/**
 * 낭비 리소스 '7일 사용률 추이' 스파크라인의 **배치 조회 판정**(v2.502) — 순수 함수.
 *
 * 무엇이 문제였나(사용자 신고 2026-09-13): CPU/메모리 과할당 표는 상위 50대를 보여주는데,
 * 화면은 `ids.slice(0, 24)` 로 **앞 24건만** 서버에 요청했다. 나머지 26행은 응답의 `series` 에
 * 아예 없어 `points === undefined` → `…` 로 영원히 남았다. 더 나쁜 것은 안내 문구가 뜨지 않은
 * 점이다: 서버의 `truncated` 는 `요청 id 수 > 처리한 수` 로 계산되는데 화면이 이미 24건으로
 * 잘라 보냈으니 둘이 같아져 `false` 가 됐다. 즉 **잘라 놓고 잘랐다는 말을 하지 않았다.**
 *
 * 고치는 방향: 표에 보이는 행 전부를 **순차 배치**로 불러온다. 한 번에 다 보내지 않는 이유는
 * 고RTT vCenter 부하 때문이다(서버가 요청당 상한을 두고 배치 안에서 동시 6개로 QueryPerf).
 * 배치 크기는 **서버가 알려주는 값**(`maxVms`)을 쓴다 — 화면에 24를 하드코딩하지 않는다
 * (루트 CLAUDE.md 프론트 회귀 방지: 상한·주기 숫자는 API 가 주면 그것을 쓴다).
 *
 * 정직성: 아직 순서를 기다리는 행과 '조회했는데 데이터가 없는' 행을 구분해 표시한다.
 * 둘 다 `…` 로 보이면 사용자는 고장인지 대기인지 알 수 없다.
 */

/** 배치 분할. size 는 1 미만이면 1로 본다(무한 루프 방지). */
export function chunkIds(ids = [], size = 24) {
  const n = Math.max(1, Math.floor(Number(size) || 1));
  const list = (ids || []).filter(Boolean);
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/**
 * 셀 상태 판정.
 *  - `pending`  : 아직 이 VM 차례가 오지 않았거나 응답 대기 중 → '…'
 *  - `none`     : 조회했는데 vCenter 에 이력이 없다(null) → '—'
 *  - `short`    : 점이 1개 이하라 선을 그릴 수 없다 → '—'
 *  - `ok`       : 그린다
 * `requested` 는 '이 id 를 서버에 이미 물어봤는가'. 이것이 없으면 '아직 안 물어본 것' 과
 * '물어봤는데 없는 것' 을 구분할 수 없다.
 */
export function sparkCellState(points, requested = false) {
  if (points === undefined) return requested ? 'none' : 'pending';
  if (points === null) return 'none';
  if (!Array.isArray(points) || points.length < 2) return 'short';
  return 'ok';
}

/** 셀 상태 → 화면 문구·툴팁. 원인을 단정하지 않는다(확인한 것만 말한다). */
export function sparkCellText(state) {
  if (state === 'pending') return { text: '…', title: '추이를 순서대로 불러오는 중입니다.' };
  if (state === 'none') return { text: '—', title: 'vCenter 에 이 VM 의 성능 이력이 없습니다(전원 OFF·권한·수집 방식 등).' };
  if (state === 'short') return { text: '—', title: '점이 2개 미만이라 추이를 그릴 수 없습니다.' };
  return null;
}

/**
 * 진행 문구. 전부 끝났으면 빈 문자열(끝난 뒤에도 남는 안내는 소음이다).
 * 건너뛴 건수(범위 밖·스냅샷에 없음)는 **숨기지 않고** 밝힌다.
 */
export function sparkProgressText({ done = 0, total = 0, skipped = 0 } = {}) {
  if (total > 0 && done < total) return `추이 차트를 불러오는 중입니다 — ${done}/${total}대`;
  if (skipped > 0) return `${skipped}대는 추이를 조회하지 못했습니다(조회 범위 밖이거나 현재 인벤토리에 없는 VM).`;
  return '';
}

/**
 * 한 번에 몇 대까지 차트를 만들 것인가. 표가 아주 커질 때를 대비한 안전 상한이며,
 * 넘으면 **자른 사실을 문구로 밝힌다**(조용히 자르는 것이 이번 결함의 원인이었다).
 */
export const SPARK_ROW_CAP = 200;

/** 상한으로 잘렸을 때의 안내(자르지 않았으면 빈 문자열). */
export function sparkCapText(totalRows, cap = SPARK_ROW_CAP) {
  const n = Number(totalRows) || 0;
  if (n <= cap) return '';
  return `표의 ${n}대 중 상위 ${cap}대만 추이를 불러옵니다(vCenter 성능 조회 부담). 나머지는 '📊 리포트' 로 개별 확인하세요.`;
}
