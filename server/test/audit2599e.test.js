/**
 * v2.599 감사 그룹 e — 회귀 고정.
 *  RECENT2599-03 DS 사용량 결측(usedGB·freeGB null)을 100% 사용·전량 여유·부분 합으로 세지 않는다
 *  T2599-01     svcmon 로그 다운로드 중단 시 fd 누수(pipe → pipeline)
 *  T2599-02     env 주기값 상·하한(2^31 초과·0 이하 → 1ms 루프)
 *  T2599-03     svcmon 로그 분석 — 따옴표 없는 긴 물리행 상한
 *  DB2599-01    idrac withLatestCache 시드가 dead-band 생략 표본의 ts 를 안다(재시작 후 이중 계수 없음)
 *  DB2599-02    horizon sessionDb 첫 open 잠금 오류를 래치하지 않는다
 *  LO2599-01    숫자 설정 빈 칸은 기본값이 아니라 이전 값 유지(SAN 사용량·현재 사용자·Horizon 세션)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2599e-'));
process.env.CONFIG_DIR = TMP;
process.env.AUTH_ENABLED = 'false';
process.env.HZSESS_DB_PATH = path.join(TMP, 'hz-sessions.db');

const runNode = (code, env = {}) => spawnSync(process.execPath, ['--input-type=module', '-e', code], {
  cwd: path.join(HERE, '..'), env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60_000,
});

/* ── RECENT2599-03 ─────────────────────────────────────────────────── */

const DS_UNKNOWN = { id: 'ds-u', name: 'U', vcenterId: 'vc1', capacityGB: 1000, freeGB: null, usedGB: null, usagePct: null };
const DS_KNOWN = { id: 'ds-k', name: 'K', vcenterId: 'vc1', capacityGB: 1000, freeGB: 900, usedGB: 100, usagePct: 10 };

test('RECENT2599-03 diskBreakdown — 사용량 미상 DS 는 용량·사용 양쪽에서 빼고 개수를 밝힌다', async () => {
  const { diskBreakdown } = await import('../src/tools/diskTrend.js');
  const b = diskBreakdown([], [DS_UNKNOWN, DS_KNOWN], { now: 1_700_000_000_000 });
  assert.equal(b.ds.capGB, 1000);
  assert.equal(b.ds.usedGB, 100);
  assert.equal(b.ds.usagePct, 10);
  assert.equal(b.ds.usageUnknown, 1);
  assert.equal(b.ds.critCount, 0);
  // freeGB 만 있으면 사용량을 계산할 수 있다 — 빼지 않는다
  const b2 = diskBreakdown([], [{ capacityGB: 1000, freeGB: 400, usedGB: null }]);
  assert.equal(b2.ds.usedGB, 600);
  assert.equal(b2.ds.usageUnknown, 0);
});

test('RECENT2599-03 datastoreMatrix — 미상 DS 를 100% 사용으로 세지 않는다', async () => {
  const { datastoreMatrix } = await import('../src/tools/compareMatrix.js');
  const r = datastoreMatrix({ vcenters: [{ id: 'vc1', name: 'VC1' }], datastores: [{ ...DS_UNKNOWN, name: 'A' }, { ...DS_KNOWN, name: 'A' }] });
  const row = r.rows.find((x) => x.name === 'A');
  assert.equal(row.total.usedPct, 10);
  assert.equal(row.total.capacityTB, Math.round((1000 / 1024) * 10) / 10);
  assert.equal(row.total.usageUnknown, 1);
  assert.equal(row.total.count, 2);
  assert.equal(r.colTotals.vc1.usedPct, 10);
});

test('RECENT2599-03 store 롤업 — 부분 합(거짓 하락) 대신 미상 DS 를 빼고 개수를 싣는다', async () => {
  const { scopedRollups } = await import('../src/store.js');
  const snap = { vcenters: [{ id: 'vc1', location: { region: 'KR' } }], hosts: [], vms: [], alarms: [], networks: [], datastores: [DS_UNKNOWN, DS_KNOWN] };
  const r = scopedRollups(snap, new Set(['vc1']));
  assert.equal(r.global.storageUsagePct, 10);
  assert.equal(r.global.datastoresUsageUnknown, 1);
  const vc = r.sites.find((x) => x.id === 'vc1').metrics;
  assert.equal(vc.storageUsagePct, 10);
  assert.equal(vc.storageTotalTB, Math.round((1000 / 1024) * 10) / 10);
  assert.equal(vc.datastoresUsageUnknown, 1);
  assert.equal(r.byRegion[0].storageUsagePct, 10);
});

test('RECENT2599-03 capacity-forecast — 여유를 모르면 소진일도 null(전량 여유로 계산하지 않는다)', () => {
  const src = stripComments(fs.readFileSync(path.join(SRC, 'routes/api/toolsCapacity.js'), 'utf8'));
  assert.doesNotMatch(src, /d\.freeGB \?\? Math\.max\(0, \(d\.capacityGB \|\| 0\) - \(d\.usedGB \|\| 0\)\)/);
  assert.match(src, /daysToFull = freeGB != null && slope/);
});

/* ── T2599-01 ──────────────────────────────────────────────────────── */

test('T2599-01 로그 다운로드를 중간에 끊어도 파일 fd 가 남지 않는다', async () => {
  const express = (await import('express')).default;
  const { registerLogs } = await import('../src/routes/svcmon/logs.js');
  const { logDir } = await import('../src/svcmon/logsettings.js');
  const name = 'results-2599-01-01.csv';
  const file = path.join(logDir(), name);
  fs.writeFileSync(file, Buffer.alloc(64 * 1024 * 1024, 0x61));
  const app = express();
  app.use((req, _res, next) => { req.user = { username: 't', role: 'admin' }; next(); });
  const r = express.Router(); registerLogs(r); app.use(r);
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((ok) => srv.once('listening', ok));
  const port = srv.address().port;
  const openFds = () => fs.readdirSync('/proc/self/fd').filter((fd) => { try { return fs.readlinkSync(`/proc/self/fd/${fd}`) === file; } catch { return false; } }).length;
  try {
    for (let i = 0; i < 8; i++) {
      await new Promise((ok) => {
        const req = http.get({ host: '127.0.0.1', port, path: `/log/files/${name}` }, (res) => {
          res.once('data', () => { req.destroy(); setTimeout(ok, 30); });
        });
        req.on('error', () => {});
      });
    }
    await new Promise((ok) => setTimeout(ok, 300));
    assert.equal(openFds(), 0, `중단된 다운로드가 fd 를 쥐고 있다: ${openFds()}개`);
  } finally { srv.close(); fs.rmSync(file, { force: true }); }
});

/* ── T2599-02 ──────────────────────────────────────────────────────── */

test('T2599-02 주기 헬퍼 — 상한·하한·0 이하', async () => {
  const { clampIntervalMs, offOrIntervalMs, MAX_TIMER_MS } = await import('../src/config.js');
  assert.ok(MAX_TIMER_MS <= 2 ** 31 - 1);
  assert.equal(clampIntervalMs(2_592_000_000, 3_600_000, 60_000), MAX_TIMER_MS);
  assert.equal(clampIntervalMs(0, 60_000, 5_000), 60_000);
  assert.equal(clampIntervalMs(-5, 60_000, 5_000), 60_000);
  assert.equal(clampIntervalMs(1, 60_000, 5_000), 5_000);
  assert.equal(clampIntervalMs(120_000, 60_000, 5_000), 120_000);
  assert.equal(offOrIntervalMs(0), 0);
  assert.equal(offOrIntervalMs(-1), 0);
  assert.equal(offOrIntervalMs(9e15, 5_000), MAX_TIMER_MS);
});

test('T2599-02 config — 2^31 초과·0 이하 env 가 setInterval 의 1ms 루프가 되지 않는다', () => {
  const r = runNode(`const { config } = await import('./src/config.js');
    console.log(JSON.stringify([config.agent.scanIntervalMs, config.pollIntervalMs, config.idrac.pollIntervalMs,
      config.agent.inventoryIntervalMs, config.agent.guestDiskIntervalMs, config.collector.pullIntervalMs, config.idrac.scanIntervalMs, config.ping.pollIntervalMs]));`, {
    AGENT_SCAN_INTERVAL_MS: '2592000000', POLL_INTERVAL_MS: '-1', IDRAC_POLL_INTERVAL_MS: '0',
    AGENT_INVENTORY_INTERVAL_MS: '1e12', AGENT_GUESTDISK_INTERVAL_MS: '5', COLLECTOR_PULL_INTERVAL_MS: '-3',
    IDRAC_SCAN_INTERVAL_MS: '9e15', PING_MON_INTERVAL_MS: '3000000000',
  });
  assert.equal(r.status, 0, r.stderr);
  const v = JSON.parse(r.stdout.trim().split('\n').pop());
  for (const x of v) assert.ok(x === 0 || (x >= 1_000 && x <= 2 ** 31 - 1), `범위 밖 주기 ${x}`);
  assert.equal(v[1], 30_000);   // POLL_INTERVAL_MS=-1 → 기본
  assert.equal(v[2], 60_000);   // IDRAC_POLL_INTERVAL_MS=0 → 기본(문서화된 끄기 없음)
  assert.equal(v[5], 0);        // COLLECTOR_PULL ≤0 → 끔(문서화)
});

/* ── T2599-03 ──────────────────────────────────────────────────────── */

test('T2599-03 따옴표 없는 20MB 한 줄 — 손상 행으로 버리고 메모리를 부풀리지 않는다', async () => {
  const { analyzeLog } = await import('../src/svcmon/loganalyze.js');
  const { logDir } = await import('../src/svcmon/logsettings.js');
  const file = path.join(logDir(), 'results-2599-09-23.csv');
  fs.writeFileSync(file, Buffer.alloc(20 * 1024 * 1024, 0));
  try {
    const h0 = process.memoryUsage().heapUsed;
    let peak = h0;
    const t = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 2);
    const r = await analyzeLog({ from: 0, to: Date.parse('2030-01-01T00:00:00Z') });
    peak = Math.max(peak, process.memoryUsage().heapUsed);
    clearInterval(t);
    assert.ok(r.badRows >= 1);
    assert.ok(peak - h0 < 200 * 1024 * 1024, `힙 증가 ${Math.round((peak - h0) / 1048576)}MB`);
  } finally { fs.rmSync(file, { force: true }); }
});

test('T2599-03 /log/analyze 는 동시 1건(single-flight)', () => {
  const src = stripComments(fs.readFileSync(path.join(SRC, 'routes/svcmon/logs.js'), 'utf8'));
  assert.match(src, /if \(analyzeRunning\) return res\.status\(409\)/);
  assert.match(src, /finally \{ analyzeRunning = false; \}/);
});

/* ── DB2599-01 ─────────────────────────────────────────────────────── */

test('DB2599-01 재시작 후 같은 표본을 롤업에 다시 더하지 않는다', () => {
  const dbPath = path.join(TMP, 'idrac-power-2599.db');
  const T0 = Math.floor(Date.parse('2030-01-01T00:00:00Z') / 3_600_000) * 3_600_000 - 30 * 60_000;
  const env = { IDRAC_DB_PATH: dbPath, T0: String(T0) };
  const p1 = runNode(`const { getDb } = await import('./src/idrac/db.js'); const db = await getDb();
    const T0 = Number(process.env.T0);
    db.insertMany([{ serverId: 'rmt:h1', watts: 500, ts: T0 }]);
    db.insertMany([{ serverId: 'rmt:h1', watts: 501, ts: T0 + 60000 }]);`, env);
  assert.equal(p1.status, 0, p1.stderr);
  // 새 프로세스 = 재시작. lastSeenTsAll 은 now 기준 창을 보므로 테스트 시각(T0)을 now 로 준다.
  const p2 = runNode(`const m = await import('./src/idrac/db.js');
    const T0 = Number(process.env.T0); const realNow = Date.now; Date.now = () => T0 + 120000;
    const db = await m.getDb(); Date.now = realNow;
    const sTs = T0 + 60000; const prevTs = db.latest('rmt:h1')?.ts;
    const skip = prevTs != null && sTs <= prevTs;      // collector/puller.js 의 중복 검사
    if (!skip) db.insertMany([{ serverId: 'rmt:h1', watts: 501, ts: sTs }]);
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(process.env.IDRAC_DB_PATH);
    console.log(JSON.stringify({ prevTs, skip, rows: raw.prepare('SELECT cnt, sumw FROM power_hourly').all() }));`, env);
  assert.equal(p2.status, 0, p2.stderr);
  const out = JSON.parse(p2.stdout.trim().split('\n').pop());
  assert.equal(out.skip, true);
  assert.equal(out.prevTs, T0 + 60_000);
  assert.deepEqual(out.rows.map((r) => r.cnt), [2]);
});

/* ── DB2599-02 ─────────────────────────────────────────────────────── */

test('DB2599-02 첫 open 잠금 오류를 래치하지 않고 잠금이 풀리면 다시 연다', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const hz = await import('../src/horizon/sessionDb.js');
  hz._resetForTest();
  const p = process.env.HZSESS_DB_PATH;
  fs.rmSync(p, { force: true });
  fs.writeFileSync(p, '');
  const holder = new DatabaseSync(p);
  holder.exec('BEGIN EXCLUSIVE');
  const s1 = await hz.hzSessionDbStatus();
  assert.equal(s1.available, false);
  assert.match(s1.error, /잠겨/);
  holder.exec('COMMIT'); holder.close();
  hz._expireLockRetryForTest();
  const s2 = await hz.hzSessionDbStatus();
  assert.equal(s2.available, true, s2.error);
  hz._resetForTest();
});

/* ── LO2599-01 ─────────────────────────────────────────────────────── */

test('LO2599-01 SAN 사용량 설정 — 빈 칸은 이전 값 유지(기본값으로 줄이지 않는다)', async () => {
  const m = await import('../src/sanswitch/perfSettings.js');
  m._resetForTest();
  m.savePerfSettings({ enabled: true, intervalMs: 3_600_000, sampleSeconds: 20, retentionDays: 3650 });
  const r = m.savePerfSettings({ enabled: true, intervalMs: 0, sampleSeconds: null, retentionDays: '' });
  assert.equal(r.retentionDays, 3650);
  assert.equal(r.intervalMs, 3_600_000);
  assert.equal(r.sampleSeconds, 20);
  assert.equal(m.savePerfSettings({ enabled: true, retentionDays: 30 }).retentionDays, 30);   // 명시값은 그대로
});

test('LO2599-01 현재 사용자·Horizon 세션 설정 — 빈 칸은 이전 값 유지', async () => {
  const cu = await import('../src/curuser/settings.js');
  cu._resetForTest();
  cu.save({ retentionDays: 3000, intervalMs: 3_600_000 });
  const a = cu.save({ ...cu.load(), retentionDays: '', intervalMs: '' });
  assert.equal(a.retentionDays, 3000);
  assert.equal(a.intervalMs, 3_600_000);
  const hs = await import('../src/horizon/sessionSettings.js');
  hs._resetForTest();
  hs.save({ retentionDays: 3000 });
  const b = hs.save({ ...hs.load(), retentionDays: '' });
  assert.equal(b.retentionDays, 3000);
});

/* ── T2599-02 후속: config.js 밖 주기·시한 env ────────────────────────── */

test('T2599-02 후속 — 워커·폴러·시한 env 가 [하한, 2^31) 에 갇힌다(0=끔 계약은 유지)', () => {
  const big = '2592000000000';
  const r = runNode(`
    const out = {};
    out.ping = (await import('./src/agent/pingWorker.js')).pingWorkerStatus().pollMs;
    out.capture = (await import('./src/agent/captureWorker.js')).captureWorkerStatus().pollMs;
    out.bmstor = (await import('./src/agent/bmstorWorker.js')).bmstorWorkerStatus().pollMs;
    out.logq = (await import('./src/agent/logQueryWorker.js')).logQueryWorkerStatus().intervalMs;
    out.idracScan = (await import('./src/agent/idracScanWorker.js')).getIdracScanWorkerStatus().pollMs;
    out.edgelog = (await import('./src/agent/edgeLogWorker.js')).edgeLogWorkerStatus().intervalMs;
    out.sansw = (await import('./src/sanswitch/poller.js')).pollMs();
    out.partfault = (await (await import('./src/partfault/poller.js')).partFaultStatus()).intervalMs;
    const { config } = await import('./src/config.js');
    out.idracTimeout = config.idrac.timeoutMs; out.collectorTimeout = config.collector.timeoutMs;
    console.log(JSON.stringify(out));`, {
    AGENT_PING_POLL_MS: big, AGENT_CAPTURE_POLL_MS: '-5', AGENT_BMSTOR_POLL_MS: big, AGENT_LOGQ_POLL_MS: big,
    AGENT_IDRAC_SCAN_POLL_MS: '-1', AGENT_EDGELOG_POLL_MS: big, SANSW_POLL_MS: big, PARTFAULT_POLL_MS: big,
    IDRAC_TIMEOUT_MS: '-3', COLLECTOR_TIMEOUT_MS: big,
  });
  assert.equal(r.status, 0, r.stderr);
  const v = JSON.parse(r.stdout.trim().split('\n').pop());
  for (const [k, x] of Object.entries(v)) assert.ok(x >= 1_000 && x <= 2 ** 31 - 1, `${k}=${x}`);
  assert.equal(v.capture, 4_000);        // 음수 → 기본
  assert.equal(v.idracScan, 5_000);
  assert.equal(v.idracTimeout, 15_000);
  // AGENT_EDGELOG_POLL_MS=0 은 '끔' 계약 — 그대로
  const off = runNode(`console.log((await import('./src/agent/edgeLogWorker.js')).edgeLogWorkerStatus().intervalMs);`, { AGENT_EDGELOG_POLL_MS: '0' });
  assert.equal(off.stdout.trim().split('\n').pop(), '0');
  const lag = stripComments(fs.readFileSync(path.join(SRC, 'util/loopLag.js'), 'utf8'));
  assert.match(lag, /clampIntervalMs\(Number\(process\.env\.LOOP_LAG_INTERVAL_MS\) \|\| 30_000, 30_000, 5_000\)/);
});

/* ── DB2599-02 후속: 공용 헬퍼 + 폴링 경로 DB 모듈 ─────────────────────── */

test('DB2599-02 헬퍼 — busy_timeout 이 journal_mode 보다 먼저, 실패한 시도의 핸들은 닫힌다', async () => {
  const { openSqlite, withOpenCleanup, retryOnLock, isSqliteLockError, createLockRetry } = await import('../src/util/sqliteOpen.js');
  const { DatabaseSync } = await import('node:sqlite');
  const p = path.join(TMP, 'helper-2599.db');
  const calls = [];
  const fake = { exec: (q) => calls.push(q), close() {} };
  openSqlite(fake);
  assert.match(calls[0], /^PRAGMA busy_timeout=3000;$/);
  assert.match(calls[1], /journal_mode=WAL/);
  let captured = null;
  await assert.rejects(withOpenCleanup(async () => { captured = openSqlite(new DatabaseSync(p)); throw new Error('boom'); }), /boom/);
  assert.throws(() => captured.exec('SELECT 1'), /not open/i);   // 닫혔다
  assert.equal(isSqliteLockError({ errcode: 5 }), true);
  assert.equal(isSqliteLockError(new Error('no such table')), false);
  const lr = createLockRetry(1000);
  assert.equal(lr.onFail(new Error('database is locked'), 0), true);
  assert.equal(lr.blocked(500), true); assert.equal(lr.blocked(1500), false);
  assert.equal(lr.onFail(new Error('disk I/O error'), 0), false);
  let n = 0;
  const v = await retryOnLock(async () => { n += 1; if (n < 3) throw Object.assign(new Error('database is locked'), { errcode: 5 }); return 'ok'; }, { waitMs: 1 });
  assert.equal(v, 'ok'); assert.equal(n, 3);
  await assert.rejects(retryOnLock(async () => { throw new Error('corrupt'); }, { waitMs: 1 }), /corrupt/);
});

// 모듈마다 자식 프로세스 하나(병렬): 빈 DB 파일에 다른 연결이 EXCLUSIVE 잠금 → 첫 open 실패는 래치하지 않고,
// 잠금이 풀리고 재시도 대기(30초)가 지나면(Date.now 를 앞당긴다) 다시 열린다.
const LOCK_CASES = {
  curuser: { file: 'curuser.db', mod: './src/curuser/db.js', probe: 'async (m) => (await m.curUserDbStatus()).available' },
  partfault: { file: 'part-faults.db', mod: './src/partfault/db.js', probe: 'async (m) => (await m.partFaultDbStatus()).available' },
  pdu: { file: 'pdu.db', mod: './src/pdu/db.js', probe: 'async (m) => !(await m.dbStats()).unavailable' },
  sanperf: { file: 'sanswitch-perf.db', mod: './src/sanswitch/perfDb.js', probe: 'async (m) => m.available()' },
  linkcheck: { file: 'link-check.db', mod: './src/linkcheck/db.js', probe: 'async (m) => m.available()' },
  bmusage: { file: 'bm-usage.db', mod: './src/bmusage/db.js', probe: 'async (m) => m.available()' },
  vmtrack: { file: 'vmtrack.db', env: 'VMTRACK_DB_PATH', mod: './src/vmtrack/db.js', probe: 'async (m) => !!(await m.getDb())' },
  guestdisk: { file: 'guestdisk.db', env: 'GUESTDISK_DB_PATH', mod: './src/guestdisk/db.js', probe: 'async (m) => !!(await m.getDb())' },
};

test('DB2599-02 후속 — 폴링 경로 DB 8종: 첫 open 잠금을 래치하지 않는다', async () => {
  const { spawn } = await import('node:child_process');
  const run = (name, c) => new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lock2599-${name}-`));
    const file = path.join(dir, c.file);
    const env = { ...process.env, CONFIG_DIR: dir, ...(c.env ? { [c.env]: file } : {}), CURUSER_DB_PATH: path.join(dir, 'curuser.db'), PARTFAULT_DB_PATH: path.join(dir, 'part-faults.db'), PDU_DB: path.join(dir, 'pdu.db') };
    const code = `
      const fs = await import('node:fs'); const { DatabaseSync } = await import('node:sqlite');
      const file = ${JSON.stringify(file)};
      fs.writeFileSync(file, '');
      const holder = new DatabaseSync(file); holder.exec('BEGIN EXCLUSIVE');
      const m = await import(${JSON.stringify(c.mod)}); const probe = ${c.probe};
      const first = await probe(m);
      holder.exec('COMMIT'); holder.close();
      const real = Date.now; Date.now = () => real() + 31_000;
      const second = await probe(m);
      console.log(JSON.stringify({ first, second }));`;
    const ch = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: path.join(HERE, '..'), env });
    let out = ''; let err = '';
    ch.stdout.on('data', (d) => { out += d; }); ch.stderr.on('data', (d) => { err += d; });
    ch.on('close', (st) => resolve({ name, st, out, err }));
  });
  const res = await Promise.all(Object.entries(LOCK_CASES).map(([k, c]) => run(k, c)));
  for (const r of res) {
    assert.equal(r.st, 0, `${r.name}: ${r.err.slice(-400)}`);
    const v = JSON.parse(r.out.trim().split('\n').pop());
    assert.equal(v.first, false, `${r.name}: 잠금 중에는 열리지 않아야 한다`);
    assert.equal(v.second, true, `${r.name}: 잠금이 풀린 뒤 다시 열려야 한다(래치 금지)`);
  }
});

test('DB2599-02 후속 — NDJSON·인메모리 폴백 모듈 4종은 잠금에 폴백하지 않고 기다렸다 SQLite 로 연다', async () => {
  const { spawn } = await import('node:child_process');
  const cases = {
    ping: { f: 'ping-monitor.db', env: 'PING_DB_PATH', code: "(await (await import('./src/ping/db.js')).getPingDb()).kind" },
    idrac: { f: 'idrac-power.db', env: 'IDRAC_DB_PATH', code: "(await (await import('./src/idrac/db.js')).getDb()).kind" },
    capacity: { f: 'capacity.db', env: 'CAPACITY_DB_PATH', code: "(await (await import('./src/capacity/db.js')).getCapacityDb()).kind" },
    logs: { f: 'vcenter-logs.db', env: null, code: "(await (await import('./src/logs/db.js')).getLogsDb()).kind" },
  };
  const run = (name, c) => new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lock2599-${name}-`));
    const file = path.join(dir, c.f);
    const env = { ...process.env, CONFIG_DIR: dir, ...(c.env ? { [c.env]: file } : {}) };
    const code = `
      const fs = await import('node:fs'); const { DatabaseSync } = await import('node:sqlite');
      const file = ${JSON.stringify(file)}; fs.writeFileSync(file, '');
      const holder = new DatabaseSync(file); holder.exec('BEGIN EXCLUSIVE');
      setTimeout(() => { holder.exec('COMMIT'); holder.close(); }, 500);
      console.log(${c.code});`;
    const ch = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: path.join(HERE, '..'), env });
    let out = ''; let err = '';
    ch.stdout.on('data', (d) => { out += d; }); ch.stderr.on('data', (d) => { err += d; });
    ch.on('close', (st) => resolve({ name, st, out, err }));
  });
  const res = await Promise.all(Object.entries(cases).map(([k, c]) => run(k, c)));
  for (const r of res) {
    assert.equal(r.st, 0, `${r.name}: ${r.err.slice(-400)}`);
    assert.equal(r.out.trim().split('\n').pop(), 'sqlite', `${r.name}: 잠금이 풀린 뒤 SQLite 로 열려야 한다(폴백 래치 금지)\n${r.err.slice(-300)}`);
  }
});
