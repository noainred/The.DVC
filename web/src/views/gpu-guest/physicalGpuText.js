/**
 * 물리(베어메탈) GPU 서버 행의 '일부 GPU 응답 없음' 판정 — 순수 함수(vitest 가 고정한다).
 *
 * v2.782(점검 K5 E-B2): 서버(gpu/physicalPoller.js)는 nvidia-smi 가 읽지 못한 GPU 장수를 gpuErrors 로 싣는데
 *   PhysicalGpuManager 는 이 값을 버려, 8장 중 1장이 죽은 서버가 '7GPU · 수집(초록)' 으로 보였다(하드웨어 장애 은폐).
 *   문구는 새로 만들지 않고 GPU 사용 화면과 같은 gpuErrText 를 쓴다(판정 코어 하나). 0·null·undefined(모름)·이상값이면
 *   표지를 지어내지 않는다 — 못 읽은 값은 0 도 장애도 아니다.
 */
import { gpuErrText } from '../tools/gpuUsageText.js';

export const PGPU_GPU_ERR_TITLE = 'nvidia-smi 가 이 수만큼 GPU 를 읽지 못했습니다(드라이버·장치 점검 필요). 사용률·메모리는 응답한 GPU 기준입니다.';

/**
 * 수집 결과 행 → { text, tone }. text 가 빈 문자열이면 추가 표지 없음(tone 'green').
 * @param {{gpuErrors?:any}|null|undefined} r
 * @returns {{ text:string, tone:'amber'|'green' }}
 */
export function physicalGpuErrView(r) {
  const text = gpuErrText(r?.gpuErrors);
  return { text, tone: text ? 'amber' : 'green' };
}

/** 수집에 성공한(count 가 있는) 행 중 일부 GPU 가 응답하지 않은 서버 수 — 요약 줄의 '그중' 배지용. */
export function physicalGpuErrServers(rows) {
  if (!Array.isArray(rows)) return 0;
  return rows.filter((r) => r && r.count != null && !r.error && physicalGpuErrView(r).text).length;
}

/**
 * 95회차 F1: 물리 GPU 서버 등록부 로드 오류(GET /admin/gpu-physical 의 loadError — 서버 요약 `{ code, text, readError }`) → 배너 문구.
 *   읽기 오류는 원본이 그대로 있고 저장이 막힌다 · 손상은 보존본으로 옮겼고 관리자 저장이 새 등록부를 만든다(그때 보존본의 다른 서버는 다시 등록해야 한다).
 *   없으면 빈 문자열. 화면 문구에 백틱을 쓰지 않는다.
 * @param {{code?:string|null, text?:string, readError?:boolean}|null|undefined} le
 */
export function physicalLoadErrorText(le) {
  if (!le || typeof le !== 'object') return '';
  const why = typeof le.text === 'string' && le.text.trim() ? le.text.trim().slice(0, 200) : '사유 미상';
  if (le.readError === true || le.code === 'read-error') {
    return `물리 GPU 서버 등록부(gpu-physical.json)를 읽지 못했습니다(${why}) — 원본은 그대로 있고, 읽힐 때까지 등록 · 수정 · 삭제를 막습니다. 파일 권한 · 소유자 · 디스크를 확인하세요.`;
  }
  return `물리 GPU 서버 등록부(gpu-physical.json)를 읽지 못했습니다(${why}) — 손상본은 보존본(.corrupt.*)으로 옮겼습니다. 목록이 비어 보여도 등록이 없다는 뜻이 아닙니다. 보존본을 되돌리거나, 여기서 저장하면 새 등록부가 만들어집니다(보존본의 다른 서버는 다시 등록해야 합니다).`;
}
