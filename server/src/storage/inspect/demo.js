/**
 * storage/inspect/demo.js — 데모(mock) 모드 점검 사실 합성(v2.965). 실장비 값이 아니다 — 화면 · 보고서 · 테스트가 상태 다섯 가지를 모두 보이게.
 * 장비 id 로 정해지는 결정적 값(새로고침해도 같은 결과). 프랑크푸르트 = 드라이브 SMARTFAIL + 재보호 진행 + HealthCheck 권한 없음,
 * 애슈번 = SyncIQ 실패 1, 상하이 = REST 만(SSH 항목 확인 불가), 그 밖 = 대체로 정상. 서울은 스냅샷 12%.
 */
const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; };

export function demoInspectFacts(dev, now = Date.now()) {
  const id = String(dev?.id || '');
  const nodes = Math.max(3, Math.min(16, Number(dev?.nodeCount) || 4 + (hash(id) % 5)));
  const fra = /fra/i.test(id); const ash = /ash/i.test(id); const sha = /sha/i.test(id); const sel = /sel/i.test(id);
  const facts = {}; const why = {}; const errors = [];
  facts.group = { inGroup: nodes, total: nodes, down: [] };
  facts.drives = fra ? { total: nodes * 60, notHealthy: [{ lnn: 5, bay: 'Bay 7', state: 'SMARTFAIL' }] } : { total: nodes * 24, notHealthy: [] };
  facts.bootMirror = { total: nodes, bad: [] };
  facts.psu = { total: nodes * 2, bad: [] };
  facts.battery = { total: nodes, bad: [] };
  facts.ifaces = { configured: nodes * 4, down: [] };
  facts.healthcheck = { evaluations: 14, failed: [], lastAt: now - 2 * 86_400_000 };
  facts.ntp = { servers: 2 };
  facts.events = fra ? { total: 3, critical: 1, warning: 2, severityKnown: true, source: 'event-groups' } : { total: ash ? 1 : 0, critical: 0, warning: ash ? 1 : 0, severityKnown: true, source: 'event-groups' };
  facts.snapshots = { count: 40 + (hash(id) % 60), usedBytes: 0, largestBytes: 0, partial: false }; // 비율은 아래에서 용량에 맞춘다(fillDemoRatios)
  facts.synciq = ash ? { policies: 6, reports: 35, failed: 1, failedPolicies: ['ash-to-fra-home'] } : sha || /sin/i.test(id) ? { policies: 0, reports: 0, failed: 0, failedPolicies: [] } : { policies: 4, reports: 21 + (hash(id) % 10), failed: 0, failedPolicies: [] };
  facts.jobs = fra ? { failed: [], running: [{ name: 'FlexProtect[2231]', phase: '2/6', progress: '62%' }] } : { failed: [], running: [] };
  facts.vhs = { enabled: true, pct: 10, bytes: null, source: 'settings' };
  facts._snapPct = sel ? 12 : 3 + (hash(id) % 6);
  if (fra) { delete facts.healthcheck; why.healthcheck = '권한 없음 — 수집 계정에 ISI_PRIV_SYS_SUPPORT 권한이 없습니다(데모)'; errors.push({ step: 'healthcheck', error: why.healthcheck }); }
  if (sha) {
    for (const k of ['group', 'bootMirror', 'psu', 'battery', 'healthcheck']) { delete facts[k]; why[k] = 'REST 로 읽는 경로가 없습니다 — SSH 로 수집하는 장비만 읽습니다(데모)'; }
  }
  return { facts, why, errors };
}
/** 데모 스냅샷 비율 — 용량을 알면 스냅샷 바이트를 그 비율로 채운다(판정이 비율로 보므로). */
export function fillDemoRatios(facts) {
  const tot = Number(facts?.capacity?.totalBytes);
  if (facts?.snapshots && facts._snapPct != null && tot > 0) {
    facts.snapshots.usedBytes = Math.round((tot * facts._snapPct) / 100);
    facts.snapshots.largestBytes = Math.round(facts.snapshots.usedBytes * 0.07);
  }
  delete facts?._snapPct;
  return facts;
}
