/**
 * 성능점검 대상/폴더 저장소 — `CONFIG_DIR/svcmon.json` 전용 파일(포탈 코어와 분리).
 *
 * 데이터 모델
 *   folders: [{ id, kind, path, createdAt }]        명시적 폴더(대상이 없어도 유지)
 *   targets: [{ id, kind, path, name, host, enabled, order, tests: [...] }]
 *   sort:    { infra: 'manual'|'name', service: 'manual'|'name' }
 * path 는 '\' 구분 트리 경로. 트리는 folders + targets.path 를 합쳐 파생한다.
 *
 * 고부하 설계(1만 대)
 * - 파일은 1개지만 저장은 **디바운스 배치**(200ms)로 묶는다 — 대량 등록/가져오기에서 매 건
 *   원자적 쓰기(temp+rename)를 하면 fsync 가 병목이 된다.
 * - `byTestId` 인덱스로 점검 조회를 O(1) 로(폴러/라우트가 자주 찾는다).
 * - `storeRevision()` 은 변경 카운터 — 폴러가 이 값으로만 인덱스 재구성 여부를 판단한다.
 *
 * 보안: 원자적 쓰기 + 로드 손상 보존, host/url SSRF 가드, 경로/호스트 화이트리스트.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { ssrfBlockReason } from '../collector/registry.js';
import { DEFAULT_PORTS } from './checker.js';

const FILE = () => path.join(config.configDir, 'svcmon.json');

export const TEST_TYPES = ['ping', 'trace', 'tcp', 'udp', 'http', 'soap', 'dns', 'cert', 'ntp',
  'smtp', 'pop3', 'imap', 'ssh', 'ldap', 'domain'];
export const KINDS = ['infra', 'service'];

const MAX_TARGETS = 20000;              // 1만 대 × 여유
const MAX_TESTS_PER_TARGET = 200;
const MAX_TOTAL_TESTS = 200000;
const MAX_FOLDERS = 5000;
const SAFE_HOST = /^[a-zA-Z0-9._:-]+$/;
const SAFE_SEG = /^[^\\/:*?"<>|]{1,60}$/;                 // 폴더 세그먼트
const SAFE_PATH = /^[^\\]{1,60}(\\[^\\]{1,60}){0,9}$/;    // 트리 깊이 최대 10

let db = null;
let rev = 0;
let byTestId = null;      // testId -> { target, test }
let saveTimer = null;
let dirty = false;

function load() {
  if (db) return db;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    db = {
      targets: Array.isArray(parsed?.targets) ? parsed.targets.filter(Boolean) : [],
      folders: Array.isArray(parsed?.folders) ? parsed.folders.filter(Boolean) : [],
      sort: parsed?.sort && typeof parsed.sort === 'object' ? parsed.sort : { infra: 'manual', service: 'manual' },
    };
  } catch (e) {
    if (e.code !== 'ENOENT') preserveCorrupt(FILE(), e?.message);
    db = { targets: [], folders: [], sort: { infra: 'manual', service: 'manual' } };
  }
  return db;
}

/** 디바운스 저장 — 대량 변경을 한 번의 원자적 쓰기로 묶는다. */
function save({ immediate = false } = {}) {
  rev += 1;
  byTestId = null;
  dirty = true;
  if (immediate) return flushSave();
  if (saveTimer) return;
  saveTimer = setTimeout(flushSave, 200);
  saveTimer.unref?.();
}

function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!dirty || !db) return;
  dirty = false;
  try {
    atomicWriteFileSync(FILE(), JSON.stringify(db));
  } catch (e) {
    dirty = true;
    console.error('[svcmon] 저장 실패:', e?.message);
  }
}

export function flushStore() { flushSave(); }
export function storeRevision() { return rev; }

const text = (v, limit, dflt = '') => {
  if (typeof v !== 'string') return dflt;
  const t = v.trim().slice(0, limit);
  return t || dflt;
};
const num = (v, low, high, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(high, Math.max(low, Math.round(n))) : dflt;
};
/** 포트 파싱 — 1~65535 정수만 인정하고 그 외는 undefined(미지정). */
const portOf = (v) => {
  if (v === '' || v === null || v === undefined) return undefined;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 65535 ? n : undefined;
};

export function validateEndpoint({ host, url }) {
  if (url) {
    if (!/^https?:\/\//i.test(url)) return 'URL 은 http/https 만 허용됩니다.';
    const reason = ssrfBlockReason(url);
    return reason ? `URL 차단: ${reason}` : null;
  }
  if (!host || !SAFE_HOST.test(host) || host.startsWith('-')) return '호스트 형식이 올바르지 않습니다.';
  const reason = ssrfBlockReason(`http://${host}/`);
  return reason ? `호스트 차단: ${reason}` : null;
}

function cleanTest(data, existing = null) {
  const base = existing || {};
  const type = TEST_TYPES.includes(data.type) ? data.type : (base.type || 'ping');
  const t = {
    id: base.id || ('t-' + crypto.randomUUID().slice(0, 8)),
    name: text(data.name, 80, base.name || ''),
    type,
    intervalSec: num(data.intervalSec, 10, 86400, base.intervalSec || 60),
    enabled: data.enabled === undefined ? (base.enabled !== false) : !!data.enabled,
    // 포트는 '무효값을 클램프하지 않는다' — 0/음수/문자를 1로 바꾸면 엉뚱한 포트를 찍는다.
    // 유효 범위 밖이면 미지정으로 보고 기존값 → 유형 기본 포트 순으로 채운다.
    port: portOf(data.port) || base.port || DEFAULT_PORTS[type] || undefined,
    url: text(data.url, 500, base.url || '') || undefined,
    keyword: text(data.keyword, 200, base.keyword || '') || undefined,
    expectStatus: num(data.expectStatus, 100, 599, base.expectStatus || 0) || undefined,
    insecure: data.insecure === undefined ? !!base.insecure : !!data.insecure,
    record: text(data.record, 253, base.record || '') || undefined,
    server: text(data.server, 253, base.server || '') || undefined,
    expect: text(data.expect, 64, base.expect || '') || undefined,
    payload: text(data.payload, 200, base.payload || '') || undefined,
    send: text(data.send, 200, base.send || '') || undefined,
    body: text(data.body, 4000, base.body || '') || undefined,
    soapAction: text(data.soapAction, 200, base.soapAction || '') || undefined,
    warnDays: num(data.warnDays, 1, 365, base.warnDays || (type === 'domain' ? 60 : 30)),
    warnMs: num(data.warnMs, 1, 600000, base.warnMs || 0) || undefined,
    badMs: num(data.badMs, 1, 600000, base.badMs || 0) || undefined,
    maxHops: num(data.maxHops, 1, 64, base.maxHops || 0) || undefined,
  };
  if (!t.name) throw new Error('점검 이름을 입력하세요.');
  if (['tcp', 'udp'].includes(t.type) && !t.port) throw new Error(`${t.type} 점검은 포트가 필요합니다.`);
  if (['http', 'soap'].includes(t.type)) {
    if (!t.url) throw new Error(`${t.type} 점검은 URL 이 필요합니다.`);
    const err = validateEndpoint({ url: t.url });
    if (err) throw new Error(err);
  }
  for (const [k, v] of [['server', t.server], ['record', t.record]]) {
    if (v && !SAFE_HOST.test(v)) throw new Error(`${k} 형식이 올바르지 않습니다.`);
  }
  return t;
}

function cleanTarget(data, existing = null) {
  const base = existing || {};
  const target = {
    id: base.id || ('g-' + crypto.randomUUID().slice(0, 8)),
    kind: KINDS.includes(data.kind) ? data.kind : (base.kind || 'infra'),
    path: text(data.path, 620, base.path || ''),
    name: text(data.name, 120, base.name || ''),
    host: text(data.host, 253, base.host || ''),
    enabled: data.enabled === undefined ? (base.enabled !== false) : !!data.enabled,
    order: num(data.order, 0, 1e9, base.order ?? Date.now()),
    tests: base.tests || [],
  };
  if (!target.name) throw new Error('대상 이름을 입력하세요.');
  if (!SAFE_PATH.test(target.path)) throw new Error("경로 형식이 올바르지 않습니다(구분자 '\\', 최대 10단계).");
  const err = validateEndpoint({ host: target.host });
  if (err) throw new Error(err);
  return target;
}

/* ── 조회 ── */
export function listTargets() { return load().targets; }           // 읽기 전용 사용 전제(폴러 성능)
export function listTargetsCopy() { return load().targets.map((t) => ({ ...t, tests: t.tests.map((x) => ({ ...x })) })); }
export function listFolders() { return load().folders.map((f) => ({ ...f })); }
export function getSort() { return { infra: 'manual', service: 'manual', ...load().sort }; }
export function getTarget(id) { return load().targets.find((t) => t.id === id) || null; }

export function totalTests() {
  let n = 0;
  for (const t of load().targets) n += t.tests.length;
  return n;
}

function testIndex() {
  if (byTestId) return byTestId;
  byTestId = new Map();
  for (const target of load().targets) for (const test of target.tests) byTestId.set(test.id, { target, test });
  return byTestId;
}
export function findTest(testId) { return testIndex().get(testId) || null; }

/* ── 폴더 ── */
export function addFolder({ kind, path: p }) {
  const dbx = load();
  if (dbx.folders.length >= MAX_FOLDERS) throw new Error(`폴더는 최대 ${MAX_FOLDERS}개까지입니다.`);
  const k = KINDS.includes(kind) ? kind : 'infra';
  const clean = text(p, 620);
  if (!SAFE_PATH.test(clean)) throw new Error("경로 형식이 올바르지 않습니다(구분자 '\\', 최대 10단계).");
  for (const seg of clean.split('\\')) if (!SAFE_SEG.test(seg)) throw new Error(`폴더 이름에 쓸 수 없는 문자: ${seg}`);
  if (dbx.folders.some((f) => f.kind === k && f.path === clean)) throw new Error('이미 있는 폴더입니다.');
  const folder = { id: 'f-' + crypto.randomUUID().slice(0, 8), kind: k, path: clean, createdAt: Date.now() };
  dbx.folders.push(folder);
  save();
  return folder;
}

export function renameFolder({ kind, path: p, newName }) {
  const dbx = load();
  const k = KINDS.includes(kind) ? kind : 'infra';
  const name = text(newName, 60);
  if (!SAFE_SEG.test(name)) throw new Error('새 폴더 이름 형식이 올바르지 않습니다.');
  const parts = String(p).split('\\');
  parts[parts.length - 1] = name;
  const to = parts.join('\\');
  if (dbx.folders.some((f) => f.kind === k && f.path === to)) throw new Error('같은 이름의 폴더가 이미 있습니다.');
  let moved = 0;
  const swap = (v) => (v === p ? to : (v.startsWith(`${p}\\`) ? to + v.slice(p.length) : v));
  for (const f of dbx.folders) if (f.kind === k && (f.path === p || f.path.startsWith(`${p}\\`))) { f.path = swap(f.path); moved += 1; }
  for (const t of dbx.targets) if (t.kind === k && (t.path === p || t.path.startsWith(`${p}\\`))) { t.path = swap(t.path); moved += 1; }
  if (!moved) throw new Error('폴더를 찾을 수 없습니다.');
  save();
  return { path: to, moved };
}

/** 폴더 삭제 — 기본은 비어 있을 때만. force 면 하위 대상까지 함께 삭제한다. */
export function deleteFolder({ kind, path: p, force = false }) {
  const dbx = load();
  const k = KINDS.includes(kind) ? kind : 'infra';
  const under = (v) => v === p || v.startsWith(`${p}\\`);
  const targets = dbx.targets.filter((t) => t.kind === k && under(t.path));
  if (targets.length && !force) {
    const err = new Error(`폴더에 대상 ${targets.length}개가 있습니다(먼저 이동/삭제하거나 강제 삭제).`);
    err.code = 'NOT_EMPTY';
    err.count = targets.length;
    throw err;
  }
  const before = dbx.folders.length + dbx.targets.length;
  dbx.folders = dbx.folders.filter((f) => !(f.kind === k && under(f.path)));
  if (force) dbx.targets = dbx.targets.filter((t) => !(t.kind === k && under(t.path)));
  if (dbx.folders.length + dbx.targets.length === before) throw new Error('폴더를 찾을 수 없습니다.');
  save();
  return { removedTargets: force ? targets.length : 0 };
}

export function setSort({ kind, mode }) {
  const dbx = load();
  const k = KINDS.includes(kind) ? kind : 'infra';
  dbx.sort = { ...getSort(), [k]: mode === 'name' ? 'name' : 'manual' };
  save();
  return getSort();
}

/* ── 대상/점검 CRUD ── */
export function addTarget(data) {
  const dbx = load();
  if (dbx.targets.length >= MAX_TARGETS) throw new Error(`대상은 최대 ${MAX_TARGETS}개까지입니다.`);
  const t = cleanTarget(data);
  dbx.targets.push(t);
  // 경로가 폴더 목록에 없으면 자동 등록(트리에서 즉시 보이게)
  ensureFolderPath(dbx, t.kind, t.path);
  save();
  return t;
}

function ensureFolderPath(dbx, kind, p) {
  if (!p) return;
  const segs = p.split('\\');
  for (let i = 1; i <= segs.length; i += 1) {
    const sub = segs.slice(0, i).join('\\');
    if (!dbx.folders.some((f) => f.kind === kind && f.path === sub)) {
      dbx.folders.push({ id: 'f-' + crypto.randomUUID().slice(0, 8), kind, path: sub, createdAt: Date.now() });
    }
  }
}

export function updateTarget(id, data) {
  const dbx = load();
  const i = dbx.targets.findIndex((t) => t.id === id);
  if (i < 0) return null;
  dbx.targets[i] = cleanTarget(data, dbx.targets[i]);
  ensureFolderPath(dbx, dbx.targets[i].kind, dbx.targets[i].path);
  save();
  return dbx.targets[i];
}

export function deleteTarget(id) {
  const dbx = load();
  const before = dbx.targets.length;
  dbx.targets = dbx.targets.filter((t) => t.id !== id);
  if (dbx.targets.length === before) return false;
  save();
  return true;
}

export function addTest(targetId, data) {
  const dbx = load();
  const target = dbx.targets.find((t) => t.id === targetId);
  if (!target) return null;
  if (target.tests.length >= MAX_TESTS_PER_TARGET) throw new Error(`점검은 대상당 최대 ${MAX_TESTS_PER_TARGET}개까지입니다.`);
  if (totalTests() >= MAX_TOTAL_TESTS) throw new Error(`전체 점검 항목은 최대 ${MAX_TOTAL_TESTS}개까지입니다.`);
  const t = cleanTest(data);
  target.tests.push(t);
  save();
  return t;
}

export function updateTest(targetId, testId, data) {
  const dbx = load();
  const target = dbx.targets.find((t) => t.id === targetId);
  if (!target) return null;
  const i = target.tests.findIndex((x) => x.id === testId);
  if (i < 0) return null;
  target.tests[i] = cleanTest(data, target.tests[i]);
  save();
  return target.tests[i];
}

export function deleteTest(targetId, testId) {
  const dbx = load();
  const target = dbx.targets.find((t) => t.id === targetId);
  if (!target) return false;
  const before = target.tests.length;
  target.tests = target.tests.filter((x) => x.id !== testId);
  if (target.tests.length === before) return false;
  save();
  return true;
}

/** 대량 등록(가져오기·자동 생성) — 한 번의 저장으로 묶는다. */
export function bulkAddTargets(list = []) {
  const dbx = load();
  const added = [];
  const errors = [];
  list.forEach((row, i) => {
    try {
      if (dbx.targets.length >= MAX_TARGETS) throw new Error('대상 상한 초과');
      const t = cleanTarget(row);
      const tests = Array.isArray(row.tests) ? row.tests : [];
      t.tests = tests.slice(0, MAX_TESTS_PER_TARGET).map((x) => cleanTest(x));
      dbx.targets.push(t);
      ensureFolderPath(dbx, t.kind, t.path);
      added.push(t.id);
    } catch (e) { errors.push({ row: i + 1, name: row?.name || '', reason: e.message }); }
  });
  save({ immediate: true });
  return { added: added.length, errors };
}

export function _resetCache() { db = null; byTestId = null; rev += 1; dirty = false; }
