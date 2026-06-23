import './logbuffer.js'; // first: capture console output into the ring buffer
import { pushLog } from './logbuffer.js';

// 단일 폴러/요청의 예기치 못한 예외가 프로세스 전체를 죽이지 않도록(크래시 루프 방지).
// 모니터링 서비스는 장시간 떠 있어야 하므로 기록 후 계속 실행한다.
process.on('uncaughtException', (err) => {
  try { pushLog('error', `uncaughtException: ${err?.stack || err}`); } catch { /* */ }
  console.error('[fatal] uncaughtException (계속 실행):', err);
});
process.on('unhandledRejection', (reason) => {
  try { pushLog('error', `unhandledRejection: ${reason?.stack || reason}`); } catch { /* */ }
  console.error('[fatal] unhandledRejection (계속 실행):', reason);
});
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
import { dlSourceRouter } from './routes/dlsource.js';
import { insightsRouter } from './routes/insights.js';
import { metricsExportRouter } from './routes/metricsExport.js';
import { startIdracPoller } from './idrac/poller.js';
import { startNsxPoller } from './nsx/store.js';
import { startAlertEngine } from './alerts.js';
import { startMetricsSampler } from './metrics/sampler.js';
import { startGpuGuestPoller } from './gpu/poller.js';
import { startIpScanPoller } from './ipam/scanPoller.js';
import { startIpScanAgent } from './agent/ipScanWorker.js';
import { startCollectorPuller } from './collector/puller.js';
import { startAgentScanner } from './agent/scanner.js';
import { startInventoryPush } from './agent/inventoryPush.js';
import { startGpuGuestPush } from './agent/gpuGuestPush.js';
import { startPingWorker } from './agent/pingWorker.js';
import { startConfigPush } from './agent/configPush.js';
import { startBackupScheduler } from './backup/settings.js';
import { startLogPoller } from './logs/poller.js';
import { startLogQueryWorker } from './agent/logQueryWorker.js';
import { startCaptureWorker } from './agent/captureWorker.js';
import { startCaptureMonitor } from './net/monitor.js';
import { startLoginMonitor } from './security/loginMonitor.js';
import { startGuestScanScheduler } from './security/guestScanScheduler.js';

const app = express();
app.use(cors());
// 사이트 위임 수집의 인벤토리 push(/api/central/inventory)만 수MB가 될 수 있어 큰 한도를 적용.
// 그 외 모든 라우트는 기본 1mb로 제한해 메모리/요청 남용 면적을 줄인다.
const BIG_JSON = express.json({ limit: process.env.JSON_BODY_LIMIT || '64mb' });
app.use('/api/central/inventory', BIG_JSON);
app.use('/api/central/agent-config', BIG_JSON); // 엣지 설정 통합 push(다수 파일)
app.use(express.json({ limit: '1mb' }));

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
app.use('/dl', dlSourceRouter);                        // 중앙 업그레이드 소스(versions.json + 번들, 공개)
app.use('/metrics', metricsExportRouter);              // Prometheus/OTel 익스포터(선택 토큰)
app.use('/api/auth', authRouter);                      // public: login / config / me
app.use('/api/upgrade', authMiddleware, upgradeRouter); // admin-gated auto-upgrade control
app.use('/api/admin', authMiddleware, auditMiddleware, adminRouter);     // admin-gated vCenter management
app.use('/api/remote', authMiddleware, auditMiddleware, remoteRouter);   // remote access (HAProxy/SSH/RDP)
app.use('/api/insights', authMiddleware, insightsRouter); // FinOps·이상탐지·예측·보안·토폴로지·인시던트·ChatOps
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

// 메인 수집(vCenter)만 즉시 기동하고, 보조 폴러들은 초기 기동을 스태거(분산)해
// 부팅 직후 동시 폴링으로 인한 CPU 스파이크를 평탄화한다(이후 각자 주기 반복).
store.start();
upgradeManager.start();
const stagger = [
  startIdracPoller, startNsxPoller, startAlertEngine, startMetricsSampler, startGpuGuestPoller,
  startIpScanPoller, startIpScanAgent, startCollectorPuller, startAgentScanner, startInventoryPush,
  startGpuGuestPush, startPingWorker, startConfigPush, startBackupScheduler, startLogPoller, startLogQueryWorker, startCaptureWorker, startCaptureMonitor, startLoginMonitor, startGuestScanScheduler,
];
stagger.forEach((start, i) => setTimeout(() => { try { start(); } catch (e) { console.error('[start] 폴러 기동 실패:', e?.message); } }, i * 1500).unref?.());

const server = app.listen(config.port, () => {
  console.log(`\n  VMware Global Monitoring Portal — API`);
  console.log(`  ▸ listening on http://localhost:${config.port}`);
  console.log(`  ▸ data source: ${config.dataSource}`);
  console.log(`  ▸ poll interval: ${config.pollIntervalMs / 1000}s`);
  console.log(`  ▸ auth: ${config.auth.enabled ? 'enabled' : 'disabled'}\n`);
});

// listen 오류(포트 충돌/특권포트 등)를 명확히 안내. 특권포트(<1024) EACCES가 흔한 원인.
server.on('error', (err) => {
  if (err.code === 'EACCES') console.error(`[listen] 포트 ${config.port} 권한 거부(EACCES). 1024 미만 특권포트입니다. PORT를 1024 이상(예: 4000)으로 설정하세요. (portal.env의 PORT 확인)`);
  else if (err.code === 'EADDRINUSE') console.error(`[listen] 포트 ${config.port} 이미 사용 중(EADDRINUSE). 다른 프로세스가 점유 중이거나 PORT를 바꾸세요.`);
  else console.error('[listen] 서버 시작 실패:', err);
  process.exit(1);
});

// Browser SSH/RDP consoles (WebSocket upgrades on /api/remote/ssh and /rdp).
attachSshGateway(server);
attachRdpGateway(server);
startMappingExpiry(); // remove ephemeral quick-connect mappings 1 day after last use
