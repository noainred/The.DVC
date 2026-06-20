import { Router } from 'express';
import { config } from '../config.js';
import { authenticate, signToken, authMiddleware, requireRole, getUser, beginTotpEnroll, confirmTotpEnroll } from '../auth/auth.js';
import { loadAdConfig, saveAdConfig, testAd } from '../auth/ad.js';

export const authRouter = Router();

// Whether auth is required at all, and whether AD login is enabled (UI hint).
authRouter.get('/config', (_req, res) => {
  const ad = loadAdConfig();
  res.json({ authEnabled: config.auth.enabled, adEnabled: Boolean(ad.enabled && ad.url) });
});

authRouter.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  const user = await authenticate(username, password);
  if (!user) return res.status(401).json({ error: 'invalid credentials' });

  const token = signToken({ sub: user.username, role: user.role, name: user.name });
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
  res.json(beginTotpEnroll(req.user.username));
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
