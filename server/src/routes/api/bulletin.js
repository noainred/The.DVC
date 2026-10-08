/**
 * routes/api/bulletin.js — 접속 공지(팝업)와 게시판 API(v2.722).
 *
 * 권한
 *  · 공지 조회(`GET /notices/active`·`GET /notices`): 로그인 사용자 전부(팝업은 로그인 뒤에만 부른다 — 무인증 면을 늘리지 않는다, v2.565).
 *  · 공지 작성·수정·삭제: admin + 전체 범위(공지는 전 법인 사용자에게 보인다). 감사 로그.
 *  · 게시판 조회: 로그인 사용자 전부.
 *  · 게시판 글·댓글 쓰기: admin·operator(서버 불변조건 '/api 상태변경은 requireRole(admin, operator)'). 수정·삭제는 작성자 본인 또는 관리자.
 *    상단 고정은 관리자만. 데모 계정은 authMiddleware 의 demoGuest 판정이 쓰기를 막는다(SAFE_ACTIONS 밖).
 *  · 답글(v2.723): 댓글 쓰기 본문의 `parentId`. 공감(v2.723): `POST …/like`·`POST …/comments/:cid/like` 본문 `{on:true|false}` —
 *    상태 변경이라 쓰기 권한(admin·operator)과 같다. 공감한 사람 이름 목록 전체는 응답에 싣지 않는다(개수·내 공감·앞 30명).
 * 게시판은 vCenter 축이 없는 포탈 공용 게시판이라 범위 계정도 같은 글을 본다.
 */
import { requireRole } from '../../auth/auth.js';
import { isDemoGuest } from '../../auth/demoGuest.js';
import { logAudit } from '../../audit.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { pageArgs } from '../../util/pageArgs.js';
import { clientIp } from '../../util/rateLimit.js';
import {
  activeNotices, listNotices, createNotice, updateNotice, deleteNotice,
  listPosts, getPost, createPost, updatePost, deletePost, addComment, deleteComment, setLike, LIMITS, NOTICE_LEVELS,
} from '../../bulletin/store.js';

const adminOnly = requireRole('admin');
const writers = requireRole('admin', 'operator');
const noticeFleetOnly = fullScopeOnlyWith('공지는 전 법인 사용자에게 보이므로 전체 범위(vCenter 제한 없는) 관리자만 작성·수정·삭제할 수 있습니다.');

const userOf = (req) => req.user?.username || 'anonymous';
/*
 * v2.727(감사 B-06): 데모 계정(mock)은 요청 문맥 역할이 admin 이지만 authMiddleware 의 demoGuest 판정이 쓰기를 403 으로 막는다 —
 * 그 계정에 `isAdmin:true`·`canWrite:true`·`canEdit:true` 를 주면 화면이 글쓰기·공지 편집·고정 버튼을 보이고 누르면 403 이 된다
 * (화면이 거짓말한다). 표시 플래그와 서버 판정(createPost 의 pinned·canModify)을 같은 함수로 계산한다.
 */
const isAdmin = (req) => req.user?.role === 'admin' && !isDemoGuest(req.user);
const canWrite = (req) => ['admin', 'operator'].includes(req.user?.role) && !isDemoGuest(req.user);
const ID_RE = /^[a-f0-9]{16}$/;

/** 저장소 오류(status 가 붙은 것)를 응답으로 — 그 밖은 전역 처리기로. `e.extra`(v2.727 board-full 의 bytes·max)는 그대로 싣는다. */
function fail(res, e, next) {
  if (e && Number.isInteger(e.status)) return res.status(e.status).json({ ok: false, reason: e.message, ...(e.field ? { field: e.field } : {}), ...(e.extra && typeof e.extra === 'object' ? e.extra : {}) });
  return next(e);
}
const badId = (res) => res.status(404).json({ ok: false, reason: '없는 항목입니다' });
const audit = (req, action, target, detail = '') => logAudit({ user: userOf(req), action, target, detail, ip: clientIp(req) });

export function registerBulletin(api) {
  /* 공지 */
  api.get('/notices/active', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, notices: activeNotices() });
  });
  api.get('/notices', (req, res) => {
    res.json({ ok: true, notices: listNotices(), limits: LIMITS, levels: NOTICE_LEVELS, canEdit: isAdmin(req) });
  });
  api.post('/notices', adminOnly, noticeFleetOnly, (req, res, next) => {
    try {
      const n = createNotice(req.body, userOf(req));
      audit(req, 'notice.create', n.id, n.title);
      res.json({ ok: true, notice: n });
    } catch (e) { fail(res, e, next); }
  });
  api.put('/notices/:id', adminOnly, noticeFleetOnly, (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    try {
      const n = updateNotice(req.params.id, req.body, userOf(req));
      audit(req, 'notice.update', n.id, n.title);
      res.json({ ok: true, notice: n });
    } catch (e) { fail(res, e, next); }
  });
  api.delete('/notices/:id', adminOnly, noticeFleetOnly, (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    try {
      const n = deleteNotice(req.params.id);
      audit(req, 'notice.delete', n.id, n.title);
      res.json({ ok: true });
    } catch (e) { fail(res, e, next); }
  });

  /* 게시판 */
  api.get('/board/posts', (req, res) => {
    const { offset, limit } = pageArgs(req.query, { def: 50, max: 200 });
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    res.json({ ok: true, ...listPosts({ q, offset, limit }), limits: LIMITS, canWrite: ['admin', 'operator'].includes(req.user?.role), isAdmin: isAdmin(req), me: userOf(req) });
  });
  api.get('/board/posts/:id', (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    try { res.json({ ok: true, post: getPost(req.params.id, userOf(req)) }); } catch (e) { fail(res, e, next); }
  });
  api.post('/board/posts', writers, (req, res, next) => {
    try {
      const p = createPost(req.body, userOf(req), { isAdmin: isAdmin(req) });
      audit(req, 'board.post.create', p.id, p.title);
      res.json({ ok: true, post: p });
    } catch (e) { fail(res, e, next); }
  });
  api.put('/board/posts/:id', writers, (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    try {
      const p = updatePost(req.params.id, req.body || {}, userOf(req), { isAdmin: isAdmin(req) });
      audit(req, 'board.post.update', p.id, p.title);
      res.json({ ok: true, post: p });
    } catch (e) { fail(res, e, next); }
  });
  api.delete('/board/posts/:id', writers, (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    try {
      const p = deletePost(req.params.id, userOf(req), { isAdmin: isAdmin(req) });
      audit(req, 'board.post.delete', p.id, `${p.title} (작성자 ${p.author})`);
      res.json({ ok: true });
    } catch (e) { fail(res, e, next); }
  });
  api.post('/board/posts/:id/comments', writers, (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    const parentId = req.body?.parentId;
    if (parentId != null && parentId !== '' && !(typeof parentId === 'string' && ID_RE.test(parentId))) {
      return res.status(400).json({ ok: false, reason: 'parentId: 댓글 id 형식이 아닙니다', field: 'parentId' });
    }
    try {
      const c = addComment(req.params.id, req.body, userOf(req));
      audit(req, c.parentId ? 'board.reply.create' : 'board.comment.create', `${req.params.id}/${c.id}`, c.parentId ? `답글 → ${c.parentId}` : '');
      res.json({ ok: true, comment: c });
    } catch (e) { fail(res, e, next); }
  });
  api.post('/board/posts/:id/like', writers, (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    try { res.json({ ok: true, ...setLike(req.params.id, null, userOf(req), req.body?.on) }); } catch (e) { fail(res, e, next); }
  });
  api.post('/board/posts/:id/comments/:cid/like', writers, (req, res, next) => {
    if (!ID_RE.test(req.params.id) || !ID_RE.test(req.params.cid)) return badId(res);
    try { res.json({ ok: true, ...setLike(req.params.id, req.params.cid, userOf(req), req.body?.on) }); } catch (e) { fail(res, e, next); }
  });
  api.delete('/board/posts/:id/comments/:cid', writers, (req, res, next) => {
    if (!ID_RE.test(req.params.id) || !ID_RE.test(req.params.cid)) return badId(res);
    try {
      const { comment: c, kept } = deleteComment(req.params.id, req.params.cid, userOf(req), { isAdmin: isAdmin(req) });
      audit(req, 'board.comment.delete', `${req.params.id}/${c.id}`, `작성자 ${c.author}${kept ? ' · 답글이 있어 자리를 남김' : ''}`);
      res.json({ ok: true, kept });
    } catch (e) { fail(res, e, next); }
  });
}
