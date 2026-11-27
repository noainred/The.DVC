/**
 * secResidual1127TotpSeal.test.js — 보안 잔여 11-27 M3: users.json 의 OTP(TOTP) 시드 암호화 저장(레코드 단위 봉인).
 *
 * 결함(2026-11-08 감사 D-1 — a821fd9e 에서 코드로 확인): secretVault SECRET_FIELDS · SECRET_FILES 에 OTP 시드가 없어 '자격증명 저장 방식 = 암호화' 를 켜도
 *   시드가 평문으로 users.json · 백업 번들 · 엣지 설정 push 에 실렸다(고권한 계정은 OTP 전용이라 시드가 유일 자격증명).
 * 설계(원 감사 권고 '전역 SECRET_FIELDS + 일반 경로' 를 택하지 않은 이유 — secretVault.js '레코드 단위 봉인' 절):
 *   일반 경로는 키 없음에서 모든 저장을 거절하고(로그인 · 비밀번호 변경이 깨진다) 복호 실패를 '' 로 열어 암호문을 지우고 OTP 전용 계정을 비밀번호로 내린다.
 *
 * 시나리오(T1~T25)는 자식 프로세스에서 돈다 — auth 의 사용자 목록 · vault 의 키 · 정책 캐시가 프로세스에 굳으므로 '재시작' 은 새 프로세스다.
 * `M3_SRC` 로 다른 소스 트리(수정 전 판본의 격리 사본)를 가리킬 수 있다 — 수정 전 실패 확인 · 변이 검증용.
 * TOTP 코드는 실제 시각의 30초 칸에서 고정 칸 번호(counter)로 만든다 — 검증 창(±1칸) 안이고, 확정 칸(now) 다음 칸(now+1)을 로그인에 쓴다(재사용 거부 회피).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.env.M3_SRC ? path.resolve(process.env.M3_SRC) : path.join(HERE, '..', 'src');
const TMP_DIRS = [];
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'm3seal-')); TMP_DIRS.push(d); return d; };
after(() => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

const KEY_A = 'A'.repeat(20) + '-m3-key-alpha-0123456789';
const KEY_B = 'B'.repeat(20) + '-m3-key-bravo-0123456789';
const SEED = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const SEED2 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const ENC = { mode: 'encrypted', level: 1 };   // L1(logN 14) — 시험 시간
const PH = (() => { const salt = crypto.randomBytes(16); return `scrypt$${salt.toString('hex')}$${crypto.scryptSync('Passw0rd!x', salt, 64).toString('hex')}`; })();

/* ── 자식 프로세스 ─────────────────────────────────────────────────────────────────────── */
const PRELUDE = `
import fs from 'node:fs'; import path from 'node:path'; import { pathToFileURL } from 'node:url';
const SRC = process.env.M3_SRC_DIR; const DIR = process.env.CONFIG_DIR;
const logs = []; for (const k of ['log', 'warn', 'error', 'info']) console[k] = (...a) => { logs.push(a.map(String).join(' ')); };
const c = {
  fs, path, DIR, logs,
  imp: (rel) => import(pathToFileURL(path.join(SRC, rel)).href),
  raw: (n) => { try { return fs.readFileSync(path.join(DIR, n), 'utf8'); } catch { return null; } },
  json: (n) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, n), 'utf8')); } catch { return null; } },
  ctr: () => Math.floor(Date.now() / 30000),
};
`;
const CHILD_ENV_DROP = ['CENTRAL_URL', 'CENTRAL_TOKEN', 'AUTH_SECRET', 'SECRETS_KEY', 'SECRETS_KEY_LOST', 'DEFAULT_ADMIN_PASSWORD', 'LOGIN_POLICY_USERS', 'SETTINGS_OWNERS', 'OTP_ROLE_ENFORCE', 'NODE_TEST_CONTEXT'];
function childEnv(dir, extraEnv = {}) {
  const env = { ...process.env, CONFIG_DIR: dir, DATA_DIR: dir, AUTH_ENABLED: 'true', DATA_SOURCE: 'live', M3_SRC_DIR: SRC, ...extraEnv };
  for (const k of CHILD_ENV_DROP) if (!(k in extraEnv)) delete env[k];
  return env;
}
function child(scenario, dir, extraEnv = {}) {
  const code = `${PRELUDE}\nconst __r = await (${scenario.toString()})(c);\nprocess.stdout.write('\\n@@' + JSON.stringify(__r) + '\\n');\nprocess.exit(0);\n`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: childEnv(dir, extraEnv), encoding: 'utf8', timeout: 120_000 });
  const line = String(r.stdout || '').split('\n').filter((l) => l.startsWith('@@')).pop();
  assert.ok(line, `자식 프로세스 결과 없음(status ${r.status}) — ${String(r.stderr || '').slice(-1200)}`);
  return JSON.parse(line.slice(2));
}
function tool(name, args, dir, extraEnv = {}) {
  const r = spawnSync(process.execPath, [path.join(SRC, 'tools', name), ...args], { env: childEnv(dir, extraEnv), encoding: 'utf8', timeout: 120_000, input: '' });
  return { status: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
const put = (dir, n, v) => { const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2); fs.writeFileSync(path.join(dir, n), s); return s; };
const raw = (dir, n) => { try { return fs.readFileSync(path.join(dir, n), 'utf8'); } catch { return null; } };
const isSealedStr = (v) => typeof v === 'string' && v.startsWith('enc$1$');
const usersOf = (dir) => JSON.parse(raw(dir, 'users.json')).users;
const byName = (dir, n) => usersOf(dir).find((u) => u.username === n);

/** 키 k 로 평문 목록을 봉인한 문자열(새 프로세스 — salt 는 프로세스마다 하나). */
function sealWith(key, plains) {
  const dir = tmpDir();
  return child(async (c) => {
    const V = await c.imp('security/secretVault.js');
    return JSON.parse(process.env.M3_PLAINS).map((p) => V.sealSecret(p, { mode: 'encrypted', level: 1 }));
  }, dir, { SECRETS_KEY: key, M3_PLAINS: JSON.stringify(plains) });
}
const SEALED_A = sealWith(KEY_A, [SEED, SEED2, 'secret-pw-for-nsx']);   // 키 A 로 봉인한 시드 둘 · NSX 비밀번호(키 없음 흔적용)

// 예전 base32 해석(알파벳 밖 글자를 건너뜀) — 봉인 문자열의 글자로 만든 '공격자 코드'
function lettersCode(sealed, counter) {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of sealed.toUpperCase()) { const i = B32.indexOf(ch); if (i >= 0) bits += i.toString(2).padStart(5, '0'); }
  const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', Buffer.from(bytes)).update(buf).digest();
  const o = h[h.length - 1] & 0x0f;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0');
}

const baseUsers = (extra = []) => ({ users: [
  { username: 'adm', name: 'Adm', role: 'admin', passwordHash: PH, tokenVersion: 3 },
  { username: 'view', name: 'View', role: 'viewer', passwordHash: PH, tokenVersion: 4 },
  { username: 'noainred', name: 'Super', role: 'super_admin', superuser: true, tokenVersion: 5 },
  { username: 'thedvcdemp', name: 'Demo', role: 'viewer', demo: true, tokenVersion: 6 },
  ...extra,
] });
const policyFiles = (dir, pol) => { put(dir, 'secrets-policy.json', pol); put(dir, 'secrets-policy.trusted.json', pol); };
const dropPolicy = (dir) => { for (const n of ['secrets-policy.json', 'secrets-policy.trusted.json']) fs.rmSync(path.join(dir, n), { force: true }); };

/* ── T1 평문 정책: 바이트 · 동작이 예전과 같다(회귀 가드) ─────────────────────────────── */
for (const withPolicy of [false, true]) {
  test(`T1 평문 정책(정책 파일 ${withPolicy ? '있음' : '없음'}) — begin · confirm · 카운터 · 비밀번호 변경 뒤 users.json 바이트 = 메모리 직렬화 · 시드 평문`, () => {
    const dir = tmpDir();
    put(dir, 'users.json', baseUsers());
    if (withPolicy) policyFiles(dir, { mode: 'plain', level: 2, algorithm: '' });
    const r = child(async (c) => {
      const A = await c.imp('auth/auth.js'); const T = await c.imp('auth/totp.js');
      const same = () => c.raw('users.json') === JSON.stringify({ users: A.loadUsers() }, null, 2);
      const out = { steps: [] };
      const b = A.beginTotpEnroll('adm', '', { trusted: true }); out.steps.push(b.ok && same());
      const now = c.ctr();
      const cf = A.confirmTotpEnroll('adm', T.generateToken(b.secret, { counter: now }), { trusted: true }); out.steps.push(cf.ok && same());
      out.login = !!A.authenticateLocal('adm', T.generateToken(b.secret, { counter: now + 1 })); out.steps.push(same());
      out.pw = A.setLocalPassword('view', 'NewPassw0rd!', { trusted: true }).ok; out.steps.push(same());
      out.seedPlain = c.json('users.json').users.find((u) => u.username === 'adm').totpSecret === b.secret;
      out.keyFile = fs.existsSync(path.join(c.DIR, 'secrets-key'));
      return out;
    }, dir);
    assert.deepEqual(r.steps, [true, true, true, true], '모든 저장 뒤 파일 = JSON.stringify({users: 메모리}, null, 2)');
    assert.equal(r.login, true); assert.equal(r.pw, true);
    assert.equal(r.seedPlain, true, '평문 정책 — 시드 평문(정책대로)');
    assert.equal(r.keyFile, false, '평문 정책은 키를 만들지 않는다');
  });
}

/* ── T2 암호화: 봉인 저장 · 새 프로세스에서 로그인 ─────────────────────────────────────── */
test('T2 암호화 — begin/confirm 뒤 파일 시드가 enc$1$ · 평문 시드 문자열 0건 · 새 프로세스가 열어 OTP 로그인 성공', () => {
  const dir = tmpDir();
  put(dir, 'users.json', baseUsers()); policyFiles(dir, ENC);
  const r = child(async (c) => {
    const A = await c.imp('auth/auth.js'); const T = await c.imp('auth/totp.js');
    const b = A.beginTotpEnroll('adm', '', { trusted: true });
    const afterBegin = c.json('users.json').users.find((u) => u.username === 'adm').totpPendingSecret;
    const now = c.ctr();
    const cf = A.confirmTotpEnroll('adm', T.generateToken(b.secret, { counter: now }), { trusted: true });
    return { ok: b.ok && cf.ok, secret: b.secret, afterBegin, now, mem: A.getUser('adm').totpSecret === b.secret };
  }, dir, { SECRETS_KEY: KEY_A });
  assert.equal(r.ok, true);
  assert.ok(isSealedStr(r.afterBegin), `begin 뒤 대기 시드 봉인: ${String(r.afterBegin).slice(0, 12)}`);
  const text = raw(dir, 'users.json');
  assert.ok(isSealedStr(byName(dir, 'adm').totpSecret), '확정 뒤 활성 시드 봉인');
  assert.equal(text.includes(r.secret), false, '파일 어디에도 평문 시드가 없다');
  assert.equal(r.mem, true, '메모리는 평문(소비 코드는 그대로)');
  const r2 = child(async (c) => {
    const A = await c.imp('auth/auth.js'); const T = await c.imp('auth/totp.js');
    return { login: !!A.authenticateLocal('adm', T.generateToken(process.env.M3_S, { counter: Number(process.env.M3_N) + 1 })) };
  }, dir, { SECRETS_KEY: KEY_A, M3_S: r.secret, M3_N: String(r.now) });
  assert.equal(r2.login, true, '새 프로세스가 봉인 시드를 열어 로그인');
});

/* ── T3 혼재 읽기 ──────────────────────────────────────────────────────────────────────── */
test('T3 평문 시드 1 · 봉인 시드 1 이 섞인 users.json — 두 계정 모두 OTP 로그인', () => {
  const dir = tmpDir();
  put(dir, 'users.json', baseUsers([
    { username: 'p1', role: 'admin', totpEnabled: true, totpSecret: SEED2, tokenVersion: 1 },
    { username: 's1', role: 'admin', totpEnabled: true, totpSecret: SEALED_A[0], tokenVersion: 1 },
  ]));
  const r = child(async (c) => {
    const A = await c.imp('auth/auth.js'); const T = await c.imp('auth/totp.js'); const n = c.ctr();
    return { p1: !!A.authenticateLocal('p1', T.generateToken(process.env.M3_S2, { counter: n })), s1: !!A.authenticateLocal('s1', T.generateToken(process.env.M3_S1, { counter: n })) };
  }, dir, { SECRETS_KEY: KEY_A, M3_S1: SEED, M3_S2: SEED2 });
  assert.deepEqual(r, { p1: true, s1: true });
});

/* ── T4 · T5 정책 전환(migrateSecretFiles) ─────────────────────────────────────────────── */
test('T4 정책 전환 — users.json 이 대상 · 암호화로 봉인 · 평문으로 해제', () => {
  const dir = tmpDir();
  put(dir, 'users.json', baseUsers([{ username: 'p1', role: 'admin', totpEnabled: true, totpSecret: SEED, totpPendingSecret: SEED2, tokenVersion: 1 }]));
  const r = child(async (c) => {
    const V = await c.imp('security/secretVault.js');
    const listed = V.SECRET_FILES.includes('users.json');
    const pol = V.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
    const m1 = V.migrateSecretFiles(pol);
    const enc = c.json('users.json').users.find((u) => u.username === 'p1');
    const pol2 = V.saveSecretsPolicy({ mode: 'plain' });
    const m2 = V.migrateSecretFiles(pol2);
    const pl = c.json('users.json').users.find((u) => u.username === 'p1');
    return { listed, row1: m1.files.find((f) => f.file === 'users.json') || null, enc, row2: m2.files.find((f) => f.file === 'users.json') || null, pl, errs: [...m1.errors, ...m2.errors].map((e) => e.file) };
  }, dir, { SECRETS_KEY: KEY_A });
  assert.equal(r.listed, true, 'SECRET_FILES 에 users.json');
  assert.deepEqual(r.row1 && { changed: r.row1.changed, secrets: r.row1.secrets }, { changed: true, secrets: 2 });
  assert.ok(isSealedStr(r.enc.totpSecret) && isSealedStr(r.enc.totpPendingSecret), '암호화 전환이 두 칸을 봉인');
  assert.equal(r.row2?.changed, true);
  assert.equal(r.pl.totpSecret, SEED); assert.equal(r.pl.totpPendingSecret, SEED2);
  assert.deepEqual(r.errs, []);
});

test('T5 다른 키로 봉인된 users.json — 전환이 users.json 을 오류로 보고하고 바이트를 바꾸지 않는다(v2.480)', () => {
  const dir = tmpDir();
  const orig = put(dir, 'users.json', baseUsers([{ username: 's1', role: 'admin', totpEnabled: true, totpSecret: SEALED_A[0], tokenVersion: 1 }]));
  const r = child(async (c) => {
    const V = await c.imp('security/secretVault.js');
    const m = V.migrateSecretFiles({ mode: 'plain' });
    return { err: m.errors.find((e) => e.file === 'users.json')?.error || null };
  }, dir, { SECRETS_KEY: KEY_B });
  assert.ok(r.err && /복호 실패/.test(r.err) && /OTP/.test(r.err), `users.json 오류 보고: ${r.err}`);
  assert.equal(raw(dir, 'users.json'), orig, '바이트 불변');
});

/* ── T6 · T7 · T8 키 불일치(다른 키로 복원) ─────────────────────────────────────────────── */
test('T6 키 불일치 계정 A + 정상 계정 B — B 의 비밀번호 변경 · OTP 카운터 저장 뒤 A 암호문 바이트 그대로 · B 시드 봉인', () => {
  const dir = tmpDir();
  put(dir, 'users.json', baseUsers([
    { username: 'a1', role: 'admin', totpEnabled: true, totpSecret: SEALED_A[0], tokenVersion: 1 },
    { username: 'b1', role: 'viewer', passwordHash: PH, totpEnabled: true, totpSecret: SEED2, tokenVersion: 1 },
  ]));
  policyFiles(dir, ENC);
  const r = child(async (c) => {
    const A = await c.imp('auth/auth.js'); const T = await c.imp('auth/totp.js');
    A.loadUsers();
    const pw = A.setLocalPassword('b1', 'NewPassw0rd!', { trusted: true }).ok;
    const login = !!A.authenticateLocal('b1', T.generateToken(process.env.M3_S2, { counter: c.ctr() }));
    return { pw, login };
  }, dir, { SECRETS_KEY: KEY_B, M3_S2: SEED2 });
  assert.deepEqual(r, { pw: true, login: true });
  assert.equal(byName(dir, 'a1').totpSecret, SEALED_A[0], '복호 실패 암호문은 지우지 않고 그대로');
  const b1 = byName(dir, 'b1').totpSecret;
  assert.ok(isSealedStr(b1) && b1 !== SEALED_A[0], 'B 시드는 이 호스트 키로 봉인');
});

test('T7 키 불일치 + OTP 전용 강제 + 비밀번호 해시가 남은 계정 — 비밀번호로 내려가지 않음 · OTP 실패 · listUsers otpUnreadable', () => {
  const dir = tmpDir();
  put(dir, 'users.json', baseUsers([{ username: 'a1', role: 'admin', passwordHash: PH, totpEnabled: true, totpSecret: SEALED_A[0], tokenVersion: 1 }]));
  const r = child(async (c) => {
    const A = await c.imp('auth/auth.js'); const T = await c.imp('auth/totp.js');
    return {
      pw: !!A.authenticateLocal('a1', 'Passw0rd!x'),
      otp: !!A.authenticateLocal('a1', T.generateToken(process.env.M3_S, { counter: c.ctr() })),
      row: A.listUsers().find((u) => u.username === 'a1'),
      other: A.listUsers().find((u) => u.username === 'adm').otpUnreadable,
      warned: c.logs.some((l) => /OTP 키 1개를 복호하지 못했습니다/.test(l) && !/a1/.test(l)),
    };
  }, dir, { SECRETS_KEY: KEY_B, M3_S: SEED });
  assert.equal(r.pw, false, '비밀번호로 내려가지 않는다(강제 분기 그대로)');
  assert.equal(r.otp, false);
  assert.equal(r.row.otpUnreadable, true); assert.equal(r.row.totpEnabled, true, '등록됨 의미 유지(재등록 우회 차단)');
  assert.equal(r.other, false);
  assert.equal(r.warned, true, '콘솔 1회 경고(계정명 없음)');
});

test('T8 봉인 문자열 시드 — 암호문 글자로 만든 코드로 로그인 · 재확인 실패 · OTP_SEED_UNREADABLE · 반복해도 잠금 없음 · 감사용 기록', () => {
  const dir = tmpDir();
  put(dir, 'users.json', baseUsers([{ username: 'a1', role: 'admin', totpEnabled: true, totpSecret: SEALED_A[0], tokenVersion: 1 }]));
  const r = child(async (c) => {
    const A = await c.imp('auth/auth.js'); const n = c.ctr();
    const atk = JSON.parse(process.env.M3_ATK);
    const login = atk.map((code) => !!A.authenticateLocal('a1', code));
    const vs = []; for (let i = 0; i < 10; i++) vs.push(A.verifyUserOtp('a1', atk[1]));
    return { login, codes: vs.map((v) => v.code || null), locked: vs.some((v) => v.locked), reason: vs[0].reason, ok: vs.some((v) => v.ok), audit: A.otpSeedUnreadableOf?.('a1')?.reason || null, n };
  }, dir, { SECRETS_KEY: KEY_B, M3_ATK: JSON.stringify([-1, 0, 1].map((d) => lettersCode(SEALED_A[0], Math.floor(Date.now() / 30000) + d))) });
  assert.deepEqual(r.login, [false, false, false], '암호문 글자 키로 만든 코드로 로그인되지 않는다');
  assert.equal(r.ok, false);
  assert.deepEqual(r.codes, Array(10).fill('OTP_SEED_UNREADABLE'));
  assert.equal(r.locked, false, '실패로 세지 않아 잠금 없음');
  assert.match(r.reason, /복호하지 못해/);
  assert.match(String(r.audit), /OTP 키 복호 실패/);
});

test('T8b totp — 봉인 문자열 · 알파벳 밖 글자 시드는 검증 null · 생성은 던짐 · 정상 시드(소문자 · 공백 · = 채움)는 통과', () => {
  const r = child(async (c) => {
    const T = await c.imp('auth/totp.js'); const n = c.ctr();
    const sealed = process.env.M3_SEALED;
    const code = T.generateToken(process.env.M3_S, { counter: n });
    let threw = false; try { T.generateToken(sealed, { counter: n }); } catch { threw = true; }
    return {
      sealed: T.verifyToken(process.env.M3_LET, sealed), junk: T.verifyToken(code, process.env.M3_S + '!!'),
      ok: T.verifyToken(code, process.env.M3_S) === n,
      lower: T.verifyToken(code, process.env.M3_S.toLowerCase().replace(/(.{4})/g, '$1 ')) === n,
      pad: T.verifyToken(code, process.env.M3_S + '======') === n, threw,
    };
  }, tmpDir(), { M3_SEALED: SEALED_A[0], M3_S: SEED, M3_LET: lettersCode(SEALED_A[0], Math.floor(Date.now() / 30000)) });
  assert.deepEqual(r, { sealed: null, junk: null, ok: true, lower: true, pad: true, threw: true });
});

/* ── T9 · T10 · T13 잠금(S-07 — 정책 · 신뢰 사본 삭제 + 키 파일 + 봉인 흔적) ───────────── */
function enrolledEncDir() {
  const dir = tmpDir();
  put(dir, 'users.json', baseUsers());
  const r = child(async (c) => {
    const V = await c.imp('security/secretVault.js'); const A = await c.imp('auth/auth.js'); const T = await c.imp('auth/totp.js');
    V.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
    const b = A.beginTotpEnroll('adm', '', { trusted: true }); const now = c.ctr();
    const cf = A.confirmTotpEnroll('adm', T.generateToken(b.secret, { counter: now }), { trusted: true });
    const b2 = A.beginTotpEnroll('view', '', { trusted: true });
    return { ok: b.ok && cf.ok && b2.ok, secret: b.secret, secret2: b2.secret, now, keyFile: fs.existsSync(path.join(c.DIR, 'secrets-key')) };
  }, dir);
  assert.equal(r.ok, true); assert.equal(r.keyFile, true);
  return { dir, ...r };
}

test('T9 잠금 — begin 거절(SECRETS_POLICY_UNAVAILABLE · 한국어 사유) · 메모리 · 파일 불변', () => {
  const e = enrolledEncDir(); dropPolicy(e.dir);
  const before = raw(e.dir, 'users.json');
  const r = child(async (c) => {
    const A = await c.imp('auth/auth.js');
    const b = A.beginTotpEnroll('noainred', '', { trusted: true });
    return { b: { ok: b.ok, code: b.code || null, reason: b.reason || '', secret: !!b.secret }, mem: A.getUser('noainred').totpPendingSecret ?? null };
  }, e.dir);
  assert.equal(r.b.ok, false); assert.equal(r.b.code, 'SECRETS_POLICY_UNAVAILABLE'); assert.equal(r.b.secret, false);
  assert.match(r.b.reason, /새 OTP 키를 발급하지 않았습니다 — 자격증명 저장 방식/);
  assert.match(r.b.reason, /기존 OTP 로그인은 그대로 됩니다/);
  assert.equal(r.mem, null, '메모리를 바꾸지 않는다');
  assert.equal(raw(e.dir, 'users.json'), before, '파일 불변');
});

test('T10 잠금 — 로그인 카운터 · 비밀번호 변경 · 역할 변경(tokenVersion) · 계정 생성은 계속 된다 · 봉인 시드 바이트 그대로', () => {
  const e = enrolledEncDir(); dropPolicy(e.dir);
  const before = byName(e.dir, 'adm');
  const r = child(async (c) => {
    const A = await c.imp('auth/auth.js'); const T = await c.imp('auth/totp.js');
    const out = {};
    out.login = !!A.authenticateLocal('adm', T.generateToken(process.env.M3_S, { counter: Number(process.env.M3_N) + 1 }));
    out.pw = A.setLocalPassword('view', 'NewPassw0rd!', { trusted: true }).ok;
    out.role = A.updateUser('view', { role: 'operator' }, { trusted: true }).ok;
    out.create = A.createUser({ username: 'newbie', role: 'viewer', password: 'Passw0rd!new' }, { trusted: true }).ok;
    return out;
  }, e.dir, { M3_S: e.secret, M3_N: String(e.now) });
  assert.deepEqual(r, { login: true, pw: true, role: true, create: true });
  const adm = byName(e.dir, 'adm');
  assert.equal(adm.totpSecret, before.totpSecret, '봉인 시드 바이트 그대로');
  assert.ok(isSealedStr(adm.totpSecret));
  assert.ok(isSealedStr(byName(e.dir, 'view').totpPendingSecret), '다른 계정의 대기 시드도 그대로 봉인');
  assert.equal(adm.totpLastCounter, e.now + 1, '카운터 저장됨');
  assert.ok(byName(e.dir, 'newbie'));
});

test('T13 정상 때 begin → 재시작(잠금) → confirm 성공 · 활성 칸이 대기 암호문을 그대로 승계', () => {
  const e = enrolledEncDir();
  const pending = byName(e.dir, 'view').totpPendingSecret;
  assert.ok(isSealedStr(pending));
  dropPolicy(e.dir);
  const r = child(async (c) => {
    const A = await c.imp('auth/auth.js'); const T = await c.imp('auth/totp.js');
    const cf = A.confirmTotpEnroll('view', T.generateToken(process.env.M3_S, { counter: c.ctr() }), { trusted: true });
    return { ok: cf.ok, reason: cf.reason || '' };
  }, e.dir, { M3_S: e.secret2 });
  assert.equal(r.ok, true, r.reason);
  const v = byName(e.dir, 'view');
  assert.equal(v.totpSecret, pending, '새 봉인 없이 대기 암호문 승계');
  assert.equal(v.totpPendingSecret, undefined);
});

/* ── T11 키 없음(SECRETS_KEY_MISSING) ──────────────────────────────────────────────────── */
test('T11 키 없음 + 암호화 정책 + 평문 시드 — 비밀번호 변경 성공 · 시드 평문 그대로(하향 아님) · begin 거절', () => {
  const dir = tmpDir();
  policyFiles(dir, ENC);
  put(dir, 'nsx.json', { managers: [{ id: 'n1', host: 'nsx.local', username: 'u', password: SEALED_A[2] }] });   // 봉인 흔적(키는 없음)
  put(dir, 'users.json', baseUsers([{ username: 'p1', role: 'admin', totpEnabled: true, totpSecret: SEED, tokenVersion: 1 }]));
  const r = child(async (c) => {
    const A = await c.imp('auth/auth.js');
    const pw = A.setLocalPassword('view', 'NewPassw0rd!', { trusted: true });
    const b = A.beginTotpEnroll('adm', '', { trusted: true });
    return { pw: pw.ok, b: { ok: b.ok, code: b.code || null, reason: b.reason || '' }, mem: A.getUser('adm').totpPendingSecret ?? null };
  }, dir);
  assert.equal(r.pw, true, '시드를 바꾸지 않는 저장은 키 없음에서도 된다');
  assert.equal(byName(dir, 'p1').totpSecret, SEED, '평문 시드 그대로(디스크와 같음)');
  assert.equal(r.b.ok, false); assert.equal(r.b.code, 'SECRETS_KEY_MISSING'); assert.match(r.b.reason, /새 OTP 키를 발급하지 않았습니다/);
  assert.equal(r.mem, null);
  assert.equal(fs.existsSync(path.join(dir, 'secrets-key')), false, '키를 만들지 않는다');
});

/* ── T12 바이트 안정 · T13b 같은 프로세스 전환 ─────────────────────────────────────────── */
test('T12 암호화 — 이 프로세스가 새로 봉인한 시드는 시드를 안 바꾸는 저장에서 글자 그대로 · confirm 은 대기 암호문 승계', () => {
  const dir = tmpDir();
  put(dir, 'users.json', baseUsers()); policyFiles(dir, ENC);
  const r = child(async (c) => {
    const A = await c.imp('auth/auth.js'); const T = await c.imp('auth/totp.js');
    const b = A.beginTotpEnroll('adm', '', { trusted: true });
    const p0 = c.json('users.json').users.find((u) => u.username === 'adm').totpPendingSecret;
    A.setLocalPassword('view', 'NewPassw0rd!', { trusted: true });
    const p1 = c.json('users.json').users.find((u) => u.username === 'adm').totpPendingSecret;
    A.updateUser('view', { name: 'V2' }, { trusted: true });
    const p2 = c.json('users.json').users.find((u) => u.username === 'adm').totpPendingSecret;
    A.confirmTotpEnroll('adm', T.generateToken(b.secret, { counter: c.ctr() }), { trusted: true });
    const s0 = c.json('users.json').users.find((u) => u.username === 'adm').totpSecret;
    A.updateUser('view', { name: 'V3' }, { trusted: true });
    const s1 = c.json('users.json').users.find((u) => u.username === 'adm').totpSecret;
    return { p0, p1, p2, s0, s1 };
  }, dir, { SECRETS_KEY: KEY_A });
  assert.ok(isSealedStr(r.p0));
  assert.equal(r.p1, r.p0); assert.equal(r.p2, r.p0);
  assert.equal(r.s0, r.p0, 'confirm 이 대기 암호문을 활성 칸으로 승계');
  assert.equal(r.s1, r.p0);
});

test('T13b 같은 프로세스 — 암호화로 전환 뒤 저장은 봉인 유지 · 평문으로 전환 뒤 저장은 평문', () => {
  const dir = tmpDir();
  put(dir, 'users.json', baseUsers([{ username: 'p1', role: 'admin', totpEnabled: true, totpSecret: SEED, tokenVersion: 1 }]));
  const r = child(async (c) => {
    const V = await c.imp('security/secretVault.js'); const A = await c.imp('auth/auth.js');
    A.loadUsers();
    V.migrateSecretFiles(V.saveSecretsPolicy({ mode: 'encrypted', level: 1 }));
    A.setLocalPassword('view', 'NewPassw0rd!', { trusted: true });
    const enc = c.json('users.json').users.find((u) => u.username === 'p1').totpSecret;
    V.migrateSecretFiles(V.saveSecretsPolicy({ mode: 'plain' }));
    A.setLocalPassword('view', 'NewPassw0rd!2', { trusted: true });
    const pl = c.json('users.json').users.find((u) => u.username === 'p1').totpSecret;
    return { enc, pl };
  }, dir, { SECRETS_KEY: KEY_A });
  assert.ok(isSealedStr(r.enc), '낡은 기억(평문)이 암호화 전환 뒤 저장을 평문으로 내리지 않는다');
  assert.equal(r.pl, SEED);
});

/* ── T14 이상한 시드 칸 + 여는 위치(파싱 try 밖) ───────────────────────────────────────── */
test('T14 이상한 시드 칸(객체 · 숫자 · 깨진 봉인) — 손상으로 옮기지 않고 기본 admin 을 만들지 않음 · 여는 일은 JSON.parse try 밖', () => {
  const dir = tmpDir();
  const orig = put(dir, 'users.json', { users: [
    { username: 'x1', role: 'viewer', passwordHash: PH, totpSecret: {}, tokenVersion: 1 },
    { username: 'x2', role: 'viewer', passwordHash: PH, totpSecret: 12345, tokenVersion: 1 },
    { username: 'x3', role: 'viewer', passwordHash: PH, totpEnabled: true, totpSecret: 'enc$1$xx$', tokenVersion: 1 },
    { username: 'noainred', role: 'super_admin', superuser: true, tokenVersion: 5 }, { username: 'thedvcdemp', role: 'viewer', demo: true, tokenVersion: 6 },
  ] });
  const r = child(async (c) => {
    const A = await c.imp('auth/auth.js');
    const names = A.loadUsers().map((u) => u.username);
    return { names, login: !!A.authenticateLocal('x1', 'Passw0rd!x'), corrupt: fs.readdirSync(c.DIR).filter((n) => n.includes('.corrupt')) };
  }, dir, { SECRETS_KEY: KEY_A });
  assert.deepEqual(r.corrupt, []); assert.equal(r.names.includes('admin'), false); assert.equal(r.login, true);
  assert.equal(raw(dir, 'users.json'), orig, '저장 없음');
  const src = stripComments(fs.readFileSync(path.join(SRC, 'auth', 'auth.js'), 'utf8'));
  const load = src.slice(src.indexOf('export function loadUsers('), src.indexOf('export function reloadUsersFromDisk('));
  assert.ok(/catch \(err\) \{[\s\S]*?\}\s*if \(loaded\) return adoptLoadedUsers\(loaded\);/.test(load), '받아들이기(adoptLoadedUsers)는 파싱 catch 뒤');
  const parseAt = load.indexOf('JSON.parse(text)');
  const tryBlock = load.slice(parseAt, load.indexOf('catch (err)', parseAt));
  assert.ok(parseAt > 0 && tryBlock.length > 20, '파싱 try 블록을 찾음');
  assert.equal(/openRecordFields|adoptLoadedUsers/.test(tryBlock), false, '여는 일이 JSON.parse try 안에 없다');
  const adopt = src.slice(src.indexOf('function adoptLoadedUsers('), src.indexOf('export function reloadUsersFromDisk('));
  assert.ok(adopt.indexOf('openRecordFields(') >= 0 && adopt.indexOf('openRecordFields(') < adopt.indexOf('ensureDemoUser('), '여는 일은 데모 · 수퍼 보장(과 그 저장)보다 먼저(반증 S-1)');
});

/* ── T15 · T16 · T16b · T18b 콘솔 도구 ─────────────────────────────────────────────────── */
test('T15 도구 — 암호화 정책 · 키 없음 · 흔적 없음: 등록 시작이 secrets-key 를 만들지 않고 거절', () => {
  const dir = tmpDir();
  policyFiles(dir, ENC);
  const orig = put(dir, 'users.json', baseUsers());
  const t = tool('otp-enroll.js', ['adm'], dir);
  assert.notEqual(t.status, 0, t.out);
  assert.match(t.err, /새 OTP 키를 발급하지 않았습니다/);
  assert.equal(fs.existsSync(path.join(dir, 'secrets-key')), false, '도구는 키를 만들지 않는다');
  assert.equal(raw(dir, 'users.json'), orig);
});

function portalWithEnvKey(dir, key) {
  // 포탈 역할 — env 키로 암호화 정책을 저장하고 키 확인 값을 남긴다.
  return child(async (c) => {
    const V = await c.imp('security/secretVault.js');
    V.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
    const s = await V._keyCheckSettled?.();
    return { s: s || null, kc: fs.existsSync(path.join(c.DIR, 'secrets-keycheck')) };
  }, dir, { SECRETS_KEY: key });
}

test('T16 도구 — 키가 portal.env 의 SECRETS_KEY 에만: 시작 · 확정이 봉인 저장 · env 키 포탈이 로그인', () => {
  const dir = tmpDir();
  put(dir, 'users.json', baseUsers());
  assert.equal(portalWithEnvKey(dir, KEY_A).kc, true, '포탈이 키 확인 값을 남김');
  put(dir, 'portal.env', `# 설정\nPORT=8080\nSECRETS_KEY="${KEY_A}"\nAUTH_SECRET=xyz\n`);
  const t1 = tool('otp-enroll.js', ['adm'], dir);
  assert.equal(t1.status, 0, t1.err + t1.out);
  const secret = (/설정 키\s*:\s*([A-Z2-7]+)/.exec(t1.out) || [])[1];
  assert.ok(secret, t1.out);
  assert.ok(isSealedStr(byName(dir, 'adm').totpPendingSecret), '도구가 포탈 키로 봉인');
  const now = Math.floor(Date.now() / 30000);
  const code = child(async (c) => { const T = await c.imp('auth/totp.js'); return T.generateToken(process.env.M3_S, { counter: Number(process.env.M3_N) }); }, tmpDir(), { M3_S: secret, M3_N: String(now) });
  const t2 = tool('otp-enroll.js', ['adm', '--confirm', code], dir);
  assert.equal(t2.status, 0, t2.err + t2.out);
  assert.ok(isSealedStr(byName(dir, 'adm').totpSecret));
  assert.equal(raw(dir, 'users.json').includes(secret), false);
  assert.equal(fs.existsSync(path.join(dir, 'secrets-key')), false, '키 파일을 만들지 않았다');
  const r = child(async (c) => {
    const A = await c.imp('auth/auth.js'); const T = await c.imp('auth/totp.js');
    return { login: !!A.authenticateLocal('adm', T.generateToken(process.env.M3_S, { counter: Number(process.env.M3_N) + 1 })) };
  }, dir, { SECRETS_KEY: KEY_A, M3_S: secret, M3_N: String(now) });
  assert.equal(r.login, true, 'env 키 포탈이 도구가 봉인한 시드로 로그인');
});

test('T16b 도구 — 포탈은 env 키, 도구는 다른 키 파일(portal.env 에 키 없음): 새 봉인 거절 · --list 도 바이트 불변(반증 M-1)', () => {
  const dir = tmpDir();
  put(dir, 'users.json', baseUsers([{ username: 'p1', role: 'admin', totpEnabled: true, totpSecret: SEED, tokenVersion: 1 }]));
  assert.equal(portalWithEnvKey(dir, KEY_A).kc, true);
  // 포탈을 한 번 띄워 평문 시드를 봉인(업그레이드 자동 봉인)한 상태
  child(async (c) => { const A = await c.imp('auth/auth.js'); A.loadUsers(); return 1; }, dir, { SECRETS_KEY: KEY_A });
  put(dir, 'users.json', JSON.stringify({ users: [...usersOf(dir), { username: 'p2', role: 'admin', totpEnabled: true, totpSecret: SEED2, tokenVersion: 1 }] }, null, 2));   // 도구 시험용 평문 시드 하나 더
  put(dir, 'secrets-key', 'F'.repeat(44));   // 낡은 키 파일(포탈은 env 키를 쓴다)
  put(dir, 'portal.env', 'PORT=8080\n');      // SECRETS_KEY 는 drop-in 등 portal.env 밖에 있는 설치
  const before = raw(dir, 'users.json');
  const l = tool('otp-enroll.js', ['--list'], dir);
  assert.equal(l.status, 0, l.err);
  assert.equal(raw(dir, 'users.json'), before, '--list 는 사용자 파일을 바꾸지 않는다(도구 안 자동 봉인 없음)');
  const t = tool('otp-enroll.js', ['adm'], dir);
  assert.notEqual(t.status, 0, t.out);
  assert.match(t.err, /같은 암호화 키를 쓰는지 확인하지 못했습니다/);
  assert.equal(raw(dir, 'users.json'), before, '다른 키로 봉인하지 않았다');
  // 시드를 바꾸지 않는 쓰기(해제가 아닌 다른 계정 — user-admin 의 비밀번호 설정과 같은 저장)는 디스크 원문 승계로 된다
  const u = child(async (c) => {
    const V = await c.imp('security/secretVault.js'); V.disallowKeyCreation?.();
    const A = await c.imp('auth/auth.js');
    return A.setLocalPassword('view', 'NewPassw0rd!', { trusted: true }).ok;
  }, dir);
  assert.equal(u, true);
  assert.equal(byName(dir, 'p2').totpSecret, SEED2, '평문 시드는 다른 키로 봉인하지 않고 디스크 그대로');
  assert.equal(byName(dir, 'p1').totpSecret, JSON.parse(before).users.find((x) => x.username === 'p1').totpSecret, '포탈이 봉인한 시드 그대로');
});

test('T18 업그레이드 — 암호화 정책 + 평문 시드: 포탈의 loadUsers 만으로 봉인 · 안내 1줄', () => {
  const dir = tmpDir();
  policyFiles(dir, ENC);
  put(dir, 'users.json', baseUsers([{ username: 'p1', role: 'admin', totpEnabled: true, totpSecret: SEED, totpPendingSecret: SEED2, tokenVersion: 1 }]));
  const r = child(async (c) => { const A = await c.imp('auth/auth.js'); A.loadUsers(); return { note: c.logs.filter((l) => /평문 OTP 키 2개를 봉인했습니다/.test(l)).length }; }, dir, { SECRETS_KEY: KEY_A });
  const p1 = byName(dir, 'p1');
  assert.ok(isSealedStr(p1.totpSecret) && isSealedStr(p1.totpPendingSecret));
  assert.notEqual(p1.totpSecret, p1.totpPendingSecret);
  assert.equal(r.note, 1);
});

test('T18b 도구 — 같은 키(키 확인 값 일치) · 암호화 정책 · 평문 시드여도 --list 는 사용자 파일을 바꾸지 않는다(자동 봉인은 포탈에서만 — 반증 M-1 ③)', () => {
  const dir = tmpDir();
  put(dir, 'users.json', baseUsers());
  assert.equal(portalWithEnvKey(dir, KEY_A).kc, true);
  const before = put(dir, 'users.json', baseUsers([{ username: 'p1', role: 'admin', totpEnabled: true, totpSecret: SEED, tokenVersion: 1 }]));
  put(dir, 'portal.env', `SECRETS_KEY=${KEY_A}\n`);
  const l = tool('otp-enroll.js', ['--list'], dir);
  assert.equal(l.status, 0, l.err);
  assert.equal(raw(dir, 'users.json'), before);
  const u = tool('user-admin.js', ['--list'], dir);
  assert.equal(u.status, 0, u.err + u.out);
  assert.equal(raw(dir, 'users.json'), before);
});

/* ── T17 root 판정 · 시작 순서 · portal.env 해석 ──────────────────────────────────────── */
test('T17 rootRunIssue 순수 판정 · parseSecretsKey · 두 도구가 users.json 읽기 전에 준비 · 준비가 세 단계를 부름', () => {
  const r = child(async (c) => {
    const K = await c.imp('tools/portalEnvKey.js');
    return {
      root: [K.rootRunIssue({ uid: 0, configDirUid: 1000 }), K.rootRunIssue({ uid: 0, configDirUid: 0 }), K.rootRunIssue({ uid: 1000, configDirUid: 1000 }), K.rootRunIssue({ uid: null, configDirUid: 1000 })].map((x) => (x ? 'issue' : null)),
      text: K.rootRunIssue({ uid: 0, configDirUid: 1000 }),
      parse: [K.parseSecretsKey('A=1\nSECRETS_KEY="abc def"\n#SECRETS_KEY=zz\n'), K.parseSecretsKey("export SECRETS_KEY='q1'\r\nSECRETS_KEY = last\n"), K.parseSecretsKey('SECRETS_KEY_LOST=true\n'), K.parseSecretsKey('')],
    };
  }, tmpDir());
  assert.deepEqual(r.root, ['issue', null, null, null]);
  assert.match(r.text, /root 로 직접 실행하지 마세요/);
  assert.deepEqual(r.parse, ['abc def', 'last', null, null]);
  for (const [f, first] of [['otp-enroll.js', 'loadUsers();'], ['user-admin.js', "argv.includes('--list')"]]) {
    const s = stripComments(fs.readFileSync(path.join(SRC, 'tools', f), 'utf8'));
    const i = s.indexOf('prepareConsoleTool(config.configDir)');
    assert.ok(i > 0 && i < s.indexOf(first, s.indexOf(f === 'user-admin.js' ? 'async function main(' : 'loadUsers();') - 1), `${f}: 준비가 첫 사용자 읽기보다 먼저`);
    assert.ok(/if \(prep\.issue\)/.test(s), `${f}: root 판정 사유면 끝낸다`);
  }
  const k = stripComments(fs.readFileSync(path.join(SRC, 'tools', 'portalEnvKey.js'), 'utf8'));
  const prep = k.slice(k.indexOf('export function prepareConsoleTool('));
  const order = ['rootRunIssue(', 'loadKeyEnvFromPortalEnv(', 'disallowKeyCreation('].map((n) => prep.indexOf(n));
  assert.ok(order.every((x) => x > 0) && order[0] < order[1] && order[1] < order[2], `준비 순서 ${order}`);
  assert.ok(/if \(issue\) return \{ issue, note: null \};/.test(prep), 'root 판정 사유면 준비를 멈춘다');
  // 실제 조건(이 시험이 root 로 돌 때만 — CI 는 일반 계정): 서비스 계정 소유 CONFIG_DIR 을 root 로 직접 실행하면 거절하고 users.json 을 만들지 않는다
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    const dir = tmpDir();
    put(dir, 'users.json', baseUsers());
    fs.chownSync(dir, 1000, 1000);
    const before = raw(dir, 'users.json');
    const t = tool('otp-enroll.js', ['adm'], dir);
    assert.notEqual(t.status, 0); assert.match(t.err, /root 로 직접 실행하지 마세요/);
    assert.equal(raw(dir, 'users.json'), before);
  }
});

/* ── T19 목록 · 도구 문구 ──────────────────────────────────────────────────────────────── */
test('T19 복호 실패 표시 — otp-enroll --list 문구 · loginStateOf(강제 → none · 비강제 → OTP 제외)', () => {
  const dir = tmpDir();
  put(dir, 'users.json', baseUsers([{ username: 'a1', role: 'admin', totpEnabled: true, totpSecret: SEALED_A[0], tokenVersion: 1 }]));
  const t = tool('otp-enroll.js', ['--list'], dir, { SECRETS_KEY: KEY_B });
  assert.equal(t.status, 0, t.err);
  assert.match(t.out, /a1\s+admin\s+OTP 등록됨\(키 복호 실패 — 로그인 불가, 다시 등록하세요\)/);
  const r = child(async (c) => {
    const X = await c.imp('tools/userAdminText.js');
    const st = X.loginStateOf({ role: 'admin', totpEnabled: true, otpUnreadable: true, hasPassword: true }, {});
    const vw = X.loginStateOf({ role: 'viewer', totpEnabled: true, otpUnreadable: true, hasPassword: true }, {});
    const okRow = X.loginStateOf({ role: 'admin', totpEnabled: true }, {});
    return { st: [st.state, st.methods, /복호하지 못해/.test(st.note)], vw: [vw.state, vw.methods], ok: okRow.state };
  }, tmpDir());
  assert.deepEqual(r, { st: ['none', '없음', true], vw: ['ok', '비밀번호'], ok: 'ok' });
});

/* ── T20 복원 경고 ─────────────────────────────────────────────────────────────────────── */
test('T20 복원 예약 — 이 호스트 키로 못 여는 번들 OTP 키를 경고 · 키 없는 평문 호스트에서 판정이 키를 만들지 않음', async () => {
  const dir = tmpDir();
  put(dir, 'users.json', baseUsers());
  const bundle = JSON.stringify(baseUsers([{ username: 'a1', role: 'admin', totpEnabled: true, totpSecret: SEALED_A[0], tokenVersion: 1 }]), null, 2);
  const r = child(async (c) => {
    const B = await c.imp('backup/service.js');
    const res = await B.restoreCentral({ central: { files: { 'users.json': process.env.M3_BUNDLE } } });
    return { w: res.warnings.map((x) => x.reason), key: fs.existsSync(path.join(c.DIR, 'secrets-key')) };
  }, dir, { M3_BUNDLE: bundle });
  assert.ok(r.w.some((w) => /번들의 OTP 키 1개\(고권한 계정 1개\)를 이 포탈의 암호화 키로 열 수 없습니다/.test(w)), r.w.join(' | '));
  assert.equal(r.key, false, '판정이 키를 만들지 않는다');
  const r2 = child(async (c) => {
    const B = await c.imp('backup/service.js');
    const res = await B.restoreCentral({ central: { files: { 'users.json': process.env.M3_BUNDLE } } });
    return res.warnings.some((x) => /OTP 키/.test(x.reason));
  }, tmpDir(), { M3_BUNDLE: bundle, SECRETS_KEY: KEY_A });
  assert.equal(r2, false, '같은 키면 경고 없음');
});

/* ── T21 · T22 소스 대조(감사 detail · 가드 · 직렬화 · 되돌림) ─────────────────────────── */
test('T21 · T22 소스 대조 — 로그인 실패 감사 detail · verifyToken 앞 isSealed 가드 3곳 · persistUsers 는 봉인 결과만 · confirm 되돌림', () => {
  const ra = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'auth.js'), 'utf8'));
  assert.ok(/otpSeedUnreadableOf\(username\)[\s\S]{0,120}shadow \+=/.test(ra), '로그인 실패 감사 detail 에 OTP 키 복호 실패 사유');
  assert.ok(/return res\.status\(401\)\.json\(\{ error: 'invalid credentials' \}\)/.test(ra), '응답은 그대로');
  const s = stripComments(fs.readFileSync(path.join(SRC, 'auth', 'auth.js'), 'utf8'));
  const calls = [...s.matchAll(/totp\.verifyToken\(/g)].map((m) => m.index);
  assert.equal(calls.length, 3);
  for (const at of calls) {
    const before = s.slice(Math.max(0, at - 700), at);
    assert.ok(/isSealed\((user\.totpSecret|u\.totpSecret|pending)\)/.test(before), `verifyToken(${at}) 앞에 isSealed 가드`);
  }
  const persist = s.slice(s.indexOf('function persistUsers('), s.indexOf('function queueUserRevocation('));
  assert.ok(/sealRecordFields\(loadUsers\(\), USER_SECRET_FIELDS\)/.test(persist) && /JSON\.stringify\(\{ users: sealed\.records \}/.test(persist));
  assert.ok(persist.indexOf('sealed.commit()') > persist.indexOf('atomicWriteFileSync('), 'commit 은 쓰기 뒤');
  assert.equal(/JSON\.stringify\(\{ users: loadUsers\(\) \}/.test(s), false);
  const confirm = s.slice(s.indexOf('export function confirmTotpEnroll('), s.indexOf('export function disableTotp('));
  assert.ok(/SEAL_ERROR_CODES\.has\(e\?\.code\)[\s\S]*for \(const \[k, s0\] of Object\.entries\(snap\)\)/.test(confirm), 'confirm 저장 실패 되돌림(도달 조건 없음 — 소스 대조)');
});

/* ── T23 salt 정리 · T24 평문 점검기 · T25 자가 점검 ─────────────────────────────────────── */
test('T23 salt 정리 — 서로 다른 salt 가 상한(4)을 넘으면 다음 저장이 세션 키 하나로 다시 봉인', () => {
  const sealedSeeds = [];
  for (let i = 0; i < 5; i++) sealedSeeds.push(sealWith(KEY_A, [SEED])[0]);   // 프로세스마다 salt 하나
  const saltOf = (v) => v.split('$')[4];
  assert.equal(new Set(sealedSeeds.map(saltOf)).size, 5);
  const dir = tmpDir();
  policyFiles(dir, ENC);
  put(dir, 'users.json', baseUsers(sealedSeeds.map((v, i) => ({ username: `s${i}`, role: 'admin', totpEnabled: true, totpSecret: v, tokenVersion: 1 }))));
  child(async (c) => { const A = await c.imp('auth/auth.js'); return A.setLocalPassword('view', 'NewPassw0rd!', { trusted: true }).ok; }, dir, { SECRETS_KEY: KEY_A });
  const after1 = usersOf(dir).filter((u) => u.username.startsWith('s')).map((u) => u.totpSecret);
  assert.ok(after1.every(isSealedStr));
  assert.equal(new Set(after1.map(saltOf)).size, 1, '세션 키 하나로 정리');
  // 상한 이하면 다시 바꾸지 않는다(바이트 안정)
  child(async (c) => { const A = await c.imp('auth/auth.js'); return A.setLocalPassword('view', 'NewPassw0rd!2', { trusted: true }).ok; }, dir, { SECRETS_KEY: KEY_A });
  assert.deepEqual(usersOf(dir).filter((u) => u.username.startsWith('s')).map((u) => u.totpSecret), after1);
});

test('T24 평문 점검기 — users.json 의 평문 OTP 시드 · alerts.json url(파일 한정 필드)을 센다', () => {
  const dir = tmpDir();
  put(dir, 'users.json', baseUsers([{ username: 'p1', role: 'admin', totpEnabled: true, totpSecret: SEED, tokenVersion: 1 }]));
  const r = child(async (c) => {
    const S = await c.imp('security/secretScan.js');
    const out = await S.runSecretScan({ fresh: true, sourceDirs: [] });
    const row = out.configFiles.find((x) => x.file === 'users.json');
    return { row: row ? { plain: row.plain, fields: row.items.map((i) => i.field) } : null };
  }, dir);
  assert.ok(r.row, 'users.json 행');
  assert.equal(r.row.plain, 1); assert.deepEqual(r.row.fields, ['totpSecret']);
});

test('T25 자가 점검 — 복호 실패 계정은 OTP 등록 수에서 빠지고 otp-seed-unreadable 이 risk(계정명 없음)', () => {
  const r = child(async (c) => {
    const S = await c.imp('security/selfCheck.js');
    const { checks } = S.collectSelfCheck({ users: [
      { username: 'adm', role: 'admin', totpEnabled: true, otpUnreadable: true },
      { username: 'op', role: 'operator', totpEnabled: true, otpUnreadable: false },
    ] });
    const cov = checks.find((x) => x.id === 'otp-coverage'); const un = checks.find((x) => x.id === 'otp-seed-unreadable');
    return { cov: [cov.status, cov.detail], un: un ? [un.status, un.detail] : null };
  }, tmpDir());
  assert.equal(r.cov[0], 'warn'); assert.match(r.cov[1], /2개 중 1개 등록 · admin 1개 중 0개 등록/);
  assert.ok(r.un); assert.equal(r.un[0], 'risk'); assert.equal(/adm/.test(r.un[1]), false);
});
