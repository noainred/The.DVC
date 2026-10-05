/**
 * clustercfg/analyze.js — 특수 기능 '클러스터 HA·DRS 점검'(도구 키 `cluster-check`, v2.701) 판정(순수).
 * 입력은 스냅샷 vCenter 배열(vc.clusterCfg = clustercfg 캐시)과 호스트 배열. vCenter 왕복 0.
 *
 * 정직 규칙
 *  · 클러스터 목록은 '호스트가 속한 클러스터 ∪ 구성을 읽은 클러스터' 다. 구성을 아직 읽지 않은 클러스터는
 *    판정하지 않고 '미수집' 으로 센다 — 빈 결과를 '이상 없음' 이라 말하지 않는다.
 *  · 수집 대기·연결 실패 vCenter 의 클러스터도 같다(구성 배열이 없으면 미수집).
 */
import { CLUSTER_CFG_CODES, clusterCfgFindings } from './parse.js';

const SEV_ORDER = { crit: 0, warn: 1, info: 2 };
export const ROWS_MAX = 2000;
const keyOf = (vcId, name) => `${vcId}\u0000${String(name).toLowerCase()}`;

export function analyzeClusters(vcenters, hosts, opt = {}) {
  const vcs = Array.isArray(vcenters) ? vcenters : [];
  const hl = Array.isArray(hosts) ? hosts : [];
  const vcName = new Map(vcs.map((v) => [v.id, v.name || v.id]));
  const hostsBy = new Map();
  for (const h of hl) {
    if (!h || !h.cluster || h.cluster === 'standalone') continue;
    const k = keyOf(h.vcenterId, h.cluster);
    if (!hostsBy.has(k)) hostsBy.set(k, { vcenterId: h.vcenterId, name: h.cluster, hosts: [] });
    hostsBy.get(k).hosts.push(h);
  }
  const cfgBy = new Map();
  for (const v of vcs) for (const c of Array.isArray(v.clusterCfg) ? v.clusterCfg : []) cfgBy.set(keyOf(v.id, c.name), { vcenterId: v.id, cfg: c });
  const keys = new Set([...hostsBy.keys(), ...cfgBy.keys()]);
  const coverage = { clusters: keys.size, cfg: 0, notCollected: 0 };
  const byCode = Object.fromEntries(Object.entries(CLUSTER_CFG_CODES).map(([c, sev]) => [c, { sev, clusters: 0 }]));
  const totals = { haOn: 0, haOff: 0, drsOn: 0, drsOff: 0, rules: 0, rulesViolated: 0 };
  const rows = [];
  const byVc = new Map();
  for (const k of keys) {
    const hb = hostsBy.get(k);
    const cb = cfgBy.get(k);
    const vcenterId = hb?.vcenterId ?? cb.vcenterId;
    const name = cb?.cfg?.name ?? hb.name;
    const hostList = hb?.hosts || [];
    const cfg = cb?.cfg || null;
    let findings = [];
    if (cfg) {
      coverage.cfg += 1;
      findings = clusterCfgFindings(cfg, hostList);
      if (cfg.ha?.enabled === true) totals.haOn += 1; else if (cfg.ha?.enabled === false) totals.haOff += 1;
      if (cfg.drs?.enabled === true) totals.drsOn += 1; else if (cfg.drs?.enabled === false) totals.drsOff += 1;
      totals.rules += Array.isArray(cfg.rules) ? cfg.rules.length : 0;
      totals.rulesViolated += (cfg.rules || []).filter((r) => r.enabled === true && r.inCompliance === false).length;
    } else coverage.notCollected += 1;
    const seen = new Set(findings.map((f) => f.code));
    for (const c of seen) byCode[c].clusters += 1;
    const vs = byVc.get(vcenterId) || { vcenterId, name: vcName.get(vcenterId) || vcenterId, clusters: 0, withFindings: 0 };
    vs.clusters += 1; if (findings.length) vs.withFindings += 1; byVc.set(vcenterId, vs);
    findings.sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev]);
    const sev = findings[0]?.sev || null;
    if (opt.code && !seen.has(opt.code)) continue;
    if (opt.sev && sev !== opt.sev) continue;
    if (opt.q) {
      const q = String(opt.q).toLowerCase();
      if (![name, vcName.get(vcenterId)].some((x) => String(x || '').toLowerCase().includes(q))) continue;
    }
    rows.push({
      vcenterId, vcenterName: vcName.get(vcenterId) || vcenterId, name,
      hosts: hostList.length, hostsDisconnected: hostList.filter((h) => h.connectionState === 'DISCONNECTED').length,
      collected: !!cfg, at: cfg?.at ?? null,
      ha: cfg?.ha ?? null, drs: cfg?.drs ?? null, evc: cfg ? cfg.evc : null,
      numHosts: cfg?.numHosts ?? null, numEffectiveHosts: cfg?.numEffectiveHosts ?? null,
      rulesTotal: cfg?.rulesTotal ?? null,
      rules: (cfg?.rules || []).map((r) => ({ name: r.name, type: r.type, enabled: r.enabled, inCompliance: r.inCompliance, mandatory: r.mandatory, vmCount: r.vms.length })),
      sev, findings,
    });
  }
  rows.sort((a, b) => (a.sev == null) - (b.sev == null) || (SEV_ORDER[a.sev] ?? 9) - (SEV_ORDER[b.sev] ?? 9)
    || b.findings.length - a.findings.length || String(a.vcenterName).localeCompare(String(b.vcenterName)) || String(a.name).localeCompare(String(b.name)));
  const matched = rows.length;
  const vcList = [...byVc.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { coverage, byCode, totals, vcenters: vcList, matched, rows: rows.slice(0, ROWS_MAX), omitted: Math.max(0, matched - ROWS_MAX) };
}

/**
 * 상세 창용 — 클러스터 하나 + (VM 이면) 그 VM 이 들어 있는 규칙. vmId 는 `${vcenterId}:${ref}` 이고
 * vCenter id 에 콜론이 있을 수 있어 split 하지 않고 접두를 뗀다.
 */
export function clusterOf(vcenters, hosts, vcenterId, clusterName, vmId = null) {
  if (!vcenterId || !clusterName || clusterName === 'standalone') return { cluster: null, vmRules: null, reason: 'standalone' };
  const vc = (vcenters || []).find((v) => v.id === vcenterId);
  const want = String(clusterName).toLowerCase();
  const cfg = (Array.isArray(vc?.clusterCfg) ? vc.clusterCfg : []).find((cl) => String(cl.name).toLowerCase() === want) || null;
  const hostList = (hosts || []).filter((h) => h.vcenterId === vcenterId && String(h.cluster).toLowerCase() === want);
  if (!cfg) return { cluster: null, vmRules: null, reason: 'not-collected', hosts: hostList.length };
  let vmRules = null;
  if (typeof vmId === 'string' && vmId.startsWith(`${vcenterId}:`)) {
    const ref = vmId.slice(vcenterId.length + 1);
    vmRules = (cfg.rules || []).filter((r) => r.vms.includes(ref)).map((r) => ({ name: r.name, type: r.type, enabled: r.enabled, inCompliance: r.inCompliance, mandatory: r.mandatory }));
  }
  return {
    cluster: { name: cfg.name, at: cfg.at, ha: cfg.ha, drs: cfg.drs, evc: cfg.evc, numHosts: cfg.numHosts, numEffectiveHosts: cfg.numEffectiveHosts, rulesTotal: cfg.rulesTotal, hosts: hostList.length },
    findings: clusterCfgFindings(cfg, hostList),
    vmRules,
  };
}
