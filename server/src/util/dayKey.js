/**
 * 날짜 경계 코어 — 하나다(v2.582 ARCH-2).
 *
 * 이 포탈의 사용자는 한국에 있고 '하루' 는 **한국 시각(UTC+9)** 기준이다(v2.531 스토리지 증가량 ·
 * v2.550 베어메탈 사용률 · v2.552 통신 점검이 각각 같은 판단을 했다). 그런데 v2.581 까지 그 판단이
 * **세 모듈에 세 벌**(`storage/db.js`·`bmusage/db.js`·`linkcheck/db.js`)로 복사돼 있었고 env 이름도
 * 셋(`STORAGE_GROWTH_TZ_OFFSET_MIN`·`BMUSAGE_TZ_OFFSET_MIN`·`LINKCHECK_TZ_OFFSET_MIN`)이었다 — 한 현장이
 * 시간대를 바꾸려면 세 값을 따로 맞춰야 하고, 하나만 바꾸면 화면마다 '어제' 가 다른 날이 된다.
 * 더 나쁜 것은 파싱이 달랐다는 점이다: storage 는 `Number.isFinite` 로 **0(UTC)** 을 받는데
 * bmusage·linkcheck 는 `|| 540` 이라 0 을 넣으면 **조용히 540 으로 되돌아갔다**.
 *
 * 그리고 내려받기 파일명·만료일 표시 30여 곳은 이 판단과 무관하게 `new Date().toISOString().slice(0,10)`
 * (**UTC 날짜**)를 썼다 — 한국 시각 00:00~09:00 에 내려받은 보고서 파일명이 **어제 날짜**가 되고,
 * 자정(KST)에 만료되는 라이선스가 **전날** 만료로 보였다(v2.582 BUG-3). 그 자리는 `dayKey()`/`todayStamp()` 다.
 *
 * 우선순위: `PORTAL_TZ_OFFSET_MIN` > 옛 이름 셋(호환 — 이미 설정한 현장이 깨지지 않게) > 540.
 * 빈 문자열·비수치는 무시하고 **0 은 유효한 값(UTC)** 이다.
 */
export const DEFAULT_DAY_OFFSET_MIN = 540;
export const DAY_MS = 86_400_000;

/** env 에서 오프셋(분)을 고른다. 순수 — 테스트가 우선순위·0 허용을 고정한다. (키를 풀어 쓴 이유: scripts/env-doc.mjs 가 `env.X` 를 읽는다) */
export function resolveDayOffsetMin(env = process.env) {
  const candidates = [env.PORTAL_TZ_OFFSET_MIN, env.STORAGE_GROWTH_TZ_OFFSET_MIN, env.BMUSAGE_TZ_OFFSET_MIN, env.LINKCHECK_TZ_OFFSET_MIN];
  for (const v of candidates) {
    if (v == null || String(v).trim() === '') continue;
    const n = Number(v);
    if (Number.isFinite(n) && Math.abs(n) <= 14 * 60) return n;
  }
  return DEFAULT_DAY_OFFSET_MIN;
}
export const DAY_OFFSET_MIN = resolveDayOffsetMin();

/** 입력을 epoch ms 로. Date·숫자·숫자문자열·ISO 문자열을 받고, 못 읽으면 NaN. */
export function toMs(ts) {
  if (ts == null) return NaN; // Number(null) === 0 함정(v2.525 규약) — null 을 1970-01-01 로 만들지 않는다
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'string') { const s = ts.trim(); if (!s) return NaN; return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : Date.parse(s); }
  return Number(ts);
}

/** epoch ms → `YYYY-MM-DD`(오프셋 적용). 못 읽으면 빈 문자열(날짜를 지어내지 않는다). */
export function dayKey(ts, offsetMin = DAY_OFFSET_MIN) {
  const t = toMs(ts);
  if (!Number.isFinite(t)) return '';
  return new Date(t + offsetMin * 60_000).toISOString().slice(0, 10);
}
/** 파일명용 오늘 날짜(오프셋 적용). */
export function todayStamp(now = Date.now(), offsetMin = DAY_OFFSET_MIN) { return dayKey(now, offsetMin); }
/** epoch ms → 일 인덱스(오프셋 적용). */
export function dayIndex(ts, offsetMin = DAY_OFFSET_MIN) { return Math.floor((Number(ts) + offsetMin * 60_000) / DAY_MS); }
/** 일 인덱스 → 그 날의 시작 epoch ms(오프셋 적용). */
export function dayStartMs(day, offsetMin = DAY_OFFSET_MIN) { return Number(day) * DAY_MS - offsetMin * 60_000; }
/** 일 인덱스 → `YYYY-MM-DD`(그 지역의 날짜). */
export function dayLabel(day, offsetMin = DAY_OFFSET_MIN) { return new Date(dayStartMs(day, offsetMin) + offsetMin * 60_000).toISOString().slice(0, 10); }
/** 그 지역의 벽시계 — 스케줄 판정용(v2.582 BUG-5: 서버 프로세스 TZ 가 아니라 이 오프셋으로 판정한다). */
export function localClock(ts = Date.now(), offsetMin = DAY_OFFSET_MIN) {
  const d = new Date(Number(ts) + offsetMin * 60_000);
  return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours(), minute: d.getUTCMinutes(), offsetMin };
}
