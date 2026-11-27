/**
 * 반증 n2(다음 점검 ②③ 검토 — 기준판 3159995f) 확정분 고정:
 *   ① F1 랙 배치에 있는데 서버 목록에 없는 서버도 랙 서버 수에 든다(미측정 not-target) — 부분 합 → 판정 보류 · 진행 중 사건 해소 아님 · 화면과 알림이 같은 집계 · 이름은 싣지 않는다
 *   ② F2 랙 서버 일부만 정비 창 안이면 억제하지 않고 보낸다(본문에 창 안 서버) · 전부 창 안이면 억제 · 창을 읽을 수 없는 배치 서버가 있으면 억제하지 않는다
 *   ③ F7 랙 억제 구간은 창들의 교집합 — ‘창 끝 뒤 억제’ 점검 거짓 경고(over-cap) 0
 *   ④ F3 시험 실행 · 폴러 상태가 전력 판정 입력 실패 · 판정 보류 수를 0건과 가른다
 *   ⑤ F4 판정 노드 함수 하나(judgeOf · rackJudgeOf) — 중앙 원천 + 엣지 대상 · 엣지 사본 + 이 노드 대상 = 판정 없음 + 사유 · 화면과 알림이 같은 함수 · S1(법인을 엣지가 맡은 서버) 이중 판정 없음
 *   ⑥ F5 보류에 시한 — 지속 주기 수보다 긴 보류 뒤의 표본은 1부터(2차 M1 — 주기 수) · ‘처음 성립’ 도 그때부터 · 짧은 보류는 잇는다
 * 기준 시각: 실제 시각을 정시로 내린 뒤 −20분(common.md) — 정비 창 · 폴러 시험만 Date.now()(제품이 실제 시각으로 판정).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmpown2-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const MIN = 60_000; const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 20 * MIN;
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }

const PA = await import('../src/bmusage/powerAlerts.js');
const AG = await import('../src/bmusage/powerAgg.js');
const A = await import('../src/bmusage/perfAlerts.js');
const R = await import('../src/bmusage/perfRules.js');
const STATE = () => JSON.parse(fs.readFileSync(path.join(DIR, 'bm-perf-alert-state.json'), 'utf8'));
const JCTX = (o = {}) => async () => ({ self: 'n2', isEdge: false, corpOwner: () => '', ...o });

function sourcesOf({ measured = [], analysis = [], inv = {}, sensors = {} } = {}) {
  return async () => ({
    measured: async () => measured, analysisServers: async () => analysis, fanFaults: async () => [],
    powerDb: async () => ({ hourlyStats: () => [] }),
    inventoryOf: (a, regId) => inv[String(a?.id || regId || '')] || null,
    sensorLatest: (id) => sensors[id] || null,
    temps: { classify: (nm) => (/inlet/i.test(nm) ? 'inlet' : 'cpu'), maxAgeOf: () => 15 * MIN },
  });
}
const rulesOf = (on = {}, extra = {}) => R.normalizeRules({ rules: Object.fromEntries(Object.entries(on).map(([id, x]) => [id, { on: true, channels: ['email'], ...x }])), ...extra }, { strict: true }).value;
function depsOf(o = {}) {
  const sends = []; const issues = [];
  return { sends, issues,
    deps: { alertConfig: async () => ({ channels: { email: { enabled: true } } }), notify: async (al) => { sends.push(al); return ['email:ok']; }, outcome: async () => 'delivered',
      retryDelay: async () => null, applyIssues: async (f) => { issues.push(...f); return { byId: {} }; }, startFocus: async () => ({ ok: true }), isMock: async () => false, clock: () => NOW,
      maintJudge: async () => null, ...o } };
}
const meas = (id, w, vc, at = NOW - MIN, source = 'idrac', extra = {}) => ({ serverId: id, watts: w, ts: at, vcenterId: vc, source, ...extra });

test('① F1 — 배치 3대 · 목록 2대: 랙 서버 3 · 측정 2 · 부분 합 → 보류(진행 중 사건 유지) · 화면과 알림이 같은 집계 · 목록 밖 서버 이름 없음', async () => {
  const rules = rulesOf({ rack: { sustain: 1 } }, { power: { racksText: 'vcA,R1,1.0,K1 K2 K3' } });
  const tg = (k) => ({ key: k, name: `bm-${k}`, vcenterId: 'vcA', idrac: { regId: `r${k}` } });
  const all3 = sourcesOf({ measured: [meas('rK1', 400, 'vcA'), meas('rK2', 400, 'vcA'), meas('rK3', 300, 'vcA')], analysis: [{ id: 'rK1' }, { id: 'rK2' }, { id: 'rK3' }] });
  const two = sourcesOf({ measured: [meas('rK1', 400, 'vcA', NOW + MIN), meas('rK2', 400, 'vcA', NOW + MIN)], analysis: [{ id: 'rK1' }, { id: 'rK2' }] });
  AG._resetPowerAggForTest(); A._resetPerfAlertsForTest();
  const d = depsOf();
  // 앞 주기: 세 대 다 대상 · 1.1 kW / 1.0 kW → 초과 → 발송(진행 중 사건)
  const it3 = await PA.powerAlertItems({ targets: ['K1', 'K2', 'K3'].map(tg), rules, now: NOW, deps: { sources: all3, judgeCtx: JCTX() } });
  const r3 = it3.find((x) => x.power.kind === 'rack');
  assert.equal(r3.power.servers, 3); assert.equal(r3.power.marginPct, -10); assert.equal(r3.power.low, true);
  await A.runPerfAlerts(it3, { rules, now: NOW, deps: d.deps });
  assert.equal(STATE().rules['rack|vcA|rack:vcA|R1'].active, true);
  // 이번 주기: K3 이 이 노드 대상에서 빠졌다(엣지 위임 · 키 충돌 제외 · 법인 끔 · 등록 삭제)
  const it2 = await PA.powerAlertItems({ targets: ['K1', 'K2'].map(tg), rules, now: NOW + 5 * MIN, deps: { sources: two, judgeCtx: JCTX() } });
  const r2 = it2.find((x) => x.power.kind === 'rack');
  assert.equal(r2.power.servers, 3, '배치 서버 수(예전 2)'); assert.equal(r2.power.measured, 2); assert.equal(r2.power.notTarget, 1);
  assert.equal(r2.power.marginPartial, true); assert.equal(r2.power.marginPct, null, '부분 합으로 여유를 내지 않는다(예전 20%)');
  assert.equal(PA.powerCondition('rack', r2), null, '보류(예전 false — 정상)');
  assert.ok(r2.members.some((m) => m.key === 'K3' && m.unknown), '창을 읽을 수 없는 배치 서버');
  const out = await A.runPerfAlerts(it2, { rules, now: NOW + 5 * MIN, deps: d.deps });
  assert.equal(out.counts.clear, 0, '진행 중 사건을 해소하지 않는다(예전 clear)');
  assert.equal(STATE().rules['rack|vcA|rack:vcA|R1'].active, true);
  // 화면(같은 aggregatePower) — 같은 입력 · 같은 숫자 · 목록 밖 서버는 수만
  const P = await import('../src/routes/api/bmPower.js');
  const deps = { currentTargets: async () => ({ targets: ['K1', 'K2'].map((k) => ({ ...tg(k), paths: ['idrac'] })) }), listEdgeBmUsage: async () => [], now: () => NOW + 5 * MIN,
    rules: async () => rules, sources: two, judgeCtx: async () => ({ self: 'n2', isEdge: false }) };
  AG._resetPowerAggForTest();
  const view = await P.bmPowerView({ user: { username: 'adm', role: 'admin' }, query: { rack: 'vcA|R1' } }, { vcenters: [] }, deps);
  const vr = view.racks.find((x) => x.rack === 'R1');
  assert.deepEqual([vr.servers, vr.measured, vr.marginPartial, vr.marginPct, vr.notTarget], [3, 2, true, null, 1], '알림 입력과 같은 집계');
  assert.equal(view.rackServers.notTarget, 1); assert.deepEqual(view.rackServers.rows.map((x) => x.key).sort(), ['K1', 'K2']);
  const op = await P.bmPowerView({ user: { username: 'op', role: 'operator', scope: { vcenters: ['vcA'] } }, query: { rack: 'vcA|R1' } }, { vcenters: [{ id: 'vcA' }] }, { ...deps, bmAddressHosts: async () => [] });
  assert.ok(!JSON.stringify(op).includes('K3'), '목록 밖 배치 서버의 키 · 이름은 응답에 없다(수만)');
});

test('② F2 — 랙 서버 일부만 창 안: 보낸다(본문에 창 안 서버) · 전부 창 안: 억제 · 창을 읽을 수 없는 배치 서버: 억제하지 않는다', async () => {
  const S = await import('../src/bmusage/maint/schedule.js');
  const ST = await import('../src/bmusage/maint/store.js');
  const MR = await import('../src/bmusage/maint/runtime.js');
  ST._resetMaintStoreForTest(); MR._resetMaintRuntimeForTest();
  const T0 = Date.now();
  const loc = (ms) => S.fmtLocal('Asia/Seoul', ms).replace(' ', 'T');
  await ST.addWindow({ name: 'K1 창', reason: '시험', target: { kind: 'server', keys: ['K1'], names: ['bm-K1'] }, vcenterId: 'vcA', tz: 'Asia/Seoul',
    schedule: { kind: 'once', start: loc(T0 - 30 * MIN), end: loc(T0 + 12 * HOUR) }, scopes: { alerts: true } }, { by: 'op', now: T0 });
  const rules = rulesOf({ rack: { sustain: 1, issue: true } });
  const mem = (unknown = false) => [{ key: 'K1', vcenterId: 'vcA', name: 'bm-K1' }, { key: 'K2', vcenterId: 'vcA', name: 'bm-K2' }, { key: 'K3', vcenterId: 'vcA', name: 'bm-K3', ...(unknown ? { unknown: true } : {}) }];
  const rk = (t, members) => ({ key: 'rack:vcA|R1', name: '랙 R1', vcenterId: 'vcA', members,
    power: { kind: 'rack', rack: 'R1', capKw: 10, nowKw: 12, marginPct: -20, low: true, marginPartial: false, measured: 3, servers: 3, rackLowPct: 10, obs: `o${t}` } });
  A._resetPerfAlertsForTest();
  const d = depsOf({ maintJudge: async (now) => MR.maintJudge({ now }), clock: () => Date.now() });
  let r = await A.runPerfAlerts([rk(T0, mem())], { rules, now: T0, deps: d.deps });
  await A._drainPerfAlertsForTest();
  assert.equal(r.maintenance, 0, '한 대의 창으로 랙 전체를 억제하지 않는다(예전 maintenance 1 · 발송 0)'); assert.equal(d.sends.length, 1); assert.equal(d.issues.length, 1);
  assert.equal(d.sends[0].severity, 'critical');
  assert.match(d.sends[0].detail, /정비 창 안 서버 1대 포함 — bm-K1\(창 끝 \d\d-\d\d \d\d:\d\d\)/);
  // 법인 창 — 세 대 전부 창 안 → 억제(기록만)
  A._resetPerfAlertsForTest();
  await ST.addWindow({ name: '법인 창', reason: '시험', target: { kind: 'corp' }, vcenterId: 'vcA', tz: 'Asia/Seoul',
    schedule: { kind: 'once', start: loc(T0 - 10 * MIN), end: loc(T0 + 2 * HOUR) }, scopes: { alerts: true } }, { by: 'op', now: T0 });
  const d2 = depsOf({ maintJudge: async (now) => MR.maintJudge({ now }), clock: () => Date.now() });
  r = await A.runPerfAlerts([rk(T0, mem())], { rules, now: T0, deps: d2.deps });
  await A._drainPerfAlertsForTest();
  assert.equal(r.maintenance, 1); assert.equal(d2.sends.length, 0);
  // 같은 법인 창이어도 창을 읽을 수 없는 배치 서버(이 노드 대상 아님)가 있으면 ‘전부 창 안’ 이 아니다
  A._resetPerfAlertsForTest();
  const d3 = depsOf({ maintJudge: async (now) => MR.maintJudge({ now }), clock: () => Date.now() });
  r = await A.runPerfAlerts([rk(T0, mem(true))], { rules, now: T0, deps: d3.deps });
  await A._drainPerfAlertsForTest();
  assert.equal(r.maintenance, 0); assert.equal(d3.sends.length, 1);
  assert.match(d3.sends[0].detail, /정비 창 안 서버 2대 포함/);
  // 순수 — groupMaintState
  const j = await MR.maintJudge({ now: T0 });
  const g = A.groupMaintState(j, mem(true), T0);
  assert.equal(g.scopes.alerts, undefined); assert.equal(g.unknown, 1); assert.deepEqual(g.partial.map((x) => x.key), ['K1', 'K2']);
  ST._resetMaintStoreForTest(); MR._resetMaintRuntimeForTest();
  for (const f of ['maintenance-windows.json', 'maintenance-windows-deployed.json']) { try { fs.unlinkSync(path.join(DIR, f)); } catch { /* */ } }
});

test('③ F7 — 랙 억제 구간은 창들의 교집합 · ‘창 끝 뒤 억제’ 점검 거짓 경고 0', async () => {
  const S = await import('../src/bmusage/maint/schedule.js');
  const ST = await import('../src/bmusage/maint/store.js');
  const MR = await import('../src/bmusage/maint/runtime.js');
  ST._resetMaintStoreForTest(); MR._resetMaintRuntimeForTest();
  const T0 = Date.now();
  const loc = (ms) => S.fmtLocal('Asia/Seoul', ms).replace(' ', 'T');
  const wa = await ST.addWindow({ name: 'K1 긴 창', reason: '시험', target: { kind: 'server', keys: ['K1'], names: ['bm-K1'] }, vcenterId: 'vcA', tz: 'Asia/Seoul',
    schedule: { kind: 'once', start: loc(T0 - 19 * HOUR), end: loc(T0 + 4 * HOUR) }, scopes: { alerts: true } }, { by: 'op', now: T0 });
  const wb = await ST.addWindow({ name: 'K2 창', reason: '시험', target: { kind: 'server', keys: ['K2'], names: ['bm-K2'] }, vcenterId: 'vcA', tz: 'Asia/Seoul',
    schedule: { kind: 'once', start: loc(T0 - 1 * HOUR), end: loc(T0 + 11 * HOUR) }, scopes: { alerts: true } }, { by: 'op', now: T0 });
  const j = await MR.maintJudge({ now: T0 });
  const members = [{ key: 'K1', vcenterId: 'vcA' }, { key: 'K2', vcenterId: 'vcA' }];
  const g = A.groupMaintState(j, members, T0);
  const sa = j.stateFor(members[0], T0); const sb = j.stateFor(members[1], T0);
  assert.equal(g.scopes.alerts, true);
  assert.equal(g.since.alerts, Math.max(...[sa, sb].map((x) => Math.min(...x.windows.map((w) => w.start)))), 'since = 서버별 시작 중 가장 늦은 것');
  assert.equal(g.until.alerts, Math.min(sa.until.alerts, sb.until.alerts), 'until = 서버별 끝 중 가장 이른 것');
  assert.deepEqual(g.windows.map((w) => w.id).sort(), [wa.id, wb.id].sort());
  A._resetPerfAlertsForTest();
  const d = depsOf({ maintJudge: async (now) => MR.maintJudge({ now }), clock: () => Date.now() });
  const rules = rulesOf({ rack: { sustain: 1 } });
  const r = await A.runPerfAlerts([{ key: 'rack:vcA|R1', name: '랙 R1', vcenterId: 'vcA', members,
    power: { kind: 'rack', rack: 'R1', capKw: 10, nowKw: 9.8, marginPct: 2, low: true, marginPartial: false, measured: 2, servers: 2, rackLowPct: 10, obs: 'o1' } }], { rules, now: T0, deps: d.deps });
  assert.equal(r.maintenance, 1);
  const audit = await MR.auditCycle({ now: T0 });
  assert.equal(audit.checked, 1); assert.equal(audit.leak, 0, `거짓 leak 없음(예전 over-cap 1) — ${JSON.stringify(audit.reasons)}`);
  ST._resetMaintStoreForTest(); MR._resetMaintRuntimeForTest();
  for (const f of ['maintenance-windows.json', 'maintenance-windows-deployed.json']) { try { fs.unlinkSync(path.join(DIR, f)); } catch { /* */ } }
});

test('④ F3 — 시험 실행 · 폴러 상태가 전력 입력 실패 · 판정 보류 수를 0건과 가른다', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const O = await import('../src/routes/api/bmPerfOps.js');
  const targets = [{ key: 'K1', name: 'bm-K1', vcenterId: 'vcA', idrac: { regId: 'rK1' } }, { key: 'K2', name: 'bm-K2', vcenterId: 'vcA', idrac: { regId: 'rK2' } }];
  const body = { rules: { rack: { on: true }, powerCap: { on: true }, inlet: { on: true } }, power: { racksText: 'vcA,R1,1.0,K1 K2' } };
  const req = { body, user: { username: 'adm', role: 'admin' } };
  // 원천이 던짐 → powerError
  const r1 = await O.bmRulesDryRun(req, { currentTargets: async () => ({ targets }), powerSources: async () => { throw new Error('idrac-power.db 열기 실패(시험)'); }, judgeCtx: JCTX() });
  assert.equal(r1.status, 200); assert.match(r1.body.powerError, /열기 실패/); assert.equal(r1.body.powerItems, undefined);
  // 전부 못 읽음 → 판정 보류 수(counts.unknown) · 전력 항목 수
  const r2 = await O.bmRulesDryRun(req, { currentTargets: async () => ({ targets }), powerSources: sourcesOf({ measured: [meas('rK1', 400, 'vcA')], analysis: [{ id: 'rK1' }] }), judgeCtx: JCTX() });
  assert.equal(r2.body.fires.length, 0); assert.equal(r2.body.powerItems, 3, '서버 2 + 랙 1'); assert.equal(r2.body.counts.unknown, 5, '판정 보류 5(랙 부분 합 · PowerCap 상한 없음 2 · 흡기 못 읽음 2) — 0건이 아니다');
  // 폴러 — 원천 실패가 주기 상태(_last.perfAlerts.powerError)에 남는다
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [] }));
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [{ id: 'o-f1', name: 'bm-f1', host: '127.0.0.5', port: 9, username: 'mon', password: 'pw', mounts: [] }] }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcF: true }, osSsh: true, idracTelemetry: false, intervalMs: 600_000 }));
  const poller = await import('../src/bmusage/poller.js');
  const OSm = await import('../src/bmusage/collectors/osSsh.js');
  poller._setFleetForTest(async () => ({ bareMetal: [{ serverId: 's-f1', name: 'bm-f1', serviceTag: 'FTAG1', vcenterId: 'vcF' }], virtualizationHosts: [] }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  const stdout = ['##STAT', 'cpu  10 0 10 1000 0 0 0 0 0 0', '##MEM', 'MemTotal: 1000000 kB', 'MemAvailable: 500000 kB', '##END'].join('\n');
  poller._setOsCollectorForTest(async () => { const sh = OSm.shapeLinux(stdout, []); return { ...sh, ok: true, peak: { windowS: 0 }, stderr: '' }; });
  PA._setPowerSourcesForTest(async () => { throw new Error('전력 원천 실패(시험)'); });
  t.after(() => { PA._setPowerSourcesForTest(null); poller._setOsCollectorForTest(null); poller._setFleetForTest(null); poller._resetForTest(); R._resetPerfRulesForTest(); });
  R._resetPerfRulesForTest();
  R.savePerfRules({ rules: { powerCap: { on: true } } }, { by: 'test' });
  A._resetPerfAlertsForTest();
  const r = await poller.pollBmUsageOnce({ trigger: 'manual' });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
  assert.match(r.perfAlerts.powerError, /전력 원천 실패/, '무음 실패 금지 — 주기 상태에 남는다');
  assert.equal(poller.bmUsageStatus().last.perfAlerts.powerError, r.perfAlerts.powerError, '규칙 화면 상태 줄이 읽는 값(bmRulesRead status.last)');
  assert.equal(A._lastIntervalForTest(), 600_000, 'F5 보류 시한은 이 노드 수집 주기(설정 10분)로 센다');
});

test('⑤ F4 — 판정 노드 함수 하나: 판정 없음 + 사유 · 화면과 알림이 같은 함수 · S1(법인을 엣지가 맡은 서버) 이중 판정 없음', async () => {
  const J = await import('../src/bmusage/powerJudge.js');
  const C = { self: 'central', isEdge: false, corpOwner: (vc) => (vc === 'vcE' ? 'edge-e' : '') };
  assert.deepEqual(J.judgeOf({ via: 'local', vcenterId: 'vcA', key: 'K', src: 'idrac' }, C), { node: 'central', reason: null });
  assert.deepEqual(J.judgeOf({ via: 'local', vcenterId: 'vcA', key: 'K', src: null }, C), { node: 'central', reason: null }, '미측정 — 대상 노드(값이 없어 보류)');
  assert.deepEqual(J.judgeOf({ via: 'local', vcenterId: 'vcA', key: 'K', src: 'remote' }, C), { node: null, reason: 'source-edge' });
  assert.deepEqual(J.judgeOf({ via: 'edge', node: 'edge-x', vcenterId: 'vcX', key: 'K', src: 'ome' }, C), { node: null, reason: 'source-central' });
  assert.deepEqual(J.judgeOf({ via: 'edge', node: 'edge-x', vcenterId: 'vcX', key: 'K', src: 'remote' }, C), { node: 'edge-x', reason: null });
  assert.deepEqual(J.judgeOf({ via: 'local', vcenterId: 'vcE', key: 'K', src: 'idrac' }, C), { node: null, reason: 'corp-edge-owned', owner: 'edge-e' }, 'S1 — 중앙은 판정하지 않는다');
  assert.deepEqual(J.judgeOf({ via: 'local', vcenterId: 'vcE', key: 'K', src: 'idrac' }, { ...C, edgeHas: () => 'edge-e' }), { node: 'edge-e', reason: null });
  assert.deepEqual(J.judgeOf({ via: 'local', vcenterId: 'vcE', key: 'K', src: 'idrac' }, { self: 'edge-e', isEdge: true }), { node: 'edge-e', reason: null }, '엣지는 법인 담당 규칙을 보지 않는다');
  assert.deepEqual(J.rackJudgeOf([{ node: 'a' }, { node: 'a' }], 0), { node: 'a', reason: null });
  assert.deepEqual(J.rackJudgeOf([{ node: 'a' }, { node: 'a' }], 1), { node: null, reason: 'member-unknown' });
  assert.deepEqual(J.rackJudgeOf([{ node: 'a' }, { node: null, reason: 'source-edge' }], 0), { node: null, reason: 'member-no-judge' });
  assert.deepEqual(J.rackJudgeOf([{ node: 'a' }, { node: 'b' }], 0), { node: null, reason: 'members-split' });
  // S1 — 같은 서버(vcE|S1)를 중앙 · 엣지가 각자 자기 대상 · 자기 iDRAC 원천으로 본다 → 판정하는 노드는 하나
  const rules = rulesOf({ powerCap: { sustain: 1 } });
  const src = sourcesOf({ measured: [meas('rS1', 500, 'vcE')], analysis: [{ id: 'rS1' }], inv: { rS1: { powerCap: { limitWatts: 500 }, collectedAt: NOW - MIN } } });
  const tgt = [{ key: 'S1', name: 'bm-s1', vcenterId: 'vcE', idrac: { regId: 'rS1' } }];
  const central = await PA.powerAlertItems({ targets: tgt, rules, now: NOW, deps: { sources: src, judgeCtx: async () => C } });
  const edge = await PA.powerAlertItems({ targets: tgt, rules, now: NOW, deps: { sources: src, judgeCtx: async () => ({ self: 'edge-e', isEdge: true }) } });
  const judged = [...central, ...edge].filter((x) => x.power && PA.powerCondition('powerCap', x) === true);
  assert.equal(judged.length, 1, `S1 이중 판정 없음(예전 2) — ${JSON.stringify([...central, ...edge].map((x) => [x.power?.judge || x.release, x.power?.capHit]))}`);
  assert.deepEqual(central[0].release, { kind: 'server', reason: 'corp-edge-owned', node: '' }, '중앙은 판정 항목이 아니라 넘김 항목(재확인 N2 — 상태 비움)'); assert.equal(central[0].power, undefined);
  // 화면 — 엣지 대상 · 중앙 OME 원천(반증 r5): 화면은 걸림을 보이되 ‘알림 판정 없음 + 사유’ · 이 노드 대상 · 엣지 사본 원천도 같은 함수
  const P = await import('../src/routes/api/bmPower.js');
  AG._resetPowerAggForTest();
  const measured = [meas('ome:1', 495, 'vcX', NOW - MIN, 'ome', { serviceTag: 'XT3' }), meas('remote:e:9', 300, 'vcA', NOW - MIN, 'remote', { serviceTag: 'AT1', dbKey: 'rmt:a1' })];
  const view = await P.bmPowerView({ user: { username: 'adm', role: 'admin' }, query: { rack: 'vcX|' } }, { vcenters: [] }, {
    currentTargets: async () => ({ targets: [{ key: 'AT1', name: 'bm-a1', vcenterId: 'vcA', serviceTag: 'AT1', paths: ['os'] }] }),
    listEdgeBmUsage: async () => [{ agent: 'edge-x', snapAt: NOW, snap: { powerCapVer: 1, targets: [{ key: 'XT3', name: 'bm-x3', vcenterId: 'vcX', serviceTag: 'XT3' }], powerCaps: [{ key: 'XT3', limitWatts: 500, enabled: true, at: NOW - MIN }] } }],
    now: () => NOW, rules: async () => R.normalizeRules({}, { strict: false }).value, minEdgeVersion: async () => null,
    sources: async () => ({ ...(await sourcesOf({ measured })()) }), judgeCtx: async () => ({ self: 'central', isEdge: false, corpOwner: () => '' }) });
  const x3 = view.capHit.find((x) => x.key === 'XT3');
  assert.equal(x3.capHit, true, '화면은 걸림'); assert.equal(x3.judgeNode, null); assert.equal(x3.judgeReason, 'source-central');
  assert.deepEqual(view.fleet.noJudge.byReason, { 'source-central': 1, 'source-edge': 1 }); assert.equal(view.fleet.noJudge.servers, 2);
});

test('⑥ F5 — 보류 시한: 지속 주기 수보다 긴 보류 뒤 표본은 1부터 · ‘처음 성립’ 도 그때 · 짧은 보류는 잇는다', async () => {
  const rules = rulesOf({ inlet: { sustain: 3, repeatMin: 0 } });
  const it = (t, state = 'ok') => ({ key: 'K1', name: 'bm-K1', vcenterId: 'vcA', target: { key: 'K1', vcenterId: 'vcA' }, power: { kind: 'server', inletWarnC: 27, tempState: state, inletC: 30, tempAt: t } });
  A._resetPerfAlertsForTest();
  const d = depsOf();
  const run = (t, state) => A.runPerfAlerts([it(t - MIN, state)], { rules, now: t, deps: d.deps, intervalMs: 5 * MIN });
  await run(NOW); await run(NOW + 5 * MIN);
  for (let i = 0; i < 6; i += 1) await run(NOW + (10 + i * 5) * MIN, 'stale');   // 보류 6주기 > 지속 3
  assert.equal(A.holdMaxCycles(rules.rules.inlet), 3, '보류 6주기 > 지속 3(2차 M1 — 시간이 아니라 주기 수)');
  let r = await run(NOW + 48 * HOUR);
  assert.equal(r.fires, 0, '긴 보류 뒤 표본 하나로 ‘3주기 지속’ 이 아니다(예전 발송)'); assert.equal(r.counts.holdReset, 1);
  assert.equal(STATE().rules['inlet|vcA|K1'].streak, 1); assert.equal(STATE().rules['inlet|vcA|K1'].since, NOW + 48 * HOUR);
  await run(NOW + 48 * HOUR + 5 * MIN);
  r = await run(NOW + 48 * HOUR + 10 * MIN);
  await A._drainPerfAlertsForTest();
  assert.equal(r.fires, 1); assert.equal(d.sends.length, 1);
  const { DAY_OFFSET_MIN } = await import('../src/util/dayKey.js');
  const hm = (ms) => new Date(ms + DAY_OFFSET_MIN * 60_000).toISOString().slice(5, 16).replace('T', ' ');
  assert.match(d.sends[0].detail, new RegExp(`처음 성립 ${hm(NOW + 48 * HOUR)}`), '처음 성립 = 다시 센 첫 표본');
  // 짧은 보류(2주기 ≤ 지속 3)는 잇는다
  A._resetPerfAlertsForTest();
  const d2 = depsOf();
  const run2 = (t, state) => A.runPerfAlerts([it(t - MIN, state)], { rules, now: t, deps: d2.deps, intervalMs: 5 * MIN });
  await run2(NOW); await run2(NOW + 5 * MIN); await run2(NOW + 10 * MIN, 'stale'); await run2(NOW + 15 * MIN, 'stale');
  r = await run2(NOW + 20 * MIN);
  assert.equal(r.fires, 1, '짧은 결측은 지속을 끊지 않는다'); assert.equal(r.counts.holdReset, 0);
  // 진행 중 사건은 긴 보류 뒤에도 끊지 않는다(다시 보내지 않는다)
  await run2(NOW + 25 * MIN, 'stale');
  r = await run2(NOW + 30 * HOUR);
  assert.equal(r.fires, 0); assert.equal(STATE().rules['inlet|vcA|K1'].active, true);
  assert.equal(STATE().rules['inlet|vcA|K1'].since, NOW, '진행 중 사건의 ‘처음 성립’ 은 그대로(보류 시한은 아직 사건이 아닐 때만)');
});
