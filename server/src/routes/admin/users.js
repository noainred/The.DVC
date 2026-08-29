// 사용자 관리·권한 매트릭스·비밀번호·TOTP — admin.js(구 2,410줄) 분할(v2.285.0). 본문은 원본 그대로, 등록 순서는 admin.js 호출 순서가 보존한다.
import { listUsers, createUser, updateUser, deleteUser, beginTotpEnroll, confirmTotpEnroll, disableTotp, setLocalPassword, clearLoginCredentials } from '../../auth/auth.js';
import { PERMISSION_CATALOG, ROLES, loadMatrix, saveMatrix, resetMatrix, rolePermissions } from '../../auth/permissions.js';
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
