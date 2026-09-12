/**
 * consoleData.js — DVC 콘솔(통합 관제 화면)의 순수 계산 모듈(v2.487).
 *
 * 콘솔 6화면(전사 현황·컴퓨트·스토리지·네트워크·물리/설비·알람 센터)이 **실 API 응답만**으로
 * 표·타일·목록을 만들 때 쓰는 판정/정렬/집계 함수를 모아 둔다. 화면(JSX)은 여기 결과를 그리기만 한다.
 * 웹 테스트가 node 환경(DOM 없음)이라 판정 규칙은 여기서 회귀로 고정한다(consoleData.test.js).
 *
 * 정직 원칙: 값이 없으면 0 으로 위장하지 않고 null 을 돌려준다(화면은 '—'). 추정치는 만들지 않는다.
 * 임계값은 포탈 공용 usageColor(primitives.jsx)와 같은 75%/90% 를 쓴다 — 디자인 시안의 75/88 대신
 * 기존 화면과 같은 색이 같은 뜻이 되게 맞췄다.
 */

export const WARN_PCT = 75;
export const CRIT_PCT = 90;
export const LEVEL_COLOR = ['#22c55e', '#f59e0b', '#ef4444'];
export const LEVEL_LABEL = ['정상', '주의', '위험'];
export const REGION_COLORS = { '아시아': '#22d3ee', '중국': '#ef4444', '유럽': '#a855f7', '북미': '#3b82f6' };
export const DOMAIN_LABEL = { COMPUTE: '컴퓨트', STORAGE: '스토리지', NETWORK: '네트워크', OTHER: '기타' };

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** 사용률(%) → 0 정상 / 1 주의 / 2 위험. 값이 없으면 null(판정 불가). */
export function levelOf(pct) {
  const p = num(pct);
  if (p == null) return null;
  return p >= CRIT_PCT ? 2 : p >= WARN_PCT ? 1 : 0;
}
export const colorOf = (pct) => { const l = levelOf(pct); return l == null ? '#5d6b85' : LEVEL_COLOR[l]; };

export const fmtInt = (n) => (num(n) == null ? '—' : Number(n).toLocaleString('en-US'));
export const fmtPct = (n) => (num(n) == null ? '—' : `${Math.round(Number(n))}%`);
export const fmtTB = (gb) => (num(gb) == null ? '—' : `${(Number(gb) / 1024).toFixed(1)} TB`);
export const fmtBytesTB = (b) => (num(b) == null ? '—' : `${(Number(b) / 1024 ** 4).toFixed(1)} TB`);

/** 경과 시간 문구('6m' · '1h25m' · '3d'). now 를 받아 결정론적으로 계산한다(테스트·서버 시각 기준). */
export function ageText(iso, now = Date.now()) {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** 알람 entityType → 콘솔 도메인. vCenter 알람은 host/vm/datastore/network 네 종류만 온다(소스 mkAlarm). */
export function domainOf(entityType) {
  const t = String(entityType || '').toLowerCase();
  if (t === 'host' || t === 'vm' || t === 'cluster' || t === 'vcenter') return 'COMPUTE';
  if (t === 'datastore') return 'STORAGE';
  if (t === 'network' || t === 'portgroup' || t === 'nsx') return 'NETWORK';
  return 'OTHER';
}

const SEV_RANK = { critical: 0, warning: 1, info: 2 };
export const sevRank = (s) => (SEV_RANK[s] ?? 3);

export function severityCounts(items) {
  const out = { critical: 0, warning: 0, info: 0, total: 0 };
  for (const a of items || []) { if (out[a.severity] !== undefined) out[a.severity] += 1; out.total += 1; }
  return out;
}

/** 도메인별 C/W/I 건수. 타일 하단 'C 6 W 31 I 14' 에 쓴다. */
export function alarmCountsByDomain(items) {
  const out = {};
  for (const d of Object.keys(DOMAIN_LABEL)) out[d] = { critical: 0, warning: 0, info: 0 };
  for (const a of items || []) {
    const d = out[domainOf(a.entityType)];
    if (d && d[a.severity] !== undefined) d[a.severity] += 1;
  }
  return out;
}

/** 심각도(critical→warning→info) 우선, 같은 심각도는 최신순. */
export function sortAlarms(items) {
  return [...(items || [])].sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0));
}

/** '지금 주목' — 실 알람 중 심각도·최신 순 상위 N. */
export const attentionList = (items, limit = 6) => sortAlarms(items).slice(0, limit);

/** 메시지 정규화: 숫자·퍼센트를 N 으로 치환해 '같은 유형' 판정에 쓴다. */
export const normalizeMessage = (msg) => String(msg || '').replace(/\d+(\.\d+)?\s*%?/g, 'N').replace(/\s+/g, ' ').trim();

/**
 * 상관 그룹 — 같은 vCenter · 같은 entityType · 같은 메시지 유형을 한 그룹으로 묶는다.
 * 원인 분석이 아니라 '같은 조건이 몇 대상에서 반복되는가' 를 보여주는 단순 집계다(화면에 그렇게 표기).
 */
export function correlateAlarms(items, limit = 6) {
  const m = new Map();
  for (const a of items || []) {
    const norm = normalizeMessage(a.message);
    const key = `${a.vcenterId}|${a.entityType}|${norm}`;
    const g = m.get(key) || { key, vcenterId: a.vcenterId, entityType: a.entityType, domain: domainOf(a.entityType), title: norm, count: 0, severity: 'info', entities: [], sample: a.message };
    g.count += 1;
    if (sevRank(a.severity) < sevRank(g.severity)) g.severity = a.severity;
    if (g.entities.length < 5 && !g.entities.includes(a.entity)) g.entities.push(a.entity);
    m.set(key, g);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || sevRank(a.severity) - sevRank(b.severity)).slice(0, limit);
}

/** /overview.sites(vCenter 롤업) → 사이트 표 행. worst = CPU/메모리/스토리지 중 최대 사용률. */
export function siteRows(sites) {
  return (sites || []).map((s) => {
    const m = s.metrics || {};
    const cpu = num(m.cpuUsagePct), mem = num(m.memUsagePct), sto = num(m.storageUsagePct);
    const vals = [cpu, mem, sto].filter((v) => v != null);
    return {
      id: s.id, name: s.name || s.id, city: s.location?.city || '', country: s.location?.country || '',
      region: s.location?.region || 'Unknown', status: s.status || '', version: s.version || '',
      lat: s.location?.lat ?? null, lon: s.location?.lon ?? null,
      hosts: num(m.hosts), vms: num(m.vms), vmsOn: num(m.vmsPoweredOn), cpu, mem, sto,
      storageUsedTB: num(m.storageUsedTB), storageTotalTB: num(m.storageTotalTB),
      powerKw: num(m.powerKw),
      alarmsCritical: num(m.alarmsCritical) || 0, alarmsWarning: num(m.alarmsWarning) || 0,
      worst: vals.length ? Math.max(...vals) : null,
    };
  }).sort((a, b) => (b.worst ?? -1) - (a.worst ?? -1) || a.id.localeCompare(b.id));
}

/** 리전별 사이트 수(지도 범례). */
export function regionCounts(rows) {
  const out = {};
  for (const r of rows || []) out[r.region] = (out[r.region] || 0) + 1;
  return out;
}

/** /tools/capacity.clusters → 부하 내림차순. load = CPU/메모리 사용률 중 최대. */
export function clusterRows(clusters, limit = Infinity) {
  return (clusters || []).map((c) => ({
    ...c, load: Math.max(num(c.cpuUsedPct) ?? 0, num(c.memUsedPct) ?? 0),
    name: c.cluster, key: `${c.vcenterId}|${c.cluster}`,
  })).sort((a, b) => b.load - a.load || b.hosts - a.hosts).slice(0, limit);
}

export function clusterCountByVc(clusters) {
  const out = {};
  for (const c of clusters || []) out[c.vcenterId] = (out[c.vcenterId] || 0) + 1;
  return out;
}

/**
 * 용량 어드바이저 — /tools/capacity 클러스터 집계에서 규칙으로 도출(추정·예측 없음, 규칙을 meta 에 명시).
 *  1) 사용률(CPU/메모리 최대) ≥ CRIT_PCT → 증설 검토(위험)
 *  2) RAM 오버커밋(구동 VM 할당/물리) ≥ 100% → 오버커밋 점검(주의)
 *  3) 호스트 3대 이상 중 부하 최저 클러스터 → 신규 배치 우선(정상)
 */
export function capacityAdvice(clusters) {
  const rows = clusterRows(clusters);
  const out = [];
  const hot = rows.find((c) => c.load >= CRIT_PCT);
  if (hot) out.push({ level: 2, title: `${hot.name} (${hot.vcenterId}) 사용률 ${hot.load}% — 증설 검토`, meta: `CPU ${fmtPct(hot.cpuUsedPct)} · MEM ${fmtPct(hot.memUsedPct)} · 호스트 ${hot.hosts} · 규칙: 사용률 ≥ ${CRIT_PCT}%` });
  const over = rows.filter((c) => num(c.ramOvercommitPct) >= 100).sort((a, b) => b.ramOvercommitPct - a.ramOvercommitPct)[0];
  if (over) out.push({ level: 1, title: `${over.name} (${over.vcenterId}) RAM 오버커밋 ${over.ramOvercommitPct}%`, meta: `구동 VM 할당 ${fmtInt(over.ramAllocatedGB)} / 물리 ${fmtInt(over.memTotalGB)} GB · 규칙: 오버커밋 ≥ 100%` });
  const room = [...rows].filter((c) => c.hosts >= 3).sort((a, b) => a.load - b.load)[0];
  if (room) out.push({ level: 0, title: `${room.name} (${room.vcenterId}) 부하 ${room.load}% — 신규 배치 우선`, meta: `호스트 ${room.hosts} · RAM 여유 ${fmtInt(room.ramHeadroomGB)} GB · 규칙: 호스트 ≥ 3 중 부하 최저` });
  return out;
}

export function datastoreTypeCounts(items) {
  const out = { VMFS: 0, vSAN: 0, NFS: 0, 기타: 0 };
  for (const d of items || []) {
    const t = String(d.type || '').toUpperCase();
    if (t === 'VMFS') out.VMFS += 1; else if (t === 'VSAN') out.vSAN += 1; else if (t.startsWith('NFS')) out.NFS += 1; else out.기타 += 1;
  }
  return out;
}

/** 임계 초과 데이터스토어(usagePct ≥ pct) 사용률 내림차순. forecast(daysToFull)가 있으면 붙인다. */
export function datastoresOver(items, pct = 85, forecast = null, limit = 8) {
  const eta = new Map((forecast || []).map((f) => [f.id, f]));
  return (items || []).filter((d) => num(d.usagePct) != null && d.usagePct >= pct)
    .sort((a, b) => b.usagePct - a.usagePct)
    .slice(0, limit)
    .map((d) => {
      const f = eta.get(d.id);
      return { ...d, daysToFull: f?.daysToFull ?? null, synthesized: !!f?.synthesized };
    });
}

/** IPAM /24 대역: used/254 사용률. */
export function ipamTop(subnets, limit = 6) {
  return (subnets || []).map((s) => ({ ...s, pct: Math.round(((num(s.used) ?? 0) / 254) * 100) }))
    .sort((a, b) => b.pct - a.pct).slice(0, limit);
}
export function ipamStats(subnets) {
  const list = subnets || [];
  if (!list.length) return { count: 0, over90: 0, avgPct: null };
  const pcts = list.map((s) => ((num(s.used) ?? 0) / 254) * 100);
  return { count: list.length, over90: pcts.filter((p) => p >= 90).length, avgPct: Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) };
}

/** svcmon summary → 레벨. 실패(bad) 있으면 위험, 경고·지연(stale) 있으면 주의, 항목 없으면 null. */
export function svcmonLevel(summary) {
  if (!summary || !summary.total) return null;
  if (summary.bad > 0) return 2;
  if (summary.warn > 0 || summary.stale > 0) return 1;
  return 0;
}

/** iDRAC 온도(°C) 셀 색 — 디자인 시안 눈금(파랑 <22 · 회색 22–24 · 노랑 24–26 · 빨강 ≥26). 미측정은 null. */
export function tempColor(t) {
  const v = num(t);
  if (v == null) return null;
  return v >= 26 ? '#ef4444' : v >= 24 ? '#f59e0b' : v >= 22 ? '#3a4a66' : '#3b82f6';
}

/**
 * /hosts → vCenter 별 물리·설비 행: 온도 셀(호스트별 iDRAC tempC), 최고 온도, iDRAC 연동 대수,
 * 전력 보고 대수, 끊김 대수. 온도 없는 호스트는 셀을 null(회색 점선)로 둔다.
 */
export function hostFacilityRows(hosts, sites) {
  const byVc = new Map();
  for (const h of hosts || []) {
    const r = byVc.get(h.vcenterId) || { vcenterId: h.vcenterId, hosts: 0, temps: [], idracBacked: 0, powerReporting: 0, powerW: 0, disconnected: 0 };
    r.hosts += 1;
    r.temps.push({ name: h.name, t: num(h.tempC) });
    if (h.idracBacked) r.idracBacked += 1;
    if (num(h.powerWatts) != null) { r.powerReporting += 1; r.powerW += Number(h.powerWatts); }
    if (h.connectionState === 'DISCONNECTED') r.disconnected += 1;
    byVc.set(h.vcenterId, r);
  }
  const siteOf = new Map((sites || []).map((s) => [s.id, s]));
  return [...byVc.values()].map((r) => {
    const s = siteOf.get(r.vcenterId);
    const ts = r.temps.map((x) => x.t).filter((v) => v != null);
    return {
      ...r, name: s?.name || r.vcenterId, city: s?.city || '', region: s?.region || '',
      maxTemp: ts.length ? Math.max(...ts) : null, measured: ts.length,
      powerKw: s?.powerKw ?? (r.powerReporting ? Math.round(r.powerW / 100) / 10 : null),
      idracPct: r.hosts ? Math.round((r.idracBacked / r.hosts) * 100) : null,
    };
  }).sort((a, b) => (b.maxTemp ?? -1) - (a.maxTemp ?? -1) || a.vcenterId.localeCompare(b.vcenterId));
}

/** /tools/storage.devices → 어레이 표 행(용량은 snap.capacity, 없으면 null). */
export function storageRows(devices, types) {
  const label = new Map((types || []).map((t) => [t.type, t.label]));
  return (devices || []).map((d) => {
    const cap = d.snap?.capacity || null;
    return {
      id: d.id, name: d.name || d.host || d.id, dc: d.datacenterId || '', type: d.type || '', typeLabel: label.get(d.type) || d.type || '',
      pct: num(cap?.pct), totalBytes: num(cap?.totalBytes), usedBytes: num(cap?.usedBytes),
      nodes: d.snap ? (d.snap.nodes?.count ?? null) : null, collectedAt: d.snap?.collectedAt || null,
      ok: d.snap ? d.snap.ok !== false && !d.snap.error : null, error: d.snap?.error || '',
      enabled: d.enabled !== false, version: d.snap?.version || '',
    };
  }).sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || a.name.localeCompare(b.name));
}

/** /tools/sanswitch.devices → 포트 셀. 문제 포트(offline+faulty) 로 색을 정한다. */
export function sanCells(devices) {
  return (devices || []).map((d) => {
    const p = d.snap?.ports || null;
    const bad = p ? (num(p.offline) ?? 0) + (num(p.faulty) ?? 0) : null;
    const level = p == null ? null : bad >= 2 ? 2 : bad >= 1 ? 1 : 0;
    return { id: d.id, name: d.name || d.id, dc: d.datacenterId || '', online: num(p?.online), total: num(p?.total), offline: num(p?.offline), faulty: num(p?.faulty), level, collectedAt: d.snap?.collectedAt || null, error: d.snap?.error || '' };
  });
}
export function sanTotals(cells) {
  const t = { devices: (cells || []).length, online: 0, total: 0, offline: 0, faulty: 0, measured: 0 };
  for (const c of cells || []) { if (c.total == null) continue; t.measured += 1; t.online += c.online ?? 0; t.total += c.total; t.offline += c.offline ?? 0; t.faulty += c.faulty ?? 0; }
  return t;
}

/** /tools/pdu.devices → 요약(수집 성공/실패·전력 합·최고 온도·센서 수). */
export function pduSummary(pdu) {
  const devs = pdu?.devices || [];
  const out = { devices: devs.length, ok: 0, failed: 0, none: 0, powerW: 0, sensors: 0, tempMaxC: null, violations: (pdu?.activeViolations || []).length };
  for (const d of devs) {
    const s = d.snapshot;
    if (!s) { out.none += 1; continue; }
    if (s.ok === false) { out.failed += 1; continue; }
    out.ok += 1;
    out.powerW += s.summary?.powerW ?? 0;
    out.sensors += s.summary?.sensors ?? 0;
    const t = num(s.summary?.tempMaxC);
    if (t != null) out.tempMaxC = out.tempMaxC == null ? t : Math.max(out.tempMaxC, t);
  }
  return out;
}

/** NSX 매니저 표 행 + 트랜스포트 노드 UP/DOWN 집계. */
export function nsxManagerRows(nsx) {
  const tn = nsx?.transportNodes || [];
  const st = new Map();
  for (const t of tn) {
    const r = st.get(t.managerId) || { up: 0, down: 0, other: 0 };
    const s = String(t.status || '').toUpperCase();
    if (s === 'UP') r.up += 1; else if (s === 'DOWN' || s === 'DEGRADED') r.down += 1; else r.other += 1;
    st.set(t.managerId, r);
  }
  const errs = new Set((nsx?.collectionErrors || []).map((e) => e.managerId));
  return (nsx?.managers || []).map((m) => ({
    ...m, nodes: st.get(m.id) || { up: 0, down: 0, other: 0 }, collectError: errs.has(m.id),
    level: m.status === 'connected' && !errs.has(m.id) && !(st.get(m.id)?.down) ? 0 : m.status === 'connected' ? 1 : 2,
  })).sort((a, b) => b.level - a.level || a.name.localeCompare(b.name));
}

export function networkTypeCounts(items) {
  const out = { distributed: 0, standard: 0, other: 0 };
  for (const n of items || []) {
    if (n.type === 'DISTRIBUTED_PORTGROUP') out.distributed += 1; else if (n.type === 'STANDARD_PORTGROUP') out.standard += 1; else out.other += 1;
  }
  return out;
}

/**
 * 전사 현황 도메인 타일 6개. 입력은 각 API 원본(없으면 null) — 없는 데이터는 '—'/미수집으로 표시하고
 * 레벨을 지어내지 않는다(level null = 판정 불가, 회색).
 */
export function buildDomainTiles({ global: g, alarms, nsx, svcmon, pdu, idracPoller, dsOver, storageDevices, permission = {} }) {
  const dom = alarmCountsByDomain(alarms);
  const ci = (d) => ({ crit: dom[d].critical, warn: dom[d].warning, info: dom[d].info });
  const tiles = [];
  // 컴퓨트 — 호스트 끊김·vCenter 불가면 위험, 아니면 CPU/메모리 사용률 판정.
  if (g) {
    const unreach = Math.max(0, (g.vcenters || 0) - (g.vcentersConnected || 0) - (g.vcentersMaintenance || 0));
    const lvUse = Math.max(levelOf(g.cpuUsagePct) ?? 0, levelOf(g.memUsagePct) ?? 0);
    const level = (g.hostsDisconnected > 0 || unreach > 0) ? 2 : lvUse;
    tiles.push({ page: 'compute', name: '컴퓨트', level, value: `${fmtInt(g.hosts)} / ${fmtInt(g.vms)}`, meta: `호스트 / VM · vCenter ${g.vcentersConnected}/${g.vcenters}${unreach ? ` · 불가 ${unreach}` : ''}${g.hostsDisconnected ? ` · 끊김 ${g.hostsDisconnected}` : ''}`, ...ci('COMPUTE') });
  } else tiles.push({ page: 'compute', name: '컴퓨트', level: null, value: '—', meta: '수집 대기', ...ci('COMPUTE') });
  // 스토리지 — 전사 사용률 판정 + 임계 초과 DS 수.
  if (g) {
    const arr = storageDevices == null ? '' : ` · 어레이 ${storageDevices}`;
    tiles.push({ page: 'storage', name: '스토리지', level: levelOf(g.storageUsagePct), value: fmtPct(g.storageUsagePct), meta: `${fmtInt(g.datastores)} DS · ${g.storageUsedTB} / ${g.storageTotalTB} TB${dsOver != null ? ` · 임계 초과 ${dsOver}` : ''}${arr}`, ...ci('STORAGE') });
  } else tiles.push({ page: 'storage', name: '스토리지', level: null, value: '—', meta: '수집 대기', ...ci('STORAGE') });
  // 네트워크 — NSX 매니저 상태로 판정(포트그룹 수는 상태가 없다).
  if (nsx?.rollup) {
    const r = nsx.rollup;
    const level = r.managers === 0 ? null : r.managersUp < r.managers - r.managersDegraded ? 2 : r.managersDegraded > 0 || (nsx.collectionErrors || []).length ? 1 : 0;
    tiles.push({ page: 'network', name: '네트워크', level, value: `${fmtInt(g?.networks)}`, meta: `포트그룹 · NSX ${r.managersUp}/${r.managers} · 세그먼트 ${r.segments} · 엣지 ${r.edgeNodes}`, ...ci('NETWORK') });
  } else tiles.push({ page: 'network', name: '네트워크', level: null, value: `${fmtInt(g?.networks)}`, meta: '포트그룹 · NSX 수집 대기', ...ci('NETWORK') });
  // 설비·전력 — 서버 측정 전력 합계 + PDU 임계 위반으로 판정(계약 전력 API 없음 → % 미표시).
  {
    const ps = pdu ? pduSummary(pdu) : null;
    const level = ps == null ? (g?.powerReporting ? 0 : null) : ps.violations >= 1 ? (ps.failed ? 2 : 1) : ps.failed ? 1 : g?.powerReporting || ps.devices ? 0 : null;
    const kw = g?.powerKw != null ? `${fmtInt(g.powerKw)} kW` : '—';
    const meta = [`서버 전력 보고 ${fmtInt(g?.powerReporting)}대`, ps ? `PDU ${ps.devices}${ps.failed ? ` (실패 ${ps.failed})` : ''}` : (permission.pdu === false ? 'PDU 권한 없음' : 'PDU 수집 대기'), ps?.violations ? `임계 위반 ${ps.violations}` : null].filter(Boolean).join(' · ');
    tiles.push({ page: 'facility', name: '설비 · 전력', level, value: kw, meta, crit: ps?.violations ? String(ps.violations) : '0', warn: ps?.failed ? String(ps.failed) : '0', info: '0' });
  }
  // 물리 서버 BMC — iDRAC 폴러 최근 실행(ok/failed). 관리자 전용 API 라 권한 없으면 '—'.
  {
    const lr = idracPoller?.lastRun || null;
    const n = lr ? (lr.ok || 0) + (lr.failed || 0) : 0;
    const pct = n ? Math.round(((lr.ok || 0) / n) * 1000) / 10 : null;
    const level = pct == null ? null : lr.failed === 0 ? 0 : (lr.failed / n) >= 0.05 ? 2 : 1;
    const meta = idracPoller ? `iDRAC 등록 ${fmtInt(idracPoller.servers)}대 · 응답 ${fmtInt(lr?.ok)} · 무응답 ${fmtInt(lr?.failed)}` : permission.idrac === false ? '관리자 권한 필요 (/admin/idrac)' : 'iDRAC 폴러 상태 대기';
    tiles.push({ page: 'facility', name: '물리 서버 BMC', level, value: pct == null ? '—' : `${pct}%`, meta, crit: String(lr?.failed || 0), warn: '0', info: '0' });
  }
  // 서비스 점검 — svcmon summary.
  {
    const s = svcmon?.summary || null;
    const level = svcmonLevel(s);
    tiles.push({ page: 'alarms', name: '서비스 점검', level, value: s ? fmtInt(s.total) : '—', meta: s ? (s.total ? `점검 항목 · 실패 ${s.bad} · 경고 ${s.warn} · 지연 ${s.stale}` : '등록된 점검 항목 없음') : '점검 상태 대기', crit: String(s?.bad || 0), warn: String(s?.warn || 0), info: String(s?.stale || 0) });
  }
  return tiles;
}

/** 검색어(공백 구분 AND)가 행의 텍스트 필드 어느 하나에라도 포함되는가. 표 필터에 쓴다. */
export function rowMatches(row, q) {
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = Object.values(row || {}).filter((v) => typeof v === 'string' || typeof v === 'number').join(' ').toLowerCase();
  return terms.every((t) => hay.includes(t));
}
