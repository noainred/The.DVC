/**
 * test/rvH_sshHostKey.test.js — SSH 호스트키 확인(2026-10-09 검토 S-01, 그룹 H).
 *
 * 재현(고치기 전): proxy/sshExec.js connect 와 proxy/sshGateway.js 는 ssh2 에 hostVerifier 를 주지 않아 **어떤 서버 키든**
 * 받아들였다 — 서로 다른 키의 서버 두 대 모두에 비밀번호가 전송됐다. 이 파일은 실제 ssh2 Server(루프백)를 띄워
 *   ① 지문 표기가 OpenSSH(ssh-keygen -lf)와 같다
 *   ② 새 설치(enforce): 모르는 키는 **비밀번호 전송 전에** 실패(서버가 password 를 한 번도 받지 않음) · 오류는 인증 실패가 아니다
 *      (isSshAuthError·isAuthFailureText·스토리지 실패 스냅샷 판정 모두 거짓) · 승인 뒤에는 통과하고 비밀번호가 간다
 *   ③ 같은 주소에 다른 키(서버 교체·가로채기) → 거부 + 감사 로그 · 포트가 다르면 승인을 승계하지 않는다
 *   ④ 이름 대소문자·끝 점·IPv6 표기 정규화(검증 함수 자체로 — 이 컨테이너는 IPv6 루프백이 없다)
 *   ⑤ 실제 수집기 경로(SAN 스위치 주기 수집): 호스트키 거부는 **인증 정지가 아니다** — 다음 주기에도 다시 시도하고,
 *      키를 승인하면 붙는다. 스냅샷 오류가 호스트키를 말한다.
 *   ⑥ 웹 SSH(WS 게이트웨이) 경로: 같은 관문 — 거부면 비밀번호를 보내지 않고 화면에 지문·승인 안내, 승인 뒤 셸이 열린다.
 * 호스트 키는 Node crypto EC SEC1 PEM(ssh2 의 ed25519 생성기는 0.52% 확률로 깨진 키를 만든다 — CLAUDE.md v2.590).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import ssh2 from 'ssh2';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rvh-hostkey-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'true';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
delete process.env.SSH_HOSTKEY_POLICY;
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

const closers = [];
after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

const newKey = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' });
/** OpenSSH 표기 지문(서버 공개키 blob 의 sha256 base64, 패딩 없음) — ssh-keygen -lf 와 같은 계산. */
const fpOf = (pem) => `SHA256:${crypto.createHash('sha256').update(ssh2.utils.parseKey(pem).getPublicSSH()).digest('base64').replace(/=+$/, '')}`;

/** 실제 SSH 서버 — 비밀번호 'pw' 만 받는다. auths 에 받은 인증 시도를 남긴다(비밀번호가 도달했는지 본다). */
async function sshServer({ hostKey = newKey(), port = 0 } = {}) {
  const auths = [];
  const inputs = [];
  const srv = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      auths.push({ method: ctx.method, user: ctx.username, password: ctx.password });
      if (ctx.method === 'password' && ctx.password === 'pw') ctx.accept(); else ctx.reject(['password']);
    });
    client.on('ready', () => client.on('session', (accept) => {
      const s = accept();
      s.on('pty', (a) => a && a());
      s.on('window-change', (a) => a && a());
      s.on('exec', (a, _r, info) => { const st = a(); st.write(info.command === 'hostname' ? 'labhost\n' : `out:${info.command}\n`); st.exit(0); st.end(); });
      s.on('shell', (a) => { const st = a(); st.write('welcome\r\n'); st.on('data', (d) => inputs.push(String(d))); });
    }));
    client.on('error', () => {});
  });
  const p = await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(port, '127.0.0.1', () => resolve(srv.address().port)); });
  const close = () => new Promise((r) => srv.close(() => r()));
  closers.push(close);
  return { port: p, hostKey, fp: fpOf(hostKey), auths, inputs, passwords: () => auths.filter((x) => x.method === 'password').length, close };
}

const pt = await import('../src/security/peerTrust.js');
const sx = await import('../src/proxy/sshExec.js');
const { isAuthFailureText } = await import('../src/util/authGuard.js');
const { sshFailureSnapshot } = await import('../src/storage/collectors/cliSsh.js');
const { isAuthFailure } = await import('../src/storage/authGuard.js');
const { describeError } = await import('../src/util/errors.js');

const run = (port, host = '127.0.0.1') => sx.withSsh({ host, port, username: 'u', password: 'pw' }, async (api) => ({ r: await api.exec('id') }));
const auditLines = () => { try { return fs.readFileSync(path.join(DIR, 'audit.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

test('① 지문 표기 = OpenSSH(ssh-keygen -lf) · 키 종류', () => {
  const pem = newKey();
  const blob = ssh2.utils.parseKey(pem).getPublicSSH();
  assert.equal(sx.sshHostKeyFingerprint(blob), fpOf(pem));
  assert.match(sx.sshHostKeyFingerprint(blob), /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.equal(sx.sshHostKeyAlgo(blob), 'ecdsa-sha2-nistp256');
  assert.equal(sx.sshHostKeyFingerprint(Buffer.alloc(0)), '');
  assert.equal(sx.sshHostKeyAlgo(Buffer.from([0, 0, 1, 0])), '');
});

test('② 새 설치(enforce): 모르는 키는 비밀번호 전송 전에 실패 · 인증 실패로 분류되지 않는다 · 승인 뒤 통과', async () => {
  assert.equal(pt.getPeerPolicy('ssh').mode, 'enforce', '장비 등록부가 없는 새 설치는 enforce');
  const s = await sshServer();
  const err = await run(s.port).then(() => null, (e) => e);
  assert.ok(err, '모르는 키인데 연결됐다(무음 TOFU)');
  assert.equal(err.code, sx.SSH_HOSTKEY_ERROR_CODE);
  assert.equal(err.hostKey.fp, s.fp, '오류가 장비가 내민 지문을 말한다');
  assert.match(err.message, /설정 › 장비 신뢰/);
  assert.match(err.message, new RegExp(s.fp.replace(/[+/]/g, '\\$&')));
  assert.equal(s.passwords(), 0, '비밀번호가 서버에 닿았다 — hostVerifier 는 인증 전에 끊어야 한다');
  assert.equal(s.auths.length, 0, '인증 단계 자체에 도달하면 안 된다');
  // 인증 실패가 아니다 — 계정 잠금 방지 '주기 정지' 판정에 걸리면 키를 승인해도 다시 붙지 않는다.
  assert.equal(sx.isSshAuthError(err), false);
  assert.equal(sx.isSshAuthError({ message: err.message }), false, '문구만 남은 결과 객체(bmstor)도 인증 실패가 아니다');
  assert.equal(isAuthFailureText(err.message), false);
  // 지문(base64)에 우연히 '+401/' 같은 조각이 들어 있어도 SSH 인증 실패로 분류하지 않는다(코드·표지가 먼저다).
  const crafted = sx.sshHostKeyError({ ok: false, reason: 'unknown', mode: 'enforce', fp: 'SHA256:ab+401/' + 'c'.repeat(35), algo: 'ssh-ed25519' });
  assert.equal(sx.isSshHostKeyError(crafted), true);
  assert.equal(sx.isSshAuthError(crafted), false, '지문 속 401 이 인증 실패 판정을 만들면 안 된다');
  assert.equal(sx.isSshAuthError({ message: crafted.message }), false, '문구만 남은 결과 객체(표지로 판정)');
  assert.equal(err.code, 'SSH_HOSTKEY_UNTRUSTED', 'TLS 쪽(ERR_TLS_PEER_UNTRUSTED)과 같이 인증 실패와 다른 코드');
  assert.doesNotMatch(String(describeError(err).hint || ''), /인증 실패/, 'util/errors.js 가 계정·비밀번호 확인을 권하면 안 된다');
  const snap = sshFailureSnapshot({ id: 'u1', name: 'U1', type: 'unity480', host: '127.0.0.1' }, err);
  assert.match(snap.error, /^SSH 수집 실패: SSH 호스트키 확인 거부/);
  assert.equal(isAuthFailure(snap), false, '스토리지 인증 정지 판정에 걸리면 안 된다');
  const e = pt.listPeers({ kind: 'ssh' }).find((x) => x.port === s.port);
  assert.equal(e.state, 'pending'); assert.equal(e.pending.fp, s.fp); assert.equal(e.pending.algo, 'ecdsa-sha2-nistp256');

  assert.equal(pt.approvePeer('ssh', '127.0.0.1', s.port, s.fp, { by: 'test' }).ok, true);
  const ok = await run(s.port);
  assert.equal(ok.ok, true);
  assert.match(ok.r.stdout, /out:id/);
  assert.equal(s.passwords(), 1, '승인 뒤에는 비밀번호가 간다');
});

test('③ 같은 주소에 다른 키 → 거부 + 감사 · 다른 포트는 승인을 승계하지 않는다', async () => {
  const a = await sshServer();
  pt.approvePeer('ssh', '127.0.0.1', a.port, a.fp, { by: 'test' });
  assert.equal((await run(a.port)).ok, true);
  const port = a.port;
  await a.close();
  const b = await sshServer({ port }); // 같은 주소·포트, 다른 키(장비 교체 또는 가로채기)
  const before = auditLines().length;
  const err = await run(port).then(() => null, (e) => e);
  assert.equal(err?.code, sx.SSH_HOSTKEY_ERROR_CODE);
  assert.equal(err.hostKey.reason, 'changed');
  assert.match(err.message, /다릅니다/);
  assert.equal(b.passwords(), 0, '바뀐 키의 서버에 비밀번호가 가면 안 된다');
  const au = auditLines().slice(before).filter((x) => x.action === '장비 키 변경 감지(연결 거부)');
  assert.equal(au.length, 1);
  assert.equal(au[0].target, `ssh 127.0.0.1:${port}`);

  // 같은 키(b)를 다른 포트에서 내밀어도 그 포트의 승인은 없다.
  const c = await sshServer({ hostKey: b.hostKey });
  const err2 = await run(c.port).then(() => null, (e) => e);
  assert.equal(err2?.hostKey?.reason, 'unknown', '포트가 바뀌면 기존 pin 을 승계하지 않는다');
  assert.equal(c.passwords(), 0);
});

test('④ 호스트 정규화 — 검증 함수(수집기·WS 공용)가 이름 대소문자·끝 점·IPv6 표기를 같은 장비로 본다', () => {
  const pem = newKey();
  const blob = ssh2.utils.parseKey(pem).getPublicSSH();
  pt.approvePeer('ssh', 'Array-01.Example.COM.', 22, fpOf(pem), { by: 'test' });
  pt.approvePeer('ssh', '0:0:0:0:0:0:0:1', 22, fpOf(pem), { by: 'test' });
  const seen = [];
  const v1 = sx.makeSshHostVerifier('array-01.example.com', 22, (r) => seen.push(r));
  const v2 = sx.makeSshHostVerifier('[::1]', 22, (r) => seen.push(r));
  const v3 = sx.makeSshHostVerifier('array-01.example.com', 2222, (r) => seen.push(r));
  assert.equal(v1(blob), true);
  assert.equal(v2(blob), true);
  assert.equal(v3(blob), false, '포트가 다르면 다른 장비');
  assert.deepEqual(seen.map((r) => r.reason), ['approved', 'approved', 'unknown']);
  // 저장소 오류는 닫는 쪽 — 판정하지 못하는데 통과시키면 그것이 곧 무음 TOFU 다.
  assert.equal(sx.verifySshHostKey('h', 22, Buffer.alloc(0)).ok, false);
});

test('⑤ 실제 수집기(SAN 스위치 주기 수집): 호스트키 거부는 인증 정지가 아니다 · 승인하면 붙는다', async () => {
  const s = await sshServer();
  fs.writeFileSync(path.join(DIR, 'sanswitch-devices.json'), JSON.stringify({ version: 1, devices: [
    { id: 'sw-hk', name: 'SW-HK', type: 'brocade', host: '127.0.0.1', sshPort: s.port, username: 'sanuser', password: 'pw', collectMethod: 'ssh', agent: '' },
  ] }, null, 2));
  const { _resetForTest: resetReg, getDeviceWithSecret } = await import('../src/sanswitch/registry.js');
  resetReg();
  const { pollSanSwitchOnce, sanAuthGuard } = await import('../src/sanswitch/poller.js');
  const { getSnapshot } = await import('../src/sanswitch/store.js');

  const r1 = await pollSanSwitchOnce();
  assert.equal(r1.failed, 1);
  const snap = getSnapshot('sw-hk');
  assert.match(String(snap?.error || ''), /호스트키 확인 거부/, `스냅샷이 호스트키를 말해야 한다: ${snap?.error}`);
  assert.ok(!snap?.extra?.authStopped, '호스트키 거부를 인증 정지로 기록하면 안 된다');
  assert.equal(sanAuthGuard.authStopFor(getDeviceWithSecret('sw-hk')), null);
  assert.equal(s.passwords(), 0);

  const r2 = await pollSanSwitchOnce();
  assert.equal(r2.authStopped, 0, '다음 주기도 정지가 아니라 다시 시도(실패)');
  assert.equal(r2.failed, 1);

  pt.approvePeer('ssh', '127.0.0.1', s.port, s.fp, { by: 'test' });
  await pollSanSwitchOnce();
  assert.ok(s.passwords() >= 1, '승인하면 다음 주기에 로그인한다');
  assert.doesNotMatch(String(getSnapshot('sw-hk')?.error || ''), /호스트키/);
});

/* ─────────── ⑥ 웹 SSH(WS 게이트웨이) ─────────── */
class FakeWs extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.readyState = 1; this.frames = []; this.closed = null; this.bufferedAmount = 0; }
  send(d, cb) { this.frames.push(String(d)); if (cb) setImmediate(() => cb()); }
  close(code, reason) { if (this.readyState !== 1) return; this.readyState = 3; this.closed = { code, reason }; setImmediate(() => this.emit('close')); }
  terminate() { this.close(1006, ''); }
  input(o) { this.emit('message', Buffer.from(JSON.stringify(o))); }
  statuses() { return this.frames.filter((f) => f.startsWith('{')).map((f) => JSON.parse(f)).filter((o) => o.type === 'status').map((o) => o.text); }
}
const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };

test('⑥ 웹 SSH 게이트웨이: 같은 관문 — 거부면 비밀번호를 보내지 않고 지문·승인 안내, 승인 뒤 셸이 열린다', async () => {
  const gw = await import('../src/proxy/sshGateway.js');
  const { addMapping } = await import('../src/proxy/registry.js');
  const admin = { username: 'admin1', role: 'admin', scope: { vcenters: [], regions: [] } };
  gw._setRemoteDepsForTest({ resolveTokenUser: (t) => (t === 'tok' ? admin : null), verifyToken: () => ({ sub: 'admin1', src: 'local', exp: Math.floor(Date.now() / 1000) + 3600 }) });
  try {
    const s = await sshServer();
    const m = addMapping({ protocol: 'ssh', targetHost: '127.0.0.1', targetPort: s.port, owner: 'admin1' }).mapping;
    const ws = new FakeWs();
    gw._handleConnectionForTest(ws, admin, { token: 'tok' });
    ws.input({ type: 'auth', mappingId: m.id, username: 'root', password: 'pw' });
    assert.ok(await waitFor(() => ws.closed), 'WS 가 닫혀야 한다');
    assert.equal(ws.closed.code, 4403);
    const txt = ws.statuses().join('\n');
    assert.match(txt, /호스트키 확인 거부/);
    assert.ok(txt.includes(s.fp), '화면에 장비가 내민 지문을 보여 준다');
    assert.doesNotMatch(txt, /아이디\/비밀번호를 확인하세요/, '인증 실패 안내를 내면 안 된다');
    assert.equal(s.passwords(), 0);
    assert.equal(gw.activeSshSessionCount(), 0, '세션 수가 새지 않는다');

    pt.approvePeer('ssh', '127.0.0.1', s.port, s.fp, { by: 'test' });
    const ws2 = new FakeWs();
    gw._handleConnectionForTest(ws2, admin, { token: 'tok' });
    ws2.input({ type: 'auth', mappingId: m.id, username: 'root', password: 'pw' });
    assert.ok(await waitFor(() => ws2.frames.some((f) => f.includes('welcome'))), `셸 출력이 와야 한다: ${ws2.statuses().join(' | ')}`);
    assert.equal(s.passwords(), 1);
    ws2.close(1000, 'bye');
    assert.ok(await waitFor(() => gw.activeSshSessionCount() === 0));
  } finally { gw._setRemoteDepsForTest(null); }
});

test('⑦ 통신 점검(linkcheck) SSH 협상: 거부하지 않고 관찰만 — 인증 시도 0 · 저장소를 바꾸지 않는다 · 승인/변경을 보고한다', async () => {
  const { stepSsh } = await import('../src/linkcheck/protocols.js');
  const s = await sshServer();
  const before = JSON.stringify(pt.listPeers({ kind: 'ssh' }));
  const r1 = await stepSsh('127.0.0.1', s.port, { timeoutMs: 8_000, host: 'Probe-Host.' });
  assert.equal(r1.ok, true, '점검은 enforce 에서도 협상까지 간다(키를 보려고 접속한다)');
  assert.equal(r1.hostKey?.fp, s.fp, '장비가 내민 지문을 보고한다');
  assert.equal(r1.hostKey.trust, 'unknown');
  assert.match(r1.note, /인증은 시도하지 않았습니다/);
  assert.equal(s.auths.length, 0, '점검이 인증(비밀번호)을 시도하면 안 된다');
  assert.equal(JSON.stringify(pt.listPeers({ kind: 'ssh' })), before, '점검이 신뢰 저장소에 쓰면 안 된다(대기 지문을 만들지 않는다)');
  // 등록 이름(host)으로 승인된 키면 '승인' — IP 로 접속해도 이름으로 찾는다.
  pt.approvePeer('ssh', 'probe-host', s.port, s.fp, { by: 'test' });
  const r2 = await stepSsh('127.0.0.1', s.port, { timeoutMs: 8_000, host: 'Probe-Host.' });
  assert.equal(r2.hostKey.trust, 'approved');
  // 승인된 키와 다르면 '변경' 을 경고한다(수집 연결은 거부될 것이라는 사실).
  pt.approvePeer('ssh', 'probe-host', s.port, 'SHA256:' + 'Q'.repeat(43), { by: 'test' });
  const r3 = await stepSsh('127.0.0.1', s.port, { timeoutMs: 8_000, host: 'probe-host' });
  assert.equal(r3.hostKey.trust, 'changed');
  assert.match(r3.note, /수집 연결은 거부됩니다/);
  assert.equal(s.auths.length, 0);
});
