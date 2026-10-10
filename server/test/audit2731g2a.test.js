/**
 * v2.731 점검 1회차 그룹 G2a.
 *
 * A3-01 ① 업그레이드 원격 소스 주소(remoteBase)를 바꾸고 토큰 칸을 비워 저장하면 저장(또는 env UPGRADE_TOKEN) 토큰이
 *         새 주소의 versions.json 요청에 Bearer 로 실렸다 — **실제 upgradeRouter** 를 express 에 마운트해 PUT → POST /check 를 부르고
 *         목 수신 서버가 받은 Authorization 헤더로 판정한다. 폐기 사실은 응답 droppedSecrets·skipped 로 밝힌다.
 *       ② 위임 IP 스캔 할당(central/assignments.js)의 대역(ips)·계정(username)을 바꾸고 비밀번호 칸을 비워 저장하면 기존 iDRAC
 *         비밀번호가 그대로 남아 엣지가 새 대역에 그 비밀번호로 로그인했다 — **실제 admin 라우터**(registerHorizonAssign)로
 *         수정·CSV merge 가져오기를 부르고 getAssignment 의 password(엣지에 내려가는 값)로 판정한다.
 * A4-03   엣지 IP 스캔 워커가 중앙 배정 응답의 에이전트별 intervalMs 를 무시하고 env(AGENT_SCAN_INTERVAL_MS)로 고정한
 *         setInterval 을 돌았다 — 목 중앙으로 runIpScanAgentOnce 를 실제 호출해 상태의 주기·스캔 여부로 판정한다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2731g2a-'));
Object.assign(process.env, {
  CONFIG_DIR: CFG, DATA_SOURCE: 'live', AUTH_ENABLED: 'false', SSRF_ALLOW_LOOPBACK: 'true',
  IPAM_WRITE_WORKER: '0', IPSCAN_WORKER: 'false', IPSCAN_USE_WORKER: 'false',
  UPGRADE_TOKEN: 'ENV-PAT-999', UPGRADE_REMOTE_BASE: 'https://mirror.corp.example/dl',
  AGENT_SCAN_INTERVAL_MS: '3600000', AGENT_NAME: 'site-g2a', CENTRAL_TOKEN: 'shared-g2a',
});
fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: [] }));

const express = (await import('express')).default;
const { config } = await import('../src/config.js');

const listen = async (handler) => {
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return s;
};
const asAdmin = (req, _res, next) => { req.user = { username: 'admin2', role: 'admin', scope: { vcenters: [], regions: [], writeVcenters: [] } }; next(); };
// 화면 문구 모듈(웹 — 순수 ESM). 서버 응답이 화면에서 어떻게 말해지는지를 같은 함수로 본다.
const webText = await import(pathToFileURL(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../web/src/views/droppedSecretText.js')).href);
const noMarkup = (t) => { assert.ok(t && !/[`*]/.test(t), `화면 문구에 백틱·별표: ${t}`); };
const quiet = async (fn) => {
  const w = console.warn; const l = console.log; const e = console.error;
  console.warn = () => {}; console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.warn = w; console.log = l; console.error = e; }
};

// ─────────────────────────────────────────────────────────────────────────────
test('A3-01 ①: remoteBase 가 바뀌면 저장·env 토큰을 승계하지 않는다(새 주소로 Bearer 가 나가지 않는다)', async () => {
  const got = [];
  const evil = await listen((req, res) => { got.push({ url: req.url, auth: req.headers.authorization || null }); res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}'); });
  const { upgradeRouter } = await import('../src/routes/upgrade.js');
  const { loadSettings } = await import('../src/upgrade/settings.js');
  const app = express();
  app.use(express.json());
  app.use(asAdmin);
  app.use('/api/upgrade', upgradeRouter);
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}/api/upgrade`;
  const evilBase = `http://127.0.0.1:${evil.address().port}`;
  const put = (body) => fetch(`${base}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  const check = async () => { got.length = 0; await quiet(() => fetch(`${base}/check`, { method: 'POST' }).then((r) => r.text())); return got.slice(); };
  try {
    // 처음: env 토큰이 있다(UPGRADE_TOKEN).
    assert.equal(loadSettings().token, 'ENV-PAT-999');

    // (a) 웹 화면과 같은 본문(토큰 칸 비움 → token 키 없음)으로 주소만 바꾼다.
    const a = await put({ enabled: true, remoteBase: `${evilBase}/evil`, autoApply: false });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual(a.body.droppedSecrets, ['token'], '폐기 사실을 응답에 싣는다');
    assert.ok(a.body.skipped?.some((x) => x.field === 'token' && /토큰/.test(x.reason)), JSON.stringify(a.body.skipped));
    assert.equal(a.body.settings.hasToken, false);
    const noteA = webText.droppedSecretNote(a.body);
    assert.match(noteA, /^저장했습니다 — 단 원격 소스 주소가 바뀌어/, noteA);
    noMarkup(noteA);
    let seen = await check();
    assert.ok(seen.some((x) => x.url === '/evil/versions.json'), JSON.stringify(seen));
    assert.ok(seen.every((x) => x.auth === null), `새 주소가 토큰을 받았다: ${JSON.stringify(seen)}`);
    // env 토큰이 되살아나지 않는다(저장값 token:'' 가 env 를 덮는다).
    assert.equal(loadSettings().token, '');

    // (b) 주소와 함께 새 토큰을 주면 그 토큰을 쓴다(폐기 아님).
    const b = await put({ remoteBase: `${evilBase}/mirror2/`, token: 'PAT-NEW' });
    assert.equal(b.status, 200);
    assert.equal(b.body.droppedSecrets, undefined, JSON.stringify(b.body));
    assert.equal(b.body.settings.hasToken, true);
    seen = await check();
    assert.ok(seen.length && seen.every((x) => x.auth === 'Bearer PAT-NEW'), JSON.stringify(seen));

    // (c) 같은 주소(끝 슬래시·대소문자·공백만 다름) + 토큰 칸 비움 → 유지.
    const c = await put({ remoteBase: `  ${evilBase.toUpperCase()}/mirror2  `, enabled: true });
    assert.equal(c.status, 200);
    assert.equal(c.body.droppedSecrets, undefined, JSON.stringify(c.body));
    assert.equal(c.body.settings.hasToken, true);
    // 다른 칸만 고친 저장(remoteBase 키 없음)도 유지.
    const c2 = await put({ autoApply: false });
    assert.equal(c2.body.settings.hasToken, true);
    assert.equal(c2.body.droppedSecrets, undefined);

    // (d) 경로만 바뀐 주소도 접속처 변경이다 → 폐기.
    const d = await put({ remoteBase: `${evilBase}/other` });
    assert.deepEqual(d.body.droppedSecrets, ['token']);
    seen = await check();
    assert.ok(seen.length && seen.every((x) => x.auth === null), JSON.stringify(seen));

    // (e) 토큰이 없는 상태에서 주소를 바꾸면 폐기할 것이 없다(거짓 안내 금지).
    const e = await put({ remoteBase: `${evilBase}/third` });
    assert.equal(e.body.droppedSecrets, undefined, JSON.stringify(e.body));
  } finally {
    srv.close(); evil.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
test('A3-01 ②: 위임 IP 스캔 할당의 대역·계정이 바뀌면 iDRAC 비밀번호를 승계하지 않는다(수정·CSV merge)', async () => {
  const { registerHorizonAssign } = await import('../src/routes/admin/horizonAssign.js');
  const { getAssignment } = await import('../src/central/assignments.js');
  const app = express();
  app.use(express.json());
  app.use(asAdmin);
  const router = express.Router();
  registerHorizonAssign(router);
  app.use('/api/admin', router);
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}/api/admin`;
  const call = (method, p, body) => fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const add = await call('POST', '/assignments', { agent: 'e1', ips: '10.20.0.0/24', username: 'root', password: 'IDRAC-PW-1', enabled: true });
    assert.equal(add.status, 201, JSON.stringify(add.body));

    // 화면 수정 창이 보내는 모양 그대로(password:'' · hasPassword 동반).
    const up = await call('PUT', '/assignments/e1', { agent: 'e1', ips: '203.0.113.50', username: 'root', password: '', enabled: true, hasPassword: true });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.deepEqual(up.body.droppedSecrets, ['password'], JSON.stringify(up.body));
    assert.ok(up.body.skipped?.some((x) => x.field === 'password' && /비밀번호/.test(x.reason)), JSON.stringify(up.body));
    assert.equal(up.body.assignment.hasPassword, false);
    const noteU = webText.droppedSecretNote(up.body);
    assert.match(noteU, /^저장했습니다 — 단 IP 대역·iDRAC 계정이 바뀌어/, noteU);
    noMarkup(noteU);
    assert.equal(getAssignment('e1').password, '', '엣지에 내려가는 비밀번호가 비어야 한다');

    // 새 비밀번호와 함께 바꾸면 그 비밀번호.
    const up2 = await call('PUT', '/assignments/e1', { agent: 'e1', ips: '10.30.0.0/24\n10.30.1.0/24', username: 'root', password: 'IDRAC-PW-2' });
    assert.equal(up2.body.droppedSecrets, undefined);
    assert.equal(getAssignment('e1').password, 'IDRAC-PW-2');

    // 같은 대역(순서·공백·대소문자만 다름) + 비밀번호 칸 비움 → 유지.
    const same = await call('PUT', '/assignments/e1', { agent: 'e1', ips: ' 10.30.1.0/24 , 10.30.0.0/24 \n', username: 'ROOT', password: '' });
    assert.equal(same.body.droppedSecrets, undefined, JSON.stringify(same.body));
    assert.equal(getAssignment('e1').password, 'IDRAC-PW-2');
    // 다른 칸만(enabled) 고친 저장도 유지.
    await call('PUT', '/assignments/e1', { enabled: false });
    assert.equal(getAssignment('e1').password, 'IDRAC-PW-2');

    // 계정만 바뀌어도 접속처 변경이다(같은 호스트의 다른 계정으로 비밀번호가 옮겨 가면 계정 잠금 위험).
    const acct = await call('PUT', '/assignments/e1', { agent: 'e1', username: 'admin', password: '' });
    assert.deepEqual(acct.body.droppedSecrets, ['password']);
    assert.equal(getAssignment('e1').password, '');

    // CSV merge 가져오기: 비밀번호 칸이 빈 줄이 대역을 바꾸면 폐기하고 passwordDropped 로 밝힌다.
    await call('PUT', '/assignments/e1', { agent: 'e1', ips: '10.20.0.0/24', username: 'root', password: 'IDRAC-PW-3' });
    const imp = await call('POST', '/assignments/import', { csv: 'agent,ips,username,password,enabled\ne1,198.51.100.7,root,,true\n', mode: 'merge' });
    assert.equal(imp.status, 200, JSON.stringify(imp.body));
    assert.equal(getAssignment('e1').password, '', 'CSV merge 가 새 대역에 옛 비밀번호를 남겼다');
    assert.ok(Array.isArray(imp.body.passwordDropped) && imp.body.passwordDropped.some((x) => x.name === 'e1' && /비밀번호/.test(x.reason)), JSON.stringify(imp.body));
    const lines = webText.passwordDroppedLines(imp.body);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^e1 — IP 대역·iDRAC 계정이 바뀌어/, lines[0]);
    noMarkup(lines[0]);

    // 같은 대역의 CSV merge(비밀번호 칸 비움)는 유지 — 폐기 목록도 없다.
    await call('PUT', '/assignments/e1', { agent: 'e1', password: 'IDRAC-PW-4' });
    const imp2 = await call('POST', '/assignments/import', { csv: 'agent,ips,username,password,enabled\ne1,198.51.100.7,root,,true\n', mode: 'merge' });
    assert.equal(getAssignment('e1').password, 'IDRAC-PW-4');
    assert.ok(!imp2.body.passwordDropped?.length, JSON.stringify(imp2.body));
  } finally {
    srv.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
test('A4-03: 엣지 IP 스캔 워커는 중앙 배정의 intervalMs 를 쓰고(없을 때만 env), 주기가 지나야 스캔한다', async () => {
  const target = await listen((_q, s) => s.end('x'));
  const tport = target.address().port;
  let assignment = { ok: true, assigned: true, ranges: ['127.0.0.1'], ports: [tport], concurrency: 2, timeoutMs: 1000, intervalMs: 21_600_000 };
  const posted = [];
  let assignStatus = 200; let resultStatus = 200;
  const central = await listen((q, r) => {
    const ch = []; q.on('data', (c) => ch.push(c));
    q.on('end', () => {
      const p = q.url.split('?')[0];
      let json = { ok: true }; let status = 200;
      if (p === '/api/central/ip-scan-assignment') { json = assignment; status = assignStatus; }
      if (p === '/api/central/ip-scan-result') { posted.push(Date.now()); status = resultStatus; }
      r.writeHead(status, { 'content-type': 'application/json' }); r.end(JSON.stringify(status === 200 ? json : { ok: false }));
    });
  });
  config.agent.centralUrl = `http://127.0.0.1:${central.address().port}`;
  config.agent.centralToken = 'shared-g2a';
  config.agent.name = 'site-g2a';
  const w = await import('../src/agent/ipScanWorker.js');
  try {
    // 배정 전: env 기본값.
    assert.equal(w.ipScanAgentStatus().intervalMs, 3_600_000);

    const r1 = await quiet(() => w.runIpScanAgentOnce());
    assert.equal(r1.assigned, true, JSON.stringify(r1));
    assert.equal(posted.length, 1);
    const st1 = w.ipScanAgentStatus();
    assert.equal(st1.intervalMs, 21_600_000, '중앙이 준 6시간을 써야 한다(수정 전: env 1시간)');
    assert.equal(st1.intervalSource, 'central');

    // 타이머 경로(dueOnly): 주기가 지나지 않았으면 배정만 다시 읽고 스캔하지 않는다.
    const t0 = Date.now();
    await quiet(() => w.runIpScanAgentOnce({ dueOnly: true, now: t0 + 60_000 }));
    assert.equal(posted.length, 1, '주기 전에 다시 스캔했다');
    // 다음 무장 간격 — 6시간 주기여도 배정은 짧은 간격으로 다시 확인한다(주기 변경이 늦게 먹지 않게).
    const d = w.ipScanNextDelayMs(t0);
    assert.ok(d >= 1_000 && d <= w.IPSCAN_ASSIGN_RECHECK_MS, String(d));

    // 중앙이 주기를 1분으로 줄이면 다음 확인에서 반영되고, 마지막 스캔 뒤 1분이 지났으면 스캔한다.
    assignment = { ...assignment, intervalMs: 60_000 };
    await quiet(() => w.runIpScanAgentOnce({ dueOnly: true, now: Date.now() + 61_000 }));
    assert.equal(w.ipScanAgentStatus().intervalMs, 60_000);
    assert.equal(posted.length, 2, '주기가 지났는데 스캔하지 않았다');
    assert.ok(w.ipScanNextDelayMs(Date.now()) <= 60_000);

    // 범위 밖 값은 클램프(1분~7일), 숫자가 아니거나 없으면(구버전 중앙) env 기본값.
    assignment = { ...assignment, intervalMs: 5 };
    await quiet(() => w.runIpScanAgentOnce({ dueOnly: true, now: Date.now() }));
    assert.equal(w.ipScanAgentStatus().intervalMs, 60_000);
    assignment = { ...assignment, intervalMs: 3e10 };
    await quiet(() => w.runIpScanAgentOnce({ dueOnly: true, now: Date.now() }));
    assert.equal(w.ipScanAgentStatus().intervalMs, 7 * 86_400_000);
    assignment = { ...assignment, intervalMs: 'abc' };
    await quiet(() => w.runIpScanAgentOnce({ dueOnly: true, now: Date.now() }));
    assert.equal(w.ipScanAgentStatus().intervalMs, 3_600_000);
    assert.equal(w.ipScanAgentStatus().intervalSource, 'env');
    const { intervalMs: _drop, ...old } = assignment;
    assignment = old;
    await quiet(() => w.runIpScanAgentOnce({ dueOnly: true, now: Date.now() }));
    assert.equal(w.ipScanAgentStatus().intervalMs, 3_600_000);

    // 미배정이면 env 기본값으로 돌아간다(다시 배정되기를 기다리는 확인 주기).
    assignment = { ...assignment, intervalMs: 21_600_000 };
    await quiet(() => w.runIpScanAgentOnce({ dueOnly: true, now: Date.now() }));
    assert.equal(w.ipScanAgentStatus().intervalMs, 21_600_000);
    assignment = { ok: true, assigned: false };
    await quiet(() => w.runIpScanAgentOnce({ dueOnly: true, now: Date.now() }));
    assert.equal(w.ipScanAgentStatus().intervalMs, 3_600_000);

    // 결과 보고가 실패해도(403) 다음 스캔은 주기 뒤다 — 재확인 간격마다 대역 전체를 다시 스캔하지 않는다. 실패 기록은 숨기지 않는다.
    assignment = { ok: true, assigned: true, ranges: ['127.0.0.1'], ports: [tport], concurrency: 2, timeoutMs: 1000, intervalMs: 21_600_000 };
    resultStatus = 403;
    w._resetIpScanAgentForTest();                        // 앞선 성공 스캔 시각이 판정을 가리지 않게 — 실패한 이 스캔이 첫 스캔이다
    const rf = await quiet(() => w.runIpScanAgentOnce());
    assert.match(String(rf.error), /result 403/);
    assert.equal(rf.phase, 'report');
    const nPost = posted.length;
    const rf2 = await quiet(() => w.runIpScanAgentOnce({ dueOnly: true, now: Date.now() + 20 * 60_000 }));
    assert.equal(posted.length, nPost, '보고 실패 뒤 주기 전에 다시 스캔했다');
    assert.match(String(rf2.error), /result 403/, '보고 실패 기록을 숨겼다');
    resultStatus = 200;
    // 배정 조회 실패 → 다음 확인 성공(주기 전)이면 조회 실패 기록은 남기지 않고 마지막 스캔 시도의 기록으로 돌아간다.
    await quiet(() => w.runIpScanAgentOnce());           // 정상 스캔 1회(기록 = 성공)
    assignStatus = 500;
    const fe = await quiet(() => w.runIpScanAgentOnce({ dueOnly: true, now: Date.now() }));
    assert.equal(fe.phase, 'assignment');
    assert.equal(w.ipScanAgentStatus().intervalMs, 21_600_000, '조회 실패는 주기를 바꾸지 않는다');
    assignStatus = 200;
    const ok2 = await quiet(() => w.runIpScanAgentOnce({ dueOnly: true, now: Date.now() }));
    assert.equal(ok2.error, undefined, JSON.stringify(ok2));
    assert.equal(ok2.assigned, true);

    // 타이머가 생성 시 간격에 묶이지 않는다 — env 값의 setInterval 이 아니라 매 회 다음 간격을 다시 읽는 타이머.
    const { stripComments } = await import('./_stripComments.js');
    const src = stripComments(fs.readFileSync(new URL('../src/agent/ipScanWorker.js', import.meta.url), 'utf8'));
    assert.ok(!/setInterval\s*\(/.test(src), 'setInterval 이 남아 있다');
    assert.match(src, /startAdaptiveTimer\(\s*\(\)\s*=>\s*ipScanNextDelayMs\(\)/);
  } finally {
    target.close(); central.close();
  }
});
