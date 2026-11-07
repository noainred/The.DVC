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
import { cmpVersion } from '../../util/cmpVersion.js';
import { isCycleFailure, collectCells, reasonState } from '../../bmusage/collectHealth.js';

const t = (v) => strOf(v, 4096).trim();
const n = numOrNull;
const opRole = requireRole('admin', 'operator');
/** 7b: 중앙 직접 수집 경고 기준(설계 §18 — 800ms+ 법인은 엣지 수집 권장). 모르면(핑 값 없음) null — 0 이나 정상으로 보이지 않는다. */
export const RTT_WARN_MS = 800;
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
    // 7b: 중앙 직접 수집 법인의 RTT(핑 모니터 마지막 값 — hostCorp.rttReader 하나). 800ms 이상이면 행에 경고(엣지 수집 권장).
    rttOf: async () => (await import('./hostCorp.js')).rttReader(),
    ...deps,
  };
}
const flagsOf = (node) => Object.entries(node?.cells || {}).filter(([, v]) => v === 'true').map(([k]) => k);

/**
 * 노드 상태(순수 — 사실 분류): off · no-cycle · old-version · edge-stale · cycle-failed · ok · attention(기준 밖 칸이 있다).
 *   ‘엣지 버전 낮음’ 은 봉투에 collectHealth 필드도 6단계 표지(collectHealthVer)도 없고, 엣지가 알린 버전이 최소 버전보다 낮거나 모를 때만(반증 F3 —
 *   재시작 직후 첫 주기 전의 6단계 엣지는 ‘아직 주기 없음’). ‘주기 실패’ 는 분류 실패 · 주기 예외 · 계산 실패(대상 · 결과를 모름 — 정상이 아니다 · 반증 F1).
 */
export function nodeStateOf({ via, enabled, health, snapAt, staleMs, now = Date.now(), hasField = true, marker = false, version = '', minEdgeVersion = '' }) {
  if (enabled === false) return 'off';
  if (via === 'edge' && !hasField) {
    if (marker) return 'no-cycle';
    const c = version && minEdgeVersion ? cmpVersion(version, minEdgeVersion) : null;
    return c != null && c >= 0 ? 'no-cycle' : 'old-version';
  }
  if (!health) return 'no-cycle';
  if (via === 'edge' && n(snapAt) != null && n(staleMs) != null && now - snapAt > staleMs) return 'edge-stale';
  if (isCycleFailure(health.node?.error)) return 'cycle-failed';
  return flagsOf(health.node).length ? 'attention' : 'ok';
}
/** 노드 값을 숨긴 범위 계정에게도 보여 줄 수 있는 상태(노드 값과 무관한 사실 · 그 법인 서버도 같이 겪는 실패) — 나머지는 법인 기준으로 다시 정한다(반증 F8). */
const HIDDEN_KEEP = new Set(['off', 'no-cycle', 'old-version', 'edge-stale', 'no-snapshot', 'cycle-failed']);
/**
 * 법인 한 곳의 기준 대조(순수) — 노드 판정 코어(collectCells) 하나에 **그 법인 값만** 넣는다: 성공률 · 인증 사유 · 주기 실패. 주기 소요 · DB 는 노드 전체 값이라 대지 않는다(unread).
 *   범위 계정이 다른 법인 서버의 장애(인증 정지 등)를 노드 상태 ‘기준 밖’ 으로 엿보지 않게(반증 F8).
 */
export function corpCellsOf(c, nodeError, th) {
  const servers = n(c?.servers); const ok = n(c?.ok);
  const reasons = Object.keys(c?.reasons || {}).map((k) => ({ code: k.split(':')[1] }));
  const cc = collectCells({ cyclePct: null, successPct: servers && ok != null ? Math.round((ok / servers) * 1000) / 10 : null, reasons: c ? reasons : null, error: nodeError }, null, th || undefined);
  return cc.cells;
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
    const la = rec?.lastAttempt;
    nodes0.push({ agent: t(rec?.agent), via: 'edge', enabled: sn ? sn.enabled === true : null, health: sn?.collectHealth || null, hasField: !!sn?.collectHealth, marker: n(sn?.collectHealthVer) != null,
      corps: Array.isArray(sn?.settings?.corps) ? sn.settings.corps : [],
      // 엣지 봉투의 byCorp 법인 이름은 그 엣지의 대상 · 설정 법인과 맞는 것만 믿는다(봉투 문자열만으로 법인 행을 새로 만들지 않는다 — 아래 corpIds).
      targetCorps: (Array.isArray(sn?.targets) ? sn.targets : []).map((x) => t(x?.vcenterId)).filter(Boolean),
      snapAt: rec?.snapAt ?? null, version: t(sn?.node?.version), noSnap: !sn,
      // 마지막 당김은 시각 · 성공 · 종류 · 소요만(사유 원문은 싣지 않는다 — 엣지 오류 문구가 섞인다).
      lastAttempt: la && typeof la === 'object' ? { at: n(la.at), ok: la.ok === true, kind: t(la.kind).slice(0, 40), ms: n(la.ms) } : null });
  }
  const nodes = []; const rows = []; let omitted = 0; let corpsDropped = 0;
  // 7b: 이 노드가 중앙이고 직접 수집하는 법인만 RTT 를 싣는다(엣지 법인은 그 법인 안에서 읽으므로 WAN RTT 가 수집에 걸리지 않는다).
  const rttOf = !config.agent?.centralUrl ? await D.rttOf().catch(() => null) : null;
  const rttCell = (vc) => {
    const r = typeof rttOf === 'function' ? rttOf(vc) : null;
    const ms = r && Number.isFinite(r.rttMs) ? r.rttMs : null;
    return { rttMs: ms, rttHigh: ms != null ? ms >= RTT_WARN_MS : null, rttAt: r?.at ?? null };
  };
  for (const x of nodes0) {
    const byCorp0 = x.health?.byCorp || {};
    let byCorp = byCorp0;
    if (x.via === 'edge') {
      const own = new Set([...(x.corps || []).map(t), ...(x.targetCorps || [])].filter(Boolean));
      byCorp = {};
      for (const [vc, v] of Object.entries(byCorp0)) { if (own.has(vc)) byCorp[vc] = v; else corpsDropped += 1; }
    }
    const corpIds = [...new Set([...(x.corps || []).map(t), ...Object.keys(byCorp)])].filter((v) => v !== undefined);
    const visible = allowed ? corpIds.filter((vc) => vc && allowed.has(vc)) : corpIds;
    if (allowed && !visible.length) { omitted += 1; continue; }
    const nodeHidden = !!allowed && corpIds.some((vc) => !vc || !allowed.has(vc));
    const state0 = x.noSnap ? 'no-snapshot' : nodeStateOf({ via: x.via, enabled: x.enabled, health: x.health, snapAt: x.snapAt, staleMs, now, hasField: x.hasField, marker: x.marker, version: x.version, minEdgeVersion });
    // 노드 값을 숨기면 노드 상태도 노드 값(다른 법인 서버 포함)으로 정하지 않는다 — ‘법인 행을 보세요’(hidden) · 법인 행은 그 법인 값으로(반증 F8).
    const state = nodeHidden && !HIDDEN_KEEP.has(state0) ? 'hidden' : state0;
    const node = x.health?.node || null;
    const failed = isCycleFailure(node?.error);
    nodes.push({
      agent: x.agent, via: x.via, state, flags: nodeHidden ? [] : flagsOf(node), snapAt: x.snapAt ?? null, version: x.version || null,
      ...(x.via === 'edge' && !allowed ? { lastAttempt: x.lastAttempt } : {}),
      nodeHidden, corps: visible,
      ...(nodeHidden || !node ? {} : { node, trend: x.health?.trend || [], sinceFrom: x.health?.sinceFrom ?? null }),
    });
    for (const vc of visible) {
      const c = byCorp[vc] || null;
      // 숨긴 노드의 법인 행 — 상태 · 기준 밖 칸은 그 법인 값으로(노드 상태가 노드 값과 무관한 사실이면 그대로).
      let rowState = state; let rowFlags = nodeHidden ? [] : flagsOf(node);
      if (nodeHidden && state === 'hidden') {
        const cells = corpCellsOf(c, node?.error, node?.th);
        rowFlags = Object.entries(cells).filter(([, v]) => v === 'true').map(([k]) => k);
        rowState = rowFlags.length ? 'attention' : 'ok';
      }
      rows.push({
        vcenterId: vc, agent: x.agent, via: x.via, nodeState: rowState, flags: rowFlags, nodeHidden,
        ...(x.via === 'local' && rttOf ? rttCell(vc) : {}),
        // 주기 실패면 이 법인 대상 수도 모른다(null — 0 이 아니다 · 반증 F1) · 주기 기록이 있고 이 법인 값이 없으면 사실 0(이번 주기 대상 없음).
        servers: c ? n(c.servers) : (x.health && !failed ? 0 : null), ok: c ? n(c.ok) : null, fail: c ? n(c.fail) : null,
        // 성공 수를 모르면 성공률도 모른다(0% 가 아니다 · 반증 F4).
        successPct: c && n(c.servers) && n(c.ok) != null ? Math.round((n(c.ok) / n(c.servers)) * 1000) / 10 : null,
        reasons: c ? Object.entries(c.reasons || {}).map(([k, v]) => { const [p, code] = k.split(':'); return { path: p, code, n: n(v) }; }).sort((a, b) => (b.n || 0) - (a.n || 0)) : [],
        ...(nodeHidden || !node ? {} : { cycleMs: n(node.cycleMs), budgetMs: n(node.budgetMs), cyclePct: n(node.cyclePct), conc: node.conc || null, ssh: node.ssh || null, dbBytes: n(node.db?.bytes), dbFiles: n(node.db?.files), dbPct: n(node.dbPct) }),
      });
    }
  }
  // 실패 사유 · 조치 — 보이는 법인 행의 사유 합(며칠째는 노드 값이 보일 때만 — 다른 법인 서버의 사유가 섞인 노드 값이다).
  const agg = new Map();
  for (const r of rows) for (const x of r.reasons) { const k = `${x.path}:${x.code}`; const cur = agg.get(k) || { path: x.path, code: x.code, n: 0, since: null }; cur.n += x.n || 0; agg.set(k, cur); }
  for (const nd of nodes) for (const x of nd.node?.reasons || []) { const cur = agg.get(`${x.path}:${x.code}`); if (cur && n(x.since) != null) cur.since = cur.since == null ? x.since : Math.min(cur.since, x.since); }
  const reasons = [...agg.values()].map((x) => ({ ...x, state: reasonState(x.path, x.code) })).sort((a, b) => b.n - a.n);
  // 합계는 **값이 있는 것만** 더하고 모르는 개수를 따로 센다(결측을 0 으로 더하지 않는다 — 모르는 법인 · 노드가 있으면 화면이 ‘n곳 모름’ 을 붙인다).
  const known = rows.filter((r) => n(r.servers) != null && n(r.ok) != null);
  const zero = rows.filter((r) => n(r.servers) === 0 && n(r.ok) == null);   // 이번 주기 대상이 없던 법인(사실 0 — 모름이 아니다)
  const servers = known.reduce((a, r) => a + r.servers, 0); const okN = known.reduce((a, r) => a + r.ok, 0);
  const visibleNodes = nodes.filter((x) => x.node);
  const sumKnown = (f) => { const v = visibleNodes.map(f).filter((x) => n(x) != null); return { sum: v.length ? v.reduce((a, x) => a + x, 0) : null, unknown: visibleNodes.length - v.length }; };
  const worst = visibleNodes.filter((x) => n(x.node.cyclePct) != null).sort((a, b) => b.node.cyclePct - a.node.cyclePct)[0] || null;
  const db = sumKnown((x) => n(x.node.db?.bytes)); const fr = sumKnown((x) => n(x.node.focus?.running)); const fq = sumKnown((x) => n(x.node.focus?.queued));
  const kpi = {
    corps: rows.length, servers, successPct: servers ? Math.round((okN / servers) * 1000) / 10 : null, okN,
    corpsUnknown: rows.length - known.length - zero.length,
    worstCycle: worst ? { agent: worst.agent, cyclePct: worst.node.cyclePct, cycleMs: worst.node.cycleMs, budgetMs: worst.node.budgetMs } : null,
    dbBytes: db.sum, dbUnknown: db.unknown,
    focusRunning: fr.sum, focusQueued: fq.sum, focusUnknown: Math.max(fr.unknown, fq.unknown),
    concNote: visibleNodes.length ? visibleNodes.map((x) => ({ agent: x.agent, max: x.node.conc?.max ?? null, cap: x.node.conc?.cap ?? null })) : [],
  };
  return { ok: true, at: now, staleMs, ...(minEdgeVersion ? { minEdgeVersion } : {}), nodes, rows, reasons, kpi, ...(corpsDropped ? { corpsDropped } : {}), ...(allowed ? { scoped: true, nodesOmitted: omitted } : {}) };
}

export function registerBmCollectHealth(api) {
  api.get('/tools/bm-usage/collect-health', opRole, toolsPerm, async (req, res) => {
    try { res.json(await bmCollectHealthView(req, store.get())); }
    catch (e) { res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) }); }
  });
}
