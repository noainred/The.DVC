/**
 * vmPower3390.test.js — v3.39.0 VM 전원 구간(달력 · 드로어 '전원 상태') 회귀 고정.
 *   ① 순수 판정(vmpower/spans.js): 관측 계획 · 소급 · 타임라인(경계 불확실 · 기록 없음 · 이벤트 보정 · 사실)
 *   ② 실제 DB(임시 vm-track.db)에 관측기를 돌려 소급 → 전환 → 끊김 → 사라짐이 저장되는지
 *   ③ 데모 구간이 스냅샷 전원 상태와 맞는지 · 라우트가 범위 밖을 404 로 막는지(소스 — 주석 제거)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vmpower3390-'));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* */ } });
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = TMP;
process.env.VMTRACK_DB_PATH = path.join(TMP, 'vt.db');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const S = await import('../src/vmpower/spans.js');
const { powerStateOf, planObservation, planBackfill, buildTimeline, WATCH_EVERY_MS: W, GAP_MS } = S;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;   // 실제 시각을 정시로 떨어뜨려 고정

test('전원 상태 — 켜짐 · 꺼짐 · 일시 정지는 꺼짐 · 모르면 null', () => {
  assert.equal(powerStateOf('POWERED_ON'), 'on');
  assert.equal(powerStateOf('poweredOff'.toUpperCase().replace('POWEREDOFF', 'POWERED_OFF')), 'off');
  assert.equal(powerStateOf('SUSPENDED'), 'off');
  assert.equal(powerStateOf(''), null);
  assert.equal(powerStateOf(undefined), null);
});

test('관측 계획 — 바뀌지 않으면 쓰기 없음 · 바뀌면 직전 관측에서 닫고 새 구간 · 사라지면 닫음 · 모르면 그대로', () => {
  const open = new Map([['a', { id: 1, state: 'on', start: NOW - DAY }], ['b', { id: 2, state: 'on', start: NOW - DAY }], ['c', { id: 3, state: 'off', start: NOW - DAY }], ['d', { id: 4, state: 'on', start: NOW - DAY }]]);
  const prev = NOW - W;
  const p = planObservation({ open, watchLast: prev, ts: NOW, vms: [
    { vmId: 'a', state: 'on' }, { vmId: 'b', state: 'off', name: 'b' }, { vmId: 'c', state: null }, { vmId: 'n', state: 'off', name: 'new' },
  ] });
  assert.equal(p.gap, null);
  assert.deepEqual(p.close.find((c) => c.id === 2), { id: 2, end: prev });
  assert.deepEqual(p.insert.find((x) => x.vmId === 'b'), { vmId: 'b', name: 'b', state: 'off', start: NOW, lo: prev });
  assert.ok(!p.close.some((c) => c.id === 1) && !p.close.some((c) => c.id === 3), '같은 상태 · 전원 모름은 닫지 않는다');
  assert.deepEqual(p.close.find((c) => c.id === 4), { id: 4, end: prev, gone: true }, '목록에서 사라진 VM 은 직전 관측에서 닫는다');
  assert.equal(p.insert.find((x) => x.vmId === 'n').lo, prev, '관측 중에 나타난 VM 은 그 사이에 생겼다');
  // 첫 관측(직전 없음) — 기록 시작 전부터 그 상태
  assert.equal(planObservation({ ts: NOW, vms: [{ vmId: 'x', state: 'on' }] }).insert[0].lo, null);
  // 끊김
  const g = planObservation({ open: new Map(), watchLast: NOW - GAP_MS - MIN, ts: NOW, vms: [] });
  assert.deepEqual(g.gap, { from: NOW - GAP_MS - MIN, to: NOW });
  assert.equal(planObservation({ open: new Map(), watchLast: NOW - GAP_MS, ts: NOW, vms: [] }).gap, null, '경계(= GAP_MS)는 끊김이 아니다');
});

test('소급 — 추적 전환으로 구간을 만들고 마지막 슬롯 뒤 바뀐 것은 새 구간 · 추적 중에 생긴 VM 은 앞 끝이 있다', () => {
  const slots = []; for (let t = NOW - 30 * DAY; t <= NOW - 6 * HOUR; t += 12 * HOUR) slots.push(t);
  const firstSeen = new Map([['a', NOW - 30 * DAY], ['b', NOW - 10 * DAY], ['c', NOW - 30 * DAY]]);
  const tOff = slots[20]; const tOn = slots[24];
  const rows = planBackfill({
    ts: NOW, snapTs: slots, firstSeen,
    vms: [{ vmId: 'a', state: 'on' }, { vmId: 'b', state: 'on' }, { vmId: 'c', state: 'on' }, { vmId: 'z', state: 'off' }],
    changes: [{ vmId: 'a', kind: 'powered_off', ts: tOff }, { vmId: 'a', kind: 'powered_on', ts: tOn }, { vmId: 'c', kind: 'powered_off', ts: tOff }],
  });
  const a = rows.filter((r) => r.vmId === 'a');
  assert.deepEqual(a.map((r) => [r.state, r.start, r.lo, r.end, r.src]), [
    ['on', NOW - 30 * DAY, null, slots[19], 'backfill'],
    ['off', tOff, slots[19], slots[23], 'backfill'],
    ['on', tOn, slots[23], null, 'backfill'],
  ]);
  const b = rows.filter((r) => r.vmId === 'b');
  assert.equal(b[0].lo, slots.filter((t) => t < NOW - 10 * DAY).pop(), '추적이 돌던 중 처음 보인 VM — 직전 슬롯이 앞 끝');
  const c = rows.filter((r) => r.vmId === 'c');
  assert.deepEqual(c.map((r) => [r.state, r.end === null, r.src]), [['on', false, 'backfill'], ['off', false, 'backfill'], ['on', true, 'watch']], '마지막 슬롯 뒤 켜짐 — 새 실시간 구간');
  assert.equal(c[2].lo, slots[slots.length - 1]);
  const z = rows.filter((r) => r.vmId === 'z');
  assert.deepEqual(z.map((r) => [r.state, r.start, r.lo, r.src]), [['off', NOW, null, 'watch']], '추적 기록이 없는 VM 은 지금부터');
});

test('타임라인 — 전환 창은 경계 불확실 · 끊김은 기록 없음 · 둘 다 켜짐/꺼짐 합에 넣지 않는다', () => {
  const spans = [
    { state: 'on', start: NOW - 10 * DAY, lo: null, end: NOW - 5 * DAY, src: 'watch' },
    { state: 'off', start: NOW - 5 * DAY + W, lo: NOW - 5 * DAY, end: NOW - 2 * DAY, src: 'watch' },
    { state: 'on', start: NOW - 2 * DAY + W, lo: NOW - 2 * DAY, end: null, src: 'watch' },
  ];
  const gaps = [{ from: NOW - 8 * DAY, to: NOW - 8 * DAY + 5 * HOUR }];
  const t = buildTimeline({ spans, gaps, now: NOW, watchLast: NOW - MIN });
  assert.equal(t.sums.est, 2 * W);
  assert.equal(t.sums.unk, 5 * HOUR);
  assert.equal(t.sums.off, 3 * DAY - W);
  assert.equal(t.sums.on + t.sums.off + t.sums.est + t.sums.unk, 10 * DAY, '기록 시작부터 지금까지 빈틈 없이');
  assert.deepEqual(t.facts.firstOn, { before: NOW - 10 * DAY, src: 'watch' }, '기록 시작 전부터 켜짐 — 날짜를 지어내지 않는다');
  assert.equal(t.facts.current.state, 'on');
  assert.equal(t.facts.current.lo, NOW - 2 * DAY);
  assert.equal(t.facts.lastOff.ts, NOW - 5 * DAY + W);
  assert.equal(t.facts.offCount, 1);
  assert.equal(t.transitions.length, 2);
  assert.equal(t.transitions[0].to, 'on', '최신 먼저');
  assert.equal(t.transitions[0].exact, false);
  // 범위로 자르면 합도 범위 안만
  const r = buildTimeline({ spans, gaps, now: NOW, watchLast: NOW - MIN, from: NOW - DAY, to: NOW });
  assert.equal(r.sums.on, DAY);
  // 관측이 끊긴 채 지금까지 — 진행 중 구간의 꼬리는 기록 없음
  const s = buildTimeline({ spans, now: NOW, watchLast: NOW - 3 * HOUR });
  assert.equal(s.segments[s.segments.length - 1].st, 'unk');
  assert.equal(s.sums.unk, 3 * HOUR);
});

test('타임라인 — 창 안의 같은 방향 전원 이벤트로 정확한 시각 · 수행 계정을 쓴다(창 밖 · 반대 방향은 쓰지 않는다)', () => {
  const spans = [
    { state: 'on', start: NOW - 3 * DAY, lo: null, end: NOW - DAY, src: 'watch' },
    { state: 'off', start: NOW - DAY + W, lo: NOW - DAY, end: null, src: 'watch' },
  ];
  const ev = NOW - DAY + 4 * MIN;
  const t = buildTimeline({ spans, now: NOW, watchLast: NOW - MIN, events: [
    { ts: ev, type: 'VmPoweredOffEvent', user: 'VSPHERE.LOCAL\\ops' },
    { ts: NOW - DAY + 5 * MIN, type: 'VmPoweredOnEvent', user: 'x' },
    { ts: NOW - 2 * DAY, type: 'VmPoweredOffEvent', user: 'y' },
  ] });
  assert.equal(t.sums.est, 0, '이벤트로 좁히면 경계 불확실이 없다');
  assert.deepEqual([t.transitions[0].ts, t.transitions[0].exact, t.transitions[0].src, t.transitions[0].user], [ev, true, 'event', 'VSPHERE.LOCAL\\ops']);
  assert.equal(t.facts.current.exact, true);
});

test('타임라인 — 소급 구간 표시 · 가장 길게 꺼짐(진행 중 포함)', () => {
  const spans = [
    { state: 'off', start: NOW - 40 * DAY, lo: NOW - 41 * DAY, end: NOW - 20 * DAY - 12 * HOUR, src: 'backfill' },
    { state: 'on', start: NOW - 20 * DAY, lo: NOW - 20 * DAY - 12 * HOUR, end: NOW - 3 * DAY, src: 'backfill' },
    { state: 'off', start: NOW - 3 * DAY + W, lo: NOW - 3 * DAY, end: null, src: 'watch' },
  ];
  const t = buildTimeline({ spans, now: NOW, watchLast: NOW });
  assert.deepEqual(t.facts.backfill, { from: NOW - 40 * DAY, to: NOW - 3 * DAY + W });
  assert.equal(t.facts.longestOff.a, NOW - 40 * DAY);
  assert.equal(t.facts.longestOff.maxMs, NOW - 20 * DAY - (NOW - 41 * DAY), '위 끝 = 앞 창 시작 ~ 다음 구간 시작');
  assert.equal(t.facts.firstOn.ts, NOW - 20 * DAY);
  assert.ok(t.segments.some((s) => s.src === 'backfill'));
  assert.equal(t.facts.current.state, 'off');
});

test('구간 길이는 범위 — 한 번만 보인 꺼짐은 0분이 아니라 0분 ~ 두 창 폭', () => {
  const S12 = 12 * HOUR;
  const spans = [
    { state: 'on', start: NOW - 10 * DAY, lo: null, end: NOW - 5 * DAY, src: 'backfill' },
    { state: 'off', start: NOW - 5 * DAY + S12, lo: NOW - 5 * DAY, end: NOW - 5 * DAY + S12, src: 'backfill' },
    { state: 'on', start: NOW - 5 * DAY + 2 * S12, lo: NOW - 5 * DAY + S12, end: null, src: 'backfill' },
  ];
  const t = buildTimeline({ spans, now: NOW, watchLast: NOW });
  assert.deepEqual(t.facts.lastOffDur, { minMs: 0, maxMs: 2 * S12, open: false });
  assert.deepEqual([t.transitions[0].prevMs, t.transitions[0].prevMaxMs], [0, 2 * S12]);
  assert.equal(t.transitions[1].prevMaxMs, null, '기록 시작 전부터 켜짐 — 위 끝을 모른다');
});

test('★ 실제 DB — 첫 관측은 소급 · 다음 관측은 전환만 · 끊김 · 사라짐 · 못 읽은 vCenter 는 건드리지 않음', async () => {
  const vt = await import('../src/vmtrack/db.js');
  const x = await vt.getDb();
  if (!x) { test.skip?.('node:sqlite 없음'); return; }
  // 추적 기록: 슬롯 2개 + vm-1 이 두 번째 슬롯에서 꺼짐으로 보임
  x.db.exec(`INSERT INTO snaps (slot, ts, vcenter_id, total) VALUES ('s1', ${NOW - 3 * DAY}, 'vc1', 2), ('s2', ${NOW - 2 * DAY - 12 * HOUR}, 'vc1', 2)`);
  x.db.exec(`INSERT INTO roster (vcenter_id, vm_id, name, power_state, first_seen) VALUES ('vc1', 'vc1:vm-1', 'a', 'POWERED_OFF', ${NOW - 3 * DAY}), ('vc1', 'vc1:vm-2', 'b', 'POWERED_ON', ${NOW - 3 * DAY})`);
  x.db.exec(`INSERT INTO changes (snap_id, ts, vcenter_id, kind, vm_id, name) VALUES (2, ${NOW - 2 * DAY - 12 * HOUR}, 'vc1', 'powered_off', 'vc1:vm-1', 'a')`);
  const W8 = await import('../src/vmpower/watcher.js');
  const D = await import('../src/vmpower/db.js');
  const snapAt = (t, vms, extra = {}) => ({ generatedAt: new Date(t).toISOString(), vcenters: [{ id: 'vc1', status: 'connected', ...extra.vc1 }, { id: 'vc2', status: 'unreachable' }], vms });
  const t0 = NOW - 2 * DAY;
  let r = await W8.runPowerWatchOnce({ now: t0, snap: snapAt(t0, [
    { id: 'vc1:vm-1', vcenterId: 'vc1', name: 'a', powerState: 'POWERED_OFF' },
    { id: 'vc1:vm-2', vcenterId: 'vc1', name: 'b', powerState: 'POWERED_ON' },
    { id: 'vc2:vm-9', vcenterId: 'vc2', name: 'z', powerState: 'POWERED_ON' },
  ]) });
  assert.equal(r.ok, true);
  assert.ok(r.backfilled >= 2, `소급 구간 ${r.backfilled}`);
  assert.deepEqual(r.held, [['vc2', 'unreachable']]);
  let s1 = await D.spansOfVm('vc1', 'vc1:vm-1');
  assert.deepEqual(s1.map((s) => [s.state, s.src, s.end == null]), [['on', 'backfill', false], ['off', 'backfill', true]]);
  assert.equal(s1[0].end, NOW - 3 * DAY, '꺼짐을 본 슬롯의 직전 슬롯에서 닫힌다');
  assert.deepEqual(await D.spansOfVm('vc2', 'vc2:vm-9'), [], '못 읽은 vCenter 는 기록하지 않는다');
  // 10분 뒤 — vm-1 켜짐 · vm-2 그대로
  const t1 = t0 + W;
  r = await W8.runPowerWatchOnce({ now: t1, snap: snapAt(t1, [
    { id: 'vc1:vm-1', vcenterId: 'vc1', name: 'a', powerState: 'POWERED_ON' },
    { id: 'vc1:vm-2', vcenterId: 'vc1', name: 'b', powerState: 'POWERED_ON' },
  ]) });
  assert.deepEqual([r.opened, r.closed, r.gaps], [1, 1, 0], '바뀐 VM 만 쓴다');
  s1 = await D.spansOfVm('vc1', 'vc1:vm-1');
  assert.deepEqual(s1.slice(-1).map((s) => [s.state, s.start, s.lo, s.src]), [['on', t1, t0, 'watch']]);
  // 목록이 통째로 비면(수집 이상) 열린 구간을 닫지 않는다
  const t2 = t1 + W;
  r = await W8.runPowerWatchOnce({ now: t2, snap: snapAt(t2, []) });
  assert.deepEqual(r.held, [['vc1', 'empty'], ['vc2', 'unreachable']]);
  assert.equal((await D.openSpansOf('vc1')).size, 2);
  // 2시간 뒤(끊김) — vm-2 사라짐
  const t3 = t1 + 2 * HOUR;
  r = await W8.runPowerWatchOnce({ now: t3, snap: snapAt(t3, [{ id: 'vc1:vm-1', vcenterId: 'vc1', name: 'a', powerState: 'POWERED_ON' }]) });
  assert.equal(r.gaps, 1);
  assert.deepEqual(await D.gapsOf('vc1', 0), [{ from: t1, to: t3 }]);
  const s2 = await D.spansOfVm('vc1', 'vc1:vm-2');
  assert.equal(s2[s2.length - 1].end, t1, '사라진 VM 은 마지막으로 본 관측에서 닫는다');
  // 오래된 스냅샷 · 긴급중단은 관측하지 않는다
  r = await W8.runPowerWatchOnce({ now: t3 + W, snap: snapAt(t3 - GAP_MS - MIN, []) });
  assert.equal(r.idle, 'stale-snapshot');
  // 응답 — 실제 DB 를 읽어 같은 판정
  const H = await import('../src/vmpower/history.js');
  const vm1 = { id: 'vc1:vm-1', vcenterId: 'vc1', name: 'a', powerState: 'POWERED_ON' };
  const res = await H.vmPowerHistory(vm1, { vms: [vm1] }, { now: t3 + MIN });
  assert.equal(res.available, true);
  assert.equal(res.facts.current.state, 'on');
  assert.equal(res.facts.current.ts, t1);
  assert.ok(res.segments.some((g) => g.st === 'unk'), '끊긴 2시간은 기록 없음');
  assert.equal(res.facts.backfill.to, t0, '소급의 끝 = 실시간 관측 시작');
  // 정리 — 끝난 구간만
  const pr = await D.prunePower(NOW + DAY);
  assert.ok(pr.spans >= 3);
  assert.equal((await D.openSpansOf('vc1')).size, 1, '진행 중 구간은 지우지 않는다');
});

test('데모 — 마지막 구간이 스냅샷 전원 상태와 같고 구간이 시간순 · 겹침 없음', async () => {
  const { demoPowerHistory } = await import('../src/mock/demo/vmPower.js');
  for (let i = 0; i < 60; i++) {
    const vm = { id: `demo:vm-${i}`, name: `vm${i}`, powerState: i % 3 ? 'POWERED_ON' : 'POWERED_OFF' };
    const d = demoPowerHistory(vm, NOW);
    const last = d.spans[d.spans.length - 1];
    assert.equal(last.end, null);
    assert.equal(last.state, i % 3 ? 'on' : 'off', vm.id);
    for (let k = 1; k < d.spans.length; k++) {
      assert.ok(d.spans[k].start >= d.spans[k - 1].end && d.spans[k - 1].end >= d.spans[k - 1].start, `${vm.id} #${k}`);
      assert.notEqual(d.spans[k].state, d.spans[k - 1].state);
    }
    const t = buildTimeline({ spans: d.spans, gaps: d.gaps, events: d.events, now: NOW, watchLast: d.watch.lastTs });
    assert.equal(t.facts.current.state, last.state);
  }
});

test('라우트 — inv.vms 권한 · 범위 밖은 404(존재 은닉) · 관측기는 상태 화면에 등록', () => {
  const src = stripComments(fs.readFileSync(path.join(SRC, 'routes/api/vmPower.js'), 'utf8'));
  assert.match(src, /requirePerm\('inv\.vms'\)/);
  assert.match(src, /!vm \|\| !inUserScope\(req\.user, snap, vm\.vcenterId\)\) return res\.status\(404\)/);
  const spec = stripComments(fs.readFileSync(path.join(SRC, 'edgelog/spec.js'), 'utf8'));
  assert.match(spec, /mod: '\.\.\/vmpower\/watcher\.js', fn: 'powerWatchStatus'/);
});

test('범위 정규화 — 기본 366일 · 상한 400일 · 미래 끝은 지금', async () => {
  const { normRange, MAX_RANGE_MS } = await import('../src/vmpower/history.js');
  assert.deepEqual(normRange(undefined, undefined, NOW), { from: NOW - 366 * DAY, to: NOW });
  assert.deepEqual(normRange(String(NOW - 900 * DAY), String(NOW + DAY), NOW), { from: NOW - MAX_RANGE_MS, to: NOW });
  assert.deepEqual(normRange('abc', '', NOW), { from: NOW - 366 * DAY, to: NOW });
});
