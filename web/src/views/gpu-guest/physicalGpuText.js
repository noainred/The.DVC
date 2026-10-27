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
