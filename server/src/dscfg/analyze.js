/**
 * dscfg/analyze.js — 특수 기능 '데이터스토어·경로 점검'(도구 키 `storage-paths`, v2.700) 판정(순수).
 * 세 보기: ① 데이터스토어 운영(A17 — ds.dcfg + vmfsMajor) ② 호스트 멀티패스(A2 — host.hcfg.mp) ③ vSAN 클러스터(A19 — host.hcfg.vsan + vSAN DS).
 * vCenter 왕복 0. 못 읽은 축은 판정하지 않고 개수를 센다(빈 결과를 '이상 없음' 이라 말하지 않는다).
 * ⚠ vSAN 헬스 서비스(vsanHealth API — 리싱크·객체 상태·헬스 점수)는 쓰지 않는다. 여기의 vSAN 판정은 호스트 런타임(디스크 문제·멤버 수)과 용량뿐이다.
 */
import { dsCfgFindings, DS_CFG_CODES } from './parse.js';

const SEV_ORDER = { crit: 0, warn: 1, info: 2 };
export const ROWS_MAX = 2000;
export const VSAN_SLACK_PCT = 70;
export const VSAN_CODES = Object.freeze({ 'vsan-partition': 'crit', 'vsan-disk-issue': 'warn', 'vsan-capacity-high': 'warn' });

function matchQ(q, ...xs) { if (!q) return true; const s = String(q).toLowerCase(); return xs.some((x) => String(x || '').toLowerCase().includes(s)); }

export function analyzeDatastores(dss, opt = {}) {
  const list = Array.isArray(dss) ? dss : [];
  const coverage = { datastores: list.length, cfg: 0, notCollected: 0 };
  const byCode = Object.fromEntries(Object.entries(DS_CFG_CODES).map(([c, sev]) => [c, { sev, count: 0 }]));
  const rows = [];
  for (const d of list) {
    if (d.dcfg) coverage.cfg += 1; else coverage.notCollected += 1;
    const f = dsCfgFindings(d);
    for (const x of f) byCode[x.code].count += 1;
    if (!f.length) continue;
    f.sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev]);
    if (opt.code && !f.some((x) => x.code === opt.code)) continue;
    if (!matchQ(opt.q, d.name, opt.vcName?.get(d.vcenterId))) continue;
    rows.push({
      id: d.id, name: d.name, vcenterId: d.vcenterId, vcenterName: opt.vcName?.get(d.vcenterId) || d.vcenterId, type: d.type || '',
      capacityGB: d.capacityGB ?? null, usedGB: d.usedGB ?? null, uncommittedGB: d.dcfg?.uncommittedGB ?? null,
      vmCount: d.dcfg?.vmCount ?? null, mounts: d.dcfg?.mounts ?? null, inSdrs: d.dcfg?.inSdrs ?? null, vmfsMajor: d.vmfsMajor ?? null,
      sev: f[0].sev, findings: f,
    });
  }
  rows.sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev] || b.findings.length - a.findings.length || String(a.name).localeCompare(String(b.name)));
  return { coverage, byCode, matched: rows.length, rows: rows.slice(0, ROWS_MAX), omitted: Math.max(0, rows.length - ROWS_MAX) };
}

/** 호스트별 멀티패스 — mp 를 읽은 호스트 전부를 보이고(문제 있는 것 먼저) 경로 정책 분포를 함께. */
export function analyzePaths(hosts, opt = {}) {
  const list = (Array.isArray(hosts) ? hosts : []).filter((h) => h.connectionState !== 'DISCONNECTED');
  const coverage = { hosts: list.length, read: 0, notCollected: 0 };
  const totals = { dead: 0, singlePath: 0, hostsDead: 0, hostsSingle: 0 };
  const policies = {};
  const rows = [];
  for (const h of list) {
    const mp = h.hcfg?.mp;
    if (!mp) { coverage.notCollected += 1; continue; }
    coverage.read += 1;
    totals.dead += mp.dead; totals.singlePath += mp.singlePath;
    if (mp.dead > 0) totals.hostsDead += 1;
    if (mp.singlePath > 0) totals.hostsSingle += 1;
    for (const [k, n] of Object.entries(mp.policies || {})) policies[k] = (policies[k] || 0) + n;
    if (opt.onlyIssues && !(mp.dead > 0 || mp.singlePath > 0)) continue;
    if (!matchQ(opt.q, h.name, h.cluster, opt.vcName?.get(h.vcenterId))) continue;
    rows.push({ id: h.id, name: h.name, vcenterId: h.vcenterId, vcenterName: opt.vcName?.get(h.vcenterId) || h.vcenterId, cluster: h.cluster, at: h.hcfg.at ?? null, ...mp });
  }
  rows.sort((a, b) => (b.dead > 0) - (a.dead > 0) || (b.singlePath > 0) - (a.singlePath > 0) || b.dead - a.dead || String(a.name).localeCompare(String(b.name)));
  return { coverage, totals, policies, matched: rows.length, rows: rows.slice(0, ROWS_MAX), omitted: Math.max(0, rows.length - ROWS_MAX) };
}

/** vSAN 클러스터 — vSAN 이 켜진 호스트가 있는 클러스터만. 멤버 수 < vSAN 호스트 수면 분할(partition) 후보. */
export function analyzeVsan(hosts, dss, opt = {}) {
  const byCl = new Map();
  let unknownHosts = 0;
  for (const h of Array.isArray(hosts) ? hosts : []) {
    if (h.connectionState === 'DISCONNECTED') continue;
    const v = h.hcfg?.vsan;
    if (!v) { unknownHosts += 1; continue; }
    if (v.enabled !== true) continue;
    const k = `${h.vcenterId}\u0000${h.cluster}`;
    const c = byCl.get(k) || { vcenterId: h.vcenterId, vcenterName: opt.vcName?.get(h.vcenterId) || h.vcenterId, cluster: h.cluster, hosts: 0, diskIssues: 0, minMembers: null, issueHosts: [] };
    c.hosts += 1;
    if (Number.isFinite(v.diskIssues) && v.diskIssues > 0) { c.diskIssues += v.diskIssues; if (c.issueHosts.length < 10) c.issueHosts.push(h.name); }
    if (Number.isFinite(v.members)) c.minMembers = c.minMembers == null ? v.members : Math.min(c.minMembers, v.members);
    byCl.set(k, c);
  }
  const vsanDs = (Array.isArray(dss) ? dss : []).filter((d) => /vsan/i.test(d.type || ''));
  const dsByVc = new Map();
  for (const d of vsanDs) { const a = dsByVc.get(d.vcenterId) || []; a.push(d); dsByVc.set(d.vcenterId, a); }
  const clusters = [];
  for (const c of byCl.values()) {
    const findings = [];
    if (c.minMembers != null && c.minMembers < c.hosts) findings.push({ code: 'vsan-partition', sev: VSAN_CODES['vsan-partition'], facts: { members: c.minMembers, hosts: c.hosts } });
    if (c.diskIssues > 0) findings.push({ code: 'vsan-disk-issue', sev: VSAN_CODES['vsan-disk-issue'], facts: { count: c.diskIssues, hosts: c.issueHosts } });
    clusters.push({ ...c, findings });
  }
  const datastores = vsanDs.map((d) => {
    const pct = d.capacityGB > 0 && Number.isFinite(d.usedGB) ? Math.round((d.usedGB / d.capacityGB) * 100) : null;
    const findings = pct != null && pct >= VSAN_SLACK_PCT ? [{ code: 'vsan-capacity-high', sev: VSAN_CODES['vsan-capacity-high'], facts: { pct, limit: VSAN_SLACK_PCT } }] : [];
    return { id: d.id, name: d.name, vcenterId: d.vcenterId, vcenterName: opt.vcName?.get(d.vcenterId) || d.vcenterId, capacityGB: d.capacityGB ?? null, usedGB: d.usedGB ?? null, usagePct: pct, findings };
  });
  clusters.sort((a, b) => b.findings.length - a.findings.length || String(a.cluster).localeCompare(String(b.cluster)));
  datastores.sort((a, b) => (b.usagePct ?? -1) - (a.usagePct ?? -1));
  return { clusters, datastores, unknownHosts, dsByVcenter: dsByVc.size };
}
