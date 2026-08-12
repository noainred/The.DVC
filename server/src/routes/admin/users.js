// 사용자 관리·권한 매트릭스·비밀번호·TOTP — admin.js(구 2,410줄) 분할(v2.285.0). 본문은 원본 그대로, 등록 순서는 admin.js 호출 순서가 보존한다.
import { listUsers, createUser, updateUser, deleteUser, beginTotpEnroll, confirmTotpEnroll, disableTotp, setLocalPassword, clearLoginCredentials } from '../../auth/auth.js';
import { PERMISSION_CATALOG, ROLES, loadMatrix, saveMatrix, resetMatrix, rolePermissions } from '../../auth/permissions.js';
import { logAudit } from '../../audit.js';
import { adminOnly } from './shared.js';

export function registerUsers(adminRouter) {

// --- User management (admin) ---
adminRouter.get('/users', adminOnly, (_req, res) => res.json({ users: listUsers() }));

adminRouter.post('/users', adminOnly, (req, res) => {
  const r = createUser(req.body || {});
  res.status(r.ok ? 200 : 400).json(r);
});

adminRouter.patch('/users/:username', adminOnly, (req, res) => {
  const r = updateUser(req.params.username, req.body || {});
  res.status(r.ok ? 200 : 400).json(r);
});

adminRouter.delete('/users/:username', adminOnly, (req, res) => {
  if (req.params.username === req.user.username) return res.status(400).json({ ok: false, reason: '자기 자신은 삭제할 수 없습니다.' });
  const r = deleteUser(req.params.username);
  res.status(r.ok ? 200 : 400).json(r);
});

// --- 기능 권한 매트릭스(역할 × 권한) — 관리자가 화면에서 켜고 끈다 ---
// admin 은 항상 전체(매트릭스로 낮출 수 없음). operator/viewer 행만 편집 가능.
adminRouter.get('/permissions', adminOnly, (_req, res) => {
  res.json({
    catalog: PERMISSION_CATALOG,
    roles: ROLES,
    matrix: { admin: rolePermissions('admin'), ...loadMatrix() },
  });
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
adminRouter.post('/users/:username/password', adminOnly, (req, res) => {
  const r = setLocalPassword(req.params.username, (req.body || {}).password);
  if (r.ok) logAudit({ user: req.user?.username, action: '사용자 비밀번호 설정', target: req.params.username, ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});
// 로그인 차단(관리자) — 비밀번호/OTP 를 모두 제거해 로그인 불가 상태로 되돌린다(데모 계정 잠금).
adminRouter.delete('/users/:username/password', adminOnly, (req, res) => {
  const r = clearLoginCredentials(req.params.username);
  if (r.ok) logAudit({ user: req.user?.username, action: '사용자 로그인 차단(자격증명 제거)', target: req.params.username, ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});

// TOTP (Google Authenticator) management for a user — admin enrolls and hands
// the QR to the user (since OTP-only users have no password to self-enroll).
adminRouter.post('/users/:username/totp/begin', adminOnly, (req, res) => {
  const r = beginTotpEnroll(req.params.username, req.get('host') || '');
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.post('/users/:username/totp/confirm', adminOnly, (req, res) => {
  const r = confirmTotpEnroll(req.params.username, (req.body || {}).code);
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.post('/users/:username/totp/disable', adminOnly, (req, res) => {
  const r = disableTotp(req.params.username, req.body || {});
  res.status(r.ok ? 200 : 400).json(r);
});
}
