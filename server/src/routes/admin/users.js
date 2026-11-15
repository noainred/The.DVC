// 사용자 관리·권한 매트릭스·비밀번호·TOTP — admin.js(구 2,410줄) 분할(v2.285.0). 본문은 원본 그대로, 등록 순서는 admin.js 호출 순서가 보존한다.
import { isSelfTarget, requireCurrentOtp, selfRebindVerified, clearSelfRebind } from '../../auth/otpRebind.js';   // 20회차 반증 F1
import { listUsers, createUser, updateUser, deleteUser, beginTotpEnroll, confirmTotpEnroll, disableTotp, setLocalPassword, clearLoginCredentials, actorIsSuperAdmin } from '../../auth/auth.js';
import { PERMISSION_CATALOG, ROLES, ADMIN_TOGGLE_KEYS, loadMatrix, saveMatrix, resetMatrix, permissionsWriteRefusal, rolePermissions, USER_TOOL_MODES, setUserTools, userToolOverrides, effectiveToolAccess } from '../../auth/permissions.js';
// v2.506: 도구 거부목록의 '서버 집행 가능 여부' 를 권한 화면에 함께 내려준다(무음 실패 제거).
import { enforcedToolKeys, TOOL_ENFORCEMENT_NOTES } from '../../auth/toolAccess.js';
import { logAudit } from '../../audit.js';
import { adminOnly } from './shared.js';
import { store } from '../../store.js';
import { scopedVcenterIds, writeScopedVcenterIds, isFullReadWriteScope } from '../../auth/scope.js';
import { denyFleetWrite } from '../../auth/scopeMerge.js';   // 전체 점검 2회차 V-1 — 전 법인 공용 쓰기는 조회 ∧ 쓰기 전체

/*
 * ⚠⚠ v2.607 AUTHZ2607-01 — 범위(scope) 제한 admin 의 사용자 관리 경계.
 * 예전에는 adminOnly 뿐이라 범위 admin(scope={vcenters:[vc-us-east]})이 `PATCH /users/<자기> {scope:null}` 한 번으로
 * **자기 범위를 지워 전체 범위**가 됐다(resolveTokenUser 가 매 요청 최신 scope 를 쓰므로 다음 요청부터). 범위 없는
 * admin 을 새로 만들거나 전체 범위 admin 의 비밀번호·OTP 를 대리 설정해 계정을 가져가는 길도 열려 있었다 —
 * v2.605·v2.606 의 범위 가드가 통째로 무력화된다. 규칙:
 *   · 범위 계정이 다룰 수 있는 계정은 **자기 범위의 부분집합인 범위 계정**뿐이다(자기 자신 포함). 그 밖의 계정은
 *     존재를 숨긴다(404 — scope 규칙). 목록도 그 계정만 준다(뺀 개수는 omittedOutOfScope).
 *   · 새 scope 는 요청자 범위의 부분집합이어야 한다 — 조회·쓰기 집합 모두, 리전은 요청자 리전 안에서만
 *     (리전은 vCenter 가 늘면 커진다). scope 해제(null·빈 값 = 전체)는 거부.
 *   · 역할 매트릭스(PUT /permissions·reset)는 전 사용자 공용이라 범위 계정 403.
 *   · 전체 범위 admin 은 예전 그대로다. 마지막 관리자·보호 계정 가드는 auth.js 가 계속 판정한다.
 */
const arrOf = (v) => [...new Set((Array.isArray(v) ? v : []).map((x) => String(x || '').trim()).filter(Boolean))];
function scopeOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return { vcenters: arrOf(raw.vcenters), regions: arrOf(raw.regions), writeVcenters: arrOf(raw.writeVcenters) };
}
function subset(inner, outer) {
  if (!outer) return true;          // 바깥이 무제한이면 무엇이든 안이다(조회 무제한 · 쓰기 제한 요청자 — 전체 점검 7회차)
  if (!inner) return false;         // 전체 범위(null)는 제한된 범위의 부분집합이 아니다
  for (const id of inner) if (!outer.has(id)) return false;
  return true;
}
/**
 * 대상 scope(원시)가 요청자(req.user) 범위 안인가. 요청자가 조회 ∧ 쓰기 전체 범위면 항상 true.
 * 전체 점검 7회차(2회차 반증 R-1 — 재현): 예전 첫 줄은 '조회 범위가 무제한이면 true' 라, writeVcenters 로 쓰기만 줄인 관리자가
 *   자기 · 남의 scope 를 null(조회 · 쓰기 무제한)로 바꾸거나 전체 범위 관리자를 만들고 그 비밀번호 · OTP 를 대리 설정했다(v2.733 · v2.904 함정과 같은 모양).
 *   이제 대상의 조회 ⊆ 요청자 조회(무제한이면 통과) · 대상의 쓰기 ⊆ 요청자 쓰기(요청자 쓰기가 제한이면 대상도 그 안이어야 한다).
 */
function scopeWithinActor(rawScope, actor, snap) {
  if (isFullReadWriteScope(actor, snap)) return true;
  const actorRead = scopedVcenterIds(actor, snap);
  const sc = scopeOf(rawScope);
  if (!sc) return false;
  const u = { scope: sc };
  if (!subset(scopedVcenterIds(u, snap), actorRead)) return false;
  if (!subset(writeScopedVcenterIds(u, snap), writeScopedVcenterIds(actor, snap))) return false;
  const actorRegions = new Set(arrOf(actor?.scope?.regions));
  return sc.regions.every((r) => actorRegions.has(r));
}
function userScopeRaw(username) {
  const u = listUsers().find((x) => x.username === username);
  return u ? u : null;
}
/**
 * 범위 계정이 대상 계정을 다룰 수 없으면 응답하고 true. 조회 범위 계정은 404(목록에 보이지 않는 계정 — 존재 은닉),
 * 조회 무제한 · 쓰기 제한 계정은 403(목록에 보이는 계정 — 조회 밖 404 → 쓰기 밖 403 규약 · 전체 점검 7회차).
 */
function denyTargetOutOfScope(req, res) {
  const snap = store.get();
  if (isFullReadWriteScope(req.user, snap)) return false;
  const t = userScopeRaw(req.params.username);
  if (t && scopeWithinActor(t.scope, req.user, snap)) return false;
  if (t && !scopedVcenterIds(req.user, snap)) { res.status(403).json({ ok: false, error: 'forbidden', requiredOwner: true, reason: SCOPE_DENY_REASON }); return true; }
  res.status(404).json({ ok: false, reason: '사용자를 찾을 수 없습니다.' });
  return true;
}
const SCOPE_DENY_REASON = '범위 제한 계정은 자기 범위 안의 vCenter·리전만 가진 범위 계정만 만들거나 바꿀 수 있습니다(범위 해제·범위 밖 vCenter 추가 불가) — 전체 범위(vCenter 제한 없는) 계정이 해야 합니다.';

/*
 * v2.741 AUTHZ-01 — 사용자별 도구 재정의(`matrix.users`)도 **목록(`GET /users`)과 같은 경계**로 거른다.
 * 예전에는 `GET /permissions` 가 `loadMatrix()` 를, `PUT /user-tools/:username` 성공 응답이 `userToolOverrides()` 를
 * 통째로 실어, 범위 계정이 단건 PUT 에서는 404(존재 은닉)를 받는 범위 밖 계정의 **이름·허용/차단 도구·설정자(by)**를
 * 형제 응답에서 그대로 봤다(재현: 범위 admin 의 두 응답에 범위 밖 operator 이름이 실렸다). 규칙:
 *   · 범위 계정에게는 `scopeWithinActor` 를 통과한 **존재하는 계정**의 항목만 준다(파일에만 남은 유령 항목도 뺀다).
 *     뺀 개수는 `omittedOutOfScope` 로 밝힌다(조용한 축소 금지).
 *   · 설정자(by)는 그 범위 계정이 목록에서 볼 수 있는 계정일 때만 남긴다 — 전체 범위 admin 이름을 흘리지 않게.
 *     가린 개수는 `byHidden`. 시각(at)은 남긴다(화면이 '시각만' 으로 그린다 — userToolText.overrideByText).
 *   · 전체 범위 계정은 예전 그대로 전량. PUT /permissions 는 범위 계정 403 이라 걸러 받은 값의 저장 왕복으로
 *     다른 계정 항목이 지워질 길이 없다(v2.605 범위 병합 사고와 무관).
 */
function overridesForActor(users, actor, snap) {
  const all = users && typeof users === 'object' ? users : {};
  if (!scopedVcenterIds(actor, snap)) return { users: all, scoped: false };
  const visible = new Set(listUsers().filter((u) => scopeWithinActor(u.scope, actor, snap)).map((u) => u.username));
  const out = {};
  let omitted = 0; let byHidden = 0;
  for (const [name, entry] of Object.entries(all)) {
    if (!visible.has(name)) { omitted += 1; continue; }
    const e = entry && typeof entry === 'object' ? { ...entry } : entry;
    if (e && typeof e === 'object' && e.by && !visible.has(String(e.by))) { delete e.by; byHidden += 1; }
    out[name] = e;
  }
  return { users: out, scoped: true, omitted, byHidden };
}

export function registerUsers(adminRouter) {

// --- User management (admin) ---
adminRouter.get('/users', adminOnly, (req, res) => {
  const snap = store.get();
  const all = listUsers();
  if (!scopedVcenterIds(req.user, snap)) return res.json({ users: all });
  const users = all.filter((u) => scopeWithinActor(u.scope, req.user, snap));
  res.json({ users, scoped: true, omittedOutOfScope: all.length - users.length });
});

// actor 전달: 소유자 '이름' 선점/삭제 차단(auth.js identityGuardDenied). 계정 생성·삭제는
// 자격증명 변경과 같은 등급의 보안 작업이므로 감사로그를 남긴다(이전에는 기록이 없었다).
adminRouter.post('/users', adminOnly, (req, res) => {
  const snap = store.get();
  if (!isFullReadWriteScope(req.user, snap) && !scopeWithinActor((req.body || {}).scope, req.user, snap)) {   // 전체 점검 7회차: 쓰기 제한 계정도
    logAudit({ user: req.user?.username, action: '사용자 생성 거부', target: String((req.body || {}).username || ''), detail: '범위 밖 scope', ip: req.ip || '' });
    return res.status(403).json({ ok: false, error: 'forbidden', requiredOwner: true, reason: SCOPE_DENY_REASON });
  }
  const r = createUser(req.body || {}, { actor: req.user?.username, actorUser: req.user });
  logAudit({ user: req.user?.username, action: r.ok ? '사용자 생성' : '사용자 생성 거부', target: String((req.body || {}).username || ''), detail: r.ok ? `role=${(req.body || {}).role || 'viewer'}` : (r.reason || ''), ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});

adminRouter.patch('/users/:username', adminOnly, (req, res) => {
  if (denyTargetOutOfScope(req, res)) return;
  if (!isFullReadWriteScope(req.user, store.get()) && (req.body || {}).scope !== undefined && !scopeWithinActor((req.body || {}).scope, req.user, store.get())) {   // 전체 점검 7회차
    logAudit({ user: req.user?.username, action: '사용자 수정 거부', target: req.params.username, detail: '범위 밖 scope', ip: req.ip || '' });
    return res.status(403).json({ ok: false, error: 'forbidden', requiredOwner: true, reason: SCOPE_DENY_REASON });
  }
  const r = updateUser(req.params.username, req.body || {}, { actor: req.user?.username, actorUser: req.user });
  logAudit({ user: req.user?.username, action: r.ok ? '사용자 수정' : '사용자 수정 거부', target: req.params.username, detail: r.ok ? `role=${(req.body || {}).role ?? '-'}·name=${(req.body || {}).name ?? '-'}` : (r.reason || ''), ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});

adminRouter.delete('/users/:username', adminOnly, (req, res) => {
  if (denyTargetOutOfScope(req, res)) return;   // v2.607 AUTHZ2607-01
  if (req.params.username === req.user.username) return res.status(400).json({ ok: false, reason: '자기 자신은 삭제할 수 없습니다.' });
  const r = deleteUser(req.params.username, { actor: req.user?.username, actorUser: req.user });
  logAudit({ user: req.user?.username, action: r.ok ? '사용자 삭제' : '사용자 삭제 거부', target: req.params.username, detail: r.ok ? '' : (r.reason || ''), ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});

// --- 기능 권한 매트릭스(역할 × 권한) — 관리자가 화면에서 켜고 끈다 ---
// admin 은 항상 전체(매트릭스로 낮출 수 없음). operator/viewer 행만 편집 가능.
adminRouter.get('/permissions', adminOnly, (_req, res) => {
  const m = loadMatrix();
  const ov = overridesForActor(m.users, _req.user, store.get());   // v2.741 AUTHZ-01 — 범위 밖 계정 항목을 싣지 않는다
  res.json({
    catalog: PERMISSION_CATALOG,
    roles: ROLES,
    matrix: { admin: rolePermissions('admin'), ...m, users: ov.users },
    ...(ov.scoped ? { scoped: true, omittedOutOfScope: ov.omitted, byHidden: ov.byHidden } : {}),
    // v2.643: admin 행에서 끌 수 있는 키(CSV)와 그것을 바꿀 수 있는가(super_admin 만). super_admin 은 항상 전체.
    adminToggleKeys: ADMIN_TOGGLE_KEYS,
    canEditAdminRow: actorIsSuperAdmin(_req.user || null),
    // v2.506(감사 미해결 #5): **서버가 실제로 막을 수 있는 도구인지** 함께 내려준다.
    // 도구 거부목록 게이트는 `api.use('/tools', …)` 에만 걸려 있어, 자기 API 가 `/api/tools/*`
    // 가 아닌 도구(예 /admin/*·/insights/*)는 이 목록으로 못 막는다. 그런데 화면은 그냥
    // '차단됨' 으로 보여 관리자가 통제가 걸린 줄 오인했다 — 이 모듈이 v2.447 에 없애려 한
    // 무음 실패가 그대로 남아 있던 부분이다. 화면이 '서버 집행 불가(사유)' 를 표시할 수 있게
    // 근거를 준다. 키 목록은 프론트가 갖고 있으므로(specialToolsList.js) 판정표만 내려보낸다.
    toolEnforcement: {
      enforced: [...enforcedToolKeys()].sort(),
      notes: TOOL_ENFORCEMENT_NOTES,
    },
    // v2.555: 사용자별 재정의의 모드 목록. 화면이 'off/allow/deny' 를 하드코딩하면
    // 서버가 모드를 늘렸을 때 조용히 안 보인다(숫자·목록을 화면에 박지 말 것 — v2.493 규약).
    userToolModes: USER_TOOL_MODES,
  });
});

/*
 * 사용자별 특수기능 접근 재정의(v2.555 — 사용자 요청 "스토리지 엔지니어에게 스토리지 메뉴만").
 * 저장 형태·판정은 `auth/permissions.js` 가 소유하고 여기서는 **경계만** 본다.
 *   · `matrix.users` 는 이미 `GET /permissions` 가 내려주므로 조회 라우트를 따로 만들지 않는다
 *     (두 곳이 각자 읽으면 화면이 어느 것을 믿을지 모른다).
 *   · ⚠ **admin 계정은 재정의 대상이 아니다** — '관리자 잠김 방지' 가 이 모듈의 최초 설계
 *     원칙이다. 조용히 무시하면 관리자가 적용된 줄 알므로 **400 + 사유**로 거절한다.
 *   · ⚠ 존재하지 않는 계정에 저장하지 않는다 — 오타로 만든 유령 항목은 화면에 뜨지 않고
 *     파일에만 남아, 나중에 같은 이름의 계정을 만들면 **뜻하지 않게 제한이 걸린다**.
 */
adminRouter.put('/user-tools/:username', adminOnly, (req, res) => {
  if (denyTargetOutOfScope(req, res)) return;   // v2.607 AUTHZ2607-01
  const name = String(req.params.username || '').trim();
  const target = listUsers().find((u) => u.username === name);
  if (!target) return res.status(400).json({ ok: false, reason: '없는 계정입니다.' });
  if (target.role === 'admin' || target.role === 'super_admin') {
    return res.status(400).json({ ok: false, reason: 'admin 계정에는 기능 제한을 걸 수 없습니다(관리자 잠김 방지). 역할을 먼저 바꾸세요.' });
  }
  const b = req.body || {};
  const r = setUserTools(name, { mode: b.mode, tools: b.tools, by: req.user?.username || '' });
  const eff = r.ok ? effectiveToolAccess({ username: name, role: target.role }) : null;
  logAudit({
    user: req.user?.username,
    action: r.ok ? '사용자 기능 접근 재정의' : '사용자 기능 접근 재정의 거부',
    target: name,
    detail: r.ok
      ? `mode=${r.entry ? r.entry.mode : 'off'}·도구=${r.entry ? r.entry.tools.length : 0}`
      : (r.reason || ''),
    ip: req.ip || '',
  });
  if (!r.ok) return res.status(r.status || 400).json(r);
  // v2.741 AUTHZ-01: 성공 응답의 전체 목록도 GET /permissions 와 같은 경계(범위 밖 계정 항목·설정자 미노출).
  const ov = overridesForActor(userToolOverrides(), req.user, store.get());
  res.json({ ok: true, entry: r.entry, effective: eff, users: ov.users, ...(ov.scoped ? { scoped: true, omittedOutOfScope: ov.omitted, byHidden: ov.byHidden } : {}) });
});
adminRouter.put('/permissions', adminOnly, (req, res) => {
  if (denyFleetWrite(req, res, '역할별 기능 권한은 전 사용자 공용이라 전체 범위(vCenter 제한 없는) 계정만 바꿀 수 있습니다.')) return; // v2.607 AUTHZ2607-01 · 전체 점검 2회차 V-1(조회 ∧ 쓰기 전체)
  const b = req.body || {};
  const next = b.matrix || b; // { operator:[...], viewer:[...], toolsDenied:{...} } 또는 { matrix:{...} }
  // v2.643: admin 행(CSV 등 관리자 전용 키)을 바꾸는 것은 super_admin 만 — admin 이 스스로 권한을 되살리지 못하게.
  //   값이 그대로면 통과시킨다(화면이 전체 매트릭스를 보내도 admin 의 operator·viewer 편집이 막히지 않게).
  let adminDenied;
  if (next.adminDenied !== undefined) {
    const cur = [...(loadMatrix().adminDenied || [])].sort().join(',');
    const want = [...new Set((Array.isArray(next.adminDenied) ? next.adminDenied : []).filter((k) => ADMIN_TOGGLE_KEYS.includes(k)))].sort().join(',');
    if (cur !== want && !actorIsSuperAdmin(req.user || null)) {
      return res.status(403).json({ ok: false, error: 'forbidden', code: 'super-admin-only', reason: 'admin 행(CSV 가져오기/내보내기)의 권한은 super_admin 만 바꿀 수 있습니다.' });
    }
    adminDenied = next.adminDenied;
  }
  { const refused = permissionsWriteRefusal(); if (refused) return res.status(refused.status).json(refused.body); }   // 20회차 F5
  const matrix = saveMatrix({ operator: next.operator, viewer: next.viewer, toolsDenied: next.toolsDenied, adminDenied });
  logAudit({ user: req.user?.username, action: '기능 권한 매트릭스 변경', target: 'permissions', detail: `operator=${matrix.operator.length}·viewer=${matrix.viewer.length}·거부(op/vw)=${matrix.toolsDenied.operator.length}/${matrix.toolsDenied.viewer.length}·admin끔=${(matrix.adminDenied || []).join(',') || '없음'}`, ip: req.ip || '' });
  res.json({ ok: true, matrix: { admin: rolePermissions('admin'), ...matrix } });
});
adminRouter.post('/permissions/reset', adminOnly, (req, res) => {
  if (denyFleetWrite(req, res, '역할별 기능 권한은 전 사용자 공용이라 전체 범위(vCenter 제한 없는) 계정만 바꿀 수 있습니다.')) return; // v2.607 AUTHZ2607-01 · 전체 점검 2회차 V-1(조회 ∧ 쓰기 전체)
  // v2.643: 초기화는 admin 행(adminDenied)도 기본(허용)으로 되돌린다 — admin 이 super_admin 의 결정을 우회하지 못하게.
  if ((loadMatrix().adminDenied || []).length && !actorIsSuperAdmin(req.user || null)) {
    return res.status(403).json({ ok: false, error: 'forbidden', code: 'super-admin-only', reason: 'super_admin 이 끈 admin 권한(CSV)이 있어 초기화는 super_admin 만 할 수 있습니다.' });
  }
  { const refused = permissionsWriteRefusal({ reset: true }); if (refused) return res.status(refused.status).json(refused.body); }   // 20회차 F5(손상이면 초기화는 허용 · 읽기 오류는 거절)
  const matrix = resetMatrix();
  logAudit({ user: req.user?.username, action: '기능 권한 매트릭스 초기화', target: 'permissions', ip: req.ip || '' });
  res.json({ ok: true, matrix: { admin: rolePermissions('admin'), ...matrix } });
});

// 로컬 계정 비밀번호 설정(관리자) — 데모 계정(thedvcdemp) 활성화 등에 사용.
// 비번이 설정되어야 해당 계정으로 로그인할 수 있다(미설정 = 로그인 불가).
// ⚠ 자격증명 변경 4경로(비번 설정·로그인 차단·OTP 등록·OTP 해제)는 모두 actor 를 넘긴다 —
// 보호 계정(수퍼관리자·설정소유자)을 다른 admin 이 대리 변경하면 그 계정으로 로그인할 수 있게 되어
// 계정 탈취가 된다(auth.js credentialGuardDenied). 한 곳만 빠져도 우회가 성립한다.
/*
 * 전체 점검 20회차 반증 F1(재현): 아래 자격증명 변경 라우트를 **자기 자신**에게 쓰면 본인 경로(/auth/totp/*)의 '현재 OTP' 요구(19회차 A-2)를
 *   그대로 비켜 갔다 — 탈취한 admin 세션이 자기 OTP 를 다시 묶거나 해제 · 비밀번호 설정 · 로그인 차단으로 영구 탈취 · 주인 잠금을 했다.
 *   대상 = 요청자이고 OTP 가 등록된 계정이면 같은 판정(auth/otpRebind.js)으로 현재 코드를 받는다. 다른 사람 대상(폰 분실 대리 등록)은 그대로.
 */
function denySelfWithoutOtp(req, res, what) {
  if (!isSelfTarget(req, req.params.username)) return false;
  // 10분 안에 현재 코드를 이미 확인했으면 다시 묻지 않는다 — 같은 코드를 다시 보내면 재사용 방지(minCounter)에 걸린다
  //   (예: OTP 전용 계정 해제 → 서버가 임시 비밀번호를 요구 → 화면이 비밀번호를 받아 다시 보냄).
  if (selfRebindVerified(req.params.username)) return false;
  const need = requireCurrentOtp(req.params.username, (req.body || {}).currentCode, what);
  if (!need) return false;
  logAudit({ user: req.user?.username, action: `${what} 거부(본인 — 현재 OTP 확인 실패)`, target: req.params.username, ip: req.ip || '' });
  res.status(need.status).json(need.body);
  return true;
}
adminRouter.post('/users/:username/password', adminOnly, (req, res) => {
  if (denyTargetOutOfScope(req, res)) return;   // v2.607 AUTHZ2607-01
  if (denySelfWithoutOtp(req, res, '비밀번호 설정')) return;   // 20회차 F1
  const r = setLocalPassword(req.params.username, (req.body || {}).password, { actor: req.user?.username, actorUser: req.user });
  if (r.ok) logAudit({ user: req.user?.username, action: '사용자 비밀번호 설정', target: req.params.username, ip: req.ip || '' });
  else logAudit({ user: req.user?.username, action: '사용자 비밀번호 설정 거부', target: req.params.username, detail: r.reason || '', ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});
// 로그인 차단(관리자) — 비밀번호/OTP 를 모두 제거해 로그인 불가 상태로 되돌린다(데모 계정 잠금).
adminRouter.delete('/users/:username/password', adminOnly, (req, res) => {
  if (denyTargetOutOfScope(req, res)) return;   // v2.607 AUTHZ2607-01
  if (denySelfWithoutOtp(req, res, '로그인 차단')) return;   // 20회차 F1
  const r = clearLoginCredentials(req.params.username, { actor: req.user?.username, actorUser: req.user });
  if (r.ok) logAudit({ user: req.user?.username, action: '사용자 로그인 차단(자격증명 제거)', target: req.params.username, ip: req.ip || '' });
  else logAudit({ user: req.user?.username, action: '사용자 로그인 차단 거부', target: req.params.username, detail: r.reason || '', ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});

// TOTP (Google Authenticator) management for a user — admin enrolls and hands
// the QR to the user (since OTP-only users have no password to self-enroll).
// actor 전달 필수(권한 상승 차단, 2026-08-30): beginTotpEnroll 이 QR 발급용 평문 시크릿을
// 반환하므로, 수퍼관리자·설정소유자 계정을 다른 admin 이 대리 등록하면 그 계정을 탈취할 수 있다
// (auth.js credentialGuardDenied). 대리 등록은 감사로그에 남긴다 — 강력한 권한 작업이다.
adminRouter.post('/users/:username/totp/begin', adminOnly, (req, res) => {
  if (denyTargetOutOfScope(req, res)) return;   // v2.607 AUTHZ2607-01
  if (denySelfWithoutOtp(req, res, 'OTP 재등록')) return;   // 20회차 F1(확인 사실은 10분 기억 — 아래 confirm 이 본다)
  const r = beginTotpEnroll(req.params.username, req.get('host') || '', { actor: req.user?.username, actorUser: req.user });
  if (!r.ok) logAudit({ user: req.user?.username, action: 'OTP 대리 등록 거부', target: req.params.username, detail: r.reason || '', ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.post('/users/:username/totp/confirm', adminOnly, (req, res) => {
  if (denyTargetOutOfScope(req, res)) return;   // v2.607 AUTHZ2607-01
  if (isSelfTarget(req, req.params.username) && !selfRebindVerified(req.params.username)) {   // 20회차 F1
    return res.status(403).json({ ok: false, needCurrentOtp: true, reason: '본인 계정의 OTP 재등록입니다 — 시작할 때 지금 OTP 코드를 확인한 뒤 10분 안에 확정하세요.' });
  }
  const r = confirmTotpEnroll(req.params.username, (req.body || {}).code, { actor: req.user?.username, actorUser: req.user });
  if (r.ok && isSelfTarget(req, req.params.username)) clearSelfRebind(req.params.username);
  if (r.ok) logAudit({ user: req.user?.username, action: 'OTP 대리 등록 확정', target: req.params.username, ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.post('/users/:username/totp/disable', adminOnly, (req, res) => {
  if (denyTargetOutOfScope(req, res)) return;   // v2.607 AUTHZ2607-01
  if (denySelfWithoutOtp(req, res, 'OTP 해제')) return;   // 20회차 F1
  // ⚠ req.body 를 통째로 넘기면 안 된다 — `force` 는 콘솔 복구 도구 전용 신뢰 플래그인데,
  // 클라이언트가 `{"force":true}` 를 실어 수퍼관리자 OTP 해제 가드를 무력화할 수 있었다
  // (재감사에서 실행 재현: 해제 → 임시 비번 로그인 → 자력 OTP 등록 → 계정 탈취).
  // 허용 필드만 골라 넘기고, force 는 서버 내부에서만 설정한다.
  const r = disableTotp(req.params.username, { password: (req.body || {}).password, actor: req.user?.username, actorUser: req.user });
  if (r.ok) logAudit({ user: req.user?.username, action: 'OTP 해제(관리자)', target: req.params.username, ip: req.ip || '' });
  else logAudit({ user: req.user?.username, action: 'OTP 해제 거부', target: req.params.username, detail: r.reason || '', ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});
}
