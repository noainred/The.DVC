/**
 * v2.628(감사 LEFT2628-01): 성능 샘플러가 가장 최근 주기에 **적재하지 않은 것** 을 한 줄로 말한다(순수).
 *
 * 서버 lastRun(v2.620 staleSkipped · v2.622 vmperfStale·vmStatsSkipped)과 /tools/waste/history 의 `sampler`
 * (같은 값의 개수 요약 — 전체 범위 계정에만 온다)를 둘 다 받는다. 예전에는 이 값을 어느 화면도 읽지 않아
 * 추이의 마지막 전체 합계 점이 '적재 보류' 인지 '점검중 vCenter 를 뺀 부분 합' 인지 알 수 없었다.
 * 제외가 없으면 null(빈 줄을 만들지 않는다). 문구에 백틱·별표를 쓰지 않는다(평문으로 그린다).
 */
const REASON_LABEL = { maintenance: '점검중', unreachable: '수집 실패', stale: '위임 보고 낡음' };

const cnt = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** lastRun(원본) 또는 sampler 요약을 같은 모양으로 맞춘다. */
export function normalizeWithheld(x) {
  if (!x || typeof x !== 'object') return null;
  if ('staleVcenters' in x || 'maintenanceExcluded' in x || 'totalPartial' in x) {
    return {
      staleVcenters: cnt(x.staleVcenters), byReason: x.byReason && typeof x.byReason === 'object' ? x.byReason : {},
      totalWithheld: !!x.totalWithheld, totalPartial: !!x.totalPartial,
      maintenanceExcluded: cnt(x.maintenanceExcluded), vmStatsSkipped: cnt(x.vmStatsSkipped),
      dsUsedUnknown: cnt(x.dsUsedUnknown), vmStorageUnknown: cnt(x.vmStorageUnknown),   // v2.727(C-01)
    };
  }
  const ss = x.staleSkipped || {}; const vs = x.vmperfStale || {};
  return {
    staleVcenters: cnt(ss.vcenters), byReason: ss.byReason && typeof ss.byReason === 'object' ? ss.byReason : {},
    totalWithheld: !!vs.totalWithheld, totalPartial: !!vs.totalPartial,
    maintenanceExcluded: cnt(vs.maintenanceExcluded), vmStatsSkipped: cnt(x.vmStatsSkipped),
    dsUsedUnknown: cnt(x.dsUsedUnknown), vmStorageUnknown: cnt(x.vmStorageUnknown),     // v2.727(C-01)
  };
}

function reasonText(byReason) {
  const parts = Object.entries(byReason || {})
    .filter(([, n]) => cnt(n) > 0)
    .map(([k, n]) => `${REASON_LABEL[k] || k} ${n}`);
  return parts.length ? ` (${parts.join(' · ')})` : '';
}

/**
 * @param {object|null} x lastRun 또는 sampler 요약
 * @param {{ totalView?: boolean }} [opts] totalView — 전체 합계 추이를 보고 있는가(합계 보류·부분 합 문구를 붙인다)
 * @returns {string|null}
 */
export function samplerWithheldNote(x, { totalView = true } = {}) {
  const n = normalizeWithheld(x);
  if (!n) return null;
  const out = [];
  if (n.staleVcenters) out.push(`최근 샘플에서 vCenter ${n.staleVcenters}곳을 적재하지 않았습니다${reasonText(n.byReason)} — 멈춘 값을 지금 값으로 쌓지 않기 위해서입니다`);
  if (totalView && n.totalWithheld) out.push('그래서 전체 합계는 이번 주기에 적재하지 않았습니다(부분 합은 거짓 하락이 됩니다)');
  else if (totalView && n.totalPartial) out.push(`전체 합계는 점검중 vCenter ${n.maintenanceExcluded || ''}${n.maintenanceExcluded ? '곳을' : '를'} 뺀 부분 합입니다`);
  if (n.vmStatsSkipped) out.push(`라이트사이징 누적에서 VM ${n.vmStatsSkipped}대를 뺐습니다`);
  // v2.727(C-01): 결측을 0 으로 채우지 않고 뺀 사실 — 추이의 마지막 점이 '못 읽은 장비를 뺀 값' 임을 말한다.
  if (n.vmStorageUnknown) out.push(`스토리지 용량을 읽지 못한 VM ${n.vmStorageUnknown}대는 VM 디스크 계열(할당·커밋·정지·스냅샷)에서 뺐습니다 — 0 으로 채우지 않았습니다`);
  if (n.dsUsedUnknown) out.push(`사용량을 읽지 못한 데이터스토어 ${n.dsUsedUnknown}개는 용량·사용 계열에서 뺐습니다`);
  return out.length ? `${out.join('. ')}.` : null;
}
