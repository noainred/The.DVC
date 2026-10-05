// v2.701(A6) — 클러스터 HA·DRS 점검 문구. 판정은 서버 clustercfg/parse.js 가 한다(코드 집합은 1:1 — 테스트 대조).
// 문구에 백틱·별표 금지(BoldText 는 **강조** 만 해석).
export const CLUSTER_CFG_CODES = Object.freeze({
  'ha-off': 'warn',
  'ha-ac-off': 'warn',
  'ha-hostmon-off': 'warn',
  'hosts-ineffective': 'warn',
  'rule-violation': 'warn',
  'drs-off': 'info',
  'drs-manual': 'info',
  'rule-disabled': 'info',
  'evc-off-mixed': 'info',
  'single-host': 'info',
});

export const CLUSTER_TEXT = Object.freeze({
  'ha-off': { title: 'vSphere HA 가 꺼져 있습니다', fix: '호스트가 죽으면 그 위의 VM 이 자동으로 다시 켜지지 않습니다 · 클러스터 › 구성 › vSphere 가용성에서 켜세요' },
  'ha-ac-off': { title: 'HA 수용 제어가 꺼져 있습니다', fix: '장애 때 VM 을 다시 켤 여유 자원을 보장하지 않습니다 · 수용 제어(예: 클러스터 자원 비율)를 켜세요' },
  'ha-hostmon-off': { title: 'HA 호스트 모니터링이 꺼져 있습니다', fix: '호스트 장애를 감지하지 못해 HA 가 동작하지 않습니다 · 유지 작업이 끝났으면 다시 켜세요' },
  'hosts-ineffective': { title: '유효 호스트가 전체보다 적습니다', fix: '연결 끊김·유지보수 모드·HA 오류 호스트가 있습니다 · 그만큼 장애 여유가 줄었습니다' },
  'rule-violation': { title: '지켜지지 않는 선호도 규칙이 있습니다', fix: '반선호도 VM 이 같은 호스트에 있거나 VM-호스트 규칙이 어긋났습니다 · DRS 권장 사항을 적용하거나 수동으로 옮기세요' },
  'drs-off': { title: 'DRS 가 꺼져 있습니다', fix: '참고 · 부하 분산과 선호도 규칙 집행이 자동으로 일어나지 않습니다' },
  'drs-manual': { title: 'DRS 가 수동 모드입니다', fix: '참고 · 권장 사항이 쌓이기만 하고 적용되지 않습니다(부분·완전 자동화 검토)' },
  'rule-disabled': { title: '꺼진 선호도 규칙이 있습니다', fix: '참고 · 의도한 것이 아니면 규칙을 켜거나 지우세요' },
  'evc-off-mixed': { title: 'EVC 없이 CPU 모델이 섞여 있습니다', fix: '참고 · CPU 세대가 다르면 vMotion 이 막힐 수 있습니다 · EVC 모드를 검토하세요' },
  'single-host': { title: '호스트가 하나뿐인 클러스터입니다', fix: '참고 · HA·DRS 가 동작할 수 없습니다' },
});
export const SEV_LABEL = Object.freeze({ crit: '위험', warn: '주의', info: '참고' });
export const SEV_BADGE = Object.freeze({ crit: 'red', warn: 'amber', info: 'gray' });
export const RULE_TYPE_LABEL = Object.freeze({ affinity: '선호도', 'anti-affinity': '반선호도', 'vm-host': 'VM-호스트', dependency: '종속', other: '기타' });
const SEV_ORDER = { crit: 0, warn: 1, info: 2 };
const BEHAVIOR = { fullyAutomated: '완전 자동', partiallyAutomated: '부분 자동', manual: '수동' };

export function findingDetail(f) {
  const x = f?.facts || {};
  switch (f?.code) {
    case 'hosts-ineffective': return `유효 ${x.effective} / 전체 ${x.total}`;
    case 'rule-violation': case 'rule-disabled': return `${x.count}개${x.names?.length ? ` · ${x.names.join(', ')}` : ''}`;
    case 'evc-off-mixed': return (x.models || []).join(' / ');
    default: return '';
  }
}

export function codeChips(byCode) {
  const list = Object.entries(byCode || {}).map(([code, v]) => ({ code, sev: v?.sev || 'info', clusters: Number.isFinite(v?.clusters) ? v.clusters : 0, title: CLUSTER_TEXT[code]?.title || code }));
  return list.sort((a, b) => (b.clusters > 0) - (a.clusters > 0) || SEV_ORDER[a.sev] - SEV_ORDER[b.sev] || b.clusters - a.clusters || a.title.localeCompare(b.title));
}

export function coverageText(c) {
  if (!c) return '';
  const parts = [`클러스터 ${c.clusters.toLocaleString()}개`, `구성 읽음 ${c.cfg.toLocaleString()}`];
  if (c.notCollected) parts.push(`아직 안 읽음 ${c.notCollected.toLocaleString()}`);
  return parts.join(' · ');
}
export function coverageNote(c, scan) {
  if (!c) return null;
  if (scan && scan.enabled === false) return '클러스터 구성 수집이 꺼져 있습니다(CLUSTER_CFG_SCAN=false) — 이 화면은 판정하지 않습니다.';
  if (c.clusters > 0 && c.cfg === 0) return '아직 구성을 읽은 클러스터가 없습니다 — 수집 서버가 다음 주기부터 읽습니다(엣지가 수집하는 vCenter 는 엣지 업그레이드 뒤에 채워집니다).';
  if (c.notCollected > 0) return `구성을 아직 읽지 않은 클러스터 ${c.notCollected.toLocaleString()}개는 판정에서 빠졌습니다(이상이 없다는 뜻이 아닙니다).`;
  return null;
}

const onOff = (v) => (v === true ? '켜짐' : v === false ? '꺼짐' : '—');
/** HA 칸 — 꺼짐·수용 제어·호스트 모니터링을 한 줄로. 모르면 '—'. */
export function haText(ha) {
  if (!ha) return '—';
  if (ha.enabled !== true) return onOff(ha.enabled);
  const parts = ['켜짐'];
  if (ha.admission === false) parts.push('수용 제어 꺼짐');
  if (ha.hostMon === 'disabled') parts.push('호스트 모니터링 꺼짐');
  return parts.join(' · ');
}
export function drsText(drs) {
  if (!drs) return '—';
  if (drs.enabled !== true) return onOff(drs.enabled);
  return `켜짐 · ${BEHAVIOR[drs.behavior] || drs.behavior || '—'}`;
}
/** EVC — '' 는 꺼짐, null 은 모름. */
export function evcText(evc) { return evc == null ? '—' : evc === '' ? '꺼짐' : evc; }

/** 상세 창(VM·호스트) — 그 클러스터 한 줄 요약. */
export function clusterDetailRows(cl) {
  if (!cl) return [];
  return [
    { label: 'vSphere HA', value: haText(cl.ha) },
    { label: 'DRS', value: drsText(cl.drs) },
    { label: 'EVC', value: evcText(cl.evc) },
    { label: '유효 호스트', value: cl.numHosts == null ? '—' : `${cl.numEffectiveHosts ?? '—'} / ${cl.numHosts}` },
    { label: '선호도 규칙', value: cl.rulesTotal == null ? '—' : `${cl.rulesTotal}개` },
  ];
}
/** VM 이 들어 있는 규칙 문구. null 이면 판정 불가(호스트 상세). */
export function vmRulesText(rules) {
  if (!Array.isArray(rules)) return null;
  if (!rules.length) return '이 VM 이 들어 있는 선호도 규칙은 없습니다.';
  return rules.map((r) => `${r.name}(${RULE_TYPE_LABEL[r.type] || r.type}${r.enabled === false ? ' · 꺼짐' : r.inCompliance === false ? ' · 위반' : ''})`).join(', ');
}
export function ageText(at, now = Date.now()) {
  if (!Number.isFinite(at)) return '';
  const m = Math.max(0, Math.round((now - at) / 60_000));
  return m < 60 ? `${m}분 전에 읽은 값` : `${Math.round(m / 60)}시간 전에 읽은 값`;
}
