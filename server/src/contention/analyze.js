/**
 * contention/analyze.js — 특수 기능 'CPU 경합·디스크 지연'(도구 키 `contention`, v2.706 — C2·C3) 판정(순수).
 * 입력은 스냅샷의 vm.perfc·host.perfc(실시간 통계 최근 창) — 요청 경로에서 vCenter 왕복 0.
 *
 * 정직 규칙
 *  · 값은 '최근 5분 창(기본)' 이다 — 지난주 피크가 아니다. 창 길이·측정 시각을 함께 싣는다.
 *  · 측정하지 못한 VM(perfc 없음)·오래된 측정(갱신 주기 × 3 초과)은 판정하지 않고 따로 센다(경합 0 이 아니다).
 *  · '같은 호스트의 사용량 상위 VM' 은 **상관** 이지 원인 증명이 아니다 — 화면이 그렇게 말한다.
 *  · 데이터스토어 지연은 그 DS 를 마운트한 호스트들이 보고한 값 중 **가장 나쁜 값** 이다(호스트마다 다를 수 있다).
 */
import { vmContentionFindings, THRESHOLDS, CONTENTION_CODES } from './parse.js';

export const ROWS_MAX = 1000;
const SEV_RANK = { crit: 3, warn: 2, info: 1 };
const worstSev = (fs) => fs.reduce((m, f) => (SEV_RANK[f.sev] > SEV_RANK[m] ? f.sev : m), fs.length ? 'info' : null) || null;
export const staleAfterMs = (refreshMs) => Math.max(45 * 60_000, (Number(refreshMs) || 900_000) * 3);

/**
 * @param snap  { vms, hosts, datastores, vcenters }(범위로 이미 거른 것)
 * @param opts  { now, refreshMs, q, sev, vcName:Map }
 */
export function analyzeContention(snap, { now = Date.now(), refreshMs = 900_000, q = '', sev = '', vcName = new Map() } = {}) {
  const staleMs = staleAfterMs(refreshMs);
  const vms = (snap.vms || []).filter((v) => v.powerState === 'POWERED_ON' && !v.template);
  const hosts = snap.hosts || [];
  const cov = { poweredOn: vms.length, measured: 0, notMeasured: 0, stale: 0, hostsConnected: 0, hostsMeasured: 0 };
  const kpi = { readyWarn: 0, readyCrit: 0, costop: 0, diskWarn: 0, diskCrit: 0, hostsDisk: 0, dsSlow: 0 };
  const rows = [];
  const byHost = new Map(); // `${vcId}\0${host}` -> { vms:[], contended:[] }
  for (const v of vms) {
    const hk = `${v.vcenterId}\u0000${v.host}`;
    if (!byHost.has(hk)) byHost.set(hk, { vms: [], contended: [] });
    byHost.get(hk).vms.push(v);
    const p = v.perfc;
    if (!p) { cov.notMeasured += 1; continue; }
    const stale = !(Number.isFinite(p.at) && now - p.at <= staleMs);
    if (stale) { cov.stale += 1; continue; }
    cov.measured += 1;
    const fs = vmContentionFindings(v);
    for (const f of fs) {
      if (f.code === 'cpu-ready') kpi.readyWarn += 1;
      if (f.code === 'cpu-ready-crit') kpi.readyCrit += 1;
      if (f.code.startsWith('cpu-costop')) kpi.costop += 1;
      if (f.code === 'disk-latency') kpi.diskWarn += 1;
      if (f.code === 'disk-latency-crit') kpi.diskCrit += 1;
    }
    if (fs.some((f) => f.code.startsWith('cpu-ready') || f.code.startsWith('cpu-costop'))) byHost.get(hk).contended.push(v);
    rows.push({
      id: v.id, name: v.name, vcenterId: v.vcenterId, vcenterName: vcName.get(v.vcenterId) || v.vcenterId, host: v.host || '', cluster: v.cluster || '',
      cpuCount: v.cpuCount ?? null, cpuUsagePct: v.cpuUsagePct ?? null,
      readyAvg: p.readyPct?.avg ?? null, readyMax: p.readyPct?.max ?? null, costopAvg: p.costopPct?.avg ?? null, latencyAvg: p.latencyPct?.avg ?? null,
      readAvg: p.readMs?.avg ?? null, writeAvg: p.writeMs?.avg ?? null, diskMax: Math.max(p.readMs?.max ?? -1, p.writeMs?.max ?? -1) >= 0 ? Math.max(p.readMs?.max ?? -1, p.writeMs?.max ?? -1) : null,
      disk: p.disk ?? null, at: p.at, findings: fs, sev: worstSev(fs),
    });
  }
  // 호스트 — 경합 VM 이 있는 호스트마다 같은 호스트의 CPU 사용량 상위 VM(이웃 후보). 사용량 = cpuUsagePct × vCPU(상대 크기).
  const hostRows = [];
  for (const h of hosts) {
    if (h.connectionState === 'DISCONNECTED') continue;
    cov.hostsConnected += 1;
    const hp = h.perfc && Number.isFinite(h.perfc.at) && now - h.perfc.at <= staleMs ? h.perfc : null;
    if (hp) cov.hostsMeasured += 1;
    const g = byHost.get(`${h.vcenterId}\u0000${h.name}`);
    const diskMax = hp?.diskMaxMs?.avg ?? null;
    const diskSev = diskMax == null ? null : diskMax >= THRESHOLDS.diskCrit ? 'crit' : diskMax >= THRESHOLDS.diskWarn ? 'warn' : null;
    if (diskSev) kpi.hostsDisk += 1;
    if (!g?.contended.length && !diskSev) continue;
    const contendedIds = new Set((g?.contended || []).map((v) => v.id));
    const neighbors = (g?.vms || []).filter((v) => !contendedIds.has(v.id) && Number.isFinite(v.cpuUsagePct) && Number.isFinite(v.cpuCount))
      .map((v) => ({ name: v.name, id: v.id, cpuCount: v.cpuCount, cpuUsagePct: v.cpuUsagePct, load: Math.round(v.cpuUsagePct * v.cpuCount) / 100 }))
      .sort((a, b) => b.load - a.load).slice(0, 3);
    hostRows.push({
      id: h.id, name: h.name, vcenterId: h.vcenterId, vcenterName: vcName.get(h.vcenterId) || h.vcenterId, cluster: h.cluster || '',
      cpuUsagePct: h.cpuUsagePct ?? null, vmCount: g?.vms.length || 0, contended: g?.contended.length || 0,
      worstReady: (g?.contended || []).reduce((m, v) => Math.max(m, v.perfc?.readyPct?.avg ?? 0), 0) || null,
      diskMaxMs: diskMax, diskSev, neighbors,
    });
  }
  hostRows.sort((a, b) => b.contended - a.contended || (b.worstReady ?? 0) - (a.worstReady ?? 0) || (b.diskMaxMs ?? 0) - (a.diskMaxMs ?? 0));
  // 데이터스토어 — 호스트 보고값(인스턴스 = DS UUID)을 같은 vCenter 의 DS 로 잇는다. 이름을 모르는 UUID 는 따로 센다.
  const dsByUuid = new Map();
  for (const d of snap.datastores || []) if (d.dsUuid) dsByUuid.set(`${d.vcenterId}\u0000${d.dsUuid}`, d);
  const dsAgg = new Map();
  let unmatchedDs = 0;
  for (const h of hosts) {
    const hp = h.perfc && Number.isFinite(h.perfc.at) && now - h.perfc.at <= staleMs ? h.perfc : null;
    for (const x of hp?.ds || []) {
      const d = dsByUuid.get(`${h.vcenterId}\u0000${x.uuid}`);
      if (!d) { unmatchedDs += 1; continue; }
      const a = dsAgg.get(d.id) || { id: d.id, name: d.name, vcenterId: d.vcenterId, vcenterName: vcName.get(d.vcenterId) || d.vcenterId, type: d.type || '', readAvg: null, writeAvg: null, worstHost: null, hosts: 0 };
      a.hosts += 1;
      const r = x.readMs?.avg; const w = x.writeMs?.avg;
      const cur = Math.max(a.readAvg ?? -1, a.writeAvg ?? -1);
      if (r != null && (a.readAvg == null || r > a.readAvg)) a.readAvg = r;
      if (w != null && (a.writeAvg == null || w > a.writeAvg)) a.writeAvg = w;
      if (Math.max(r ?? -1, w ?? -1) > cur) a.worstHost = h.name;
      dsAgg.set(d.id, a);
    }
  }
  const dsRows = [...dsAgg.values()].map((a) => {
    const m = Math.max(a.readAvg ?? -1, a.writeAvg ?? -1);
    const s = m >= THRESHOLDS.diskCrit ? 'crit' : m >= THRESHOLDS.diskWarn ? 'warn' : null;
    if (s) kpi.dsSlow += 1;
    return { ...a, sev: s };
  }).sort((a, b) => Math.max(b.readAvg ?? -1, b.writeAvg ?? -1) - Math.max(a.readAvg ?? -1, a.writeAvg ?? -1));
  // VM 표 — 필터·정렬(가장 나쁜 것 먼저) 후 상한.
  const qq = String(q || '').toLowerCase();
  let shown = rows;
  if (sev === 'issue') shown = shown.filter((r) => r.sev === 'warn' || r.sev === 'crit');
  else if (sev === 'cpu') shown = shown.filter((r) => r.findings.some((f) => f.code.startsWith('cpu-')));
  else if (sev === 'disk') shown = shown.filter((r) => r.findings.some((f) => f.code.startsWith('disk-')));
  if (qq) shown = shown.filter((r) => [r.name, r.host, r.cluster, r.vcenterName].some((x) => String(x || '').toLowerCase().includes(qq)));
  shown.sort((a, b) => (SEV_RANK[b.sev] || 0) - (SEV_RANK[a.sev] || 0) || (b.readyAvg ?? -1) - (a.readyAvg ?? -1) || (b.readAvg ?? -1) - (a.readAvg ?? -1) || String(a.name).localeCompare(String(b.name)));
  return {
    thresholds: THRESHOLDS, codes: CONTENTION_CODES, staleAfterMs: staleMs, coverage: cov, kpi,
    matched: shown.length, vms: shown.slice(0, ROWS_MAX), omitted: Math.max(0, shown.length - ROWS_MAX),
    hosts: hostRows.slice(0, 300), hostsOmitted: Math.max(0, hostRows.length - 300),
    datastores: dsRows.slice(0, 300), dsOmitted: Math.max(0, dsRows.length - 300), unmatchedDs,
  };
}
