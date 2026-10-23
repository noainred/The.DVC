/**
 * v2.767(점검 R2-B5-5 — 재현) — fetchUagStats 의 시한은 요청 '전체' 시한이다.
 *  예전에는 https.request 의 timeout(소켓 유휴 시한)뿐이라, 응답을 시한보다 짧은 간격으로 1바이트씩 흘리는 대상이 요청을
 *  무한정 붙잡았다(2초 시한에 13초). 폴러는 전 대상을 기다리므로(Promise.allSettled) 모든 UAG 수집이 멈췄다.
 *  MAX_BODY 를 넘는 응답도 버리기만 하고 끝까지 받았고, dns.lookup 에는 시한이 없었다. 해석 결과 재검증(핀 IP)은 유지한다.
 *
 * 실행: node --test uagmon/test/uag2767.test.js  (openssl 이 없으면 TLS 서버가 필요한 항목은 건너뛴다)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { fetchUagStats } from '../lib/uag.js';

function makePem() {
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uag2767-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem')], { stdio: 'ignore' });
    const pem = { key: fs.readFileSync(path.join(tmp, 'k.pem')), cert: fs.readFileSync(path.join(tmp, 'c.pem')) };
    fs.rmSync(tmp, { recursive: true, force: true });
    return pem;
  } catch { return null; }
}
const PEM = makePem();

async function withServer(handler, fn) {
  const sockets = new Set();
  const srv = https.createServer(PEM, handler);
  srv.on('secureConnection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { return await fn(srv.address().port, sockets); }
  finally {
    for (const s of sockets) s.destroy();
    await new Promise((r) => srv.close(r));
  }
}

const target = (port) => ({ host: '127.0.0.1', port, insecureTls: true, username: 'u', password: 'p' });

test('정상 응답은 그대로 읽는다', { skip: !PEM && 'openssl 없음', timeout: 15_000 }, async () => {
  await withServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"totalSessionCount": 5}'); },
    async (port) => {
      const r = await fetchUagStats(target(port), { timeoutMs: 3000 });
      assert.equal(r.ok, true);
      assert.equal(r.totalSessions, 5);
    });
});

test('응답을 조금씩 흘리는 대상도 전체 시한에 끊는다', { skip: !PEM && 'openssl 없음', timeout: 15_000 }, async () => {
  const timers = [];
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{');
    // 소켓 유휴 시한(=전체 시한)보다 훨씬 짧은 간격으로 1바이트씩 — 유휴 시한만으로는 영원히 끊기지 않는다.
    const t = setInterval(() => { try { res.write(' '); } catch { /* 끊김 */ } }, 100);
    timers.push(t);
    res.on('close', () => clearInterval(t));
  }, async (port, sockets) => {
    const t0 = Date.now();
    const r = await fetchUagStats(target(port), { timeoutMs: 800 });
    const took = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.match(r.error, /전체 0\.8s 초과/);
    assert.ok(took < 2500, `전체 시한 0.8초인데 ${took}ms 걸렸다`);
    // 끊은 뒤에는 연결도 닫힌다(소켓을 붙잡고 있지 않는다).
    for (let i = 0; i < 40 && sockets.size > 0; i++) await new Promise((r2) => setTimeout(r2, 50));
    assert.equal(sockets.size, 0, '시한 뒤에도 연결이 남았다');
  });
  timers.forEach(clearInterval);
});

test('응답 상한(2MB)을 넘으면 끝까지 받지 않고 곧바로 끊는다', { skip: !PEM && 'openssl 없음', timeout: 15_000 }, async () => {
  let serverSawClose = false;
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write(Buffer.alloc(3 * 1024 * 1024, 0x20));   // 상한 초과분을 보낸 뒤 끝내지 않는다
    res.on('close', () => { serverSawClose = true; });
  }, async (port) => {
    const t0 = Date.now();
    const r = await fetchUagStats(target(port), { timeoutMs: 20_000 });
    const took = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.match(r.error, /너무 큽니다/);
    assert.ok(took < 10_000, `상한 초과인데 시한(20초) 근처까지 기다렸다: ${took}ms`);
    for (let i = 0; i < 40 && !serverSawClose; i++) await new Promise((r2) => setTimeout(r2, 50));
    assert.equal(serverSawClose, true, '상한 초과 뒤 연결을 끊지 않았다');
  });
});

test('주소 해석(dns.lookup)도 전체 시한과 경쟁한다', { timeout: 15_000 }, async () => {
  let called = false;
  const t0 = Date.now();
  const r = await fetchUagStats({ host: 'uag.example.internal', port: 9443 },
    { timeoutMs: 300, lookup: () => { called = true; return new Promise(() => {}); } });
  const took = Date.now() - t0;
  assert.equal(called, true, '끝나지 않는 해석을 거치지 않았다');
  assert.equal(r.ok, false);
  assert.match(r.error, /0\.3s 안에 끝나지 않음/);
  assert.match(r.error, /주소 해석 실패/);
  assert.ok(took < 2000, `해석이 끝나지 않는데 ${took}ms 기다렸다`);
});

test('해석 결과 재검증(핀 IP)은 그대로 — 루프백으로 해석되면 접속하지 않는다', async () => {
  let asked = null;
  const r = await fetchUagStats({ host: 'uag.example.internal', port: 9443 }, {
    timeoutMs: 1000,
    lookup: async (h, o) => { asked = { h, o }; return { address: '127.0.0.1', family: 4 }; },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /차단된 주소로 해석됨\(127\.0\.0\.1\)/);
  assert.deepEqual(asked, { h: 'uag.example.internal', o: { verbatim: true } });
});

test('소스 — 전체 시한 타이머는 done 에서 해제하고 server.js 주석이 유휴 시한을 전체 시한으로 부르지 않는다', () => {
  const src = fs.readFileSync(new URL('../lib/uag.js', import.meta.url), 'utf8');
  assert.match(src, /if \(wall\) clearTimeout\(wall\)/);
  const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.doesNotMatch(server, /per-target 10s 타임아웃 내장/);
});
