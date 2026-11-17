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
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { makeJsonFileLoader } from '../util/jsonFileLoad.js';   // 90회차 F3: 읽기 오류 ≠ 손상(결정 G2 공용 로더 — 36회차 '남긴 것')
import { numOrNull } from '../util/numOrNull.js';
import { clampSetting } from '../util/clampSetting.js'; // v2.613 DEPS2613-12 · RUNTIME2613-08: 숫자 설정 정규화는 하나(빈 칸 = 미지정)

const FILE = () => path.join(config.configDir, 'horizon-sessions.json');

export const LIMITS = Object.freeze({
  // 5분 기본. '실시간' 이라도 1분 주기는 28법인 고RTT 환경에서 로그인 왕복을 과하게 만든다.
  intervalMs: { min: 60_000, max: 6 * 3600_000, def: 5 * 60_000 },
  retentionDays: { min: 1, max: 3650, def: 180 },
  // v2.684 앱별 사용 누적(사용자×서비스 하루 1행) 보존 — 기본 400일(작년 같은 달과 비교할 수 있게).
  usageRetentionDays: { min: 7, max: 3650, def: 400 },
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
    usageRetentionDays: clampSetting(positive(src.usageRetentionDays), LIMITS.usageRetentionDays),
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

/*
 * 90회차 F3(재현 — 36회차 '남긴 것'): 예전 catch 하나는 **읽기 오류**(EACCES · EIO · EISDIR)도 손상으로 보고 온전한 원본을 `.corrupt` 로 옮긴 뒤
 *   기본값(꺼짐 · 보존 180일 · 서버별 끔 설정 없음)을 **프로세스 수명 동안** 캐시했다 — 수집이 조용히 멈추고, 화면에서 저장하면 그 기본값 위에 썼다.
 *   판정은 공용 로더 하나다: 손상만 보존본으로 옮기고(사유와 함께 · 서비스 점검에 등재), 읽기 오류는 원본을 두고 30초마다 다시 읽으며 그동안 저장을 409 로 거절한다.
 *   도는 값은 예전처럼 기본값이다(꺼짐 — 손상 · 읽기 오류 동안 주기 수집을 하지 않는다). 손상 상태의 관리자 저장이 오류를 푸는 규약은 다른 설정과 같다.
 */
const _file = makeJsonFileLoader(() => FILE(), { label: 'Horizon 실시간 사용자 수집 설정(horizon-sessions.json) — 확정하면 기본값(수집 꺼짐)으로 저장됩니다', confirm: () => save({}), tag: 'horizon-sessions' });
/** 설정 파일을 못 읽었으면 `{ reason, at, readError }`(요약 — 파일 조각 없음), 읽었으면 null. */
export function horizonSessionSettingsLoadError() { load(); return _file.marker(); }

export function load() {
  if (_cache && !_file.recheckDue()) return _cache;   // 오류 중에는 캐시를 믿지 않고 간격마다 다시 판정(보존본을 되돌리면 재시작 없이 풀린다)
  const r = _file.load();
  _cache = normalize(r.kind === 'ok' ? r.value : {});
  return _cache;
}

export function save(next) {
  const cur = load();
  // 90회차 F3: 읽기 오류면 원본이 디스크에 그대로 있다 — 기본값 위에 쓰면 그 원본(켜짐 · 주기 · 서버별 끔)을 덮는다(라우트 409).
  if (_file.loadError()?.readError) {
    const no = _file.refusal('Horizon 실시간 사용자 수집 설정');
    throw Object.assign(new Error(no?.reason || 'Horizon 실시간 사용자 수집 설정 파일을 읽지 못해 저장하지 않았습니다.'), { status: 409, code: 'settings-unreadable' });
  }
  const v = normalize(keepPrevBlankNumbers(next, cur));
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  atomicWriteFileSync(FILE(), JSON.stringify(v, null, 2), { mode: 0o600 });
  _cache = v;
  _file.saved();
  for (const cb of listeners) { try { cb(v); } catch { /* 구독자 오류가 저장을 막지 않게 */ } }
  return v;
}

export function _resetForTest() { _cache = null; _file.saved(); }
