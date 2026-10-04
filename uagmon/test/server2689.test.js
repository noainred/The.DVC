/**
 * v2.689 — uagmon 서버 라우터 회귀(실제 프로세스를 띄워 HTTP 로 본다).
 *  B3  무인증 요청 한 줄(`GET //[ HTTP/1.1`)로 프로세스가 죽던 것 → 400 + 계속 실행
 *  500 저장 실패(디스크·권한)도 프로세스를 죽이지 않고 500 + 메모리 되돌림
 *  CSRF/리바인딩 로컬 모드: text/plain 415 · 교차 Origin 403 · 위조 Host 403 · 정상 200
 *  서버(비밀번호) 모드: Host·Origin 불일치는 막지 않는다(리버스 프록시) — Sec-Fetch-Site 만
 *
 * 임시 데이터 디렉터리는 UAGMON_TEST_TMP(없으면 OS 임시 폴더) 아래에 만들고 끝나면 지운다.
 * 실행: node --test uagmon/test/server2689.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP_BASE = process.env.UAGMON_TEST_TMP || os.tmpdir();

function startServer({ host = '127.0.0.1', env = {}, prepare } = {}) {
  const dataDir = fs.mkdtempSync(path.join(TMP_BASE, 'uagmon2689-'));
  if (prepare) prepare(dataDir);
  const childEnv = { ...process.env, ...env };
  if (!env.UAGMON_PASSWORD) delete childEnv.UAGMON_PASSWORD;
  delete childEnv.UAGMON_DATA;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--host', host, '--port', '0', '--data', dataDir], {
    env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  const ready = new Promise((resolve, reject) => {
    const onData = (d) => {
      out += String(d);
      const m = /UAGMON_LISTENING port=(\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`server exited early (${code})\n${out}`)));
    setTimeout(() => reject(new Error(`server not ready\n${out}`)), 10_000).unref();
  });
  return ready.then((port) => ({
    port, host, child,
    get out() { return out; },
    get exited() { return exited; },
    async stop() {
      if (!exited) {
        await new Promise((r) => { child.once('exit', r); child.kill('SIGKILL'); });
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  }));
}

function req(srv, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Host: `127.0.0.1:${srv.port}`, ...headers };
    const r = http.request({ host: srv.host, port: srv.port, method, path: p, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch { /* 본문이 JSON 이 아님 */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    r.on('error', reject);
    // 응답이 오지 않으면(핸들러가 던지고 아무도 응답하지 않음) 매달리지 말고 실패로 끝낸다.
    r.setTimeout(5000, () => r.destroy(new Error(`응답 없음 5s: ${method} ${p}`)));
    if (body != null) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 원시 소켓으로 요청 한 덩어리를 보내고 서버가 닫거나 응답할 때까지 받는다. */
function raw(srv, text) {
  return new Promise((resolve) => {
    const s = net.connect(srv.port, srv.host);
    let got = '';
    s.on('data', (d) => { got += String(d); if (/\r\n\r\n/.test(got)) s.end(); });
    s.on('close', () => resolve(got));
    s.on('error', () => resolve(got));
    s.write(text);
    setTimeout(() => s.destroy(), 3000).unref();
  });
}

const JSON_CT = { 'Content-Type': 'application/json' };
const target = { name: 't1', host: '10.255.255.1', port: 9443, username: 'admin', password: 'pw-test-1', insecureTls: true };

test('B3: GET //[ (URL 파싱 실패) → 400 이고 프로세스는 계속 산다', async () => {
  const srv = await startServer();
  try {
    const resp = await raw(srv, `GET //[ HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\nConnection: close\r\n\r\n`);
    assert.match(resp, /^HTTP\/1\.1 400/, `응답: ${resp.slice(0, 120)}`);
    await sleep(200);
    assert.equal(srv.exited, null, `서버가 죽었다:\n${srv.out}`);
    const meta = await req(srv, { path: '/api/meta' });
    assert.equal(meta.status, 200);
    assert.equal(meta.json.ok, true);
  } finally { await srv.stop(); }
});

test('500: 설정 저장 실패(대상 파일 자리에 디렉터리) → 500 · 프로세스 생존 · 메모리 되돌림', async () => {
  const srv = await startServer({ prepare: (dir) => fs.mkdirSync(path.join(dir, 'uag-config.json'), { recursive: true }) });
  try {
    const r = await req(srv, { method: 'POST', path: '/api/targets', headers: JSON_CT, body: target });
    assert.equal(r.status, 500, r.text);
    assert.equal(r.json.ok, false);
    assert.doesNotMatch(r.text, /EISDIR|rename|uag-config/, '내부 원문을 응답에 싣지 않는다');
    await sleep(100);
    assert.equal(srv.exited, null, `서버가 죽었다:\n${srv.out}`);
    const st = await req(srv, { path: '/api/state' });
    assert.equal(st.status, 200);
    assert.equal(st.json.targets.length, 0, '저장 실패한 대상이 메모리에 남으면 안 된다');
  } finally { await srv.stop(); }
});

test('로컬 모드 CSRF/리바인딩: text/plain 415 · 교차 Origin 403 · Sec-Fetch-Site cross-site 403 · 위조 Host 403', async () => {
  const srv = await startServer();
  try {
    const plain = await req(srv, { method: 'POST', path: '/api/targets', headers: { 'Content-Type': 'text/plain' }, body: target });
    assert.equal(plain.status, 415);
    const noCt = await req(srv, { method: 'POST', path: '/api/targets', headers: {}, body: target });
    assert.equal(noCt.status, 415);
    const cross = await req(srv, { method: 'POST', path: '/api/targets', headers: { ...JSON_CT, Origin: 'http://evil.example' }, body: target });
    assert.equal(cross.status, 403);
    const nullOrigin = await req(srv, { method: 'POST', path: '/api/targets', headers: { ...JSON_CT, Origin: 'null' }, body: target });
    assert.equal(nullOrigin.status, 403);
    const sfs = await req(srv, { method: 'POST', path: '/api/targets', headers: { ...JSON_CT, 'Sec-Fetch-Site': 'cross-site' }, body: target });
    assert.equal(sfs.status, 403);
    const delCross = await req(srv, { method: 'DELETE', path: '/api/targets/abcdef', headers: { Origin: 'http://evil.example' } });
    assert.equal(delCross.status, 403);
    const delPlain = await req(srv, { method: 'DELETE', path: '/api/targets/abcdef', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    assert.equal(delPlain.status, 415);
    // DNS 리바인딩 — Host 가 공격자 도메인
    const rebindRead = await req(srv, { path: '/api/state', headers: { Host: `rebind.evil.example:${srv.port}` } });
    assert.equal(rebindRead.status, 403);
    const rebindWrite = await req(srv, {
      method: 'POST', path: '/api/targets',
      headers: { ...JSON_CT, Host: `rebind.evil.example:${srv.port}`, Origin: `http://rebind.evil.example:${srv.port}` }, body: target,
    });
    assert.equal(rebindWrite.status, 403);
    const st = await req(srv, { path: '/api/state' });
    assert.equal(st.json.targets.length, 0, '거부된 요청이 대상을 만들면 안 된다');
  } finally { await srv.stop(); }
});

test('로컬 모드 정상 경로: 같은 출처 JSON POST 201 · 상태 200 · localhost/[::1] Host · 본문 없는 DELETE 200', async () => {
  const srv = await startServer();
  try {
    const origin = `http://127.0.0.1:${srv.port}`;
    const add = await req(srv, { method: 'POST', path: '/api/targets', headers: { 'Content-Type': 'application/json; charset=utf-8', Origin: origin, 'Sec-Fetch-Site': 'same-origin' }, body: target });
    assert.equal(add.status, 201, add.text);
    const id = add.json.target.id;
    assert.equal(add.json.target.password, undefined, '비밀번호는 응답에 없다');
    const st = await req(srv, { path: '/api/state' });
    assert.equal(st.status, 200);
    assert.equal(st.json.targets.length, 1);
    for (const h of [`localhost:${srv.port}`, `[::1]:${srv.port}`, '127.0.0.1']) {
      assert.equal((await req(srv, { path: '/api/meta', headers: { Host: h } })).status, 200, h);
    }
    const poll = await req(srv, { method: 'POST', path: '/api/poll-now', headers: { ...JSON_CT, Origin: origin }, body: {} });
    assert.equal(poll.status, 200);
    const del = await req(srv, { method: 'DELETE', path: `/api/targets/${id}`, headers: { Origin: origin } });
    assert.equal(del.status, 200);
    assert.equal((await req(srv, { path: '/api/state' })).json.targets.length, 0);
    const idx = await req(srv, { path: '/' });
    assert.equal(idx.status, 200);
  } finally { await srv.stop(); }
});

test('서버(비밀번호) 모드: Host·Origin 불일치는 막지 않는다(프록시) · Sec-Fetch-Site cross-site 와 text/plain 은 막는다', async (t) => {
  let srv;
  try {
    srv = await startServer({ host: '127.0.0.2', env: { UAGMON_PASSWORD: 'server-mode-pw-1' } });
  } catch (err) {
    // 127.0.0.2 바인딩이 안 되는 환경(일부 macOS)에서는 건너뛴다 — 사실대로 표시.
    t.skip(`127.0.0.2 바인딩 불가: ${err.message.split('\n')[0]}`);
    return;
  }
  try {
    const meta = await req(srv, { path: '/api/meta', headers: { Host: 'uag.corp.example' } });
    assert.equal(meta.status, 200);
    assert.equal(meta.json.authRequired, true);
    const login = await req(srv, {
      method: 'POST', path: '/api/login',
      headers: { ...JSON_CT, Host: 'backend:8123', Origin: 'https://uag.corp.example', 'Sec-Fetch-Site': 'same-origin' },
      body: { password: 'wrong' },
    });
    assert.equal(login.status, 401, '프록시가 Host 를 바꿔도 로그인 시도는 403 이 아니라 인증 판정까지 간다');
    const sfs = await req(srv, { method: 'POST', path: '/api/login', headers: { ...JSON_CT, 'Sec-Fetch-Site': 'cross-site' }, body: { password: 'x' } });
    assert.equal(sfs.status, 403);
    const plain = await req(srv, { method: 'POST', path: '/api/login', headers: { 'Content-Type': 'text/plain' }, body: { password: 'x' } });
    assert.equal(plain.status, 415);
    const unauth = await req(srv, { path: '/api/state' });
    assert.equal(unauth.status, 401);
  } finally { await srv.stop(); }
});
