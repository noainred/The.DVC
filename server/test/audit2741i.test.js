/**
 * test/audit2741i.test.js — 점검 v2.741 그룹 GH(엣지 배관·svcmon·Horizon) 회귀.
 *
 *  ① LEFT-02 스토리지·PDU 설정 pull 은 '지금 수집'(collectNow)을 기다리지 않는다 — SAN v2.733 C4-02 runCollectJob 과 같은 모양.
 *     예전에는 pull 이 장비를 한 대씩 끝까지 수집하고 push 한 뒤에야 돌아와, 그동안 다음 pull 이 재진입 가드에 막혔다.
 *     실제 pull 함수를 목 중앙(HTTP)·응답 없는 장비(SSH 배너를 보내지 않는 TCP 서버)로 부른다.
 *  ② LEFT-06 svcmon `/state` 는 전 대상·전 점검을 깊이 복사하지 않는다(limit=1 요약 조회가 전체 복사 비용을 내던 것).
 *  ③ EDGE-02 수집기 라우터는 전역 1MB 파서보다 먼저 마운트되고, 토큰을 본문 해석보다 먼저 본다 — 라우트별 한도가 실제로 적용된다.
 *     **실제 포탈 프로세스**를 띄워 확인한다(index.js 마운트 순서는 라우터 단독 시험으로 볼 수 없다).
 *  ④ EDGE-03 bmstor-collect 는 객체가 아닌 원소를 빼고 개수를 밝힌다(예전: list[i].id 에서 던져 요청 전체 500).
 *  ⑤ DB-02 Horizon 기간 집계는 날 조각 + 시간 기준 양보이고 결과(순서 포함)는 예전 한 문장 SQL 과 같다 ·
 *     화면(/usage)과 CSV(/usage.csv)의 같은 조건 요청은 한 계산을 쓴다.
 * 기준 시각을 Date.now() 판정 경계로 쓰지 않는다 — 사건의 **순서**와 개수만 본다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2741i-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'false';
process.env.SVCMON_WORKERS = '0';
process.env.SSH_READY_TIMEOUT_MS = '1500';      // 응답 없는 장비 한 대 ≈ 1.5초(운영 기본 60초의 축소)
process.env.HZSESS_DB_PATH = path.join(DIR, 'hz.db');
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

const servers = [];
const procs = new Set();
after(async () => {
  for (const p of [...procs]) await new Promise((r) => { if (p.exitCode != null || p.signalCode) return r(); p.once('exit', r); p.kill('SIGKILL'); });
  for (const s of servers) { try { s.close(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

const waitFor = async (pred, ms = 20_000) => { const until = Date.now() + ms; while (!(await pred()) && Date.now() < until) await new Promise((r) => setTimeout(r, 25)); return pred(); };

/** SSH 배너를 보내지 않는 장비 — 접속은 받지만 끝내 답하지 않는다(ssh2 readyTimeout 으로 끝난다). */
async function hangDevice() {
  const srv = net.createServer((s) => { s.on('error', () => {}); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv);
  return srv.address().port;
}

/** 목 중앙 — 사건 순서(ev)를 기록한다. */
async function mockCentral(cfgPath, dataPath, payload) {
  const ev = [];
  let seq = 0;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url.startsWith(cfgPath)) { ev.push({ n: ++seq, kind: 'config' }); res.end(JSON.stringify(payload())); return; }
      if (req.url.startsWith(dataPath)) { ev.push({ n: ++seq, kind: 'data' }); res.end('{"ok":true}'); return; }
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv);
  return { ev, url: `http://127.0.0.1:${srv.address().port}` };
}

const { config } = await import('../src/config.js');

/* ─────────────────────────── ① LEFT-02 ─────────────────────────── */

test('LEFT-02 ① 스토리지 설정 pull 은 재수집을 기다리지 않는다 · 다음 pull 이 막히지 않는다 · 상태가 진행·결과를 말한다', { timeout: 60_000 }, async () => {
  const pull = await import('../src/agent/storageConfigPull.js');
  const port = await hangDevice();
  const dev = (id) => ({ id, name: id, type: 'unity480', collectMethod: 'ssh', host: '127.0.0.1', sshPort: port, username: 'service', password: 'x', agent: 'edge-g', enabled: true });
  const devices = [dev('st1'), dev('st2')];
  let first = true;
  const c = await mockCentral('/api/central/storage-config', '/api/central/storage-data', () => {
    if (!first) return { ok: true, devices };
    first = false;
    return { ok: true, devices, collectNow: ['st1', 'st2'] };
  });
  config.agent.centralUrl = c.url; config.agent.centralToken = 'tok'; config.agent.name = 'edge-g';
  try {
    const r = await pull.pullStorageConfigNow();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.collectRequested, 2);
    // 수정 전: pull 이 두 대를 끝까지 수집하고 push 한 뒤에 돌아왔다(그 사이 'data' 가 이미 와 있다)
    assert.equal(c.ev.filter((e) => e.kind === 'data').length, 0, 'pull 이 재수집·push 를 기다렸다');
    assert.equal(pull.storageConfigPullStatus().collectJob?.running, true, '재수집 작업은 뒤에서 돌고 있어야 한다');
    const r2 = await pull.pullStorageConfigNow();
    assert.equal(r2.ok, true, `다음 pull 이 재수집에 막혔다: ${JSON.stringify(r2)}`);
    assert.ok(await waitFor(() => !pull.storageConfigPullStatus().collectJob?.running), '재수집 작업이 끝나지 않았다');
    assert.ok(await waitFor(() => c.ev.some((e) => e.kind === 'data')), `재수집 결과 push 가 오지 않았다: ${JSON.stringify(c.ev)}`);
    const st = pull.storageConfigPullStatus();
    assert.equal(st.collectRun?.requested, 2);
    assert.equal((st.collectRun?.collected || 0) + (st.collectRun?.busy || 0) + (st.collectRun?.failed || 0), 2, JSON.stringify(st.collectRun));
    assert.equal(st.collectJob.queued, 0);
  } finally { config.agent.centralUrl = ''; }
});

test('LEFT-02 ② PDU 설정 pull 도 재수집을 기다리지 않는다 · 같은 장비 중복 요청은 한 번만', { timeout: 60_000 }, async () => {
  const pull = await import('../src/agent/pduConfigPull.js');
  const port = await hangDevice();
  const dev = (id) => ({ id, name: id, host: '127.0.0.1', sshPort: port, username: 'apc', password: 'x', agent: 'edge-g', enabled: true });
  const devices = [dev('p1'), dev('p2')];
  const c = await mockCentral('/api/central/pdu-config', '/api/central/pdu-data', () => ({ ok: true, devices, collectNow: ['p1', 'p2'] }));
  config.agent.centralUrl = c.url; config.agent.centralToken = 'tok'; config.agent.name = 'edge-g';
  try {
    const r = await pull.pullPduConfigNow();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(c.ev.filter((e) => e.kind === 'data').length, 0, 'pull 이 재수집·push 를 기다렸다');
    assert.equal(pull.pduConfigPullStatus().collectJob?.running, true, '재수집 작업은 뒤에서 돌고 있어야 한다');
    const r2 = await pull.pullPduConfigNow();   // 중앙이 시한 뒤 같은 장비를 다시 내려보낸 경우
    assert.equal(r2.ok, true, `다음 pull 이 재수집에 막혔다: ${JSON.stringify(r2)}`);
    assert.ok(r.collectQueued >= 1, JSON.stringify(r));
    assert.equal((r.collectQueued || 0) + (r2.collectQueued || 0), 2, `같은 장비를 대기열에 두 번 넣었다: ${JSON.stringify([r, r2])}`);
    assert.ok(await waitFor(() => !pull.pduConfigPullStatus().collectJob?.running), '재수집 작업이 끝나지 않았다');
    assert.ok(await waitFor(() => c.ev.some((e) => e.kind === 'data')), `재수집 결과 push 가 오지 않았다: ${JSON.stringify(c.ev)}`);
    const st = pull.pduConfigPullStatus();
    assert.equal(st.collectRun?.requested, 2, JSON.stringify(st.collectRun));
    assert.equal(st.collectRun.failed, 2, '응답 없는 PDU 두 대 — 실패로 센다(성공이라 말하지 않는다)');
  } finally { config.agent.centralUrl = ''; }
});

test('LEFT-02 ③ 엣지 로그 표의 스토리지·PDU 설정 상태가 재수집 작업(collectJob)을 싣는다', async () => {
  const { STATUS_SPEC } = await import('../src/edgelog/spec.js');
  for (const key of ['pull.storage', 'pull.pdu']) {
    const s = STATUS_SPEC.find((x) => x.key === key);
    assert.ok(s, `${key} 가 엣지 로그 표에 없다`);
    const mod = await import(new URL(s.mod, new URL('../src/edgelog/spec.js', import.meta.url)).href);
    const st = mod[s.fn]();
    assert.ok(st && typeof st.collectJob === 'object', `${key} 상태에 collectJob 이 없다: ${JSON.stringify(st)}`);
    assert.equal(typeof st.collectJob.running, 'boolean');
  }
});

/* ─────────────────────────── ② LEFT-06 ─────────────────────────── */

test('LEFT-06 svcmon /state?limit=1 은 전 대상의 점검을 복사하지 않는다 — 응답 모양은 그대로', async () => {
  const store = await import('../src/svcmon/store.js');
  const { registerOverview } = await import('../src/routes/svcmon/overview.js');
  const N = 40;
  for (let i = 0; i < N; i++) {
    const t = store.addTarget({ kind: 'infra', path: 'L6', name: `h-${i}`, host: `10.6.0.${i + 1}` });
    store.addTest(t.id, { type: 'ping', name: `ping-${i}` });
  }
  // 저장소 원본 배열의 tests 를 map 호출을 세는 배열로 바꾼다 — 전 대상 깊이 복사는 대상마다 map 을 부른다.
  let maps = 0;
  class CountArr extends Array { map(...a) { maps++; return super.map(...a); } static get [Symbol.species]() { return Array; } }
  for (const t of store.listTargets()) t.tests = CountArr.from(t.tests);
  const app = express();
  const r = express.Router();
  registerOverview(r);
  app.use('/svc', r);
  const srv = app.listen(0, '127.0.0.1'); servers.push(srv);
  await new Promise((res) => srv.once('listening', res));
  const base = `http://127.0.0.1:${srv.address().port}/svc`;
  maps = 0;
  const j = await (await fetch(`${base}/state?limit=1`)).json();
  assert.equal(j.targets.length, 1);
  assert.equal(j.targetCount, N);
  assert.equal(j.summary.total, N, '요약은 여전히 전체 기준');
  assert.equal(j.truncated, true);
  assert.equal(j.targets[0].tests.length, 1);
  assert.equal(typeof j.targets[0].tests[0].state, 'string');
  assert.ok(maps <= 2, `limit=1 조회가 대상 ${N}개의 점검을 복사했다(map ${maps}회)`);
  // 응답이 저장소 원본을 바꾸지 않는다(state·result 를 원본에 붙이지 않는다)
  const orig = store.listTargets().find((t) => t.id === j.targets[0].id);
  assert.equal(orig.tests[0].state, undefined, '응답 조립이 저장소 원본 점검을 고쳤다');
  assert.equal(orig.tests[0].result, undefined);
});

/* ─────────────────────────── ③ EDGE-02 · ④ EDGE-03 (라우터 단독) ─────────────────────────── */

test('EDGE-02·03 라우터 단독 — 토큰 없는 깨진 본문은 403(본문을 해석하지 않는다) · bmstor 원소 정제', async () => {
  const { collectorRouter } = await import('../src/routes/collector.js');
  config.collector.token = 'ctok-2741';
  const app = express();
  app.use('/api/collector', collectorRouter);
  const srv = app.listen(0, '127.0.0.1'); servers.push(srv);
  await new Promise((res) => srv.once('listening', res));
  const base = `http://127.0.0.1:${srv.address().port}/api/collector`;
  const post = (p, body, tok = 'ctok-2741') => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { 'X-Collector-Token': tok } : {}) }, body });
  // 토큰보다 본문 해석이 먼저면 깨진 JSON 은 400 이다 — 토큰 없는 요청이 파서 비용을 쓰게 하지 않는다.
  assert.equal((await post('/set-password', '{bad', '')).status, 403);
  assert.equal((await post('/isidu-run', '{bad', 'nope')).status, 403);
  // EDGE-03: null 원소 하나가 요청 전체를 500 으로 만들지 않는다 — 빼고 개수를 밝힌다.
  const r = await post('/bmstor-collect', JSON.stringify({ servers: [null, 'x', { id: 'a', host: '127.0.0.1', mounts: [] }] }));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.dropped, 2);
  assert.equal(j.results.length, 1);
  assert.equal(j.results[0].id, 'a');
  const r2 = await post('/bmstor-collect', JSON.stringify({ servers: [null, 7] }));
  assert.equal(r2.status, 400);
  assert.equal((await r2.json()).dropped, 2);
});

/* ─────────────────────────── ③ EDGE-02 (실제 포탈) ─────────────────────────── */

async function freePortIn(lo, hi) {
  for (let p = lo; p <= hi; p++) {
    const ok = await new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(p, '127.0.0.1', () => s.close(() => r(true))); });
    if (ok) return p;
  }
  return null;
}

test('EDGE-02 실제 포탈 — 수집기 라우트별 한도가 적용되고(전역 1MB 파서 앞) 토큰을 본문 해석보다 먼저 본다', { timeout: 90_000 }, async () => {
  const port = await freePortIn(6080, 6089);
  assert.ok(port, '6080~6089 에 빈 포트가 없다');
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2741i-portal-'));
  const env = { ...process.env, CONFIG_DIR: cfg, DATA_SOURCE: 'live', AUTH_ENABLED: 'false', PORT: String(port), HOST: '127.0.0.1',
    COLLECTOR_TOKEN: 'ctok-portal', IDRAC_ENABLED: 'false', STALL_WATCH: '0', NODE_ENV: 'test', SSH_HOSTKEY_POLICY: 'observe' };
  delete env.HZSESS_DB_PATH; delete env.SVCMON_WORKERS;
  const p = spawn(process.execPath, ['src/index.js'], { cwd: SERVER, env, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.add(p);
  const log = [];
  p.stdout.on('data', (d) => log.push(String(d))); p.stderr.on('data', (d) => log.push(String(d)));
  try {
    const up = await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { return false; } }, 60_000);
    assert.ok(up, `포탈이 뜨지 않았다:\n${log.join('').slice(-2000)}`);
    const post = (pth, body, tok) => fetch(`http://127.0.0.1:${port}/api/collector${pth}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { 'X-Collector-Token': tok } : {}) }, body });
    // 수정 전: 전역 1MB 파서가 먼저 돌아 토큰 없는 깨진 본문이 400 이었다(토큰 판정 전에 본문을 해석했다)
    assert.equal((await post('/set-password', '{bad', '')).status, 403);
    // 수정 전: 전역 파서가 본문을 이미 읽어 라우트의 4kb 한도가 건너뛰어졌다(req._body) — 5KB 본문이 핸들러까지 갔다
    const big = JSON.stringify({ pad: 'x'.repeat(5000) });
    assert.equal((await post('/isidu-run', big, 'ctok-portal')).status, 413, '라우트 한도(4kb)가 적용되지 않았다');
    // 정상 크기는 그대로 핸들러에 닿는다(413 이 아니다)
    assert.notEqual((await post('/isidu-run', '{}', 'ctok-portal')).status, 413);
    // 다른 경로의 전역 파서는 그대로 동작한다(수집기 마운트를 앞으로 옮긴 것이 /api 본문 해석을 깨지 않는다)
    const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
    assert.equal(login.status, 400, '전역 JSON 파서가 /api 에서 동작하지 않는다');
  } finally {
    await new Promise((r) => { if (p.exitCode != null || p.signalCode) return r(); p.once('exit', r); p.kill('SIGTERM'); });
    try { fs.rmSync(cfg, { recursive: true, force: true }); } catch { /* */ }
  }
});

/* ─────────────────────────── ⑤ DB-02 ─────────────────────────── */

const DAY = 86_400_000;
const dayStr = (t) => new Date(t).toISOString().slice(0, 10);
const T0 = Date.UTC(2026, 8, 1, 3, 0, 0);   // 고정 기준(정시 경계와 무관 — 날 문자열만 쓴다)

/** 합성 누적 — 12일 · 서버 2대 · 이름이 날마다 바뀌는 쌍 · 대리 쌍/BMP 높은 글자 키 · 같은 날 두 서버에 같은 쌍. */
function synthUsage() {
  const usage = []; const cover = [];
  const users = ['alice', 'Bob', 'bob', '�z', '😀u', 'ü', 'carol'];
  const svcs = [['app:excel', 'Excel'], ['app:word', 'Word'], ['desktop:w10', 'Win10'], ['farm:f1', 'Farm 1']];
  for (let d = 0; d < 12; d++) {
    const day = dayStr(T0 + d * DAY);
    for (const sid of ['hz1', 'hz2']) {
      cover.push({ day, serverId: sid, cycles: 10 + d, okCycles: 9 + (d % 2), firstTs: T0 + d * DAY, lastTs: T0 + d * DAY + 3600_000 });
      users.forEach((u, ui) => {
        svcs.forEach(([sk, sn], si) => {
          if ((ui + si + d) % 3 === 0 && !(sid === 'hz2' && (ui + d) % 2)) return;
          usage.push({ day, serverId: sid, userKey: u.toLowerCase() === u ? u : `${u}#`, serviceKey: sk,
            user: `${u}-${(d * 7 + ui) % 5}`, service: `${sn} v${d % 3}`, kind: sk.split(':')[0], basis: si % 2 ? 'app-pool' : 'farm-single-app',
            firstTs: T0 + d * DAY + ui * 1000 + si, lastTs: T0 + d * DAY + 7200_000 + ui * 1000 - si,
            samples: 3 + ui + si, connectedSamples: 1 + ((ui + d) % 3) });
        });
      });
    }
  }
  return { usage, cover };
}

/** 예전(2726851) 구현 — 한 문장 SQL. 같은 DB 파일을 직접 열어 대조한다. */
async function oldUsageRange(dbPath, { fromDay, toDay, serverId = '' }) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const sid = String(serverId || '');
    const P = `SELECT user_key, service_key, MAX(user_name) AS user_name, MAX(service_name) AS service_name,
        MAX(kind) AS kind, MAX(basis) AS basis, COUNT(DISTINCT day) AS days, MIN(first_ts) AS first_ts, MAX(last_ts) AS last_ts,
        SUM(samples) AS samples, SUM(connected_samples) AS connected_samples
      FROM hz_usage_daily WHERE day >= ? AND day <= ?${sid ? ' AND server_id = ?' : ''} GROUP BY user_key, service_key`;
    const D = `SELECT day, COUNT(DISTINCT user_key) AS users, COUNT(DISTINCT service_key) AS services
      FROM hz_usage_daily WHERE day >= ? AND day <= ?${sid ? ' AND server_id = ?' : ''} GROUP BY day ORDER BY day`;
    const U = `SELECT user_key, COUNT(DISTINCT day) AS days FROM hz_usage_daily WHERE day >= ? AND day <= ?${sid ? ' AND server_id = ?' : ''} GROUP BY user_key`;
    const args = sid ? [fromDay, toDay, sid] : [fromDay, toDay];
    const n = (v) => (v == null ? null : Number(v));
    return {
      pairs: db.prepare(P).all(...args).map((r) => ({
        userKey: r.user_key, serviceKey: r.service_key, user: r.user_name, service: r.service_name, kind: r.kind, basis: r.basis,
        days: Number(r.days) || 0, firstTs: n(r.first_ts), lastTs: n(r.last_ts), samples: Number(r.samples) || 0, connectedSamples: Number(r.connected_samples) || 0,
      })),
      daily: db.prepare(D).all(...args).map((r) => ({ day: r.day, users: Number(r.users) || 0, services: Number(r.services) || 0 })),
      userDays: db.prepare(U).all(...args).map((r) => ({ userKey: r.user_key, days: Number(r.days) || 0 })),
    };
  } finally { db.close(); }
}

test('DB-02 ① 날 조각 집계는 예전 한 문장 SQL 과 결과·순서가 같다(전체·서버 지정·한 날·빈 기간)', async () => {
  const sdb = await import('../src/horizon/sessionDb.js');
  const { usage, cover } = synthUsage();
  const b = await sdb.backfillHzDemo({ usage, cover });
  assert.equal(b.ok, true, JSON.stringify(b));
  const cases = [
    { fromDay: dayStr(T0), toDay: dayStr(T0 + 11 * DAY) },
    { fromDay: dayStr(T0 + 2 * DAY), toDay: dayStr(T0 + 9 * DAY), serverId: 'hz2' },
    { fromDay: dayStr(T0 + 5 * DAY), toDay: dayStr(T0 + 5 * DAY) },
    { fromDay: dayStr(T0 - 30 * DAY), toDay: dayStr(T0 - 20 * DAY) },
    { fromDay: dayStr(T0 - 3 * DAY), toDay: dayStr(T0 + 40 * DAY), serverId: 'hz1' },
  ];
  for (const c of cases) {
    const got = await sdb.hzUsageRange(c);
    const want = await oldUsageRange(process.env.HZSESS_DB_PATH, c);
    assert.equal(got.available, true);
    assert.deepEqual(got.pairs, want.pairs, `pairs 불일치 ${JSON.stringify(c)}`);
    assert.deepEqual(got.daily, want.daily, `daily 불일치 ${JSON.stringify(c)}`);
    assert.deepEqual(got.userDays, want.userDays, `userDays 불일치 ${JSON.stringify(c)}`);
  }
  assert.ok((await sdb.hzUsageRange(cases[0])).pairs.length > 20, '합성 데이터가 비어 있다');
});

test('DB-02 ② 집계는 조각 사이에서 이벤트 루프에 양보한다(setImmediate 프로브)', async () => {
  const sdb = await import('../src/horizon/sessionDb.js');
  let ticks = 0; let stop = false;
  const probe = () => { if (stop) return; ticks++; setImmediate(probe); };
  setImmediate(probe);
  const r = await sdb.hzUsageRange({ fromDay: dayStr(T0), toDay: dayStr(T0 + 11 * DAY), sliceMs: 0.000001 });
  stop = true;
  assert.equal(r.available, true);
  assert.ok(ticks >= 5, `12일 조회가 한 번도(또는 거의) 양보하지 않았다(프로브 ${ticks}회)`);
  const st = sdb.hzUsageRangeStats?.();
  assert.ok(st && st.lastChunks === 12, `날 조각 수: ${JSON.stringify(st)}`);
});

test('DB-02 ③ 화면(/usage)과 CSV(/usage.csv)의 같은 조건 요청은 한 계산을 쓴다 · 반복 CSV 는 다시 계산하지 않는다', async () => {
  const sdb = await import('../src/horizon/sessionDb.js');
  const { registerHorizonSessions } = await import('../src/routes/api/horizonSessions.js');
  const app = express();
  const r = express.Router();
  registerHorizonSessions(r);
  app.use('/api', r);
  const srv = app.listen(0, '127.0.0.1'); servers.push(srv);
  await new Promise((res) => srv.once('listening', res));
  const base = `http://127.0.0.1:${srv.address().port}/api/tools/horizon-sessions`;
  const runs = () => sdb.hzUsageRangeStats().runs;
  const r0 = runs();
  const [a, b] = await Promise.all([fetch(`${base}/usage?days=30`), fetch(`${base}/usage.csv?days=30`)]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  await a.json(); await b.text();
  assert.equal(runs() - r0, 1, '같은 조건의 화면·CSV 동시 요청이 각자 집계했다');
  const c = await fetch(`${base}/usage.csv?days=30`); assert.equal(c.status, 200); await c.text();
  const d = await fetch(`${base}/usage.csv?days=30`); assert.equal(d.status, 200); await d.text();
  assert.equal(runs() - r0, 1, 'CSV 를 받을 때마다 집계를 다시 돌렸다');
  const e = await fetch(`${base}/usage.csv?days=7`); assert.equal(e.status, 200); await e.text();
  assert.equal(runs() - r0, 2, '다른 기간은 새로 계산한다');
});
