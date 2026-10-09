/**
 * storage/onefsAreaSummary.js — OneFS API 영역 수집 요약 한 줄의 **모양**(v2.730 검토 I-03 — 순수, import 없음).
 *
 * ⚠⚠ 왜 있나: v2.598~v2.729 의 영역 요약은 `{area, ok, failed}` 뿐이라, 시한(signal)·인증 실패(401)·연속 전송 오류로
 *   **영역 중간에서** 멈추면 그 영역은 남은 엔드포인트가 있는데도 `failed === 0` 이 되어 화면이 **초록 '정상'** 으로 칠했다
 *   (재현: cluster 영역 엔드포인트 3개 중 첫째만 성공한 뒤 시한 → `{area:'cluster', ok:1, failed:0}`). 이후 영역만
 *   `notTried` 로 표시됐다. 같은 원인으로 '첫 요청 전에 시한이 끊은 영역' 도 `{ok:0, failed:0}` 로 초록이었다.
 *
 * 규칙(테스트가 하나씩 고정한다 — test/rvC_onefsAreas.test.js):
 *  - 영역마다 `expectedEndpoints`(카탈로그의 엔드포인트 수) · `attempted`(응답을 받았거나 실제로 실패한 요청 수 = ok + failed) ·
 *    `notTriedEndpoints`(= expected − attempted) · `partial`(시도했는데 끝까지 못 감) · `stopReason`(멈춘 영역과 그 뒤 영역) 을 싣는다.
 *  - **시한이 끊은 요청은 failed 가 아니다** — 장비가 실패한 것이 아니라 우리가 끊은 것이므로 미시도(notTriedEndpoints)로 센다.
 *  - 한 엔드포인트도 시도하지 못한 영역은 '부분' 이 아니라 **미시도**(`skipped + notTried`)다 — 이후 영역과 같은 모양이다.
 *  - 기존 `notTried`(반환값·`extra.areasNotTried`)는 **영역 개수** 단위 그대로다. 엔드포인트 개수는 새 필드
 *    (`notTriedEndpoints`·`extra.areasNotTriedEndpoints`)로 따로 싣는다 — 단위를 바꾸면 구버전 화면 문구가 거짓이 된다.
 *  - 중단 전 읽은 값은 DB 에 그대로 저장한다(areasCollector) — 다만 그 영역을 '정상' 으로 판정하는 근거로 쓰지 않는다
 *    (판정은 웹 `views/tools/onefsAreaState.js` 하나가 소유한다).
 */

/** 연속 전송 실패(HTTP 응답 자체가 없음) 이 횟수면 나머지 영역을 시도하지 않는다(v2.598 T2598-01). */
export const TRANSPORT_FAIL_LIMIT = 3;

/** 멈춘 사유 코드 — 웹 onefsAreaState.js 의 STOP_REASON_TEXT 키와 1:1. */
export const AREA_STOP_REASONS = Object.freeze(['auth', 'deadline', 'transport']);

/** 멈춘 뒤 시도하지 않은 영역에 붙이는 사유(화면이 그대로 보여준다). */
export const STOP_TEXT = Object.freeze({
  auth: '인증 실패로 나머지 영역을 시도하지 않았습니다(계정 잠금 예방)',
  deadline: '영역 수집 시한 초과로 이번 주기에는 시도하지 않았습니다',
  transport: `장비 응답 없음(연속 ${TRANSPORT_FAIL_LIMIT}회)으로 이번 주기에는 시도하지 않았습니다`,
});

const cnt = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/**
 * 시도한(엔드포인트를 하나 이상 부른) 영역의 요약 한 줄.
 * @param {string} areaKey
 * @param {{ expected:number, ok:number, failed:number, firstErr?:string, stopReason?:string|null }} o
 */
export function triedAreaEntry(areaKey, { expected, ok, failed, firstErr = '', stopReason = null }) {
  const okN = cnt(ok); const failN = cnt(failed);
  const attempted = okN + failN;
  const exp = Math.max(cnt(expected), attempted);
  const left = exp - attempted;
  return {
    area: areaKey, ok: okN, failed: failN,
    expectedEndpoints: exp, attempted, notTriedEndpoints: left, partial: left > 0,
    ...(stopReason ? { stopReason } : {}),
    ...(firstErr ? { error: String(firstErr).slice(0, 120) } : {}),
  };
}

/** 이번 주기에 한 엔드포인트도 시도하지 않은 영역(멈춘 영역의 첫 요청 전 중단 · 그 뒤 영역). */
export function notTriedAreaEntry(areaKey, expected, stopReason) {
  const exp = cnt(expected);
  return {
    area: areaKey, ok: 0, failed: 0, skipped: true, notTried: true,
    expectedEndpoints: exp, attempted: 0, notTriedEndpoints: exp, partial: false,
    ...(stopReason ? { stopReason } : {}),
    error: STOP_TEXT[stopReason] || '이번 주기에는 시도하지 않았습니다',
  };
}

/** 카탈로그에서 꺼 둔 영역(원래 수집하지 않는 영역 — 미시도와 다르다). */
export function disabledAreaEntry(area) {
  return { area: area.key, ok: 0, failed: 0, skipped: true, error: area.reason };
}

/**
 * 요약 배열 → 장비 단위 합계. 비활성 영역(카탈로그)은 세지 않는다.
 * @returns {{ expectedEndpoints:number, attemptedEndpoints:number, notTried:number, notTriedEndpoints:number, partialAreas:number }}
 */
export function areaTotals(summary) {
  const t = { expectedEndpoints: 0, attemptedEndpoints: 0, notTried: 0, notTriedEndpoints: 0, partialAreas: 0 };
  for (const a of Array.isArray(summary) ? summary : []) {
    if (!a || (a.skipped && !a.notTried)) continue;
    t.expectedEndpoints += cnt(a.expectedEndpoints);
    t.attemptedEndpoints += cnt(a.attempted);
    t.notTriedEndpoints += cnt(a.notTriedEndpoints);
    if (a.notTried) t.notTried += 1;
    if (a.partial === true) t.partialAreas += 1;
  }
  return t;
}

/**
 * 영역 수집 결과 → 스냅샷 `extra` 에 싣는 필드(poller 가 쓴다). 실제 수집기·데모 합성이 같은 함수를 지난다.
 *   `areasExpectedEndpoints` 는 늘 싣는다(화면이 '엔드포인트 n/m' 을 말한다). 멈췄을 때만 `areasStopped` ·
 *   `areasNotTried`(영역 개수 — 예전 단위) · `areasNotTriedEndpoints` · `areasPartial`.
 */
export function areasExtraFields(r, now = Date.now()) {
  const t = areaTotals(r?.summary);
  return {
    areas: r?.summary || [], areasAt: now, areasEndpoints: r?.endpoints ?? null,
    areasExpectedEndpoints: t.expectedEndpoints,
    ...(r?.stopped ? {
      areasStopped: r.stopped,
      areasNotTried: r.notTried ?? t.notTried,
      areasNotTriedEndpoints: t.notTriedEndpoints,
      areasPartial: t.partialAreas,
    } : {}),
  };
}
