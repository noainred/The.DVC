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
import { requireRole, requirePerm, listUsers } from '../../auth/auth.js';
import { isDemoGuest, isAdminDetailUser } from '../../auth/demoGuest.js';
import { userHasPermission } from '../../auth/permissions.js';
import { logAudit } from '../../audit.js';
import { pageArgs } from '../../util/pageArgs.js';
import { clientIp } from '../../util/rateLimit.js';
import { scopedVcenterIds, writeScopedVcenterIds, isFullReadWriteScope } from '../../auth/scope.js';
import { store } from '../../store.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import {
  listIssues, getIssue, createIssue, updateIssue, setStatus, assignIssue, bulkAssign, setBlocked, setWatch, addComment, deleteComment, deleteIssue, setProgress, activityFeed,
  bulkEdit, moveSprintIssues, sprintBoard, queryContext, addLink, removeLink, LINK_TYPES, addWorklog, removeWorklog,
  issueStats, knownNames, issuesSeq, waitIssuesPersist, issuesPersist, PERSIST_WAIT_MS, addWatchers, mentionsOf, editComment, reportSource,
  LIMITS, STATUSES, TYPES, PRIORITIES, KEY_RE, ID_RE, RECENT_DONE_MS, KEY_PREFIX,
} from '../../issues/store.js';
import { loadIssueSettings, saveIssueSettings, issueSettingsLoadError, suggestAssignee, SETTINGS_LIMITS, NOTIFY_EVENTS } from '../../issues/settings.js';
import { issueNotifyStatus, resolveMentions } from '../../issues/notify.js';
import { mentionCandidates } from '../../issues/mentionables.js';
import { allIssueTemplates, saveIssueTemplate, deleteIssueTemplate, issueTemplatesLoadError, ISSUE_TEMPLATE_LIMITS } from '../../issues/templates.js';
import { issueViewers } from '../../issues/visibility.js';
import {
  loadAutoCreate, saveAutoCreate, autoCreateLoadError, autoCreateStatus, simulatePartFault,
  AUTO_SUPPORTED, AUTO_KINDS, AUTO_SCOPES, AUTO_LEVELS, AUTO_LIMITS, DEFAULT_TITLE_TPL,
} from '../../issues/autoCreate.js';
import { PART_KIND_LABEL, SCOPE_LABEL } from '../../partfault/types.js';
import { listCollectors } from '../../collector/registry.js';
import { listSprints, createSprint, updateSprint, closeSprint, getSprint, sprintsLoadError, SPRINT_LIMITS } from '../../issues/sprints.js';
import { listFilters, createFilter, updateFilter, deleteFilter, filtersLoadError, setSubscription, FILTER_LIMITS } from '../../issues/filters.js';
import { QUERY_LIMITS, FIELDS as QUERY_FIELDS, ORDERABLE as QUERY_ORDERABLE } from '../../issues/query.js';
import { issueDocIndex } from '../../wiki/store.js';
import { issuesCsv } from '../../issues/exportCsv.js';
import { buildIssueReport, issueReportCsv, REPORT_WEEKS } from '../../issues/report.js';
import { listInbox, markInboxRead, inboxStatus, INBOX_LIMITS } from '../../issues/inbox.js';
import { automationStatus } from '../../issues/automation.js';
import { loadAlertAuto, saveAlertAuto, alertAutoLoadError, alertIssuesStatus, ALERT_ISSUE_KINDS, ALERT_KIND_LABEL, ALERT_ISSUE_LIMITS } from '../../issues/alertIssues.js';
import { removeOwnerAfterPersist } from '../../attach/store.js';
import { currentVersion } from '../../config.js';
import { listNotes } from '../../release-notes.js';
import { fileStamp } from '../../util/dayKey.js';

const writers = requireRole('admin', 'operator');
const adminOnly = requireRole('admin');
const issueSettingsFleetOnly = fullScopeOnlyWith('이슈 설정(자동 할당 · 알림 · 메일 주소)은 전 법인 공용이라 전체 범위(vCenter 제한 없는) 관리자만 보고 바꿀 수 있습니다.');
/** v2.882 스프린트는 전 법인 공용(공용 + 전 법인 이슈를 담는다) — 만들기 · 고치기 · 끝내기는 전체 범위 운영자 · 관리자. 이슈 넣기 · 빼기는 그 이슈의 쓰기 범위. */
const sprintFleetOnly = fullScopeOnlyWith('스프린트(이름 · 기간 · 목표 · 끝내기)는 전 법인 공용이라 전체 범위(vCenter 제한 없는) 운영자 · 관리자만 만들고 바꿀 수 있습니다 — 이슈를 넣고 빼는 것은 이슈의 쓰기 범위로 됩니다.');
/** v2.871 감사 A3-05: 전 법인 공용 쓰기 — 조회가 무제한이어도 쓰기 범위(writeVcenters)가 지정된 계정은 403(bareosManage.js fullWriteOnly 와 같은 판정). */
function fullWriteOnly(req, res, next) {
  let w = null;
  try { w = writeScopedVcenterIds(req.user, store.get()); } catch { w = new Set(); } // 판정이 던지면 거부 기본값
  if (w) return res.status(403).json({ ok: false, error: 'forbidden', reason: '이슈 설정은 전 법인 공용 쓰기라 쓰기 범위(수정 가능 vCenter)가 지정되지 않은 관리자만 바꿀 수 있습니다.' });
  next();
}
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
// v2.904 점검 P-1: 조회와 쓰기 둘 다 무제한일 때만(조회 무제한 + writeVcenters 관리자가 남의 공유 필터를 지우던 구멍)
const isMod = (req) => isAdmin(req) && isFullReadWriteScope(req.user, store.get());
const SCOPED_MOD_NOTE = '범위 관리자는 이슈 관리 권한(다른 사람의 이슈·댓글 삭제)이 없습니다 — 조회 · 쓰기 범위가 모두 지정되지 않은 전체 범위 관리자만 할 수 있습니다';

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
 * 담당자 후보가 그 법인을 볼 수 있는가(자동 할당 · 제안) — 판정은 issues/visibility.js 하나(알림 수신자 거르기와 같은 함수).
 * 로컬 계정은 그 계정의 조회 범위로, 로컬이 아닌 이름은 AD 사용자(범위 축 없음 = 전체)로 본다.
 */
function suggestionFor(issue) {
  const settings = loadIssueSettings();
  return suggestAssignee(issue, settings, issueStats().byAssignee, issueViewers().canSee);
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
  // v2.871 반증 N1: 바깥 조건은 조회·쓰기 둘 다 무제한일 때만(조회 무제한 + writeVcenters 계정을 '전체' 로 읽지 않는다 — server/CLAUDE.md v2.733 함정).
  if (!access.read && !access.write) {
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
      canSettings: isAdmin(req) && !access.read && !access.write, scoped: !!access.read, writeScoped: !!access.write,
      limits: LIMITS, statuses: STATUSES, types: TYPES, priorities: PRIORITIES,
      keyPrefix: KEY_PREFIX, recentDoneMs: RECENT_DONE_MS, people: write ? people(req, access) : [], vcenters: vcenterChoices(access),
      components: write ? loadIssueSettings().autoAssign.components.map((c) => c.name) : [],
      persist: issuesPersist({ admin: isAdmin(req) }),
      // v2.882 스프린트 · 검색식 · 저장 필터
      canSprints: write && !access.read && !access.write, linkTypes: LINK_TYPES, canShareFilters: write && !access.read && !access.write, canFilters: write,
      queryLimits: QUERY_LIMITS, queryFields: Object.keys(QUERY_FIELDS), queryOrderable: QUERY_ORDERABLE, sprintLimits: SPRINT_LIMITS, filterLimits: FILTER_LIMITS,
      // v2.888 C-3 — SLA 목표(비밀 아님 — 배지 설명) · 포탈 버전(수정 버전 '반영됨' 판정) · 최근 릴리스 버전(고르기 후보)
      sla: loadIssueSettings().sla, portalVersion: currentVersion(), knownVersions: (() => { try { return listNotes().slice(0, 15).map((n) => n.version); } catch { return []; } })(),
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
    const s = suggestionFor({ component: str(req.query.component).slice(0, LIMITS.component), vcenterId: vcenterId.trim() });
    // v2.871 감사 A3-04: 제안 이름은 이 사용자의 담당자 후보(people)에 있을 때만 싣는다 — 요청 계정·범위 계정에게 계정명을 새로 알려 주지 않는다.
    const visible = !!s && canWrite(req) && ((!access.read && !access.write) || people(req, access).some((p) => p.username === s.assignee));
    res.json({ ok: true, suggestion: visible ? s : null, ...(s && !visible ? { hidden: true } : {}), autoAssign: loadIssueSettings().autoAssign.enabled });
  });
  /* ── v2.907 이슈 템플릿(기능 추천 5) — '/issues/:key' 보다 먼저(뒤에 두면 'templates' 가 키로 잡혀 404) ── */
  api.get('/issues/templates', creators, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const canManage = isAdmin(req) && isFullReadWriteScope(req.user, store.get());
    // v2.930(점검 B1-07): 문지기는 creators(범위 운영자 · 요청 권한 viewer 포함)라 관리자 계정명(createdBy · updatedBy)은 관리할 수 있는 사람에게만
    const items = canManage ? allIssueTemplates() : allIssueTemplates().map(({ createdBy, updatedBy, ...t }) => { void createdBy; void updatedBy; return t; });
    res.json({ ok: true, items, loadError: isAdmin(req) ? issueTemplatesLoadError() : null, limits: ISSUE_TEMPLATE_LIMITS, canManage });
  });
  api.post('/issues/templates', adminOnly, issueSettingsFleetOnly, fullWriteOnly, (req, res, next) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 템플릿을 바꿀 수 없습니다' });
    try { const t = saveIssueTemplate({ ...(req.body || {}), id: '' }, userOf(req)); audit(req, 'issue.template', t.id, `만듦: ${t.name}`); res.json({ ok: true, template: t }); } catch (e) { fail(res, e, next); }
  });
  api.put('/issues/templates/:id', adminOnly, issueSettingsFleetOnly, fullWriteOnly, (req, res, next) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 템플릿을 바꿀 수 없습니다' });
    try { const t = saveIssueTemplate({ ...(req.body || {}), id: str(req.params.id).slice(0, 20) }, userOf(req)); audit(req, 'issue.template', t.id, `고침: ${t.name}`); res.json({ ok: true, template: t }); } catch (e) { fail(res, e, next); }
  });
  api.delete('/issues/templates/:id', adminOnly, issueSettingsFleetOnly, fullWriteOnly, (req, res, next) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 템플릿을 바꿀 수 없습니다' });
    try { const r = deleteIssueTemplate(str(req.params.id).slice(0, 20)); audit(req, 'issue.template', r.id, '지움'); res.json({ ok: true, ...r }); } catch (e) { fail(res, e, next); }
  });
  api.get('/issues/settings', adminOnly, issueSettingsFleetOnly, (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 이슈 설정을 볼 수 없습니다' });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, settings: loadIssueSettings(), loadError: issueSettingsLoadError(), limits: SETTINGS_LIMITS, events: NOTIFY_EVENTS, notifyStatus: issueNotifyStatus(),
      automationStatus: automationStatus(), inboxStatus: inboxStatus() }); // v2.908
  });
  api.put('/issues/settings', adminOnly, issueSettingsFleetOnly, fullWriteOnly, (req, res, next) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 이슈 설정을 바꿀 수 없습니다' });
    try {
      const s = saveIssueSettings(req.body || {});
      audit(req, 'issue.settings', 'issue-settings.json', `자동 할당 ${s.autoAssign.enabled ? '켬' : '끔'}(규칙 ${s.autoAssign.components.length} · 후보 ${s.autoAssign.pool.length}) · 알림 ${s.notify.enabled ? '켬' : '끔'}(사람 ${s.notify.people.length})`);
      res.json({ ok: true, settings: s, loadError: null, notifyStatus: issueNotifyStatus(), automationStatus: automationStatus(), inboxStatus: inboxStatus() });
    } catch (e) { fail(res, e, next); }
  });
  /* ── v2.908 다른 알람 · 백업 실패 → 이슈 자동 등록(기능 추천 10) — 파트 장애 자동 등록과 같은 문지기. '/issues/:key' 보다 먼저 ── */
  api.get('/issues/autocreate/alerts', adminOnly, issueSettingsFleetOnly, (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 이슈 설정을 볼 수 없습니다' });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, settings: loadAlertAuto(), loadError: alertAutoLoadError(), status: alertIssuesStatus(), kinds: ALERT_ISSUE_KINDS, kindLabels: ALERT_KIND_LABEL, limits: ALERT_ISSUE_LIMITS });
  });
  api.put('/issues/autocreate/alerts', adminOnly, issueSettingsFleetOnly, fullWriteOnly, (req, res, next) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 이슈 설정을 바꿀 수 없습니다' });
    try {
      const s = saveAlertAuto(req.body || {});
      audit(req, 'issue.autocreate', 'issue-alert-auto.json', `다른 알람 자동 등록 ${s.enabled ? '켬' : '끔'}(${ALERT_ISSUE_KINDS.filter((k) => s.kinds[k]).join(',') || '없음'} · ${s.delayMin}분 · 하루 상한 ${s.dailyMax})`);
      res.json({ ok: true, settings: s, loadError: null, status: alertIssuesStatus() });
    } catch (e) { fail(res, e, next); }
  });
  /* ── v2.908 포탈 알림함(기능 추천 9) — 내 것만 · 지금 범위로 다시 거른다. 읽음 표시는 이슈 · 위키 댓글을 쓸 수 있는 계정(creators) ── */
  api.get('/issues/inbox', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (isDemoGuest(req.user)) return res.json({ ok: true, items: [], unread: 0, total: 0, demo: true, limits: INBOX_LIMITS });
    const access = accessOf(req);
    // v2.930(점검 B1-05): issues/visibility.js · 이슈 canSee 와 같은 규칙 — 범위 계정은 법인 없는 줄(공용 이슈 · 공용 위키)도 보지 않는다
    //   (예전 `!vc ||` 가 먼저 참이 돼, 전체 범위였다가 좁혀진 계정이 공용 이슈 제목 · 댓글 앞부분 줄을 30일 동안 계속 봤다)
    const canSee = (vc) => !access.read || (!!vc && access.read.has(vc));
    const { limit } = pageArgs(req.query, { def: 50, max: 100 });
    const r = listInbox(userOf(req), { canSee, limit, unreadOnly: str(req.query.unread) === '1' });
    res.json({ ok: true, ...r, enabled: loadIssueSettings().inbox?.enabled !== false, limits: INBOX_LIMITS });
  });
  api.post('/issues/inbox/read', creators, (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
    res.json({ ok: true, changed: markInboxRead(userOf(req), ids) });
  });
  /* ── v2.908 리포트(기능 추천 7) — 범위 안 이슈만(재료를 만들 때 거른다) · 주 1~52 ── */
  const reportFor = (req) => {
    const access = accessOf(req);
    const names = new Map(vcenterChoices(access).map((v) => [v.id, v.name || v.id]));
    const vc = str(req.query.vcenterId).slice(0, 128);
    let rows = reportSource({ access });
    if (vc) rows = rows.filter((r) => (vc === '-' ? !r.vcenterId : r.vcenterId === vc));
    return buildIssueReport(rows, { weeks: req.query.weeks, vcName: (id) => names.get(id) || id });
  };
  api.get('/issues/report', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ...reportFor(req), weeksLimits: REPORT_WEEKS });
  });
  api.get('/issues/report.csv', requirePerm('data.csv'), (req, res) => {
    res.set('Cache-Control', 'no-store');
    const r = reportFor(req);
    audit(req, 'issue.export', 'issue-report.csv', `리포트 ${r.weeks}주`);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="issue-report-${fileStamp()}.csv"`);
    res.send(issueReportCsv(r));
  });
  // v2.880 파트 장애 → 이슈 자동 등록 설정 — 이슈 설정과 같은 문지기(관리자 + 전체 범위, 저장은 쓰기 범위도 무제한).
  //   ⚠ '/issues/:key' 보다 먼저(뒤에 두면 'autocreate' 가 키로 잡혀 404).
  api.get('/issues/autocreate', adminOnly, issueSettingsFleetOnly, (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 이슈 설정을 볼 수 없습니다' });
    res.set('Cache-Control', 'no-store');
    let agents = [];
    try { agents = listCollectors().map((c) => ({ id: String(c.id || ''), name: String(c.name || c.id || '') })).filter((c) => c.id).slice(0, 500); } catch { agents = []; }
    res.json({
      ok: true, settings: loadAutoCreate(), loadError: autoCreateLoadError(), status: autoCreateStatus(),
      supported: AUTO_SUPPORTED, kinds: AUTO_KINDS, scopes: AUTO_SCOPES, levels: AUTO_LEVELS, limits: AUTO_LIMITS, defaultTitleTpl: DEFAULT_TITLE_TPL,
      kindLabels: PART_KIND_LABEL, scopeLabels: SCOPE_LABEL, agents,
    });
  });
  api.put('/issues/autocreate', adminOnly, issueSettingsFleetOnly, fullWriteOnly, (req, res, next) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 이슈 설정을 바꿀 수 없습니다' });
    try {
      const s = saveAutoCreate(req.body || {});
      const pf = s.partfault;
      const on = Object.values(pf.matrix).reduce((n, m) => n + Object.values(m).filter((v) => v !== 'off').length, 0);
      audit(req, 'issue.autocreate', 'issue-autocreate.json', `파트 장애 자동 등록 ${pf.enabled ? '켬' : '끔'}(켜진 칸 ${on} · 하루 상한 ${pf.dailyMax} · 법인 예외 ${pf.agentsOff.length})`);
      res.json({ ok: true, settings: s, loadError: null, status: autoCreateStatus() });
    } catch (e) { fail(res, e, next); }
  });
  // 시험 실행 — 지난 N시간 파트 장애 이벤트에 (저장 전) 화면 값을 대 본다. 만들지 않는다(읽기). 화면 값이 형식 밖이면 400.
  api.post('/issues/autocreate/simulate', adminOnly, issueSettingsFleetOnly, async (req, res, next) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 이슈 설정을 볼 수 없습니다' });
    try {
      const r = await simulatePartFault({ hours: req.body?.hours, cfgOverride: req.body?.settings || null });
      res.json({ ok: true, ...r });
    } catch (e) { fail(res, e, next); }
  });
  // 팀 활동 피드(v2.871) — 로그인 사용자 전부 · 범위 안 이슈만(요청 필터보다 먼저). 폴링하지 않는다(화면이 마운트·버튼으로).
  api.get('/issues/activity', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { limit } = pageArgs(req.query, { def: 100, max: LIMITS.activityMax });
    const since = Number(req.query.since);
    res.json({ ok: true, ...activityFeed({ access: accessOf(req), limit, since: Number.isFinite(since) && since > 0 ? since : 0 }) });
  });
  /** 목록 · CSV 공용 — 범위가 요청 필터 · 검색식보다 먼저(listIssues). 던지면 호출부가 fail. */
  const listFor = (req, { offset, limit }) => {
    const done = ['open', 'recent', 'all'].includes(req.query.done) ? req.query.done : 'open';
    const q = req.query;
    const access = accessOf(req);
    const query = str(q.query).slice(0, QUERY_LIMITS.length + 1);
    // 검색식(v2.882) — 법인 이름은 이 사용자가 볼 수 있는 vCenter 로만 푼다 · doc 필드는 보이는 위키 문서로만
    let ctx = null;
    if (query.trim()) {
      const docs = /\bdoc\b/i.test(query) ? issueDocIndex(access) : null;
      ctx = queryContext({ me: userOf(req), vcenters: vcenterChoices(access), docs: docs ? (k) => docs.get(k) || [] : null });
    }
    return listIssues({
      q: str(q.q), status: STATUSES.includes(q.status) ? q.status : '', assignee: Object.hasOwn(q, 'assignee') ? str(q.assignee) : null,
      priority: PRIORITIES.includes(q.priority) ? q.priority : '', type: TYPES.includes(q.type) ? q.type : '', label: str(q.label).slice(0, LIMITS.label),
      vcenterId: Object.hasOwn(q, 'vcenterId') ? str(q.vcenterId).slice(0, 128) : null,
      sprintId: Object.hasOwn(q, 'sprintId') ? str(q.sprintId).slice(0, 20) : null,
      done, offset, limit, access, query, me: userOf(req), ctx,
    });
  };
  api.get('/issues', (req, res, next) => {
    const { offset, limit } = pageArgs(req.query, { def: 500, max: LIMITS.issueMax });
    res.set('Cache-Control', 'no-store');
    let list;
    try { list = listFor(req, { offset, limit }); } catch (e) { return fail(res, e, next); }
    res.json({ ok: true, ...list, me: userOf(req), canWrite: canWrite(req), persist: issuesPersist({ admin: isAdmin(req) }) });
  });
  // v2.888 C-3 수정 버전별 이슈 수(릴리스 노트의 '이 버전에서 고친 이슈' 한 줄) — 로그인 사용자 전부 · 범위가 먼저(볼 수 있는 이슈만 센다).
  api.get('/issues/versions', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const fix = {};
    for (const r of listIssues({ done: 'all', limit: LIMITS.issueMax, access: accessOf(req) }).rows) {
      if (!r.fixVersion) continue;
      const c = fix[r.fixVersion] || (fix[r.fixVersion] = { total: 0, open: 0 });
      c.total += 1; if (r.status !== 'done') c.open += 1;
    }
    res.json({ ok: true, fix });
  });
  // v2.888 C-2 CSV 내보내기 — 목록과 같은 조건(범위 → 필터 · 검색식). 포탈 규약대로 권한 키 'data.csv'(관리자 · 권한에서 끌 수 있다 —
  //   v2.643 CSV 가져오기/내보내기). ⚠ '/issues/:key' 보다 먼저.
  api.get('/issues/export.csv', requirePerm('data.csv'), (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    let list;
    try { list = listFor(req, { offset: 0, limit: LIMITS.issueMax }); } catch (e) { return fail(res, e, next); }
    const access = accessOf(req);
    const names = new Map(vcenterChoices(access).map((v) => [v.id, v.name || v.id]));
    const body = issuesCsv(list.rows, { vcName: (id) => names.get(id) || id, sprintName: (id) => getSprint(id)?.name || id });
    audit(req, 'issue.export', 'issues.csv', `${list.rows.length}건${str(req.query.query).trim() ? ' · 검색식' : ''}`);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="issues-${fileStamp()}.csv"`);
    res.send(body);
  });

  /* ───── 스프린트(v2.882 · 시안 ⑦) — '/issues/:key' 보다 먼저(키 형식이 아니라 404 가 된다) ───── */
  api.get('/issues/sprints', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const access = accessOf(req);
    res.json({ ok: true, sprints: listSprints(), canManage: canWrite(req) && !access.read && !access.write, loadError: isAdmin(req) ? sprintsLoadError() : null, limits: SPRINT_LIMITS });
  });
  api.get('/issues/sprints/:id/board', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try { res.json({ ok: true, ...sprintBoard(str(req.params.id).slice(0, 20), { access: accessOf(req) }) }); } catch (e) { fail(res, e, next); }
  });
  api.post('/issues/sprints', writers, sprintFleetOnly, fullWriteOnly, (req, res, next) => {
    if (!canWrite(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 스프린트를 만들 수 없습니다' });
    try {
      const sp = createSprint(req.body || {}, userOf(req));
      audit(req, 'issue.sprint.create', sp.id, `${sp.name} ${sp.startDay}~${sp.endDay}`);
      res.json({ ok: true, sprint: sp });
    } catch (e) { fail(res, e, next); }
  });
  api.put('/issues/sprints/:id', writers, sprintFleetOnly, fullWriteOnly, (req, res, next) => {
    if (!canWrite(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 스프린트를 고칠 수 없습니다' });
    try {
      const sp = updateSprint(str(req.params.id).slice(0, 20), req.body || {}, userOf(req));
      audit(req, 'issue.sprint.update', sp.id, Object.keys(req.body || {}).slice(0, 6).join(','));
      res.json({ ok: true, sprint: sp });
    } catch (e) { fail(res, e, next); }
  });
  // 끝내기 — 미완료를 다음 스프린트(to) 또는 백로그('')로 옮긴 뒤 닫는다(순서: 옮기기 → 닫기. 옮기기가 실패하면 닫지 않는다).
  api.post('/issues/sprints/:id/close', writers, sprintFleetOnly, fullWriteOnly, async (req, res, next) => {
    if (!canWrite(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 스프린트를 끝낼 수 없습니다' });
    try {
      const id = str(req.params.id).slice(0, 20);
      const sp = getSprint(id);
      if (!sp) return res.status(404).json({ ok: false, reason: '없는 스프린트입니다' });
      if (sp.state === 'closed') return res.status(409).json({ ok: false, reason: '이미 끝난 스프린트입니다' });
      const to = str(req.body?.to).slice(0, 20);
      const moved = moveSprintIssues(id, to, userOf(req));
      const closed = closeSprint(id, userOf(req), { note: `완료 ${moved.done} · 옮김 ${moved.moved}${to ? ` → ${getSprint(to)?.name || to}` : ' → 백로그'}` });
      audit(req, 'issue.sprint.close', id, `${sp.name} — 완료 ${moved.done} · 옮김 ${moved.moved}${to ? ` → ${to}` : ' → 백로그'}`);
      res.json({ ok: true, sprint: closed, moved, persist: await persistView(req) });
    } catch (e) { fail(res, e, next); }
  });

  /* ───── 저장 필터(v2.882 · 시안 ⑧) — 쓰기 계정(운영자 · 관리자)이 저장한다. 공유는 전체 범위 쓰기 계정만(저장소가 canShare 로 판정) ───── */
  api.get('/issues/filters', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, filters: listFilters(userOf(req), { isMod: isMod(req) }), loadError: isAdmin(req) ? filtersLoadError() : null, limits: FILTER_LIMITS });
  });
  const canShareFilters = (req) => { const a = accessOf(req); return canWrite(req) && !a.read && !a.write; };
  api.post('/issues/filters', writers, (req, res, next) => {
    if (!canWrite(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 필터를 저장할 수 없습니다' });
    try { res.json({ ok: true, filter: createFilter(req.body || {}, userOf(req), { canShare: canShareFilters(req) }) }); } catch (e) { fail(res, e, next); }
  });
  api.put('/issues/filters/:id', writers, (req, res, next) => {
    if (!canWrite(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 필터를 고칠 수 없습니다' });
    try { res.json({ ok: true, filter: updateFilter(str(req.params.id).slice(0, 20), req.body || {}, userOf(req), { canShare: canShareFilters(req) }) }); } catch (e) { fail(res, e, next); }
  });
  // v2.883 주간 메일 구독 — 볼 수 있는 필터(내 것 · 공유)만. 메일은 받는 사람의 범위로 다시 거른다(notify.js scanWeeklyFilters).
  api.post('/issues/filters/:id/subscribe', writers, (req, res, next) => {
    if (!canWrite(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 구독할 수 없습니다' });
    try { res.json({ ok: true, filter: setSubscription(str(req.params.id).slice(0, 20), userOf(req), req.body?.on === true ? true : req.body?.on === false ? false : null, { isMod: isMod(req) }) }); } catch (e) { fail(res, e, next); }
  });
  api.delete('/issues/filters/:id', writers, (req, res, next) => {
    if (!canWrite(req)) return res.status(403).json({ ok: false, reason: '데모 계정은 필터를 지울 수 없습니다' });
    try { res.json({ ok: true, ...deleteFilter(str(req.params.id).slice(0, 20), userOf(req), { isMod: isMod(req) }) }); } catch (e) { fail(res, e, next); }
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
      const auto = wantAuto ? suggestionFor({ component: str(body.component).trim(), vcenterId: str(body.vcenterId).trim() }) : null; // 저장(vcenterField)과 같은 트림 — 감사 A2-10
      const x = createIssue(body, userOf(req), { access: accessOf(req), known: knownVcenters(), auto, requestOnly });
      audit(req, requestOnly ? 'issue.request' : 'issue.create', x.key, `${x.title}${x.vcenterId ? ` [${x.vcenterId}]` : ''}${x.assignee ? ` → ${x.assignee}${auto?.assignee === x.assignee ? '(자동)' : ''}` : ''}`);
      res.json({ ok: true, issue: x, requestOnly, persist: await persistView(req) });
    } catch (e) { fail(res, e, next); }
  });
  // ⚠ '/issues/:key/…' 보다 먼저 — 뒤에 두면 'bulk' 가 키로 잡혀 404 가 된다(v2.864 자체 테스트가 잡았다).
  // v2.882 일괄 편집(스프린트 · 에픽 · 라벨 더하기) — 키마다 updateIssue(범위 · 계층 규칙 하나)
  api.post('/issues/bulk/edit', writers, async (req, res, next) => {
    try {
      const r = bulkEdit(req.body?.keys, req.body?.set, userOf(req), { access: accessOf(req), known: knownVcenters() });
      audit(req, 'issue.bulk-edit', Object.keys(req.body?.set || {}).slice(0, 4).join(','), `${r.done}건 성공 · ${r.failed}건 실패`);
      res.json({ ok: true, ...r, persist: await persistView(req) });
    } catch (e) { fail(res, e, next); }
  });
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
      const x = setStatus(req.params.key, req.body?.status, userOf(req), { access: accessOf(req), closeChildren: req.body?.closeChildren === true, ignoreBlockers: req.body?.ignoreBlockers === true });
      audit(req, 'issue.status', x.key, x.status);
      res.json({ ok: true, issue: x, persist: await persistView(req) });
    } catch (e) { fail(res, e, next, req); }
  });
  // v2.883 연결(차단함 · 관련 · 중복) — 쓰기 계정. 더하기는 이 이슈의 쓰기 범위 + 상대 조회 범위, 빼기는 저장된 쪽 이슈의 쓰기 범위.
  api.post('/issues/:key/links', writers, async (req, res, next) => {
    if (!KEY_RE.test(req.params.key)) return badKey(res);
    try {
      const x = addLink(req.params.key, req.body || {}, userOf(req), { access: accessOf(req) });
      audit(req, 'issue.link', x.key, `${str(req.body?.type).slice(0, 20)} ${str(req.body?.key).slice(0, 20)}`);
      res.json({ ok: true, issue: x, persist: await persistView(req) });
    } catch (e) { fail(res, e, next, req); }
  });
  api.post('/issues/:key/links/remove', writers, async (req, res, next) => {
    if (!KEY_RE.test(req.params.key)) return badKey(res);
    try {
      const x = removeLink(req.params.key, req.body || {}, userOf(req), { access: accessOf(req) });
      audit(req, 'issue.unlink', x.key, `${str(req.body?.type).slice(0, 20)} ${str(req.body?.key).slice(0, 20)}`);
      res.json({ ok: true, issue: x, persist: await persistView(req) });
    } catch (e) { fail(res, e, next, req); }
  });
  // 진행률·진행 메모(v2.871) — 쓰기 계정 · 쓰기 범위.
  // v2.888 C-3 작업 기록 — 쓰기 역할 · 그 이슈의 쓰기 범위(저장소 findFor). 지우기는 적은 사람 또는 전체 범위 관리자.
  api.post('/issues/:key/worklog', writers, async (req, res, next) => {
    if (!KEY_RE.test(req.params.key)) return badKey(res);
    try {
      const x = addWorklog(req.params.key, req.body || {}, userOf(req), { access: accessOf(req) });
      res.json({ ok: true, issue: x, persist: await persistView(req) });
    } catch (e) { fail(res, e, next, req); }
  });
  api.post('/issues/:key/worklog/remove', writers, async (req, res, next) => {
    if (!KEY_RE.test(req.params.key)) return badKey(res);
    try {
      const x = removeWorklog(req.params.key, str(req.body?.id).slice(0, 40), userOf(req), { access: accessOf(req), isMod: isMod(req) });
      res.json({ ok: true, issue: x, persist: await persistView(req) });
    } catch (e) { fail(res, e, next, req); }
  });
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
  // v2.907 멘션 후보(시안 docs/design/wiki-mention ⑥-7) — 위키와 같은 판정(issues/mentionables.js) · 참여자 = 담당 · 보고 · 관찰 · 댓글 쓴 사람
  api.get('/issues/:key/mentionables', writers, (req, res, next) => {
    if (!KEY_RE.test(req.params.key)) return badKey(res);
    res.set('Cache-Control', 'no-store');
    try {
      const access = accessOf(req);
      const it = getIssue(req.params.key, userOf(req), access);
      const parts = [it.assignee, it.reporter, ...(it.watcherNames || []), ...(it.comments || []).map((c) => c.author)].filter(Boolean);
      const full = canWrite(req) && isFullReadWriteScope(req.user, store.get());
      const settings = loadIssueSettings();
      const viewers = issueViewers();
      let users = [];
      try { users = listUsers(); } catch { users = []; }
      const r = mentionCandidates({ q: str(req.query.q), me: userOf(req), meName: req.user?.name || '', full, participants: parts, knownNames: knownNames(access), users, people: full ? settings.notify?.people || [] : [], canSee: (n) => viewers.canSee(n, it.vcenterId || '') });
      res.json({ ok: true, ...r, full, notifyOn: !!(settings.notify?.enabled && settings.notify?.mail !== false) });
    } catch (e) { fail(res, e, next, req); }
  });
  api.post('/issues/:key/comments', writers, async (req, res, next) => {
    if (!KEY_RE.test(req.params.key)) return badKey(res);
    try {
      const access = accessOf(req);
      const c = addComment(req.params.key, req.body, userOf(req), { access });
      audit(req, 'issue.comment.create', `${req.params.key}/${c.id}`);
      // v2.907 선택(결정 5): 언급한 사람을 관찰자로 — 그 법인을 볼 수 없는 사람은 빼고 센다
      // v2.930(점검 B1-06): 응답(added · skipped)이 '그 이름의 계정이 있는가 · 그 법인을 보는가' 판정이 되지 않게 — 전체 범위 쓰기 계정이 아니면
      //   이름 해석 후보를 멘션 자동완성(mentionCandidates)과 같게(참여자 + 볼 수 있는 이슈에 나온 이름 + 자기) 좁히고, 뺀 사람은 이름 없이 수만.
      //   알림 수신 해석(notify.js recipientsOf)은 응답에 나오지 않으므로 그대로 둔다.
      let watch = null;
      if (req.body?.watchMentions === true) {
        const it = getIssue(req.params.key, userOf(req), access);
        const viewers = issueViewers();
        const parts = [it.assignee, it.reporter, ...(it.watcherNames || []), ...(it.comments || []).map((x) => x.author)].filter(Boolean);
        const full = canWrite(req) && isFullReadWriteScope(req.user, store.get());
        const known = full
          ? new Set([...viewers.localNames, ...(loadIssueSettings().notify?.people || []).map((p) => p.username), ...parts])
          : new Set([...parts, ...knownNames(access), userOf(req)]);
        const r = addWatchers(req.params.key, resolveMentions(mentionsOf(c.body), known), userOf(req), { access, canSee: viewers.canSee });
        watch = full ? { ...r, skippedN: r.skipped.length } : { added: r.added, skippedN: r.skipped.length };
      }
      res.json({ ok: true, comment: c, ...(watch ? { watch } : {}), persist: await persistView(req) });
    } catch (e) { fail(res, e, next, req); }
  });
  // v2.907 댓글 고치기(기능 추천 1) — 쓴 사람만(저장소가 판정) · 새로 언급한 사람에게만 알림
  api.put('/issues/:key/comments/:cid', writers, async (req, res, next) => {
    if (!KEY_RE.test(req.params.key)) return badKey(res);
    try {
      const c = editComment(req.params.key, str(req.params.cid).slice(0, 40), req.body || {}, userOf(req), { access: accessOf(req) });
      audit(req, 'issue.comment.edit', `${req.params.key}/${c.id}`);
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
      const seq = issuesSeq();
      audit(req, 'issue.delete', x.key, `${x.title} (보고자 ${x.reporter})`);
      const persist = await persistView(req);
      // v2.904 점검 S-5: 첨부 본체는 이슈 삭제가 디스크에 닿은 뒤에 지운다
      removeOwnerAfterPersist('issue', x.key, { seq, state: persist.state, wait: waitIssuesPersist });
      res.json({ ok: true, persist });
    } catch (e) { fail(res, e, next, req); }
  });
}
