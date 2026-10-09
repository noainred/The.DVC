/**
 * guestDiskCsv.js — 게스트 디스크 회수 리포트의 조회 조건과 CSV 경로(순수 · vitest 가 고정).
 *
 * 검토 I-10(2026-10-09): CSV 버튼이 `downloadFile('/api/tools/guest-disk/export.csv?…')` 를 불렀다.
 * `api.js downloadFile` 은 **`/api` 이후 경로**를 받아 앞에 `/api` 를 붙이는 계약이라 실제 요청은
 * `/api/api/tools/guest-disk/export.csv` 가 되어 CSV 라우트에 닿지 못했다(화면 조회는 되고 CSV 만 실패).
 * 경로는 이 모듈 하나가 만들고 `/api` 를 붙이지 않는다 — 테스트가 실제 downloadFile 을 거친 URL 을 본다.
 *
 * 조회(`/tools/guest-disk`)와 CSV 는 **같은 조건 객체**를 쓴다. 화면은 마지막으로 반영된(응답을 받은) 조건을
 * 들고 있다가 CSV 에 넘긴다 — 입력칸에 쳐 놓고 '적용' 을 누르지 않은 값이 CSV 에만 들어가면 화면 표와 CSV 가
 * 다른 목록이 된다.
 */
import { numOrNull } from '../../numOrNull.js';

/**
 * 입력칸 문자열 → 조회 조건(서버 쿼리와 같은 이름).
 *   minReclaimGB: 읽지 못하면 0(전체) — 화면 기본값과 같다.
 *   maxRatioPct : 빈 값·숫자 아님이면 넣지 않는다(미적용). 공백만 있는 칸을 0% 로 읽지 않는다.
 *   usageFactor : 0 보다 크고 1 이 아닐 때만(1 은 서버 기본값).
 *   vcenterId   : 상단 vCenter 선택('' = 전체면 넣지 않는다).
 */
export function guestDiskParams({ minReclaimStr = '0', maxRatioStr = '', factorStr = '1', scope = '' } = {}) {
  const params = { minReclaimGB: numOrNull(minReclaimStr) ?? 0 };
  const ratio = numOrNull(maxRatioStr);
  if (ratio != null) params.maxRatioPct = ratio;
  const f = numOrNull(factorStr);
  if (f != null && f > 0 && f !== 1) params.usageFactor = f;
  if (scope) params.vcenterId = String(scope);
  return params;
}

/** CSV 경로 — `/api` 이후 경로(downloadFile 계약). params 는 guestDiskParams 결과. */
export function guestDiskCsvPath(params) {
  const p = params && typeof params === 'object' ? params : guestDiskParams();
  const q = new URLSearchParams();
  for (const k of ['minReclaimGB', 'maxRatioPct', 'usageFactor', 'vcenterId']) {
    if (p[k] != null && p[k] !== '') q.set(k, String(p[k]));
  }
  if (!q.has('minReclaimGB')) q.set('minReclaimGB', '0');
  return `/tools/guest-disk/export.csv?${q.toString()}`;
}
