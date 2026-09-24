/**
 * v2.607 감사 그룹 c — 시한·SSH·정규식·업그레이드·알림 엔진 회귀.
 *
 * TIM2607-02(+LEFT2607-08) 시한 단일 관문(util/deadline.js) — withDeadline(sshExec·bulkRun)·storage 연결 테스트·
 *   엣지 번들 push 의 AbortSignal.timeout 이 2^31 초과·NaN·음수에서 1ms 에 끊기지 않는다 ·
 * TIM2607-03 알림 엔진 intervalSec 로드 정규화 · WEB2607-04(서버) suppressWindowMin 빈 칸 = 이전 값 ·
 * LEFT2607-04(서버) alarmsUnknown vCenter 의 경보 해소 보류 ·
 * SEC2607-01 relaycheck sshBanner 수신 상한 + 절대 시한 · SEC2607-02 VPLEX 버전 정규식 ·
 * SEC2607-03(+LEFT2607-10) 라이선스·텔레메트리 퍼센트·lsan fabric id 정규식 + 라이선스 필드 절단 ·
 * SEC2607-04 execAnswered·execCapture stderr 상한 · SEC2607-05 hostname 채널 상한·시한 ·
 * SEC2607-06 업그레이드 다운로드 바이트 상한을 읽는 중에.
 * 정규식 수정은 옛 정규식과 **결정적 난수 입력**으로 결과 동일성을 대조한다(성능 수정은 출력이 같다는 증거와 함께).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2607c-'));
// 알림 설정은 손으로 고친 파일(문자열 주기)로 시작한다 — 로드 정규화(TIM2607-03)를 본다.
fs.writeFileSync(path.join(CFG, 'alerts.json'), JSON.stringify({ intervalSec: '15s', cooldownMin: {}, suppressWindowMin: 'x' }));
Object.assign(process.env, { CONFIG_DIR: CFG, DATA_SOURCE: 'live', IPAM_WRITE_WORKER: '0', SSRF_ALLOW_LOOPBACK: 'true', UPGRADE_ALLOW_UNVERIFIED: 'true' });

/** 결정적 난수(mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function randStrings(seed, alphabet, n = 4000, maxParts = 12) {
  const r = rng(seed); const out = [];
  for (let i = 0; i < n; i++) { let s = ''; const k = 1 + Math.floor(r() * maxParts); for (let j = 0; j < k; j++) s += alphabet[Math.floor(r() * alphabet.length)]; out.push(s); }
  return out;
}
const execSig = (re, s) => { const m = re.exec(s); return m ? [m.index, ...m] : null; };
const timeIt = (fn) => { const t0 = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t0) / 1e6; };

// ── TIM2607-02 / LEFT2607-08 ────────────────────────────────────────────────
test('TIM2607-02 — withDeadline: 2^31 초과·NaN·Infinity·음수가 1ms 로 접히지 않는다(signal 을 따르는 작업)', async () => {
  const { withDeadline, deadlineMs } = await import('../src/proxy/sshExec.js');
  const work = (signal) => new Promise((res, rej) => {
    const t = setTimeout(() => res('ok'), 150);
    signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }, { once: true });
  });
  for (const ms of [3e9, NaN, Infinity, -5, '3000000000', 'abc']) {
    assert.equal(await withDeadline(ms, work, '수집 타임아웃'), 'ok', `withDeadline(${ms})`);
  }
  assert.equal(deadlineMs(3e9), 7_200_000);
  assert.equal(deadlineMs(NaN), 60_000);
  assert.equal(deadlineMs(-1), 60_000);
  assert.equal(deadlineMs(500), 1_000);
  assert.equal(deadlineMs(180_000), 180_000);
  // 정상 시한은 그대로 끊는다(v2.417 — 세션을 실제로 끊는다)
  await assert.rejects(withDeadline(1_200, (s) => new Promise((_, rej) => s.addEventListener('abort', () => rej(new Error('x')))), '수집 타임아웃'), /수집 타임아웃\(1초\)/);
});

test('TIM2607-02 — bulkRun: 사본이 사라지고 같은 관문을 쓴다(timeoutMs 3e9 에서도 행이 성공)', async () => {
  const src = stripComments(fs.readFileSync(path.join(SRC, 'util/bulkRun.js'), 'utf8'));
  assert.ok(!/function withDeadline\s*\(/.test(src), 'bulkRun 의 withDeadline 사본 제거');
  const b = await import('../src/util/bulkRun.js');
  b._resetForTest();
  const r = b.startBulkTest({ kind: 't2607c', rows: [{ _line: 1, name: 'a', host: 'h' }], timeoutMs: 3e9,
    testOne: (_row, signal) => new Promise((res, rej) => { const t = setTimeout(() => res({ ok: true }), 120); signal.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); }); }) });
  assert.ok(r.ok);
  for (let i = 0; i < 100 && b.publicRun(r.id).status !== 'done'; i++) await new Promise((x) => setTimeout(x, 20));
  const run = b.publicRun(r.id);
  assert.equal(run.results[0].status, 'ok', `3e9 시한이 1ms 로 접혀 '${run.results[0].reason}'`);
});

test('TIM2607-02 — storage testDeviceConnection: 시한 3e9 가 즉시 "테스트 시간 초과" 로 끝나지 않는다', async () => {
  const { testDeviceConnection } = await import('../src/storage/poller.js');
  // 닫힌 포트 — 수집기는 곧 연결 거부로 끝난다. 예전엔 시한이 1ms 로 접혀 그보다 먼저 '시간 초과' 였다.
  const srv = net.createServer(); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port; await new Promise((r) => srv.close(r));
  const res = await testDeviceConnection({ id: 't', type: 'isilon', host: '127.0.0.1', port, username: 'u', password: 'p' }, { timeoutMs: 3e9 });
  assert.ok(!/테스트 시간 초과/.test(String(res.error || '')), `시한이 1ms 로 접혔다: ${res.error}`);
});

function pushServer() {
  const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true,"version":"9.9.9"}'); }, 80)); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
test('TIM2607-02 — 엣지 번들 push: 시한 3e9·음수가 1ms abort·ERR_OUT_OF_RANGE 가 되지 않는다', async () => {
  const srv = await pushServer(); const port = srv.address().port;
  try {
    const { pushBundleToCollector } = await import('../src/collector/upgradePush.js');
    for (const timeout of [3e9, -1]) {
      const r = await pushBundleToCollector({ id: 'c1', url: `http://127.0.0.1:${port}`, token: 't' }, Buffer.from('x'), { timeout });
      assert.equal(r.ok, true, `pushBundleToCollector timeout=${timeout}: ${JSON.stringify(r)}`);
    }
    const { pushBundleToEdge } = await import('../src/upgrade/upgrade.js');
    const f = path.join(CFG, 'b.tar.gz'); fs.writeFileSync(f, 'x');
    for (const timeout of [3e9, -1]) {
      const r = await pushBundleToEdge({ url: `http://127.0.0.1:${port}`, token: 't' }, f, { timeout });
      assert.equal(r.ok, true, `pushBundleToEdge timeout=${timeout}: ${JSON.stringify(r)}`);
    }
  } finally { srv.close(); }
});

// ── SEC2607-06 ─────────────────────────────────────────────────────────────
test('SEC2607-06 — downloadArchive: 상한을 넘는 순간 읽기를 멈춘다(끝없는 본문에서도 시한 전에 "too large")', async () => {
  let sent = 0;
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/gzip' });
    const chunk = Buffer.alloc(64 * 1024, 1);
    const iv = setInterval(() => { if (res.destroyed || sent > 64 * 1048576) { clearInterval(iv); return; } res.write(chunk); sent += chunk.length; }, 1);
    res.on('close', () => clearInterval(iv));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const { downloadArchive } = await import('../src/upgrade/upgrade.js');
    const t0 = Date.now();
    const r = await downloadArchive(`http://127.0.0.1:${srv.address().port}/vmware-portal-9.9.9.tar.gz`, CFG, { timeout: 4_000, maxBytes: 512 * 1024, sha256: 'a'.repeat(64) });
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /too large/, `예전엔 전량을 기다리다 시한에 걸렸다: ${r.reason}`);
    assert.ok(Date.now() - t0 < 3_500, `상한에서 즉시 멈춰야 한다(${Date.now() - t0}ms)`);
  } finally { srv.close(); }
  for (const f of ['upgrade/upgrade.js', 'upgrade/fetchPackage.js', 'upgrade/bundleSource.js']) {
    const s = stripComments(fs.readFileSync(path.join(SRC, f), 'utf8'));
    assert.ok(!/\.arrayBuffer\(\)/.test(s), `${f} 가 본문 전량을 받는다`);
    assert.ok(/readBytesCapped\(/.test(s), `${f} 가 바이트 상한 읽기를 쓴다`);
  }
});

test('SEC2607-06 — readBytesCapped: Content-Length 초과는 읽지 않고, 스트림은 상한 +1 에서 멈춘다', async () => {
  const { readBytesCapped } = await import('../src/util/readBytesCapped.js');
  const big = new Response(new Uint8Array(10_000), { headers: { 'content-length': '10000' } });
  assert.deepEqual((await readBytesCapped(big, 100)).ok, false);
  let pulled = 0;
  const stream = new ReadableStream({ pull(c) { pulled += 1; c.enqueue(new Uint8Array(1000)); } });
  const r = await readBytesCapped(new Response(stream), 5_000);
  assert.equal(r.ok, false); assert.ok(pulled <= 8, `상한 뒤에도 계속 읽었다(${pulled})`);
  const ok = await readBytesCapped(new Response(new Uint8Array([1, 2, 3])), 3);
  assert.equal(ok.ok, true); assert.deepEqual([...ok.buf], [1, 2, 3]);
});

// ── SEC2607-04 ─────────────────────────────────────────────────────────────
function fakeConn(drive) {
  return { exec(cmd, opts, cb) { const s = new EventEmitter(); s.stderr = new EventEmitter(); s.write = () => {}; s.close = () => { setImmediate(() => s.emit('close', null)); }; s.destroy = () => {}; cb(null, s); setImmediate(() => drive(s)); } };
}
test('SEC2607-04 — execAnswered: stderr 도 합산 상한(4MB)에 걸린다', async () => {
  const { execAnswered } = await import('../src/proxy/sshExec.js');
  const chunk = Buffer.alloc(256 * 1024, 65);
  const conn = fakeConn((s) => { for (let i = 0; i < 24; i++) s.stderr.emit('data', chunk); s.emit('close', 0); });
  await assert.rejects(execAnswered(conn, 'uemcli x', { pty: false, timeoutMs: 5_000 }), /출력 상한/);
  const ok = fakeConn((s) => { s.stderr.emit('data', Buffer.from('warn\n')); s.emit('data', Buffer.from('out\n')); s.emit('close', 0); });
  const r = await execAnswered(ok, 'x', { pty: false, timeoutMs: 5_000 });
  assert.equal(r.stderr, 'warn\n'); assert.match(r.stdout, /out/);
});
test('SEC2607-04 — execCapture: stderr 는 앞 64KB 만 남기고 버린 사실을 밝힌다', async () => {
  const mod = await import('../src/proxy/sshExec.js');
  assert.ok(mod._sshExecInternals?.execCapture, '테스트 접근자');
  const chunk = Buffer.alloc(32 * 1024, 66);
  const conn = fakeConn((s) => { for (let i = 0; i < 64; i++) s.stderr.emit('data', chunk); s.emit('data', Buffer.from('perf')); s.emit('close', 0); });
  const r = await mod._sshExecInternals.execCapture(conn, 'portperfshow', 3_000);
  assert.ok(r.stderr.length <= 64 * 1024, `stderr ${r.stderr.length}`);
  assert.equal(r.stderrTruncated, true);
  assert.equal(r.stdout, 'perf');
});

// ── SEC2607-05 ─────────────────────────────────────────────────────────────
test('SEC2607-05 — hostname 채널: 256자에서 멈추고 닫으며, 끝나지 않아도 시한에 라벨을 낸다', async () => {
  const { collectHostnameLabel, HOSTNAME_MAX_CHARS } = await import('../src/proxy/sshGateway.js');
  const hs = new EventEmitter(); let closed = 0; hs.close = () => { closed += 1; };
  const names = [];
  collectHostnameLabel(hs, (n) => names.push(n));
  for (let i = 0; i < 1000; i++) hs.emit('data', Buffer.alloc(4096, 97));
  hs.emit('close');
  assert.equal(names.length, 1); assert.ok(names[0].length <= HOSTNAME_MAX_CHARS); assert.ok(closed >= 1, '상한에서 채널을 닫는다');
  const hs2 = new EventEmitter(); hs2.close = () => {};
  const n2 = [];
  collectHostnameLabel(hs2, (n) => n2.push(n), { timeoutMs: 50 });
  hs2.emit('data', Buffer.from('web01 '));
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(n2, ['web01']);
});

// ── SEC2607-01 ─────────────────────────────────────────────────────────────
test('SEC2607-01 — sshBanner: 개행 없이 계속 보내는 대상에서 상한·절대 시한 안에 끝난다', async () => {
  const { runCheck, SSH_BANNER_MAX_BYTES } = await import('../src/relaycheck/checks.js');
  const chunk = Buffer.alloc(32 * 1024, 65);
  let sent = 0;
  const srv = net.createServer((s) => { const iv = setInterval(() => { if (s.destroyed || sent > 64 * 1048576) return clearInterval(iv); s.write(chunk); sent += chunk.length; }, 5); s.on('error', () => {}); s.on('close', () => clearInterval(iv)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const t0 = Date.now();
    const r = await runCheck({ kind: 'irs-ssh', host: '127.0.0.1', port: srv.address().port }, { timeoutMs: 1_000 });
    assert.equal(r.ok, false); assert.equal(r.phase, 'banner');
    assert.ok(Date.now() - t0 < 1_500, `유휴 시한만 있어 데이터가 오는 동안 끝나지 않았다(${Date.now() - t0}ms)`);
    assert.ok(SSH_BANNER_MAX_BYTES <= 4096);
  } finally { srv.close(); }
  // 절대 시한 — 1바이트씩 천천히(유휴 시한은 매번 다시 시작) 보내는 대상도 시한에 끝난다
  const slow = net.createServer((s) => { const iv = setInterval(() => { if (s.destroyed) return clearInterval(iv); s.write('A'); }, 100); s.on('error', () => {}); s.on('close', () => clearInterval(iv)); });
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  try {
    const t0 = Date.now();
    const r = await runCheck({ kind: 'irs-ssh', host: '127.0.0.1', port: slow.address().port }, { timeoutMs: 600 });
    assert.equal(r.ok, false);
    assert.ok(Date.now() - t0 < 1_200, `절대 시한이 없다(${Date.now() - t0}ms)`);
  } finally { slow.close(); }
  // 정상 배너
  const good = net.createServer((s) => { s.end('SSH-2.0-OpenSSH_9.6\r\nrest'); s.on('error', () => {}); });
  await new Promise((r) => good.listen(0, '127.0.0.1', r));
  try {
    const r = await runCheck({ kind: 'irs-ssh', host: '127.0.0.1', port: good.address().port }, { timeoutMs: 2_000 });
    assert.equal(r.ok, true); assert.equal(r.detail, 'SSH-2.0-OpenSSH_9.6');
  } finally { good.close(); }
});

// ── SEC2607-02 ─────────────────────────────────────────────────────────────
test('SEC2607-02 — VPLEX 버전 정규식: 옛 정규식과 결과 동일 + 공백 2만 자에서 선형', async () => {
  const OLD = /(?:product\s+version|version)\s*[:=]?\s*([\d][\w.]*)/i;
  const NEW = /(?:product\s+version|version)\s*(?:[:=]\s*)?(\d[\w.]*)/i;
  const src = stripComments(fs.readFileSync(path.join(SRC, 'storage/collectors/vplexSsh.js'), 'utf8'));
  assert.ok(src.includes(NEW.source), '소스가 대조한 정규식을 쓴다');
  for (const s of randStrings(2607, ['Product', 'product', ' ', '  ', '\t', 'Version', 'version', ':', '=', '6', '2.0', '.01', 'x', '\n', 'a', '-'])) {
    assert.deepEqual(execSig(NEW, s), execSig(OLD, s), JSON.stringify(s));
  }
  const { normalizeVplexSsh } = await import('../src/storage/collectors/vplexSsh.js');
  const ms = timeIt(() => normalizeVplexSsh({ id: 'v', name: 'v', type: 'vplex' }, { version: `Version${' '.repeat(20_000)}x` }));
  assert.ok(ms < 150, `O(n²) (${ms.toFixed(1)}ms — 예전 약 0.6초)`);
  assert.equal(normalizeVplexSsh({ id: 'v', name: 'v', type: 'vplex' }, { version: 'Product Version: 6.2.0.01.00.13\n' }).version, '6.2.0.01.00.13');
});

// ── SEC2607-03 / LEFT2607-10 ───────────────────────────────────────────────
test('SEC2607-03 — 라이선스 등급 정규식: 옛 정규식과 결과 동일 + 선형', async () => {
  const OLD = /data\s*-?\s*cent(er|re)/i;
  const NEW = /data\s*(?:-\s*)?cent(er|re)/i;
  const src = stripComments(fs.readFileSync(path.join(SRC, 'bmusage/license.js'), 'utf8'));
  assert.ok(src.includes(NEW.source));
  for (const s of randStrings(26071, ['data', 'Data', 'DATA', ' ', '\t', '-', '--', 'cent', 'center', 'centre', 'CENTER', 'x', 'iDRAC9 ', 'Enterprise'])) {
    assert.deepEqual(execSig(NEW, s), execSig(OLD, s), JSON.stringify(s));
  }
  const { classifyLicense } = await import('../src/bmusage/license.js');
  const ms = timeIt(() => classifyLicense([{ name: `data${' '.repeat(20_000)}x` }]));
  assert.ok(ms < 150, `O(n²) (${ms.toFixed(1)}ms)`);
  assert.equal(classifyLicense([{ name: 'iDRAC9 x5 Data - Center License' }]).tier, 'datacenter');
});

test('SEC2607-03 — pctFromMetric: 옛 판정과 결과 동일 + 선형', async () => {
  const { pctFromMetric } = await import('../src/bmusage/parse/idracTelemetry.js');
  const old = (v) => {
    if (v == null) return null; let x;
    if (typeof v === 'number') x = v; else { const m = /^\s*(\d+(?:\.\d+)?)\s*%?\s*$/.exec(String(v)); if (!m) return null; x = Number(m[1]); }
    return Number.isFinite(x) && x >= 0 && x <= 100 ? x : null;
  };
  for (const s of randStrings(26072, [' ', '\t', '\n', ' ', '　', '1', '2', '0', '.', '5', '%', 'x', '-', '99', '100'], 6000, 8)) {
    assert.equal(pctFromMetric(s), old(s), JSON.stringify(s));
  }
  for (const v of [null, undefined, 5, 101, -1, '', 'N/A', ' 42 % ', '42%', '3.5']) assert.equal(pctFromMetric(v), old(v));
  const ms = timeIt(() => pctFromMetric(`1${' '.repeat(20_000)}x`));
  assert.ok(ms < 100, `O(n²) (${ms.toFixed(1)}ms)`);
});

test('LEFT2607-10 — lsanshow fabric id 정규식: 옛 정규식과 결과 동일 + 선형', async () => {
  const OLD = /fabric\s*id\s*:?\s*(\d{1,3})/i;
  const NEW = /fabric\s*id\s*(?::\s*)?(\d{1,3})/i;
  const src = stripComments(fs.readFileSync(path.join(SRC, 'sanswitch/collectors/fosParse.js'), 'utf8'));
  assert.ok(src.includes(NEW.source));
  for (const s of randStrings(26073, ['Fabric', 'fabric', 'ID', 'id', ' ', '\t', ':', '::', '1', '12', '128', '9999', 'x', 'LSAN_'])) {
    assert.deepEqual(execSig(NEW, s), execSig(OLD, s), JSON.stringify(s));
  }
  const fos = await import('../src/sanswitch/collectors/fosParse.js');
  const parse = fos.parseLsanShow;
  assert.equal(typeof parse, 'function');
  const ms = timeIt(() => parse(`fabric id${' '.repeat(20_000)}x\n`));
  assert.ok(ms < 150, `O(n²) (${ms.toFixed(1)}ms)`);
});

test('SEC2607-03 — redfish 라이선스 항목 문자열은 256자로 자른다', () => {
  const s = stripComments(fs.readFileSync(path.join(SRC, 'idrac/redfish.js'), 'utf8'));
  assert.match(s, /name: capStr\(l\.Name \|\| l\.LicenseDescription \|\| l\.Id \|\| '', LICENSE_FIELD_MAX\)/);
  assert.match(s, /entitlement: capStr\(l\.EntitlementId \|\| l\.EntitlementID \|\| '', LICENSE_FIELD_MAX\)/);
});

// ── TIM2607-03 / WEB2607-04 / LEFT2607-04 ──────────────────────────────────
test('TIM2607-03 — 알림 설정 로드가 intervalSec·cooldownMin·suppressWindowMin 을 좁힌다(문자열 → 1ms 주기 금지)', async () => {
  const alerts = await import('../src/alerts.js');
  const c = alerts.loadAlertConfig();
  assert.equal(c.intervalSec, 60, `'15s' 가 그대로 남았다: ${c.intervalSec}`);
  assert.equal(c.cooldownMin, 60);
  assert.equal(c.suppressWindowMin, 5);
  assert.equal(alerts.alertIntervalMs('15s'), 60_000);
  assert.equal(alerts.alertIntervalMs(NaN), 60_000);
  assert.equal(alerts.alertIntervalMs(3), 15_000);
  assert.equal(alerts.alertIntervalMs(1e12), 86_400_000);
});

test('WEB2607-04 — suppressWindowMin: 빈 칸은 이전 값, 명시적 0 만 0', async () => {
  const alerts = await import('../src/alerts.js');
  const base = alerts.loadAlertConfig();
  alerts.saveAlertConfig({ ...base, suppressWindowMin: 7 });
  assert.equal(alerts.loadAlertConfig().suppressWindowMin, 7);
  alerts.saveAlertConfig({ ...alerts.loadAlertConfig(), suppressWindowMin: '' });
  assert.equal(alerts.loadAlertConfig().suppressWindowMin, 7, '빈 칸이 0(억제 끔)으로 저장됐다');
  alerts.saveAlertConfig({ ...alerts.loadAlertConfig(), suppressWindowMin: 0 });
  assert.equal(alerts.loadAlertConfig().suppressWindowMin, 0);
});

test('LEFT2607-04 — 경보를 조회하지 않은(REST 폴백) vCenter 의 발생 중 위험 알람은 해소되지 않는다', async () => {
  const alerts = await import('../src/alerts.js');
  const { store } = await import('../src/store.js');
  const cfg = structuredClone(alerts.loadAlertConfig());
  for (const k of Object.keys(cfg.rules)) if (cfg.rules[k] && typeof cfg.rules[k] === 'object') cfg.rules[k].enabled = false;
  cfg.rules.criticalAlarms = { enabled: true };
  alerts._resetAlertStateForTest();
  const snap = (alarms, unknown) => ({ vcenters: [{ id: 'vc1', status: 'ok', ...(unknown ? { alarmsUnknown: true } : {}) }], hosts: [], vms: [], datastores: [], alarms });
  const keys = () => alerts.alertStatus().firing.map((f) => f.key);
  store.snapshot = snap([{ id: 'a1', name: 'HA', severity: 'critical', vcenterId: 'vc1', entity: 'h1' }], false);
  await alerts._refreshStateForTest(cfg, false);
  assert.deepEqual(keys(), ['alarm:a1']);
  store.snapshot = snap([], true);
  await alerts._refreshStateForTest(cfg, false);
  assert.deepEqual(keys(), ['alarm:a1'], '경보 미조회를 해소로 읽었다');
  assert.ok(!alerts.alertStatus().recent.some((r) => r.severity === 'resolved'));
  store.snapshot = snap([], false);
  await alerts._refreshStateForTest(cfg, false);
  assert.deepEqual(keys(), [], '경보를 조회했고 없으면 해소');
  alerts._resetAlertStateForTest();
});
