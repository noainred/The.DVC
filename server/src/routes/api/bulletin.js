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
 *
 * 리뷰 I-05(그룹 D) — '수용됨' 과 '저장 완료' 의 계약:
 *  · 쓰기 응답의 `persist` = 이 변경의 디스크 저장 상태 `{ state: 'saved'|'pending'|'failed', seq }`. 변경은 응답 시점에 이미 메모리에
 *    반영돼 다른 사용자에게 보인다(수용됨). 디스크 저장 실패는 5xx 가 아니라 200 + `persist.state:'failed'` 다 — 되돌리지 않고 자동
 *    재시도·관리자 재시도가 이어서 쓴다. 글·댓글 작성·수정·삭제와 공지는 저장 결과를 **상한(PERSIST_WAIT_MS) 안에서 기다려** 싣고,
 *    공감은 기다리지 않는다(연타 묶음). 관리자(데모 계정 제외)에게만 `persist.error`(사유 코드·단계·짧은 문구)를 싣는다.
 *  · `GET /board/persist`: 로그인 사용자 전부 — 두 저장소(게시판·공지)의 상태·미저장 시작 시각·자동 재시도 여부. 관리자에게만 상세
 *    (미저장 변경 수·사유 코드·마지막 저장 완료 시각·다음 재시도 시각·시도 횟수). 범위 관리자도 상세를 본다 — 포탈 공용 저장소 하나의 상태이고
 *    법인 축 데이터·파일 경로·내용·계정명이 없다. 화면이 '저장 대기/실패' 경고를 저장될 때까지 유지하는 데 쓴다.
 *  · `POST /board/persist/retry`: 관리자 + 전체 범위 — '지금 다시 저장'(backoff 초기화 후 즉시 다시 쓰고 결과를 기다린다). 감사 로그.
 *    전 법인 공용 저장소에 대한 운영 동작이라 범위 관리자는 403(공지 쓰기와 같은 기준). 데모 계정은 authMiddleware 가 막는다.
 */
import { requireRole } from '../../auth/auth.js';
import { isDemoGuest } from '../../auth/demoGuest.js';
import { logAudit } from '../../audit.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { pageArgs } from '../../util/pageArgs.js';
import { clientIp } from '../../util/rateLimit.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import {
  activeNotices, listNotices, createNotice, updateNotice, deleteNotice,
  listPosts, getPost, createPost, updatePost, deletePost, addComment, deleteComment, setLike, LIMITS, NOTICE_LEVELS,
  bulletinSeq, bulletinPersistOf, waitBulletinPersist, bulletinHealth, retryBulletinWrites, PERSIST_WAIT_MS,
} from '../../bulletin/store.js';

const adminOnly = requireRole('admin');
const writers = requireRole('admin', 'operator');
const noticeFleetOnly = fullScopeOnlyWith('공지는 전 법인 사용자에게 보이므로 전체 범위(vCenter 제한 없는) 관리자만 작성·수정·삭제할 수 있습니다.');
const fullScopeOnly = fullScopeOnlyWith('게시판·공지 저장소는 전 법인 공용이라 전체 범위(vCenter 제한 없는) 관리자만 다시 저장을 실행할 수 있습니다.');

const userOf = (req) => req.user?.username || 'anonymous';
/*
 * v2.727(감사 B-06): 데모 계정(mock)은 요청 문맥 역할이 admin 이지만 authMiddleware 의 demoGuest 판정이 쓰기를 403 으로 막는다 —
 * 그 계정에 `isAdmin:true`·`canWrite:true`·`canEdit:true` 를 주면 화면이 글쓰기·공지 편집·고정 버튼을 보이고 누르면 403 이 된다
 * (화면이 거짓말한다). 표시 플래그와 서버 판정(createPost 의 pinned·canModify)을 같은 함수로 계산한다.
 */
const isAdmin = (req) => req.user?.role === 'admin' && !isDemoGuest(req.user);
const canWrite = (req) => ['admin', 'operator'].includes(req.user?.role) && !isDemoGuest(req.user);
const ID_RE = /^[a-f0-9]{16}$/;
/** '지금 다시 저장' 을 누를 수 있는가 — 관리자(데모 계정 제외) + 전체 범위(라우트 게이트와 같은 판정). */
const canRetryPersist = (req) => isAdmin(req) && !scopedVcenterIds(req.user, store.get());

/**
 * 리뷰 I-05 — 쓰기 직후의 저장 상태. 저장소 쓰기는 동기라 호출 직후의 순번이 곧 이 변경의 순번이다.
 * wait=true 면 묶음 창을 앞당겨 실제 디스크 결과를 상한 안에서 기다린다. 사유 코드는 관리자에게만.
 */
async function persistView(req, kind, { wait = true } = {}) {
  const seq = bulletinSeq(kind);
  const p = wait ? await waitBulletinPersist(kind, seq, { maxMs: PERSIST_WAIT_MS }) : bulletinPersistOf(kind, seq);
  const out = { state: p.state, seq };
  if (p.state !== 'saved' && isAdmin(req)) {
    const h = bulletinHealth({ admin: true })[kind];
    if (h?.lastWriteError) out.error = { code: h.lastWriteError.code, phase: h.lastWriteError.phase, message: h.lastWriteError.message };
  }
  return out;
}

/** 저장소 오류(status 가 붙은 것)를 응답으로 — 그 밖은 전역 처리기로. `e.extra`(v2.727 board-full 의 bytes·max)는 그대로 싣는다. */
function fail(res, e, next) {
  if (e && Number.isInteger(e.status)) return res.status(e.status).json({ ok: false, reason: e.message, ...(e.field ? { field: e.field } : {}), ...(e.extra && typeof e.extra === 'object' ? e.extra : {}) });
  return next(e);
}
const badId = (res) => res.status(404).json({ ok: false, reason: '없는 항목입니다' });
const audit = (req, action, target, detail = '') => logAudit({ user: userOf(req), action, target, detail, ip: clientIp(req) });

export function registerBulletin(api) {
  /* 공지 */
  // v2.727(감사 B-04): 게시자·작성자·수정자 계정명(by·createdBy·updatedBy)은 admin 에게만 — 공지 작성자는 정의상 전체 범위
  //   관리자라 모든 로그인 사용자(데모 계정 포함)에게 주면 관리자 계정 열거 단서가 된다. 목록 자체는 예전처럼 로그인 사용자 전부
  //   (게시판 › 공지 탭이 모든 사용자에게 보인다 — adminOnly 로 바꾸면 그 화면이 403 이 된다).
  api.get('/notices/active', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, notices: activeNotices(Date.now(), { by: isAdmin(req) }) });
  });
  api.get('/notices', (req, res) => {
    const admin = isAdmin(req);
    res.json({ ok: true, notices: listNotices({ by: admin }), limits: LIMITS, levels: NOTICE_LEVELS, canEdit: admin, persist: bulletinHealth({ admin }).notices });
  });
  api.post('/notices', adminOnly, noticeFleetOnly, async (req, res, next) => {
    try {
      const n = createNotice(req.body, userOf(req));
      audit(req, 'notice.create', n.id, n.title);
      res.json({ ok: true, notice: n, persist: await persistView(req, 'notices') });
    } catch (e) { fail(res, e, next); }
  });
  api.put('/notices/:id', adminOnly, noticeFleetOnly, async (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    try {
      const n = updateNotice(req.params.id, req.body, userOf(req));
      audit(req, 'notice.update', n.id, n.title);
      res.json({ ok: true, notice: n, persist: await persistView(req, 'notices') });
    } catch (e) { fail(res, e, next); }
  });
  api.delete('/notices/:id', adminOnly, noticeFleetOnly, async (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    try {
      const n = deleteNotice(req.params.id);
      audit(req, 'notice.delete', n.id, n.title);
      res.json({ ok: true, persist: await persistView(req, 'notices') });
    } catch (e) { fail(res, e, next); }
  });

  /* 게시판 */
  api.get('/board/posts', (req, res) => {
    const { offset, limit } = pageArgs(req.query, { def: 50, max: 200 });
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    res.json({ ok: true, ...listPosts({ q, offset, limit }), limits: LIMITS, canWrite: canWrite(req), isAdmin: isAdmin(req), me: userOf(req), persist: bulletinHealth({ admin: isAdmin(req) }).board });
  });
  api.get('/board/posts/:id', (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    try { res.json({ ok: true, post: getPost(req.params.id, userOf(req)) }); } catch (e) { fail(res, e, next); }
  });
  api.post('/board/posts', writers, async (req, res, next) => {
    try {
      const p = createPost(req.body, userOf(req), { isAdmin: isAdmin(req) });
      audit(req, 'board.post.create', p.id, p.title);
      res.json({ ok: true, post: p, persist: await persistView(req, 'board') });
    } catch (e) { fail(res, e, next); }
  });
  api.put('/board/posts/:id', writers, async (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    try {
      const p = updatePost(req.params.id, req.body || {}, userOf(req), { isAdmin: isAdmin(req) });
      audit(req, 'board.post.update', p.id, p.title);
      res.json({ ok: true, post: p, persist: await persistView(req, 'board') });
    } catch (e) { fail(res, e, next); }
  });
  api.delete('/board/posts/:id', writers, async (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    try {
      const p = deletePost(req.params.id, userOf(req), { isAdmin: isAdmin(req) });
      audit(req, 'board.post.delete', p.id, `${p.title} (작성자 ${p.author})`);
      res.json({ ok: true, persist: await persistView(req, 'board') });
    } catch (e) { fail(res, e, next); }
  });
  api.post('/board/posts/:id/comments', writers, async (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    const parentId = req.body?.parentId;
    if (parentId != null && parentId !== '' && !(typeof parentId === 'string' && ID_RE.test(parentId))) {
      return res.status(400).json({ ok: false, reason: 'parentId: 댓글 id 형식이 아닙니다', field: 'parentId' });
    }
    try {
      const c = addComment(req.params.id, req.body, userOf(req));
      audit(req, c.parentId ? 'board.reply.create' : 'board.comment.create', `${req.params.id}/${c.id}`, c.parentId ? `답글 → ${c.parentId}` : '');
      res.json({ ok: true, comment: c, persist: await persistView(req, 'board') });
    } catch (e) { fail(res, e, next); }
  });
  // 공감은 저장 결과를 기다리지 않는다(연타를 한 번의 쓰기로 묶는 것이 v2.727 의 목적이다) — 상태만 싣는다.
  api.post('/board/posts/:id/like', writers, async (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return badId(res);
    try { const r = setLike(req.params.id, null, userOf(req), req.body?.on); res.json({ ok: true, ...r, persist: await persistView(req, 'board', { wait: false }) }); } catch (e) { fail(res, e, next); }
  });
  api.post('/board/posts/:id/comments/:cid/like', writers, async (req, res, next) => {
    if (!ID_RE.test(req.params.id) || !ID_RE.test(req.params.cid)) return badId(res);
    try { const r = setLike(req.params.id, req.params.cid, userOf(req), req.body?.on); res.json({ ok: true, ...r, persist: await persistView(req, 'board', { wait: false }) }); } catch (e) { fail(res, e, next); }
  });
  api.delete('/board/posts/:id/comments/:cid', writers, async (req, res, next) => {
    if (!ID_RE.test(req.params.id) || !ID_RE.test(req.params.cid)) return badId(res);
    try {
      const { comment: c, kept } = deleteComment(req.params.id, req.params.cid, userOf(req), { isAdmin: isAdmin(req) });
      audit(req, 'board.comment.delete', `${req.params.id}/${c.id}`, `작성자 ${c.author}${kept ? ' · 답글이 있어 자리를 남김' : ''}`);
      res.json({ ok: true, kept, persist: await persistView(req, 'board') });
    } catch (e) { fail(res, e, next); }
  });

  /* 저장 상태(리뷰 I-05) */
  api.get('/board/persist', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const admin = isAdmin(req);
    res.json({ ok: true, admin, canRetry: canRetryPersist(req), stores: bulletinHealth({ admin }) });
  });
  api.post('/board/persist/retry', adminOnly, fullScopeOnly, async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'forbidden', reason: '데모 계정은 다시 저장을 실행할 수 없습니다.' });
    const result = await retryBulletinWrites({ maxMs: PERSIST_WAIT_MS });
    const tried = result.filter((r) => r.attempted);
    audit(req, 'bulletin.persist.retry', tried.map((r) => r.kind).join(',') || '-', tried.map((r) => `${r.kind}=${r.state}${r.code ? `(${r.code})` : ''}`).join(' ') || '미저장 변경 없음');
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, result, stores: bulletinHealth({ admin: true }), canRetry: true });
  });
}
