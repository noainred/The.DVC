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
// 숫자 env 파서 — 명시된 유한 숫자면 그 값(0 포함), 아니면 기본값. `Number(x) || d`는
// 0을 falsy로 흘려 "0=비활성" 계약을 깨므로(주기 0으로 끄기 불가) 이 헬퍼로 통일한다.
const numEnv = (raw, def) => { const n = Number(raw); return Number.isFinite(n) ? n : def; };
// 보존일 전용(v2.583 감사 #24): '0 = 전부 보관' 계약을 지킨다 — `Number(x) || d` 는 0 을 기본값으로 되돌려
// 문서가 약속한 keep-all 이 조용히 prune 이 됐다(IDRAC/TEMP/PING 3곳 실측). 빈 문자열(`KEY=`)은 0 이 아니라
// **미지정**이다 — `Number('') === 0` 이라 그대로 두면 빈 줄 하나가 '무제한 보관' 으로 둔갑한다.
const retentionEnv = (raw, def) => (raw == null || String(raw).trim() === '' ? def : numEnv(raw, def));
// v2.599 T2599-02: env 주기값은 setInterval 로 곧장 간다 — Node 는 2^31−1ms(약 24.8일)를 넘거나 0 이하·NaN 인 지연을
// **1ms** 로 바꿔 경고 한 줄만 남기고 루프를 돈다(실측: AGENT_SCAN_INTERVAL_MS=2592000000 → 12초에 중앙 요청 7,752회).
// 주기 env 는 전부 이 헬퍼로 [min, MAX_TIMER_MS] 에 가둔다. 0 이하·비숫자는 기본값(끄기가 문서화된 키는 offOrIntervalMs).
export const MAX_TIMER_MS = 2_147_000_000;
export const clampIntervalMs = (n, def, min = 1_000) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return def;
  return Math.min(MAX_TIMER_MS, Math.max(min, v));
};
// '0 이하 = 끔' 이 문서화된 키(COLLECTOR_PULL_INTERVAL_MS · IDRAC_SCAN_INTERVAL_MS) — 0 이하는 0(끔), 양수는 상·하한.
export const offOrIntervalMs = (n, min = 1_000) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(MAX_TIMER_MS, Math.max(min, v));
};

const EDGE_ALL = (process.env.EDGE_MODE || '').trim().toLowerCase() === 'all';
const EDGE_TOKEN = process.env.EDGE_TOKEN || process.env.CENTRAL_TOKEN || '';
const EDGE_CENTRAL_URL = (process.env.CENTRAL_URL || '').replace(/\/+$/, '');

/**
 * DB 저장 디렉터리(v2.379) — 대용량 시계열 DB 를 CONFIG_DIR 밖의 큰 볼륨에 둘 수 있게 한다.
 * CONFIG_DIR/db-location.json 의 { dbDir } 를 읽는다(마이그레이션 스크립트가 기록).
 * ⚠ 개별 *_DB_PATH env 가 있으면 **env 가 우선**한다 — 명시 설정을 덮지 않는다.
 * dbLocation.js 를 import 하면 순환 참조가 되므로 여기서 파일을 직접 읽는다(기동 시 1회).
 */
function readDbDir() {
  const cfgDir = process.env.CONFIG_DIR || path.resolve(ROOT, 'config');
  const file = path.join(cfgDir, 'db-location.json');
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const v = j && j.dbDir ? String(j.dbDir).trim() : '';
    return v || null;
  } catch (e) {
    // v2.451: 예전에는 모든 예외를 조용히 삼켜 null 을 돌려줬다. 그래서 마이그레이션 스크립트가
    // 소유권을 잘못 잡아 이 파일을 못 읽는 경우(EACCES)에도 아무 흔적 없이 **옛 경로로 폴백**했고,
    // 관리자는 "복사·검증 완료" 만 보고 성공했다고 믿었다. '파일 없음'(정상)과 그 외를 구분한다.
    if (e && e.code !== 'ENOENT') {
      console.error(`[db-location] ${file} 을(를) 읽지 못해 **기본 경로(CONFIG_DIR)로 폴백**합니다: ${e.message}`);
      console.error('[db-location] DB 경로를 옮겼다면 이 상태에서는 적용되지 않습니다 — 파일 권한(서비스 계정 읽기 가능)을 확인하세요.');
    }
    return null;
  }
}
const DB_DIR = readDbDir();
/** DB 파일 경로 — 설정된 dbDir 이 있으면 그 아래, 없으면 CONFIG_DIR. */
const dbFile = (name) => path.join(DB_DIR || process.env.CONFIG_DIR || path.resolve(ROOT, 'config'), name);

export const config = {
  port: Number(process.env.PORT) || 4000,
  dataSource: (process.env.DATA_SOURCE || (EDGE_ALL ? 'live' : 'mock')).toLowerCase(),
  // 통합 엣지 모드 여부(로깅/자기등록 판단용).
  edgeAll: EDGE_ALL,
  // Where user config (vcenters.json / users.json / upgrade.json) is read/written.
  // Defaults to the app's server/config; set CONFIG_DIR (e.g. /etc/vmware-portal)
  // to keep it OUTSIDE the app dir so upgrades never touch it.
  configDir: process.env.CONFIG_DIR || path.resolve(ROOT, 'config'),
  // 설정된 DB 저장 디렉터리(null = configDir 사용). db-location.json 에서 읽는다(v2.379).
  dbDir: DB_DIR,
  // How often (ms) the collector refreshes the aggregated snapshot.
  pollIntervalMs: clampIntervalMs(Number(process.env.POLL_INTERVAL_MS) || 30_000, 30_000, 5_000),
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
    pollIntervalMs: clampIntervalMs(numEnv(process.env.IDRAC_POLL_INTERVAL_MS, 60_000), 60_000, 5_000),
    // 전력 폴 시 동시에 조회할 iDRAC 수 상한 — 무제한 Promise.all은 자동등록 후 수백 대에
    // 동시 TLS 핸드셰이크를 열어 CPU 스파이크·소켓 고갈을 유발한다(vCenter 수집과 동일 원칙).
    pollConcurrency: Math.max(1, numEnv(process.env.IDRAC_POLL_CONCURRENCY, 16)),
    // vCenter별 IP 대역을 주기적으로 스캔해 iDRAC을 자동 발견·등록하는 주기. 스캔은 무거우므로
    // 기본 6시간. 0 이하면 비활성(주기 스캔 끔, 수동 '지금 스캔'은 가능). IDRAC_SCAN_INTERVAL_MS.
    scanIntervalMs: offOrIntervalMs(numEnv(process.env.IDRAC_SCAN_INTERVAL_MS, 6 * 3_600_000), 60_000),
    // SQLite database file for power samples. Kept in CONFIG_DIR so upgrades
    // preserve history. Override with IDRAC_DB_PATH.
    dbPath: process.env.IDRAC_DB_PATH || dbFile('idrac-power.db'),
    // How many days of samples to retain (older rows pruned). 0 = keep all.
    retentionDays: retentionEnv(process.env.IDRAC_RETENTION_DAYS, 90),
    // 원본(샘플 단위) 보존기간(v2.451). 0 = retentionDays 와 동일(기존 동작).
    // 시간당 롤업(power_hourly)은 retentionDays 만큼 남으므로 대시보드 집계는 그대로다.
    rawRetentionDays: Number(process.env.IDRAC_RAW_RETENTION_DAYS) || 0,
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
    dbPath: process.env.TEMP_DB_PATH || dbFile('host-temp.db'),
    sampleIntervalMs: clampIntervalMs(Number(process.env.TEMP_SAMPLE_INTERVAL_MS) || 60_000, 60_000, 5_000),  // 1분 (설정에서 변경 가능)
    retentionDays: retentionEnv(process.env.TEMP_RETENTION_DAYS, 1830),           // ~5년(시간당 롤업 기준)
    // 원본(분 단위) 보존기간 — 용량의 대부분이 원본이라 짧게 두면, 그 이전 구간은 시간당
    // 롤업(평균·최소·최대)만 남는다. 60분+ 버킷 조회는 이미 롤업을 쓰므로 장기 추이는 그대로다.
    //
    // ⚠ 기본값은 **0(끔)** 이다(v2.453). v2.451 은 기본 90 이었는데, 5년치가 쌓인 34.3GB DB 에서
    // 업그레이드 후 첫 샘플에 **수억 행이 삭제 대상**이 되어 포탈이 멈췄다(실제 운영 장애).
    // 과거 데이터를 대량으로 지우는 동작은 **운영자가 설정 화면에서 명시적으로 켜야** 한다 —
    // 업그레이드가 조용히 시작할 일이 아니다. 삭제 자체는 이제 청크로 양보하지만(util/chunkedPrune.js),
    // 기본값으로 켜지 않는다는 원칙은 유지한다. 용량이 '더 늘지 않게' 하는 dead-band 는 기본 동작이다.
    rawRetentionDays: Number(process.env.TEMP_RAW_RETENTION_DAYS) || 0,
  },
  ping: {
    // 네트워크 Ping 모니터링 — 등록한 대상(호스트)의 도달성/지연(RTT)을 주기적으로 측정해
    // 별도 SQLite(ping-monitor.db)에 시계열로 저장한다. iDRAC/온도 DB와 동일 정책(WAL 등).
    // CONFIG_DIR에 두어 업그레이드에도 이력이 보존된다. 대상 정의는 CONFIG_DIR/ping-targets.json.
    enabled: process.env.PING_MON_ENABLED !== 'false',
    dbPath: process.env.PING_DB_PATH || dbFile('ping-monitor.db'),
    pollIntervalMs: clampIntervalMs(numEnv(process.env.PING_MON_INTERVAL_MS, 60_000), 60_000, 5_000), // 기본 1분
    timeoutMs: numEnv(process.env.PING_MON_TIMEOUT_MS, 2_500),
    // 동시에 프로브할 대상 수 상한(고RTT·다수 대상에서 이벤트 루프/소켓 폭주 방지).
    concurrency: Math.max(1, numEnv(process.env.PING_MON_CONCURRENCY, 8)),
    retentionDays: retentionEnv(process.env.PING_MON_RETENTION_DAYS, 365), // ~1년
  },
  ipam: {
    // Shareable IP ledger DB (SQLite). Replaced on every refresh so external
    // programs can read the current per-center IP inventory. In CONFIG_DIR so
    // upgrades preserve it. Override with IPAM_DB_PATH.
    dbPath: process.env.IPAM_DB_PATH ||
      path.join(process.env.CONFIG_DIR || path.resolve(ROOT, 'config'), 'ipam.db'),
  },
  capacity: {
    // 리소스 적정성 진단(Capacity Advisor) — 포탈 서버 '호스트 자신'의 CPU/메모리/네트워크/
    // 디스크/이벤트루프를 상시 in-process 로 실측해 시계열(capacity.db)에 적재하고, 1일/1주/1달
    // 창별 통계로 증설·감축을 권고한다. 엣지는 자기 샘플을 중앙으로 push(k=agent명), 중앙은
    // 자기 것을 k='local' 로 적재해 한 DB 에서 함께 본다. CONFIG_DIR 에 두어 업그레이드에 보존.
    enabled: process.env.CAPACITY_MON_ENABLED !== 'false',
    dbPath: process.env.CAPACITY_DB_PATH || dbFile('capacity.db'),
    // 30초 샘플: 이벤트루프 지연·짧은 CPU 스파이크를 놓치지 않으면서 한 달 원본이 과하지 않게.
    sampleIntervalMs: clampIntervalMs(numEnv(process.env.CAPACITY_SAMPLE_INTERVAL_MS, 30_000), 30_000, 10_000),
    // 원본은 3일만(1일 창의 정확한 p95 계산용). 그 이상 창(1주/1달)은 시간당 롤업으로 본다.
    rawRetentionHours: Math.max(24, numEnv(process.env.CAPACITY_RAW_RETENTION_HOURS, 72)),
    // 시간당 롤업은 ~13개월 보존(1달 창 + 여유). 롤업 1행/시간이라 호스트당 연 ~8,760행으로 작다.
    rollupRetentionDays: Math.max(35, numEnv(process.env.CAPACITY_ROLLUP_RETENTION_DAYS, 400)),
    // 엣지 → 중앙 push. 엣지가 CENTRAL_URL·토큰을 갖췄을 때만 실제 기동(그 외 자기 것만 로컬 적재).
    push: process.env.CAPACITY_PUSH !== 'false',
    pushIntervalMs: clampIntervalMs(numEnv(process.env.CAPACITY_PUSH_INTERVAL_MS, 60_000), 60_000, 15_000),
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
    pullIntervalMs: offOrIntervalMs(numEnv(process.env.COLLECTOR_PULL_INTERVAL_MS, 60_000), 5_000),
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
  /**
   * 성능점검(svcmon) 역할 — 이 인스턴스가 점검을 **직접 실행하는지** 결정한다.
   *
   *  'central' : 점검을 실행하지 않는다. 대상·점검 정의를 여기서 관리해 엣지에 배포하고
   *              결과만 수신·표시한다. 고RTT 사이트를 중앙에서 찌르지 않으므로 응답시간
   *              판정이 RTT 에 오염되지 않는다(폴란드·미국동부 800ms+).
   *  'edge'    : 점검을 실행한다. 정의는 중앙에서 받아 적용하고 결과를 중앙에 push 한다.
   *  'both'    : 직접 실행 + (중앙이면) 수신. 엣지가 없는 단일 사이트 설치용 **기존 동작**.
   *
   * 기본값을 'both' 로 두는 이유: 업그레이드로 기존 단일 사이트 설치의 감시가 조용히
   * 멈추면 안 된다. 중앙·엣지 분리 배포에서는 각 인스턴스에 명시적으로 지정한다.
   * `SVCMON_ENABLED=false` 는 여전히 전체 킬스위치다(역할과 무관하게 폴러 미기동).
   */
  svcmonRole: (() => {
    const raw = String(process.env.SVCMON_ROLE || '').trim().toLowerCase();
    return ['central', 'edge', 'both'].includes(raw) ? raw : 'both';
  })(),
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
    scanIntervalMs: clampIntervalMs(Number(process.env.AGENT_SCAN_INTERVAL_MS) || 3_600_000, 3_600_000, 60_000),
    // Auto-register discovered iDRACs into this agent's local registry so it
    // begins collecting their power immediately.
    autoRegister: process.env.AGENT_AUTO_REGISTER !== 'false',
    // 사이트 위임 수집: 이 서버가 자기 로컬 vCenter 인벤토리를 수집해 중앙으로 push.
    // 고RTT 원격 사이트의 vCenter 수집을 현장 서버가 전담하게 해 중앙↔vCenter RTT를 제거.
    // EDGE_MODE=all 이면 기본 on(AGENT_PUSH_INVENTORY=false로 명시적 off 가능).
    pushInventory: EDGE_ALL ? process.env.AGENT_PUSH_INVENTORY !== 'false' : process.env.AGENT_PUSH_INVENTORY === 'true',
    inventoryIntervalMs: clampIntervalMs(Number(process.env.AGENT_INVENTORY_INTERVAL_MS) || 60_000, 60_000, 5_000),
    // 게스트 디스크 회수 리포트(v2.466): 중앙은 site 모드 vCenter 에 직접 접속하지 않으므로
    // guest.disk(게스트 파티션 할당/사용)를 라이브 조회할 수 없다. 엣지가 로컬 vCenter 의
    // guest.disk 를 수집해 중앙으로 push 해야 리포트가 site vCenter 도 덮는다.
    // 인벤토리 push 가 켜진 사이트에서 기본 on(AGENT_PUSH_GUESTDISK=false 로 off).
    // 게스트 파티션은 천천히 변하므로 주기는 길게(기본 12h) — 인벤토리 주기(60초)와 별도.
    // 명시 지정(env 존재)이 최우선, 미지정이면 EDGE_ALL + 인벤토리 push 켜짐일 때만 기본 on.
    pushGuestDisk: process.env.AGENT_PUSH_GUESTDISK != null
      ? process.env.AGENT_PUSH_GUESTDISK !== 'false'
      : (EDGE_ALL && process.env.AGENT_PUSH_INVENTORY !== 'false'),
    guestDiskIntervalMs: clampIntervalMs(Number(process.env.AGENT_GUESTDISK_INTERVAL_MS) || 43_200_000, 43_200_000, 60_000), // 12h
    // 실시간 스파이크 수집(v2.510): site 위임 vCenter 의 20초 표본은 엣지만 받을 수 있으므로 엣지의
    // vmseries 폴러가 저장한 같은 주기 결과를 중앙에 push 한다. 게스트 디스크와 같은 기본 규칙
    // (명시 env 최우선, 미지정이면 EDGE_ALL + 인벤토리 push 켜짐일 때만 on). 주기는 vmseries 설정을 따른다.
    pushVmSeries: process.env.AGENT_PUSH_VMSERIES != null
      ? process.env.AGENT_PUSH_VMSERIES !== 'false'
      : (EDGE_ALL && process.env.AGENT_PUSH_INVENTORY !== 'false'),
    // '현재 사용자'(v2.520): site 위임 vCenter 의 config.extraConfig 는 중앙이 읽을 수 없으므로
    // 엣지의 curuser 폴러가 읽은 결과를 push 한다. 위와 같은 기본 규칙(명시 env 최우선,
    // 미지정이면 EDGE_ALL + 인벤토리 push 켜짐일 때만 on). 주기는 curuser 설정을 따른다.
    pushCurUser: process.env.AGENT_PUSH_CURUSER != null
      ? process.env.AGENT_PUSH_CURUSER !== 'false'
      : (EDGE_ALL && process.env.AGENT_PUSH_INVENTORY !== 'false'),
  },
  auth: {
    enabled: process.env.AUTH_ENABLED !== 'false',
    // Signing secret for session tokens. Set AUTH_SECRET in production so
    // tokens survive restarts; otherwise a random per-process secret is used.
    secret: process.env.AUTH_SECRET || '',
    // Token lifetime, e.g. "8h", "30m", "7d", or seconds.
    tokenTtl: process.env.AUTH_TOKEN_TTL || '8h',
    // Default seed admin password when no users.json exists (demo convenience).
    defaultAdminPassword: process.env.DEFAULT_ADMIN_PASSWORD || '', // v2.591 P1: 고정 기본값 없음(비면 auth.js 가 임의 생성)
    // Issuer label shown in Google Authenticator when enrolling TOTP.
    totpIssuer: process.env.TOTP_ISSUER || 'VMware Portal',
  },
  // 서비스 허브(pyportal) 주소. 설정하면 특수 기능에 '서비스 허브' 바로가기가 나타난다.
  // 별도 프로세스·별도 포트로 도는 포탈이라 하드코딩하지 않고 env 로 받는다.
  // 인증된 응답(/auth/me·로그인)에서만 내려준다 — 미인증 응답에 내부 주소를 싣지 않는다.
  serviceHubUrl: (process.env.SERVICE_HUB_URL || '').trim().replace(/\/+$/, ''),
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
    pollIntervalMs: numEnv(process.env.UPGRADE_POLL_INTERVAL_MS,
      EDGE_ALL && EDGE_CENTRAL_URL ? 3_600_000 : 0),
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

/**
 * Current running version, read from the repo root package.json.
 * v2.581(TUNE-E): **1회 읽고 메모한다** — 런타임 계측(fs 훅)에서 이 함수가 분당 19회 디스크를 읽고 있었다
 * (엣지 push·자기등록·health 응답이 매번 부른다). 버전은 프로세스 수명 동안 바뀌지 않는다 — 업그레이드는
 * 프로세스를 재시작한다(`upgrade/manager.js`). 읽기 실패('0.0.0')는 메모하지 않는다(다음 호출이 다시 시도).
 */
let _versionMemo = null;
export function currentVersion() {
  if (_versionMemo) return _versionMemo;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(ROOT, '..', 'package.json'), 'utf8'));
    const v = pkg.version || '0.0.0';
    if (v !== '0.0.0') _versionMemo = v;
    return v;
  } catch {
    return '0.0.0';
  }
}

/**
 * Load the list of vCenters to monitor.
 * Falls back to vcenters.example.json so the portal works out of the box.
 */
// secretVault 지연 로드(순환 import 회피) — 로드 완료 전 호출되면 평문 그대로 반환한다.
// 기동 시퀀스상 첫 수집은 항상 이 import 완료 후이므로(비동기 폴러) 실질 공백은 없다.
let openSecretsDeepRef = null;
// v2.479(감사 코어 B-2): 이 import 는 index.js 최상위 코드가 끝난 뒤에야 완료되므로, 동기 호출되는 첫 store.refresh 는
// 암호화 모드에서 봉인문(암호문) 비밀번호로 vCenter 로그인을 시도했다(재시작마다 전 vCenter 1회 실패). store.start 가
// secretsReady 를 기다린 뒤 첫 수집을 돌린다.
export const secretsReady = import('./security/secretVault.js').then((m) => { openSecretsDeepRef = m.openSecretsDeep; }).catch(() => {});

/**
 * 번들 예제 템플릿(vcenters.example.json)으로 폴백할지(v2.444).
 *
 * 사고: 신규 배포한 IRS 엣지들이 vCenter 를 아직 등록하지 않은 상태에서 이 템플릿으로 폴백해
 * `vc-us-east` · `vc-ap-northeast` 같은 **가짜 vCenter 를 실제로 수집 시도**했고(접속 실패 →
 * 호스트 0·VM 0), 그 빈 슬라이스를 중앙에 push 해 중앙 vCenter 목록이 오염됐다. 화면상
 * 6개 사이트가 똑같은 'vc-ap-northeast' 를 보내고 있었다 — 전부 같은 템플릿을 읽은 것이다.
 *
 * 이 폴백은 원래 데모 편의('works out of the box')였는데, **mock 모드는 이 목록을 쓰지 않는다**
 * (store.js 가 mock 이면 generateSnapshot 으로 즉시 반환). 즉 폴백은 live/auto 에서만 일어나고
 * 거기서는 순수한 사고 원인이다. 그래서 기본을 '폴백 안 함' 으로 바꾼다.
 * 데모로 되살리려면 `VCENTERS_EXAMPLE_FALLBACK=true`.
 */
const EXAMPLE_FALLBACK = process.env.VCENTERS_EXAMPLE_FALLBACK === 'true';
let warnedExample = false;

export function loadVcenterConfig() {
  const candidates = [
    path.join(process.env.CONFIG_DIR || path.resolve(ROOT, 'config'), 'vcenters.json'),
    path.resolve(ROOT, 'config', 'vcenters.json'),           // legacy in-app location
    // 번들 템플릿은 명시적으로 켰을 때만(v2.444) — 기본은 '등록 없으면 빈 목록'.
    ...(EXAMPLE_FALLBACK ? [path.resolve(ROOT, 'config', 'vcenters.example.json')] : []),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(parsed?.vcenters)) {
          // host에 스킴(http/https)이 없으면 https:// 보강 — fetch 'unknown scheme' 방지.
          const vcenters = parsed.vcenters.map((v) => (v && v.host && !/^https?:\/\//i.test(String(v.host))
            ? { ...v, host: `https://${String(v.host).trim()}` } : v));
          // 자격증명 저장 방식(평문/암호화, v2.296): 이 함수는 vcenter/registry.js 를 우회해
          // vcenters.json 을 직접 읽는 수집 핵심 경로다 — 암호화 모드에서 복호를 빠뜨리면
          // 모든 vCenter 로그인이 암호문 비번으로 실패한다. 지연 import 로 순환을 피한다
          // (secretVault 도 config 를 import — 상단 정적 import 시 TDZ 기동 실패).
          if (file.endsWith('vcenters.example.json') && !warnedExample) {
            warnedExample = true;
            console.warn('[config] ⚠ vCenter 가 등록되지 않아 **예제 템플릿**(vcenters.example.json)을 읽었습니다 — vc-us-east 같은 가짜 vCenter 를 수집 시도하고 중앙에 빈 인벤토리를 보냅니다. 설정 › vCenter 관리에서 실제 vCenter 를 등록하세요(이 폴백은 VCENTERS_EXAMPLE_FALLBACK=true 로 켜져 있습니다).');
          }
          return { file, vcenters: openSecretsDeepRef ? openSecretsDeepRef(vcenters) : vcenters };
        }
      } catch (err) {
        console.error(`[config] Failed to parse ${file}: ${err.message}`);
      }
    }
  }
  return { file: null, vcenters: [] };
}
