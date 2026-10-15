// v2.741 그룹 GD2 — vCenter 로그 DB·NDJSON 폴백 회귀(AUTHZ-02 · DB-01 · DB-03 · LEFT-13).
//   AUTHZ-02: /tools/vmware-config?download=1(파일 내보내기)는 data.csv 권한 — 실제 api 라우터로 상태코드를 본다.
//   DB-01:    로그 검색(검색어·심각도)은 db.searchAsync — 결과가 예전 한 문장 판(query + countCapped)과 같고 조각 사이에 양보한다.
//   DB-03:    용량 상한은 사용 중 크기(page_count − freelist_count)로 판정하고 VACUUM 을 부르지 않는다 — 실제 폴러를 돌려 본다.
//   LEFT-13:  NDJSON 폴백 재기록(prune·dropTarget·rewrite)은 원자적 교체(tmp → rename) — 파일 inode 가 바뀌는지로 본다(자식 프로세스).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2741e-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';

const express = (await import('express')).default;
const { store } = await import('../src/store.js');
await store.refresh();
const perms = await import('../src/auth/permissions.js');
// 이 파일의 라우트 등록 함수 그대로(registerChecksLogs) — api.js 전체를 끌어오면 다른 묶음 변경에 테스트가 묶인다.
const { registerChecksLogs } = await import('../src/routes/api/checksLogs.js');
const { getLogsDb, resetLogsDb, COUNT_CAP } = await import('../src/logs/db.js');
const { saveLogSettings, loadLogSettings } = await import('../src/logs/settings.js');

const HOUR = 3_600_000; const DAY = 86_400_000;
// 기준 시각은 정시 −30분으로 고정한다(CLAUDE.md — 시각 경계에서 떨어뜨린다).
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
const VCS = (store.get().vcenters || []).map((v) => v.id).slice(0, 6);

// 결정적 난수(LCG) — 매 실행 같은 표본.
let seed = 20261015; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
function synthRows(n) {
  const sevs = ['info', 'info', 'info', 'warning', 'error'];
  const out = [];
  for (let i = 0; i < n; i++) {
    // ts 는 분 단위로 반올림해 같은 ts 묶음(rowid 타이브레이커)과 조각 경계 걸침을 만든다. 2% 는 미래(시계가 앞선 vCenter).
    const ts = rnd() < 0.02 ? NOW + Math.floor(rnd() * 2 * HOUR) : Math.floor((NOW - rnd() * 30 * DAY) / 60_000) * 60_000;
    const r = rnd();
    const word = r < 0.05 ? 'alpha' : r < 0.052 ? 'beta' : r < 0.06 ? 'pct 50%_x' : 'gamma';
    out.push({ vcenterId: VCS[i % VCS.length], key: `k${i}`, ts, severity: sevs[Math.floor(rnd() * sevs.length)],
      type: i % 3 ? 'TaskEvent' : 'UserLoginSessionEvent', user: `u${i % 17}`, entity: `vm-${i % 211}`, message: `${word} event ${i}` });
  }
  return out;
}

let db;
test('준비 — 합성 로그 1.2만 행(무작위 순서 적재 · 같은 ts 묶음 · 미래 ts)', async () => {
  db = await getLogsDb();
  assert.equal(db.kind, 'sqlite');
  db.insertMany(synthRows(12_000));
  assert.equal(db.rowCount(), 12_000);
});

test('DB-01 ① searchAsync 는 query(f, limit, offset) + countCapped(f, cap) 와 같은 결과다(필터·범위·기간·페이지·상한 전수)', async () => {
  assert.equal(typeof db.searchAsync, 'function', 'logs DB 에 searchAsync 가 있어야 한다');
  const filters = [
    { q: 'alpha' }, { q: 'beta' }, { q: 'nomatch-zzz' }, { severity: 'error' }, { q: 'alpha', severity: 'warning' },
    { q: '50%_x' }, { q: 'alpha', vcenterId: VCS[1] }, { q: 'gamma', vcenterIds: [VCS[1], VCS[3]] }, { q: 'alpha', vcenterIds: [] },
    { q: 'alpha', since: NOW - 7 * DAY }, { q: 'gamma', since: NOW - 7 * DAY, until: NOW - DAY }, { severity: 'error', until: NOW - 3 * DAY },
    { severity: 'error', since: NOW - 400 * DAY }, { q: 'alpha', since: NOW + HOUR }, { severity: 'warning', since: NOW - 2 * DAY, until: NOW + 3 * HOUR },
  ];
  const pages = [[200, 0], [50, 37], [1000, 0], [100, 5000], [7, 0]];
  const opts = [{ sliceMs: HOUR, rowidChunk: 1000 }, { sliceMs: 60_000, rowidChunk: 1000 }, { sliceMs: 6 * HOUR, rowidChunk: 50_000 }];
  let cases = 0;
  for (const f of filters) for (const [lim, off] of pages) for (const cap of [COUNT_CAP, 40]) for (const o of opts) {
    const want = { rows: db.query(f, lim, off), ...db.countCapped(f, cap) };
    const got = await db.searchAsync(f, lim, off, { ...o, cap, now: NOW });
    assert.deepEqual(got.rows, want.rows, `rows ${JSON.stringify({ f, lim, off, cap, o })}`);
    assert.equal(got.total, want.total, `total ${JSON.stringify({ f, lim, off, cap })}`);
    assert.equal(got.capped, want.capped, `capped ${JSON.stringify({ f, lim, off, cap })}`);
    cases++;
  }
  assert.ok(cases >= 400);
});

test('DB-01 ② searchAsync 는 조각 사이에 이벤트 루프에 양보한다(무일치 검색 · 기간 있음/없음)', async () => {
  for (const f of [{ q: 'nomatch-zzz' }, { q: 'nomatch-zzz', since: NOW - 20 * DAY }]) {
    let ticks = 0; let on = true;
    const loop = () => { ticks++; if (on) setImmediate(loop); };
    setImmediate(loop);
    const r = await db.searchAsync(f, 200, 0, { sliceMs: HOUR, rowidChunk: 1000, yieldMs: 0.001, now: NOW });
    on = false;
    assert.equal(r.total, 0);
    assert.ok(r.slices > 5, `조각 수 ${r.slices}`);
    assert.ok(ticks > 5, `검색 중 다른 일이 돌아야 한다(돈 횟수 ${ticks})`);
  }
});

// 실제 라우트 핸들러(registerChecksLogs) — 사용자를 헤더로 고른다(인증 미들웨어 대신 — requirePerm 은 config.auth.enabled 와 req.user 로 판정한다).
const USERS = {
  adm: { username: 'adm', role: 'admin', scope: null },
  sup: { username: 'noainred', role: 'admin', superAdmin: true, scope: null },
  op: { username: 'op', role: 'operator', scope: null },
  sc: { username: 'sc', role: 'admin', scope: { vcenters: [VCS[2]] } },
};
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']]; next(); });
const api = express.Router();
registerChecksLogs(api);
app.use('/api', api);
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const BASE = `http://127.0.0.1:${srv.address().port}`;
test.after(() => { srv.closeAllConnections?.(); srv.close(); });
const get = async (u, p) => { const r = await fetch(BASE + p, { headers: { 'x-u': u } }); const buf = Buffer.from(await r.arrayBuffer()); return { status: r.status, type: r.headers.get('content-type') || '', disp: r.headers.get('content-disposition') || '', buf }; };
const json = (x) => JSON.parse(x.buf.toString('utf8'));

test('DB-01 ③ /tools/vclogs 필터 조회는 searchAsync 를 거치고 응답은 예전 계산과 같다(전체·범위 계정)', async () => {
  const orig = db.searchAsync; let calls = 0;
  db.searchAsync = (...a) => { calls++; return orig(...a); };
  try {
    const a = json(await get('adm', '/api/tools/vclogs?q=alpha&limit=50&offset=10'));
    assert.equal(calls, 1, '필터 조회는 searchAsync 로 읽어야 한다(동기 두 문장 금지)');
    assert.deepEqual(a.rows, JSON.parse(JSON.stringify(db.query({ vcenterId: '', severity: '', q: 'alpha', since: 0, until: 0 }, 50, 10))));
    assert.equal(a.total, db.countCapped({ q: 'alpha' }).total);
    const since = NOW - 7 * DAY;
    const s = json(await get('sc', `/api/tools/vclogs?severity=error&since=${since}&limit=30`));
    assert.equal(calls, 2);
    const fsc = { vcenterId: '', severity: 'error', q: '', since, until: 0, vcenterIds: [VCS[2]] };
    assert.deepEqual(s.rows, JSON.parse(JSON.stringify(db.query(fsc, 30, 0))));
    assert.ok(s.rows.every((r) => r.vcenterId === VCS[2]));
    assert.equal(s.total, db.countCapped(fsc).total);
    // 필터 없는 조회는 예전 경로 그대로(정확한 개수)
    const u = json(await get('adm', '/api/tools/vclogs?limit=5'));
    assert.equal(calls, 2);
    assert.equal(u.total, db.rowCount());
    assert.equal(u.totalCapped, false);
  } finally { db.searchAsync = orig; }
});

test('AUTHZ-02 /tools/vmware-config?download=1 은 data.csv 권한 — 끈 admin·operator 403, 조회(JSON)는 그대로 200', async () => {
  perms.saveMatrix({ adminDenied: ['data.csv'] });
  try {
    for (const u of ['adm', 'op']) {
      const d = await get(u, '/api/tools/vmware-config?download=1');
      assert.equal(d.status, 403, `${u} download`);
      assert.deepEqual(json(d).requiredPerm, ['data.csv']);
      assert.ok(!d.disp.includes('attachment'));
      const j = await get(u, '/api/tools/vmware-config');
      assert.equal(j.status, 200, `${u} json`);
      assert.ok(j.type.includes('application/json'));
    }
    const s = await get('sup', '/api/tools/vmware-config?download=1');
    assert.equal(s.status, 200, 'super_admin 은 항상 data.csv');
    assert.ok(s.disp.includes('attachment'));
  } finally { perms.saveMatrix({ adminDenied: [] }); }
  const a = await get('adm', '/api/tools/vmware-config?download=1');
  assert.equal(a.status, 200, 'data.csv 를 가진 admin 은 받는다');
  assert.ok(a.type.includes('application/gzip'));
});

test('DB-03 ① usedBytes 는 지운 만큼 줄고 파일 크기(sizeBytes)는 줄지 않는다 — 판정 기준', async () => {
  const dir = path.join(TMP, 'cap1');
  fs.mkdirSync(dir, { recursive: true });
  saveLogSettings({ storagePath: dir }); resetLogsDb();
  const d = await getLogsDb();
  assert.equal(typeof d.usedBytes, 'function');
  const rows = synthRows(20_000).map((r) => ({ ...r, message: `${r.message} ${'x'.repeat(120)}` })).sort((x, y) => x.ts - y.ts);
  d.insertMany(rows);
  const u0 = d.usedBytes(); const f0 = d.sizeBytes();
  let n = 0; while (n < 10_000) { const k = d.pruneOldest(10_000 - n); if (!k) break; n += k; }
  assert.equal(n, 10_000);
  assert.ok(d.usedBytes() < u0 * 0.8, `사용 중 크기가 줄어야 한다(${u0} → ${d.usedBytes()})`);
  assert.ok(d.sizeBytes() >= f0 * 0.95, '파일은 VACUUM 없이 줄지 않는다(그래서 파일 크기로 판정하면 안 된다)');
  assert.ok(d.freeBytes() > 0);
});

test('DB-03 ② 실제 폴러의 용량 상한 처리는 VACUUM 없이 사용 중 크기를 상한 아래로 만든다(전부 지우지 않는다)', async () => {
  const dir = path.join(TMP, 'cap2');
  fs.mkdirSync(dir, { recursive: true });
  saveLogSettings({ storagePath: dir, maxSizeMB: 2, retentionDays: 0, enabled: true }); resetLogsDb();
  const d = await getLogsDb();
  const rows = synthRows(30_000).map((r) => ({ ...r, ts: r.ts - 200 * DAY, message: `${r.message} ${'y'.repeat(150)}` })).sort((x, y) => x.ts - y.ts);
  d.insertMany(rows);
  assert.ok(d.usedBytes() > 4 * 1024 * 1024, `사전 적재가 상한보다 커야 한다(${d.usedBytes()})`);
  let vac = 0; const origVac = d.vacuum; d.vacuum = () => { vac++; return origVac(); };
  const { pollLogsOnce, logStatus } = await import('../src/logs/poller.js');
  try {
    for (let i = 0; i < 10; i++) await pollLogsOnce({ manual: true });   // PRUNE_EVERY(10) 번째 주기에 용량 점검
  } finally { d.vacuum = origVac; }
  assert.equal(vac, 0, '용량 상한 처리에서 VACUUM(파일 전체 재작성 — 동기 수 초)을 부르지 않는다');
  const used = d.usedBytes();
  assert.ok(used <= 2 * 1024 * 1024, `사용 중 크기가 상한 아래여야 한다(${used})`);
  assert.ok(d.rowCount() > 1000, `상한 만큼만 지운다 — 전부 지우지 않는다(남은 ${d.rowCount()}행)`);
  const st = await logStatus();
  assert.ok(Number.isFinite(st.dbUsedBytes) && Number.isFinite(st.dbFreeBytes), '상태가 사용 중 크기·빈 공간을 싣는다');
  assert.equal(st.lastCap?.limitBytes, 2 * 1024 * 1024);
  assert.ok(st.lastCap.dropped > 0 && st.lastCap.stuck === false);
  saveLogSettings({ storagePath: '', maxSizeMB: 1024, retentionDays: 365 }); resetLogsDb();
  assert.equal(loadLogSettings().storagePath, '');
});

test('LEFT-13 NDJSON 폴백 재기록은 원자적 교체다 — logs·metrics·ping·idrac(자식 프로세스, SQLite 를 열 수 없게 해 폴백)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2741e-ndjson-'));
  for (const n of ['vcenter-logs.db', 'host-temp.db', 'ping-monitor.db', 'idrac-power.db']) fs.mkdirSync(path.join(dir, n));   // DB 경로가 디렉터리 → open 실패(잠금 아님) → NDJSON
  const script = `
    const out = {};
    const ino = (f) => require('node:fs').statSync(f).ino;
    const R = ${JSON.stringify(SRC)};
    const { getLogsDb } = await import(R + '/logs/db.js');
    const L = await getLogsDb(); out.logsKind = L.kind;
    L.insertMany([{ vcenterId: 'v', key: 'a', ts: 1000, message: 'old' }, { vcenterId: 'v', key: 'b', ts: 9000, message: 'new' }, { vcenterId: 'v', key: 'c', ts: 9500, message: 'new2' }]);
    let i0 = ino(L.path); L.prune(5000); out.logsPrune = ino(L.path) !== i0; out.logsLeft = L.count({});
    i0 = ino(L.path); L.pruneOldest(1); out.logsOldest = ino(L.path) !== i0;
    const { getMetricsDb } = await import(R + '/metrics/db.js');
    const M = await getMetricsDb(); out.metricsKind = M.kind;
    M.insertMany([{ metric: 'm', k: 'a', v: 1 }], 1000); M.insertMany([{ metric: 'm', k: 'a', v: 2 }], 9000);
    const mf = ${JSON.stringify(path.join(dir, 'host-temp.ndjson'))};
    i0 = ino(mf); M.prune(5000); out.metricsPrune = ino(mf) !== i0;
    out.metricsLeft = require('node:fs').readFileSync(mf, 'utf8').trim().split('\\n').length;
    const { getPingDb } = await import(R + '/ping/db.js');
    const P = await getPingDb(); out.pingKind = P.kind;
    P.insertMany([{ target: 't1', ts: 1000, rtt: 1, ok: true }, { target: 't1', ts: 9000, rtt: 2, ok: true }, { target: 't2', ts: 9000, rtt: 3, ok: true }]);
    const pf = ${JSON.stringify(path.join(dir, 'ping-monitor.ndjson'))};
    i0 = ino(pf); P.prune(5000); out.pingPrune = ino(pf) !== i0;
    i0 = ino(pf); await P.dropTarget('t2'); out.pingDrop = ino(pf) !== i0;
    out.pingLeft = require('node:fs').readFileSync(pf, 'utf8').trim().split('\\n').length;
    const { getDb } = await import(R + '/idrac/db.js');
    const D = await getDb(); out.idracKind = D.kind;
    D.insertMany([{ serverId: 's1', watts: 100, ts: 1000 }, { serverId: 's1', watts: 110, ts: 9000 }, { serverId: 's2', watts: 50, ts: 9000 }]);
    const df = ${JSON.stringify(path.join(dir, 'idrac-power.ndjson'))};
    i0 = ino(df); D.prune(5000); out.idracPrune = ino(df) !== i0;
    i0 = ino(df); D.deleteServers(['s2']); out.idracDelete = ino(df) !== i0;
    out.idracLeft = require('node:fs').readFileSync(df, 'utf8').trim().split('\\n').length;
    process.stdout.write('@@' + JSON.stringify(out) + '@@');
    process.exit(0);
  `;
  const raw = execFileSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); ${script}`], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', IDRAC_DB_PATH: path.join(dir, 'idrac-power.db'), TEMP_DB_PATH: path.join(dir, 'host-temp.db'), PING_DB_PATH: path.join(dir, 'ping-monitor.db') },
    cwd: path.join(HERE, '..'), encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = JSON.parse(raw.split('@@')[1]);
  for (const k of ['logsKind', 'metricsKind', 'pingKind', 'idracKind']) assert.equal(out[k], 'json', `${k} 는 NDJSON 폴백이어야 한다`);
  for (const k of ['logsPrune', 'logsOldest', 'metricsPrune', 'pingPrune', 'pingDrop', 'idracPrune', 'idracDelete']) {
    assert.equal(out[k], true, `${k}: 재기록이 같은 파일을 0바이트로 자르고 덮어쓰면 안 된다(tmp → rename 으로 inode 가 바뀐다)`);
  }
  assert.equal(out.logsLeft, 2); assert.equal(out.metricsLeft, 1); assert.equal(out.pingLeft, 1); assert.equal(out.idracLeft, 1);
});
