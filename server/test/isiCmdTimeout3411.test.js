/**
 * isiCmdTimeout3411.test.js — v3.41.1 버그 점검 1회차(v3.39.0 PowerScale SSH 명령 대기 시간 설정의 후속 수정).
 *
 * 사용자 지시: "고치면서 버그 있는지 확인해서 버그 없을때까지 계속 수정". 독립 검토가 재현한 것:
 *  ① 연결 테스트(바깥 시한 60초)에서 부가 명령 하나가 응답하지 않으면 테스트가 통째로 '시간 초과' — v3.39.0 이 부가 명령을 설정값(3분)까지
 *     기다리게 하면서 이 경로를 빠뜨린 회귀. 예전에는 호출부의 짧은 시한(20초·45초·exec 기본값)에 그 명령만 끊겼다.
 *  ② 세션 예산이 시한을 줄여 끝까지 기다리지 못한 시리얼 조회가 '실패' 로 1시간 기억돼, 다음 수집에서 다시 묻지 않는다.
 *  ③ 시리얼 '예산 초과' 사유가 실제 경과와 무관하게 늘 "이미 100초 걸려" 라고 말한다.
 *  ④ 엣지 재시작 직후 첫 수집이 중앙 값을 받기 전에 돈다(시한은 늦게 먹으면 실패가 된다) — 첫 수집을 첫 설정 pull 뒤로.
 *  ⑤ SSH_EXEC_TIMEOUT_MS 를 3분보다 길게 잡아 넘기던 엣지는 업그레이드 뒤 isi 명령 대기가 줄어든다 — 옛 env 가 로컬 값을 올린다.
 *
 * ⚠ SSH exec 기본 시한을 1초로 축척한다(모듈 로드 시 굳는다) — 프로젝트 모듈은 전부 아래에서 동적 import 한다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'isi-cmd-timeout-3411-'));
process.env.CONFIG_DIR = TMP;
process.env.SSH_HOSTKEY_POLICY = 'observe';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.SSH_EXEC_TIMEOUT_MS = '1000';   // 예전 isi 명령 시한(exec 기본값 60초)을 1초로 축척
for (const k of ['STORAGE_ISI_CMD_TIMEOUT_MS', 'STORAGE_DEVICE_TIMEOUT_MS', 'STORAGE_CLI_SESSION_BUDGET_MS', 'STORAGE_INTERVALS_LOCAL',
  'STORAGE_POLL_MS', 'STORAGE_PUSH_MS', 'STORAGE_CONFIG_PULL_MS', 'STORAGE_AREAS_MS', 'CENTRAL_URL', 'CENTRAL_TOKEN']) delete process.env[k];
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const SRC = new URL('../src/', import.meta.url);
const require = createRequire(import.meta.url);
const ssh2 = require('ssh2');
// ⚠ ssh2 의 ed25519 생성기는 자기 파서가 거부하는 키를 0.5% 만든다(v2.590 릴리스 CI 사고) — EC SEC1 PEM 을 쓴다.
const HOST_KEY = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' });

/** 명령별 응답 — 문자열(즉시) · { out, delayMs }(늦게) · null(응답하지 않는다). */
async function fakeSsh(respond) {
  const seen = [];
  const timers = new Set();
  const srv = new ssh2.Server({ hostKeys: [HOST_KEY] }, (client) => {
    client.on('authentication', (ctx) => ctx.accept());
    client.on('error', () => {});
    client.on('ready', () => client.on('session', (accept) => {
      const s = accept();
      s.on('exec', (acc, _rej, info) => {
        const ch = acc(); const cmd = info.command; seen.push(cmd);
        const r = respond(cmd);
        if (r == null) return;
        const send = (out) => { try { ch.write(out); ch.exit(0); ch.end(); } catch { /* 클라이언트가 먼저 끊었다 */ } };
        if (typeof r === 'string') return send(r);
        const t = setTimeout(() => { timers.delete(t); send(r.out); }, r.delayMs);
        timers.add(t);
      });
    }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, seen, close: () => { for (const t of timers) clearTimeout(t); return new Promise((r) => srv.close(() => r())); } };
}

const ISI_STATUS = `Cluster Name: isi-demo
Cluster Health:     [  OK ]
Cluster Storage:  HDD                 SSD Storage
Size:             100.0T (100.0T Raw) 0 (0 Raw)
VHS Size:         0
Used:             40.0T (40%)         0 (n/a)
Avail:            60.0T (60%)         0 (n/a)

                   Health  Throughput (bps)  HDD Storage      SSD Storage
ID |IP Address     |DASR |  In   Out  Total| Used / Size     |Used / Size
---+---------------+-----+-----+-----+-----+-----------------+-----------------
  1|10.0.0.1       | OK  |  0  |  0  |  0  |20.0T/ 50.0T( 40%)|(No Storage SSDs)
  2|10.0.0.2       | OK  |  0  |  0  |  0  |20.0T/ 50.0T( 40%)|(No Storage SSDs)
`;
const devOf = (srv, id) => ({ id, type: 'isilon', name: id, host: '127.0.0.1', sshPort: srv.port, username: 'root', password: 'pw' });


/** isi status 는 즉시 · `hang` 에 든 명령은 응답하지 않는다 · 그 밖은 빈 출력으로 즉시. */
const respondExcept = (hang) => (c) => (c === 'isi status' ? ISI_STATUS : hang(c) ? null : '');

/* ══════════════════════ ① 연결 테스트 ══════════════════════ */

test('① 연결 테스트: 부가 명령 하나(isi version)가 응답하지 않아도 그 명령만 짧게 끊고 성공한다 — 실제 진입 함수(testDeviceConnection)', async () => {
  const poller = await import(new URL('storage/poller.js', SRC));
  const srv = await fakeSsh(respondExcept((c) => c === 'isi version'));
  try {
    const t0 = Date.now();
    // 바깥 시한 8초. 고치기 전: isi version 을 min(명령 대기 3분, 예산 280초) 기다리다 8초에 '테스트 시간 초과'.
    const r = await poller.testDeviceConnection({ ...devOf(srv, 'isi-test-1'), collectMethod: 'ssh' }, { timeoutMs: 8_000 });
    const ms = Date.now() - t0;
    assert.equal(r.ok, true, `부가 명령 하나의 무응답이 테스트를 통째로 실패시키면 안 된다: ${r.error}`);
    assert.ok(!/테스트 시간 초과/.test(String(r.error || '')));
    assert.equal(r.nodes?.count, 2, 'isi status 결과는 살아 있다');
    assert.ok(ms < 6_000, `호출부의 짧은 시한(여기서는 exec 기본 1초)에 끊겨야 한다: ${ms}ms`);
    assert.ok(srv.seen.includes('isi auth users list --format json'), '뒤 명령은 계속 돈다');
  } finally { await srv.close(); }
});

test('① 연결 테스트: 부가 명령이 전부 매달려도 바깥 시한 안에 끝난다(예산 = 바깥 시한 − 여유) — isi status 결과를 버리지 않는다', async () => {
  const isiMod = await import(new URL('storage/collectors/isilon.js', SRC));
  const hw = await import(new URL('storage/collectors/isilonHw.js', SRC));
  const pw = await import(new URL('storage/collectors/isilonPower.js', SRC));
  hw._resetIsiHwCacheForTest(); pw._resetIsiPowerCache();
  const srv = await fakeSsh(respondExcept(() => true));
  try {
    const t0 = Date.now();
    // 바깥 시한 26초로 알려 준다 → 예산 6초. 통계(호출부 20초)는 예산에 잘리고 뒤 명령은 시작하지 않는다.
    const snap = await isiMod.collect({ ...devOf(srv, 'isi-test-2'), collectMethod: 'ssh', _test: true, _testTimeoutMs: 26_000 });
    const ms = Date.now() - t0;
    assert.equal(snap.ok, true, snap.error);
    assert.ok(ms < 12_000, `예산(6초) 근처에서 끝나야 한다: ${ms}ms`);
    assert.ok(snap.extra?.cliSkipped >= 1, '끝까지 기다리지 못한 · 시작하지 않은 명령을 밝힌다');
    assert.match(snap.sections.accounts, /^미수집\(수집 시간 예산 초과/);
  } finally { await srv.close(); }
});

test('① 주기 수집은 그대로 설정값까지 기다린다 — quick 은 연결 테스트에만(소스 + 동작)', async () => {
  const isi = await import(new URL('storage/collectors/isilonSsh.js', SRC));
  const src = fs.readFileSync(new URL('storage/collectors/isilon.js', SRC), 'utf8');
  assert.match(src, /if \(device\._test\) \{[\s\S]{0,400}collectViaSsh\(device, \{ quick: true, budgetMs:/);
  assert.match(fs.readFileSync(new URL('storage/poller.js', SRC), 'utf8'), /_test: true, _testTimeoutMs: effMs/);
  // 주기 수집(quick 아님): isi version 이 1.6초 걸려도(exec 기본 1초보다 길다) 받는다
  const srv = await fakeSsh((c) => (c === 'isi status' ? ISI_STATUS : c === 'isi version' ? { out: 'Isilon OneFS v9.7.1.7\n', delayMs: 1_600 } : ''));
  try {
    const snap = await isi.collectViaSsh(devOf(srv, 'isi-periodic'));
    assert.match(String(snap.version || ''), /9\.7\.1\.7/);
  } finally { await srv.close(); }
});

/* ══════════════════════ ② ③ 시리얼 ══════════════════════ */

test('② 예산이 시한을 줄여 끊긴 시리얼 조회는 실패로 기억하지 않는다 — 다음 수집에서 다시 묻는다', async () => {
  const isi = await import(new URL('storage/collectors/isilonSsh.js', SRC));
  const hw = await import(new URL('storage/collectors/isilonHw.js', SRC));
  const pw = await import(new URL('storage/collectors/isilonPower.js', SRC));
  hw._resetIsiHwCacheForTest(); pw._resetIsiPowerCache();
  const srv = await fakeSsh(respondExcept((c) => c === hw.ISI_HW_CMD));
  try {
    const dev = devOf(srv, 'isi-hw-cut');
    // 명령 대기 30초(주입) · 예산 3초 — 시리얼은 남은 예산(약 3초)으로 잘린 시한에 끊긴다(명령 대기까지 기다린 것이 아니다).
    const s1 = await isi.collectViaSsh(dev, { cmdTimeoutMs: 30_000, budgetMs: 3_000 });
    assert.equal(s1.ok, true, s1.error);
    assert.equal(s1.extra.nodeSerialProbe?.reason, 'budget', `실패('exec')가 아니라 예산 갈래: ${JSON.stringify(s1.extra.nodeSerialProbe)}`);
    assert.match(s1.extra.nodeSerialProbe.detail, /끝까지 기다리지 못했습니다/);
    assert.ok(s1.extra.cliSkippedCmds.some((c) => c.startsWith('isi_for_array')), '끝까지 기다리지 못한 명령을 밝힌다');
    const before = srv.seen.filter((c) => c === hw.ISI_HW_CMD).length;
    await isi.collectViaSsh(dev, { cmdTimeoutMs: 30_000, budgetMs: 3_000 });
    assert.equal(srv.seen.filter((c) => c === hw.ISI_HW_CMD).length, before + 1, '실패로 1시간 기억했다면 다시 묻지 않는다');
  } finally { await srv.close(); }
});

test('② 예산이 넉넉한데 명령 대기 시간에 끊긴 것은 그대로 실패다(예산 갈래로 숨기지 않는다)', async () => {
  const isi = await import(new URL('storage/collectors/isilonSsh.js', SRC));
  const hw = await import(new URL('storage/collectors/isilonHw.js', SRC));
  const pw = await import(new URL('storage/collectors/isilonPower.js', SRC));
  hw._resetIsiHwCacheForTest(); pw._resetIsiPowerCache();
  const srv = await fakeSsh(respondExcept((c) => c === hw.ISI_HW_CMD));
  try {
    const snap = await isi.collectViaSsh(devOf(srv, 'isi-hw-real'), { cmdTimeoutMs: 700, budgetMs: 60_000 });
    assert.equal(snap.extra.nodeSerialProbe?.reason, 'exec');
    assert.equal(snap.extra.cliSkipped, undefined);
  } finally { await srv.close(); hw._resetIsiHwCacheForTest(); }
});

test('③ 예산이 바닥나 시작하지 않은 시리얼의 사유는 꾸며 낸 경과("이미 100초")를 말하지 않는다', async () => {
  const isi = await import(new URL('storage/collectors/isilonSsh.js', SRC));
  const hw = await import(new URL('storage/collectors/isilonHw.js', SRC));
  hw._resetIsiHwCacheForTest();
  const srv = await fakeSsh(respondExcept(() => false));
  try {
    const snap = await isi.collectViaSsh(devOf(srv, 'isi-hw-skip'), { budgetMs: 1 });   // 접속하자마자 바닥
    assert.equal(snap.ok, true, snap.error);
    assert.equal(snap.extra.nodeSerialProbe?.reason, 'budget');
    assert.doesNotMatch(snap.extra.nodeSerialProbe.detail, /\d+초 걸려/, snap.extra.nodeSerialProbe.detail);
    assert.match(snap.extra.nodeSerialProbe.detail, /수집 시간 예산이 모자라/);
    assert.ok(!srv.seen.includes(hw.ISI_HW_CMD));
  } finally { await srv.close(); }
  // 모듈 단독: 예산 갈래는 직전 성공값을 그대로 돌려주고 기억을 바꾸지 않는다 · 옛 경과 판정(100초)은 그대로 실제 경과를 말한다
  const fakeSh = { exec: async () => { const e = new Error('x'); e.code = 'SESSION_BUDGET'; throw e; } };
  const r = await hw.readIsiHwSsh(fakeSh, { id: 'solo', host: 'h' }, {});
  assert.equal(r.reason, 'budget');
  const r2 = await hw.readIsiHwSsh({ exec: async () => { throw new Error('boom'); } }, { id: 'solo', host: 'h' }, {});
  assert.equal(r2.reason, 'exec', '예산 갈래를 기억하지 않았으므로 바로 다시 시도한다');
  const r3 = await hw.readIsiHwSsh(fakeSh, { id: 'solo2', host: 'h2' }, { sessionStartedAt: Date.now() - 130_000 });
  assert.match(r3.detail, /이미 130초 걸려/);
  hw._resetIsiHwCacheForTest();
});

/* ══════════════════════ ④ 엣지 첫 수집 ══════════════════════ */

test('④ 엣지의 첫 수집은 첫 설정 pull 이 끝난 뒤다 — pull 시작 10초 + 한 번의 시한 20초 < 첫 수집 지연', () => {
  const poll = fs.readFileSync(new URL('storage/poller.js', SRC), 'utf8');
  const pull = fs.readFileSync(new URL('agent/storageConfigPull.js', SRC), 'utf8');
  const delay = Number(/export const EDGE_FIRST_POLL_DELAY_MS = ([\d_]+);/.exec(poll)?.[1]?.replace(/_/g, ''));
  const pullFirst = Number(/startAdaptiveTimer\(configPullMs, \(\) => pullStorageConfigNow\(\), \{ firstDelayMs: ([\d_]+)/.exec(pull)?.[1]?.replace(/_/g, ''));
  const pullTimeout = Number(/storage-config\?agent=[\s\S]{0,400}?timeoutMs: ([\d_]+)/.exec(pull)?.[1]?.replace(/_/g, ''));
  assert.ok(Number.isFinite(delay) && Number.isFinite(pullFirst) && Number.isFinite(pullTimeout), `${delay} ${pullFirst} ${pullTimeout}`);
  assert.ok(pullFirst + pullTimeout < delay, `첫 pull(${pullFirst} + ${pullTimeout}) 이 첫 수집(${delay}) 전에 끝나야 한다`);
  assert.match(poll, /firstDelayMs: isEdgeNode \? EDGE_FIRST_POLL_DELAY_MS : 15_000/, '중앙(직접 수집)은 예전 그대로 15초');
});

/* ══════════════════════ ⑤ 옛 env ══════════════════════ */

test('⑤ SSH_EXEC_TIMEOUT_MS 가 3분보다 길면 로컬 값으로 쓴다(올리기만 · 상한 5분) — 이 항목의 env · 중앙 지정이 우선', async () => {
  const iv = await import(new URL('storage/intervals.js', SRC));
  const keep = process.env.SSH_EXEC_TIMEOUT_MS;
  const val = () => iv.envIntervals().isiCmdTimeoutMs;
  const from = () => iv.runtimeIntervalSource().find((x) => x.key === 'isiCmdTimeoutMs').from;
  iv._resetForTest();
  try {
    for (const [env, want, src] of [['240000', 240_000, 'env'], ['300000', 300_000, 'env'], ['600000', 300_000, 'env'],
      ['180000', 180_000, 'default'], ['60000', 180_000, 'default'], ['1000', 180_000, 'default'],
      ['3000000000', 180_000, 'default'], ['abc', 180_000, 'default'], ['', 180_000, 'default'], ['-5', 180_000, 'default']]) {
      process.env.SSH_EXEC_TIMEOUT_MS = env;
      assert.equal(val(), want, `SSH_EXEC_TIMEOUT_MS='${env}'`);
      assert.equal(from(), src, `출처 SSH_EXEC_TIMEOUT_MS='${env}'`);
    }
    process.env.SSH_EXEC_TIMEOUT_MS = '300000';
    process.env.STORAGE_ISI_CMD_TIMEOUT_MS = '120000';
    assert.equal(val(), 120_000, '이 항목의 env 가 있으면 옛 env 는 보지 않는다');
    delete process.env.STORAGE_ISI_CMD_TIMEOUT_MS;
    iv.applyCentralIntervals({ isiCmdTimeoutMs: 60_000 });
    assert.equal(iv.runtimeIntervals().isiCmdTimeoutMs, 60_000, '중앙 지정이 우선');
    assert.equal(from(), 'central');
    // 다른 항목은 옛 env 의 영향을 받지 않는다
    assert.equal(iv.envIntervals().pollMs, 3_600_000);
  } finally {
    delete process.env.STORAGE_ISI_CMD_TIMEOUT_MS;
    if (keep === undefined) delete process.env.SSH_EXEC_TIMEOUT_MS; else process.env.SSH_EXEC_TIMEOUT_MS = keep;
    iv._resetForTest();
  }
});
