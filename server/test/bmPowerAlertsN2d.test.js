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

test('④ Q1 — 상태 파일 손상 뒤 서버 · 랙 항목이 없는 판정(실패 주기의 빈 판정 · 노드 칸만)은 ‘첫 주기는 기준만’ 을 소비하지 않는다', async () => {
  const rules = rulesOf({ powerCap: { sustain: 1, repeatMin: 0 }, collect: { sustain: 1, repeatMin: 0 } });
  const cap = (s) => ({ key: 'K1', name: 'bm-K1', vcenterId: 'vcA', target: { key: 'K1', vcenterId: 'vcA' }, power: { kind: 'server', capHitPct: 98, w: 900, at: s, capW: 900, capPct: 100, capHit: true } });
  const node = { key: '__node__', name: '수집 노드 n', vcenterId: '', collect: { cells: { error: 'true' }, error: 'classify-failed' } };
  for (const [label, first] of [['빈 판정', []], ['노드 칸만', [node]]]) {
    await A._drainPerfAlertsForTest();
    A._resetPerfAlertsForTest();
    const d = depsOf();
    // 손상(재시작 뒤 첫 로드) → 실패 주기의 판정이 먼저
    fs.writeFileSync(FILE, '{broken');
    const r0 = await A.runPerfAlerts(first, { rules, now: NOW, deps: d.deps, intervalMs: 5 * MIN, cycleStartAt: NOW - MIN });
    assert.equal(r0.fires ?? 0, 0, `${label} — 그 판정도 보내지 않는다(기준만)`); assert.equal(d.sends.length, 0);
    assert.equal(STATE().cycle.at, NOW, `${label} — 판정 시각(P2 동작)은 그대로 남긴다`);
    // 다음 정상 주기 — 진행 중이던 걸림을 새 사건으로 보내지 않는다(이 판정이 기준만 잡는다)
    const r1 = await A.runPerfAlerts([cap(NOW + 4 * MIN), node], { rules, now: NOW + 5 * MIN, deps: d.deps, intervalMs: 5 * MIN, cycleStartAt: NOW + 4 * MIN });
    assert.equal(r1.warmup, true, `${label} 뒤 정상 주기가 기준을 잡는다(기준판: warmup false · 발송 1)`);
    const r2 = await A.runPerfAlerts([cap(NOW + 9 * MIN), node], { rules, now: NOW + 10 * MIN, deps: d.deps, intervalMs: 5 * MIN, cycleStartAt: NOW + 9 * MIN });
    await A._drainPerfAlertsForTest();
    assert.equal(r2.fires, 0, '그 뒤에도 같은 사건은 진행 중'); assert.equal(d.sends.length, 0, `${label} — 발송 0`);
  }
  // 서버 항목이 있는 첫 판정은 예전처럼 보호를 소비한다(다음 주기 새 사건은 발송)
  await A._drainPerfAlertsForTest();
  A._resetPerfAlertsForTest();
  const d = depsOf();
  fs.writeFileSync(FILE, '{broken');
  const r0 = await A.runPerfAlerts([cap(NOW - MIN)], { rules, now: NOW, deps: d.deps, intervalMs: 5 * MIN });
  assert.equal(r0.warmup, true);
  const ri = rulesOf({ powerCap: { sustain: 1, repeatMin: 0 }, inlet: { sustain: 1, repeatMin: 0 } });
  const r1 = await A.runPerfAlerts([{ key: 'K2', name: 'bm-K2', vcenterId: 'vcA', target: { key: 'K2', vcenterId: 'vcA' }, power: { kind: 'server', inletWarnC: 27, tempState: 'ok', inletC: 30, tempAt: NOW + 4 * MIN } }], { rules: ri, now: NOW + 5 * MIN, deps: d.deps, intervalMs: 5 * MIN });
  await A._drainPerfAlertsForTest();
  assert.equal(r1.warmup, undefined); assert.equal(r1.fires, 1); assert.equal(d.sends.length, 1);
});

test('⑤ R1 — 손상 뒤 보호는 종류별(수집 노드 칸 · 서버 · 랙): 분류 실패가 이어져도 수집 건강 알림은 둘째 주기부터 나가고 서버 · 랙은 첫 정상 주기에 기준만', async () => {
  const rules = rulesOf({ powerCap: { sustain: 1, repeatMin: 0 }, collect: { sustain: 2, repeatMin: 0 } });
  const cap = (s) => ({ key: 'K1', name: 'bm-K1', vcenterId: 'vcA', target: { key: 'K1', vcenterId: 'vcA' }, power: { kind: 'server', capHitPct: 98, w: 900, at: s, capW: 900, capPct: 100, capHit: true } });
  const node = { key: '__node__', name: '수집 노드 n', vcenterId: '', collect: { cells: { error: 'true' }, error: 'classify-failed' } };
  await A._drainPerfAlertsForTest();
  A._resetPerfAlertsForTest();
  const d = depsOf();
  fs.writeFileSync(FILE, '{broken');
  const run = (k, items) => A.runPerfAlerts(items, { rules, now: NOW + k * 5 * MIN, deps: d.deps, intervalMs: 5 * MIN, cycleStartAt: NOW + k * 5 * MIN - MIN });
  // 분류 실패 3주기(항목은 수집 노드 칸뿐 · 수집 건강 걸림 지속 2) — 첫 주기는 기준만, 둘째 주기에 발화 · 발송
  const f = [];
  for (const k of [0, 1, 2]) { const r = await run(k, [node]); f.push(r); }
  await A._drainPerfAlertsForTest();
  assert.equal(d.sends.length, 1, '수집 건강 알림이 나간다(e50dac58: 정상 주기가 올 때까지 0)'); assert.match(d.sends[0].title, /수집 건강/);
  assert.equal(f[1].fires, 1, '둘째 주기 발화(첫 주기는 지속 1)'); assert.equal(f[1].warmup, undefined, '걸러진 발화가 없으면 warmup 표지 없음');
  // 첫 정상 주기 — 서버 · 랙 쪽은 기준만(진행 중이던 걸림을 새 사건으로 보내지 않는다 — 2225415f: 발송) · 걸러졌으니 warmup 표지
  const r3 = await run(3, [cap(NOW + 14 * MIN), node]);
  assert.equal(r3.warmup, true); assert.equal(r3.warmupHeld, 1); assert.equal(r3.fires, 0);
  const r4 = await run(4, [cap(NOW + 19 * MIN), node]);
  await A._drainPerfAlertsForTest();
  assert.equal(r4.fires, 0); assert.equal(r4.warmup, undefined);
  assert.equal(d.sends.length, 1, '서버 · 랙은 기준만 — 총 발송은 수집 건강 1건');
  // 한 주기에 두 종류가 처음 함께 오면 둘 다 기준만(손상 직후 정상 주기 — 예전과 같음)
  await A._drainPerfAlertsForTest();
  A._resetPerfAlertsForTest();
  const d2 = depsOf();
  fs.writeFileSync(FILE, '{broken');
  const r0 = await A.runPerfAlerts([cap(NOW - MIN), node], { rules: rulesOf({ powerCap: { sustain: 1, repeatMin: 0 }, collect: { sustain: 1, repeatMin: 0 } }), now: NOW, deps: d2.deps, intervalMs: 5 * MIN });
  await A._drainPerfAlertsForTest();
  assert.equal(r0.warmup, true); assert.equal(r0.warmupHeld, 2); assert.equal(d2.sends.length, 0);
});

test('⑥ S5 — 손상 뒤 서버 · 랙 보호는 실제로 판정한 항목만 푼다(넘김 항목은 기준을 잡지 않으므로 풀지 않는다)', async () => {
  const rules = rulesOf({ powerCap: { sustain: 1, repeatMin: 0 } });
  const cap = (s) => ({ key: 'K1', name: 'bm-K1', vcenterId: 'vcA', target: { key: 'K1', vcenterId: 'vcA' }, power: { kind: 'server', capHitPct: 98, w: 900, at: s, capW: 900, capPct: 100, capHit: true } });
  const rel = { key: 'K1', name: 'bm-K1', vcenterId: 'vcA', release: { kind: 'server', reason: 'corp-edge-owned', node: '' } };
  await A._drainPerfAlertsForTest();
  A._resetPerfAlertsForTest();
  const d = depsOf();
  fs.writeFileSync(FILE, '{broken');
  // 손상 직후 첫 주기 — 서버 · 랙 항목이 전부 넘김(이 노드는 판정 노드가 아님)
  const r0 = await A.runPerfAlerts([rel], { rules, now: NOW, deps: d.deps, intervalMs: 5 * MIN });
  assert.equal(r0.fires, 0);
  // 판정 노드가 이 노드로 돌아옴 — 진행 중이던 걸림은 이 판정이 기준만 잡는다(817f770b: 넘김 주기가 보호를 풀어 새 사건으로 발송)
  const r1 = await A.runPerfAlerts([cap(NOW + 4 * MIN)], { rules, now: NOW + 5 * MIN, deps: d.deps, intervalMs: 5 * MIN });
  assert.equal(r1.warmup, true, '넘김만 있던 주기는 보호를 풀지 않는다'); assert.equal(r1.warmupHeld, 1);
  const r2 = await A.runPerfAlerts([cap(NOW + 9 * MIN)], { rules, now: NOW + 10 * MIN, deps: d.deps, intervalMs: 5 * MIN });
  await A._drainPerfAlertsForTest();
  assert.equal(r2.fires, 0); assert.equal(d.sends.length, 0, '발송 0');
  // 같은 주기에 넘김 + 판정 항목이 함께 오면 판정 항목이 보호를 푼다(그 주기 발화는 기준만 — 다음 주기 새 사건은 발송)
  await A._drainPerfAlertsForTest();
  A._resetPerfAlertsForTest();
  const d2 = depsOf();
  fs.writeFileSync(FILE, '{broken');
  const k2 = { ...cap(NOW - MIN), key: 'K2', name: 'bm-K2', target: { key: 'K2', vcenterId: 'vcA' } };
  const q0 = await A.runPerfAlerts([rel, k2], { rules, now: NOW, deps: d2.deps, intervalMs: 5 * MIN });
  assert.equal(q0.warmupHeld, 1);
  const q1 = await A.runPerfAlerts([cap(NOW + 4 * MIN), { ...k2, power: { ...k2.power, at: NOW + 4 * MIN } }], { rules, now: NOW + 5 * MIN, deps: d2.deps, intervalMs: 5 * MIN });
  await A._drainPerfAlertsForTest();
  assert.equal(q1.warmup, undefined); assert.equal(q1.fires, 1, 'K1 은 이 노드가 처음 판정하는 새 사건 — 보호가 풀린 뒤라 발송'); assert.equal(d2.sends.length, 1);
});
