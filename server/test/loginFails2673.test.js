/**
 * v2.673 — 운영 장애(2026-10-01) 두 번째 멈춤 지점: 로그인 실패 분석(security/loginFails.js analyzeLoginFails).
 * 예전에는 vCenter 이벤트 7일치를 'login'·'auth'·'fail'·'로그인' 으로 네 번 LIKE 검색했다(검색어마다 5,000행).
 *  ① 정확도 — 흔한 'login' 정상 이벤트가 상한을 채워 실제 실패를 덜 셌다(재현: 1,000건 중 30건). 이제 전부 센다.
 *  ② SQL 후보 조건 ↔ 정규식 — 정규식이 실패라 하는 문장을 SQL 이 놓치지 않는다(실제 SQLite 로 갈래마다)
 *  ③ 1시간 조각 + 시간 기준 양보 — 계산 중에도 다른 일이 돈다
 *  ④ 첫 조각은 위가 열려 있다 — 포탈보다 앞선 vCenter 시계의 '미래 시각' 실패도 센다
 *  ⑤ 상한은 '실패' 에만 · 넘으면 truncated
 *  ⑥ 증분(주기 감시) — 두 번째부터 직전 2시간만 다시 훑는다 · 새 실패는 센다 · 2시간보다 늦게 들어온 것은 6시간마다 전 범위에서
 *  ⑦ 소스 — 분석기가 예전 네 단어 검색(db.query)을 부르지 않는다 · 주기 감시는 증분으로 부른다
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2673-'));
Object.assign(process.env, { CONFIG_DIR: CFG, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', IPAM_WRITE_WORKER: '0' });

const { getLogsDb } = await import('../src/logs/db.js');
const L = await import('../src/security/loginFails.js');
const P = await import('../src/logs/loginFailPattern.js');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 경계에서 떨어진 고정 기준(v2.517 규약)
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;

let seq = 0;
const ev = (o) => ({ vcenterId: 'vc-a', key: `k${++seq}`, severity: 'info', user: 'svc', entity: 'vm-1', ...o });
const okLogin = (ts) => ev({ ts, type: 'UserLoginSessionEvent', message: 'User svc@10.0.0.9 logged in as pyvmomi login session', user: 'svc' });
const badLogin = (ts, i) => ev({ ts, type: 'BadUsernameSessionEvent', message: `Cannot login user${i % 7}@10.1.2.${i % 200}`, user: `user${i % 7}` });

test('① 정확도 — 흔한 정상 로그인 이벤트가 실패 집계를 밀어내지 않는다', async () => {
  const db = await getLogsDb();
  const rows = [];
  // 정상 로그인 8,000건(검색어 'login' 에 걸린다) 사이에 실패 300건 — 6일에 걸쳐 고르게
  for (let i = 0; i < 8_000; i++) rows.push(okLogin(NOW - Math.floor((i / 8_000) * 6 * DAY)));
  for (let i = 0; i < 300; i++) rows.push(badLogin(NOW - Math.floor((i / 300) * 6 * DAY) - 7, i));
  db.insertMany(rows);
  const r = await L.analyzeLoginFails({ days: 7, threshold: 5, windowMin: 10 }, { now: NOW });
  assert.equal(r.summary.vcenter, 300, `실제 실패 300건 중 ${r.summary.vcenter}건만 셌다`);
  assert.equal(r.scan.source, 'candidates');
  assert.equal(r.scan.truncated, false);
  assert.ok(r.scan.chunks >= 7 * 24, `1시간 조각으로 7일을 나눠 훑어야 한다: ${r.scan.chunks}`);
  // 재현 조건(예전 방식): 'login' 검색어는 5,000행에서 잘리고 그 안의 실패는 300건보다 훨씬 적다
  const oldLogin = db.query({ since: NOW - 7 * DAY, q: 'login' }, 5000, 0).filter(P.isLoginFailRow).length;
  assert.ok(oldLogin < 300, `재현 조건 실패 — 예전 검색도 300건을 다 봤다: ${oldLogin}`);
});

test('② SQL 후보 조건은 정규식이 실패라 하는 문장을 놓치지 않는다(실제 SQLite)', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const m = new DatabaseSync(':memory:');
  m.exec('CREATE TABLE events (type TEXT, message TEXT)');
  const ins = m.prepare('INSERT INTO events (type, message) VALUES (?, ?)');
  const positives = [
    ['vim.event.BadUsernameSessionEvent', ''], ['InvalidLoginEvent', ''], ['NoAccessUserEvent', ''], ['AccountLockedEvent', ''],
    ['com.vmware.sso.LoginFailure', ''], ['AuthenticationFailedEvent', ''], ['NoPermissionEvent', ''],
    ['EventEx', 'Cannot login root@10.0.0.1'], ['EventEx', 'Failed to log in user'], ['EventEx', 'failed to login as admin'],
    ['EventEx', 'Failed to authenticate user x'], ['EventEx', 'Login failure for svc'], ['EventEx', 'Authentication failed for y'],
    ['EventEx', 'Invalid login attempt'], ['EventEx', 'invalid credentials supplied'], ['EventEx', 'Invalid user name'],
    ['EventEx', 'Bad username or password'], ['EventEx', 'The account admin has been locked'], ['EventEx', 'ACCOUNT is LOCKED out'],
    ['EventEx', '사용자 로그인 시도 실패'], ['EventEx', '인증 요청이 실패했습니다'],
  ];
  const negatives = [['UserLoginSessionEvent', 'User svc logged in'], ['TaskEvent', 'Reconfigure virtual machine'], ['AlarmStatusChangedEvent', 'clock skew detected']];
  for (const [t, msg] of [...positives, ...negatives]) ins.run(t, msg);
  const picked = m.prepare(`SELECT type, message FROM events WHERE ${P.LOGIN_FAIL_SQL}`).all();
  const key = (r) => `${r.type}|${r.message}`;
  const got = new Set(picked.map(key));
  for (const [t, msg] of positives) {
    assert.ok(P.isLoginFailRow({ type: t, message: msg }), `표본이 정규식에 안 맞는다: ${t} / ${msg}`);
    assert.ok(got.has(`${t}|${msg}`), `SQL 후보 조건이 실패를 놓쳤다: ${t} / ${msg}`);
  }
  for (const [t, msg] of negatives) assert.ok(!P.isLoginFailRow({ type: t, message: msg }), `음성 표본이 정규식에 맞았다: ${t}`);
  m.close();
});

/** 가짜 db — 조각마다 바쁜 대기(동기 SQL 흉내). */
function slowDb(busyMs) {
  let calls = 0;
  return {
    get calls() { return calls; },
    loginFailCandidates() { calls++; const t = performance.now(); while (performance.now() - t < busyMs) { /* */ } return []; },
    query() { throw new Error('예전 네 단어 검색(db.query)을 부르면 안 된다'); },
  };
}

test('③ 1시간 조각 + 시간 기준 양보 — 계산 중에도 다른 일이 돈다', async () => {
  const db = slowDb(2);
  let ticks = 0; let stop = false;
  const probe = () => { if (stop) return; ticks++; setImmediate(probe); };
  setImmediate(probe);
  let r;
  try { r = await L.analyzeLoginFails({ days: 7 }, { db, now: NOW, sliceMs: 15 }); } finally { stop = true; }
  assert.equal(db.calls, 7 * 24, '7일 = 1시간 조각 168개');
  assert.equal(r.scan.chunks, 168);
  // 약 336ms 동기 일 → 15ms 마다 양보면 약 20회. 양보가 없으면 프로브는 거의 돌지 못한다.
  assert.ok(ticks >= 10, `계산 중 프로브가 거의 돌지 못했다: ${ticks}`);
});

test('④ 첫 조각은 위가 열려 있다 — 포탈보다 앞선 vCenter 시계의 실패도 센다 · 조각 경계에서 두 번 세지 않는다', async () => {
  const db = await getLogsDb();
  const vc = 'vc-future';
  db.insertMany([
    ev({ vcenterId: vc, ts: NOW + 10 * 60_000, type: 'BadUsernameSessionEvent', message: 'Cannot login a@1.1.1.1', user: 'a' }),
    ev({ vcenterId: vc, ts: NOW - HOUR, type: 'BadUsernameSessionEvent', message: 'Cannot login b@1.1.1.2', user: 'b' }),         // 조각 경계 정확히
    ev({ vcenterId: vc, ts: NOW - 2 * HOUR - 1, type: 'BadUsernameSessionEvent', message: 'Cannot login c@1.1.1.3', user: 'c' }),
  ]);
  const r = await L.analyzeLoginFails({ vcenterId: vc, days: 1 }, { now: NOW });
  assert.equal(r.summary.vcenter, 3, JSON.stringify(r.recent.map((x) => x.ts - NOW)));
});

test('⑤ 상한은 실패에만 걸리고, 넘으면 truncated(최근 것부터)', async () => {
  const db = await getLogsDb();
  const vc = 'vc-many';
  db.insertMany(Array.from({ length: 50 }, (_, i) => ev({ vcenterId: vc, ts: NOW - i * 60_000, type: 'BadUsernameSessionEvent', message: `Cannot login u${i}@1.1.1.${i}`, user: `u${i}` })));
  const r = await L.analyzeLoginFails({ vcenterId: vc, days: 1 }, { now: NOW, rowsMax: 20 });
  assert.equal(r.summary.vcenter, 20);
  assert.equal(r.scan.truncated, true);
  assert.equal(r.recent[0].user, 'u0', '최근 것부터 담아야 한다');
});

test('⑥ 증분 — 두 번째부터 직전 2시간만 · 새 실패는 센다 · 늦게 들어온 옛 실패는 6시간마다 전 범위에서', async () => {
  L._resetLoginFailIncForTest();
  const db = await getLogsDb();
  const vc = 'vc-inc';
  db.insertMany(Array.from({ length: 10 }, (_, i) => ev({ vcenterId: vc, ts: NOW - (i + 1) * 5 * HOUR, type: 'BadUsernameSessionEvent', message: `Cannot login x${i}@2.2.2.${i}`, user: `x${i}` })));
  const r1 = await L.analyzeLoginFails({ vcenterId: vc, days: 7 }, { now: NOW, incremental: true });
  assert.equal(r1.scan.mode, 'full');
  assert.equal(r1.summary.vcenter, 10);
  // 15분 뒤: 새 실패 1건 — 증분은 직전 2시간(+15분)만 훑는다
  const T2 = NOW + 15 * 60_000;
  db.insertMany([ev({ vcenterId: vc, ts: T2 - 60_000, type: 'BadUsernameSessionEvent', message: 'Cannot login new@3.3.3.3', user: 'new' })]);
  const r2 = await L.analyzeLoginFails({ vcenterId: vc, days: 7 }, { now: T2, incremental: true });
  assert.equal(r2.scan.mode, 'incremental');
  assert.ok(r2.scan.chunks <= 3, `증분인데 조각을 너무 많이 훑었다: ${r2.scan.chunks}`);
  assert.equal(r2.summary.vcenter, 11, '새 실패를 세지 못했다');
  // 2시간보다 늦게 들어온 옛 실패(ts 가 하루 전) — 증분에는 아직 없다(정직 기록), 6시간 뒤 전 범위에서 들어온다
  db.insertMany([ev({ vcenterId: vc, ts: NOW - DAY, type: 'BadUsernameSessionEvent', message: 'Cannot login late@4.4.4.4', user: 'late' })]);
  const T3 = T2 + 15 * 60_000;
  const r3 = await L.analyzeLoginFails({ vcenterId: vc, days: 7 }, { now: T3, incremental: true });
  assert.equal(r3.scan.mode, 'incremental');
  assert.equal(r3.summary.vcenter, 11);
  const T4 = NOW + L.LOGIN_FAIL_FULL_EVERY_MS + 60_000;
  const r4 = await L.analyzeLoginFails({ vcenterId: vc, days: 7 }, { now: T4, incremental: true });
  assert.equal(r4.scan.mode, 'full');
  assert.equal(r4.summary.vcenter, 12, '6시간 전 범위 재훑기에서 늦게 들어온 실패가 들어오지 않았다');
  // 기간·범위가 바뀌면 처음부터
  const r5 = await L.analyzeLoginFails({ vcenterId: vc, days: 3 }, { now: T4 + 60_000, incremental: true });
  assert.equal(r5.scan.mode, 'full');
  // 증분이 아닌 호출(화면 수동 분석)은 언제나 전 범위
  const r6 = await L.analyzeLoginFails({ vcenterId: vc, days: 3 }, { now: T4 + 120_000 });
  assert.equal(r6.scan.mode, 'full');
});

test('⑦ 소스 — 분석기는 예전 네 단어 검색을 부르지 않고, 주기 감시는 증분으로 부른다', () => {
  const read = (p) => stripComments(fs.readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8'));
  const a = read('security/loginFails.js');
  assert.doesNotMatch(a, /\.query\(/, '분석기가 db.query(검색어 LIKE 전 범위)를 부른다');
  assert.doesNotMatch(a, /\['login',\s*'auth'/);
  assert.match(a, /createYielder\(/);
  const m = read('security/loginMonitor.js');
  assert.match(m, /analyzeLoginFails\([^)]*\)\s*,\s*\{\s*incremental:\s*true\s*\}|incremental:\s*true/);
  // 판정 정규식은 한 곳 — 분석기에 사본이 없다
  assert.doesNotMatch(a, /const (TYPE_RE|MSG_RE)\s*=/);
});
