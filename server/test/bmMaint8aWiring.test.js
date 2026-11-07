/**
 * 리눅스 성능 8a단계 — 정비 창 **억제 5종의 실제 배선**(설계 PROFILES §20 ⑲). 고정하는 규약:
 *   ① 알림 발송 억제 — 성능 알림 규칙(perfAlerts.runPerfAlerts 실제 함수 + 실제 판정기 · 창 파일): 창 안 = 기록만(발송 0 · 이슈 0 · 창마다 한 번) ·
 *      창 뒤에도 참이면 그때 1회(제목 ‘정비 창 안부터 초과’) · 창 안에 풀리면 창 뒤 발송 없음 · 임계 초과 알림(notify.runBmUsageAlerts 실제 함수)도 같은 규약
 *   ② 파트 장애 전이 보류 — transition(maintHold): 열린 장애는 닫지도 바꾸지도 않고 사유 maintenance · 새 장애는 열지 않음 · 창 뒤 첫 주기에 평소 판정 ·
 *      partfaultMaintHold(서비스 태그 대응 · 창 판정)
 *   ③ 자동 집중 억제 — startFocusLocal(trigger auto) 은 code 'maintenance' · 수동은 허용 · 인증 정지가 먼저
 *   ④ 수집 중단 — pollBmUsageOnce 가 접속하지 않음 · ‘정비 중’ 은 실패도 성공도 아님(성공률 분모 밖) · 창 안 실패는 따로 · 인증 거부는 inMaint 를 달지 않는다
 *   ⑤ 분모 제외 — 목표선 evaluateGoal(exclude) · 베이스라인 bandOf · slotBands(exclOf)
 *   + 억제 시한 · ‘창 끝 뒤 억제 0’ 점검(auditCycle)
 * 기준 시각: 실제 시각을 정시로 떨어뜨린 기준(창 파일은 실제 시각으로 판정된다 — common.md).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm8awire-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const MIN = 60_000; const HOUR = 3_600_000;
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }
const S = await import('../src/bmusage/maint/schedule.js');
const ST = await import('../src/bmusage/maint/store.js');
const R = await import('../src/bmusage/maint/runtime.js');
const loc = (ms) => S.fmtLocal('Asia/Seoul', ms).replace(' ', 'T');
const T0 = Date.now();
/** 실제 시각 기준 창 하나(지금 −30분 ~ +60분). */
async function addWin(o = {}) {
  return ST.addWindow({ name: '시험 창', reason: '시험', target: { kind: 'server', keys: ['TAGA1'], names: ['bm-a1'] }, vcenterId: 'vcA', tz: 'Asia/Seoul',
    schedule: { kind: 'once', start: loc(T0 - 30 * MIN), end: loc(T0 + 60 * MIN) }, scopes: { alerts: true }, ...o }, { by: 'op', now: T0 });
}
function resetAll() {
  ST._resetMaintStoreForTest(); R._resetMaintRuntimeForTest();
  for (const f of ['maintenance-windows.json', 'maintenance-windows-deployed.json']) { try { fs.unlinkSync(path.join(DIR, f)); } catch { /* */ } }
}

test('① 성능 알림 규칙 — 창 안 기록만(창마다 한 번) · 창 뒤 참이면 1회(창 안부터 초과) · 창 안에 풀리면 없음', async () => {
  resetAll();
  const w = await addWin();
  const A = await import('../src/bmusage/perfAlerts.js');
  A._resetPerfAlertsForTest();
  const sends = []; const issues = []; const focus = [];
  const deps = { alertConfig: async () => ({ channels: { email: { enabled: true } } }), notify: async (al) => { sends.push(al); return ['email:ok']; }, outcome: async () => 'delivered',
    retryDelay: async () => null, applyIssues: async (f) => { issues.push(...f); return { byId: {} }; }, startFocus: async (o) => { focus.push(o); return { ok: true }; }, isMock: async () => false, clock: () => Date.now() };
  const rules = { rules: { use: { on: true, cond: 'sat-err', sustain: 1, repeatMin: 0, channels: ['email'], issue: true, autoFocus: false, corpsOff: [] } }, daily: { alerts: 50, issues: 20, autoFocus: 10 }, focus: { autoCorps: [] } };
  const item = { key: 'TAGA1', name: 'bm-a1', vcenterId: 'vcA', target: { key: 'TAGA1', vcenterId: 'vcA' }, entry: { verdict: 'saturated', line: 'disk' } };
  const occ = (await R.maintJudge({ now: T0 })).stateFor({ key: 'TAGA1', vcenterId: 'vcA' }, T0);
  assert.equal(occ.scopes.alerts, true, '시험 창이 지금 덮는다');
  const end = occ.until.alerts;
  // 창 안 2주기 — 발송 0 · 이슈 0 · 기록 1(창마다 한 번)
  let r = await A.runPerfAlerts([item], { rules, now: T0, deps });
  await A._drainPerfAlertsForTest();
  assert.equal(r.maintenance, 1); assert.equal(sends.length, 0); assert.equal(issues.length, 0);
  r = await A.runPerfAlerts([item], { rules, now: T0 + 5 * MIN, deps });
  assert.equal(r.maintHeld, 1, '같은 창 반복은 세지 않는다'); assert.equal(sends.length, 0);
  const st = A.perfAlertStatus();
  assert.equal(st.sent.filter((x) => x.result === 'maintenance').length, 1);
  assert.deepEqual(st.sent.find((x) => x.result === 'maintenance').maint.ids, [w.id]);
  // 창 뒤 — 아직 참 → 1회(창 안부터 초과) · 다음 주기는 진행 중(재발송 없음)
  r = await A.runPerfAlerts([item], { rules, now: end + MIN, deps });
  await A._drainPerfAlertsForTest();
  assert.equal(r.afterMaint, 1); assert.equal(sends.length, 1);
  assert.match(sends[0].title, /정비 창 안부터 초과/);
  r = await A.runPerfAlerts([item], { rules, now: end + 6 * MIN, deps });
  assert.equal(sends.length, 1, '창 뒤 발송은 1회');
  assert.equal(R.maintStats().byWindow[w.id].alerts, 1); assert.equal(R.maintStats().byWindow[w.id].after, 1);
  // 창 안에 풀리면 창 뒤 발송 없음
  A._resetPerfAlertsForTest();
  sends.length = 0;
  await A.runPerfAlerts([item], { rules, now: T0, deps });
  await A.runPerfAlerts([{ ...item, entry: { verdict: 'ok' } }], { rules, now: T0 + 5 * MIN, deps });
  await A.runPerfAlerts([{ ...item, entry: { verdict: 'ok' } }], { rules, now: end + MIN, deps });
  await A._drainPerfAlertsForTest();
  assert.equal(sends.length, 0);
});

test('① 임계 초과 알림(v2.551 notify) — 같은 규약(창 안 보내지 않음 · 창 뒤 1회 · 표지는 발화 없는 주기에도 유지)', async () => {
  const H = (await import('../src/bmusage/maint/alertHold.js')).holdThresholdFires;
  const { evaluateRows } = await import('../src/bmusage/alertRules.js');
  const cfg = { pct: 90, sustainMin: 0, repeatHours: 6, intervalMs: 300_000 };
  const inWin = { scopes: { alerts: true }, until: { alerts: T0 + HOUR }, windows: [{ id: 'mw-x1', scopes: ['alerts'] }] };
  let state = {};
  const step = (v, now, ms) => { const { next, fires } = evaluateRows([{ key: 'K', vcenterId: 'vcA', cpu_pct: v }], state, cfg, now); const h = H({ prev: state, next, fires, now, stateOf: () => ms }); state = next; return h; };
  let h = step(95, T0, inWin);
  assert.equal(h.send.length, 0); assert.equal(h.heldNew, 1); assert.equal(state['K|cpu_pct'].notifiedAt, null); assert.deepEqual(state['K|cpu_pct'].maint.ids, ['mw-x1']);
  h = step(96, T0 + 5 * MIN, inWin);
  assert.equal(h.send.length, 0); assert.equal(h.heldNew, 0, '같은 창 두 번 세지 않는다');
  h = step(97, T0 + 2 * HOUR, null);
  assert.equal(h.send.length, 1); assert.equal(h.send[0].afterMaint, true);
  const { alertOf } = await import('../src/bmusage/alertRules.js');
  assert.match(alertOf(h.send[0]).title, /정비 창 안부터 초과/);
  h = step(97, T0 + 2 * HOUR + 5 * MIN, null);
  assert.equal(h.send.length, 0, '이미 보냄 — 재알림 억제');
  // 실제 함수 — 창 파일이 덮는 서버의 초과는 보내지 않는다(채널 없음 → 네트워크 없음)
  resetAll();
  await addWin();
  const N = await import('../src/bmusage/notify.js');
  N._resetAlertStateForTest();
  const out = await N.runBmUsageAlerts([{ key: 'TAGA1', name: 'bm-a1', vcenterId: 'vcA', cpu_pct: 99 }], { alertEnabled: true, alertPct: 90, alertSustainMin: 0, alertRepeatHours: 6, intervalMs: 300_000 });
  assert.equal(out.sent, 0); assert.equal(out.maint.held, 1);
  const out2 = await N.runBmUsageAlerts([{ key: 'OTHER', name: 'bm-b', vcenterId: 'vcA', cpu_pct: 99 }], { alertEnabled: true, alertPct: 90, alertSustainMin: 0, alertRepeatHours: 6, intervalMs: 300_000 });
  assert.equal(out2.sent, 1, '창 밖 서버는 보낸다');
});

test('② 파트 장애 전이 보류 — 닫지도 바꾸지도 열지도 않는다 · 창 뒤 첫 주기 평소 판정 · 서비스 태그 대응', async () => {
  const { transition } = await import('../src/partfault/transition.js');
  const open = [{ agent: 'edge-a', partKey: 'p1', deviceId: 'd1', kind: 'disk', state: 'fault', firstSeenAt: 1 }];
  const observed = [
    { agent: 'edge-a', partKey: 'p1', deviceId: 'd1', kind: 'disk', state: 'ok' },      // 열린 장애가 ok — 평소면 닫힘
    { agent: 'edge-a', partKey: 'p2', deviceId: 'd1', kind: 'psu', state: 'fault' },    // 새 장애 — 평소면 열림
    { agent: 'edge-a', partKey: 'p3', deviceId: 'd2', kind: 'psu', state: 'fault' },    // 다른 장비 — 그대로 열림
  ];
  const scan = { deviceOk: { 'edge-a|d1': true, 'edge-a|d2': true }, agentsReported: new Set(['', 'edge-a']) };
  const held = transition({ open, observed, scan: { ...scan, maintHold: new Set(['edge-a|d1']) }, now: 10 });
  assert.equal(held.closed.length, 0); assert.equal(held.held[0].holdReason, 'maintenance'); assert.equal(held.held[0].maintObserved, 'ok');
  assert.deepEqual(held.opened.map((x) => x.partKey), ['p3']); assert.equal(held.maintDeferred.length, 1); assert.equal(held.stats.heldMaintenance, 1);
  const after = transition({ open, observed, scan, now: 20 });
  assert.deepEqual(after.closed.map((x) => x.partKey), ['p1']); assert.deepEqual(after.opened.map((x) => x.partKey).sort(), ['p2', 'p3']);
  // 관측 목록에 없는 열린 장애도 창 안이면 maintenance
  const miss = transition({ open, observed: [], scan: { ...scan, maintHold: new Set(['edge-a|d1']) }, now: 30 });
  assert.equal(miss.held[0].holdReason, 'maintenance');
  // 보류 집합 — 서비스 태그로 서버에 대응 · ② hold 를 켠 창만
  resetAll();
  await addWin({ scopes: { hold: true } });
  const P = await import('../src/bmusage/maint/partfaultHold.js');
  const targets = [{ agent: 'edge-a', key: 'TAGA1', serviceTag: 'TAGA1', vcenterId: 'vcA' }];
  const devs = [{ scope: 'idrac', agent: 'Edge-A', deviceId: 'd1', deviceKey: 'taga1' }, { scope: 'idrac', agent: 'edge-a', deviceId: 'd2', deviceKey: 'OTHER' }, { scope: 'storage', agent: 'edge-a', deviceId: 'd3', deviceKey: 'TAGA1' }];
  const r = await P.partfaultMaintHold(devs, { deps: { targets } });
  assert.deepEqual([...r.hold], ['edge-a|d1']);
  resetAll();
  await addWin({ scopes: { alerts: true } });
  assert.equal((await P.partfaultMaintHold(devs, { deps: { targets } })).hold.size, 0, '② 를 켜지 않은 창은 보류하지 않는다');
  // ② 를 켠 창이 다른 서버에 있어도 — 알림만 켠 창의 서버는 보류하지 않는다(변이 M20)
  await addWin({ scopes: { hold: true }, target: { kind: 'server', keys: ['OTHER'], names: ['x'] } });
  const r2 = await P.partfaultMaintHold(devs, { deps: { targets: [...targets, { agent: 'edge-a', key: 'OTHER', serviceTag: 'OTHER', vcenterId: 'vcA' }] } });
  assert.deepEqual([...r2.hold], ['edge-a|d2'], '② 창의 서버(OTHER)만');
  // 폴러가 집합을 transition 에 넘긴다(소스 — 실제 파트 장애 폴러는 iDRAC 스캔이 필요해 여기서 돌리지 않는다)
  const src = fs.readFileSync(new URL('../src/partfault/poller.js', import.meta.url), 'utf8');
  assert.match(src, /partfaultMaintHold\(\[\.\.\.observed, \.\.\.prev\]\)/); assert.match(src, /maintHold: maint\.hold/);
});

test('③ 자동 집중 억제 — auto 는 maintenance(실제 판정기 · 창 파일) · 수동은 허용 · 인증 정지가 먼저', async (t) => {
  resetAll();
  await addWin({ scopes: { focus: true } });
  const F = await import('../src/bmusage/focus/run.js');
  t.after(() => F._setFocusDepsForTest({}));
  const base = { now: () => Date.now(), osAuthStop: async () => null, idracAuthStop: async () => null, loadRules: async () => ({ focus: {} }) };
  F._setFocusDepsForTest(base);   // maintState 는 기본(실제 판정기)
  const target = { key: 'TAGA1', vcenterId: 'vcA', paths: ['os'], osHost: { host: '127.0.0.1', port: 9 } };
  const auto = await F.startFocusLocal({ target, trigger: 'auto', reason: '규칙' });
  assert.equal(auto.code, 'maintenance'); assert.ok(auto.maint.until > Date.now());
  const manual = await F.startFocusLocal({ target, trigger: 'manual', reason: '수동 확인' });
  assert.notEqual(manual.code, 'maintenance', '수동 집중은 허용');
  F._resetFocusForTest();
  F._setFocusDepsForTest({ ...base, osAuthStop: async () => ({ attempts: 3 }) });
  assert.equal((await F.startFocusLocal({ target: { ...target, key: 'TAGA1' }, trigger: 'auto', reason: 'r' })).code, 'auth-stopped', '인증 정지가 먼저');
  // 다른 서버는 억제 없음
  F._setFocusDepsForTest(base);
  assert.notEqual((await F.startFocusLocal({ target: { ...target, key: 'OTHER' }, trigger: 'auto', reason: 'r' })).code, 'maintenance');
});

test('④ 수집 중단 — 접속하지 않음 · 정비 중은 성공률 분모 밖 · 창 안 실패는 따로 · 인증 거부는 표시하지 않음', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  resetAll();
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [] }));
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [{ id: 'o-a1', name: 'bm-a1', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: [] }] }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true }, osSsh: true, idracTelemetry: false }));
  const poller = await import('../src/bmusage/poller.js');
  poller._setFleetForTest(async () => ({ bareMetal: [{ serverId: 's-a1', name: 'bm-a1', serviceTag: 'TAGA1', vcenterId: 'vcA' }], virtualizationHosts: [] }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  t.after(() => { poller._setFleetForTest(null); poller._resetForTest(); });
  await addWin({ scopes: { collect: true } });
  const r = await poller.pollBmUsageOnce({ trigger: 'manual' });
  assert.equal(r.maintSkipped, 1); assert.equal(r.okCount, 0); assert.equal(r.failCount, 0, '정비 중은 실패가 아니다');
  let h = poller.collectHealthNow();
  assert.equal(h.node.maint.skipped, 1); assert.equal(h.node.servers, 0); assert.equal(h.node.successPct, null, '분모 0 = 모름(100% 도 0% 도 아니다)');
  assert.equal(h.node.maint.leak, 0, '창 끝 뒤 억제 0');
  assert.ok(poller.usageDetailFor('TAGA1').maintSkip, '상세에 정비 중 표지');
  // 수집 중단을 끈 창(알림만) — 수집은 하고, 실패(연결 거부)는 창 안 실패로 따로 센다
  resetAll();
  await addWin({ scopes: { alerts: true } });
  const r2 = await poller.pollBmUsageOnce({ trigger: 'manual' });
  assert.equal(r2.maintSkipped, undefined);
  h = poller.collectHealthNow();
  assert.equal(h.node.maint.failInWindow, 1); assert.equal(h.node.fail, 0); assert.equal(h.node.reasons.length, 0);
  // 인증 거부는 창과 무관 — 표시하지 않는다(실패로 센다)
  const marked = poller.markInMaint([
    { ok: false, target: { key: 'A' }, os: { ok: false, error: 'All configured authentication methods failed' } },
    { ok: false, target: { key: 'B' }, os: { ok: false, authStopped: { attempts: 3 } } },
    { ok: false, target: { key: 'C' }, os: { ok: false, error: 'connect ECONNREFUSED' } },
    { ok: true, target: { key: 'D' } },
  ], () => ({ active: true, windows: [{ id: 'mw-z' }] }));
  assert.deepEqual(marked.map((x) => x.target.key), ['C']);
});

test('⑤ 분모 제외 — 목표선 · 베이스라인 띠 · 슬롯 띠', async () => {
  const L = await import('../src/bmusage/slo.js');
  const B = await import('../src/bmusage/baseline.js');
  const from = Date.UTC(2026, 10, 1); const step = 5 * MIN;
  const pts = Array.from({ length: 24 }, (_, i) => ({ t: from + i * step, avg: i >= 6 && i < 12 ? 99 : 10 }));
  const goal = { metric: 'cpu_pct', basis: 'avg', op: 'lt', value: 80, objectivePct: 99 };
  const plain = L.evaluateGoal(goal, pts, { from, to: from + 24 * step, stepMs: step, cycleMs: step, now: from + 24 * step });
  const ex = L.evaluateGoal(goal, pts, { from, to: from + 24 * step, stepMs: step, cycleMs: step, now: from + 24 * step, exclude: [{ from: from + 6 * step, to: from + 12 * step }] });
  assert.equal(plain.status, 'missed'); assert.equal(plain.valid, 24);
  assert.equal(ex.status, 'met'); assert.equal(ex.valid, 18); assert.equal(ex.maintenance.excluded, 6); assert.equal(ex.maintenance.source, 'windows');
  assert.equal(ex.expected, plain.expected - 6, '기대 주기에서도 뺀다'); assert.equal(ex.missing, 0, '뺀 구간을 결측으로 세지 않는다');
  // 베이스라인 — 창이 걸친 주는 표본에서 빠진다(값도 결측도 아니다)
  const weekly = [{ h: 1, avg: 20, samples: 12 }, { h: 2, avg: 22, samples: 12 }, { h: 3, avg: 95, samples: 12, excluded: true }, { h: 4, avg: 21, samples: 12 }, { h: 5, avg: 19, samples: 12 }];
  const b = B.bandOf(weekly, { bandPct: 40, minWeeks: 4, maxMissingPct: 25, expectedPerHour: 12 });
  assert.equal(b.weeks, 4); assert.equal(b.excluded, 1); assert.equal(b.mean, 20.5); assert.equal(b.missingPct, 0);
  const few = B.bandOf(weekly.slice(0, 4).map((w, i) => (i ? { ...w, excluded: true } : w)), { minWeeks: 4, expectedPerHour: 12 });
  assert.equal(few.reason, 'few-weeks'); assert.equal(few.excluded, 3);
  // 슬롯 띠 — exclOf 가 준 구간의 주를 뺀다(가짜 기간 파일)
  B._resetBaselineForTest();
  const now = Date.UTC(2026, 10, 30, 10, 30); const hours = B.slotHours(now, 4);
  const rows = hours.map((h, i) => ({ key: 'K', h, cpu_sum: (i === 0 ? 95 : 20) * 12, cpu_n: 12 }));
  const forEachPeriod = async (_f, _a, _b, fn) => fn({ prepare: () => ({ all: () => rows }) });
  const cfg = { weeks: 4, bandPct: 40, minWeeks: 3, maxMissingPct: 25 };
  const bandsEx = await B.slotBands({ cfg, now, intervalMs: 300_000, deps: { forEachPeriod }, exclOf: () => [{ from: hours[0], to: hours[0] + HOUR }], exclSig: 'x' });
  assert.equal(bandsEx.get('K').get('cpu_pct').mean, 20); assert.equal(bandsEx.get('K').get('cpu_pct').excluded, 1);
  B._resetBaselineForTest();
  const bandsAll = await B.slotBands({ cfg, now, intervalMs: 300_000, deps: { forEachPeriod } });
  assert.ok(bandsAll.get('K').get('cpu_pct').mean > 30, '빼지 않으면 정비 창 값이 평균을 올린다');
});

test('억제 시한 — ‘창 끝 뒤 억제 0’ 점검: 시한을 넘긴 적용 · 지금 판정이 억제가 아닌 적용을 센다', async () => {
  resetAll();
  const w = await addWin({ scopes: { alerts: true } });
  const occ = (await R.maintJudge({ now: T0 })).stateFor({ key: 'TAGA1', vcenterId: 'vcA' }, T0);
  R.noteApplied('alerts', 'TAGA1', occ.until.alerts, [w.id], T0);                  // 정상
  let a = await R.auditCycle({ targetsByKey: new Map([['TAGA1', { key: 'TAGA1', vcenterId: 'vcA' }]]) });
  assert.deepEqual(a, { checked: 1, leak: 0 });
  R.noteApplied('alerts', 'TAGA1', occ.until.alerts, [w.id], occ.until.alerts + MIN);   // 시한 뒤 적용(버그 흉내)
  R.noteApplied('collect', 'TAGA1', occ.until.alerts, [w.id], T0);                    // 그 창은 ④ 를 켜지 않았다(판정과 어긋남)
  a = await R.auditCycle({ targetsByKey: new Map([['TAGA1', { key: 'TAGA1', vcenterId: 'vcA' }]]) });
  assert.deepEqual(a, { checked: 2, leak: 2 });
  assert.equal(R.maintStats().leak.n, 2);
  // 겹친 창 — 짧은 창의 시한을 넘겨 적용했지만 긴 창이 아직 덮는다: 판정은 억제여도 ‘시한을 넘긴 적용’ 은 센다(변이 M28)
  await addWin({ name: '긴 창', schedule: { kind: 'once', start: loc(T0 - 30 * MIN), end: loc(T0 + 3 * HOUR) }, scopes: { alerts: true } });
  R.noteApplied('alerts', 'TAGA1', occ.until.alerts, [w.id], occ.until.alerts + MIN);
  a = await R.auditCycle({ targetsByKey: new Map([['TAGA1', { key: 'TAGA1', vcenterId: 'vcA' }]]) });
  assert.deepEqual(a, { checked: 1, leak: 1 });
});
