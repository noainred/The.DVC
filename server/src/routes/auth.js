import { Router } from 'express';
import { config } from '../config.js';
import { authenticate, signToken, authMiddleware, requireEnrolled, requireRole, getUser, beginTotpEnroll, confirmTotpEnroll, setupState } from '../auth/auth.js';
import { rolePermissions, roleToolsDenied } from '../auth/permissions.js';
import { loadAdConfig, saveAdConfig, testAd } from '../auth/ad.js';
import { logAudit } from '../audit.js';
import { recordPortalLoginFail } from '../security/loginStore.js';
import { loadSessionSecurity, singleSessionRequired } from '../security/securitySettings.js';
import { newSessionId, setActiveSession } from '../auth/sessions.js';
import { checkLoginAllowed, recordLoginFailure, recordLoginSuccess } from '../security/loginRateLimit.js';

export const authRouter = Router();

// Whether auth is required at all, and whether AD login is enabled (UI hint).
// 유휴 자동 로그아웃 설정도 함께 내려 클라이언트가 그 시간으로 타이머를 건다(비밀 아님).
authRouter.get('/config', (_req, res) => {
  const ad = loadAdConfig();
  const sec = loadSessionSecurity();
  // setupState: 초기 구축 중이면 로그인 화면이 '최초 관리자 비밀번호 파일 경로'를 안내한다
  // (비밀번호 값이 아니라 경로만 — 이미 문서에 공개된 고정 위치).
  // ⚠ settingsOwners(설정 소유 '계정명' 목록)는 여기에 싣지 않는다 — 미인증 응답이라
  // 공격자에게 유효 관정 계정명을 알려주는 열거 단서가 된다(감사 C1 후속). 프론트의 '설정' 탭
  // 노출 판단은 인증 후 /auth/me 의 isSettingsOwner 불리언을 쓴다(서버는 requireSettingsOwner 로 강제).
  res.json({ authEnabled: config.auth.enabled, adEnabled: Boolean(ad.enabled && ad.url), idleLogoutEnabled: sec.idleLogoutEnabled, idleLogoutMin: sec.idleLogoutMin, ...setupState() });
});

authRouter.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  // 문자열만 허용 — 객체/배열이 오면 String() 강제변환으로 "[object Object]" 같은 값이 인증에
  // 쓰이는 사고를 막는다(특수문자 자체는 어떤 것이든 그대로 통과).
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0];
  // 잠금 키는 클라이언트가 위조할 수 없는 '실제 peer 주소'를 쓴다(X-Forwarded-For는 스푸핑으로
  // 계정별 잠금을 무력화할 수 있으므로 키에 사용하지 않는다 — 감사 로그에는 XFF를 그대로 남김).
  const gateIp = (req.socket?.remoteAddress || ip || '').toString();

  // 무차별 대입 방어: peer+계정 잠금 상태면 인증 시도 자체를 막는다.
  const gate = checkLoginAllowed(gateIp, username);
  if (gate.blocked) {
    logAudit({ user: username, action: '로그인 차단(잠금)', detail: `${gate.retryAfterSec}s`, ip });
    return res.status(429).set('Retry-After', String(gate.retryAfterSec))
      .json({ error: `로그인 시도가 일시적으로 잠겼습니다. ${gate.retryAfterSec}초 후 다시 시도하세요.` });
  }

  const user = await authenticate(username, password);
  if (!user) {
    const lk = recordLoginFailure(gateIp, username);
    logAudit({ user: username, action: lk.locked ? '로그인 실패(잠금 발동)' : '로그인 실패', ip });
    try { recordPortalLoginFail({ username, ip, reason: 'invalid credentials' }); } catch { /* */ }
    if (lk.locked) {
      return res.status(429).set('Retry-After', String(lk.retryAfterSec))
        .json({ error: `로그인 실패가 많아 일시적으로 잠겼습니다. ${lk.retryAfterSec}초 후 다시 시도하세요.` });
    }
    return res.status(401).json({ error: 'invalid credentials' });
  }

  recordLoginSuccess(gateIp, username);
  // 로컬 계정 토큰에는 src/tv(tokenVersion)를 실어 서버측 폐기(비번/역할 변경 시 즉시 무효)를
  // 가능하게 한다(감사 M5). AD 계정은 로컬 레코드가 없어 다음 로그인 시점에 역할이 반영된다.
  const local = user.source === 'local' ? getUser(user.username) : null;
  // 단일 세션 강제(ID 공유 금지, v2.280) — 강제 대상이면 이 로그인에 새 세션 ID(sid)를 발급해 토큰에
  // 싣고 계정의 활성 세션으로 등록한다. 이 등록이 같은 계정의 이전 세션 sid 를 덮어써(최신 로그인
  // 우선) 이전 토큰이 resolveTokenUser 에서 무효가 된다. 아니면 sid 를 싣지 않는다(다중 세션 허용).
  // v2.294: 판정은 singleSessionRequired 하나로(resolveTokenUser 와 동일 함수 — 발급/검사 쌍 유지).
  // 내장 데모 계정(local.demo)은 '설정 › 세션 보안'의 Demo 중복 접속 모드에 따라 전역과 독립 판정:
  // 'allow'=중복 허용(전역 단일세션이어도 sid 미발급·미검사), 'single'=데모만 단일 세션, 미설정=전역 따름.
  const sid = singleSessionRequired(!!local?.demo) ? newSessionId() : null;
  const token = signToken({ sub: user.username, role: user.role, name: user.name, ...(local ? { src: 'local', tv: local.tokenVersion || 0 } : {}), ...(sid ? { sid } : {}) });
  if (sid) setActiveSession(user.username, sid, { at: Date.now(), ip });
  logAudit({ user: user.username, action: '로그인', detail: `${user.role}${sid ? ' · 단일세션' : ''}${user.mustEnrollOtp ? ' · OTP 등록 필요(등록 전용 세션)' : ''}`, ip });
  // 로그인 직후에도 프론트가 메뉴를 바로 게이팅할 수 있게 권한/scope 를 함께 내려준다.
  // mustEnrollOtp 이면 프론트는 OTP 등록 화면에 고정된다(서버도 requireEnrolled 로 차단).
  const owners = (() => { try { return loadSessionSecurity().settingsOwners || []; } catch { return []; } })();
  const enriched = {
    ...user,
    permissions: rolePermissions(user.role),
    toolsDenied: roleToolsDenied(user.role),
    isSettingsOwner: !config.auth.enabled || owners.includes(user.username) || owners.includes(user.name),
    // 서비스 허브 주소는 인증 후에만 — 미인증 응답에 내부 호스트를 노출하지 않는다.
    serviceHubUrl: config.serviceHubUrl || '',
    scope: (local && local.scope) ? { vcenters: local.scope.vcenters || [], regions: local.scope.regions || [] } : { vcenters: [], regions: [] },
  };
  res.json({ token, user: enriched });
});

// Returns the current user when a valid token is presented.
authRouter.get('/me', authMiddleware, (req, res) => {
  const u = getUser(req.user.username);
  // permissions: 현재 매트릭스 기준 '내 기능 권한'(프론트 메뉴/버튼 게이팅용, 매 조회 시 최신 반영).
  // scope: 볼 수 있는 vCenter/리전 제한(빈 배열 = 전체).
  // isSettingsOwner: '설정' 탭 노출 여부(계정명 목록 대신 불리언만 — 열거 단서 제거).
  const owners = (() => { try { return loadSessionSecurity().settingsOwners || []; } catch { return []; } })();
  const isSettingsOwner = !config.auth.enabled || owners.includes(req.user.username) || owners.includes(req.user.name);
  res.json({ user: { ...req.user, totpEnabled: !!u?.totpEnabled, local: !!u, permissions: rolePermissions(req.user.role), toolsDenied: roleToolsDenied(req.user.role), isSettingsOwner, serviceHubUrl: config.serviceHubUrl || '' } });
});

// Self-service TOTP (Google Authenticator) enrollment for the current local user.
// actor = 대상과 동일(본인) → totpRebindDenied 통과. 수퍼관리자의 폰 교체 재등록 경로다.
authRouter.post('/totp/begin', authMiddleware, (req, res) => {
  if (!getUser(req.user.username)) return res.status(400).json({ ok: false, reason: '로컬 계정만 OTP를 등록할 수 있습니다. (AD 계정 제외)' });
  res.json(beginTotpEnroll(req.user.username, req.get('host') || '', { actor: req.user.username }));
});
authRouter.post('/totp/confirm', authMiddleware, (req, res) => {
  const r = confirmTotpEnroll(req.user.username, (req.body || {}).code, { actor: req.user.username });
  res.status(r.ok ? 200 : 400).json(r);
});

// --- Active Directory configuration, admin only ---
// requireEnrolled 필수(v2.322 보안 감사): authRouter 는 index.js 에서 requireEnrolled 없이
// mount 되므로(로그인/공개용), 이 admin 라우트들이 게이트 밖에 있으면 OTP 미등록(부트스트랩)
// admin 세션이 AD 설정을 바꿔 자기 LDAP 를 admin 그룹으로 응답시켜 OTP 우회 admin 경로를 만들 수
// 있다. requireEnrolled 를 넣어 등록 전 세션은 /auth/{me,totp/*} 외 이 라우트에 못 오게 한다.
const adminOnly = [authMiddleware, requireEnrolled, requireRole('admin')];

authRouter.get('/ad-config', ...adminOnly, (_req, res) => {
  res.json({ ad: loadAdConfig() });
});

authRouter.put('/ad-config', ...adminOnly, (req, res) => {
  res.json({ ok: true, ad: saveAdConfig(req.body || {}) });
});

// Test connectivity / a sample login. Body: { config?, username?, password? }
authRouter.post('/ad-test', ...adminOnly, async (req, res) => {
  const { config: cfg, username, password } = req.body || {};
  res.json(await testAd(cfg, username, password));
});
