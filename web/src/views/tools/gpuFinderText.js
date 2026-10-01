/**
 * 서버 분석 › GPU 찾기 머리 문구(v2.683). 합계는 Overview 'GPU 카드' 와 같은 기준(서버 `idrac/gpuCount.js`)이고,
 * 합계에 섞인 것(오래된 인벤토리·모델 미상)과 합계에 넣지 않은 것(비활성 서버·SSH 등록 GPU 물리 서버)을 따로 말한다.
 */
const n = (v) => Number(v) || 0;
export function gpuFinderNote(d) {
  if (!d) return '';
  const parts = [];
  if (n(d.gpusStale)) parts.push(`오래된 인벤토리 ${n(d.inventoryStale)}대의 ${n(d.gpusStale)}장 포함`);
  else if (n(d.inventoryStale)) parts.push(`오래된 인벤토리 ${n(d.inventoryStale)}대`);
  if (n(d.gpusUnnamed)) parts.push(`모델 미상 ${n(d.gpusUnnamed)}장 포함`);
  if (n(d.disabledServers)) parts.push(`비활성 ${n(d.disabledServers)}대 제외`);
  if (n(d.physicalServers)) {
    parts.push(d.physicalGpus != null
      ? `SSH 등록 GPU 물리 서버 ${n(d.physicalServers)}대 ${n(d.physicalGpus)}장은 합계에 넣지 않음`
      : `SSH 등록 GPU 물리 서버 ${n(d.physicalServers)}대`);
  }
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}
