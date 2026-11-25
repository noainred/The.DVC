/**
 * vmPower3420.test.js — v3.42.0 VM 전원 이력 재검토(독립 반증 14건) 회귀 고정. 번호는 재검토 보고의 번호.
 *   #1 전환을 범위 밖 최신 500건으로 자름 · #2 한 번 빠짐을 새 구간으로 · #3 제곱 비용 · #4 끊김 중 '지금' · #5 소급 공백을 켜짐으로 ·
 *   #6 수행 계정 가림 · #7 시계 역행 · #8 엣지 위임 안내 · #10 정리 뒤 '처음' · #11 나타남 ≠ Power On · #12 중복 id · #14 사라진 vCenter 정리(3390 에서).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vmpower3420-'));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* */ } });
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = TMP;
process.env.VMTRACK_DB_PATH = path.join(TMP, 'vt.db');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '../../web/src');
const S = await import('../src/vmpower/spans.js');
const { planObservation, planBackfill, backfillGaps, buildTimeline, WATCH_EVERY_MS: W, GAP_MS, TRACK_GRAN_MS, ABSENT_MERGE_MS } = S;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

test('#2 같은 상태로 한 번(≤ GAP) 빠졌다 돌아온 VM 은 한 구간 — 지금 상태 시작 · 꺼짐 횟수를 지어내지 않는다', () => {
  // A: 10일째 켜짐인데 2일 전 관측 한 번 빠짐
  const A = [
    { state: 'on', start: NOW - 10 * DAY, lo: null, end: NOW - 2 * DAY, src: 'watch' },
    { state: 'on', start: NOW - 2 * DAY + 2 * W, lo: NOW - 2 * DAY, end: null, src: 'appear' },
  ];
  const a = buildTimeline({ spans: A, now: NOW, watchLast: NOW });
  assert.deepEqual(a.facts.current.before, NOW - 10 * DAY, '켜짐 · 10일 이상');
  assert.equal(a.transitions.length, 0);
  assert.equal(a.sums.unk, 2 * W, '빠진 20분은 기록 없음');
  // B: 5일 전 꺼짐 · 2일 전 한 번 빠짐
  const B = [
    { state: 'on', start: NOW - 10 * DAY, lo: null, end: NOW - 5 * DAY, src: 'watch' },
    { state: 'off', start: NOW - 5 * DAY + W, lo: NOW - 5 * DAY, end: NOW - 2 * DAY, src: 'watch' },
    { state: 'off', start: NOW - 2 * DAY + 2 * W, lo: NOW - 2 * DAY, end: null, src: 'appear' },
  ];
  const b = buildTimeline({ spans: B, now: NOW, watchLast: NOW });
  assert.equal(b.facts.offCount, 1);
  assert.equal(b.facts.current.ts, NOW - 5 * DAY + W, '꺼진 지 5일');
  assert.equal(b.sums.unk, 2 * W, '빠진 시간은 꺼짐이 아니라 기록 없음(2회차 N2)');
  // 2회차 N1 — 관측 3번 빠짐(31.5분)도 한 구간 · 꺼짐 1번 · 마지막 Power Off 는 5일 전
  const C = [B[0], B[1], { ...B[2], start: NOW - 2 * DAY + 31.5 * MIN }];
  const c = buildTimeline({ spans: C, now: NOW, watchLast: NOW, from: NOW - 30 * DAY, to: NOW });
  assert.equal(c.facts.offCount, 1);
  assert.equal(c.facts.lastOff.ts, NOW - 5 * DAY + W);
  assert.equal(c.facts.longestOffInRange.a, NOW - 5 * DAY + W);
  // 아주 오래(> ABSENT_MERGE_MS) 빠졌다 돌아오면 '목록에 나타남' — 꺼짐 횟수에 넣지 않고 길이는 하한
  const E = [B[0], B[1], { ...B[2], start: NOW - 2 * DAY + ABSENT_MERGE_MS + HOUR }];
  const e = buildTimeline({ spans: E, now: NOW, watchLast: NOW });
  assert.equal(e.facts.offCount, 1, 'appear 구간은 Power Off 가 아니다');
  assert.equal(e.facts.current.appeared, true);
  assert.equal(e.facts.lastOffDur.maxMs, null, '시작을 모르는 구간은 위 끝 없음');
  // 꺼진 채 새로 만든 VM 은 꺼짐 0번
  const n = buildTimeline({ spans: [{ state: 'off', start: NOW - DAY, lo: NOW - DAY - W, end: null, src: 'appear' }], now: NOW, watchLast: NOW });
  assert.equal(n.facts.offCount, 0);
  assert.equal(n.facts.lastOff.appeared, true);
});

test('#3 판정 코어는 선형 — 구간 2만 · 끊김 5천 · 이벤트 5천을 1초 안에', () => {
  const spans = [];
  let t = NOW - 1000 * DAY;
  for (let i = 0; i < 20_000; i++) { const st = i % 2 ? 'off' : 'on'; spans.push({ state: st, start: t, lo: i ? t - W : null, end: i === 19_999 ? null : t + 40 * MIN, src: 'watch' }); t += 40 * MIN + W; }
  const gaps = []; for (let i = 0; i < 5000; i++) gaps.push({ from: NOW - 1000 * DAY + i * 4 * HOUR, to: NOW - 1000 * DAY + i * 4 * HOUR + 35 * MIN });
  const events = []; for (let i = 0; i < 5000; i++) events.push({ ts: NOW - 1000 * DAY + i * 3 * HOUR + 5 * MIN, type: i % 2 ? 'VmPoweredOffEvent' : 'VmPoweredOnEvent', user: 'u' });
  const t0 = performance.now();
  const r = buildTimeline({ spans, gaps, events, now: NOW, watchLast: NOW, from: NOW - 400 * DAY, to: NOW });
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `${ms.toFixed(0)}ms`);
  assert.ok(r.segments.length > 0 && r.transitions.length > 0);
  // 조각은 시간순 · 겹침 없음(선형 칠하기가 순서를 깨지 않는다)
  for (let i = 1; i < r.segments.length; i++) assert.ok(r.segments[i].a >= r.segments[i - 1].b, `조각 ${i}`);
});

test('선형 칠하기 — 여러 끊김이 한 조각 · 여러 조각을 가로질러도 예전 판정과 같다', () => {
  const spans = [
    { state: 'on', start: 0, lo: null, end: 100, src: 'watch' },
    { state: 'off', start: 110, lo: 100, end: 300, src: 'watch' },
    { state: 'on', start: 310, lo: 300, end: null, src: 'watch' },
  ];
  const gaps = [{ from: 20, to: 30 }, { from: 25, to: 40 }, { from: 90, to: 120 }, { from: 200, to: 205 }, { from: 390, to: 500 }];
  const r = buildTimeline({ spans, gaps, now: 400, watchLast: 400, gapMs: 1000 });
  assert.deepEqual(r.segments.map((s) => [s.a, s.b, s.st]), [
    [0, 20, 'on'], [20, 40, 'unk'], [40, 90, 'on'], [90, 120, 'unk'], [120, 200, 'off'], [200, 205, 'unk'], [205, 300, 'off'], [300, 310, 'est'], [310, 390, 'on'], [390, 400, 'unk'],
  ]);
});

test('#4 관측이 끊긴 채면 지금 상태는 \'마지막으로 본 상태\'', () => {
  const r = buildTimeline({ spans: [{ state: 'on', start: NOW - 20 * DAY, lo: NOW - 20 * DAY - W, end: null, src: 'watch' }], now: NOW, watchLast: NOW - 3 * DAY });
  assert.equal(r.facts.current.stale, true);
  assert.equal(r.facts.current.seenTs, NOW - 3 * DAY);
  const ok = buildTimeline({ spans: [{ state: 'on', start: NOW - 20 * DAY, lo: null, end: null, src: 'watch' }], now: NOW, watchLast: NOW - W });
  assert.equal(ok.facts.current.stale, false);
});

test('#5 소급 — 추적 슬롯이 빈 기간과 마지막 슬롯 ~ 지금은 기록 없음', () => {
  const slots = []; for (let t = NOW - 90 * DAY; t <= NOW - 60 * DAY; t += TRACK_GRAN_MS) slots.push(t);
  slots.push(NOW - 30 * DAY);   // 30일 빈 뒤 한 슬롯
  const g = backfillGaps({ snapTs: slots, ts: NOW });
  assert.deepEqual(g, [{ from: slots[slots.length - 2], to: NOW - 30 * DAY }, { from: NOW - 30 * DAY, to: NOW }]);
  const rows = planBackfill({ vms: [{ vmId: 'a', state: 'on' }], firstSeen: new Map([['a', NOW - 90 * DAY]]), changes: [], snapTs: slots, ts: NOW });
  const t = buildTimeline({ spans: rows, gaps: g, now: NOW, watchLast: NOW });
  assert.ok(t.sums.unk >= 59 * DAY, `기록 없음 ${t.sums.unk / DAY}일`);
  assert.equal(backfillGaps({ snapTs: [NOW - 2 * TRACK_GRAN_MS, NOW - TRACK_GRAN_MS], ts: NOW }).length, 0, '슬롯 간격이 정상이면 끊김 없음');
});

test('#7 시계가 뒤로 가면 관측을 쓰지 않는다 · #12 한 관측 안 중복 id 는 하나만 · #11 나타남은 appear', () => {
  const open = new Map([['a', { id: 1, state: 'on', start: NOW - DAY }]]);
  assert.equal(planObservation({ open, watchLast: NOW, ts: NOW - HOUR, vms: [{ vmId: 'a', state: 'off' }] }).skip, true);
  assert.equal(planObservation({ open, watchLast: NOW, ts: NOW, vms: [{ vmId: 'a', state: 'off' }] }).skip, true, '같은 시각도 쓰지 않는다');
  const d = planObservation({ open: new Map(), watchLast: NOW - W, ts: NOW, vms: [{ vmId: 'x', state: 'on' }, { vmId: 'x', state: 'off' }] });
  assert.equal(d.insert.length, 1);
  assert.equal(d.insert[0].src, 'appear');
  assert.equal(planObservation({ ts: NOW, vms: [{ vmId: 'y', state: 'on' }] }).insert[0].src, 'watch', '첫 관측은 기록 시작');
  const t = buildTimeline({ spans: [{ state: 'on', start: NOW - DAY, lo: NOW - DAY - W, end: null, src: 'appear' }], now: NOW, watchLast: NOW });
  assert.equal(t.facts.firstOn.appeared, true, "목록에 나타남 — 'Power On' 이 아니다");
});

test('2회차 N5 — 정리 뒤 남은 첫 구간이 꺼짐이어도 처음 Power On 을 지어내지 않는다 · 끊김 포함 시간', () => {
  const spans = [
    { state: 'off', start: NOW - 500 * DAY, lo: NOW - 500 * DAY - W, end: NOW - 100 * DAY, src: 'watch' },
    { state: 'on', start: NOW - 100 * DAY + W, lo: NOW - 100 * DAY, end: null, src: 'watch' },
  ];
  assert.equal(buildTimeline({ spans, now: NOW, watchLast: NOW }).facts.firstOn.ts, NOW - 100 * DAY + W, '정리 전에는 그 날');
  const t = buildTimeline({ spans, now: NOW, watchLast: NOW, floor: NOW - 400 * DAY, gaps: [{ from: NOW - 10 * DAY, to: NOW - 9 * DAY }] });
  assert.deepEqual(t.facts.firstOn, { before: NOW - 500 * DAY, src: 'watch' });
  assert.equal(t.facts.current.unknownMs, DAY, '지금 상태 길이에 끼어 있는 기록 없음');
});

test('#10 보존 정리 뒤 남은 첫 구간은 기록 시작 전으로', () => {
  const spans = [{ state: 'on', start: NOW - 500 * DAY, lo: NOW - 500 * DAY - W, end: null, src: 'watch' }];
  assert.equal(buildTimeline({ spans, now: NOW, watchLast: NOW }).facts.firstOn.ts, NOW - 500 * DAY);
  assert.deepEqual(buildTimeline({ spans, now: NOW, watchLast: NOW, floor: NOW - 400 * DAY }).facts.firstOn, { before: NOW - 500 * DAY, src: 'watch' });
});

test('★ 실제 DB — #1 범위 안 전환 · 잘림 표시 · #6 계정 가림 · #8 엣지 위임 · #7 시계 복구', async () => {
  const D = await import('../src/vmpower/db.js');
  const p = await D.powerDb();
  if (!p) return;
  const H = await import('../src/vmpower/history.js');
  // 2년 동안 하루 두 번 켜고 끔 → 전환 약 2,920건
  const vm = { id: 'vc1:vm-1', vcenterId: 'vc1', name: 'batch-1', powerState: 'POWERED_ON' };
  p.db.exec('BEGIN');
  let t = NOW - 730 * DAY;
  let st = 'on';
  let lo = null;
  while (t < NOW - DAY) {
    const end = t + 12 * HOUR - W;
    p.st.insSpan.run('vc1', vm.id, vm.name, st, t, lo, end, 'watch');
    lo = end; t += 12 * HOUR; st = st === 'on' ? 'off' : 'on';
  }
  p.st.insSpan.run('vc1', vm.id, vm.name, 'on', t, lo, null, 'watch');
  p.st.upsertWatch.run('vc1', NOW - 730 * DAY, NOW - MIN, 0);
  p.db.exec('COMMIT');
  const from = NOW - 730 * DAY + 10 * DAY; const to = NOW - 366 * DAY;   // '이전 12개월' 창
  const old = await H.vmPowerHistory(vm, { vms: [vm], vcenters: [{ id: 'vc1' }] }, { from, to, now: NOW });
  assert.ok(old.transitionsInRange > 600, `이전 창 전환 ${old.transitionsInRange}`);
  assert.ok(old.transitions.length > 0 && old.transitions.every((x) => x.ts >= old.from && x.ts <= old.to), '범위 안 전환만');
  const recent = await H.vmPowerHistory(vm, { vms: [vm], vcenters: [{ id: 'vc1' }] }, { now: NOW });
  assert.equal(recent.transitions.length, Math.min(recent.transitionsInRange, H.TRANSITIONS_CAP));
  if (recent.transitionsInRange > H.TRANSITIONS_CAP) {
    assert.equal(recent.transitionsTruncated, true);
    assert.ok(recent.transitions[0].ts > recent.transitions[recent.transitions.length - 1].ts, '최신부터');
  }
  // #6 이벤트 계정 — 관리자 판본에만
  const { getLogsDb } = await import('../src/logs/db.js');
  const ldb = await getLogsDb();
  const lastStart = t;
  if (ldb?.kind === 'sqlite') {
    ldb.insertMany([{ vcenterId: 'vc1', key: 'ev1', ts: lastStart - 3 * MIN, severity: 'info', type: 'VmPoweredOnEvent', user: 'VSPHERE.LOCAL\\ops', entity: vm.name, message: 'on' }]);
    const u = await H.vmPowerHistory(vm, { vms: [vm], vcenters: [{ id: 'vc1' }] }, { now: NOW, admin: false });
    assert.equal(u.facts.current.exact, true);
    assert.equal(u.facts.current.user, '', '비관리자에게 계정 이름을 싣지 않는다');
    assert.equal(u.userMasked, true);
    assert.ok(u.transitions.every((x) => !x.user));
    const a = await H.vmPowerHistory(vm, { vms: [vm], vcenters: [{ id: 'vc1' }] }, { now: NOW, admin: true });
    assert.equal(a.facts.current.user, 'VSPHERE.LOCAL\\ops');
    assert.equal(a.userMasked, undefined);
  }
  // #8 엣지 위임 vCenter — 이벤트로 좁히지 못한 이유를 밝힌다
  const vm2 = { id: 'vs:vm-9', vcenterId: 'vs', name: 'edge-9', powerState: 'POWERED_ON' };
  p.st.insSpan.run('vs', vm2.id, vm2.name, 'on', NOW - DAY, null, null, 'watch');
  const s = await H.vmPowerHistory(vm2, { vms: [vm2], vcenters: [{ id: 'vs', collectSource: 'site' }] }, { now: NOW });
  assert.equal(s.eventsNote, 'site');
  // #5 첫 관측(소급) 때 추적이 비었던 기간을 끊김으로 저장한다 — 슬롯이 90~60일 전에만 있는 vCenter
  const vt = await import('../src/vmtrack/db.js');
  const x = await vt.getDb();
  for (let k = 0, ts = NOW - 90 * DAY; ts <= NOW - 60 * DAY; ts += TRACK_GRAN_MS, k++) x.db.exec(`INSERT INTO snaps (slot, ts, vcenter_id, total) VALUES ('g${k}', ${ts}, 'vg', 1)`);
  x.db.exec(`INSERT INTO roster (vcenter_id, vm_id, name, power_state, first_seen) VALUES ('vg', 'vg:a', 'a', 'POWERED_ON', ${NOW - 90 * DAY})`);
  const W5 = await import('../src/vmpower/watcher.js');
  const gsnap = { generatedAt: new Date(NOW).toISOString(), vcenters: [{ id: 'vg', status: 'connected' }], vms: [{ id: 'vg:a', vcenterId: 'vg', name: 'a', powerState: 'POWERED_ON' }] };
  await W5.runPowerWatchOnce({ now: NOW, snap: gsnap });
  const gg = await D.gapsOf('vg', 0);
  assert.equal(gg.length, 1);
  assert.equal(gg[0].to, NOW);
  assert.ok(NOW - gg[0].from >= 59 * DAY, '마지막 슬롯 ~ 지금');
  const gh = await H.vmPowerHistory({ id: 'vg:a', vcenterId: 'vg', name: 'a', powerState: 'POWERED_ON' }, { vms: [], vcenters: [{ id: 'vg' }] }, { now: NOW + MIN });
  assert.ok(gh.sums.unk >= 59 * DAY, '비어 있던 기간은 켜짐이 아니라 기록 없음');
  // #7 시계가 앞으로 튀었다 돌아옴 — 미래의 마지막 관측을 지금으로 되돌리고 그 관측은 건너뛴다
  const W8 = await import('../src/vmpower/watcher.js');
  p.st.upsertWatch.run('vf', NOW - DAY, NOW - DAY, 1);
  p.st.repairWatch.run(NOW + 2 * DAY, 'vf');
  const snap = { generatedAt: new Date(NOW).toISOString(), vcenters: [{ id: 'vf', status: 'connected' }], vms: [{ id: 'vf:a', vcenterId: 'vf', name: 'a', powerState: 'POWERED_ON' }] };
  const r = await W8.runPowerWatchOnce({ now: NOW, snap });
  assert.deepEqual(r.held, [['vf', 'clock']]);
  assert.equal((await D.watchOf('vf')).lastTs, NOW, '지금으로 되돌림');
  const r2 = await W8.runPowerWatchOnce({ now: NOW + W, snap: { ...snap, generatedAt: new Date(NOW + W).toISOString() } });
  assert.equal(r2.held.length, 0, '다음 관측부터 정상');
  // 3회차 R1 — 작은 역행(6시간 미만)은 데이터를 건드리지 않고 시계가 따라잡을 때까지 건너뛴다
  p.st.repairWatch.run(NOW + 3 * HOUR, 'vf');
  const r3 = await W8.runPowerWatchOnce({ now: NOW + 2 * W, snap: { ...snap, generatedAt: new Date(NOW + 2 * W).toISOString() } });
  assert.deepEqual(r3.held, [['vf', 'clock']]);
  assert.equal((await D.watchOf('vf')).lastTs, NOW + 3 * HOUR, '되돌리지 않고 기다린다');
  // 방향별 건수는 실린 건수가 아니라 범위 안 전체
  assert.equal(recent.transitionsInRangeBy.on + recent.transitionsInRangeBy.off, recent.transitionsInRange);
  // 2회차 N6 — 정리 경계는 끝난 구간을 실제로 지운 vCenter 에만
  p.st.upsertWatch.run('vq', NOW - DAY, NOW, 0);
  p.st.insSpan.run('vq', 'vq:a', 'a', 'on', NOW - 900 * DAY, NOW - 900 * DAY - W, null, 'appear');
  await D.prunePower(NOW - 600 * DAY);
  assert.equal((await D.watchOf('vq')).prunedTo, null, '정리할 것이 없던 vCenter 는 그대로');
  assert.equal((await D.watchOf('vc1')).prunedTo, NOW - 600 * DAY, '2년치 중 앞부분을 지운 vCenter');
});

test('#13 개체 보기 탭은 VM 이 바뀌면 상태를 새로(key) · 달력은 요청 기준 시각으로', () => {
  const vo = stripComments(fs.readFileSync(path.join(WEB, 'views/vcd/VmObject.jsx'), 'utf8'));
  assert.match(vo, /<PowerCalendarTab key=\{vm\.id\} vm=\{vm\} \/>/);
  const ph = stripComments(fs.readFileSync(path.join(WEB, 'views/vms/PowerHistory.jsx'), 'utf8'));
  assert.match(ph, /monthsBack\(q\.base, 12, offset\)/);
});

test('2회차 N4 — 틱 게이트는 미래의 마지막 관측에서 멈추지 않는다', () => {
  const src = stripComments(fs.readFileSync(path.resolve(HERE, '../src/vmpower/watcher.js'), 'utf8'));
  assert.match(src, /const since = Date\.now\(\) - lastAt;\s*if \(since >= 0 && since < WATCH_EVERY_MS\) return;/);
});

test('3회차 R1 — 1시간 역행 · 2일 앞으로 튐 뒤에도 구간이 깨지지 않고 지금 상태가 맞다(실제 관측기 + DB)', async () => {
  const D = await import('../src/vmpower/db.js');
  if (!(await D.powerDb())) return;
  const W8 = await import('../src/vmpower/watcher.js');
  const H = await import('../src/vmpower/history.js');
  const obs = (vc, ts, ps) => W8.runPowerWatchOnce({ now: ts, snap: { generatedAt: new Date(ts).toISOString(), vcenters: [{ id: vc, status: 'connected' }], vms: [{ id: `${vc}:a`, vcenterId: vc, name: `${vc}-a`, powerState: ps }] } });
  const vmOf = (vc, ps) => ({ id: `${vc}:a`, vcenterId: vc, name: `${vc}-a`, powerState: ps });
  const T0 = NOW - 10 * DAY;
  // ① 0~60분 관측(40분에 끔) → 시계 1시간 뒤로 → 실제 80분에 다시 켬
  for (const m of [0, 10, 20, 30]) await obs('vb', T0 + m * MIN, 'POWERED_ON');
  for (const m of [40, 50, 60]) await obs('vb', T0 + m * MIN, 'POWERED_OFF');
  const back = await obs('vb', T0 + 0 * MIN + 5 * MIN, 'POWERED_OFF');   // 시계가 1시간 뒤(실제 65분 → 표시 5분)
  assert.deepEqual(back.held, [['vb', 'clock']]);
  await obs('vb', T0 + 20 * MIN, 'POWERED_ON');                           // 실제 80분 — 아직 따라잡지 못함
  await obs('vb', T0 + 70 * MIN, 'POWERED_ON');                           // 따라잡음
  const sp = await D.spansOfVm('vb', 'vb:a');
  for (const x of sp) { assert.ok(x.lo == null || x.lo <= x.start, '시작이 앞 끝보다 이르지 않다'); assert.ok(x.end == null || x.end >= x.start); }
  const h1 = await H.vmPowerHistory(vmOf('vb', 'POWERED_ON'), { vms: [] }, { now: T0 + 71 * MIN });
  assert.equal(h1.facts.current?.state, 'on');
  assert.equal(h1.facts.gone, false);
  // ② 2일 앞으로 튐(그 시각에 끔이 기록됨) → 시계 복귀 → 미래 구간을 지우고 다시 연다
  const T1 = NOW - 5 * DAY;
  await obs('vj', T1, 'POWERED_ON');
  await obs('vj', T1 + W, 'POWERED_ON');
  await obs('vj', T1 + 2 * DAY, 'POWERED_OFF');                            // 미래(튄 시계)
  const rep = await obs('vj', T1 + 2 * W, 'POWERED_ON');                   // 복귀 — 복구만
  assert.deepEqual(rep.held, [['vj', 'clock']]);
  const after = await D.spansOfVm('vj', 'vj:a');
  assert.ok(after.every((x) => x.start <= T1 + 2 * W), '미래에 시작한 구간이 없다');
  assert.equal(after.filter((x) => x.end == null).length, 1, '열린 구간 하나');
  await obs('vj', T1 + 3 * W, 'POWERED_ON');
  const h2 = await H.vmPowerHistory(vmOf('vj', 'POWERED_ON'), { vms: [] }, { now: T1 + 3 * W + MIN });
  assert.equal(h2.facts.current?.state, 'on');
  assert.equal(h2.facts.gone, false);
  assert.equal(h2.transitions.length, 0, '튄 시계의 꺼짐은 남지 않는다');
});

test('3회차 R2 — 전환 목록의 직전 길이는 사실과 같은 판정 · 빠진 시간을 밝힌다', () => {
  const spans = [
    { state: 'on', start: NOW - 10 * DAY, lo: NOW - 10 * DAY - W, end: NOW - 6 * DAY, src: 'appear' },
    { state: 'on', start: NOW - 6 * DAY + 5 * HOUR, lo: NOW - 6 * DAY, end: NOW - 2 * DAY, src: 'appear' },
    { state: 'off', start: NOW - 2 * DAY + W, lo: NOW - 2 * DAY, end: null, src: 'watch' },
  ];
  const t = buildTimeline({ spans, now: NOW, watchLast: NOW });
  const x = t.transitions[0];
  assert.equal(x.prevFromStart, true, '나타난 구간의 길이는 하한');
  assert.equal(x.prevMaxMs, null);
  assert.equal(x.prevHoleMs, 5 * HOUR);
  assert.equal(t.facts.onCount, 0);
});
