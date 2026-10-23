/**
 * v2.761 — Veeam 백업 표시 점검 확정분(서버 쪽) 회귀.
 *  B1 비관리자 notes 에 주소·지문 없음 · B7 비관리자 counts=null · B2/B5 결과 나이 → stale(엣지는 그 엣지 주기) · D5 runningStale ·
 *  A5 otherVcenter·hostMismatch · C1 no-collect-yet · C2 엣지 collectedAt · C3 24h 잔존 제외 · C4 공용 계정 겹침 · C6 ambiguous → partial ·
 *  C8 엣지 요약 at = 수신 시각 · C9 잠금은 래치하지 않음 · C5 적재 실패 → 덮음 무효 · D4 snap-events verdict(판정 코어 하나).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'veeam2761b-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
const VC1 = 'pl:vc01';    // 중앙 직접 Veeam — notes 에 주소
const VC2 = 'us:vc02';    // 엣지 결과 3일 전(stale) + 백업 중
const VC3 = 'eu:vc03';    // 엣지 주기 1시간 · 결과 40분 전(stale 아님)
const VC4 = 'kr:vc04';    // Veeam 이 IP 로 적은 vCenter(이름 불일치)
const SN = 'kr:vc05';     // 연동 없음 · 직접 수집(로그 DB)
const SN2 = 'kr:vc06';    // 연동 없음 · 직접 수집(폴러가 돈 뒤 처음 조회)
const ALL = [VC1, VC2, VC3, VC4, SN, SN2];
const VCFILE = path.join(DIR, 'vcenters.json');
const vcJson = (extra = {}) => JSON.stringify({ vcenters: ALL.map((id) => ({ id, name: id, host: `${id.split(':')[1]}.corp.local`, username: 'u', password: 'p', ...extra })) });
fs.writeFileSync(VCFILE, vcJson());
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const B = await import('../src/veeam/backupCounts.js');
const S = await import('../src/veeam/snapEvents.js');
const D = await import('../src/veeam/snapDb.js');
const HOUR = 3_600_000; const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

test('C3 — 24시간 넘게 남은 임시 스냅샷은 수에 넣지 않고 snapStale 로 따로 · 시각 모름은 포함 · 상수는 웹과 같다', async () => {
  const W = await import('../../web/src/views/veeamBadge.js');
  assert.equal(B.VEEAM_SNAP_STALE_MS, W.VEEAM_SNAP_STALE_MS, '웹 배지의 잔존 기준과 같은 값');
  const vms = [{ id: 'x:1', veeamSnaps: 1, veeamSnapTs: NOW - 60 * DAY }, { id: 'x:2', veeamSnaps: 1, veeamSnapTs: NOW - HOUR }, { id: 'x:3', veeamSnaps: 1 }, { id: 'x:4' }];
  const ev = { status: 'ok', source: 'local', byVm: {}, accounts: 1, collectedAt: NOW, at: NOW };
  const r = B.snapCount({ ev, vms, now: NOW });
  assert.deepEqual([r.n, r.snapNow, r.snapStale], [2, 2, 1], '60일 잔존(x:1)은 백업으로 세지 않는다');
});

test('C6 — 동명 VM 이라 정하지 못한 이벤트가 있으면 partial + ambiguous · unmatched 는 partial 아님', () => {
  const ev = { status: 'ok', source: 'local', byVm: { 'x:1': [NOW, 1] }, accounts: 1, collectedAt: NOW, at: NOW };
  const a = B.snapCount({ ev: { ...ev, ambiguous: 2 }, vms: [{ id: 'x:1' }, { id: 'x:2' }], now: NOW });
  assert.deepEqual([a.n, a.ambiguous, a.partial], [1, 2, true]);
  assert.equal(B.snapCount({ ev: { ...ev, unmatched: 5 }, vms: [{ id: 'x:1' }], now: NOW }).partial, false);
});

test('C1·C2·D4 — snapVerdict 하나: no-collect-yet · 엣지도 6시간 판정 · 옛 엣지(필드 없음)는 막지 않는다', () => {
  assert.equal(typeof B.snapVerdict, 'function');
  const ev = { status: 'ok', source: 'local', byVm: { 'x:1': [NOW, 1] }, accounts: 1, at: NOW };
  // C1: 이 프로세스에서 로그 폴러가 돈 뒤에도 수집 기록이 없다 → 모름
  const c1 = B.snapCount({ ev: { ...ev, collectedAt: null, collectRan: true }, vms: [{ id: 'x:1' }], now: NOW });
  assert.deepEqual([c1.n, c1.reason], [null, 'no-collect-yet']);
  assert.equal(B.snapCount({ ev: { ...ev, collectedAt: null }, vms: [{ id: 'x:1' }], now: NOW }).n, 1, '기동 직후(폴러 전)는 막지 않는다');
  // C2: 엣지 요약도 마지막 온전한 수집이 6시간보다 오래되면 모름
  const c2 = B.snapCount({ ev: { ...ev, source: 'edge', collectedAt: NOW - 7 * HOUR }, vms: [{ id: 'x:1' }], now: NOW });
  assert.deepEqual([c2.n, c2.reason], [null, 'stale-events']);
  assert.equal(B.snapCount({ ev: { ...ev, source: 'edge' }, vms: [{ id: 'x:1' }], now: NOW }).n, 1, '옛 엣지(collectedAt 없음)는 그대로 센다');
  // D4: 판정 결과가 snapCount 와 같다
  assert.deepEqual(B.snapVerdict({ ...ev, collectedAt: NOW - 7 * HOUR }, NOW), { ok: false, reason: 'stale-events' });
  assert.deepEqual(B.snapVerdict({ ...ev, accounts: 0, byVm: {} }, NOW), { ok: false, reason: 'no-account' });
  assert.deepEqual(B.snapVerdict({ status: 'stale-edge' }, NOW), { ok: false, reason: 'stale-edge' });
  assert.deepEqual(B.snapVerdict({ ...ev, collectedAt: NOW }, NOW), { ok: true, reason: null });
});

test('A5 — 대조 0대인데 다른 vCenter 로 적힌 VM 이 있으면 hostMismatch(n 은 그대로) · B2 stale 서버는 partial', () => {
  const m = B.veeamCount({ views: [{ ok: true, lastOkTs: NOW }], byVm: {}, vmTotal: 10, otherVcenter: 7 });
  assert.deepEqual([m.n, m.otherVcenter, m.hostMismatch, m.partial], [0, 7, true, false]);
  assert.equal(B.veeamCount({ views: [{ ok: true, lastOkTs: NOW }], byVm: { a: {} }, vmTotal: 10, otherVcenter: 7 }).hostMismatch, undefined);
  const st = B.veeamCount({ views: [{ ok: true, lastOkTs: NOW - 3 * DAY, stale: true }], byVm: { a: {} }, vmTotal: 10 });
  assert.deepEqual([st.n, st.stale, st.partial], [1, 1, true], '숫자는 숨기지 않고 부분 표지');
});

test('C4 — 학습: 공용 계정과 겹친 다른 계정을 유일 후보로 삼지 않는다 · 공용 계정 혼자면 후보 없음', () => {
  const vms = [{ name: 'web77', veeamSnaps: 1, veeamSnapTs: NOW }, { name: 'web78', veeamSnaps: 1, veeamSnapTs: NOW }, { name: 'web79', veeamSnaps: 1, veeamSnapTs: NOW }];
  const row = (entity, user) => ({ entity, user, ts: NOW - 30_000, type: 'TaskEvent', severity: 'info', message: 'Task: Create virtual machine snapshot' });
  const out = S.learnAccounts(vms, [row('web77', 'administrator@vsphere.local'), row('web77', 'CORP\\svc-patch'), row('web78', 'Administrator'), row('web79', 'CORP\\svc-bk')]);
  assert.deepEqual(out, [{ account: 'CORP\\svc-bk', vm: 'web79' }], 'web77(겹침)·web78(공용 혼자)은 후보가 아니다');
});

test('C2·C8 — 엣지 요약 정제: collectedAt 은 수만(미래는 수신 시각) · collectRan · at 은 수신 시각, 엣지 시각은 edgeAt', async () => {
  const now = NOW;
  const base = { vcenterId: 'eu:vcx', status: 'ok', byVm: { 'eu:vcx:vm-1': [now - HOUR, 1] }, at: now - 40 * 60_000 };
  const { items } = S.sanitizeEdgeSnap([
    { ...base, collectedAt: now - 2 * HOUR, collectRan: true },
    { ...base, vcenterId: 'eu:vcy', byVm: {}, collectedAt: now + DAY },
    { ...base, vcenterId: 'eu:vcz', byVm: {}, collectedAt: String(now) },
  ], () => true, now);
  assert.equal(items[0].at, now, 'C8: 엣지 시계가 40분 늦어도 받은 시각');
  assert.equal(items[0].edgeAt, now - 40 * 60_000);
  assert.deepEqual([items[0].collectedAt, items[0].collectRan], [now - 2 * HOUR, true]);
  assert.equal(items[1].collectedAt, now, '미래는 수신 시각으로');
  assert.equal(items[2].collectedAt, null, '문자열은 받지 않는다(모름)');
  assert.equal(items[2].collectRan, undefined);
  // 엣지 payload 가 수집 시각을 싣는다
  const { getLogsDb } = await import('../src/logs/db.js');
  const snap = { vcenters: [{ id: 'eu:vcp' }], vms: [{ id: 'eu:vcp:vm-1', vcenterId: 'eu:vcp', name: 'p1' }] };
  const out = await S.edgeSnapPayload({ db: await getLogsDb(), snap, notCollected: new Map(), logSettings: { enabled: true, minSeverity: 'info' }, now,
    collectedAtFor: () => now - HOUR, collectRan: true });
  assert.deepEqual([out[0].collectedAt, out[0].collectRan], [now - HOUR, true]);
});

test('C9·C5 — 전용 DB 잠금은 래치하지 않고 다시 연다 · 그동안 버린 행의 vCenter 덮음은 무효', { timeout: 120_000 }, async () => {
  const { config } = await import('../src/config.js');
  const { getLogsDb } = await import('../src/logs/db.js');
  const { DatabaseSync } = await import('node:sqlite');
  const VC = 'kr:vc99';
  S.saveManualAccounts(['svc-bkp']);
  const base = { vcenterId: VC, severity: 'info', type: 'TaskEvent', user: 'CORP\\svc-bkp', message: 'Task: Create virtual machine snapshot' };
  const logs = await getLogsDb();
  await logs.insertManyAsync([{ ...base, key: 'x1', ts: NOW - 3 * DAY, entity: 'app1' }]);
  let db = await D.getSnapDb();
  await D.backfillSnap({ logsDb: logs, vcenterIds: [VC], now: NOW });
  assert.equal(S.snapCovered(db, VC, NOW - 7 * DAY), true);
  D._resetSnapDbForTest();
  const locker = new DatabaseSync(config.veeamSnap.dbPath);
  locker.exec('PRAGMA journal_mode=DELETE');
  locker.exec('BEGIN EXCLUSIVE');
  const warn = console.warn; console.warn = () => {};
  try { db = await D.getSnapDb(); } finally { console.warn = warn; }
  assert.equal(db, null, '잠겨 있는 동안은 null');
  // 잠금 중 폴러가 새 백업 이벤트를 적재 — 전용 DB 에는 못 넣는다 → 그 vCenter 덮음 무효
  const row = { ...base, key: 'x2', ts: NOW - HOUR, entity: 'app2' };
  await logs.insertManyAsync([row]);
  assert.equal(await D.ingestSnapRows([row]), 0);
  locker.exec('ROLLBACK'); locker.close();
  D._expireSnapLockForTest?.();   // 30초 대기를 건너뛴다
  db = await D.getSnapDb();
  assert.ok(db, 'C9: 잠금이 풀리면 같은 프로세스에서 다시 연다(래치 금지)');
  assert.equal(S.snapCovered(db, VC, NOW - 7 * DAY), false, 'C5: 빠진 행이 있는 덮음은 믿지 않는다');
  // 무효 뒤 시작한 백필이 다시 메우면 덮음이 돌아오고 빠졌던 VM 도 보인다
  await D.backfillSnap({ logsDb: logs, vcenterIds: [VC] });
  assert.equal(S.snapCovered(db, VC, NOW - 7 * DAY), true);
  const vms = [{ id: `${VC}:vm-1`, vcenterId: VC, name: 'app1' }, { id: `${VC}:vm-2`, vcenterId: VC, name: 'app2' }];
  const r = await S.localSnapSummary(logs, VC, vms, { now: NOW, snapDb: db });
  assert.equal(Object.keys(r.byVm).length, 2);
});

test('C5 — 열린 DB 에 적재가 던지면 그 vCenter 의 덮음 기록(meta)을 지운다', async () => {
  const { getLogsDb } = await import('../src/logs/db.js');
  const logs = await getLogsDb();
  const VC = 'kr:vc98';
  const db = await D.getSnapDb();
  await D.backfillSnap({ logsDb: logs, vcenterIds: [VC], now: NOW });
  assert.equal(S.snapCovered(db, VC, NOW - 7 * DAY), true);
  const orig = db.ingest; db.ingest = () => { throw new Error('SQLITE_FULL: database or disk is full'); };
  const warn = console.warn; console.warn = () => {};
  try { assert.equal(await D.ingestSnapRows([{ vcenterId: VC, ts: NOW, type: 'TaskEvent', message: 'Task: Create virtual machine snapshot' }]), 0); }
  finally { db.ingest = orig; console.warn = warn; }
  assert.equal(S.snapCovered(db, VC, NOW - 7 * DAY), false);
});

test('라우트 — B1·B7 가림 · B2·B5 stale · D5 runningStale · A5 hostMismatch · C1 no-collect-yet · D4 verdict', { timeout: 120_000 }, async () => {
  const R = await import('../src/veeam/registry.js');
  const VS = await import('../src/veeam/store.js');
  const E = await import('../src/central/veeamEdge.js');
  const now = Date.now();
  const leakNote = '작업 상태을(를) 읽지 못했습니다: vbr-pl.corp.local:9419 응답이 없습니다(연결 시간 초과) (ETIMEDOUT)';
  const tlsNote = '백업 객체을(를) 읽지 못했습니다: 인증서를 신뢰하지 않습니다 — 대상 10.20.30.40 지문 AB:CD:EF';
  const a = R.saveServer({ name: 'VBR-PL', host: 'vbr-pl.corp.local', username: 'svc', password: 'pw-1', vcenterIds: [VC1] });
  VS.putResult(a.id, { ok: true, ts: now, jobs: [], counts: { jobs: 5, backupObjects: 900 }, notes: [leakNote, tlsNote, '에이전트 백업 3대는 vCenter 정보가 없어'], vms: [{ n: 'web01', m: 'vm-1', h: 'vc01.corp.local', j: [], rp: 3 }] });
  const b = R.saveServer({ name: 'VBR-US', host: 'vbr-us.corp.local', username: 'svc', password: 'pw-2', vcenterIds: [VC2] });
  VS.putResult(b.id, { ok: true, ts: now - 3 * DAY, jobs: [], counts: {}, notes: [], vms: [{ n: 'db01', m: 'vm-1', h: 'vc02.corp.local', j: [], rp: 1, run: 1 }] }, { via: 'edge', agent: 'edge-us' });
  const c = R.saveServer({ name: 'VBR-EU', host: 'vbr-eu.corp.local', username: 'svc', password: 'pw-3', vcenterIds: [VC3] });
  VS.putResult(c.id, { ok: true, ts: now - 40 * 60_000, jobs: [], counts: {}, notes: [], vms: [{ n: 'eu01', m: 'vm-1', h: 'vc03.corp.local', j: [], rp: 1, run: 1 }] }, { via: 'edge', agent: 'edge-slow' });
  E.saveVeeamEdgeStatus('edge-slow', { servers: 1, poller: { intervalMs: HOUR } });
  const d = R.saveServer({ name: 'VBR-KR', host: 'vbr-kr.corp.local', username: 'svc', password: 'pw-4', vcenterIds: [VC4] });
  VS.putResult(d.id, { ok: true, ts: now, jobs: [], counts: {}, notes: [], vms: [{ n: 'k1', m: 'vm-1', h: '10.10.1.20', j: [], rp: 1 }, { n: 'k2', m: 'vm-2', h: '10.10.1.20', j: [], rp: 1 }] });

  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { registerVeeamBadges } = await import('../src/routes/api/veeam.js');
  const prev = store.snapshot;
  store.snapshot = { source: 'live', generatedAt: NOW, vcenters: ALL.map((id) => ({ id, name: id })),
    vms: ALL.map((id) => ({ id: `${id}:vm-1`, vcenterId: id, name: { [VC1]: 'web01', [VC2]: 'db01', [VC3]: 'eu01', [VC4]: 'k1' }[id] || 'app1' })), hosts: [] };
  const app = express();
  let user = { username: 'v', role: 'viewer', scope: { vcenters: ALL } };
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); registerVeeamBadges(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const get = async (p) => (await fetch(`http://127.0.0.1:${srv.address().port}/api${p}`)).json();
  try {
    // B1·B7 — viewer
    const v1 = await get(`/veeam/badges?vcenterId=${VC1}`);
    const raw = JSON.stringify(v1);
    for (const leak of ['vbr-pl.corp.local', '9419', '10.20.30.40', 'AB:CD:EF']) assert.equal(raw.includes(leak), false, `viewer badges 에 ${leak}`);
    assert.equal(v1.servers[0].notes.length, 3, '비고 개수는 그대로(문구만 일반화)');
    assert.ok(v1.servers[0].notes[0].startsWith('작업 상태을(를) 읽지 못했습니다'));
    assert.equal(v1.servers[0].counts, null, 'B7: 서버 전체 집계는 관리자만');
    const vd = JSON.stringify(await get(`/veeam/vm-detail?vcenterId=${VC1}&vmId=${encodeURIComponent(`${VC1}:vm-1`)}`));
    assert.equal(vd.includes('vbr-pl.corp.local'), false, 'vm-detail 에도 주소 없음');
    // admin 은 원문
    user = { username: 'a', role: 'admin' };
    const a1 = await get(`/veeam/badges?vcenterId=${VC1}`);
    assert.equal(a1.servers[0].notes[0], leakNote);
    assert.equal(a1.servers[0].counts.jobs, 5);
    user = { username: 'v', role: 'viewer', scope: { vcenters: ALL } };
    // B2·D5 — 3일 전 엣지 결과
    const v2 = await get(`/veeam/badges?vcenterId=${VC2}`);
    assert.equal(v2.servers[0].stale, true);
    assert.equal(v2.runningStale, true, 'D5: 백업 중을 지웠다는 사실을 싣는다');
    assert.equal(v2.byVm[`${VC2}:vm-1`].run, 0);
    // B5 — 엣지 주기 1시간 · 40분 전 결과는 낡지 않았다(중앙 주기 10분으로 보면 낡음)
    const v3 = await get(`/veeam/badges?vcenterId=${VC3}`);
    assert.equal(v3.servers[0].stale, false);
    assert.equal(v3.runningStale, false);
    assert.equal(v3.byVm[`${VC3}:vm-1`].run, 1, '그 엣지 주기 안이면 백업 중을 지우지 않는다');
    assert.equal(v1.servers[0].stale, false);
    // A5 — 배지 응답에 otherVcenter
    const v4 = await get(`/veeam/badges?vcenterId=${VC4}`);
    assert.deepEqual([v4.otherVcenter, v4.hostMismatch], [null, true], 'v2.762(F5): 수는 관리자만 — 비관리자는 불리언');
    // 카드
    const bc = (await get('/veeam/backup-counts')).byVc;
    assert.deepEqual([bc[VC2].n, bc[VC2].stale, bc[VC2].partial], [1, 1, true], 'B2: 수는 그대로 · 부분');
    assert.deepEqual([bc[VC3].stale, bc[VC3].partial], [0, false]);
    assert.deepEqual([bc[VC4].n, bc[VC4].otherVcenter, bc[VC4].hostMismatch], [0, null, true], 'A5 · v2.762(F5) 수는 관리자만');
    // D4 — snap-events 에 verdict(카드와 같은 판정)
    const se = await get(`/veeam/snap-events?vcenterId=${SN}`);
    assert.equal(se.status, 'ok');
    assert.deepEqual(se.verdict, B.snapVerdict(se), '응답에 실린 판정 = 같은 함수');
    // C1 — 로그 폴러가 한 주기를 끝낸 뒤에도 그 vCenter 기록이 없으면 '아직 못 모음'(대상 0곳으로 한 주기 돌린다)
    const P = await import('../src/logs/poller.js');
    assert.equal(P.logPollerRanOnce?.() ?? false, false, '기동 직후');
    fs.writeFileSync(VCFILE, vcJson({ enabled: false }));
    try { await P.pollLogsOnce(); } finally { fs.writeFileSync(VCFILE, vcJson()); }
    assert.equal(P.logPollerRanOnce?.(), true);
    const se2 = await get(`/veeam/snap-events?vcenterId=${SN2}`);
    assert.equal(se2.status, 'ok');
    assert.equal(se2.collectedAt, null);
    assert.deepEqual(se2.verdict, { ok: false, reason: 'no-collect-yet' });
    store.snapshot = { ...store.snapshot, generatedAt: NOW + 1 };
    const bc2 = (await get('/veeam/backup-counts')).byVc;
    assert.deepEqual([bc2[SN2].n, bc2[SN2].reason], [null, 'no-collect-yet']);
  } finally { store.snapshot = prev; }
});
