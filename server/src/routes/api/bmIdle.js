/**
 * routes/api/bmIdle.js — 리눅스 성능 8b단계 **저활용 서버 찾기** API(설계 PROFILES §20 ㉑ · 아트보드 Idle).
 *
 *   GET  /tools/bm-usage/idle          — 함대 표 · 요약(이 노드의 하루 계산 결과 + 엣지 봉투의 결과 — 다시 계산하지 않는다) + 검토 상태(중앙 주석 저장소)
 *   POST /tools/bm-usage/idle/review   — 검토 상태(검토 중 · 반납 예정 · 유지(사유 필수) · 대기 · DR · 지우기) — 운영 주석(6단계 저장소 재사용 · auto `idle:<상태>`) · 감사
 *   POST /tools/bm-usage/idle/recompute — 이 노드 다시 계산(운영자 이상 · 전체 범위만 · 감사)
 * 권한 · 범위: tools + 조회 범위(행의 법인 — 귀속 없음은 범위 계정에 숨김) · 검토 쓰기 = 운영자 이상 + 조회 밖 404 → 쓰기 밖 403(resolvePerfTarget · inUserWriteScope —
 *   주석 라우트와 같은 판정) · 비관리자에게는 서버 이름 중 주소(등록부 · IPv4)를 가린다(형제 라우트와 같은 판정기).
 * ⚠ ‘저활용 ≠ 불필요’ — 점수는 후보 표시다. 제외(데이터 부족 · 정비 창 · 대기 · DR)는 수를 적고 숨기지 않는다 · 후보 전력 합은 측정한 후보만(미측정 수를 함께).
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds, inUserWriteScope } from '../../auth/scope.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { config } from '../../config.js';
import { isAdminReq, maskedIdToken } from '../../auth/addressMask.js';
import { currentTargets, bmUsageStatus } from '../../bmusage/poller.js';
import { strOf } from '../../util/coercionTrap.js';
import { memoJson, scopeKey } from './shared.js';
import { resolvePerfTarget, bmAddressHosts, perfAddressMatcher } from './bmUsage.js';
import { IDLE_REVIEW } from '../../bmusage/idleConst.js';

const toolsPerm = requirePerm('tools');
const writeRole = requireRole('admin', 'operator');
const t = (v) => strOf(v, 4096).trim();
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const SORT = { candidate: 0, watch: 1, periodic: 2, active: 3, excluded: 4 };
export const REVIEW_LABEL = Object.freeze({ review: '검토 중', retire: '반납 예정', keep: '유지', dr: '대기 · DR', clear: '검토 상태 지움' });
const DAY = 86_400_000;

function deps0(deps = {}) {
  return {
    currentTargets, bmAddressHosts,
    listEdgeBmUsage: async () => (await import('../../central/bmUsageEdgePull.js')).listEdgeBmUsage(),
    idle: async () => import('../../bmusage/idle.js'),
    annotations: async () => import('../../bmusage/annotations.js'),
    minEdgeVersion: async () => (await import('../../central/featureMinEdgeVersion.js')).stage8bMinEdgeVersion(),
    audit: logAudit,
    now: () => Date.now(),
    ...deps,
  };
}
const memo = (D) => { let p = null; return { ...D, currentTargets: () => (p ||= D.currentTargets()) }; };

/**
 * 검토 상태(순수) — 주석 목록에서 서버(법인, 키)마다 가장 최근의 `idle:<상태>` 하나(지운 주석은 건너뛴다 · 마지막이 clear 면 상태 없음).
 * @returns {Map<string, {status, reason, by, at, id}>}  열쇠 `${vcenterId}|${key}`
 */
export function reviewMap(items = []) {
  const out = new Map();
  for (const a of Array.isArray(items) ? items : []) {
    if (!a || a.deleted || typeof a.auto !== 'string' || !a.auto.startsWith('idle:')) continue;
    const st = a.auto.slice(5);
    if (!IDLE_REVIEW.includes(st) || a.target?.type !== 'server') continue;
    const k = `${t(a.target.vcenterIds?.[0])}|${t(a.target.keys?.[0])}`;
    const cur = out.get(k);
    if (cur && cur.at >= Number(a.created)) continue;
    out.set(k, { status: st, reason: String(a.text || '').slice(0, 300), by: String(a.by || '').slice(0, 64), at: Number(a.created) || 0, id: a.id });
  }
  for (const [k, v] of [...out]) if (v.status === 'clear') out.delete(k);
  return out;
}

/** 함대 표. */
export async function bmIdleFleet(req, snap, deps = {}) {
  const D = memo(deps0(deps));
  const allowed = scopedVcenterIds(req.user, snap);
  const isAdmin = isAdminReq(req);
  const I = await D.idle();
  const now = D.now();
  const sources = []; const rows = [];
  const local = I.loadIdle();
  const tg = await D.currentTargets().catch(() => ({ targets: [] }));
  const localBy = new Map((tg.targets || []).map((x) => [x.key, x]));
  sources.push({ node: config.agent?.name || '', via: 'local', at: local?.at ?? null, day: local?.day ?? null, firstDay: local?.firstDay ?? null, ...(local?.unreadable ? { unreadable: true } : {}), ...(local ? {} : { none: true }) });
  for (const r of local?.rows || []) rows.push({ ...r, via: 'local', node: config.agent?.name || '', name: r.name || localBy.get(r.key)?.name || r.key, vcenterId: r.vcenterId || localBy.get(r.key)?.vcenterId || '' });
  for (const rec of await D.listEdgeBmUsage().catch(() => [])) {
    const sn = rec?.snap; if (!sn) continue;
    const byKey = new Map((sn.targets || []).map((x) => [t(x.key), x]));
    const id = sn.idle || null;
    sources.push({ node: rec.agent, via: 'edge', at: id?.at ?? null, day: id?.day ?? null, firstDay: id?.firstDay ?? null, ...(sn.idleVer == null ? { old: true } : {}), ...(id ? {} : { none: true }), ...(id?.unreadable ? { unreadable: true } : {}), ...(id?.truncated ? { truncated: id.truncated } : {}) });
    for (const r of id?.rows || []) { const tgt = byKey.get(r.key); rows.push({ ...r, via: 'edge', node: rec.agent, name: String(tgt?.name || r.key), vcenterId: t(tgt?.vcenterId) }); }
  }
  const visible0 = rows.filter((r) => !allowed || (r.vcenterId && allowed.has(r.vcenterId)));
  // 검토 상태(중앙 주석) — 못 읽으면 상태 칸을 비우고 그 사실을 밝힌다(‘검토 없음’ 으로 보이지 않게).
  let reviews = new Map(); let reviewUnreadable = false;
  try { reviews = reviewMap((await D.annotations()).listAnnotations()); } catch { reviewUnreadable = true; }
  const visible = visible0.map((r) => {
    const rv = reviews.get(`${r.vcenterId}|${r.key}`) || null;
    // ‘대기 · DR’ 은 계산이 아니라 사람이 정한 제외 — 점수는 남기고 상태만 제외(사유 dr)로.
    if (rv?.status === 'dr' && r.status !== 'excluded') return { ...r, scoredStatus: r.status, status: 'excluded', reason: 'dr', review: rv };
    return rv ? { ...r, review: rv } : r;
  });
  let match = null;
  if (!isAdmin) ({ match } = await perfAddressMatcher(D, tg));
  const maskName = (nm) => (isAdmin ? nm : (match && match(nm) ? maskedIdToken(nm) : String(nm).replace(IPV4_RE, (ip) => maskedIdToken(ip))));
  const maskKey = (k) => (isAdmin ? k : (match && match(k) ? maskedIdToken(k) : k));
  const maskBy = (r) => (r.review ? { ...r, review: { ...r.review, by: isAdmin ? r.review.by : (r.review.by ? maskedIdToken(r.review.by) : '') } } : r);
  const out = visible.map((r) => maskBy({ ...r, key: maskKey(r.key), name: maskName(r.name || r.key) }))
    .sort((a, b) => (SORT[a.status] ?? 9) - (SORT[b.status] ?? 9) || (b.score ?? -1) - (a.score ?? -1) || String(a.name).localeCompare(String(b.name)));
  const summary = I.summarizeIdle(visible);
  const cand = visible.filter((r) => r.status === 'candidate');
  summary.review = { review: 0, retire: 0, keep: 0 };
  for (const r of cand) if (r.review && summary.review[r.review.status] != null) summary.review[r.review.status] += 1;
  summary.reviewed = cand.filter((r) => r.review && ['review', 'retire', 'keep'].includes(r.review.status)).length;
  // 지난 30일 진입 · 이탈 — 행의 candSince · candLeft(수집 노드의 하루 계산이 이어 쓴다). 그 노드의 계산 이력이 30일 안 되면 ‘—’(전부 새 후보로 보이지 않게).
  const today = now;
  const oldEnough = (r) => { const s = sources.find((x) => x.node === r.node && x.via === r.via); return !!(s?.firstDay && Date.parse(`${s.firstDay}T00:00:00Z`) <= today - 30 * DAY); };
  const recent = (d) => typeof d === 'string' && Date.parse(`${d}T00:00:00Z`) >= today - 30 * DAY;
  const known = visible.length > 0 && visible.every(oldEnough);
  summary.month = known ? { joined: cand.filter((r) => recent(r.candSince)).length, left: visible.filter((r) => r.status !== 'candidate' && recent(r.candLeft)).length } : null;
  const shownNodes = new Set(out.map((r) => r.node));
  const rules = local?.cfg || null;
  return {
    ok: true, now, rows: out.slice(0, 20_000), truncated: out.length > 20_000, summary, reviewLabel: REVIEW_LABEL, ...(reviewUnreadable ? { reviewUnreadable: true } : {}),
    sources: allowed ? sources.filter((s) => shownNodes.has(s.node)) : sources, cfg: rules || (await import('../../bmusage/idle.js')).IDLE_DEFAULTS, recomputeAfterMin: I.RECOMPUTE_AFTER_MIN,
    minEdgeVersion: await D.minEdgeVersion().catch(() => null), ...(isAdmin ? {} : { addressHidden: true }),
  };
}

/** 검토 상태 쓰기 — { key, status, reason }. 반환 { status, body }. */
export async function bmIdleReview(req, deps = {}) {
  const D = memo(deps0(deps));
  const snap = store.get();
  const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const st = t(b.status);
  if (!IDLE_REVIEW.includes(st)) return { status: 400, body: { ok: false, code: 'bad-status', field: 'status', reason: `검토 상태는 ${IDLE_REVIEW.join(' · ')} 중 하나입니다.` } };
  const A = await D.annotations();
  const reason = A.cleanText(typeof b.reason === 'string' ? b.reason : '', 300);
  if (st === 'keep' && !reason) return { status: 400, body: { ok: false, code: 'bad-reason', field: 'reason', reason: '‘유지’ 는 사유가 필요합니다.' } };
  const allowed = scopedVcenterIds(req.user, snap);
  const f = await resolvePerfTarget(req, D, { allowed, isAdmin: isAdminReq(req), key: t(b.key).slice(0, 256) });
  if (!f || f.denied) return { status: 404, body: { ok: false, code: 'not-found', reason: '대상 서버를 찾지 못했습니다.' } };
  const vc = t(f.target.vcenterId);
  if (!vc) return { status: 404, body: { ok: false, code: 'not-found', reason: '대상 서버를 찾지 못했습니다.' } };
  if (!inUserWriteScope(req.user, snap, vc)) return { status: 403, body: { ok: false, code: 'forbidden', reason: '이 법인에 쓰기 권한이 없습니다(조회 전용).' } };
  try {
    const rec = A.addAnnotation({ by: req.user?.username || '', at: D.now(), kind: 'memo', auto: `idle:${st}`, text: `[저활용 검토] ${REVIEW_LABEL[st]}${reason ? ` — ${reason}` : ''}`,
      target: { type: 'server', keys: [f.realKey], names: [String(f.target.name || f.realKey)], vcenterIds: [vc] } });
    D.audit({ user: req.user?.username, action: 'bm-perf.idle.review', target: f.realKey, ip: req.ip || '', detail: JSON.stringify({ status: st, vcenterId: vc, id: rec.id, reason: reason.slice(0, 120) }).slice(0, 300) });
    return { status: 200, body: { ok: true, id: rec.id } };
  } catch (e) {
    const code = [400, 409, 503].includes(e?.status) ? e.status : 500;
    return { status: code, body: { ok: false, code: e?.code || 'error', reason: String(e?.message || e).slice(0, 300) } };
  }
}

export function registerBmIdle(api, deps = {}) {
  const key = async (req) => {
    let e = 0; try { for (const r of (await import('../../central/bmUsageEdgePull.js')).listEdgeBmUsage()) e = Math.max(e, Number(r?.snapAt) || 0); } catch { e = 0; }
    let l = 0; try { l = Number((await import('../../bmusage/idle.js')).loadIdle()?.at) || 0; } catch { l = 0; }
    let a = 0; try { a = (await import('../../bmusage/annotations.js')).listAnnotations().length; } catch { a = -1; }
    return `${scopeKey(req.user, store.get())}|${isAdminReq(req) ? 'a' : 'u'}|${bmUsageStatus().last?.at || 0}|i${l}|e${e}|n${a}`;
  };
  api.get('/tools/bm-usage/idle', toolsPerm, async (req, res) => memoJson(req, res, 'bm-idle', (snap) => bmIdleFleet(req, snap, deps), { extraKey: await key(req) }));
  api.post('/tools/bm-usage/idle/review', writeRole, toolsPerm, async (req, res) => {
    try { const r = await bmIdleReview(req, deps); res.status(r.status).json(r.body); } catch (e) { res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) }); }
  });
  api.post('/tools/bm-usage/idle/recompute', writeRole, toolsPerm, async (req, res) => {
    try {
      if (scopedVcenterIds(req.user, store.get())) return res.status(403).json({ ok: false, code: 'full-scope-only', reason: '다시 계산은 전체 범위(vCenter 제한 없는) 계정만 할 수 있습니다.' });
      const I = await deps0(deps).idle();
      const r = await I.recomputeIdle({ force: true });
      logAudit({ user: req.user?.username, action: 'bm-perf.idle.recompute', target: config.agent?.name || 'local', ip: req.ip || '', detail: JSON.stringify({ ok: !!r.ok, rows: r.rows ?? null }).slice(0, 200) });
      res.json(r);
    } catch (e) { res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) }); }
  });
}
