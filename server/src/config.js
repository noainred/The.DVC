import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Directory on GitHub (raw) that holds versions.json + the upgrade bundles.
// The portal monitors this for new releases. After merging to main, switch the
// ref to 'main'. Override with UPGRADE_REMOTE_BASE.
const DEFAULT_REMOTE_BASE =
  'https://raw.githubusercontent.com/noainred/The.DVC/claude/vmware-global-monitoring-portal-nrnpnt/download';

/**
 * Central configuration for the portal backend.
 *
 * DATA_SOURCE controls where infrastructure data comes from:
 *   - "mock"  : always use generated demo data (default, runs anywhere)
 *   - "live"  : only query the real vCenters listed in config/vcenters.json
 *   - "auto"  : try live; for any vCenter that fails, fall back to mock
 */
export const config = {
  port: Number(process.env.PORT) || 4000,
  dataSource: (process.env.DATA_SOURCE || 'mock').toLowerCase(),
  // Where user config (vcenters.json / users.json / upgrade.json) is read/written.
  // Defaults to the app's server/config; set CONFIG_DIR (e.g. /etc/vmware-portal)
  // to keep it OUTSIDE the app dir so upgrades never touch it.
  configDir: process.env.CONFIG_DIR || path.resolve(ROOT, 'config'),
  // How often (ms) the collector refreshes the aggregated snapshot.
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 30_000,
  // Allow self-signed vCenter certificates (common in private DCs).
  rejectUnauthorized: process.env.VC_TLS_REJECT_UNAUTHORIZED === 'true',
  // TLS compatibility for older vCenter appliances (used when cert verify is off).
  vcTlsMinVersion: process.env.VC_TLS_MIN_VERSION || 'TLSv1',
  vcTlsCiphers: process.env.VC_TLS_CIPHERS || 'DEFAULT@SECLEVEL=0',
  // Use the vim25 SOAP API for real host/VM metrics (default on; REST is a fallback).
  vcSoapMetrics: process.env.VC_SOAP_METRICS !== 'false',
  // Directory of the built web client to serve in production (optional).
  webDist: path.resolve(ROOT, '..', 'web', 'dist'),
  // The app root (contains server/ + web/ + package.json). Used as the default
  // install dir when applying a centrally-pushed upgrade on a collector agent.
  appRoot: path.resolve(ROOT, '..'),
  ui: {
    // Show the admin "업그레이드" tab. Hidden by default; SHOW_UPGRADE_TAB=true to enable.
    showUpgradeTab: process.env.SHOW_UPGRADE_TAB === 'true',
  },
  idrac: {
    // Poll Dell iDRAC (Redfish) for real host power draw and store time-series
    // in SQLite. The registry (server name, iDRAC host, credentials) lives in
    // CONFIG_DIR/idrac.json. Enabled automatically when any entry is registered.
    enabled: process.env.IDRAC_ENABLED !== 'false',
    pollIntervalMs: Number(process.env.IDRAC_POLL_INTERVAL_MS) || 60_000,
    // SQLite database file for power samples. Kept in CONFIG_DIR so upgrades
    // preserve history. Override with IDRAC_DB_PATH.
    dbPath: process.env.IDRAC_DB_PATH ||
      path.join(process.env.CONFIG_DIR || path.resolve(ROOT, 'config'), 'idrac-power.db'),
    // How many days of samples to retain (older rows pruned). 0 = keep all.
    retentionDays: Number(process.env.IDRAC_RETENTION_DAYS) || 90,
    // Per-request timeout to the iDRAC Redfish API.
    timeoutMs: Number(process.env.IDRAC_TIMEOUT_MS) || 15_000,
    // --- OME (OpenManage Enterprise) tuning ---
    // Power Manager plugin id (constant across OME installs; override if needed).
    omePluginId: process.env.OME_POWER_PLUGIN_ID || '2F6D05BE-EE4B-4B0E-B873-C8D2F64A4625',
    // Power Manager metric types to try, in order, until one returns a value.
    // Defaults cover instantaneous/average system power across OME versions.
    omePowerMetricTypes: (process.env.OME_POWER_METRIC_TYPES || '3,4,1')
      .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)),
    // Duration window enum for the metric query (0=recent). Override per env.
    omePowerDuration: Number(process.env.OME_POWER_DURATION) || 0,
  },
  collector: {
    // Distributed collection. Each datacenter runs this app as a "collector
    // agent" that polls its local iDRAC/OME and exposes the result at
    // GET /api/collector/export (guarded by COLLECTOR_TOKEN). The central
    // portal registers those agents and pulls+merges their power data.
    //
    // Token this instance REQUIRES on its own export endpoint. Empty = export
    // endpoint disabled (this instance is central-only, not an agent).
    token: process.env.COLLECTOR_TOKEN || '',
    // Friendly datacenter label advertised by this agent's export.
    datacenter: process.env.COLLECTOR_DATACENTER || process.env.DATACENTER || '',
    // Central portal: pull registered collectors on this interval. 0 disables.
    pullIntervalMs: Number(process.env.COLLECTOR_PULL_INTERVAL_MS) || 60_000,
    // Per-request timeout when pulling a remote collector.
    timeoutMs: Number(process.env.COLLECTOR_TIMEOUT_MS) || 20_000,
  },
  auth: {
    enabled: process.env.AUTH_ENABLED !== 'false',
    // Signing secret for session tokens. Set AUTH_SECRET in production so
    // tokens survive restarts; otherwise a random per-process secret is used.
    secret: process.env.AUTH_SECRET || '',
    // Token lifetime, e.g. "8h", "30m", "7d", or seconds.
    tokenTtl: process.env.AUTH_TOKEN_TTL || '8h',
    // Default seed admin password when no users.json exists (demo convenience).
    defaultAdminPassword: process.env.DEFAULT_ADMIN_PASSWORD || 'admin123',
  },
  upgrade: {
    // Opt-in: the whole feature is OFF unless explicitly enabled.
    enabled: process.env.UPGRADE_ENABLED === 'true',
    // Local folder watched for vmware-portal-<ver>.tar.gz/.zip bundles.
    watchDir: process.env.UPGRADE_WATCH_DIR || '',
    // Directory that gets replaced on upgrade (the running install). Required to apply.
    installDir: process.env.UPGRADE_INSTALL_DIR || '',
    // Top-level package directory name inside bundles.
    packageName: process.env.UPGRADE_PACKAGE_NAME || 'vmware-portal',
    // Remote source base = the directory that contains versions.json. Defaults
    // to this repo's download/ on GitHub so the portal monitors it out of the box.
    remoteBase: process.env.UPGRADE_REMOTE_BASE || DEFAULT_REMOTE_BASE,
    // PAT for private remote sources, optional.
    token: process.env.UPGRADE_TOKEN || '',
    // Where downloaded bundles are stored before install.
    downloadDir: process.env.UPGRADE_DOWNLOAD_DIR || path.resolve(ROOT, '.upgrade-cache'),
    // Background check interval (ms). 0 disables the background watcher.
    pollIntervalMs: Number(process.env.UPGRADE_POLL_INTERVAL_MS) || 0,
    // When true, a newer version found by the watcher is applied + restarts automatically.
    autoApply: process.env.UPGRADE_AUTO_APPLY === 'true',
    // Edge agents this portal pushes new bundles to after self-upgrade.
    // JSON array: [{"url":"https://edge1","token":"..."}]
    edges: parseEdges(process.env.UPGRADE_EDGES),
  },
};

function parseEdges(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((e) => e && e.url) : [];
  } catch {
    return [];
  }
}

/** Current running version, read from the repo root package.json. */
export function currentVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(ROOT, '..', 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Load the list of vCenters to monitor.
 * Falls back to vcenters.example.json so the portal works out of the box.
 */
export function loadVcenterConfig() {
  const candidates = [
    path.join(process.env.CONFIG_DIR || path.resolve(ROOT, 'config'), 'vcenters.json'),
    path.resolve(ROOT, 'config', 'vcenters.json'),           // legacy in-app location
    path.resolve(ROOT, 'config', 'vcenters.example.json'),   // bundled template
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(parsed?.vcenters)) {
          return { file, vcenters: parsed.vcenters };
        }
      } catch (err) {
        console.error(`[config] Failed to parse ${file}: ${err.message}`);
      }
    }
  }
  return { file: null, vcenters: [] };
}
