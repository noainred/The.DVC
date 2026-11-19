/**
 * snapHist3260.test.js — v3.26.0 스냅샷 화면 · VM 별 스냅샷 이력 DB(설계 docs/design/snapshots).
 *   ① view: 판정은 hygieneFindings 그대로 · 못 읽은 크기/생성일은 null · 법인 = DataCenter · 범위 → 고른 법인 순 · 신호
 *   ② record: 못 읽은 vCenter 는 행 없이 사유만 · 집합을 아는 VM(knownVms)만 닫기 재료
 *   ③ db: 하루 한 번(이미 ok 면 덮지 않음) · 없어진 스냅샷 닫기(snap / vm) · 모르는 VM 은 닫지 않음 · 이름만 열쇠 → 생성 시각 열쇠 승계
 *   ④ history: 부분 합은 추이에 넣지 않는다(빠진 vCenter 가 있는 날 = null) · 기록 시작 전은 빠진 것으로 세지 않는다
 *   ⑤ 상수 대조 · 라우트 범위(정적)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'snaphist3260-'));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* */ } });
process.env.SNAPHIST_DB_PATH = path.join(TMP, 'snap-history.db');

const { snapshotToolView, snapGbOf, bandOf, AGE_EDGES_DAYS, ADVISE_HOURS, DS_HIGH_PCT } = await import('../src/snaphist/view.js');
const { dayRecord, vcDayRecord, itemKeyOf, dayKeyOf } = await import('../src/snaphist/record.js');
const { commitDay, snapHistStmts, matchItems } = await import('../src/snaphist/db.js');
const { aggregateDays, dayKeys, goneList } = await import('../src/snaphist/history.js');
const { pendingVcenters, readableNow } = await import('../src/snaphist/poller.js');
const { SNAP_AGE_EDGES_DAYS } = await import('../src/inventory/vmInsight.js');
const { DEFAULT_POLICY } = await import('../src/tools/diskTrend.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAY = 86_400_000;
// 기준 시각: 실제 시각에서 정시 경계로 떨어뜨려 고정(docs/rules/common.md)
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const HY = { snapAgeDays: 7, snapCount: 3, snapSizeGB: 100, uptimeDays: 365, exceptions: ['keep-me'], notify: { enabled: true, hour: 9 } };

const node = (name, daysAgo, o = {}) => ({ d: 0, name, desc: null, ts: daysAgo == null ? null : NOW - daysAgo * DAY, state: 'poweredOff', quiesced: false, current: false, ...o });
const vm = (vc, id, o = {}) => ({ id: `${vc}:${id}`, vcenterId: vc, name: id, powerState: 'POWERED_ON', template: false, cluster: 'C1', host: 'h1', snapshotCount: 0, snapshotSizeGB: 0, ...o });
const snapOf = (vms, vcs = [{ id: 'va', name: 'VC-A', status: 'connected' }, { id: 'vb', name: 'VC-B', status: 'connected' }]) => ({
  generatedAt: NOW, vcenters: vcs, vms,
  datastores: [{ vcenterId: 'va', name: 'ds1', capacityGB: 100, freeGB: 10 }, { vcenterId: 'va', name: 'ds2', capacityGB: 100, freeGB: 60 }],
});

test('① view — 판정 · 못 읽은 값 · 신호 · 법인', () => {
  const vms = [
    vm('va', 'old', { snapshotCount: 2, snapshotSizeGB: 12, snapshotOldestTs: NOW - 40 * DAY, snapshotTree: [node('first', 40, { state: 'poweredOn' }), node('second', 2, { d: 1, current: true })], dev: { disks: [{ datastore: 'ds1' }, { datastore: 'ds2' }] } }),
    vm('va', 'unknown-size', { snapshotCount: 1, snapshotSizeGB: 0, snapshotOldestTs: NOW - 4 * DAY }),        // 크기 0 + 개수 1 = 못 읽음
    vm('va', 'no-date', { snapshotCount: 1, snapshotSizeGB: 3, snapshotOldestTs: null, snapshotNames: ['x'] }),
    vm('va', 'tmpl', { snapshotCount: 5, snapshotSizeGB: 200, snapshotOldestTs: NOW - 400 * DAY, template: true }),
    vm('vb', 'keep-me-vm', { snapshotCount: 1, snapshotSizeGB: 500, snapshotOldestTs: NOW - 100 * DAY }),
    vm('vb', 'none', { snapshotCount: 0, orphanDeltaGB: 4 }),
  ];
  const v = snapshotToolView(snapOf(vms), { hygiene: HY, now: NOW, dcOf: (id) => (id === 'va' ? 'seoul' : ''), dcNames: new Map([['seoul', '서울']]) });
  assert.equal(v.count, 5);
  assert.equal(v.ghost, 1);
  const by = Object.fromEntries(v.items.map((i) => [i.name, i]));
  assert.equal(by.old.days, 40); assert.equal(by.old.band, 'd30'); assert.equal(by.old.sig.age, true); assert.equal(by.old.sig.mem, true);
  assert.deepEqual(by.old.ds, { name: 'ds1', pct: 90 }); assert.equal(by.old.sig.ds, true);
  assert.equal(by.old.oldestName, 'first'); assert.equal(by.old.depth, 2);
  assert.equal(by['unknown-size'].snapGB, null, '크기 0 + 개수 1 은 못 읽음(null)');
  assert.equal(by['unknown-size'].sig.h72, true); assert.equal(by['unknown-size'].sig.age, false);
  assert.equal(by['no-date'].days, null); assert.equal(by['no-date'].band, 'unk'); assert.equal(by['no-date'].oldestName, 'x');
  assert.equal(by.tmpl.judged, false); assert.equal(by.tmpl.skip, 'template'); assert.equal(by.tmpl.band, 'skip'); assert.equal(by.tmpl.sig.age, false);
  assert.equal(by['keep-me-vm'].skip, 'exception'); assert.equal(by['keep-me-vm'].sig.size, false, '예외 VM 은 판정하지 않는다');
  assert.equal(by.old.corpId, 'dc:seoul'); assert.equal(by.old.corpName, '서울');
  assert.equal(by['keep-me-vm'].corpId, 'vc:vb'); assert.equal(by['keep-me-vm'].corpName, 'VC-B');
  assert.equal(v.totalSizeGB, 12 + 3 + 200 + 500, '못 읽은 크기는 합에 없다');
  assert.equal(v.thresholds.snapAgeDays, 7); assert.equal(v.thresholds.exceptions, 1);
});

test('① view — 범위가 먼저, 고른 법인은 그 뒤(빈 Set = 0건)', () => {
  const vms = [vm('va', 'a', { snapshotCount: 1, snapshotSizeGB: 1, snapshotOldestTs: NOW - DAY }), vm('vb', 'b', { snapshotCount: 1, snapshotSizeGB: 1, snapshotOldestTs: NOW - DAY })];
  const s = snapOf(vms);
  assert.deepEqual(snapshotToolView(s, { allowed: new Set(['va']), hygiene: HY, now: NOW }).items.map((i) => i.name), ['a']);
  assert.deepEqual(snapshotToolView(s, { allowed: new Set(['va']), pick: new Set(['vb']), hygiene: HY, now: NOW }).items, [], '범위 밖을 골라도 0건');
  assert.deepEqual(snapshotToolView(s, { pick: new Set(), hygiene: HY, now: NOW }).items, []);
  assert.equal(snapshotToolView(s, { allowed: new Set(['va']), hygiene: HY, now: NOW }).corps.length, 1);
});

test('① view — 설정을 못 받으면 판정하지 않는다(지어내지 않는다)', () => {
  const v = snapshotToolView(snapOf([vm('va', 'a', { snapshotCount: 9, snapshotSizeGB: 999, snapshotOldestTs: NOW - 99 * DAY })]), { hygiene: null, now: NOW });
  assert.equal(v.items[0].judged, false); assert.equal(v.items[0].skip, 'no-settings'); assert.equal(v.items[0].sig.age, false); assert.equal(v.items[0].sig.h72, false);
});

test('⑤ 상수 대조 — 나이 구간 · 72시간 · 85%', () => {
  assert.deepEqual([...AGE_EDGES_DAYS], [...SNAP_AGE_EDGES_DAYS]);
  assert.equal(ADVISE_HOURS, DEFAULT_POLICY.snapshotMaxHours);
  assert.equal(DS_HIGH_PCT, DEFAULT_POLICY.critPct);
  assert.equal(snapGbOf({ snapshotCount: 0, snapshotSizeGB: 0 }), 0);
  assert.equal(bandOf(5, true, 7), 'new'); assert.equal(bandOf(7, true, 7), 'd7'); assert.equal(bandOf(90, true, 7), 'd90');
});

test('② record — 못 읽은 vCenter 는 행 없이 사유만 · 줄기가 잘리면 집합을 모른다', () => {
  const vcs = [{ id: 'va', name: 'A', status: 'connected' }, { id: 'vb', name: 'B', status: 'unreachable' }, { id: 'vc', name: 'C', status: 'pending' }];
  const vms = [
    vm('va', 'full', { snapshotCount: 1, snapshotSizeGB: 2, snapshotTree: [node('s1', 3)] }),
    vm('va', 'cut', { snapshotCount: 3, snapshotSizeGB: 2, snapshotTree: [node('s1', 3)] }),
    vm('va', 'zero', { snapshotCount: 0 }),
    vm('va', 'nocount', { snapshotCount: null }),
    vm('vb', 'x', { snapshotCount: 1, snapshotSizeGB: 2 }),
  ];
  const r = dayRecord(snapOf(vms, vcs), { now: NOW, hygiene: HY });
  const by = Object.fromEntries(r.perVc.map((x) => [x.vcenterId, x]));
  assert.equal(by.vb.status, 'unreachable'); assert.equal(by.vb.rows.length, 0);
  assert.equal(by.vc.status, 'pending');
  assert.equal(by.va.status, 'partial', '개수를 못 읽은 VM 이 있으면 부분(반증 1)'); assert.equal(by.va.sum.countUnknown, 1); assert.equal(by.va.rows.length, 2);
  assert.ok(by.va.knownVms.has('va:full')); assert.ok(by.va.knownVms.has('va:zero'));
  assert.ok(!by.va.knownVms.has('va:cut'), '줄기가 잘린 VM 은 집합을 모른다');
  assert.ok(!by.va.knownVms.has('va:nocount'));
  assert.ok(by.va.vmIds.has('va:nocount'));
  assert.equal(by.va.sum.vms, 2); assert.equal(by.va.sum.gb, 4);
});

test('③ db — 하루 한 번 · 없어진 스냅샷 닫기 · 모르는 VM 은 닫지 않음 · 이름만 열쇠 승계', async () => {
  const st0 = await snapHistStmts();
  assert.ok(st0, 'node:sqlite 가 있어야 한다');
  const vcs = [{ id: 'va', name: 'A', status: 'connected' }];
  const D1 = NOW - 2 * DAY; const D2 = NOW - DAY; const D3 = NOW;
  // 날 1: 세 VM — a(s1,s2) · b(이름만 n1) · c(s9)
  const day1 = [
    vm('va', 'a', { snapshotCount: 2, snapshotSizeGB: 5, snapshotTree: [node('s1', 10), node('s2', 5, { d: 1 })] }),
    vm('va', 'b', { snapshotCount: 1, snapshotSizeGB: 1, snapshotNames: ['n1'] }),
    vm('va', 'c', { snapshotCount: 1, snapshotSizeGB: 1, snapshotTree: [node('s9', 30)] }),
    vm('va', 'd', { snapshotCount: 1, snapshotSizeGB: 1, snapshotTree: [node('s7', 30)] }),
  ];
  let r = await commitDay(dayRecord(snapOf(day1, vcs), { now: D1, hygiene: HY }));
  assert.equal(r.ok, true); assert.equal(r.recorded, 1);
  r = await commitDay(dayRecord(snapOf([], vcs), { now: D1 + 3_600_000, hygiene: HY }));
  assert.equal(r.recorded, 0, '같은 날 이미 ok 면 다시 쓰지 않는다(빈 인벤토리로 덮어 전부 닫는 사고 방지)');
  // 날 2: a 는 s2 를 지움 · b 는 같은 n1 이 생성 시각과 함께 보임 · c 는 VM 이 사라짐 · d 는 개수만 있고 줄기를 못 읽음
  const day2 = [
    vm('va', 'a', { snapshotCount: 1, snapshotSizeGB: 3, snapshotTree: [node('s1', 10)] }),
    vm('va', 'b', { snapshotCount: 1, snapshotSizeGB: 1, snapshotTree: [node('n1', 20)] }),
    vm('va', 'd', { snapshotCount: 1, snapshotSizeGB: 1 }),
  ];
  r = await commitDay(dayRecord(snapOf(day2, vcs), { now: D2, hygiene: HY }));
  assert.equal(r.ok, true); assert.equal(r.gone, 2, 'a 의 s2(snap) + c 의 s9(vm)');
  const st = await snapHistStmts();
  const items = (id) => st.itemsOfVm.all('va', `va:${id}`);
  assert.equal(items('a').find((i) => i.name === 's2').gone_reason, 'snap');
  assert.equal(items('a').find((i) => i.name === 's1').gone_at, null);
  assert.equal(items('c')[0].gone_reason, 'vm');
  assert.equal(items('b').length, 1, '이름만 열쇠였던 것이 생성 시각과 함께 보이면 새 항목을 만들지 않는다');
  assert.equal(items('b')[0].gone_at, null);
  assert.equal(items('d')[0].gone_at, null, '집합을 모르는 VM(줄기 못 읽음)은 닫지 않는다');
  // 날 3: vCenter 를 못 읽음 — 아무것도 닫지 않고 사유만
  r = await commitDay(dayRecord(snapOf([], [{ id: 'va', name: 'A', status: 'unreachable' }]), { now: D3, hygiene: HY }));
  assert.equal(r.missing, 1); assert.equal(r.gone, 0);
  assert.equal(items('a').find((i) => i.name === 's1').gone_at, null);
  const days = dayKeys(D3, 3);
  const rows = st.vcdaySince.all(days[0]);
  const agg = aggregateDays(days, rows, new Set(['va']), new Map([['va', dayKeyOf(D1)]]));
  assert.equal(agg[0].vms, 4); assert.equal(agg[1].vms, 3);
  assert.equal(agg[2].vms, null, '못 읽은 날은 0 이 아니라 빠진 날'); assert.equal(agg[2].missing, 1);
});

test('④ history — 부분 합은 추이에 넣지 않고, 기록 시작 전은 빠진 것으로 세지 않는다', () => {
  const days = ['2026-01-01', '2026-01-02', '2026-01-03'];
  const rows = [
    { day: '2026-01-01', vcenter_id: 'a', status: 'ok', vms: 2, snaps: 2, gb: 1, gb_unknown: 0, over: 1 },
    { day: '2026-01-02', vcenter_id: 'a', status: 'ok', vms: 3, snaps: 3, gb: 2, gb_unknown: 1, over: 1 },
    { day: '2026-01-02', vcenter_id: 'b', status: 'ok', vms: 1, snaps: 1, gb: 5, gb_unknown: 0, over: 0 },
    { day: '2026-01-03', vcenter_id: 'a', status: 'ok', vms: 3, snaps: 3, gb: 2, gb_unknown: 0, over: 1 },
    { day: '2026-01-03', vcenter_id: 'b', status: 'stale', vms: null },
  ];
  const first = new Map([['a', '2026-01-01'], ['b', '2026-01-02']]);
  const s = aggregateDays(days, rows, new Set(['a', 'b']), first);
  assert.equal(s[0].vms, 2, 'b 는 그날 기록을 시작하지 않았다 — 빠진 것이 아니다');
  assert.equal(s[1].vms, 4); assert.equal(s[1].gb, null, '크기를 못 읽은 VM 이 있는 날의 크기 합은 null'); assert.equal(s[1].gbUnknown, 1);
  assert.equal(s[2].vms, null); assert.equal(s[2].missing, 1);
});

test('poller — 오늘 ok 가 아닌 vCenter 중 지금 읽을 수 있는 것만', () => {
  const snap = { vcenters: [{ id: 'a', status: 'connected' }, { id: 'b', status: 'pending' }, { id: 'c', status: 'connected', stale: true }, { id: 'd', status: 'connected' }] };
  const todo = pendingVcenters(snap, new Set(['d']));
  assert.deepEqual(todo, ['a', 'b', 'c']);
  assert.deepEqual(readableNow(snap, todo), ['a']);
});

test('itemKey — 생성 시각이 없으면 이름만', () => {
  assert.equal(itemKeyOf(null, 'x'), '|x'); assert.equal(itemKeyOf(5, 'x'), '5', '생성 시각을 알면 그것만(이름 변경은 같은 스냅샷 — 반증 4)');
  assert.equal(vcDayRecord({ vcenters: [] }, 'zz', { now: NOW, hygiene: HY, unread: new Map() }).status, 'unreachable');
});

test('⑤ 라우트 — 범위 교집합 · 캐시 열쇠 · VM 단건 404(정적)', () => {
  const src = stripComments(fs.readFileSync(path.join(HERE, '../src/routes/api/vcTools.js'), 'utf8'));
  const body = (a, b) => src.slice(src.indexOf(a), b ? src.indexOf(b, src.indexOf(a) + 1) : undefined);
  const list = body("api.get('/tools/snapshots'", "api.get('/tools/snapshots/history'");
  assert.match(list, /scopedVcenterIds\(req\.user/); assert.match(list, /extraKey: `\$\{scopeKey\(req\.user/); assert.match(list, /vcenterPickKey/);
  const hist = body("api.get('/tools/snapshots/history'", "api.get('/tools/snapshots/history/vm'");
  assert.match(hist, /scopedVcenterIds\(req\.user/); assert.match(hist, /scopeKey\(req\.user/); assert.match(hist, /snapHistGeneration\(\)/);
  const one = body("api.get('/tools/snapshots/history/vm'");
  assert.match(one, /inUserScope\(req\.user, snap, vcenterId\)/); assert.match(one, /status\(404\)/);
});

// ── 반증 회귀(dbg3260 — 재현 스크립트 scratchpad/snaprev 의 장면) ──
test('반증 1 — REST 폴백 날은 ‘0개’ 가 아니라 빠진 날(no-snap)', () => {
  const vcs = [{ id: 'vr', name: 'R', status: 'connected', collectSource: 'rest' }];
  const r = dayRecord(snapOf([vm('vr', 'x', { snapshotCount: undefined, snapshotSizeGB: undefined })], vcs), { now: NOW, hygiene: HY });
  assert.equal(r.perVc[0].status, 'no-snap'); assert.equal(r.perVc[0].rows.length, 0); assert.equal(r.perVc[0].vmIds.size, 0, '닫기 재료도 없다');
});

test('반증 2 · 3 — 기록 시작 = 첫 행(상태 무관) · 점검중 / 비활성은 묶음에서 뺀다', () => {
  const days = ['2026-02-01', '2026-02-02', '2026-02-03'];
  const rows = [
    { day: '2026-02-01', vcenter_id: 'a', status: 'ok', vms: 10, gb: 1, gb_unknown: 0, over: 0 }, { day: '2026-02-01', vcenter_id: 'b', status: 'unreachable' },
    { day: '2026-02-02', vcenter_id: 'a', status: 'ok', vms: 10, gb: 1, gb_unknown: 0, over: 0 }, { day: '2026-02-02', vcenter_id: 'b', status: 'maintenance' },
    { day: '2026-02-03', vcenter_id: 'a', status: 'ok', vms: 10, gb: 1, gb_unknown: 0, over: 0 }, { day: '2026-02-03', vcenter_id: 'b', status: 'partial', vms: 3, gb: 1, gb_unknown: 0, over: 0 },
  ];
  const s = aggregateDays(days, rows, new Set(['a', 'b']), new Map([['a', '2026-02-01'], ['b', '2026-02-01']]));
  assert.equal(s[0].vms, null, 'b 의 첫 행은 못 읽은 날 — 그날부터 빠진 것으로 센다'); assert.equal(s[0].missing, 1);
  assert.equal(s[1].vms, 10, '점검중은 빼고 a 만'); assert.equal(s[1].excluded, 1);
  assert.equal(s[2].vms, null, 'partial(개수 못 읽은 VM 있음)은 부분 합 — 추이에 넣지 않는다');
});

test('반증 4 · 5 · 6 — 항목 짝짓기(이름 변경 · 이름만 ↔ 줄기 · 같은 이름 여럿)', () => {
  // 4: 같은 생성 시각, 이름만 바뀜 → 열쇠가 같아 같은 스냅샷
  assert.equal(itemKeyOf(NOW - DAY, 'a'), itemKeyOf(NOW - DAY, 'b'));
  // 5: 줄기(ts) 로 열린 것이 이름만으로 보이면 그 항목을 본 것으로
  let m = matchItems([{ skey: '100', name: 's1' }], [{ key: '|s1', name: 's1', vmName: 'v' }]);
  assert.deepEqual([...m.matched], ['100']); assert.equal(m.upsert.length, 0);
  // 6: 이름만 'daily' 하나가 열려 있고 줄기에 daily 두 개 → 하나는 짝, 하나는 새 항목
  m = matchItems([{ skey: '|daily', name: 'daily' }], [{ key: '1', name: 'daily', vmName: 'v' }, { key: '2', name: 'daily', vmName: 'v' }]);
  assert.equal(m.matched.size, 1); assert.equal(m.upsert.length, 1);
  // 6: 이름만 받았는데 같은 이름이 여럿이면 그 VM 의 집합을 모른다(닫지 않는다)
  const r = vcDayRecord(snapOf([vm('va', 'dup', { snapshotCount: 2, snapshotSizeGB: 1, snapshotNames: ['daily', 'daily'] })]), 'va', { now: NOW, hygiene: HY, unread: new Map() });
  assert.ok(!r.knownVms.has('va:dup'));
});

test('반증 8 — 백업 도구 임시 스냅샷은 항목으로 만들지 않는다(합에는 든다)', () => {
  const r = vcDayRecord(snapOf([vm('va', 'bk', { snapshotCount: 2, snapshotSizeGB: 4, snapshotTree: [node('VEEAM BACKUP TEMPORARY SNAPSHOT', 0), node('keep', 3)] })]), 'va', { now: NOW, hygiene: HY, unread: new Map() });
  assert.deepEqual(r.items.map((i) => i.name), ['keep']); assert.equal(r.sum.snaps, 2);
});

test('반증 9 — 지난 일수는 판정과 같은 값(snapshotOldestTs)만 — band 와 sig.age 가 갈리지 않는다', () => {
  const v = snapshotToolView(snapOf([vm('va', 'x', { snapshotCount: 1, snapshotSizeGB: 1, snapshotOldestTs: null, snapshotTree: [node('s', 40)] })]), { hygiene: HY, now: NOW });
  assert.equal(v.items[0].days, null); assert.equal(v.items[0].band, 'unk'); assert.equal(v.items[0].sig.age, false);
});

test('반증 7 — 없어진 목록: 범위 밖이 읽기 창을 다 채우면 ‘더 있음’', async () => {
  const vcs = [{ id: 'vz', name: 'Z', status: 'connected' }];
  const five = Array.from({ length: 5 }, (_, i) => vm('vz', `z${i}`, { snapshotCount: 1, snapshotSizeGB: 1, snapshotTree: [node(`s${i}`, 5)] }));
  await commitDay(dayRecord(snapOf(five, vcs), { now: NOW - 5 * DAY, hygiene: HY }));
  const r = await commitDay(dayRecord(snapOf(five.map((v) => ({ ...v, snapshotCount: 0, snapshotTree: undefined })), vcs), { now: NOW - 4 * DAY, hygiene: HY }));
  assert.equal(r.gone, 5);
  const g = await goneList({ vcIds: new Set(['nowhere']), sinceTs: 0, limit: 1 });
  assert.equal(g.items.length, 0); assert.equal(g.more, true, '창(1 × 4)을 범위 밖이 다 채웠다 — 조용히 0건이라 하지 않는다');
  const g2 = await goneList({ vcIds: new Set(['vz']), sinceTs: 0, limit: 10 });
  assert.equal(g2.items.length, 5); assert.equal(g2.more, false);
});
