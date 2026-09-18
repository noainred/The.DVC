// 사용자 관리·권한 매트릭스·비밀번호·TOTP — admin.js(구 2,410줄) 분할(v2.285.0). 본문은 원본 그대로, 등록 순서는 admin.js 호출 순서가 보존한다.
import { listUsers, createUser, updateUser, deleteUser, beginTotpEnroll, confirmTotpEnroll, disableTotp, setLocalPassword, clearLoginCredentials } from '../../auth/auth.js';
import { PERMISSION_CATALOG, ROLES, loadMatrix, saveMatrix, resetMatrix, rolePermissions, USER_TOOL_MODES, setUserTools, userToolOverrides, effectiveToolAccess } from '../../auth/permissions.js';
// v2.506: 도구 거부목록의 '서버 집행 가능 여부' 를 권한 화면에 함께 내려준다(무음 실패 제거).
import { enforcedToolKeys, TOOL_ENFORCEMENT_NOTES } from '../../auth/toolAccess.js';
import { logAudit } from '../../audit.js';
import { adminOnly } from './shared.js';

export function registerUsers(adminRouter) {

// --- User management (admin) ---
adminRouter.get('/users', adminOnly, (_req, res) => res.json({ users: listUsers() }));

// actor 전달: 소유자 '이름' 선점/삭제 차단(auth.js identityGuardDenied). 계정 생성·삭제는
// 자격증명 변경과 같은 등급의 보안 작업이므로 감사로그를 남긴다(이전에는 기록이 없었다).
adminRouter.post('/users', adminOnly, (req, res) => {
  const r = createUser(req.body || {}, { actor: req.user?.username });
  logAudit({ user: req.user?.username, action: r.ok ? '사용자 생성' : '사용자 생성 거부', target: String((req.body || {}).username || ''), detail: r.ok ? `role=${(req.body || {}).role || 'viewer'}` : (r.reason || ''), ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});

adminRouter.patch('/users/:username', adminOnly, (req, res) => {
  const r = updateUser(req.params.username, req.body || {}, { actor: req.user?.username });
  logAudit({ user: req.user?.username, action: r.ok ? '사용자 수정' : '사용자 수정 거부', target: req.params.username, detail: r.ok ? `role=${(req.body || {}).role ?? '-'}·name=${(req.body || {}).name ?? '-'}` : (r.reason || ''), ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});

adminRouter.delete('/users/:username', adminOnly, (req, res) => {
  if (req.params.username === req.user.username) return res.status(400).json({ ok: false, reason: '자기 자신은 삭제할 수 없습니다.' });
  const r = deleteUser(req.params.username, { actor: req.user?.username });
  logAudit({ user: req.user?.username, action: r.ok ? '사용자 삭제' : '사용자 삭제 거부', target: req.params.username, detail: r.ok ? '' : (r.reason || ''), ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});

// --- 기능 권한 매트릭스(역할 × 권한) — 관리자가 화면에서 켜고 끈다 ---
// admin 은 항상 전체(매트릭스로 낮출 수 없음). operator/viewer 행만 편집 가능.
adminRouter.get('/permissions', adminOnly, (_req, res) => {
  res.json({
    catalog: PERMISSION_CATALOG,
    roles: ROLES,
    matrix: { admin: rolePermissions('admin'), ...loadMatrix() },
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
  const name = String(req.params.username || '').trim();
  const target = listUsers().find((u) => u.username === name);
  if (!target) return res.status(400).json({ ok: false, reason: '없는 계정입니다.' });
  if (target.role === 'admin') {
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
  res.status(r.ok ? 200 : 400).json(r.ok ? { ok: true, entry: r.entry, effective: eff, users: userToolOverrides() } : r);
});
adminRouter.put('/permissions', adminOnly, (req, res) => {
  const b = req.body || {};
  const next = b.matrix || b; // { operator:[...], viewer:[...], toolsDenied:{...} } 또는 { matrix:{...} }
  const matrix = saveMatrix({ operator: next.operator, viewer: next.viewer, toolsDenied: next.toolsDenied });
  logAudit({ user: req.user?.username, action: '기능 권한 매트릭스 변경', target: 'permissions', detail: `operator=${matrix.operator.length}·viewer=${matrix.viewer.length}·거부(op/vw)=${matrix.toolsDenied.operator.length}/${matrix.toolsDenied.viewer.length}`, ip: req.ip || '' });
  res.json({ ok: true, matrix: { admin: rolePermissions('admin'), ...matrix } });
});
adminRouter.post('/permissions/reset', adminOnly, (req, res) => {
  const matrix = resetMatrix();
  logAudit({ user: req.user?.username, action: '기능 권한 매트릭스 초기화', target: 'permissions', ip: req.ip || '' });
  res.json({ ok: true, matrix: { admin: rolePermissions('admin'), ...matrix } });
});

// 로컬 계정 비밀번호 설정(관리자) — 데모 계정(thedvcdemp) 활성화 등에 사용.
// 비번이 설정되어야 해당 계정으로 로그인할 수 있다(미설정 = 로그인 불가).
// ⚠ 자격증명 변경 4경로(비번 설정·로그인 차단·OTP 등록·OTP 해제)는 모두 actor 를 넘긴다 —
// 보호 계정(수퍼관리자·설정소유자)을 다른 admin 이 대리 변경하면 그 계정으로 로그인할 수 있게 되어
// 계정 탈취가 된다(auth.js credentialGuardDenied). 한 곳만 빠져도 우회가 성립한다.
adminRouter.post('/users/:username/password', adminOnly, (req, res) => {
  const r = setLocalPassword(req.params.username, (req.body || {}).password, { actor: req.user?.username });
  if (r.ok) logAudit({ user: req.user?.username, action: '사용자 비밀번호 설정', target: req.params.username, ip: req.ip || '' });
  else logAudit({ user: req.user?.username, action: '사용자 비밀번호 설정 거부', target: req.params.username, detail: r.reason || '', ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});
// 로그인 차단(관리자) — 비밀번호/OTP 를 모두 제거해 로그인 불가 상태로 되돌린다(데모 계정 잠금).
adminRouter.delete('/users/:username/password', adminOnly, (req, res) => {
  const r = clearLoginCredentials(req.params.username, { actor: req.user?.username });
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
  const r = beginTotpEnroll(req.params.username, req.get('host') || '', { actor: req.user?.username });
  if (!r.ok) logAudit({ user: req.user?.username, action: 'OTP 대리 등록 거부', target: req.params.username, detail: r.reason || '', ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.post('/users/:username/totp/confirm', adminOnly, (req, res) => {
  const r = confirmTotpEnroll(req.params.username, (req.body || {}).code, { actor: req.user?.username });
  if (r.ok) logAudit({ user: req.user?.username, action: 'OTP 대리 등록 확정', target: req.params.username, ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.post('/users/:username/totp/disable', adminOnly, (req, res) => {
  // ⚠ req.body 를 통째로 넘기면 안 된다 — `force` 는 콘솔 복구 도구 전용 신뢰 플래그인데,
  // 클라이언트가 `{"force":true}` 를 실어 수퍼관리자 OTP 해제 가드를 무력화할 수 있었다
  // (재감사에서 실행 재현: 해제 → 임시 비번 로그인 → 자력 OTP 등록 → 계정 탈취).
  // 허용 필드만 골라 넘기고, force 는 서버 내부에서만 설정한다.
  const r = disableTotp(req.params.username, { password: (req.body || {}).password, actor: req.user?.username });
  if (r.ok) logAudit({ user: req.user?.username, action: 'OTP 해제(관리자)', target: req.params.username, ip: req.ip || '' });
  else logAudit({ user: req.user?.username, action: 'OTP 해제 거부', target: req.params.username, detail: r.reason || '', ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});
}
