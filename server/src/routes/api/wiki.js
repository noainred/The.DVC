/**
 * routes/api/wiki.js — 위키 API(v2.881 · 시안 docs/design/wiki-issues).
 *
 * 권한(이슈 트래커와 같은 틀):
 *  · 조회(대문 · 트리 · 문서 · 판 · 비교 · 찾기 · 역참조): 로그인 사용자 전부 — 범위가 걸린다. 범위 계정은 자기 조회 범위 법인 스페이스만 보고
 *    공용 스페이스는 보지 않는다(서버 불변조건 '귀속 없는 데이터는 범위 계정에 노출하지 않는다'). 범위는 요청 필터보다 먼저.
 *  · 쓰기(만들기 · 저장 · 되돌리기 · 지우기): admin · operator(데모 계정 제외). 단건은 조회 밖 404 → 쓰기 밖 403(저장소 findFor 하나).
 *  · 댓글 · 지켜보기: 쓰기 역할 또는 권한 키 `issues.request`(이슈 요청 등록과 같은 키 — viewer 기본 보유). 그 밖의 viewer 는 읽기만.
 *  · 지우기 · 남의 댓글 지우기: 만든 사람(쓴 사람) 또는 **전체 범위** 관리자.
 *  · 스페이스 설정(대문 글 · 공지 · 바로 가기 · 읽기 전용): 관리자 + 그 스페이스의 쓰기 범위(공용은 전체 범위만 — 저장소가 판정).
 *  · 쓰기 응답의 `persist` 는 이슈 · 게시판과 같은 계약(saved · pending · failed).
 */
import { requireRole } from '../../auth/auth.js';
import { isDemoGuest, isAdminDetailUser } from '../../auth/demoGuest.js';
import { userHasPermission } from '../../auth/permissions.js';
import { logAudit } from '../../audit.js';
import { clientIp } from '../../util/rateLimit.js';
import { scopedVcenterIds, writeScopedVcenterIds, isFullReadWriteScope } from '../../auth/scope.js';
import { store } from '../../store.js';
import {
  listSpaces, spaceView, updateSpace, tree, getPage, createPage, updatePage, revertPage, versionBody, diffVersions, deletePage,
  addComment, deleteComment, setWatch, searchPages, backrefs, homeOf, toggleTask, wikiSeq, waitWikiPersist, wikiPersist, PERSIST_WAIT_MS,
  TEMPLATES, STATUSES, LIMITS, PUB, metasFor, resolveComment, getComment, pageParticipants, setCommentIssue,
  listTrash, restorePage, purgeTrashItem, purgeExpiredTrash, TRASH_DAYS, backlinks, brokenLinks, movePage, editComment,
} from '../../wiki/store.js';
import { listCustomTemplates, getCustomTemplate, saveCustomTemplate, deleteCustomTemplate, customTemplatesLoadError, TEMPLATE_LIMITS } from '../../wiki/templates.js';
import { removeOwnerAfterPersist } from '../../attach/store.js';
import { writeScopedVcenterIds as writeScopeOf } from '../../auth/scope.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { recordView, setFavorite, userLists, isFavorite, viewCounts, forgetPage, USER_LIMITS } from '../../wiki/userState.js';
import { listUsers } from '../../auth/auth.js';
import { createIssue, findByOrigin, knownNames, mentionsOf, addLink, issueStats, issuesSeq, waitIssuesPersist } from '../../issues/store.js';
import { issueViewers } from '../../issues/visibility.js';
import { resolveMentions } from '../../issues/notify.js';
import { loadIssueSettings, suggestAssignee, emailOf } from '../../issues/settings.js';
import { mentionCandidates } from '../../issues/mentionables.js';
import { planCommentIssue, vcenterOfSpace } from '../../issues/fromComment.js';

const writers = requireRole('admin', 'operator');
// v2.889 관리자 템플릿 — 전 법인 공용(모든 스페이스의 '새 문서') · 관리자 + 전체 범위 + 쓰기 범위 무제한
const templateFleetOnly = fullScopeOnlyWith('관리자 템플릿은 모든 스페이스에 보이는 전 법인 공용 설정이라 전체 범위(vCenter 제한 없는) 관리자만 바꿉니다.');
function templateFullWrite(req, res, next) {
  let w = null;
  try { w = writeScopeOf(req.user, store.get()); } catch { w = new Set(); }
  if (w) return res.status(403).json({ ok: false, error: 'forbidden', reason: '관리자 템플릿은 쓰기 범위(수정 가능 vCenter)가 지정되지 않은 관리자만 바꿉니다' });
  next();
}
const adminOnly = requireRole('admin');
const userOf = (req) => req.user?.username || 'anonymous';
const isAdmin = (req) => isAdminDetailUser(req.user);
const canWrite = (req) => ['admin', 'operator'].includes(req.user?.role) && !isDemoGuest(req.user);
const canComment = (req) => canWrite(req) || (!!req.user && !isDemoGuest(req.user) && userHasPermission(req.user, 'issues.request'));
// v2.904 점검 P-1: 조회와 쓰기 둘 다 무제한일 때만(쓰기 범위 관리자는 남의 댓글을 지우거나 해결하지 못한다)
const isMod = (req) => isAdmin(req) && isFullReadWriteScope(req.user, store.get());
/** 댓글 · 지켜보기 문지기 — 쓰기 역할 또는 요청 권한. 판정 종류를 archScan 이 읽게 태그를 단다. */
const commenters = (req, res, next) => {
  if (canComment(req)) return next();
  return res.status(403).json({ error: 'forbidden', requiredRole: ['admin', 'operator'], requiredPerm: ['issues.request'] });
};
commenters.gate = Object.freeze({ kind: 'perm', arg: Object.freeze(['issues.request']) });

function accessOf(req) {
  const snap = store.get();
  return { read: scopedVcenterIds(req.user, snap), write: writeScopedVcenterIds(req.user, snap) };
}
const vcentersOf = () => (store.get()?.vcenters || []).filter((v) => v?.id).map((v) => ({ id: v.id, name: v.name || v.id }));
function knownSpaces() {
  const vcs = store.get()?.vcenters;
  return Array.isArray(vcs) && vcs.length ? new Set(vcs.map((v) => v.id).filter(Boolean)) : null;
}
async function persistView(req) {
  const seq = wikiSeq();
  const p = await waitWikiPersist(seq, { maxMs: PERSIST_WAIT_MS });
  const out = { state: p.state, seq };
  if (p.state !== 'saved' && isAdmin(req)) {
    const h = wikiPersist({ admin: true });
    if (h.lastWriteError) out.error = { code: h.lastWriteError.code, phase: h.lastWriteError.phase, message: h.lastWriteError.message };
  }
  return out;
}
/* ───── v2.907 댓글 @멘션 자동완성 · 댓글 → 이슈(시안 docs/design/wiki-mention · 사용자 '모두 적용' — 추천안 5개 그대로) ───── */
const fullWriter = (req) => canWrite(req) && isFullReadWriteScope(req.user, store.get());
/**
 * 댓글 글 → 언급한 실제 이름(가장 긴 접두). 전체 범위 쓰기 계정은 알림과 같은 해석(로컬 계정 · 메일 주소 표 · 이 문서 참여자).
 * v2.927(점검 B1-06): 그 밖의 계정은 멘션 자동완성(mentionCandidates)과 같은 후보(참여자 + 볼 수 있는 이슈에 나온 이름 + 자기)로만 푼다 —
 *   예전에는 담당자 400 문구 · 관찰자 · skipped 가 '그 이름의 계정이 있는가 · 그 법인을 보는가' 를 알려 주는 판정이 됐다(감사 A3-02 의 옆길).
 *   알림 수신 해석(notify.js queueWikiEvent)은 응답에 나오지 않으므로 그대로다.
 */
function mentionedIn(req, body, participants, access) {
  const viewers = issueViewers();
  const settings = loadIssueSettings();
  const full = fullWriter(req);
  const known = full
    ? new Set([...viewers.localNames, ...(settings.notify?.people || []).map((p) => p.username), ...participants])
    : new Set([...participants, ...knownNames(access), userOf(req)]);
  return { names: resolveMentions(mentionsOf(body), known), viewers, settings, restricted: !full };
}
/** 메일이 갈지 — 알림이 켜져 있고(메일 · 위키/할당 종류) 주소 표에 있는 사람. 주소 유무 이름은 전체 범위 쓰기 계정에게만. */
function mailOutlook(req, settings, names) {
  const n = settings.notify || {};
  const on = !!(n.enabled && n.mail !== false);
  const out = { notifyOn: on };
  if (fullWriter(req)) out.noEmail = names.filter((u) => !emailOf(settings, u));
  return out;
}
/**
 * 댓글 하나 → 이슈 1건(planCommentIssue 가 거르고 createIssue 가 저장). 같은 댓글로 만든 열린 이슈가 있으면 만들지 않고 그 키를 돌려준다 —
 * 그 이슈가 완료됐으면 새로 만들고 '관련' 으로 잇는다.
 */
function issueFromComment(req, pageId, cid, want) {
  const access = accessOf(req);
  const { page, comment } = getComment(pageId, cid, access);
  const sameOrigin = (o) => o.kind === 'wiki-comment' && o.pageId === page.id && o.commentId === comment.id;
  const open = findByOrigin(sameOrigin);
  if (open.length) return { key: open[0].key, existing: true };
  const prev = findByOrigin(sameOrigin, { openOnly: false }).sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  const { names, viewers, settings, restricted } = mentionedIn(req, comment.body, pageParticipants(pageId, access).names, access);
  const plan = planCommentIssue({ page, comment, req: want || {}, mentioned: names, canWrite: canWrite(req), canSee: viewers.canSee, restricted });
  const auto = plan.requestOnly && settings.autoAssign?.enabled ? suggestAssignee({ component: '', vcenterId: plan.body.vcenterId }, settings, issueStats().byAssignee, viewers.canSee) : null;
  const x = createIssue(plan.body, userOf(req), { access, known: knownSpaces(), auto, requestOnly: plan.requestOnly, origin: plan.origin });
  if (prev) { try { addLink(x.key, { type: 'relates', key: prev.key }, userOf(req), { access }); } catch { /* 옛 이슈를 볼 수 없거나 연결 상한 — 잇지 않는다 */ } }
  setCommentIssue(pageId, cid, x.key, { access });
  audit(req, plan.requestOnly ? 'issue.request' : 'issue.create', x.key, `위키 댓글 ${pageId}/${cid}${x.assignee ? ` → ${x.assignee}` : ''}`);
  // v2.927(점검 B1-06): 뺀 사람(그 법인을 볼 수 없는 사람)의 이름은 전체 범위 쓰기 계정에게만 — 그 밖은 수만(skippedN)
  return { key: x.key, assignee: x.assignee || '', watchers: plan.watchers, ...(restricted ? {} : { skipped: plan.skipped }), skippedN: plan.skipped.length, requestOnly: plan.requestOnly, relatedTo: prev?.key || '', ...mailOutlook(req, settings, [x.assignee, ...plan.watchers].filter(Boolean)) };
}
/** v2.907 기한이 지난 휴지통 항목을 영구히 지우고 그 첨부 · 즐겨찾기를 정리한다(목록 · 지우기 때 — 폴링하지 않는다). */
function dropExpiredTrash() {
  let gone = [];
  try { gone = purgeExpiredTrash(); } catch (e) { console.warn(`[wiki] 휴지통 정리 실패: ${String(e?.message || e).slice(0, 160)}`); return; }
  if (!gone.length) return;
  const seq = wikiSeq();
  for (const id of gone) { forgetPage(id); removeOwnerAfterPersist('wiki', id, { seq, state: 'pending', wait: waitWikiPersist }); }
}
function fail(res, e, next) {
  if (e && Number.isInteger(e.status)) return res.status(e.status).json({ ok: false, reason: e.message, ...(e.field ? { field: e.field } : {}), ...(e.extra && typeof e.extra === 'object' ? e.extra : {}) });
  return next(e);
}
const ID_RE = /^W\d{1,9}$/;
const badId = (res) => res.status(404).json({ ok: false, reason: '없는 문서입니다' });
const audit = (req, action, target, detail = '') => logAudit({ user: userOf(req), action, target, detail, ip: clientIp(req) });
const str = (v) => (typeof v === 'string' ? v : '');
const spaceOf = (req, access) => {
  const s = str(req.query.space).trim().slice(0, 128);
  if (s) return s;
  return access.read ? ([...access.read][0] || '') : PUB; // 범위 계정은 공용을 못 보므로 첫 법인
};

export function registerWiki(api) {
  api.get('/wiki/meta', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const access = accessOf(req);
    res.json({
      ok: true, me: userOf(req), canWrite: canWrite(req), canComment: canComment(req), isMod: isMod(req), isAdmin: isAdmin(req), scoped: !!access.read,
      spaces: listSpaces({ access, vcenters: vcentersOf() }), statuses: STATUSES, limits: LIMITS,
      templates: [...TEMPLATES.map((t) => ({ id: t.id, name: t.name, tag: t.tag })), ...listCustomTemplates().map((t) => ({ id: t.id, name: t.name, tag: t.tag, custom: true }))], persist: wikiPersist({ admin: isAdmin(req) }),
      canTemplates: isAdmin(req) && !access.read && !access.write, templateLimits: TEMPLATE_LIMITS, templatesLoadError: isAdmin(req) ? customTemplatesLoadError() : null,
    });
  });
  // v2.889 관리자 템플릿 목록(본문 포함 — 관리 화면) · 만들기 · 고치기 · 지우기
  api.get('/wiki/templates', adminOnly, templateFleetOnly, (req, res) => {
    res.set('Cache-Control', 'no-store');
    // v2.904 점검 P-3: 관리 목록(본문 · 만든 사람)은 관리자 판본 — 데모 계정은 형제 설정 라우트(/issues/settings · /attach/admin/usage)와 같이 403
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'forbidden', reason: '템플릿 관리는 관리자만 봅니다' });
    res.json({ ok: true, items: listCustomTemplates(), loadError: customTemplatesLoadError(), limits: TEMPLATE_LIMITS });
  });
  api.post('/wiki/templates', adminOnly, templateFleetOnly, templateFullWrite, (req, res, next) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 템플릿을 바꿀 수 없습니다' });
    try { const t = saveCustomTemplate({ ...(req.body || {}), id: '' }, userOf(req)); audit(req, 'wiki.template', t.id, `만듦: ${t.name}`); res.json({ ok: true, template: t }); } catch (e) { fail(res, e, next); }
  });
  api.put('/wiki/templates/:id', adminOnly, templateFleetOnly, templateFullWrite, (req, res, next) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 템플릿을 바꿀 수 없습니다' });
    try { const t = saveCustomTemplate({ ...(req.body || {}), id: String(req.params.id).slice(0, 20) }, userOf(req)); audit(req, 'wiki.template', t.id, `고침: ${t.name}`); res.json({ ok: true, template: t }); } catch (e) { fail(res, e, next); }
  });
  api.delete('/wiki/templates/:id', adminOnly, templateFleetOnly, templateFullWrite, (req, res, next) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 템플릿을 바꿀 수 없습니다' });
    try { const r = deleteCustomTemplate(String(req.params.id).slice(0, 20)); audit(req, 'wiki.template', r.id, '지움'); res.json({ ok: true, ...r }); } catch (e) { fail(res, e, next); }
  });
  api.get('/wiki/templates/:id', (req, res) => {
    const t = TEMPLATES.find((x) => x.id === req.params.id) || getCustomTemplate(req.params.id);
    if (!t) return res.status(404).json({ ok: false, reason: '없는 템플릿입니다' });
    res.json({ ok: true, template: t });
  });
  api.get('/wiki/home', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      const access = accessOf(req);
      const home = homeOf(spaceOf(req, access), { access, me: userOf(req), views: viewCounts() });
      // v2.888 개인화 — 즐겨찾기 · 최근 본 문서(모든 스페이스 · 지금 범위로 다시 거른다)
      const mine = userLists(userOf(req));
      const at = new Map(mine.recent.map((r) => [r.id, r.at]));
      res.json({ ok: true, ...home, mine: { fav: metasFor(mine.fav, access), recent: metasFor(mine.recent.map((r) => r.id), access, (id) => ({ viewedAt: at.get(id) })) } });
    } catch (e) { fail(res, e, next); }
  });
  api.get('/wiki/tree', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try { const access = accessOf(req); const sid = spaceOf(req, access); res.json({ ok: true, spaceId: sid, pages: tree(sid, { access }) }); } catch (e) { fail(res, e, next); }
  });
  api.get('/wiki/search', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      const q = req.query;
      res.json({ ok: true, ...searchPages({ q: str(q.q), spaceId: str(q.space).slice(0, 128), label: str(q.label).slice(0, LIMITS.label), status: STATUSES.includes(q.status) ? q.status : '', issueKey: str(q.issue), includeArchived: q.archived === '1', limit: q.limit, access: accessOf(req) }) });
    } catch (e) { fail(res, e, next); }
  });
  api.get('/wiki/backrefs', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, pages: backrefs(str(req.query.key), accessOf(req)) });
  });
  api.put('/wiki/spaces/:id', adminOnly, (req, res, next) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 스페이스 설정을 바꿀 수 없습니다' });
    try {
      const s = updateSpace(String(req.params.id).slice(0, 128), req.body || {}, userOf(req), { access: accessOf(req) });
      audit(req, 'wiki.space', s.id, Object.keys(req.body || {}).slice(0, 6).join(','));
      res.json({ ok: true, space: s });
    } catch (e) { fail(res, e, next); }
  });
  api.get('/wiki/spaces/:id', (req, res, next) => {
    try { res.json({ ok: true, space: spaceView(String(req.params.id).slice(0, 128), accessOf(req)) }); } catch (e) { fail(res, e, next); }
  });

  api.post('/wiki/pages', writers, async (req, res, next) => {
    if (!canWrite(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 문서를 만들 수 없습니다' });
    try {
      const p = createPage(req.body || {}, userOf(req), { access: accessOf(req), known: knownSpaces() });
      audit(req, 'wiki.create', p.id, `${p.title} [${p.spaceId}]`);
      res.json({ ok: true, page: p, persist: await persistView(req) });
    } catch (e) { fail(res, e, next); }
  });
  api.get('/wiki/pages/:id', (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    res.set('Cache-Control', 'no-store');
    try {
      const page = getPage(req.params.id, userOf(req), accessOf(req));
      // v2.888 최근 본 · 조회 수 — 볼 수 있음을 확인한 뒤에만(데모 계정은 함께 쓰는 계정이라 세지 않는다). ?nv=1 은 세지 않는다(저장 뒤 다시 읽기 등).
      if (!isDemoGuest(req.user) && req.query.nv !== '1') recordView(userOf(req), page.id);
      res.json({ ok: true, page: { ...page, fav: isFavorite(userOf(req), page.id) }, canWrite: canWrite(req), canComment: canComment(req), isMod: isMod(req), me: userOf(req) });
    } catch (e) { fail(res, e, next); }
  });
  api.put('/wiki/pages/:id', writers, async (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    if (!canWrite(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 문서를 고칠 수 없습니다' });
    try {
      const { linkFix, ...p } = updatePage(req.params.id, req.body || {}, userOf(req), { access: accessOf(req) });
      audit(req, 'wiki.save', p.id, `v${p.version}${linkFix?.fixed ? ` · 링크 갱신 ${linkFix.fixed}` : ''}`);
      res.json({ ok: true, page: p, ...(linkFix ? { linkFix } : {}), persist: await persistView(req) });
    } catch (e) { fail(res, e, next); }
  });
  api.post('/wiki/pages/:id/revert', writers, async (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    if (!canWrite(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 문서를 고칠 수 없습니다' });
    try {
      const p = revertPage(req.params.id, req.body?.v, userOf(req), { access: accessOf(req), note: str(req.body?.note) });
      audit(req, 'wiki.revert', p.id, `v${req.body?.v} → v${p.version}`);
      res.json({ ok: true, page: p, persist: await persistView(req) });
    } catch (e) { fail(res, e, next); }
  });
  // v2.883 체크리스트 체크 — 쓰기 역할 · 쓰기 범위 · 읽기 전용 아님(저장과 같은 판정). 판을 만들지 않는다(저장소가 지금 판 본문을 같이 고친다).
  api.post('/wiki/pages/:id/check', writers, async (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    if (!canWrite(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 문서를 고칠 수 없습니다' });
    try {
      const p = toggleTask(req.params.id, req.body || {}, userOf(req), { access: accessOf(req) });
      res.json({ ok: true, page: p, persist: await persistView(req) });
    } catch (e) { fail(res, e, next); }
  });
  api.get('/wiki/pages/:id/versions/:v', (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    try { res.json({ ok: true, version: versionBody(req.params.id, req.params.v, accessOf(req)) }); } catch (e) { fail(res, e, next); }
  });
  api.get('/wiki/pages/:id/diff', (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    try { res.json({ ok: true, ...diffVersions(req.params.id, req.query.from, req.query.to, accessOf(req)) }); } catch (e) { fail(res, e, next); }
  });
  api.delete('/wiki/pages/:id', writers, async (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    if (!canWrite(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 문서를 지울 수 없습니다' });
    try {
      // v2.907 휴지통 — 지우기는 휴지통으로(TRASH_DAYS 동안 되살릴 수 있다). 첨부 · 즐겨찾기는 영구 삭제 때 정리한다.
      const r = deletePage(req.params.id, userOf(req), { access: accessOf(req), isMod: isMod(req) });
      audit(req, 'wiki.delete', r.id, '휴지통으로');
      dropExpiredTrash();
      res.json({ ok: true, ...r, persist: await persistView(req) });
    } catch (e) { fail(res, e, next); }
  });
  /* ── v2.907 휴지통(기능 추천 2) · 링크(3) · 스페이스 이동(4) · 댓글 고치기(1) ── */
  api.get('/wiki/trash', writers, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try { dropExpiredTrash(); res.json({ ok: true, items: listTrash({ access: accessOf(req), spaceId: str(req.query.space) }), days: TRASH_DAYS, isMod: isMod(req), me: userOf(req) }); } catch (e) { fail(res, e, next); }
  });
  api.post('/wiki/trash/:id/restore', writers, async (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    if (!canWrite(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 되살릴 수 없습니다' });
    try {
      const page = restorePage(req.params.id, userOf(req), { access: accessOf(req) });
      audit(req, 'wiki.restore', page.id, page.title);
      res.json({ ok: true, page, persist: await persistView(req) });
    } catch (e) { fail(res, e, next); }
  });
  api.delete('/wiki/trash/:id', writers, async (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    if (!canWrite(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 지울 수 없습니다' });
    try {
      const r = purgeTrashItem(req.params.id, userOf(req), { access: accessOf(req), isMod: isMod(req) });
      const seq = wikiSeq();
      audit(req, 'wiki.purge', r.id, '영구 삭제');
      forgetPage(r.id); // v2.888 그 문서의 조회 수 · 즐겨찾기 · 최근 기록
      const persist = await persistView(req);
      // v2.904 점검 S-5: 첨부 본체는 삭제가 디스크에 닿은 뒤에 지운다
      removeOwnerAfterPersist('wiki', r.id, { seq, state: persist.state, wait: waitWikiPersist });
      res.json({ ok: true, ...r, persist });
    } catch (e) { fail(res, e, next); }
  });
  api.get('/wiki/pages/:id/backlinks', (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    try { res.json({ ok: true, items: backlinks(req.params.id, accessOf(req)) }); } catch (e) { fail(res, e, next); }
  });
  api.get('/wiki/broken-links', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try { res.json({ ok: true, ...brokenLinks({ access: accessOf(req), spaceId: str(req.query.space) }) }); } catch (e) { fail(res, e, next); }
  });
  api.post('/wiki/pages/:id/move', writers, async (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    if (!canWrite(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 옮길 수 없습니다' });
    try {
      const r = movePage(req.params.id, str(req.body?.spaceId), userOf(req), { access: accessOf(req), known: knownSpaces() });
      audit(req, 'wiki.move', r.id, `${r.from} → ${r.spaceId} · 문서 ${r.moved}개`);
      res.json({ ok: true, ...r, persist: await persistView(req) });
    } catch (e) { fail(res, e, next); }
  });
  api.put('/wiki/pages/:id/comments/:cid', commenters, async (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    try {
      const cm = editComment(req.params.id, String(req.params.cid).slice(0, 40), req.body || {}, userOf(req), { access: accessOf(req) });
      res.json({ ok: true, comment: cm, persist: await persistView(req) });
    } catch (e) { fail(res, e, next); }
  });
  // v2.907 멘션 후보 — 서버가 범위로 거른다(issues/mentionables.js). 댓글을 쓸 수 있는 사람만.
  api.get('/wiki/pages/:id/mentionables', commenters, (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    res.set('Cache-Control', 'no-store');
    try {
      const access = accessOf(req);
      const { spaceId, names } = pageParticipants(req.params.id, access);
      const full = fullWriter(req);
      const settings = loadIssueSettings();
      const viewers = issueViewers();
      const vc = vcenterOfSpace(spaceId);
      let users = [];
      try { users = listUsers(); } catch { users = []; }
      const r = mentionCandidates({ q: str(req.query.q), me: userOf(req), meName: req.user?.name || '', full, participants: names, knownNames: knownNames(access), users, people: full ? settings.notify?.people || [] : [], canSee: (n) => viewers.canSee(n, vc) });
      res.json({ ok: true, ...r, full, notifyOn: !!(settings.notify?.enabled && settings.notify?.mail !== false), canIssue: canWrite(req), canRequest: !canWrite(req) && canComment(req) });
    } catch (e) { fail(res, e, next); }
  });
  api.post('/wiki/pages/:id/comments', commenters, async (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    try {
      const access = accessOf(req);
      const want = req.body?.issue && typeof req.body.issue === 'object' && !Array.isArray(req.body.issue) ? req.body.issue : null;
      // v2.907 댓글 → 이슈: 저장 전에 거를 수 있는 것(담당자 = 언급한 사람 · 그 법인을 볼 수 있는가 · 유형 · 우선순위 · 제목 · 권한)을 먼저 — 400 이면 댓글도 저장하지 않는다
      if (want) {
        const pp = pageParticipants(req.params.id, access);
        const { names, viewers, restricted } = mentionedIn(req, str(req.body?.body), pp.names, access);
        planCommentIssue({ page: { id: req.params.id, title: '', spaceId: pp.spaceId }, comment: { id: '0', body: str(req.body?.body), author: userOf(req) }, req: want, mentioned: names, canWrite: canWrite(req), canSee: viewers.canSee, restricted });
      }
      const cm = addComment(req.params.id, req.body || {}, userOf(req), { access });
      let issue = null; let issueError = '';
      if (want) {
        try { issue = issueFromComment(req, req.params.id, cm.id, want); } catch (e) { issueError = String(e?.message || e).slice(0, 300); }
      }
      const persist = await persistView(req);
      const issuePersist = issue && !issue.existing ? (await waitIssuesPersist(issuesSeq(), { maxMs: PERSIST_WAIT_MS })).state : undefined;
      res.json({ ok: true, comment: { ...cm, ...(issue?.key ? { issueKey: issue.key } : {}) }, ...(want ? { issue, issueError } : {}), persist, ...(issuePersist ? { issuePersist } : {}) });
    } catch (e) { fail(res, e, next); }
  });
  // v2.907 댓글을 뒤늦게 이슈로(체크를 끄고 단 댓글 · 완료된 이슈를 다시) — 댓글을 쓴 사람 · 운영자/관리자. 같은 댓글의 열린 이슈가 있으면 그 키.
  api.post('/wiki/pages/:id/comments/:cid/issue', commenters, async (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    try {
      const cid = String(req.params.cid).slice(0, 40);
      const { comment } = getComment(req.params.id, cid, accessOf(req));
      if (!canWrite(req) && comment.author !== userOf(req)) return res.status(403).json({ ok: false, reason: '이 댓글을 쓴 사람이나 운영자 · 관리자만 이슈로 등록합니다' });
      const want = req.body && typeof req.body === 'object' ? req.body : {};
      const issue = issueFromComment(req, req.params.id, cid, want);
      res.json({ ok: true, issue, persist: await persistView(req) });
    } catch (e) { fail(res, e, next); }
  });
  // v2.889 인라인 댓글 해결 표시 — 문지기는 댓글과 같고, 쓴 사람 · 고칠 수 있는 사람 · 전체 범위 관리자만(저장소가 판정)
  api.post('/wiki/pages/:id/comments/:cid/resolve', commenters, async (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    try {
      const cm = resolveComment(req.params.id, String(req.params.cid).slice(0, 40), userOf(req), req.body?.on, { access: accessOf(req), canWrite: canWrite(req), isMod: isMod(req) });
      res.json({ ok: true, comment: cm, persist: await persistView(req) });
    } catch (e) { fail(res, e, next); }
  });
  api.delete('/wiki/pages/:id/comments/:cid', commenters, async (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    try {
      const r = deleteComment(req.params.id, String(req.params.cid).slice(0, 40), userOf(req), { access: accessOf(req), isMod: isMod(req) });
      res.json({ ok: true, ...r, persist: await persistView(req) });
    } catch (e) { fail(res, e, next); }
  });
  // v2.888 즐겨찾기 — 지켜보기와 같은 문지기(쓰기 역할 또는 요청 권한). 볼 수 있는 문서만(조회 밖 404). 본인 상태만 바꾼다.
  api.post('/wiki/pages/:id/fav', commenters, (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    try {
      getPage(req.params.id, userOf(req), accessOf(req));
      res.json({ ok: true, ...setFavorite(userOf(req), req.params.id, req.body?.on !== false), max: USER_LIMITS.fav });
    } catch (e) { fail(res, e, next); }
  });
  api.post('/wiki/pages/:id/watch', commenters, (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    try { res.json({ ok: true, ...setWatch(req.params.id, userOf(req), req.body?.on !== false, { access: accessOf(req) }) }); } catch (e) { fail(res, e, next); }
  });
}
