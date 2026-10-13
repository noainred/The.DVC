/**
 * v2.735 — 전송 속도 측정의 **실행 일정**(사용자 요청: "① 원하는 시간에 실행/반복/주간반복/월간 반복 ② 30분/1시간 등 원하는 간격").
 *
 *  ① 일정 검사 — 종류·시각·날짜·요일·일자, 잘못된 값은 고치지 않고 사유를 준다
 *  ② 실행 시각 계산(포탈 시각) — 매일·매주·매월(그 달에 없는 날은 마지막 날, 겹치면 한 번)·1회, 다음/이전
 *  ③ since — 새로 만들거나 바꾼 일정은 지난 시각을 소급 실행하지 않는다 · 꺼 두었다 켠 일정도 같다
 *  ④ 틱 판정(planTick) — 유예 안이면 실행 · 늦으면 놓침(사유 down/busy/late/off) · 같은 시각 두 번 실행 없음 · 간격 판정
 *  ⑤ 오래됨 경계·회선 산수 — 예약만 쓰면 실행 간격 기준 · 반복 예약이 없으면 판정하지 않는다
 *  ⑥ 설정 저장 — 잘못된 일정 거절(bad-schedule) · id·since 부여 · 간격 끔 · 간격 상한 7일
 *  ⑦ 폴러 틱 — 예약 실행 · 처리 기록(재시작 대비) · 놓침 기록 · 간격 실행 · 꺼짐이면 off 로 넘김
 *  ⑧ 웹과 같은 계산 — nextOccurrence·검사 문구·하루 횟수·놓침 사유를 같은 입력으로 대조
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '../../web/src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xfersched2735-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'live';
delete process.env.XFER_SPEED_ENABLED;
delete process.env.PORTAL_TZ_OFFSET_MIN;

const sch = await import('../src/xferspeed/schedule.js');
const settings = await import('../src/xferspeed/settings.js');
const an = await import('../src/xferspeed/analyze.js');
const poller = await import('../src/xferspeed/poller.js');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const KST = 540;
/** 포탈 시각(KST) y-m-d h:mi → ms */
const kst = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi) - KST * MIN;

test('① 일정 검사 — 잘못된 값은 사유와 함께 거절(고치지 않는다)', () => {
  const bad = [
    [{ kind: 'hourly', time: '09:00' }, 'kind'],
    [{ kind: 'daily', time: '9:00' }, 'time'],
    [{ kind: 'daily', time: '24:00' }, 'time'],
    [{ kind: 'once', time: '09:00', date: '2026-02-30' }, 'date'],
    [{ kind: 'once', time: '09:00', date: '' }, 'date'],
    [{ kind: 'weekly', time: '09:00', days: [] }, 'days'],
    [{ kind: 'weekly', time: '09:00', days: [7, -1, 'x'] }, 'days'],
    [{ kind: 'monthly', time: '09:00', monthDays: [0, 32] }, 'monthDays'],
    [null, 'kind'],
  ];
  for (const [raw, field] of bad) {
    const r = sch.checkSchedule(raw);
    assert.equal(r.ok, false, JSON.stringify(raw));
    assert.equal(r.field, field, JSON.stringify(raw));
    assert.ok(r.reason.length > 5);
  }
  const w = sch.checkSchedule({ kind: 'weekly', time: '18:30', days: [4, 1, 1, 9], enabled: true, id: 'Bad Id!' });
  assert.equal(w.ok, true);
  assert.deepEqual(w.sched.days, [1, 4], '정렬·중복 제거·범위 밖 버림');
  assert.equal(w.sched.id, '', '형식에 맞지 않는 id 는 버린다(서버가 새로 붙인다)');
  const m = sch.checkSchedule({ kind: 'monthly', time: '06:00', monthDays: [15, 1, 31], date: '2026-01-01', days: [1] });
  assert.deepEqual(Object.keys(m.sched).sort(), ['enabled', 'id', 'kind', 'monthDays', 'time'], '종류에 맞는 칸만 남긴다');
});

test('② 실행 시각 — 포탈 시각 기준 매일·매주·매월(마지막 날)·1회', () => {
  const daily = { kind: 'daily', time: '09:00' };
  // 2026-10-13 09:30 KST 이후 다음 = 10-14 09:00 KST
  assert.equal(sch.nextOccurrence(daily, kst(2026, 10, 13, 9, 30), KST), kst(2026, 10, 14, 9, 0));
  assert.equal(sch.nextOccurrence(daily, kst(2026, 10, 13, 8, 59), KST), kst(2026, 10, 13, 9, 0));
  assert.equal(sch.prevOccurrence(daily, kst(2026, 10, 13, 9, 0), KST), kst(2026, 10, 13, 9, 0), 'prev 는 같은 시각을 포함');
  assert.equal(sch.prevOccurrence(daily, kst(2026, 10, 13, 8, 59), KST), kst(2026, 10, 12, 9, 0));
  // 오프셋 0(UTC 포탈)이면 같은 '09:00' 이 9시간 뒤다 — 서버 TZ 가 아니라 포탈 오프셋이 기준
  assert.equal(sch.nextOccurrence(daily, Date.UTC(2026, 9, 13, 8, 0), 0), Date.UTC(2026, 9, 13, 9, 0));
  // 매주 월(1)·목(4) 18:30 — 2026-10-13 은 화요일
  const weekly = { kind: 'weekly', time: '18:30', days: [1, 4] };
  assert.equal(sch.nextOccurrence(weekly, kst(2026, 10, 13, 12), KST), kst(2026, 10, 15, 18, 30));
  assert.equal(sch.nextOccurrence(weekly, kst(2026, 10, 15, 18, 30), KST), kst(2026, 10, 19, 18, 30), '같은 시각은 다음으로');
  // 매월 31일 — 2027-02(28일)는 28일에, 30일과 31일을 함께 고르면 30일짜리 달에는 한 번만
  const m31 = { kind: 'monthly', time: '06:00', monthDays: [31] };
  assert.equal(sch.nextOccurrence(m31, kst(2027, 2, 1), KST), kst(2027, 2, 28, 6, 0));
  const m3031 = { kind: 'monthly', time: '06:00', monthDays: [30, 31] };
  assert.equal(sch.nextOccurrence(m3031, kst(2026, 4, 29), KST), kst(2026, 4, 30, 6, 0));
  assert.equal(sch.nextOccurrence(m3031, kst(2026, 4, 30, 6, 0), KST), kst(2026, 5, 30, 6, 0), '4월 30일 다음은 5월 30일(4월에 두 번 없음)');
  // 1회 — 지났으면 다음 없음
  const once = { kind: 'once', time: '14:00', date: '2026-10-20' };
  assert.equal(sch.nextOccurrence(once, kst(2026, 10, 13), KST), kst(2026, 10, 20, 14, 0));
  assert.equal(sch.nextOccurrence(once, kst(2026, 10, 21), KST), null);
  assert.equal(sch.prevOccurrence(once, kst(2026, 10, 19), KST), null);
});

test('③ since — 새 일정·바꾼 일정·다시 켠 일정은 지난 시각을 소급 실행하지 않는다', () => {
  let n = 0;
  const newId = () => `s-t${++n}`;
  const T0 = kst(2026, 10, 13, 10);
  const a = sch.checkSchedules([{ kind: 'daily', time: '09:00' }, { kind: 'weekly', time: '08:00', days: [2] }], { now: T0, newId });
  assert.equal(a.ok, true);
  assert.deepEqual(a.schedules.map((x) => [x.id, x.since]), [['s-t1', T0], ['s-t2', T0]]);
  const T1 = T0 + DAY;
  const b = sch.checkSchedules([
    { ...a.schedules[0] },                              // 그대로 — since 유지
    { ...a.schedules[1], time: '08:30' },               // 바뀜 — since 새로
  ], { prev: a.schedules, now: T1, newId });
  assert.deepEqual(b.schedules.map((x) => x.since), [T0, T1]);
  const off = sch.checkSchedules([{ ...b.schedules[0], enabled: false }], { prev: b.schedules, now: T1 + 1, newId });
  assert.equal(off.schedules[0].since, T0, '끄는 것은 since 를 바꾸지 않는다');
  const on = sch.checkSchedules([{ ...off.schedules[0], enabled: true }], { prev: off.schedules, now: T1 + 2, newId });
  assert.equal(on.schedules[0].since, T1 + 2, '다시 켜면 since 를 다시 잡는다(꺼져 있던 동안의 시각을 실행하지 않는다)');
  const dup = sch.checkSchedules([{ id: 's-x', kind: 'daily', time: '01:00' }, { id: 's-x', kind: 'daily', time: '02:00' }], { now: T0, newId });
  assert.notEqual(dup.schedules[0].id, dup.schedules[1].id, '같은 id 는 하나만');
  const tooMany = sch.checkSchedules(Array.from({ length: sch.SCHEDULE_MAX + 1 }, () => ({ kind: 'daily', time: '01:00' })), { now: T0 });
  assert.equal(tooMany.ok, false);
  const bad = sch.checkSchedules([{ kind: 'daily', time: '01:00' }, { kind: 'weekly', time: '01:00', days: [] }], { now: T0 });
  assert.deepEqual(bad.errors.map((e) => [e.index, e.field]), [[1, 'days']]);
});

test('④ planTick — 유예 안 실행 · 늦으면 놓침(사유) · 같은 시각 두 번 없음 · 간격', () => {
  const since = kst(2026, 10, 1);
  const S = { intervalOn: false, intervalMs: 30 * MIN, schedules: [{ id: 'd9', kind: 'daily', time: '09:00', enabled: true, since }, { id: 'off', kind: 'daily', time: '09:00', enabled: false, since }] };
  const occ = kst(2026, 10, 13, 9, 0);
  const p1 = sch.planTick({ settings: S, state: {}, now: occ + 5 * MIN, bootAt: 0 });
  assert.deepEqual(p1.fire, [{ id: 'd9', occ }]);
  assert.equal(p1.run, true);
  assert.equal(p1.interval, false, '간격 실행이 꺼져 있으면 간격으로는 돌지 않는다');
  const p2 = sch.planTick({ settings: S, state: { d9: { lastAt: occ } }, now: occ + 10 * MIN, bootAt: 0 });
  assert.equal(p2.run, false, '처리한 시각은 다시 실행하지 않는다');
  // 유예(30분)를 넘기면 놓침 — 기동 전이면 down, 측정 중이었으면 busy, 그 밖은 late
  const late = occ + 2 * HOUR;
  assert.equal(sch.planTick({ settings: S, state: {}, now: late, bootAt: occ + HOUR }).missed[0].reason, 'down');
  assert.equal(sch.planTick({ settings: S, state: {}, now: late, bootAt: 0, wasBusy: (o) => o === occ }).missed[0].reason, 'busy');
  assert.equal(sch.planTick({ settings: S, state: {}, now: late, bootAt: 0 }).missed[0].reason, 'late');
  const offPlan = sch.planTick({ settings: S, state: {}, now: occ + MIN, bootAt: 0, enabled: false });
  assert.deepEqual(offPlan.missed, [{ id: 'd9', occ, reason: 'off' }], '자동 측정이 꺼져 있으면 실행하지 않고 off 로 넘긴다');
  assert.equal(offPlan.run, false);
  // 놓침은 가장 최근 시각 하나만(며칠 꺼져 있어도 몰아서 여러 건 만들지 않는다)
  assert.equal(sch.planTick({ settings: S, state: {}, now: occ + 3 * DAY + 2 * HOUR, bootAt: 0 }).missed.length, 1);
  // since 이전 시각은 보지 않는다
  assert.equal(sch.planTick({ settings: { ...S, schedules: [{ ...S.schedules[0], since: occ + MIN }] }, state: {}, now: occ + 5 * MIN }).run, false);
  // 간격 — 마지막 실행 + 간격이 지났을 때만, 마지막 실행을 모르면 바로
  const I = { intervalOn: true, intervalMs: 30 * MIN, schedules: [] };
  assert.equal(sch.planTick({ settings: I, now: 1e12, lastRunAt: null }).interval, true);
  assert.equal(sch.planTick({ settings: I, now: 1e12, lastRunAt: 1e12 - 29 * MIN }).interval, false);
  assert.equal(sch.planTick({ settings: I, now: 1e12, lastRunAt: 1e12 - 30 * MIN }).interval, true);
  // 다음 실행 = 간격과 예약 중 이른 것
  assert.deepEqual(sch.nextRunOf({ settings: { ...I, schedules: S.schedules }, now: occ - 10 * MIN, lastRunAt: occ - 35 * MIN }), { at: occ - 5 * MIN, kind: 'interval', id: null });
  assert.deepEqual(sch.nextRunOf({ settings: { ...I, schedules: S.schedules }, now: occ - 10 * MIN, lastRunAt: occ - 25 * MIN }), { at: occ, kind: 'schedule', id: 'd9' });
  assert.deepEqual(sch.nextRunOf({ settings: { ...S }, now: occ - 10 * MIN, lastRunAt: null }), { at: occ, kind: 'schedule', id: 'd9' });
  assert.equal(sch.nextRunOf({ settings: S, now: occ, enabled: false }), null);
});

test('⑤ 오래됨 경계·회선 산수 — 예약만 쓰면 실행 간격 기준, 반복 예약이 없으면 판정 안 함', () => {
  const now = kst(2026, 10, 13, 12);
  assert.equal(an.staleMsOf(30 * MIN), 2 * HOUR, '숫자 인자는 예전 규칙');
  assert.equal(an.staleMsOf({ intervalOn: true, intervalMs: 6 * HOUR }), 18 * HOUR);
  const weekly = { intervalOn: false, intervalMs: 30 * MIN, schedules: [{ id: 'w', kind: 'weekly', time: '09:00', days: [1, 4], enabled: true }] };
  assert.equal(sch.cadenceMs(weekly, { now }), 4 * DAY, '목 → 다음 월 = 4일');
  assert.equal(an.staleMsOf(weekly, { now }), 6 * DAY);
  const onceOnly = { intervalOn: false, schedules: [{ id: 'o', kind: 'once', time: '09:00', date: '2026-10-20', enabled: true }] };
  assert.equal(an.staleMsOf(onceOnly, { now }), null);
  // 정해진 주기가 없으면 '오래됨' 으로 칠하지 않는다
  const rows = an.edgeRows({
    collectors: [{ id: 'E1', url: 'https://e1' }],
    latest: [{ agent: 'E1', dir: 'down', ts: now - 40 * DAY, ok: 1, mbps: 50 }, { agent: 'E1', dir: 'up', ts: now - 40 * DAY, ok: 1, mbps: 40 }],
    settings: onceOnly, now,
  });
  assert.equal(rows[0].state, 'ok');
  const daily2 = { ...weekly, schedules: [{ id: 'a', kind: 'daily', time: '09:00', enabled: true }] };
  assert.equal(an.edgeRows({ collectors: [{ id: 'E1', url: 'https://e1' }], latest: [{ agent: 'E1', dir: 'down', ts: now - 40 * HOUR, ok: 1, mbps: 50 }], settings: daily2, now })[0].state, 'stale', '매일 예약 — 36시간 넘으면 오래됨');
  const tr = an.trafficOf({ sizeMB: 10, intervalOn: true, intervalMs: 30 * MIN, schedules: [{ id: 'a', kind: 'daily', time: '09:00', enabled: true }, { id: 'b', kind: 'weekly', time: '09:00', days: [1, 4], enabled: true }, { id: 'c', kind: 'once', time: '09:00', date: '2026-10-20', enabled: true }] }, 2);
  assert.equal(tr.intervalRunsPerDay, 48);
  assert.equal(tr.scheduleRunsPerDay, 1.29);
  assert.equal(tr.cyclesPerDay, 49.29);
  assert.equal(tr.onceSchedules, 1);
  assert.equal(an.trafficOf({ sizeMB: 10, intervalOn: false, schedules: [] }, 2).cyclesPerDay, 0);
  assert.equal(an.trafficOf({ sizeMB: 10, intervalMs: 30 * MIN }, 28).cyclesPerDay, 48, '예전 호출 모양 그대로');
});

test('⑥ 설정 저장 — 잘못된 일정 거절 · id·since 부여 · 간격 끔 · 간격 상한 7일', () => {
  assert.equal(settings.DEFAULTS.intervalOn, true);
  assert.deepEqual(settings.DEFAULTS.schedules, []);
  assert.throws(() => settings.saveXferSpeedSettings({ schedules: [{ kind: 'daily', time: '09:00' }, { kind: 'monthly', time: '09:00', monthDays: [] }] }),
    (e) => e.code === 'bad-schedule' && /예약 2/.test(e.message) && e.errors[0].field === 'monthDays');
  assert.throws(() => settings.saveXferSpeedSettings({ schedules: 'daily' }), (e) => e.code === 'bad-schedule', '배열이 아니면 거절(조용히 지우지 않는다)');
  assert.deepEqual(settings.loadXferSpeedSettings().schedules, [], '거절된 저장은 아무것도 바꾸지 않는다');
  const s = settings.saveXferSpeedSettings({ intervalOn: false, intervalMs: 7 * DAY, schedules: [{ kind: 'weekly', time: '07:15', days: [3] }] });
  assert.equal(s.intervalOn, false);
  assert.equal(s.intervalMs, 7 * DAY);
  assert.match(s.schedules[0].id, /^s-[0-9a-f]{6}$/);
  assert.ok(s.schedules[0].since > 0);
  const again = settings.saveXferSpeedSettings({ schedules: [{ ...s.schedules[0] }] });
  assert.equal(again.schedules[0].since, s.schedules[0].since, '그대로 다시 저장하면 since 유지');
  assert.equal(settings.saveXferSpeedSettings({ intervalMs: 8 * DAY }).intervalMs, 7 * DAY, '상한 7일');
  assert.equal(settings.saveXferSpeedSettings({ intervalOn: 'no' }).intervalOn, false, '불리언이 아니면 이전 값 유지');
  // 손으로 고친 파일의 잘못된 일정은 실행하지 않는다
  fs.writeFileSync(path.join(TMP, 'xfer-speed-settings.json'), JSON.stringify({ enabled: true, schedules: [{ kind: 'daily', time: '25:00' }, { kind: 'daily', time: '05:00' }] }));
  const loaded = settings.loadXferSpeedSettings();
  assert.equal(loaded.schedules.length, 1);
  assert.equal(loaded.schedules[0].id, 's-n1');
  fs.rmSync(path.join(TMP, 'xfer-speed-settings.json'));
});

test('⑦ 폴러 틱 — 예약 실행 · 처리 기록 · 놓침 · 간격 · 꺼짐', async () => {
  poller._resetXferPollerForTest();
  // 30분 뒤 시각(KST)의 매일 예약 — 저장 시각(since)보다 뒤라 실행 대상이다
  const ahead = Date.now() + 30 * MIN;
  const d = new Date(ahead + KST * MIN);
  const hhmm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const occ = kst(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes());
  settings.saveXferSpeedSettings({ enabled: true, intervalOn: false, schedules: [{ kind: 'daily', time: hhmm }] });
  const id = settings.loadXferSpeedSettings().schedules[0].id;

  const before = await poller.tickXferSchedule({ now: occ - MIN });
  assert.equal(before.plan.run, false, '시각 전에는 실행하지 않는다');
  const t1 = await poller.tickXferSchedule({ now: occ + 2 * MIN });
  assert.equal(t1.started, true);
  assert.equal(t1.trigger, 'schedule');
  const res = await t1.promise;
  assert.equal(res.ok, true);
  assert.deepEqual(res.scheduleIds, [id]);
  const state = JSON.parse(fs.readFileSync(path.join(TMP, 'xfer-speed-schedule-state.json'), 'utf8'));
  assert.deepEqual([state.schedules[id].lastAt, state.schedules[id].result], [occ, 'ran'], '처리 기록 — 재시작 뒤 같은 시각을 다시 실행하지 않게');
  const t2 = await poller.tickXferSchedule({ now: occ + 5 * MIN });
  assert.equal(t2.plan.run, false, '같은 시각을 두 번 실행하지 않는다');
  const st = poller.xferSpeedStatus(occ + 5 * MIN);
  assert.equal(st.last.trigger, 'schedule');
  assert.equal(st.schedules[0].next, occ + DAY);
  assert.deepEqual(st.next, { at: occ + DAY, kind: 'schedule', id });
  assert.equal(st.offsetMin, KST);

  // 다음 날 시각을 2시간 지나 확인하면 놓침(late) — 몰아서 실행하지 않는다
  const t3 = await poller.tickXferSchedule({ now: occ + DAY + 2 * HOUR });
  assert.equal(t3.plan.run, false);
  assert.deepEqual(t3.plan.missed.map((m) => [m.id, m.reason]), [[id, 'late']]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(TMP, 'xfer-speed-schedule-state.json'), 'utf8')).schedules[id].result, 'missed');

  // 간격 실행 — 마지막 실행 시작에서 간격이 지나야 돈다(예약 실행도 마지막 실행이다)
  settings.saveXferSpeedSettings({ intervalOn: true, intervalMs: 30 * MIN, schedules: [] });
  const last = poller.xferSpeedStatus().lastRunAt;
  assert.ok(Number.isFinite(last));
  assert.equal((await poller.tickXferSchedule({ now: last + 20 * MIN })).plan.run, false);
  const t4 = await poller.tickXferSchedule({ now: last + 31 * MIN });
  assert.equal(t4.trigger, 'timer');
  await t4.promise;
  assert.ok(!fs.readFileSync(path.join(TMP, 'xfer-speed-schedule-state.json'), 'utf8').includes(`"${id}"`), '지운 일정의 처리 기록은 다음 기록 때 버린다');

  // 꺼짐 — 지난 예약은 실행하지 않고 off 로 넘긴다(켠 뒤 소급 실행하지 않게)
  settings.saveXferSpeedSettings({ enabled: false, schedules: [{ kind: 'daily', time: hhmm }] });
  const t5 = await poller.tickXferSchedule({ now: occ + DAY + 2 * MIN });
  assert.equal(t5.plan.run, false);
  assert.equal(t5.plan.missed[0].reason, 'off');
  fs.rmSync(path.join(TMP, 'xfer-speed-settings.json'), { force: true });
});

test('⑧ 웹과 같은 계산 — 다음 실행 시각 · 검사 문구 · 하루 횟수 · 놓침 사유', async () => {
  const w = await import(path.join(WEB, 'views/tools/xferSpeedText.js'));
  assert.deepEqual(Object.keys(w.MISSED_TEXT).sort(), [...sch.MISSED_REASONS].sort());
  assert.deepEqual([...w.SCHEDULE_KINDS], [...sch.SCHEDULE_KINDS]);
  // 결정적 난수(LCG)로 일정 × 기준 시각을 만들어 같은 답인지 본다
  let seed = 2735;
  const rnd = (n) => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed % n; };
  const pad = (n) => String(n).padStart(2, '0');
  for (let i = 0; i < 400; i++) {
    const kind = sch.SCHEDULE_KINDS[rnd(4)];
    const s = { kind, time: `${pad(rnd(24))}:${pad(rnd(60))}`, date: `2026-${pad(1 + rnd(12))}-${pad(1 + rnd(28))}`, days: [rnd(7), rnd(7)], monthDays: [1 + rnd(31), 1 + rnd(31)] };
    const after = Date.UTC(2026, 0, 1) + rnd(400) * DAY + rnd(DAY / MIN) * MIN;
    for (const off of [KST, 0, -300]) {
      assert.equal(w.nextOccurrence(s, after, off), sch.nextOccurrence(s, after, off), `${JSON.stringify(s)} after=${after} off=${off}`);
    }
    const srv = sch.checkSchedule(s);
    assert.equal(w.checkScheduleForm(s), srv.ok ? '' : srv.reason);
  }
  for (const raw of [{ kind: 'x', time: '09:00' }, { kind: 'daily', time: '9:00' }, { kind: 'once', time: '09:00', date: '2026-13-01' }, { kind: 'weekly', time: '09:00', days: [] }, { kind: 'monthly', time: '09:00', monthDays: [] }]) {
    assert.equal(w.checkScheduleForm(raw), sch.checkSchedule(raw).reason);
  }
  const list = [{ id: 'a', kind: 'daily', time: '09:00', enabled: true }, { id: 'b', kind: 'weekly', time: '09:00', days: [1, 3, 5], enabled: true }, { id: 'c', kind: 'monthly', time: '09:00', monthDays: [1, 15], enabled: true }, { id: 'd', kind: 'daily', time: '09:00', enabled: false }];
  assert.equal(w.runsPerDayPreview({ intervalOn: true, intervalMin: 60, schedules: list }), sch.runsPerDay({ intervalOn: true, intervalMs: HOUR, schedules: list }));
  assert.equal(w.runsPerDayPreview({ intervalOn: false, intervalMin: 60, schedules: list }), sch.runsPerDay({ intervalOn: false, intervalMs: HOUR, schedules: list }));
});
