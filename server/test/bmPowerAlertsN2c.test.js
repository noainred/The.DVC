/**
 * 반증 n2 2차 재확인(기준판 5139423c) 확정분 고정:
 *   ① M1 보류 시한이 주기 소요 시간에 따라 늘거나 줄지 않는다 — 진짜 보류(조건 null)는 ‘연속 보류 주기 수’ 로,
 *      주기가 없던 틈(재시작 · 건너뜀)은 ‘폴러가 돌지 않은 시간’(이번 주기 시작 − 직전 주기 끝 − 설정 주기)으로 따로 잰다.
 *      기준판: 주기 1분 · 간격 4.5분(소요 3.5분) / 주기 5분 · 간격 21분(소요 16분)이면 매 주기 1로 돌아가 발화 0 · holdReset 78.
 *   ② M2 판정 노드가 넘어가 상태를 비울 때 재발 억제용 묘비(firedAt)를 재발 억제 기간 동안 남긴다 — 깜빡임마다 같은 사건을 다시 보내지 않는다.
 *   ③ M3 판정 노드 넘어감은 발송 기록(최근 200)에 쓰지 않는다(주기 상태 · 콘솔 한 줄) — 실제 발송 기록을 밀어내지 않는다.
 * 기준 시각: 실제 시각을 정시로 내린 뒤 −20분(common.md).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmpown2c-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const MIN = 60_000; const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 20 * MIN;

const PA = await import('../src/bmusage/powerAlerts.js');
const AG = await import('../src/bmusage/powerAgg.js');
const A = await import('../src/bmusage/perfAlerts.js');
const R = await import('../src/bmusage/perfRules.js');
const STATE = () => JSON.parse(fs.readFileSync(path.join(DIR, 'bm-perf-alert-state.json'), 'utf8'));
const rulesOf = (on = {}, extra = {}) => R.normalizeRules({ rules: Object.fromEntries(Object.entries(on).map(([id, x]) => [id, { on: true, channels: ['email'], ...x }])), ...extra }, { strict: true }).value;
function depsOf() {
  const sends = [];
  return { sends, deps: { alertConfig: async () => ({ channels: { email: { enabled: true } } }), notify: async (al) => { sends.push(al); return ['email:ok']; }, outcome: async () => 'delivered',
    retryDelay: async () => null, applyIssues: async () => ({ byId: {} }), startFocus: async () => ({ ok: true }), isMock: async () => false, clock: () => NOW, maintJudge: async () => null } };
}
const srv = (p, key = 'K1') => ({ key, name: `bm-${key}`, vcenterId: 'vcA', target: { key, vcenterId: 'vcA' }, power: { kind: 'server', inletWarnC: 27, capHitPct: 98, surgePct: 20, tempState: 'ok', ...p } });
/** 흡기 30 °C(기준 27) · PowerCap 걸림(900 W / 900 W) — 표본 시각 s(관측 표지). */
const both = (s) => srv({ inletC: 30, tempAt: s, w: 900, at: s, capW: 900, capPct: 100, capHit: true });
const stale = (s) => srv({ inletC: 30, tempAt: s, tempState: 'stale' });

/**
 * 폴러 주기 시뮬레이션 — 주기 시작 S · 판정(≈ 주기 끝) J = S + 소요 · 다음 시작 = 끝 + 설정 주기(adaptiveTimer 는 ‘이전 실행 종료 기준’).
 *   tailMs: 판정 뒤 주기 꼬리(롤업 보정 · 정리 — 판정보다 늦게 끝난다) · note: 폴러처럼 실제 끝 시각을 알린다(notePerfCycleEnd).
 */
async function cycles({ rules, intervalMs, durMs, n = 40, itemsOf = (s) => [both(s)], tailMs = 0, note = false, at = NOW }) {
  A._resetPerfAlertsForTest();
  const d = depsOf();
  let fires = 0; let resets = 0; let first = null; let S = at;
  for (let k = 0; k < n; k += 1) {
    const J = S + durMs;
    const r = await A.runPerfAlerts(itemsOf(J - 30_000, k), { rules, now: J, deps: d.deps, intervalMs, cycleStartAt: S });
    fires += r.fires || 0; resets += r.counts?.holdReset || 0;
    if (r.fires && first == null) first = k;
    if (note) A.notePerfCycleEnd(J + tailMs);
    S = J + tailMs + intervalMs;
  }
  await A._drainPerfAlertsForTest();
  return { fires, resets, first, sends: d.sends.length };
}

test('① M1 — 주기 소요가 ‘지속 × 수집 주기’ 를 넘어도 발화한다(소요 3.5분 · 16분) · 대조군(2.9분 · 14분) 그대로', async () => {
  const rules = rulesOf({ inlet: { sustain: 3, repeatMin: 0 }, powerCap: { sustain: 3, repeatMin: 0 } });
  // 기준판: 주기 1분 · 간격 4.5분 → 발화 0 · holdReset 78
  const a = await cycles({ rules, intervalMs: MIN, durMs: 3.5 * MIN });
  assert.equal(a.resets, 0, '주기 자체가 느린 것은 관측이 이어진 것이다(예전 78번 다시 셈)'); assert.equal(a.fires, 2, '흡기 · PowerCap 각 1(예전 0)'); assert.equal(a.first, 2, '세 번째 주기');
  // 기준판: 주기 5분 · 간격 21분 → 발화 0 · holdReset 78
  const b = await cycles({ rules, intervalMs: 5 * MIN, durMs: 16 * MIN });
  assert.equal(b.resets, 0); assert.equal(b.fires, 2, '(예전 0)'); assert.equal(b.first, 2);
  // 대조군 — 간격 3.9분 · 19분(기준판에서도 발화)
  const c = await cycles({ rules, intervalMs: MIN, durMs: 2.9 * MIN });
  assert.equal(c.resets, 0); assert.equal(c.fires, 2); assert.equal(c.first, 2);
  const e = await cycles({ rules, intervalMs: 5 * MIN, durMs: 14 * MIN });
  assert.equal(e.resets, 0); assert.equal(e.fires, 2); assert.equal(e.first, 2);
});

test('② M1 — 진짜 보류는 주기 수로 센다: 긴 주기(간격 4.5분)에서도 보류 3주기는 잇고 4주기는 1부터 · 항목이 빠진 주기도 보류 주기', async () => {
  const rules = rulesOf({ inlet: { sustain: 3, repeatMin: 0 } });
  // 표본 2개(지속 2) → 낡음 h 주기 → 새 표본: h ≤ 지속(3)이면 잇는다(발화) · 넘으면 1부터
  const seq = (h) => (s, k) => [k < 2 || k >= 2 + h ? both(s) : stale(s - 10 * MIN)];
  let r = await cycles({ rules, intervalMs: MIN, durMs: 3.5 * MIN, n: 3 + 3, itemsOf: seq(3) });
  assert.equal(r.fires, 1, '보류 3주기(13.5분 — 예전 시한 4분 초과로 끊김)는 잇는다'); assert.equal(r.resets, 0); assert.equal(r.first, 5);
  r = await cycles({ rules, intervalMs: MIN, durMs: 3.5 * MIN, n: 3 + 4, itemsOf: seq(4) });
  assert.equal(r.fires, 0, '보류 4주기 > 지속 3 — 1부터'); assert.equal(r.resets, 1);
  assert.equal(STATE().rules['inlet|vcA|K1'].streak, 1);
  // 짧은 주기(간격 1.5분)에서도 같은 주기 수 규칙 — 시간이 아니라 주기 수
  r = await cycles({ rules, intervalMs: MIN, durMs: 0.5 * MIN, n: 3 + 4, itemsOf: seq(4) });
  assert.equal(r.fires, 0); assert.equal(r.resets, 1);
  r = await cycles({ rules, intervalMs: MIN, durMs: 0.5 * MIN, n: 3 + 3, itemsOf: seq(3) });
  assert.equal(r.fires, 1); assert.equal(r.resets, 0);
  // 전력 입력 실패(항목 없음) 주기도 보류 주기로 센다(들고 가는 상태 · 주기 수 +1)
  const gone = (h) => (s, k) => (k < 2 || k >= 2 + h ? [both(s)] : []);
  r = await cycles({ rules, intervalMs: 5 * MIN, durMs: 0.5 * MIN, n: 3 + 4, itemsOf: gone(4) });
  assert.equal(r.fires, 0, '항목이 빠진 4주기 뒤 — 1부터'); assert.equal(r.resets, 1);
  r = await cycles({ rules, intervalMs: 5 * MIN, durMs: 0.5 * MIN, n: 3 + 3, itemsOf: gone(3) });
  assert.equal(r.fires, 1); assert.equal(r.resets, 0);
});

test('③ M1 — 주기가 없던 틈은 ‘폴러가 돌지 않은 시간’: 1시간 틈 → 1부터 · 수집 주기 5→1분 변경 직후 거짓 끊김 없음 · 판정 뒤 꼬리는 주기 소요', async () => {
  const rules = rulesOf({ inlet: { sustain: 3, repeatMin: 0 } });
  const d = depsOf();
  const run = (S, J, iv, s = J - 30_000) => A.runPerfAlerts([both(s)], { rules: rulesOf({ inlet: { sustain: 3, repeatMin: 0 } }), now: J, deps: d.deps, intervalMs: iv, cycleStartAt: S });
  // 1시간 틈(재시작) — 주기 5분 · 소요 1분: 지속 2 → 끝(+7분) 뒤 60분 만에 다음 주기 → 1부터
  A._resetPerfAlertsForTest();
  await run(NOW, NOW + MIN, 5 * MIN); await run(NOW + 6 * MIN, NOW + 7 * MIN, 5 * MIN);
  let r = await run(NOW + 67 * MIN, NOW + 68 * MIN, 5 * MIN);
  assert.equal(r.fires, 0, '틈 뒤 첫 표본으로 지속을 잇지 않는다'); assert.equal(r.counts.holdReset, 1); assert.equal(STATE().rules['inlet|vcA|K1'].streak, 1);
  // 틈이 지속 × 주기(15분) 이하면 잇는다(늦은 주기 하나)
  A._resetPerfAlertsForTest();
  await run(NOW, NOW + MIN, 5 * MIN); await run(NOW + 6 * MIN, NOW + 7 * MIN, 5 * MIN);
  r = await run(NOW + 27 * MIN, NOW + 28 * MIN, 5 * MIN);
  assert.equal(r.fires, 1, '끝 + 주기 + 15분 = 시한 안'); assert.equal(r.counts.holdReset, 0);
  // 틈 뒤 첫 주기가 보류(낡음)여도 틈은 잊히지 않는다 — 그 주기에 1부터 다시 세고 다음 표본은 1
  A._resetPerfAlertsForTest();
  await run(NOW, NOW + MIN, 5 * MIN); await run(NOW + 6 * MIN, NOW + 7 * MIN, 5 * MIN);
  await A.runPerfAlerts([stale(NOW)], { rules, now: NOW + 68 * MIN, deps: d.deps, intervalMs: 5 * MIN, cycleStartAt: NOW + 67 * MIN });
  r = await run(NOW + 73 * MIN, NOW + 74 * MIN, 5 * MIN);
  assert.equal(r.fires, 0); assert.equal(STATE().rules['inlet|vcA|K1'].streak, 1, '틈 + 보류 1주기 뒤 첫 표본은 1');
  // 틈 뒤 첫 주기에 그 항목이 아예 없어도(전력 입력 실패) 틈은 잊히지 않는다
  A._resetPerfAlertsForTest();
  await run(NOW, NOW + MIN, 5 * MIN); await run(NOW + 6 * MIN, NOW + 7 * MIN, 5 * MIN);
  await A.runPerfAlerts([], { rules, now: NOW + 68 * MIN, deps: d.deps, intervalMs: 5 * MIN, cycleStartAt: NOW + 67 * MIN });
  r = await run(NOW + 73 * MIN, NOW + 74 * MIN, 5 * MIN);
  assert.equal(r.fires, 0); assert.equal(STATE().rules['inlet|vcA|K1'].streak, 1, '틈 + 항목 없는 1주기 뒤 첫 표본은 1');
  // 재시작(메모리 비움 · 상태 파일만 남음) 뒤에도 직전 판정 시각으로 틈을 잰다
  A._resetPerfAlertsForTest();
  await run(NOW, NOW + MIN, 5 * MIN); await run(NOW + 6 * MIN, NOW + 7 * MIN, 5 * MIN);
  assert.deepEqual(STATE().cycle, { at: NOW + 7 * MIN, intervalMs: 5 * MIN });
  A._resetPerfAlertsForTest({ unlink: false });
  r = await run(NOW + 67 * MIN, NOW + 68 * MIN, 5 * MIN);
  assert.equal(r.fires, 0, '재시작 뒤 1시간 틈 — 상태 파일의 직전 판정 시각'); assert.equal(r.counts.holdReset, 1);
  // 수집 주기 5분 → 1분 변경 — 직전 끝 4분 · 4.5분 뒤에 바꾸면 바로 다음 주기(재무장: 마지막 종료 기준 남은 시간 0) → 끊지 않는다(기준판: holdReset 1)
  for (const late of [4, 4.5]) {
    A._resetPerfAlertsForTest();
    await run(NOW, NOW + MIN, 5 * MIN); await run(NOW + 6 * MIN, NOW + 7 * MIN, 5 * MIN);
    r = await run(NOW + (7 + late) * MIN, NOW + (8 + late) * MIN, MIN);
    assert.equal(r.counts.holdReset, 0, `주기 변경 직후 거짓 끊김 없음(끝 뒤 ${late}분 — 예전 1)`); assert.equal(r.fires, 1);
  }
  // 5분 → 1분 변경 뒤 진짜 틈(30분)은 끊는다
  A._resetPerfAlertsForTest();
  await run(NOW, NOW + MIN, 5 * MIN); await run(NOW + 6 * MIN, NOW + 7 * MIN, 5 * MIN);
  r = await run(NOW + 37 * MIN, NOW + 38 * MIN, MIN);
  assert.equal(r.counts.holdReset, 1); assert.equal(r.fires, 0);
  // 판정 뒤 꼬리(롤업 보정 · 정리 3분 — 주기 1분 · 지속 2): 폴러가 실제 끝을 알리면 꼬리는 주기 소요라 끊지 않는다
  const r2 = rulesOf({ inlet: { sustain: 2, repeatMin: 0 } });
  const t1 = await cycles({ rules: r2, intervalMs: MIN, durMs: 0.5 * MIN, tailMs: 3 * MIN, note: true, n: 6 });
  assert.equal(t1.resets, 0); assert.equal(t1.fires, 1, '꼬리는 틈이 아니다(기준판 0)'); assert.equal(t1.first, 1);
  // 재시작으로 끝 알림을 잃으면(판정 시각만 남음) 꼬리가 틈으로 보일 수 있다 — 끊는 쪽(지속을 잇지 않음)으로 틀린다
  const t2 = await cycles({ rules: r2, intervalMs: MIN, durMs: 0.5 * MIN, tailMs: 3 * MIN, note: false, n: 6 });
  assert.equal(t2.fires, 0); assert.ok(t2.resets > 0);
});

test('④ M2 — 판정 노드가 깜빡여도 같은 진행 중 사건을 다시 보내지 않는다(묘비 firedAt) · day0 → day3 새 사건은 발화 · 묘비는 재발 억제 기간 뒤 지운다', async () => {
  const rules = rulesOf({ powerCap: { sustain: 1, repeatMin: 720 }, rack: { sustain: 1, repeatMin: 720 } }, { power: { racksText: 'vcE,E-1,0.5,S1' } });
  const tgt = [{ key: 'S1', name: 'bm-s1', vcenterId: 'vcE', idrac: { regId: 'rS1' } }];
  const src = (w, at) => async () => ({
    measured: async () => [{ serverId: 'rS1', watts: w, ts: at, vcenterId: 'vcE', source: 'idrac' }], analysisServers: async () => [{ id: 'rS1' }], fanFaults: async () => [],
    powerDb: async () => ({ hourlyStats: () => [] }), inventoryOf: () => ({ powerCap: { limitWatts: 500 }, collectedAt: at }), sensorLatest: () => null,
    temps: { classify: () => 'cpu', maxAgeOf: () => 15 * MIN } });
  let owner = '';
  const jctx = async () => ({ self: 'central', isEdge: false, corpOwner: () => owner });
  A._resetPerfAlertsForTest(); AG._resetPowerAggForTest();
  const d = depsOf();
  const cycle = async (t, w = 495) => A.runPerfAlerts(await PA.powerAlertItems({ targets: tgt, rules, now: t, deps: { sources: src(w, t - MIN), judgeCtx: jctx } }), { rules, now: t, deps: d.deps, intervalMs: 5 * MIN, cycleStartAt: t - MIN });
  // day0 — 중앙 판정 · 걸림 → 발송 2(PowerCap · 랙)
  let r = await cycle(NOW);
  assert.equal(r.fires, 2);
  // 엣지가 맡음 → 넘김(상태 비움 · 묘비)
  owner = 'edge-e'; r = await cycle(NOW + 5 * MIN);
  assert.equal(r.counts.released, 2);
  const tomb0 = STATE().rules['powerCap|vcE|S1'] || null;
  // day3 — 엣지 만료 → 다시 중앙 · 새로 걸림 → 발화(N2 그대로)
  owner = ''; r = await cycle(NOW + 72 * HOUR, 499);
  assert.equal(r.fires, 2, 'day3 새 사건(재발 억제 720분 지남)');
  // 깜빡임 3번(각 3주기 · 약 1시간 안) — 걸림이 내내 이어지는 동안: 기준판은 깜빡일 때마다 2건씩 다시 보냈다(재발 억제 우회)
  let t = NOW + 72 * HOUR;
  let flickerFires = 0;
  for (let i = 0; i < 3; i += 1) {
    owner = 'edge-e';
    for (let k = 0; k < 3; k += 1) { t += 5 * MIN; r = await cycle(t); flickerFires += r.fires || 0; }
    owner = '';
    for (let k = 0; k < 3; k += 1) { t += 5 * MIN; r = await cycle(t); flickerFires += r.fires || 0; }
  }
  await A._drainPerfAlertsForTest();
  assert.equal(flickerFires, 0, '깜빡임마다 다시 보내지 않는다(예전 6)'); assert.equal(d.sends.length, 4, 'day0 2 + day3 2');
  // 넘김 때 남긴 묘비 — 진행 중 상태는 비우고(묵은 active 로 새 사건을 삼키지 않게) 재발 억제용 firedAt 만
  assert.equal(tomb0?.active, false); assert.equal(tomb0?.streak, 0); assert.equal(tomb0?.firedAt, NOW, '재발 억제용 firedAt 은 남긴다');
  // 재발 억제 기간(720분)이 지나도 같은 사건이 이어지는 중이면(진행 중) 다시 보내지 않는다 — 판정 노드에 머문 동안은 ‘한 사건에 한 번’
  // 묘비 만료 — 넘김이 이어지는 동안 재발 억제 기간이 지나면 묘비를 지운다(다시 판정하면 새 사건)
  owner = 'edge-e';
  for (let k = 0; k < 2; k += 1) { t += 5 * MIN; await cycle(t); }
  assert.ok(STATE().rules['powerCap|vcE|S1'], '억제 기간 안 — 묘비 유지');
  t = NOW + 72 * HOUR + 12 * HOUR + 5 * MIN; await cycle(t);
  assert.equal(STATE().rules['powerCap|vcE|S1'], undefined, '억제 기간 뒤 — 묘비 지움');
  // 판정 항목이 아예 오지 않아도(대상 제외) 묘비는 억제 기간까지만 들고 간다(24시간 들고 가기와 별개)
  A._resetPerfAlertsForTest(); owner = '';
  await cycle(NOW); owner = 'edge-e'; await cycle(NOW + 5 * MIN);
  await A.runPerfAlerts([], { rules, now: NOW + 6 * HOUR, deps: d.deps, intervalMs: 5 * MIN });
  assert.ok(STATE().rules['powerCap|vcE|S1']);
  await A.runPerfAlerts([], { rules, now: NOW + 12 * HOUR, deps: d.deps, intervalMs: 5 * MIN });
  assert.equal(STATE().rules['powerCap|vcE|S1'], undefined);
  // 묘비에서 다시 판정한 상태는 묘비가 아니다(묘비 표지가 남으면 보류 시한이 그 상태를 끊지 않는다)
  {
    const ri = rulesOf({ inlet: { sustain: 3, repeatMin: 240 } });
    A._resetPerfAlertsForTest();
    const it = (s) => srv({ inletC: 30, tempAt: s });
    for (const k of [0, 5, 10]) await A.runPerfAlerts([it(NOW + k * MIN - 30_000)], { rules: ri, now: NOW + k * MIN, deps: d.deps, intervalMs: 5 * MIN });
    assert.equal(STATE().rules['inlet|vcA|K1'].active, true);
    await A.runPerfAlerts([{ key: 'K1', name: 'bm-K1', vcenterId: 'vcA', release: { kind: 'server', reason: 'source-edge', node: '' } }], { rules: ri, now: NOW + 15 * MIN, deps: d.deps, intervalMs: 5 * MIN });
    assert.ok(STATE().rules['inlet|vcA|K1'].tomb);
    for (const k of [20, 25]) await A.runPerfAlerts([it(NOW + k * MIN - 30_000)], { rules: ri, now: NOW + k * MIN, deps: d.deps, intervalMs: 5 * MIN });
    assert.equal(STATE().rules['inlet|vcA|K1'].streak, 2); assert.equal(STATE().rules['inlet|vcA|K1'].tomb, undefined, '다시 판정 — 묘비 표지 지움(firedAt 은 잇는다)');
    assert.equal(STATE().rules['inlet|vcA|K1'].firedAt, NOW + 10 * MIN);
    const r9 = await A.runPerfAlerts([it(NOW + 90 * MIN - 30_000)], { rules: ri, now: NOW + 90 * MIN, deps: d.deps, intervalMs: 5 * MIN });
    assert.equal(r9.counts.holdReset, 1, '묘비에서 다시 판정한 지속 상태도 틈이면 1부터');
  }
  // 묘비 규칙(순수) — 억제 기간 안의 firedAt 만 · 재시도 대기(받은 채널 없음)는 남기지 않는다 · 묘비는 처음 넘긴 시각을 잇는다
  assert.deepEqual(A.tombOf({ streak: 4, active: true, firedAt: NOW, since: NOW - MIN, obs: 'x', holdN: 2 }, { repeatMin: 720 }, NOW + 5 * MIN), { streak: 0, active: false, firedAt: NOW, since: null, seenAt: NOW + 5 * MIN, tomb: NOW + 5 * MIN });
  assert.equal(A.tombOf({ active: true, firedAt: NOW, retryAt: NOW + 5 * MIN }, { repeatMin: 720 }, NOW + MIN), null);
  assert.equal(A.tombOf({ active: true, firedAt: NOW }, { repeatMin: 720 }, NOW + 720 * MIN), null);
  assert.equal(A.tombOf({ active: false, firedAt: null, streak: 2 }, { repeatMin: 720 }, NOW), null);
  assert.equal(A.tombOf({ tomb: NOW + MIN, firedAt: NOW }, { repeatMin: 720 }, NOW + HOUR).tomb, NOW + MIN);
  // 재발 억제 0 이면 묘비를 남기지 않는다(예전처럼 지운다)
  const r0 = rulesOf({ powerCap: { sustain: 1, repeatMin: 0 } });
  A._resetPerfAlertsForTest(); owner = '';
  const c0 = async (tt) => A.runPerfAlerts(await PA.powerAlertItems({ targets: tgt, rules: r0, now: tt, deps: { sources: src(495, tt - MIN), judgeCtx: jctx } }), { rules: r0, now: tt, deps: d.deps, intervalMs: 5 * MIN });
  await c0(NOW); owner = 'edge-e'; await c0(NOW + 5 * MIN);
  assert.equal(STATE().rules['powerCap|vcE|S1'], undefined);
});

test('⑤ M3 — 판정 노드 넘어감은 발송 기록을 밀어내지 않는다(120대 × 2규칙) · 주기 상태 · 콘솔 한 줄', async (t) => {
  const rules = rulesOf({ inlet: { sustain: 1, repeatMin: 0 }, powerCap: { sustain: 1, repeatMin: 0 } }, { daily: { alerts: 1_000 } });
  A._resetPerfAlertsForTest();
  const d = depsOf();
  const keys = Array.from({ length: 120 }, (_, i) => `S${i}`);
  // 120대 × 2규칙 진행 중 — 주기 상한을 넘기지 않게 두 번에 나눠 걸리게 한다(발송 기록 200줄 = 실제 발송)
  for (const [i, part] of [keys.slice(0, 60), keys.slice(60)].entries()) {
    await A.runPerfAlerts(part.map((k) => srv({ inletC: 30, tempAt: NOW - MIN, w: 900, at: NOW - MIN, capW: 900, capPct: 100, capHit: true }, k)), { rules, now: NOW + i * MIN, deps: d.deps, cycleMax: 1_000 });
  }
  await A._drainPerfAlertsForTest();
  const before = A.perfAlertStatus().sent;
  assert.equal(before.length, 200); assert.equal(before.filter((x) => x.result === 'sent').length, 200);
  const logs = []; const orig = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  t.after(() => { console.log = orig; });
  let r;
  try { r = await A.runPerfAlerts(keys.map((k) => ({ key: k, name: `bm-${k}`, vcenterId: 'vcA', release: { kind: 'server', reason: 'corp-edge-owned', node: '' } })), { rules, now: NOW + 5 * MIN, deps: d.deps }); }
  finally { console.log = orig; }
  assert.equal(r.counts.released, 240);
  const after = A.perfAlertStatus().sent;
  assert.equal(after.length, 200); assert.equal(after.filter((x) => x.result === 'sent').length, 200, '실제 발송 기록 그대로(예전 judge-moved 200 · sent 0)');
  assert.equal(after.filter((x) => x.result === 'judge-moved').length, 0);
  const moved = logs.filter((x) => /판정 노드 넘어감/.test(x));
  assert.equal(moved.length, 1, '콘솔은 주기당 한 줄'); assert.match(moved[0], /240건/); assert.doesNotMatch(moved[0], /bm-S\d/, '이름을 싣지 않는다(개수 · 사유만)');
});

test('⑥ M1 · M3 폴러 배선 — 주기 시작(t0)을 넘기고 실제 끝을 알린다(수동 · 자동 틱) · 판정 노드 넘어감은 지난 주기 상태(개수) · 묘비', async (t) => {
  let sqlite = null; try { sqlite = await import('node:sqlite'); } catch { sqlite = null; }
  if (!sqlite) return t.skip('node:sqlite 없음');
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [] }));
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [{ id: 'o-f1', name: 'bm-f1', host: '127.0.0.5', port: 9, username: 'mon', password: 'pw', mounts: [] }] }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcF: true }, osSsh: true, idracTelemetry: false, intervalMs: 600_000 }));
  const poller = await import('../src/bmusage/poller.js');
  const OSm = await import('../src/bmusage/collectors/osSsh.js');
  poller._setFleetForTest(async () => ({ bareMetal: [{ serverId: 's-f1', name: 'bm-f1', serviceTag: 'FTAG1', vcenterId: 'vcF' }], virtualizationHosts: [] }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  const stdout = ['##STAT', 'cpu  10 0 10 1000 0 0 0 0 0 0', '##MEM', 'MemTotal: 1000000 kB', 'MemAvailable: 500000 kB', '##END'].join('\n');
  poller._setOsCollectorForTest(async () => { const sh = OSm.shapeLinux(stdout, []); return { ...sh, ok: true, peak: { windowS: 0 }, stderr: '' }; });
  // 그 서버의 전력 원천이 엣지 사본(remote) — 이 노드는 판정 노드가 아니다(source-edge → 넘김)
  PA._setPowerSourcesForTest(async () => ({ measured: async () => [{ serverId: 'remote:e:1', watts: 300, ts: Date.now() - MIN, vcenterId: 'vcF', source: 'remote', serviceTag: 'FTAG1', dbKey: 'rmt:f1' }],
    analysisServers: async () => [], fanFaults: async () => [], powerDb: async () => ({ hourlyStats: () => [] }), inventoryOf: () => null, sensorLatest: () => null, temps: { classify: () => 'cpu', maxAgeOf: () => 15 * MIN } }));
  t.after(() => { PA._setPowerSourcesForTest(null); poller._setOsCollectorForTest(null); poller._setFleetForTest(null); poller._resetForTest(); R._resetPerfRulesForTest(); });
  R._resetPerfRulesForTest();
  R.savePerfRules({ rules: { powerCap: { on: true } } }, { by: 'test' });
  // 이 노드가 판정하던 진행 중 사건(발송 1시간 전 · 재발 억제 720분 안)
  A._resetPerfAlertsForTest();
  const firedAt = Date.now() - HOUR;
  fs.writeFileSync(path.join(DIR, 'bm-perf-alert-state.json'), JSON.stringify({ v: 1, rules: { 'powerCap|vcF|FTAG1': { streak: 4, active: true, firedAt, since: firedAt - 15 * MIN, seenAt: Date.now() - 10 * MIN } }, day: '', counts: {}, sent: [] }));
  const t0 = Date.now();
  const r = await poller.pollBmUsageOnce({ trigger: 'manual' });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
  const lc = A._lastCycleForTest();
  assert.equal(lc.startGiven, true, '폴러가 주기 시작을 넘긴다'); assert.ok(lc.start >= t0 && lc.start <= STATE().cycle.at, '시작 ≤ 판정');
  assert.equal(lc.intervalMs, 600_000, '이 노드 수집 주기(10분)');
  assert.ok(A._cycleEndForTest() != null && A._cycleEndForTest() >= STATE().cycle.at, '수동 주기도 끝을 알린다(판정 뒤)');
  // M3 — 넘어감은 개수만 지난 주기 상태 · 발송 기록에 없음 · M2 묘비
  assert.equal(r.perfAlerts.released, 1); assert.equal(poller.bmUsageStatus().last.perfAlerts.released, 1, '규칙 화면 상태 줄이 읽는 값');
  assert.equal(A.perfAlertStatus().sent.length, 0);
  const tb = STATE().rules['powerCap|vcF|FTAG1'];
  assert.equal(tb.active, false); assert.equal(tb.firedAt, firedAt); assert.ok(tb.tomb);
  // 자동 틱 — 판정 뒤 롤업 보정 · 정리까지 끝난 시각을 알린다(폴러 끝이 아니라 틱 끝)
  A._resetPerfAlertsForTest({ unlink: false });
  assert.equal(A._cycleEndForTest(), null);
  await poller.bmUsageTimerTick();
  assert.ok(A._cycleEndForTest() != null && A._cycleEndForTest() >= STATE().cycle.at, '자동 틱이 끝을 알린다');
  assert.equal(A._lastCycleForTest().startGiven, true);
  // 판정이 없었던 틱(규칙 꺼짐)은 끝을 적지 않는다 — 그 시간은 다음 틈에 든다
  R.savePerfRules({ rules: {} }, { by: 'test' });
  A._resetPerfAlertsForTest({ unlink: false });
  await poller.bmUsageTimerTick();
  assert.equal(A._cycleEndForTest(), null);
});
