/**
 * vCenter REST 폴백 표지 해석(v2.607, 감사 WEB2607-06 · LEFT2607-04).
 *
 * SOAP 이 실패해 REST 목록 API 로 수집된 vCenter 는 서버(vcenter/restClient.js)가 `collectSource:'rest'`·
 * `restUnknown:['cluster','vmPlacement','alarms']`·`alarmsUnknown:true` 를 싣는다. 엣지 위임 vCenter 는 중앙 병합에서
 * collectSource 가 'site' 로 덮이므로 원래 값은 `collectMethod` 로 보존된다(store.js).
 * 경보를 **조회하지 않았으므로** alarms:[] 는 '경보 0건' 이 아니다 — 초록 0 으로 칠하거나 합계에 0 으로 더하지 않는다.
 */
const UNKNOWN_LABEL = { cluster: '클러스터', vmPlacement: 'VM 배치(호스트별 VM)', alarms: '경보' };

export function isRestFallback(site) {
  if (!site || typeof site !== 'object') return false;
  return site.collectSource === 'rest' || site.collectMethod === 'rest' || site.alarmsUnknown === true
    || (Array.isArray(site.restUnknown) && site.restUnknown.length > 0);
}

/** 이 vCenter 의 경보 수를 모르는가(REST 폴백은 경보를 조회하지 않는다). */
export function alarmsUnknown(site) {
  if (!site || typeof site !== 'object') return false;
  if (site.alarmsUnknown === true) return true;
  if (Array.isArray(site.restUnknown) && site.restUnknown.includes('alarms')) return true;
  return site.collectSource === 'rest' || site.collectMethod === 'rest';
}

/** 카드 배지 — REST 폴백이 아니면 null. */
export function restFallbackBadge(site) {
  if (!isRestFallback(site)) return null;
  const miss = (Array.isArray(site.restUnknown) ? site.restUnknown : ['alarms']).filter((k) => typeof k === 'string').map((k) => UNKNOWN_LABEL[k] || k);
  return {
    label: 'REST 폴백',
    title: `SOAP 수집이 실패해 REST 목록 API 로 받은 스냅샷입니다 — 미수집: ${miss.length ? miss.join('·') : '일부 항목'}. 경보 수 '—' 는 0건이 아니라 조회하지 않았다는 뜻입니다.`,
  };
}

/** 사이트 목록 → 경보 합계(경보를 모르는 vCenter 는 빼고 개수를 센다). */
export function alarmTotals(sites) {
  let critical = 0; let warning = 0; let unknown = 0;
  for (const s of Array.isArray(sites) ? sites : []) {
    if (alarmsUnknown(s)) { unknown += 1; continue; }
    const m = (s && s.metrics) || {};
    critical += Number(m.alarmsCritical) || 0;
    warning += Number(m.alarmsWarning) || 0;
  }
  return { critical, warning, total: critical + warning, unknown };
}
