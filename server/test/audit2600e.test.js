/**
 * v2.600 감사 수정 그룹 e — 보안·타이머·설정·DB 회귀.
 *  T2600-01  로그인 잠금 키가 username 길이에 비례하지 않는다(무인증 메모리 고갈)
 *  T2600-02  하드캡 퇴출이 활성 로그인·OTP 잠금을 지우지 않는다(잠금 해제 우회)
 *  T2600-04  adaptiveTimer 가 NaN 주기를 1ms 루프로 만들지 않는다
 *  T2600-05  GPU 게스트 설정 부분 패치의 빈 값은 이전 값 유지
 *  LO2600-02 게스트 로그인 스캔 수정 저장의 빈 숫자 칸은 이전 값 유지
 *  LO2600-03 네트워크 캡처 모니터 수정 저장의 빈 숫자 칸은 이전 값 유지
 *  LO2600-05 iDRAC 스캔 주기 빈 값은 400(명시적 0 만 끔)
 *  LO2600-06 프록시 bindAddress 에 개행·기호 거부(HAProxy 설정 주입)
 *  DB2600-02 metrics history 는 원본 보존이 짧아도 롤업으로 긴 창을 덮는다
 *  DB2600-04 PDU prune 은 청크 + 양보
 *  SEC2600-01 원격 root 배포는 고정 /tmp 경로가 아니라 mktemp 디렉터리
 * 기준 시각은 Date.now() 가 아니라 고정값을 쓴다(CLAUDE.md v2.517).
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2600e-'));
process.env.CONFIG_DIR = TMP;
process.env.TEMP_DB_PATH = path.join(TMP, 'host-temp.db');
process.env.PDU_DB = path.join(TMP, 'pdu.db');
process.env.PDU_RETAIN_DAYS = '1';
process.env.PRUNE_CHUNK_ROWS = '500';
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

const T0 = 1_700_000_000_000;       // 고정 기준 시각
const HOUR = 3_600_000;
const DAY = 86_400_000;

let rl;
before(async () => { rl = await import('../src/security/loginRateLimit.js'); });

// ─────────────── T2600-01
test('T2600-01: 900KB username 실패가 900KB 키를 남기지 않는다(해시로 접는다)', () => {
  rl._resetLoginRateLimitForTest();
  const huge = 'a'.repeat(900_000);
  rl.recordLoginFailure('10.0.0.1', huge + '1', T0);
  rl.recordLoginFailure('10.0.0.1', huge + '2', T0);
  const { keys, chars } = rl._attemptKeyCharsForTest();
  assert.ok(keys >= 3);
  assert.ok(chars < 2_000, `키 길이 합 ${chars} — 입력 길이에 비례하면 안 된다`);
});

test('T2600-01: 앞 128자가 같은 두 긴 계정명은 서로 다른 카운터다(자르지 않고 해시)', () => {
  rl._resetLoginRateLimitForTest();
  const pre = 'b'.repeat(300);
  for (let i = 0; i < 8; i++) rl.recordLoginFailure('10.0.0.2', pre + 'X', T0 + i);
  assert.equal(rl.checkLoginAllowed('10.0.0.2', pre + 'X', T0 + 100).blocked, true);
  assert.equal(rl.checkLoginAllowed('10.0.0.2', pre + 'Y', T0 + 100).blocked, false);
  // 짧은 계정은 대소문자 무시 그대로
  for (let i = 0; i < 8; i++) rl.recordLoginFailure('10.0.0.3', 'Admin', T0 + i);
  assert.equal(rl.checkLoginAllowed('10.0.0.3', 'admin', T0 + 100).blocked, true);
});

// ─────────────── T2600-02
test('T2600-02: 분산 실패 폭주(하드캡 퇴출)가 활성 로그인 잠금을 풀지 않는다', () => {
  rl._resetLoginRateLimitForTest();
  for (let i = 0; i < 8; i++) rl.recordLoginFailure('10.9.9.9', 'victim', T0 + i);
  assert.equal(rl.checkLoginAllowed('10.9.9.9', 'victim', T0 + 10).blocked, true);
  // 서로 다른 출발지·계정 2,000회 → 키 6,000개 → prune 하드캡 발동
  for (let i = 0; i < 2000; i++) rl.recordLoginFailure(`172.16.${i >> 8}.${i & 255}`, `u${i}`, T0 + 1000 + i);
  const s = rl._attemptKeyCharsForTest();
  assert.ok(s.keys <= 5003, `하드캡이 동작해야 한다(${s.keys})`);
  assert.equal(rl.checkLoginAllowed('10.9.9.9', 'victim', T0 + 5000).blocked, true, '활성 잠금이 퇴출되면 안 된다');
});

test('T2600-02: OTP 잠금도 같은 Map 퇴출에서 살아남는다', () => {
  rl._resetLoginRateLimitForTest();
  for (let i = 0; i < 5; i++) rl.recordOtpFailure('otpuser', T0 + i);
  assert.equal(rl.checkOtpAllowed('otpuser', T0 + 10).blocked, true);
  for (let i = 0; i < 2000; i++) rl.recordLoginFailure(`172.17.${i >> 8}.${i & 255}`, `v${i}`, T0 + 1000 + i);
  assert.equal(rl.checkOtpAllowed('otpuser', T0 + 5000).blocked, true);
});

// ─────────────── T2600-04
test('T2600-04: 주기가 NaN 이어도 1ms 루프가 되지 않는다', async () => {
  const { startAdaptiveTimer } = await import('../src/util/adaptiveTimer.js');
  let n = 0;
  const origWarn = console.warn; console.warn = () => {};
  const t = startAdaptiveTimer(() => NaN, () => { n += 1; }, { firstDelayMs: NaN, name: 'nan-test' });
  await new Promise((r) => setTimeout(r, 150));
  t.stop(); console.warn = origWarn;
  assert.equal(n, 0, `150ms 동안 ${n}회 실행 — NaN 이 1ms 가 되면 안 된다`);
});

// ─────────────── T2600-05
test('T2600-05: GPU 게스트 부분 패치의 빈 값·null 은 이전 값 유지, 명시적 값은 반영', async () => {
  const { mergeGpuGuestSettings } = await import('../src/gpu/settings.js');
  const cur = { enabled: true, pollIntervalMs: 900_000, concurrency: 6, timeoutMs: 45_000, maxVmsPerVcenter: 300, sshPort: 2222, vcenters: {} };
  const a = mergeGpuGuestSettings(cur, { pollIntervalMs: '', concurrency: null, timeoutMs: '  ', maxVmsPerVcenter: '', sshPort: null });
  assert.equal(a.pollIntervalMs, 900_000);
  assert.equal(a.concurrency, 6);
  assert.equal(a.timeoutMs, 45_000);
  assert.equal(a.maxVmsPerVcenter, 300);
  assert.equal(a.sshPort, 2222);
  const b = mergeGpuGuestSettings(cur, { pollIntervalMs: '120000', sshPort: 22 });
  assert.equal(b.pollIntervalMs, 120_000);
  assert.equal(b.sshPort, 22);
  const c = mergeGpuGuestSettings(cur, { pollIntervalMs: 0 });   // 명시적 0 은 값 → 하한
  assert.equal(c.pollIntervalMs, 10_000);
});

// ─────────────── LO2600-02 / LO2600-03
test('LO2600-02: 게스트 로그인 스캔 수정 저장의 빈 숫자 칸은 이전 값 유지(새 항목은 기본값)', async () => {
  const { saveGuestScan } = await import('../src/security/guestScanScheduler.js');
  const a = saveGuestScan({ name: 'g', vcenterId: 'vc1', intervalMin: 1440, days: 30, maxVms: 500, enabled: false });
  const b = saveGuestScan({ id: a.id, name: 'g', vcenterId: 'vc1', intervalMin: '', days: '', maxVms: '', enabled: false });
  assert.deepEqual([b.intervalMin, b.days, b.maxVms], [1440, 30, 500]);
  const c = saveGuestScan({ name: 'new', vcenterId: 'vc1', intervalMin: '', days: '', maxVms: '', enabled: false });
  assert.deepEqual([c.intervalMin, c.days, c.maxVms], [60, 7, 100]);
  const d = saveGuestScan({ id: a.id, name: 'g', vcenterId: 'vc1', intervalMin: 90, days: 3, maxVms: 20, enabled: false });
  assert.deepEqual([d.intervalMin, d.days, d.maxVms], [90, 3, 20]);
});

test('LO2600-03: 캡처 모니터 수정 저장의 빈 숫자 칸은 이전 값 유지(새 항목은 기본값)', async () => {
  const { saveMonitor } = await import('../src/net/monitor.js');
  const a = saveMonitor({ name: 'm', enabled: false, intervalMin: 1440, seconds: 30, maxPackets: 5000 });
  const b = saveMonitor({ id: a.id, name: 'm', enabled: false, intervalMin: '', seconds: '', maxPackets: '' });
  assert.deepEqual([b.intervalMin, b.seconds, b.maxPackets], [1440, 30, 5000]);
  const c = saveMonitor({ name: 'n', enabled: false, intervalMin: '', seconds: '', maxPackets: '' });
  assert.deepEqual([c.intervalMin, c.seconds, c.maxPackets], [10, 10, 1000]);
});

// ─────────────── LO2600-05
test('LO2600-05: PUT /idrac/scan-ranges/interval 의 빈 값은 400 이고 저장하지 않는다', async () => {
  const { adminRouter } = await import('../src/routes/admin.js');
  const layer = adminRouter.stack.find((l) => l.route?.path === '/idrac/scan-ranges/interval' && l.route.methods.put);
  assert.ok(layer, '라우트가 있어야 한다');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const call = (body) => new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    handler({ body, user: { username: 't', role: 'admin' } }, res);
  });
  const settingsFile = path.join(TMP, 'idrac-scan-settings.json');
  for (const body of [{ hours: '' }, { hours: null }, {}, { hours: '  ' }]) {
    const r = await call(body);
    assert.equal(r.status, 400, `빈 값 ${JSON.stringify(body)} 은 400`);
  }
  assert.equal(fs.existsSync(settingsFile) && JSON.parse(fs.readFileSync(settingsFile, 'utf8')).intervalMs === 0, false, '빈 값이 주기 끔(0)으로 저장되면 안 된다');
  const ok = await call({ hours: 0 });   // 명시적 0 은 끔
  assert.equal(ok.status, 200);
  assert.equal(ok.body.intervalMs, 0);
});

// ─────────────── LO2600-06
test('LO2600-06: bindAddress 에 개행·공백·기호가 있으면 저장 거부', async () => {
  const reg = await import('../src/proxy/registry.js');
  for (const ok of [undefined, '', '*', '0.0.0.0', '10.1.2.3', '::', '[::1]', 'proxy.example']) assert.equal(reg.bindAddressIssue(ok), null, String(ok));
  for (const bad of ['*:1\n    mode http\nlisten evil\n    bind *', 'a b', '10.0.0.1;x', '#']) assert.ok(reg.bindAddressIssue(bad), JSON.stringify(bad));
  const r = reg.saveProxy({ name: 'p1', dataplane: { bindAddress: '*:1\nlisten evil' } });
  assert.equal(r.ok, false);
  assert.throws(() => reg.saveConfig({ dataplane: { bindAddress: '*\nlisten evil' } }));
  const g = reg.saveProxy({ name: 'p2', dataplane: { bindAddress: '10.0.0.5' } });
  assert.equal(g.ok, true);
});

// ─────────────── DB2600-02
test('DB2600-02: 원본 보존(90일)이 롤업보다 짧아도 365일 창은 롤업으로 전 기간을 보인다', async () => {
  const { getMetricsDb } = await import('../src/metrics/db.js');
  const db = await getMetricsDb();
  assert.equal(db.kind, 'sqlite');
  // 200일 동안 하루 1표본(값을 바꿔 dead-band 에 걸리지 않게)
  for (let d = 200; d >= 1; d--) db.insertMany([{ metric: 'audit2600_x', k: 'k1', v: d % 7 + 1 }], T0 - d * DAY + HOUR / 2);
  await db.prune(T0 - 90 * DAY, T0 - 1830 * DAY);   // 원본 90일 · 롤업 5년
  const pts = db.history('audit2600_x', 'k1', T0 - 365 * DAY, DAY, 1000);
  assert.ok(pts.length >= 199, `365일 창 ${pts.length}점 — 롤업이 덮는 200일이 보여야 한다`);
  const pts180 = db.history('audit2600_x', 'k1', T0 - 180 * DAY, DAY, 1000);
  assert.ok(pts180.length >= 179, `180일 창 ${pts180.length}점`);
  assert.ok(pts.length >= pts180.length, '긴 창이 짧은 창보다 적으면 안 된다');
});

// ─────────────── DB2600-04
test('DB2600-04: PDU prune 은 청크로 끊고 청크 사이에 양보한다', async () => {
  const pdu = await import('../src/pdu/db.js');
  pdu._resetForTest();
  const units = Array.from({ length: 100 }, (_, i) => ({ index: i + 1, powerW: 100 + i }));
  // 20회째 적재에서 prune(PRUNE_EVERY=20). 전부 보존일(1일) 밖의 고정 과거 시각.
  for (let i = 0; i < 19; i++) await pdu.recordSnapshot({ id: 'pdu1', collectedAt: 1_000_000_000_000 + i * 1000, units });
  assert.equal((await pdu.dbStats()).sample.n, 1900);
  await pdu.recordSnapshot({ id: 'pdu1', collectedAt: 1_000_000_000_000 + 19_000, units });
  const mid = (await pdu.dbStats()).sample.n;
  assert.ok(mid > 0, `적재 직후 ${mid}행 — 한 번에 동기 삭제하면 0 이다(청크 사이 양보가 없다)`);
  let left = mid;
  for (let i = 0; i < 200 && left > 0; i++) { await new Promise((r) => setImmediate(r)); left = (await pdu.dbStats()).sample.n; }
  assert.equal(left, 0, '결국 전부 지워진다');
});

// ─────────────── SEC2600-01
test('SEC2600-01: remoteTmpDir 는 mktemp 결과를 검증하고 소유를 확인한다', async () => {
  const { remoteTmpDir } = await import('../src/agent/deploy.js');
  const cmds = [];
  const good = async (c) => { cmds.push(c); if (c.startsWith('mktemp')) return { code: 0, stdout: '/tmp/vmportal-agent.Ab3dE6gH9j\n' }; return { code: 0, stdout: 'ok\n' }; };
  assert.equal(await remoteTmpDir(good, 'vmportal-agent'), '/tmp/vmportal-agent.Ab3dE6gH9j');
  assert.match(cmds[0], /^mktemp -d \/tmp\/vmportal-agent\.X{10}$/);
  assert.match(cmds[1], /test -O \/tmp\/vmportal-agent\.Ab3dE6gH9j/);
  // 형식이 다른 출력(주입 시도)·소유 확인 실패·mktemp 실패는 던진다(고정 경로 폴백 없음)
  await assert.rejects(remoteTmpDir(async () => ({ code: 0, stdout: '/tmp/x; rm -rf /' }), 'vmportal-agent'));
  await assert.rejects(remoteTmpDir(async (c) => (c.startsWith('mktemp') ? { code: 0, stdout: '/tmp/vmportal-agent.Ab3dE6gH9j' } : { code: 1, stdout: '' }), 'vmportal-agent'));
  await assert.rejects(remoteTmpDir(async () => ({ code: 1, stdout: '', stderr: 'no space' }), 'vmportal-agent'));
});

test('SEC2600-01: 배포 코드에 고정 /tmp 경로가 남아 있지 않다(에이전트·RMA)', () => {
  const agent = fs.readFileSync(path.join(SRC, 'agent/deploy.js'), 'utf8');
  const rma = fs.readFileSync(path.join(SRC, 'rma/deploy.js'), 'utf8');
  assert.equal(/['"`]\/tmp\/vmportal-agent-(pkg|deploy)/.test(agent), false);
  assert.equal(/['"`]\/tmp\/vmware-portal-rma\.sudoers/.test(rma), false);
  assert.match(agent, /remoteTmpDir\(exec, 'vmportal-agent'\)/);
  assert.match(rma, /remoteTmpDir\(exec, 'vmware-portal-rma'\)/);
});

// ─────────────── 추가 배정: T2600-01 라우트 상한 · DB2600-02(vmperf) · SEC2600-01(ollama)
test('T2600-01: /api/auth/login 은 256자 초과 username 을 400 으로 거절하고 잠금·기록에 남기지 않는다', async () => {
  const express = (await import('express')).default;
  const { authRouter } = await import('../src/routes/auth.js');
  rl._resetLoginRateLimitForTest();
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/auth', authRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${srv.address().port}/api/auth/login`;
  const post = (username) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'x' }) });
  try {
    const long = await post('a'.repeat(257));
    assert.equal(long.status, 400);
    const huge = await post('b'.repeat(900_000));
    assert.equal(huge.status, 400);
    assert.equal(rl._attemptKeyCharsForTest().keys, 0, '길이 초과 요청은 잠금 카운터에 기록되지 않는다');
    const ok256 = await post('c'.repeat(256));   // 경계값은 길이로 거절하지 않는다(자격 실패 401 등)
    assert.notEqual(ok256.status, 400);
  } finally { srv.close(); }
});

test('DB2600-02: vmperfHistory 도 원본 보존이 짧을 때 롤업으로 긴 창을 덮는다', async () => {
  process.env.VMPERF_DB_DIR = path.join(TMP, 'vmperf');
  const vp = await import('../src/metrics/vmperfDb.js');
  for (let d = 200; d >= 1; d--) await vp.insertVmperf('vc-2600e', [{ metric: 'm', k: 'vc-2600e', v: d % 5 + 1 }], T0 - d * DAY + HOUR / 2);
  const x = await vp.getVmperfDb('vc-2600e');
  x.db.prepare('DELETE FROM samples WHERE ts < ?').run(T0 - 90 * DAY);   // 원본만 90일로 줄인 상태
  const pts = await vp.vmperfHistory('vc-2600e', 'm', T0 - 365 * DAY, DAY, 1000);
  assert.ok(pts.length >= 199, `365일 창 ${pts.length}점`);
});

test('SEC2600-01: ollama 오프라인 설치도 고정 /tmp 경로를 쓰지 않는다', () => {
  const src = fs.readFileSync(path.join(SRC, 'llm/ollamaDeploy.js'), 'utf8');
  assert.equal(/['"`]\/tmp\/ollama-install\.tgz/.test(src), false);
  assert.match(src, /remoteTmpDir\(exec, 'ollama-install'\)/);
});
