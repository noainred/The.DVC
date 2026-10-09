/**
 * test/rvH_sshBackpressure.test.js — 웹 SSH 출력 백프레셔(2026-10-09 검토 I-07, 그룹 H).
 *
 * 재현(고치기 전): proxy/sshGateway.js 는 SSH stdout/stderr 를 받는 즉시 ws.send() 했고 ws.bufferedAmount 를 보지 않았다 —
 * 브라우저가 느리면(고RTT·탭 백그라운드) 포탈 메모리에 출력이 끝없이 쌓였다(검토 재현: 4,194,426바이트 대기에도 pause 0회).
 * 이 파일은 **실제 연결 처리기**(handleConnection)를 가짜 WS(소비 속도를 조절) + 가짜 ssh2 Client(결정적) + 실제 ssh2 서버로 돌려
 *   ① 빠른 출력 + 느린 소비: 대기열이 high + 조각 하나를 넘지 않고, 멈췄다 풀며, 받은 출력이 **순서·내용 그대로**다
 *   ② 두 사용자: 한쪽이 멈춰 있어도 다른 쪽은 끝까지 받는다 · 멈춘 쪽은 전송 대기 시한에 **사유를 말하고** 닫힌다 · 타이머가 남지 않는다
 *   ③ 멈춤이 듣지 않는 스트림(안전망): 대기열 상한을 넘으면 사유를 말하고 닫는다
 *   ④ 실제 ssh2: 포탈이 멈추면 SSH 창 흐름 제어로 **대상 서버의 쓰기가 막힌다**(포탈 메모리에 쌓이지 않는다)
 *   ⑤ UTF-8 글자가 조각 경계에서 잘려도 깨지지 않는다
 * 를 고정한다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import ssh2 from 'ssh2';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rvh-bp-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
delete process.env.SSH_HOSTKEY_POLICY;
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
const closers = [];
after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

const gw = await import('../src/proxy/sshGateway.js');
const reg = await import('../src/proxy/registry.js');
const pt = await import('../src/security/peerTrust.js');

const ADMIN = { username: 'admin1', role: 'admin', scope: { vcenters: [], regions: [] } };
const OP2 = { username: 'admin2', role: 'admin', scope: { vcenters: [], regions: [] } };
gw._setRemoteDepsForTest({
  resolveTokenUser: (t) => (t === 'tok1' ? ADMIN : t === 'tok2' ? OP2 : null),
  sessionInfoOf: (t) => ({ username: t === 'tok2' ? 'admin2' : 'admin1', source: 'local', sid: null, exp: Math.floor(Date.now() / 1000) + 3600 }),
});

/** 소비 속도를 조절하는 가짜 WS — send 는 bufferedAmount 에 쌓이고 drain(n) 이 앞에서부터 비우며 콜백을 부른다. */
class SlowWs extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.readyState = 1; this.queue = []; this.bufferedAmount = 0; this.maxBuffered = 0; this.text = ''; this.json = []; this.closed = null; }
  send(d, cb) {
    const s = String(d);
    if (s.startsWith('{')) { this.json.push(JSON.parse(s)); if (cb) setImmediate(cb); return; }
    const n = Buffer.byteLength(s);
    this.queue.push({ s, n, cb });
    this.bufferedAmount += n;
    if (this.bufferedAmount > this.maxBuffered) this.maxBuffered = this.bufferedAmount;
  }
  drain(bytes) {
    while (bytes > 0 && this.queue.length) {
      const f = this.queue[0];
      const take = Math.min(bytes, f.n);
      f.n -= take; bytes -= take; this.bufferedAmount -= take;
      if (f.n === 0) { this.queue.shift(); this.text += f.s; if (f.cb) f.cb(); }
    }
  }
  pump(bytes, everyMs) { this._pump = setInterval(() => this.drain(bytes), everyMs); }
  close(code, reason) { if (this.readyState !== 1) return; this.readyState = 3; this.closed = { code, reason }; clearInterval(this._pump); setImmediate(() => this.emit('close')); }
  terminate() { this.close(1006, ''); }
  input(o) { this.emit('message', Buffer.from(JSON.stringify(o))); }
  statuses() { return this.json.filter((o) => o.type === 'status').map((o) => o.text); }
}
const waitFor = async (fn, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 10)); } return false; };

/** 가짜 ssh2 Client — 셸 스트림은 PassThrough(쓰는 쪽이 write() 반환값으로 백프레셔를 본다). */
function fakeClientClass(onShell) {
  return class FakeClient extends EventEmitter {
    connect(cfg) { this.cfg = cfg; setImmediate(() => this.emit('ready')); }
    exec(_c, cb) { cb(new Error('no exec')); }
    shell(_o, cb) { const s = new PassThrough(); s.stderr = new PassThrough(); s.setWindow = () => {}; this.stream = s; cb(null, s); onShell(s, this); }
    end() { this.ended = true; try { this.stream?.destroy(); } catch { /* */ } }
  };
}

/** 번호를 붙인 조각을 백프레셔를 지키며 쓴다. 반환: 전체 텍스트·write 가 false 를 준 횟수. */
async function produce(stream, chunks, size, { stopped = () => false } = {}) {
  let all = ''; let blocked = 0;
  for (let i = 0; i < chunks; i++) {
    if (stopped()) break;
    const piece = `[${String(i).padStart(5, '0')}]${'x'.repeat(size - 8)}\n`;
    all += piece;
    if (!stream.write(piece)) { blocked++; await new Promise((r) => { const t = setTimeout(r, 2000); stream.once('drain', () => { clearTimeout(t); r(); }); }); }
  }
  return { all, blocked };
}

function sshMapping(port = 22) {
  const r = reg.addMapping({ protocol: 'ssh', targetHost: '127.0.0.1', targetPort: port, owner: 'admin1' });
  assert.equal(r.ok, true, r.reason);
  return r.mapping;
}

const LIM = { high: 256 * 1024, low: 64 * 1024, max: 2 * 1024 * 1024, stallMs: 5000 };

test('① 빠른 출력 + 느린 소비 — 대기열 상한 이내 · 멈췄다 풀림 · 순서·내용 그대로', async () => {
  let producing = null;
  let ws = null;
  // 세션이 닫히면 생산을 멈춘다 — 멈춤(pause)이 빠진 회귀에서 대기열 상한으로 닫힌 뒤 drain 을 기다리며 매달리지 않고 곧바로 실패하게.
  gw._setSshDepsForTest({ Client: fakeClientClass((s) => { producing = produce(s, 300, 16 * 1024, { stopped: () => ws.readyState !== 1 }); }) });
  try {
    const before = gw.sshOutputStats();
    ws = new SlowWs();
    const h = gw._handleConnectionForTest(ws, ADMIN, { token: 'tok1', limits: LIM });
    ws.pump(64 * 1024, 2);
    ws.input({ type: 'auth', mappingId: sshMapping().id, username: 'u', password: 'p' });
    assert.ok(await waitFor(() => producing));
    const { all, blocked } = await producing;
    assert.ok(await waitFor(() => ws.text.length >= all.length && ws.bufferedAmount === 0), `받은 ${ws.text.length} / 보낸 ${all.length}`);
    assert.equal(ws.text, all, '출력 순서·내용이 바뀌었다');
    assert.ok(ws.maxBuffered <= LIM.high + 16 * 1024, `대기열 최대 ${ws.maxBuffered}B 가 high(${LIM.high}) + 조각 하나를 넘었다`);
    assert.ok(blocked > 0, 'SSH 쪽 쓰기가 한 번도 막히지 않았다 — 멈춤(pause)이 전달되지 않았다');
    const st = gw.sshOutputStats();
    assert.ok(st.pauses > before.pauses && st.resumes > before.resumes, JSON.stringify(st));
    assert.equal(h.outState().paused, false);
    ws.close(1000, 'bye');
    assert.ok(await waitFor(() => !h.outState().timers && gw.activeSshSessionCount() === 0));
  } finally { gw._setSshDepsForTest(null); }
});

test('② 두 사용자 — 한쪽이 멈춰도 다른 쪽은 끝까지 · 멈춘 쪽은 전송 대기 시한에 사유를 말하고 닫힌다 · 타이머 정리', async () => {
  const shells = [];
  gw._setSshDepsForTest({ Client: fakeClientClass((s, c) => shells.push({ s, c })) });
  try {
    const before = gw.sshOutputStats().stallClosed;
    const slow = new SlowWs(); // 전혀 소비하지 않는다
    const fast = new SlowWs(); fast.pump(1 << 20, 1);
    const hs = gw._handleConnectionForTest(slow, ADMIN, { token: 'tok1', limits: { ...LIM, stallMs: 800 } });
    const hf = gw._handleConnectionForTest(fast, OP2, { token: 'tok2', limits: LIM });
    const m = sshMapping();
    slow.input({ type: 'auth', mappingId: m.id, username: 'u', password: 'p' });
    assert.ok(await waitFor(() => shells.length === 1));
    fast.input({ type: 'auth', mappingId: reg.addMapping({ protocol: 'ssh', targetHost: '127.0.0.1', targetPort: 22, owner: 'admin2' }).mapping.id, username: 'u', password: 'p' });
    assert.ok(await waitFor(() => shells.length === 2));
    let slowStopped = false;
    const pSlow = produce(shells[0].s, 200, 16 * 1024, { stopped: () => slowStopped });
    const { all } = await produce(shells[1].s, 200, 16 * 1024);
    assert.ok(await waitFor(() => fast.text.length >= all.length), '멈춘 사용자 때문에 다른 사용자의 출력이 막혔다');
    assert.equal(fast.text, all);
    assert.equal(fast.closed, null);
    assert.ok(slow.maxBuffered <= LIM.high + 16 * 1024, `멈춘 쪽 대기열 ${slow.maxBuffered}`);
    assert.ok(await waitFor(() => slow.closed, 4000), '전송 대기 시한에 닫혀야 한다');
    slowStopped = true;
    assert.equal(slow.closed.code, 4008);
    assert.match(slow.statuses().join('\n'), /출력을 받지 못해 세션을 닫습니다/);
    assert.equal(gw.sshOutputStats().stallClosed, before + 1);
    assert.ok(shells[0].c.ended, '멈춘 쪽 SSH 연결을 끊어야 한다');
    await pSlow;
    assert.ok(await waitFor(() => !hs.outState().timers), '닫힌 연결의 타이머가 남았다');
    fast.close(1000, 'bye');
    assert.ok(await waitFor(() => !hf.outState().timers && gw.activeSshSessionCount() === 0));
    assert.equal(gw.remoteSessionStatus().live, 0);
    assert.deepEqual(gw.remoteSessionStatus().watching, { revalidateTimer: false, revocationSubscribed: false });
  } finally { gw._setSshDepsForTest(null); }
});

test('③ 멈춤이 듣지 않는 스트림 — 대기열 상한을 넘으면 사유를 말하고 닫는다', async () => {
  let deaf = null;
  gw._setSshDepsForTest({
    Client: class extends EventEmitter {
      connect() { setImmediate(() => this.emit('ready')); }
      exec(_c, cb) { cb(new Error('no')); }
      shell(_o, cb) { deaf = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), pause() {}, resume() {}, write() {}, end() {}, setWindow() {} }); deaf.stderr.pause = () => {}; deaf.stderr.resume = () => {}; cb(null, deaf); }
      end() { this.ended = true; }
    },
  });
  try {
    const before = gw.sshOutputStats().overflowClosed;
    const ws = new SlowWs();
    gw._handleConnectionForTest(ws, ADMIN, { token: 'tok1', limits: LIM });
    ws.input({ type: 'auth', mappingId: sshMapping().id, username: 'u', password: 'p' });
    assert.ok(await waitFor(() => deaf));
    const chunk = Buffer.alloc(64 * 1024, 0x41);
    for (let i = 0; i < 100 && !ws.closed; i++) deaf.emit('data', chunk);
    assert.equal(ws.closed?.code, 4009);
    assert.match(ws.statuses().join('\n'), /출력 대기열이 상한/);
    assert.ok(ws.bufferedAmount <= LIM.max + chunk.length, `닫은 뒤에도 쌓였다: ${ws.bufferedAmount}`);
    const n = ws.queue.length;
    deaf.emit('data', chunk);
    assert.equal(ws.queue.length, n, '닫은 뒤 출력을 더 보냈다');
    assert.equal(gw.sshOutputStats().overflowClosed, before + 1);
  } finally { gw._setSshDepsForTest(null); }
});

test('④ 실제 ssh2 — 포탈이 멈추면 SSH 창 흐름 제어로 대상 서버의 쓰기가 막힌다 · 내용 그대로', async () => {
  const hostKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' });
  const fp = `SHA256:${crypto.createHash('sha256').update(ssh2.utils.parseKey(hostKey).getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
  let produced = null;
  const srv = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => (ctx.method === 'password' ? ctx.accept() : ctx.reject(['password'])));
    client.on('ready', () => client.on('session', (accept) => {
      const s = accept();
      s.on('pty', (a) => a && a());
      s.on('exec', (a) => { const st = a(); st.write('h\n'); st.exit(0); st.end(); });
      s.on('shell', (a) => { const st = a(); produced = produce(st, 256, 16 * 1024); });
    }));
    client.on('error', () => {});
  });
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  closers.push(() => new Promise((r) => srv.close(() => r())));
  pt.approvePeer('ssh', '127.0.0.1', port, fp, { by: 'test' });
  const ws = new SlowWs();
  const h = gw._handleConnectionForTest(ws, ADMIN, { token: 'tok1', limits: { ...LIM, high: 512 * 1024, low: 128 * 1024 } });
  ws.input({ type: 'auth', mappingId: sshMapping(port).id, username: 'u', password: 'p' });
  assert.ok(await waitFor(() => produced), ws.statuses().join(' | '));
  // 한동안 소비하지 않는다 — 대상 서버가 막혀야 한다(SSH 창 2MB + 포탈 대기열 high 만큼만 흘러온다).
  await new Promise((r) => setTimeout(r, 600));
  assert.ok(h.outState().paused, '대기열이 high 를 넘었는데 멈추지 않았다');
  const held = ws.maxBuffered;
  assert.ok(held <= 512 * 1024 + 64 * 1024, `소비가 멈춘 동안 대기열 ${held}B`);
  ws.pump(256 * 1024, 2);
  const { all, blocked } = await produced;
  const got = () => { const i = ws.text.indexOf('[00000]'); return i < 0 ? '' : ws.text.slice(i); };
  const done = await waitFor(() => got().length >= all.length, 20000);
  ws.close(1000, 'bye');
  assert.ok(done, `끝까지 받아야 한다: ${got().length} / ${all.length}`);
  assert.equal(got(), all, '실제 SSH 경로에서도 내용·순서 그대로');
  assert.ok(blocked > 0, '대상 서버 쓰기가 막힌 적이 없다 — 흐름 제어가 전달되지 않았다');
  assert.ok(await waitFor(() => gw.activeSshSessionCount() === 0));
});

test('⑤ UTF-8 글자가 조각 경계에서 잘려도 깨지지 않는다', async () => {
  let sh = null;
  gw._setSshDepsForTest({ Client: fakeClientClass((s) => { sh = s; }) });
  try {
    const ws = new SlowWs(); ws.pump(1 << 20, 1);
    gw._handleConnectionForTest(ws, ADMIN, { token: 'tok1', limits: LIM });
    ws.input({ type: 'auth', mappingId: sshMapping().id, username: 'u', password: 'p' });
    assert.ok(await waitFor(() => sh));
    const b = Buffer.from('한글 출력 테스트\n');
    sh.write(b.subarray(0, 4)); // '한' 3바이트 + '글' 첫 바이트
    sh.write(b.subarray(4));
    assert.ok(await waitFor(() => ws.text.includes('테스트')));
    assert.equal(ws.text, '한글 출력 테스트\n');
    assert.ok(!ws.text.includes('�'));
    ws.close(1000, 'bye');
  } finally { gw._setSshDepsForTest(null); }
});

test('⑥ 계정당 동시 SSH 세션 상한 — 한 계정이 상한을 다 써도 다른 계정은 연다 · 닫으면 다시 열 수 있다', async () => {
  const shells = [];
  gw._setSshDepsForTest({ Client: fakeClientClass((st, c) => shells.push({ st, c })) });
  const opened = [];
  try {
    assert.ok(await waitFor(() => gw.activeSshSessionCount() === 0 && gw.sshOutputStats().perUserOpen === 0), `앞 테스트의 세션이 남았다 ${JSON.stringify(gw.sshOutputStats())} active=${gw.activeSshSessionCount()}`);
    const cap = gw.MAX_SESSIONS_PER_USER;
    assert.ok(cap > 0 && cap < 80, `상한 ${cap} 은 전체 상한(80)보다 작아야 한다`);
    const m = sshMapping();
    for (let i = 0; i < cap; i++) {
      const w = new SlowWs(); w.pump(1 << 20, 5);
      gw._handleConnectionForTest(w, ADMIN, { token: 'tok1', limits: LIM });
      w.input({ type: 'auth', mappingId: m.id, username: 'u', password: 'p' });
      opened.push(w);
    }
    assert.ok(await waitFor(() => shells.length === cap), `${shells.length}/${cap} ${opened.map((w) => (w.closed ? w.closed.code : '') + w.statuses().slice(-1).join('')).filter(Boolean).join(' | ')}`);
    const over = new SlowWs();
    gw._handleConnectionForTest(over, ADMIN, { token: 'tok1', limits: LIM });
    over.input({ type: 'auth', mappingId: m.id, username: 'u', password: 'p' });
    assert.ok(await waitFor(() => over.closed));
    assert.equal(over.closed.code, 4429);
    assert.match(over.statuses().join('\n'), /이 계정의 동시 원격 세션 한도/);
    assert.equal(shells.length, cap, '상한을 넘은 세션이 대상에 접속했다');
    // 다른 계정은 영향이 없다
    const other = new SlowWs(); other.pump(1 << 20, 5);
    gw._handleConnectionForTest(other, OP2, { token: 'tok2', limits: LIM });
    other.input({ type: 'auth', mappingId: reg.addMapping({ protocol: 'ssh', targetHost: '127.0.0.1', targetPort: 22, owner: 'admin2' }).mapping.id, username: 'u', password: 'p' });
    assert.ok(await waitFor(() => shells.length === cap + 1), '다른 계정이 막혔다');
    opened.push(other);
    // 하나를 닫으면 다시 열 수 있다
    opened[0].close(1000, 'bye');
    assert.ok(await waitFor(() => gw.activeSshSessionCount() === cap));
    const again = new SlowWs(); again.pump(1 << 20, 5);
    gw._handleConnectionForTest(again, ADMIN, { token: 'tok1', limits: LIM });
    again.input({ type: 'auth', mappingId: m.id, username: 'u', password: 'p' });
    assert.ok(await waitFor(() => shells.length === cap + 2));
    opened.push(again);
  } finally {
    for (const w of opened) w.close(1000, 'bye');
    gw._setSshDepsForTest(null);
  }
  assert.ok(await waitFor(() => gw.activeSshSessionCount() === 0 && gw.sshOutputStats().perUserOpen === 0), JSON.stringify(gw.sshOutputStats()));
});
