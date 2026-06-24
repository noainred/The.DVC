import { Router } from 'express';
import { config } from '../config.js';
import { authenticate, signToken, authMiddleware, requireRole, getUser, beginTotpEnroll, confirmTotpEnroll } from '../auth/auth.js';
import { loadAdConfig, saveAdConfig, testAd } from '../auth/ad.js';
import { logAudit } from '../audit.js';
import { recordPortalLoginFail } from '../security/loginStore.js';
import { loadSessionSecurity } from '../security/securitySettings.js';

export const authRouter = Router();

// Whether auth is required at all, and whether AD login is enabled (UI hint).
// 유휴 자동 로그아웃 설정도 함께 내려 클라이언트가 그 시간으로 타이머를 건다(비밀 아님).
authRouter.get('/config', (_req, res) => {
  const ad = loadAdConfig();
  const sec = loadSessionSecurity();
  res.json({ authEnabled: config.auth.enabled, adEnabled: Boolean(ad.enabled && ad.url), idleLogoutEnabled: sec.idleLogoutEnabled, idleLogoutMin: sec.idleLogoutMin, settingsOwners: sec.settingsOwners });
});

authRouter.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0];
  const user = await authenticate(username, password);
  if (!user) {
    logAudit({ user: username, action: '로그인 실패', ip });
    try { recordPortalLoginFail({ username, ip, reason: 'invalid credentials' }); } catch { /* */ }
    return res.status(401).json({ error: 'invalid credentials' });
  }

  const token = signToken({ sub: user.username, role: user.role, name: user.name });
  logAudit({ user: user.username, action: '로그인', detail: user.role, ip });
  res.json({ token, user });
});

// Returns the current user when a valid token is presented.
authRouter.get('/me', authMiddleware, (req, res) => {
  const u = getUser(req.user.username);
  res.json({ user: { ...req.user, totpEnabled: !!u?.totpEnabled, local: !!u } });
});

// Self-service TOTP (Google Authenticator) enrollment for the current local user.
authRouter.post('/totp/begin', authMiddleware, (req, res) => {
  if (!getUser(req.user.username)) return res.status(400).json({ ok: false, reason: '로컬 계정만 OTP를 등록할 수 있습니다. (AD 계정 제외)' });
  res.json(beginTotpEnroll(req.user.username, req.get('host') || ''));
});
authRouter.post('/totp/confirm', authMiddleware, (req, res) => {
  const r = confirmTotpEnroll(req.user.username, (req.body || {}).code);
  res.status(r.ok ? 200 : 400).json(r);
});

// --- Active Directory configuration, admin only ---
const adminOnly = [authMiddleware, requireRole('admin')];

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
