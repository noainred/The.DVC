/**
 * PowerStore 볼륨 할당 합계 문구(순수, v2.603 감사 COL-2603-07 후속).
 * 서버(`storage/collectors/powerstore.js`)는 size 를 못 읽은 볼륨이 있으면 합계를 null 로 두고 `sizeUnknown` 개수를 싣는다
 * (0 으로 더해 부분 합을 전체라 말하지 않는다). 화면도 그 사실을 말한다 — 예전에는 null 이면 항목이 조용히 사라졌다.
 * @param {object} volumes inventory.volumes
 * @param {(bytes:number)=>string} fmt 용량 표기 함수
 * @returns {string} 앞에 ' · ' 가 붙은 조각 또는 ''
 */
export function volumeProvisionText(volumes, fmt) {
  const v = volumes || {};
  const unknown = Number.isInteger(v.sizeUnknown) && v.sizeUnknown > 0 ? v.sizeUnknown : 0;
  if (unknown) return ` · 할당 합계 — (크기를 읽지 못한 볼륨 ${unknown.toLocaleString()}개 — 0 으로 더하지 않았습니다)`;
  const b = v.provisionedBytes;
  return typeof b === 'number' && Number.isFinite(b) && b > 0 ? ` · 할당 ${fmt(b)}` : '';
}
