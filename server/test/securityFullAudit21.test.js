/**
 * securityFullAudit21.test.js — 전체 점검 21회차(보안 ② 자격증명 · 비밀 보관) 확정분.
 *  M-1 키가 없을 때 읽기 경로가 새 키를 만들고, 일반 저장 한 번이 전 항목 암호문을 지우던 것 —
 *      봉인된 값이 있으면 키를 만들지 않고, 복호 실패 칸은 원래 암호문을 다시 쓴다(env 를 되돌리면 그대로 복호)
 *  M-2 비밀 칸이 아닌 칸(이름 · 메모)의 봉인 문자열은 열지 않는다(복호 오라클)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REG = path.join(HERE, '../src/vcenter/registry.js');
const VAULT = path.join(HERE, '../src/security/secretVault.js');
const KEY = 'test-secrets-key-0123456789abcdef';
const run = (dir, code, env = {}) => {
  const e = { ...process.env, CONFIG_DIR: dir, DATA_DIR: dir, ...env };
  if (!('SECRETS_KEY' in env)) delete e.SECRETS_KEY;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: e, encoding: 'utf8' });
  const line = r.stdout.trim().split('\n').pop();
  try { return JSON.parse(line); } catch { throw new Error(`${r.stdout}\n${r.stderr}`); }
};

test('M-1 — env 가 빠진 재시작: 키를 만들지 않고 · 이름만 고친 저장이 암호문을 지우지 않는다 · env 복구 후 그대로 복호', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sec21-'));
  try {
    fs.writeFileSync(path.join(d, 'secrets-policy.json'), JSON.stringify({ mode: 'encrypted', level: 2 }));
    const seed = run(d, `const r = await import(${JSON.stringify(REG)});
      const a = r.addVcenter({ id: 'vc-a', name: 'A', host: 'https://10.0.0.1', username: 'u', password: 'PwA-1!' });
      const b = r.addVcenter({ id: 'vc-b', name: 'B', host: 'https://10.0.0.2', username: 'u', password: 'PwB-2!' });
      console.log(JSON.stringify({ a: a.ok, b: b.ok }));`, { SECRETS_KEY: KEY });
    assert.deepEqual(seed, { a: true, b: true });
    assert.ok(fs.readFileSync(path.join(d, 'vcenters.json'), 'utf8').includes('enc$1$'), '봉인됐다(전제)');
    const noEnv = run(d, `const r = await import(${JSON.stringify(REG)});
      const list = r.loadRegistry(); let up;
      try { up = r.updateVcenter('vc-b', { name: 'B2', host: 'https://10.0.0.2', username: 'u' }); } catch (e) { up = { ok: false, code: e.code }; }
      try { r.updateVcenter('vc-a', { name: 'A', host: 'https://10.0.0.9', username: 'u' }); } catch { /* 접속처 변경 */ }
      console.log(JSON.stringify({ pw: list.map((v) => v.password), up: up.ok ?? false, code: up.code || null }));`);
    assert.deepEqual(noEnv.pw, ['', ''], 'env 없이 복호 실패(전제)');
    assert.ok(!fs.existsSync(path.join(d, 'secrets-key')), '봉인된 값이 있으면 새 키를 만들지 않는다(수정 전: 새 키 생성)');
    const back = run(d, `const r = await import(${JSON.stringify(REG)});
      console.log(JSON.stringify(r.loadRegistry().map((v) => [v.id, v.name, v.password])));`, { SECRETS_KEY: KEY });
    assert.equal(back[1][2], 'PwB-2!', '이름만 고친 vc-b 는 env 를 되돌리면 그대로(수정 전: \'\')');
    assert.ok(!back[0][2], '접속처(host)를 바꾼 vc-a 는 옛 비밀을 승계하지 않는다(secretCarry 규약)');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('M-2 — 비밀 칸이 아닌 곳의 봉인 문자열은 열지 않는다', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sec21b-'));
  try {
    fs.writeFileSync(path.join(d, 'secrets-policy.json'), JSON.stringify({ mode: 'encrypted', level: 2 }));
    const out = run(d, `const v = await import(${JSON.stringify(VAULT)});
      const ct = v.sealSecret('S3cr3t-Victim!');
      const o = v.openSecretsDeep({ name: ct, note: ct, list: [ct], password: ct });
      console.log(JSON.stringify({ sealed: v.isSealed(ct), name: o.name === ct, note: o.note === ct, arr: o.list[0] === ct, pw: o.password }));`, { SECRETS_KEY: KEY });
    assert.equal(out.sealed, true);
    assert.equal(out.name, true, 'name 칸은 열지 않는다'); assert.equal(out.note, true); assert.equal(out.arr, true);
    assert.equal(out.pw, 'S3cr3t-Victim!', '비밀 칸은 그대로 연다');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

const CRED = path.join(HERE, '../src/security/credentialStore.js');
const GSCAN = path.join(HERE, '../src/security/guestScanScheduler.js');
test('L-1 — 계정 저장이 실패하면(S-07 잠금) 메모리에도 들어가지 않는다(브로커가 내주지 않음)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sec21c-'));
  try {
    fs.writeFileSync(path.join(d, 'secrets-key'), 'k'.repeat(40));          // 암호화를 쓴 흔적
    fs.writeFileSync(path.join(d, 'secrets-policy.json'), '{ bad');           // 정책 손상 → 잠금
    const out = run(d, `const c = await import(${JSON.stringify(CRED)});
      let err = null; try { c.saveCredential({ name: 'n1', kind: 'password', username: 'svc', password: 'Pw-Locked-1', hosts: ['*'], agents: ['*'] }, { actor: 't' }); } catch (e) { err = e.code || e.message; }
      console.log(JSON.stringify({ err: !!err, n: c.listCredentials ? c.listCredentials().length : null }));`);
    assert.equal(out.err, true, '잠금이면 저장 실패(전제)');
    if (out.n != null) assert.equal(out.n, 0, '메모리 목록에도 없다(수정 전: 들어가 브로커가 내줬다)');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
  const src = fs.readFileSync(CRED, 'utf8');
  assert.match(src, /const next = existing \? db\.items\.map\(\(x\) => \(x === existing \? rec : x\)\) : \[\.\.\.db\.items, rec\];\n  persist\(next\);\n  db\.items = next;/);
});

test('L-2 · L-3 — 게스트 조사: 계정 · vCenter 가 바뀌면 비밀번호를 물려주지 않는다 · 쓰기 실패는 메모리를 바꾸지 않는다', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sec21d-'));
  try {
    const out = run(d, `const g = await import(${JSON.stringify(GSCAN)});
      const a = g.saveGuestScan({ name: 'j', vcenterId: 'vc-A', guestUser: 'CORP\\\\svc-scan', guestPass: 'Dom-Pass-1' });
      g.saveGuestScan({ id: a.id, name: 'j', vcenterId: 'vc-B', guestUser: 'other-user' });
      const fs = await import('node:fs'); const raw = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(d, 'guest-scans.json'))}, 'utf8'));
      g.saveGuestScan({ id: a.id, name: 'j2', vcenterId: 'vc-B', guestUser: 'other-user', guestPass: 'P2' });
      g.saveGuestScan({ id: a.id, name: 'j3', vcenterId: 'vc-B', guestUser: 'other-user' });
      const raw2 = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(d, 'guest-scans.json'))}, 'utf8'));
      console.log(JSON.stringify({ moved: raw[0].guestPass, same: raw2[0].guestPass }));`);
    assert.equal(out.moved, '', 'vCenter · 계정이 바뀌면 승계하지 않는다(수정 전: Dom-Pass-1)');
    assert.equal(out.same, 'P2', '같은 계정 · 같은 대상의 빈 칸은 기존 유지');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
  const src = fs.readFileSync(GSCAN, 'utf8');
  assert.match(src, /writeList\(next\);   \/\/ 21회차 L-3: 실패면 던진다\(메모리 불변\)\n  cache = next;/);
});

test('L-4 · L-8 — 평문 점검 프리뷰: 공백 든 값 · 줄 끝까지 가림 · 위치 숫자가 붙지 않음 · 긴 줄 선형', async () => {
  const { maskLine } = await import('../src/security/secretScan.js');
  const a = maskLine('{"password": "correct horse battery staple"}');
  assert.ok(!/horse|battery|staple/.test(a), a);
  const b = maskLine('password=open sesame now');
  assert.ok(!/sesame|now/.test(b), b); assert.ok(!/\*\*\*\d/.test(b), `위치 숫자가 붙지 않는다: ${b}`);
  const c = maskLine('url https://admin:S3cret@host/x');
  assert.ok(!c.includes('S3cret'), c); assert.ok(!/\*\*\*\d/.test(c), c);
  const long = `://${'a'.repeat(32_000)}`;
  const base = `${'b'.repeat(32_003)}`;
  const t = (s) => { const t0 = performance.now(); maskLine(s); return performance.now() - t0; };
  t(base); const tb = t(base); const tl = t(long);
  assert.ok(tl < Math.max(tb * 20, 15), `긴 줄 ${tl.toFixed(1)}ms · 기준 ${tb.toFixed(1)}ms`);
});

test('L-5 · L-6 · L-7 — 파싱 오류 요약 · KDF 반복 상한 · 자가진단 스위치', async () => {
  const sv = fs.readFileSync(VAULT, 'utf8');
  assert.match(sv, /out\.errors\.push\(\{ file: name, error: safeLoadText\(e, 200\) \|\| '사유 미상' \}\);/);
  assert.match(fs.readFileSync(path.join(HERE, '../src/security/secretScan.js'), 'utf8'), /파싱 실패\(\$\{safeLoadText\(e, 60\) \|\| '사유 미상'\}\)/);
  const { opensshKdfRounds, sshKdfRoundsIssue, SSH_KDF_ROUNDS_MAX } = await import('../src/util/sshKeyKdf.js');
  // 최소 openssh-key-v1 머리(aes256-ctr · bcrypt · salt 16 · rounds N)
  const mk = (rounds) => {
    const s = (b) => { const l = Buffer.alloc(4); l.writeUInt32BE(b.length); return Buffer.concat([l, b]); };
    const opts = Buffer.concat([s(Buffer.alloc(16, 1)), (() => { const r = Buffer.alloc(4); r.writeUInt32BE(rounds); return r; })()]);
    const body = Buffer.concat([Buffer.from('openssh-key-v1\0', 'latin1'), s(Buffer.from('aes256-ctr')), s(Buffer.from('bcrypt')), s(opts), Buffer.alloc(8)]);
    return `-----BEGIN OPENSSH PRIVATE KEY-----\n${body.toString('base64')}\n-----END OPENSSH PRIVATE KEY-----\n`;
  };
  assert.equal(opensshKdfRounds(mk(16)), 16); assert.equal(sshKdfRoundsIssue(mk(16)), null);
  assert.match(sshKdfRoundsIssue(mk(100_000)), /상한/);
  assert.ok(SSH_KDF_ROUNDS_MAX >= 64);
  const { inspectPrivateKey } = await import('../src/security/credentialStore.js');
  const t0 = performance.now(); const r = inspectPrivateKey(mk(100_000), 'pw'); const ms = performance.now() - t0;
  assert.equal(r.ok, false); assert.match(r.reason, /상한/); assert.ok(ms < 1_000, `bcrypt 를 돌리지 않는다 ${ms.toFixed(0)}ms`);
  const { RELAX_SWITCHES } = await import('../src/security/selfCheck.js');
  for (const e of ['VEEAM_TLS_VERIFY', 'TLS_PEER_POLICY', 'SSH_HOSTKEY_POLICY']) assert.ok(RELAX_SWITCHES.some((x) => x.env === e), e);
});
