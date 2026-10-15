/**
 * v2.740 점검 그룹 f · F-11 — UAG 모니터 서버 모드 비밀번호는 무염 SHA-256 이 아니라 scrypt(랜덤 salt)로 저장한다.
 *  · 새 저장 형식 `scrypt$N$r$p$<salt hex>$<hash hex>` — 같은 비밀번호도 저장마다 다르다(사전·레인보우 표가 통하지 않는다).
 *  · 옛 64자 hex(sha256) 저장값도 받는다 — 로그인에 성공하면 새 형식으로 다시 저장한다(업그레이드만으로 잠기지 않게).
 *  · 비교는 timingSafeEqual · 해시는 비동기(scrypt 가 이벤트 루프를 막지 않게) · 동시 로그인이 잠금을 우회하지 못한다.
 * 실행: node --test uagmon/test/auth2740.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Auth, hashPassword, verifyPassword, isLegacyHash } from '../lib/auth.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP_BASE = process.env.UAGMON_TEST_TMP || os.tmpdir();
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

test('F-11 hashPassword — scrypt + 랜덤 salt, 같은 비밀번호도 저장마다 다르다 · 무염 sha256 이 아니다', async () => {
  const a = hashPassword('correct horse battery');
  const b = hashPassword('correct horse battery');
  assert.match(a, /^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.notEqual(a, b, 'salt 가 달라 같은 비밀번호도 다른 값이다');
  assert.ok(!a.includes(sha256('correct horse battery')), '무염 sha256 이 들어 있지 않다');
  assert.deepEqual(await verifyPassword(a, 'correct horse battery'), { ok: true, rehash: false });
  assert.equal((await verifyPassword(a, 'wrong')).ok, false);
  assert.equal((await verifyPassword(b, 'correct horse battery')).ok, true);
});

test('F-11 verifyPassword — 옛 sha256 hex 는 받되 다시 저장하라고 알린다 · 손상·빈 값은 거부', async () => {
  const legacy = sha256('old-password-1');
  assert.equal(isLegacyHash(legacy), true);
  assert.deepEqual(await verifyPassword(legacy, 'old-password-1'), { ok: true, rehash: true });
  assert.equal((await verifyPassword(legacy, 'nope')).ok, false);
  assert.equal((await verifyPassword(legacy.toUpperCase(), 'old-password-1')).ok, false, '옛 형식은 소문자 hex 64자만');
  for (const bad of ['', 'x'.repeat(64), 'scrypt$', 'scrypt$16384$8$1$zz$aa', `scrypt$1$8$1$${'0'.repeat(32)}$${'0'.repeat(64)}`, `scrypt$${2 ** 30}$8$1$${'0'.repeat(32)}$${'0'.repeat(64)}`, null, undefined, 42]) {
    assert.equal((await verifyPassword(bad, 'x')).ok, false, `거부: ${String(bad).slice(0, 40)}`);
  }
});

test('F-11 Auth — 옛 해시로 로그인에 성공하면 새 형식으로 바꾸고 onRehash 로 알린다', async () => {
  const saved = [];
  const auth = new Auth({ required: true, passwordHash: sha256('old-password-1'), onRehash: (h) => saved.push(h) });
  assert.equal((await auth.login('10.0.0.9', 'nope')).ok, false);
  assert.equal(saved.length, 0, '실패는 다시 저장하지 않는다');
  const r = await auth.login('10.0.0.9', 'old-password-1');
  assert.equal(r.ok, true);
  assert.equal(saved.length, 1);
  assert.match(saved[0], /^scrypt\$/);
  assert.equal(auth.passwordHash, saved[0]);
  assert.equal((await auth.login('10.0.0.9', 'old-password-1')).ok, true, '새 형식으로도 같은 비밀번호가 통한다');
  assert.equal(saved.length, 1, '이미 새 형식이면 다시 저장하지 않는다');
  assert.equal(auth.check(`Bearer ${r.token}`), true);
});

test('F-11 동시 로그인이 실패 잠금을 우회하지 못한다(검증을 기다리는 동안에도 시도를 센다)', async () => {
  const auth = new Auth({ required: true, passwordHash: hashPassword('right-pass-1') });
  const rs = await Promise.all(Array.from({ length: 12 }, () => auth.login('10.0.0.7', 'bad')));
  const locked = rs.filter((x) => /잠겼습니다/.test(x.error || '')).length;
  assert.ok(locked >= 12 - 5, `12건 동시 시도 중 잠금 응답 ${locked}건(검증까지 간 것은 5건 이하)`);
  assert.match((await auth.login('10.0.0.7', 'right-pass-1')).error || '', /잠겼습니다/, '잠긴 동안은 맞는 비밀번호도 막는다');
});

/* ── 실제 서버 프로세스 — 옛 해시가 저장된 설정 파일로 로그인하면 파일이 새 형식이 된다 ─────────── */
function startServer({ host, dataDir, env = {} }) {
  const childEnv = { ...process.env, ...env };
  if (!env.UAGMON_PASSWORD) delete childEnv.UAGMON_PASSWORD;
  delete childEnv.UAGMON_DATA;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--host', host, '--port', '0', '--data', dataDir], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  return new Promise((resolve, reject) => {
    const onData = (d) => { out += String(d); const m = /UAGMON_LISTENING port=(\d+)/.exec(out); if (m) resolve({ port: Number(m[1]), child, stop: () => new Promise((r) => { child.once('exit', r); child.kill('SIGKILL'); }) }); };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`server exited early (${code})\n${out}`)));
    setTimeout(() => reject(new Error(`server not ready\n${out}`)), 10_000).unref();
  });
}
function post(host, port, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host, port, method: 'POST', path: p, agent: false, headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' } }, (res) => {
      const chunks = []; res.on('data', (d) => chunks.push(d));
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* */ } resolve({ status: res.statusCode, json }); });
    });
    r.on('error', reject); r.setTimeout(5000, () => r.destroy(new Error('응답 없음')));
    r.end(JSON.stringify(body));
  });
}

test('F-11 서버 — 옛 sha256 설정 파일로 로그인하면 파일이 scrypt 형식으로 다시 저장된다 · --set-password 도 scrypt', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(TMP_BASE, 'uagmon2740-'));
  const file = path.join(dataDir, 'uag-config.json');
  fs.writeFileSync(file, JSON.stringify({ v: 1, targets: [], settings: { pollSeconds: 30, passwordHash: sha256('legacy-pass-9') } }), { mode: 0o600 });
  let srv;
  try {
    try { srv = await startServer({ host: '127.0.0.2', dataDir }); }
    catch (err) { t.skip(`127.0.0.2 바인딩 불가: ${err.message.split('\n')[0]}`); return; }
    assert.equal((await post('127.0.0.2', srv.port, '/api/login', { password: 'wrong' })).status, 401);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).settings.passwordHash, sha256('legacy-pass-9'), '실패 로그인은 파일을 바꾸지 않는다');
    const ok = await post('127.0.0.2', srv.port, '/api/login', { password: 'legacy-pass-9' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const after = JSON.parse(fs.readFileSync(file, 'utf8')).settings.passwordHash;
    assert.match(after, /^scrypt\$/, '성공한 로그인 뒤 새 형식으로 저장됐다');
    assert.equal((await verifyPassword(after, 'legacy-pass-9')).ok, true);
    assert.equal((fs.statSync(file).mode & 0o777), 0o600, '0600 유지');
    await srv.stop(); srv = null;
    // --set-password
    const r = await new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--data', dataDir, '--set-password', 'brand-new-pass-1'], { stdio: ['ignore', 'pipe', 'pipe'] });
      c.on('exit', (code) => resolve(code));
    });
    assert.equal(r, 0);
    const set = JSON.parse(fs.readFileSync(file, 'utf8')).settings.passwordHash;
    assert.match(set, /^scrypt\$/);
    assert.equal((await verifyPassword(set, 'brand-new-pass-1')).ok, true);
  } finally {
    if (srv) await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
