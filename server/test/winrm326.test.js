/**
 * v3.25 서버 접속 3단계(2단계와 한 릴리스) — WinRM HTTPS(5986) + NTLMv2(설계 docs/design/server-access ④ · D2).
 * ⚠ 실제 Windows 서버로는 확인하지 못했다 — 이 시험은 MS-NLMP 예시 값(4.2.4)과, 같은 규격으로 **서버 쪽 검증을 직접 구현한** 가짜 WinRM 서버로 한다
 *   (NTProofStr · MIC · 채널 바인딩을 서버가 다시 계산해 대조한다 — 클라이언트 계산이 틀리면 거부된다).
 * 고정: 인증서 판정 전에는 아무 바이트도 보내지 않음 · 연결 하나 · 거부면 다시 시도하지 않음 · 출력 상한 · 시한 · 응답 읽기의 선형 시간.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'winrm326-'));
process.env.CONFIG_DIR = TMP;
delete process.env.WINRM_TLS_VERIFY;
process.env.SSRF_ALLOW_LOOPBACK = 'true';   // 가짜 서버가 127.0.0.1 — 운영은 루프백을 막는다(ssrfLookup)
delete process.env.TLS_PEER_POLICY;
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(HERE, 'fixtures', 'rvI-tls');
const pem = (n) => fs.readFileSync(path.join(FX, n));

const VAULT = await import('../src/security/secretVault.js');
VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
const N = await import('../src/winrm/ntlm.js');
const KS = await import('../src/bmusage/onboard/keyStore.js');
const BM = await import('../src/bmstor/registry.js');
const ST = await import('../src/sshaccess/state.js');
const RS = await import('../src/sshaccess/readServer.js');
const SVC = await import('../src/sshaccess/service.js');
const P = await import('../src/serverinfo/profiles.js');
const { store } = await import('../src/store.js');
store.snapshot = { ...store.get(), vcenters: [{ id: 'vcW', name: 'KR-WIN' }] };
const WS = await import('../src/winrm/wsman.js');
const T = await import('../src/security/tlsTrust.js');
const C = await import('../src/winrm/client.js');
fs.writeFileSync(path.join(TMP, 'tls-ca-bundle.pem'), pem('ca.crt'));
T.loadCaBundle({ force: true });

/* ── 가짜 WinRM 서버(서버 쪽 NTLMv2 검증 · 연결 단위 인증) ── */
const SIG = Buffer.from('NTLMSSP\0', 'latin1');
function challengeMsg(serverChallenge, { withTs = true } = {}) {
  const pairs = [{ id: N.AV.NB_DOMAIN, value: Buffer.from('CORP', 'utf16le') }, { id: N.AV.NB_COMPUTER, value: Buffer.from('FILE01', 'utf16le') }];
  if (withTs) pairs.push({ id: N.AV.TIMESTAMP, value: N.fileTime(Date.now()) });
  pairs.push({ id: N.AV.EOL, value: Buffer.alloc(0) });
  const ti = N.avPairsBuffer(pairs);
  const name = Buffer.from('CORP', 'utf16le');
  const head = 56;
  const b = Buffer.alloc(head + name.length + ti.length);
  SIG.copy(b, 0); b.writeUInt32LE(2, 8);
  b.writeUInt16LE(name.length, 12); b.writeUInt16LE(name.length, 14); b.writeUInt32LE(head, 16);
  b.writeUInt32LE((N.NEGOTIATE_FLAGS | N.FLAGS.TARGET_INFO) >>> 0, 20);
  serverChallenge.copy(b, 24);
  b.writeUInt16LE(ti.length, 40); b.writeUInt16LE(ti.length, 42); b.writeUInt32LE(head + name.length, 44);
  name.copy(b, head); ti.copy(b, head + name.length);
  return b;
}
const fieldOf = (m, at) => m.subarray(m.readUInt32LE(at + 4), m.readUInt32LE(at + 4) + m.readUInt16LE(at));
/** 서버 쪽 검증 — NTProofStr(비밀번호를 아는 서버가 다시 계산) · MIC · 채널 바인딩(서버 인증서). */
function verifyAuth({ neg, chal, auth, accounts, certDer }) {
  if (!auth.subarray(0, 8).equals(SIG) || auth.readUInt32LE(8) !== 3) return 'not-type3';
  const nt = fieldOf(auth, 20); const dom = fieldOf(auth, 28).toString('utf16le'); const user = fieldOf(auth, 36).toString('utf16le');
  const pw = accounts[`${dom.toLowerCase()}\\${user.toLowerCase()}`] ?? accounts[user.toLowerCase()];
  if (pw == null) return 'no-user';
  const ntHash = N.ntowfv2(user, dom, pw);
  const proof = nt.subarray(0, 16); const blob = nt.subarray(16);
  const expect = crypto.createHmac('md5', ntHash).update(Buffer.concat([chal.subarray(24, 32), blob])).digest();
  if (!crypto.timingSafeEqual(proof, expect)) return 'bad-proof';
  const ti = N.parseAvPairs(blob.subarray(28, blob.length - 4));
  const cb = ti.find((p) => p.id === N.AV.CHANNEL_BINDINGS);
  if (!cb || !cb.value.equals(N.channelBindingHash(certDer))) return 'bad-cbt';
  const sbk = crypto.createHmac('md5', ntHash).update(proof).digest();
  const zeroed = Buffer.from(auth); zeroed.fill(0, 72, 88);
  const mic = crypto.createHmac('md5', sbk).update(Buffer.concat([neg, chal, zeroed])).digest();
  if (!mic.equals(auth.subarray(72, 88))) return 'bad-mic';
  return 'ok';
}
const b64 = (s) => Buffer.from(s).toString('base64');
async function fakeWinrm({ cert = 'server-ok', accounts = { 'corp\\svc': 'Right-1' }, stdout = 'hello from windows\r\n', exitCode = 0, receiveTimeouts = 0, hugeOutput = 0, dropAfterCreate = false, neverDone = false, rejectAfterAuth = false } = {}) {
  const st = { conns: 0, auths: [], authHeaders: 0, requests: [], receiveTimeouts: 0 };
  const certDer = new crypto.X509Certificate(pem(`${cert}.crt`)).raw;
  const srv = https.createServer({ key: pem(`${cert}.key`), cert: pem(`${cert}.crt`) }, (req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const sock = req.socket;
      const a = /^Negotiate (\S+)$/.exec(req.headers.authorization || '');
      if (a) st.authHeaders += 1;
      st.requests.push({ url: req.url, auth: !!a, action: /<a:Action[^>]{0,80}>([^<]{1,200})</.exec(body)?.[1] || '' });
      if (!sock.ntlmOk) {
        if (!a) { res.writeHead(401, { 'www-authenticate': 'Negotiate' }); return res.end(); }
        const m = Buffer.from(a[1], 'base64');
        if (m.readUInt32LE(8) === 1) {
          sock.neg = m; sock.chal = challengeMsg(crypto.randomBytes(8));
          res.writeHead(401, { 'www-authenticate': `Negotiate ${sock.chal.toString('base64')}` }); return res.end();
        }
        const v = verifyAuth({ neg: sock.neg, chal: sock.chal, auth: m, accounts, certDer });
        st.auths.push(v);
        if (v !== 'ok') { res.writeHead(401, { 'www-authenticate': 'Negotiate' }); return res.end(); }
        sock.ntlmOk = true;
      }
      const action = /<a:Action[^>]{0,80}>([^<]{1,200})</.exec(body)?.[1] || '';
      if (rejectAfterAuth && action === WS.ACTION.command) { res.writeHead(401, { 'www-authenticate': 'Negotiate' }); return res.end(); }   // 같은 연결에서 세션을 잃음(서버 쪽 만료 흉내)
      res.setHeader('content-type', 'application/soap+xml;charset=UTF-8');
      if (action === WS.ACTION.create) { res.setHeader('connection', dropAfterCreate ? 'close' : 'keep-alive'); res.end('<s:Envelope><s:Body><rsp:Shell><rsp:ShellId>11111111-2222-3333-4444-555555555555</rsp:ShellId></rsp:Shell></s:Body></s:Envelope>'); return undefined; }
      if (action === WS.ACTION.command) return res.end('<s:Envelope><s:Body><rsp:CommandResponse><rsp:CommandId>AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE</rsp:CommandId></rsp:CommandResponse></s:Body></s:Envelope>');
      if (action === WS.ACTION.receive) {
        if (st.receiveTimeouts < receiveTimeouts) { st.receiveTimeouts += 1; res.statusCode = 500; return res.end('<s:Envelope><s:Body><s:Fault><s:Code><s:Value>s:Receiver</s:Value></s:Code><s:Reason><s:Text>timed out</s:Text></s:Reason><s:Detail><w:TimedOut/></s:Detail></s:Fault></s:Body></s:Envelope>'); }
        if (neverDone) return res.end('<s:Envelope><s:Body><rsp:ReceiveResponse><rsp:Stream Name="stdout" CommandId="AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE">eA==</rsp:Stream></rsp:ReceiveResponse></s:Body></s:Envelope>');
        const out = hugeOutput ? 'x'.repeat(hugeOutput) : stdout;
        return res.end(`<s:Envelope><s:Body><rsp:ReceiveResponse><rsp:Stream Name="stdout" CommandId="AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE">${b64(out)}</rsp:Stream><rsp:Stream Name="stderr" CommandId="AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"></rsp:Stream><rsp:CommandState CommandId="AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE" State="http://schemas.microsoft.com/wbem/wsman/1/windows/shell/CommandState/Done"><rsp:ExitCode>${exitCode}</rsp:ExitCode></rsp:CommandState></rsp:ReceiveResponse></s:Body></s:Envelope>`);
      }
      return res.end('<s:Envelope><s:Body/></s:Envelope>');
    });
  });
  srv.on('connection', () => { st.conns += 1; });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, st, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
}

test('① NTLM 계산 — RFC 1320 MD4 · MS-NLMP 4.2.4 NTLMv2 예시 값', () => {
  assert.equal(N.md4(Buffer.alloc(0)).toString('hex'), '31d6cfe0d16ae931b73c59d7e0c089c0');
  assert.equal(N.md4(Buffer.from('abc')).toString('hex'), 'a448017aaf21d8525fc10ae87aa6729d');
  assert.equal(N.ntowfv1('Password').toString('hex'), 'a4f49c406510bdcab6824ee7c30fd852');
  assert.equal(N.ntowfv2('User', 'Domain', 'Password').toString('hex'), '0c868a403bfd7a93a3001ef22ef02e3f');
  // 4.2.4.2.2 NTLMv2 응답 — 서버 챌린지 0123456789abcdef · 클라이언트 챌린지 aa×8 · 시각 0 · 대상 정보(예시)
  const ti = Buffer.from('02000c0044006f006d00610069006e0001000c0053006500720076006500720000000000', 'hex');
  const r = N.ntlmv2Response({ ntHash: N.ntowfv2('User', 'Domain', 'Password'), serverChallenge: Buffer.from('0123456789abcdef', 'hex'), clientChallenge: Buffer.alloc(8, 0xaa), timestamp: Buffer.alloc(8), targetInfo: ti });
  assert.equal(r.ntProof.toString('hex'), '68cd0ab851e51c96aabc927bebef6a1c');
  assert.equal(r.sessionBaseKey.toString('hex'), '8de40ccadbc14a82f15cb0ad0de95ca3');
});

test('② 성공 — CA 체인 인증서 · 연결 하나 · AD 계정(도메인 · 계정명 따로) · 출력 · 종료값 · 셸 정리', async (t) => {
  const W = await fakeWinrm();
  t.after(() => W.close());
  const r = await C.winrmRun({ host: '127.0.0.1', port: W.port, username: 'svc', domain: 'CORP', password: 'Right-1', command: 'powershell', args: ['-NoProfile', '-Command', 'hostname'] });
  assert.equal(r.stdout, 'hello from windows\r\n'); assert.equal(r.exitCode, 0);
  assert.deepEqual(W.st.auths, ['ok']);
  assert.equal(W.st.conns, 1, 'NTLM 은 연결 단위 — 연결 하나로 끝까지');
  assert.deepEqual(W.st.requests.map((x) => x.action.split('/').pop()), ['', 'Create', 'Command', 'Receive', 'Signal', 'Delete']);
});

test('③ 거부 — 틀린 비밀번호는 한 번만(다시 시도하지 않음) · kind auth-rejected', async (t) => {
  const W = await fakeWinrm();
  t.after(() => W.close());
  await assert.rejects(C.winrmRun({ host: '127.0.0.1', port: W.port, username: 'svc', domain: 'CORP', password: 'Wrong-9', command: 'hostname' }), (e) => e.kind === 'auth-rejected');
  assert.deepEqual(W.st.auths, ['bad-proof']);
  assert.equal(W.st.requests.filter((x) => x.auth).length, 2, 'NEGOTIATE · AUTHENTICATE 각 한 번 — 재시도 없음');
});

test('③-b 반증(review326) — 연결이 갈리면 로그인 거부가 아니다 · 끝(Done)이 없으면 실패 · 응답 상한 · 접속처 글자 · 채널 바인딩 해시 알고리즘', async (t) => {
  // F1: 인증 뒤 서버가 연결을 끊으면 다음 요청은 새 연결 — 바이트를 보내기 전에 거절(인증 없는 요청이 401 을 받아 ‘거부’ 로 보이지 않게)
  const W = await fakeWinrm({ dropAfterCreate: true });
  t.after(() => W.close());
  await assert.rejects(C.winrmRun({ host: '127.0.0.1', port: W.port, username: 'svc', domain: 'CORP', password: 'Right-1', command: 'hostname' }), (e) => e.kind === 'connection-split');
  assert.deepEqual(W.st.auths, ['ok']); assert.equal(W.st.conns, 1, '두 번째 연결을 열지 않았다');
  // F1 둘째 겹: 같은 연결에서 인증 뒤에 받은 401 은 세션을 잃은 것 — 로그인 거부(계정 정지 대상)가 아니다
  const Wr = await fakeWinrm({ rejectAfterAuth: true });
  t.after(() => Wr.close());
  await assert.rejects(C.winrmRun({ host: '127.0.0.1', port: Wr.port, username: 'svc', domain: 'CORP', password: 'Right-1', command: 'hostname' }), (e) => e.kind === 'session-lost');
  // F6: Done 이 끝내 오지 않으면 성공이 아니다
  const W2 = await fakeWinrm({ neverDone: true });
  t.after(() => W2.close());
  await assert.rejects(C.winrmRun({ host: '127.0.0.1', port: W2.port, username: 'svc', domain: 'CORP', password: 'Right-1', command: 'hostname' }), (e) => e.kind === 'timeout');
  // F5: 응답 하나가 상한(640KB)을 넘으면 읽기를 그만둔다(출력 상한과 별개)
  const W3 = await fakeWinrm({ hugeOutput: 600_000 });
  t.after(() => W3.close());
  await assert.rejects(C.winrmRun({ host: '127.0.0.1', port: W3.port, username: 'svc', domain: 'CORP', password: 'Right-1', command: 'x', maxBytes: 4 * 1024 * 1024 }), (e) => e.kind === 'too-large');
  // F10: 접속처 글자 — '@' · '#' · '/' 로 접속처를 바꾸지 않는다
  for (const h of ['decoy.invalid@127.0.0.1', '127.0.0.1#x', 'a/b']) await assert.rejects(C.winrmRun({ host: h, username: 'svc', password: 'x', command: 'x' }), (e) => e.kind === 'bad-host', h);
  // F2: 채널 바인딩 해시는 인증서 서명 알고리즘을 따른다(RFC 5929 4.1) — 순환 검증이 아니라 crypto 로 따로 계산해 대조
  const FX2 = path.join(HERE, 'fixtures', 'winrm-cbt');
  const der = (f) => new crypto.X509Certificate(fs.readFileSync(f)).raw;
  const rfc = (d, alg) => { const app = Buffer.concat([Buffer.from('tls-server-end-point:', 'latin1'), crypto.createHash(alg).update(d).digest()]); const h = Buffer.alloc(20); h.writeUInt32LE(app.length, 16); return crypto.createHash('md5').update(Buffer.concat([h, app])).digest().toString('hex'); };
  const d384 = der(path.join(FX2, 'p384-sha384.crt')); const d512 = der(path.join(FX2, 'rsa-sha512.crt')); const ded = der(path.join(FX2, 'ed25519.crt')); const d256 = der(path.join(FX, 'server-ok.crt'));
  assert.equal(N.certHashAlg(d384), 'sha384'); assert.equal(N.certHashAlg(d512), 'sha512'); assert.equal(N.certHashAlg(d256), 'sha256'); assert.equal(N.certHashAlg(ded), null);
  assert.equal(N.channelBindingHash(d384).toString('hex'), rfc(d384, 'sha384'));
  assert.equal(N.channelBindingHash(d512).toString('hex'), rfc(d512, 'sha512'));
  assert.notEqual(N.channelBindingHash(d384).toString('hex'), rfc(d384, 'sha256'), '예전(늘 SHA-256)과 다르다');
  assert.throws(() => N.channelBindingHash(ded), /정할 수 없/);
  assert.equal(N.certHashAlg(Buffer.from([0x30, 0x82, 0xff, 0xff])), null, '잘린 DER 은 모름');
});

test('④ 상대 확인 — 승인하지 않은 자체서명 인증서는 TLS 단계에서 끊고 인증 머리를 하나도 보내지 않는다', async (t) => {
  const W = await fakeWinrm({ cert: 'self-a' });
  t.after(() => W.close());
  await assert.rejects(C.winrmRun({ host: '127.0.0.1', port: W.port, username: 'svc', domain: 'CORP', password: 'Right-1', command: 'hostname' }), (e) => e.kind === 'tls-peer');
  assert.equal(W.st.authHeaders, 0, '비밀번호에서 만든 값은 물론 NEGOTIATE 도 가지 않았다');
  assert.equal(W.st.requests.length, 0);
});

test('⑤ 시한 · 출력 상한 · Receive 시한 Fault 는 다시 받기', async (t) => {
  const W = await fakeWinrm({ receiveTimeouts: 2 });
  t.after(() => W.close());
  const r = await C.winrmRun({ host: '127.0.0.1', port: W.port, username: 'svc', domain: 'CORP', password: 'Right-1', command: 'hostname' });
  assert.equal(r.exitCode, 0); assert.equal(W.st.receiveTimeouts, 2);
  const W2 = await fakeWinrm({ hugeOutput: 300_000 });
  t.after(() => W2.close());
  await assert.rejects(C.winrmRun({ host: '127.0.0.1', port: W2.port, username: 'svc', domain: 'CORP', password: 'Right-1', command: 'x', maxBytes: 100_000 }), (e) => e.kind === 'too-large');
  // 시한 — 응답하지 않는 서버(TCP 만 받음)
  const net = await import('node:net');
  const hang = net.createServer(() => {}); await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  t.after(() => hang.close());
  const t0 = Date.now();
  await assert.rejects(C.winrmRun({ host: '127.0.0.1', port: hang.address().port, username: 'svc', domain: 'CORP', password: 'Right-1', command: 'x', timeoutMs: 1500 }));
  assert.ok(Date.now() - t0 < 10_000, '시한 안에 끊었다');
});

test('⑥ 응답 읽기 — 큰 · 이상한 입력에도 선형(정규식 되돌아가기 없음) · ShellId 꼴 검사 · Fault 이유', () => {
  const big = `<rsp:Stream Name="stdout" ${'a'.repeat(250)}>${'A'.repeat(900_000)}`;   // 닫는 태그 없음
  const t0 = process.hrtime.bigint();
  WS.parseReceive(big);
  WS.faultReason(`<s:Fault>${'<s:Text>'.repeat(50_000)}`);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 500, `선형 — ${ms.toFixed(0)}ms`);
  assert.throws(() => WS.parseShellId('<rsp:ShellId>../../etc</rsp:ShellId>'));
  assert.equal(WS.parseShellId('<x:ShellId>11111111-2222-3333-4444-555555555555</x:ShellId>'), '11111111-2222-3333-4444-555555555555');
  assert.match(WS.faultReason('<s:Fault><s:Text>Access is denied.</s:Text><f:WSManFault Code="5"/></s:Fault>'), /Access is denied\. \(WSMan 5\)/);
  // 명령 · 인자는 XML 이스케이프(명령 끼워 넣기 아님 — 값은 호출부 상수지만 이중 방어)
  assert.equal(WS.commandBody('a<b', ['"&']), '<rsp:CommandLine><rsp:Command>a&lt;b</rsp:Command><rsp:Arguments>&quot;&amp;</rsp:Arguments></rsp:CommandLine>');
});

test('⑦ 코어 연결(3단계) — Windows 단계 지정이 WinRM 이면 readServer · 지정 저장 확인이 WinRM HTTPS + NTLM 으로 · 거부 한 번이면 계정 정지 · 키만 있는 계정은 붙지 않음 · 미승인 인증서는 비밀 0', async (t) => {
  const winOut = `##WINJSON\r\n${JSON.stringify({ err: [], os: { caption: 'Microsoft Windows Server 2022 Standard', version: '10.0.20348', build: '20348', memKB: 268435456 }, cs: { maker: '가상', model: 'GX', name: 'file01', domain: 'corp.example' }, bios: { serial: 'S1' }, cpu: [{ Name: 'CPU', NumberOfCores: 16, NumberOfLogicalProcessors: 32 }], disk: [{ Index: 0, Model: 'SSD', Size: 1000 }], pd: [{ DeviceId: '0', MediaType: 4, HealthStatus: 0, BusType: 10 }], vol: [{ DeviceID: 'C:', FileSystem: 'NTFS', Size: 100, FreeSpace: 40 }] })}\r\n`;
  const W = await fakeWinrm({ accounts: { 'corp\\svc': 'Ad-Right-1' }, stdout: winOut });
  t.after(() => W.close());
  const a = KS.saveAccount({ name: 'kr-ad', kind: 'os', corp: 'vcW', os: 'windows', logon: 'ad', domain: 'CORP', username: 'svc', password: 'Ad-Right-1' }, { by: 't' });
  assert.equal(a.ok, true, a.reason); assert.equal(a.account.loginName, 'CORP\\svc');
  const s0 = BM.saveBmServer({ name: 'file01', host: '127.0.0.1', port: 22, vcenterId: 'vcW', os: 'windows', addrOnly: true, mounts: ['/'] });
  assert.equal(s0.ok, true, s0.reason);
  const s = BM.listBmServersRaw().find((x) => x.id === s0.server.id);
  assert.equal(BM.setBmServerInherit(s.id, { on: true, expectAddr: `127.0.0.1:22|root`, expectKey: BM.inheritKeyOf(s), by: 't' }).ok, true);
  // 지정 저장 — WinRM 으로 먼저 확인(SSH 22 번에는 아무도 없다 — WinRM 으로 가지 않으면 실패한다)
  const sa = await SVC.setAssignment({ corp: 'vcW', level: 'windows', accountId: a.account.id, auth: '', via: 'winrm', port: W.port, verifyServerId: s.id, by: 't' });
  assert.equal(sa.ok, true, `${sa.code} ${sa.reason}`); assert.equal(sa.verified.ok, true);
  assert.deepEqual({ via: ST.assignFor('vcW', 'windows').via, port: ST.assignFor('vcW', 'windows').port }, { via: 'winrm', port: W.port });
  // 서버 정보 읽기 — WinRM 으로 · Windows 해석
  const r = await RS.readServer(s.id, { feature: 'server-info', plan: P.SERVER_INFO_PLAN });
  assert.equal(r.ok, true, `${r.reason} ${JSON.stringify(W.st.auths)} ${r.via}`); assert.equal(r.via, 'winrm');
  const p = P.parseFor('windows', r.stdout, r.stderr);
  assert.equal(p.base.cpuCores.value, 16); assert.equal(p.disks[0].media, 'SSD'); assert.equal(p.fs[0].usePct, 60);
  assert.equal(JSON.stringify(r).includes('Ad-Right-1'), false);
  // 거부(도메인 쪽 비밀번호가 바뀜) — 한 번만 보내고 계정 단위 정지 → 다음 읽기는 보내지 않는다
  W.st.auths.length = 0;
  KS.saveAccount({ id: a.account.id, password: 'Ad-Old-0' }, { by: 't' });   // 포탈에 저장된 비밀번호가 틀린 상황
  const rej = await RS.readServer(s.id, { feature: 'server-info', plan: P.SERVER_INFO_PLAN });
  assert.equal(rej.code, 'auth-rejected'); assert.deepEqual(W.st.auths, ['bad-proof']);
  assert.ok(ST.accountStopFor(a.account.id, KS.accountSecretVersion(KS.accountById(a.account.id))));
  const again = await RS.readServer(s.id, { feature: 'server-info', plan: P.SERVER_INFO_PLAN });
  assert.equal(again.code, 'cred'); assert.equal(W.st.auths.length, 1, '정지된 계정은 보내지 않는다');
  // 같은 계정을 WinRM 으로 물려받는 3대를 동시에 — 계정 탐침이 하나만 보낸다(WinRM 경로도 accountGate 를 지난다)
  ST.clearAccountStop(a.account.id, { by: 't' });
  KS.saveAccount({ id: a.account.id, password: 'Ad-Old-1' }, { by: 't' });   // 새 판 — 틀린 비밀번호
  const more = [2, 3].map((i) => { const r0 = BM.saveBmServer({ name: `file0${i}`, host: '127.0.0.1', port: 22, vcenterId: 'vcW', os: 'windows', addrOnly: true, mounts: ['/'] }); const x = BM.listBmServersRaw().find((y) => y.id === r0.server.id); assert.equal(BM.setBmServerInherit(x.id, { on: true, expectAddr: '127.0.0.1:22|root', expectKey: BM.inheritKeyOf(x), by: 't' }).ok, true); return x; });
  W.st.auths.length = 0;
  const all3 = await Promise.all([s, ...more].map((x) => RS.readServer(x.id, { feature: 'server-info', plan: P.SERVER_INFO_PLAN })));
  assert.equal(W.st.auths.length, 1, `탐침 하나 — ${JSON.stringify(all3.map((x) => x.code))}`);
  // Windows 단계 밖에는 접속 방식을 남기지 않는다(상태 파일 모양)
  ST.setAssign('vcW', 'linux', { account: a.account.id, auth: '', via: 'winrm', port: 5986 }, { by: 't' });
  assert.equal(ST.assignFor('vcW', 'linux').via, undefined); ST.setAssign('vcW', 'linux', null, { by: 't' });
  // 비밀번호가 없는 계정(키만)은 WinRM 으로 붙지 않는다(NTLM 은 비밀번호만 — 기본 키로 넘어가지 않는다)
  const REFS = await import('../src/bmusage/onboard/refs.js');
  ST.clearAccountStop(a.account.id, { by: 't' });
  const F = await import('./_sshKeyFixtures.js');
  const k = KS.addKey({ name: 'win-key', privateKey: F.ed25519Key().pem, folderCorp: 'vcW' }, { by: 't' });
  assert.equal(k.ok, true, k.reason);
  const ko = KS.saveAccount({ name: 'kr-keyonly', kind: 'os', corp: 'vcW', os: 'windows', logon: 'local', username: 'kadm', keyRef: k.key.id }, { by: 't' });
  assert.equal(ko.ok, true, ko.reason);
  ST.setAssign('vcW', 'windows', { account: ko.account.id, auth: '', via: 'winrm', port: W.port }, { by: 't' });
  const cur = BM.listBmServersRaw().find((x) => x.id === s.id);
  assert.equal(REFS.resolveOsAuth(cur, { feature: 'server-info', winrm: true }).code, 'winrm-needs-password');
  // 반증 F3: SSH 로 붙는 기능(사용률 · 스토리지 · 연결 시험 …)은 지정에 WinRM 이 있어도 키 우선 그대로 — 비밀번호 고정이 번지지 않는다
  const sshAuth = REFS.resolveOsAuth(cur, { feature: 'server-info' });
  assert.equal(sshAuth.ok, true); assert.equal(sshAuth.authKind, 'key'); assert.equal(sshAuth.via, undefined);
  const n0 = W.st.requests.length;
  assert.equal((await RS.readServer(s.id, { feature: 'server-info', plan: P.SERVER_INFO_PLAN })).credCode, 'winrm-needs-password');
  assert.equal(W.st.requests.length, n0, '키로 WinRM 에 붙지 않는다(요청 0)');
  // 반증 F4: 키 + 비밀번호 계정(로그인 방식 기본 ‘키 먼저’)을 WinRM 으로 확인하면 비밀번호로 해석한다 — 예전에는 키를 골라 늘 실패
  const both = KS.saveAccount({ name: 'kr-both', kind: 'os', corp: 'vcW', os: 'windows', logon: 'ad', domain: 'CORP', username: 'svc', keyRef: k.key.id, password: 'Ad-Right-1' }, { by: 't' });
  assert.equal(both.ok, true, both.reason);
  ST.setAssign('vcW', 'windows', { account: both.account.id, auth: '', via: 'winrm', port: W.port }, { by: 't' });
  const vb = await SVC.verifyAccount({ accountId: both.account.id, serverId: s.id, by: 't' });
  assert.equal(vb.ok, true, vb.reason);
  assert.equal((await RS.readServer(s.id, { feature: 'server-info', plan: P.SERVER_INFO_PLAN })).ok, true, 'WinRM 읽기도 비밀번호로');
  // 미승인 자체서명 인증서 — TLS 단계에서 끊고 인증 머리 0
  const W2 = await fakeWinrm({ cert: 'self-a' });
  t.after(() => W2.close());
  KS.saveAccount({ id: a.account.id, password: 'Ad-Right-1' }, { by: 't' });
  ST.setAssign('vcW', 'windows', { account: a.account.id, auth: '', via: 'winrm', port: W2.port }, { by: 't' });
  const tl = await RS.readServer(s.id, { feature: 'server-info', plan: P.SERVER_INFO_PLAN });
  assert.equal(tl.code, 'tls'); assert.equal(W2.st.authHeaders, 0);
  // 지정 칸 검사 — WinRM 은 Windows 단계만 · 포트 범위
  assert.equal((await SVC.setAssignment({ corp: 'vcW', level: 'linux', accountId: a.account.id, via: 'winrm', by: 't', dryRun: true })).code, 'account-os');
  assert.equal(ST.setAssign('vcW', 'windows', { account: a.account.id, via: 'winrm', port: 70000 }, { by: 't' }).code, 'bad-port');
});
