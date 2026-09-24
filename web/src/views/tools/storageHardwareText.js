/**
 * views/tools/storageHardwareText.js — PowerStore 하드웨어 인벤토리 요약 표지(순수, v2.599 감사 C2599-06).
 * 서버가 lifecycle_state 를 이상(unhealthy)·빈 슬롯(absent)·상태 미확인(unknown)으로 **나눠** 준다.
 * 빈 슬롯은 고장이 아니고, 미확인은 정상도 이상도 아니다(v2.523 규약) — '이상 없음' 한 마디로 덮지 않는다.
 * @returns {Array<{text:string, tone:'red'|'dim'|'ok'}>}
 */
export function hardwareSummaryParts(hw) {
  if (!hw || typeof hw !== 'object') return [];
  const n = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : 0);
  const bad = n(hw.unhealthy), absent = n(hw.absent), unknown = n(hw.unknown);
  const out = [];
  if (bad > 0) out.push({ text: `이상 ${bad}`, tone: 'red' });
  else if (unknown > 0) out.push({ text: '확인된 이상 없음', tone: 'ok' });
  else out.push({ text: '이상 없음', tone: 'ok' });
  if (unknown > 0) out.push({ text: `상태 미확인 ${unknown}`, tone: 'dim' });
  if (absent > 0) out.push({ text: `빈 슬롯 ${absent}`, tone: 'dim' });
  return out;
}
