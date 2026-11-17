/**
 * 전체 점검 102회차 — env 수치 스윕 잔여(99회차가 공용 · 담당 밖으로 남긴 것).
 *
 * 재현(수정 전):
 *   · WAN_CONNECT_TIMEOUT_MS=-1 → undici Agent 가 검사 없이 연결 시한 타이머(약 0.5초 눈금)에 넣어 연결 수립이 1초를 넘는 법인
 *     (RTT 800ms — TCP + TLS)의 중앙↔엣지 요청이 전부 'Connect Timeout Error'. Infinity 면 연결 시한이 사라졌다.
 *     WAN_MAX_CONNECTIONS=-1 → 첫 요청에서 'invalid connections'. (99회차 기록의 "'invalid connectTimeout'" 은 Client 직접 생성 때 문구 —
 *     Agent 경로에서는 위처럼 짧은 시한으로 실패한다. 결과(중앙↔엣지 요청 실패)는 같다.)
 *   · API_RATE_WINDOW_MS=Infinity → 한 IP 가 한도에 한 번 닿으면 재시작 전까지 429(Retry-After: Infinity).
 *   · SOAP_PARSE_WORKERS=Infinity → 첫 큰 SOAP 응답에서 `for (i < Infinity) new Worker()` — 메인 스레드가 멈췄다(4초 뒤 강제 종료).
 *   · COLLECT_CONCURRENCY=Infinity → util/pool.js 가 유한하지 않은 limit 을 1 로 읽어 vCenter 수집이 하나씩 차례로.
 *   · SVCMON_WORKERS=0.5 → runBatch 가 점검을 하나도 돌리지 않고 [] · 빈 값 → pool 은 인라인, capacity 는 기본(3) — 판정 둘.
 *   · IPAM_DB_LOCK_RETRY_MS=Infinity → 잠금 오류 한 번에 재시작 전까지 IP 관리 DB 를 다시 열지 않았다.
 *   · 상한 env(EDGE_*_MAX_BYTES · PARTFAULT_EDGE_* · GPU_GUEST_FILE_MAX_BYTES · 내보내기 행 · 이벤트 읽기) Infinity → 상한이 꺼졌다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripComments } from './_stripComments.js';
import { envNonNegative, envPositive, ENV_INT_MAX, ENV_DEFAULT_MAX } from '../src/util/envNumber.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const SRC_URL = pathToFileURL(SRC).href;

/** 자식 프로세스에서 script 를 돌려 마지막 `@@json@@` 을 돌려준다(모듈 상수는 import 때 굳으므로 env 마다 새 프로세스). */
function runChild(script, env = {}, timeout = 90_000) {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'env102-'));
  try {
    const full = { ...process.env, CONFIG_DIR: cfg, DATA_DIR: cfg, NODE_NO_WARNINGS: '1', ...env };
    for (const [k, v] of Object.entries(full)) if (v === undefined) delete full[k];
    // 스크립트는 파일로 — `-e` · `--input-type` 은 워커 스레드가 execArgv 로 물려받아 SOAP · svcmon 워커가 뜨자마자 죽는다(실제 경로를 시험하지 못한다).
    const file = path.join(cfg, 'probe.mjs');
    fs.writeFileSync(file, script);
    const r = spawnSync(process.execPath, ['--experimental-sqlite', file], { encoding: 'utf8', env: full, timeout });
    const m = /@@(.*)@@/s.exec(r.stdout || '');
    return { ok: !!m, json: m ? JSON.parse(m[1]) : null, status: r.status, signal: r.signal, stderr: (r.stderr || '').slice(-600) };
  } finally { fs.rmSync(cfg, { recursive: true, force: true }); }
}

test('102 — envNonNegative: 0 은 값, 빈 값 · 음수 · 숫자 아님 · Infinity · 상한 밖은 기본값', () => {
  assert.equal(envNonNegative('0', 9), 0, "'0' 은 의미(항상 오프로드 · 인라인)");
  assert.equal(envNonNegative(0, 9), 0);
  assert.equal(Object.is(envNonNegative('-0', 9), 0), true, "'-0' 도 0(음의 0 을 흘리지 않는다)");
  for (const bad of ['', '  ', undefined, null, '-1', '-0.5', 'abc', 'Infinity', '1e400', NaN, Infinity, [], {}]) {
    assert.equal(envNonNegative(bad, 9), 9, `envNonNegative(${JSON.stringify(bad)})`);
  }
  assert.equal(envNonNegative('2.9', 9), 2, '정수는 내림');
  assert.equal(envNonNegative('0.5', 9), 0, '내림해 0 이면 0(값 0 의 의미)');
  assert.equal(envNonNegative('2.5', 9, { int: false }), 2.5);
  assert.equal(envNonNegative('65', 9, { max: 64 }), 9, '상한 밖은 잘라 쓰지 않고 기본값');
  assert.equal(envNonNegative('64', 9, { max: 64 }), 64);
  // envPositive 와 0 만 다르다
  assert.equal(envPositive('0', 9), 9);
});

const PROBE = `
  const out = {};
  const rf = await import('${SRC_URL}/util/resilientFetch.js');
  out.wanConnect = rf.WAN_CONNECT_TIMEOUT_MS; out.wanConns = rf.WAN_MAX_CONNECTIONS;
  const rl = await import('${SRC_URL}/util/rateLimit.js');
  out.rateMax = rl.API_RATE_MAX; out.rateWin = rl.API_RATE_WINDOW_MS;
  const rc = await import('${SRC_URL}/util/readCapped.js');
  out.edgeExport = rc.EDGE_EXPORT_MAX_BYTES; out.edgeResp = rc.EDGE_RESPONSE_MAX_BYTES;
  const sp = await import('${SRC_URL}/util/soapParsePool.js');
  out.soapWorkers = sp._poolInfo().workerCount; out.soapMin = sp._poolInfo().minOffloadChars;
  const go = await import('${SRC_URL}/gpu/guestops.js');
  out.gpuFile = go.GUEST_FILE_MAX_BYTES;
  const pf = await import('${SRC_URL}/routes/api/partFaults.js');
  out.incEvents = pf.INCIDENT_EVENT_READ_MAX;
  const cap = await import('${SRC_URL}/svcmon/capacity.js');
  const pool = await import('${SRC_URL}/svcmon/pool.js');
  const ps = pool.poolStats();
  out.svcWorkers = ps.workers; out.capWorkers = cap.workersFromEnv(); out.sock = ps.sockLimit; out.proc = ps.procLimit; out.batch = ps.batch;
  const pl = await import('${SRC_URL}/svcmon/poller.js');
  out.tickMs = pl.pollerStats().tickMs; out.maxPerTick = pl.pollerStats().maxPerTick; out.warmMax = pl.WARM_MAX_MS;
  out.ceiling = cap.tickCeilingPerSec();
  process.stdout.write('@@' + JSON.stringify(out) + '@@');
  process.exit(0);`;
const KEYS = ['WAN_CONNECT_TIMEOUT_MS', 'WAN_MAX_CONNECTIONS', 'API_RATE_LIMIT', 'API_RATE_WINDOW_MS', 'EDGE_EXPORT_MAX_BYTES', 'EDGE_RESPONSE_MAX_BYTES',
  'SOAP_PARSE_WORKERS', 'SOAP_PARSE_MIN_CHARS', 'GPU_GUEST_FILE_MAX_BYTES', 'PARTFAULT_INCIDENT_EVENT_MAX', 'SVCMON_WORKERS', 'SVCMON_CONCURRENCY',
  'SVCMON_PROC_CONCURRENCY', 'SVCMON_BATCH', 'SVCMON_TICK_MS', 'SVCMON_MAX_PER_TICK', 'SVCMON_WARM_MAX_MS'];
const clean = () => Object.fromEntries(KEYS.map((k) => [k, undefined]));
const probe = (env) => { const r = runChild(PROBE, { ...clean(), ...env }); assert.ok(r.ok, `자식 실패(${r.status} ${r.signal}): ${r.stderr}`); return r.json; };

test('102 ② 실제 모듈 — Infinity · 음수 · 1e400 · 숫자 아님 · 빈 값은 기본값과 같다(상한 · 시한이 꺼지지 않는다)', { timeout: 300_000 }, () => {
  const base = probe({});
  assert.equal(base.wanConnect, 20_000); assert.equal(base.wanConns, 6);
  assert.equal(base.rateMax, 1800); assert.equal(base.rateWin, 60_000);
  assert.equal(base.soapMin, 262_144);
  assert.equal(base.svcWorkers, base.capWorkers, 'pool 과 capacity 는 같은 워커 수');
  for (const bad of ['Infinity', '-5', '1e400', 'abc', '']) {
    const got = probe(Object.fromEntries(KEYS.map((k) => [k, bad])));
    const diff = Object.keys(base).filter((k) => got[k] !== base[k]).map((k) => `${k}=${got[k]}(기본 ${base[k]})`);
    assert.deepEqual(diff, [], `위험한 값 ${JSON.stringify(bad)}`);
  }
  // 시한(setTimeout 1ms 함정) · 워커 · 동시성 상한 — 큰 유한값도 기본값
  const big = probe({ WAN_CONNECT_TIMEOUT_MS: '3000000000', API_RATE_WINDOW_MS: '3000000000', SOAP_PARSE_WORKERS: '10000',
    SVCMON_WORKERS: '1000000', SVCMON_CONCURRENCY: '1000000', SVCMON_PROC_CONCURRENCY: '100000' });
  assert.deepEqual([big.wanConnect, big.rateWin, big.soapWorkers, big.svcWorkers, big.capWorkers, big.sock, big.proc],
    [base.wanConnect, base.rateWin, base.soapWorkers, base.svcWorkers, base.capWorkers, base.sock, base.proc]);
});

test('102 ② 실제 모듈 — 정상 값 · 0 의 의미는 그대로', { timeout: 120_000 }, () => {
  const got = probe({ WAN_CONNECT_TIMEOUT_MS: '45000', WAN_MAX_CONNECTIONS: '12', API_RATE_LIMIT: '600', API_RATE_WINDOW_MS: '30000',
    EDGE_EXPORT_MAX_BYTES: String(128 * 1048576), SOAP_PARSE_WORKERS: '0', SOAP_PARSE_MIN_CHARS: '0', SVCMON_WORKERS: '0',
    SVCMON_CONCURRENCY: '512', SVCMON_PROC_CONCURRENCY: '32', SVCMON_BATCH: '500', SVCMON_TICK_MS: '10000', SVCMON_MAX_PER_TICK: '8000' });
  assert.equal(got.wanConnect, 45_000); assert.equal(got.wanConns, 12);
  assert.equal(got.rateMax, 600); assert.equal(got.rateWin, 30_000);
  assert.equal(got.edgeExport, 128 * 1048576);
  assert.equal(got.soapWorkers, 0, 'SOAP_PARSE_WORKERS=0 = 오프로딩 끔(의미)');
  assert.equal(got.soapMin, 0, 'SOAP_PARSE_MIN_CHARS=0 = 항상 오프로드(의미)');
  assert.equal(got.svcWorkers, 0, 'SVCMON_WORKERS=0 = 인라인(의미)');
  assert.equal(got.capWorkers, 0);
  assert.deepEqual([got.sock, got.proc, got.batch, got.tickMs, got.maxPerTick], [512, 32, 500, 10_000, 8000]);
  assert.equal(got.ceiling, 800, '용량 천장은 폴러가 실제로 쓰는 틱 값으로(8000 / 10초)');
});

test('102 F2 — API_RATE_WINDOW_MS=Infinity 여도 창이 바뀐다(한 번 걸린 IP 가 영원히 429 가 아니다)', { timeout: 60_000 }, () => {
  const script = `
    const { rateLimit } = await import('${SRC_URL}/util/rateLimit.js');
    const mw = rateLimit();
    let now = 1_000_000; Date.now = () => now;
    const call = () => { const h = {}; let st = 200; let passed = false;
      const res = { setHeader: (k, v) => { h[k] = v; }, status(s) { st = s; return this; }, json() { return this; } };
      mw({ socket: { remoteAddress: '10.0.0.1' }, app: {} }, res, () => { passed = true; }); return { passed, st, retry: h['Retry-After'] ?? null }; };
    const r = [call(), call(), call()];
    now += 86_400_000;
    r.push(call());
    process.stdout.write('@@' + JSON.stringify(r) + '@@'); process.exit(0);`;
  for (const win of ['Infinity', '1e400', '-1']) {
    const r = runChild(script, { API_RATE_LIMIT: '2', API_RATE_WINDOW_MS: win });
    assert.ok(r.ok, r.stderr);
    assert.deepEqual(r.json.map((x) => x.passed), [true, true, false, true], `창 ${win}: 하루 뒤에는 다시 통과`);
    assert.equal(r.json[2].retry, '60', `창 ${win}: Retry-After 는 기본 창(60초) 기준`);
  }
});

test('102 F5 — SOAP_PARSE_WORKERS=Infinity 여도 큰 SOAP 응답 파싱이 끝난다(워커를 끝없이 만들지 않는다)', { timeout: 120_000 }, () => {
  const script = `
    const m = await import('${SRC_URL}/util/soapParsePool.js');
    const xml = '<returnval><obj type="VirtualMachine">vm-1</obj><propSet><name>name</name><val>' + 'x'.repeat(300_000) + '</val></propSet></returnval>';
    const t0 = Date.now();
    await m.parseObjectContentAsync(xml).catch(() => null);
    const info = m._poolInfo();
    await m.shutdownParsePool();
    process.stdout.write('@@' + JSON.stringify({ ms: Date.now() - t0, workers: info.workerCount }) + '@@'); process.exit(0);`;
  for (const v of ['Infinity', '1e9', '2.5']) {
    const r = runChild(script, { SOAP_PARSE_WORKERS: v }, 60_000);
    assert.ok(r.ok, `SOAP_PARSE_WORKERS=${v}: 자식이 끝나지 않았다(${r.status} ${r.signal}) ${r.stderr}`);
    assert.ok(Number.isInteger(r.json.workers) && r.json.workers >= 1 && r.json.workers <= 64, `워커 ${r.json.workers}`);
  }
});

test('102 F7 — SVCMON_WORKERS=0.5 · 빈 값이어도 점검이 돈다(결과가 빈 배열이 아니다)', { timeout: 120_000 }, () => {
  const script = `
    const pool = await import('${SRC_URL}/svcmon/pool.js');
    const cap = await import('${SRC_URL}/svcmon/capacity.js');
    const items = [{ test: { id: 't1', type: 'tcp', port: 1, timeoutMs: 300 }, host: '127.0.0.1' }, { test: { id: 't2', type: 'tcp', port: 1, timeoutMs: 300 }, host: '127.0.0.1' }];
    const keep = setInterval(() => {}, 1000);   // 워커는 unref 라 — 서버처럼 루프를 붙잡아 둔다
    const r = await pool.runBatch(items);
    clearInterval(keep);
    const out = { results: r.length, pool: pool.poolStats().workers, cap: cap.workersFromEnv(), capCount: cap.workerCount() };
    pool.closePool();
    process.stdout.write('@@' + JSON.stringify(out) + '@@'); process.exit(0);`;
  for (const v of ['0.5', '', '  ', '-1', 'abc']) {
    const r = runChild(script, { SVCMON_WORKERS: v });
    assert.ok(r.ok, `SVCMON_WORKERS=${JSON.stringify(v)}: ${r.stderr}`);
    assert.equal(r.json.results, 2, `SVCMON_WORKERS=${JSON.stringify(v)}: 점검 결과가 빠졌다 ${JSON.stringify(r.json)}`);
    assert.equal(r.json.pool, r.json.cap, `SVCMON_WORKERS=${JSON.stringify(v)}: pool 과 capacity 의 워커 수가 다르다 ${JSON.stringify(r.json)}`);
    assert.ok(Number.isInteger(r.json.pool), `워커 수는 정수 ${r.json.pool}`);
  }
});

test('102 — 고친 파일에는 감싸지 않은 env 수치(별칭 env.X 포함)가 남지 않는다', () => {
  const RAW = /(?:Number(?:\.parse(?:Int|Float))?|parseInt|parseFloat)\(\s*(?:process\.env|env)\s*(?:\.[A-Z0-9_]+|\[|\))|\+\s*process\.env\.[A-Z]/;
  const fixed = ['util/resilientFetch.js', 'util/rateLimit.js', 'util/readCapped.js', 'util/soapParsePool.js', 'util/loopLag.js', 'util/activityLog.js',
    'store.js', 'svcmon/pool.js', 'svcmon/poller.js', 'svcmon/capacity.js', 'ipam/db.js', 'central/partFaultEdge.js', 'partfault/push.js',
    'partfault/scan.js', 'gpu/guestops.js', 'routes/api/checksLogs.js', 'routes/api/hardwareGpu.js', 'routes/api/partFaults.js'];
  const left = [];
  for (const rel of fixed) {
    stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8')).split('\n').forEach((ln, i) => {
      if (RAW.test(ln) && !/clampIntervalMs\(\s*Number\(process\.env\./.test(ln)) left.push(`${rel}:${i + 1} ${ln.trim().slice(0, 140)}`);   // 주기는 clampIntervalMs(닫힌 범위)
    });
  }
  // rma/agent.js 는 별칭 env 를 쓴다 — 남는 것은 RMA_PRIORITY(유한 검사) · 같은 줄에서 범위가 닫힌 longpoll · 동시성뿐이어야 한다.
  stripComments(fs.readFileSync(path.join(SRC, 'rma/agent.js'), 'utf8')).split('\n').forEach((ln, i) => {
    if (!RAW.test(ln)) return;
    if (/RMA_PRIORITY/.test(ln) && /Number\.isFinite/.test(ln)) return;
    if (/Math\.max\(/.test(ln) && /Math\.min\(/.test(ln)) return;
    left.push(`rma/agent.js:${i + 1} ${ln.trim().slice(0, 140)}`);
  });
  assert.deepEqual(left, []);
});

test('102 — 같은 env 는 같은 판정: PARTFAULT_INV_MAX_AGE_MS(스캔 · 상세 화면) · 워커 수(pool · capacity) · 틱(poller · capacity)', () => {
  const src = (rel) => stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
  const call = /clampIntervalMs\(process\.env\.PARTFAULT_INV_MAX_AGE_MS, 90 \* 60_000, 60_000\)/;
  assert.match(src('partfault/scan.js'), call, '파트 장애 스캔의 신선도');
  assert.match(src('idrac/serverParts.js'), call, '서버 상세의 신선도(같은 헬퍼 · 같은 인자)');
  assert.match(src('svcmon/pool.js'), /WORKER_COUNT = workersFromEnv\(\)/);
  assert.doesNotMatch(src('svcmon/pool.js'), /SVCMON_WORKERS/, 'pool 이 워커 env 를 따로 읽지 않는다');
  assert.match(src('svcmon/poller.js'), /TICK_MS = tickMsFromEnv\(\)/);
  assert.match(src('svcmon/poller.js'), /MAX_PER_TICK = maxPerTickFromEnv\(\)/);
});

test('102 — ENV_INT_MAX 전제(시한 상한)', () => {
  assert.equal(ENV_INT_MAX, 2 ** 31 - 1);
});

test('102(100회차 반증 제안) — 기본 max 는 Number.MAX_SAFE_INTEGER: 유한 거대값(1e300)도 기본값, 2GB 넘는 바이트 상한 · 명시 max 는 그대로', () => {
  assert.equal(ENV_DEFAULT_MAX, Number.MAX_SAFE_INTEGER);
  for (const huge of ['1e300', '1e17', String(2 ** 53), 1e300]) {
    assert.equal(envPositive(huge, 77), 77, `envPositive(${huge}) — 예전 기본 max(Infinity)는 통과시켜 개수 · 상한 · 동시성이 사실상 꺼졌다`);
    assert.equal(envNonNegative(huge, 77), 77, `envNonNegative(${huge})`);
  }
  assert.equal(envPositive(String(Number.MAX_SAFE_INTEGER), 77), Number.MAX_SAFE_INTEGER, '경계값 자체는 값');
  assert.equal(envPositive(String(4 * 1024 ** 3), 77), 4 * 1024 ** 3, '2GB 를 넘는 정당한 바이트 상한(4GB)은 그대로 — 기본을 ENV_INT_MAX 로 두지 않은 이유');
  assert.equal(envPositive('3000000000', 77, { max: ENV_INT_MAX }), 77, '시한은 호출부의 { max: ENV_INT_MAX } 가 그대로 이긴다');
  assert.equal(envPositive('70000', 443, { max: 65_535 }), 443, '명시 max(포트)는 그대로');
});

test('102 남김(메인): docs/ENV.md — `|| 10 * 60_000` 꼴 곱 기본값은 계산해 적고, 주석 속 `process.env.X` 예시는 키가 아니다', () => {
  const md = fs.readFileSync(new URL('../../docs/ENV.md', import.meta.url), 'utf8');
  const def = (k) => (md.match(new RegExp('^\\| `' + k + '` \\| `([^`]*)`', 'm')) || [])[1];
  assert.equal(def('VEEAM_RUN_DEADLINE_MS'), '86400000', '24 * 60 * 60_000 — 첫 숫자(24)만 적던 것');
  assert.equal(def('SANSW_POLL_MS'), '300000', '5 * 60_000');
  assert.equal(def('BMUSAGE_ENVELOPE_MAX_BYTES'), '8388608', '8 * 1024 * 1024');
  assert.doesNotMatch(md, /^\| `X` \|/m, '주석 속 예시 키(X)가 실리면 안 된다');
});
