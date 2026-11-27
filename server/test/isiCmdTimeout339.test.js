/**
 * isiCmdTimeout339.test.js — v3.39.0 PowerScale(Isilon) SSH 명령 대기 시간 설정.
 *
 * 사용자 보고: "파워스케일에서 ssh 명령어로 isi 명령어 실행하는데 처리에 오래 걸려서 timeout 이 발생하고 있어, timeout 시간을 설정하는
 * 메뉴를 설정에 만들어줘, 최대 5분까지 기다리는 설정을 하고, 기본값으로 3분으로 설정해줘" · 선택: 모든 isi 명령에 적용 · 기존 화면에 항목 추가.
 *
 * 고정하는 것(틀리면 운영에서 조용히 잘못 도는 것들):
 *  ① 사양 — 기본 3분 · 하한 1분 · 상한 5분, '못 읽은 값' 은 하한으로 승격하지 않는다.
 *  ② 시한 산수 — 명령 대기 < 세션 예산 < 장비 시한. 명령 대기만 올리면 장비 시한이 먼저 끊어 받은 결과까지 버린다(v2.528·v2.741 과 같은 유형).
 *  ③ 수집기가 **실제로** 설정값까지 기다린다(필수 isi status · 부가 명령 모두) — 예전 시한(exec 기본값)으로는 실패하던 응답을 받는다.
 *  ④ 시한(`timer: false`)만 바뀌면 폴러·push·pull 타이머를 다시 잡지 않는다.
 *  ⑤ 중앙 → 엣지 배포 경로(지정한 키만) · 폴러 장비 시한 · 중앙의 재수집 결과 대기 시한이 같은 값에서 나온다.
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'isi-cmd-timeout-'));
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

/* ══════════════════════ ① 사양 ══════════════════════ */

test('① 사양 — 기본 3분 · 하한 1분 · 상한 5분 · 주기가 아닌 시한(timer:false) · 선택지는 사양이 싣는다', async () => {
  const iv = await import(new URL('storage/intervals.js', SRC));
  const s = iv.INTERVAL_SPEC.find((x) => x.key === 'isiCmdTimeoutMs');
  assert.ok(s, '사양에 항목이 있다');
  assert.equal(s.def, 180_000); assert.equal(s.min, 60_000); assert.equal(s.max, 300_000);
  assert.equal(s.timer, false);
  assert.equal(s.env, 'STORAGE_ISI_CMD_TIMEOUT_MS');
  assert.deepEqual(s.presets, [60_000, 120_000, 180_000, 240_000, 300_000]);
  assert.ok(s.presets.every((ms) => ms >= s.min && ms <= s.max) && s.presets.includes(s.def));
  assert.ok(!/`/.test(s.hint) && !/`/.test(s.label), '화면 문구에 백틱 금지');
  // 다른 항목은 상한 24시간 그대로(이 항목 때문에 좁아지지 않는다)
  assert.equal(iv.normalizeIntervals({ pollMs: 99 * 3_600_000 }).values.pollMs, 86_400_000);
});

test('① 정규화 — 상한 초과는 5분으로 내리고 사유를 남긴다 · 하한 미만은 1분으로 · 빈 값·0·문자는 버린다(하한 승격 금지)', async () => {
  const iv = await import(new URL('storage/intervals.js', SRC));
  const hi = iv.normalizeIntervals({ isiCmdTimeoutMs: 600_000 });
  assert.equal(hi.values.isiCmdTimeoutMs, 300_000);
  assert.match(hi.issues.join(' '), /PowerScale SSH 명령 대기: 상한 5분으로 내림/);
  assert.equal(iv.normalizeIntervals({ isiCmdTimeoutMs: 5_000 }).values.isiCmdTimeoutMs, 60_000);
  for (const bad of ['', null, undefined, 0, '0', 'abc', -1, NaN]) {
    assert.equal('isiCmdTimeoutMs' in iv.normalizeIntervals({ isiCmdTimeoutMs: bad }).values, false, `버려야 한다: ${String(bad)}`);
  }
  const t = await import(new URL('storage/isiTimeouts.js', SRC));
  for (const bad of ['', null, undefined, 0, 'abc', -5, NaN, Infinity]) assert.equal(t.clampIsiCmdTimeoutMs(bad), 180_000, `못 읽은 값은 기본값: ${String(bad)}`);
  assert.equal(t.clampIsiCmdTimeoutMs(1), 60_000); assert.equal(t.clampIsiCmdTimeoutMs(9e9), 300_000); assert.equal(t.clampIsiCmdTimeoutMs('240000'), 240_000);
});

test('① env — STORAGE_ISI_CMD_TIMEOUT_MS 는 [1분, 5분] 에 갇히고, 없으면 3분', async () => {
  const iv = await import(new URL('storage/intervals.js', SRC));
  assert.equal(iv.envIntervals().isiCmdTimeoutMs, 180_000);
  try {
    process.env.STORAGE_ISI_CMD_TIMEOUT_MS = '3000000000'; assert.equal(iv.envIntervals().isiCmdTimeoutMs, 300_000);
    process.env.STORAGE_ISI_CMD_TIMEOUT_MS = '1000'; assert.equal(iv.envIntervals().isiCmdTimeoutMs, 60_000);
    process.env.STORAGE_ISI_CMD_TIMEOUT_MS = '240000'; assert.equal(iv.envIntervals().isiCmdTimeoutMs, 240_000);
    process.env.STORAGE_ISI_CMD_TIMEOUT_MS = 'x'; assert.equal(iv.envIntervals().isiCmdTimeoutMs, 180_000);
  } finally { delete process.env.STORAGE_ISI_CMD_TIMEOUT_MS; }
});

/* ══════════════════════ ② 시한 산수 ══════════════════════ */

test('② 산수 — 선택지 전부에서: 접속 + 명령 대기 ≤ 세션 예산 < 장비 시한, 필수 경로 최악에도 부가 명령 몫이 남는다', async () => {
  const t = await import(new URL('storage/isiTimeouts.js', SRC));
  assert.equal(t.ISI_SESSION_EXTRA_MS, t.ISI_CONNECT_ALLOWANCE_MS + t.ISI_AUX_FLOOR_MS + t.ISI_DEADLINE_MARGIN_MS);
  const BASE = 180_000;   // storage/poller.js 기본 장비 시한
  for (const cmd of [...t.ISI_CMD_TIMEOUT_PRESETS, t.ISI_CMD_TIMEOUT_MIN_MS, t.ISI_CMD_TIMEOUT_MAX_MS]) {
    const dev = t.isiDeviceTimeoutFor(cmd, BASE);
    const budget = t.isiSessionBudgetFor(cmd, BASE);
    assert.ok(dev >= BASE, `장비 시한은 기존 값보다 줄지 않는다(${cmd})`);
    assert.ok(budget + t.ISI_DEADLINE_MARGIN_MS <= dev, `예산 ${budget} 은 장비 시한 ${dev} 보다 여유만큼 작다(${cmd})`);
    assert.ok(t.ISI_CONNECT_ALLOWANCE_MS + cmd + t.ISI_AUX_FLOOR_MS <= budget, `접속 + isi status 최악 뒤에도 부가 명령 몫이 남는다(${cmd})`);
  }
  assert.equal(t.isiDeviceTimeoutFor(180_000, BASE), 300_000, '기본 3분 → 장비 시한 5분');
  assert.equal(t.isiDeviceTimeoutFor(300_000, BASE), 420_000, '상한 5분 → 장비 시한 7분');
  assert.equal(t.isiDeviceTimeoutFor(60_000, BASE), 180_000, '1분 → 기존 장비 시한 그대로');
  assert.equal(t.isiDeviceTimeoutFor(180_000, 900_000), 900_000, '현장이 장비 시한을 더 길게 잡았으면 그 값');
  // 명시한 예산 상한은 지킨다 — 그래도 장비 시한보다 작다
  assert.equal(t.isiSessionBudgetFor(180_000, BASE, { capMs: 150_000 }), 150_000);
  assert.ok(t.isiSessionBudgetFor(180_000, BASE, { capMs: 999_999 }) < t.isiDeviceTimeoutFor(180_000, BASE));
});

/* ══════════════════════ ③ 수집기 — 실제로 기다린다 ══════════════════════ */

test('③ 느린 isi status·isi version 을 설정값까지 기다린다 — 예전 시한(exec 기본값, 여기서는 1초)이면 장비가 통째로 실패했다', async () => {
  const isi = await import(new URL('storage/collectors/isilonSsh.js', SRC));
  const sshExec = await import(new URL('proxy/sshExec.js', SRC));
  assert.equal(sshExec.execTimeoutMs(), 1_000, '축척 전제 — exec 기본 시한 1초');
  assert.equal(isi.isiCmdTimeoutMs(), 180_000, '설정값(기본 3분)');
  const srv = await fakeSsh((c) => (c === 'isi status' ? { out: ISI_STATUS, delayMs: 2_200 }
    : c === 'isi version' ? { out: 'Isilon OneFS v9.7.1.7 B_9_7_1_7_010(RELEASE)\n', delayMs: 1_600 } : ''));
  try {
    const snap = await isi.collectViaSsh(devOf(srv, 'isi-slow'));
    assert.equal(snap.ok, true, snap.error);
    assert.ok(snap.capacity?.totalBytes > 0);
    assert.equal(snap.nodes?.count, 2);
    assert.match(String(snap.version || ''), /9\.7\.1\.7/, '부가 명령(isi version)도 설정값까지 기다린다');
    assert.equal(snap.extra?.cliSkipped, undefined, '예산으로 건너뛴 명령이 없다');
  } finally { await srv.close(); }
});

test('③ 부가 명령의 시한은 호출부가 넘긴 값(20초·45초)이 아니라 명령 대기 시간이다 — 전부 매달려도 명령 대기 × 명령 수 안에 끝난다', async () => {
  const isi = await import(new URL('storage/collectors/isilonSsh.js', SRC));
  const hw = await import(new URL('storage/collectors/isilonHw.js', SRC));
  const pw = await import(new URL('storage/collectors/isilonPower.js', SRC));
  hw._resetIsiHwCacheForTest(); pw._resetIsiPowerCache();
  const srv = await fakeSsh((c) => (c === 'isi status' ? ISI_STATUS : null));
  try {
    const t0 = Date.now();
    // 명령 대기 700ms(주입) · 예산 넉넉 — 통계(예전 20초)·전원 키(20초)·버전·계정·시리얼(45초)이 모두 700ms 에 끊겨야 한다.
    const snap = await isi.collectViaSsh(devOf(srv, 'isi-aux'), { cmdTimeoutMs: 700, budgetMs: 60_000 });
    const ms = Date.now() - t0;
    assert.equal(snap.ok, true, snap.error);
    assert.ok(ms < 12_000, `부가 명령이 예전 시한(20초·45초)을 기다렸다: ${ms}ms`);
    for (const c of [isi.ISI_STATS_CMD, 'isi version', 'isi auth users list --format json', hw.ISI_HW_CMD]) assert.ok(srv.seen.includes(c), `시작해야 한다: ${c}`);
    assert.equal(snap.extra?.cliSkipped, undefined, '예산이 남아 있으므로 건너뛴 명령은 없다(시한 초과는 건너뜀이 아니다)');
  } finally { await srv.close(); }
});

test('③ isi status 가 명령 대기 시간을 넘기면 실패 문구에 어디서 늘리는지 붙인다 — 인증 실패로 읽히지 않는다', async () => {
  const isi = await import(new URL('storage/collectors/isilonSsh.js', SRC));
  const { isAuthFailure } = await import(new URL('storage/authGuard.js', SRC));
  const srv = await fakeSsh(() => null);
  try {
    const snap = await isi.collectViaSsh(devOf(srv, 'isi-timeout'), { cmdTimeoutMs: 600 });
    assert.equal(snap.ok, false);
    assert.match(snap.error, /^SSH 수집 실패: SSH exec 타임아웃\(1s\): isi status/);
    assert.match(snap.error, /설정 › 수집 주기·임계 › 스토리지 수집 주기의 ‘PowerScale SSH 명령 대기’ 를 늘려 보세요/);
    assert.ok(!/`/.test(snap.error), '화면에 나가는 문구 — 백틱 금지');
    assert.equal(isAuthFailure(snap), false, '시한 초과는 인증 실패가 아니다(주기 수집을 멈추지 않는다)');
  } finally { await srv.close(); }
  // 이미 상한이면 '늘려 보세요' 가 아니라 장비 쪽을 보라고 말한다
  assert.match(isi.isiTimeoutHint(300_000), /이미 상한\(5분\)/);
  assert.match(isi.isiTimeoutHint(180_000), /지금 180초 · 상한 5분/);
});

/* ══════════════════════ ④ 타이머 ══════════════════════ */

test('④ 시한만 바뀌면 타이머 리스너를 부르지 않는다 — 값은 바로 먹는다 · 주기가 바뀌면 부른다', async () => {
  const iv = await import(new URL('storage/intervals.js', SRC));
  const isi = await import(new URL('storage/collectors/isilonSsh.js', SRC));
  iv._resetForTest();
  let calls = 0;
  const off = iv.onIntervalsChange(() => { calls += 1; });
  try {
    const r = iv.applyCentralIntervals({ isiCmdTimeoutMs: 300_000 });
    assert.equal(r.applied, true); assert.equal(r.effectiveChanged, true); assert.equal(r.timersChanged, false);
    assert.equal(calls, 0, '주기가 아닌 값 — 폴러·push·pull 타이머를 다시 잡지 않는다');
    assert.equal(iv.runtimeIntervals().isiCmdTimeoutMs, 300_000);
    assert.equal(isi.isiCmdTimeoutMs(), 300_000, '수집기는 매번 읽는다(모듈 로드 시 굳지 않는다)');
    assert.equal(isi.isiDeviceTimeoutMs(), 420_000); assert.equal(isi.isiSessionBudgetMs(), 400_000);
    const r2 = iv.applyCentralIntervals({ isiCmdTimeoutMs: 300_000, pollMs: 120_000 });
    assert.equal(r2.timersChanged, true); assert.equal(calls, 1);
    // 중앙이 지정을 거두면(빈 객체) 로컬(기본 3분)로 돌아간다
    iv.applyCentralIntervals({});
    assert.equal(isi.isiCmdTimeoutMs(), 180_000);
  } finally { off(); iv._resetForTest(); }
});

test('④ STORAGE_INTERVALS_LOCAL=1(현장 고정)은 이 값도 중앙 것을 무시한다', async () => {
  const iv = await import(new URL('storage/intervals.js', SRC));
  const isi = await import(new URL('storage/collectors/isilonSsh.js', SRC));
  iv._resetForTest();
  try {
    process.env.STORAGE_INTERVALS_LOCAL = '1';
    assert.equal(iv.applyCentralIntervals({ isiCmdTimeoutMs: 300_000 }).applied, false);
    assert.equal(isi.isiCmdTimeoutMs(), 180_000);
  } finally { delete process.env.STORAGE_INTERVALS_LOCAL; iv._resetForTest(); }
});

/* ══════════════════════ ⑤ 배포 · 폴러 · 중앙 대기 ══════════════════════ */

test('⑤ 중앙 저장 → 그 엣지 몫(지정한 키만) → 엣지 적용 → 수집기 값 · 폴러 장비 시한 · 중앙의 결과 대기 시한', async () => {
  const iv = await import(new URL('storage/intervals.js', SRC));
  const isi = await import(new URL('storage/collectors/isilonSsh.js', SRC));
  const poller = await import(new URL('storage/poller.js', SRC));
  const cr = await import(new URL('storage/collectRequests.js', SRC));
  iv._resetForTest();
  try {
    // 지정이 없을 때 — 기본값
    assert.equal(poller.deviceTimeoutMsFor({ type: 'isilon', collectMethod: 'ssh' }), 300_000);
    assert.equal(poller.deviceTimeoutMsFor({ type: 'isilon' }), 300_000, '수집 방식이 비어 있으면 수집기 분기와 같이 SSH 로 본다');
    assert.equal(poller.deviceTimeoutMsFor({ type: 'isilon', collectMethod: 'api' }), 180_000, 'REST 방식은 그대로');
    assert.equal(poller.deviceTimeoutMsFor({ type: 'unity480', collectMethod: 'ssh' }), 180_000, '다른 장비는 그대로');
    assert.equal(cr.perItemMs(), 300_000);

    const saved = iv.saveIntervalConfig({ global: {}, agents: { NJ: { isiCmdTimeoutMs: 300_000 }, AZ: { pollMs: 600_000 } } });
    assert.equal(saved.ok, true);
    assert.deepEqual(iv.intervalsForAgent('NJ'), { isiCmdTimeoutMs: 300_000 }, '지정한 키만 내려간다');
    assert.equal('isiCmdTimeoutMs' in iv.intervalsForAgent('AZ'), false, '지정하지 않은 엣지에는 내려가지 않는다(엣지 로컬 유지)');
    assert.equal(iv.maxConfiguredIntervalMs('isiCmdTimeoutMs'), 300_000);
    assert.equal(cr.perItemMs(), 420_000, '중앙은 배포한 값 중 가장 긴 것으로 결과를 기다린다(짧으면 재인출 → 두 번 수집)');
    // 파일로 남는다(재기동 뒤에도)
    const onDisk = JSON.parse(fs.readFileSync(path.join(TMP, 'storage-intervals.json'), 'utf8'));
    assert.equal(onDisk.agents.NJ.isiCmdTimeoutMs, 300_000);

    // 엣지(NJ)가 pull 로 받은 값을 적용 — storageConfigPull 이 부르는 같은 함수
    iv.applyCentralIntervals(iv.intervalsForAgent('NJ'));
    assert.equal(isi.isiCmdTimeoutMs(), 300_000);
    assert.equal(poller.deviceTimeoutMsFor({ type: 'isilon', collectMethod: 'ssh' }), 420_000);
    assert.equal(poller.deviceTimeoutMsFor({ type: 'isilon', collectMethod: 'ssh' }), isi.isiDeviceTimeoutMs(), '폴러와 수집기가 같은 장비 시한을 쓴다');
    assert.ok(isi.isiSessionBudgetMs() < poller.deviceTimeoutMsFor({ type: 'isilon', collectMethod: 'ssh' }), '세션 예산 < 장비 시한');
    // 화면의 '지금 쓰는 값' 에 출처와 함께 나온다
    const src = iv.runtimeIntervalSource().find((x) => x.key === 'isiCmdTimeoutMs');
    assert.deepEqual({ ms: src.ms, from: src.from }, { ms: 300_000, from: 'central' });
  } finally { iv.saveIntervalConfig({}); iv._resetForTest(); }
});

test('⑤ 소스 — 폴러는 장비별 시한을 쓰고, 수집기는 isi status 에 설정값을 넘긴다(상수로 굳히지 않는다)', () => {
  const poll = fs.readFileSync(new URL('storage/poller.js', SRC), 'utf8');
  assert.match(poll, /withDeadline\(deviceTimeoutMsFor\(full\),/);
  assert.doesNotMatch(poll, /withDeadline\(DEVICE_TIMEOUT_MS,/, '장비 시한 상수를 그대로 넘기면 Isilon 명령 대기 3분이 180초에 끊긴다');
  const ssh = fs.readFileSync(new URL('storage/collectors/isilonSsh.js', SRC), 'utf8');
  assert.match(ssh, /sh\.exec\('isi status', cmdMs\)/);
  assert.doesNotMatch(ssh, /export const ISI_SESSION_BUDGET_MS\b/, '예산은 설정값에서 계산하는 함수다');
  const q = fs.readFileSync(new URL('storage/collectRequests.js', SRC), 'utf8');
  assert.match(q, /createCollectRequestQueue\(\{ ttlMs: TTL_MS, perItemMs,/);
});

test('⑤ 장비 시한 env 가 못 쓰는 값이어도 수집기와 폴러가 같은 장비 시한을 쓰고 예산은 그보다 작다(단위 착오 3000000000 · 음수 · Infinity)', () => {
  // 모듈 로드 시 굳는 env 라 깨끗한 자식 프로세스에서 실제 모듈을 읽는다.
  const read = (extraEnv) => {
    const dir = fs.mkdtempSync(path.join(TMP, 'env-'));
    const env = { ...process.env, CONFIG_DIR: dir, ...extraEnv };
    delete env.SSH_EXEC_TIMEOUT_MS;
    const code = `const i = await import(${JSON.stringify(new URL('storage/collectors/isilonSsh.js', SRC).href)});
const p = await import(${JSON.stringify(new URL('storage/poller.js', SRC).href)});
console.log(JSON.stringify({ base: i.ISI_DEVICE_TIMEOUT_MS, dev: i.isiDeviceTimeoutMs(), budget: i.isiSessionBudgetMs(), poller: p.deviceTimeoutMsFor({ type: 'isilon', collectMethod: 'ssh' }) }));
process.exit(0);`;
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8', timeout: 60_000 }).trim().split('\n').pop());
  };
  for (const v of ['3000000000', '-5', 'Infinity', 'abc', '']) {
    const r = read({ STORAGE_DEVICE_TIMEOUT_MS: v });
    assert.equal(r.base, 180_000, `못 쓰는 값은 기본값: '${v}'`);
    assert.equal(r.dev, r.poller, `수집기와 폴러의 장비 시한이 같다: '${v}'`);
    assert.ok(r.budget < r.poller, `예산 ${r.budget} < 폴러 장비 시한 ${r.poller}: '${v}'`);
  }
  // 현장이 장비 시한을 길게 잡았으면(10분) 둘 다 그 값
  const long = read({ STORAGE_DEVICE_TIMEOUT_MS: '600000' });
  assert.equal(long.dev, 600_000); assert.equal(long.poller, 600_000); assert.equal(long.budget, 580_000);
});
