/**
 * 추이 화면의 '해상도·기준선' 문구 — 판정과 문장을 한 곳에서 소유한다(v2.578).
 *
 * ## 왜 이 모듈이 있나
 *
 * 사용자 질문(2026-09-14): "guestos 의 CPU·메모리 사용량을 7일로 조회하는 것과 14일·30일·60일로
 * 조회하면 결과가 모두 다른데 이유를 설명해줘." 조사 결론은 **기간은 필터가 아니라 해상도
 * 스위치**라는 것이다 — 기간을 늘리면 vCenter 도 이 포탈도 더 거친 롤업을 쓰고, 그래서 평균은
 * 거의 보존되지만 **최대·p95 는 구조적으로 달라진다**(밤 1시간 100% 스파이크가 30분 롤업에서
 * 100% · 2시간 롤업에서 52.5% · 1일 롤업에서 9%).
 *
 * 그 원인 자체는 설계대로이고 고칠 것이 아니다. **고쳐야 할 것은 화면이 그 사실을 말하지 않는
 * 것**이었다. v2.510 릴리스 노트가 결함 4건을 적고 "v2.511 로 분리" 라고 했는데 그 뒤 67개
 * 릴리스 동안 아무도 하지 않았다 — 이 모듈이 그 넷 중 D1·D3·D4 의 문구를 소유한다.
 *
 * ## ⚠⚠ D1 — `collectedSince` 를 '수집 시작' 이라 단정하지 말 것
 *
 * `metrics/vmperfDb.js vmperfMeta` 의 `firstTs` 는 **prune 된 `samples` 테이블의 MIN(ts)** 다
 * (`vmperfDb.js:146` + `:227` — `pruneVmperf` 가 보존일 이전 행을 지운다). 즉 그 값은
 *
 *     firstTs = max(실제 수집 시작, 지금 - 보존일)
 *
 * 이다. 보존 기본값은 90일(`metrics/vmperfSettings.js:48`). 그래서 90일 넘게 돌아간 포탈에서
 * 화면이 "수집 시작: <날짜> — 더 긴 기간은 그만큼 시간이 지나야 채워집니다" 라고 말하면
 * **거짓**이다. 120일·365일 구간은 **기다려도 영원히 채워지지 않는다**(보존이 90일이므로).
 * CLAUDE.md v2.493 '값이 없는 이유를 단정하지 말 것' 계열이다.
 *
 * 서버가 두 원인을 구분할 정보를 갖고 있지 않으므로(첫 행이 언제 들어왔는지는 지워진 뒤
 * 알 수 없다) **구분하지 않고 둘 다 말한다** — `kind: 'either'`. 지어내지 않는 쪽이다.
 *
 * ## 규약
 *
 * - 순수 함수만 둔다(웹 테스트는 node 환경이라 DOM 이 없다 — `accessDeniedText.js`·
 *   `version_4/loadState.js` 와 같은 관례). 회귀는 `trendMeta.test.js`.
 * - 문구에 **백틱을 쓰지 않는다**(`BoldText` 는 강조 표기만 해석하고 백틱은 글자로 샌다 —
 *   v2.439·2.440·2.505·2.545·2.553·2.576). 값 인용은 홑화살괄호로 한다.
 * - 수치는 `numOrNull` 로 좁힌다(`Number(null) === 0` — 여덟 번 재발한 결함).
 * - 주기·보존일 같은 **숫자를 문장에 박지 않는다** — 서버가 준 값만 쓴다(CLAUDE.md 규약).
 */
import { numOrNull } from '../numOrNull.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

/** 버킷 크기를 사람이 읽는 단위 하나로. 값이 없으면 null(단위만 붙여 0 처럼 보이게 하지 않는다). */
export function bucketLabel(bucketMs) {
  const ms = numOrNull(bucketMs);
  if (ms == null || ms <= 0) return null;
  if (ms % DAY_MS === 0) return `${ms / DAY_MS}일`;
  if (ms >= DAY_MS) return `${Math.round((ms / DAY_MS) * 10) / 10}일`;
  if (ms % HOUR_MS === 0) return `${ms / HOUR_MS}시간`;
  if (ms >= HOUR_MS) return `${Math.round((ms / HOUR_MS) * 10) / 10}시간`;
  return `${Math.max(1, Math.round(ms / MIN_MS))}분`;
}

/** 차트 각주용 — ‘12시간 평균’. 값이 없으면 null. */
export function bucketAvgLabel(bucketMs) {
  const l = bucketLabel(bucketMs);
  return l == null ? null : `${l} 평균`;
}

/**
 * D3 — 기간을 바꾸면 왜 값이 달라지는지 한 문장으로.
 *
 * 평균은 거의 보존되고 **최대·순간값이 평탄화**된다는 것이 핵심이다. 이것을 적지 않으면
 * 사용자는 7일 곡선과 60일 곡선을 같은 뜻으로 보고 직접 비교한다.
 */
export function resolutionNote(bucketMs) {
  const l = bucketLabel(bucketMs);
  if (l == null) return '기간을 바꾸면 집계 단위도 함께 바뀝니다 — 서로 다른 기간의 곡선을 직접 비교하지 마세요.';
  return `기간을 바꾸면 집계 단위도 함께 바뀝니다(지금 ${l}). 집계 단위가 굵어지면 평균은 거의 그대로지만 짧은 최대값은 평탄해집니다 — 서로 다른 기간의 곡선을 직접 비교하지 마세요.`;
}

/**
 * D1 — 기준선(언제부터의 자료인가)을 단정하지 않고 말한다.
 *
 * @returns {{kind:'none'|'start'|'either', text:string, waiting:boolean}}
 *   `waiting` 은 '기다리면 채워지는가' 다 — CLAUDE.md v2.509 규약(화면이 그것을 말해야 한다).
 *   `kind==='either'` 이면 기다려서 채워질지 **알 수 없으므로** false 다.
 */
export function sinceNote({ collectedSince, retentionDays, now } = {}) {
  const since = numOrNull(collectedSince);
  const keep = numOrNull(retentionDays);
  const at = numOrNull(now) ?? 0;
  if (since == null) {
    return { kind: 'none', waiting: true, text: '아직 이 계열의 표본이 없습니다 — 수집이 시작되면 쌓입니다.' };
  }
  const d = (ts) => new Date(ts).toLocaleDateString('ko-KR');
  // 보존이 켜져 있고(0 = 무제한) 첫 표본이 보존 경계에 하루 이내로 붙어 있으면, 그것이
  // '수집을 그때 시작했다' 인지 '그 이전이 지워졌다' 인지 **구분할 수 없다**.
  if (keep != null && keep > 0 && at > 0) {
    const edge = at - keep * DAY_MS;
    if (since - edge <= DAY_MS) {
      return {
        kind: 'either',
        waiting: false,
        text: `표본은 ${d(since)}부터 있습니다 — 수집을 그때 시작했거나, 보존 기간(${keep}일)을 지나 그 이전이 정리된 것입니다. 보존 경계라면 더 긴 기간은 기다려도 채워지지 않습니다.`,
      };
    }
  }
  return {
    kind: 'start',
    waiting: true,
    text: `표본은 ${d(since)}부터 있습니다(수집 시작) — 더 긴 기간은 그만큼 시간이 지나야 채워집니다.`,
  };
}

/**
 * D2 — 요청한 기간이 프리셋으로 내려앉았으면 그 사실을 말한다.
 *
 * `/tools/rightsize` 는 프리셋 밖이면 7일로, `POST /vms/usage` 는 30일로 조용히 떨어진다
 * (`toolsCapacity.js` · `vcenter/perfBatch.js normDays`). 응답은 정규화된 값을 싣지만 화면이
 * 요청값을 그대로 보여주면 사용자는 14일 결과라고 믿는다. 같으면 null(불필요한 배너 금지).
 */
export function normalizedDaysNote(requested, effective) {
  const a = numOrNull(requested);
  const b = numOrNull(effective);
  if (a == null || b == null || a === b) return null;
  return `요청한 ${a}일은 지원하지 않는 기간이라 ${b}일로 조회했습니다 — 아래 값은 ${b}일 기준입니다.`;
}

/**
 * D4 — 같은 ‘7일’ 이라도 화면마다 출처·해상도가 다르다. 그것을 각주에 적는다.
 *
 * 트리 2시간 · 리포트 30분 · 호스트 추이 30분 · vCenter 합계 1시간 — 각각 비용 근거가 있는
 * 설계지만(주석에 적혀 있다) **표기가 없으면 사용자에게는 불일치로만 보인다**.
 *
 * @param {{source:'vcenter'|'portal', intervalSec?:number, bucketMs?:number, statsLevel?:number}} o
 */
export function sourceNote({ source, intervalSec, bucketMs } = {}) {
  const sec = numOrNull(intervalSec);
  if (source === 'vcenter') {
    const l = sec != null && sec > 0 ? bucketLabel(sec * 1000) : null;
    return l ? `출처: vCenter 성능 롤업(${l} 구간)` : '출처: vCenter 성능 롤업';
  }
  const l = bucketAvgLabel(bucketMs);
  return l ? `출처: 포탈 시계열(${l})` : '출처: 포탈 시계열';
}

/**
 * 구간 최대 **사용률**을 낼 수 없던 구간이 있으면 밝힌다(v2.578).
 *
 * 분모가 그 구간의 **평균 할당**이라 구간 안에서 할당이 늘면 비율이 100% 를 넘는다 — 차트
 * y축이 0~100 이라 그대로 두면 조용히 잘려 ‘꽉 찼다’ 는 거짓이 된다. 서버가 그런 구간을
 * null 로 비우고 개수를 주므로, 화면은 **비운 사실**을 말한다(조용한 보정 금지).
 */
export function maxPctGapNote(count) {
  const n = numOrNull(count);
  if (n == null || n <= 0) return null;
  return `구간 ${n}개는 그 안에서 할당량이 바뀌어 최대 사용률(%)을 내지 않았습니다 — 절대량 보기에서는 그대로 보입니다.`;
}

/** 상한으로 잘렸으면 밝힌다(조용한 상한 금지 — CLAUDE.md v2.509). 안 잘렸으면 null. */
export function truncationNote({ truncated, covered, requestedDays } = {}) {
  if (!truncated) return null;
  const c = numOrNull(covered);
  const r = numOrNull(requestedDays);
  if (c == null || r == null) return '응답 상한에 걸려 요청한 기간의 일부만 표시합니다 — 집계 단위를 굵게 하면 전체 구간을 볼 수 있습니다.';
  return `응답 상한에 걸려 요청한 ${r}일 중 최근 약 ${c}일만 표시합니다 — 집계 단위를 굵게 하면 전체 구간을 볼 수 있습니다.`;
}
