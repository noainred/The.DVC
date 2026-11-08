/**
 * 반증 n2 3차 재확인(기준판 f4f86837) 확정분 고정 — 둘 다 ‘지속을 한 번 1부터 다시 세는 지연’:
 *   ① P1 재시작 직후에도 판정 뒤 꼬리(롤업 보정 · 정리)는 틈이 아니다 — 꼬리가 긴 틱의 실제 끝을 상태 파일(cycle.endAt)에 남긴다(직렬 큐 · 짧은 꼬리는 쓰지 않음).
 *      기준판: 흡기 지속 2 · 주기 5분 · 꼬리 14분 · 꼬리 끝 직후 재시작 → holdReset 1 · 한 주기 늦게 발화.
 *   ② P2 판정 없는 실패 주기(수집 건강 규칙 꺼짐)도 판정 주기다 — 빈 항목으로 판정해 전력 상태는 보류 1주기 · 끝 시각을 남긴다.
 *   ③ (의심) 자동 틱의 꼬리 도중 수동 수집이 먼저 판정 · 끝 알림을 해도 자동 틱의 실제 끝(늦은 쪽)을 남긴다.
 * 기준 시각: 실제 시각을 정시로 내린 뒤 −20분(common.md).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmpown2d-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const MIN = 60_000; const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 20 * MIN;

const PA = await import('../src/bmusage/powerAlerts.js');
const A = await import('../src/bmusage/perfAlerts.js');
const R = await import('../src/bmusage/perfRules.js');
const FILE = path.join(DIR, 'bm-perf-alert-state.json');
const STATE = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const rulesOf = (on = {}) => R.normalizeRules({ rules: Object.fromEntries(Object.entries(on).map(([id, x]) => [id, { on: true, channels: ['email'], ...x }])) }, { strict: true }).value;
function depsOf() {
  const sends = [];
  return { sends, deps: { alertConfig: async () => ({ channels: { email: { enabled: true } } }), notify: async (al) => { sends.push(al); return ['email:ok']; }, outcome: async () => 'delivered',
    retryDelay: async () => null, applyIssues: async () => ({ byId: {} }), startFocus: async () => ({ ok: true }), isMock: async () => false, clock: () => NOW, maintJudge: async () => null } };
}
const inl = (s) => ({ key: 'K1', name: 'bm-K1', vcenterId: 'vcA', target: { key: 'K1', vcenterId: 'vcA' }, power: { kind: 'server', inletWarnC: 27, tempState: 'ok', inletC: 30, tempAt: s } });

test('① P1 — 재시작 직후에도 판정 뒤 꼬리는 틈이 아니다(긴 꼬리의 실제 끝을 상태 파일에) · 짧은 꼬리는 쓰지 않는다', async () => {
  const rules = rulesOf({ inlet: { sustain: 2, repeatMin: 0 } });
  const d = depsOf();
  const run = (S, J) => A.runPerfAlerts([inl(J - 30_000)], { rules, now: J, deps: d.deps, intervalMs: 5 * MIN, cycleStartAt: S });
  // 주기 5분 · 소요 1분 · 판정 뒤 꼬리 14분 · 꼬리 끝 직후 재시작(정지 1분 + 첫 틱 45초)
  A._resetPerfAlertsForTest();
  await run(NOW, NOW + MIN);
  const E0 = NOW + 15 * MIN;
  await A.notePerfCycleEnd(E0, { sinceAt: NOW });
  await A._drainPerfAlertsForTest();
  assert.equal(STATE().cycle.endAt, E0, '긴 꼬리의 실제 끝을 상태 파일에 남긴다');
  A._resetPerfAlertsForTest({ unlink: false });   // 재시작 — 메모리 끝 시각 사라짐
  const S1 = E0 + 1.75 * MIN;
  let r = await run(S1, S1 + MIN);
  assert.equal(r.counts.holdReset, 0, '꼬리는 틈이 아니다(기준판 1 — gap 10.75분 > 10분)'); assert.equal(r.fires, 1, '2주기째 발화(기준판 3주기째)');
  // 재시작 없이도 같은 결과(대조)
  A._resetPerfAlertsForTest();
  await run(NOW, NOW + MIN); await A.notePerfCycleEnd(E0, { sinceAt: NOW });
  r = await run(E0 + 5 * MIN, E0 + 6 * MIN);
  assert.equal(r.fires, 1); assert.equal(r.counts.holdReset, 0);
  // 짧은 꼬리(30초)는 상태 파일을 다시 쓰지 않는다(주기마다 대량 쓰기를 늘리지 않게 — 오차 < 60초)
  await A._drainPerfAlertsForTest();   // 앞 단계 발송 결과 기록이 끝난 뒤(그 쓰기와 섞지 않게)
  A._resetPerfAlertsForTest();
  await run(NOW, NOW + MIN);
  await A._drainPerfAlertsForTest();
  const before = fs.readFileSync(FILE, 'utf8');
  await A.notePerfCycleEnd(NOW + MIN + 30_000, { sinceAt: NOW });
  await A._drainPerfAlertsForTest();
  assert.equal(fs.readFileSync(FILE, 'utf8'), before, '짧은 꼬리 — 쓰기 없음');
  assert.equal(A._cycleEndForTest(), NOW + MIN + 30_000, '메모리에는 남긴다');
  // 재시작 뒤 진짜 틈(1시간)은 여전히 끊는다
  A._resetPerfAlertsForTest();
  await run(NOW, NOW + MIN); await A.notePerfCycleEnd(E0, { sinceAt: NOW }); await A._drainPerfAlertsForTest();
  A._resetPerfAlertsForTest({ unlink: false });
  r = await run(E0 + HOUR, E0 + HOUR + MIN);
  assert.equal(r.counts.holdReset, 1); assert.equal(r.fires, 0);
});

test('③ 의심 — 자동 틱 꼬리 도중 수동 수집이 먼저 판정 · 끝을 알려도 자동 틱의 실제 끝(늦은 쪽)을 남긴다', async () => {
  const rules = rulesOf({ inlet: { sustain: 2, repeatMin: 0 } });
  const d = depsOf();
  A._resetPerfAlertsForTest();
  // 자동 틱: 시작 NOW · 판정 +1분 → 꼬리 14분(끝 +15분). 그 사이 수동 수집: 시작 +2분 · 판정 +2.5분 · 끝 +3분
  await A.runPerfAlerts([inl(NOW + 30_000)], { rules, now: NOW + MIN, deps: d.deps, intervalMs: 5 * MIN, cycleStartAt: NOW });
  await A.runPerfAlerts([inl(NOW + 30_000)], { rules, now: NOW + 2.5 * MIN, deps: d.deps, intervalMs: 5 * MIN, cycleStartAt: NOW + 2 * MIN });   // 같은 표본(보류) — 지속 1
  await A.notePerfCycleEnd(NOW + 3 * MIN, { sinceAt: NOW + 2 * MIN });
  await A.notePerfCycleEnd(NOW + 15 * MIN, { sinceAt: NOW });
  assert.equal(A._cycleEndForTest(), NOW + 15 * MIN, '자동 틱의 실제 끝(기준판: 수동 끝 +3분에 머묾)');
  // 늦은 쪽 유지 — 먼저 끝난 것이 나중에 알려져도 끝을 앞당기지 않는다
  await A.notePerfCycleEnd(NOW + 4 * MIN, { sinceAt: NOW + 2 * MIN });
  assert.equal(A._cycleEndForTest(), NOW + 15 * MIN);
  // 다음 자동 틱(끝 + 5분) — 틈 아님
  const r = await A.runPerfAlerts([inl(NOW + 20 * MIN)], { rules, now: NOW + 21 * MIN, deps: d.deps, intervalMs: 5 * MIN, cycleStartAt: NOW + 20 * MIN });
  assert.equal(r.counts.holdReset, 0, '(기준판 1 — gap 12분 > 10분)'); assert.equal(r.fires, 1, '지속 2 — 발화(기준판 1부터 다시 셈)');
  // 판정이 없었던 틱(시작 뒤 판정 없음)은 끝을 적지 않는다
  await A.notePerfCycleEnd(NOW + 40 * MIN, { sinceAt: NOW + 30 * MIN });
  assert.notEqual(A._cycleEndForTest(), NOW + 40 * MIN);
});

test('② P2 — 수집 건강 규칙이 꺼진 노드의 실패 주기도 판정 주기(전력 상태 보류 1주기 · 끝 시각) — 폴러 실제 경로', async (t) => {
  let sqlite = null; try { sqlite = await import('node:sqlite'); } catch { sqlite = null; }
  if (!sqlite) return t.skip('node:sqlite 없음');
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [] }));
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [{ id: 'o-f1', name: 'bm-f1', host: '127.0.0.5', port: 9, username: 'mon', password: 'pw', mounts: [] }] }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcF: true }, osSsh: true, idracTelemetry: false, intervalMs: 300_000 }));
  const poller = await import('../src/bmusage/poller.js');
  (await import('../src/bmusage/settings.js'))._resetForTest();
  // 분류 실패 주기(대상을 모름) — 전력 규칙만 켜짐(수집 건강 꺼짐)
  poller._setFleetForTest(async () => { throw new Error('인벤토리 응답 없음(시험)'); });
  t.after(() => { poller._setFleetForTest(null); poller._resetForTest(); R._resetPerfRulesForTest(); });
  R._resetPerfRulesForTest();
  R.savePerfRules({ rules: { inlet: { on: true, sustain: 2 } } }, { by: 'test' });
  A._resetPerfAlertsForTest();
  // 직전 주기에 지속 1이던 흡기 상태
  fs.writeFileSync(FILE, JSON.stringify({ v: 1, rules: { 'inlet|vcF|FTAG1': { streak: 1, active: false, firedAt: null, since: Date.now() - 6 * MIN, seenAt: Date.now() - 6 * MIN, obs: 1 } }, day: '', counts: {}, sent: [],
    cycle: { at: Date.now() - 6 * MIN, intervalMs: 300_000 } }));
  const t0 = Date.now();
  const r = await poller.pollBmUsageOnce({ trigger: 'manual' });
  assert.equal(r.ok, false); assert.match(r.reason, /대상 분류/);
  const st = STATE();
  assert.equal(st.rules['inlet|vcF|FTAG1'].holdN, 1, '실패 주기 = 보류 1주기(기준판: 판정 없음)'); assert.equal(st.rules['inlet|vcF|FTAG1'].streak, 1, '지속은 잇는다');
  assert.ok(st.cycle.at >= t0, '실패 주기의 판정 시각'); assert.equal(A._lastCycleForTest().startGiven, true);
  assert.ok(A._cycleEndForTest() != null && A._cycleEndForTest() >= st.cycle.at, '실패 주기도 끝 시각을 남긴다');
  assert.equal(poller.bmUsageStatus().last.collectAlert, undefined, '수집 건강 규칙이 꺼져 있으면 그 칸은 그대로 없음');
  assert.equal(A.perfAlertStatus().sent.length, 0);
});
