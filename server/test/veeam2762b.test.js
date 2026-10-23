/**
 * v2.762 — Veeam 표시·수량 판정·전용 DB 점검 확정분(수정 그룹 B) 회귀.
 *  E1 래치·잠금 대기 중 버린 행 → 표지 파일 → 다음 프로세스가 덮음을 믿지 않는다(C5 메모리 무효의 재시작 소실도) ·
 *  E2 전용 DB 적재가 로그 DB 적재보다 먼저(실제 pollLogsOnce — 자식 프로세스, mock 수집) · E3 open 은 시도당 1회(동기 대기 누적 없음) ·
 *  E-I1 엣지 payload 가 vCenter 사이에 양보 · F2·F3 veeamCount 사유·failedNoLast · F4 등록부 손상 → 503·registry-unreadable ·
 *  F5 otherVcenter 수는 관리자만(응답 경로 전부 + 캐시 키) · F6 '오래됨' 한도 = max(6h, 로그 주기×2+30분).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'veeam2762b-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
const VC1 = 'pl:vc01';   // Veeam 연동 · 다른 vCenter 로 적힌 VM 만(주소 불일치)
const VC2 = 'kr:vc02';   // Veeam 연동 · 실패(한 번도 성공 못함) + 첫 수집 전
const SN = 'kr:vc05';    // 연동 없음 · 직접 수집
const ALL = [VC1, VC2, SN];
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: ALL.map((id) => ({ id, name: id, host: `${id.split(':')[1]}.corp.local`, username: 'u', password: 'p' })) }));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const B = await import('../src/veeam/backupCounts.js');
const S = await import('../src/veeam/snapEvents.js');
const D = await import('../src/veeam/snapDb.js');
const { config } = await import('../src/config.js');
const HOUR = 3_600_000; const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;
const quiet = async (fn) => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };
const snapRow = (vc, extra) => ({ vcenterId: vc, severity: 'info', type: 'TaskEvent', user: 'CORP\\svc-bkp', message: 'Task: Create virtual machine snapshot', ...extra });

test('E1 — 잠금이 아닌 open 실패로 래치된 동안 버린 행 → 표지 → 다음 프로세스는 그 vCenter 덮음을 믿지 않는다', { timeout: 60_000 }, async () => {
  const { getLogsDb } = await import('../src/logs/db.js');
  S.saveManualAccounts(['svc-bkp']);
  const VC = 'kr:e1';
  const logs = await getLogsDb();
  await logs.insertManyAsync([{ ...snapRow(VC, { ts: NOW - 3 * DAY, entity: 'app1' }), key: 'e1a' }]);
  const db = await D.getSnapDb();
  await D.backfillSnap({ logsDb: logs, vcenterIds: [VC], now: NOW });
  assert.equal(S.snapCovered(db, VC, NOW - 7 * DAY), true);
  D._resetSnapDbForTest();
  // 프로세스 B: DB 경로가 디렉터리라 열지 못함(잠금 아님 → 래치) — 그동안 폴러가 새 백업 이벤트를 적재
  const file = config.veeamSnap.dbPath; const bak = `${file}.bak-e1`;
  fs.renameSync(file, bak); fs.mkdirSync(file);
  try {
    assert.equal(await quiet(() => D.getSnapDb()), null, '래치');
    const row = { ...snapRow(VC, { ts: NOW - HOUR, entity: 'app2' }), key: 'e1b' };
    await logs.insertManyAsync([row]);
    assert.equal(await quiet(() => D.ingestSnapRows([row])), 0);
    assert.ok(fs.existsSync(D._invalidMarkerPathForTest()), '표지 파일을 남긴다');
    assert.deepEqual(JSON.parse(fs.readFileSync(D._invalidMarkerPathForTest(), 'utf8')).vcenterIds, [VC]);
  } finally { D._resetSnapDbForTest(); fs.rmdirSync(file); fs.renameSync(bak, file); }
  // 프로세스 C: 정상 open — 표지를 보고 덮음을 지운다(메모리 무효는 재시작으로 사라졌다)
  const db2 = await quiet(() => D.getSnapDb());
  assert.ok(db2);
  assert.equal(S.snapCovered(db2, VC, NOW - 7 * DAY), false, '빠진 행이 있는 덮음을 믿지 않는다');
  assert.equal(fs.existsSync(D._invalidMarkerPathForTest()), false, '표지는 지운다');
  await D.backfillSnap({ logsDb: logs, vcenterIds: [VC] });
  assert.equal(S.snapCovered(db2, VC, NOW - 7 * DAY), true, '백필이 다시 메운다');
  const vms = [{ id: `${VC}:vm-1`, vcenterId: VC, name: 'app1' }, { id: `${VC}:vm-2`, vcenterId: VC, name: 'app2' }];
  assert.equal(Object.keys((await S.localSnapSummary(logs, VC, vms, { snapDb: db2 })).byVm).length, 2);
});

test('E1(C5 잔여) — 잠금 대기 중 버린 행의 무효는 재시작해도 남는다 · E3 open 은 시도당 1회(27초 동기 대기 누적 없음)', { timeout: 120_000 }, async () => {
  const { getLogsDb } = await import('../src/logs/db.js');
  const { DatabaseSync } = await import('node:sqlite');
  const VC = 'kr:c5';
  const logs = await getLogsDb();
  let db = await D.getSnapDb();
  await logs.insertManyAsync([{ ...snapRow(VC, { ts: NOW - 2 * DAY, entity: 'app1' }), key: 'c5a' }]);
  await D.backfillSnap({ logsDb: logs, vcenterIds: [VC], now: NOW });
  assert.equal(S.snapCovered(db, VC, NOW - 7 * DAY), true);
  D._resetSnapDbForTest();
  const locker = new DatabaseSync(config.veeamSnap.dbPath);
  locker.exec('PRAGMA journal_mode=DELETE');
  locker.exec('BEGIN EXCLUSIVE');
  try {
    const t0 = performance.now();
    db = await quiet(() => D.getSnapDb());
    const took = performance.now() - t0;
    assert.equal(db, null);
    assert.ok(took < 8_000, `E3: 잠긴 DB 의 open 한 번은 busy_timeout 한 번(약 3초) — ${Math.round(took)}ms`);
    const row = { ...snapRow(VC, { ts: NOW - HOUR, entity: 'app2' }), key: 'c5b' };
    await logs.insertManyAsync([row]);
    assert.equal(await D.ingestSnapRows([row]), 0);
  } finally { locker.exec('ROLLBACK'); locker.close(); }
  D._resetSnapDbForTest();   // 재시작 — 메모리 무효(_coverInvalid)가 사라진다
  db = await quiet(() => D.getSnapDb());
  assert.ok(db);
  assert.equal(S.snapCovered(db, VC, NOW - 7 * DAY), false, '재시작 뒤에도 빠진 행이 있는 덮음을 믿지 않는다');
});

test('E1 — 표지 파일이 손상이면 어느 vCenter 인지 모르므로 전 vCenter 덮음을 지운다(손상본은 보존) · 손상 표지에 덧쓸 때도 좁히지 않는다', { timeout: 60_000 }, async () => {
  const { getLogsDb } = await import('../src/logs/db.js');
  const logs = await getLogsDb();
  let db = await D.getSnapDb();
  await D.backfillSnap({ logsDb: logs, vcenterIds: ['kr:m1', 'kr:m2'], now: NOW });
  assert.equal(S.snapCovered(db, 'kr:m1', NOW - 7 * DAY) && S.snapCovered(db, 'kr:m2', NOW - 7 * DAY), true);
  D._resetSnapDbForTest();
  const mk = D._invalidMarkerPathForTest();
  fs.writeFileSync(mk, '{"v":1,"vcenterIds":["kr:m1"');   // 잘린 표지
  db = await quiet(() => D.getSnapDb());
  assert.deepEqual([S.snapCovered(db, 'kr:m1', NOW - 7 * DAY), S.snapCovered(db, 'kr:m2', NOW - 7 * DAY)], [false, false]);
  assert.equal(fs.existsSync(mk), false);
  assert.ok(fs.readdirSync(path.dirname(mk)).some((f) => f.startsWith(`${path.basename(mk)}.corrupt.`)), '손상본 보존');
  // 잠금 대기 중 표지를 쓰는데 기존 표지가 손상이면 'all' 로 둔다
  await D.backfillSnap({ logsDb: logs, vcenterIds: ['kr:m1', 'kr:m2'] });
  D._resetSnapDbForTest();
  fs.writeFileSync(mk, 'garbage');
  const { DatabaseSync } = await import('node:sqlite');
  const locker = new DatabaseSync(config.veeamSnap.dbPath);
  locker.exec('PRAGMA journal_mode=DELETE'); locker.exec('BEGIN EXCLUSIVE');
  try {
    assert.equal(await quiet(() => D.getSnapDb()), null);
    await quiet(() => D.ingestSnapRows([snapRow('kr:m1', { ts: NOW, entity: 'z' })]));
    assert.equal(JSON.parse(fs.readFileSync(mk, 'utf8')).all, true);
  } finally { locker.exec('ROLLBACK'); locker.close(); }
  D._resetSnapDbForTest();
  db = await quiet(() => D.getSnapDb());
  assert.equal(S.snapCovered(db, 'kr:m2', NOW - 7 * DAY), false, '적히지 않은 vCenter 도(전부)');
});

test('E2 — 로그 폴러는 전용 DB 에 먼저 넣는다(로그 DB 적재가 도중에 끝나도 전용 DB 에 빠진 행이 없다 · 실제 pollLogsOnce)', { timeout: 120_000 }, () => {
  const src = fileURLToPath(new URL('../src', import.meta.url));
  const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'veeam2762b-e2-'));
  const child = path.join(cdir, 'child.mjs');
  fs.writeFileSync(child, `
const R = process.argv[2];
const P = await import(R + '/logs/poller.js');
const { store } = await import(R + '/store.js');
const { getLogsDb } = await import(R + '/logs/db.js');
const D = await import(R + '/veeam/snapDb.js');
const VC = 'kr:vc01';
store.snapshot = { source: 'mock', generatedAt: Date.now(), vcenters: [{ id: VC, name: 'vc01' }], hosts: [],
  vms: Array.from({ length: 6 }, (_, i) => ({ id: VC + ':vm-' + i, vcenterId: VC, name: 'web0' + i })) };
const logs = await getLogsDb();
let seen = null;
logs.insertManyAsync = async (rows) => {   // 로그 DB 적재 시점 — 여기서 프로세스가 끝나거나 적재가 던진 것과 같다
  const sdb = await D.getSnapDb();
  seen = { snapRowsInBatch: rows.filter(D.isSnapRow).length, snapDbRows: sdb ? sdb.rowsFor(VC, 0, 1e6).length : -1 };
  throw new Error('simulated exit mid-insert');
};
console.warn = () => {};
try { await P.pollLogsOnce(); } catch { /* */ }
process.stdout.write('RESULT ' + JSON.stringify(seen) + '\\n');
process.exit(0);
`);
  try {
    const r = spawnSync(process.execPath, [child, src], { env: { ...process.env, CONFIG_DIR: path.join(cdir, 'cfg'), DATA_SOURCE: 'mock' }, encoding: 'utf8', timeout: 100_000 });
    const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
    assert.ok(line, `자식 출력 없음: ${String(r.stderr || '').slice(-500)}`);
    const seen = JSON.parse(line.slice(7));
    assert.ok(seen && seen.snapRowsInBatch > 0, '합성 수집에 스냅샷 행이 있어야 시험이 성립한다');
    assert.equal(seen.snapDbRows, seen.snapRowsInBatch, '로그 DB 적재 전에 전용 DB 에 이미 들어 있다');
  } finally { fs.rmSync(cdir, { recursive: true, force: true }); }
});

test('E-I1 — 엣지 payload 는 vCenter 사이에 이벤트 루프에 양보한다', async () => {
  const busy = (ms) => { const t = performance.now(); while (performance.now() - t < ms) { /* 동기 비용 */ } };
  const fakeSnapDb = { coveredFrom: () => 1, rowsFor: () => { busy(25); return []; } };
  const vcs = ['e:a', 'e:b', 'e:c', 'e:d'];
  const snap = { vcenters: vcs.map((id) => ({ id })), vms: vcs.map((id) => ({ id: `${id}:vm-1`, vcenterId: id, name: 'x' })) };
  let ticks = 0; let on = true;
  const tick = () => { ticks++; if (on) setImmediate(tick); };
  setImmediate(tick);
  const out = await S.edgeSnapPayload({ db: {}, snap, notCollected: new Map(), logSettings: { enabled: true, minSeverity: 'info' }, now: NOW, snapDb: fakeSnapDb });
  on = false;
  assert.equal(out.length, 4);
  assert.ok(ticks >= 2, `vCenter 사이에 다른 매크로태스크가 돌았다(${ticks})`);
});

test('F2·F3 — veeamCount: 실패 서버가 있으면 veeam-failed 우선(첫 수집 대기 수도 함께) · 한 번도 성공 못한 실패는 failedNoLast', () => {
  const f3 = B.veeamCount({ views: [{ ok: false, lastOkTs: null }, { ok: null, lastOkTs: null }], byVm: null, vmTotal: 9 });
  assert.deepEqual([f3.n, f3.reason, f3.failed, f3.waiting], [null, 'veeam-failed', 1, 1]);
  assert.equal(B.veeamCount({ views: [{ ok: null, lastOkTs: null }], byVm: null, vmTotal: 9 }).reason, 'veeam-pending');
  const f2 = B.veeamCount({ views: [{ ok: true, lastOkTs: NOW }, { ok: false, lastOkTs: null }, { ok: false, lastOkTs: NOW - HOUR }], byVm: { a: {} }, vmTotal: 9 });
  assert.deepEqual([f2.failed, f2.failedNoLast, f2.partial], [2, 1, true]);
});

test('F6 — 스냅샷 오래됨 한도 = max(6h, 로그 주기×2 + 30분) · 엣지 요약(staleMs 없음)은 6시간', () => {
  assert.equal(B.snapStaleMs(10), B.SNAP_STALE_MS);
  assert.equal(B.snapStaleMs(720), 24 * HOUR + 30 * 60_000);
  assert.equal(B.snapStaleMs(1440), 48 * HOUR + 30 * 60_000);
  assert.equal(B.snapStaleMs(null), B.SNAP_STALE_MS);
  const ev = { status: 'ok', source: 'local', byVm: { 'x:1': [NOW, 1] }, accounts: 1, at: NOW };
  // 12시간 주기 · 수집 시작 11시간 뒤 — 정상 수집 사이(예전에는 6시간 고정이라 '—')
  assert.deepEqual(B.snapVerdict({ ...ev, collectedAt: NOW - 11 * HOUR, staleMs: B.snapStaleMs(720) }, NOW), { ok: true, reason: null });
  assert.equal(B.snapCount({ ev: { ...ev, collectedAt: NOW - 11 * HOUR, staleMs: B.snapStaleMs(720) }, vms: [{ id: 'x:1' }], now: NOW }).n, 1);
  assert.deepEqual(B.snapVerdict({ ...ev, collectedAt: NOW - 25 * HOUR, staleMs: B.snapStaleMs(720) }, NOW), { ok: false, reason: 'stale-events' });
  assert.deepEqual(B.snapVerdict({ ...ev, source: 'edge', collectedAt: NOW - 7 * HOUR }, NOW), { ok: false, reason: 'stale-events' }, '엣지는 6시간');
  assert.deepEqual(B.snapVerdict({ ...ev, collectedAt: NOW - 7 * HOUR, staleMs: 1000 }, NOW), { ok: false, reason: 'stale-events' }, '6시간보다 짧게 줄이지 않는다');
});

test('라우트 — F4 등록부 손상 → badges·vm-detail 503 · backup-counts 전부 registry-unreadable · F5 수는 관리자만(캐시 키 포함) · F6 staleMs', { timeout: 120_000 }, async () => {
  const R = await import('../src/veeam/registry.js');
  const VS = await import('../src/veeam/store.js');
  const LS = await import('../src/logs/settings.js');
  const now = Date.now();
  const a = R.saveServer({ name: 'VBR-PL', host: 'vbr-pl.corp.local', username: 'svc', password: 'pw-1', vcenterIds: [VC1] });
  VS.putResult(a.id, { ok: true, ts: now, jobs: [], counts: {}, notes: [], vms: [{ n: 'k1', m: 'vm-1', h: '10.10.1.20', j: [], rp: 1 }, { n: 'k2', m: 'vm-2', h: '10.10.1.20', j: [], rp: 1 }] });
  R.saveServer({ name: 'VBR-KR-1', host: 'vbr-kr1.corp.local', username: 'svc', password: 'pw-2', vcenterIds: [VC2] });
  const c = R.saveServer({ name: 'VBR-KR-2', host: 'vbr-kr2.corp.local', username: 'svc', password: 'pw-3', vcenterIds: [VC2] });
  VS.putResult(c.id, { ok: false, ts: now, error: 'HTTP 401', kind: 'auth' });
  fs.writeFileSync(path.join(DIR, 'vcenter-logs.json'), JSON.stringify({ enabled: true, pollIntervalMin: 720, minSeverity: 'info' }));
  LS._resetLogSettingsForTest();

  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { registerVeeamBadges } = await import('../src/routes/api/veeam.js');
  const prev = store.snapshot;
  let gen = NOW;
  const setSnap = () => { gen += 1; store.snapshot = { source: 'live', generatedAt: gen, vcenters: ALL.map((id) => ({ id, name: id })), vms: ALL.map((id) => ({ id: `${id}:vm-1`, vcenterId: id, name: 'k1' })), hosts: [] }; };
  setSnap();
  const app = express();
  // 전체 범위 viewer — scopeKey 가 관리자와 같은 'all' 이라 역할이 캐시 키에 없으면 관리자 판본을 받는다(F5 캐시 키 검사)
  const viewer = { username: 'v', role: 'viewer' };
  let user = viewer;
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); registerVeeamBadges(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const req = async (p) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}/api${p}`); return { status: r.status, body: await r.json() }; };
  const get = async (p) => (await req(p)).body;
  try {
    // F5 — 관리자는 수 · 같은 세대에 이어 부른 비관리자는 관리자 판본(캐시)을 받지 않는다
    user = { username: 'a', role: 'admin' };
    const ab = await get(`/veeam/badges?vcenterId=${VC1}`);
    assert.deepEqual([ab.otherVcenter, ab.hostMismatch], [2, true]);
    const ac = (await get('/veeam/backup-counts')).byVc;
    assert.deepEqual([ac[VC1].n, ac[VC1].otherVcenter, ac[VC1].hostMismatch], [0, 2, true]);
    user = viewer;
    const vc = (await get('/veeam/backup-counts')).byVc;
    assert.deepEqual([vc[VC1].n, vc[VC1].otherVcenter, vc[VC1].hostMismatch], [0, null, true], '비관리자 — 수 없이 불리언(캐시 판본 섞임 없음)');
    const vb = await get(`/veeam/badges?vcenterId=${VC1}`);
    assert.deepEqual([vb.otherVcenter, vb.hostMismatch], [null, true]);
    // 응답 경로 스윕 — 비관리자 본문 어디에도 otherVcenter 수가 없다
    const vd = await get(`/veeam/vm-detail?vcenterId=${VC1}&vmId=${encodeURIComponent(`${VC1}:vm-1`)}`);
    for (const [name, body] of [['badges', vb], ['backup-counts', vc], ['vm-detail', vd]]) {
      assert.equal(/"otherVcenter":\d/.test(JSON.stringify(body)), false, `${name} 에 otherVcenter 수`);
    }
    // F2·F3 — VC2: 서버 둘 중 하나 첫 수집 전, 하나 한 번도 성공 못함 → 사유는 실패 우선
    assert.deepEqual([vc[VC2].n, vc[VC2].reason, vc[VC2].failed, vc[VC2].waiting], [null, 'veeam-failed', 1, 1]);
    // F6 — 로컬 snap-events 는 로그 주기(720분)를 반영한 한도를 싣고 판정도 그 값으로
    const se = await get(`/veeam/snap-events?vcenterId=${SN}`);
    assert.equal(se.status, 'ok');
    assert.equal(se.staleMs, B.snapStaleMs(720));
    assert.deepEqual(se.verdict, B.snapVerdict(se));

    // F4 — 등록부 손상
    fs.writeFileSync(path.join(DIR, 'veeam-servers.json'), '{"version":1,"servers":[{"id":"x" "name":"broken"}]}');
    R._resetForTest();
    const w = console.warn; console.warn = () => {};
    try {
      assert.ok(R.registryLoadError(), '손상 판정');
      setSnap();
      const b503 = await req(`/veeam/badges?vcenterId=${VC1}`);
      assert.equal(b503.status, 503);
      assert.equal(b503.body.registryUnreadable, true);
      assert.equal(/등록하세요/.test(b503.body.reason), false, "'등록하세요' 가 아니다");
      assert.equal(JSON.stringify(b503.body).includes('broken'), false, '파일 조각(원문)을 싣지 않는다');
      const d503 = await req(`/veeam/vm-detail?vcenterId=${VC1}&vmId=${encodeURIComponent(`${VC1}:vm-1`)}`);
      assert.equal(d503.status, 503);
      const nf = await req(`/veeam/badges?vcenterId=${encodeURIComponent('zz:none')}`);
      assert.equal(nf.status, 404, '범위·존재 판정이 먼저(존재 은닉)');
      const bc = (await get('/veeam/backup-counts')).byVc;
      for (const id of ALL) assert.deepEqual([bc[id].src, bc[id].n, bc[id].reason], ['veeam', null, 'registry-unreadable'], `${id} — 스냅샷 기준으로 조용히 바꾸지 않는다`);
    } finally { console.warn = w; }
  } finally { store.snapshot = prev; }
});
