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
  'storage/intervals.js': { '[dyn]': '검사됨 — 유한 양수 + 키별 min · max' },
  'pdu/intervals.js': { '[dyn]': '검사됨 — 다음 줄 Math.min(MAX_MS, Math.max(min, …))' },
  'collector/state.js': { POWER_CURRENT_STALE_MS: '검사됨 — Number.isFinite && > 0(비교 전용 경계)' },
  'idrac/roomTemp.js': { ROOMTEMP_STALE_CAP_MS: '검사됨 — Number.isFinite && > 0 + 24시간 상한' },
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
  // ── 102회차: 별칭(`env.X`) · 지역 변수(`const raw = process.env.X`) 꼴 — 스윕을 넓히며 드러난 것(전부 바로 뒤에 검사가 있다) ──
  'rma/agent.js': { RMA_PRIORITY: '검사됨 — Number.isFinite + 빈 값 제외(우선순위는 음수도 값)' },
  'util/exportBusy.js': { EXPORT_LOCK_MAX_MS: '검사됨 — Number.isFinite && > 0 + 상 · 하한' },
  'routes/admin/idracTrend.js': { IDRAC_TREND_RETENTION_DAYS: '검사됨 — Number.isFinite && ≥ 1 + 3650 상한' },
  'bmstor/history.js': { BMSTOR_HISTORY_INTERVAL_HOURS: '검사됨 — 빈 값 제외 + Number.isFinite + 1~24', BMSTOR_HISTORY_RETENTION_DAYS: '검사됨 — Number.isFinite && ≥ 0(0 = 전부 보관이 의미)' },
  'routes/central.js': { CENTRAL_INVENTORY_OWNER_HANDOVER_HOURS: '검사됨 — 빈 값 제외 + Number.isFinite && > 0(0 · 음수 = 인계 안 함이 의미)' },
  // (담당 밖 줄은 100 · 102회차에 모두 고쳐 지웠다 — 새로 담당 밖으로 넘길 때는 사유와 함께 다시 쓴다)
};

const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
};
/*
 * 102회차: 스윕을 넓혔다 — 예전 정규식은 `process.env` 를 글자 그대로 쓴 꼴만 봐서 다음을 놓쳤다(실제로 남아 있던 결함 포함).
 *   · 별칭: `const env = process.env; Number(env.X)`(rma/agent.js RMA_CRED_CACHE_MS — Infinity 면 받은 비밀을 영원히 캐시) ·
 *     `function f(env = process.env) { Number(env.X) }`.
 *   · 지역 변수: `const raw = process.env.X; … Number(raw)`(util/soapParsePool.js SOAP_PARSE_WORKERS — Infinity 면 워커를 끝없이 만들며 멈췄다).
 *     선언 뒤 LOCAL_SPAN 줄 안의 `Number(raw)` 만 본다(같은 파일의 무관한 `Number(v)` 를 잡지 않게).
 *   · 구조 분해: `const { X, Y: y } = process.env` 뒤의 `Number(X)` · `Number(y)`.
 *   · `Number.parseInt` · `Number.parseFloat`.
 */
const NUM_FN = String.raw`(?:Number(?:\.parse(?:Int|Float))?|parseInt|parseFloat)\(\s*`;
const LOCAL_SPAN = 8;
const esc = (x) => x.replace(/[$]/g, '\\$&');

/** 파일 본문(주석 제거 뒤) → [{ key, line, text }] — 범위가 닫힌 것(clampIntervalMs 안 · 같은 줄 Math.max + Math.min)은 뺀다. */
export function envNumberSitesOf(text) {
  const aliases = ['process\\.env'];
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*process\.env(?!\s*[.[\w$])/g)) if (m[1] !== 'process') aliases.push(esc(m[1]));
  const alias = aliases.join('|');
  const re = new RegExp(`${NUM_FN}(?:${alias})(?:\\.([A-Z0-9_]+)|\\[)|\\+\\s*(?:${alias})\\.([A-Z0-9_]+)`, 'g');
  const lines = text.split('\n');
  const locals = [];   // { name, key, from, to } — 지역 이름이 env 값을 담은 줄 범위
  lines.forEach((ln, i) => {
    for (const m of ln.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*process\.env\.([A-Z0-9_]+)\s*(?:;|$)/g)) locals.push({ name: m[1], key: m[2], from: i, to: i + LOCAL_SPAN });
    for (const m of ln.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*process\.env\b/g)) {
      for (const part of m[1].split(',')) {
        const [k, v] = part.split(':').map((x) => x.trim().replace(/\s*=.*$/, ''));
        if (/^[A-Z][A-Z0-9_]*$/.test(k)) locals.push({ name: v || k, key: k, from: i, to: lines.length });
      }
    }
  });
  const out = [];
  lines.forEach((ln, i) => {
    const hits = [...ln.matchAll(re)].map((m) => ({ key: m[1] || m[2] || '[dyn]', at: m.index }));
    for (const l of locals) {
      if (i < l.from || i > l.to) continue;
      for (const m of ln.matchAll(new RegExp(`${NUM_FN}${esc(l.name)}\\s*[,)]`, 'g'))) hits.push({ key: l.key, at: m.index });
    }
    for (const { key, at } of hits) {
      const before = ln.slice(0, at);
      if (/(?:clampIntervalMs|offOrIntervalMs)\(\s*$/.test(before)) continue;     // 상 · 하한 + 비유한 → 기본값
      if (/Math\.max\(/.test(ln) && /Math\.min\(/.test(ln)) continue;             // 같은 줄에서 범위가 닫혔다
      out.push({ key, line: i + 1, text: ln.trim().slice(0, 160) });
    }
  });
  return out;
}

function rawEnvNumberSites() {
  const out = [];
  for (const f of walk(SRC)) {
    const rel = path.relative(SRC, f).replace(/\\/g, '/');
    if (rel.startsWith('intro/vendor/')) continue;   // 번들된 외부 라이브러리(우리 코드 아님)
    for (const site of envNumberSitesOf(stripComments(fs.readFileSync(f, 'utf8')))) out.push({ rel, ...site });
  }
  return out;
}

test('102 ① 스윕이 별칭 · 지역 변수 · 구조 분해 · Number.parseInt 꼴도 잡는다(넓힌 정규식 자체 시험)', () => {
  const keys = (t) => envNumberSitesOf(t).map((x) => x.key);
  assert.deepEqual(keys('const env = process.env;\nconst A = Math.max(0, Number(env.RMA_X) || 5);'), ['RMA_X']);
  assert.deepEqual(keys('export function f(env = process.env) {\n  const n = Number(env.EXP_Y);\n}'), ['EXP_Y']);
  assert.deepEqual(keys('const W = (() => {\n  const env = process.env.SOAP_W;\n  if (env) return Math.max(0, Number(env) || 0);\n})();'), ['SOAP_W']);
  assert.deepEqual(keys('const { PORT_A, B_MS: b } = process.env;\nconst p = parseInt(PORT_A, 10);\nconst q = Number(b);'), ['PORT_A', 'B_MS']);
  assert.deepEqual(keys('const z = Number.parseInt(process.env.Z_N, 10);'), ['Z_N']);
  assert.deepEqual(keys('const v = process.env.FAR;\n' + '\n'.repeat(LOCAL_SPAN + 2) + 'const k = Number(v);'), [], '선언에서 멀리 떨어진 같은 이름은 env 가 아니다');
  assert.deepEqual(keys('const k = Math.min(9, Math.max(1, Number(process.env.CLOSED) || 4));'), [], '같은 줄에서 범위가 닫힌 것은 통과');
  assert.deepEqual(keys('const k = clampIntervalMs(Number(process.env.IV_MS) || 1000, 1000);'), [], 'clampIntervalMs 안은 통과');
  assert.deepEqual(keys('const k = envPositive(process.env.OK_N, 5);'), [], '공용 해석기는 통과');
});

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
