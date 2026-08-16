/**
 * 글로벌 네트워크 점검 — 전세계 제어플레인 엔드포인트(vCenter·NSX 매니저)의 중앙에서의
 * 도달성/지연(TCP 443 RTT)을 측정하고, 수집된 네트워크 객체(포트그룹/분산스위치/NSX 세그먼트)를
 * 요약한다. 고RTT 사이트(폴란드/미국)는 RTT가 크게 나오며, 에이전트 경유 수집 vCenter는 중앙
 * 직접 도달이 불가해도 '수집 정상'으로 표시될 수 있다(이중 표기).
 */

import { store } from '../store.js';
import { loadVcenterConfig } from '../config.js';
import { nsxStore } from '../nsx/store.js';
import { listRegistry as listNsxRegistry } from '../nsx/registry.js';
import { tcpProbeMany } from '../util/ping.js';
import { visibleNsxManagers } from '../nsx/scope.js';

const hostOf = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
const rttGrade = (ms) => (ms == null ? 'down' : ms < 100 ? 'ok' : ms < 400 ? 'warn' : 'slow');

/**
 * @param {Set<string>|null} allowed 사용자 scope(scopedVcenterIds) — non-null 이면 프로브 대상
 *   vCenter/NSX 를 그 범위로 좁힌다(v2.322 보안 감사: 범위 밖 제어플레인 host/이름/region/RTT
 *   노출 차단). NSX 는 nsx/scope.js 귀속 판정(매니저.vcenterId∈allowed ∪ region∈allowed region)을
 *   재사용해 무귀속 매니저를 숨긴다. null=무제한(기존 동작).
 */
export async function getNetworkCheck(allowed = null) {
  const snap = store.get();
  const vcStatus = new Map((snap.vcenters || []).map((v) => [v.id, v.status]));
  const vcCfg = (loadVcenterConfig().vcenters || []).filter((v) => !allowed || allowed.has(v.id));

  // 프로브 대상: vCenter(설정 host) + NSX 매니저(host). 범위 계정은 귀속분만.
  const targets = [];
  for (const v of vcCfg) { const h = hostOf(v.host); if (h) targets.push({ kind: 'vcenter', id: v.id, name: v.id, host: h, port: 443, collected: vcStatus.get(v.id) || 'unknown' }); }
  const nsxMgrs = visibleNsxManagers(listNsxRegistry().map((m) => ({ ...m, region: m.region || m.location?.region || '' })), snap.vcenters, allowed);
  for (const m of nsxMgrs) { const h = hostOf(m.host); if (h && m.enabled !== false) targets.push({ kind: 'nsx', id: m.id, name: m.name || h, host: h, port: 443, region: m.region || '' }); }

  // 고RTT(800ms+) 사이트는 왕복+재전송 여유를 위해 5s. 짧으면 살아있는 vCenter도 'unreachable' 오판.
  const probed = await tcpProbeMany(targets, { timeoutMs: Number(process.env.HEALTH_PROBE_TIMEOUT_MS) || 5000, concurrency: 12 });
  const endpoints = probed.map((t) => ({
    kind: t.kind, id: t.id, name: t.name, host: t.host, region: t.region || '',
    reachable: t.alive, rttMs: t.rttMs, grade: rttGrade(t.rttMs),
    collected: t.collected || null,
    // 중앙 직접 도달 불가지만 수집은 정상 → 에이전트 경유로 안내.
    viaAgent: t.kind === 'vcenter' && !t.alive && t.collected === 'connected',
  })).sort((a, b) => (b.rttMs ?? 1e9) - (a.rttMs ?? 1e9));

  // 네트워크 객체 요약(수집 스냅샷) — 범위 계정은 허용 vCenter 의 네트워크만 집계.
  const nets = (snap.networks || []).filter((n) => !allowed || allowed.has(n.vcenterId));
  const byType = {};
  for (const n of nets) { const k = n.type || 'unknown'; byType[k] = (byType[k] || 0) + 1; }
  const nsxSnap = nsxStore.get();
  // NSX 세그먼트/게이트웨이 총계도 보이는 매니저 기준으로만(전 함대 총계 유출 차단).
  const visMgrIds = new Set(targets.filter((t) => t.kind === 'nsx').map((t) => t.id));
  const nsxSeg = allowed ? (nsxSnap.segments || []).filter((s) => visMgrIds.has(s.managerId)) : (nsxSnap.segments || []);
  const nsxGw = allowed ? (nsxSnap.gateways || []).filter((g) => visMgrIds.has(g.managerId)) : (nsxSnap.gateways || []);

  const summary = {
    endpoints: endpoints.length,
    reachable: endpoints.filter((e) => e.reachable).length,
    viaAgent: endpoints.filter((e) => e.viaAgent).length,
    unreachable: endpoints.filter((e) => !e.reachable && !e.viaAgent).length,
    avgRttMs: (() => { const r = endpoints.filter((e) => e.rttMs != null).map((e) => e.rttMs); return r.length ? Math.round(r.reduce((a, b) => a + b, 0) / r.length) : null; })(),
    networks: nets.length, byType,
    nsxSegments: nsxSeg.length, nsxGateways: nsxGw.length,
  };
  return { summary, endpoints, generatedAt: Date.now() };
}
