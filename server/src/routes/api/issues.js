/**
 * routes/api/issues.js — 이슈 트래커 API(v2.864 · v2.871 법인 축 · 알림 · 자동 할당 · 요청 등록).
 *
 * 권한(게시판 v2.722 와 같은 틀 — 서버 불변조건 '/api 상태변경은 requireRole(admin, operator)'):
 *  · 조회(목록·상세·통계·메타): 로그인 사용자 전부 — **v2.871 부터 범위가 걸린다**: 범위 계정은 자기 조회 범위 법인(vCenter)의 이슈만 보고
 *    공용(법인 없음) 이슈는 보지 않는다(서버 불변조건 '귀속 없는 데이터는 범위 계정에 노출하지 않는다'). 범위는 요청 필터보다 먼저다.
 *  · 생성·수정·상태·할당·보류·댓글: admin·operator(데모 계정은 authMiddleware 의 demoGuest 판정이 막는다). 단건은 조회 밖 404 →
 *    쓰기 밖 403(writeScopedVcenterIds — 한 함수 findFor). 범위 계정의 새 이슈는 쓰기 범위 안 법인을 반드시 고른다.
 *  · **요청 등록(v2.871)**: 운영자·관리자가 아니어도 권한 키 `issues.request`(viewer 기본 보유)가 있으면 POST /issues 로 '요청' 유형만
 *    만든다(백로그 · 담당자·상태·관찰자 지정 없음 — 자동 할당이 켜져 있으면 그것만). 이 라우트만 viewer 상태변경 예외이고 그 범위는 저장소가
 *    `requestOnly` 로 좁힌다. 그 밖의 쓰기는 예전처럼 admin·operator.
 *  · 삭제(이슈)·남의 댓글 삭제: 보고자/작성자 본인 또는 **전체 범위 관리자**(v2.732 B3-06 과 같은 기준).
 *  · 담당자 후보(`people` — v2.871 감사 A3-02): **전체 범위 쓰기 계정**에게만 로컬 계정 전부 + 이슈에 보이는 이름. 범위 계정에게는 자기가
 *    볼 수 있는 이슈에 이미 나온 이름 + 자기 자신만(전 계정 이름 목록을 범위 계정에 주지 않는다). viewer 에게는 빈 목록.
 *  · 설정(`/issues/settings` — 자동 할당 · 알림 · 사람별 메일 주소): 조회·저장 모두 관리자 + 전체 범위(전 법인 공용 설정 — 메일 주소를 담는다).
 *  · 쓰기 응답의 `persist` 는 게시판 리뷰 I-05 계약 그대로.
 */
import { requireRole, listUsers } from '../../auth/auth.js';
import { isDemoGuest, isAdminDetailUser } from '../../auth/demoGuest.js';
import { userHasPermission } from '../../auth/permissions.js';
import { logAudit } from '../../audit.js';
import { pageArgs } from '../../util/pageArgs.js';
import { clientIp } from '../../util/rateLimit.js';
import { scopedVcenterIds, writeScopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import {
  listIssues, getIssue, createIssue, updateIssue, setStatus, assignIssue, bulkAssign, setBlocked, setWatch, addComment, deleteComment, deleteIssue, setProgress, activityFeed,
  issueStats, knownNames, issuesSeq, waitIssuesPersist, issuesPersist, PERSIST_WAIT_MS,
  LIMITS, STATUSES, TYPES, PRIORITIES, KEY_RE, ID_RE, RECENT_DONE_MS, KEY_PREFIX,
} from '../../issues/store.js';
import { loadIssueSettings, saveIssueSettings, issueSettingsLoadError, suggestAssignee, SETTINGS_LIMITS, NOTIFY_EVENTS } from '../../issues/settings.js';
import { issueNotifyStatus } from '../../issues/notify.js';

const writers = requireRole('admin', 'operator');
const adminOnly = requireRole('admin');
const issueSettingsFleetOnly = fullScopeOnlyWith('이슈 설정(자동 할당 · 알림 · 메일 주소)은 전 법인 공용이라 전체 범위(vCenter 제한 없는) 관리자만 보고 바꿀 수 있습니다.');
const userOf = (req) => req.user?.username || 'anonymous';
/** 관리자(데모 계정 제외) — 판정은 auth/demoGuest.js isAdminDetailUser 하나(role 직접 비교 금지 — audit2744e 스윕). */
const isAdmin = (req) => isAdminDetailUser(req.user);
const canWrite = (req) => ['admin', 'operator'].includes(req.user?.role) && !isDemoGuest(req.user);
/**
 * 요청 등록 권한(v2.871) — 쓰기 역할이 아니어도 issues.request 가 있으면. 인증을 끈 설치는 authMiddleware 가 req.user 를 대체 역할
 * (AUTH_DISABLED_ROLE)로 채우므로 같은 판정이 그대로 맞는다 — 인증 여부로 따로 가르지 않는다(가르면 대체 역할 viewer 가 요청 전용 제한을 벗어난다).
 */
const canRequest = (req) => !!req.user && !isDemoGuest(req.user) && userHasPermission(req.user, 'issues.request');
/** 관리자 권한(남의 댓글·이슈 삭제) — 관리자(데모 계정 제외) + 전체 범위(게시판 isBoardModerator 와 같은 판정). */
const isMod = (req) => isAdmin(req) && !scopedVcenterIds(req.user, store.get());
const SCOPED_MOD_NOTE = '범위 관리자는 이슈 관리 권한(다른 사람의 이슈·댓글 삭제)이 없습니다 — 전체 범위(vCenter 제한 없는) 관리자만 할 수 있습니다';

/** 이 사용자의 법인 접근(v2.871) — read/write: Set|null(제한 없음). */
function accessOf(req) {
  const snap = store.get();
  return { read: scopedVcenterIds(req.user, snap), write: writeScopedVcenterIds(req.user, snap) };
}
/** 지금 등록된 vCenter id(새 이슈의 법인 검사). 스냅샷이 아직 없으면 null(검사 생략 — 시험·첫 수집 전). */
function knownVcenters() {
  const vcs = store.get()?.vcenters;
  return Array.isArray(vcs) && vcs.length ? new Set(vcs.map((v) => v.id).filter(Boolean)) : null;
}
/** 화면의 법인 선택지 — 이 사용자가 볼 수 있는 vCenter 만(쓰기 가능 여부 표시). */
function vcenterChoices(access) {
  const out = [];
  for (const v of store.get()?.vcenters || []) {
    if (!v?.id || (access.read && !access.read.has(v.id))) continue;
    out.push({ id: v.id, name: v.name || v.id, writable: !access.write || access.write.has(v.id) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 담당자 후보가 그 법인을 볼 수 있는가(자동 할당 · 제안) — 로컬 계정이면 그 계정의 조회 범위로, 모르는 이름(AD 등)은 볼 수 있다고 본다.
 * 법인 없는(공용) 이슈는 범위 계정이 보지 못하므로 범위 계정 후보를 고르지 않는다.
 */
function candidateCanSee() {
  const snap = store.get();
  const users = new Map(listUsers().map((u) => [u.username, u]));
  return (name, vcenterId) => {
    const u = users.get(name);
    if (!u) return true;
    const read = scopedVcenterIds(u, snap);
    if (!read) return true;
    return !!vcenterId && read.has(vcenterId);
  };
}
function suggestionFor(issue) {
  const settings = loadIssueSettings();
  return suggestAssignee(issue, settings, issueStats().byAssignee, candidateCanSee());
}

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
    const reason = e.status === 403 && req && isAdmin(req) && !isMod(req) && /관리자만/.test(e.message) ? `${e.message} — ${SCOPED_MOD_NOTE}` : e.message;
    return res.status(e.status).json({ ok: false, reason, ...(e.field ? { field: e.field } : {}), ...(e.extra && typeof e.extra === 'object' ? e.extra : {}) });
  }
  return next(e);
}
const badKey = (res) => res.status(404).json({ ok: false, reason: '없는 이슈입니다' });
const audit = (req, action, target, detail = '') => logAudit({ user: userOf(req), action, target, detail, ip: clientIp(req) });
const str = (v) => (typeof v === 'string' ? v : '');

/**
 * 담당자 후보(v2.871 감사 A3-02). 전체 범위 쓰기 계정 — 로컬 계정(데모 제외) + 이슈에 보이는 이름. 범위 계정 — 볼 수 있는 이슈에 나온 이름 +
 * 자기 자신. 계정명·표시 이름만(역할·범위·OTP 여부는 싣지 않는다).
 */
function people(req, access) {
  const out = new Map();
  if (!access.read) {
    for (const u of listUsers()) if (!u.demo && u.username) out.set(u.username, { username: u.username, name: u.name || u.username });
  } else {
    const me = userOf(req);
    out.set(me, { username: me, name: req.user?.name || me });
  }
  for (const n of knownNames(access)) if (!out.has(n)) out.set(n, { username: n, name: n });
  return [...out.values()].sort((a, b) => a.username.localeCompare(b.username));
}

/** POST /issues 게이트 — 쓰기 역할 또는 요청 등록 권한. 판정 종류를 archScan 이 읽게 태그를 단다. */
const creators = (req, res, next) => {
  if (canWrite(req) || canRequest(req)) return next();
  return res.status(403).json({ error: 'forbidden', requiredRole: ['admin', 'operator'], requiredPerm: ['issues.request'] });
};
creators.gate = Object.freeze({ kind: 'perm', arg: Object.freeze(['issues.request']) });

export function registerIssues(api) {
  api.get('/issues/meta', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const write = canWrite(req);
    const access = accessOf(req);
    res.json({
      ok: true, me: userOf(req), canWrite: write, canRequest: write || canRequest(req), isMod: isMod(req), isAdmin: isAdmin(req),
      canSettings: isAdmin(req) && !access.read, scoped: !!access.read,
      limits: LIMITS, statuses: STATUSES, types: TYPES, priorities: PRIORITIES,
      keyPrefix: KEY_PREFIX, recentDoneMs: RECENT_DONE_MS, people: write ? people(req, access) : [], vcenters: vcenterChoices(access),
      components: write ? loadIssueSettings().autoAssign.components.map((c) => c.name) : [],
      persist: issuesPersist({ admin: isAdmin(req) }),
    });
  });
  api.get('/issues/stats', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, me: userOf(req), ...issueStats({ access: accessOf(req) }) });
  });
  // 담당자 제안(새 이슈 창) — 쓰기·요청 계정. 자동 할당이 꺼져 있어도 제안은 한다(근거를 함께 — 지어내지 않는다).
  api.get('/issues/suggest', (req, res) => {
    if (!(canWrite(req) || canRequest(req))) return res.status(403).json({ ok: false, reason: '이슈를 등록할 권한이 없습니다' });
    res.set('Cache-Control', 'no-store');
    const vcenterId = str(req.query.vcenterId).slice(0, 128);
    const access = accessOf(req);
    if (vcenterId && access.read && !access.read.has(vcenterId)) return res.json({ ok: true, suggestion: null, autoAssign: false });
    const s = suggestionFor({ component: str(req.query.component).slice(0, LIMITS.component), vcenterId });
    res.json({ ok: true, suggestion: s, autoAssign: loadIssueSettings().autoAssign.enabled });
  });
  api.get('/issues/settings', adminOnly, issueSettingsFleetOnly, (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 이슈 설정을 볼 수 없습니다' });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, settings: loadIssueSettings(), loadError: issueSettingsLoadError(), limits: SETTINGS_LIMITS, events: NOTIFY_EVENTS, notifyStatus: issueNotifyStatus() });
  });
  api.put('/issues/settings', adminOnly, issueSettingsFleetOnly, (req, res, next) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 이슈 설정을 바꿀 수 없습니다' });
    try {
      const s = saveIssueSettings(req.body || {});
      audit(req, 'issue.settings', 'issue-settings.json', `자동 할당 ${s.autoAssign.enabled ? '켬' : '끔'}(규칙 ${s.autoAssign.components.length} · 후보 ${s.autoAssign.pool.length}) · 알림 ${s.notify.enabled ? '켬' : '끔'}(사람 ${s.notify.people.length})`);
      res.json({ ok: true, settings: s, loadError: null, notifyStatus: issueNotifyStatus() });
    } catch (e) { fail(res, e, next); }
  });
  // 팀 활동 피드(v2.871) — 로그인 사용자 전부 · 범위 안 이슈만(요청 필터보다 먼저). 폴링하지 않는다(화면이 마운트·버튼으로).
  api.get('/issues/activity', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { limit } = pageArgs(req.query, { def: 100, max: LIMITS.activityMax });
    const since = Number(req.query.since);
    res.json({ ok: true, ...activityFeed({ access: accessOf(req), limit, since: Number.isFinite(since) && since > 0 ? since : 0 }) });
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
        vcenterId: Object.hasOwn(q, 'vcenterId') ? str(q.vcenterId).slice(0, 128) : null,
        done, offset, limit, access: accessOf(req),
      }),
      me: userOf(req), canWrite: canWrite(req), persist: issuesPersist({ admin: isAdmin(req) }),
    });
  });
  api.get('/issues/:key', (req, res, next) => {
    if (!KEY_RE.test(req.params.key)) return badKey(res);
    try { res.json({ ok: true, issue: getIssue(req.params.key, userOf(req), accessOf(req)), canWrite: canWrite(req), isMod: isMod(req), me: userOf(req) }); } catch (e) { fail(res, e, next); }
  });

  api.post('/issues', creators, async (req, res, next) => {
    try {
      const requestOnly = !canWrite(req);
      const body = req.body || {};
      const wantAuto = !str(body.assignee).trim() && loadIssueSettings().autoAssign.enabled;
      const auto = wantAuto ? suggestionFor({ component: str(body.component), vcenterId: str(body.vcenterId) }) : null;
      const x = createIssue(body, userOf(req), { access: accessOf(req), known: knownVcenters(), auto, requestOnly });
      audit(req, requestOnly ? 'issue.request' : 'issue.create', x.key, `${x.title}${x.vcenterId ? ` [${x.vcenterId}]` : ''}${x.assignee ? ` → ${x.assignee}${auto?.assignee === x.assignee ? '(자동)' : ''}` : ''}`);
      res.json({ ok: true, issue: x, requestOnly, persist: await persistView(req) });
    } catch (e) { fail(res, e, next); }
  });
  // ⚠ '/issues/:key/…' 보다 먼저 — 뒤에 두면 'bulk' 가 키로 잡혀 404 가 된다(v2.864 자체 테스트가 잡았다).
  api.post('/issues/bulk/assign', writers, async (req, res, next) => {
    try {
      const r = bulkAssign(req.body?.keys, req.body?.assignee, userOf(req), { access: accessOf(req) });
      audit(req, 'issue.bulk-assign', r.assignee || '(해제)', `${r.done}건 성공 · ${r.failed}건 실패`);
      res.json({ ok: true, ...r, persist: await persistView(req) });
    } catch (e) { fail(res, e, next); }
  });
  api.put('/issues/:key', writers, async (req, res, next) => {
    if (!KEY_RE.test(req.params.key)) return badKey(res);
    try {
      const x = updateIssue(req.params.key, req.body || {}, userOf(req), { access: accessOf(req), known: knownVcenters() });
      audit(req, 'issue.update', x.key, Object.keys(req.body || {}).filter((k) => typeof k === 'string').slice(0, 12).join(','));
      res.json({ ok: true, issue: x, persist: await persistView(req) });
    } catch (e) { fail(res, e, next, req); }
  });
  api.post('/issues/:key/status', writers, async (req, res, next) => {
    if (!KEY_RE.test(req.params.key)) return badKey(res);
    try {
      const x = setStatus(req.params.key, req.body?.status, userOf(req), { access: accessOf(req) });
      audit(req, 'issue.status', x.key, x.status);
      res.json({ ok: true, issue: x, persist: await persistView(req) });
    } catch (e) { fail(res, e, next, req); }
  });
  // 진행률·진행 메모(v2.871) — 쓰기 계정 · 쓰기 범위.
  api.post('/issues/:key/progress', writers, async (req, res, next) => {
    if (!KEY_RE.test(req.params.key)) return badKey(res);
    try {
      const x = setProgress(req.params.key, req.body || {}, userOf(req), { access: accessOf(req) });
      audit(req, 'issue.progress', x.key, `${x.progress == null ? '보고 없음' : `${x.progress}%`}${x.progressNote ? ` · ${x.progressNote.slice(0, 80)}` : ''}`);
      res.json({ ok: true, issue: x, persist: await persistView(req) });
    } catch (e) { fail(res, e, next, req); }
  });
  api.post('/issues/:key/assign', writers, async (req, res, next) => {
    if (!KEY_RE.test(req.params.key)) return badKey(res);
    try {
      const x = assignIssue(req.params.key, req.body?.assignee, userOf(req), { reason: str(req.body?.reason), access: accessOf(req) });
      audit(req, 'issue.assign', x.key, x.assignee ? `→ ${x.assignee}` : '할당 해제');
      res.json({ ok: true, issue: x, persist: await persistView(req) });
    } catch (e) { fail(res, e, next, req); }
  });
  api.post('/issues/:key/block', writers, async (req, res, next) => {
    if (!KEY_RE.test(req.params.key)) return badKey(res);
    try {
      const x = setBlocked(req.params.key, req.body?.on, userOf(req), { reason: str(req.body?.reason), access: accessOf(req) });
      audit(req, 'issue.block', x.key, x.blocked ? `보류: ${x.blocked.reason}` : '보류 해제');
      res.json({ ok: true, issue: x, persist: await persistView(req) });
    } catch (e) { fail(res, e, next, req); }
  });
  // 관찰은 본인 상태만 바꾼다 — 저장 결과를 기다리지 않는다(연타 묶음).
  api.post('/issues/:key/watch', writers, async (req, res, next) => {
    if (!KEY_RE.test(req.params.key)) return badKey(res);
    try { const x = setWatch(req.params.key, userOf(req), req.body?.on, { access: accessOf(req) }); res.json({ ok: true, issue: x, persist: await persistView(req, { wait: false }) }); } catch (e) { fail(res, e, next); }
  });
  api.post('/issues/:key/comments', writers, async (req, res, next) => {
    if (!KEY_RE.test(req.params.key)) return badKey(res);
    try {
      const c = addComment(req.params.key, req.body, userOf(req), { access: accessOf(req) });
      audit(req, 'issue.comment.create', `${req.params.key}/${c.id}`);
      res.json({ ok: true, comment: c, persist: await persistView(req) });
    } catch (e) { fail(res, e, next, req); }
  });
  api.delete('/issues/:key/comments/:cid', writers, async (req, res, next) => {
    if (!KEY_RE.test(req.params.key) || !ID_RE.test(req.params.cid)) return badKey(res);
    try {
      const c = deleteComment(req.params.key, req.params.cid, userOf(req), { isMod: isMod(req), access: accessOf(req) });
      audit(req, 'issue.comment.delete', `${req.params.key}/${c.id}`, `작성자 ${c.author}`);
      res.json({ ok: true, persist: await persistView(req) });
    } catch (e) { fail(res, e, next, req); }
  });
  api.delete('/issues/:key', writers, async (req, res, next) => {
    if (!KEY_RE.test(req.params.key)) return badKey(res);
    try {
      const x = deleteIssue(req.params.key, userOf(req), { isMod: isMod(req), access: accessOf(req) });
      audit(req, 'issue.delete', x.key, `${x.title} (보고자 ${x.reporter})`);
      res.json({ ok: true, persist: await persistView(req) });
    } catch (e) { fail(res, e, next, req); }
  });
}
