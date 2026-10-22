/**
 * v2.759 — Veeam 스냅샷 전용 DB(veeam-snap.db · 사용자 요청: 별도 DB 에 저장해 두고 화면은 바로 · 최근 1달 보관).
 *  ① 판정·결과 동등: 전용 DB 에서 센 요약 = 예전 로그 DB 검색 요약(같은 입력) · 준비 뒤에는 로그 DB 를 검색하지 않는다
 *  ② 적재·백필 겹침은 한 번 · 31일 보관(prune) · 백필은 8일을 전 vCenter 먼저, 그다음 31일
 *  ③ 엣지 요약 보존 — 중앙 재시작(메모리 비움) 뒤 복원
 *  ④ 엣지 push: 백필 전 vCenter 는 보내지 않고 백필을 시작한다
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'veeam2759-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const D = await import('../src/veeam/snapDb.js');
const S = await import('../src/veeam/snapEvents.js');
const { getLogsDb } = await import('../src/logs/db.js');
const HOUR = 3_600_000; const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;
const VC = 'kr:vc01'; const VC2 = 'kr:vc02';
const ev = (o) => ({ vcenterId: VC, severity: 'info', type: 'TaskEvent', user: 'CORP\\svc-veeam', ...o });

test('isSnapRow — 로그 DB 검색(4열 · 영문 대소문자 무시 · 한국어)과 같은 판정', () => {
  assert.equal(D.isSnapRow({ message: 'Task: Create virtual machine SNAPSHOT' }), true);
  assert.equal(D.isSnapRow({ message: '가상 시스템 스냅샷 생성' }), true);
  assert.equal(D.isSnapRow({ type: 'VmSnapshotCreatedEvent', message: '' }), true);
  assert.equal(D.isSnapRow({ entity: 'snapshot-host', message: 'x' }), true, '로그 검색이 대상·계정 열도 본다');
  assert.equal(D.isSnapRow({ message: 'Task: Power On virtual machine' }), false);
});

test('① 백필 뒤 전용 DB 요약 = 로그 DB 검색 요약 · 그 뒤로는 로그 DB 를 검색하지 않는다 ② 겹침 한 번', async () => {
  S.saveManualAccounts(['svc-veeam']);
  const logs = await getLogsDb();
  const vms = Array.from({ length: 6 }, (_, i) => ({ id: `${VC}:vm-${i}`, vcenterId: VC, name: `app${i}` }));
  const rows = [];
  for (let d = 0; d < 40; d++) {
    for (let i = 0; i < 6; i++) {
      const t = NOW - d * DAY - i * 60_000;
      rows.push(ev({ key: `c${d}-${i}`, ts: t, entity: `app${i}`, message: 'Task: Create virtual machine snapshot' }));
      rows.push(ev({ key: `p${d}-${i}`, ts: t + 1000, entity: `app${i}`, message: 'Task: Power On virtual machine' })); // 스냅샷이 아닌 행
    }
  }
  await logs.insertManyAsync(rows);
  const before = await S.localSnapSummary(logs, VC, vms, { now: NOW });   // 예전 경로(전용 DB 없이)
  assert.equal(Object.keys(before.byVm).length, 6);
  const db = await D.getSnapDb();
  assert.ok(db, 'node:sqlite 로 열린다');
  assert.equal(S.snapCovered(db, VC, NOW - 7 * DAY), false, '백필 전');
  const r = await D.backfillSnap({ logsDb: logs, vcenterIds: [VC], now: NOW });
  assert.equal(r.done, 31, '하루 창 31개(8 + 23)');
  assert.equal(S.snapCovered(db, VC, NOW - 7 * DAY), true);
  assert.equal(db.coveredFrom(VC), NOW - 31 * DAY);
  // 같은 입력이면 같은 요약 — 그리고 로그 DB 는 부르지 않는다
  let calls = 0;
  const spy = { queryAsync: async (...a) => { calls++; return logs.queryAsync(...a); }, query: (...a) => { calls++; return logs.query(...a); } };
  const viaDb = await S.localSnapSummary(spy, VC, vms, { now: NOW, snapDb: db });
  assert.equal(calls, 0, '준비된 vCenter 는 로그 DB 를 검색하지 않는다');
  assert.deepEqual({ ...viaDb, at: 0 }, { ...before, at: 0 });
  // 적재(폴러)와 백필이 같은 행을 넣어도 한 번
  const n0 = db.rowsFor(VC, 0, 100_000).length;
  assert.equal(n0, 31 * 6 + 1, '0~30일 전 6건씩 + 31일 하한과 같은 시각 1건(하한 포함) — 스냅샷 행만');
  await D.ingestSnapRows(rows.slice(0, 20));
  assert.equal(db.rowsFor(VC, 0, 100_000).length, n0, '같은 행은 다시 넣지 않는다');
  assert.ok(db.rowsFor(VC, 0, 100_000).every((x) => /snapshot/i.test(x.message)), '스냅샷 행만');
});

test('② 31일 보관 — prune 은 31일보다 오래된 행만 지운다', async () => {
  const db = await D.getSnapDb();
  await D.ingestSnapRows([ev({ vcenterId: VC2, ts: NOW - 45 * DAY, entity: 'old', message: 'Create virtual machine snapshot' }), ev({ vcenterId: VC2, ts: NOW - 30 * DAY, entity: 'keep', message: 'Create virtual machine snapshot' })]);
  db.prune(NOW);
  assert.deepEqual(db.rowsFor(VC2, 0, 10).map((x) => x.entity), ['keep']);
  assert.ok(db.rowsFor(VC, 0, 100_000).every((x) => x.ts >= NOW - D.RETENTION_MS));
});

test('② 백필 순서 — 8일을 전 vCenter 먼저, 그다음 31일까지', async () => {
  D._resetSnapDbForTest();
  fs.rmSync(path.join(DIR, 'veeam-snap.db'), { force: true });
  const seen = [];
  const logs = { queryAsync: async (f) => { seen.push([f.vcenterId, Math.round((NOW - f.since) / DAY)]); return []; } };
  await D.backfillSnap({ logsDb: logs, vcenterIds: ['a', 'b'], now: NOW });
  const firstB = seen.findIndex(([v]) => v === 'b');
  assert.ok(seen.slice(0, firstB).every(([, d]) => d <= 8), 'a 의 8일 → b 의 8일 → (그다음) 31일');
  assert.equal(Math.max(...seen.slice(0, seen.findIndex(([, d]) => d > 8)).map(([, d]) => d)), 8);
  const db = await D.getSnapDb();
  assert.equal(db.coveredFrom('a'), NOW - 31 * DAY); assert.equal(db.coveredFrom('b'), NOW - 31 * DAY);
});

test('③ 엣지 요약 보존 — 중앙 재시작(메모리 비움) 뒤 전용 DB 에서 복원', async () => {
  const item = { vcenterId: 'us:gm1', status: 'ok', byVm: { 'us:gm1:vm-1': [NOW, 2] }, accounts: 1, at: NOW };
  S.putEdgeSnap('edge-us', [item]);
  await new Promise((r) => setTimeout(r, 50));   // 저장은 비동기(best effort)
  S._resetForTest();                              // 재시작 흉내 — 메모리만 비운다
  assert.equal(S.edgeSnapFor('us:gm1'), null);
  assert.equal(await S.restoreEdgeSnap(), 1);
  assert.deepEqual(S.edgeSnapFor('us:gm1').byVm, item.byVm);
  assert.equal(S.edgeSnapFor('us:gm1').agent, 'edge-us');
});

test('④ 엣지 push — 백필 전 vCenter 는 보내지 않고(중앙은 직전 요약 유지) 백필을 시작한다', async () => {
  const db = await D.getSnapDb();
  let q = 0;
  const logs = { queryAsync: async () => { q++; return []; }, query: () => [] };
  const snap = { vcenters: [{ id: 'kr:new' }], vms: [{ id: 'kr:new:vm-1', vcenterId: 'kr:new', name: 'n1' }] };
  const out = await S.edgeSnapPayload({ db: logs, snap, notCollected: new Map(), logSettings: null, now: NOW, snapDb: db });
  assert.deepEqual(out, []);
  await D.backfillSnap({ logsDb: logs, vcenterIds: ['kr:new'], now: NOW });
  assert.ok(q > 0, '백필이 로그 DB 를 읽었다');
  const out2 = await S.edgeSnapPayload({ db: logs, snap, notCollected: new Map(), logSettings: null, snapDb: db });
  assert.equal(out2.length, 1, '백필 뒤에는 보낸다'); assert.equal(out2[0].status, 'ok');
});
