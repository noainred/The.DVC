/**
 * 141회차(137회차 반증 — 서버 접속 · 계층 지정 · 공통 계정) 회귀 — 실제 키 저장소 + secretVault · 실제 등록부 · 실제 상태 파일 · 실제 ssh2 가짜 sshd(시도를 센다).
 *  ① 승인이 효력을 잃은 서버(승인 뒤 OS · 법인 · 주소가 바뀜 — 화면 ‘승인 대기(…바뀜)’)는 root + 빈 비밀번호로 붙지 않는다(137 A1 이 놓친 갈래 · inherit-stale).
 *  ② 잠든 승인은 OTP 없는 되돌리기(bm-storage 서버 저장 · OS 쓰기 · 엣지 지정 떼기)로 되살지 않는다 — 잠든 동안 확인 없이 저장된 지정의 비밀번호가 가지 않는다.
 *  ③ 공통 계정 새 비밀번호의 저장 전 확인은 **계정 법인**의 사용 중지(긴급 조치)도 본다(접속 때 판정과 같게).
 *  ④ 서버 정보 읽기의 ‘계정 없음’ 문구 — 승인은 있는데 물려받을 지정이 없는 서버에 ‘승인 모두 없음’ 이라 말하지 않는다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'rb141-'));
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
const RS = await import('../src/sshaccess/readServer.js');
const SVC = await import('../src/sshaccess/service.js');
const { collectServer } = await import('../src/bmstor/collect.js');
const { store } = await import('../src/store.js');
store.snapshot = { ...store.get(), vcenters: [{ id: 'vcA', name: 'KR-SEL' }, { id: 'vcB', name: 'US-EAST' }, { id: 'vcD', name: 'PL-WAW' }] };

const rsa = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
/** 가짜 sshd — st.password 만 받는다. 모든 인증 시도를 센다. */
async function fakeSshd() {
  const st = { password: null, seen: [] };
  const srv = new ssh2.Server({ hostKeys: [rsa()] }, (client) => {
    client.on('authentication', (ctx) => {
      st.seen.push({ method: ctx.method, username: ctx.username, password: ctx.method === 'password' ? ctx.password : undefined });
      if (ctx.method === 'password' && st.password && ctx.password === st.password) return ctx.accept();
      return ctx.reject(['password']);
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

const srv = (body) => { const r = BM.saveBmServer({ host: '127.0.0.1', port: SSHD.port, mounts: ['/'], ...body }); assert.equal(r.ok, true, r.reason); return BM.listBmServersRaw().find((x) => x.id === r.server.id); };
const byId = (id) => BM.listBmServersRaw().find((x) => x.id === id);
/** 관리자(소유자 아님 · OTP 없음)의 bm-storage 서버 저장과 같은 본문 — 묶음이 아니다(bindOfWrite). */
const save = (s, patch) => { const r = BM.saveBmServer({ id: s.id, name: s.name, host: s.host, port: s.port, mounts: ['/'], ...patch }); assert.equal(r.ok, true, r.reason); return byId(s.id); };
const resolved = (s) => REFS.withResolvedAuth([byId(s.id)], { feature: 'bm-storage' })[0];

test('① 승인이 효력을 잃은 서버(승인 뒤 OS · 법인 · 주소가 바뀜)는 root + 빈 비밀번호로 붙지 않는다 — 엣지 위임 서버 · 예전 항목은 그대로', async () => {
  const acc = KS.saveAccount({ name: 'rb1-lin', kind: 'os', corp: 'vcA', os: 'linux', username: 'svc1', password: 'Rb1-pw' }).account;
  assert.equal(ST.setAssign('vcA', 'linux', { account: acc.id, auth: '' }).ok, true);
  const s = srv({ name: 'rb1', vcenterId: 'vcA', os: 'linux', addrOnly: true });
  assert.equal(BM.setBmServerInherit(s.id, { on: true }).ok, true);
  assert.equal(resolved(s).password, 'Rb1-pw', '승인되면 물려받는다');
  // OS 를 바꾸면 승인은 효력을 잃는다 — 예전에는 그 뒤 매 주기 root + 빈 비밀번호로 로그인했다(137 A1 은 효력 있는 승인만 막았다)
  save(s, { os: 'windows' });
  assert.equal(BM.inheritActive(byId(s.id)), false);
  const r = resolved(s);
  assert.equal(r.authErrorCode, 'inherit-stale');
  assert.equal(r.password, '');
  const n0 = SSHD.st.seen.length;
  const c = await collectServer(r);
  assert.equal(c.ok, false); assert.match(c.error, /빈 비밀번호로 시도하지 않습니다/);
  assert.equal(SSHD.st.seen.length, n0, '접속 시도 0회');
  const rr = await RS.readServer(s.id, { feature: 'server-info', plan: { windows: { command: 'hostname', timeoutMs: 5_000 }, linux: { command: 'echo ok', timeoutMs: 5_000 } } });
  assert.equal(rr.ok, false); assert.equal(SSHD.st.seen.length, n0, '서버 정보도 붙지 않는다');
  // 법인 · 주소를 바꿔 효력을 잃은 경우도 같다
  const s2 = srv({ name: 'rb1b', vcenterId: 'vcA', os: 'linux', addrOnly: true });
  assert.equal(BM.setBmServerInherit(s2.id, { on: true }).ok, true);
  save(s2, { os: 'linux', vcenterId: 'vcB' });
  assert.equal(resolved(s2).authErrorCode, 'inherit-stale');
  // 엣지 위임 서버(agent)는 그 엣지가 정한다 — 중앙 해석은 예전 그대로(같은 객체)
  const s3 = srv({ name: 'rb1c', vcenterId: 'vcA', os: 'linux', addrOnly: true });
  assert.equal(BM.setBmServerInherit(s3.id, { on: true }).ok, true);
  save(s3, { os: 'linux', vcenterId: 'vcA', agent: 'edge1' });
  const raw3 = byId(s3.id);
  assert.equal(REFS.withResolvedAuth([raw3], { feature: 'bm-storage' })[0], raw3);
  // 예전 항목(승인 없음)은 그대로 — 해석하지 않고 같은 객체
  const legacy = srv({ name: 'rb1-legacy', vcenterId: 'vcA' });
  assert.equal(REFS.withResolvedAuth([legacy], { feature: 'bm-storage' })[0], legacy);
  // 자기 비밀번호가 생기면(따로 정함) 승인은 지워지고 그 비밀번호로
  const own = save(s2, { password: 'Own-1' });
  assert.equal(own.inherit, undefined);
  assert.equal(resolved(s2).password, 'Own-1');
  ST.setAssign('vcA', 'linux', null);
});

test('② 잠든 승인은 OTP 없는 되돌리기로 되살지 않는다 — 잠든 동안 확인 없이 저장된 지정의 비밀번호가 가지 않는다 · 다시 승인하면 산다', async () => {
  const A = KS.saveAccount({ name: 'rb2-a', kind: 'os', corp: 'vcA', os: 'linux', username: 'svc-a', password: 'A-pw' }).account;
  const B = KS.saveAccount({ name: 'rb2-b', kind: 'os', corp: 'vcA', os: 'linux', username: 'svc-b', password: 'B-pw' }).account;
  assert.equal(ST.setAssign('vcA', 'linux', { account: A.id, auth: '' }).ok, true);
  const s = srv({ name: 'rb2', vcenterId: 'vcA', os: 'linux', addrOnly: true });
  assert.equal(BM.setBmServerInherit(s.id, { on: true }).ok, true);
  // (가) OS 를 바꿨다가 — 그동안 소유자가 지정을 B 로(물려받는 서버가 없어 확인 없이 저장된다) — OTP 없는 저장으로 되돌림
  save(s, { os: 'windows' });
  const sa = await SVC.setAssignment({ corp: 'vcA', level: 'linux', accountId: B.id, by: 'own' });
  assert.equal(sa.ok, true, sa.reason); assert.equal(sa.willUse, 0); assert.equal(sa.verified, undefined, '확인 없이 저장됐다');
  save(s, { os: 'linux' });
  assert.equal(BM.inheritActive(byId(s.id)), false, '되돌려도 승인은 살아나지 않는다');
  assert.ok(byId(s.id).inherit, '표지는 남는다(화면 ‘승인 대기(…바뀜)’)');
  const r = resolved(s);
  assert.notEqual(r.password, 'B-pw'); assert.equal(r.authErrorCode, 'inherit-stale');
  const n0 = SSHD.st.seen.length;
  await collectServer(r);
  assert.equal(SSHD.st.seen.length, n0, 'B 의 비밀번호도 빈 비밀번호도 보내지 않는다');
  // (나) 엣지 지정을 붙였다 떼기 · 주소를 바꿨다 되돌리기 · OS 쓰기 함수로 되돌리기 — 모두 같다
  for (const [label, away, back] of [
    ['엣지', { os: 'linux', agent: 'edge1' }, { os: 'linux', agent: '' }],
    ['주소', { os: 'linux', host: '127.0.0.2' }, { os: 'linux', host: '127.0.0.1' }],
    ['법인', { os: 'linux', vcenterId: 'vcB' }, { os: 'linux', vcenterId: 'vcA' }],
  ]) {
    const x = srv({ name: `rb2-${label}`, vcenterId: 'vcA', os: 'linux', addrOnly: true });
    assert.equal(BM.setBmServerInherit(x.id, { on: true }).ok, true);
    save(x, away); save(byId(x.id), back);
    assert.equal(BM.inheritActive(byId(x.id)), false, `${label}: 되돌려도 살아나지 않는다`);
  }
  const y = srv({ name: 'rb2-os', vcenterId: 'vcA', os: 'linux', addrOnly: true });
  assert.equal(BM.setBmServerInherit(y.id, { on: true }).ok, true);
  assert.equal(BM.setBmServerOs(y.id, 'windows').ok, true);
  assert.equal(BM.setBmServerOs(y.id, 'linux').ok, true);
  assert.equal(BM.inheritActive(byId(y.id)), false, 'setBmServerOs 로 되돌려도');
  const z = srv({ name: 'rb2-oss', vcenterId: 'vcA', os: 'linux', addrOnly: true });
  assert.equal(BM.setBmServerInherit(z.id, { on: true }).ok, true);
  assert.equal(BM.setBmServersOs({ [z.id]: 'windows' }).ok, true);
  assert.equal(BM.setBmServersOs({ [z.id]: 'linux' }).ok, true);
  assert.equal(BM.inheritActive(byId(z.id)), false, 'setBmServersOs 로 되돌려도');
  // 이 판 전에 잠든 승인(승인 키는 옛 값 그대로 — 업그레이드 전 파일 · 키 고르기 실패 되돌림이 OS 가 바뀐 뒤 옛 승인을 되돌린 경우)도 되돌리기로 살아나지 않는다
  const u = srv({ name: 'rb2-old', vcenterId: 'vcA', os: 'linux', addrOnly: true });
  assert.equal(BM.setBmServerInherit(u.id, { on: true }).ok, true);
  const wk = BM.setBmServerKeyRef(u.id, 'k_0123456789ab', { expectAddr: `127.0.0.1:${SSHD.port}|root` });
  assert.equal(wk.ok, true, wk.reason);
  assert.equal(BM.setBmServerOs(u.id, 'windows').ok, true);
  assert.equal(BM.restoreBmServerKeyRef(u.id, wk.previous).ok, true);
  assert.equal(byId(u.id).inherit.key, BM.inheritKeyOf({ ...byId(u.id), os: 'linux' }), '옛 승인 키 그대로 잠듦');
  save(byId(u.id), { os: 'linux' });
  assert.equal(BM.inheritActive(byId(u.id)), false, '옛 판에서 잠든 승인도 되돌리기로 살아나지 않는다');
  // OS 쓰기가 디스크에 실패하면 OS 와 함께 승인도 메모리에서 되돌린다(파일과 같게 — 승인은 산 채로)
  const q = srv({ name: 'rb2-wfail', vcenterId: 'vcA', os: 'linux', addrOnly: true });
  assert.equal(BM.setBmServerInherit(q.id, { on: true }).ok, true);
  const F = path.join(DIR, 'bm-storage.json'); const keep = `${F}.rb141`;
  fs.renameSync(F, keep); fs.mkdirSync(F);   // 원자 쓰기의 rename 이 디렉터리에 막힌다(EISDIR)
  try {
    assert.equal(BM.setBmServerOs(q.id, 'windows').ok, false);
    assert.equal(BM.setBmServersOs({ [q.id]: 'windows' }).ok, false);
  } finally { fs.rmdirSync(F); fs.renameSync(keep, F); }
  assert.equal(byId(q.id).os, 'linux');
  assert.equal(BM.inheritActive(byId(q.id)), true, '쓰기 실패 — 승인도 되돌렸다');
  // (다) 효력 있는 승인은 무관한 저장(이름 · 마운트 · 같은 OS)으로 지워지지 않는다 · 키 고르기 실패 되돌림은 승인도 되돌린다(serverAccess324 ⑨)
  const k = srv({ name: 'rb2-keep', vcenterId: 'vcA', os: 'linux', addrOnly: true });
  assert.equal(BM.setBmServerInherit(k.id, { on: true }).ok, true);
  save(k, { name: 'rb2-keep2', os: 'linux' });
  assert.equal(BM.inheritActive(byId(k.id)), true, '효력 있는 승인은 그대로');
  assert.equal(resolved(k).password, 'B-pw');
  const w = BM.setBmServerKeyRef(k.id, 'k_0123456789ab', { expectAddr: `127.0.0.1:${SSHD.port}|root` });
  assert.equal(w.ok, true, w.reason);
  assert.equal(BM.restoreBmServerKeyRef(k.id, w.previous).ok, true);
  assert.equal(BM.inheritActive(byId(k.id)), true, '되돌리면 승인도 되돌아온다');
  // (라) 다시 승인(소유자 + OTP 경로의 등록부 함수)하면 산다
  assert.equal(BM.setBmServerInherit(s.id, { on: true }).ok, true);
  assert.equal(BM.inheritActive(byId(s.id)), true);
  assert.equal(resolved(s).password, 'B-pw');
  ST.setAssign('vcA', 'linux', null);
});

test('③ 공통 계정 새 비밀번호의 저장 전 확인 — 계정 법인이 사용 중지(긴급 조치)면 보내지 않는다(법인 없는 서버의 자기 credRef)', async () => {
  const D = KS.saveAccount({ name: 'rb3-d', kind: 'os', corp: 'vcD', os: 'linux', username: 'svc-d', password: 'D-old' }).account;
  const s = srv({ name: 'rb3', credRef: D.id, bindApproved: true });   // 법인 없는 서버 — 다른 법인 계정 경계(둘 다 있을 때만 거절)
  assert.equal(byId(s.id).credRef, D.id);
  assert.equal(SVC.stopCorp('vcD', { by: 'own', reason: 'test' }).ok, true);
  assert.equal(REFS.resolveOsAuth(byId(s.id), { feature: 'bm-usage' }).code, 'account-corp-stopped', '접속 때 판정은 계정 법인을 본다');
  SSHD.st.password = 'D-new';
  const n0 = SSHD.st.seen.length;
  const r = await SVC.saveAccountChecked({ input: { id: D.id, password: 'D-new' }, verifyServerId: s.id, by: 'own' });
  assert.equal(r.ok, false); assert.equal(r.verified?.kind, 'corp-stopped');
  assert.equal(SSHD.st.seen.length, n0, '새 비밀번호를 보내지 않았다');
  assert.equal(KS.accountById(D.id).password, 'D-old', '저장하지 않았다');
  // 재개하면 예전처럼 확인 뒤 저장
  assert.equal(SVC.resumeCorp('vcD', { by: 'own' }).ok, true);
  const r2 = await SVC.saveAccountChecked({ input: { id: D.id, password: 'D-new' }, verifyServerId: s.id, by: 'own' });
  assert.equal(r2.ok, true, r2.reason); assert.equal(r2.verified?.ok, true);
  assert.ok(SSHD.st.seen.slice(n0).some((x) => x.password === 'D-new'));
  SSHD.st.password = null;
});

test('④ 서버 정보 읽기 — 승인은 있는데 물려받을 지정이 없는 서버에 ‘승인 모두 없음’ 이라 말하지 않는다(code 는 not-configured 그대로)', async () => {
  ST.setAssign('vcA', 'linux', null);   // 앞 시험이 남긴 지정과 무관하게
  const s = srv({ name: 'rb4', vcenterId: 'vcA', os: 'linux', addrOnly: true });
  assert.equal(BM.setBmServerInherit(s.id, { on: true }).ok, true);
  const n0 = SSHD.st.seen.length;
  const rr = await RS.readServer(s.id, { feature: 'server-info', plan: { linux: { command: 'echo ok', timeoutMs: 5_000 } } });
  assert.equal(rr.code, 'not-configured');
  assert.doesNotMatch(rr.reason, /승인 모두 없음/);
  assert.equal(rr.reason, REFS.AUTH_ERROR['no-cred']);
  assert.equal(SSHD.st.seen.length, n0);
  // 승인도 자격도 없는 예전 항목은 예전 문구
  const legacy = srv({ name: 'rb4-legacy', vcenterId: 'vcA', os: 'linux' });
  const rl = await RS.readServer(legacy.id, { feature: 'server-info', plan: { linux: { command: 'echo ok', timeoutMs: 5_000 } } });
  assert.equal(rl.code, 'not-configured'); assert.match(rl.reason, /승인 모두 없음/);
});
