/**
 * 137회차 새 코드 점검(서버 접속 · 계층 지정 · 공통 계정 정지) 회귀 — 실제 키 저장소 + secretVault · 실제 등록부 · 실제 상태 파일 · 실제 ssh2 가짜 sshd(시도를 센다).
 *  ① 해석이 ‘자격 없음’(승인만 하고 지정 없음 · 비밀번호 고정인데 계정 비밀번호 없음)이면 폴러용 해석이 authError — 빈 비밀번호로 로그인하지 않는다.
 *  ② 한 번 성공한 비밀번호 판도 거부를 보면 그 자리에서 계정을 멈춘다(같은 주기의 나머지 서버로 틀린 비밀번호를 보내지 않는다).
 *  ③ ‘한 대로 다시 확인’ 이 키로 로그인했으면 비밀번호 거부로 걸린 계정 정지를 풀지 않는다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'nc137-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.SSH_HOSTKEY_POLICY = 'observe';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const VAULT = await import('../src/security/secretVault.js');
VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
const ssh2 = (await import('ssh2')).default;
const KS = await import('../src/bmusage/onboard/keyStore.js');
const REFS = await import('../src/bmusage/onboard/refs.js');
const BM = await import('../src/bmstor/registry.js');
const ST = await import('../src/sshaccess/state.js');
const G = await import('../src/sshaccess/accountGate.js');
const RS = await import('../src/sshaccess/readServer.js');
const SVC = await import('../src/sshaccess/service.js');
const { collectServer } = await import('../src/bmstor/collect.js');
const { store } = await import('../src/store.js');
store.snapshot = { ...store.get(), vcenters: [{ id: 'vcA', name: 'KR-SEL' }] };

const rsa = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
const USER_KEY = rsa();
/** 가짜 sshd — USER_KEY 공개키와 st.password 를 받는다. 모든 인증 시도를 센다. */
async function fakeSshd() {
  const allow = ssh2.utils.parseKey(USER_KEY);
  const st = { password: null, seen: [] };
  const srv = new ssh2.Server({ hostKeys: [rsa()] }, (client) => {
    client.on('authentication', (ctx) => {
      st.seen.push({ method: ctx.method, username: ctx.username, password: ctx.method === 'password' ? ctx.password : undefined });
      if (ctx.method === 'publickey' && Buffer.compare(ctx.key.data, allow.getPublicSSH()) === 0) {
        if (!ctx.signature) return ctx.accept();
        return allow.verify(ctx.blob, ctx.signature, ctx.hashAlgo) ? ctx.accept() : ctx.reject();
      }
      if (ctx.method === 'password' && st.password && ctx.password === st.password) return ctx.accept();
      return ctx.reject(['publickey', 'password']);
    });
    client.on('ready', () => client.on('session', (accept) => {
      const s = accept();
      s.on('exec', (acc) => { const stream = acc(); stream.write('ok\n'); stream.exit(0); stream.end(); });
    }));
    client.on('error', () => {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, st, close: () => srv.close() };
}
const SSHD = await fakeSshd();
test.after(() => SSHD.close());

const KEY = KS.addKey({ name: 'kr-key', privateKey: USER_KEY, folderCorp: 'vcA' });
const srv = (body) => { const r = BM.saveBmServer({ host: '127.0.0.1', port: SSHD.port, mounts: ['/'], ...body }); assert.equal(r.ok, true, r.reason); return BM.listBmServersRaw().find((x) => x.id === r.server.id); };
const byId = (id) => BM.listBmServersRaw().find((x) => x.id === id);


test('② 성공했던 비밀번호 판도 거부를 보면 그 자리에서 정지 — 같은 주기의 나머지 서버로 틀린 비밀번호를 보내지 않는다', async () => {
  G._resetAccountGateForTest();
  const id = 'a_0123456789ab';
  const s0 = { credAccountId: id, credVersion: '1700000000000', credAccountName: 'kr-ad', name: 's0' };
  const opts = { feature: 'bm-usage', rejected: (r) => r?.authFailed === true, stopped: (code) => ({ ok: false, gated: code }) };
  assert.equal((await G.gateAccountLogin(s0, async () => ({ ok: true }), opts)).ok, true, '앞 주기 — 성공');
  // AD 에서 비밀번호가 바뀌었다(포탈 판은 그대로) — 서버 6대를 차례로
  let sent = 0;
  const out = [];
  for (let i = 1; i <= 6; i += 1) out.push(await G.gateAccountLogin({ ...s0, name: `s${i}` }, async () => { sent += 1; return { ok: false, authFailed: true }; }, opts));
  assert.equal(sent, 1, '틀린 비밀번호는 한 번만');
  assert.equal(out.filter((x) => x.gated === 'account-stopped').length, 5);
  const stop = ST.accountStopFor(id, '1700000000000');
  assert.ok(stop && stop.server === 's1', '거부를 본 서버로 정지 기록');
  // 거부가 아닌 실패(연결 실패)로는 멈추지 않는다
  ST.clearAccountStop(id);
  G._resetAccountGateForTest();
  await G.gateAccountLogin(s0, async () => ({ ok: true }), opts);
  await G.gateAccountLogin(s0, async () => ({ ok: false, authFailed: false }), opts);
  assert.equal(ST.accountStopFor(id, '1700000000000'), null);
  ST.clearAccountStop(id);
});

