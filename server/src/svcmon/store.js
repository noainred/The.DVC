/**
 * 성능점검(서비스 모니터링) 대상 저장소 — HostMonitor식 트리 + 대상(호스트) + 점검 항목.
 *
 * 데이터 모델(CONFIG_DIR/svcmon.json):
 *   targets: [{ id, path, name, host, enabled, tests: [
 *     { id, name, type('ping'|'tcp'|'http'|'dns'|'cert'|'ntp'), intervalSec, enabled,
 *       port?, url?, keyword?, expectStatus?, insecure?, record?, server?,
 *       warnBelowPct?, warnDays? } ] }]
 * path 는 '\\' 구분 트리 경로(예: 'B.Service\\A.Data_Landing(SBP)\\01.HQ\\SBP\\Admin').
 * 트리는 별도 저장 없이 path 에서 파생한다 — 가져오기/복원 때 구조 어긋남을 없애기 위함.
 *
 * 보안: 저장은 원자적 쓰기 + 로드 손상 보존(preserveCorrupt) — 쓰기만 원자적이고 로드가
 * 손상을 조용히 []로 넘기면 다음 저장이 원본을 덮어쓴다(CLAUDE.md 불변조건).
 * host/url 은 ssrfBlockReason 통과 필수(외부 입력을 네트워크로 찌르는 신규 기능).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { ssrfBlockReason } from '../collector/registry.js';

const FILE = () => path.join(config.configDir, 'svcmon.json');

export const TEST_TYPES = ['ping', 'tcp', 'http', 'dns', 'cert', 'ntp'];
const MAX_TARGETS = 500;
const MAX_TESTS_PER_TARGET = 100;
const SAFE_HOST = /^[a-zA-Z0-9._:-]+$/;          // 명령 조립·헤더 인젝션 방지(선행 '-' 차단 포함)
const SAFE_PATH = /^[^\\]{1,60}(\\[^\\]{1,60}){0,7}$/; // 트리 깊이 최대 8

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(FILE(), 'utf8');
    const parsed = JSON.parse(raw);
    cache = Array.isArray(parsed?.targets) ? { targets: parsed.targets.filter(Boolean) } : { targets: [] };
  } catch (e) {
    if (e.code !== 'ENOENT') preserveCorrupt(FILE(), e?.message); // 손상 보존 — 빈 값으로 시작하되 원본은 남긴다
    cache = { targets: [] };
  }
  return cache;
}

function save() {
  atomicWriteFileSync(FILE(), JSON.stringify(cache, null, 2));
}

const text = (v, limit, dflt = '') => {
  if (typeof v !== 'string') return dflt;
  const t = v.trim().slice(0, limit);
  return t || dflt;
};
const num = (v, low, high, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(high, Math.max(low, Math.round(n))) : dflt;
};

/** host/url 검증 — 형식 화이트리스트 + SSRF 가드(RFC1918 허용, 루프백/링크로컬/우회표기 차단). */
export function validateEndpoint({ host, url }) {
  if (url) {
    const reason = ssrfBlockReason(url);
    if (reason) return `URL 차단: ${reason}`;
    if (!/^https?:\/\//i.test(url)) return 'URL 은 http/https 만 허용됩니다.';
    return null;
  }
  if (!host || !SAFE_HOST.test(host) || host.startsWith('-')) return '호스트 형식이 올바르지 않습니다.';
  const reason = ssrfBlockReason(`http://${host}/`);
  if (reason) return `호스트 차단: ${reason}`;
  return null;
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
    port: num(data.port, 1, 65535, base.port || 0) || undefined,
    url: text(data.url, 300, base.url || '') || undefined,
    keyword: text(data.keyword, 120, base.keyword || '') || undefined,
    expectStatus: num(data.expectStatus, 100, 599, base.expectStatus || 0) || undefined,
    insecure: data.insecure === undefined ? !!base.insecure : !!data.insecure,
    record: text(data.record, 200, base.record || '') || undefined,   // dns 조회 이름
    server: text(data.server, 100, base.server || '') || undefined,   // dns/ntp 서버 오버라이드
    warnDays: num(data.warnDays, 1, 365, base.warnDays || 30),        // cert 경고 임계(D-일)
  };
  if (!t.name) throw new Error('점검 이름을 입력하세요.');
  if (t.type === 'tcp' && !t.port) throw new Error('tcp 점검은 포트가 필요합니다.');
  if (t.type === 'http' && !t.url) throw new Error('http 점검은 URL 이 필요합니다.');
  if (t.type === 'http') {
    const err = validateEndpoint({ url: t.url });
    if (err) throw new Error(err);
  }
  if (t.server && !SAFE_HOST.test(t.server)) throw new Error('서버 주소 형식이 올바르지 않습니다.');
  if (t.record && !SAFE_HOST.test(t.record)) throw new Error('조회 이름 형식이 올바르지 않습니다.');
  return t;
}

function cleanTarget(data, existing = null) {
  const base = existing || {};
  const target = {
    id: base.id || ('g-' + crypto.randomUUID().slice(0, 8)),
    // 인프라/서비스 모드(핸드오프 시안의 상단 2개 탭) — 트리·목록이 kind 로 분리된다.
    kind: ['infra', 'service'].includes(data.kind) ? data.kind : (base.kind || 'infra'),
    path: text(data.path, 400, base.path || ''),
    name: text(data.name, 120, base.name || ''),
    host: text(data.host, 200, base.host || ''),
    enabled: data.enabled === undefined ? (base.enabled !== false) : !!data.enabled,
    tests: base.tests || [],
  };
  if (!target.name) throw new Error('대상 이름을 입력하세요.');
  if (!SAFE_PATH.test(target.path)) throw new Error("경로 형식이 올바르지 않습니다(구분자 '\\', 최대 8단계).");
  const err = validateEndpoint({ host: target.host });
  if (err) throw new Error(err);
  return target;
}

export function listTargets() { return load().targets.map((t) => ({ ...t, tests: t.tests.map((x) => ({ ...x })) })); }
export function getTarget(id) { return load().targets.find((t) => t.id === id) || null; }

export function addTarget(data) {
  const db = load();
  if (db.targets.length >= MAX_TARGETS) throw new Error(`대상은 최대 ${MAX_TARGETS}개까지입니다.`);
  const t = cleanTarget(data);
  db.targets.push(t);
  save();
  return t;
}

export function updateTarget(id, data) {
  const db = load();
  const i = db.targets.findIndex((t) => t.id === id);
  if (i < 0) return null;
  db.targets[i] = cleanTarget(data, db.targets[i]);
  save();
  return db.targets[i];
}

export function deleteTarget(id) {
  const db = load();
  const before = db.targets.length;
  db.targets = db.targets.filter((t) => t.id !== id);
  if (db.targets.length === before) return false;
  save();
  return true;
}

export function addTest(targetId, data) {
  const db = load();
  const target = db.targets.find((t) => t.id === targetId);
  if (!target) return null;
  if (target.tests.length >= MAX_TESTS_PER_TARGET) throw new Error(`점검은 대상당 최대 ${MAX_TESTS_PER_TARGET}개까지입니다.`);
  const t = cleanTest(data);
  target.tests.push(t);
  save();
  return t;
}

export function updateTest(targetId, testId, data) {
  const db = load();
  const target = db.targets.find((t) => t.id === targetId);
  if (!target) return null;
  const i = target.tests.findIndex((x) => x.id === testId);
  if (i < 0) return null;
  target.tests[i] = cleanTest(data, target.tests[i]);
  save();
  return target.tests[i];
}

export function deleteTest(targetId, testId) {
  const db = load();
  const target = db.targets.find((t) => t.id === targetId);
  if (!target) return false;
  const before = target.tests.length;
  target.tests = target.tests.filter((x) => x.id !== testId);
  if (target.tests.length === before) return false;
  save();
  return true;
}

/** 테스트용 — 캐시 리셋(파일 교체 후 재로드). */
export function _resetCache() { cache = null; }
