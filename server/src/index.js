import './logbuffer.js'; // first: capture console output into the ring buffer
import { pushLog } from './logbuffer.js';
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import { config } from './config.js';
import { store } from './store.js';
import { api } from './routes/api.js';
import { authRouter } from './routes/auth.js';
import { authMiddleware } from './auth/auth.js';
import { upgradeRouter } from './routes/upgrade.js';
import { upgradeManager } from './upgrade/manager.js';
import { adminRouter } from './routes/admin.js';

const app = express();
app.use(cors());
app.use(express.json());

// Lightweight request logging for the log viewer (skip the log endpoint itself).
app.use((req, res, next) => {
  const url = req.originalUrl.split('?')[0];
  if (url === '/api/admin/logs') return next();
  const start = Date.now();
  res.on('finish', () => {
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    pushLog(level, `${req.method} ${url} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

app.use('/api/auth', authRouter);                      // public: login / config / me
app.use('/api/upgrade', authMiddleware, upgradeRouter); // admin-gated auto-upgrade control
app.use('/api/admin', authMiddleware, adminRouter);     // admin-gated vCenter management
app.use('/api', authMiddleware, api);                   // protected resource endpoints

// Serve the built web client when it exists (production single-port mode).
if (fs.existsSync(config.webDist)) {
  app.use(express.static(config.webDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(`${config.webDist}/index.html`);
  });
}

store.start();
upgradeManager.start();

app.listen(config.port, () => {
  console.log(`\n  VMware Global Monitoring Portal — API`);
  console.log(`  ▸ listening on http://localhost:${config.port}`);
  console.log(`  ▸ data source: ${config.dataSource}`);
  console.log(`  ▸ poll interval: ${config.pollIntervalMs / 1000}s`);
  console.log(`  ▸ auth: ${config.auth.enabled ? 'enabled' : 'disabled'}\n`);
});
