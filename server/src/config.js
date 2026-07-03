import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// GitHub Releases '롤링' 자산(versions.json + 설치/업그레이드 번들)이 있는 base.
// release 워크플로가 'downloads' 태그에 자산을 업로드하므로 ${base}/versions.json,
// ${base}/<파일> 이 그대로 자산을 가리킨다. 사내 미러는 UPGRADE_REMOTE_BASE로 override.
const DEFAULT_REMOTE_BASE =
  'https://github.com/noainred/The.DVC/releases/download/downloads';

/**
 * Central configuration for the portal backend.
 *
 * DATA_SOURCE controls where infrastructure data comes from:
 *   - "mock"  : always use generated demo data (default, runs anywhere)
 *   - "live"  : only query the real vCenters listed in config/vcenters.json
 *   - "auto"  : try live; for any vCenter that fails, fall back to mock
 */
// ─── 통합 엣지 모드 (EDGE_MODE=all) ────────────────────────────────────────
// 엣지에 이 3개만 설정하면 전 기능이 켜진다:
//   EDGE_MODE=all  CENTRAL_URL=http://중앙:4000  EDGE_TOKEN=공유토큰
// 활성 내용: 수집기 export(COLLECTOR_TOKEN=EDGE_TOKEN) · 위임 스캔/핑/캡처/로그 워커 ·
// 사이트 인벤토리 push · live 수집(DATA_SOURCE=live) · 중앙발 자동 업그레이드(/dl) ·
// 부팅 시 중앙 자동 등록(수집 서버 수동 추가 불필요). 개별 env를 명시하면 그 값이 우선.
// 주의: EDGE_TOKEN은 CENTRAL_TOKEN과 달리 이 인스턴스의 /api/central 엔드포인트를 열지
// 않는다(엣지가 또 다른 중앙이 되는 부작용 없음) — 엣지에서는 EDGE_TOKEN 사용을 권장.
const EDGE_ALL = (process.env.EDGE_MODE || '').trim().toLowerCase() === 'all';
const EDGE_TOKEN = process.env.EDGE_TOKEN || process.env.CENTRAL_TOKEN || '';
const EDGE_CENTRAL_URL = (process.env.CENTRAL_URL || '').replace(/\/+$/, '');

export const config = {
  port: Number(process.env.PORT) || 4000,
  dataSource: (process.env.DATA_SOURCE || (EDGE_ALL ? 'live' : 'mock')).toLowerCase(),
  // 통합 엣지 모드 여부(로깅/자기등록 판단용).
  edgeAll: EDGE_ALL,
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
  // 외부 공개용 소개 페이지(정적 데모 — 포탈 데이터/인증과 무관). server/src 안에 두어
  // 오프라인 패키지·업그레이드 번들(server/src 통째 복사)에 자동 포함된다.
  introDir: path.resolve(__dirname, 'intro'),
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
    // vCenter별 IP 대역을 주기적으로 스캔해 iDRAC을 자동 발견·등록하는 주기. 스캔은 무거우므로
    // 기본 6시간. 0 이하면 비활성(주기 스캔 끔, 수동 '지금 스캔'은 가능). IDRAC_SCAN_INTERVAL_MS.
    scanIntervalMs: Number(process.env.IDRAC_SCAN_INTERVAL_MS) || 6 * 3_600_000,
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
  temp: {
    // ESXi host temperature time-series (SQLite, like iDRAC power). In CONFIG_DIR
    // so it survives upgrades. 5-year retention by default; sampled on an interval.
    dbPath: process.env.TEMP_DB_PATH ||
      path.join(process.env.CONFIG_DIR || path.resolve(ROOT, 'config'), 'host-temp.db'),
    sampleIntervalMs: Number(process.env.TEMP_SAMPLE_INTERVAL_MS) || 60_000,  // 1분 (설정에서 변경 가능)
    retentionDays: Number(process.env.TEMP_RETENTION_DAYS) || 1830,           // ~5년
  },
  ipam: {
    // Shareable IP ledger DB (SQLite). Replaced on every refresh so external
    // programs can read the current per-center IP inventory. In CONFIG_DIR so
    // upgrades preserve it. Override with IPAM_DB_PATH.
    dbPath: process.env.IPAM_DB_PATH ||
      path.join(process.env.CONFIG_DIR || path.resolve(ROOT, 'config'), 'ipam.db'),
  },
  packages: {
    // Where to fetch upgrade/install packages from (GitHub Releases 롤링 'downloads'
    // 태그 기본; 폐쇄망은 PACKAGE_BASE_URL로 LAN 미러 지정), and where to store the
    // downloaded files (also searched by the agent-deploy installer resolver).
    baseUrl: process.env.PACKAGE_BASE_URL ||
      'https://github.com/noainred/The.DVC/releases/download/downloads',
    dir: process.env.PACKAGE_DIR ||
      path.join(process.env.CONFIG_DIR || path.resolve(ROOT, 'config'), 'packages'),
  },
  collector: {
    // Distributed collection. Each datacenter runs this app as a "collector
    // agent" that polls its local iDRAC/OME and exposes the result at
    // GET /api/collector/export (guarded by COLLECTOR_TOKEN). The central
    // portal registers those agents and pulls+merges their power data.
    //
    // Token this instance REQUIRES on its own export endpoint. Empty = export
    // endpoint disabled (this instance is central-only, not an agent).
    // EDGE_MODE=all 이면 EDGE_TOKEN으로 자동 활성.
    token: process.env.COLLECTOR_TOKEN || (EDGE_ALL ? EDGE_TOKEN : ''),
    // Friendly datacenter label advertised by this agent's export.
    datacenter: process.env.COLLECTOR_DATACENTER || process.env.DATACENTER || '',
    // Central portal: pull registered collectors on this interval. 0 disables.
    pullIntervalMs: Number(process.env.COLLECTOR_PULL_INTERVAL_MS) || 60_000,
    // Per-request timeout when pulling a remote collector.
    timeoutMs: Number(process.env.COLLECTOR_TIMEOUT_MS) || 20_000,
  },
  // Central orchestration of agent-side scans. The central portal hands out
  // per-agent IP assignments; each agent pulls its assignment by name, scans
  // locally, and posts the results back.
  central: {
    // Token the central REQUIRES on its /api/central endpoints (agent->central).
    // Empty = those endpoints are disabled (this instance is not a central).
    token: process.env.CENTRAL_TOKEN || '',
  },
  agent: {
    // This agent's name — matched against central IP assignments.
    name: process.env.AGENT_NAME || process.env.COLLECTOR_DATACENTER || os.hostname(),
    // Central portal base URL this agent pulls assignments from / posts to.
    // Empty = agent scanning disabled.
    centralUrl: (process.env.CENTRAL_URL || '').replace(/\/+$/, ''),
    // Token presented to the central (must match the central's CENTRAL_TOKEN).
    // 엣지에서는 EDGE_TOKEN 사용 권장(이 인스턴스의 central 엔드포인트를 열지 않음).
    centralToken: process.env.CENTRAL_TOKEN || (EDGE_ALL ? EDGE_TOKEN : ''),
    // How often the agent pulls its assignment and scans (ms).
    scanIntervalMs: Number(process.env.AGENT_SCAN_INTERVAL_MS) || 3_600_000,
    // Auto-register discovered iDRACs into this agent's local registry so it
    // begins collecting their power immediately.
    autoRegister: process.env.AGENT_AUTO_REGISTER !== 'false',
    // 사이트 위임 수집: 이 서버가 자기 로컬 vCenter 인벤토리를 수집해 중앙으로 push.
    // 고RTT 원격 사이트의 vCenter 수집을 현장 서버가 전담하게 해 중앙↔vCenter RTT를 제거.
    // EDGE_MODE=all 이면 기본 on(AGENT_PUSH_INVENTORY=false로 명시적 off 가능).
    pushInventory: EDGE_ALL ? process.env.AGENT_PUSH_INVENTORY !== 'false' : process.env.AGENT_PUSH_INVENTORY === 'true',
    inventoryIntervalMs: Number(process.env.AGENT_INVENTORY_INTERVAL_MS) || 60_000,
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
    // Issuer label shown in Google Authenticator when enrolling TOTP.
    totpIssuer: process.env.TOTP_ISSUER || 'VMware Portal',
  },
  upgrade: {
    // Opt-in: the whole feature is OFF unless explicitly enabled.
    // EDGE_MODE=all + CENTRAL_URL 이면 중앙발 자동 업그레이드 기본 on(UPGRADE_ENABLED=false로 off).
    enabled: process.env.UPGRADE_ENABLED === 'true'
      || (EDGE_ALL && !!EDGE_CENTRAL_URL && process.env.UPGRADE_ENABLED !== 'false'),
    // Local folder watched for vmware-portal-<ver>.tar.gz/.zip bundles.
    watchDir: process.env.UPGRADE_WATCH_DIR || '',
    // Directory that gets replaced on upgrade (the running install). Required to apply.
    // EDGE_MODE=all 이면 실행 중인 앱 루트(server/web 상위)로 자동 설정.
    installDir: process.env.UPGRADE_INSTALL_DIR || (EDGE_ALL ? path.resolve(ROOT, '..') : ''),
    // Top-level package directory name inside bundles.
    packageName: process.env.UPGRADE_PACKAGE_NAME || 'vmware-portal',
    // Remote source base = the directory that contains versions.json. Defaults
    // to this repo's download/ on GitHub so the portal monitors it out of the box.
    // EDGE_MODE=all 엣지는 중앙 포탈의 /dl 을 소스로 사용(폐쇄망에서도 동작).
    remoteBase: process.env.UPGRADE_REMOTE_BASE
      || (EDGE_ALL && EDGE_CENTRAL_URL ? `${EDGE_CENTRAL_URL}/dl` : DEFAULT_REMOTE_BASE),
    // PAT for private remote sources, optional.
    token: process.env.UPGRADE_TOKEN || '',
    // Where downloaded bundles are stored before install.
    downloadDir: process.env.UPGRADE_DOWNLOAD_DIR || path.resolve(ROOT, '.upgrade-cache'),
    // Background check interval (ms). 0 disables the background watcher.
    // EDGE_MODE=all 엣지는 1시간 주기 기본 on.
    pollIntervalMs: Number(process.env.UPGRADE_POLL_INTERVAL_MS)
      || (EDGE_ALL && EDGE_CENTRAL_URL ? 3_600_000 : 0),
    // When true, a newer version found by the watcher is applied + restarts automatically.
    autoApply: process.env.UPGRADE_AUTO_APPLY === 'true'
      || (EDGE_ALL && !!EDGE_CENTRAL_URL && process.env.UPGRADE_AUTO_APPLY !== 'false'),
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
          // host에 스킴(http/https)이 없으면 https:// 보강 — fetch 'unknown scheme' 방지.
          const vcenters = parsed.vcenters.map((v) => (v && v.host && !/^https?:\/\//i.test(String(v.host))
            ? { ...v, host: `https://${String(v.host).trim()}` } : v));
          return { file, vcenters };
        }
      } catch (err) {
        console.error(`[config] Failed to parse ${file}: ${err.message}`);
      }
    }
  }
  return { file: null, vcenters: [] };
}
