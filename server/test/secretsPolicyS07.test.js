/**
 * S-07(2026-10-09 검토 보고서) — 암호화 정책이 손상·유실되면 새 비밀이 평문으로 저장되던 결함.
 *
 * 재현(수정 전 코드, 실제 NSX 등록부 저장 경로): ① 실행 중 정책 손상 → 첫 load 는 encrypted 유지, preserveCorrupt 가 원본을
 * 옆으로 치운 뒤 둘째 load 는 '파일 없음' 으로 plain ② 암호화 후 정책 삭제 + 재시작 → plain ③ 손상 + 재시작 → plain
 * ④ `{}`·알 수 없는 mode → normPolicy 가 plain 으로 정규화 ⑤ mode 없이 레벨만 바꾸는 저장 → plain(PUT 라우트는 그 뒤 전 파일을
 * 평문으로 재기록한다). 다섯 경우 모두 다음 저장이 새 비밀을 평문으로 썼다.
 *
 * 고정하는 의미론:
 *  - 신규 설치(정책·키·봉인 값·손상 보존본 전부 없음)와 의도적 plain(정책 파일이 plain)과 명시적 평문 전환(PUT, 감사)은 평문 저장이 맞다.
 *  - 정책을 못 읽으면 직전 유효 정책(실행 중) → 신뢰 사본(secrets-policy.trusted.json) 순으로 복구하고, 둘 다 없는데 암호화를 쓴 흔적이
 *    있으면 **잠금**이다 — 새 비밀은 저장하지 않고(throw), 이미 봉인돼 있던 값은 그 암호문 그대로 다시 쓴다.
 *  - 손상 원본은 지우지 않는다(.corrupt.<ts> 보존) · 기존 키는 바꾸지 않는다 · 정책을 되돌리면 원래 키로 기존 비밀이 열린다.
 *
 * 각 단계는 별도 node 프로세스다(= 재시작 — config.js·secretVault 의 모듈 상태가 새로 시작한다). 저장은 실제 등록부(nsx/registry.js)와
 * 실제 관리 라우트(PUT /api/admin/secrets/policy)로 하고 판정은 디스크의 원문으로 한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src') + '/';
const SEALED = 'enc$1$';

const freshDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-s07-'));
const POLICY = 'secrets-policy.json';
const TRUSTED = 'secrets-policy.trusted.json';

/** 한 프로세스(= 한 번의 기동)에서 body 를 실행하고 out 객체를 돌려준다. */
function run(dir, body, env = {}) {
  const script = `
    const SRC = ${JSON.stringify(SRC)};
    const v = await import(SRC + 'security/secretVault.js');
    const nsx = await import(SRC + 'nsx/registry.js');
    const fs = await import('node:fs'); const path = await import('node:path');
    const DIR = ${JSON.stringify(dir)};
    const raw = (n) => { try { return fs.readFileSync(path.join(DIR, n), 'utf8'); } catch { return null; } };
    const stored = (id) => { const j = JSON.parse(raw('nsx.json') || '{"managers":[]}'); return j.managers.find((m) => m.id === id)?.password ?? null; };
    const expire = async () => { if (v._resetSecretsPolicyCache) v._resetSecretsPolicyCache(); else await new Promise((r) => setTimeout(r, 3100)); };
    const add = (id, pw) => { try { const r = nsx.addManager({ id, name: id, host: 'https://nsx-' + id + '.example.local', username: 'admin', password: pw }); return r.ok ? 'ok' : r.reason; } catch (e) { return 'THROW:' + (e.code || '') + ':' + e.message; } };
    const out = {};
    ${body}
    process.stdout.write('\\n@@OUT@@' + JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(HERE, '..'), encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', SECRETS_KEY: '', ...env },
  });
  const m = String(r.stdout || '').split('@@OUT@@');
  if (r.status !== 0 || m.length < 2) assert.fail(`자식 프로세스 실패(status ${r.status}): ${String(r.stderr || '').slice(-1500)}`);
  return { out: JSON.parse(m.pop()), stderr: String(r.stderr || '') };
}

const readRaw = (dir, n) => { try { return fs.readFileSync(path.join(dir, n), 'utf8'); } catch { return null; } };
const nsxPw = (dir, id) => JSON.parse(readRaw(dir, 'nsx.json') || '{"managers":[]}').managers.find((m) => m.id === id)?.password ?? null;
const corruptCopies = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith(`${POLICY}.corrupt.`));

/** 암호화를 켜고 비밀 하나(OLD)를 봉인 저장한 설치를 만든다(첫 기동). */
function encryptedInstall() {
  const dir = freshDir();
  const { out } = run(dir, `out.pol = v.saveSecretsPolicy({ mode: 'encrypted', level: 1, algorithm: '' }); out.add = add('old', 'OLD-SECRET');`);
  assert.equal(out.add, 'ok');
  assert.ok(nsxPw(dir, 'old').startsWith(SEALED), '준비: OLD 는 봉인 저장');
  return { dir, key: readRaw(dir, 'secrets-key') };
}

/* ── 정상 경로(회귀 금지) ─────────────────────────────────────────────── */

test('신규 설치 — 정책·키가 없으면 평문(기본) 그대로이고 키·신뢰 사본을 만들지 않는다', () => {
  const dir = freshDir();
  const { out } = run(dir, `out.pol = v.loadSecretsPolicy(); out.add = add('a', 'NEW-A');`);
  assert.deepEqual(out.pol, { mode: 'plain', level: 2, algorithm: '' }, '신규 설치 정책 모양은 예전과 같다');
  assert.equal(out.add, 'ok');
  assert.equal(nsxPw(dir, 'a'), 'NEW-A', '신규 설치는 평문 저장이 맞다');
  assert.equal(fs.existsSync(path.join(dir, 'secrets-key')), false, '평문 설치에서 키를 만들지 않는다');
  assert.equal(fs.existsSync(path.join(dir, TRUSTED)), false, '정책 파일이 없으면 신뢰 사본도 만들지 않는다');
});

test('의도적 plain — 정책 파일이 plain 이면 재시작 뒤에도 평문 저장', () => {
  const dir = freshDir();
  run(dir, `v.saveSecretsPolicy({ mode: 'plain' });`);
  const { out } = run(dir, `out.pol = v.loadSecretsPolicy(); out.add = add('b', 'NEW-B');`);
  assert.deepEqual(out.pol, { mode: 'plain', level: 2, algorithm: '' });
  assert.equal(nsxPw(dir, 'b'), 'NEW-B');
  assert.equal(JSON.parse(readRaw(dir, TRUSTED)).mode, 'plain', '저장 시 신뢰 사본도 같은 정책으로 남는다');
});

/* ── 결함 재현(수정 전에는 전부 평문 저장) ───────────────────────────── */

test('warm 손상 — 손상 후 load 를 두 번 해도 encrypted 유지 · 새 비밀은 봉인 · 손상 원본 보존', () => {
  const { dir } = encryptedInstall();
  const { out } = run(dir, `
    out.first = v.loadSecretsPolicy();
    fs.writeFileSync(path.join(DIR, ${JSON.stringify(POLICY)}), '{ broken');
    out.load1 = v.loadSecretsPolicy(); out.load2 = v.loadSecretsPolicy();
    await expire();
    out.add = add('c', 'NEW-C');
    out.read = nsx.loadRegistry().find((m) => m.id === 'c')?.password;`);
  assert.equal(out.first.mode, 'encrypted');
  assert.equal(out.load1.mode, 'encrypted', '첫 load');
  assert.equal(out.load2.mode, 'encrypted', '둘째 load — 손상본이 옆으로 치워진 뒤에도 plain 으로 내려가지 않는다');
  assert.equal(out.load2.recovered, 'last-good', '실행 중에는 직전 유효 정책(이 프로세스가 읽은 값)을 먼저 쓴다');
  assert.equal(out.add, 'ok');
  assert.ok(nsxPw(dir, 'c').startsWith(SEALED), `새 비밀이 평문으로 저장됨: ${nsxPw(dir, 'c')}`);
  assert.equal(out.read, 'NEW-C', '봉인 값은 다시 열린다');
  assert.equal(corruptCopies(dir).length, 1, '손상 원본은 .corrupt.<ts> 로 보존');
});

test('암호화 후 정책 삭제 — 실행 중이면 직전 정책, 재시작이면 신뢰 사본으로 계속 봉인', () => {
  const { dir } = encryptedInstall();
  const warm = run(dir, `
    out.before = v.loadSecretsPolicy();
    fs.rmSync(path.join(DIR, ${JSON.stringify(POLICY)}));
    out.after = v.loadSecretsPolicy(); await expire(); out.add = add('d1', 'NEW-D1');`).out;
  assert.equal(warm.after.mode, 'encrypted');
  assert.ok(nsxPw(dir, 'd1').startsWith(SEALED), `warm: 새 비밀이 평문: ${nsxPw(dir, 'd1')}`);
  const cold = run(dir, `out.pol = v.loadSecretsPolicy(); out.again = v.loadSecretsPolicy(); out.add = add('d2', 'NEW-D2');`).out;
  assert.equal(cold.again.recovered, 'trusted-copy', '둘째 load 도 출처(신뢰 사본)를 바르게 말한다 — 사본 값을 직전 정책이라 하지 않는다');
  assert.equal(cold.pol.mode, 'encrypted', '재시작 — 신뢰 사본으로 복구');
  assert.equal(cold.pol.level, 1, '레벨까지 복구(기본 레벨로 바꾸지 않는다)');
  assert.equal(cold.pol.recovered, 'trusted-copy');
  assert.ok(nsxPw(dir, 'd2').startsWith(SEALED), `cold: 새 비밀이 평문: ${nsxPw(dir, 'd2')}`);
  assert.equal(fs.existsSync(path.join(dir, POLICY)), false, '정책 파일을 자동으로 다시 쓰지 않는다(복구는 명시적으로)');
});

test('cold 손상 + 신뢰 사본도 없음 — 잠금: 새 비밀 저장 거부 · 기존 암호문은 그대로 다시 씀 · 손상본 보존', () => {
  const { dir, key } = encryptedInstall();
  fs.rmSync(path.join(dir, TRUSTED), { force: true });
  const original = readRaw(dir, POLICY);
  fs.writeFileSync(path.join(dir, POLICY), '{"mode":"encr');
  const oldCipher = nsxPw(dir, 'old');
  const r1 = run(dir, `
    out.pol = v.loadSecretsPolicy();
    out.add = add('e1', 'NEW-E1');
    try { out.upd = nsx.updateManager('old', { enabled: false }); } catch (e) { out.upd = 'THROW:' + e.message; }
    try { out.direct = v.sealSecret('NEW-DIRECT'); } catch (e) { out.direct = 'THROW:' + (e.code || ''); }
    out.empty = v.sealSecret('');`);
  assert.notEqual(r1.out.pol.mode, 'plain', `손상 정책이 plain 으로 해석됨: ${JSON.stringify(r1.out.pol)}`);
  assert.equal(r1.out.pol.locked, true);
  assert.match(String(r1.out.add), /^THROW:SECRETS_POLICY_UNAVAILABLE:/, `새 비밀 저장은 거부: ${r1.out.add}`);
  assert.equal(nsxPw(dir, 'e1'), null, '거부된 비밀은 디스크에 없다');
  assert.ok(!readRaw(dir, 'nsx.json').includes('NEW-E1'));
  assert.equal(r1.out.upd?.ok, true, `비밀이 그대로인 수정은 저장된다: ${JSON.stringify(r1.out.upd)}`);
  assert.equal(nsxPw(dir, 'old'), oldCipher, '기존 암호문을 그대로 다시 쓴다(평문으로 풀지 않는다)');
  assert.match(String(r1.out.direct), /^THROW:SECRETS_POLICY_UNAVAILABLE/);
  assert.equal(r1.out.empty, '', '빈 값은 그대로(비밀이 아니다)');
  assert.deepEqual(corruptCopies(dir).map((n) => readRaw(dir, n)), ['{"mode":"encr'], '손상 원본 보존');
  // 둘째 재시작 — 손상본이 옆으로 치워져 정책 파일이 '없음' 이 되어도 신규 설치로 보지 않는다
  const r2 = run(dir, `out.pol = v.loadSecretsPolicy(); out.add = add('e2', 'NEW-E2');`);
  assert.equal(r2.out.pol.locked, true, `손상본을 치운 뒤 재시작이 plain 이 됨: ${JSON.stringify(r2.out.pol)}`);
  assert.equal(nsxPw(dir, 'e2'), null);
  assert.equal(readRaw(dir, 'secrets-key'), key, '키는 바뀌지 않는다');
  // 복구 — 원래 정책 파일을 되돌리면 원래 키로 기존 비밀이 열리고 새 비밀은 봉인된다
  fs.writeFileSync(path.join(dir, POLICY), original);
  const r3 = run(dir, `out.pol = v.loadSecretsPolicy(); out.old = nsx.loadRegistry().find((m) => m.id === 'old')?.password; out.add = add('e3', 'NEW-E3');`);
  assert.deepEqual(r3.out.pol, { mode: 'encrypted', level: 1, algorithm: '' });
  assert.equal(r3.out.old, 'OLD-SECRET', '복구 후 원래 키로 기존 비밀을 읽는다');
  assert.ok(nsxPw(dir, 'e3').startsWith(SEALED));
  assert.equal(readRaw(dir, 'secrets-key'), key);
});

test('비밀 없이 암호화만 켠 설치 — 정책·사본이 함께 사라져도 키 파일·손상 보존본이 흔적이 되어 잠금', () => {
  // ① 키 파일 흔적: 암호화를 켜는 저장이 키를 미리 만든다(첫 봉인 전에 정책을 잃어도 신규 설치로 보지 않게)
  const a = freshDir();
  run(a, `v.saveSecretsPolicy({ mode: 'encrypted', level: 2 });`);
  assert.ok(fs.existsSync(path.join(a, 'secrets-key')), '암호화를 켜면 키가 준비된다');
  fs.rmSync(path.join(a, POLICY)); fs.rmSync(path.join(a, TRUSTED));
  const ra = run(a, `out.pol = v.loadSecretsPolicy(); out.add = add('g1', 'NEW-G1');`).out;
  assert.equal(ra.pol.locked, true, `정책·사본 삭제 + 키 파일 → 잠금이어야 함: ${JSON.stringify(ra.pol)}`);
  assert.deepEqual(ra.pol.evidence, ['key-file']);
  assert.equal(nsxPw(a, 'g1'), null);
  // ② 손상 보존본 흔적: 키가 env(SECRETS_KEY)라 키 파일이 없어도, 손상본을 치운 뒤 재시작이 신규 설치로 보이지 않는다
  const b = freshDir();
  const env = { SECRETS_KEY: 'k'.repeat(40) };
  run(b, `v.saveSecretsPolicy({ mode: 'encrypted', level: 2 });`, env);
  assert.equal(fs.existsSync(path.join(b, 'secrets-key')), false, 'env 키면 키 파일을 만들지 않는다');
  fs.rmSync(path.join(b, TRUSTED));
  fs.writeFileSync(path.join(b, POLICY), '{"mode":');
  const rb1 = run(b, `out.pol = v.loadSecretsPolicy(); out.add = add('h1', 'NEW-H1');`, env).out;
  assert.equal(rb1.pol.locked, true, '손상 정책은 흔적과 무관하게 잠금');
  const rb2 = run(b, `out.pol = v.loadSecretsPolicy(); out.add = add('h2', 'NEW-H2');`, env).out;
  assert.equal(rb2.pol.locked, true, `손상본을 치운 뒤 재시작이 plain 이 됨: ${JSON.stringify(rb2.pol)}`);
  assert.deepEqual(rb2.pol.evidence, ['corrupt-policy-copy']);
  assert.equal(nsxPw(b, 'h1'), null); assert.equal(nsxPw(b, 'h2'), null);
});

for (const [label, txt] of [['{}', '{}'], ['알 수 없는 mode', '{"mode":"hsm","level":2,"algorithm":""}'], ['배열', '[]'], ['mode 없는 레벨만', '{"level":3}']]) {
  test(`의미가 잘못된 정책(${label}) — plain 으로 정규화하지 않는다`, () => {
    const { dir } = encryptedInstall();
    fs.writeFileSync(path.join(dir, POLICY), txt);
    const withCopy = run(dir, `out.pol = v.loadSecretsPolicy(); out.add = add('f1', 'NEW-F1');`).out;
    assert.equal(withCopy.pol.mode, 'encrypted', `신뢰 사본으로 복구되어야 함: ${JSON.stringify(withCopy.pol)}`);
    assert.ok(nsxPw(dir, 'f1').startsWith(SEALED), `새 비밀이 평문: ${nsxPw(dir, 'f1')}`);
    assert.deepEqual(corruptCopies(dir).map((n) => readRaw(dir, n)), [txt], '잘못된 정책도 손상본으로 보존');
    // 신뢰 사본도 없으면 잠금
    fs.rmSync(path.join(dir, TRUSTED));
    fs.writeFileSync(path.join(dir, POLICY), txt);
    const locked = run(dir, `out.pol = v.loadSecretsPolicy(); out.add = add('f2', 'NEW-F2');`).out;
    assert.equal(locked.pol.locked, true);
    assert.equal(nsxPw(dir, 'f2'), null);
  });
}

test('명시적 정책 저장 — mode 를 빼면 현재 방식 유지 · 알 수 없는 mode 는 거부(평문으로 바꾸지 않는다)', () => {
  const { dir } = encryptedInstall();
  const { out } = run(dir, `
    out.levelOnly = v.saveSecretsPolicy({ mode: undefined, level: 3, algorithm: '' });
    try { out.bad = v.saveSecretsPolicy({ mode: 'rot13' }); } catch (e) { out.bad = 'THROW:' + e.message; }
    try { out.mig = v.migrateSecretFiles({ mode: 'unavailable' }); } catch (e) { out.mig = 'THROW:' + e.message; }
    out.after = v.loadSecretsPolicy();`);
  assert.equal(out.levelOnly.mode, 'encrypted', 'mode 없는 저장이 plain 이 됨');
  assert.equal(out.levelOnly.level, 3);
  assert.match(String(out.bad), /^THROW:/, '알 수 없는 mode 는 저장하지 않는다');
  assert.match(String(out.mig), /^THROW:/, '정책이 아닌 값으로 전 파일을 재기록하지 않는다');
  assert.equal(out.after.mode, 'encrypted');
  assert.ok(nsxPw(dir, 'old').startsWith(SEALED), '기존 파일이 평문으로 재기록되지 않았다');
});

/* ── 실제 관리 라우트: 명시적 전환만 평문으로 간다 ────────────────────── */

const ROUTE = `
  const express = (await import('express')).default;
  const { adminRouter } = await import(SRC + 'routes/admin.js');
  const app = express(); app.use(express.json());
  app.use((req, _r, n) => { req.user = { username: 'owner', role: 'admin', scope: null }; n(); });
  app.use('/api/admin', adminRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const put = async (b) => { const r = await fetch(base + '/api/admin/secrets/policy', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { s: r.status, j: await r.json() }; };
  const get = async () => (await fetch(base + '/api/admin/secrets/policy')).json();
`;

test('라우트 — mode 없는 PUT 은 암호화 유지, 잘못된 mode 는 400, 명시적 plain 은 전환(감사)', () => {
  const { dir } = encryptedInstall();
  const { out } = run(dir, `${ROUTE}
    out.levelOnly = await put({ level: 3 });
    out.bad = await put({ mode: 'rot13' });
    out.cipherAfterLevel = JSON.parse(raw('nsx.json')).managers[0].password;
    out.toPlain = await put({ mode: 'plain', level: 2, algorithm: '' });
    out.audit = raw('audit.ndjson');
    srv.close();`);
  assert.equal(out.levelOnly.s, 200);
  assert.equal(out.levelOnly.j.policy.mode, 'encrypted', 'mode 없는 PUT 이 평문 전환이 됨');
  assert.ok(out.cipherAfterLevel.startsWith(SEALED), '레벨 변경은 다시 봉인할 뿐 평문으로 풀지 않는다');
  assert.equal(out.bad.s, 400);
  assert.equal(out.toPlain.s, 200);
  assert.equal(out.toPlain.j.policy.mode, 'plain');
  assert.equal(nsxPw(dir, 'old'), 'OLD-SECRET', '명시적 평문 전환은 기존 비밀을 평문으로 전환한다(의도된 동작)');
  assert.match(String(out.audit), /자격증명 저장 방식 변경/, '전환은 감사 로그에 남는다');
});

test('라우트 — 잠금 상태: GET 이 잠금을 알리고, mode 없는 PUT 은 400, 명시적 선택으로 복구', () => {
  const { dir, key } = encryptedInstall();
  fs.rmSync(path.join(dir, TRUSTED));
  fs.rmSync(path.join(dir, POLICY));
  const { out } = run(dir, `${ROUTE}
    out.get = await get();
    out.noMode = await put({ level: 2 });
    out.enc = await put({ mode: 'encrypted', level: 1, algorithm: '' });
    out.after = v.loadSecretsPolicy();
    out.old = nsx.loadRegistry().find((m) => m.id === 'old')?.password;
    out.audit = raw('audit.ndjson');
    srv.close();`);
  assert.equal(out.get.policy.locked, true, `GET 이 잠금을 알려야 한다: ${JSON.stringify(out.get.policy)}`);
  assert.ok(Array.isArray(out.get.policy.evidence) && out.get.policy.evidence.length > 0, '잠금 근거를 밝힌다');
  assert.equal(out.noMode.s, 400, 'mode 를 정하지 않은 저장은 거부');
  assert.equal(out.enc.s, 200);
  assert.deepEqual(out.after, { mode: 'encrypted', level: 1, algorithm: '' });
  assert.equal(out.old, 'OLD-SECRET', '원래 키로 기존 비밀이 열린다');
  assert.equal(readRaw(dir, 'secrets-key'), key, '키는 그대로');
  assert.match(String(out.audit), /정책 읽기 실패/, '감사 로그의 이전 상태가 평문이라고 적히지 않는다');
});
