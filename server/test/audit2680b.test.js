// v2.680 감사 그룹 B — iDRAC 통합 추이 결함 정리.
//  ① E-02 statsSinceAll 은 지표 파티션 전체를 훑지 않는다(키마다 seek) — 실행된 SQL 의 계획을 직접 본다 + 옛 SQL 과 결과 동일.
//  ② A-07 1일 버킷은 포탈 날짜(한국 시각 0시) 경계 — parseWindow · metrics historyRange · 전력 bucketRange · rebucketMean.
//  ③ A-04 /idrac/trend/table 은 서버 수만큼 등록부를 다시 읽지 않는다(statSync 횟수).
//  ④ C-04 resolve-host 는 범위 밖 호스트에 404.
//  ⑤ C-05 범위 계정은 범위 밖 vCenter 호스트와의 매칭이 없는 것으로 본다(hostCpu null · 베어메탈).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2680b-'));
process.env.CONFIG_DIR = DIR;
process.env.TEMP_DB_PATH = path.join(DIR, 'host-temp.db');
process.env.IDRAC_DB_PATH = path.join(DIR, 'idrac-power.db');
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'mock';

// 실행된 SQL 을 기록한다(계획 검사용). 모듈을 불러오기 전에 건다.
const executed = [];
let recording = false;
const origPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function patched(sql, ...rest) {
  const st = origPrepare.call(this, sql, ...rest);
  for (const m of ['get', 'all']) {
    const f = st[m].bind(st);
    st[m] = (...a) => { if (recording) executed.push(sql); return f(...a); };
  }
  return st;
};

const HOUR = 3_600_000, DAY = 86_400_000, MIN = 60_000;
const { getMetricsDb } = await import('../src/metrics/db.js');
const T = await import('../src/routes/admin/idracTrend.js');

test('① E-02 statsSinceAll — 키마다 (metric,k,h) seek · 옛 SQL 과 같은 결과', async () => {
  const db = await getMetricsDb();
  const raw = new DatabaseSync(process.env.TEMP_DB_PATH);
  const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * MIN;
  const ins = raw.prepare('INSERT OR REPLACE INTO samples_hourly (metric, k, h, n, sum, mn, mx) VALUES (?, ?, ?, ?, ?, ?, ?)');
  raw.exec('BEGIN');
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 40; i += 1) {
    const k = `srv-${String(i).padStart(3, '0')}`;
    const hours = i % 5 === 0 ? 10 : 200; // 일부 키는 창 밖 이력만 있다
    for (let j = 0; j < hours; j += 1) {
      const h = Math.floor(NOW / HOUR) * HOUR - (j + (i % 5 === 0 ? 100 : 0)) * HOUR;
      const n = 1 + Math.floor(rnd() * 60); const mn = rnd() * 50; const mx = mn + rnd() * 40;
      ins.run('t2680_m', k, h, n, (mn + mx) / 2 * n * (0.9 + rnd() * 0.2), mn, mx);
    }
  }
  ins.run('t2680_other', 'srv-000', Math.floor(NOW / HOUR) * HOUR, 1, 5, 5, 5);
  raw.exec('COMMIT');
  const since = NOW - 48 * HOUR;
  const oldRows = raw.prepare(`SELECT k, SUM(sum)/SUM(n) AS avg, MIN(mn) AS min, MAX(mx) AS max, SUM(n) AS n
    FROM samples_hourly WHERE metric=? AND h>=? GROUP BY k`).all('t2680_m', Math.floor(since / HOUR) * HOUR);
  const r1 = (x) => (x == null ? null : Number(x.toFixed(1)));
  const want = new Map(oldRows.map((r) => [r.k, { avg: r1(r.avg), min: r1(r.min), max: r1(r.max), n: r.n }]));
  executed.length = 0; recording = true;
  const got = db.statsSinceAll('t2680_m', since);
  recording = false;
  const gotA = await db.statsSinceAllAsync('t2680_m', since);
  assert.deepEqual([...got.entries()].sort(), [...want.entries()].sort(), '옛 GROUP BY 와 같은 결과');
  assert.deepEqual([...gotA.entries()].sort(), [...want.entries()].sort(), '비동기판도 같은 결과');
  assert.ok(want.size > 20 && !want.has('srv-000'), '창 밖 키는 빠진다');
  // 실행된 SQL 의 계획 — 재귀 키 탐색을 빼면 samples_hourly 를 (metric=?) 만으로 훑는 문장이 없어야 한다.
  const plans = [...new Set(executed)].filter((q) => /samples_hourly/.test(q) && !/RECURSIVE/.test(q))
    .map((q) => raw.prepare(`EXPLAIN QUERY PLAN ${q}`).all(...q.split('?').slice(1).map(() => 'x')).map((r) => r.detail).join(' | '));
  assert.ok(plans.length >= 1, '집계 문장이 실행됐다');
  for (const p of plans) assert.match(p, /k=\?/, `키 seek 계획이어야 한다: ${p}`);
  raw.close();
});

test('② A-07 parseWindow — 1일 버킷만 포탈 날짜 경계(오프셋 9시간) · 다른 버킷은 그대로', () => {
  const now = Date.UTC(2026, 8, 30, 3, 17); // KST 12:17
  const y = T.parseWindow({ range: '1y' }, { now, offsetMin: 540 });
  assert.equal(y.bucketMs, DAY); assert.equal(y.offsetMs, 9 * HOUR);
  assert.equal((y.start + 9 * HOUR) % DAY, 0, 'KST 0시 경계');
  assert.ok(y.start <= now - 365 * DAY && y.start > now - 366 * DAY);
  const d = T.parseWindow({ range: '24h' }, { now, offsetMin: 540 });
  assert.equal(d.offsetMs, 0); assert.equal(d.start % d.bucketMs, 0, '1일 미만 버킷은 예전 경계');
  assert.equal(T.parseWindow({ range: '1y' }, { now, offsetMin: 330 }).offsetMs, 0, '1시간 정배수가 아니면 UTC(롤업 경계)');
  assert.equal(T.dayBucketOffsetMs(0), 0);
  // rebucketMean — 오프셋 경계로 다시 묶는다.
  const win = { start: y.start, bucketMs: DAY, offsetMs: 9 * HOUR };
  const day0 = y.start; // KST 0시
  const out = T.rebucketMean([{ ts: day0 + MIN, v: 10 }, { ts: day0 + 23 * HOUR, v: 30 }, { ts: day0 + DAY, v: 50 }, { ts: day0 + 5, v: null }], win);
  assert.deepEqual(out, [{ ts: day0, v: 20 }, { ts: day0 + DAY, v: 50 }]);
});

test('② A-07 historyRange · 전력 bucketRange — 오프셋 버킷이 KST 하루를 묶는다(오프셋 0 은 예전 UTC)', async () => {
  const db = await getMetricsDb();
  const raw = new DatabaseSync(process.env.TEMP_DB_PATH);
  const day0 = Date.UTC(2026, 6, 1) - 9 * HOUR; // KST 2026-07-01 00:00
  const ins = raw.prepare('INSERT OR REPLACE INTO samples_hourly (metric, k, h, n, sum, mn, mx) VALUES (?, ?, ?, 1, ?, ?, ?)');
  raw.exec('BEGIN');
  for (let j = -24; j < 48; j += 1) { const v = j < 24 ? 10 : 40; ins.run('t2680_d', 'k1', day0 + j * HOUR, v, v, v); }
  raw.exec('COMMIT'); raw.close();
  const kst = db.historyRange('t2680_d', 'k1', day0, day0 + 2 * DAY, DAY, 9 * HOUR);
  assert.deepEqual(kst.map((p) => [p.ts, p.avg]), [[day0, 10], [day0 + DAY, 40]], 'KST 0시 ~ 24시 한 칸');
  const utc = db.historyRange('t2680_d', 'k1', day0, day0 + 2 * DAY, DAY);
  assert.equal(utc[0].ts % DAY, 0, '오프셋 없이는 UTC 경계(호환)');
  // 전력 — 시간당 롤업 행
  const { getDb } = await import('../src/idrac/db.js');
  const pdb = await getDb();
  const pr = new DatabaseSync(process.env.IDRAC_DB_PATH);
  const pins = pr.prepare('INSERT OR REPLACE INTO power_hourly (server_id, hb, sumw, cnt, maxw, minw, last_ts) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (let j = 0; j < 48; j += 1) { const w = j < 24 ? 100 : 300; pins.run('p1', (day0 + j * HOUR) / HOUR, w * 2, 2, w, w, day0 + j * HOUR); }
  pr.close();
  const pk = pdb.bucketRange('p1', day0, day0 + 2 * DAY, DAY, 9 * HOUR);
  assert.deepEqual(pk, [{ ts: day0, watts: 100 }, { ts: day0 + DAY, watts: 300 }]);
  const pu = pdb.bucketRange('p1', day0, day0 + 2 * DAY, DAY);
  assert.ok(pu.every((p) => p.ts % DAY === 0), '오프셋 없으면 예전 그대로');
});

// ── 라우트 ──
const USERS = {
  full: { username: 'full', role: 'admin', scope: null },
  sadm: { username: 'sadm', role: 'admin', scope: null }, // vcenters 는 아래에서 채운다
};
let srv; let base; let IN_VC; let OUT_HOST;
async function call(u, p) {
  const r = await fetch(base + p, { headers: { 'x-u': u } });
  let j = null; try { j = await r.json(); } catch { /* */ }
  return { s: r.status, j };
}

test('라우트 준비', async () => {
  const { store } = await import('../src/store.js');
  await store.refresh({ force: true });
  const hosts = store.get().hosts || [];
  const vcs = [...new Set(hosts.map((h) => h.vcenterId).filter(Boolean))];
  assert.ok(vcs.length >= 2, '목 vCenter 둘 이상');
  IN_VC = vcs[0];
  const short = (n) => String(n || '').split('.')[0].toLowerCase();
  const counts = new Map(); for (const h of hosts) counts.set(short(h.name), (counts.get(short(h.name)) || 0) + 1);
  OUT_HOST = hosts.find((h) => h.vcenterId !== IN_VC && counts.get(short(h.name)) === 1 && !/^\d/.test(short(h.name)));
  assert.ok(OUT_HOST, '범위 밖 유일 이름 호스트');
  USERS.sadm.scope = { vcenters: [IN_VC] };
  const { addServer } = await import('../src/idrac/registry.js');
  // C-05: 범위 안(vcenterId 명시)인데 이름이 범위 밖 호스트와 같은 서버.
  assert.equal(addServer({ id: 'c05', name: short(OUT_HOST.name).toUpperCase(), host: '10.9.0.1', username: 'root', password: 'x', vcenterId: IN_VC }).ok, true);
  for (let i = 0; i < 25; i += 1) addServer({ id: `bulk${i}`, name: `bulk-node-${i}`, host: `10.9.1.${i + 1}`, username: 'root', password: 'x', vcenterId: IN_VC });
  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api/admin', adminRouter);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api/admin`;
});

test('③ A-04 /idrac/trend/table — 등록부를 서버 수만큼 다시 읽지 않는다', async () => {
  const regFile = path.join(DIR, 'idrac.json');
  const orig = fs.statSync;
  let n = 0;
  fs.statSync = function counted(p, ...a) { if (String(p) === regFile) n += 1; return orig.call(this, p, ...a); };
  let r;
  try { r = await call('full', '/idrac/trend/table?hours=6&corp=*&site=*'); } finally { fs.statSync = orig; }
  assert.equal(r.s, 200);
  assert.ok(r.j.rows.length >= 26, `행 ${r.j.rows.length}`);
  assert.ok(n < 12, `등록부 statSync ${n}회 — 행마다 읽으면 행 수 이상이다`);
  // 색인 함수 — 등록부 먼저, 엣지 보고는 같은 id 의 처음 것.
  const find = T.serverLookup({ registry: [{ id: 'a', v: 1 }], remote: [{ id: 'b', v: 2 }, { id: 'b', v: 3 }, { id: 'a', v: 9 }] });
  assert.equal(find('a').v, 1); assert.equal(find('b').v, 2); assert.equal(find('zz'), null);
});

test('④ C-04 resolve-host — 범위 밖 호스트는 404(이름·vCenter 를 싣지 않는다) · 전체 범위는 200', async () => {
  const q = `/idrac/trend/resolve-host?hostId=${encodeURIComponent(OUT_HOST.id)}`;
  const s = await call('sadm', q);
  assert.equal(s.s, 404);
  assert.ok(!JSON.stringify(s.j).includes(OUT_HOST.name), '이름을 싣지 않는다');
  assert.equal((await call('full', q)).s, 200);
});

test('⑤ C-05 범위 계정 — 범위 밖 vCenter 호스트와 매칭된 서버는 hostCpu 없음 · 베어메탈', async () => {
  const full = await call('full', '/idrac/c05/trend?range=6h');
  assert.equal(full.s, 200);
  assert.equal(full.j.kind, 'esxi'); assert.equal(full.j.hostCpu?.hostId, OUT_HOST.id, '전체 범위는 예전처럼 매칭');
  const sc = await call('sadm', '/idrac/c05/trend?range=6h');
  assert.equal(sc.s, 200);
  assert.equal(sc.j.hostCpu, null); assert.equal(sc.j.hostGpu, null); assert.equal(sc.j.kind, 'baremetal');
  assert.ok(!JSON.stringify(sc.j).includes(OUT_HOST.id), '범위 밖 호스트 id 를 싣지 않는다');
  const tb = await call('sadm', '/idrac/trend/table?hours=6&corp=*&site=*');
  assert.equal(tb.j.rows.find((x) => x.id === 'c05')?.kind, 'baremetal');
  // 순수 — 범위 안 호스트는 그대로.
  const k = { kind: 'esxi', host: { id: 'h', vcenterId: 'A' }, matchedBy: 'hostname' };
  assert.equal(T.scopeKind(k, { allowed: new Set(['A']) }), k);
  assert.equal(T.scopeKind(k, null), k);
  assert.equal(T.scopeKind(k, { allowed: new Set(['B']) }).host, null);
});

test('정리', () => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });
