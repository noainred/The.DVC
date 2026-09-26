/**
 * version_6/v6Data.js — V6 Overview·Summary·서버 메뉴의 계산(순수, v2.623 — vitest 로 고정).
 *
 * 핸드오프(Portal Home.dc.html)의 숫자는 **목업**이다 — 여기서는 전부 실제 API(/overview · /summary · /alarms)에서 계산한다.
 * 정직성 규칙(이 저장소 공통):
 *   · 값이 없으면 0 이 아니라 null('—') 이고 단위를 붙이지 않는다(v2.575).
 *   · 첫 수집 중·연결 불가·비활성 vCenter 를 정상에 섞지 않는다 — 판정은 consoleData.vcStatusCounts 하나(v2.618).
 *   · 사용률 색 임계는 consoleData 의 75/90 하나(WARN_PCT/CRIT_PCT).
 */
import { vcStatusCounts, siteRows, WARN_PCT, CRIT_PCT } from '../console/consoleData.js';
import { numOrNull } from '../numOrNull.js';

const n = numOrNull;

/** 사용률 → 톤. null 은 'none'(회색 — 정상이 아니다). */
export function pctTone(p) {
  const v = n(p);
  if (v == null) return 'none';
  return v >= CRIT_PCT ? 'crit' : v >= WARN_PCT ? 'warn' : 'ok';
}

/** Overview 상태 타일 4장. g = /overview.global. */
export function statusTiles(g) {
  if (!g) return [];
  const c = vcStatusCounts(g) || { unreach: null, pending: null, maint: null, disabled: 0 };
  const active = n(g.vcenters) == null ? null : n(g.vcenters) - (c.disabled || 0);
  const vcParts = [
    { k: '연결', v: n(g.vcentersConnected), tone: 'ok' },
    { k: '점검', v: c.maint, tone: 'warn' },
    { k: '불가', v: c.unreach, tone: 'crit' },
  ];
  if (c.pending) vcParts.push({ k: '첫 수집 중', v: c.pending, tone: 'none' });
  return [
    { id: 'vcenter', label: 'vCenter', value: active == null ? null : `${n(g.vcentersConnected) ?? '—'}/${active}`, accent: 'var(--accent-2)',
      go: '#/m/platform', goLabel: '플랫폼 관리', parts: vcParts, note: c.disabled ? `비활성 ${c.disabled}곳은 분모에서 뺐습니다` : '' },
    { id: 'hosts', label: '가상화 호스트', value: n(g.hosts), accent: 'var(--accent)', go: '#/m/server/host', goLabel: '서버',
      parts: [{ k: '정상', v: n(g.hostsConnected), tone: 'ok' }, { k: '점검', v: n(g.hostsMaintenance), tone: 'warn' }, { k: '끊김', v: n(g.hostsDisconnected), tone: 'crit' }] },
    { id: 'vms', label: '가상화 서버 (VM)', value: n(g.vms), accent: 'var(--green)', go: '#/m/server/vm', goLabel: '서버',
      parts: [{ k: '구동', v: n(g.vmsPoweredOn), tone: 'ok' }, { k: '정지', v: n(g.vmsPoweredOff), tone: 'none' }] },
    { id: 'alarms', label: '활성 알람', value: n(g.alarms), accent: 'var(--red)', go: '#/m/ops', goLabel: '운영관제',
      parts: [{ k: '위험', v: n(g.alarmsCritical), tone: 'crit' }, { k: '경고', v: n(g.alarmsWarning), tone: 'warn' }] },
  ];
}

/** 사용률 게이지 3개(CPU·메모리·스토리지). 사용량을 못 읽은 호스트·DS 는 서버가 뺐다 — 그 사실을 note 로. */
export function usageGauges(g) {
  if (!g) return [];
  const fmt = (v, d = 0) => (n(v) == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d }));
  const excl = n(g.hostsUsageExcluded ?? g.hostsDisconnected) || 0;
  const hostNote = excl > 0 ? `끊긴 호스트 ${excl}대 사용률 제외` : '';
  const dsUnknown = n(g.datastoresUsageUnknown) || 0;
  return [
    { id: 'cpu', label: 'CPU', pct: n(g.cpuUsagePct), used: `${fmt(g.cpuUsedGhz)} / ${fmt(g.cpuTotalGhz)} GHz`, note: hostNote },
    { id: 'mem', label: '메모리', pct: n(g.memUsagePct), used: `${fmt(g.memUsedGB)} / ${fmt(g.memTotalGB)} GB`, note: hostNote },
    { id: 'sto', label: '스토리지', pct: n(g.storageUsagePct), used: `${fmt(g.storageUsedTB, 1)} / ${fmt(g.storageTotalTB, 1)} TB · ${fmt(g.datastores)} DS`,
      note: dsUnknown > 0 ? `사용량 미상 데이터스토어 ${dsUnknown}개 제외` : '' },
  ].map((x) => ({ ...x, tone: pctTone(x.pct) }));
}

/** 법인별 상태 카드 — worst(CPU·MEM·DS 최대)로 톤. 값이 하나도 없으면 'none'(판정 대기). */
export function siteCards(sites) {
  return siteRows(sites || []).map((r) => ({
    ...r,
    tone: pctTone(r.worst),
    alarms: r.alarmsUnknown ? null : (r.alarmsCritical || 0) + (r.alarmsWarning || 0),
    bars: [['CPU', r.cpu], ['MEM', r.mem], ['DS', r.sto]].map(([k, v]) => ({ k, v, tone: pctTone(v) })),
  }));
}

/** 상태 카드 톤 개수(정상·주의·위험·판정 대기) — 판정 대기를 정상에 섞지 않는다. */
export function siteToneCounts(cards) {
  const out = { ok: 0, warn: 0, crit: 0, none: 0 };
  for (const c of cards || []) out[c.tone] = (out[c.tone] || 0) + 1;
  return out;
}

const SEV_RANK = { critical: 0, red: 0, error: 0, warning: 1, yellow: 1 };
/** 최근 알람 — 위험 먼저, 같은 등급은 최신 먼저. /alarms 는 {items} 또는 배열. */
export function recentAlarms(alarms, max = 6) {
  const list = Array.isArray(alarms) ? alarms : Array.isArray(alarms?.items) ? alarms.items : [];
  const ts = (a) => { const t = Date.parse(a?.time || ''); return Number.isFinite(t) ? t : 0; };
  return list.filter((a) => a && typeof a === 'object')
    .slice().sort((a, b) => ((SEV_RANK[a.severity] ?? 2) - (SEV_RANK[b.severity] ?? 2)) || ts(b) - ts(a))
    .slice(0, max)
    .map((a) => ({ id: a.id, sev: SEV_RANK[a.severity] === 0 ? 'crit' : SEV_RANK[a.severity] === 1 ? 'warn' : 'none',
      sevLabel: SEV_RANK[a.severity] === 0 ? '위험' : SEV_RANK[a.severity] === 1 ? '경고' : (a.severity || '정보'),
      message: String(a.message || ''), entity: String(a.entity || ''), vcenterId: String(a.vcenterId || ''), ts: ts(a) || null }));
}

/**
 * '조치 필요' 바로가기 — 개수는 이 화면이 **세지 않는다**(각 도구 API 를 Overview 마다 부르면 그 자체가 부하다).
 * 항목은 권한이 있는 도구만 남긴다(보이는데 403 인 링크를 만들지 않는다).
 */
export const ACTIONS = Object.freeze([
  { k: 'cert-expiry', label: '인증서 만료 임박(D-30)', desc: 'vCenter·NSX 인증서 만료일' },
  { k: 'capacity-forecast', label: '30일 안에 가득 찰 데이터스토어', desc: '증가 추세 선형회귀 예상일' },
  { k: 'part-faults', label: '파트(부품) 장애', desc: 'PSU·디스크·DIMM·팬 장애 기록' },
  { k: 'unprotected-vms', label: '미보호 VM(백업 공백)', desc: '백업 스냅샷 이벤트가 없는 가동 VM' },
  { k: 'snapshot-age', label: '30일 넘은 스냅샷', desc: '생성일 기준 오래된 스냅샷' },
]);
export function actionLinks(allowed) {
  return ACTIONS.filter((a) => (typeof allowed === 'function' ? allowed(a.k) : true)).map((a) => ({ ...a, hash: `#/tools/${a.k}` }));
}

/** Summary — 용량 vs 할당 카드 3장. s = /summary. 비율 임계는 시안 값(vCPU 4:1 · 메모리 150% 초과 주의). */
export function capacityCards(s) {
  if (!s) return [];
  const c = s.compute || {}, a = s.allocation || {}, st = s.storage || {};
  const ramAllocPct = n(c.memTotalGB) > 0 && n(a.ramAllocatedGB) != null ? Math.round((a.ramAllocatedGB / c.memTotalGB) * 100) : null;
  const provPct = n(st.capacityTB) > 0 && n(a.provisionedStorageTB) != null ? Math.round((a.provisionedStorageTB / st.capacityTB) * 100) : null;
  const vpc = n(a.vcpuPerCore);
  return [
    { id: 'cpu', label: 'CPU', phys: `${fmtN(c.cpuCores)} 코어`, alloc: `${fmtN(a.vcpuAllocated)} vCPU`,
      ratio: vpc == null ? null : `${vpc}:1`, ratioLabel: 'vCPU : 코어', warn: vpc != null && vpc > 4, allocPct: vpc == null ? null : Math.round(vpc * 25) },
    { id: 'mem', label: '메모리', phys: `${fmtN(c.memTotalGB)} GB`, alloc: `${fmtN(a.ramAllocatedGB)} GB`,
      ratio: ramAllocPct == null ? null : `${ramAllocPct}%`, ratioLabel: '할당 / 물리', warn: ramAllocPct != null && ramAllocPct > 150, allocPct: ramAllocPct },
    { id: 'sto', label: '스토리지', phys: `${fmtN(st.capacityTB, 1)} TB`, alloc: `${fmtN(a.provisionedStorageTB, 1)} TB 프로비저닝`,
      used: `${fmtN(st.usedTB, 1)} TB 사용`, ratio: provPct == null ? null : `${provPct}%`, ratioLabel: '프로비저닝 / 용량', warn: provPct != null && provPct > 100, allocPct: provPct },
  ];
}
function fmtN(v, d = 0) { return n(v) == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d }); }

/** Summary 총량 타일 6개. */
export function totalTiles(s) {
  if (!s) return [];
  const c = s.compute || {}, st = s.storage || {}, cnt = s.counts || {}, a = s.allocation || {}, p = s.power || {};
  return [
    { label: '물리 코어', value: fmtN(c.cpuCores) },
    { label: '물리 메모리', value: n(c.memTotalGB) == null ? '—' : `${fmtN(c.memTotalGB / 1024, 1)} TB` },
    { label: '스토리지 용량', value: n(st.capacityTB) == null ? '—' : `${fmtN(st.capacityTB, 1)} TB` },
    { label: '클러스터', value: fmtN(cnt.clusters) },
    { label: '호스트당 VM', value: fmtN(a.avgVmPerHost, 1) },
    { label: '총 소비전력', value: n(p.kw) == null ? '—' : `${fmtN(p.kw, 1)} kW` },
  ];
}

/** OS별 할당 — 비중 %(VM 수 기준) 포함. */
export function osRows(s) {
  const rows = Array.isArray(s?.osAllocation) ? s.osAllocation : [];
  const total = rows.reduce((t, r) => t + (n(r.vms) || 0), 0);
  return rows.map((r) => ({ ...r, share: total > 0 ? Math.round(((n(r.vms) || 0) / total) * 1000) / 10 : null }));
}

/** 법인(vCenter)별 기여도 표 + 합계 행. 합계는 값이 있는 행만 더하고 못 읽은 행 수를 밝힌다. */
export function corpContribution(s) {
  const rows = Array.isArray(s?.byVcenter) ? s.byVcenter : [];
  const keys = ['hosts', 'vms', 'cpuCores', 'memTotalGB', 'storageTotalTB', 'vcpuAllocated', 'ramAllocatedGB', 'provisionedTB', 'powerKw'];
  const total = {};
  for (const k of keys) {
    const vals = rows.map((r) => n(r[k])).filter((v) => v != null);
    total[k] = vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  }
  return { rows, total };
}

/**
 * 서버 메뉴 구분 카드 3장 + 법인별 서버 구분 표. ov = /overview.
 * 산식은 idrac/serverByCorp.js 규칙 그대로: 서버 합계 = 물리 전용 + 가상화 호스트(같은 장비 중복 제외), VM 은 합계에 넣지 않는다.
 * physicalByCorp 를 못 받았으면 물리·합계는 null('—')이다(0 이 아니다).
 */
export function serverSegments(ov) {
  const g = ov?.global || {};
  const pbc = ov?.physicalByCorp && !ov.physicalByCorp.error ? ov.physicalByCorp : null;
  return {
    phys: { value: pbc ? n(pbc.total) : n(ov?.physical?.servers), sub: pbc ? `물리 전용 ${fmtN(pbc.physicalOnly)} · 호스트와 같은 장비 ${fmtN(pbc.matchedCount)}` : '' },
    host: { value: n(g.hosts), sub: `정상 ${fmtN(g.hostsConnected)} · 점검 ${fmtN(g.hostsMaintenance)} · 끊김 ${fmtN(g.hostsDisconnected)}` },
    vm: { value: n(g.vms), sub: `구동 ${fmtN(g.vmsPoweredOn)} · 정지 ${fmtN(g.vmsPoweredOff)}` },
    union: pbc ? n(pbc.union) : null,
    error: ov?.physicalByCorp?.error || null,
  };
}

export function serverCorpRows(ov) {
  const pbc = ov?.physicalByCorp && !ov.physicalByCorp.error ? ov.physicalByCorp : null;
  return (ov?.sites || []).map((s) => {
    const m = s.metrics || {};
    const hosts = n(m.hosts), vms = n(m.vms);
    const only = pbc ? (n(pbc.byVcenterPhysicalOnly?.[s.id]) ?? 0) : null;
    return { id: s.id, name: s.name || s.id, physOnly: only, hosts, total: only == null || hosts == null ? null : only + hosts,
      vms, vmsOn: n(m.vmsPoweredOn), perHost: hosts ? Math.round((vms / hosts) * 10) / 10 : null };
  });
}
