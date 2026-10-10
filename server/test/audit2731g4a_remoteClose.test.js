/**
 * v2.731 점검 1회차 G4a · A5-02 + A1-03 — 원격 콘솔 닫힘 사유가 원인별로 구분되어 화면까지 간다.
 *
 * 결함: 게이트웨이는 4403 하나를 권한·범위·매핑 삭제(mapping-gone)·대상 변경(mapping-changed)·**호스트키 거부**에 함께 쓰고,
 * 웹 onclose 는 4403 을 무조건 '이 계정의 권한·범위가 바뀌어 서버가 연결을 닫았습니다' 로 바꿔 서버가 먼저 보낸 정확한 사유(status)를
 * 상태줄에서 덮었다 — 호스트키가 승인되지 않은 장비에 붙은 사용자는 권한을 의심하고, 실제 조치(장비 신뢰에서 지문 승인)를 하지 않는다.
 *
 * 여기서는 **실제 연결 처리기**(sshGateway handleConnection · guacdTunnel handle)를 가짜 WS 로 돌리고 실제 ssh2 서버(루프백)로
 *   ① 미승인 호스트키 → 닫힘 사유 'host-key-unknown'(코드 4403 그대로) · 화면 문구가 호스트키·장비 신뢰를 말하고 권한을 말하지 않는다
 *   ② 승인된 키와 다른 키 → 'host-key-changed'
 *   ③ 접속 때 매핑 권한 없음 → 'mapping-denied'(예전 'forbidden')
 *   ④ 열린 세션의 매핑 삭제 → 'mapping-gone' · 대상 변경 → 'mapping-changed' — 화면 문구가 각각 다르다
 *   ⑤ RDP 접속 때 매핑 권한 없음 → 'mapping-denied'(닫힘 코드 1011 그대로)
 * 를 고정한다. 문구 판정은 화면이 쓰는 web/src/remote/sshSend.js 를 그대로 import 한다.
 * 호스트 키는 Node crypto EC SEC1 PEM(ssh2 ed25519 생성기는 0.52% 확률로 깨진 키를 만든다 — CLAUDE.md v2.590).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import ssh2 from 'ssh2';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a2731g4a-remote-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'true';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.SSH_HOSTKEY_POLICY = 'enforce'; // 매핑 파일이 먼저 생기면 '기존 현장(observe)' 으로 판정된다 — 이 테스트는 거부 경로를 본다
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

const closers = [];
const allWs = [];
after(async () => {
  for (const w of allWs) { try { w.close(1000, 'test end'); } catch { /* */ } }
  await new Promise((r) => setTimeout(r, 200));
  for (const c of closers) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

const gw = await import('../src/proxy/sshGateway.js');
const gd = await import('../src/proxy/guacdTunnel.js');
const reg = await import('../src/proxy/registry.js');
const pt = await import('../src/security/peerTrust.js');
const { remoteCloseReasonText, sshCloseReasonText } = await import('../../web/src/remote/sshSend.js');

const newKey = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' });
const fpOf = (pem) => `SHA256:${crypto.createHash('sha256').update(ssh2.utils.parseKey(pem).getPublicSSH()).digest('base64').replace(/=+$/, '')}`;

async function sshServer() {
  const hostKey = newKey();
  const srv = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => { if (ctx.method === 'password' && ctx.password === 'pw') ctx.accept(); else ctx.reject(['password']); });
    client.on('ready', () => client.on('session', (accept) => {
      const s = accept();
      s.on('pty', (a) => a && a());
      s.on('window-change', (a) => a && a());
      s.on('exec', (a) => { const st = a(); st.write('labhost\n'); st.exit(0); st.end(); });
      s.on('shell', (a) => { const st = a(); st.write('welcome\r\n'); });
    }));
    client.on('error', () => {});
  });
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  closers.push(() => new Promise((r) => srv.close(() => r())));
  return { port, fp: fpOf(hostKey) };
}

class FakeWs extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.readyState = 1; this.frames = []; this.closed = null; this.bufferedAmount = 0; allWs.push(this); }
  send(d, cb) { this.frames.push(String(d)); if (cb) setImmediate(() => cb()); }
  close(code, reason) { if (this.readyState !== 1) return; this.readyState = 3; this.closed = { code, reason }; setImmediate(() => this.emit('close')); }
  terminate() { this.close(1006, ''); }
  input(o) { this.emit('message', Buffer.from(JSON.stringify(o))); }
  statuses() { return this.frames.filter((f) => f.startsWith('{')).map((f) => JSON.parse(f)).filter((o) => o.type === 'status').map((o) => o.text); }
}
const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };

const ADMIN = { username: 'admin1', role: 'admin', scope: { vcenters: [], regions: [] } };
const OPERATOR = { username: 'op1', role: 'operator', scope: { vcenters: [], regions: [] } };
const USERS = { tok: ADMIN, optok: OPERATOR };
const fakeDeps = () => ({ resolveTokenUser: (t) => USERS[t] || null, verifyToken: () => ({ sub: 'x', src: 'local', exp: Math.floor(Date.now() / 1000) + 3600 }) });

/** 화면이 그 닫힘에서 보일 문구 — RemoteConsole.jsx onclose 와 같은 순서(서버 사유 → 코드). */
const screenText = (closed) => remoteCloseReasonText(closed?.reason) || sshCloseReasonText(closed?.code);

test('① 미승인 호스트키: 닫힘 사유가 호스트키를 말한다(코드 4403 은 그대로) — 화면은 권한을 말하지 않는다', async () => {
  gw._setRemoteDepsForTest(fakeDeps());
  try {
    const s = await sshServer();
    const m = reg.addMapping({ protocol: 'ssh', targetHost: '127.0.0.1', targetPort: s.port, owner: 'admin1' }).mapping;
    const ws = new FakeWs();
    gw._handleConnectionForTest(ws, ADMIN, { token: 'tok' });
    ws.input({ type: 'auth', mappingId: m.id, username: 'root', password: 'pw' });
    assert.ok(await waitFor(() => ws.closed), 'WS 가 닫혀야 한다');
    assert.equal(ws.closed.code, 4403, '닫힘 코드 숫자는 바꾸지 않는다');
    assert.equal(ws.closed.reason, 'host-key-unknown');
    const t = screenText(ws.closed);
    assert.match(t, /호스트키/);
    assert.match(t, /장비 신뢰/);
    assert.doesNotMatch(t, /권한·범위가 바뀌어/, '호스트키 거부를 권한 변경으로 말하면 안 된다');
    assert.match(ws.statuses().join('\n'), /호스트키 확인 거부/, '서버의 상세 상태 줄은 그대로 보낸다');
  } finally { gw._setRemoteDepsForTest(null); }
});

test('② 승인된 키와 다른 키: 사유 host-key-changed · 화면이 키가 다르다고 말한다', async () => {
  gw._setRemoteDepsForTest(fakeDeps());
  try {
    const s = await sshServer();
    pt.approvePeer('ssh', '127.0.0.1', s.port, fpOf(newKey()), { by: 'test' }); // 다른 키를 승인해 둔다
    const m = reg.addMapping({ protocol: 'ssh', targetHost: '127.0.0.1', targetPort: s.port, owner: 'admin1' }).mapping;
    const ws = new FakeWs();
    gw._handleConnectionForTest(ws, ADMIN, { token: 'tok' });
    ws.input({ type: 'auth', mappingId: m.id, username: 'root', password: 'pw' });
    assert.ok(await waitFor(() => ws.closed));
    assert.equal(ws.closed.code, 4403);
    assert.equal(ws.closed.reason, 'host-key-changed');
    assert.match(screenText(ws.closed), /승인된 키와 달라/);
  } finally { gw._setRemoteDepsForTest(null); }
});

test('③ 접속 때 매핑 권한 없음: 사유 mapping-denied(예전 \'forbidden\') · 화면은 그 매핑을 쓸 수 없다고 말한다', async () => {
  gw._setRemoteDepsForTest(fakeDeps());
  try {
    const m = reg.addMapping({ protocol: 'ssh', targetHost: '127.0.0.1', targetPort: 22, owner: 'someone-else' }).mapping;
    const ws = new FakeWs();
    gw._handleConnectionForTest(ws, OPERATOR, { token: 'optok' });
    ws.input({ type: 'auth', mappingId: m.id, username: 'root', password: 'pw' });
    assert.ok(await waitFor(() => ws.closed));
    assert.equal(ws.closed.code, 4403);
    assert.equal(ws.closed.reason, 'mapping-denied');
    assert.match(screenText(ws.closed), /매핑을 쓸 수 없/);
    assert.equal(gw.activeSshSessionCount(), 0, '세션 수가 새지 않는다');
  } finally { gw._setRemoteDepsForTest(null); }
});

test('④ 열린 세션: 매핑 삭제 → mapping-gone · 대상 변경 → mapping-changed — 두 문구가 다르고 권한을 말하지 않는다', async () => {
  gw._setRemoteDepsForTest(fakeDeps());
  try {
    const s = await sshServer();
    pt.approvePeer('ssh', '127.0.0.1', s.port, s.fp, { by: 'test' });
    const open = async () => {
      const m = reg.addMapping({ protocol: 'ssh', targetHost: '127.0.0.1', targetPort: s.port, owner: 'admin1' }).mapping;
      const ws = new FakeWs();
      gw._handleConnectionForTest(ws, ADMIN, { token: 'tok' });
      ws.input({ type: 'auth', mappingId: m.id, username: 'root', password: 'pw' });
      assert.ok(await waitFor(() => ws.frames.some((f) => f.includes('welcome'))), `셸이 열려야 한다: ${ws.statuses().join(' | ')}`);
      return { ws, m };
    };
    const a = await open();
    reg.removeMapping(a.m.id);
    gw.revalidateRemoteSessions();
    assert.equal(a.ws.closed?.code, 4403);
    assert.equal(a.ws.closed?.reason, 'mapping-gone');
    const gone = screenText(a.ws.closed);
    assert.match(gone, /삭제/);

    const b = await open();
    gw._setRemoteDepsForTest({ getMapping: (id) => { const m = reg.getMapping(id); return m && { ...m, targetPort: Number(m.targetPort) + 1 }; } });
    gw.revalidateRemoteSessions();
    assert.equal(b.ws.closed?.code, 4403);
    assert.equal(b.ws.closed?.reason, 'mapping-changed');
    const changed = screenText(b.ws.closed);
    assert.match(changed, /대상/);
    assert.notEqual(gone, changed, '삭제와 대상 변경은 조치가 다르다 — 같은 문구로 덮지 않는다');
    for (const t of [gone, changed]) assert.doesNotMatch(t, /권한·범위가 바뀌어/);
  } finally { gw._setRemoteDepsForTest(null); }
});

test('⑤ RDP 접속 때 매핑 권한 없음: 닫힘 사유 mapping-denied(코드 1011 그대로) — 화면(Guacamole 터널)은 사유로 문구를 고른다', async () => {
  const m = { id: 'rdp-x', protocol: 'rdp', owner: 'someone-else', targetHost: '10.0.0.9', targetPort: 3389, proxyId: '' };
  gd._setRdpDepsForTest({ getMapping: () => m });
  try {
    const ws = new FakeWs();
    gd._rdpHandleForTest(ws, new URLSearchParams({ mappingId: 'rdp-x' }), OPERATOR, 'optok');
    assert.ok(await waitFor(() => ws.closed));
    assert.equal(ws.closed.code, 1011, '닫힘 코드 숫자는 바꾸지 않는다');
    assert.equal(ws.closed.reason, 'mapping-denied');
    assert.match(remoteCloseReasonText(ws.closed.reason), /매핑을 쓸 수 없/);
  } finally { gd._setRdpDepsForTest(null); }
});
