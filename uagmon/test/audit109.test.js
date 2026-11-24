/**
 * 전체 점검 109회차 — uagmon 1차 점검 회귀.
 *  D-1 guard: IPv6 의 다른 표기(0:0:0:0:0:0:0:1 · 0::1 · 0:0:0:0:0:ffff:127.0.0.1 · …ffff:a9fe:a9fe)가 루프백·링크로컬 판정을 비켜 갔다
 *      (UAGMON_ALLOW_PUBLIC=true 에서 통과 — '옵트인과 무관하게 항상 차단' 이 깨졌다). 정규형으로 바꾼 뒤 판정한다.
 *  D-2 server: host 를 바꾸면서 비밀번호를 비운 수정이 200 이었다 — 저장 비밀번호가 조용히 비워지고 폴러가 빈 비밀번호로 로그인했다.
 *      README('재입력을 요구합니다')대로 400 으로 거절하고 저장값은 그대로 둔다.
 *  D-3 폴링 주기: 숫자가 아닌 값(NaN)·2,147,483초 초과는 setInterval 을 1ms 로 만든다 → 10초~1일로 묶는다.
 *  D-4 화면: 인라인 style 속성(setAttribute)은 이 서버의 CSP(style-src 'self')가 막는다 → CSSOM 대입.
 *
 * 임시 데이터 디렉터리는 UAGMON_TEST_TMP(없으면 OS 임시 폴더) 아래에 만들고 끝나면 지운다.
 * 실행: node --test uagmon/test/audit109.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hostBlockReason, canonIpv6 } from '../lib/guard.js';
import { Store, pollSecondsOf, hostChanges, POLL_MIN_SECONDS, POLL_MAX_SECONDS } from '../lib/store.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP_BASE = process.env.UAGMON_TEST_TMP || os.tmpdir();

/* ------------------------------ D-1 guard ------------------------------ */
function withPublic(fn) {
  const prev = process.env.UAGMON_ALLOW_PUBLIC;
  process.env.UAGMON_ALLOW_PUBLIC = 'true';
  try { fn(); } finally { if (prev === undefined) delete process.env.UAGMON_ALLOW_PUBLIC; else process.env.UAGMON_ALLOW_PUBLIC = prev; }
}

test('D-1 canonIpv6: 같은 주소의 다른 표기는 한 정규형이 되고, IPv6 가 아니면 null', () => {
  for (const a of ['::1', '0:0:0:0:0:0:0:1', '0::1', '::0:1', '0000:0000:0000:0000:0000:0000:0000:0001', '0:0:0:0:0:0:0:1%lo']) {
    assert.equal(canonIpv6(a), '::1', a);
  }
  assert.equal(canonIpv6('0:0:0:0:0:ffff:127.0.0.1'), '::ffff:7f00:1');
  assert.equal(canonIpv6('FD12:3456:0:0::1'), 'fd12:3456::1');
  for (const bad of ['', 'abc:def', '1:2', 'uag01.corp.local', '::g', '1::2::3', `${'1:'.repeat(40)}1`, '::1]/x[::2']) {
    assert.equal(canonIpv6(bad), null, JSON.stringify(bad));
  }
});

test('D-1 루프백·미지정·링크로컬(메타데이터)은 IPv6 의 어떤 표기로도 — ALLOW_PUBLIC 에서도 — 막힌다', () => {
  withPublic(() => {
    for (const a of ['0:0:0:0:0:0:0:1', '0::1', '::0:1', '0000:0000:0000:0000:0000:0000:0000:0001', '[0::1]']) {
      assert.match(String(hostBlockReason(a)), /루프백/, a);
    }
    for (const a of ['0::', '0:0:0:0:0:0:0:0', '::0']) assert.match(String(hostBlockReason(a)), /미지정/, a);
    for (const a of ['0:0:0:0:0:ffff:127.0.0.1', '0::ffff:7f00:1', '::ffff:7F00:1', '0000:0000:0000:0000:0000:ffff:7f00:0001']) {
      assert.match(String(hostBlockReason(a)), /루프백\(127/, a);
    }
    for (const a of ['0:0:0:0:0:ffff:a9fe:a9fe', '0::ffff:169.254.169.254']) assert.match(String(hostBlockReason(a)), /링크로컬/, a);
    for (const a of ['fe80::1', 'FE80:0:0::1', 'fe80::1%eth0', 'febf::1']) assert.match(String(hostBlockReason(a)), /링크로컬/, a);
    // IPv6 로 읽을 수 없는 값은 통과시키지 않는다(예전에는 ALLOW_PUBLIC 에서 null — 연결 단계까지 갔다)
    for (const a of ['abc:def', '1:2', '::g']) assert.match(String(hostBlockReason(a)), /형식|문자/, a);
    // 옵트인이 여는 것은 그대로 연다
    assert.equal(hostBlockReason('2001:db8::1'), null);
    assert.equal(hostBlockReason('::ffff:8.8.8.8'), null);
  });
});

test('D-1 기본 설정의 판정은 그대로다 — ULA·사설 IPv4-mapped 허용, 공개 차단', () => {
  delete process.env.UAGMON_ALLOW_PUBLIC;
  for (const a of ['fd12:3456::1', 'fc00::1', 'FD00:0:0:0:0:0:0:1', '[fd00::1]', '::ffff:10.0.0.1', '0:0:0:0:0:ffff:10.0.0.1']) {
    assert.equal(hostBlockReason(a), null, a);
  }
  assert.match(hostBlockReason('2001:db8::1'), /공개 IPv6/);
  assert.match(hostBlockReason('::ffff:8.8.8.8'), /공개 IP/);
  assert.match(hostBlockReason('0:0:0:0:0:0:0:1'), /루프백/); // 예전에는 '공개 IPv6' 사유로 막혔다 — 이제 맞는 사유로
});

/* ------------------------------ D-3 폴링 주기 ------------------------------ */
test('D-3 pollSecondsOf: 못 읽은 값은 기본 30초, 범위 밖은 10초~1일로 묶는다(setInterval 1ms 방지)', () => {
  for (const bad of ['abc', '', null, undefined, NaN, Infinity, true, false, {}, [1, 2]]) {
    assert.equal(pollSecondsOf(bad), 30, String(bad));
  }
  assert.equal(pollSecondsOf(30), 30);
  assert.equal(pollSecondsOf('45'), 45);
  assert.equal(pollSecondsOf(1), POLL_MIN_SECONDS);
  assert.equal(pollSecondsOf(-5), POLL_MIN_SECONDS);
  assert.equal(pollSecondsOf(3_000_000), POLL_MAX_SECONDS);
  assert.equal(pollSecondsOf(99_999_999), POLL_MAX_SECONDS);
  // 어떤 입력이든 setInterval 지연(ms)은 32비트 정수 안이고 최소 10초다
  for (const v of ['abc', 1e12, -1, 12.9, '86401']) {
    const ms = pollSecondsOf(v) * 1000;
    assert.ok(Number.isInteger(ms) && ms >= 10_000 && ms <= 2 ** 31 - 1, `${v} → ${ms}`);
  }
});

test('D-3 Store: 설정 파일의 pollSeconds 가 숫자가 아니어도 읽은 뒤 정상 범위다', () => {
  const dir = fs.mkdtempSync(path.join(TMP_BASE, 'uagmon109-'));
  try {
    fs.writeFileSync(path.join(dir, 'uag-config.json'), JSON.stringify({ v: 1, targets: [], settings: { pollSeconds: '30s', passwordHash: 'x' } }));
    const s = new Store(dir);
    assert.equal(s.settings.pollSeconds, 30);
    assert.equal(s.settings.passwordHash, 'x', '다른 설정은 그대로');
    fs.writeFileSync(path.join(dir, 'uag-config.json'), JSON.stringify({ v: 1, targets: [], settings: { pollSeconds: 5_000_000 } }));
    assert.equal(new Store(dir).settings.pollSeconds, POLL_MAX_SECONDS);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ------------------------------ D-2 host 변경 ------------------------------ */
test('D-2 hostChanges: normalizeTarget 의 비밀번호 이월 금지와 같은 비교', () => {
  const cur = { id: 'x', host: '10.0.0.5' };
  assert.equal(hostChanges({ host: '10.0.0.5' }, cur), false);
  assert.equal(hostChanges({ host: ' 10.0.0.5 ' }, cur), false);
  assert.equal(hostChanges({ name: 'n' }, cur), false, 'host 를 보내지 않은 부분 수정');
  assert.equal(hostChanges({ host: '10.0.0.6' }, cur), true);
  assert.equal(hostChanges({ host: 'UAG.corp' }, { host: 'uag.corp' }), true, '대소문자만 달라도 바뀐 것으로 본다(안전측)');
  assert.equal(hostChanges(5, cur), false);
  assert.equal(hostChanges(null, cur), false);
});

function startServer(extraArgs = []) {
  const dataDir = fs.mkdtempSync(path.join(TMP_BASE, 'uagmon109-'));
  const childEnv = { ...process.env };
  delete childEnv.UAGMON_PASSWORD; delete childEnv.UAGMON_DATA; delete childEnv.UAGMON_ALLOW_PUBLIC; delete childEnv.UAGMON_ALLOWED_DOMAINS;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--host', '127.0.0.1', '--port', '0', '--data', dataDir, ...extraArgs], {
    env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let exited = false;
  child.on('exit', () => { exited = true; });
  const ready = new Promise((resolve, reject) => {
    const onData = (d) => { out += String(d); const m = /UAGMON_LISTENING port=(\d+)/.exec(out); if (m) resolve(Number(m[1])); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`server exited early (${code})\n${out}`)));
    setTimeout(() => reject(new Error(`server not ready\n${out}`)), 10_000).unref();
  });
  return ready.then((port) => ({
    port, dataDir,
    get out() { return out; },
    async stop() {
      if (!exited) await new Promise((r) => { child.once('exit', r); child.kill('SIGKILL'); });
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  }));
}

function req(srv, { method = 'GET', path: p = '/', body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `127.0.0.1:${srv.port}` };
    if (body != null) headers['Content-Type'] = 'application/json';
    const r = http.request({ host: '127.0.0.1', port: srv.port, method, path: p, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch { /* JSON 아님 */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    r.on('error', reject);
    r.setTimeout(5000, () => r.destroy(new Error(`응답 없음 5s: ${method} ${p}`)));
    if (body != null) r.write(JSON.stringify(body));
    r.end();
  });
}

const stored = (srv) => JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'uag-config.json'), 'utf8')).targets;

test('D-2 PUT: host 를 바꾸면서 비밀번호를 비우면 400 이고 저장값(host·비밀번호)은 그대로다', async () => {
  const srv = await startServer();
  try {
    // 10.255.255.1 은 닿지 않는 사설 주소 — 폴러의 연결 시도는 이 테스트의 판정과 무관하다(시한 10초 · 끝나면 프로세스를 끈다)
    const add = await req(srv, { method: 'POST', path: '/api/targets', body: { name: 'a', host: '10.255.255.1', username: 'admin', password: 'secret-pw' } });
    assert.equal(add.status, 201, add.text);
    const id = add.json.target.id;

    const swap = await req(srv, { method: 'PUT', path: `/api/targets/${id}`, body: { name: 'a', host: '10.255.255.2', port: 9443, username: 'admin', password: '', insecureTls: false } });
    assert.equal(swap.status, 400, swap.text);
    assert.match(swap.json.error, /비밀번호를 다시 입력/);
    assert.equal(stored(srv)[0].host, '10.255.255.1', '거절한 수정은 저장하지 않는다');
    assert.equal(stored(srv)[0].password, 'secret-pw', '저장 비밀번호가 조용히 비워지지 않는다');

    // host 만 보낸 부분 수정도 같다
    const part = await req(srv, { method: 'PUT', path: `/api/targets/${id}`, body: { host: '10.255.255.3' } });
    assert.equal(part.status, 400, part.text);

    // host 가 그대로면 비밀번호 없이 수정된다(종전 — 미입력 = 변경 안 함)
    const same = await req(srv, { method: 'PUT', path: `/api/targets/${id}`, body: { name: 'renamed', host: '10.255.255.1', password: '' } });
    assert.equal(same.status, 200, same.text);
    assert.equal(same.json.target.hasPassword, true);
    assert.equal(stored(srv)[0].name, 'renamed');
    assert.equal(stored(srv)[0].password, 'secret-pw');

    // 비밀번호를 함께 주면 host 를 바꿀 수 있다
    const ok = await req(srv, { method: 'PUT', path: `/api/targets/${id}`, body: { host: '10.255.255.2', password: 'new-pw' } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(stored(srv)[0].host, '10.255.255.2');
    assert.equal(stored(srv)[0].password, 'new-pw');

    // 없는 대상은 종전대로 404
    const none = await req(srv, { method: 'PUT', path: '/api/targets/abcdef', body: { host: '10.255.255.9' } });
    assert.equal(none.status, 404, none.text);
  } finally { await srv.stop(); }
});

test('D-3 서버: --poll 이 24.8일을 넘어도 주기가 1일로 묶이고 TimeoutOverflowWarning 이 없다', async () => {
  const srv = await startServer(['--poll', '99999999']);
  try {
    const st = await req(srv, { path: '/api/state' });
    assert.equal(st.status, 200, st.text);
    assert.equal(st.json.pollSeconds, POLL_MAX_SECONDS);
    assert.doesNotMatch(srv.out, /TimeoutOverflowWarning/);
  } finally { await srv.stop(); }
});

/* ------------------------------ D-4 화면 ------------------------------ */
test('D-4 app.js el(): style 은 setAttribute 가 아니라 CSSOM 으로 넣는다(CSP style-src self 가 인라인 속성을 막는다)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const a = src.indexOf('function el(');
  const b = src.indexOf('\n}\n', a);
  assert.ok(a >= 0 && b > a, 'el() 을 찾지 못했다');
  const calls = [];
  const node = () => ({
    className: '', textContent: '', style: { cssText: '' },
    setAttribute(k, v) { calls.push(['attr', k, v]); },
    addEventListener(k) { calls.push(['on', k]); },
    append() {},
  });
  // eslint-disable-next-line no-new-func
  const el = new Function('document', `${src.slice(a, b + 2)}\nreturn el;`)({ createElement: node });
  const n = el('div', { class: 'banner error', style: 'display:none', title: 't', onclick: () => {} });
  assert.equal(n.style.cssText, 'display:none');
  assert.equal(n.className, 'banner error');
  assert.deepEqual(calls.filter((c) => c[0] === 'attr'), [['attr', 'title', 't']], 'style 은 속성으로 넣지 않는다');
  // 서버의 CSP 가 그대로인 동안에만 의미가 있다 — 인라인 스타일을 허용하게 바꾸면 이 테스트를 다시 볼 것
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /style-src 'self'/);
  assert.doesNotMatch(server, /style-src[^;"]*unsafe-inline/);
});
