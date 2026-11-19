/**
 * newcode138.test.js — 새 코드 점검 138회차(스냅샷 이력 v3.26.0 ~ v3.28.0 · server/src/snaphist · /tools/snapshots*).
 *   N138-1: 7일 변화(ago7)가 **지금 값을 못 읽은** vCenter(보존 창이 지난 unreachable 최소 항목 · 기동 직후 pending · REST 폴백 · 낡은 위임)의
 *           7일 전 VM 을 화면에서 ‘스냅샷을 다 지운 VM(약 N GB 회수)’ 으로 세게 했다 — 라우트가 지금 읽은 vCenter 만 넘긴다(view.readableVcenterIds).
 *   N138-2: 법인 카드 재료(corps[].vcenters[])에 ‘지금 못 읽음’ 이 없어 화면이 그 vCenter 를 ‘0대 · 스냅샷 없음’ 으로 적었다 — unread 사유를 싣는다.
 *           판정은 view.vcReadIssue 하나(record.js 도 같은 함수 — 엣지가 REST 로 받은 위임 vCenter(collectMethod 'rest')도 'no-snap').
 *   N138-3(문서): ‘partial’ 은 사유만 남긴다(행 · 합계 없음) — 머리말이 ‘행은 넣는다’ 고 적었던 것을 정정 · 지금 동작을 고정.
 *   N138-4: 포탈 상태(health pollerCheck)의 ‘스냅샷 이력 기록’ 행이 하루 1번 기록 시각(lastResult)만 보아 기록 30분 뒤부터 다음 기록까지 거짓 ‘주의’ 였다 —
 *           폴러가 틱 시각(lastRun) · 주기(intervalMs) · 실패(warn)를 싣는다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'newcode138-'));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } });
process.env.SNAPHIST_DB_PATH = path.join(TMP, 'snap-history.db');
process.env.CONFIG_DIR = process.env.CONFIG_DIR || TMP;

const { snapshotToolView, vcReadIssue, readableVcenterIds } = await import('../src/snaphist/view.js');
const { dayRecord } = await import('../src/snaphist/record.js');
const { commitDay, snapHistStmts } = await import('../src/snaphist/db.js');
const { unreadVcenterReasons } = await import('../src/metrics/unreadVcenters.js');
const { registerVcTools } = await import('../src/routes/api/vcTools.js');
const { store } = await import('../src/store.js');
const P = await import('../src/snaphist/poller.js');
const { pollerCheck } = await import('../src/health/services.js');

const DAY = 86_400_000;
// 기준 시각: 실제 시각에서 정시 경계로 떨어뜨려 고정(docs/rules/common.md)
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const HY = { snapAgeDays: 7, snapCount: 3, snapSizeGB: 100, exceptions: [], notify: { enabled: false, hour: 9 } };
const vm = (vc, id, o = {}) => ({ id: `${vc}:${id}`, vcenterId: vc, name: id, powerState: 'POWERED_ON', template: false, snapshotCount: 1, snapshotSizeGB: 20,
  snapshotOldestTs: NOW - 30 * DAY, snapshotTree: [{ d: 0, name: `s-${id}`, ts: NOW - 30 * DAY }], ...o });
const VA = { id: 'va', name: 'A', status: 'connected' };

// 지금 못 읽는 모양들(store.js 가 실제로 만드는 항목 — 보존 창이 지난 unreachable 최소 항목 · 골격 pending · 등록부 비활성 · 점검중 캐시 없음 ·
//   REST 폴백(직접) · 엣지 REST(위임 — collectSource 'site' + collectMethod 'rest') · 낡은 위임(lastGood 이월 stale))
const UNREAD = [
  [{ id: 'vb', name: 'B', status: 'unreachable', error: 'x' }, 'unreachable', []],
  [{ id: 'vb', name: 'B', status: 'pending' }, 'pending', []],
  [{ id: 'vb', name: 'B', status: 'disabled' }, 'disabled', []],
  [{ id: 'vb', name: 'B', status: 'maintenance', maintenance: true }, 'maintenance', []],
  [{ id: 'vb', name: 'B', status: 'connected', collectSource: 'rest' }, 'no-snap', [{ id: 'vb:b1', vcenterId: 'vb', name: 'b1' }]],
  [{ id: 'vb', name: 'B', status: 'connected', collectSource: 'site', collectMethod: 'rest' }, 'no-snap', [{ id: 'vb:b1', vcenterId: 'vb', name: 'b1' }]],
  [{ id: 'vb', name: 'B', status: 'connected', collectSource: 'site', stale: true }, 'stale', [vm('vb', 'b1')]],
];

test('N138-2 — vcReadIssue · corps[].vcenters[].unread · readableVcenterIds: 지금 못 읽는 vCenter 를 사유로 가른다', () => {
  for (const [vb, reason, vbVms] of UNREAD) {
    const snap = { vcenters: [VA, vb], vms: [vm('va', 'a1'), ...vbVms], datastores: [] };
    assert.equal(vcReadIssue(vb, 'vb', unreadVcenterReasons(snap)), reason, JSON.stringify(vb));
    const v = snapshotToolView(snap, { hygiene: HY, now: NOW });
    const byId = Object.fromEntries(v.corps.flatMap((c) => c.vcenters).map((x) => [x.id, x]));
    assert.equal(byId.vb.unread, reason, `법인 카드 재료에 사유 — ${reason}`);
    assert.equal(byId.va.unread, null, '읽은 vCenter 는 null');
    assert.deepEqual([...readableVcenterIds(snap, new Set(['va', 'vb']))], ['va']);
  }
  assert.equal(vcReadIssue(undefined, 'gone', new Map()), 'unreachable', '스냅샷에 없는 id 는 못 읽음');
});

test('N138-2 — record 의 사유는 같은 판정(엣지 REST 위임 vCenter 는 partial 이 아니라 no-snap)', () => {
  for (const [vb, reason, vbVms] of UNREAD) {
    const r = dayRecord({ vcenters: [VA, vb], vms: [vm('va', 'a1'), ...vbVms] }, { now: NOW, hygiene: HY });
    const b = r.perVc.find((x) => x.vcenterId === 'vb');
    assert.equal(b.status, reason, JSON.stringify(vb));
    assert.equal(b.rows.length, 0); assert.equal(b.vmIds.size, 0, '닫기 재료가 없다');
    assert.equal(r.perVc.find((x) => x.vcenterId === 'va').status, 'ok');
  }
});

test('N138-1 — 라우트 /tools/snapshots/history: ago7 은 지금 값을 읽은 vCenter 만(못 읽은 vCenter 의 7일 전 VM 을 ‘다 지운 VM’ 으로 넘기지 않는다)', async () => {
  // 7일 전: 두 vCenter 모두 정상 기록(va 1대 · vb 2대)
  const okVcs = [VA, { id: 'vb', name: 'B', status: 'connected' }];
  const r7 = await commitDay(dayRecord({ vcenters: okVcs, vms: [vm('va', 'a1'), vm('vb', 'b1'), vm('vb', 'b2')] }, { now: NOW - 7 * DAY, hygiene: HY }));
  assert.equal(r7.recorded, 2);
  const routes = new Map();
  const api = { get: (p, ...h) => routes.set(p, h.at(-1)), post: () => {}, put: () => {}, patch: () => {}, delete: () => {}, use: () => {} };
  registerVcTools(api);
  const handler = routes.get('/tools/snapshots/history');
  assert.ok(handler, '라우트가 있어야 한다');
  const call = async (snap, gen) => {
    store.snapshot = { generatedAt: `n138-${gen}`, vcenters: snap.vcenters, vms: snap.vms, datastores: [], hosts: [], alarms: [] };
    const res = { statusCode: 200, headers: {}, status(c) { this.statusCode = c; return this; }, set(k, v) { this.headers[k] = v; return this; },
      setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, json(b) { this.body = b; return this; }, end(b) { this.raw = b; return this; } };
    const req = { user: { username: 'n138', role: 'admin' }, query: {}, originalUrl: `/api/tools/snapshots/history?g=${gen}`, headers: {}, get() { return undefined; } };
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    return res.body;
  };
  // 둘 다 읽음 — 예전과 같다(7일 변화 재료에 둘 다)
  const both = await call({ vcenters: okVcs, vms: [vm('va', 'a1'), vm('vb', 'b1')] }, 'both');
  assert.deepEqual([...both.ago7.okVcenters].sort(), ['va', 'vb']);
  assert.equal(both.ago7.rows.length, 3);
  let i = 0;
  for (const [vb, reason, vbVms] of UNREAD) {
    const body = await call({ vcenters: [VA, vb], vms: [vm('va', 'a1'), ...vbVms] }, `u${i += 1}`);
    assert.deepEqual(body.ago7.okVcenters, ['va'], `지금 ${reason} 인 vb 는 7일 변화 재료에서 빠진다`);
    assert.ok(body.ago7.rows.every((x) => x.vcenterId === 'va'), `${reason}: vb 의 7일 전 VM 이 ‘다 지운 VM’ 재료로 내려가지 않는다`);
  }
});

test('N138-3 — partial(개수를 못 읽은 VM 있음)은 사유만 남긴다: 합계 NULL · 행 없음 · 항목을 닫지 않는다', async () => {
  const vcs = [{ id: 'vp', name: 'P', status: 'connected' }];
  const D = NOW - 20 * DAY;
  const r1 = await commitDay(dayRecord({ vcenters: vcs, vms: [vm('vp', 'p1')] }, { now: D, hygiene: HY }));
  assert.equal(r1.recorded, 1);
  // 다음 날: p1 의 개수를 못 읽음 + p2 는 정상 → partial
  const rec = dayRecord({ vcenters: vcs, vms: [vm('vp', 'p1', { snapshotCount: null }), vm('vp', 'p2')] }, { now: D + DAY, hygiene: HY });
  assert.equal(rec.perVc[0].status, 'partial');
  const r2 = await commitDay(rec);
  assert.equal(r2.recorded, 0); assert.equal(r2.missing, 1);
  const st = await snapHistStmts();
  const day2 = new Date(D + DAY);
  const key = `${day2.getFullYear()}-${String(day2.getMonth() + 1).padStart(2, '0')}-${String(day2.getDate()).padStart(2, '0')}`;
  const row = st.vcdaySince.all(key).find((x) => x.vcenter_id === 'vp' && x.day === key);
  assert.equal(row.status, 'partial'); assert.equal(row.vms, null, '합계는 NULL(빠진 날)');
  assert.equal(st.dayRows.all(key).filter((x) => x.vcenter_id === 'vp').length, 0, '행은 넣지 않는다');
  assert.equal(st.itemsOfVm.all('vp', 'vp:p1')[0].gone_at, null, '열린 항목을 닫지 않는다');
});

test('N138-4 — 포탈 상태 행: 하루 1번 기록이어도 틱이 돌면 정상 · 틱이 멈추면 주의(거짓 주의 금지 · 무음 정지 금지)', async () => {
  const d = new Date(NOW); d.setHours(4, 0, 0, 0);
  const T = d.getTime() - 40 * DAY;   // 40일 전 04:00(기록 시각 3시 뒤) — 다른 시험의 날과 겹치지 않게
  store.snapshot = { generatedAt: 'n138-h', vcenters: [{ id: 'vh', name: 'H', status: 'connected' }], vms: [vm('vh', 'h1', { snapshotCount: 0 })] };
  const r = await P.runSnapHistOnce({ now: T });
  assert.equal(r.ok, true); assert.equal(r.recorded, 1);
  const up = 48 * 3_600_000;
  for (const h of [1, 6, 20]) {
    const now = T + h * 3_600_000;
    await P.runSnapHistOnce({ now });   // 그 시각의 틱(오늘은 이미 기록 — 쉬는 틱)
    const row = pollerCheck(P.snapHistPollerStatus(), { now, uptimeMs: up });
    assert.equal(row.status, 'ok', `기록 ${h}시간 뒤에도 틱이 돌면 정상: ${row.detail}`);
  }
  const last = T + 20 * 3_600_000;
  const stopped = pollerCheck(P.snapHistPollerStatus(), { now: last + 31 * 60_000, uptimeMs: up });
  assert.equal(stopped.status, 'warn', '틱이 30분 넘게 멈추면 주의');
  assert.equal(P.snapHistPollerStatus().lastResult.recorded, 1, '마지막 기록 결과(lastResult)는 그대로 — historyStatus 가 쓴다');
});
