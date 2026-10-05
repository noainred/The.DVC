/**
 * hostcfg/analyze.js — 특수 기능 'ESXi 호스트 구성 점검'(도구 키 `host-hygiene`, v2.699) 판정(순수).
 * 입력은 스냅샷 호스트 배열(host.hcfg = hostcfg 캐시 + build). vCenter 왕복 0.
 *
 * 정직 규칙
 *  · hcfg 가 없는 호스트는 판정하지 않고 '미수집' 으로 센다 — 빈 결과를 '이상 없음' 이라 말하지 않는다.
 *  · 연결이 끊긴 호스트는 판정하지 않는다(값이 낡았다) — 개수만 센다.
 *  · 드리프트는 같은 클러스터에서 값을 아는 호스트끼리만 비교하고, 다수값이 없으면(동률) 어느 쪽이 옳다고 말하지 않는다.
 */
import { HOST_CFG_CODES, hostCfgFindings, clusterDrift } from './parse.js';

const SEV_ORDER = { crit: 0, warn: 1, info: 2 };
export const ROWS_MAX = 2000;

export function analyzeHostCfg(hosts, opt = {}) {
  const now = opt.now ?? Date.now();
  const list = Array.isArray(hosts) ? hosts : [];
  const { perHost, clusters } = clusterDrift(list);
  const coverage = { hosts: list.length, cfg: 0, notCollected: 0, disconnected: 0 };
  const byCode = Object.fromEntries(Object.entries(HOST_CFG_CODES).map(([c, sev]) => [c, { sev, hosts: 0 }]));
  const rows = [];
  const byVc = new Map();
  for (const h of list) {
    const vs = byVc.get(h.vcenterId) || { vcenterId: h.vcenterId, name: opt.vcName?.get(h.vcenterId) || h.vcenterId, hosts: 0, withFindings: 0 };
    vs.hosts += 1; byVc.set(h.vcenterId, vs);
    if (h.connectionState === 'DISCONNECTED') { coverage.disconnected += 1; continue; }
    if (!h.hcfg) { coverage.notCollected += 1; continue; }
    coverage.cfg += 1;
    const findings = hostCfgFindings(h, now);
    for (const d of perHost.get(h.id) || []) findings.push({ code: 'drift', sev: 'info', facts: d });
    const seen = new Set();
    for (const f of findings) if (!seen.has(f.code)) { seen.add(f.code); byCode[f.code].hosts += 1; }
    if (!findings.length) continue;
    vs.withFindings += 1;
    findings.sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev]);
    const sev = findings[0].sev;
    if (opt.code && !seen.has(opt.code)) continue;
    if (opt.sev && sev !== opt.sev) continue;
    if (opt.q) {
      const q = String(opt.q).toLowerCase();
      if (![h.name, h.cluster, opt.vcName?.get(h.vcenterId)].some((x) => String(x || '').toLowerCase().includes(q))) continue;
    }
    rows.push({
      id: h.id, name: h.name, vcenterId: h.vcenterId, vcenterName: opt.vcName?.get(h.vcenterId) || h.vcenterId,
      cluster: h.cluster, version: h.version || '', build: h.build || '', at: h.hcfg.at ?? null, sev, findings,
    });
  }
  rows.sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev] || b.findings.length - a.findings.length || String(a.name).localeCompare(String(b.name)));
  const matched = rows.length;
  return { coverage, byCode, vcenters: [...byVc.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))), clusters: clusters.slice(0, 200), clustersOmitted: Math.max(0, clusters.length - 200), matched, rows: rows.slice(0, ROWS_MAX), omitted: Math.max(0, matched - ROWS_MAX) };
}
