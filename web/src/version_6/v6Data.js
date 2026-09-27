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
import { alarmTotals } from '../views/restFallbackText.js';
import { corpSiteStatus } from '../views/corpSiteStatus.js'; // v2.631(감사 WEB2631-03)

const n = numOrNull;

/** 사용률 → 톤. null 은 'none'(회색 — 정상이 아니다). */
export function pctTone(p) {
  const v = n(p);
  if (v == null) return 'none';
  return v >= CRIT_PCT ? 'crit' : v >= WARN_PCT ? 'warn' : 'ok';
}

/**
 * 경보를 조회하지 않은 vCenter 수(v2.629 WEB2629-04) — REST 폴백 vCenter 는 alarms:[] 라 서버 합계에 0 으로 들어간다.
 * 판정은 restFallbackText.alarmTotals 하나(VCenters.jsx 와 같은 기준). sites 를 못 받았으면 null(모른다).
 */
export function alarmsUnknownCount(sites) {
  if (!Array.isArray(sites)) return null;
  return alarmTotals(sites).unknown;
}
/** 경보 합계 옆에 붙일 안내 — 미조회가 없으면 ''. */
export function alarmsUnknownNote(sites) {
  const u = alarmsUnknownCount(sites);
  return u > 0 ? `경보 미조회 vCenter ${u}곳은 합계에 없습니다` : '';
}

/** Overview 상태 타일 4장. g = /overview.global, sites = /overview.sites(경보 미조회 판정용 — 없으면 안내 생략). */
export function statusTiles(g, sites) {
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
      parts: [{ k: '위험', v: n(g.alarmsCritical), tone: 'crit' }, { k: '경고', v: n(g.alarmsWarning), tone: 'warn' }], note: alarmsUnknownNote(sites) },
  ];
}

/** 사용률 게이지 3개(CPU·메모리·스토리지). 사용량을 못 읽은 호스트·DS 는 서버가 뺐다 — 그 사실을 note 로. */
export function usageGauges(g) {
  if (!g) return [];
  const fmt = (v, d = 0) => (n(v) == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d }));
  const excl = n(g.hostsUsageExcluded ?? g.hostsDisconnected) || 0;
  const hostNote = excl > 0 ? `끊긴 호스트 ${excl}대 사용률 제외` : '';
  const dsUnknown = n(g.datastoresUsageUnknown) || 0;
  // v2.628 WEB2628-05: 사용률(%)의 분모는 '사용량을 읽은 호스트' 용량이다(store.js usageReadable). 문구의 분모도 같은 기준을
  //   써야 '50 / 200 GHz · 50%' 처럼 문구와 막대가 어긋나지 않는다. 서버가 읽은 호스트 용량(cpuTotalReadableGhz)을 주면 그것을,
  //   제외된 호스트가 있는데 그 값이 없으면(구버전 서버) 전체 용량임을 문구에 밝힌다.
  const denom = (readable, total, unit) => {
    const r = n(readable);
    if (r != null) return { text: `${fmt(r)} ${unit}`, extra: excl > 0 && n(total) != null ? `전체 ${fmt(total)} ${unit}` : '' };
    return { text: `${fmt(total)} ${unit}`, extra: excl > 0 ? '분모는 끊긴 호스트 포함 전체 용량' : '' };
  };
  const cpuD = denom(g.cpuTotalReadableGhz, g.cpuTotalGhz, 'GHz');
  const memD = denom(g.memTotalReadableGB, g.memTotalGB, 'GB');
  const noteOf = (d) => [hostNote, d.extra].filter(Boolean).join(' · ');
  return [
    { id: 'cpu', label: 'CPU', pct: n(g.cpuUsagePct), used: `${fmt(g.cpuUsedGhz)} / ${cpuD.text}`, note: noteOf(cpuD) },
    { id: 'mem', label: '메모리', pct: n(g.memUsagePct), used: `${fmt(g.memUsedGB)} / ${memD.text}`, note: noteOf(memD) },
    { id: 'sto', label: '스토리지', pct: n(g.storageUsagePct), used: `${fmt(g.storageUsedTB, 1)} / ${fmt(g.storageTotalTB, 1)} TB · ${fmt(g.datastores)} DS`,
      note: dsUnknown > 0 ? `사용량 미상 데이터스토어 ${dsUnknown}개 제외` : '' },
  ].map((x) => ({ ...x, tone: pctTone(x.pct) }));
}

/** 법인별 상태 카드 — worst(CPU·MEM·DS 최대)로 톤. 값이 하나도 없으면 'none'(판정 대기). */
export function siteCards(sites) {
  return siteRows(sites || []).sort(bySiteName).map((r) => ({
    group: siteGroupOf(r.name),
    ...r,
    tone: pctTone(r.worst),
    alarms: r.alarmsUnknown ? null : (r.alarmsCritical || 0) + (r.alarmsWarning || 0),
    bars: [['CPU', r.cpu], ['MEM', r.mem], ['DS', r.sto]].map(([k, v]) => ({ k, v, tone: pctTone(v) })),
  }));
}

/**
 * 법인 카드 기본 순서 — 이름 알파벳순(v2.624 사용자 요청). 예전 순서(가장 나쁜 사용률 먼저)는 상태 점과 KPI 가 이미 말한다.
 * 숫자를 인식하고(HG2 < HG10) 대소문자를 구분하지 않는다. Collator 는 한 번만 만든다(v2.503 — 비교마다 옵션 재해석 금지).
 */
const NAME_COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
export function bySiteName(a, b) {
  return NAME_COLLATOR.compare(String(a?.name ?? ''), String(b?.name ?? '')) || NAME_COLLATOR.compare(String(a?.id ?? ''), String(b?.id ?? ''));
}

/**
 * 법인 구분(v2.624 사용자 요청) — 이름에 'IRS' 가 들어가면 'irs', 아니면 'davinci'(다빈치).
 * 대소문자는 가리지 않는다(HG-IRS · hg-irs 모두 IRS). 판정 근거는 **이름뿐**이다 — 등록 정보에 따로 표시된 값이 아니다.
 */
export function siteGroupOf(name) {
  return /irs/i.test(String(name ?? '')) ? 'irs' : 'davinci';
}
export const SITE_GROUPS = [
  { id: 'all', label: '전체' },
  { id: 'davinci', label: '다빈치' },
  { id: 'irs', label: 'IRS' },
];
/** 구분별 개수 — {all, davinci, irs}. */
export function siteGroupCounts(cards) {
  const out = { all: 0, davinci: 0, irs: 0 };
  for (const c of cards || []) { out.all += 1; out[c.group === 'irs' ? 'irs' : 'davinci'] += 1; }
  return out;
}
/** 구분으로 거른다 — 모르는 값은 전체(빈 화면을 만들지 않는다). */
export function filterSiteGroup(cards, group) {
  if (group !== 'davinci' && group !== 'irs') return cards || [];
  return (cards || []).filter((c) => c.group === group);
}

/** 고른 구분에 법인이 하나도 없을 때의 문구(v2.629 WEB2629-05 — '전체' 를 다빈치 문구로 말하던 것). */
export function emptyGroupText(group) {
  if (group === 'irs') return "이름에 'IRS' 가 들어간 법인이 없습니다.";
  if (group === 'davinci') return "이름에 'IRS' 가 없는 법인이 없습니다.";
  return '표시할 법인이 없습니다.';
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
    powerTile(p, cnt),
  ];
}

/**
 * v2.628 WEB2628-01: 서버 /summary 의 power.kw 는 **항상 숫자**다(보고 호스트가 없으면 0). 0 kW 는 '소비 없음' 이라는 거짓이므로
 * 보고 호스트 수(power.reporting)를 먼저 본다 — 0 이면 '—'. reporting 이 없는 옛 응답은 kw 가 양수일 때만 값으로 믿는다.
 * 일부 호스트만 보고하면 부분 합이라 '보고 N/M대' 를 붙인다.
 */
function powerTile(p, cnt) {
  const kw = n(p.kw), rep = n(p.reporting), hosts = n(cnt?.hosts);
  if (kw == null || rep === 0 || (rep == null && !(kw > 0))) {
    return { label: '총 소비전력', value: '—', note: rep === 0 ? '전력 보고 호스트 없음' : '' };
  }
  const note = rep != null && hosts != null && rep < hosts ? `보고 ${fmtN(rep)}/${fmtN(hosts)}대 합계` : '';
  return { label: '총 소비전력', value: `${fmtN(kw, 1)} kW`, note };
}

/** OS별 할당 — 비중 %(VM 수 기준) 포함. */
export function osRows(s) {
  const rows = Array.isArray(s?.osAllocation) ? s.osAllocation : [];
  const total = rows.reduce((t, r) => t + (n(r.vms) || 0), 0);
  return rows.map((r) => ({ ...r, share: total > 0 ? Math.round(((n(r.vms) || 0) / total) * 1000) / 10 : null }));
}

export const CONTRIB_KEYS = Object.freeze(['hosts', 'vms', 'cpuCores', 'memTotalGB', 'storageTotalTB', 'vcpuAllocated', 'ramAllocatedGB', 'provisionedTB', 'powerKw']);
const VC_STATUS_LABEL = { pending: '첫 수집 중', unreachable: '연결 불가', disabled: '비활성', maintenance: '점검 중' };
/** 연결되지 않은 vCenter 상태 라벨 — status 가 없으면(옛 응답) null(연결로 본다). */
export function vcStatusLabel(status) {
  if (status == null || status === '' || status === 'connected') return null;
  return VC_STATUS_LABEL[status] || String(status);
}

/**
 * 법인(vCenter)별 기여도 표 + 합계 행.
 * v2.628 WEB2628-02: 서버는 첫 수집 중·연결 불가·비활성 vCenter 행을 **0 으로 채워** 보낸다(inventory.js bucket 초기값).
 * 그 0 은 값이 아니라 '모른다' 이므로 행의 수치를 null 로 바꾸고(`statusLabel` 로 상태를 말한다) 합계에서 뺀 뒤,
 * 뺀 행 수(`excluded`)와 키별 못 읽은 행 수(`missing`)를 돌려준다 — 부분 합을 '합계' 라고만 말하지 않는다.
 * v2.629 A1-2629-02: 상태만으로 지우지 않는다 — 점검 중(maintenance) vCenter 는 store 가 직전 수집 인벤토리를 스냅샷에
 * 유지하고, 연결 불가(unreachable)도 LASTGOOD 보존 창 안이면 직전 인벤토리를 이월한다. 그 값은 **실제로 있는 값**이고
 * 서버 /summary 상단 합계(counts.hosts 등)에도 들어 있으므로 여기서 지우면 같은 화면의 타일과 합계가 어긋난다.
 * 그래서 값이 없는 행만 null 이다 — 첫 수집 중·비활성, 그리고 호스트·VM 이 둘 다 0 인 연결 불가(보존 창 밖 — 인벤토리 비움).
 * 점검 중·이월 행은 값을 두고 합계에 포함하되 '직전 값' 라벨을 붙이고 개수(`carried`)를 밝힌다.
 */
const VALUELESS_STATUS = new Set(['pending', 'disabled']);
export function contribRowKind(r) {
  const st = r?.status;
  if (st == null || st === '' || st === 'connected') return 'live';
  if (VALUELESS_STATUS.has(st)) return 'none';
  // v2.630 R2630-02: 점검 중도 연결 불가와 같은 규칙이다 — store 는 인메모리 캐시(vcCache)에 직전 인벤토리가 있을 때만
  // 값을 유지하고, 없으면(중앙 재시작 직후·등록 직후 점검) 호스트·VM 없이 상태만 싣는다. 그 0 을 '직전 값' 이라 부르면 거짓이다.
  if (st === 'maintenance' || st === 'unreachable') {
    const h = n(r?.hosts), v = n(r?.vms);
    return (h || 0) > 0 || (v || 0) > 0 ? 'carried' : 'none';
  }
  return 'none'; // 모르는 상태 — 값을 믿지 않는다
}
export function corpContribution(s) {
  const src = Array.isArray(s?.byVcenter) ? s.byVcenter : [];
  let excluded = 0, carried = 0;
  const rows = src.map((r) => {
    const kind = contribRowKind(r);
    const base = vcStatusLabel(r?.status);
    if (kind === 'live') return { ...r, statusLabel: null, carried: false };
    if (kind === 'carried') { carried += 1; return { ...r, statusLabel: `${base} · 직전 값`, carried: true }; }
    excluded += 1;
    const out = { ...r, statusLabel: base, carried: false };
    for (const k of CONTRIB_KEYS) out[k] = null;
    return out;
  });
  const total = {}, missing = {};
  for (const k of CONTRIB_KEYS) {
    const vals = rows.map((r) => n(r[k])).filter((v) => v != null);
    total[k] = vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    missing[k] = rows.length - vals.length;
  }
  return { rows, total, excluded, carried, missing };
}

/** 기여도 표 머리말 안내(v2.629) — 뺀 행과 직전 값 행을 나눠 말한다. 둘 다 없으면 ''. */
export function contribNote(c) {
  const parts = [];
  if (c?.excluded > 0) parts.push(`첫 수집 중·점검 중·연결 불가(보관 인벤토리 없음)·비활성 ${c.excluded}곳은 값을 모르므로 합계에서 뺐습니다`);
  if (c?.carried > 0) parts.push(`점검 중·연결 불가 ${c.carried}곳은 직전 수집 값을 합계에 포함했습니다`);
  return parts.join(' · ');
}
/** 합계 행 라벨. */
export function contribTotalLabel(c) {
  const bits = [];
  if (c?.excluded > 0) bits.push(`${c.excluded}곳 제외`);
  if (c?.carried > 0) bits.push(`직전 값 ${c.carried}곳 포함`);
  return bits.length ? `합계(${bits.join(' · ')})` : '합계';
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
    // v2.631(감사 WEB2631-03): 첫 수집 중·연결 실패·비활성 vCenter 는 호스트·VM 을 0 이 아니라 null('—') + 표지(corpSiteStatus 하나).
    const st = corpSiteStatus(s);
    const hosts = st.countable ? n(m.hosts) : null;
    const vms = st.countable ? n(m.vms) : null;
    const only = pbc ? (n(pbc.byVcenterPhysicalOnly?.[s.id]) ?? 0) : null;
    return { id: s.id, name: s.name || s.id, countable: st.countable, mark: st.mark, markTitle: st.title,
      physOnly: only, hosts, total: only == null || hosts == null ? null : only + hosts,
      vms, vmsOn: st.countable ? n(m.vmsPoweredOn) : null, perHost: hosts && vms != null ? Math.round((vms / hosts) * 10) / 10 : null }; // v2.628 WEB2628-04: VM 수를 모르면 0 이 아니라 null
  });
}
