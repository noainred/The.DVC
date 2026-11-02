/**
 * routes/api/issues.js — 이슈 트래커 API(v2.863). 등록·할당·상태·댓글·이력·통계.
 *
 * 권한(게시판 v2.722 와 같은 틀 — 서버 불변조건 '/api 상태변경은 requireRole(admin, operator)'):
 *  · 조회(목록·상세·통계·메타): 로그인 사용자 전부. 이슈는 vCenter 축이 없는 포탈 공용 데이터라 범위 계정도 같은 목록을 본다.
 *  · 생성·수정·상태·할당·보류·댓글·관찰: admin·operator(데모 계정은 authMiddleware 의 demoGuest 판정이 막는다 — SAFE_ACTIONS 밖).
 *    협업 도구라 쓰기 계정은 **남의 이슈도** 고친다(담당자 변경이 핵심 동작이다). viewer 는 조회만 — 요청자 등록은 권한 매트릭스 결정이
 *    필요해 1차에 넣지 않았다(기획 '2차').
 *  · 삭제(이슈)·남의 댓글 삭제: 보고자/작성자 본인 또는 **전체 범위 관리자**(v2.732 B3-06 과 같은 기준 — 범위 관리자는 관리자가 아니다).
 *  · 담당자 후보(`people`): 쓰기 계정에게만 — 로컬 계정명(데모 계정 제외)과 이슈에 이미 보이는 이름. viewer 에게는 빈 목록(계정 열거 단서를
 *    늘리지 않는다 — 고를 수도 없다).
 *  · 쓰기 응답의 `persist` 는 게시판 리뷰 I-05 계약 그대로 — 변경은 메모리에 반영됐고(수용됨) 디스크 저장은 상한 안에서 기다려 상태를 싣는다.
 *    저장 실패는 5xx 가 아니라 200 + `persist.state:'failed'`(되돌리지 않는다 — 자동 재시도·다음 변경이 이어서 쓴다).
 */
import { requireRole, listUsers } from '../../auth/auth.js';
import { isDemoGuest } from '../../auth/demoGuest.js';
import { logAudit } from '../../audit.js';
import { pageArgs } from '../../util/pageArgs.js';
import { clientIp } from '../../util/rateLimit.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import {
  listIssues, getIssue, createIssue, updateIssue, setStatus, assignIssue, bulkAssign, setBlocked, setWatch, addComment, deleteComment, deleteIssue,
  issueStats, knownNames, issuesSeq, waitIssuesPersist, issuesPersist, PERSIST_WAIT_MS,
  LIMITS, STATUSES, TYPES, PRIORITIES, KEY_RE, ID_RE, RECENT_DONE_MS, KEY_PREFIX,
} from '../../issues/store.js';

const writers = requireRole('admin', 'operator');
const userOf = (req) => req.user?.username || 'anonymous';
const isAdmin = (req) => req.user?.role === 'admin' && !isDemoGuest(req.user);
const canWrite = (req) => ['admin', 'operator'].includes(req.user?.role) && !isDemoGuest(req.user);
/** 관리자 권한(남의 댓글·이슈 삭제) — 관리자(데모 계정 제외) + 전체 범위(게시판 isBoardModerator 와 같은 판정). */
const isMod = (req) => isAdmin(req) && !scopedVcenterIds(req.user, store.get());
const SCOPED_MOD_NOTE = '범위 관리자는 이슈 관리 권한(다른 사람의 이슈·댓글 삭제)이 없습니다 — 전체 범위(vCenter 제한 없는) 관리자만 할 수 있습니다';

async function persistView(req, { wait = true } = {}) {
  const seq = issuesSeq();
  const p = wait ? await waitIssuesPersist(seq, { maxMs: PERSIST_WAIT_MS }) : { state: issuesPersist().state, seq };
  const out = { state: p.state, seq };
  if (p.state !== 'saved' && isAdmin(req)) {
    const h = issuesPersist({ admin: true });
    if (h.lastWriteError) out.error = { code: h.lastWriteError.code, phase: h.lastWriteError.phase, message: h.lastWriteError.message };
  }
  return out;
}

/** 저장소 오류(status 가 붙은 것)를 응답으로 — 그 밖은 전역 처리기로. `e.extra`(issues-full 의 bytes·max)는 그대로 싣는다. */
function fail(res, e, next, req = null) {
  if (e && Number.isInteger(e.status)) {
    const reason = e.status === 403 && req && isAdmin(req) && !isMod(req) ? `${e.message} — ${SCOPED_MOD_NOTE}` : e.message;
    return res.status(e.status).json({ ok: false, reason, ...(e.field ? { field: e.field } : {}), ...(e.extra && typeof e.extra === 'object' ? e.extra : {}) });
  }
  return next(e);
}
const badKey = (res) => res.status(404).json({ ok: false, reason: '없는 이슈입니다' });
const audit = (req, action, target, detail = '') => logAudit({ user: userOf(req), action, target, detail, ip: clientIp(req) });
const str = (v) => (typeof v === 'string' ? v : '');

/** 담당자 후보 — 로컬 계정(데모 계정 제외: 할당받을 사람이 아니다) + 이슈에 이미 보이는 이름. 계정명·표시 이름만(역할·범위·OTP 여부는 싣지 않는다). */
function people() {
  const out = new Map();
  for (const u of listUsers()) if (!u.demo && u.username) out.set(u.username, { username: u.username, name: u.name || u.username });
  for (const n of knownNames()) if (!out.has(n)) out.set(n, { username: n, name: n });
  return [...out.values()].sort((a, b) => a.username.localeCompare(b.username));
}

export function registerIssues(api) {
  api.get('/issues/meta', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const write = canWrite(req);
    res.json({
      ok: true, me: userOf(req), canWrite: write, isMod: isMod(req), limits: LIMITS, statuses: STATUSES, types: TYPES, priorities: PRIORITIES,
      keyPrefix: KEY_PREFIX, recentDoneMs: RECENT_DONE_MS, people: write ? people() : [], persist: issuesPersist({ admin: isAdmin(req) }),
    });
  });
  api.get('/issues/stats', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, me: userOf(req), ...issueStats() });
  });
  api.get('/issues', (req, res) => {
    const { offset, limit } = pageArgs(req.query, { def: 500, max: LIMITS.issueMax });
    const done = ['open', 'recent', 'all'].includes(req.query.done) ? req.query.done : 'open';
    const q = req.query;
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      ...listIssues({
        q: str(q.q), status: STATUSES.includes(q.status) ? q.status : '', assignee: Object.hasOwn(q, 'assignee') ? str(q.assignee) : null,
        priority: PRIORITIES.includes(q.priority) ? q.priority : '', type: TYPES.includes(q.type) ? q.type : '', label: str(q.label).slice(0, LIMITS.label),
        done, offset, limit,
      }),
      me: userOf(req), canWrite: canWrite(req), persist: issuesPersist({ admin: isAdmin(req) }),
    });
  });
  api.get('/issues/:key', (req, res, next) => {
    if (!KEY_RE.test(req.params.key)) return badKey(res);
    try { res.json({ ok: true, issue: getIssue(req.params.key, userOf(req)), canWrite: canWrite(req), isMod: isMod(req), me: userOf(req) }); } catch (e) { fail(res, e, next); }
  });

  // ⚠ '/issues/:key/…' 보다 먼저 — 뒤에 두면 'bulk' 가 키로 잡혀 404 가 된다(v2.863 자체 테스트가 잡았다).
  api.post('/issues/bulk/assign', writers, async (req, res, next) => {
    try {
      const r = bulkAssign(req.body?.keys, req.body?.assignee, userOf(req));
      audit(req, 'issue.bulk-assign', r.assignee || '(해제)', `${r.done}건 성공 · ${r.failed}건 실패`);
      res.json({ ok: true, ...r, persist: await persistView(req) });
    } catch (e) { fail(res, e, next); }
  });
  api.post('/issues', writers, async (req, res, next) => {
    try {
      const x = createIssue(req.body, userOf(req));
      audit(req, 'issue.create', x.key, `${x.title}${x.assignee ? ` → ${x.assignee}` : ''}`);
      res.json({ ok: true, issue: x, persist: await persistView(req) });
    } catch (e) { fail(res, e, next); }
  });
  api.put('/issues/:key', writers, async (req, res, next) => {
    if (!KEY_RE.test(req.params.key)) return badKey(res);
    try {
      const x = updateIssue(req.params.key, req.body || {}, userOf(req));
      audit(req, 'issue.update', x.key, Object.keys(req.body || {}).filter((k) => typeof k === 'string').slice(0, 12).join(','));
      res.json({ ok: true, issue: x, persist: await persistView(req) });
    } catch (e) { fail(res, e, next); }
  });
  api.post('/issues/:key/status', writers, async (req, res, next) => {
    if (!KEY_RE.test(req.params.key)) return badKey(res);
    try {
      const x = setStatus(req.params.key, req.body?.status, userOf(req));
      audit(req, 'issue.status', x.key, x.status);
      res.json({ ok: true, issue: x, persist: await persistView(req) });
    } catch (e) { fail(res, e, next); }
  });
  api.post('/issues/:key/assign', writers, async (req, res, next) => {
    if (!KEY_RE.test(req.params.key)) return badKey(res);
    try {
      const x = assignIssue(req.params.key, req.body?.assignee, userOf(req), { reason: str(req.body?.reason) });
      audit(req, 'issue.assign', x.key, x.assignee ? `→ ${x.assignee}` : '할당 해제');
      res.json({ ok: true, issue: x, persist: await persistView(req) });
    } catch (e) { fail(res, e, next); }
  });
  api.post('/issues/:key/block', writers, async (req, res, next) => {
    if (!KEY_RE.test(req.params.key)) return badKey(res);
    try {
      const x = setBlocked(req.params.key, req.body?.on, userOf(req), { reason: str(req.body?.reason) });
      audit(req, 'issue.block', x.key, x.blocked ? `보류: ${x.blocked.reason}` : '보류 해제');
      res.json({ ok: true, issue: x, persist: await persistView(req) });
    } catch (e) { fail(res, e, next); }
  });
  // 관찰은 본인 상태만 바꾼다 — 저장 결과를 기다리지 않는다(연타 묶음).
  api.post('/issues/:key/watch', writers, async (req, res, next) => {
    if (!KEY_RE.test(req.params.key)) return badKey(res);
    try { const x = setWatch(req.params.key, userOf(req), req.body?.on); res.json({ ok: true, issue: x, persist: await persistView(req, { wait: false }) }); } catch (e) { fail(res, e, next); }
  });
  api.post('/issues/:key/comments', writers, async (req, res, next) => {
    if (!KEY_RE.test(req.params.key)) return badKey(res);
    try {
      const c = addComment(req.params.key, req.body, userOf(req));
      audit(req, 'issue.comment.create', `${req.params.key}/${c.id}`);
      res.json({ ok: true, comment: c, persist: await persistView(req) });
    } catch (e) { fail(res, e, next); }
  });
  api.delete('/issues/:key/comments/:cid', writers, async (req, res, next) => {
    if (!KEY_RE.test(req.params.key) || !ID_RE.test(req.params.cid)) return badKey(res);
    try {
      const c = deleteComment(req.params.key, req.params.cid, userOf(req), { isMod: isMod(req) });
      audit(req, 'issue.comment.delete', `${req.params.key}/${c.id}`, `작성자 ${c.author}`);
      res.json({ ok: true, persist: await persistView(req) });
    } catch (e) { fail(res, e, next, req); }
  });
  api.delete('/issues/:key', writers, async (req, res, next) => {
    if (!KEY_RE.test(req.params.key)) return badKey(res);
    try {
      const x = deleteIssue(req.params.key, userOf(req), { isMod: isMod(req) });
      audit(req, 'issue.delete', x.key, `${x.title} (보고자 ${x.reporter})`);
      res.json({ ok: true, persist: await persistView(req) });
    } catch (e) { fail(res, e, next, req); }
  });
}
