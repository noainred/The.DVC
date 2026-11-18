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
  const rowsMax = opt.rowsMax ?? ROWS_MAX;
  return { coverage, byCode, vcenters: [...byVc.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))), clusters: clusters.slice(0, 200), clustersOmitted: Math.max(0, clusters.length - 200), matched, rows: rows.slice(0, rowsMax), omitted: Math.max(0, matched - rowsMax) };
}

/**
 * v3.22.0 Hypervisor 분석 화면 요약(`/tools/host-hygiene?summary=1` — docs/design/vm-insight §10 · host-insight) — 법인(vCenter)별 줄 + 법인별 상위 N.
 *   법인마다 analyzeHostCfg 를 **상한 없이** 한 번 돌린다(판정 그대로 — 화면 목록 2,000줄에 잘린 행으로 세지 않는다). 드리프트 비교 묶음은
 *   (vCenter, 클러스터) 라 법인으로 나눠 돌려도 판정이 같고, coverage · byCode 는 더하면 전체와 같다.
 *   crit · warn · info = 가장 높은 심각도로 센 호스트 수(도구 행의 sev) · problem = 판정이 하나라도 있는 호스트(withFindings) ·
 *   ssh · certExpired · certExpiring = 도구 byCode 의 'ssh-running' · 'cert-expired' · 'cert-expiring' 호스트 수 ·
 *   판정 밖 = coverage.notCollected(구성 값을 못 받음) + coverage.disconnected(끊김 — 값이 낡았다).
 *   상위 N: certExpired = 인증서가 만료된 호스트를 만료 뒤 지난 일수 큰 순 · worst = 도구 정렬(심각도 → 판정 수 → 이름)의 앞 N.
 */
export function hostCfgSummaryByVc(snap, { now = Date.now(), vcName = new Map(), topN = 5 } = {}) {
  const ids = new Set((snap.vcenters || []).map((v) => v.id));
  const by = new Map();
  for (const h of snap.hosts || []) { if (!h || typeof h !== 'object') continue; ids.add(h.vcenterId); let a = by.get(h.vcenterId); if (!a) { a = []; by.set(h.vcenterId, a); } a.push(h); }
  const pick = (r) => ({ id: r.id, name: r.name, cluster: r.cluster, version: r.version, build: r.build, sev: r.sev, codes: [...new Set(r.findings.map((f) => f.code))] });
  const rows = [...ids].map((id) => {
    const out = analyzeHostCfg(by.get(id) || [], { now, vcName, rowsMax: Infinity });
    const sevN = { crit: 0, warn: 0, info: 0 };
    for (const r of out.rows) sevN[r.sev] += 1;
    const byCode = Object.fromEntries(Object.entries(out.byCode).map(([c, v]) => [c, v.hosts]));
    const expired = out.rows.filter((r) => r.findings.some((f) => f.code === 'cert-expired'))
      .map((r) => ({ ...pick(r), days: r.findings.find((f) => f.code === 'cert-expired').facts?.days ?? null }))
      .sort((a, b) => (b.days ?? -1) - (a.days ?? -1) || String(a.name).localeCompare(String(b.name)));
    return {
      vcenterId: id, name: vcName.get(id) || id, coverage: out.coverage, hosts: out.coverage.hosts,
      problem: out.matched, crit: sevN.crit, warn: sevN.warn, info: sevN.info,
      ssh: byCode['ssh-running'] ?? 0, certExpired: byCode['cert-expired'] ?? 0, certExpiring: byCode['cert-expiring'] ?? 0,
      outOfJudgment: out.coverage.notCollected + out.coverage.disconnected,
      byCode,
      top: { certExpired: expired.slice(0, topN), worst: out.rows.slice(0, topN).map(pick) },
    };
  }).sort((a, b) => String(a.vcenterId).localeCompare(String(b.vcenterId)));
  return { codes: HOST_CFG_CODES, topN, rows };
}
