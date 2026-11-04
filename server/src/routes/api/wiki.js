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
import { scopedVcenterIds, writeScopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import {
  listSpaces, spaceView, updateSpace, tree, getPage, createPage, updatePage, revertPage, versionBody, diffVersions, deletePage,
  addComment, deleteComment, setWatch, searchPages, backrefs, homeOf, toggleTask, wikiSeq, waitWikiPersist, wikiPersist, PERSIST_WAIT_MS,
  TEMPLATES, STATUSES, LIMITS, PUB, metasFor, resolveComment,
} from '../../wiki/store.js';
import { listCustomTemplates, getCustomTemplate, saveCustomTemplate, deleteCustomTemplate, customTemplatesLoadError, TEMPLATE_LIMITS } from '../../wiki/templates.js';
import { removeOwner as removeAttachments } from '../../attach/store.js';
import { writeScopedVcenterIds as writeScopeOf } from '../../auth/scope.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { recordView, setFavorite, userLists, isFavorite, viewCounts, forgetPage, USER_LIMITS } from '../../wiki/userState.js';

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
const isMod = (req) => isAdmin(req) && !scopedVcenterIds(req.user, store.get());
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
      // v2.886 개인화 — 즐겨찾기 · 최근 본 문서(모든 스페이스 · 지금 범위로 다시 거른다)
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
      // v2.886 최근 본 · 조회 수 — 볼 수 있음을 확인한 뒤에만(데모 계정은 함께 쓰는 계정이라 세지 않는다). ?nv=1 은 세지 않는다(저장 뒤 다시 읽기 등).
      if (!isDemoGuest(req.user) && req.query.nv !== '1') recordView(userOf(req), page.id);
      res.json({ ok: true, page: { ...page, fav: isFavorite(userOf(req), page.id) }, canWrite: canWrite(req), canComment: canComment(req), isMod: isMod(req), me: userOf(req) });
    } catch (e) { fail(res, e, next); }
  });
  api.put('/wiki/pages/:id', writers, async (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    if (!canWrite(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 문서를 고칠 수 없습니다' });
    try {
      const p = updatePage(req.params.id, req.body || {}, userOf(req), { access: accessOf(req) });
      audit(req, 'wiki.save', p.id, `v${p.version}`);
      res.json({ ok: true, page: p, persist: await persistView(req) });
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
      const r = deletePage(req.params.id, userOf(req), { access: accessOf(req), isMod: isMod(req) });
      audit(req, 'wiki.delete', r.id);
      forgetPage(r.id); // v2.886 그 문서의 조회 수 · 즐겨찾기 · 최근 기록
      try { removeAttachments('wiki', r.id); } catch (e) { console.warn(`[wiki] ${r.id} 첨부 정리 실패: ${String(e?.message || e).slice(0, 160)}`); } // v2.889
      res.json({ ok: true, ...r, persist: await persistView(req) });
    } catch (e) { fail(res, e, next); }
  });
  api.post('/wiki/pages/:id/comments', commenters, async (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    try {
      const cm = addComment(req.params.id, req.body || {}, userOf(req), { access: accessOf(req) });
      res.json({ ok: true, comment: cm, persist: await persistView(req) });
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
  // v2.886 즐겨찾기 — 지켜보기와 같은 문지기(쓰기 역할 또는 요청 권한). 볼 수 있는 문서만(조회 밖 404). 본인 상태만 바꾼다.
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
