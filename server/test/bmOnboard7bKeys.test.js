/**
 * 7b단계 SSH 키 저장소 — 키 판정 · 저장(봉인 · 0600 · 손상 보존 · 쓰기 거절) · 사용처 · 회전 · 삭제 · 접속 자격 해석 · 주소 변경 시 참조 승계 0 ·
 * 실제 api 라우터 권한(관리자 조회 · 설정 소유자 등급 + 본인 OTP · 범위 소유자 403 · OTP 소모 순서) · 비밀 노출 스윕(응답 · 감사 로그 · 백업/엣지 push 번들).
 * 키는 node:crypto 로 매 실행 새로 만든다(test/_sshKeyFixtures.js — CI 러너에 ssh-keygen 없음).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm7bkeys-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.SETTINGS_OWNERS = 'own,sown';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HERE = path.dirname(fileURLToPath(import.meta.url));

const F = await import('./_sshKeyFixtures.js');
const { generateSecret, generateToken } = await import('../src/auth/totp.js');
const SECRET = generateSecret();
fs.writeFileSync(path.join(DIR, 'users.json'), JSON.stringify({ users: [
  { username: 'own', role: 'admin', totpEnabled: true, totpSecret: SECRET },
  { username: 'sown', role: 'admin', scope: { vcenters: ['vcA'] } },
  { username: 'adm', role: 'admin' },
  { username: 'v', role: 'viewer' },
] }));
const VAULT = await import('../src/security/secretVault.js');
VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
const P = await import('../src/bmusage/onboard/keyParse.js');
const KS = await import('../src/bmusage/onboard/keyStore.js');
// v3.10.0: 두 사람 승인(기본 켬)이면 이 화면의 키 등록 · 교체 · 삭제는 409 로 SSH 공용 접속 화면에 보낸다 — 이 파일은 7b 본래 동작을 본다(끄고 시작 · 켠 동작은 sshKeyLogin3100).
(await import('../src/sshaccess/state.js')).setGuards({ twoPerson: false }, { by: 'test' });
const REFS = await import('../src/bmusage/onboard/refs.js');
const BM = await import('../src/bmstor/registry.js');

const ED = F.ed25519Key();
const ED2 = F.ed25519Key();
const RSA = F.rsaKey(3072, 'pw-rsa');
const body64 = (pem) => pem.split('\n').filter((l) => l && !l.startsWith('-----')).join('');   // 키 본문(base64) — 어디에도 나오면 안 된다
const leaks = (text, pems) => pems.some((pem) => { const b = body64(pem); return text.includes(b.slice(0, 40)) || text.includes(b.slice(-40)); });

test('① 키 판정 — ed25519 · RSA≥2048 · ECDSA 허용 / DSA · RSA<2048 · 공개키만 · 암호 미입력 · 틀린 passphrase · 형식 오류 · 두 개 거부 · 지문은 ssh-keygen 표기', () => {
  const ok = P.parsePrivateKey(ED.pem);
  assert.equal(ok.ok, true);
  assert.equal(ok.algo, 'ed25519'); assert.equal(ok.bits, 256); assert.equal(ok.recommended, true);
  assert.equal(ok.fingerprint, ED.fingerprint, '지문 = base64(sha256(공개키 blob)) — 끝 = 없음');
  assert.match(ok.publicKey, /^ssh-ed25519 AAAA[0-9A-Za-z+/]+=*$/);
  assert.equal(leaks(JSON.stringify(ok), [ED.pem]), false, '판정 결과에 개인키가 없다');
  assert.equal(P.parsePrivateKey(F.rsaKey(2048).pem).bits, 2048);
  assert.equal(P.parsePrivateKey(F.ecKey().pem).algo, 'ecdsa');
  assert.equal(P.parsePrivateKey(F.dsaKey().pem).code, 'weak-dsa');
  assert.equal(P.parsePrivateKey(F.rsaKey(1024).pem).code, 'weak-rsa');
  assert.equal(P.parsePrivateKey(ok.publicKey).code, 'public-only');
  assert.equal(P.parsePrivateKey(RSA.pem).code, 'need-passphrase');
  assert.equal(P.parsePrivateKey(RSA.pem, 'nope').code, 'bad-passphrase');
  assert.equal(P.parsePrivateKey(RSA.pem, 'pw-rsa').ok, true);
  assert.equal(P.parsePrivateKey('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n').code, 'unsupported-format');
  assert.equal(P.parsePrivateKey(ED.pem + ED2.pem).code, 'multi-key');
  assert.equal(P.parsePrivateKey('x'.repeat(P.KEY_TEXT_MAX + 1)).code, 'too-long');
  assert.equal(P.parsePrivateKey('').code, 'empty');
  for (const c of Object.keys(P.KEY_REJECT)) assert.equal(/`/.test(P.KEY_REJECT[c]), false, `${c}: 화면 문구에 백틱 금지`);
});

test('② 비밀 원문 칸 판정 — 키 블록 · 공개키 줄 · password= · 비밀번호: · 긴 base64 / 일반 이름 · 경로 · 메모는 아니다 · 긴 입력도 선형', () => {
  // 7b 반증 F11 표본(rv7b/h8): 소문자 머리글 · 머리글 없는 본문(여러 줄 · 한 줄 · 공백으로 이음) · PuTTY ppk · '"pw"="x"' · 'pw    = x'
  const body = ED.pem.split('\n').filter((l) => l && !l.startsWith('-----'));
  const F11 = [ED.pem.toLowerCase(), body.join('\n'), body[0], body.join(' '), 'PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none', 'Private-Lines: 1', '"pw"="Secret1"', 'pw    = Secret1'];
  for (const s of [ED.pem, `ssh-ed25519 ${'A'.repeat(68)}`, 'password=Abc!1', 'PW: x', '비밀번호: 1234', ...F11]) assert.equal(P.cellLooksSecret(s), true, s.slice(0, 30));
  for (const s of ['kr-ops-ed25519', '/; /data', 'bm-kr1-db01', '비밀번호는 현장 관리', 'mypw=1', '10.20.3.4', '', 'this server hosts the primary database for the finance reporting team in seoul',
    '/var/lib/postgresql/data/base/12345/67890', `x ${'Q'.repeat(90)}`]) assert.equal(P.cellLooksSecret(s), false, s);
  // ReDoS 회귀는 비율로(절대 시간 단언 금지 — CI 러너 편차): 입력이 50배 길어도 시간이 길이에 비례해 늘지 않는다(앞 4KB 만 본다).
  const time = (s) => { const t0 = process.hrtime.bigint(); for (let i = 0; i < 20; i += 1) P.cellLooksSecret(s); return Number(process.hrtime.bigint() - t0); };
  time('p'.repeat(4000));
  const small = time('p:'.repeat(2000)); const big = time('p:'.repeat(100_000));
  assert.ok(big < small * 10, `긴 입력 비율 ${(big / small).toFixed(1)} — 길이를 먼저 자른다`);
});

test('③ 저장 — 암호화 모드에서 개인키 · passphrase 봉인 · 0600 · 같은 이름/같은 키 거부 · 보이는 모양엔 지문 · 공개키만', () => {
  const a = KS.addKey({ name: 'kr-ops-ed25519', privateKey: ED.pem, rotateAt: '2027-01-31' }, { by: 'own' });
  assert.equal(a.ok, true, a.reason);
  const b = KS.addKey({ name: 'kr-rsa', privateKey: RSA.pem, passphrase: 'pw-rsa' }, { by: 'own' });
  assert.equal(b.ok, true, b.reason);
  const raw = fs.readFileSync(path.join(DIR, 'ssh-keys.json'), 'utf8');
  assert.equal(leaks(raw, [ED.pem, RSA.pem]), false, '디스크에 개인키 평문 없음');
  assert.equal(raw.includes('pw-rsa'), false, 'passphrase 평문 없음');
  const j = JSON.parse(raw);
  assert.ok(j.keys.every((k) => VAULT.isSealed(k.privateKey)), '개인키는 봉인');
  assert.equal(VAULT.isSealed(j.keys[1].passphrase), true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(DIR, 'ssh-keys.json')).mode & 0o777, 0o600);
  assert.equal(KS.addKey({ name: 'KR-OPS-ED25519', privateKey: ED2.pem }).code, 'dup-name');
  assert.equal(KS.addKey({ name: 'other', privateKey: ED.pem }).code, 'dup-key');
  assert.equal(KS.addKey({ name: 'password', privateKey: ED2.pem }).code, 'bad-name', 'CSV 예약어');
  assert.equal(KS.addKey({ name: 'x;rm', privateKey: ED2.pem }).code, 'bad-name');
  const view = REFS.listKeysView();
  assert.equal(view.keys.length, 2);
  const s = JSON.stringify(view);
  assert.equal(leaks(s, [ED.pem, RSA.pem]) || s.includes('privateKey') || s.includes('pw-rsa'), false, `보이는 모양에 비밀 없음: ${s.slice(0, 200)}`);
  assert.equal(view.keys[0].fingerprint, ED.fingerprint);
  assert.equal(view.keys[0].servers, 0, '등록부를 읽었고 쓰는 서버가 없으면 0');
  // 원본은 keyMaterial 하나로만 — 접속 직전
  const m = KS.keyMaterial(a.key.id);
  assert.equal(m.ok, true); assert.equal(m.privateKey, ED.pem);
});

test('④ 주소가 바뀌면 키 · 공통 계정 참조를 승계하지 않는다(host · port · 계정) · agent 변경은 승계 · 요청이 다시 고르면 그 값', () => {
  const k = KS.keyByName('kr-ops-ed25519');
  const acc = KS.saveAccount({ name: 'kr-ops', kind: 'os', corp: 'vcA', username: 'monitor', keyRef: k.id }, { by: 'own' });
  assert.equal(acc.ok, true, acc.reason);
  // r3(R-N1): 참조를 주소에 묶는 쓰기는 게이트를 통과한 호출만(bindApproved) — 이 테스트의 '묶어 둔 상태' 는 승인된 쓰기로 만든다.
  const s1 = BM.saveBmServer({ name: 'bm1', host: '10.1.1.1', username: 'monitor', mounts: ['/'], keyRef: k.id, credRef: acc.account.id, bindApproved: true });
  assert.equal(s1.ok, true, s1.reason);
  const id = s1.server.id;
  for (const change of [{ host: '10.1.1.2' }, { port: 2222 }, { username: 'other' }]) {
    BM.saveBmServer({ id, name: 'bm1', host: '10.1.1.1', port: 22, username: 'monitor', mounts: ['/'], keyRef: k.id, credRef: acc.account.id, bindApproved: true });
    const r = BM.saveBmServer({ id, name: 'bm1', host: '10.1.1.1', port: 22, username: 'monitor', mounts: ['/'], ...change });
    assert.deepEqual([...(r.droppedSecrets || [])].sort(), ['credRef', 'keyRef', 'password'].filter((x) => x !== 'password'), JSON.stringify(change));
    const raw = BM.listBmServersRaw().find((x) => x.id === id);
    assert.equal(raw.keyRef, undefined, `${JSON.stringify(change)} → keyRef 남음`);
    assert.equal(raw.credRef, undefined);
  }
  // agent 만 바뀌면 승계(위임 수집에 필요 — 기존 규칙 그대로)
  BM.saveBmServer({ id, name: 'bm1', host: '10.1.1.1', port: 22, username: 'monitor', mounts: ['/'], keyRef: k.id, bindApproved: true });
  const r2 = BM.saveBmServer({ id, name: 'bm1', host: '10.1.1.1', port: 22, username: 'monitor', mounts: ['/'], agent: 'edge-x' });
  assert.equal(r2.droppedSecrets, undefined);
  assert.equal(BM.listBmServersRaw().find((x) => x.id === id).keyRef, k.id);
  // 주소를 바꾸며 키를 다시 고르면 — 승인(bindApproved) 없이는 묶지 않는다(choke point · bindRefused) · 승인된 쓰기만 그 값
  const r3n = BM.saveBmServer({ id, name: 'bm1', host: '10.1.1.9', port: 22, username: 'monitor', mounts: ['/'], agent: '', keyRef: k.id });
  assert.equal(r3n.ok, true); assert.equal(r3n.bindRefused, true);
  assert.deepEqual(r3n.droppedSecrets, ['keyRef']);
  assert.equal(BM.listBmServersRaw().find((x) => x.id === id).keyRef, undefined, '승인 없는 주소 이동 + 같은 키 = 버림');
  BM.saveBmServer({ id, name: 'bm1', host: '10.1.1.1', port: 22, username: 'monitor', mounts: ['/'], keyRef: k.id, bindApproved: true });
  const r3 = BM.saveBmServer({ id, name: 'bm1', host: '10.1.1.9', port: 22, username: 'monitor', mounts: ['/'], agent: '', keyRef: k.id, bindApproved: true });
  assert.equal((r3.droppedSecrets || []).includes('keyRef'), false);
  assert.equal(r3.bindRefused, undefined);
  assert.equal(BM.listBmServersRaw().find((x) => x.id === id).keyRef, k.id);
  assert.equal('bindApproved' in BM.listBmServersRaw().find((x) => x.id === id), false, '승인 표지는 등록부에 저장하지 않는다');
  // 공통 계정: 법인 · 계정명이 바뀌면 비밀 · 기본 키를 잇지 않는다
  const acc2 = KS.saveAccount({ name: 'kr-pw', kind: 'os', corp: 'vcA', username: 'u1', password: 'Secret-1' });
  const moved = KS.saveAccount({ id: acc2.account.id, corp: 'vcB' });
  assert.deepEqual(moved.droppedSecrets || [], [], '비밀번호만 있는 계정 — 이동하면 비밀이 없어져 거부되거나 비어야 한다');
  assert.equal(moved.ok, false, '비밀번호를 다시 넣지 않으면 OS 계정은 비밀이 없어 거부');
  assert.equal(KS.accountById(acc2.account.id).password, 'Secret-1', '거부되면 저장 값 그대로');
});

test('⑤ 접속 자격 해석 — 서버 키 > 계정 기본 키 > 계정 비밀번호 > 서버 비밀번호 · 키가 없으면 비밀번호로 몰래 넘어가지 않는다 · 키 인증엔 비밀번호를 보내지 않는다', () => {
  const k = KS.keyByName('kr-ops-ed25519');
  const accK = KS.accountByName('os', 'kr-ops');
  let a = REFS.resolveOsAuth({ host: 'h', username: 'monitor', password: 'srv-pw', keyRef: k.id });
  assert.equal(a.authKind, 'key'); assert.equal(a.password, ''); assert.equal(a.keyFingerprint, ED.fingerprint);
  a = REFS.resolveOsAuth({ host: 'h', username: '', password: 'srv-pw', credRef: accK.id });
  assert.equal(a.authKind, 'key'); assert.equal(a.username, 'monitor', '계정명은 공통 계정에서');
  a = REFS.resolveOsAuth({ host: 'h', username: 'x', password: 'srv-pw', keyRef: 'k_000000000000' });
  assert.equal(a.ok, false); assert.equal(a.code, 'key-missing');
  a = REFS.resolveOsAuth({ host: 'h', username: 'x', password: 'srv-pw', credRef: 'a_000000000000' });
  assert.equal(a.code, 'account-missing');
  a = REFS.resolveOsAuth({ host: 'h', username: 'x', password: 'srv-pw' });
  assert.equal(a.authKind, 'password'); assert.equal(a.password, 'srv-pw');
  const list = REFS.withResolvedAuth([{ id: 's1', host: 'h', password: 'srv-pw', keyRef: 'k_000000000000' }, { id: 's2', host: 'h', password: 'p2' }]);
  assert.equal(list[0].password, '', '해석 실패 항목은 비밀번호를 비운다');
  assert.match(list[0].authError, /키 저장소에 없습니다/);
  assert.equal(list[1].password, 'p2', '예전 항목은 그대로');
});

test('⑥ 사용처 · 삭제 · 회전 — 쓰는 서버가 있으면 409 · 회전은 서버 → 계정 → 퇴역 순 · 바뀐 서버 목록 · 등록부를 못 읽으면 사용처 모름(삭제 거절)', () => {
  const k = KS.keyByName('kr-ops-ed25519');
  const view = REFS.listKeysView().keys.find((x) => x.id === k.id);
  assert.ok(view.servers >= 1 && view.accountsUsing >= 1, JSON.stringify(view));
  const del = REFS.deleteKeyIfUnused(k.id);
  assert.equal(del.code, 'in-use'); assert.equal(del.status, 409);
  const nk = KS.addKey({ name: 'kr-ops-2027', privateKey: ED2.pem }, { by: 'own' });
  assert.equal(nk.ok, true, nk.reason);
  const rot = REFS.rotateKey(k.id, nk.key.id);
  assert.equal(rot.ok, true, rot.reason);
  assert.ok(rot.servers.length >= 1);
  assert.equal(BM.listBmServersRaw().filter((s) => s.keyRef === k.id).length, 0, '옛 키를 가리키는 서버 0');
  assert.equal(KS.accountByName('os', 'kr-ops').keyRef, nk.key.id);
  assert.equal(KS.keyById(k.id).status, 'retired');
  assert.equal(REFS.deleteKeyIfUnused(k.id).ok, true, '사용처 0 이면 지운다');
  assert.equal(KS.keyById(k.id), null);
  // 등록부 손상 → 사용처 모름 → 삭제 거절(0 으로 지어내지 않는다)
  const file = path.join(DIR, 'bm-storage.json');
  const saved = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, '{ not json');
  const regMod = BM; void regMod;
  // 등록부 모듈은 캐시를 들고 있다 — 새 프로세스로 확인한다(아래 ⑦ 의 자식 실행과 같은 방식).
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const R = await import(${JSON.stringify(path.join(HERE, '../src/bmusage/onboard/refs.js'))});
    const KS = await import(${JSON.stringify(path.join(HERE, '../src/bmusage/onboard/keyStore.js'))});
    const k = KS.keyByName('kr-rsa');
    const v = R.listKeysView().keys.find((x) => x.id === k.id);
    console.log(JSON.stringify({ servers: v.servers, del: R.deleteKeyIfUnused(k.id).code, known: R.listKeysView().usageKnown }));
  `], { env: { ...process.env, CONFIG_DIR: DIR }, encoding: 'utf8' });
  const o = JSON.parse(out.trim().split('\n').pop());
  assert.equal(o.servers, null, '등록부를 못 읽으면 사용처는 null(—)');
  assert.equal(o.del, 'usage-unknown');
  assert.equal(o.known, false);
  for (const f of fs.readdirSync(DIR)) if (f.startsWith('bm-storage.json.corrupt.')) fs.rmSync(path.join(DIR, f));
  fs.writeFileSync(file, saved);
});

test('⑦ 손상 · 정책 잠금 — 손상이면 보존본을 남기고 쓰기 거절(503) · 정책을 못 읽으면 SECRETS_POLICY_UNAVAILABLE 그대로 · 평문을 쓰지 않는다', () => {
  const run = (dir, code) => execFileSync(process.execPath, ['--input-type=module', '-e', `
    const KS = await import(${JSON.stringify(path.join(HERE, '../src/bmusage/onboard/keyStore.js'))});
    const F = await import(${JSON.stringify(path.join(HERE, './_sshKeyFixtures.js'))});
    ${code}
  `], { env: { ...process.env, CONFIG_DIR: dir, SETTINGS_OWNERS: '' }, encoding: 'utf8' });
  const d1 = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm7bk-c-'));
  fs.writeFileSync(path.join(d1, 'ssh-keys.json'), '{"keys": [ broken');
  const o1 = JSON.parse(run(d1, `const r = KS.addKey({ name: 'a', privateKey: F.ed25519Key().pem }); console.log(JSON.stringify({ code: r.code, status: r.status, err: !!KS.keyStoreLoadError() }));`).trim().split('\n').pop());
  assert.deepEqual(o1, { code: 'registry-unreadable', status: 503, err: true });
  assert.ok(fs.readdirSync(d1).some((f) => f.startsWith('ssh-keys.json.corrupt.')), '손상 보존본');
  assert.equal(fs.existsSync(path.join(d1, 'ssh-keys.json')), false, '빈 저장소로 새로 쓰지 않았다');
  const d2 = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm7bk-p-'));
  fs.writeFileSync(path.join(d2, 'secrets-policy.json'), '{ broken');
  const pem = F.ed25519Key().pem;
  fs.writeFileSync(path.join(d2, 'k.pem'), pem);
  const o2 = JSON.parse(run(d2, `const fs = await import('node:fs'); const r = KS.addKey({ name: 'a', privateKey: fs.readFileSync(${JSON.stringify(path.join(d2, 'k.pem'))}, 'utf8') }); console.log(JSON.stringify({ code: r.code, n: KS.listKeysRaw().length }));`).trim().split('\n').pop());
  assert.equal(o2.code, 'SECRETS_POLICY_UNAVAILABLE');
  assert.equal(o2.n, 0, '메모리도 바뀌지 않는다');
  const written = fs.existsSync(path.join(d2, 'ssh-keys.json')) ? fs.readFileSync(path.join(d2, 'ssh-keys.json'), 'utf8') : '';
  assert.equal(leaks(written, [pem]), false, '평문으로 쓰지 않았다');
  fs.rmSync(d1, { recursive: true, force: true }); fs.rmSync(d2, { recursive: true, force: true });
});

test('⑧ 백업 · 엣지 설정 push 번들 — 개인키 · passphrase · 비밀번호를 싣지 않는다(봉인본도) · 복원은 지금 파일의 같은 지문으로 되살리고 없는 키는 뺀다', async () => {
  const BK = await import('../src/backup/service.js');
  const files = BK.collectConfigDir();
  const bundled = files['ssh-keys.json'];
  assert.ok(bundled, '번들에 파일은 있다(지문 · 공개키 · 이름)');
  const j = JSON.parse(bundled);
  assert.ok(j.keys.length >= 2);
  for (const k of j.keys) { assert.equal(k.privateKey, KS.REDACTED_SECRET); assert.ok(k.fingerprint.startsWith('SHA256:')); }
  assert.equal(/enc[:$]|\$v\d/.test(JSON.stringify(j.keys.map((k) => [k.privateKey, k.passphrase]))), false, '봉인본도 싣지 않는다');
  assert.ok(files[BK.REDACTED_META]?.['ssh-keys.json'], '가린 사실을 메타가 말한다');
  // 복원 병합
  const cur = fs.readFileSync(path.join(DIR, 'ssh-keys.json'), 'utf8');
  const extra = JSON.parse(bundled); extra.keys.push({ id: 'k_ffffffffffff', name: 'gone', fingerprint: 'SHA256:none', privateKey: KS.REDACTED_SECRET });
  const m = KS.mergeRedactedKeyStore(JSON.stringify(extra), cur);
  const mj = JSON.parse(m.text);
  assert.equal(mj.keys.some((k) => k.id === 'k_ffffffffffff'), false, '되살릴 수 없는 키는 뺀다');
  assert.ok(m.dropped.includes('key:gone'));
  const curJ = JSON.parse(cur);
  for (const k of mj.keys) assert.equal(k.privateKey, curJ.keys.find((x) => x.fingerprint === k.fingerprint).privateKey, '지금 파일의 봉인본 그대로');
  // 손상 내용은 원문을 싣지 않는다
  assert.equal(KS.redactKeyStoreText('{"keys":[{"privateKey":"-----BEGIN').text.includes('BEGIN'), false);
});

async function server(t) {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { store } = await import('../src/store.js');
  store.set?.({ ...store.get(), vcenters: [{ id: 'vcA', name: 'A' }, { id: 'vcB', name: 'B' }] });
  const USERS = { own: { username: 'own', role: 'admin', scope: null }, sown: { username: 'sown', role: 'admin', scope: { vcenters: ['vcA'] } }, adm: { username: 'adm', role: 'admin', scope: null }, v: { username: 'v', role: 'viewer', scope: null } };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}/api/tools/bm-usage`;
  return async (u, method, p, body) => {
    const r = await fetch(`${base}${p}`, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const txt = await r.text();
    let j = {}; try { j = JSON.parse(txt); } catch { /* */ }
    return { s: r.status, j, txt };
  };
}
const otpCodes = async () => {
  const left = 30_000 - (Date.now() % 30_000);
  if (left < 12_000) await new Promise((r) => setTimeout(r, left + 50));
  const now = Math.floor(Date.now() / 30_000);
  return [now - 1, now, now + 1].map((counter) => generateToken(SECRET, { counter }));
};

test('⑨ 실제 라우터 — 조회 관리자 · 관리 = 설정 소유자(전체 범위) + 본인 OTP · 권한 없는 요청은 OTP 를 소모하지 않는다 · 응답 · 감사 로그에 비밀 없음', async (t) => {
  const call = await server(t);
  const ED3 = F.ed25519Key();
  // 조회
  assert.equal((await call('v', 'GET', '/ssh-keys')).s, 403, 'viewer');
  const g = await call('adm', 'GET', '/ssh-keys');
  assert.equal(g.s, 200);
  assert.equal(leaks(g.txt, [ED.pem, ED2.pem, RSA.pem]) || /privateKey|passphrase"\s*:/.test(g.txt), false, '목록 응답에 비밀 칸 없음');
  const [c1, c2, c3] = await otpCodes();
  // 관리 — 소유자가 아닌 관리자 · 범위 소유자 → 403(OTP 를 묻기 전)
  const na = await call('adm', 'POST', '/ssh-keys', { name: 'n1', privateKey: ED3.pem, otp: c1 });
  assert.equal(na.s, 403); assert.equal(na.j.requiredOwner, true);
  const so = await call('sown', 'POST', '/ssh-keys', { name: 'n1', privateKey: ED3.pem, otp: c1 });
  assert.equal(so.s, 403); assert.match(so.j.reason, /전체 범위/);
  // 소유자 — OTP 없음 · 틀림 → 403 needOtp
  const no = await call('own', 'POST', '/ssh-keys', { name: 'n1', privateKey: ED3.pem });
  assert.equal(no.s, 403); assert.equal(no.j.needOtp, true);
  assert.equal((await call('own', 'POST', '/ssh-keys', { name: 'n1', privateKey: ED3.pem, otp: '000000' })).s, 403);
  // 위에서 c1 은 소모되지 않았다(권한 게이트가 먼저) → 지금 통과
  const ok = await call('own', 'POST', '/ssh-keys', { name: 'n1', privateKey: ED3.pem, otp: c1 });
  assert.equal(ok.s, 200, ok.txt);
  assert.equal(leaks(ok.txt, [ED3.pem]), false);
  assert.equal(ok.j.key.fingerprint, ED3.fingerprint);
  assert.equal((await call('own', 'POST', '/ssh-keys', { name: 'n2', privateKey: ED3.pem, otp: c1 })).s, 403, '쓴 코드는 다시 못 쓴다');
  // 약한 키는 400(OTP 를 쓰고) — 저장하지 않는다
  const weak = await call('own', 'POST', '/ssh-keys', { name: 'n3', privateKey: F.rsaKey(1024).pem, otp: c2 });
  assert.equal(weak.s, 400); assert.equal(weak.j.code, 'weak-rsa');
  // 쓰는 서버가 있는 키 삭제 → 409
  const used = KS.keyByName('kr-ops-2027');
  const del = await call('own', 'DELETE', `/ssh-keys/${used.id}?otp=${c3}`);
  assert.equal(del.s, 409, del.txt);
  // 공통 계정 — 범위 계정에게는 자기 법인 + 공용만
  KS.saveAccount({ name: 'b-only', kind: 'idrac', corp: 'vcB', username: 'ro', password: 'B-secret-9' });
  const accA = await call('sown', 'GET', '/accounts');
  assert.equal(accA.s, 200);
  assert.equal(accA.j.accounts.some((a) => a.corp === 'vcB'), false, '조회 범위 밖 법인 계정은 보이지 않는다');
  const accAll = await call('adm', 'GET', '/accounts');
  assert.ok(accAll.j.accounts.some((a) => a.corp === 'vcB'));
  assert.equal(accAll.txt.includes('B-secret-9') || accAll.txt.includes('Secret-1'), false, '계정 비밀번호 없음');
  // 감사 로그 — 비밀 없음 · 키 등록 · 거부가 남는다
  const audit = fs.readFileSync(path.join(DIR, 'audit.ndjson'), 'utf8');
  assert.ok(audit.includes('bm-usage.ssh-key.add'));
  assert.equal(leaks(audit, [ED.pem, ED2.pem, ED3.pem, RSA.pem]) || audit.includes('pw-rsa') || audit.includes('B-secret-9'), false, '감사 로그에 비밀 없음');
});

const { stripComments } = await import('./_stripComments.js');
test('⑩ 소스 스윕 — 라우트는 원본 목록(listKeysRaw · listAccountsRaw · keyMaterial)을 응답에 쓰지 않는다 · 비밀 파일 등록 · .gitignore', () => {
  const route = stripComments(fs.readFileSync(path.join(HERE, '../src/routes/api/bmOnboard.js'), 'utf8'));
  for (const bad of ['listKeysRaw', 'listAccountsRaw', 'keyMaterial', 'resolveOsAuth', 'withResolvedAuth']) assert.equal(route.includes(bad), false, `라우트가 ${bad} 를 쓴다`);
  assert.ok(VAULT.SECRET_FILES.includes('ssh-keys.json'));
  const gi = fs.readFileSync(path.join(HERE, '../../.gitignore'), 'utf8');
  assert.ok(gi.includes('server/config/ssh-keys.json'));
});
