/**
 * v2.742 그룹 GH — vCenter 로그 DB·로그 이슈 분석 회귀(DB-01 · DB-02 · DB-03 · DB-04 · LEFT-02).
 *  DB-01  엣지 로그 연합 조회 워커(agent/logQueryWorker.js)는 검색어·심각도가 있으면 db.searchAsync 로 읽는다 — 상한 없는 정확 COUNT(db.count)를
 *         부르지 않고, 결과 본문에 totalCapped(상한에 닿았나)를 싣는다. **실제 워커**를 가짜 중앙(같은 프로세스 HTTP)과 돌려 본다.
 *  DB-02  로그 이슈 분석(net/logIssues.js)은 기간 전체를 정확 COUNT·한 문장 조회로 동기 실행하지 않는다 — 상한 있는 개수(capped 표시) +
 *         시간 조각·양보. 결과(합계·Top·패턴)는 예전 판정과 같다. 같은 조건은 짧게 기억한다(실제 adminRouter 로 본다).
 *  DB-03  vCenter 로그 CSV 내보내기(exportLogPages)는 검색어·심각도가 있으면 ts 조각 안에서 키셋으로 읽는다 — 모든 queryPage 가 ts 구간을
 *         갖고, 결과 순서·내용은 예전(구간 없는 키셋)과 같다.
 *  DB-04  logs prune 청크는 작게 시작해 시간 기준으로 맞춘다(인덱스 7개 표에서 2만 행 한 청크 ≈ 0.2~0.5초). 지우는 행은 같다.
 *  LEFT-02 포탈 DB '자세히' 의 vcenter-logs 설명이 v2.741 DB-03 이후 동작(사용 중 크기 · 자동 VACUUM 없음 · 수동 VACUUM 절차)을 말한다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2742i-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'false';
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({
  vcenters: [
    { id: 'vc-edge', name: 'Edge-local', host: 'e.example.invalid', username: 'u', password: 'p' },
    { id: 'lv-d', name: 'Direct', host: 'd.example.invalid', username: 'u', password: 'p' },
    { id: 'lv-s', name: 'Site', host: 's.example.invalid', username: 'u', password: 'p', collectMode: 'site', remoteAgent: 'edge-x' },
  ],
}));

// ── 가짜 중앙(DB-01): /api/central/log-queries 는 pending 을 한 번 내주고, /log-query-result 는 받은 본문을 남긴다.
let pending = [];
const posted = [];
const central = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/api/central/log-queries')) { const q = pending; pending = []; res.end(JSON.stringify({ queries: q })); return; }
    if (req.url.startsWith('/api/central/log-query-result')) { try { posted.push(JSON.parse(body)); } catch { posted.push(null); } res.end('{"ok":true}'); return; }
    res.statusCode = 404; res.end('{}');
  });
});
await new Promise((r) => central.listen(0, '127.0.0.1', r));
process.env.CENTRAL_URL = `http://127.0.0.1:${central.address().port}`;
process.env.CENTRAL_TOKEN = 'test-central-token';
process.env.AGENT_NAME = 'edge-test';

const servers = [];
after(async () => {
  try { central.closeAllConnections?.(); central.close(); } catch { /* */ }
  for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

const { getLogsDb, COUNT_CAP } = await import('../src/logs/db.js');
const db = await getLogsDb();
assert.equal(db.kind, 'sqlite', '테스트 환경은 node:sqlite 전제');

const HOUR = 3_600_000; const DAY = 86_400_000;
// 기준 시각은 정시 −30분으로 고정(CLAUDE.md — 시각 경계에서 떨어뜨린다).
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
let seed = 20261016; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

/** 설정한 시각에 setImmediate 가 몇 번 돌았는지 — 동기로 끝나는 코드는 0 이다. */
async function immediatesDuring(fn) {
  let ticks = 0; let on = true;
  const spin = () => { if (!on) return; ticks++; setImmediate(spin); };
  setImmediate(spin);
  try { const r = await fn(); return { r, ticks }; } finally { on = false; }
}

// ───────────────────────────── DB-01
test('DB-01 엣지 연합 조회 워커 — 검색어·심각도면 searchAsync(정확 COUNT 0회) · totalCapped 를 싣는다 · 필터 없음은 예전 그대로', async () => {
  const rows = [];
  for (let i = 0; i < COUNT_CAP + 37; i++) rows.push({ vcenterId: 'vc-edge', key: `n${i}`, ts: NOW - Math.floor(rnd() * 200 * DAY), severity: i % 7 ? 'info' : 'error', type: 'TaskEvent', user: `u${i % 9}`, entity: `vm-${i % 50}`, message: `needle hit ${i}` });
  for (let i = 0; i < 400; i++) rows.push({ vcenterId: 'vc-edge', key: `o${i}`, ts: NOW - Math.floor(rnd() * 200 * DAY), severity: 'warning', type: 'AlarmEvent', user: '', entity: `h-${i % 5}`, message: `other ${i}` });
  db.insertMany(rows);
  const { runLogQueryWorkerOnce, logQueryWorkerStatus } = await import('../src/agent/logQueryWorker.js');
  const calls = { count: 0, searchAsync: 0 };
  const origCount = db.count; const origSearch = db.searchAsync;
  db.count = (...a) => { calls.count++; return origCount(...a); };
  db.searchAsync = (...a) => { calls.searchAsync++; return origSearch(...a); };
  try {
    const cases = [
      { reqId: 'cap', filter: { vcenterId: 'vc-edge', severity: '', q: 'needle', since: 0, until: 0, limit: 200 } },
      { reqId: 'none', filter: { vcenterId: 'vc-edge', severity: '', q: 'zzz-nomatch', since: 0, until: 0, limit: 200 } },
      { reqId: 'sev', filter: { vcenterId: 'vc-edge', severity: 'warning', q: '', since: NOW - 300 * DAY, until: 0, limit: 50 } },
    ];
    for (const c of cases) {
      pending = [{ reqId: c.reqId, vcenterId: 'vc-edge', filter: c.filter }];
      calls.count = 0; calls.searchAsync = 0;
      await runLogQueryWorkerOnce();
      const b = posted.find((x) => x && x.reqId === c.reqId);
      assert.ok(b, `${c.reqId}: 결과 보고가 없다 — ${JSON.stringify(logQueryWorkerStatus().last)}`);
      assert.equal(calls.count, 0, `${c.reqId}: 검색어·심각도 조회에서 상한 없는 정확 COUNT 를 불렀다(${calls.count}회 — 기간 하한 없이 표 전체를 동기로 훑는다)`);
      assert.ok(calls.searchAsync >= 1, `${c.reqId}: searchAsync 를 쓰지 않았다`);
      const want = { rows: JSON.parse(JSON.stringify(db.query(c.filter, c.filter.limit, 0))), ...db.countCapped(c.filter) };   // 본문은 JSON 왕복
      assert.deepEqual(b.rows, want.rows, `${c.reqId}: 행이 예전 한 문장 판과 다르다`);
      assert.equal(b.total, want.total, `${c.reqId}: total`);
      assert.equal(b.totalCapped, want.capped, `${c.reqId}: totalCapped 가 없거나 틀렸다(중앙이 '적어도 N건' 으로 말할 수 없다)`);
      if (want.capped) assert.equal(b.totalCap, want.total, `${c.reqId}: 상한에 닿았으면 totalCap 을 함께 싣는다`);
    }
    // 필터 없음 — 예전처럼 정확 COUNT(인덱스로 싸다) + 정렬 조회, totalCapped:false
    pending = [{ reqId: 'plain', vcenterId: 'vc-edge', filter: { vcenterId: 'vc-edge', severity: '', q: '', since: 0, until: 0, limit: 20 } }];
    calls.count = 0;
    await runLogQueryWorkerOnce();
    const p = posted.find((x) => x && x.reqId === 'plain');
    assert.ok(p, '필터 없는 조회 결과 보고가 없다');
    assert.ok(calls.count >= 1, '필터 없는 조회는 예전처럼 정확 COUNT');
    assert.equal(p.total, origCount({ vcenterId: 'vc-edge' }));
    assert.equal(p.totalCapped, false);
    assert.equal(p.rows.length, 20);
  } finally { db.count = origCount; db.searchAsync = origSearch; }
});

// ───────────────────────────── DB-02
const { analyzeLogsForIssues, _resetLogIssuesMemo } = await import('../src/net/logIssues.js');
{
  const r = [];
  const types = ['HostConnectionLostEvent', 'BadUsernameSessionEvent', 'DatastoreFullEvent', 'TaskEvent'];
  for (let i = 0; i < 900; i++) {
    const vc = i % 5 === 0 ? 'lv-s' : 'lv-d';
    r.push({ vcenterId: vc, key: `li${i}`, ts: NOW - Math.floor(rnd() * 20 * DAY), severity: i % 3 === 0 ? 'error' : i % 3 === 1 ? 'warning' : 'info',
      type: types[i % types.length], user: '', entity: `esx-${i % 13}`, message: i % 4 === 0 ? 'Lost connection to host' : 'Cannot login root' });
  }
  db.insertMany(r);
}
// 예전 판정(기준 커밋 89adbd1 net/logIssues.js) — 같은 DB 에서 정확 COUNT·한 문장 조회로 계산한 기대값.
function legacyExpect({ vcenterId = '', days = 7, nc = new Map() }) {
  const since = NOW - days * DAY;
  const exclIds = vcenterId ? [] : [...nc.keys()];
  const excl = new Set(exclIds);
  const exclErr = exclIds.length ? db.count({ since, vcenterIds: exclIds, severity: 'error' }) : 0;
  const exclWarn = exclIds.length ? db.count({ since, vcenterIds: exclIds, severity: 'warning' }) : 0;
  const keep = (rows) => (exclIds.length ? rows.filter((x) => !excl.has(String(x.vcenterId))).slice(0, 5000) : rows);
  const errors = keep(db.query({ vcenterId, since, severity: 'error' }, Math.min(25_000, 5000 + exclErr), 0));
  const byType = new Map(); for (const e of errors) byType.set(e.type, (byType.get(e.type) || 0) + 1);
  const topTypes = [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([key, count]) => ({ key, count }));
  return { errors: db.count({ vcenterId, since, severity: 'error' }) - exclErr, warnings: db.count({ vcenterId, since, severity: 'warning' }) - exclWarn, exclErr, exclWarn, topTypes };
}

test('DB-02 ① 로그 이슈 분석 — 정확 COUNT 0회 · 시간 조각 사이에 양보 · 합계·Top·제외 수는 예전 판정과 같다', async () => {
  const nc = new Map([['lv-s', 'site']]);
  for (const c of [{ vcenterId: '', days: 7 }, { vcenterId: '', days: 30 }, { vcenterId: 'lv-d', days: 7 }, { vcenterId: 'lv-d', days: 1 }]) {
    let counts = 0;
    const spy = new Proxy(db, { get(t, k) { if (k === 'count') return (...a) => { counts++; return t.count(...a); }; return t[k]; } });
    const { r, ticks } = await immediatesDuring(() => analyzeLogsForIssues(c, { db: spy, notCollected: nc, now: NOW, yieldMs: 1e-6 }));
    assert.equal(counts, 0, `${JSON.stringify(c)}: 상한 없는 정확 COUNT 를 ${counts}회 불렀다`);
    assert.ok(ticks > 0, `${JSON.stringify(c)}: 분석이 한 번도 양보하지 않고 끝났다(기간 전체를 동기로 훑는다)`);
    const w = legacyExpect({ ...c, nc });
    assert.equal(r.summary.errors, w.errors, `${JSON.stringify(c)}: 오류 합계`);
    assert.equal(r.summary.warnings, w.warnings, `${JSON.stringify(c)}: 경고 합계`);
    assert.equal(r.summary.errorsCapped, false); assert.equal(r.summary.warningsCapped, false);
    assert.deepEqual(r.topTypes, w.topTypes, `${JSON.stringify(c)}: 오류 유형 Top`);
    if (!c.vcenterId) assert.deepEqual(r.excluded, { errors: w.exclErr, warnings: w.exclWarn }, '뺀 vCenter 의 오류·경고 수');
  }
});

test('DB-02 ② 상한에 닿으면 숫자를 지어내지 않고 capped 로 밝힌다 · 기간은 함수 안에서 자른다', async () => {
  const r = await analyzeLogsForIssues({ vcenterId: 'lv-d', days: 30 }, { db, notCollected: new Map(), now: NOW, countCap: 10 });
  assert.equal(r.summary.errors, 10); assert.equal(r.summary.errorsCapped, true);
  assert.equal(r.summary.warnings, 10); assert.equal(r.summary.warningsCapped, true);
  const ok = r.patterns.find((p) => p.sev === 'ok');
  if (ok) assert.match(ok.detail, /이상/, '상한에 닿은 합계를 정확한 값처럼 말하지 않는다');
  const big = await analyzeLogsForIssues({ vcenterId: 'lv-d', days: 1e9 }, { db, notCollected: new Map(), now: NOW });
  assert.ok(Number.isFinite(big.window.since) && big.window.days <= 366, `기간을 자르지 않았다: ${JSON.stringify(big.window)}`);
  const nan = await analyzeLogsForIssues({ vcenterId: 'lv-d', days: 'abc' }, { db, notCollected: new Map(), now: NOW });
  assert.equal(nan.window.days, 7, '숫자가 아니면 기본 7일');
});

test('DB-02 ③ 실제 adminRouter — 같은 조건은 짧게 기억하고(재계산 0) 새 이벤트가 들어오면 다시 계산한다', async () => {
  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', name: 'adm', scope: null }; next(); });
  app.use('/api/admin', adminRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(srv);
  const get = async (p) => { const res = await fetch(`http://127.0.0.1:${srv.address().port}${p}`); return { status: res.status, b: await res.json() }; };
  _resetLogIssuesMemo?.();
  let qa = 0;
  const orig = db.queryAsync;
  db.queryAsync = (...a) => { qa++; return orig(...a); };
  try {
    const a = await get('/api/admin/net/log-issues?vcenterId=lv-d&days=7');
    assert.equal(a.status, 200);
    const first = qa;
    assert.ok(first >= 1);
    const b = await get('/api/admin/net/log-issues?vcenterId=lv-d&days=7');
    assert.equal(b.status, 200);
    assert.equal(qa, first, `같은 조건을 기억하지 않고 다시 훑었다(${qa - first}회)`);
    assert.deepEqual(b.b.summary, a.b.summary);
    // 새 이벤트(더 늦은 ts) → 다시 계산
    db.insertMany([{ vcenterId: 'lv-d', key: 'late-1', ts: Date.now() + 1000, severity: 'error', type: 'TaskEvent', user: '', entity: 'x', message: 'late' }]);
    const c = await get('/api/admin/net/log-issues?vcenterId=lv-d&days=7');
    assert.ok(qa > first, '새 이벤트가 들어왔는데 기억한 결과를 그대로 줬다');
    assert.equal(c.b.summary.errors, a.b.summary.errors + 1);
    // API 로 임의 기간을 줘도 함수가 자른다
    const d = await get('/api/admin/net/log-issues?vcenterId=lv-d&days=100000');
    assert.equal(d.status, 200);
    assert.ok(d.b.window.days <= 366);
  } finally { db.queryAsync = orig; }
});

// ───────────────────────────── DB-03
test('DB-03 CSV 내보내기 — 검색어·심각도면 모든 queryPage 가 ts 구간을 갖고, 결과는 예전(구간 없는 키셋)과 같다', async () => {
  const { exportLogPages } = await import('../src/routes/api/checksLogs.js');
  const r = [];
  for (let i = 0; i < 3000; i++) {
    // 분 단위 ts(같은 ts 묶음) · 일부는 미래(vCenter 시계가 앞섬) · 드문 검색어
    const ts = rnd() < 0.02 ? NOW + Math.floor(rnd() * 3 * HOUR) : Math.floor((NOW - rnd() * 60 * DAY) / 60_000) * 60_000;
    const x = rnd();
    r.push({ vcenterId: i % 2 ? 'ex-a' : 'ex-b', key: `ex${i}`, ts, severity: x < 0.2 ? 'error' : 'info', type: 'TaskEvent', user: '', entity: `vm-${i % 30}`, message: x < 0.03 ? `rare-word ${i}` : `common ${i}` });
  }
  db.insertMany(r);
  const legacyDb = { queryPage: (...a) => db.queryPage(...a), query: (...a) => db.query(...a) };   // tsRange 가 없으면 예전 경로(구간 없는 키셋)
  const filters = [{ q: 'rare-word' }, { severity: 'error' }, { q: 'rare-word', vcenterId: 'ex-a' }, { severity: 'error', since: NOW - 10 * DAY },
    { q: 'common', until: NOW - 5 * DAY }, { severity: 'error', vcenterIds: ['ex-a', 'ex-b'] }, { q: 'nomatch-zzz' }];
  const collect = async (d, f, o) => { const out = []; const res = await exportLogPages(d, f, { ...o, onRows: async (rows) => { out.push(...rows); return true; } }); return { out, res }; };
  for (const f of filters) for (const [max, chunk] of [[100_000, 20_000], [100_000, 7], [40, 9], [1, 1]]) {
    const old = await collect(legacyDb, f, { max, chunk });
    let unbounded = 0; let calls = 0;
    const spy = new Proxy(db, { get(t, k) {
      if (k === 'queryPage') return (ff, lim, cur, bounds) => { calls++; if (!bounds || !Number.isFinite(bounds.lo)) unbounded++; return t.queryPage(ff, lim, cur, bounds); };
      return t[k];
    } });
    const neu = await collect(spy, f, { max, chunk, sliceMs: 6 * HOUR, now: NOW, yieldMs: 1e-6 });
    assert.equal(unbounded, 0, `${JSON.stringify(f)}: ts 구간 없는 키셋 조회 ${unbounded}/${calls}회 — 드문 검색어 한 번이 표 전체를 동기로 훑는다`);
    assert.deepEqual(neu.out.map((x) => x.rid), old.out.map((x) => x.rid), `${JSON.stringify({ f, max, chunk })}: 순서·내용`);
    assert.deepEqual({ ...neu.res }, { ...old.res }, `${JSON.stringify({ f, max, chunk })}: emitted·truncated`);
  }
  // 필터 없음은 예전 경로 그대로(키셋 한 문장 — 인덱스 순서로 LIMIT 에서 멈춘다)
  const plainOld = await collect(legacyDb, { vcenterId: 'ex-a' }, { max: 500, chunk: 100 });
  const plainNew = await collect(db, { vcenterId: 'ex-a' }, { max: 500, chunk: 100 });
  assert.deepEqual(plainNew.out.map((x) => x.rid), plainOld.out.map((x) => x.rid));
});

// ───────────────────────────── DB-04
test('DB-04 ① chunkedDelete 의 시간 기준 청크(targetMs) — 지우는 행은 같고, 청크 소요를 목표 근처로 맞춘다 · 옵션이 없으면 예전 그대로', async () => {
  const { chunkedDelete } = await import('../src/util/chunkedPrune.js');
  const mk = (rows, msPerRow) => {
    let left = rows; let clock = 0; const sizes = [];
    return { stmt: { run: (_c, want) => { const n = Math.min(left, want); left -= n; clock += want * msPerRow; sizes.push(want); return { changes: n }; } },
      clock: () => clock, sizes, left: () => left };
  };
  // 행당 0.02ms(2만 행 = 400ms) — 목표 40ms 면 청크가 약 2,000 으로 줄어야 한다
  const a = mk(50_000, 0.02);
  const ra = await chunkedDelete(a.stmt, [1], { chunk: 20_000, targetMs: 40, clock: a.clock, maxRows: 0 });
  assert.equal(ra.deleted, 50_000); assert.equal(a.left(), 0); assert.equal(ra.done, true);
  assert.ok(a.sizes.slice(1).every((s) => s * 0.02 <= 80), `첫 청크 뒤에도 목표의 2배(80ms)를 넘는 청크가 있다: ${a.sizes.join(',')}`);
  // 빠른 표(행당 0.0005ms)는 키워 간다 — 상한(maxChunk)까지
  const b = mk(200_000, 0.0005);
  const rb = await chunkedDelete(b.stmt, [1], { chunk: 1_000, targetMs: 40, maxChunk: 20_000, clock: b.clock, maxRows: 0 });
  assert.equal(rb.deleted, 200_000);
  assert.ok(Math.max(...b.sizes) > 1_000 && Math.max(...b.sizes) <= 20_000, `청크가 늘지 않았거나 상한을 넘었다: ${Math.max(...b.sizes)}`);
  // 옵션 없음 — 모든 청크가 같은 크기(예전 동작)
  const c = mk(45_000, 0.02);
  const rc = await chunkedDelete(c.stmt, [1], { chunk: 20_000, maxRows: 0 });
  assert.equal(rc.deleted, 45_000);
  assert.ok(c.sizes.every((s) => s === 20_000), `targetMs 없이 청크 크기가 바뀌었다: ${c.sizes.join(',')}`);
  // 상한(maxRows)은 그대로 — 넘겨 지우지 않는다
  const d = mk(50_000, 0.02);
  const rd = await chunkedDelete(d.stmt, [1], { chunk: 20_000, targetMs: 40, clock: d.clock, maxRows: 7_000 });
  assert.equal(rd.deleted, 7_000); assert.equal(rd.done, false);
});

test('DB-04 ② logs prune — 첫 동기 청크·pruneOldest 가 2만 행이 아니라 작게 시작한다 · 결국 같은 행을 지운다', async () => {
  const before = db.rowCount();
  const rows = [];
  const T = NOW - 3000 * DAY;   // 다른 테스트 행보다 훨씬 오래된 구간
  for (let i = 0; i < 7_000; i++) rows.push({ vcenterId: 'pr-a', key: `p${i}`, ts: T + i, severity: 'info', type: 't', user: '', entity: '', message: `m ${i}` });
  db.insertMany(rows);
  const log = console.log; console.log = () => {};
  try {
    const first = db.prune(T + 7_000);
    assert.ok(first > 0 && first <= 2_000, `보관기간 정리의 첫 동기 청크가 ${first}행 — 2만 행 한 청크는 이 표(인덱스 7개)에서 0.2초를 넘는다`);
    await db.pruneInFlight?.();
    assert.equal(db.count({ vcenterId: 'pr-a' }), 0, '보관기간 초과분은 결국 전부 지워진다');
    assert.equal(db.rowCount(), before, '다른 행은 지우지 않는다');
  } finally { console.log = log; }
  const rows2 = [];
  for (let i = 0; i < 5_000; i++) rows2.push({ vcenterId: 'pr-b', key: `q${i}`, ts: T - 10_000 + i, severity: 'info', type: 't', user: '', entity: '', message: `m ${i}` });
  db.insertMany(rows2);
  const k = db.pruneOldest(5_000);
  assert.ok(k > 0 && k <= 2_000, `pruneOldest 첫 청크가 ${k}행`);
  let n = k; while (n < 5_000) { const x = db.pruneOldest(5_000 - n); if (!x) break; n += x; }
  assert.equal(n, 5_000); assert.equal(db.count({ vcenterId: 'pr-b' }), 0, '가장 오래된 것부터 정확히 요청 수만큼');
  assert.equal(db.rowCount(), before);
});

// ───────────────────────────── LEFT-02
test('LEFT-02 포탈 DB 자세히 — vcenter-logs 설명이 자동 VACUUM 을 말하지 않고, 사용 중 크기·파일은 줄지 않음·수동 VACUUM 절차를 말한다', async () => {
  const { guideFor } = await import('../src/insights/dbGuide.js');
  for (const f of ['vcenter-logs.db', 'vcenter-logs.json']) {
    const g = guideFor(f);
    assert.ok(g, `${f} 설명이 없다`);
    const all = [g.summary, ...g.stores, g.writer, ...g.usedBy, g.retention, g.growth, g.shrink, g.ifDeleted, ...g.cautions, ...g.settings].join('\n');
    assert.doesNotMatch(all, /자동 VACUUM|스스로 VACUUM|VACUUM\s*을 한 번 실행|VACUUM\s*까지|파일 크기도 실제로 줄어듭니다|파일을 실제로 줄이는 가장 확실한 방법/,
      `${f}: v2.741 DB-03 이전 동작(상한을 넘으면 자동 VACUUM)을 적고 있다`);
    assert.match(all, /사용 중 크기/, `${f}: 상한이 사용 중 크기 기준이라는 말이 없다`);
    assert.match(all, /줄지 않/, `${f}: 파일 크기가 줄지 않는다는 말이 없다`);
  }
  const g = guideFor('vcenter-logs.db');
  assert.match(g.shrink, /VACUUM/, '파일을 실제로 줄이는 수동 VACUUM 절차가 없다');
  assert.match(g.shrink, /멈춘|중지/, '수동 VACUUM 은 포탈을 멈춘 뒤라는 말이 없다');
  assert.match(g.shrink, /디스크 여유|여유 공간/, 'VACUUM 에 필요한 디스크 여유를 말하지 않는다');
});
