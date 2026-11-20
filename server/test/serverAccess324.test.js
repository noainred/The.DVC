/**
 * v3.24 서버 접속 공용 모듈 1단계(설계 docs/design/server-access §4.4 · §4.6) — 계층 지정(법인 › OS 종류 › 서버) · Windows 로컬 · AD 공통 계정 ·
 * 비밀번호 특별 관리(암호화 정책에서만 · 허용 기능 · 계정 단위 정지 · 한 대 먼저 확인 · 나이) · 물려받기 승인(주소 · 포트 · OS 에 묶임).
 * 실제 keyStore + secretVault · 실제 등록부 · 실제 상태 파일 · 실제 ssh2 가짜 sshd(비밀번호 로그인 — 시도를 센다) · 실제 api 라우터(설정 소유자 + OTP).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'srvacc319-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.SETTINGS_OWNERS = 'own,own2,sown';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.SSH_HOSTKEY_POLICY = 'observe';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '../src');

const { generateSecret, generateToken } = await import('../src/auth/totp.js');
const SECRETS = { own: generateSecret(), own2: generateSecret() };
fs.writeFileSync(path.join(DIR, 'users.json'), JSON.stringify({ users: [
  { username: 'own', role: 'admin', totpEnabled: true, totpSecret: SECRETS.own },
  { username: 'own2', role: 'admin', totpEnabled: true, totpSecret: SECRETS.own2 },
  { username: 'sown', role: 'admin', scope: { vcenters: ['vcA'] } },
  { username: 'adm', role: 'admin' },
] }));
const VAULT = await import('../src/security/secretVault.js');
const KS = await import('../src/bmusage/onboard/keyStore.js');

/* ⓪ 평문 정책(새 설치 — 정책 파일 없음)에서는 새 공통 비밀번호를 받지 않는다(키와 같은 조건). 시험 본문은 모듈 맨 위가 끝난 뒤 돌므로 여기서 미리 잰다. */
const PLAIN = { mode: VAULT.loadSecretsPolicy().mode, r: KS.saveAccount({ name: 'p-1', kind: 'os', corp: 'vcA', username: 'u', password: 'x' }),
  file: fs.existsSync(path.join(DIR, 'ssh-keys.json')), noSecret: KS.saveAccount({ name: 'p-1', kind: 'os', corp: 'vcA', username: 'u' }).code };
VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });

const ssh2 = (await import('ssh2')).default;
const REFS = await import('../src/bmusage/onboard/refs.js');
const BM = await import('../src/bmstor/registry.js');
const ST = await import('../src/sshaccess/state.js');
const US = await import('../src/sshaccess/usage.js');
const OUT = await import('../src/sshaccess/outcome.js');
const SVC = await import('../src/sshaccess/service.js');
const { store } = await import('../src/store.js');
store.snapshot = { ...store.get(), vcenters: [{ id: 'vcA', name: 'KR-SEL' }, { id: 'vcB', name: 'PL-WAW' }] };

/** 가짜 sshd — 비밀번호 로그인만(st.passwords 의 계정명 → 비밀번호). 모든 인증 시도를 센다(다시 시도하지 않는지 본다). */
async function fakeSshd() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const st = { passwords: {}, seen: [] };
  const srv = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password') st.seen.push({ username: ctx.username, password: ctx.password });
      if (ctx.method === 'password' && st.passwords[ctx.username] && st.passwords[ctx.username] === ctx.password) return ctx.accept();
      return ctx.reject(['password']);
    });
    client.on('ready', () => client.on('session', (accept) => {
      const s = accept();
      s.on('exec', (acc, _rej, info) => { const stream = acc(); stream.write(info.command.startsWith('uname') ? 'Linux\n' : 'ok\n'); stream.exit(0); stream.end(); });
    }));
    client.on('error', () => {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, st, close: () => srv.close() };
}
const SSHD = await fakeSshd();
test.after(() => SSHD.close());
const pwTries = (password) => SSHD.st.seen.filter((x) => x.password === password).length;

async function api(t) {
  const express = (await import('express')).default;
  const { api: router } = await import('../src/routes/api.js');
  const USERS = { own: { username: 'own', role: 'admin', scope: null }, own2: { username: 'own2', role: 'admin', scope: null },
    adm: { username: 'adm', role: 'admin', scope: null }, sown: { username: 'sown', role: 'admin', scope: { vcenters: ['vcA'] } } };
  const app = express(); app.use(express.json({ limit: '4mb' }));
  app.use((req, _r, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', router);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => srv.close());
  return async (u, method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api${p}`, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const txt = await r.text(); let j = {}; try { j = JSON.parse(txt); } catch { /* */ }
    return { s: r.status, j, txt };
  };
}
/** OTP — 사용자마다 counter 를 하나씩 앞으로(1회용 · 같은 창에서 3개까지). */
const _used = {};
function otp(user) {
  const base = Math.floor(Date.now() / 30_000);
  _used[user] = (_used[user] ?? -2) + 1;
  if (_used[user] > 1) throw new Error(`${user} OTP 를 너무 많이 씀 — 시험을 나눌 것`);
  return generateToken(SECRETS[user], { counter: base + _used[user] });
}

const srv = (body) => { const r = BM.saveBmServer({ host: '127.0.0.1', port: SSHD.port, mounts: ['/'], ...body }); assert.equal(r.ok, true, r.reason); return BM.listBmServersRaw().find((x) => x.id === r.server.id); };
const byName = (n) => BM.listBmServersRaw().find((x) => x.name === n);
const addrOf = (s) => (KS, `${String(s.host).toLowerCase()}:${Number(s.port) || 22}|${String(s.username || 'root').toLowerCase()}`);

// ⚠ 시험은 모듈 맨 위의 await 가 다 끝난 뒤에 등록한다 — 먼저 등록한 시험이 혼자 끝나면 러너가 test.after(설정 폴더 지우기)를 먼저 돌린다.
test('⓪ D6 — 새 OS 공통 비밀번호는 암호화 정책에서만(평문 409 passwords-need-encryption) · 비밀이 없으면 여전히 need-secret', () => {
  assert.equal(PLAIN.mode, 'plain');
  assert.equal(PLAIN.r.code, 'passwords-need-encryption'); assert.equal(PLAIN.r.status, 409);
  assert.equal(PLAIN.file, false, '파일을 만들지 않았다');
  assert.equal(PLAIN.noSecret, 'need-secret');
});

/* ── ① 공통 계정 모델 — Windows 로컬 · AD · 로그인 이름 · 승계 금지 · 바꿔치기 대조 ───────────────────── */
test('① 계정 모델 — AD 로그인 이름(UPN · NetBIOS) · 도메인 필수 · @ 금지 · 도메인을 바꾸면 비밀번호를 잇지 않는다 · 응답에 비밀 없음 · 포탈 밖 도메인 변경은 account-tampered', () => {
  const ad = KS.saveAccount({ name: 'kr-ad', kind: 'os', corp: 'vcA', os: 'windows', logon: 'ad', domain: 'corp.example', username: 'svc', password: 'Ad-Right-1', features: ['bm-usage', 'bm-storage'] }, { by: 'own' });
  assert.equal(ad.ok, true, ad.reason);
  assert.equal(ad.account.loginName, 'svc@corp.example');
  assert.equal(ad.account.family, 'windows'); assert.equal(ad.account.pwAgeDays, 0);
  assert.equal(JSON.stringify(ad).includes('Ad-Right-1'), false, '응답에 비밀번호 없음');
  assert.equal(KS.loginNameOf({ kind: 'os', os: 'windows', logon: 'ad', domain: 'corp', username: 'svc' }), 'CORP\\svc');
  assert.equal(KS.saveAccount({ name: 'x1', kind: 'os', os: 'windows', logon: 'ad', username: 'svc', password: 'p' }).code, 'bad-domain');
  assert.equal(KS.saveAccount({ name: 'x2', kind: 'os', os: 'windows', logon: 'local', username: 'a@b', password: 'p' }).code, 'bad-username');
  assert.equal(KS.saveAccount({ name: 'x3', kind: 'os', os: 'macos', username: 'a', password: 'p' }).code, 'bad-os');
  // 도메인만 바꾸면 비밀번호를 잇지 않는다(다른 도메인으로 같은 비밀번호가 가지 않게)
  const tmp = KS.saveAccount({ name: 'mv', kind: 'os', corp: 'vcA', os: 'windows', logon: 'ad', domain: 'a.example', username: 'u', password: 'Mv-1' });
  const mv = KS.saveAccount({ id: tmp.account.id, domain: 'b.example', keyRef: '' });
  assert.equal(mv.code, 'need-secret', '도메인을 바꾸면 저장된 비밀번호를 이어 쓰지 않는다(새로 넣어야 한다)');
  // 포탈 밖에서 도메인만 바꾸면 그 계정으로 접속하지 않는다
  const file = path.join(DIR, 'ssh-keys.json');
  const orig = fs.readFileSync(file, 'utf8');
  const j = JSON.parse(orig); for (const a of j.accounts) if (a.id === ad.account.id) a.domain = 'evil.example';
  fs.writeFileSync(file, JSON.stringify(j));
  assert.ok(KS.diskDrift().accountsChanged.includes(ad.account.id));
  assert.equal(REFS.resolveOsAuth({ id: 'q', name: 'q', host: '10.0.0.9', vcenterId: 'vcA', credRef: ad.account.id }, { feature: 'conn-test' }).code, 'account-tampered');
  fs.writeFileSync(file, orig);
  assert.equal(SVC.reloadKeyStore({ by: 'own' }).ok, true);
  KS._removeAccount(tmp.account.id);
});

/* ── ② 계층 해석 ──────────────────────────────────────────────────────── */
test('② 계층 해석 — 승인 전 물려받지 않음 · OS 단계가 이김 · 법인 단계는 OS 계열이 같을 때만 · 주소 · OS 가 바뀌면 승인이 풀림 · 자기 자격 우선 · 엣지 서버 제외', () => {
  const lin = KS.saveAccount({ name: 'kr-lin', kind: 'os', corp: 'vcA', os: 'linux', username: 'monitor', password: 'Lin-1' }).account;
  const ad = KS.accountByName('os', 'kr-ad');
  assert.equal(ST.setAssign('vcA', 'all', { account: lin.id, auth: '' }, { by: 'own' }).ok, true);
  assert.equal(ST.setAssign('vcA', 'windows', { account: ad.id, auth: 'password' }, { by: 'own' }).ok, true);
  const w1 = srv({ name: 'w1', vcenterId: 'vcA', os: 'windows', username: 'root', addrOnly: true });
  const l1 = srv({ name: 'l1', vcenterId: 'vcA', os: 'linux', addrOnly: true });
  const n1 = srv({ name: 'n1', vcenterId: 'vcA', addrOnly: true });
  // 승인 전 — 지정은 있지만 물려받지 않는다(pending) · 해석은 none · 폴러용 해석은 그대로 둔다
  assert.deepEqual(REFS.effectiveAccountOf(w1), { source: 'none', pending: true, level: 'windows', accountId: ad.id });
  assert.equal(REFS.resolveOsAuth(w1, { feature: 'bm-usage' }).authKind, 'none');
  assert.equal(REFS.withResolvedAuth([w1], { feature: 'bm-usage' })[0], w1);
  // 승인(등록부 — 서비스만 부른다) → OS 단계(windows) · 로그인 이름 · 비밀번호
  for (const s of [w1, l1, n1]) assert.equal(BM.setBmServerInherit(s.id, { on: true, expectAddr: addrOf(s), by: 'own' }).ok, true);
  const rw = REFS.resolveOsAuth(byName('w1'), { feature: 'bm-usage' });
  assert.deepEqual({ ok: rw.ok, u: rw.username, k: rw.authKind, src: rw.source }, { ok: true, u: 'svc@corp.example', k: 'password', src: 'os' });
  assert.equal(REFS.resolveOsAuth(byName('l1'), { feature: 'bm-usage' }).source, 'corp', 'Linux 단계가 비면 법인 단계(Linux 계정)');
  assert.equal(REFS.resolveOsAuth(byName('n1'), { feature: 'bm-usage' }).username, 'monitor', 'OS 미지정 = Linux 로 보고 법인 단계');
  const wr = REFS.withResolvedAuth([byName('w1')], { feature: 'bm-usage' })[0];
  assert.equal(wr.credAccountId, ad.id); assert.equal(wr.credVersion, KS.accountSecretVersion(KS.accountById(ad.id)));
  // 법인 단계가 Windows 계정이면 Linux · 미지정 서버에는 닿지 않는다(mismatch)
  assert.equal(ST.setAssign('vcA', 'all', { account: ad.id }, { by: 'own' }).ok, true);
  assert.equal(REFS.effectiveAccountOf(byName('l1')).mismatch, true);
  assert.equal(REFS.resolveOsAuth(byName('n1'), { feature: 'bm-usage' }).authKind, 'none', 'Windows 비밀번호를 OS 미지정 서버로 보내지 않는다');
  assert.equal(ST.setAssign('vcA', 'all', { account: lin.id }, { by: 'own' }).ok, true);
  // 주소가 바뀌면(승인 칸은 요청이 세울 수 없다 · 다른 쓰기 경로) 승인이 저절로 풀린다
  const l1s = byName('l1');
  const moved = BM.saveBmServer({ id: l1s.id, host: '127.0.0.2', port: SSHD.port, mounts: ['/'], name: 'l1', inherit: { key: '127.0.0.2:x|linux' } });
  assert.equal(moved.ok, true);
  assert.equal(BM.inheritActive(byName('l1')), false);
  assert.equal(REFS.effectiveAccountOf(byName('l1')).pending, true);
  BM.saveBmServer({ id: l1s.id, host: '127.0.0.1', port: SSHD.port, mounts: ['/'], name: 'l1' });
  assert.equal(BM.inheritActive(byName('l1')), true, '같은 주소 · OS 로 돌아오면 그 승인 그대로(승인 칸은 주소 · 포트 · OS 의 값)');
  // OS 를 바꾸면 풀린다(다른 OS 계정이 OTP 없이 가지 않게)
  BM.saveBmServer({ id: byName('w1').id, host: '127.0.0.1', port: SSHD.port, mounts: ['/'], name: 'w1', os: 'linux' });
  assert.equal(BM.inheritActive(byName('w1')), false);
  BM.saveBmServer({ id: byName('w1').id, host: '127.0.0.1', port: SSHD.port, mounts: ['/'], name: 'w1', os: 'windows' });
  assert.equal(BM.inheritActive(byName('w1')), true);
  // 자기 자격(서버 비밀번호)이 있으면 계층을 보지 않는다
  const own1 = srv({ name: 'own1', vcenterId: 'vcA', os: 'linux', password: 'Own-1' });
  BM.setBmServerInherit(own1.id, { on: true, clearOwn: false, expectAddr: addrOf(own1), by: 'own' });
  assert.equal(REFS.resolveOsAuth(byName('own1'), { feature: 'bm-usage' }).password, 'Own-1');
  // 엣지 서버는 물려받지 않는다(승인도 거절)
  const e1 = srv({ name: 'e1', vcenterId: 'vcA', os: 'linux', agent: 'edge-kr', addrOnly: true });
  assert.equal(BM.setBmServerInherit(e1.id, { on: true, expectAddr: addrOf(e1) }).code, 'edge-delegated');
  const forged = { ...e1, inherit: { key: BM.inheritKeyOf(e1) } };
  assert.equal(BM.inheritActive(forged), false); assert.equal(REFS.effectiveAccountOf(forged).source, 'none');
  // OS 를 정한 서버에 다른 OS 계정을 직접 붙이면 account-os
  assert.equal(REFS.resolveOsAuth({ ...byName('l1'), credRef: ad.id }, { feature: 'bm-usage' }).code, 'account-os');
});

test('③ 공통 계정 비밀번호에도 — 허용 기능 · 법인 사용 중지 · 상태 파일 손상(fail-closed)', () => {
  const ad = KS.accountByName('os', 'kr-ad');
  const w1 = byName('w1');
  // 허용 기능: kr-ad = bm-usage · bm-storage → 다른 기능은 거절 · 연결 시험은 언제나
  assert.equal(REFS.resolveOsAuth(w1, { feature: 'disk-audit' }).code, 'account-feature');
  assert.equal(REFS.resolveOsAuth(w1, { feature: 'conn-test' }).ok, true);
  // 법인 사용 중지 → 공통 계정 비밀번호도 멈춘다
  assert.equal(SVC.stopCorp('vcA', { by: 'own', reason: 't' }).ok, true);
  assert.equal(REFS.resolveOsAuth(w1, { feature: 'bm-usage' }).code, 'account-corp-stopped');
  assert.equal(REFS.resolveOsAuth({ id: 'x', name: 'x', host: '10.9.9.9', vcenterId: 'vcA', credRef: ad.id }, { feature: 'bm-usage' }).code, 'account-corp-stopped');
  assert.equal(SVC.resumeCorp('vcA', { by: 'own' }).ok, true);
  // 상태 파일 손상 → 물려받는 서버 · 공통 계정 비밀번호 모두 멈춘다(지정 · 정지 기록을 모른다)
  const sf = path.join(DIR, 'ssh-access-state.json');
  const orig = fs.readFileSync(sf, 'utf8');
  fs.writeFileSync(sf, '{"assign": [1,2]}');
  ST._resetSshAccessStateForTest();
  assert.equal(REFS.resolveOsAuth(byName('w1'), { feature: 'bm-usage' }).code, 'account-state-unreadable');
  assert.equal(REFS.resolveOsAuth({ id: 'x', name: 'x', host: '10.9.9.9', vcenterId: 'vcA', credRef: ad.id }, { feature: 'bm-usage' }).code, 'account-state-unreadable');
  assert.equal(REFS.resolveOsAuth(byName('own1'), { feature: 'bm-usage' }).ok, true, '서버 자기 비밀번호는 상태 파일과 무관(예전 그대로)');
  for (const f of fs.readdirSync(DIR).filter((x) => x.startsWith('ssh-access-state.json.corrupt.'))) fs.rmSync(path.join(DIR, f));
  fs.writeFileSync(sf, orig);
  ST._resetSshAccessStateForTest();
  assert.equal(REFS.resolveOsAuth(byName('w1'), { feature: 'bm-usage' }).ok, true);
});

test('④ 계정 단위 정지 — 로그인 거부 한 번이면 그 계정을 쓰는 서버 전부 멈춤 · 다른 실패는 아님 · 비밀번호를 새로 넣으면 풀림', () => {
  const ad = KS.accountByName('os', 'kr-ad');
  const w2 = srv({ name: 'w2', vcenterId: 'vcA', os: 'windows', addrOnly: true });
  BM.setBmServerInherit(w2.id, { on: true, expectAddr: addrOf(w2), by: 'own' });
  const r1 = REFS.withResolvedAuth([byName('w1')], { feature: 'bm-usage' })[0];
  // 접속 실패(로그인 거부 아님) · 인증 정지 중 결과는 계정을 멈추지 않는다
  assert.equal(OUT.noteCredOutcome(r1, { ok: false, code: 'connect', feature: 'bm-usage' }).accountStopped, undefined);
  assert.equal(OUT.noteCredOutcome(r1, { ok: false, rejected: true, authStopped: true, feature: 'bm-usage' }).accountStopped, undefined);
  // 반증 F3: 로그인에 성공한 뒤 명령 출력의 'Permission denied'(df stderr 를 error 에 담는다)는 거부가 아니다 — 거부 표지는 호출부의 접속 단계 판정뿐
  assert.equal(OUT.noteCredOutcome(r1, { ok: false, error: 'df: /data/secure: Permission denied', feature: 'bm-storage' }).accountStopped, undefined);
  assert.equal(REFS.resolveOsAuth(byName('w2'), { feature: 'bm-usage' }).ok, true);
  // 자격 해석이 막은 결과는 기록하지도 않는다
  assert.equal(OUT.noteCredOutcome({ ...r1, authErrorCode: 'account-feature' }, { ok: false, rejected: true, feature: 'bm-usage' }).recorded, false);
  // 로그인 거부 → 계정 정지 → 같은 계정의 다른 서버도 접속하지 않는다
  assert.equal(OUT.noteCredOutcome(r1, { ok: false, rejected: true, feature: 'bm-usage' }).accountStopped, true);
  const r2 = REFS.resolveOsAuth(byName('w2'), { feature: 'bm-usage' });
  assert.equal(r2.code, 'account-stopped'); assert.equal(r2.stoppedOn, 'w1');
  assert.equal(REFS.withResolvedAuth([byName('w2')], { feature: 'bm-usage' })[0].password, '', '정지된 계정의 비밀번호를 폴러에 싣지 않는다');
  // 사용 기록 — 계정 지문 칸(비밀 아님)
  assert.ok(US.keyUsageView({ fingerprint: US.accountUseFingerprint(ad.id) }).rows.some((x) => x.lastCode === 'auth-rejected'));
  // 비밀번호를 새로 넣으면(판이 바뀜) 풀린 것으로 본다 — 같은 비밀번호를 다시 넣어도 판이 바뀐다
  const before = KS.accountSecretVersion(KS.accountById(ad.id));
  const sv = KS.saveAccount({ id: ad.id, password: 'Ad-Right-1' }, { now: Date.now() + 5 });
  assert.equal(sv.ok, true, sv.reason);
  assert.notEqual(KS.accountSecretVersion(KS.accountById(ad.id)), before);
  assert.equal(REFS.resolveOsAuth(byName('w2'), { feature: 'bm-usage' }).ok, true);
  assert.equal(ST.listAccountStops().length, 1, '옛 판의 기록은 남는다(화면이 ‘비밀번호 바꿔 풀림’ 으로 보인다)');
  assert.equal(ST.clearAccountStop(ad.id, { by: 'own' }).ok, true);
});

/* ── ⑤ 서비스 — 한 대 먼저 확인(가짜 sshd · 시도 수) ─────────────────────── */
test('⑤ 한 대 먼저 확인 — 지정 · 승인 · 새 비밀번호 저장 모두 틀리면 저장하지 않고 한 번만 시도 · 맞으면 확인 기록', async () => {
  SSHD.st.passwords['svc@corp.example'] = 'Ad-Right-1';
  SSHD.st.passwords.monitor = 'Lin-1';
  const ad = KS.accountByName('os', 'kr-ad');
  const lin = KS.accountByName('os', 'kr-lin');
  // 지정 — 지금 물려받는 서버가 있으면 확인 대상을 골라야 한다
  const need = await SVC.setAssignment({ corp: 'vcA', level: 'windows', accountId: ad.id, auth: 'password', by: 'own' });
  assert.equal(need.code, 'need-verify'); assert.ok(need.candidates.some((c) => c.name === 'w1'));
  // 틀린 비밀번호의 계정으로 바꾸려 하면 — 확인 실패 · 지정은 그대로 · 시도 한 번
  const bad = KS.saveAccount({ name: 'kr-ad-bad', kind: 'os', corp: 'vcA', os: 'windows', logon: 'ad', domain: 'corp.example', username: 'svc', password: 'Wrong-9' }).account;
  const r0 = await SVC.setAssignment({ corp: 'vcA', level: 'windows', accountId: bad.id, verifyServerId: byName('w1').id, by: 'own' });
  assert.equal(r0.code, 'verify-failed');
  assert.equal(pwTries('Wrong-9'), 1, '틀린 비밀번호는 한 번만(다시 시도하지 않는다)');
  assert.equal(ST.assignFor('vcA', 'windows').account, ad.id, '지정은 바뀌지 않았다');
  assert.ok(ST.accountStopFor(bad.id), '확인 실패(로그인 거부)도 그 계정을 멈춘다');
  // 맞는 계정 — 확인 뒤 저장 · 확인 기록
  const r1 = await SVC.setAssignment({ corp: 'vcA', level: 'windows', accountId: ad.id, auth: 'password', verifyServerId: byName('w1').id, by: 'own' });
  assert.equal(r1.ok, true, r1.reason); assert.equal(r1.verified.ok, true); assert.ok(r1.willUse >= 2);
  assert.equal(KS.accountById(ad.id).verifiedOn, 'w1');
  // 승인 — 먼저 확인(틀리면 아무것도 승인하지 않음)
  const w3 = srv({ name: 'w3', vcenterId: 'vcA', os: 'windows', addrOnly: true });
  const w4 = srv({ name: 'w4', vcenterId: 'vcA', os: 'windows', addrOnly: true });
  SSHD.st.passwords['svc@corp.example'] = 'Changed-On-Domain';
  const keysOf = (...xs) => Object.fromEntries(xs.map((x) => [x.id, BM.inheritKeyOf(byName(x.name))]));
  const a0 = await SVC.approveInherit({ ids: [w3.id, w4.id], expectAddrs: { [w3.id]: addrOf(w3), [w4.id]: addrOf(w4) }, expectKeys: keysOf(w3, w4), by: 'own' });
  assert.equal(a0.code, 'verify-failed');
  assert.equal(BM.inheritActive(byName('w3')) || BM.inheritActive(byName('w4')), false, '하나도 승인하지 않았다');
  ST.clearAccountStop(ad.id, { by: 'own' });
  // 낡은 화면(주소가 다름)이면 거절
  assert.equal((await SVC.approveInherit({ ids: [w3.id], expectAddrs: { [w3.id]: 'other:22|root' }, expectKeys: keysOf(w3), by: 'own' })).code, 'moved');
  // 반증 F8: 화면이 본 승인 키(주소 · 포트 · OS · 법인)가 지금과 다르면(본 뒤 OS 가 바뀜) 거절 · 키를 안 보내도 거절
  assert.equal((await SVC.approveInherit({ ids: [w3.id], expectAddrs: { [w3.id]: addrOf(w3) }, expectKeys: { [w3.id]: BM.inheritKeyOf({ ...byName('w3'), os: 'linux' }) }, by: 'own' })).code, 'moved');
  assert.equal((await SVC.approveInherit({ ids: [w3.id], expectAddrs: { [w3.id]: addrOf(w3) }, by: 'own' })).code, 'moved');
  // 새 비밀번호 저장 — 쓰는 서버가 있으면 확인 대상 필요 · 틀리면 저장하지 않는다
  const s0 = await SVC.saveAccountChecked({ input: { id: ad.id, password: 'Typo-0' }, by: 'own' });
  assert.equal(s0.code, 'need-verify');
  const s1 = await SVC.saveAccountChecked({ input: { id: ad.id, password: 'Typo-0' }, verifyServerId: byName('w1').id, by: 'own' });
  assert.equal(s1.code, 'verify-failed'); assert.equal(pwTries('Typo-0'), 1);
  assert.equal(KS.accountById(ad.id).password, 'Ad-Right-1', '틀린 새 비밀번호는 저장하지 않았다');
  const s2 = await SVC.saveAccountChecked({ input: { id: ad.id, password: 'Changed-On-Domain' }, verifyServerId: byName('w1').id, by: 'own' });
  assert.equal(s2.ok, true, s2.reason); assert.equal(s2.verified.server, 'w1');
  assert.equal(KS.accountById(ad.id).password, 'Changed-On-Domain');
  // 이제 승인 — 확인 성공 → 두 대 승인
  const a1 = await SVC.approveInherit({ ids: [w3.id, w4.id], expectAddrs: { [w3.id]: addrOf(w3), [w4.id]: addrOf(w4) }, expectKeys: keysOf(w3, w4), by: 'own' });
  assert.equal(a1.ok, true, a1.reason); assert.equal(a1.approved, 2);
  assert.equal(REFS.resolveOsAuth(byName('w4'), { feature: 'bm-usage' }).password, 'Changed-On-Domain');
  // 한 대로 다시 확인 — 정지를 푼다
  OUT.noteCredOutcome(REFS.withResolvedAuth([byName('w3')], { feature: 'bm-usage' })[0], { ok: false, rejected: true, feature: 'bm-usage' });
  assert.equal(REFS.resolveOsAuth(byName('w4'), { feature: 'bm-usage' }).code, 'account-stopped');
  const v1 = await SVC.verifyAccount({ accountId: ad.id, serverId: byName('w4').id, by: 'own' });
  assert.equal(v1.ok, true, v1.reason); assert.equal(v1.resumed, true);
  assert.equal(REFS.resolveOsAuth(byName('w3'), { feature: 'bm-usage' }).ok, true);
  // 따로 정하기 — 실패하면 되돌린다
  const c0 = await SVC.chooseServerAccount({ serverId: byName('w4').id, accountId: bad.id, expectAddr: addrOf(byName('w4')), by: 'own' });
  assert.equal(c0.code, 'test-failed'); assert.equal(c0.reverted, true);
  assert.equal(BM.inheritActive(byName('w4')), true, '되돌려 다시 물려받는다'); assert.equal(byName('w4').credRef, undefined);
  // 지정이 가리키는 계정은 지우지 않는다 · OS 를 바꿔 지정을 어긋나게 하지 않는다
  assert.equal(REFS.deleteAccountIfUnused(ad.id).code, 'in-use');
  assert.equal(REFS.accountUseIssue(KS.accountById(ad.id), { kind: 'os', corp: 'vcA', os: 'linux' }).code, 'assign-conflict');
  assert.equal(REFS.accountUseIssue(KS.accountById(lin.id), { kind: 'os', corp: 'vcB', os: 'linux' }).code, 'assign-conflict', '다른 법인으로 옮기면 지정과 어긋난다');
  ST.clearAccountStop(bad.id, { by: 'own' });
});

test('⑥ 지정 규칙 — 다른 법인 계정 · 단계 OS 와 다른 계정 · 없는 법인 · 지우기', async () => {
  const pl = KS.saveAccount({ name: 'pl-lin', kind: 'os', corp: 'vcB', os: 'linux', username: 'pl', password: 'Pl-1' }).account;
  const ad = KS.accountByName('os', 'kr-ad');
  assert.equal((await SVC.setAssignment({ corp: 'vcA', level: 'linux', accountId: pl.id, by: 'own' })).code, 'account-other-corp');
  assert.equal((await SVC.setAssignment({ corp: 'vcA', level: 'linux', accountId: ad.id, by: 'own' })).code, 'account-os');
  assert.equal((await SVC.setAssignment({ corp: 'vcZ', level: 'all', accountId: ad.id, by: 'own' })).code, 'bad-corp');
  assert.equal((await SVC.setAssignment({ corp: 'vcB', level: 'linux', accountId: pl.id, by: 'own' })).ok, true, 'vcB 에는 물려받는 서버가 없어 확인 없이 저장');
  assert.equal((await SVC.setAssignment({ corp: 'vcB', level: 'linux', accountId: '', by: 'own' })).ok, true);
  assert.equal(ST.assignFor('vcB', 'linux'), null);
  assert.ok(ST.listEvents({ limit: 20 }).some((e) => e.kind === 'assign-clear' && e.corp === 'vcB'));
});

/* ── ⑦ 실제 라우터 — 설정 소유자 등급 + OTP 마지막 · 비밀 노출 없음 ─────────────────── */
test('⑦ 라우트 — 비소유자 · 범위 소유자 403 · OTP 없으면 거절 · 소유자 + OTP 통과 · 화면 응답 · 감사에 비밀 없음', async (t) => {
  const call = await api(t);
  const ad = KS.accountByName('os', 'kr-ad');
  const body = { corp: 'vcA', level: 'windows', accountId: ad.id, auth: 'password', verifyServerId: byName('w1').id };
  assert.equal((await call('adm', 'PUT', '/settings/ssh-access/assign', body)).s, 403);
  assert.equal((await call('sown', 'PUT', '/settings/ssh-access/assign', body)).s, 403);
  const noOtp = await call('own', 'PUT', '/settings/ssh-access/assign', body);
  assert.equal(noOtp.s, 403); assert.equal(noOtp.j.needOtp, true);
  const ok = await call('own', 'PUT', '/settings/ssh-access/assign', { ...body, otp: otp('own') });
  assert.equal(ok.s, 200, ok.txt); assert.equal(ok.j.verified.ok, true);
  // 화면 응답 — 계층 칸 · 비밀 없음
  const view = await call('own', 'GET', '/settings/ssh-access');
  assert.equal(view.s, 200);
  for (const secret of ['Changed-On-Domain', 'Lin-1', 'Wrong-9', 'Pl-1']) assert.equal(view.txt.includes(secret), false, `응답에 ${secret} 없음`);
  const w1 = view.j.servers.find((s) => s.name === 'w1');
  assert.deepEqual({ src: w1.source, os: w1.os, ap: w1.inheritApproved, login: w1.loginName }, { src: 'os', os: 'windows', ap: true, login: 'svc@corp.example' });
  assert.ok(Array.isArray(view.j.assign) && view.j.assign.some((a) => a.corp === 'vcA' && a.level === 'windows'));
  assert.equal(view.j.accounts.find((a) => a.id === ad.id).family, 'windows');
  // 계정 저장 라우트 — 새 비밀번호 + 확인 대상(OTP 는 own2)
  SSHD.st.passwords['svc@corp.example'] = 'Route-New-2';
  const sv = await call('own2', 'POST', '/settings/ssh-access/accounts', { id: ad.id, name: 'kr-ad', corp: 'vcA', username: 'svc', password: 'Route-New-2', verifyServerId: byName('w1').id, otp: otp('own2') });
  assert.equal(sv.s, 200, sv.txt); assert.equal(sv.j.verified.server, 'w1');
  assert.equal(sv.txt.includes('Route-New-2'), false);
  // 감사 로그에 비밀 없음
  const auditTxt = fs.readdirSync(DIR).filter((f) => f.startsWith('audit')).map((f) => { try { return fs.readFileSync(path.join(DIR, f), 'utf8'); } catch { return ''; } }).join('\n');
  for (const secret of ['Route-New-2', 'Changed-On-Domain', 'Ad-Right-1']) assert.equal(auditTxt.includes(secret), false);
});

/* ── ⑧ 소스 스윕 — 묶는 쓰기는 서비스 하나 · 라우트는 자격 원본을 만지지 않는다 · 복원 제외 ─────────────── */
test('⑧ 스윕 — 승인 · 계정 바꾸기 · 지정 쓰기는 sshaccess/service.js 만 부른다 · 상태 파일은 복원 제외 · 라우트는 OTP 게이트', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
  const files = walk(SRC);
  const callers = (re) => files.filter((f) => re.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(SRC, f)).sort();
  assert.deepEqual(callers(/\bsetBmServerInherit\(/), ['bmstor/registry.js', 'sshaccess/service.js']);
  assert.deepEqual(callers(/\bsetBmServerCredRef\(/), ['bmstor/registry.js', 'sshaccess/service.js']);
  assert.deepEqual(callers(/\bsetAssign\(/), ['sshaccess/service.js', 'sshaccess/state.js']);
  assert.deepEqual(callers(/ignoreAccountStop: true/), ['sshaccess/service.js'], '계정 정지를 넘는 해석은 ‘한 대로 다시 확인’ 하나');
  const routes = fs.readFileSync(path.join(SRC, 'routes/api/sshAccess.js'), 'utf8');
  assert.doesNotMatch(routes, /resolveOsAuth|keyMaterial|listKeysRaw|listBmServersRaw|KS\./);
  for (const p of ['/assign', '/servers/inherit', '/servers/:id/account', '/servers/os', '/accounts/:id/verify', '/accounts/:id/stop']) {
    const line = routes.split('\n').find((l) => l.includes(`'/settings/ssh-access${p}'`));
    // ownerWrite 그대로이거나, 판정 거절을 OTP 앞에 두는 꼴(반증 F9 — adminOnly → 소유자 → judgeFirst(dryRun) → reauth 마지막)
    assert.ok(line && (/\.\.\.ownerWrite/.test(line) || /adminOnly, requireSettingsOwner, judgeFirst\(.*\), reauth, async/.test(line)), `${p} 는 소유자 + OTP`);
  }
  assert.match(routes, /'\/settings\/ssh-access\/accounts', adminOnly, requireSettingsOwner, pwVaultFirst,\s*judgeFirst\([\s\S]{0,400}?dryRun: true[\s\S]{0,40}?\), reauth,/);
  assert.match(routes, /const judgeFirst = [\s\S]{0,200}?r\.ok === false\) return send\(res, r\); return next\(\)/, 'dryRun 거절이면 OTP 전에 돌려준다');
  const restore = fs.readFileSync(path.join(SRC, 'backup/stagedRestore.js'), 'utf8');
  assert.match(restore, /\['ssh-access-state\.json', '[^']*계층 지정/);
});

/* ── ⑨ ~ ⑪ 반증 검토(review319) 확정분 — 고친 뒤의 동작을 고정한다 ─────────────────────────────── */
const freshAcc = (b) => { const r = KS.saveAccount({ kind: 'os', os: 'linux', ...b }, { by: 'own' }); assert.equal(r.ok, true, r.reason); return KS.accountById(r.account.id); };
const approve = (s) => { const w = BM.setBmServerInherit(s.id, { on: true, expectAddr: addrOf(s), expectKey: BM.inheritKeyOf(s), by: 'own' }); assert.equal(w.ok, true, w.reason); return byName(s.name); };

test('⑨ 반증 F1 · F5 · F4 — 승인은 법인에도 묶인다 · 자기 자격이 생기면 승인을 지운다(떼기 · 키 고르기) · 복원 병합은 도메인이 다르면 비밀번호를 붙이지 않고 기능 · 판은 지금 값', async () => {
  const a = freshAcc({ name: 'f1-a', corp: 'vcC', username: 'f1a', password: 'F1-A-pw' });
  const b = freshAcc({ name: 'f1-b', corp: 'vcD', username: 'f1b', password: 'F1-B-pw' });
  ST.setAssign('vcC', 'linux', { account: a.id, auth: '' }, { by: 'own' });
  ST.setAssign('vcD', 'linux', { account: b.id, auth: '' }, { by: 'own' });
  // F1: 승인 뒤 OTP 없는 서버 저장으로 법인만 바꾸면 — 예전에는 다른 법인 계정(F1-B-pw)이 이 서버로 갔다
  const s = approve(srv({ name: 'f1', vcenterId: 'vcC', os: 'linux', addrOnly: true }));
  assert.equal(REFS.resolveOsAuth(s, { feature: 'bm-usage' }).password, 'F1-A-pw');
  assert.equal(BM.saveBmServer({ id: s.id, name: 'f1', host: s.host, port: s.port, mounts: ['/'], vcenterId: 'vcD' }).ok, true);
  assert.equal(BM.inheritActive(byName('f1')), false, '법인이 바뀌면 승인은 효력을 잃는다');
  assert.notEqual(REFS.resolveOsAuth(byName('f1'), { feature: 'bm-usage' }).password, 'F1-B-pw', '다른 법인의 공통 계정 비밀번호가 가지 않는다');
  assert.notEqual(BM.inheritKeyOf({ ...s, vcenterId: 'vcC' }), BM.inheritKeyOf({ ...s, vcenterId: 'vcD' }));
  // F5: 자기 계정을 묶으면 승인 칸을 지운다 → 그 뒤 OTP 없는 ‘떼기’ 로 물려받기가 되살지 않는다
  const own = freshAcc({ name: 'f5-own', corp: 'vcC', username: 'f5o', password: 'F5-own' });
  const s5 = approve(srv({ name: 'f5', vcenterId: 'vcC', os: 'linux', addrOnly: true }));
  assert.equal(BM.saveBmServer({ id: s5.id, name: 'f5', host: s5.host, port: s5.port, mounts: ['/'], credRef: own.id, bindApproved: true }).ok, true);
  assert.equal(byName('f5').inherit, undefined, '자기 자격이 생기면 승인을 지운다');
  assert.equal(BM.saveBmServer({ id: s5.id, name: 'f5', host: s5.host, port: s5.port, mounts: ['/'], credRef: '' }).ok, true);
  assert.equal(BM.inheritActive(byName('f5')), false);
  assert.notEqual(REFS.resolveOsAuth(byName('f5'), { feature: 'bm-usage' }).password, 'F1-A-pw', '떼기만으로 위 단계 비밀번호를 물려받지 않는다');
  // 키 고르기도 같다 — 실패해 되돌리면 승인도 되돌린다
  const s6 = approve(srv({ name: 'f5k', vcenterId: 'vcC', os: 'linux', addrOnly: true }));
  const w = BM.setBmServerKeyRef(s6.id, 'k_0123456789ab', { expectAddr: addrOf(s6) });
  assert.equal(w.ok, true, w.reason); assert.equal(byName('f5k').inherit, undefined);
  assert.equal(BM.restoreBmServerKeyRef(s6.id, w.previous).ok, true);
  assert.equal(BM.inheritActive(byName('f5k')), true, '되돌리면 승인도 되돌아온다');
  // F4: 복원 병합 — 백업의 도메인이 지금과 다르면 지금 비밀번호를 붙이지 않는다 · 기능 · 비밀번호 판 · 확인 기록은 지금 값
  const KB = await import('../src/bmusage/onboard/keyBundle.js');
  const id = 'a_0000000000aa';
  const cur = { keys: [], accounts: [{ id, name: 'r1', kind: 'os', corp: 'vcA', os: 'windows', logon: 'ad', domain: 'new.example', username: 'svc', password: 'SEALED-NEW', features: ['bm-usage'], pwSetAt: 2000, verifiedAt: 1500, verifiedOn: 'w1' }] };
  const bak = { keys: [], accounts: [{ id, name: 'r1', kind: 'os', corp: 'vcA', os: 'windows', logon: 'ad', domain: 'old.example', username: 'svc', password: KB.REDACTED_SECRET, features: null, pwSetAt: 1000 }] };
  const m1 = JSON.parse(KB.mergeRedactedKeyStore(JSON.stringify(bak), JSON.stringify(cur)).text).accounts[0];
  assert.equal(m1.password, '', '도메인이 다르면 새 비밀번호를 옛 도메인에 붙이지 않는다');
  assert.deepEqual(m1.features, ['bm-usage'], '좁혀 둔 기능을 넓히지 않는다');
  assert.equal(m1.pwSetAt, 2000, '비밀번호 판(계정 정지가 걸린 판)을 되돌리지 않는다');
  assert.equal(m1.verifiedOn, 'w1');
  const m2 = JSON.parse(KB.mergeRedactedKeyStore(JSON.stringify({ ...bak, accounts: [{ ...bak.accounts[0], domain: 'new.example' }] }), JSON.stringify(cur)).text).accounts[0];
  assert.equal(m2.password, 'SEALED-NEW'); assert.equal(m2.pwSetAt, 2000);
  const m3 = JSON.parse(KB.mergeRedactedKeyStore(JSON.stringify({ ...bak, accounts: [{ ...bak.accounts[0], domain: 'new.example', os: 'linux' }] }), JSON.stringify(cur)).text).accounts[0];
  assert.equal(m3.password, '', 'OS 계열이 다르면 붙이지 않는다');
});

test('⑩ 반증 F2 — 같은 공통 계정을 물려받는 서버 5대가 한 주기에 틀린 비밀번호를 한 번만 보낸다(탐침) · 정지는 그 주기 안에 · 연결 실패면 다음 하나가 탐침', async () => {
  const g = freshAcc({ name: 'f2-g', corp: 'vcE', username: 'f2user', password: 'F2-Wrong-1' });
  ST.setAssign('vcE', 'linux', { account: g.id, auth: '' }, { by: 'own' });
  for (let i = 1; i <= 5; i += 1) approve(srv({ name: `f2-${i}`, vcenterId: 'vcE', os: 'linux', addrOnly: true }));
  const BP = await import('../src/bmstor/poller.js');
  const r = await BP.bmCollectNow('auto');
  assert.equal(r.skipped, undefined, JSON.stringify(r).slice(0, 200));
  assert.equal(pwTries('F2-Wrong-1'), 1, '틀린 비밀번호는 한 번만(예전 5번)');
  assert.ok(ST.accountStopFor(g.id, KS.accountSecretVersion(KS.accountById(g.id))), '그 주기 안에 계정 정지');
  // 문 자체 — 거부면 기다리던 접속은 보내지 않는다 · 연결 실패면 하나씩 · 성공 뒤에는 함께
  const G = await import('../src/sshaccess/accountGate.js');
  const y = freshAcc({ name: 'gate-y', corp: 'vcE', username: 'gy', password: 'Gy-1' });
  const sy = { credAccountId: y.id, credVersion: KS.accountSecretVersion(y), name: 'gy' };
  const opts = { feature: 'bm-usage', rejected: (x) => x?.error === 'auth', stopped: (code) => ({ ok: false, authErrorCode: code }) };
  const log = []; let n = 0; let active = 0; let maxActive = 0;
  const run = async () => { const k = n++; active += 1; maxActive = Math.max(maxActive, active); log.push(['s', k]); await new Promise((res) => setTimeout(res, 15)); active -= 1; log.push(['e', k]); return k === 0 ? { ok: false, error: 'timeout' } : { ok: true }; };
  const rs = await Promise.all(Array.from({ length: 6 }, () => G.gateAccountLogin(sy, run, opts)));
  assert.equal(n, 6); assert.equal(rs.filter((x) => x.ok).length, 5);
  assert.ok(log.findIndex((x) => x[0] === 's' && x[1] === 1) > log.findIndex((x) => x[0] === 'e' && x[1] === 0), '첫 탐침이 실패(연결)한 뒤에 다음 하나가 탐침');
  assert.ok(log.findIndex((x) => x[0] === 's' && x[1] === 2) > log.findIndex((x) => x[0] === 'e' && x[1] === 1), '성공한 탐침 뒤에야 나머지');
  assert.ok(maxActive >= 2, '성공 뒤에는 함께 접속한다');
  const z = freshAcc({ name: 'gate-z', corp: 'vcE', username: 'gz', password: 'Gz-1' });
  const sz = { credAccountId: z.id, credVersion: KS.accountSecretVersion(z), name: 'gz' };
  let nz = 0;
  const rz = await Promise.all(Array.from({ length: 6 }, () => G.gateAccountLogin(sz, async () => { nz += 1; await new Promise((res) => setTimeout(res, 10)); return { ok: false, error: 'auth' }; }, opts)));
  assert.equal(nz, 1, '거부면 한 번만'); assert.equal(rz.filter((x) => x.authErrorCode === 'account-stopped').length, 5);
  assert.ok(ST.accountStopFor(z.id, KS.accountSecretVersion(z)));
  // 두 폴러 모두 이 문을 지난다(bm-usage 는 장비 시한 밖에서 기다린다 — 시한은 탐침 뒤 run 안에서 연다)
  const src = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
  assert.match(src('bmusage/poller.js'), /gateAccountLogin\(target\.osHost, \(\) => withDeadline\(DEVICE_TIMEOUT_MS/);
  assert.match(src('bmstor/poller.js'), /collectMany\(central, \{ collect: gatedCollect \}\)/);
  assert.match(src('bmstor/poller.js'), /const gatedCollect = \(s\) => gateAccountLogin\(s, \(\) => collectServer\(s\)/);
  // 키 로그인(판 없음)은 문을 지나지 않는다
  let nk = 0; await Promise.all(Array.from({ length: 3 }, () => G.gateAccountLogin({ credAccountId: z.id, name: 'k' }, async () => { nk += 1; return { ok: false, error: 'auth' }; }, opts)));
  assert.equal(nk, 3);
});

test('⑪ 반증 F6 · F7 · F9 — 여러 계정 승인은 계정마다 확인 · 옛 화면은 지정 계정의 새 비밀번호를 거절 · 연결 시험 거부도 계정 정지 · 판정 거절은 OTP 앞', async (t) => {
  // F6: Linux(맞는 비밀번호) + Windows(틀린 비밀번호)를 한 번에 승인 — 예전에는 첫 계정만 확인했다
  SSHD.st.passwords.f1a = 'F1-A-pw';
  ST.clearAccountStop(KS.accountByName('os', 'f1-a').id, { by: 'own' });   // ⑩ 의 주기 수집이 f1-a 서버(f5k)에서 거부를 보고 멈춰 두었다(탐침이 맞게 동작)
  const w6 = freshAcc({ name: 'f6-w', corp: 'vcC', os: 'windows', logon: 'local', username: 'f6w', password: 'F6-W-wrong' });
  ST.setAssign('vcC', 'windows', { account: w6.id, auth: '' }, { by: 'own' });
  const l = srv({ name: 'f6-l', vcenterId: 'vcC', os: 'linux', addrOnly: true });
  const wv = srv({ name: 'f6-w1', vcenterId: 'vcC', os: 'windows', addrOnly: true });
  const ap = await SVC.approveInherit({ ids: [l.id, wv.id], expectAddrs: { [l.id]: addrOf(l), [wv.id]: addrOf(wv) }, expectKeys: { [l.id]: BM.inheritKeyOf(l), [wv.id]: BM.inheritKeyOf(wv) }, by: 'own' });
  assert.equal(ap.code, 'verify-failed', JSON.stringify(ap).slice(0, 300));
  assert.equal(pwTries('F6-W-wrong'), 1, `둘째 계정도 확인했다 ${JSON.stringify(ap).slice(0, 400)}`);
  assert.equal(ap.verifiedAll.length, 1, '첫 계정(Linux)은 확인됐고 둘째(Windows)에서 멈췄다');
  assert.equal(BM.inheritActive(byName('f6-l')) || BM.inheritActive(byName('f6-w1')), false, '하나도 승인하지 않았다');
  // F6: 고른 서버들이 쓰게 될 계정이 4개를 넘으면 나눠 승인하게 한다(계정마다 한 대씩 확인하므로 — 판정 단계에서 거절, 로그인 없음)
  const many = [];
  for (const c of ['vcH', 'vcI', 'vcJ', 'vcK', 'vcL']) {
    const acc = freshAcc({ name: `f6-${c}`, corp: c, username: `u${c}`, password: `P-${c}` });
    ST.setAssign(c, 'linux', { account: acc.id, auth: '' }, { by: 'own' });
    many.push(srv({ name: `f6-${c}`, vcenterId: c, os: 'linux', addrOnly: true }));
  }
  const tm = await SVC.approveInherit({ ids: many.map((x) => x.id), expectAddrs: Object.fromEntries(many.map((x) => [x.id, addrOf(x)])), expectKeys: Object.fromEntries(many.map((x) => [x.id, BM.inheritKeyOf(x)])), by: 'own' });
  assert.equal(tm.code, 'too-many-accounts', JSON.stringify(tm).slice(0, 200));
  assert.equal(many.some((x) => pwTries(`P-${x.vcenterId}`) > 0), false, '로그인하지 않았다');
  // F7: 옛 7b 계정 화면 — 계층 지정 계정(f1-a)의 새 비밀번호는 OTP 전에 거절(새 화면으로 안내)
  const call = await api(t);
  const a = KS.accountByName('os', 'f1-a');
  const legacy = await call('own', 'POST', '/tools/bm-usage/accounts', { id: a.id, name: 'f1-a', kind: 'os', corp: 'vcC', username: 'f1a', password: 'Legacy-New-1' });
  assert.equal(legacy.s, 409, legacy.txt); assert.equal(legacy.j.code, 'use-server-access');
  assert.equal(KS.accountById(a.id).password, 'F1-A-pw');
  // F7: 저장 자격 연결 시험(온보딩 연결 시험 · 서버 접속 화면 공용 본체)의 로그인 거부도 계정 단위 정지
  const f7 = freshAcc({ name: 'f7-acc', corp: 'vcF', username: 'f7u', password: 'F7-Wrong' });
  ST.setAssign('vcF', 'linux', { account: f7.id, auth: '' }, { by: 'own' });
  const s7 = approve(srv({ name: 'f7', vcenterId: 'vcF', os: 'linux', addrOnly: true }));
  const CT = await import('../src/bmusage/onboard/connTest.js');
  const tr = await CT.testSavedOs(s7, { by: 'own' });
  assert.equal(tr.kind, 'auth-rejected');
  assert.ok(ST.accountStopFor(f7.id, KS.accountSecretVersion(KS.accountById(f7.id))), '연결 시험 거부도 계정을 멈춘다');
  // F9: 판정 거절은 OTP 를 묻기 전에(1회 비밀번호를 쓰지 않게) — 없는 계정 · 도메인 꼴 · 낡은 승인 키
  const r1 = await call('own', 'PUT', '/settings/ssh-access/assign', { corp: 'vcA', level: 'linux', accountId: 'a_ffffffffffff' });
  assert.equal(r1.j.code, 'account-missing', r1.txt); assert.notEqual(r1.j.needOtp, true);
  const r2 = await call('own', 'POST', '/settings/ssh-access/accounts', { name: 'bad-dom', corp: 'vcA', os: 'windows', logon: 'ad', domain: 'bad domain!', username: 'svc', password: 'X-1' });
  assert.equal(r2.j.code, 'bad-domain', r2.txt); assert.notEqual(r2.j.needOtp, true);
  const r3 = await call('own', 'POST', '/settings/ssh-access/servers/inherit', { ids: [l.id], expectAddrs: { [l.id]: addrOf(l) }, expectKeys: { [l.id]: 'x:22||' } });
  assert.equal(r3.j.code, 'moved', r3.txt); assert.notEqual(r3.j.needOtp, true);
  // 통과하는 요청은 여전히 OTP 를 묻는다
  const r4 = await call('own', 'PUT', '/settings/ssh-access/assign', { corp: 'vcA', level: 'linux', accountId: '' });
  assert.equal(r4.s, 403); assert.equal(r4.j.needOtp, true);
});
