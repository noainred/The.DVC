/**
 * 새 코드 점검 136회차 — WinRM(NTLMv2 · WS-Man) · 서버 정보(v3.25 서버 접속 2 · 3단계) 확정 결함 회귀.
 *  ① winrm/wsman.js parseReceive — `Stream\s+([^>]{0,300})` 의 겹치는 반복(공백 k 개마다 300번 되돌아감): 공백으로 채운 640KB 응답 하나가 0.38초 이벤트 루프를 막았다
 *     (Receive 마다 반복 — 인증서만 통과한 서버가 시한 내내). 같은 크기 정상 응답과의 **비율**로 고정한다(루트 CLAUDE.md — ReDoS 회귀는 비율로).
 *  ② 채널 바인딩을 정할 수 없는 인증서(`cbt` — Ed25519 등)는 인증서를 이미 믿은 경우다 — ‘장비 신뢰에서 승인하세요’ 로 안내하지 않는다(readServer · 지정 저장 확인 둘 다).
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'newcode136-'));
process.env.CONFIG_DIR = TMP;
delete process.env.WINRM_TLS_VERIFY;
process.env.SSRF_ALLOW_LOOPBACK = 'true';   // 가짜 서버가 127.0.0.1 — 운영은 루프백을 막는다(ssrfLookup)
delete process.env.TLS_PEER_POLICY;
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const WS = await import('../src/winrm/wsman.js');

test('① parseReceive — 이름 뒤 공백으로 채운 큰 응답도 같은 크기 정상 응답과 비슷한 시간(겹치는 반복 없음)', () => {
  const N = 640 * 1024;
  const best = (fn) => { let m = Infinity; for (let i = 0; i < 3; i += 1) { const t0 = process.hrtime.bigint(); fn(); m = Math.min(m, Number(process.hrtime.bigint() - t0) / 1e6); } return m; };
  const benign = `<rsp:Stream Name="stdout" CommandId="x">${'QUFB'.repeat(Math.floor((N - 60) / 4))}</rsp:Stream>`;
  const base = Math.max(best(() => WS.parseReceive(benign)), 1);
  const evil = [
    `<rsp:Stream${' '.repeat(N - 12)}`,                                       // 닫는 '>' 없는 공백
    `<Stream${'\t\n'.repeat(Math.floor((N - 8) / 2))}`,                         // 탭 · 줄바꿈
    `<Stream ${' '.repeat(300)}`.repeat(Math.floor(N / 308)),                   // 짧은 조각 여럿
  ];
  for (const x of evil) {
    const ms = best(() => WS.parseReceive(x));
    assert.ok(ms / base < 8, `정상 ${base.toFixed(1)}ms 대비 ${ms.toFixed(1)}ms(×${(ms / base).toFixed(1)}) — 겹치는 반복이 되살아났다`);
  }
  // 모양은 그대로 읽는다(공백 둘 · 줄바꿈 뒤 속성)
  const ok = WS.parseReceive('<rsp:Stream  Name="stdout" CommandId="a">aGk=</rsp:Stream><rsp:Stream\n Name="stderr" CommandId="a">ZQ==</rsp:Stream>');
  assert.equal(Buffer.concat(ok.stdout).toString(), 'hi'); assert.equal(Buffer.concat(ok.stderr).toString(), 'e');
});

test('② 채널 바인딩을 정할 수 없는 인증서(Ed25519) — 코드 tls 지만 ‘승인하세요’ 가 아니라 인증서를 바꾸라고 말한다 · AUTHENTICATE 0', async (t) => {
  // Ed25519 자체서명 인증서(시험 실행 때 만든다 — 개인키를 커밋하지 않는다)
  const key = path.join(TMP, 'ed.key'); const crt = path.join(TMP, 'ed.crt');
  try {
    execFileSync('openssl', ['genpkey', '-algorithm', 'ed25519', '-out', key], { stdio: 'ignore' });
    execFileSync('openssl', ['req', '-x509', '-new', '-key', key, '-out', crt, '-days', '2', '-subj', '/CN=newcode136 TEST-ONLY'], { stdio: 'ignore' });
  } catch { t.skip('openssl 없음'); return; }
  const N = await import('../src/winrm/ntlm.js');
  const VAULT = await import('../src/security/secretVault.js');
  VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
  const KS = await import('../src/bmusage/onboard/keyStore.js');
  const BM = await import('../src/bmstor/registry.js');
  const ST = await import('../src/sshaccess/state.js');
  const RS = await import('../src/sshaccess/readServer.js');
  const SVC = await import('../src/sshaccess/service.js');
  const P = await import('../src/serverinfo/profiles.js');
  const { store } = await import('../src/store.js');
  store.snapshot = { ...store.get(), vcenters: [{ id: 'vcW', name: 'KR-WIN' }] };
  // 인증서 판정은 통과시킨다(검증 예외 — 이 시험의 주제는 판정 뒤 채널 바인딩)
  process.env.WINRM_TLS_VERIFY = 'false';
  t.after(() => { delete process.env.WINRM_TLS_VERIFY; });
  const st = { negotiate: 0, authenticate: 0 };
  const srv = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(crt) }, (req, res) => {
    req.resume();
    req.on('end', () => {
      const a = /^Negotiate (\S+)$/.exec(req.headers.authorization || '');
      const m = a ? Buffer.from(a[1], 'base64') : null;
      if (m && m.readUInt32LE(8) === 1) {
        st.negotiate += 1;
        const ti = N.avPairsBuffer([{ id: N.AV.NB_DOMAIN, value: Buffer.from('CORP', 'utf16le') }, { id: N.AV.TIMESTAMP, value: N.fileTime() }, { id: N.AV.EOL, value: Buffer.alloc(0) }]);
        const b = Buffer.alloc(48 + ti.length);
        Buffer.from('NTLMSSP\0', 'latin1').copy(b, 0); b.writeUInt32LE(2, 8); b.writeUInt32LE(48, 16);
        b.writeUInt32LE((N.NEGOTIATE_FLAGS | N.FLAGS.TARGET_INFO) >>> 0, 20);
        b.writeUInt16LE(ti.length, 40); b.writeUInt16LE(ti.length, 42); b.writeUInt32LE(48, 44); ti.copy(b, 48);
        res.writeHead(401, { 'www-authenticate': `Negotiate ${b.toString('base64')}` }); return res.end();
      }
      if (m) st.authenticate += 1;
      res.writeHead(401, { 'www-authenticate': 'Negotiate' }); return res.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }));
  const port = srv.address().port;
  const a = KS.saveAccount({ name: 'kr-ad136', kind: 'os', corp: 'vcW', os: 'windows', logon: 'ad', domain: 'CORP', username: 'svc', password: 'Ad-Right-136' }, { by: 't' });
  assert.equal(a.ok, true, a.reason);
  const s0 = BM.saveBmServer({ name: 'file136', host: '127.0.0.1', port: 22, vcenterId: 'vcW', os: 'windows', addrOnly: true, mounts: ['/'] });
  assert.equal(s0.ok, true, s0.reason);
  const s = BM.listBmServersRaw().find((x) => x.id === s0.server.id);
  assert.equal(BM.setBmServerInherit(s.id, { on: true, expectAddr: '127.0.0.1:22|root', expectKey: BM.inheritKeyOf(s), by: 't' }).ok, true);
  // 지정 저장 전 확인(loginOnce) — 저장하지 않고, 사유는 인증서 교체(승인 안내가 아니다)
  const sa = await SVC.setAssignment({ corp: 'vcW', level: 'windows', accountId: a.account.id, via: 'winrm', port, verifyServerId: s.id, by: 't' });
  assert.equal(sa.ok, false); assert.equal(sa.code, 'verify-failed');
  assert.ok(sa.reason.includes(RS.WINRM_CBT_REASON), sa.reason);
  assert.equal(st.authenticate, 0, '비밀번호에서 만든 값은 보내지 않았다');
  // 서버 정보 읽기(readServer) — 같은 사유
  assert.equal(ST.setAssign('vcW', 'windows', { account: a.account.id, auth: '', via: 'winrm', port }, { by: 't' }).ok, true);
  const r = await RS.readServer(s.id, { feature: 'server-info', plan: P.SERVER_INFO_PLAN });
  assert.equal(r.code, 'tls'); assert.equal(r.via, 'winrm');
  assert.equal(r.reason, RS.WINRM_CBT_REASON);
  assert.ok(!/승인하세요/.test(r.reason));
  assert.ok(st.negotiate >= 2); assert.equal(st.authenticate, 0);
});
