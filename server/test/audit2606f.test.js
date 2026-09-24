/**
 * v2.606 감사 그룹 f — 타이머·DB·LLM 회귀.
 *  TIM2606-01 LLM 타임아웃 정규화(저장·로드·연결 테스트) + resilientFetch 시한 2차 클램프 ·
 *  TIM2606-03 SSH exec/execAnswered 단일 관문 + SAN·스토리지 CLI/HTTP env · LEFT2606-04 DIRUSAGE_TICK_MS·GUESTDISK_TIMEOUT_MS ·
 *  DB2606-01 vCenter 로그 meta(MIN/MAX 단독 + 건수 캐시) · DB2606-02 스토리지 api_history·capacity_history 청크 정리 ·
 *  DB2606-03 RMA 점검·실행 이력·SAN 점검 이력 DB 잠금 래치 금지 · DB2606-05 RMA NOCASE 인덱스 + testHistory hours 상한.
 * 기준 시각: 보존 경계 테스트는 경계에서 수십 일 떨어뜨린다(루트 CLAUDE.md v2.517).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2606f-'));
process.env.CONFIG_DIR = TMP;
process.env.PRUNE_CHUNK_ROWS = '500';            // 청크 사이 양보를 작은 표본으로 관찰한다
process.env.SSRF_ALLOW_LOOPBACK = 'true';        // 목 LLM 서버(127.0.0.1)
process.env.SANHEALTH_DB_PATH = path.join(TMP, 'san-health.db');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..');
const SRC = path.join(SERVER, 'src');
const DAY = 86_400_000;

/** 대상 Promise 가 끝날 때까지 setImmediate 로 자기를 다시 거는 프로브 — 양보 횟수를 센다(v2.581 BUG-E 규약). */
async function countYields(p) {
  let n = 0; let done = false;
  const spin = () => { if (done) return; n += 1; setImmediate(spin); };
  setImmediate(spin);
  const r = await p;
  done = true;
  return { r, yields: n };
}

function runChild(code, env = {}) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: SERVER, env: { ...process.env, CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'a2606f-c-')), ...env }, encoding: 'utf8', timeout: 90_000,
  });
  if (r.status !== 0) throw new Error(`child 실패(${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

/** 모듈 안의 Date.now 를 앞으로 민다(잠금 재시도 대기·캐시 TTL 경과 재현). */
function withClock(offsetMs, fn) {
  const real = Date.now;
  Date.now = () => real() + offsetMs;
  return Promise.resolve().then(fn).finally(() => { Date.now = real; });
}

// ── TIM2606-01 ────────────────────────────────────────────────────────────
test('TIM2606-01: LLM 타임아웃은 숫자로 저장되고 빈 칸·음수는 이전 값, 범위 밖은 [1초, 10분]', async () => {
  const m = await import('../src/llm/config.js');
  assert.equal(m.saveLlmConfig({ timeoutMs: '60000' }).timeoutMs, 60000, '화면의 문자열 60000 은 숫자 60000 으로(예전: 문자열 그대로 저장)');
  assert.equal(typeof m.loadLlmConfig().timeoutMs, 'number');
  assert.equal(m.saveLlmConfig({ timeoutMs: '' }).timeoutMs, 60000, '빈 칸은 이전 값');
  assert.equal(m.saveLlmConfig({ timeoutMs: -1 }).timeoutMs, 60000, '음수는 이전 값');
  assert.equal(m.saveLlmConfig({ timeoutMs: 3e9 }).timeoutMs, 600_000, '2^31 초과는 10분');
  // 옛 파일에 이미 저장된 문자열도 로드에서 복구한다
  fs.writeFileSync(path.join(TMP, 'llm.json'), JSON.stringify({ timeoutMs: '45000' }));
  assert.equal(m.loadLlmConfig().timeoutMs, 45000);
  fs.writeFileSync(path.join(TMP, 'llm.json'), JSON.stringify({ timeoutMs: '' }));
  assert.equal(m.loadLlmConfig().timeoutMs, 30000, '빈 저장값은 기본값');
});

test('TIM2606-01: 저장된 문자열 타임아웃으로도 연결 테스트가 성공하고, resilientFetch 는 시한을 한 번 더 좁힌다', async () => {
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ models: [{ name: 'llama3.1' }] })); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const { ollamaTest } = await import('../src/llm/ollama.js');
    const url = `http://127.0.0.1:${srv.address().port}`;
    for (const t of ['60000', '-1', 3e9]) {
      const r = await ollamaTest({ url, model: 'llama3.1', timeoutMs: t });
      assert.equal(r.ok, true, `timeoutMs=${t}: ${r.reason}`);   // 예전: '60000' → ERR_INVALID_ARG_TYPE, 3e9 → 1ms abort
    }
  } finally { srv.close(); }
  const { normFetchTimeoutMs } = await import('../src/util/resilientFetch.js');
  assert.equal(normFetchTimeoutMs('60000'), 60000);
  assert.equal(normFetchTimeoutMs(3e9), 1_800_000);
  assert.equal(normFetchTimeoutMs(-5), 20_000);
  assert.equal(normFetchTimeoutMs(NaN), 20_000);
  assert.equal(normFetchTimeoutMs(15_000), 15_000, '정상 값은 그대로');
  // 저장 전 '연결 테스트'(본문 cfg)도 같은 정규화를 거친다
  const src = fs.readFileSync(path.join(SRC, 'routes/admin/deployLlm.js'), 'utf8');
  const route = src.slice(src.indexOf("'/llm-test'"), src.indexOf("'/llm-test'") + 600);
  assert.match(route, /cfg\.timeoutMs = normTimeoutMs\(cfg\.timeoutMs\)/, '/admin/llm-test 가 본문 timeoutMs 를 정규화한다');
});

// ── TIM2606-03 ────────────────────────────────────────────────────────────
function fakeConn(delayMs = 200) {
  return { exec(cmd, opts, cb) {
    if (typeof opts === 'function') { cb = opts; }
    const s = new EventEmitter(); s.stderr = new EventEmitter(); s.close = () => {}; s.destroy = () => {}; s.setWindow = () => {}; s.write = () => {}; s.end = () => {};
    cb(null, s); setTimeout(() => { s.emit('data', Buffer.from('ok\n')); s.emit('close', 0); }, delayMs);
  } };
}
test('TIM2606-03: 호출자가 준 SSH 명령 시한이 2^31 초과·NaN 이어도 즉시 타임아웃이 되지 않는다(단일 관문)', async () => {
  const { execAnswered, execTimeoutMs } = await import('../src/proxy/sshExec.js');
  for (const t of [3e9, NaN, -5]) {
    const t0 = Date.now();
    const out = await execAnswered(fakeConn(), 'switchshow', { timeoutMs: t });
    assert.equal(!!out.timedOut, false, `timeoutMs=${t}: ${Date.now() - t0}ms 만에 타임아웃(예전: 1ms)`);
    assert.match(out.stdout, /ok/);
  }
  assert.equal(execTimeoutMs(3e9), 1_800_000);
  assert.equal(execTimeoutMs(500), 1_000, '하한 1초는 예전(Math.max(1000, …))과 같다');
  assert.equal(execTimeoutMs(45_000), 45_000);
  const src = fs.readFileSync(path.join(SRC, 'proxy/sshExec.js'), 'utf8');
  const execFn = src.slice(src.indexOf('function exec(conn'), src.indexOf('function exec(conn') + 300);
  assert.match(execFn, /execTimeoutMs\(/, 'exec 도 같은 관문을 지난다');
});

test('TIM2606-03: SANSW_HTTP_TIMEOUT_MS 음수·2^31 초과는 범위에 가둔다', () => {
  for (const v of ['-5', '3000000000']) {
    const r = runChild(`
      const seen = [];
      AbortSignal.timeout = (ms) => { seen.push(ms); return AbortSignal.abort(); };
      const { collect } = await import('./src/sanswitch/collectors/fosRest.js');
      try { await collect({ id: 'x', host: '127.0.0.1', username: 'u', password: 'p' }); } catch { /* 중단 */ }
      console.log(JSON.stringify({ seen }));`, { SANSW_HTTP_TIMEOUT_MS: v });
    assert.ok(r.seen.length >= 1 && r.seen.every((ms) => ms >= 1_000 && ms <= 600_000), `SANSW_HTTP_TIMEOUT_MS=${v} → AbortSignal.timeout(${r.seen})`);
  }
  for (const [f, k] of [['sanswitch/collectors/fosSsh.js', 'SANSW_CLI_TIMEOUT_MS'], ['storage/collectors/cliSsh.js', 'STORAGE_CLI_TIMEOUT_MS']]) {
    assert.match(fs.readFileSync(path.join(SRC, f), 'utf8'), new RegExp(`CMD_TIMEOUT_MS = reqTimeoutMs\\(process\\.env\\.${k}`), `${f} ${k}`);
  }
});

// ── LEFT2606-04 ───────────────────────────────────────────────────────────
test('LEFT2606-04: DIRUSAGE_TICK_MS 2^31 초과는 1ms 루프가 되지 않고, GUESTDISK_TIMEOUT_MS 는 범위에 가둔다', () => {
  const r = runChild("const m = await import('./src/dirusage/scheduler.js'); console.log(JSON.stringify({ t: m.schedulerStatus().tickMs }));", { DIRUSAGE_TICK_MS: '3000000000' });
  assert.ok(r.t >= 30_000 && r.t <= 2 ** 31 - 1, `틱 ${r.t}(예전 3e9 → setInterval 1ms)`);
  const d = runChild("const m = await import('./src/dirusage/scheduler.js'); console.log(JSON.stringify({ t: m.schedulerStatus().tickMs }));", { DIRUSAGE_TICK_MS: '-1' });
  assert.ok(d.t >= 30_000, `음수 ${d.t}`);
  // GUESTDISK: 시한 상수는 모듈 안에 있고 vCenter 조회 경로로만 닿는다 — 정의 줄을 고정하고, 같은 헬퍼의 결과를 확인한다.
  assert.match(fs.readFileSync(path.join(SRC, 'guestdisk/service.js'), 'utf8'), /COLLECT_TIMEOUT_MS = reqTimeoutMs\(process\.env\.GUESTDISK_TIMEOUT_MS/, 'GUESTDISK_TIMEOUT_MS 가 reqTimeoutMs 를 지난다');
});

// ── DB2606-01 ─────────────────────────────────────────────────────────────
test('DB2606-01: 로그 보관 상태의 기간(MIN/MAX)은 매번 새로, 건수는 상태 폴링(30초)보다 긴 TTL 로 캐시한다', async () => {
  const { getLogsDb } = await import('../src/logs/db.js');
  const db = await getLogsDb();
  assert.equal(db.kind, 'sqlite');
  const base = Date.UTC(2026, 0, 10, 3, 30);
  db.insertMany(Array.from({ length: 50 }, (_, i) => ({ vcenterId: 'vc-a', key: `k${i}`, ts: base + i * 1000, severity: 'info', type: 't', user: '', entity: 'e', message: 'm' })));
  const m1 = db.meta();
  assert.equal(m1.count, 50);
  // 폴링 간격(30초)이 지나 새 로그가 들어왔다
  await withClock(31_000, () => {
    db.insertMany([{ vcenterId: 'vc-a', key: 'new', ts: base + 999_000, severity: 'info', type: 't', user: '', entity: 'e', message: 'n' }]);
    const m2 = db.meta();
    assert.equal(m2.lastTs, base + 999_000, '마지막 시각은 단독 MAX 로 매번 새로 읽는다');
    assert.equal(m2.count, 50, '30초 뒤의 다음 상태 폴링에서 풀스캔(COUNT·GROUP BY)을 다시 돌지 않는다(예전 TTL 30초 = 폴링 간격)');
  });
  await withClock(301_000, () => { assert.equal(db.meta().count, 51, 'TTL(기본 5분)이 지나면 건수를 다시 센다'); });
  const src = fs.readFileSync(path.join(SRC, 'logs/db.js'), 'utf8');
  assert.doesNotMatch(src, /SELECT COUNT\(\*\) n, MIN\(ts\) mn, MAX\(ts\) mx FROM events/, 'aggregate 3개 한 쿼리 금지(v2.550.3)');
});

// ── DB2606-02 ─────────────────────────────────────────────────────────────
test('DB2606-02: 스토리지 api_history·capacity_history 보존 정리는 청크로 나눠 지우고 사이에 양보한다', async () => {
  const sdb = await import('../src/storage/db.js');
  assert.equal(await sdb.dbAvailable(), true);
  const file = path.join(TMP, 'storage-history.db');
  const side = new DatabaseSync(file);
  side.exec('PRAGMA busy_timeout=3000');
  const old = Date.now() - 200 * DAY;
  side.exec('BEGIN');
  const ia = side.prepare('INSERT INTO api_history (device_id, area, ts, ok, bytes, error) VALUES (?,?,?,?,?,?)');
  const ic = side.prepare('INSERT INTO capacity_history (device_id, ts, total_bytes, used_bytes) VALUES (?,?,?,?)');
  for (let i = 0; i < 3000; i++) { ia.run('d1', 'a', old + i, 1, 10, null); ic.run('d1', old + i, 100, 50); }
  ia.run('d1', 'a', Date.now() - DAY, 1, 10, null); ic.run('d1', Date.now() - DAY, 100, 50);   // 보존 안의 행은 남아야 한다
  side.exec('COMMIT');
  const { yields } = await countYields(sdb.pruneNow());
  assert.equal(side.prepare('SELECT COUNT(*) n FROM api_history').get().n, 1);
  assert.equal(side.prepare('SELECT COUNT(*) n FROM capacity_history').get().n, 1);
  assert.ok(yields >= 6, `청크 사이 양보 ${yields}회(6천 행 / 청크 500 — 예전: 한 문장 동기 삭제)`);
  side.close();
});

// ── DB2606-03 ─────────────────────────────────────────────────────────────
test('DB2606-03: RMA 점검·실행 이력과 SAN 점검 이력 DB 는 첫 open 잠금을 래치하지 않고, 원인을 잠금으로 말한다', async () => {
  const files = ['rma-tests.db', 'rma-history.db', 'san-health.db'].map((f) => path.join(TMP, f));
  const lockers = files.map((f) => { const c = new DatabaseSync(f); c.exec('BEGIN EXCLUSIVE'); return c; });
  const warns = []; const origWarn = console.warn; console.warn = (...a) => { warns.push(a.join(' ')); };
  const tr = await import('../src/rma/testResults.js');
  const hd = await import('../src/rma/historyDb.js');
  const hh = await import('../src/sanswitch/healthHistory.js');
  try {
    assert.equal((await tr.testHistory('edge-a', 't1')).unavailable, true, '잠긴 동안은 비활성');
    assert.equal(await hd.historyAvailable(), false);
    const st = await hh.healthHistoryStatus();
    assert.equal(st.available, false);
    assert.equal(st.locked, true, '상태가 잠금임을 밝힌다');
  } finally { console.warn = origWarn; }
  assert.ok(warns.some((w) => /\[rma\] 이력 DB 잠김/.test(w)), `RMA 실행 이력 경고가 잠금을 말한다: ${warns.join(' | ')}`);
  assert.ok(!warns.some((w) => /node:sqlite 없음/.test(w)), '잠금을 모듈 부재로 말하지 않는다');
  for (const c of lockers) { c.exec('COMMIT'); c.close(); }
  // 잠금이 풀리고 재시도 시각(30초)이 지나면 다시 열린다 — 예전: 재시작 전까지 비활성 래치
  await withClock(31_000, async () => {
    assert.equal((await tr.testHistory('edge-a', 't1')).unavailable, undefined, 'RMA 점검 이력 복구');
    assert.equal(await hd.historyAvailable(), true, 'RMA 실행 이력 복구');
    assert.equal((await hh.healthHistoryStatus()).available, true, 'SAN 점검 이력 복구');
  });
});

// ── DB2606-05 ─────────────────────────────────────────────────────────────
test('DB2606-05: RMA 이력의 NOCASE agent 조회가 인덱스를 타고, testHistory hours 는 보존일로 상한', async () => {
  const tr = await import('../src/rma/testResults.js');
  const hd = await import('../src/rma/historyDb.js');
  assert.equal(await hd.historyAvailable(), true);
  await tr.testHistory('x', 'y');   // 스키마 생성
  const side = new DatabaseSync(path.join(TMP, 'rma-history.db'));
  const planH = side.prepare('EXPLAIN QUERY PLAN SELECT * FROM rma_history WHERE agent = ? COLLATE NOCASE ORDER BY done_at DESC LIMIT ?').all('EDGE-A', 10).map((r) => r.detail).join(' | ');
  assert.match(planH, /idx_rma_agent_nc_done/, `실행 이력 조회 계획: ${planH}(예전 SCAN USING INDEX idx_rma_done)`);
  side.close();
  const side2 = new DatabaseSync(path.join(TMP, 'rma-tests.db'));
  const planT = side2.prepare('EXPLAIN QUERY PLAN SELECT * FROM test_results WHERE agent = ? COLLATE NOCASE AND test_id = ? AND ts >= ? ORDER BY ts DESC LIMIT ?').all('EDGE-A', 't1', 0, 10).map((r) => r.detail).join(' | ');
  assert.match(planT, /idx_tr_key_nc_ts/, `점검 이력 조회 계획: ${planT}(예전 idx_tr_ts 범위 전 agent)`);
  // 보존일(기본 90일)보다 오래된 행은 hours 를 크게 줘도 나오지 않는다
  side2.prepare('INSERT INTO test_results (agent, test_id, instance, ts, status, reply, value) VALUES (?,?,?,?,?,?,?)').run('edge-b', 't9', '', Date.now() - 200 * DAY, 'ok', '', null);
  side2.prepare('INSERT INTO test_results (agent, test_id, instance, ts, status, reply, value) VALUES (?,?,?,?,?,?,?)').run('edge-b', 't9', '', Date.now() - 10 * DAY, 'ok', '', null);
  side2.close();
  const r = await tr.testHistory('EDGE-B', 't9', { hours: 1e6 });
  assert.equal(r.rows.length, 1, `hours=1e6 → 보존일 안의 행만(${r.rows.length})`);
  assert.equal((await tr.testHistory('edge-b', 't9', { hours: 'abc' })).rows.length, 0, '숫자가 아닌 hours 는 기본 24시간');
});
