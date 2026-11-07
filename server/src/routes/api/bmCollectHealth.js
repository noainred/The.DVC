/**
 * routes/api/bmCollectHealth.js — 리눅스 성능 6단계 **수집 건강 보드**(메타 모니터링 · 설계 PROFILES §16 C · 아트보드 Collect) API.
 *
 * `GET /tools/bm-usage/collect-health` — 관리자 · 운영자(설계 ‘관리자와 운영자’) + tools. 사람이 열 때 1회 + 버튼(폴링 없음 · 캐시 없음).
 *   · 값은 **수집 노드가 매 주기 쓴 것**(이 노드: poller.collectHealthNow · 엣지: 봉투 collectHealth — 중앙 정제 화이트리스트를 거친 보관분).
 *     중앙은 다시 판정하지 않는다(기준 대조 cells 도 그 노드 것). 상태 code 는 여기서 붙이되 판정이 아니라 사실 분류(꺼짐 · 주기 없음 · 엣지 버전 · 보관분 오래됨).
 *   · 범위(server/CLAUDE.md ‘조회 라우트 scope 는 예외 없이’): 법인 행은 허용 법인만 · 노드 전체 값(주기 소요 · 동시성 · SSH · DB · 추이 · 사유 며칠째)은
 *     **그 노드의 법인이 전부 허용 안일 때만**(아니면 nodeHidden — 다른 법인 서버가 섞인 값이다) · 보이는 법인이 없는 노드는 행을 주지 않는다(개수만 밝힌다).
 *   · 엣지 최소 버전 문구는 릴리스 노트의 6단계 첫 게시 번호(featureMinEdgeVersion — 숫자를 박지 않는다). 판정은 ‘봉투에 collectHealth 가 있는가’.
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { strOf } from '../../util/coercionTrap.js';
import { numOrNull } from '../../util/numOrNull.js';
import { config } from '../../config.js';

const t = (v) => strOf(v, 4096).trim();
const n = numOrNull;
const opRole = requireRole('admin', 'operator');
const toolsPerm = requirePerm('tools');

function deps0(deps = {}) {
  return {
    localHealth: async () => (await import('../../bmusage/poller.js')).collectHealthNow(),
    localEnabled: async () => (await import('../../bmusage/settings.js')).bmUsageEnabled(),
    localCorps: async () => Object.keys((await import('../../bmusage/settings.js')).loadBmUsageSettings().corps || {}),
    localTrend: async () => (await import('../../bmusage/edgePull.js')).collectTrend(),
    listEdgeBmUsage: async () => (await import('../../central/bmUsageEdgePull.js')).listEdgeBmUsage(),
    staleMs: async () => (await import('../../central/bmUsageEdgePull.js')).STALE_MS,
    minEdgeVersion: async () => (await import('../../central/featureMinEdgeVersion.js')).stage6MinEdgeVersion(),
    ...deps,
  };
}
const flagsOf = (node) => Object.entries(node?.cells || {}).filter(([, v]) => v === 'true').map(([k]) => k);

/**
 * 노드 상태(순수 — 사실 분류): off · no-cycle · old-version · edge-stale · ok · attention(기준 밖 칸이 있다).
 *   ‘엣지 버전 낮음’ 은 봉투에 collectHealth 필드가 없을 때(경로 존재와 같은 판정 — 버전 숫자 비교가 아니다).
 */
export function nodeStateOf({ via, enabled, health, snapAt, staleMs, now = Date.now(), hasField = true }) {
  if (enabled === false) return 'off';
  if (via === 'edge' && !hasField) return 'old-version';
  if (!health) return 'no-cycle';
  if (via === 'edge' && n(snapAt) != null && n(staleMs) != null && now - snapAt > staleMs) return 'edge-stale';
  return flagsOf(health.node).length ? 'attention' : 'ok';
}

export async function bmCollectHealthView(req, snap, deps = {}) {
  const D = deps0(deps);
  const allowed = scopedVcenterIds(req.user, snap);
  const now = Date.now();
  const staleMs = await D.staleMs().catch(() => 30 * 60_000);
  const minEdgeVersion = await D.minEdgeVersion().catch(() => null);
  const nodes0 = [];
  const lh = await D.localHealth().catch(() => null);
  const lEnabled = await D.localEnabled().catch(() => null);
  if (lh || lEnabled) nodes0.push({ agent: config.agent?.name || '', via: 'local', enabled: lEnabled, health: lh ? { ...lh, trend: await D.localTrend().catch(() => []) } : null, corps: await D.localCorps().catch(() => []), hasField: true });
  for (const rec of await D.listEdgeBmUsage()) {
    const sn = rec?.snap || null;
    nodes0.push({ agent: t(rec?.agent), via: 'edge', enabled: sn ? sn.enabled === true : null, health: sn?.collectHealth || null, hasField: !!sn?.collectHealth, corps: Array.isArray(sn?.settings?.corps) ? sn.settings.corps : [],
      snapAt: rec?.snapAt ?? null, version: t(sn?.node?.version), lastAttempt: rec?.lastAttempt || null, noSnap: !sn });
  }
  const nodes = []; const rows = []; let omitted = 0;
  for (const x of nodes0) {
    const byCorp = x.health?.byCorp || {};
    const corpIds = [...new Set([...(x.corps || []).map(t), ...Object.keys(byCorp)])].filter((v) => v !== undefined);
    const visible = allowed ? corpIds.filter((vc) => vc && allowed.has(vc)) : corpIds;
    if (allowed && !visible.length) { omitted += 1; continue; }
    const nodeHidden = !!allowed && corpIds.some((vc) => !vc || !allowed.has(vc));
    const state = x.noSnap ? 'no-snapshot' : nodeStateOf({ via: x.via, enabled: x.enabled, health: x.health, snapAt: x.snapAt, staleMs, now, hasField: x.hasField });
    const node = x.health?.node || null;
    nodes.push({
      agent: x.agent, via: x.via, state, flags: nodeHidden ? [] : flagsOf(node), snapAt: x.snapAt ?? null, version: x.version || null,
      ...(x.via === 'edge' && !allowed ? { lastAttempt: x.lastAttempt } : {}),
      nodeHidden, corps: visible,
      ...(nodeHidden || !node ? {} : { node, trend: x.health?.trend || [], sinceFrom: x.health?.sinceFrom ?? null }),
    });
    for (const vc of visible) {
      const c = byCorp[vc] || null;
      rows.push({
        vcenterId: vc, agent: x.agent, via: x.via, nodeState: state, nodeHidden,
        servers: c ? n(c.servers) : (x.health ? 0 : null), ok: c ? n(c.ok) : null, fail: c ? n(c.fail) : null,
        successPct: c && n(c.servers) ? Math.round((n(c.ok) / n(c.servers)) * 1000) / 10 : null,
        reasons: c ? Object.entries(c.reasons || {}).map(([k, v]) => { const [p, code] = k.split(':'); return { path: p, code, n: n(v) }; }).sort((a, b) => (b.n || 0) - (a.n || 0)) : [],
        ...(nodeHidden || !node ? {} : { cycleMs: n(node.cycleMs), budgetMs: n(node.budgetMs), cyclePct: n(node.cyclePct), conc: node.conc || null, ssh: node.ssh || null, dbBytes: n(node.db?.bytes), dbFiles: n(node.db?.files), dbPct: n(node.dbPct) }),
      });
    }
  }
  // 실패 사유 · 조치 — 보이는 법인 행의 사유 합(며칠째는 노드 값이 보일 때만 — 다른 법인 서버의 사유가 섞인 노드 값이다).
  const agg = new Map();
  for (const r of rows) for (const x of r.reasons) { const k = `${x.path}:${x.code}`; const cur = agg.get(k) || { path: x.path, code: x.code, n: 0, since: null }; cur.n += x.n || 0; agg.set(k, cur); }
  for (const nd of nodes) for (const x of nd.node?.reasons || []) { const cur = agg.get(`${x.path}:${x.code}`); if (cur && n(x.since) != null) cur.since = cur.since == null ? x.since : Math.min(cur.since, x.since); }
  const { reasonState } = await import('../../bmusage/collectHealth.js');
  const reasons = [...agg.values()].map((x) => ({ ...x, state: reasonState(x.path, x.code) })).sort((a, b) => b.n - a.n);
  const sum = (f) => rows.reduce((a, r) => a + (n(r[f]) ?? 0), 0);
  const servers = sum('servers'); const okN = sum('ok');
  const visibleNodes = nodes.filter((x) => x.node);
  const worst = visibleNodes.filter((x) => n(x.node.cyclePct) != null).sort((a, b) => b.node.cyclePct - a.node.cyclePct)[0] || null;
  const kpi = {
    corps: rows.length, servers, successPct: servers ? Math.round((okN / servers) * 1000) / 10 : null, okN,
    worstCycle: worst ? { agent: worst.agent, cyclePct: worst.node.cyclePct, cycleMs: worst.node.cycleMs, budgetMs: worst.node.budgetMs } : null,
    dbBytes: visibleNodes.length ? visibleNodes.reduce((a, x) => a + (n(x.node.db?.bytes) ?? 0), 0) : null,
    focusRunning: visibleNodes.length ? visibleNodes.reduce((a, x) => a + (n(x.node.focus?.running) ?? 0), 0) : null,
    focusQueued: visibleNodes.length ? visibleNodes.reduce((a, x) => a + (n(x.node.focus?.queued) ?? 0), 0) : null,
    concNote: visibleNodes.length ? visibleNodes.map((x) => ({ agent: x.agent, max: x.node.conc?.max ?? null, cap: x.node.conc?.cap ?? null })) : [],
  };
  return { ok: true, at: now, staleMs, ...(minEdgeVersion ? { minEdgeVersion } : {}), nodes, rows, reasons, kpi, ...(allowed ? { scoped: true, nodesOmitted: omitted } : {}) };
}

export function registerBmCollectHealth(api) {
  api.get('/tools/bm-usage/collect-health', opRole, toolsPerm, async (req, res) => {
    try { res.json(await bmCollectHealthView(req, store.get())); }
    catch (e) { res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) }); }
  });
}
