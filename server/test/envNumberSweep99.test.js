/**
 * 전체 점검 99회차 — 공통 스윕: 환경 변수 수치 해석(`Number(process.env.X) || 기본값`).
 *
 * 그 꼴은 빈 값 · 0 · 숫자 아님만 기본값으로 보내고 **Infinity · '1e400' · 음수 · 2^31 초과**를 그대로 통과시킨다.
 * `Math.max(하한, …)` 로 감싸도 Infinity 는 그대로라 상한 · 보존일 · 보류 시한이 '무한' 이 된다(57 · 58 · 74 · 76회차에서 개별로 고친 계열).
 * 99회차에 남은 110곳을 공용 해석기(`util/envNumber.js envPositive` — 시한은 `{ max: ENV_INT_MAX }`)로 바꿨다. 재현(수정 전):
 *   · ROOMTEMP_STALE_MS=-1 → DEFAULT_MAX_AGE_MS −1 → `effectiveMaxAgeMs` 가 '0 이하 = 검사 끔' 으로 읽어 죽은 서버의 마지막 온도를 '현재' 로 썼다.
 *   · CENTRAL_PDU_TTL_MS=-1 → 경계가 미래가 되어 엣지 PDU 보고가 받자마자 전부 만료 · Infinity 면 영원히 만료 안 됨.
 *   · AGENT_FLEET_WITHHOLD_MAX_MS · PDU_PUSH_WITHHOLD_MAX_MS=Infinity → 보류(withhold) 시한이 사라진다(루트 규칙 '보류에는 반드시 시한').
 *   · SVCMON_XLSX_MAX_UNCOMPRESSED_BYTES=Infinity → xlsx 압축 폭탄 상한이 꺼진다 · RMA_MAX_OUTPUT=-1 → 출력 상한이 음수.
 *   · NSX_LIST_MAX_PAGES=Infinity → 페이지 반복 상한이 꺼진다 · RMA_TEST_ALERT_STREAK=Infinity → 연속 실패 알림이 영영 안 뜬다.
 *   · VC_KEEPALIVE_MS=-1 · Infinity → undici 가 'invalid keepAliveTimeout' 을 던져 vCenter REST 요청이 전부 실패한다.
 *   · SANSW_TEST_PICKUP_MS=3e9 → setTimeout 이 1ms 로 바뀌어 SAN 연결 테스트가 즉시 '엣지 응답 없음'.
 *
 * ① 스윕: 서버 소스의 `Number(process.env…)` · `parseInt/parseFloat(process.env…)` · `+process.env.X` 는
 *    `clampIntervalMs(` / `offOrIntervalMs(` 안이거나 같은 줄에 `Math.max` + `Math.min` 이 둘 다 있어 범위가 닫힌 것만 자동 통과,
 *    그 밖은 아래 허용 목록(사유)에 있어야 한다 — 새 파일이 공용 해석기 없이 쓰면 실패한다.
 * ② 동작: 위험한 값(Infinity · −5 · 1e400 · 숫자 아님, 시한은 3e9 도)을 준 자식 프로세스의 상수가 **기본값과 같고**,
 *    정상 값은 그대로 통과하는지(의미 보존) 실제 모듈을 불러 대조한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripComments } from './_stripComments.js';
import { envPositive, ENV_INT_MAX } from '../src/util/envNumber.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

/*
 * 허용 목록 — 파일 → { 키: 사유 }. 사유 분류:
 *   검사됨  : 바로 뒤에 Number.isFinite · > 0 · 상하한 검사가 따라온다(이 줄만 보면 감싸지 않은 것처럼 보일 뿐).
 *   의미 0  : 0 · 음수가 의미(끔)라 envPositive 로 바꾸면 의미가 바뀐다.
 *   담당 밖 : 99회차에 다른 회차가 고치던 파일 · 공용 파일(util · store) — 제안으로 넘겼다. 고치면 이 줄을 지운다.
 *   표시/정책: 결과가 화면 문구 · 정책 수치에만 쓰여 상한 무력화 · 시한 오류로 이어지지 않는다.
 * '[dyn]' = `process.env[k]` 동적 조회(지역 도우미).
 */
const ALLOW = {
  'agent/edgeLogWorker.js': { AGENT_EDGELOG_POLL_MS: '검사됨 — 0 = 끔, 그 밖은 clampIntervalMs' },
  'agent/svcmonConfigPull.js': { '[dyn]': '검사됨 — envNum: 유한 양수만(시한 아닌 개수 · 주기는 호출부 clamp)' },
  'agent/svcmonPush.js': { '[dyn]': '검사됨 — envNum: 유한 양수만' },
  'agent/vmCloneWorker.js': { '[dyn]': '검사됨 — envNum: 유한 양수만' },
  'central/svcmonEdge.js': { '[dyn]': '검사됨 — envNum: 유한 양수만' },
  'central/svcmonSilence.js': { '[dyn]': '검사됨 — envNum: 유한 양수만' },
  'svcmon/trial.js': { '[dyn]': '검사됨 — envNum: 유한 양수만' },
  'svcmon/pool.js': { '[dyn]': '검사됨 — envNum: 유한 수 + 호출부 Math.max 하한(SVCMON_WORKERS 0 = 인프로세스가 의미). 상한 없음은 제안' },
  'svcmon/poller.js': { '[dyn]': '검사됨 — envNum: 유한 수 + clampIntervalMs · Math.max 하한' },
  'storage/intervals.js': { '[dyn]': '검사됨 — 유한 양수 + 키별 min · max' },
  'pdu/intervals.js': { '[dyn]': '검사됨 — 다음 줄 Math.min(MAX_MS, Math.max(min, …))' },
  'collector/state.js': { POWER_CURRENT_STALE_MS: '검사됨 — Number.isFinite && > 0(비교 전용 경계)' },
  'idrac/roomTemp.js': { ROOMTEMP_STALE_CAP_MS: '검사됨 — Number.isFinite && > 0 + 24시간 상한' },
  'ipam/db.js': {
    IPAM_DB_LOCK_RETRY_MS: '검사됨 — > 0 일 때만(Infinity 는 제안)',
    IPAM_WRITE_MIN_ROWS: "의미 0 — '0' 이면 항상 오프로드(행 수 비교 문턱). 숫자 아님 → NaN 은 제안",
  },
  'upgrade/fetchPackage.js': { UPGRADE_PACKAGE_MAX_BYTES: '검사됨 — Number.isFinite && > 0(2GB 넘는 번들 상한이 정당해 ENV_INT_MAX 를 걸지 않는다)' },
  'veeam/em/client.js': { VEEAM_EM_VM_BUDGET_MS: '검사됨 — Number.isFinite && ≥ 10초 + 10분 상한' },
  'vmtrack/db.js': { VMTRACK_RETENTION_DAYS: '검사됨 — pruneVmtrack 첫 줄이 numOrNull · > 0 아니면 정리를 건너뛴다' },
  'index.js': { TRUST_PROXY: '검사됨 — /^\\d+$/ 일 때만 수(홉 수), 그 밖은 문자열 그대로' },
  'mock/demo/bareos.js': { BAREOS_DEMO_RUN_MS: '검사됨(데모 전용)', BAREOS_DEMO_CANCEL_MS: '검사됨(데모 전용)' },
  'config.js': {
    PORT: '결정 필요 — 범위 밖 포트는 지금 listen 이 던져 기동이 멈춘다(드러난 실패). envPort 로 바꾸면 조용히 4000 이 된다',
    IDRAC_RAW_RETENTION_DAYS: '의미 0 — 0 이하 = 롤업과 같은 기준(store.js `> 0` 검사)',
    TEMP_RAW_RETENTION_DAYS: '의미 0 — 0 이하 = 롤업과 같은 기준',
    OME_POWER_DURATION: '의미 0 — 0 = OME 기본 구간(장비에 그대로 넘긴다)',
  },
  'routes/api/toolsCapacity.js': {
    RIGHTSIZE_HEADROOM_PCT: '표시/정책 — tools/rightsize.js 정책 병합(시한 · 상한 아님)',
    RIGHTSIZE_MIN_DAYS: '표시/정책', RIGHTSIZE_MIN_COVERAGE_PCT: '표시/정책',
    RIGHTSIZE_CAP_REDUCTION_PCT: '표시/정책', RIGHTSIZE_READY_WARN_PCT: '표시/정책',
  },
  // ── 담당 밖(99회차에 다른 회차가 고치던 파일 · 공용 파일) — 고치면 줄을 지운다 ──
  'central/partFaultEdge.js': { PARTFAULT_EDGE_MAX_DEVICES: '담당 밖', PARTFAULT_EDGE_DEVICE_PART_MAX: '담당 밖', PARTFAULT_EDGE_REPORT_PART_MAX: '담당 밖' },
  'partfault/push.js': { PARTFAULT_PUSH_MAX_DEVICES: '담당 밖' },
  'partfault/scan.js': { PARTFAULT_INV_MAX_AGE_MS: '담당 밖' },
  'collector/registry.js': { CENTRAL_SELF_REGISTER_MAX: '담당 밖', CENTRAL_SELF_REGISTER_UNVERIFIED_MAX: '담당 밖' },
  'gpu/guestops.js': { GPU_GUEST_FILE_MAX_BYTES: '담당 밖' },
  'proxy/registry.js': { PROXY_SSH_PORT: '담당 밖(포트 — envPort 제안)', PROXY_PUBLIC_PORT_BASE: '담당 밖', GUACD_PORT: '담당 밖(포트 — envPort 제안)' },
  'routes/api/checksLogs.js': { VCLOGS_EXPORT_MAX_ROWS: '담당 밖' },
  'routes/api/hardwareGpu.js': { GPU_EXPORT_MAX_ROWS: '담당 밖' },
  'routes/api/partFaults.js': { PARTFAULT_INCIDENT_EVENT_MAX: '담당 밖' },
  'store.js': { COLLECT_CONCURRENCY: '담당 밖(공용) — Infinity 동시성 제안' },
  'util/loopLag.js': { LOOP_LAG_WARN_MS: '담당 밖(공용) — 로그 문턱' },
  'util/rateLimit.js': { API_RATE_LIMIT: '담당 밖(공용) — Infinity 면 속도 제한이 꺼진다(제안)', API_RATE_WINDOW_MS: '담당 밖(공용)' },
  'util/readCapped.js': { EDGE_EXPORT_MAX_BYTES: '담당 밖(공용) — Infinity 면 상한이 꺼진다(제안)', EDGE_RESPONSE_MAX_BYTES: '담당 밖(공용)' },
  'util/resilientFetch.js': { WAN_CONNECT_TIMEOUT_MS: "담당 밖(공용) — −1 · Infinity 면 undici 'invalid connectTimeout'(제안)", WAN_MAX_CONNECTIONS: '담당 밖(공용)' },
  'util/soapParsePool.js': { SOAP_PARSE_MIN_CHARS: '담당 밖(공용) — 숫자 아님 → NaN(제안)' },
};

const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
};
const RE = /(?:Number|parseInt|parseFloat)\(\s*process\.env(?:\.([A-Z0-9_]+)|\[)|\+\s*process\.env\.([A-Z0-9_]+)/g;

function rawEnvNumberSites() {
  const out = [];
  for (const f of walk(SRC)) {
    const rel = path.relative(SRC, f).replace(/\\/g, '/');
    const lines = stripComments(fs.readFileSync(f, 'utf8')).split('\n');
    lines.forEach((ln, i) => {
      for (const m of ln.matchAll(RE)) {
        const key = m[1] || m[2] || '[dyn]';
        const before = ln.slice(0, m.index);
        if (/(?:clampIntervalMs|offOrIntervalMs)\(\s*$/.test(before)) continue;     // 상 · 하한 + 비유한 → 기본값
        if (/Math\.max\(/.test(ln) && /Math\.min\(/.test(ln)) continue;             // 같은 줄에서 범위가 닫혔다
        out.push({ rel, key, line: i + 1, text: ln.trim().slice(0, 160) });
      }
    });
  }
  return out;
}

test('99 ① 스윕 — 범위가 닫히지 않은 env 수치 해석은 허용 목록(사유)에 있어야 한다', () => {
  const sites = rawEnvNumberSites();
  assert.ok(sites.length > 10, `스윕이 아무것도 못 찾았다(${sites.length}) — 정규식 · 주석 제거를 확인`);
  const bad = sites.filter((s) => !ALLOW[s.rel]?.[s.key]);
  assert.deepEqual(bad.map((s) => `${s.rel}:${s.line} ${s.key} — ${s.text}`), [],
    '새 env 수치는 util/envNumber.js envPositive(시한이면 { max: ENV_INT_MAX }) · clampIntervalMs 로 읽을 것 — 0 · 음수가 의미면 사유와 함께 허용 목록에');
});

test('99 ① 스윕 — 99회차에 고친 파일에는 감싸지 않은 env 수치가 남지 않는다', () => {
  const fixed = ['rma/exec.js', 'rma/testResults.js', 'rma/historyDb.js', 'rma/jobs.js', 'central/pduEdge.js', 'idrac/roomTemp.js',
    'idrac/service.js', 'idrac/ome.js', 'idrac/redfish.js', 'svcmon/formats.js', 'insights/dbHealth.js', 'nsx/client.js',
    'agent/fleetPush.js', 'agent/gpuGuestPush.js', 'pdu/push.js', 'pdu/db.js', 'pdu/poller.js', 'sanswitch/testRuns.js',
    'vcenter/restClient.js', 'vcenter/soapClient.js', 'bmusage/poller.js', 'bmusage/collectors/idracEnterprise.js', 'central/edgeRecord.js',
    'central/edgeLogStore.js', 'proxy/sshExec.js', 'storage/collectors/powerstore.js', 'bmstor/collect.js', 'routes/central/pduSanRoutes.js'];
  const left = rawEnvNumberSites().filter((s) => fixed.includes(s.rel) && !ALLOW[s.rel]?.[s.key]);
  assert.deepEqual(left.map((s) => `${s.rel}:${s.line} ${s.key}`), []);
});

test('99 — 공용 해석기 규칙(이 회차가 기대는 성질)', () => {
  for (const bad of ['Infinity', '-Infinity', '1e400', '-5', '0', '', 'abc', '  ', undefined, null, '-0.5']) {
    assert.equal(envPositive(bad, 77), 77, `envPositive(${JSON.stringify(bad)})`);
  }
  assert.equal(envPositive('3000000000', 77, { max: ENV_INT_MAX }), 77, '시한은 2^31−1 을 넘으면 기본값(setTimeout 이 1ms 로 바꾼다)');
  assert.equal(envPositive('3000000000', 77), 3_000_000_000, '비교 전용 경계 · 바이트 상한은 큰 유한값을 그대로(의미 보존)');
  assert.equal(envPositive('2500.9', 77), 2500);
  assert.equal(envPositive('1500', 77, { max: Math.floor(ENV_INT_MAX / 2) }), 1500);
  assert.equal(setTimeoutOverflowFires(), true, 'Node 가 2^31 초과 지연을 1ms 로 바꾼다는 전제(바뀌면 시한 max 근거를 다시 볼 것)');
});

function setTimeoutOverflowFires() {
  const r = spawnSync(process.execPath, ['-e', 'const t0 = Date.now(); setTimeout(() => { console.log(Date.now() - t0 < 1000 ? "fast" : "slow"); process.exit(0); }, 3e9); setTimeout(() => { console.log("slow"); process.exit(0); }, 1500).unref?.();'],
    { encoding: 'utf8', timeout: 10_000, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  return r.stdout.trim() === 'fast';
}

// ── ② 실제 모듈 — 위험한 값이면 기본값, 정상 값은 그대로 ─────────────────────────────
// [모듈, 내보낸 이름, env 키, 시한(2^31 초과도 기본값이어야 함)]
const PROBES = [
  ['rma/exec.js', 'DEFAULT_MAX_OUTPUT', 'RMA_MAX_OUTPUT', false],
  ['svcmon/formats.js', 'XLSX_MAX_UNCOMPRESSED', 'SVCMON_XLSX_MAX_UNCOMPRESSED_BYTES', false],
  ['idrac/roomTemp.js', 'DEFAULT_MAX_AGE_MS', 'ROOMTEMP_STALE_MS', false],
  ['nsx/client.js', 'NSX_LIST_MAX_PAGES', 'NSX_LIST_MAX_PAGES', false],
  ['agent/fleetPush.js', 'FLEET_WITHHOLD_MAX_MS', 'AGENT_FLEET_WITHHOLD_MAX_MS', false],
  ['agent/gpuGuestPush.js', 'GPU_GUEST_PUSH_WITHHOLD_MAX_MS', 'AGENT_GPU_GUEST_WITHHOLD_MAX_MS', false],
  ['pdu/push.js', 'PDU_PUSH_WITHHOLD_MAX_MS', 'PDU_PUSH_WITHHOLD_MAX_MS', false],
  ['rma/jobs.js', 'HEARTBEAT_MAX_INSTANCES', 'RMA_MAX_INSTANCES_PER_AGENT', false],
  ['rma/jobs.js', 'HEARTBEAT_PURGE_MS', 'RMA_HEARTBEAT_PURGE_MS', false],
  ['central/edgeRecord.js', 'EDGE_AGENT_MAX_BYTES', 'CENTRAL_EDGE_AGENT_MAX_BYTES', false],
  ['central/edgeRecord.js', 'EDGE_AGENT_EVICT_MS', 'CENTRAL_EDGE_AGENT_EVICT_MS', false],
  ['bmusage/collectors/idracEnterprise.js', 'SESSION_BUDGET_MS', 'BMUSAGE_ENT_BUDGET_MS', true],
  ['bmusage/collectors/idracEnterprise.js', 'API_SLICE_MS', 'BMUSAGE_ENT_API_MS', true],
  ['portalcheck/tokenProbe.js', 'PROBE_TIMEOUT_MS', 'PORTALCHECK_TIMEOUT_MS', true],
  ['portalcheck/tokenProbe.js', 'PROBE_CONCURRENCY', 'PORTALCHECK_CONCURRENCY', false],
  ['xferspeed/serve.js', 'XFER_TEST_MAX_BYTES', 'XFER_TEST_MAX_BYTES', false],
  ['proxy/sshExec.js', 'EXEC_MAX_OUTPUT', 'SSH_EXEC_MAX_OUTPUT', false],
  ['collector/remoteInventory.js', 'REMOTE_SERVERS_MAX', 'COLLECTOR_REMOTE_SERVERS_MAX', false],
  ['linkcheck/db.js', 'DETAIL_MAX_BYTES', 'LINKCHECK_DETAIL_MAX', false],
  ['cvp/client.js', 'BODY_MAX_BYTES', 'CVP_BODY_MAX_BYTES', false],
  ['bmusage/notify.js', 'MAX_SEND', 'BMUSAGE_ALERT_MAX', false],
];

function readConstants(envOverrides) {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'env99-'));
  try {
    const mods = [...new Set(PROBES.map((p) => p[0]))];
    const script = `
      const out = {};
      for (const m of ${JSON.stringify(mods)}) {
        const mod = await import(${JSON.stringify(pathToFileURL(SRC).href)} + '/' + m);
        for (const [f, name] of ${JSON.stringify(PROBES.map((p) => [p[0], p[1]]))}) if (f === m) out[m + ':' + name] = String(mod[name]);
      }
      process.stdout.write('@@' + JSON.stringify(out) + '@@');
      process.exit(0);`;
    const env = { ...process.env, CONFIG_DIR: cfg, DATA_DIR: cfg, NODE_NO_WARNINGS: '1' };
    for (const p of PROBES) delete env[p[2]];
    Object.assign(env, envOverrides);
    const r = spawnSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', script], { encoding: 'utf8', env, timeout: 90_000 });
    const m = /@@(.*)@@/s.exec(r.stdout || '');
    assert.ok(m, `자식 프로세스 실패(${r.status}): ${(r.stderr || '').slice(-800)}`);
    return JSON.parse(m[1]);
  } finally { fs.rmSync(cfg, { recursive: true, force: true }); }
}

test('99 ② 실제 모듈 — Infinity · −5 · 1e400 · 숫자 아님(시한은 3e9 도)은 기본값과 같다', { timeout: 300_000 }, () => {
  const base = readConstants({});
  for (const [k, v] of Object.entries(base)) assert.ok(Number(v) > 0 && Number.isFinite(Number(v)), `기본값이 유한 양수가 아니다: ${k}=${v}`);
  for (const bad of ['Infinity', '-5', '1e400', 'abc']) {
    const got = readConstants(Object.fromEntries(PROBES.map((p) => [p[2], bad])));
    const diff = PROBES.filter((p) => got[`${p[0]}:${p[1]}`] !== base[`${p[0]}:${p[1]}`]).map((p) => `${p[2]}=${bad} → ${p[1]} ${got[`${p[0]}:${p[1]}`]}(기본 ${base[`${p[0]}:${p[1]}`]})`);
    assert.deepEqual(diff, [], `위험한 값 ${bad}`);
  }
  const timers = PROBES.filter((p) => p[3]);
  const big = readConstants(Object.fromEntries(timers.map((p) => [p[2], '3000000000'])));
  const diff = timers.filter((p) => big[`${p[0]}:${p[1]}`] !== base[`${p[0]}:${p[1]}`]).map((p) => `${p[2]}=3e9 → ${big[`${p[0]}:${p[1]}`]}`);
  assert.deepEqual(diff, [], '시한 env 가 2^31−1 을 넘으면 기본값(setTimeout 1ms 함정)');
});

test('99 ② 실제 모듈 — 정상 값은 그대로 통과한다(의미 보존)', { timeout: 120_000 }, () => {
  const base = readConstants({});
  const want = {};
  const env = {};
  for (const p of PROBES) {
    const b = Number(base[`${p[0]}:${p[1]}`]);
    // 기본값의 두 배(하한 위 · 시한 상한 안)를 주고 그 값이 그대로 오는지 — 하한(Math.max)이 있는 상수도 두 배는 하한 위다.
    const v = b * 2;
    if (env[p[2]] != null && env[p[2]] !== String(v)) continue;   // 같은 키를 두 상수가 쓰면 첫 것만
    env[p[2]] = String(v); want[`${p[0]}:${p[1]}`] = String(v);
  }
  const got = readConstants(env);
  const diff = Object.keys(want).filter((k) => got[k] !== want[k]).map((k) => `${k} ${got[k]} ≠ ${want[k]}`);
  assert.deepEqual(diff, []);
});
