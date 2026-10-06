// v2.707(C11) — 비용 배분(쇼백) 문구. 계산은 서버 cost/analyze.js. 문구에 백틱·별표 금지.
export const GROUP_LABEL = Object.freeze({ vcenter: '법인(vCenter)', cluster: '클러스터', folder: '폴더', tag: '태그 카테고리' });
export const OFF_POLICY_LABEL = Object.freeze({ full: '꺼진 VM 도 전부 계산', storage: '꺼진 VM 은 스토리지만', none: '꺼진 VM 은 빼기' });
export const STORAGE_BASIS_LABEL = Object.freeze({ used: '실제 사용(committed)', provisioned: '할당(사용 + thin 여유)' });
/** 금액 — 값이 없으면 '—'. 통화 기호·코드는 그대로 붙인다. */
export function moneyText(v, currency) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const s = n.toLocaleString('ko-KR', { maximumFractionDigits: n >= 1000 ? 0 : 2 });
  return currency ? `${s} ${currency}` : s;
}
export function numText(v, unit = '') {
  if (v == null || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}${unit}` : '—';
}
/** 단가 안내 — 비면 할당량만, 일부만 있으면 그 사실. */
export function ratesNote(data) {
  if (!data) return null;
  if (!data.ratesSet) return '단가가 설정되지 않아 비용은 계산하지 않고 할당량만 보여 줍니다 — 단가는 이 화면의 단가 설정에서 입력합니다(관리자).';
  if (data.partialRates) {
    const miss = [['vcpu', 'vCPU'], ['ramGB', '메모리'], ['storageGB', '스토리지']].filter(([k]) => data.rates?.[k] == null).map(([, l]) => l);
    return `${miss.join('·')} 단가가 비어 있어 합계는 입력한 항목만 더한 값입니다.`;
  }
  return null;
}
export function notesText(data) {
  const n = data?.notes || {};
  const parts = [];
  if (n.excludedOff) parts.push(`꺼진 VM ${n.excludedOff.toLocaleString()}대는 설정대로 뺐습니다`);
  if (n.storageUnknown) parts.push(`스토리지 용량을 모르는 VM ${n.storageUnknown.toLocaleString()}대는 스토리지 합계에서 빠졌습니다`);
  if (n.tagUnknown) parts.push(`태그를 읽지 못한 vCenter 의 VM ${n.tagUnknown.toLocaleString()}대는 '(태그 확인 안 됨)' 으로 묶었습니다`);
  if (n.multiTag) parts.push(`같은 카테고리 태그가 둘 이상인 VM ${n.multiTag.toLocaleString()}대는 첫 태그에만 넣었습니다(두 번 세지 않습니다)`);
  return parts.length ? `${parts.join(' · ')}.` : null;
}
export const BASIS_NOTE = '비용은 할당 기준(차지한 vCPU·메모리·스토리지 × 월 단가)입니다 — 실제 사용률과 무관하며, 청구서가 아니라 배분 참고값입니다.';
