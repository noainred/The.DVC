/**
 * 공개 API 의 **시각 표기 단일 소유자** (v2.562) — 순수 모듈.
 *
 * ⚠⚠ **이 저장소의 시각 필드는 두 가지 꼴로 섞여 있다.** `store.js:402` 의
 * `snap.generatedAt` 은 **ISO 8601 문자열**(`new Date().toISOString()`)이고, DB·엣지 계열
 * (`collectedAt`·`openedAt`·`lastSeenAt` …)은 대부분 **epoch ms 숫자**다. 그래서 공개 API 가
 * 시각을 `numOrNull()` 로 통과시키면 **ISO 문자열이 `null` 이 된다**(v2.562 자체 검증에서
 * 실제로 `/inventory/collection` 의 `generatedAt` 이 그랬다).
 *
 * 그것은 단순한 형식 문제가 아니라 **이 API 최악의 거짓**이다 — 공개 계약이
 * "읽지 못한 값은 null"(`openapi.js CONTRACT_NOTES`)이라고 못 박고 있으므로, 값을 갖고
 * 있는데 `null` 을 주면 상대 포탈은 **'수집 시각을 읽지 못했다'** 고 읽는다.
 *
 * ⚠ 표기는 **epoch ms 하나**다 — 봉투의 `generatedAt` 이 이미 `Date.now()` 이므로
 *   같은 응답 안에서 두 표기가 섞이면 소비자가 파싱을 두 벌 만들어야 한다.
 *
 * ⚠ **숫자 문자열을 `Date.parse` 에 넘기지 말 것** — `Date.parse('12345')` 는 **연도 12345**
 *   로 해석돼 `epoch 3.2e14`(서기 12345년)가 된다. 그래서 숫자 꼴을 **먼저** 본다.
 */

/**
 * 시각을 epoch ms 로 되돌린다. 읽을 수 없으면 `null`(0 으로 채우지 않는다).
 * @param {*} v epoch ms 숫자 · 숫자 문자열 · ISO 8601 문자열 · Date
 * @returns {number|null}
 */
export function msOrNull(v) {
  if (v == null) return null;
  if (v instanceof Date) { const t = v.getTime(); return Number.isFinite(t) ? t : null; }
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;       // 불리언·배열·객체는 시각이 아니다
  const s = v.trim();
  if (s === '') return null;                     // ⚠ `Number('') === 0` 함정(v2.561 규약)
  // ① 숫자 꼴을 먼저 — 위 주석의 `Date.parse('12345')` 오해석을 구조적으로 피한다.
  if (/^-?\d+(\.\d+)?$/.test(s)) { const n = Number(s); return Number.isFinite(n) ? n : null; }
  // ② ISO 8601 등 날짜 문자열
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export default msOrNull;
