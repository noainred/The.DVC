/**
 * horizon/sessionSettings.js — Horizon 실시간 사용자 수집 설정(v2.525).
 *
 * 파일: `CONFIG_DIR/horizon-sessions.json`. **자격증명은 여기 없다** — Connection Server 목록과
 * 계정은 이미 `horizon.json`(설정 › Horizon 등록)이 갖고 있고 이 기능은 그것을 **재사용**한다.
 * 자격증명 스토어를 하나 더 만들면 비밀 승계·SSRF 가드를 두 곳에서 지켜야 한다(v2.503 규칙).
 *
 * ⚠ 주기를 모듈 로드 시 `const` 로 굳히지 말 것 — `startAdaptiveTimer` 가 매 틱 조회하고
 *   설정 변경 시 **무장된 타이머를 즉시 재무장**한다(v2.409 규칙. 없으면 최대 한 주기 뒤에 먹는다).
 * ⚠ 기본 **꺼짐(opt-in)**. 실시간 사용자는 매 주기 Connection Server 에 로그인·조회·로그아웃
 *   왕복을 만든다 — 관리자가 명시적으로 켜야 시작한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';

const FILE = () => path.join(config.configDir, 'horizon-sessions.json');

export const LIMITS = Object.freeze({
  // 5분 기본. '실시간' 이라도 1분 주기는 28법인 고RTT 환경에서 로그인 왕복을 과하게 만든다.
  intervalMs: { min: 60_000, max: 6 * 3600_000, def: 5 * 60_000 },
  retentionDays: { min: 1, max: 3650, def: 180 },
  concurrency: { min: 1, max: 8, def: 3 },
  timeoutMs: { min: 5_000, max: 300_000, def: 30_000 },
  pageSize: { min: 50, max: 1000, def: 500 },      // Horizon `size` 상한 1000
  maxPages: { min: 1, max: 200, def: 20 },         // 20 × 500 = 10,000 세션. 넘으면 truncated 로 밝힌다
  maxUsers: { min: 50, max: 20_000, def: 2000 },   // 저장·응답 계정 목록 상한(초과는 개수만)
});

const clamp = (v, l) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return l.def;
  return Math.min(l.max, Math.max(l.min, Math.round(n)));
};

let _cache = null;
const listeners = new Set();
export function onHorizonSessionSettingsChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }

/** 정규화(순수 — 테스트가 고정). `servers[id] = { enabled }` — 미등록 id 는 화면이 무시한다. */
export function normalize(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const sIn = src.servers && typeof src.servers === 'object' && !Array.isArray(src.servers) ? src.servers : {};
  const servers = {};
  for (const [id, v] of Object.entries(sIn).slice(0, 200)) {
    const o = v && typeof v === 'object' ? v : {};
    servers[String(id)] = { enabled: o.enabled !== false };   // 등록했으면 기본 수집
  }
  return {
    enabled: src.enabled === true,
    intervalMs: clamp(src.intervalMs, LIMITS.intervalMs),
    retentionDays: clamp(src.retentionDays, LIMITS.retentionDays),
    concurrency: clamp(src.concurrency, LIMITS.concurrency),
    timeoutMs: clamp(src.timeoutMs, LIMITS.timeoutMs),
    pageSize: clamp(src.pageSize, LIMITS.pageSize),
    maxPages: clamp(src.maxPages, LIMITS.maxPages),
    maxUsers: clamp(src.maxUsers, LIMITS.maxUsers),
    // 계정명 표시 정책 — 사용자 선택(2026-09-16): **목록은 가리고 상세에서 본다**.
    showNamesInList: src.showNamesInList === true,
    servers,
  };
}

export function load() {
  if (_cache) return _cache;
  let raw = {};
  try { if (fs.existsSync(FILE())) raw = JSON.parse(fs.readFileSync(FILE(), 'utf8')); }
  catch { preserveCorrupt(FILE()); raw = {}; }
  _cache = normalize(raw);
  return _cache;
}

export function save(next) {
  const v = normalize(next);
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  atomicWriteFileSync(FILE(), JSON.stringify(v, null, 2), { mode: 0o600 });
  _cache = v;
  for (const cb of listeners) { try { cb(v); } catch { /* 구독자 오류가 저장을 막지 않게 */ } }
  return v;
}

export function _resetForTest() { _cache = null; }
