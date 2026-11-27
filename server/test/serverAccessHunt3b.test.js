/**
 * 점검 3회차 보안 R3S-1 회귀 — 계정 단위 정지를 사람이 푼 뒤(‘한 대로 다시 확인’ — 같은 비밀번호) 탐침이었던 서버도 다음 주기에 수집된다
 * (공통 계정 비밀번호 서버는 계정 단위 정지 하나가 판정 — 서버별 인증 정지(bmstor-auth-stops)가 남아 그 서버만 빠지던 것 · 재현 판은 scratchpad).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const SRC = new URL('../src', import.meta.url).pathname;
const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'r3sec-a-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.SSH_HOSTKEY_POLICY = 'observe';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const VAULT = await import(`${SRC}/security/secretVault.js`);
VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
const KS = await import(`${SRC}/bmusage/onboard/keyStore.js`);
const BM = await import(`${SRC}/bmstor/registry.js`);
const ST = await import(`${SRC}/sshaccess/state.js`);
const SVC = await import(`${SRC}/sshaccess/service.js`);
const BP = await import(`${SRC}/bmstor/poller.js`);
const { store } = await import(`${SRC}/store.js`);
store.snapshot = { ...store.get(), vcenters: [{ id: 'vcX', name: 'X' }] };
const ssh2 = (await import('ssh2')).default;

async function fakeSshd() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const st = { passwords: {}, seen: [], locked: false };
  const srv = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method !== 'password') return ctx.reject(['password']);
      st.seen.push({ username: ctx.username, password: ctx.password });
      if (!st.locked && st.passwords[ctx.username] === ctx.password) return ctx.accept();
      return ctx.reject(['password']);
    });
    client.on('ready', () => client.on('session', (accept) => {
      const s = accept();
      s.on('exec', (acc, _rej, info) => {
        const stream = acc();
        if (info.command.startsWith('df')) stream.write('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 500 500 50% /\n');
        else stream.write('ok\n');
        stream.exit(0); stream.end();
      });
    }));
    client.on('error', () => {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, st, close: () => srv.close() };
}
const SSHD = await fakeSshd();
test.after(() => SSHD.close());

const addrOf = (s) => `${String(s.host).toLowerCase()}:${Number(s.port) || 22}|${String(s.username || 'root').toLowerCase()}`;
const byName = (n) => BM.listBmServersRaw().find((x) => x.name === n);

test('R3S-1 계정 정지를 같은 비밀번호로 풀면(AD 잠금 해제 뒤 ‘한 대로 다시 확인’) 탐침이었던 서버도 다음 주기에 수집된다', async () => {
  const r0 = KS.saveAccount({ kind: 'os', os: 'linux', name: 'acc-a', corp: 'vcX', username: 'svc', password: 'PW-OK' }, { by: 't' });
  assert.equal(r0.ok, true, r0.reason);
  const acc = KS.accountById(r0.account.id);
  SSHD.st.passwords.svc = 'PW-OK';
  ST.setAssign('vcX', 'linux', { account: acc.id, auth: '' }, { by: 't' });
  for (const n of ['p1', 'p2', 'p3']) {
    // 같은 sshd 를 서버 이름만 다르게(주소가 같으면 중복 거절 — 계정 칸만 바꿔 셋을 등록)
    const w = BM.saveBmServer({ host: '127.0.0.1', port: SSHD.port, username: `u-${n}`, name: n, vcenterId: 'vcX', os: 'linux', mounts: ['/'], addrOnly: true });
    assert.equal(w.ok, true, w.reason);
    const s = byName(n);
    const a = BM.setBmServerInherit(s.id, { on: true, expectAddr: addrOf(s), expectKey: BM.inheritKeyOf(s), by: 't' });
    assert.equal(a.ok, true, a.reason);
  }
  // ① AD 계정이 잠김(맞는 비밀번호도 거부) — 주기 수집 한 번: 탐침 하나 거부 → 계정 단위 정지
  SSHD.st.locked = true;
  const c1 = await BP.bmCollectNow('auto');
  assert.equal(c1.ok, true);
  const tries1 = SSHD.st.seen.length;
  assert.equal(tries1, 1, '탐침 하나만 보냈다');
  const stop = ST.accountStopFor(acc.id);
  assert.ok(stop, '계정 단위 정지');
  const probeName = stop.server;
  const probe = byName(probeName);
  assert.ok(BP.bmstorAuthStopFor({ ...probe, username: 'svc', password: 'PW-OK' }), '탐침 서버의 bm-storage 서버별 인증 정지도 걸렸다');
  // ② AD 잠금 해제 → 사람이 그 서버(정지 사유에 적힌 서버)로 ‘한 대로 다시 확인’
  SSHD.st.locked = false;
  const v = await SVC.verifyAccount({ accountId: acc.id, serverId: probe.id, by: 't' });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(ST.accountStopFor(acc.id), null, '계정 단위 정지는 풀렸다');
  // ③ 다음 주기 — 탐침 서버는 여전히 ‘인증 실패로 주기 수집 정지’ 로 빠지는가
  const before = SSHD.st.seen.filter((x) => x.username === 'svc').length;
  const c2 = await BP.bmCollectNow('auto');
  const after = SSHD.st.seen.filter((x) => x.username === 'svc').length;
  const latest = BP.getBmLatest();
  const rowProbe = latest.get(probe.id);
  const others = BM.listBmServersRaw().filter((s) => s.id !== probe.id).map((s) => latest.get(s.id));
  void (JSON.stringify({ c2: { okCount: c2.okCount, errors: c2.errors, authStopped: c2.authStopped }, logins: after - before,
    probe: { ok: rowProbe?.ok, error: rowProbe?.error?.slice(0, 90), authStopped: !!rowProbe?.authStopped }, others: others.map((x) => x?.ok) }));
  assert.equal(others.every((x) => x?.ok === true), true, '다른 서버는 수집됐다');
  assert.equal(rowProbe?.ok, true, `탐침이었던 서버도 수집된다(예전: ‘비밀번호를 고치면 재개’ 로 계속 빠졌다) — ${rowProbe?.error || ''}`);
  assert.equal(c2.authStopped || 0, 0);
});
