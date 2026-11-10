/**
 * routes/api/bmCapacity.js — 리눅스 성능 8a단계 **용량 소진 예측** API(설계 PROFILES §20 ⑱ · 아트보드 Capacity).
 *
 *   GET  /tools/bm-usage/capacity        — 함대 표 · 요약(이 노드의 하루 계산 결과 + 엣지 봉투의 결과 — 다시 계산하지 않는다)
 *   GET  /tools/bm-usage/capacity/:key   — 서버 상세(일 계열 · 14일 맞춤선 · 정비 창 제외 날짜 — 이 노드 서버는 그때 계산 · 엣지 서버는 엣지 대행)
 *   POST /tools/bm-usage/capacity/recompute — 이 노드 다시 계산(운영자 이상 · 진행 중이면 공유 · 감사)
 * 권한 · 범위: tools + 조회 범위(행의 법인 — 귀속 없음은 범위 계정에 숨김 · 상세는 형제 라우트와 같은 resolvePerfTarget — 범위 밖 · 없는 키 404) ·
 *   비관리자에게는 서버 이름 중 주소(등록부 · IPv4)를 가린다(형제 라우트와 같은 판정기).
 * ⚠ ‘못 읽음’ 은 0 이 아니다: 데이터 부족 · 불안정 · 상한 없음 · 계산 결과 없음(엣지 구버전 · 아직 계산 전 · 손상)을 각각 센다 — ‘예측 없음 = 안전’ 으로 보이지 않게.
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { config } from '../../config.js';
import { isAdminReq, maskedIdToken } from '../../auth/addressMask.js';
import { currentTargets } from '../../bmusage/poller.js';
import { strOf } from '../../util/coercionTrap.js';
import { resolvePerfTarget, perfTargetFail, perfVcOf, bmAddressHosts, perfAddressMatcher } from './bmUsage.js';

const toolsPerm = requirePerm('tools');
const writeRole = requireRole('admin', 'operator');
const t = (v) => strOf(v, 4096).trim();
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;

function deps0(deps = {}) {
  return {
    currentTargets, bmAddressHosts,
    listEdgeBmUsage: async () => (await import('../../central/bmUsageEdgePull.js')).listEdgeBmUsage(),
    capacity: async () => import('../../bmusage/capacity.js'),
    rules: async () => (await import('../../bmusage/perfRules.js')).loadPerfRules(),
    pullEdgeCapacity: async (agent, key) => (await import('../../central/bmCapacityPull.js')).pullEdgeCapacity(agent, key),
    maintJudge: async (now) => (await import('../../bmusage/maint/runtime.js')).maintJudge({ now }),
    minEdgeVersion: async () => (await import('../../central/featureMinEdgeVersion.js')).stage8aMinEdgeVersion(),
    audit: logAudit,
    now: () => Date.now(),
    ...deps,
  };
}
const memo = (D) => { let p = null; return { ...D, currentTargets: () => (p ||= D.currentTargets()) }; };
const SORT = { reached: 0, forecast: 1, unstable: 2, 'no-growth': 3, insufficient: 4, 'no-limit': 5 };

/** 함대 표(순수에 가까움 — 입력 주입). */
export async function bmCapacityFleet(req, snap, deps = {}) {
  const D = memo(deps0(deps));
  const allowed = scopedVcenterIds(req.user, snap);
  const isAdmin = isAdminReq(req);
  const C = await D.capacity();
  const rules = await D.rules().catch(() => ({}));
  const now = D.now();
  const sources = []; const rows = [];
  const local = C.loadCapacity();
  const tg = await D.currentTargets().catch(() => ({ targets: [] }));
  const localNames = new Map((tg.targets || []).map((x) => [x.key, x]));
  sources.push({ node: config.agent?.name || '', via: 'local', at: local?.at ?? null, day: local?.day ?? null, ...(local?.unreadable ? { unreadable: true } : {}), ...(local ? {} : { none: true }), ...(local?.truncated ? { truncated: true } : {}), ...(local?.cap ? { cap: local.cap } : {}) });
  for (const r of local?.rows || []) rows.push({ ...r, via: 'local', node: config.agent?.name || '', vcenterId: r.vcenterId || localNames.get(r.key)?.vcenterId || '' });
  for (const rec of await D.listEdgeBmUsage().catch(() => [])) {
    const sn = rec?.snap; if (!sn) continue;
    const byKey = new Map((sn.targets || []).map((x) => [t(x.key), x]));
    const cap = sn.capacity || null;
    // 구버전(표지 없음) · 아직 계산 전 · 손상을 각각 밝힌다 — 행이 없는 것을 ‘소진 없음’ 으로 보이지 않게.
    sources.push({ node: rec.agent, via: 'edge', at: cap?.at ?? null, day: cap?.day ?? null, ...(sn.capacityVer == null ? { old: true } : {}), ...(cap ? {} : { none: true }), ...(cap?.unreadable ? { unreadable: true } : {}), ...(cap?.truncated ? { truncated: cap.truncated } : {}), ...(cap?.cap ? { cap: cap.cap } : {}) });
    for (const r of cap?.rows || []) { const tgt = byKey.get(r.key); rows.push({ ...r, via: 'edge', node: rec.agent, name: String(tgt?.name || r.key), vcenterId: t(tgt?.vcenterId) }); }
  }
  const visible = rows.filter((r) => !allowed || (r.vcenterId && allowed.has(r.vcenterId)));
  let match = null;
  if (!isAdmin) ({ match } = await perfAddressMatcher(D, tg));
  const maskName = (nm) => (isAdmin ? nm : (match && match(nm) ? maskedIdToken(nm) : String(nm).replace(IPV4_RE, (ip) => maskedIdToken(ip))));
  const maskKey = (k) => (isAdmin ? k : (match && match(k) ? maskedIdToken(k) : k));
  const out = visible.map((r) => ({ ...r, key: maskKey(r.key), name: maskName(r.name || r.key) }))
    .sort((a, b) => (SORT[a.status] ?? 9) - (SORT[b.status] ?? 9) || (a.daysToTarget ?? 1e9) - (b.daysToTarget ?? 1e9) || String(a.name).localeCompare(String(b.name)));
  const days = rules.capacity?.days ?? 7;
  // 범위 계정에는 다른 법인 노드 출처를 보이지 않는다(노드 이름만 — 행이 보이는 노드만).
  const shownNodes = new Set(out.map((r) => r.node));
  return {
    ok: true, now, rows: out.slice(0, 20_000), truncated: out.length > 20_000, summary: C.summarize(visible, { soonDays: days, monthDays: 30 }),
    sources: allowed ? sources.filter((s) => shownNodes.has(s.node)) : sources, cfg: { ...C.CAP_DEFAULTS, targetPct: rules.capacity?.targetPct ?? C.CAP_DEFAULTS.targetPct, minDays: rules.capacity?.minDays ?? C.CAP_DEFAULTS.minDays, alertDays: days, recomputeAfterMin: C.RECOMPUTE_AFTER_MIN },
    minEdgeVersion: await D.minEdgeVersion().catch(() => null), ...(isAdmin ? {} : { addressHidden: true }),
  };
}

/** 서버 상세. */
export async function bmCapacityDetail(req, snap, deps = {}) {
  const D = memo(deps0(deps));
  const allowed = scopedVcenterIds(req.user, snap);
  const key = t(req.params?.key);
  const f = await resolvePerfTarget(req, D, { allowed, isAdmin: isAdminReq(req), key, vcenterId: perfVcOf(req) });   // 다음 점검 ①: (법인, 키) 쌍
  const bad = perfTargetFail(f);
  if (bad) return bad;
  const rules = await D.rules().catch(() => ({}));
  const cfg = { targetPct: rules.capacity?.targetPct, minDays: rules.capacity?.minDays };
  if (f.via === 'edge') {
    const r = await D.pullEdgeCapacity(f.agent, f.realKey);
    if (!r.ok) return { ok: false, key, via: 'edge', agent: f.agent, kind: r.kind || 'error', reason: r.reason || '엣지에서 용량 예측을 읽지 못했습니다.' };
    return { ...r.body, key, via: 'edge', agent: f.agent };
  }
  const C = await D.capacity();
  const now = D.now();
  const judge = await D.maintJudge(now).catch(() => null);
  const r = await C.computeServer({ agent: f.agent, target: f.target, now, cfg, judge, series: true });
  return { ...r, key, via: 'local' };
}

export function registerBmCapacity(api, deps = {}) {
  const send = (res, r) => { if (r?.__status) { const { __status, ...rest } = r; return res.status(__status).json(rest); } res.json(r); };
  const err = (res, e) => res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
  api.get('/tools/bm-usage/capacity', toolsPerm, async (req, res) => { try { send(res, await bmCapacityFleet(req, store.get(), deps)); } catch (e) { err(res, e); } });
  api.get('/tools/bm-usage/capacity/:key', toolsPerm, async (req, res) => { try { send(res, await bmCapacityDetail(req, store.get(), deps)); } catch (e) { err(res, e); } });
  api.post('/tools/bm-usage/capacity/recompute', writeRole, toolsPerm, async (req, res) => {
    try {
      // 전 법인 대상 계산이라 전체 범위만(범위 계정이 다른 법인 계산을 일으키지 않게 — fullScopeOnly 와 같은 판단).
      if (scopedVcenterIds(req.user, store.get())) return res.status(403).json({ ok: false, code: 'full-scope-only', reason: '다시 계산은 전체 범위(vCenter 제한 없는) 계정만 할 수 있습니다.' });
      const C = await deps0(deps).capacity();
      const r = await C.recomputeCapacity({ force: true });
      logAudit({ user: req.user?.username, action: 'bm-perf.capacity.recompute', target: config.agent?.name || 'local', ip: req.ip || '', detail: JSON.stringify({ ok: !!r.ok, rows: r.rows ?? null }).slice(0, 200) });
      res.json(r);
    } catch (e) { err(res, e); }
  });
}
