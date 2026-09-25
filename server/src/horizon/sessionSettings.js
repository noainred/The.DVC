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
import { numOrNull } from '../util/numOrNull.js';
import { clampSetting } from '../util/clampSetting.js'; // v2.613 DEPS2613-12 · RUNTIME2613-08: 숫자 설정 정규화는 하나(빈 칸 = 미지정)

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


// v2.599 LO2599-01: 숫자 칸을 비우고 저장하면(''·null·비숫자·0 이하) clamp 가 **기본값**을 줬다 — 예: 보존 3650일 →
// 180일(Horizon 세션). v2.596 규약대로 빈 칸은 '미지정' 이고 **이전 값을 유지**한다(판정은 numOrNull — Number('')===0 함정).
// v2.613 DEPS2613-12: clamp 사본 대신 util/clampSetting.js. 이 모듈의 계약(v2.599 LO2599-01·기존 테스트)은 '빈 값·비숫자·**0 이하** = 미지정
//   → 기본값' 이라 0 이하를 먼저 미지정(null)으로 접는다 — clampSetting 은 0 을 값으로 보고 하한으로 올린다(미입력이 최소주기로 둔갑).
const positive = (v) => { const n = numOrNull(v); return n != null && n <= 0 ? null : v; };
function keepPrevBlankNumbers(input, prev) {
  const out = { ...(input && typeof input === 'object' ? input : {}) };
  for (const k of Object.keys(LIMITS)) {
    const n = numOrNull(out[k]);
    if (n == null || n <= 0) out[k] = prev[k];
  }
  return out;
}

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
    intervalMs: clampSetting(positive(src.intervalMs), LIMITS.intervalMs),
    retentionDays: clampSetting(positive(src.retentionDays), LIMITS.retentionDays),
    concurrency: clampSetting(positive(src.concurrency), LIMITS.concurrency),
    timeoutMs: clampSetting(positive(src.timeoutMs), LIMITS.timeoutMs),
    pageSize: clampSetting(positive(src.pageSize), LIMITS.pageSize),
    maxPages: clampSetting(positive(src.maxPages), LIMITS.maxPages),
    maxUsers: clampSetting(positive(src.maxUsers), LIMITS.maxUsers),
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
  const v = normalize(keepPrevBlankNumbers(next, load()));
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  atomicWriteFileSync(FILE(), JSON.stringify(v, null, 2), { mode: 0o600 });
  _cache = v;
  for (const cb of listeners) { try { cb(v); } catch { /* 구독자 오류가 저장을 막지 않게 */ } }
  return v;
}

export function _resetForTest() { _cache = null; }
