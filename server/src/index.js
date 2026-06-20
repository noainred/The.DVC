import './logbuffer.js'; // first: capture console output into the ring buffer
import { pushLog } from './logbuffer.js';
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { store } from './store.js';
import { api } from './routes/api.js';
import { authRouter } from './routes/auth.js';
import { authMiddleware } from './auth/auth.js';
import { auditMiddleware } from './audit.js';
import { upgradeRouter } from './routes/upgrade.js';
import { upgradeManager } from './upgrade/manager.js';
import { adminRouter } from './routes/admin.js';
import { remoteRouter } from './routes/remote.js';
import { attachSshGateway } from './proxy/sshGateway.js';
import { attachRdpGateway } from './proxy/guacdTunnel.js';
import { startMappingExpiry } from './proxy/expiry.js';
import { collectorRouter } from './routes/collector.js';
import { centralRouter } from './routes/central.js';
import { startIdracPoller } from './idrac/poller.js';
import { startNsxPoller } from './nsx/store.js';
import { startCollectorPuller } from './collector/puller.js';
import { startAgentScanner } from './agent/scanner.js';

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

app.use('/api/collector', collectorRouter);            // token-gated agent export (no user auth)
app.use('/api/central', centralRouter);                // token-gated agent<->central (no user auth)
app.use('/api/auth', authRouter);                      // public: login / config / me
app.use('/api/upgrade', authMiddleware, upgradeRouter); // admin-gated auto-upgrade control
app.use('/api/admin', authMiddleware, auditMiddleware, adminRouter);     // admin-gated vCenter management
app.use('/api/remote', authMiddleware, auditMiddleware, remoteRouter);   // remote access (HAProxy/SSH/RDP)
app.use('/api', authMiddleware, api);                   // protected resource endpoints

// Serve the built web client when it exists (production single-port mode).
if (fs.existsSync(config.webDist)) {
  // Hashed assets can cache forever; index.html must never be cached so the
  // browser always picks up new asset hashes after an upgrade.
  app.use(express.static(config.webDist, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      else if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    // A missing file with an extension (e.g. a stale asset hash) must 404 — never
    // return index.html for it, or the browser executes HTML as JS and shows a blank page.
    if (path.extname(req.path)) return res.status(404).end();
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(path.join(config.webDist, 'index.html'));
  });
}

store.start();
upgradeManager.start();
startIdracPoller();
startNsxPoller();
startCollectorPuller();
startAgentScanner();

const server = app.listen(config.port, () => {
  console.log(`\n  VMware Global Monitoring Portal — API`);
  console.log(`  ▸ listening on http://localhost:${config.port}`);
  console.log(`  ▸ data source: ${config.dataSource}`);
  console.log(`  ▸ poll interval: ${config.pollIntervalMs / 1000}s`);
  console.log(`  ▸ auth: ${config.auth.enabled ? 'enabled' : 'disabled'}\n`);
});

// Browser SSH/RDP consoles (WebSocket upgrades on /api/remote/ssh and /rdp).
attachSshGateway(server);
attachRdpGateway(server);
startMappingExpiry(); // remove ephemeral quick-connect mappings 1 day after last use
