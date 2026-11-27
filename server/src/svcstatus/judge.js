/**
 * svcstatus/judge.js — **포탈 서비스 상태 모니터링의 판정 코어 하나**(순수 · v3.54).
 *
 * 사용자 요청(2026-11-26): "포탈에 등록된 vcenter, edge 상태를 자동으로 등록하고 모니터링 하는 기능을 특수기능에 포탈 서비스 상태 모니터링 이라는
 * 제목으로 … 포탈에서 접속하는 엣지 ip/port 형태로 포트 모니터링 … cvp, 스토리지, vcenter … 포탈에 등록된 ip/port 형식으로 모니터링".
 * 시안 docs/design/portal-svc-status/README.md (컨펌 2026-11-27 '좋아 기본값대로 구현해줘').
 *
 * 상태 넷 — 정상(ok) · 지연(slow) · 끊김(down) · 못 잼(unknown). 그 밖 셋(off · excluded · problem)은 **화면 표지**이고 합계에 넣지 않는다.
 *   · 끊김 = 연속 `failThreshold` 회 연결 실패. 그 전의 실패는 '일시 실패'(표본 코드 2) — 직전 판정을 유지한다(한 번 끊겼다고 끊김이 아니다).
 *   · 지연 = 연결은 되지만 **대상별 평소**(최근 7일 성공 표본 중앙값)의 `slowFactor` 배를 넘고 그 차이가 `slowMinDeltaMs` 이상.
 *     고정 기준을 쓰면 폴란드 · 미국 동부(RTT 800ms+)가 늘 지연으로 뜬다(CLAUDE.md 운영 환경). 평소를 모르면 지연을 판정하지 않는다(지어내지 않는다).
 *   · 못 잼 = 측정값이 오지 않았거나 오래됐다 — **정상에도 끊김에도 세지 않는다**(CLAUDE.md '못 읽은 값은 0 이 아니다').
 *
 * ⚠ 웹은 이 판정을 다시 하지 않는다 — 서버가 준 `state`·`reason` 으로 색 · 문구만 고른다(코드 목록은 웹 시험이 이 파일과 대조한다).
 */
import { numOrNull } from '../util/numOrNull.js';

export const STATE_CODES = Object.freeze(['ok', 'slow', 'down', 'unknown', 'off', 'excluded', 'problem']);
/** 합계(정상 · 지연 · 끊김 · 못 잼)에 들어가는 상태. 나머지는 따로 센다. */
export const MEASURED_STATES = Object.freeze(['ok', 'slow', 'down', 'unknown']);

/** 행 사유 코드 — 문구는 웹 `svcStatusText.js` 표 하나(1:1 대조 시험). */
export const REASON_CODES = Object.freeze([
  'no-data', 'stale', 'judging',
  'edge-waiting', 'edge-silent', 'edge-old-version', 'edge-unknown-version', 'edge-disabled', 'edge-missing',
  'unassigned', 'registry-held',
  'disabled', 'demo-live', 'excluded', 'bad-address',
  'measure-off', 'db-unavailable',
]);

/**
 * 표본 코드(DB `sv_sample.st` · 30분 칸 `worst` · 띠 칸 값). 칸의 색은 그 칸의 **가장 나쁜** 표본.
 *   0 정상 · 1 지연 · 2 일시 실패(끊김 판정 전) · 3 끊김
 */
export const SAMPLE = Object.freeze({ ok: 0, slow: 1, fail: 2, down: 3 });

/** 화면 · 알림 정렬용 심각도(클수록 위). */
export const SEVERITY = Object.freeze({ down: 6, unknown: 5, slow: 4, ok: 3, problem: 2, off: 1, excluded: 0 });

/** 지연 판정에 쓰는 평소의 최소 표본 수 — 이보다 적으면 평소를 모른다(null). 30 = 60초 주기 30분. */
export const BASELINE_MIN_SAMPLES = 30;
/** 평소 창(일) — 화면이 '최근 N일 중앙값' 으로 말한다(API 값). */
export const BASELINE_DAYS = 7;
/** 시한의 상한 — 평소가 큰 대상의 시한을 늘려도 이것을 넘지 않는다. */
export const TIMEOUT_CEIL_MS = 15_000;
/** 시한 = max(설정 시한, 평소 × 이 배수) — 800ms 대상이 2.5초 시한에 가끔 걸려 거짓 실패하지 않게(시안 '평소가 큰 대상은 시한을 늘린다'). */
export const TIMEOUT_BASE_FACTOR = 4;

const n = numOrNull;

/** 평소가 큰 대상의 측정 시한(ms). */
export function timeoutFor(baseMs, settings = {}) {
  const set = n(settings.timeoutMs) ?? 2_500;
  const b = n(baseMs);
  const grown = b != null && b > 0 ? Math.round(b * TIMEOUT_BASE_FACTOR) : 0;
  return Math.min(TIMEOUT_CEIL_MS, Math.max(set, grown));
}

/** 지연 판정 경계(ms) — 평소를 모르면 null(지연을 판정하지 않는다). */
export function slowAtOf(baseMs, settings = {}) {
  const b = n(baseMs);
  if (b == null || b <= 0) return null;
  const f = n(settings.slowFactor) ?? 2;
  const d = n(settings.slowMinDeltaMs) ?? 0;
  return Math.max(b * f, b + d);
}

/**
 * 측정 하나 → 다음 판정(순수).
 * @param {{state?:string, failStreak?:number}|null} prev 직전 최신 행(없으면 null)
 * @param {{ok:boolean, ms?:number|null}} r 측정 결과
 * @param {object} settings `{ failThreshold, slowFactor, slowMinDeltaMs }`
 * @param {number|null} baseMs 평소
 * @returns {{ st:number, state:string, failStreak:number }} state 는 ok|slow|down|pending(첫 측정부터 실패 — 아직 판정 전)
 */
export function judgeSample(prev, r, settings = {}, baseMs = null) {
  const threshold = Math.max(1, Math.round(n(settings.failThreshold) ?? 3));
  if (r && r.ok === true) {
    const ms = n(r.ms);
    const at = slowAtOf(baseMs, settings);
    const slow = at != null && ms != null && ms > at;
    return { st: slow ? SAMPLE.slow : SAMPLE.ok, state: slow ? 'slow' : 'ok', failStreak: 0 };
  }
  const failStreak = Math.max(0, Math.round(n(prev?.failStreak) ?? 0)) + 1;
  if (failStreak >= threshold) return { st: SAMPLE.down, state: 'down', failStreak };
  const p = String(prev?.state || '');
  // 끊김 판정 전의 실패는 직전 판정을 유지한다 — 처음부터 실패면 '판정 중'(pending).
  const state = p === 'ok' || p === 'slow' || p === 'down' ? p : 'pending';
  return { st: SAMPLE.fail, state, failStreak };
}

/**
 * '측정이 멈췄다' 경계(ms) — 주기 3번을 놓치고 1분 여유. 하한 4분(60초 주기 기준).
 * 엣지 보고 · 중앙 측정 모두 같은 경계를 쓴다(판정 복제 금지).
 */
export function staleLimitMs(intervalMs) {
  const iv = n(intervalMs);
  const base = iv != null && iv > 0 ? iv * 3 + 60_000 : 0;
  return Math.max(4 * 60_000, base);
}

/**
 * 저장된 최신 행 → 화면 상태(순수). 측정이 오래됐거나 없으면 못 잼.
 * @param {object|null} latest `{ ts, state, failStreak }`
 * @returns {{ state:string, reason:string|null }}
 */
export function presentState(latest, { now = Date.now(), staleMs } = {}) {
  if (!latest || n(latest.ts) == null) return { state: 'unknown', reason: 'no-data' };
  if (now - n(latest.ts) > n(staleMs)) return { state: 'unknown', reason: 'stale' };
  const s = String(latest.state || '');
  if (s === 'ok' || s === 'slow' || s === 'down') return { state: s, reason: null };
  return { state: 'unknown', reason: 'judging' };
}

/**
 * 알림용 '못 잼' 경과(ms) — 측정값을 받을 수 있었던 때부터만 센다(점검 반증 #1 · #4 — 재현):
 *   시작 = 화면의 '언제부터 못 잼'(since) 또는 마지막 측정 + 멈춤 경계, 그리고 **중앙 기동 · 측정을 다시 켠 시각 + 멈춤 경계** 이후.
 *   중앙이 꺼져 있던 시간 · 측정을 꺼 둔 시간을 '못 잼' 으로 세면 재기동 · 다시 켜기 직후 전 대상 '못 잼' → 곧바로 '복구' 메일이 쏟아졌다.
 */
export function unknownForMsOf(row, { now = Date.now(), staleMs = 0, armedAt = 0 } = {}) {
  if (!row || row.state !== 'unknown') return 0;
  const since = n(row.since);
  const last = n(row.lastTs);
  const start = since != null ? since : (last != null ? last + (n(staleMs) ?? 0) : null);
  if (start == null) return 0;
  const from = Math.max(start, (n(armedAt) ?? 0) + (n(staleMs) ?? 0));
  return Math.max(0, now - from);
}

/** 성공 표본 배열의 중앙값(null · 비수치는 뺀다). 비면 null. */
export function median(values) {
  const a = (Array.isArray(values) ? values : []).map(n).filter((x) => x != null).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * 알림 수준(순수) — 화면 상태를 '알릴 상태' 로 접는다. 설정에서 끈 종류는 정상으로 본다.
 * 못 잼은 `unknownMin` 분 넘게 이어질 때만 'unknown' — 그 전에는 직전 알림 수준을 유지(hold).
 * @returns {'ok'|'slow'|'down'|'unknown'|'hold'|'quiet'}
 */
export function alertLevelOf(state, { alerts = {}, unknownForMs = 0 } = {}) {
  if (state === 'down') return alerts.down !== false ? 'down' : 'ok';
  if (state === 'slow') return alerts.slow === true ? 'slow' : 'ok';
  if (state === 'unknown') {
    const min = n(alerts.unknownMin) ?? 0;
    if (min <= 0) return 'hold';
    return unknownForMs >= min * 60_000 ? 'unknown' : 'hold';
  }
  if (state === 'ok') return 'ok';
  // off · excluded · problem — 사람이 끄거나 뺀 대상이다. '복구' 메일을 보내지 않고 알림 수준만 조용히 정상으로 되돌린다
  // (다시 넣었을 때 끊겨 있으면 그때 끊김을 알린다).
  return 'quiet';
}
