/**
 * 전체 점검 76회차 — 원격 접속 게이트웨이(proxy) 회귀.
 *  F1 guacd → 브라우저 중계는 완전한 Guacamole 명령 단위로(브라우저 WebSocketTunnel 은 메시지마다 따로 파싱 — 잘린 명령이 버려졌다) · UTF-8 조각 경계
 *  F2 매핑 이름의 제어 문자(NUL 등)는 HAProxy 자동 배포 블록에 들어가지 않는다(한 매핑이 그 프록시의 전 배포를 막았다)
 *  F3 매핑의 중계 프록시가 지워졌으면 SSH · RDP · .rdp 가 기본 프록시(+ 같은 공개 포트 = 다른 매핑의 대상)로 바꿔 접속하지 않는다
 *  F4 guacd 호스트의 대괄호 IPv6 는 벗겨서 접속한다
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import express from 'express';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const DIR = tmpDir('proxy-audit76-');
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.OTP_ROLE_ENFORCE = 'false';
process.env.DATA_SOURCE = 'live';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

const auth = await import('../src/auth/auth.js');
const sessions = await import('../src/auth/sessions.js');
const gw = await import('../src/proxy/sshGateway.js');
const gd = await import('../src/proxy/guacdTunnel.js');
const reg = await import('../src/proxy/registry.js');
const deploy = await import('../src/proxy/deploy.js');
const transport = await import('../src/proxy/guacdTransport.js');
const { issueRdpTicket, consumeRdpTicket } = await import('../src/proxy/rdpTicket.js');
const { store } = await import('../src/store.js');

const allWs = [];
class FakeWs extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.readyState = 1; this.frames = []; this.closed = null; this.bufferedAmount = 0; allWs.push(this); }
  send(d, cb) { this.frames.push(String(d)); if (cb) setImmediate(() => cb()); }
  close(code, reason) { if (this.readyState !== 1) return; this.readyState = 3; this.closed = { code, reason }; setImmediate(() => this.emit('close')); }
  terminate() { this.close(1006, ''); }
  input(o) { this.emit('message', Buffer.from(typeof o === 'string' ? o : JSON.stringify(o))); }
  statuses() { return this.frames.filter((f) => f.startsWith('{')).map((f) => JSON.parse(f)).filter((o) => o.type === 'status').map((o) => o.text); }
}
after(async () => { for (const w of allWs) { try { w.close(1000, 'test end'); } catch { /* */ } } await new Promise((r) => setTimeout(r, 50)); });

function fakeGuacd() {
  return Object.assign(new EventEmitter(), {
    writes: [], destroyed: false,
    write(s) { if (this.destroyed) throw new Error('destroyed'); this.writes.push(String(s)); return true; },
    destroy() { this.destroyed = true; setImmediate(() => this.emit('close')); },
    end() { this.destroy(); }, setTimeout() {},
  });
}
function mkUser(username, scope = {}) {
  const r = auth.createUser({ username, role: 'operator', password: 'Passw0rd!x', scope }, { trusted: true });
  assert.equal(r.ok, true, r.reason);
}
function login(username) {
  const u = auth.getUser(username);
  const s = sessions.newSessionId();
  sessions.setActiveSession(username, s);
  return auth.signToken({ sub: username, role: u.role, name: username, src: 'local', tv: u.tokenVersion || 0, sid: s });
}

before(() => {
  store.snapshot = { ...store.get(), vcenters: [{ id: 'vc-a' }], vms: [{ id: 'vm1', vcenterId: 'vc-a', name: 'vm1', ipAddresses: ['10.1.1.5'] }], hosts: [] };
});

/* ─────────── F1 Guacamole 명령 경계 ─────────── */

test('F1: guacCompleteEnd — 완전한 명령이 끝나는 위치 · 미완성은 앞까지 · 형식 오류는 -1 · 길이는 유니코드 글자 수', () => {
  const { guacCompleteEnd } = gd;
  assert.equal(guacCompleteEnd(''), 0);
  assert.equal(guacCompleteEnd('4.sync,1.1;'), 11);
  assert.equal(guacCompleteEnd('4.sync,1.1;4.sy'), 11, '뒤의 잘린 명령은 남긴다');
  assert.equal(guacCompleteEnd('4.syn'), 0);
  assert.equal(guacCompleteEnd('4.sync,1'), 0, '길이 칸이 아직 다 오지 않았다');
  assert.equal(guacCompleteEnd('4.sync,1.1;1'), 11);
  assert.equal(guacCompleteEnd('0.,4.ping,1.5;'), 14, '빈 opcode(내부 명령)도 형식은 맞다');
  assert.equal(guacCompleteEnd('-4.ab;'), -1, '음수 길이(49회차 F49-1 과 같은 규칙)');
  assert.equal(guacCompleteEnd('12345678901.x'), -1, '길이 칸은 10자리까지');
  assert.equal(guacCompleteEnd('x.ab;'), -1);
  assert.equal(guacCompleteEnd('4.sync!'), -1, '구분자가 , ; 가 아니다');
  assert.equal(guacCompleteEnd('2.한글;'), 5, 'BMP 글자는 UTF-16 한 칸');
  const astral = '2.😀a;4.sync;';   // 😀 = 글자 하나(UTF-16 두 칸) — guacd 는 UTF-8 글자로 센다
  assert.equal(guacCompleteEnd(astral), astral.length);
  assert.equal(guacCompleteEnd('2.😀'), 0, '값이 아직 다 오지 않았다');
});

test('F1: makeGuacRelay — 조각이 명령 · UTF-8 글자 중간에서 잘려도 완전한 명령만 순서대로 보낸다', () => {
  const full = '5.ready,4.abcd;4.name,7.서버-원격접속;3.img,1.1,2.14,1.0,9.image/png,1.0,1.0;4.blob,1.1,8.QUJDRA==;3.end,1.1;4.sync,13.1700000000000;';
  const bytes = Buffer.from(full, 'utf8');
  const sent = []; const fails = [];
  const relay = gd.makeGuacRelay((t) => sent.push(t), (w) => fails.push(w));
  // 한글 글자의 바이트 중간 · img 명령 중간 · 길이 칸 중간을 지나게 자른다
  const cuts = [7, bytes.indexOf(0xec) + 1, bytes.indexOf(Buffer.from('9.image')) + 3, bytes.indexOf(Buffer.from('blob')) - 1, bytes.length - 4];
  let prev = 0;
  for (const c of [...cuts.sort((a, b) => a - b), bytes.length]) { relay.push(bytes.subarray(prev, c)); prev = c; }
  assert.deepEqual(fails, []);
  assert.equal(sent.join(''), full, '이어 붙이면 원문 그대로(글자 깨짐 없음)');
  for (const f of sent) assert.equal(gd.guacCompleteEnd(f), f.length, `메시지마다 완전한 명령으로 끝나야 한다: ${JSON.stringify(f.slice(-20))}`);
  assert.equal(relay.pendingLength(), 0);
});

test('F1: makeGuacRelay — 형식이 깨졌거나 한 명령이 상한을 넘으면 한 번만 실패로 닫고 더 보내지 않는다', () => {
  const sent = []; const fails = [];
  const r1 = gd.makeGuacRelay((t) => sent.push(t), (w) => fails.push(w));
  r1.text('4.sync,1.1;x.bad;');
  assert.deepEqual(fails.length, 1);
  r1.text('4.sync,1.2;');
  assert.equal(sent.length, 0, '형식 오류가 섞인 묶음은 보내지 않고 이후도 보내지 않는다');
  const fails2 = [];
  const r2 = gd.makeGuacRelay(() => {}, (w) => fails2.push(w), { maxPending: 64 });
  r2.text('5000.');
  r2.text('a'.repeat(100));
  r2.text('a'.repeat(100));
  assert.equal(fails2.length, 1, '상한을 넘은 미완성 명령은 한 번만 실패');
  assert.ok(gd.GUAC_RELAY_MAX_PENDING >= 1024 * 1024);
});

test('F1: RDP 연결 처리기 — ready 뒤 guacd TCP 조각이 명령 중간에서 잘려도 브라우저 프레임은 완전한 명령 단위다(실제 처리기)', async () => {
  mkUser('rdp76a');
  reg.saveConfig({ guacd: { host: '127.0.0.1', port: 4822 } });
  const tok = login('rdp76a');
  const r = reg.addMapping({ protocol: 'rdp', targetHost: '10.1.1.5', targetPort: 3389, owner: 'rdp76a', vcenterId: 'vc-a' });
  assert.equal(r.ok, true, r.reason);
  const ticket = issueRdpTicket({ username: 'u', password: 'p' }, { owner: 'rdp76a' });
  const sock = fakeGuacd();
  gd._setRdpDepsForTest({ connect: () => sock });
  try {
    const ws = new FakeWs();
    gd._rdpHandleForTest(ws, new URLSearchParams({ mappingId: r.mapping.id, ticket }), auth.resolveTokenUser(tok), tok);
    sock.emit('connect');
    sock.emit('data', Buffer.from('4.args,13.VERSION_1_5_0,8.hostname,4.port;'));
    // ready 와 같은 조각에 다음 명령의 앞부분이 붙어 온다(ready 직후 조각 경계)
    const tail = '4.name,4.원격서버;3.img,1.1,2.14,1.0,9.image/png,1.0,1.0;4.sync,13.1700000000000;';
    const tb = Buffer.from(tail, 'utf8');
    const k = tb.indexOf(0xec) + 1;           // '원' 의 첫 바이트 뒤(UTF-8 글자 중간)
    const m = tb.indexOf(Buffer.from('9.image')) + 4;
    sock.emit('data', Buffer.concat([Buffer.from('5.ready,5.$abcd;'), tb.subarray(0, k)]));
    sock.emit('data', tb.subarray(k, m));
    sock.emit('data', tb.subarray(m));
    assert.equal(ws.closed, null, `닫히면 안 된다: ${JSON.stringify(ws.closed)}`);
    assert.equal(ws.frames.join(''), `5.ready,5.$abcd;${tail}`, '이어 붙이면 원문 그대로');
    for (const f of ws.frames) assert.equal(gd.guacCompleteEnd(f), f.length, `브라우저 프레임이 명령 중간에서 끝났다: ${JSON.stringify(f)}`);
    // guacd 가 깨진 출력을 보내면 사유를 말하고 닫는다(브라우저가 조용히 버리게 두지 않는다)
    sock.emit('data', Buffer.from('zz.bad;'));
    assert.equal(ws.closed?.code, 1011);
    assert.equal(sock.destroyed, true);
  } finally { gd._setRdpDepsForTest(null); }
});

/* ─────────── F2 매핑 이름 → HAProxy 블록 ─────────── */

test('F2: 매핑 이름의 제어 문자(NUL · 수직 탭 · 줄 구분자)는 저장 · 배포 블록 어디에도 들어가지 않는다', () => {
  const r = reg.addMapping({ name: 'evil\u0000name\u000b\u2028listen x\u0085', protocol: 'ssh', targetHost: '10.1.1.5', targetPort: 22, owner: 'x', vcenterId: 'vc-a' });
  assert.equal(r.ok, true, r.reason);
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(r.mapping.name, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
  // 예전에 저장된 이름(제어 문자 포함)도 블록 생성에서 걸러진다
  const legacy = { id: 'abc123', name: 'old\u0000\nlisten evil\r', protocol: 'ssh', targetHost: '10.1.1.6', targetPort: 22, publicPort: 20077 };
  const block = deploy.buildConfigBlock([legacy, r.mapping]);
  assert.ok(!block.includes('\u0000'), 'NUL 이 설정 파일에 들어가면 HAProxy 가 전체 설정을 거부한다(Stray NUL character)');
  assert.ok(!block.includes('\u2028') && !block.includes('\u000b') && !block.includes('\r'));
  assert.ok(!block.split('\n').some((l) => l.trim().startsWith('listen evil')), '이름이 새 줄을 만들면 안 된다');
  assert.equal(reg.mappingNameText(undefined), '');
  reg.removeMapping(r.mapping.id);
});

/* ─────────── F3 지워진 중계 프록시 ─────────── */

let portSeq = 31000;
function setupRemovedProxy(owner) {
  const base = (portSeq += 10);
  const sp = reg.saveProxy({ name: 'P2', proxyHost: 'p2.example', publicPortBase: base, vcenterIds: [], guacd: { host: '127.0.0.1', port: 4822 } });
  assert.equal(sp.ok, true, sp.reason);
  const p2 = sp.proxy.id;
  reg.saveConfig({ proxyHost: 'default.example', guacd: { host: '127.0.0.1', port: 4822 } });
  const a = reg.addMapping({ protocol: 'ssh', targetHost: '10.1.1.5', targetPort: 22, publicPort: base + 1, proxyId: p2, owner, vcenterId: 'vc-a' });
  const ar = reg.addMapping({ protocol: 'rdp', targetHost: '10.1.1.5', targetPort: 3389, publicPort: base + 2, proxyId: p2, owner, vcenterId: 'vc-a' });
  // 기본 프록시의 같은 공개 포트에는 다른 대상의 매핑이 있다
  const b = reg.addMapping({ protocol: 'ssh', targetHost: '10.9.9.9', targetPort: 22, publicPort: base + 1, owner: 'someone-else' });
  assert.ok(a.ok && ar.ok && b.ok, `${a.reason} ${ar.reason} ${b.reason}`);
  assert.equal(reg.mappingProxyOf(a.mapping)?.id, p2);
  // 79회차(결정 — 권장안): 매핑이 쓰는 중계는 이제 removeProxy 가 409 로 거절한다. 이 시험은 그 전 판본에서 지워졌거나(업그레이드 전 상태)
  //   파일을 손으로 고쳐 매핑만 남은 상태를 본다 — 메모리 설정에서 직접 뺀다(게이트웨이 판정 mappingProxyOf 는 그 상태에서도 null 이어야 한다).
  assert.equal(reg.removeProxy(p2).code, 'proxy-in-use');
  const cfg = reg.getConfig(); cfg.proxies = cfg.proxies.filter((x) => x.id !== p2);
  return { ssh: reg.getMapping(a.mapping.id), rdp: reg.getMapping(ar.mapping.id) };
}

test('F3: 매핑의 중계가 지워졌으면 SSH 게이트웨이는 접속하지 않는다 — 기본 프록시 + 같은 공개 포트(다른 매핑의 대상)로 바꿔 끼우지 않는다', async () => {
  mkUser('ssh76');   // 전체 범위 계정(범위 판정의 중계 대조를 타지 않는 쪽)
  const { ssh: m } = setupRemovedProxy('ssh76');
  assert.equal(reg.mappingProxyOf(m), null, '지워진 중계는 null — 기본 프록시가 아니다');
  assert.equal(reg.mappingProxyOf({ proxyId: '' })?.id, 'default', 'proxyId 없는 예전 매핑은 기본 프록시 그대로');
  const tok = login('ssh76');
  const dials = [];
  class FakeClient extends EventEmitter { connect(o) { dials.push(o); } end() {} exec() {} shell() {} }
  gw._setSshDepsForTest({ Client: FakeClient });
  try {
    const ws = new FakeWs();
    gw._handleConnectionForTest(ws, auth.resolveTokenUser(tok), { token: tok });
    ws.input({ type: 'auth', mappingId: m.id, username: 'root', password: 'secret-pw' });
    assert.deepEqual(dials, [], `접속하면 안 된다(비밀번호가 다른 장비로 간다): ${JSON.stringify(dials.map((d) => `${d.host}:${d.port}`))}`);
    assert.equal(ws.closed?.code, 4404);
    assert.equal(ws.closed?.reason, 'mapping-proxy-gone');
    assert.ok(ws.statuses().some((t) => t.includes('중계 서버')), ws.statuses().join(' | '));
    assert.equal(gw.activeSshSessionCount(), 0, '세션 수에 세지 않는다');
  } finally { gw._setSshDepsForTest(null); }
});

test('F3: RDP 게이트웨이도 접속하지 않고 티켓을 소비하지 않는다 · .rdp 내려받기는 409', async () => {
  mkUser('rdp76b');
  const { rdp: m } = setupRemovedProxy('rdp76b');
  const tok = login('rdp76b');
  const ticket = issueRdpTicket({ username: 'u', password: 'p' }, { owner: 'rdp76b' });
  let dialed = 0;
  gd._setRdpDepsForTest({ connect: () => { dialed++; return fakeGuacd(); } });
  try {
    const ws = new FakeWs();
    gd._rdpHandleForTest(ws, new URLSearchParams({ mappingId: m.id, ticket }), auth.resolveTokenUser(tok), tok);
    assert.equal(dialed, 0, 'guacd 에 붙으면 connect 명령에 기본 프록시 주소 + 같은 공개 포트가 실린다');
    assert.equal(ws.closed?.reason, 'mapping-proxy-gone');
    assert.ok(consumeRdpTicket(ticket, { user: 'rdp76b' }), '티켓은 쓰지 않은 채 남는다(주인이 다른 매핑에 쓸 수 있다)');
  } finally { gd._setRdpDepsForTest(null); }

  const { remoteRouter } = await import('../src/routes/remote.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = auth.resolveTokenUser(tok); next(); });
  app.use('/api/remote', remoteRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/remote/rdp/${m.id}`);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.reason, /중계 서버/);
    // 매핑 목록도 기본 프록시 주소(= 수동 접속이 다른 매핑의 대상으로 가는 주소)를 보이지 않는다
    const list = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/remote/mappings`)).json();
    const row = list.mappings.find((x) => x.id === m.id);
    assert.equal(row?.proxyGone, true);
    assert.equal(row.proxyHost, '');
    assert.notEqual(row.proxyName, '기본 프록시');
  } finally { await new Promise((r) => srv.close(() => r())); }
});

/* ─────────── F4 guacd 대괄호 IPv6 ─────────── */

test('F4: guacd 호스트를 대괄호로 적은 IPv6 는 벗겨서 접속한다(평문 · TLS)', () => {
  const seen = [];
  transport.openGuacdSocket({ host: '[fd00::5]', port: 4822 }, { netConnect: (p, h) => { seen.push(h); return {}; } });
  assert.deepEqual(seen, ['fd00::5']);
  const tlsSeen = [];
  transport.openGuacdSocket({ host: '[fd00::6]', port: 4823, tls: true }, { tlsConnect: (o) => { tlsSeen.push(o); return {}; } });
  assert.equal(tlsSeen[0].host, 'fd00::6');
  assert.equal(tlsSeen[0].servername, undefined, 'IP 는 SNI 를 싣지 않는다');
  const plain = [];
  transport.openGuacdSocket({ host: 'guacd.corp', port: 4822 }, { netConnect: (p, h) => { plain.push(h); return {}; } });
  assert.deepEqual(plain, ['guacd.corp'], '이름은 그대로');
});

/* ─────────── F5 읽기 오류 ≠ 손상 ─────────── */

test('F5: remote-access.json 읽기 오류(EIO)는 손상이 아니다 — 원본을 옮기지 않고 · 캐시하지 않고 · 저장을 거절하며 · 다시 읽히면 그대로 돌아온다', async () => {
  const FILE = path.join(DIR, 'remote-access.json');
  // 앞 시험들이 쓴 실제 파일(중계 · 매핑 포함)
  reg.addMapping({ protocol: 'ssh', targetHost: '10.1.1.5', targetPort: 2299, owner: 'f5owner', vcenterId: 'vc-a' });
  const before = fs.readFileSync(FILE, 'utf8');
  const nBefore = JSON.parse(before).mappings.length;
  assert.ok(nBefore >= 1);
  const jfl = await import('../src/util/jsonFileLoad.js');
  let now = Date.now();
  jfl._setJsonFileLoadClockForTest(() => now);
  const orig = fs.readFileSync;
  let failing = true;
  fs.readFileSync = function patched(p, ...a) {
    if (failing && String(p) === FILE) { const e = new Error('EIO: i/o error, read'); e.code = 'EIO'; throw e; }
    return orig.call(this, p, ...a);
  };
  try {
    const fresh = await import(`../src/proxy/registry.js?r76f5=${Date.now()}`);   // 캐시 없는 새 인스턴스 — 기동 직후 첫 읽기와 같다
    assert.equal(fresh.listMappings().length, 0, '못 읽은 동안은 빈 목록(게이트웨이는 매핑 없음으로 닫는다)');
    assert.throws(() => fresh.addMapping({ protocol: 'ssh', targetHost: '10.1.1.5', targetPort: 2300, owner: 'x' }), (e) => e.code === 'settings-unreadable' && e.status === 409);
    assert.doesNotThrow(() => fresh.touchMapping('nope'));
    assert.equal(orig.call(fs, FILE, 'utf8'), before, '온전한 원본을 빈 설정으로 덮으면 안 된다');
    assert.deepEqual(fs.readdirSync(DIR).filter((f) => f.startsWith('remote-access.json.corrupt')), [], '읽기 오류를 손상으로 보고 원본을 옮기면 안 된다');
    failing = false;
    now += 31_000;   // 다시 읽기 간격(READ_RETRY_MS) 뒤
    assert.equal(fresh.listMappings().length, nBefore, '다시 읽히면 원래 매핑이 그대로 보인다');
    const ok = fresh.addMapping({ protocol: 'ssh', targetHost: '10.1.1.5', targetPort: 2301, owner: 'x', vcenterId: 'vc-a' });
    assert.equal(ok.ok, true, '회복 뒤에는 저장된다');
    // 사용 시각 기록의 쓰기 실패(디스크 가득 등)는 던지지 않는다 — WS 처리기 안에서 불리므로 던지면 처리기 밖 '[fatal]' 이 된다
    const origRename = fs.renameSync;
    fs.renameSync = () => { const e = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; throw e; };
    try { assert.doesNotThrow(() => fresh.touchMapping(ok.mapping.id)); } finally { fs.renameSync = origRename; }
  } finally {
    fs.readFileSync = orig;
    jfl._setJsonFileLoadClockForTest(null);
  }
  // 진짜 손상(JSON 아님)은 예전처럼 보존본으로 옮기고 빈 값이다
  fs.writeFileSync(FILE, '{ not json');
  const broken = await import(`../src/proxy/registry.js?r76f5b=${Date.now()}`);
  assert.equal(broken.listMappings().length, 0);
  assert.ok(fs.readdirSync(DIR).some((f) => f.startsWith('remote-access.json.corrupt')), '손상은 보존본으로');
});
