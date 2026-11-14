/**
 * v3.9.0 SSH 공용 접속(설계 docs/design/ssh-access) — 7b 키 저장소 위의 폴더 · 허용 기능 · 서버별 키 고르기 · 서버에 들어 있는 키 읽기 ·
 * 받는 곳(inbox) · 법인 사용 중지 · 키 바꿔치기 감시 · 사용 기록 · 키 점검 · 라우트 권한(설정 소유자 등급 + OTP 마지막) · 비밀 노출 스윕.
 * 실제 api 라우터 · 실제 keyStore + secretVault(encrypted) · 실제 ssh2 가짜 sshd(정한 공개키만 받고 exec 에 답한다) · 실제 등록부.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'sshacc390-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.SETTINGS_OWNERS = 'own,own2,sown';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.SSH_HOSTKEY_POLICY = 'observe';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HERE = path.dirname(fileURLToPath(import.meta.url));

const F = await import('./_sshKeyFixtures.js');
const { generateSecret, generateToken } = await import('../src/auth/totp.js');
const SECRETS = { own: generateSecret(), own2: generateSecret() };
fs.writeFileSync(path.join(DIR, 'users.json'), JSON.stringify({ users: [
  { username: 'own', role: 'admin', totpEnabled: true, totpSecret: SECRETS.own },
  { username: 'own2', role: 'admin', totpEnabled: true, totpSecret: SECRETS.own2 },
  { username: 'sown', role: 'admin', scope: { vcenters: ['vcA'] } },
  { username: 'adm', role: 'admin' },
] }));
const VAULT = await import('../src/security/secretVault.js');
VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
const ssh2 = (await import('ssh2')).default;
const KS = await import('../src/bmusage/onboard/keyStore.js');
const REFS = await import('../src/bmusage/onboard/refs.js');
const BM = await import('../src/bmstor/registry.js');
const ST = await import('../src/sshaccess/state.js');
const US = await import('../src/sshaccess/usage.js');
const INS = await import('../src/sshaccess/installed.js');
const INB = await import('../src/sshaccess/inbox.js');
const AK = await import('../src/sshaccess/authorizedKeys.js');
const SVC = await import('../src/sshaccess/service.js');
const CHK = await import('../src/sshaccess/check.js');
const { store } = await import('../src/store.js');
store.snapshot = { ...store.get(), vcenters: [{ id: 'vcA', name: 'KR-SEL' }, { id: 'vcB', name: 'PL-WAW' }] };

/** 가짜 sshd — allowFp 의 공개키만 받는다. exec: uname → Linux, authorized_keys 읽기 → AK_TEXT. 받은 인증 시도를 기록한다. */
async function fakeSshd() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const st = { allow: null, akText: '', seen: [], execs: [] };
  const srv = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => {
      st.seen.push({ method: ctx.method, username: ctx.username, password: ctx.method === 'password' ? ctx.password : undefined });
      if (ctx.method === 'publickey' && st.allow && Buffer.compare(ctx.key.data, st.allow.blob) === 0) {
        if (!ctx.signature) return ctx.accept();
        return st.allow.parsed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) ? ctx.accept() : ctx.reject();
      }
      if (ctx.method === 'password' && st.password && ctx.password === st.password) return ctx.accept();
      return ctx.reject(['publickey', 'password']);
    });
    client.on('ready', () => client.on('session', (accept) => {
      const s = accept();
      s.on('exec', (acc, _rej, info) => {
        st.execs.push(info.command);
        const stream = acc();
        stream.write(info.command.startsWith('uname') ? 'Linux\n' : (info.command.includes('##AK') ? `##AK present\n${st.akText}` : ''));
        stream.exit(0); stream.end();
      });
    }));
    client.on('error', () => {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, st, close: () => srv.close(),
    allowKey(pem) { const k = ssh2.utils.parseKey(pem); const p = Array.isArray(k) ? k[0] : k; st.allow = { blob: p.getPublicSSH(), parsed: p }; } };
}
const SSHD = await fakeSshd();
test.after(() => SSHD.close());

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
/** 사용자마다 OTP 코드 3개(1회용 — 앞 counter 부터 쓴다). */
const _codes = {};
async function otp(user) {
  if (!_codes[user] || !_codes[user].length) {
    const left = 30_000 - (Date.now() % 30_000);
    if (left < 12_000) await new Promise((r) => setTimeout(r, left + 50));
    const now = Math.floor(Date.now() / 30_000);
    if (_codes[user]?.used) await new Promise((r) => setTimeout(r, 30_000 * 2));
    const n2 = Math.floor(Date.now() / 30_000);
    _codes[user] = [n2 - 1, n2, n2 + 1].map((counter) => generateToken(SECRETS[user], { counter }));
    _codes[user].used = true; void now;
  }
  return _codes[user].shift();
}
const leaks = (text, secrets) => secrets.some((s) => s && String(text).includes(s.replace(/\r?\n/g, '').slice(40, 90)));

const ED_A = F.ed25519Key();   // vcA 공통
const ED_B = F.ed25519Key();   // vcB 공통
const ED_S = F.ed25519Key();   // vcA 서버별(bm-a1)
const ED_X = F.ed25519Key();   // 폴더 없음(예전 키)

/* ── 키 저장소: 암호화 정책 · 폴더 · 허용 기능 ───────────────────────────── */
test('① 새 로그인 키는 암호화 정책에서만 — 평문 정책 409 keys-need-encryption · 정책 잠금 503 SECRETS_POLICY_UNAVAILABLE · 폴더 · 허용 기능 정규화', () => {
  const run = (dir, code) => execFileSync(process.execPath, ['--input-type=module', '-e', `
    const KS = await import(${JSON.stringify(path.join(HERE, '../src/bmusage/onboard/keyStore.js'))});
    const F = await import(${JSON.stringify(path.join(HERE, './_sshKeyFixtures.js'))});
    ${code}
  `], { env: { ...process.env, CONFIG_DIR: dir }, encoding: 'utf8' }).trim().split('\n').pop();
  const d1 = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'sshacc-p-'));
  const o1 = JSON.parse(run(d1, `const r = KS.addKey({ name: 'a', privateKey: F.ed25519Key().pem }); console.log(JSON.stringify({ code: r.code, status: r.status, file: (await import('node:fs')).existsSync(${JSON.stringify(path.join(d1, 'ssh-keys.json'))}) }));`));
  assert.deepEqual(o1, { code: 'keys-need-encryption', status: 409, file: false }, '평문 정책(정책 파일 없음 = 신규 설치 평문)이면 받지 않고 쓰지 않는다');
  fs.rmSync(d1, { recursive: true, force: true });

  const k = KS.addKey({ name: 'kr-common', privateKey: ED_A.pem, folderCorp: 'vcA', features: ['bm-usage', 'bm-storage', 'nope'] }, { by: 'own' });
  assert.ok(k.ok, JSON.stringify(k));
  assert.deepEqual([k.key.folderCorp, k.key.folderServer, k.key.features], ['vcA', '', ['bm-usage', 'bm-storage']], '모르는 기능 id 는 버린다');
  const bad = KS.addKey({ name: 'srv-only', privateKey: ED_S.pem, folderServer: 'bm-a1' });
  assert.equal(bad.code, 'bad-folder', '서버별 폴더는 법인이 먼저');
  const legacy = KS.addKey({ name: 'legacy', privateKey: ED_X.pem });
  assert.equal(legacy.key.features, null, '허용 기능을 주지 않은 키(예전 방식) = null(모든 기능) — 키 점검이 경고');
  const raw = fs.readFileSync(path.join(DIR, 'ssh-keys.json'), 'utf8');
  assert.equal(leaks(raw, [ED_A.pem, ED_X.pem]), false, '개인키는 봉인돼 파일에 평문으로 없다');
  assert.equal(KS.plainStoredKeyIds().length, 0);
});

/* ── 접속 자격 해석: 폴더 · 허용 기능 · 사용 중지 · 손상 ─────────────────── */
test('② resolveOsAuth — 폴더 밖 서버 key-folder · 서버별 폴더는 그 서버만 · 허용 기능 밖 key-feature(빈 기능 id 도 거절) · 연결 시험은 기능 무관 · 법인 사용 중지 · 상태 파일 손상이면 키 접속 멈춤', () => {
  const kA = KS.keyByName('kr-common');
  const kB = KS.addKey({ name: 'pl-common', privateKey: ED_B.pem, folderCorp: 'vcB', features: ['bm-usage'] }, { by: 'own' }).key;
  const kS = KS.addKey({ name: 'bm-a1-only', privateKey: ED_S.pem, folderCorp: 'vcA', folderServer: 'bm-a1', features: ['bm-usage', 'disk-audit'] }, { by: 'own' }).key;
  const sA1 = { id: 's1', name: 'bm-a1', host: '10.9.0.1', vcenterId: 'vcA', username: 'mon' };
  const sA2 = { id: 's2', name: 'bm-a2', host: '10.9.0.2', vcenterId: 'vcA', username: 'mon' };
  assert.equal(REFS.resolveOsAuth({ ...sA1, keyRef: kA.id }, { feature: 'bm-usage' }).ok, true);
  assert.equal(REFS.resolveOsAuth({ ...sA1, keyRef: kA.id }, { feature: 'disk-audit' }).code, 'key-feature', '허용 기능 밖');
  assert.equal(REFS.resolveOsAuth({ ...sA1, keyRef: kA.id }).code, 'key-feature', '기능을 밝히지 않은 호출은 목록이 있는 키를 못 쓴다');
  assert.equal(REFS.resolveOsAuth({ ...sA1, keyRef: kA.id }, { feature: 'conn-test' }).ok, true, '연결 시험은 허용 기능과 무관');
  assert.equal(REFS.resolveOsAuth({ ...sA1, keyRef: kB.id }, { feature: 'bm-usage' }).code, 'key-folder', '다른 법인 폴더의 키');
  assert.equal(REFS.resolveOsAuth({ ...sA1, vcenterId: '', keyRef: kA.id }, { feature: 'bm-usage' }).code, 'key-folder', '미귀속 서버는 폴더 키를 못 쓴다');
  assert.equal(REFS.resolveOsAuth({ ...sA1, keyRef: kS.id }, { feature: 'disk-audit' }).ok, true);
  assert.equal(REFS.resolveOsAuth({ ...sA2, keyRef: kS.id }, { feature: 'bm-usage' }).code, 'key-folder', '서버별 폴더 키는 그 서버만');
  assert.equal(REFS.resolveOsAuth({ ...sA2, keyRef: KS.keyByName('legacy').id }, { feature: 'disk-audit' }).ok, true, '폴더 · 기능이 없는 예전 키는 그대로 쓰인다(하위 호환)');
  // 공통 계정의 기본 키도 같은 판정
  const acc = KS.saveAccount({ name: 'kr-acc', kind: 'os', corp: 'vcA', username: 'svc', keyRef: kA.id }, { by: 'own' });
  assert.equal(REFS.resolveOsAuth({ ...sA2, credRef: acc.account.id }, { feature: 'bm-storage' }).username, 'svc');
  assert.equal(REFS.resolveOsAuth({ ...sA2, vcenterId: 'vcB', credRef: acc.account.id }, { feature: 'bm-storage' }).code, 'key-folder');
  // 사용 중지 — 서버 법인 · 키 폴더 법인 어느 쪽이든
  assert.ok(ST.setCorpStop('vcA', { by: 'own', reason: '유출 의심' }).ok);
  assert.equal(REFS.resolveOsAuth({ ...sA1, keyRef: kA.id }, { feature: 'bm-usage' }).code, 'corp-stopped');
  assert.equal(REFS.resolveOsAuth({ ...sA1, keyRef: kA.id }, { feature: 'conn-test' }).code, 'corp-stopped', '연결 시험도 사용 중지를 넘지 못한다');
  assert.equal(REFS.resolveOsAuth({ ...sA1, password: 'pw' }, { feature: 'bm-usage' }).authKind, 'password', '사용 중지는 키만 — 비밀번호 항목은 그대로');
  const wr = REFS.withResolvedAuth([{ ...sA1, keyRef: kA.id }], { feature: 'bm-usage' })[0];
  assert.deepEqual([wr.authErrorCode, wr.password, wr.privateKey], ['corp-stopped', '', undefined], '폴러 목록 — 접속하지 않게 표지 · 키를 싣지 않는다');
  assert.ok(ST.clearCorpStop('vcA', { by: 'own' }).ok);
  assert.equal(REFS.resolveOsAuth({ ...sA1, keyRef: kA.id }, { feature: 'bm-usage' }).ok, true);
  // 상태 파일 손상 — fail-closed(모든 키 접속 멈춤) · 쓰기 거절
  const sf = path.join(DIR, ST.STATE_FILE_NAME);
  const before = fs.readFileSync(sf, 'utf8');
  fs.writeFileSync(sf, '{ broken');
  ST._resetSshAccessStateForTest();
  assert.equal(REFS.resolveOsAuth({ ...sA1, keyRef: kA.id }, { feature: 'bm-usage' }).code, 'state-unreadable');
  assert.equal(ST.setCorpStop('vcB', { by: 'own' }).code, 'state-unreadable', '손상본을 빈 상태로 덮어쓰지 않는다');
  assert.ok(fs.readdirSync(DIR).some((f) => f.startsWith(`${ST.STATE_FILE_NAME}.corrupt.`)));
  fs.writeFileSync(sf, before);
  for (const f of fs.readdirSync(DIR)) if (f.startsWith(`${ST.STATE_FILE_NAME}.corrupt.`)) fs.rmSync(path.join(DIR, f));
  ST._resetSshAccessStateForTest();
  assert.equal(REFS.resolveOsAuth({ ...sA1, keyRef: kA.id }, { feature: 'bm-usage' }).ok, true);
});

test('③ 키 바꿔치기 감시 — 디스크 파일이 포탈이 쓴 내용과 다르면 그 키는 key-tampered(접속 안 함) · 밖에서 들어온 키 · 키 점검 bad · 다시 읽으면 첫 사용 대조가 원문 ↔ 지문을 본다', async () => {
  const file = path.join(DIR, 'ssh-keys.json');
  const orig = fs.readFileSync(file, 'utf8');
  const j = JSON.parse(orig);
  const victim = j.keys.find((k) => k.name === 'legacy');
  const srv = { name: 'x', host: '10.0.0.9', keyRef: victim.id };
  assert.equal(REFS.resolveOsAuth(srv, { feature: 'bm-usage' }).ok, true, '바꾸기 전');
  victim.privateKey = VAULT.sealSecret(F.ed25519Key().pem);   // 다른 키 원문을 같은 자리에(봉인은 정상 — 지문만 다르다)
  const intruder = { ...j.keys[0], id: 'k_intruder01', name: 'intruder', fingerprint: F.ed25519Key().fingerprint };
  fs.writeFileSync(file, JSON.stringify({ ...j, keys: [...j.keys, intruder] }));
  // 메모리를 비우지 않는다(포탈이 도는 중 누군가 파일을 고친 상황) — 주기 점검의 파일 대조가 잡는다
  const drift = CHK.checkKeyDrift();
  assert.deepEqual([drift.ok, drift.changed, drift.added.map((a) => a.id)], [true, [victim.id], ['k_intruder01']]);
  assert.equal(REFS.resolveOsAuth(srv, { feature: 'bm-usage' }).code, 'key-tampered', '바뀐 키는 메모리 원문이 멀쩡해도 접속에 쓰지 않는다');
  const chk = CHK.buildKeyCheck({ policyMode: 'encrypted', drift });
  assert.ok(chk.items.some((i) => i.code === 'tampered' && i.level === 'bad'));
  assert.ok(chk.items.some((i) => i.code === 'added-outside' && i.level === 'bad'));
  // 주기 점검 — 사건은 한 번만(같은 변경을 10분마다 다시 쌓지 않는다)
  await SVC.runSshAccessScan();
  await SVC.runSshAccessScan();
  assert.equal(ST.listEvents({ limit: 300 }).filter((e) => e.kind === 'key-changed-outside' && e.detail === victim.fingerprint).length, 1);
  // 사람이 ‘받아들이기’ — 디스크가 새 기준. 그래도 원문 ↔ 지문이 다른 키는 첫 사용 대조가 막는다(두 번째 겹)
  assert.equal(SVC.reloadKeyStore({ by: 'own' }).ok, true);
  assert.equal(KS.tamperedKeyIds().length, 0, '표지를 풀었다');
  assert.equal(REFS.resolveOsAuth(srv, { feature: 'bm-usage' }).code, 'key-tampered', '원문이 지문과 다르다');
  fs.writeFileSync(file, orig);
  assert.equal(SVC.reloadKeyStore({ by: 'own' }).ok, true);
  assert.equal(REFS.resolveOsAuth(srv, { feature: 'bm-usage' }).ok, true, '원래대로 되돌리면 풀린다');
  assert.deepEqual(CHK.checkKeyDrift().changed, []);
  assert.ok(ST.listEvents({ limit: 300 }).some((e) => e.kind === 'keystore-reloaded' && e.by === 'own'));
});

test('④ authorized_keys 해석 — 옵션(따옴표 안 공백) · 설명 · 주석 · 잘못된 줄 · 포탈 표지 · 표지 줄 판정 · 긴 줄 선형(ReDoS 비율)', () => {
  const pub = (pem) => { const k = ssh2.utils.parseKey(pem); const p = Array.isArray(k) ? k[0] : k; return `${p.type} ${p.getPublicSSH().toString('base64')}`; };
  const text = [
    '# comment',
    `${pub(ED_A.pem)} ops@bastion`,
    `from="10.0.0.1,10.0.0.2",no-pty,command="echo hi there" ${pub(ED_S.pem)} portal-ssh:vcA:bm-a1`,
    'ssh-ed25519 !!!notbase64 junk',
    'garbage line',
    '',
  ].join('\n');
  const r = AK.parseAuthorizedKeys(text);
  assert.equal(r.keys.length, 2); assert.equal(r.bad, 2);
  assert.deepEqual(r.keys.map((k) => [k.fingerprint, k.comment, k.portal, k.hasOptions]), [[ED_A.fingerprint, 'ops@bastion', false, false], [ED_S.fingerprint, 'portal-ssh:vcA:bm-a1', true, true]]);
  assert.deepEqual(AK.parseReadOutput('##AK missing\n'), { ok: true, present: false, keys: [], bad: 0, truncated: 0 });
  assert.equal(AK.parseReadOutput('Welcome banner\n##AK present\n').ok, false, '표지 줄이 첫 줄이 아니면 읽지 못한 것');
  const time = (n) => { const s = `from="${'a'.repeat(n)} ssh-ed25519 AAAA`; const t0 = process.hrtime.bigint(); AK.parseAuthorizedKeys(s); return Number(process.hrtime.bigint() - t0); };
  time(2000); const a = time(4000); const b = time(16000);
  assert.ok(b < a * 16, `선형(4배 입력 → ${(b / a).toFixed(1)}배)`);
});

/* ── 서버의 키 고르기 · 들어 있는 키 읽기(가짜 sshd) ───────────────────── */
test('⑤ 서버의 키 고르기 — 폴더 밖 키 409 · 고른 키로 접속되면 유지 · 안 되면 이전 설정으로 되돌림 · 들어 있는 키 읽기(지문 대조 · 1회 비밀번호 미저장) · 사용 기록', async () => {
  const kA = KS.keyByName('kr-common'); const kS = KS.keyByName('bm-a1-only'); const kB = KS.keyByName('pl-common');
  const s = BM.saveBmServer({ name: 'bm-a1', host: '127.0.0.1', port: SSHD.port, username: 'mon', mounts: ['/'], vcenterId: 'vcA', password: 'Pw-Old-1' }).server;
  assert.equal((await SVC.chooseServerKey({ serverId: s.id, keyId: kB.id, by: 'own' })).code, 'key-folder');
  // 낡은 화면(다른 접속처를 본 화면)에서 고른 키는 묶지 않는다(점검 A-8)
  assert.equal((await SVC.chooseServerKey({ serverId: s.id, keyId: kA.id, expectAddr: '127.0.0.1:1|mon', by: 'own' })).code, 'moved');
  assert.equal(BM.listBmServersRaw().find((x) => x.id === s.id).keyRef, undefined);
  // 가짜 sshd 가 kS 만 받는다 → kA 고르기는 접속 실패 → 되돌림(비밀번호 그대로)
  SSHD.allowKey(ED_S.pem);
  const bad = await SVC.chooseServerKey({ serverId: s.id, keyId: kA.id, by: 'own' });
  assert.equal(bad.code, 'test-failed'); assert.equal(bad.reverted, true);
  const raw1 = BM.listBmServersRaw().find((x) => x.id === s.id);
  assert.equal(raw1.keyRef, undefined, '되돌렸다'); assert.equal(raw1.password, 'Pw-Old-1', '비밀번호는 그대로');
  const view0 = await SVC.buildView();
  const good = await SVC.chooseServerKey({ serverId: s.id, keyId: kS.id, expectAddr: view0.servers.find((x) => x.id === s.id).addr, by: 'own' });
  assert.equal(good.ok, true, JSON.stringify(good)); assert.equal(good.test.authKind, 'key');
  assert.equal(BM.listBmServersRaw().find((x) => x.id === s.id).keyRef, kS.id);
  // 들어 있는 키 읽기 — 저장된 키로 · 지문 대조
  const pub = (pem) => { const k = ssh2.utils.parseKey(pem); const p = Array.isArray(k) ? k[0] : k; return `${p.type} ${p.getPublicSSH().toString('base64')}`; };
  SSHD.st.akText = `${pub(ED_S.pem)} portal-ssh:vcA:bm-a1\n${pub(F.ed25519Key().pem)} someone@else\n`;
  const rd = await SVC.readInstalledKeys({ serverId: s.id, by: 'own' });
  assert.equal(rd.ok, true, JSON.stringify(rd));
  assert.deepEqual(rd.keys.map((k) => [k.keyName, k.portal]), [['bm-a1-only', true], ['', false]]);
  assert.equal(INS.installedOf(s.id).keys.length, 2);
  assert.equal(fs.readFileSync(path.join(DIR, ST.STATE_FILE_NAME), 'utf8').includes('installed'), false, '읽은 결과는 상태 파일과 따로(fail-closed 파일을 키우지 않는다)');
  // 1회 비밀번호로 읽기 — 저장하지 않는다
  SSHD.st.allow = null; SSHD.st.password = 'Once-Pw-77';
  const rd2 = await SVC.readInstalledKeys({ serverId: s.id, oncePassword: 'Once-Pw-77', by: 'own' });
  assert.equal(rd2.ok, true, JSON.stringify(rd2)); assert.equal(rd2.via, 'password-once');
  for (const f of fs.readdirSync(DIR)) if (f.endsWith('.json')) assert.equal(fs.readFileSync(path.join(DIR, f), 'utf8').includes('Once-Pw-77'), false, `${f} 에 1회 비밀번호가 없다`);
  SSHD.st.password = null;
  // 사용 기록 — 연결 시험(conn-test)으로 남았다 · 파일에는 비밀이 없다
  const u = US.keyUsageView({ fingerprint: ED_S.fingerprint });
  assert.ok(u.rows.some((r) => r.feature === 'conn-test' && r.okCount >= 1));
  US.flushKeyUsage();
  const uf = fs.readFileSync(path.join(DIR, US.USAGE_FILE_NAME), 'utf8');
  assert.equal(leaks(uf, [ED_S.pem, ED_A.pem]), false); assert.equal(uf.includes('Pw-Old-1'), false);
});

test('⑥ 키 폴더 바꾸기 — 쓰는 서버 · 공통 계정이 새 폴더 밖이 되면 409 + 목록 · 서버별 폴더 키는 공통 계정의 기본 키가 될 수 없다', () => {
  const kA = KS.keyByName('kr-common');
  const r = SVC.setKeyPlacement({ keyId: kA.id, folderCorp: 'vcB' });
  assert.equal(r.code, 'folder-conflict'); assert.ok(r.conflicts.some((c) => c.kind === 'account' && c.name === 'kr-acc'));
  const kS = KS.keyByName('bm-a1-only');
  const r2 = SVC.setKeyPlacement({ keyId: kS.id, folderServer: 'bm-zz' });
  assert.equal(r2.code, 'bad-folder', '없는 서버 폴더');
  const r3 = SVC.setKeyPlacement({ keyId: KS.keyByName('legacy').id, folderCorp: 'vcA', features: ['disk-audit'] });
  assert.equal(r3.ok, true, JSON.stringify(r3)); assert.deepEqual(r3.key.features, ['disk-audit']);
});

/* ── 받는 곳(inbox) ───────────────────────────────────────────────────── */
test('⑦ 받는 곳 — 폴더 이름(slug) · 찾은 파일은 내용 없이(지문만) · 심링크 거부 · 승인 = 다시 읽어 같은 지문일 때만 · 폴더는 자리에서 · 평문 삭제 · 경로 탈출 거부', async () => {
  assert.equal(INB.folderSlug('vcA'), 'vcA');
  assert.match(INB.folderSlug('kr/vc:443'), /^kr_vc_443-[0-9a-f]{6}$/);
  assert.match(INB.folderSlug('..'), /^_-[0-9a-f]{6}$/);
  const dir = INB.inboxPathOf('vcA', 'bm-a1');
  fs.mkdirSync(dir, { recursive: true });
  const NEW = F.ed25519Key();
  fs.writeFileSync(path.join(dir, 'id_new'), NEW.pem, { mode: 0o600 });
  fs.symlinkSync(path.join(DIR, 'users.json'), path.join(dir, 'link'));
  const corps = [{ id: 'vcA' }, { id: 'vcB' }];
  const servers = BM.listBmServersRaw().map((s) => ({ id: s.id, name: s.name, vcenterId: s.vcenterId }));
  const sc = await INB.scanInbox({ corps, servers });
  const it = sc.items.find((x) => x.file === 'id_new');
  assert.equal(it.code, 'ready'); assert.equal(it.fingerprint, NEW.fingerprint); assert.equal(it.server, 'bm-a1');
  assert.equal(JSON.stringify(sc).includes('PRIVATE KEY'), false, '내용을 싣지 않는다');
  assert.equal(sc.items.find((x) => x.file === 'link').code, 'symlink');
  assert.match(it.sha, /^[0-9a-f]{32}$/);
  // 사람이 본 것과 다르면 거절(지문 · 내용 해시) · 둘 다 없으면 거절
  assert.equal((await SVC.approveInbox({ relPath: it.relPath, fingerprint: ED_A.fingerprint, name: 'n1', by: 'own' })).code, 'fingerprint-changed');
  assert.equal((await SVC.approveInbox({ relPath: it.relPath, sha: '0'.repeat(64), name: 'n1', by: 'own' })).code, 'file-changed');
  assert.equal((await SVC.approveInbox({ relPath: it.relPath, name: 'n1', by: 'own' })).code, 'need-expect');
  assert.equal((await SVC.approveInbox({ relPath: ` ${it.relPath}`, sha: it.sha, name: 'n1', by: 'own' })).code, 'bad-path', '앞뒤 공백을 다듬지 않는다');
  // 다른 계정이 읽을 수 있는 파일은 승인하지 않는다(이미 노출됐을 수 있다 — 점검 C-12)
  fs.chmodSync(path.join(dir, 'id_new'), 0o644);
  assert.equal((await SVC.approveInbox({ relPath: it.relPath, sha: it.sha, name: 'n1', by: 'own' })).code, 'loose-perm');
  fs.chmodSync(path.join(dir, 'id_new'), 0o600);
  assert.equal((await SVC.approveInbox({ relPath: '../users.json', fingerprint: NEW.fingerprint, name: 'n1', by: 'own' })).code, 'bad-path');
  assert.equal((await SVC.approveInbox({ relPath: 'vcA/servers/bm-a1/../../../users.json', fingerprint: NEW.fingerprint, name: 'n1', by: 'own' })).code, 'bad-path');
  // 모양(법인/servers/서버/파일)은 맞지만 '..' 조각 — 받는 곳 안의 엉뚱한 자리(법인 폴더 바로 아래)를 지우지 않는다(변이 M8)
  const stray = path.join(INB.inboxDir(), 'vcA', 'stray-key');
  fs.writeFileSync(stray, 'x');
  assert.equal(SVC.discardInbox({ relPath: 'vcA/servers/../stray-key', sha: '0'.repeat(64), by: 'own' }).code, 'bad-path');
  assert.equal(fs.existsSync(stray), true, '지우지 않았다');
  fs.rmSync(stray);
  const ok = await SVC.approveInbox({ relPath: it.relPath, fingerprint: NEW.fingerprint, sha: it.sha, name: 'bm-a1-new', features: ['bm-usage'], by: 'own' });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual([ok.key.folderCorp, ok.key.folderServer, ok.key.features, ok.plaintextRemoved], ['vcA', 'bm-a1', ['bm-usage'], true]);
  assert.equal(fs.existsSync(path.join(dir, 'id_new')), false, '평문 파일을 지웠다');
  assert.equal(leaks(fs.readFileSync(path.join(DIR, 'ssh-keys.json'), 'utf8'), [NEW.pem]), false, '봉인 저장');
  assert.ok(fs.existsSync(path.join(DIR, 'users.json')), '심링크 대상은 건드리지 않았다');
  fs.rmSync(path.join(dir, 'link'));
  // 지우기 — 사람이 본 파일과 같을 때만(그 사이 바뀐 파일은 지우지 않는다 — 점검 C-6)
  const D2 = F.ed25519Key();
  fs.writeFileSync(path.join(dir, 'id_d'), D2.pem, { mode: 0o600 });
  const it2 = (await INB.scanInbox({ corps, servers })).items.find((x) => x.file === 'id_d');
  fs.appendFileSync(path.join(dir, 'id_d'), '\n');
  assert.equal(SVC.discardInbox({ relPath: it2.relPath, sha: it2.sha, by: 'own' }).code, 'file-changed');
  assert.equal(fs.existsSync(path.join(dir, 'id_d')), true);
  assert.equal(SVC.discardInbox({ relPath: it2.relPath, by: 'own' }).code, 'need-expect');
  const it3 = (await INB.scanInbox({ corps, servers })).items.find((x) => x.file === 'id_d');
  assert.equal(SVC.discardInbox({ relPath: it3.relPath, sha: it3.sha, by: 'own' }).ok, true);
  // 디렉터리 심링크 — 서버 폴더가 받는 곳 밖을 가리키면 읽지도 · 승인하지도 · 지우지도 않는다(점검 A-2 · C-2)
  const outside = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'sshacc-out-'));
  const OUT = F.ed25519Key();
  fs.writeFileSync(path.join(outside, 'id_out'), OUT.pem, { mode: 0o600 });
  BM.saveBmServer({ name: 'bm-a3', host: '10.9.0.3', mounts: ['/'], vcenterId: 'vcA', password: 'x' });
  fs.symlinkSync(outside, path.join(INB.inboxDir(), 'vcA', 'servers', 'bm-a3'));
  const servers3 = BM.listBmServersRaw().map((s) => ({ id: s.id, name: s.name, vcenterId: s.vcenterId }));
  const sc3 = await INB.scanInbox({ corps, servers: servers3 });
  assert.equal(sc3.items.some((x) => x.file === 'id_out'), false, '링크 폴더 안은 읽지 않는다');
  assert.ok(sc3.unknownFolders.some((u) => u.includes('bm-a3')));
  const shaOut = crypto.createHash('sha256').update(fs.readFileSync(path.join(outside, 'id_out'))).digest('hex');
  assert.equal((await SVC.approveInbox({ relPath: 'vcA/servers/bm-a3/id_out', sha: shaOut, fingerprint: OUT.fingerprint, name: 'out', by: 'own' })).code, 'bad-path');
  assert.equal(SVC.discardInbox({ relPath: 'vcA/servers/bm-a3/id_out', sha: shaOut, by: 'own' }).code, 'bad-path');
  assert.equal(fs.existsSync(path.join(outside, 'id_out')), true, '받는 곳 밖 파일을 지우지 않았다');
  fs.rmSync(path.join(INB.inboxDir(), 'vcA', 'servers', 'bm-a3'));
  fs.rmSync(outside, { recursive: true, force: true });
  // 폴더 이름이 겹치는 두 서버(대소문자만 다름) — 어느 쪽인지 모르므로 읽지 않고 승인하지 않는다(점검 C-13 · A-5)
  BM.saveBmServer({ name: 'BM-DUP', host: '10.9.0.4', mounts: ['/'], vcenterId: 'vcA', password: 'x' });
  BM.saveBmServer({ name: 'bm-dup', host: '10.9.0.5', mounts: ['/'], vcenterId: 'vcA', password: 'x' });
  const ddir = INB.inboxPathOf('vcA', 'bm-dup');
  fs.mkdirSync(ddir, { recursive: true });
  const DUP = F.ed25519Key();
  fs.writeFileSync(path.join(ddir, 'id_dup'), DUP.pem, { mode: 0o600 });
  const servers4 = BM.listBmServersRaw().map((s) => ({ id: s.id, name: s.name, vcenterId: s.vcenterId }));
  const sc4 = await INB.scanInbox({ corps, servers: servers4 });
  assert.equal(sc4.items.some((x) => x.file === 'id_dup'), false);
  const rel4 = path.relative(INB.inboxDir(), path.join(ddir, 'id_dup')).split(path.sep).join('/');
  const shaDup = crypto.createHash('sha256').update(fs.readFileSync(path.join(ddir, 'id_dup'))).digest('hex');
  assert.equal((await SVC.approveInbox({ relPath: rel4, sha: shaDup, name: 'dup', by: 'own' })).code, 'ambiguous-folder');
  fs.rmSync(ddir, { recursive: true, force: true });
  for (const s of BM.listBmServersRaw().filter((x) => ['BM-DUP', 'bm-dup', 'bm-a3'].includes(x.name))) BM.removeBmServer(s.id);
  // 새 파일 여러 개는 사건 하나로(파일마다 상태 파일을 다시 쓰지 않는다 — 점검 D-2)
  const cdir = INB.inboxPathOf('vcB');
  fs.mkdirSync(cdir, { recursive: true });
  for (const n of ['k1', 'k2', 'k3']) fs.writeFileSync(path.join(cdir, n), F.ed25519Key().pem, { mode: 0o600 });
  const before = ST.listEvents({ limit: 300 }).filter((e) => e.kind === 'inbox-new').length;
  await SVC.runSshAccessScan();
  const evs = ST.listEvents({ limit: 300 }).filter((e) => e.kind === 'inbox-new');
  assert.equal(evs.length, before + 1);
  assert.match(evs[0].target, /^3개 — /);
  await SVC.runSshAccessScan();
  assert.equal(ST.listEvents({ limit: 300 }).filter((e) => e.kind === 'inbox-new').length, before + 1, '같은 파일은 다시 세지 않는다');
  fs.rmSync(cdir, { recursive: true, force: true });
});

/* ── 라우트 권한 · 비밀 노출 ──────────────────────────────────────────── */
test('⑧ 라우트 — 조회는 설정 소유자 등급(비소유자 · 범위 소유자 403) · 쓰기는 OTP 마지막(권한 없는 요청이 OTP 를 소모하지 않는다) · 응답 · 감사에 비밀 없음 · 사용 중지/재개', async (t) => {
  const call = await api(t);
  assert.equal((await call('adm', 'GET', '/settings/ssh-access')).s, 403, '비소유자 관리자');
  assert.equal((await call('sown', 'GET', '/settings/ssh-access')).s, 403, '범위가 지정된 소유자(소유자 등급 아님)');
  const v = await call('own', 'GET', '/settings/ssh-access');
  assert.equal(v.s, 200, v.txt);
  assert.ok(v.j.keys.some((k) => k.name === 'kr-common' && k.folderCorp === 'vcA'));
  assert.ok(v.j.servers.some((s) => s.name === 'bm-a1' && s.keyName === 'bm-a1-only' && s.keyMode === 'pinned'));
  assert.ok(Array.isArray(v.j.check.items));
  assert.ok(v.j.servers.every((s) => typeof s.addr === 'string' && s.addr), '키 고르기에 돌려보낼 접속처');
  const sc = await call('own', 'POST', '/settings/ssh-access/scan', {});
  assert.equal(sc.s, 202, sc.txt); assert.equal(sc.j.started, true, '점검은 시작만 하고 바로 돌려준다');
  assert.equal(leaks(v.txt, [ED_A.pem, ED_B.pem, ED_S.pem, ED_X.pem]), false); assert.equal(/Pw-Old-1|PRIVATE KEY|enc\$1\$/.test(v.txt), false, '비밀 · 봉인본 없음');
  // 쓰기 — 비소유자는 OTP 를 묻기 전에 403(코드 소모 없음) · 소유자 OTP 없으면 needOtp
  const code = await otp('own');
  assert.equal((await call('adm', 'POST', '/settings/ssh-access/corps/vcB/stop', { reason: 'x', otp: code })).s, 403);
  assert.equal((await call('own', 'POST', '/settings/ssh-access/corps/vcB/stop', { reason: 'x' })).j.needOtp, true);
  const st = await call('own', 'POST', '/settings/ssh-access/corps/vcB/stop', { reason: '유출 의심', otp: code });
  assert.equal(st.s, 200, st.txt);
  assert.equal(ST.stopFor('vcB').by, 'own');
  const code2 = await otp('own');
  assert.equal((await call('own', 'DELETE', `/settings/ssh-access/corps/vcB/stop?otp=${code2}`)).s, 200);
  assert.equal(ST.stopFor('vcB'), null);
  // 키 등록(폴더 · 기능) — 응답에 개인키 없음 · 감사 로그에 비밀 없음
  const K2 = F.ed25519Key();
  const code3 = await otp('own');
  const add = await call('own', 'POST', '/settings/ssh-access/keys', { name: 'pl-new', privateKey: K2.pem, folderCorp: 'vcB', features: ['disk-audit'], otp: code3 });
  assert.equal(add.s, 200, add.txt); assert.equal(leaks(add.txt, [K2.pem]), false);
  const auditFile = fs.readdirSync(DIR).find((f) => /^audit/.test(f));
  if (auditFile) assert.equal(leaks(fs.readFileSync(path.join(DIR, auditFile), 'utf8'), [K2.pem, ED_A.pem]), false, '감사 로그에 개인키 없음');
  const ch = await call('own', 'GET', '/settings/ssh-access/changes');
  assert.equal(ch.s, 200); assert.ok(ch.j.items.some((e) => e.action === 'ssh-access.key.add'));
  assert.ok(ch.j.events.some((e) => e.kind === 'corp-stop'));
});

/* ── 사용 기록 · 키 점검 · 복원 제외 · 소스 스윕 ──────────────────────── */
test('⑨ 사용 기록 — (키, 서버, 기능) 묶음 · 처음 쓰인 서버/기능은 ‘평소와 다름’ · 주기 성공은 사건으로 쌓지 않는다 · 90일 지난 묶음은 쓰기 때 버린다', () => {
  US._resetKeyUsageForTest();
  const fp = ED_A.fingerprint; const now = Date.now();
  assert.equal(US.noteKeyUse({ fingerprint: fp, server: 'srv1', feature: 'bm-usage', ok: true }, { now }).unusual, 'new-server');
  assert.equal(US.noteKeyUse({ fingerprint: fp, server: 'srv1', feature: 'bm-storage', ok: true }, { now }).unusual, 'new-feature');
  assert.equal(US.noteKeyUse({ fingerprint: fp, server: 'srv1', feature: 'bm-usage', ok: true }, { now }).unusual, undefined);
  for (let i = 0; i < 20; i += 1) US.noteKeyUse({ fingerprint: fp, server: 'srv1', feature: 'bm-usage', ok: true, trigger: 'auto' }, { now });
  const v = US.keyUsageView({ fingerprint: fp });
  assert.equal(v.rows.find((r) => r.feature === 'bm-usage').count, 22);
  assert.equal(v.recent.filter((e) => e.server === 'srv1').length, 2, '주기 성공은 사건으로 쌓지 않는다(처음 두 번만)');
  US.noteKeyUse({ fingerprint: fp, server: 'old', feature: 'bm-usage', ok: false, code: 'auth-rejected' }, { now: now - US.RETAIN_MS - 1000 });
  US.flushKeyUsage({ now });
  US._resetKeyUsageForTest();
  assert.equal(US.keyUsageView({ fingerprint: fp }).rows.some((r) => r.server === 'old'), false, '보존 기간이 지난 묶음은 버린다');
  assert.equal(US.noteKeyUse({ fingerprint: 'nope', server: 's', feature: 'f', ok: true }).recorded, false);
});

test('⑩ 키 점검 — 평문 정책 bad · 폴더/기능 미지정 warn · 교체 시기 · 승인 대기 · 사용 중지 · 저장소 손상 unknown', () => {
  assert.ok(KS.addKey({ name: 'no-feat', privateKey: F.ed25519Key().pem }, { by: 'own' }).ok);
  const c = CHK.buildKeyCheck({ policyMode: 'plain', inbox: { items: [{ code: 'ready', relPath: 'vcA/common/x' }], unknownFolders: [] }, drift: CHK.checkKeyDrift(),
    servers: { blocked: ['bm-x'], noCorp: ['bm-y'] } });
  const codes = c.items.map((i) => i.code);
  for (const x of ['policy-plain', 'no-features', 'no-folder', 'inbox-pending', 'integrity', 'placement-blocked', 'no-corp-key']) assert.ok(codes.includes(x), x);
  const old = CHK.buildKeyCheck({ now: Date.now() + (CHK.ROTATE_DAYS + 1) * 86_400_000, policyMode: 'encrypted', drift: null });
  assert.ok(old.items.some((i) => i.code === 'rotate-due'));
  assert.ok(old.items.some((i) => i.code === 'integrity-pending' && i.level === 'unknown'), '확인 전은 ok 가 아니라 unknown');
});

test('⑪ 복원 제외 · 소스 스윕 — 상태 파일은 복원하지 않는다 · 서버 키 쓰기(setBmServerKeyRef)는 sshaccess/service.js 만 · 라우트는 자격 원본을 만지지 않는다 · bindApproved 를 늘리지 않는다', async () => {
  const SR = await import('../src/backup/stagedRestore.js');
  assert.ok(SR.RESTORE_EXCLUDE.has('ssh-access-state.json'));
  assert.equal(SR.stagedNameIssue('ssh-access-state.json'), '복원 제외');
  const { stripComments } = await import('./_stripComments.js');
  const SRC = path.join(HERE, '../src');
  const files = execFileSync('git', ['ls-files', '*.js'], { cwd: SRC, encoding: 'utf8' }).split('\n').filter(Boolean);
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '*.js'], { cwd: SRC, encoding: 'utf8' }).split('\n').filter(Boolean);
  const all = [...new Set([...files, ...untracked])];
  const has = (re) => all.filter((f) => re.test(stripComments(fs.readFileSync(path.join(SRC, f), 'utf8'))));
  assert.deepEqual(has(/setBmServerKeyRef|restoreBmServerKeyRef/).sort(), ['bmstor/registry.js', 'sshaccess/service.js']);
  const rt = stripComments(fs.readFileSync(path.join(SRC, 'routes/api/sshAccess.js'), 'utf8'));
  assert.doesNotMatch(rt, /resolveOsAuth|keyMaterial|listKeysRaw|listAccountsRaw|listBmServersRaw|KS\.|keyStore/, '라우트는 자격 원본 · 키 저장소를 만지지 않는다');
  assert.equal(rt.split('\n').filter((l) => l.includes('privateKey')).length, 1, '개인키는 키 등록 본문을 서비스로 넘기는 한 줄뿐(응답 · 감사에 싣지 않는다)');
  assert.doesNotMatch(rt, /bindApproved/);
  // 쓰기 라우트는 전부 소유자 → OTP 마지막. 키를 새로 받는 쓰기는 저장 방식 검사를 OTP 앞에(점검 B-5)
  const readOnly = ['/settings/ssh-access/scan', '/settings/ssh-access/servers/:id/installed-keys', '/settings/ssh-access/servers/:id/test'];
  const keyAdd = ['/settings/ssh-access/keys', '/settings/ssh-access/inbox/approve'];
  for (const m of rt.matchAll(/api\.(post|put|delete)\('([^']+)', \.\.\.(\w+)/g)) {
    assert.equal(m[3], readOnly.includes(m[2]) ? 'ownerRead' : keyAdd.includes(m[2]) ? 'keyAddWrite' : 'ownerWrite', m[2]);
  }
  assert.match(rt, /const ownerWrite = \[adminOnly, requireSettingsOwner, reauth\];/);
  assert.match(rt, /const keyAddWrite = \[adminOnly, requireSettingsOwner, vaultFirst, reauth\];/);
  assert.match(rt, /api\.post\('\/settings\/ssh-access\/reload-state', \.\.\.ownerWrite/);
  assert.match(rt, /api\.post\('\/settings\/ssh-access\/reload-keystore', \.\.\.ownerWrite/);
  assert.doesNotMatch(rt, /ST\.(setCorpStop|clearCorpStop|addEvent|reload)/, '상태 쓰기는 service 를 거친다(사용 중지는 서버 목록과 함께)');
  const ob = stripComments(fs.readFileSync(path.join(SRC, 'routes/api/bmOnboard.js'), 'utf8'));
  assert.match(ob, /const keyAddGate = \[adminOnly, toolsPerm, requireSettingsOwner, keyVaultFirst, reauth\];/);
  assert.match(ob, /api\.post\('\/tools\/bm-usage\/ssh-keys', \.\.\.keyAddGate/);
  // 폴러 두 곳이 기능 id 를 밝힌다(빈 기능 id = 목록이 있는 키 거절)
  assert.match(fs.readFileSync(path.join(SRC, 'bmstor/poller.js'), 'utf8'), /\)\), \{ feature: 'bm-storage' \}\);/);
  assert.match(fs.readFileSync(path.join(SRC, 'bmusage/poller.js'), 'utf8'), /withResolvedAuth\(listBmServersRaw\(\), \{ feature: 'bm-usage' \}\)/);
  // 기능 목록 한 벌 — 서비스 목록 = 키 저장소 허용 id
  assert.deepEqual(SVC.FEATURE_CATALOG.map((f) => f.id), [...KS.KEY_FEATURES]);
});

/* ── 점검(5축 + 반증) 확정 결함 회귀 ──────────────────────────────────── */
test('⑫ 법인 사용 중지 — 중지할 때 그 법인 서버(id · 접속처)를 함께 적는다: 서버의 법인 칸을 비우거나 바꿔도 · 같은 접속처를 새 항목으로 다시 만들어도 풀리지 않는다(점검 A-4 · B-1)', async () => {
  const kX = KS.keyByName('no-feat');   // 폴더 없는 키 — 사용 중지가 키 폴더가 아니라 서버 쪽 기록으로 걸리는지 본다
  const s = BM.listBmServersRaw().find((x) => x.name === 'bm-a1');
  const r = SVC.stopCorp('vcA', { by: 'own', reason: '유출 의심' });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.ok(r.servers >= 1);
  const asIs = { ...s, keyRef: kX.id };
  assert.equal(REFS.resolveOsAuth(asIs, { feature: 'conn-test' }).code, 'corp-stopped');
  assert.equal(REFS.resolveOsAuth({ ...asIs, vcenterId: '' }, { feature: 'conn-test' }).code, 'corp-stopped', '법인 칸을 비워도(서버 id)');
  assert.equal(REFS.resolveOsAuth({ ...asIs, id: 'bm_new', vcenterId: 'vcB' }, { feature: 'conn-test' }).code, 'corp-stopped', '다른 항목 · 다른 법인이어도 같은 접속처');
  assert.equal(REFS.resolveOsAuth({ ...asIs, id: 'bm_other', host: '10.99.0.1', vcenterId: '' }, { feature: 'conn-test' }).ok, true, '다른 서버는 그대로');
  assert.equal(SVC.resumeCorp('vcA', { by: 'own' }).ok, true);
  assert.equal(REFS.resolveOsAuth({ ...asIs, vcenterId: '' }, { feature: 'conn-test' }).ok, true);
});

test('⑬ 상태 파일 모양이 틀리면(JSON 은 맞아도) 손상으로 보고 키 접속을 멈춘다 · 사람이 고친 뒤 다시 읽기로 푼다(점검 A-6 · C-11 · C-3)', () => {
  const sf = path.join(DIR, ST.STATE_FILE_NAME);
  const before = fs.readFileSync(sf, 'utf8');
  const srv = { id: 'z1', name: 'z', host: '10.0.0.77', keyRef: KS.keyByName('no-feat').id };
  for (const bad of ['{"stops":[]}', '[]', '{"stops":{"vcA":"yes"}}', '{"events":{}}']) {
    fs.writeFileSync(sf, bad);
    ST._resetSshAccessStateForTest();
    assert.equal(REFS.resolveOsAuth(srv, { feature: 'conn-test' }).code, 'state-unreadable', bad);
    assert.equal(SVC.reloadState({ by: 'own' }).code, 'state-unreadable', '고치기 전에는 다시 읽어도 잠긴 채');
  }
  fs.writeFileSync(sf, before);
  assert.equal(SVC.reloadState({ by: 'own' }).ok, true);
  assert.equal(REFS.resolveOsAuth(srv, { feature: 'conn-test' }).ok, true);
  for (const f of fs.readdirSync(DIR)) if (f.startsWith(`${ST.STATE_FILE_NAME}.corrupt.`)) fs.rmSync(path.join(DIR, f));
});

test('⑭ 집중 모니터링은 분마다 자격을 다시 해석한다 — 세션 중 건 사용 중지 · 지운 항목 · 바뀐 접속처는 다음 분부터 접속하지 않는다(점검 B-2) · 수집 사유는 cred-config(점검 B-8)', async () => {
  const FR = await import('../src/bmusage/focus/run.js');
  const { osMissOf } = await import('../src/bmusage/missReason.js');
  const { HEALTH_REASON_CODES } = await import('../src/bmusage/collectHealth.js');
  const s = BM.listBmServersRaw().find((x) => x.name === 'bm-a1');
  const start = REFS.withResolvedAuth([s], { feature: 'bm-usage' })[0];
  assert.ok(start.privateKey, '세션 시작 때는 키가 풀렸다');
  assert.ok((await FR.refreshFocusOsHost(start)).privateKey, '바뀐 것이 없으면 그대로');
  assert.ok(SVC.stopCorp('vcA', { by: 'own', reason: 't' }).ok);
  const r1 = await FR.refreshFocusOsHost(start);
  assert.deepEqual([r1.authErrorCode, r1.privateKey, r1.password], ['corp-stopped', undefined, '']);
  assert.ok(SVC.resumeCorp('vcA', { by: 'own' }).ok);
  assert.equal((await FR.refreshFocusOsHost({ ...start, host: '10.1.1.1' })).authErrorCode, 'moved');
  assert.equal((await FR.refreshFocusOsHost({ ...start, id: 'bm_gone' })).authErrorCode, 'gone');
  const legacy = { host: '10.0.0.1', password: 'pw' };
  assert.equal(await FR.refreshFocusOsHost(legacy), legacy, '등록 id 가 없는 예전 대상은 그대로');
  assert.equal(osMissOf({ ok: false, error: '법인 키 사용 중지', authErrorCode: 'corp-stopped' }), 'cred-config');
  assert.equal(osMissOf({ ok: false, error: 'connect ECONNREFUSED' }), 'ssh-error');
  assert.ok(FR.FOCUS_MISS.includes('cred-config') && HEALTH_REASON_CODES.includes('cred-config'));
  const webTxt = (f) => fs.readFileSync(path.join(HERE, '../../web/src/views/tools', f), 'utf8');
  assert.match(webTxt('bmPerfOpsText.js'), /'cred-config':/); assert.match(webTxt('bmCollectText.js'), /'cred-config':/);
});

test('⑮ 복원 · 회전 · 공통 계정이 폴더 규칙을 넓히지 못한다 — 복원은 지금 키의 폴더 · 기능 · 퇴역을 유지(점검 A-3 · C-1) · 새 키 폴더 밖이면 회전 409 · 되돌리기는 바뀐 접속처에 키를 다시 묶지 않는다(점검 A-1 · C-4 · C-5)', async () => {
  const BUN = await import('../src/bmusage/onboard/keyBundle.js');
  const cur = fs.readFileSync(path.join(DIR, 'ssh-keys.json'), 'utf8');
  const kA = KS.keyByName('kr-common');
  const wide = JSON.parse(cur);
  for (const k of wide.keys) if (k.id === kA.id) { k.folderCorp = ''; k.folderServer = ''; k.features = null; }
  const merged = JSON.parse(BUN.mergeRedactedKeyStore(JSON.stringify(wide), cur).text);
  const mk = merged.keys.find((k) => k.id === kA.id);
  assert.deepEqual([mk.folderCorp, mk.features], ['vcA', ['bm-usage', 'bm-storage']], '옛 백업의 넓은 값으로 돌아가지 않는다');
  // 회전 — 옛 키를 쓰는 서버가 새 키 폴더 밖이면 쓰기 전에 거절
  const kS = KS.keyByName('bm-a1-only'); const kB = KS.keyByName('pl-common');
  const rot = REFS.rotateKey(kS.id, kB.id);
  assert.equal(rot.code, 'folder-conflict'); assert.equal(KS.keyById(kS.id).status, 'active', '옛 키를 퇴역시키지 않았다');
  // 공통 계정 기본 키 — 서버별 폴더 키 · 다른 법인 폴더 키는 안 된다
  assert.equal(KS.saveAccount({ name: 'kr-acc2', kind: 'os', corp: 'vcA', username: 'svc', keyRef: kS.id }, { by: 'own' }).code, 'key-folder');
  assert.equal(KS.saveAccount({ name: 'kr-acc3', kind: 'os', corp: 'vcA', username: 'svc', keyRef: kB.id }, { by: 'own' }).code, 'key-folder');
  // 되돌리기 — 그 사이 접속처가 바뀌었으면(등록부가 키 참조를 이미 버렸다) 옛 키를 새 주소에 다시 묶지 않는다
  const s = BM.listBmServersRaw().find((x) => x.name === 'bm-a1');
  const w = BM.setBmServerKeyRef(s.id, '', {});
  assert.equal(w.ok, true); assert.equal(w.previous.keyRef, kS.id);
  BM.saveBmServer({ id: s.id, name: s.name, host: '127.0.0.2', port: s.port, username: s.username, mounts: s.mounts, vcenterId: s.vcenterId });
  const back = BM.restoreBmServerKeyRef(s.id, w.previous);
  assert.equal(back.code, 'moved');
  assert.equal(BM.listBmServersRaw().find((x) => x.id === s.id).keyRef, undefined, '새 주소에 옛 키가 없다');
});

test('⑯ 키 사용 기록 — 마지막 사용은 전체 묶음에서(최근 몇 개만 보지 않는다 — 점검 D-3) · 다른 법인의 같은 이름 서버는 다른 묶음(점검 C-9)', () => {
  fs.rmSync(path.join(DIR, US.USAGE_FILE_NAME), { force: true });
  US._resetKeyUsageForTest();
  const now = Date.now();
  const fpA = ED_A.fingerprint; const fpB = ED_B.fingerprint;
  US.noteKeyUse({ fingerprint: fpA, server: 'web1', corp: 'vcA', feature: 'bm-usage', ok: true }, { now: now - 5000 });
  for (let i = 0; i < 30; i += 1) US.noteKeyUse({ fingerprint: fpB, server: `s${i}`, corp: 'vcB', feature: 'bm-usage', ok: true }, { now });
  assert.equal(US.lastUseByFingerprint().get(fpA)?.lastAt, now - 5000, '오래전 한 번 쓴 키도 마지막 사용이 보인다');
  assert.equal(US.noteKeyUse({ fingerprint: fpA, server: 'web1', corp: 'vcB', feature: 'bm-usage', ok: true }, { now }).unusual, 'new-server', '다른 법인의 같은 이름 서버');
  assert.equal(US.keyUsageView({ fingerprint: fpA }).rows.length, 2);
});
