/**
 * routes/api/bmMaint.js — 리눅스 성능 8a단계 **정비 창 · 알림 억제** API(설계 PROFILES §20 ⑲ · 아트보드 Maint).
 *
 * 경로 `/tools/bm-usage/maintenance…`(도구 키 bm-usage 그대로 — toolAccess 매핑 안). 권한 · 범위(security-api.md 8a 항목):
 *   · 읽기 = tools + 조회 범위 — 창의 법인이 조회 범위 안일 때만 보인다(귀속 없음 · 범위 밖은 범위 계정에 숨김).
 *   · 쓰기 = operator 이상 + tools · **조회 밖 404 → 쓰기 범위 밖 403**(한 함수 writeGate) · 서버 대상은 1~20대 · 한 법인(법인 간 대상 금지).
 *   · 서버 대상은 **(법인, 키) 쌍**(반증 F1): 법인을 고르면 그 법인 안에서만 키를 찾고, 고르지 않았는데 같은 키가 여러 법인에 보이면 400(ambiguous-key — 고르게 한다).
 *   · **승인 등급**: 법인 전체 · 태그 대상 · 12시간 초과 창은 설정 소유자 등급(소유자 ∧ 전체 범위 — requireSettingsOwner 와 같은 판정 isOwnerTier)만 만들고 · 고치고 · 재확인한다.
 *     12시간은 창 하나가 아니라 **같은 서버를 덮는 살아 있는 창 전부(소유자 창 · 법인 창 · 태그 창 포함)의 합**으로도 본다(store.coverNeedsOwner — 어느 24시간에서든
 *     12시간 초과: 반증 F5 · 재확인 G1) — 재확인도 같은 규칙. approvedBy(소유자 등급이 저장했다 · 비소유자가 고치면 비운다)는 **기록일 뿐 합 판정에 쓰지 않는다**(G2).
 *     고치기는 **고치기 전과 뒤 중 하나라도** 소유자 등급이 필요하면 소유자 등급(범위 관리자가 법인 창을 서버 창으로 바꿔 쥐거나, 서버 창을 법인 창으로 넓히지 못하게).
 *     억제를 **줄이는** 동작(지금 끝내기 · 지우기)은 그 법인 쓰기 범위면 된다(안전한 쪽).
 *   · 엣지 배포본(origin central)은 엣지에서 고칠 수 없다(중앙에서 고친다 — 다음 인출에 반영).
 *   · 감사 `bm-perf.maintenance`(op · id · 대상 종류 · 법인 · 서버 수 · 길이 · 범위 · 사유 앞 120자).
 *   · 미리보기(다음 5회 · DST 표지)는 서버가 계산한다 — 웹은 시간대 · 일정 계산을 복제하지 않는다.
 *   · 요청 경로 비용(반증 F6): 목록은 창마다 상태를 한 번(조각 탐색 windowStatus) · 행 사이 시간 기준 양보 · 배포 현황은 창 상태를 한 번 세고 엣지마다 다시 쓴다.
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds, inUserWriteScope } from '../../auth/scope.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { isAdminReq, maskedIdToken } from '../../auth/addressMask.js';
import { currentTargets } from '../../bmusage/poller.js';
import { strOf } from '../../util/coercionTrap.js';
import { resolvePerfTarget, bmAddressHosts, perfAddressMatcher } from './bmUsage.js';
import { isOwnerTier } from './bmOnboard.js';
import { createYielder } from '../../util/timeSlice.js';

const toolsPerm = requirePerm('tools');
const writeRole = requireRole('admin', 'operator');
const t = (v) => strOf(v, 4096).trim();
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const VC_RE = /^[A-Za-z0-9._:@-]{1,128}$/;

function deps0(deps = {}) {
  return {
    currentTargets, bmAddressHosts,
    listEdgeBmUsage: async () => (await import('../../central/bmUsageEdgePull.js')).listEdgeBmUsage(),
    store: async () => import('../../bmusage/maint/store.js'),
    judge: async () => import('../../bmusage/maint/judge.js'),
    schedule: async () => import('../../bmusage/maint/schedule.js'),
    runtime: async () => import('../../bmusage/maint/runtime.js'),
    ownerTier: (req) => isOwnerTier(req),
    // 엣지 최소 버전(안내 문구) — 릴리스 노트의 8a단계 첫 번호(숫자를 박지 않는다 · featureMinEdgeVersion 공용 함수)
    minEdgeVersion: async () => (await import('../../central/featureMinEdgeVersion.js')).stage8aMinEdgeVersion(),
    audit: logAudit,
    now: () => Date.now(),
    yielder: () => createYielder(15),   // 목록 행 사이 시간 기준 양보(시험이 횟수를 센다)
    ...deps,
  };
}
const memo = (D) => { let p = null; return { ...D, currentTargets: () => (p ||= D.currentTargets()) }; };
function errOut(res, e) {
  const st = [400, 403, 404, 409, 503].includes(e?.status) ? e.status : 500;
  return res.status(st).json({ ok: false, code: e?.code || 'error', ...(e?.field ? { field: e.field } : {}), reason: String(e?.message || e).slice(0, 300) });
}
const fail = (status, code, reason) => Object.assign(new Error(reason), { status, code });
const bodyOf = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
/** 창이 이 계정에 보이나(순수) — 법인이 조회 범위 안. */
export const maintVisible = (w, allowed) => !allowed || (!!w?.vcenterId && allowed.has(w.vcenterId));

/** 이 노드가 아는 법인(스냅샷 vCenter · 이 노드 대상 · 엣지 보관분 대상의 법인). */
async function knownCorps(snap, D) {
  const known = new Set((snap?.vcenters || []).map((v) => String(v.id)));
  for (const x of (await D.currentTargets().catch(() => ({ targets: [] }))).targets || []) if (x?.vcenterId) known.add(String(x.vcenterId));
  for (const rec of await D.listEdgeBmUsage().catch(() => [])) for (const x of rec?.snap?.targets || []) if (x?.vcenterId) known.add(String(x.vcenterId));
  return known;
}

/**
 * 쓰기 대상 해석 — **조회 밖 404 → 쓰기 범위 밖 403**(한 함수). 서버(키들 · 한 법인) · 태그(법인 + role:/app:) · 법인 전체.
 * @returns {Promise<{target:object, vcenterId:string}>}  던지면 status · code
 */
async function writeGate(req, snap, D, b) {
  const allowed = scopedVcenterIds(req.user, snap);
  const isAdmin = isAdminReq(req);
  const tg = b.target && typeof b.target === 'object' && !Array.isArray(b.target) ? b.target : {};
  const kind = String(tg.kind || '');
  if (kind === 'corp' || kind === 'tag') {
    const vc = t(b.vcenterId ?? tg.corp).slice(0, 128);
    if (!VC_RE.test(vc)) throw fail(400, 'bad-target', '법인을 고르세요.');
    if (allowed && !allowed.has(vc)) throw fail(404, 'not-found', '대상 법인을 찾지 못했습니다.');
    if (!(await knownCorps(snap, D)).has(vc)) throw fail(404, 'not-found', '대상 법인을 찾지 못했습니다.');
    if (!inUserWriteScope(req.user, snap, vc)) throw fail(403, 'forbidden', '이 법인에 쓰기 권한이 없습니다(조회 전용).');
    return { vcenterId: vc, target: kind === 'corp' ? { kind: 'corp' } : { kind: 'tag', tag: String(tg.tag ?? '').trim().toLowerCase() } };
  }
  if (kind !== 'server') throw fail(400, 'bad-target', '대상은 서버 · 태그 · 법인 중 하나입니다.');
  const keys = [...new Set((Array.isArray(tg.keys) ? tg.keys : []).map((k) => t(k)).filter(Boolean))];
  if (!keys.length || keys.length > 20) throw fail(400, 'bad-target', '대상 서버는 1~20대입니다.');
  // 서버 = (법인, 키) 쌍(반증 F1) — 법인을 골랐으면 그 법인 안에서만 찾는다(IP 키는 법인끼리 겹친다).
  const want = t(b.vcenterId ?? '').slice(0, 128);
  if (want && !VC_RE.test(want)) throw fail(400, 'bad-target', '법인(vCenter id) 형식이 다릅니다.');
  if (want && allowed && !allowed.has(want)) throw fail(404, 'not-found', '대상 서버를 찾지 못했습니다.');
  const found = [];
  for (const key of keys) {
    let f;
    if (want) f = await resolvePerfTarget(req, corpOnly(D, want), { allowed, isAdmin, key });
    else {
      const corps = await corpsOfKey(req, D, { allowed, isAdmin, key });
      if (corps.length > 1) throw fail(400, 'ambiguous-key', `같은 키의 서버가 ${corps.length}개 법인에 있습니다 — 법인을 고르세요.`);
      f = await resolvePerfTarget(req, corps.length === 1 ? corpOnly(D, corps[0]) : D, { allowed, isAdmin, key });
    }
    if (!f || f.denied) throw fail(404, 'not-found', '대상 서버를 찾지 못했습니다.');
    found.push(f);
  }
  const vcs = [...new Set(found.map((f) => t(f.target.vcenterId)))];
  if (vcs.length !== 1 || !vcs[0]) throw fail(400, 'cross-corp', '한 창의 서버는 한 법인이어야 합니다(법인 간 대상 금지 · 귀속 없는 서버는 대상이 될 수 없습니다).');
  if (!inUserWriteScope(req.user, snap, vcs[0])) throw fail(403, 'forbidden', '대상 서버의 법인에 쓰기 권한이 없습니다(조회 전용).');
  return { vcenterId: vcs[0], target: { kind: 'server', keys: found.map((f) => f.realKey), names: found.map((f) => String(f.target.name || f.realKey)) } };
}
/** 대상 해석을 한 법인으로 좁힌 의존성(같은 resolvePerfTarget 을 쓴다 — 가림 토큰 · 엣지 보관분 규칙 그대로). */
function corpOnly(D, vc) {
  return {
    ...D,
    currentTargets: async () => { const tg = await D.currentTargets(); return { ...tg, targets: (tg?.targets || []).filter((x) => t(x?.vcenterId) === vc) }; },
    listEdgeBmUsage: async () => (await D.listEdgeBmUsage()).map((rec) => (rec?.snap ? { ...rec, snap: { ...rec.snap, targets: (rec.snap.targets || []).filter((x) => t(x?.vcenterId) === vc) } } : rec)),
  };
}
/** 이 계정에 보이는 법인 중 그 키(또는 가림 토큰)의 서버가 있는 법인들. */
async function corpsOfKey(req, D, { allowed, isAdmin, key }) {
  const corps = new Set();
  for (const x of (await D.currentTargets().catch(() => ({ targets: [] }))).targets || []) if (t(x?.vcenterId)) corps.add(t(x.vcenterId));
  for (const rec of await D.listEdgeBmUsage().catch(() => [])) for (const x of rec?.snap?.targets || []) if (t(x?.vcenterId)) corps.add(t(x.vcenterId));
  const out = [];
  for (const vc of [...corps].sort()) {
    if (allowed && !allowed.has(vc)) continue;
    const f = await resolvePerfTarget(req, corpOnly(D, vc), { allowed, isAdmin, key }).catch(() => null);
    if (f && !f.denied) out.push(vc);
  }
  return out;
}
/**
 * 소유자 등급 게이트(순수 판정은 store.needsOwnerTier · store.coverNeedsOwner — 화면 문구도 같은 값). 소유자 등급이면 통과(합 계산을 하지 않는다).
 * @param {Array} wins  창 하나 규칙을 볼 창들(고치기는 전 · 후) · combined = 합 규칙을 볼 후보(서버 창)
 */
async function ownerGate(req, D, wins, { combined = null, now = Date.now() } = {}) {
  if (await D.ownerTier(req)) return;
  const ST = await D.store();
  if (wins.some((w) => w && ST.needsOwnerTier(w))) throw fail(403, 'owner-required', '법인 전체 · 태그 대상 · 12시간 넘는 창은 설정 소유자 등급(소유자 + 전체 범위)만 만들고 고칠 수 있습니다.');
  if (combined) {
    // 이 노드의 창 + 신선한 배포본(엣지 노드라면 중앙 창도 그 서버를 덮는다) · 태그 창은 수동 용도 태그로
    const dep = ST.loadDeployed(now);
    const all = [...ST.listWindows(), ...(dep && !dep.unreadable && !ST.deployedStale(dep, now) ? dep.items : [])];
    const tagsOf = await (await D.runtime()).tagsReader();
    if (ST.coverNeedsOwner(combined, all, now, { tagsOf })) {
      throw fail(403, 'owner-required', '같은 서버를 덮는 창들(설정 소유자 창 · 법인 · 태그 창 포함)의 합이 어느 24시간에서든 12시간을 넘습니다 — 설정 소유자 등급만 만들고 · 고치고 · 재확인할 수 있습니다.');
    }
  }
}
/** 기존 창 찾기 — 조회 밖 404 → 쓰기 밖 403 · 엣지 배포본은 409. */
async function existingGate(req, snap, D, id) {
  const ST = await D.store();
  const w = ST.getWindow(t(id).slice(0, 48));
  const allowed = scopedVcenterIds(req.user, snap);
  if (!w || w.deleted || !maintVisible(w, allowed)) throw fail(404, 'not-found', '그 정비 창을 찾지 못했습니다.');
  if (!inUserWriteScope(req.user, snap, w.vcenterId)) throw fail(403, 'forbidden', '이 창의 법인에 쓰기 권한이 없습니다(조회 전용).');
  return w;
}
const auditOf = (op, w, extra = {}) => JSON.stringify({ op, kind: w?.target?.kind, corp: w?.vcenterId, n: w?.target?.keys?.length || (w?.target?.kind === 'server' ? 0 : null),
  ...(w?.target?.tag ? { tag: w.target.tag } : {}), sched: w?.schedule?.kind, scopes: Object.keys(w?.scopes || {}), reason: String(w?.reason || '').slice(0, 120), ...extra }).slice(0, 300);

/** GET /tools/bm-usage/maintenance — 목록(상태 · 다음 발생 · 억제 계수 · 배포 현황). */
export async function bmMaintList(req, snap, deps = {}) {
  const D = memo(deps0(deps));
  const allowed = scopedVcenterIds(req.user, snap);
  const isAdmin = isAdminReq(req);
  const now = D.now();
  const ST = await D.store(); const J = await D.judge(); const S = await D.schedule(); const R = await D.runtime();
  let local;
  try { local = ST.listWindows(); } catch (e) { return { __status: e?.status || 500, ok: false, code: e?.code || 'error', reason: String(e?.message || e).slice(0, 300) }; }
  const dep = ST.loadDeployed(now);
  const all = [...local, ...(dep?.items || [])].filter((w) => maintVisible(w, allowed));
  const corp = t(req.query?.corp);
  const list = corp ? all.filter((w) => w.vcenterId === corp) : all;
  // 억제 계수 — 이 노드 + 엣지 봉투(같은 창 id 를 더한다 · 엣지가 실제로 억제한 수)
  const counts = {};
  const add = (id, c) => { const x = (counts[id] ||= { alerts: 0, after: 0, hold: 0, focus: 0, collect: 0, collectFail: 0 }); for (const k of Object.keys(x)) x[k] += Number(c?.[k]) || 0; };
  for (const [id, c] of Object.entries(R.maintStats().byWindow || {})) add(id, c);
  const edges = await D.listEdgeBmUsage().catch(() => []);
  for (const rec of edges) for (const [id, c] of Object.entries(rec?.snap?.maint?.byWindow || {})) add(id, c);
  let match = null;
  if (!isAdmin) { const tg = await D.currentTargets().catch(() => ({ targets: [] })); ({ match } = await perfAddressMatcher(D, tg)); }
  const maskName = (nm) => (isAdmin ? nm : (match && match(nm) ? maskedIdToken(nm) : String(nm).replace(IPV4_RE, (ip) => maskedIdToken(ip))));
  const owner = await D.ownerTier(req);
  const writable = (w) => w.origin !== 'central' && inUserWriteScope(req.user, snap, w.vcenterId);
  const view = (w) => {
    const st = J.windowStatus(w, now);
    const fmt = (o) => (o ? { start: o.start, end: o.end, startLocal: S.fmtLocal(w.tz, o.start), endLocal: S.fmtLocal(w.tz, o.end) } : null);
    const needOwner = ST.needsOwnerTier(w);
    return {
      id: w.id, name: w.name, reason: w.reason, vcenterId: w.vcenterId, tz: w.tz, schedule: w.schedule, scopes: Object.keys(w.scopes || {}), origin: w.origin || 'local', rev: w.rev,
      target: { kind: w.target.kind, ...(w.target.tag ? { tag: w.target.tag } : {}), count: (w.target.keys || []).length, names: (w.target.names || []).map(maskName).slice(0, 20),
        ...(w.target.kind === 'server' ? { keys: isAdmin ? w.target.keys : (w.target.keys || []).map((k) => (match && match(k) ? maskedIdToken(k) : k)) } : {}) },
      status: st.status, current: fmt(st.current), next: fmt(st.next), last: fmt(st.last), remainingMs: st.remainingMs ?? null, expiresAt: st.expiresAt ?? null,
      durationMin: ST.durationMinOf(w.schedule, w.tz), by: w.by, at: w.at, approvedBy: w.approvedBy || '', confirmedAt: w.confirmedAt ?? null,
      ...(w.endedAt != null ? { endedAt: w.endedAt, endedBy: w.endedBy || '' } : {}),
      counts: counts[w.id] || null, needOwner,
      canEdit: writable(w) && (!needOwner || owner), canEnd: writable(w) && st.status === 'active', canDelete: writable(w),
      canConfirm: writable(w) && w.schedule.kind !== 'once' && (!needOwner || owner),
      edits: (w.edits || []).slice(-5),
    };
  };
  const y = D.yielder();
  const rows0 = [];
  for (const w of list) { rows0.push(view(w)); await y(); }   // 창마다 상태 한 번 · 사이 양보(F6)
  const rows = rows0.sort((a, b) => ({ active: 0, scheduled: 1, expired: 2, ended: 3 }[a.status] ?? 4) - ({ active: 0, scheduled: 1, expired: 2, ended: 3 }[b.status] ?? 4) || (a.next?.start ?? a.last?.start ?? 0) - (b.next?.start ?? b.last?.start ?? 0));
  const s = R.maintStats();
  // 엣지 배포 현황(중앙) — 인출 기록 + 엣지 봉투의 배포본 상태
  let deploy = null;
  try {
    const DP = await import('../../bmusage/maint/deploy.js');
    deploy = allowed ? null : await DP.deployStatusView(edges, now);
  } catch { deploy = null; }
  return {
    ok: true, now, windows: rows,
    summary: { active: rows.filter((r) => r.status === 'active').length, scheduled: rows.filter((r) => r.status === 'scheduled').length, ended: rows.filter((r) => r.status === 'ended').length, expired: rows.filter((r) => r.status === 'expired').length },
    leak: s.leak, ownerTier: owner, ...(dep ? { deployed: { at: dep.at, sig: dep.sig, n: dep.items.length, ...(dep.unreadable ? { unreadable: true } : {}), stale: ST.deployedStale(dep, now) } } : {}),
    limits: { onceMaxMin: S.ONCE_MAX_MIN, recurMaxMin: S.RECUR_MAX_MIN, ownerOverMin: ST.OWNER_OVER_MIN, keysMax: ST.KEYS_MAX, confirmDays: J.RECUR_CONFIRM_DAYS, deployTtlMs: ST.DEPLOY_TTL_MS },
    scopes: J.SCOPES, defaultTz: S.DEFAULT_TZ, ...(deploy ? { deploy: { ...deploy, minEdgeVersion: await D.minEdgeVersion().catch(() => null) } } : {}), ...(isAdmin ? {} : { addressHidden: true }),
  };
}

/** POST /tools/bm-usage/maintenance/preview — 다음 5회(벽시계 · DST 표지). 형식 밖은 400. */
export async function bmMaintPreview(req, deps = {}) {
  const D = deps0(deps);
  const S = await D.schedule(); const ST = await D.store();
  const b = bodyOf(req);
  const now = D.now();
  // 일정 · 시간대 형식은 저장과 같은 정규화로 본다(대상 · 이름은 미리보기에 필요 없어 자리 값).
  const w = ST.normalizeWindow({ name: '미리보기', reason: '미리보기', target: { kind: 'corp' }, vcenterId: 'preview', tz: b.tz, schedule: b.schedule, scopes: { alerts: true } }, { strict: true, now });
  const occ = S.nextOccurrences(w.schedule, w.tz, now, 5);
  const want = w.schedule.kind === 'once' ? w.schedule.start.slice(11) : w.schedule.time;
  return {
    ok: true, tz: w.tz, durationMin: ST.durationMinOf(w.schedule, w.tz), needOwnerIfServer: ST.needsOwnerTier({ ...w, target: { kind: 'server' } }),
    next: occ.map((o) => { const sl = S.fmtLocal(w.tz, o.start); return { start: o.start, end: o.end, startLocal: sl, endLocal: S.fmtLocal(w.tz, o.end), dstShift: sl.slice(11) !== want }; }),
  };
}

/** GET /tools/bm-usage/maintenance/occurrences?key=&from=&to= — 추이 음영 · 변경 이벤트 묶음(그 서버를 덮는 창 구간). */
export async function bmMaintOccurrences(req, snap, deps = {}) {
  const D = memo(deps0(deps));
  const allowed = scopedVcenterIds(req.user, snap);
  const key = t(req.query?.key);
  if (!key) return { __status: 400, ok: false, reason: 'key 가 필요합니다.' };
  const f = await resolvePerfTarget(req, D, { allowed, isAdmin: isAdminReq(req), key });
  if (!f || f.denied) return { __status: 404, ok: false, reason: '대상 서버를 찾지 못했습니다.' };
  const now = D.now();
  let from = Number(req.query?.from); let to = Number(req.query?.to);
  if (!Number.isFinite(to)) to = now;
  if (!Number.isFinite(from)) from = to - 7 * 86_400_000;
  if (!(from < to) || to - from > 400 * 86_400_000) return { __status: 400, ok: false, reason: '기간이 잘못됐습니다(400일까지).' };
  const R = await D.runtime(); const J = await D.judge();
  const MJ = await R.maintJudge({ now });
  // 판정기와 같은 입력(이 노드의 창 + 배포본 · 수동 태그)으로 이 서버를 덮는 창을 고른다 — 판정을 다시 만들지 않는다.
  // 이 계정에 보이는 창만으로 합친다(merged 에 범위 밖 창 id 가 섞이지 않게) · 지운 창은 지운 시각까지(묘비 — 소급 소거 금지).
  const merged = MJ.cover(f.target, from, to, null, { only: (w) => maintVisible(w, allowed) });
  const ids = new Set(merged.flatMap((x) => x.ids));
  const items = [];
  for (const w of MJ.windows) {
    if (!ids.has(w.id) || !maintVisible(w, allowed)) continue;
    for (const o of J.effectiveOccurrences(w, from, to, { history: true })) items.push({ id: w.id, name: w.name, start: o.start, end: o.end, scopes: Object.keys(w.scopes || {}), ...(o.cut ? { cut: true } : {}), ...(o.deleted ? { deleted: true } : {}) });
    if (items.length >= 1_000) break;
  }
  items.sort((a, b) => a.start - b.start);
  return { ok: true, key, from, to, items, merged: merged.map((x) => ({ from: x.from, to: x.to, ids: x.ids })) };
}

async function create(req, res, D) {
  try {
    const snap = store.get();
    const b = bodyOf(req);
    const g = await writeGate(req, snap, D, b);
    const ST = await D.store();
    const input = { name: b.name, reason: b.reason, tz: b.tz, schedule: b.schedule, scopes: b.scopes, target: g.target, vcenterId: g.vcenterId };
    const now = D.now();
    const probe = ST.normalizeWindow({ ...input, id: 'mw-probe0000', by: '', at: now, confirmedAt: now }, { strict: true, now, fresh: true });
    await ownerGate(req, D, [probe], { combined: probe, now });
    const owner = !!(await D.ownerTier(req));
    const by = String(req.user?.username || '');
    const rec = await ST.addWindow(input, { by, approvedBy: owner ? by : '', now });
    D.audit({ user: by, action: 'bm-perf.maintenance', target: rec.id, ip: req.ip || '', detail: auditOf('create', rec, { durMin: ST.durationMinOf(rec.schedule, rec.tz), owner }) });
    res.json({ ok: true, id: rec.id, rev: rec.rev });
  } catch (e) { errOut(res, e); }
}
async function edit(req, res, D) {
  try {
    const snap = store.get();
    const cur = await existingGate(req, snap, D, req.params.id);
    const b = bodyOf(req);
    const ST = await D.store();
    let target = cur.target; let vcenterId = cur.vcenterId;
    if (b.target !== undefined) { const g = await writeGate(req, snap, D, { ...b, vcenterId: b.vcenterId ?? cur.vcenterId }); target = g.target; vcenterId = g.vcenterId; }
    const now = D.now();
    const next = ST.normalizeWindow({ ...cur, ...(b.name !== undefined ? { name: b.name } : {}), ...(b.reason !== undefined ? { reason: b.reason } : {}), ...(b.tz !== undefined ? { tz: b.tz } : {}),
      ...(b.schedule !== undefined ? { schedule: b.schedule } : {}), ...(b.scopes !== undefined ? { scopes: b.scopes } : {}), target, vcenterId }, { strict: true, now, fresh: b.schedule !== undefined });
    // 합 규칙은 덮임이 바뀌는 고치기(대상 · 시간대 · 일정 · 범위)에만 — 이름 · 사유만 고치는 것은 억제를 늘리지 않는다(창 하나 규칙은 그대로).
    const coverChanged = ['target', 'tz', 'schedule', 'scopes'].some((k) => JSON.stringify(next[k]) !== JSON.stringify(cur[k]));
    await ownerGate(req, D, [cur, next], { combined: coverChanged ? { ...next, id: cur.id, confirmedAt: now } : null, now });
    const owner = !!(await D.ownerTier(req));
    const by = String(req.user?.username || '');
    const rec = await ST.editWindow(cur.id, { name: next.name, reason: next.reason, tz: next.tz, schedule: next.schedule, scopes: next.scopes, target: next.target, vcenterId: next.vcenterId },
      { by, approvedBy: owner ? by : '', rev: b.rev ?? null, now });
    D.audit({ user: by, action: 'bm-perf.maintenance', target: rec.id, ip: req.ip || '', detail: auditOf('edit', rec, { fields: rec.edits?.at(-1)?.fields || [] }) });
    res.json({ ok: true, id: rec.id, rev: rec.rev });
  } catch (e) { errOut(res, e); }
}
async function change(req, res, D, op) {
  try {
    const snap = store.get();
    const cur = await existingGate(req, snap, D, req.params.id);
    const ST = await D.store();
    const b = bodyOf(req);
    const by = String(req.user?.username || '');
    const now = D.now();
    if (op === 'confirm') await ownerGate(req, D, [cur], { combined: { ...cur, confirmedAt: now }, now });   // 재확인은 억제를 늘린다 — 만들 때와 같은 등급(합 규칙 포함)
    const fn = { end: ST.endWindowNow, confirm: ST.confirmWindow, delete: ST.deleteWindow }[op];
    const rec = await fn(cur.id, { by, rev: b.rev ?? req.query?.rev ?? null, now });
    D.audit({ user: by, action: 'bm-perf.maintenance', target: cur.id, ip: req.ip || '', detail: auditOf(op, cur) });
    res.json({ ok: true, id: rec.id, rev: rec.rev });
  } catch (e) { errOut(res, e); }
}

export function registerBmMaint(api, deps = {}) {
  const D = () => memo(deps0(deps));
  api.get('/tools/bm-usage/maintenance', toolsPerm, async (req, res) => {
    try { const r = await bmMaintList(req, store.get(), deps); if (r.__status) { const { __status, ...rest } = r; return res.status(__status).json(rest); } res.set('Cache-Control', 'no-store'); res.json(r); }
    catch (e) { errOut(res, e); }
  });
  api.get('/tools/bm-usage/maintenance/occurrences', toolsPerm, async (req, res) => {
    try { const r = await bmMaintOccurrences(req, store.get(), deps); if (r.__status) { const { __status, ...rest } = r; return res.status(__status).json(rest); } res.json(r); }
    catch (e) { errOut(res, e); }
  });
  api.post('/tools/bm-usage/maintenance/preview', writeRole, toolsPerm, async (req, res) => {
    try { res.json(await bmMaintPreview(req, deps)); } catch (e) { errOut(res, e); }
  });
  api.post('/tools/bm-usage/maintenance', writeRole, toolsPerm, (req, res) => create(req, res, D()));
  api.put('/tools/bm-usage/maintenance/:id', writeRole, toolsPerm, (req, res) => edit(req, res, D()));
  api.post('/tools/bm-usage/maintenance/:id/end', writeRole, toolsPerm, (req, res) => change(req, res, D(), 'end'));
  api.post('/tools/bm-usage/maintenance/:id/confirm', writeRole, toolsPerm, (req, res) => change(req, res, D(), 'confirm'));
  api.delete('/tools/bm-usage/maintenance/:id', writeRole, toolsPerm, (req, res) => change(req, res, D(), 'delete'));
}
