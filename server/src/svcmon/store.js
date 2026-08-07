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
import { TEST_TYPES, KINDS, TEST_FIELDS, TARGET_FIELDS } from './testSchema.js';

const FILE = () => path.join(config.configDir, 'svcmon.json');

// 필드 정의는 testSchema.js 하나만 둔다(CSV·템플릿·검증 공용). 기존 임포트 호환을 위해 재수출.
export { TEST_TYPES, KINDS };

const MAX_TARGETS = 20000;              // 1만 대 × 여유
const MAX_TESTS_PER_TARGET = 200;
const MAX_TOTAL_TESTS = 200000;
const MAX_FOLDERS = 5000;
/**
 * 1회 요청 상한(라우트에서 강제) — 저장소 상한과 별개다.
 * 근거: 다양한 경로 5,000행 등록이 116ms(측정) → 2,000행 ≈ 50ms. 본문 한도 1MB 에서
 * 점검 행 약 150B 면 약 6,500행이 물리 한계다. 초과는 **클램프하지 않고 오류**로 돌린다.
 */
export const LIMITS = {
  maxTargets: MAX_TARGETS,
  maxTestsPerTarget: MAX_TESTS_PER_TARGET,
  maxTotalTests: MAX_TOTAL_TESTS,
  maxFolders: MAX_FOLDERS,
  maxBulkRows: 2000,
  maxBulkTests: 10000,
};
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

/** @returns {boolean} 파일에 실제로 썼는지. 호출부가 실패를 201 로 감추지 않게 반환한다. */
function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!dirty || !db) return true;
  dirty = false;
  try {
    atomicWriteFileSync(FILE(), JSON.stringify(db));
    return true;
  } catch (e) {
    dirty = true;
    console.error('[svcmon] 저장 실패:', e?.message);
    return false;
  }
}

export function flushStore() { return flushSave(); }
export function storeRevision() { return rev; }

const text = (v, limit, dflt = '') => {
  if (typeof v !== 'string') return dflt;
  const t = v.trim().slice(0, limit);
  return t || dflt;
};
/**
 * 숫자 파싱 — **빈 값은 기본값**이다. `Number('')===0` 이라 이 가드가 없으면 빈 셀이 `low` 로
 * 클램프된다(CSV 가져오기에서 expectStatus 100·intervalSec 10·warnMs 1 이 되어 오류 없이
 * 전 점검이 오설정됨). 같은 저장소의 다른 num 헬퍼도 `v === ''` 를 가드한다.
 */
const num = (v, low, high, dflt) => {
  if (v === null || v === undefined) return dflt;
  if (typeof v === 'string' && v.trim() === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(high, Math.max(low, Math.round(n))) : dflt;
};
const TRUTHY = new Set(['1', 'true', 'yes', 'y', 'on', 't', '예', 'o']);
const FALSY = new Set(['0', 'false', 'no', 'n', 'off', 'f', '아니오', 'x']);
/**
 * 불리언 파싱 — `!!'false'` 는 **true** 다. CSV 의 `insecure="false"` 가 TLS 검증 해제로
 * 뒤집히던 원인이므로 화이트리스트로만 판정하고, 알 수 없는 값은 기본값을 유지한다
 * (조용한 반전 금지).
 */
const bool = (v, dflt) => {
  if (v === null || v === undefined) return dflt;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v !== 0 : dflt;
  const s = String(v).trim().toLowerCase();
  if (!s) return dflt;
  if (TRUTHY.has(s)) return true;
  if (FALSY.has(s)) return false;
  return dflt;
};
/**
 * undefined 키 제거 — `JSON.stringify` 는 undefined 키를 버리므로, 남겨 두면 **메모리 객체와
 * 저장 후 재로드한 객체의 키 집합이 달라진다**. 템플릿 재적용 diff 가 그 차이를 '변경'으로
 * 오판하고, 20만 점검에서 빈 키 15개는 메모리 낭비이기도 하다.
 */
const compact = (o) => {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
};
/** 열거형 파싱 — 대소문자만 정규화하고, 목록 밖 값은 **조용히 폴백하지 않고 예외**. */
const pickEnum = (v, allowed, dflt, label) => {
  if (v === null || v === undefined || v === '') return dflt;
  const s = String(v).trim().toLowerCase();
  if (!s) return dflt;
  if (allowed.includes(s)) return s;
  throw new Error(`알 수 없는 ${label}: ${String(v).slice(0, 40)} (가능: ${allowed.join(', ')})`);
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
  // 미지 유형을 ping 으로 폴백하면 'disk' 라고 적은 템플릿·CSV 가 전 대상에 ping 점검을
  // 만들면서 오류를 0건으로 보고한다. 목록 밖 값은 거부한다.
  const type = pickEnum(data.type, TEST_TYPES, base.type || 'ping', '점검 유형');
  const t = { id: base.id || ('t-' + crypto.randomUUID().slice(0, 8)), type };
  // 필드는 testSchema.js 의 표에서 파생한다 — 여기에 목록을 다시 적으면 CSV/템플릿과 어긋난다.
  for (const f of TEST_FIELDS) {
    if (f.key === 'type') continue;
    const cur = data[f.key];
    const prev = base[f.key];
    if (f.kind === 'text') {
      const v = text(cur, f.max, prev || '') || undefined;
      t[f.key] = f.optional ? v : (v || '');
    } else if (f.kind === 'bool') {
      t[f.key] = bool(cur, prev === undefined ? f.dflt : prev);
    } else if (f.kind === 'int') {
      const dflt = f.dfltByType ? (f.dfltByType[type] ?? f.dfltByType['*']) : f.dflt;
      const v = num(cur, f.min, f.max, prev ?? dflt);
      t[f.key] = f.optional ? (v || undefined) : v;
    } else if (f.kind === 'port') {
      // 포트는 '무효값을 클램프하지 않는다' — 0/음수/문자를 1로 바꾸면 엉뚱한 포트를 찍는다.
      // 유효 범위 밖이면 미지정으로 보고 기존값 → 유형 기본 포트 순으로 채운다.
      t[f.key] = portOf(cur) || prev || DEFAULT_PORTS[type] || undefined;
    }
  }
  // 템플릿 귀속 태그 — 재적용 멱등성의 매칭 키다. 이 화이트리스트에서 빠지면 저장 시
  // 조용히 사라져 재적용이 매번 점검을 중복 생성한다. CSV 컬럼은 아니므로 표 밖에 둔다.
  t.tpl = text(data.tpl, 40, base.tpl || '') || undefined;
  t.tplKey = text(data.tplKey, 40, base.tplKey || '') || undefined;

  if (!t.name) throw new Error('점검 이름을 입력하세요.');
  for (const f of TEST_FIELDS) {
    if (f.requiredFor?.includes(type) && !t[f.key]) {
      throw new Error(`${type} 점검은 ${f.label} 값이 필요합니다.`);
    }
  }
  if (t.url) {
    const err = validateEndpoint({ url: t.url });
    if (err) throw new Error(err);
  }
  // server/record 도 목적지가 된다(dns 는 server 를 네임서버로, ntp 는 server 로 질의).
  // 대상 host 만 SSRF 가드를 태우면 이 두 필드로 루프백·메타데이터 주소를 그대로 찍을 수 있다.
  for (const [k, v] of [['server', t.server], ['record', t.record]]) {
    if (!v) continue;
    if (!SAFE_HOST.test(v) || v.startsWith('-')) throw new Error(`${k} 형식이 올바르지 않습니다.`);
    const err = validateEndpoint({ host: v });
    if (err) throw new Error(`${k}: ${err}`);
  }
  return compact(t);
}

function cleanTarget(data, existing = null) {
  const base = existing || {};
  const target = { id: base.id || ('g-' + crypto.randomUUID().slice(0, 8)) };
  for (const f of TARGET_FIELDS) {
    const cur = data[f.key];
    const prev = base[f.key];
    if (f.kind === 'enum') target[f.key] = pickEnum(cur, f.values, prev || f.values[0], f.label);
    else if (f.kind === 'bool') target[f.key] = bool(cur, prev === undefined ? f.dflt : prev);
    else {
      // text() 는 초과분을 조용히 자른다 — 대량 생성에서 접두사가 같으면 서로 다른 번호가
      // 같은 이름으로 잘려 중복이 된다. 넘치면 거부한다.
      if (typeof cur === 'string' && cur.trim().length > f.max) throw new Error(`${f.label}은 ${f.max}자를 넘을 수 없습니다.`);
      target[f.key] = text(cur, f.max, prev || '');
    }
  }
  // 밀리초 타임스탬프이므로 상한을 1e9(=1970-01-12)로 두면 값이 들어올 때 뭉개진다.
  target.order = num(data.order, 0, Number.MAX_SAFE_INTEGER, base.order ?? Date.now());
  // 대량 등록 배치 태그 — 롤백이 '정확히 그 배치만' 지우는 근거.
  target.batch = text(data.batch, 40, base.batch || '') || undefined;
  target.tests = base.tests || [];

  if (!target.name) throw new Error('대상 이름을 입력하세요.');
  if (!SAFE_PATH.test(target.path)) throw new Error("경로 형식이 올바르지 않습니다(구분자 '\\', 최대 10단계).");
  const err = validateEndpoint({ host: target.host });
  if (err) throw new Error(err);
  return compact(target);
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
  // 경로가 폴더 목록에 없으면 자동 등록(트리에서 즉시 보이게).
  // 폴더 상한 초과로 던질 수 있으므로 대상 push 보다 **먼저** — 순서를 바꾸면 실패한 등록의
  // 대상이 메모리에 남는다.
  ensureFolderPath(dbx, t.kind, t.path);
  dbx.targets.push(t);
  save();
  return t;
}

const folderKey = (kind, p) => `${kind} ${p}`;
/** 폴더 경로 인덱스 — 대량 등록에서 행마다 folders.some() 을 돌면 O(행×폴더)가 된다. */
function folderKeySet(dbx) {
  const s = new Set();
  for (const f of dbx.folders) s.add(folderKey(f.kind, f.path));
  return s;
}
/** 아직 없는 상위 경로 목록(생성 순서대로). 인덱스를 주면 그 인덱스로만 판단한다. */
function missingFolderPaths(dbx, kind, p, idx = null) {
  if (!p) return [];
  const segs = p.split('\\');
  const out = [];
  for (let i = 1; i <= segs.length; i += 1) {
    const sub = segs.slice(0, i).join('\\');
    const has = idx ? idx.has(folderKey(kind, sub))
      : dbx.folders.some((f) => f.kind === kind && f.path === sub);
    if (!has) { out.push(sub); idx?.add(folderKey(kind, sub)); }
  }
  return out;
}
function pushFolders(dbx, kind, paths) {
  for (const sub of paths) {
    dbx.folders.push({ id: 'f-' + crypto.randomUUID().slice(0, 8), kind, path: sub, createdAt: Date.now() });
  }
}
/** 상한을 **먼저** 확인한 뒤 한 번에 만든다 — 중간에 던지면 대상만 남고 폴더가 빠진다. */
function ensureFolderPath(dbx, kind, p) {
  const missing = missingFolderPaths(dbx, kind, p);
  if (!missing.length) return 0;
  if (dbx.folders.length + missing.length > MAX_FOLDERS) throw new Error(`폴더는 최대 ${MAX_FOLDERS}개까지입니다.`);
  pushFolders(dbx, kind, missing);
  return missing.length;
}

export function updateTarget(id, data) {
  const dbx = load();
  const i = dbx.targets.findIndex((t) => t.id === id);
  if (i < 0) return null;
  const next = cleanTarget(data, dbx.targets[i]);
  ensureFolderPath(dbx, next.kind, next.path);   // 실패 시 기존 대상을 덮어쓰지 않는다
  dbx.targets[i] = next;
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

/** 대상 동일성 — 한 폴더 안에서는 이름이 식별자다(CSV 행 그룹핑과 같은 키). */
const dupKey = (t) => `${t.kind} ${t.path} ${t.name.toLowerCase()}`;

/**
 * 대량 등록(가져오기·자동 생성) — 검증을 **전량 끝낸 뒤** 한 번의 저장으로 커밋한다.
 *
 * 이전 구현의 문제 3가지를 함께 고친다.
 *  - 트랜잭션이 아니었다: 중간 행이 실패해도 앞 행은 커밋돼 부분 등록이 남았다.
 *  - 중복 검사가 없었다: 같은 (구분·경로·이름) 을 몇 번 가져와도 대상이 계속 늘었다.
 *  - 상한을 대상 수만 봤다: 전체 점검·폴더 상한을 넘겨도 오류 없이 통과했다
 *    (5,000행×50점검 = 25만 점검, 폴더 5,420개가 오류 0건으로 등록됨).
 *
 * @param {object[]} list
 * @param {{atomic?:boolean, dedup?:boolean, batch?:string}} opts
 *   atomic=false 는 오류 행을 건너뛰고 나머지를 커밋한다(가져오기 미리보기에서 쓰지 않는다).
 * @returns {{added:number, errors:object[], skipped:object[], newFolders:number, newTests:number,
 *            committed:boolean, saved:boolean}}
 */
export function bulkAddTargets(list = [], { atomic = true, dedup = true, batch = '' } = {}) {
  const dbx = load();
  const plan = planBulkTargets(list, { dedup, batch });
  const fail = plan.over.length > 0 || (atomic && plan.errors.length > 0);
  if (fail) {
    return {
      added: 0,
      errors: [...plan.errors, ...plan.over.map((reason) => ({ row: 0, name: '', reason }))],
      skipped: plan.skipped,
      newFolders: 0,
      newTests: 0,
      committed: false,
      saved: true,
    };
  }

  for (const { target, folders } of plan.prepared) {
    pushFolders(dbx, target.kind, folders);
    dbx.targets.push(target);
  }
  const saved = plan.prepared.length ? save({ immediate: true }) : true;
  return {
    added: plan.prepared.length,
    errors: plan.errors,
    skipped: plan.skipped,
    newFolders: plan.newFolders,
    newTests: plan.newTests,
    committed: true,
    saved: saved !== false,
  };
}

/**
 * 대량 등록 계획 — **저장하지 않고** 커밋과 똑같은 검증을 수행한다.
 * 미리보기와 실제 등록이 다른 코드로 판정하면 "미리보기는 통과인데 등록은 실패"가 생긴다.
 */
export function planBulkTargets(list = [], { dedup = true, batch = '' } = {}) {
  const dbx = load();
  const errors = [];
  const skipped = [];
  const prepared = [];      // { target, folders: string[] }
  const folderIdx = folderKeySet(dbx);
  const nameIdx = new Set();
  if (dedup) for (const t of dbx.targets) nameIdx.add(dupKey(t));
  let newFolders = 0;
  let newTests = 0;
  const startTests = totalTests();   // 호출당 1회(전수 순회를 행마다 돌리지 않는다)

  list.forEach((row, i) => {
    try {
      const t = cleanTarget({ ...row, batch: row?.batch || batch });
      const key = dupKey(t);
      if (dedup && nameIdx.has(key)) {
        skipped.push({ row: i + 1, name: t.name, path: t.path, reason: '이미 있는 대상(구분+경로+이름 중복)' });
        return;
      }
      const tests = Array.isArray(row?.tests) ? row.tests : [];
      if (tests.length > MAX_TESTS_PER_TARGET) throw new Error(`점검은 대상당 최대 ${MAX_TESTS_PER_TARGET}개까지입니다.`);
      t.tests = tests.map((x) => cleanTest(x));
      const folders = missingFolderPaths(dbx, t.kind, t.path, folderIdx);
      nameIdx.add(key);
      newFolders += folders.length;
      newTests += t.tests.length;
      // row 는 입력 순번(1부터) — 미리보기 표가 CSV 행 번호와 같은 체계로 표시한다.
      prepared.push({ row: i + 1, target: t, folders });
    } catch (e) { errors.push({ row: i + 1, name: row?.name || '', reason: e.message }); }
  });

  // 상한은 행마다 오류를 넣지 않고 **1건으로** 보고한다(2,000행이면 응답이 수백 KB 가 된다).
  const over = [];
  if (dbx.targets.length + prepared.length > MAX_TARGETS) over.push(`대상 상한 초과: 기존 ${dbx.targets.length} + 신규 ${prepared.length} > ${MAX_TARGETS}`);
  if (startTests + newTests > MAX_TOTAL_TESTS) over.push(`전체 점검 상한 초과: 기존 ${startTests} + 신규 ${newTests} > ${MAX_TOTAL_TESTS}`);
  if (dbx.folders.length + newFolders > MAX_FOLDERS) over.push(`폴더 상한 초과: 기존 ${dbx.folders.length} + 신규 ${newFolders} > ${MAX_FOLDERS}`);

  return {
    prepared, errors, skipped, over, newFolders, newTests,
    before: { targets: dbx.targets.length, tests: startTests, folders: dbx.folders.length },
    after: {
      targets: dbx.targets.length + prepared.length,
      tests: startTests + newTests,
      folders: dbx.folders.length + newFolders,
    },
  };
}

/**
 * 배치 롤백 — 대량 등록/가져오기가 붙인 `batch` 태그로 **그 배치만** 지운다.
 * `expectedCount` 를 주면 개수가 다를 때 아무것도 지우지 않는다(미리보기 이후 목록이
 * 바뀐 상태에서 엉뚱한 범위를 지우는 것을 막는다).
 */
export function deleteTargetsByBatch(batchId, { expectedCount = null } = {}) {
  const id = String(batchId || '').trim();
  if (!id) return { removed: 0, tests: 0, error: '배치 ID 가 필요합니다.' };
  const dbx = load();
  const hit = dbx.targets.filter((t) => t.batch === id);
  if (!hit.length) return { removed: 0, tests: 0, error: '그 배치로 등록된 대상이 없습니다(이미 삭제되었을 수 있습니다).' };
  if (expectedCount !== null && Number(expectedCount) !== hit.length) {
    return { removed: 0, tests: 0, error: `대상 수가 다릅니다(예상 ${expectedCount}, 실제 ${hit.length}). 목록을 새로 고친 뒤 다시 시도하세요.` };
  }
  let tests = 0;
  for (const t of hit) tests += t.tests.length;
  dbx.targets = dbx.targets.filter((t) => t.batch !== id);
  const saved = save({ immediate: true });
  return { removed: hit.length, tests, saved: saved !== false };
}

/** 배치별 현재 대상 수 — 롤백 화면이 '지금 몇 개 남아 있는지' 표시할 때 쓴다. */
export function batchCounts() {
  const m = new Map();
  for (const t of load().targets) {
    if (!t.batch) continue;
    const cur = m.get(t.batch) || { targets: 0, tests: 0 };
    cur.targets += 1;
    cur.tests += t.tests.length;
    m.set(t.batch, cur);
  }
  return m;
}

export function _resetCache() { db = null; byTestId = null; rev += 1; dirty = false; }
