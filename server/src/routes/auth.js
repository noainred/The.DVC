import { Router } from 'express';
import { config } from '../config.js';
import { authenticate, signToken, authMiddleware } from '../auth/auth.js';

export const authRouter = Router();

// Whether auth is required at all (lets the SPA skip the login screen if off).
authRouter.get('/config', (_req, res) => {
  res.json({ authEnabled: config.auth.enabled });
});

authRouter.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  const user = authenticate(username, password);
  if (!user) return res.status(401).json({ error: 'invalid credentials' });

  const token = signToken({ sub: user.username, role: user.role, name: user.name });
  res.json({ token, user });
});

// Returns the current user when a valid token is presented.
authRouter.get('/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});
