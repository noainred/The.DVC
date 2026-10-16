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

/*
 * v2.742(감사 VC-05) — 같은 vCenter 안에 같은 이름 클러스터가 둘 이상일 수 있다(vSphere 이름은 데이터센터 안에서만 유일).
 *   서버 행은 ref(클러스터 moref)·vcDatacenter(데이터센터 이름)·sameName(같은 이름 행 수)을 싣는다.
 */
// 행의 클러스터 moref — 점검 표(/tools/cluster-check)는 ref, N+1 표(/tools/insights clusters)는 clusterRef 로 싣는다.
const refOfRow = (r) => (typeof r?.ref === 'string' && r.ref ? r.ref : typeof r?.clusterRef === 'string' && r.clusterRef ? r.clusterRef : null);
/** 표의 행 키 — ref 가 있으면 ref, 없으면(구버전 엣지 스냅샷) 예전 이름 키. ref 가 없는 같은 이름 구성 행(이름 겹침)은 순번을 붙인다. */
export function clusterRowKey(r, i) {
  if (!r) return '';
  const ref = refOfRow(r);
  if (ref) return `${r.vcenterId}|r:${ref}`;
  const base = `${r.vcenterId}|${r.name ?? r.cluster ?? ''}`;
  // ref 를 싣지 않은 옛 구성이 같은 이름으로 둘 이상이면(nameCollision) 이름 키가 겹친다 — 표 위치로 가른다.
  return r.nameCollision > 1 && Number.isInteger(i) ? `${base}#${i}` : base;
}
/** 클러스터 이름 표시 — 같은 이름이 둘 이상일 때만 데이터센터(모르면 ref)를 붙인다. */
export function clusterNameLabel(r) {
  const name = r?.name ?? r?.cluster ?? '';
  if (!r || !(r.sameName > 1)) return String(name);
  if (r.vcDatacenter) return `${name} · ${r.vcDatacenter}`;
  const ref = refOfRow(r);
  if (ref) return `${name} (${ref})`;
  return `${name} (같은 이름 ${r.sameName}개 — 구분 불가)`;
}
/**
 * 점검 표 머리 안내 — 이름 키로 묶은 vCenter(호스트가 클러스터 식별자를 싣지 않는 구버전 엣지 보고·REST 폴백 수집)에서
 * 같은 이름 구성이 둘 이상이라 호스트를 어느 클러스터에도 붙이지 않은 수(coverage.hostsAmbiguous). 0·없음이면 null.
 */
export function hostsAmbiguousNote(c) {
  const n = c?.hostsAmbiguous;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  return `같은 이름의 클러스터가 둘 이상인데 호스트가 클러스터 식별자를 싣지 않아(구버전 엣지 보고·REST 폴백 수집) 호스트 ${n.toLocaleString()}대를 어느 클러스터에도 붙이지 않았습니다 — 그 행의 호스트 칸은 0 이 아니라 모름(—)이고 호스트 기반 판정(EVC 혼재·유효 호스트)은 빠졌습니다. 그 vCenter 를 수집하는 노드를 업그레이드하면 구분됩니다.`;
}
/**
 * 상세 창(VM·호스트)이 /tools/cluster-check/of 에 넘길 조회 인자 — 서버 라우트가 읽는 쿼리 이름(vcenterId·cluster·vmId·hostId·clusterRef)과 1:1.
 * 같은 이름 클러스터가 여러 데이터센터에 있을 수 있어 호스트는 hostId, VM 은 vmId 를 함께 넘긴다(서버가 그 ref 로 고른다).
 * 넘길 것이 없으면(클러스터 없음·standalone) null.
 */
export function clusterOfParams(item, isVm) {
  if (!item?.vcenterId || !item?.cluster || item.cluster === 'standalone') return null;
  const params = { vcenterId: item.vcenterId, cluster: item.cluster };
  if (isVm && item.id) params.vmId = item.id;
  if (!isVm && item.id) params.hostId = item.id;
  if (typeof item.clusterRef === 'string' && item.clusterRef) params.clusterRef = item.clusterRef;
  return params;
}
/** 상세 창 '클러스터 구성' 칸의 빈 사유 — 서버 clusterOf 의 reason 과 1:1. */
export const CLUSTER_MISS_TEXT = Object.freeze({
  standalone: '클러스터에 속하지 않은 호스트입니다',
  'not-collected': '이 클러스터의 구성을 아직 읽지 않았습니다',
  ambiguous: '같은 이름의 클러스터가 여러 데이터센터에 있어 어느 것인지 정하지 못했습니다 — 클러스터 HA·DRS 점검 화면에서 데이터센터로 구분해 보세요',
});
export function clusterMissText(d) {
  if (!d || d.cluster) return null;
  if (d.reason === 'ambiguous') return `${CLUSTER_MISS_TEXT.ambiguous}${d.candidates ? `(후보 ${d.candidates}개)` : ''}`;
  return CLUSTER_MISS_TEXT[d.reason] || CLUSTER_MISS_TEXT['not-collected'];
}
/** 상세 창 한 줄 — clusterMissText 에 '아직 안 읽음' 일 때만 기다리면 채워진다는 안내를 붙인다(이름 겹침은 기다려도 바뀌지 않는다). */
export function clusterMissLine(d) {
  const t = clusterMissText(d);
  if (!t) return null;
  const waiting = d.reason !== 'ambiguous' && d.reason !== 'standalone';
  return waiting ? `${t} — 수집 서버가 주기적으로 읽습니다(엣지가 수집하는 vCenter 는 엣지 업그레이드 뒤에 채워집니다).` : `${t}.`;
}
/** 표의 호스트 칸 — 이름 겹침으로 호스트를 붙이지 못한 행(hosts null)은 0 이 아니라 '—'. */
export function clusterHostsText(r) {
  if (!r) return '—';
  if (r.hosts == null) return r.hostsAmbiguous ? `— (같은 이름 클러스터 호스트 ${r.hostsAmbiguous}대 구분 불가)` : '—';
  return String(r.hosts);
}
