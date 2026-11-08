/**
 * 반증 n2 재확인(기준판 bdc88e73) 확정분 고정:
 *   ① N1 보류 시한은 ‘조건이 null 인 진짜 보류’ 와 ‘주기가 없던 틈’ 만 잰다 — 같은 표본 보류(조건은 살아 있는 관측)는 시한을 늘리지도 끊지도 않는다
 *      (a) 피크 급증 지속 2 · 수집 5분 · 표지 시간 단위 (b) 흡기 지속 3 · 수집 1분 · 센서 5분 간격 (c) PowerCap 지속 3 · 표본 25분 간격 → 모두 발화
 *      (d) 48시간 낡음 뒤 표본 1개는 발화 아님(F5 유지) (e) 주기가 없던 1시간 틈 뒤 첫 표본도 1부터 (f) 주기 상한으로 이월된 발화도 같은 규칙(다음 새 표본에 발화)
 *   ② N2 판정 노드가 넘어가면 그 서버 · 랙의 전력 규칙 상태를 비운다(해소 알림 없이 · 이력 한 줄) — 다시 이 노드가 판정하면 새 사건으로 발화
 *   ③ N4 법인을 맡은 엣지의 봉투가 없으면 ‘판정 여부 모름’(judge-unknown) — ‘판정 없음’ 합계와 따로 센다
 *   ④ N5 이 판 표지(powerCapVer)가 없는 구버전 엣지의 서버는 ‘엣지 버전 낮음’ 판정 없음(edge-old)
 * 기준 시각: 실제 시각을 정시로 내린 뒤 −20분(common.md).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmpown2b-'));
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
const srv = (p) => ({ key: 'K1', name: 'bm-K1', vcenterId: 'vcA', target: { key: 'K1', vcenterId: 'vcA' }, power: { kind: 'server', inletWarnC: 27, capHitPct: 98, surgePct: 20, tempState: 'ok', ...p } });
/** 주기 시뮬레이션 — 수집 주기 everyMs 마다 판정 · 표본은 sampleMs 마다 새로(그 사이는 같은 표본). 발화 수 · 다시 센 수. */
async function simulate({ rule, rules, everyMs, sampleMs, spanMs, itemOf, cycleMaxAt = null }) {
  A._resetPerfAlertsForTest();
  const d = depsOf();
  let fires = 0; let resets = 0; let firstFireAt = null;
  for (let t = NOW; t <= NOW + spanMs; t += everyMs) {
    const sampleAt = NOW + Math.floor((t - NOW) / sampleMs) * sampleMs;
    const r = await A.runPerfAlerts([itemOf(sampleAt, t)], { rules, now: t, deps: d.deps, intervalMs: everyMs, ...(cycleMaxAt != null && t === cycleMaxAt ? { cycleMax: 0 } : {}) });
    fires += r.fires || 0; resets += r.counts?.holdReset || 0;
    if (r.fires && firstFireAt == null && !r.deferred) firstFireAt = t;
  }
  await A._drainPerfAlertsForTest();
  return { fires, resets, firstFireAt, sends: d.sends.length, state: STATE().rules[`${rule}|vcA|K1`] };
}

test('① N1 — 같은 표본 보류는 시한에 들지 않는다(a · b · c 발화) · 진짜 보류 · 주기 없던 틈은 1부터(d · e) · 이월 경로도 같은 규칙(f)', async () => {
  // (a) 피크 급증 지속 2 · 수집 5분 · 표지 시간 단위(새 시간 행마다 바뀜) · 12시간 — 기준판: 발화 0 · 다시 셈 11
  const surge = (lastHour) => srv({ surge: { state: 'ok', ratioPct: 30, peakW: 1300, baseW: 1000, baseHours: 168, hours24: 24, lastHour }, inletC: null });
  const a = await simulate({ rule: 'surge', rules: rulesOf({ surge: { sustain: 2, repeatMin: 0 } }), everyMs: 5 * MIN, sampleMs: HOUR, spanMs: 12 * HOUR, itemOf: (s) => surge(s) });
  assert.equal(a.resets, 0, '같은 표본 보류로 지속을 끊지 않는다(예전 11번)'); assert.equal(a.fires, 1, '두 번째 시간 표본에서 발화(예전 0)'); assert.equal(a.firstFireAt, NOW + HOUR);
  // (b) 흡기 지속 3 · 수집 1분(설정 하한) · 센서 표본 5분 · 3시간 — 기준판: 발화 0 · 다시 셈 35
  const inl = (s) => srv({ inletC: 30, tempAt: s });
  const b = await simulate({ rule: 'inlet', rules: rulesOf({ inlet: { sustain: 3, repeatMin: 0 } }), everyMs: MIN, sampleMs: 5 * MIN, spanMs: 3 * HOUR, itemOf: inl });
  assert.equal(b.resets, 0); assert.equal(b.fires, 1, '세 번째 표본(10분)에 발화(예전 0)'); assert.equal(b.firstFireAt, NOW + 10 * MIN);
  // (c) PowerCap 지속 3 · 수집 5분 · 전력 표본 25분 · 6시간 — 기준판: 발화 0 · 다시 셈 14
  const cap = (s) => srv({ w: 900, at: s, capW: 900, capPct: 100, capHit: true });
  const c = await simulate({ rule: 'powerCap', rules: rulesOf({ powerCap: { sustain: 3, repeatMin: 0 } }), everyMs: 5 * MIN, sampleMs: 25 * MIN, spanMs: 6 * HOUR, itemOf: cap });
  assert.equal(c.resets, 0); assert.equal(c.fires, 1, '세 번째 표본(50분)에 발화(예전 0)'); assert.equal(c.firstFireAt, NOW + 50 * MIN);
  // (d) F5 유지 — 흡기 표본 2개 뒤 48시간 낡음(조건 null) → 새 표본 1개는 발화 아님 · 1부터
  A._resetPerfAlertsForTest();
  const d = depsOf(); const rI = rulesOf({ inlet: { sustain: 3, repeatMin: 0 } });
  const run = (t, it) => A.runPerfAlerts([it], { rules: rI, now: t, deps: d.deps, intervalMs: 5 * MIN });
  await run(NOW, inl(NOW - MIN)); await run(NOW + 5 * MIN, inl(NOW + 4 * MIN));
  for (let i = 0; i < 6; i += 1) await run(NOW + (10 + i * 5) * MIN, srv({ inletC: 40, tempAt: NOW + 4 * MIN, tempState: 'stale' }));
  let r = await run(NOW + 48 * HOUR, inl(NOW + 48 * HOUR - MIN));
  assert.equal(r.fires, 0); assert.equal(r.counts.holdReset, 1); assert.equal(STATE().rules['inlet|vcA|K1'].streak, 1);
  // 시한 = (지속 + 1) × 수집 주기 — 한 주기 여유(늦은 주기 · 이월로 거짓 재시작이 나지 않게)
  assert.equal(A.holdMaxMs({ sustain: 3 }, 5 * MIN), 20 * MIN);
  // 보류 15분(조건 null 세 주기)은 시한 안 — 잇는다
  A._resetPerfAlertsForTest();
  await run(NOW, inl(NOW - MIN)); await run(NOW + 5 * MIN, inl(NOW + 4 * MIN));
  for (const k of [10, 15, 20]) await run(NOW + k * MIN, srv({ inletC: 40, tempAt: NOW + 4 * MIN, tempState: 'stale' }));
  r = await run(NOW + 25 * MIN, inl(NOW + 24 * MIN));
  assert.equal(r.fires, 1, '마지막 관측(+5분) 뒤 20분 — 시한 안'); assert.equal(r.counts.holdReset, 0);
  // (e) 주기가 아예 없던 틈(재시작 · 주기 건너뜀 1시간) 뒤 첫 표본 — 1부터(기준판: 보류 주기가 없어 ‘3주기 지속’ 발화)
  A._resetPerfAlertsForTest();
  await run(NOW, inl(NOW - MIN)); await run(NOW + 5 * MIN, inl(NOW + 4 * MIN));
  r = await run(NOW + 65 * MIN, inl(NOW + 64 * MIN));
  assert.equal(r.fires, 0, '틈 뒤 첫 표본으로 지속을 잇지 않는다'); assert.equal(r.counts.holdReset, 1);
  // (f) 이월(주기 상한 MAX_SEND) — 발화 차례가 이월되면 다음 새 표본에 발화(같은 표본 보류로 지속이 끊기지 않는다)
  const f = await simulate({ rule: 'inlet', rules: rI, everyMs: MIN, sampleMs: 5 * MIN, spanMs: HOUR, itemOf: inl, cycleMaxAt: NOW + 10 * MIN });
  assert.equal(f.resets, 0); assert.equal(f.sends, 1, '이월 뒤 다음 표본(15분)에 1회'); assert.equal(f.firstFireAt, NOW + 15 * MIN);
});

test('② N2 — 판정 노드가 넘어가면 상태를 비운다(해소 알림 없이 · 이력 한 줄) · 다시 이 노드가 판정하면 새 사건으로 발화', async () => {
  const rules = rulesOf({ powerCap: { sustain: 1, repeatMin: 0 }, rack: { sustain: 1, repeatMin: 0 } }, { power: { racksText: 'vcE,E-1,0.5,S1' } });
  const tgt = [{ key: 'S1', name: 'bm-s1', vcenterId: 'vcE', idrac: { regId: 'rS1' } }];
  const src = (w, at) => async () => ({
    measured: async () => [{ serverId: 'rS1', watts: w, ts: at, vcenterId: 'vcE', source: 'idrac' }], analysisServers: async () => [{ id: 'rS1' }], fanFaults: async () => [],
    powerDb: async () => ({ hourlyStats: () => [] }), inventoryOf: () => ({ powerCap: { limitWatts: 500 }, collectedAt: at }), sensorLatest: () => null,
    temps: { classify: () => 'cpu', maxAgeOf: () => 15 * MIN } });
  let owner = '';
  const jctx = async () => ({ self: 'central', isEdge: false, corpOwner: () => owner });
  A._resetPerfAlertsForTest(); AG._resetPowerAggForTest();
  const d = depsOf();
  const cycle = async (t, w) => A.runPerfAlerts(await PA.powerAlertItems({ targets: tgt, rules, now: t, deps: { sources: src(w, t - MIN), judgeCtx: jctx } }), { rules, now: t, deps: d.deps });
  // day0 — 중앙 판정 · 걸림 → 발송(진행 중)
  let r = await cycle(NOW, 495);
  assert.equal(r.fires, 2, 'PowerCap + 랙(0.5 kW · 495 W)'); assert.equal(STATE().rules['powerCap|vcE|S1'].active, true);
  // 엣지가 법인을 맡음 → 이 노드는 판정 노드 아님 → 상태를 비운다(보류로 남기지 않는다) · 해소 알림 없음 · 이력 한 줄
  owner = 'edge-e';
  r = await cycle(NOW + 5 * MIN, 300);
  assert.equal(r.fires, 0); assert.equal(r.counts.released, 2);
  assert.equal(STATE().rules['powerCap|vcE|S1'], undefined, '판정 노드 아님 — 상태 비움(예전 active 보류)'); assert.equal(STATE().rules['rack|vcE|rack:vcE|E-1'], undefined);
  const moved = A.perfAlertStatus().sent.filter((x) => x.result === 'judge-moved');
  assert.deepEqual(moved.map((x) => x.rule).sort(), ['powerCap', 'rack']); assert.match(moved[0].title, /판정 노드 넘어감/);
  // 엣지 봉투로 오는 같은 기록도 중앙 정제가 결과를 지키고(‘’ 로 지우지 않는다) 화면 문구가 있다
  const OP = await import('../src/central/bmPerfOpsPull.js');
  assert.equal(OP.sanitizeAlertSent(moved, NOW)[0].result, 'judge-moved');
  const T = await import('../../web/src/views/tools/bmPerfOpsText.js');
  assert.match(T.sentResultText('judge-moved'), /판정 노드 넘어감/);
  await A._drainPerfAlertsForTest();
  assert.equal(d.sends.length, 2, '해소 · 넘어감 알림은 보내지 않는다');
  // 다음 주기에도 다시 적지 않는다(비운 상태라 한 번만)
  r = await cycle(NOW + 10 * MIN, 300);
  assert.equal(A.perfAlertStatus().sent.filter((x) => x.result === 'judge-moved').length, 2);
  // day3 — 엣지 보고 만료(엣지 꺼짐) → 다시 중앙 판정 · 새로 걸림 → 발화(예전 0 · ongoing)
  owner = '';
  r = await cycle(NOW + 72 * HOUR, 499);
  await A._drainPerfAlertsForTest();
  assert.equal(r.fires, 2, '새 사건'); assert.equal(d.sends.length, 4);
});

test('③ N4 — 법인을 맡은 엣지의 봉투가 없으면 ‘판정 여부 모름’ · ‘판정 없음’ 합계와 따로 · ④ N5 — 구버전 엣지(표지 없음) 서버는 ‘엣지 버전 낮음’', async () => {
  const J = await import('../src/bmusage/powerJudge.js');
  const C = { self: 'central', isEdge: false, corpOwner: (vc) => (vc === 'vcE' ? 'edge-e' : '') };
  assert.deepEqual(J.judgeOf({ via: 'local', vcenterId: 'vcE', key: 'K', src: 'idrac' }, { ...C, edgeKnown: () => false }), { node: null, reason: 'judge-unknown', owner: 'edge-e' }, '봉투 없음 — 모름');
  assert.deepEqual(J.judgeOf({ via: 'local', vcenterId: 'vcE', key: 'K', src: 'idrac' }, { ...C, edgeKnown: () => true }), { node: null, reason: 'corp-edge-owned', owner: 'edge-e' }, '봉투는 있는데 그 서버가 없음 — 없음');
  assert.deepEqual(J.judgeOf({ via: 'edge', node: 'edge-o', vcenterId: 'vcO', key: 'K', src: 'remote', capState: 'old-version' }, C), { node: null, reason: 'edge-old' });
  assert.deepEqual(J.rackJudgeOf([{ node: 'a' }, { node: null, reason: 'judge-unknown' }], 0), { node: null, reason: 'judge-unknown' });
  const P = await import('../src/routes/api/bmPower.js');
  AG._resetPowerAggForTest();
  const measured = [{ serverId: 'rKA', watts: 300, ts: NOW - MIN, vcenterId: 'vcE', source: 'idrac', serviceTag: 'KA' }, { serverId: 'remote:o:1', watts: 200, ts: NOW - MIN, vcenterId: 'vcO', source: 'remote', serviceTag: 'KO', dbKey: 'rmt:ko' }];
  const sources = async () => ({ measured: async () => measured, analysisServers: async () => [{ id: 'rKA', serviceTag: 'KA' }], fanFaults: async () => [], powerDb: async () => ({ hourlyStats: () => [] }),
    inventoryOf: () => null, sensorLatest: () => null, temps: { classify: () => 'cpu', maxAgeOf: () => 15 * MIN } });
  const base = { currentTargets: async () => ({ targets: [{ key: 'KA', name: 'bm-ka', vcenterId: 'vcE', serviceTag: 'KA', idrac: { regId: 'rKA' }, paths: ['idrac'] }] }), now: () => NOW,
    rules: async () => R.normalizeRules({}, { strict: false }).value, minEdgeVersion: async () => '9.9.9', sources,
    judgeCtx: async (edgeHas, edgeKnown) => ({ self: 'central', isEdge: false, corpOwner: (vc) => (vc === 'vcE' ? 'edge-e' : ''), edgeHas, edgeKnown }) };
  const old = { agent: 'edge-o', snapAt: NOW, snap: { targets: [{ key: 'KO', name: 'bm-ko', vcenterId: 'vcO', serviceTag: 'KO' }] } };
  const view = (edges) => P.bmPowerView({ user: { username: 'adm', role: 'admin' }, query: { rack: 'vcE|' } }, { vcenters: [] }, { ...base, listEdgeBmUsage: async () => edges });
  // edge-e 봉투 없음 — 모름(합계에서 뺀다) · edge-o 는 표지 없는 구버전 — 엣지 버전 낮음(판정 없음)
  let v = await view([old]);
  const ka = v.rackServers.rows.find((x) => x.key === 'KA');
  assert.equal(ka.judgeReason, 'judge-unknown', '봉투가 없으면 단정하지 않는다(예전 corp-edge-owned)');
  assert.equal(v.fleet.noJudge.unknown, 1); assert.equal(v.fleet.noJudge.byReason['judge-unknown'], undefined);
  assert.deepEqual(v.fleet.noJudge.byReason, { 'edge-old': 1 }, 'N5 — 구버전 엣지 서버는 판정 없음(예전 판정 노드 = 그 엣지)'); assert.equal(v.fleet.noJudge.servers, 1);
  // edge-e 봉투가 왔는데 그 서버가 없으면 ‘없음’ · 있으면 그 엣지가 판정 노드
  v = await view([old, { agent: 'edge-e', snapAt: NOW, snap: { powerCapVer: 1, targets: [{ key: 'KZ', vcenterId: 'vcE' }], powerCaps: [] } }]);
  assert.equal(v.rackServers.rows.find((x) => x.key === 'KA').judgeReason, 'corp-edge-owned');
  v = await view([old, { agent: 'Edge-E', snapAt: NOW, snap: { powerCapVer: 1, targets: [{ key: 'KA', vcenterId: 'vcE' }], powerCaps: [] } }]);
  const ka3 = v.rackServers.rows.find((x) => x.key === 'KA');
  assert.equal(ka3.judgeNode, 'Edge-E'); assert.equal(ka3.judgeReason, null);
});
