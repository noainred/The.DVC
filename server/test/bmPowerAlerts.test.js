/**
 * 다음 점검 ②③ — 전력 · 온도 알림 규칙 4종(랙 여유 · 흡기 지속 · 피크 급증 · PowerCap 걸림) + 엣지 서버 PowerCap.
 *   ① 조건(순수): 미측정 · 부분 합 · 낡은 센서 · 표본 모자람은 null(보류 — 0 · 정상이 아니다) · 규칙 ↔ 항목 종류 · 랙 키
 *   ② 판정 입력(powerAlertItems — 실제 gatherPower · aggregatePower): 랙(상한 랙만 · 일부만 측정 = 보류) · (법인, 키) 쌍 · 피크 급증 창(24시간 ↔ 앞 7일 겹침 없음)
 *   ③ 실제 규칙 엔진(runPerfAlerts): 지속 = 서로 다른 표본 · 낡음은 잇지도 끊지도 않음 · 해제 · 재발 억제 · 하루 상한 · 채널 · 이슈(중앙 생성 · 엣지 pending-central) · 법인 예외 · 상태 열쇠 쌍
 *   ④ 실제 정비 창(판정기 · 창 파일): 서버 · 랙(서버 하나라도 창 안) 기록만 → 창 뒤 1회 · 창 안 해제는 억제하지 않는다
 *   ⑤ 실제 폴러 배선(pollBmUsageOnce → runCyclePerfAlerts → powerAlertItems(실제 원천 · localOnly) → 발송 기록)
 *   ⑥ 엣지 PowerCap: 봉투(실제 collector 라우터 · 실제 pullBmUsage 왕복) → 중앙 정제(화이트리스트) → 중앙 전력 보기 · 걸림 판정 · 구버전 = ‘엣지 버전 낮음’(그때만) · 낡음
 *   ⑦ 중앙 이력 재구성(랙 키 · 법인은 중앙이 정함 · capacity 규칙 id 정정) · 설정 정규화(자동 집중 꺼짐 · 피크 기준 범위)
 * 기준 시각: 실제 시각을 정시로 내린 뒤 −20분(common.md) — 정비 창 · 폴러는 실제 시각(제품이 실제 시각으로 판정)이라 그 시험만 Date.now().
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmpowal-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.COLLECTOR_TOKEN = 'tok-pw';
process.env.AUTH_ENABLED = 'true';
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 2, matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const MIN = 60_000; const HOUR = 3_600_000; const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 20 * MIN;
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }

const PA = await import('../src/bmusage/powerAlerts.js');
const AG = await import('../src/bmusage/powerAgg.js');
const A = await import('../src/bmusage/perfAlerts.js');
const R = await import('../src/bmusage/perfRules.js');
const STATE = () => JSON.parse(fs.readFileSync(path.join(DIR, 'bm-perf-alert-state.json'), 'utf8'));

/* ── 원천 묶음(시험 주입 — gatherPower 가 읽는 모양) ── */
function sourcesOf({ measured = [], analysis = [], inv = {}, sensors = {}, hourly = {} } = {}) {
  return async () => ({
    measured: async () => measured,
    analysisServers: async () => analysis,
    fanFaults: async () => [],
    powerDb: async () => ({ hourlyStats: (k, from, to) => (hourly[k] || []).filter((r) => r.ts >= Math.floor(from / HOUR) * HOUR && r.ts < Math.ceil(to / HOUR) * HOUR) }),
    inventoryOf: (a, regId) => inv[String(a?.id || regId || '')] || null,
    sensorLatest: (id) => sensors[id] || null,
    temps: { classify: (nm) => (/inlet/i.test(nm) ? 'inlet' : 'cpu'), maxAgeOf: () => 15 * MIN },
  });
}
const rulesOf = (on = {}, extra = {}) => R.normalizeRules({ rules: Object.fromEntries(Object.entries(on).map(([id, x]) => [id, { on: true, channels: ['email'], ...x }])), ...extra }, { strict: true }).value;
function depsOf(o = {}) {
  const sends = []; const issues = [];
  return {
    sends, issues,
    deps: { alertConfig: async () => ({ channels: { email: { enabled: true }, webhook: { enabled: true } } }), notify: async (al, cfg) => { sends.push({ al, cfg }); return ['email:ok']; }, outcome: async () => 'delivered',
      retryDelay: async () => null, applyIssues: async (f) => { issues.push(...f); return { byId: Object.fromEntries(f.map((x) => [x.id, 'created'])) }; }, startFocus: async () => ({ ok: true }), isMock: async () => false, clock: () => NOW,
      maintJudge: async () => null, ...o },
  };
}
const srvItem = (key, vc, p = {}) => ({ key, name: `bm-${key}`, vcenterId: vc, target: { key, vcenterId: vc }, power: { kind: 'server', inletWarnC: 27, capHitPct: 98, surgePct: 20, tempState: 'ok', ...p } });

test('① 조건(순수) — 미측정 · 부분 합 · 낡은 센서 · 표본 모자람은 보류(null) · 규칙 ↔ 항목 종류 · 랙 키', () => {
  const C = PA.powerCondition;
  // 랙
  assert.equal(C('rack', { power: { kind: 'rack', low: true } }), true);
  assert.equal(C('rack', { power: { kind: 'rack', low: false } }), false);
  assert.equal(C('rack', { power: { kind: 'rack', low: null, marginPartial: true } }), null, '일부만 측정된 랙은 보류(부분 합 — 8b F6)');
  assert.equal(C('rack', { power: { kind: 'server', low: true } }), null, '종류가 다르면 보류');
  // 흡기
  assert.equal(C('inlet', { power: { kind: 'server', tempState: 'ok', inletC: 27, inletWarnC: 27 } }), true, '화면 ‘더운 서버’ 와 같은 ≥');
  assert.equal(C('inlet', { power: { kind: 'server', tempState: 'ok', inletC: 26.9, inletWarnC: 27 } }), false);
  assert.equal(C('inlet', { power: { kind: 'server', tempState: 'stale', inletC: 40, inletWarnC: 27 } }), null, '낡은 센서는 초과도 정상도 아니다');
  assert.equal(C('inlet', { power: { kind: 'server', tempState: 'none', inletC: null, inletWarnC: 27 } }), null);
  assert.equal(C('inlet', { power: { kind: 'server', tempState: 'ok', inletC: null, inletWarnC: 27 } }), null, '흡기 센서 없음(CPU 만)');
  // PowerCap
  assert.equal(C('powerCap', { power: { kind: 'server', capHit: true } }), true);
  assert.equal(C('powerCap', { power: { kind: 'server', capHit: false } }), false);
  assert.equal(C('powerCap', { power: { kind: 'server', capHit: null } }), null, '미측정 · 상한 없음');
  // 피크 급증
  const sg = (peak, base, hours = 168) => PA.surgeOf({ peakW: peak, hours: 24, byHour: [{ t: NOW - HOUR, w: 1 }] }, base == null ? null : { peakW: base, hours }, 20);
  assert.equal(C('surge', { power: { kind: 'server', surgePct: 20, surge: sg(1200, 1000) } }), true, '+20% = 걸림');
  assert.equal(C('surge', { power: { kind: 'server', surgePct: 20, surge: sg(1199, 1000) } }), false);
  assert.equal(sg(1200, 1000).ratioPct, 20);
  assert.equal(C('surge', { power: { kind: 'server', surgePct: 20, surge: sg(5000, 1000, PA.SURGE_MIN_BASE_HOURS - 1) } }), null, '앞 7일 표본이 모자라면 보류(피크가 낮게 잡혀 거짓 급증)');
  assert.equal(sg(5000, 1000, PA.SURGE_MIN_BASE_HOURS - 1).state, 'short');
  assert.equal(C('surge', { power: { kind: 'server', surgePct: 20, surge: sg(5000, null) } }), null, '앞 7일 없음');
  assert.equal(PA.surgeOf(null, { peakW: 1000, hours: 168 }, 20).state, 'none', '24시간 미측정');
  // 관측 표지
  assert.equal(PA.powerObs('inlet', { power: { tempAt: 5 } }), 't5'); assert.equal(PA.powerObs('inlet', { power: { tempAt: null } }), null);
  assert.equal(PA.powerObs('powerCap', { power: { at: 7 } }), 'w7');
  // 규칙 ↔ 항목 종류 — 서로의 항목에 대 보지 않는다(같은 키 상태를 덮지 않게)
  assert.equal(A.ruleApplies('inlet', { power: { kind: 'server' } }), true);
  assert.equal(A.ruleApplies('rack', { power: { kind: 'server' } }), false);
  assert.equal(A.ruleApplies('use', { power: { kind: 'server' } }), false);
  assert.equal(A.ruleApplies('inlet', { key: 'K', entry: {} }), false);
  assert.equal(A.ruleApplies('use', { key: 'K', entry: {} }), true);
  // 상태 열쇠 — 전력은 (법인, 키) 쌍 · 예전 규칙은 예전 그대로
  assert.equal(A.stateKeyOf('inlet', { key: 'K', vcenterId: 'vcA' }), 'inlet|vcA|K');
  assert.equal(A.stateKeyOf('use', { key: 'K', vcenterId: 'vcA' }), 'use|K');
  // 랙 키
  assert.equal(PA.rackKeyOf('vcA', 'A|07'), 'rack:vcA|A|07');
  assert.deepEqual(PA.parseRackKey('rack:vcA|A|07'), { vcenterId: 'vcA', rack: 'A|07' });
  assert.equal(PA.parseRackKey('rack:|A'), null); assert.equal(PA.parseRackKey('K1'), null);
});

test('② 판정 입력 — 실제 집계 · 상한 랙만 · 일부만 측정 = 보류 · (법인, 키) 쌍 · 24시간 ↔ 앞 7일 창 겹침 없음', async () => {
  AG._resetPowerAggForTest();
  // 24시간 요약의 첫 행 = hourlyStats(now − 24h, now) 의 hb ≥ floor((now − 24h)/1h) — 시험이 제품 함수(weekWindowEnd)를 쓰지 않고 따로 센다(변이 M24).
  const E = Math.floor((NOW - DAY) / HOUR) * HOUR;
  assert.equal(AG.weekWindowEnd(NOW), E);
  const rowsFull = [];
  for (let ts = E - 7 * DAY; ts < E; ts += HOUR) rowsFull.push({ ts, avg: 800, max: 1000 });
  for (let ts = E; ts <= NOW; ts += HOUR) rowsFull.push({ ts, avg: 900, max: ts === E ? 1300 : 950 });   // 창 첫 시간(E)은 24시간 쪽
  const rowsShort = [];
  for (let ts = E - 50 * HOUR; ts < E; ts += HOUR) rowsShort.push({ ts, avg: 500, max: 600 });
  for (let ts = E; ts <= NOW; ts += HOUR) rowsShort.push({ ts, avg: 900, max: 2000 });
  const src = sourcesOf({
    measured: [
      { serverId: 'r1', watts: 900, ts: NOW - MIN, vcenterId: 'vcA', source: 'idrac' },
      { serverId: 'r2', watts: 100, ts: NOW - MIN, vcenterId: 'vcB', source: 'idrac' },
      { serverId: 'r3', watts: 50, ts: NOW - 2 * MIN, vcenterId: 'vcA', source: 'idrac' },
      { serverId: 'r4', watts: 100, ts: NOW - MIN, vcenterId: 'vcA', source: 'idrac' },
    ],
    analysis: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }, { id: 'r4' }, { id: 'r5' }],
    inv: { r1: { powerCap: { limitWatts: 900 }, collectedAt: NOW - MIN }, r2: { powerCap: { limitWatts: null }, collectedAt: NOW - MIN } },
    sensors: { r1: { t: NOW - MIN, temps: { 'System Board Inlet Temp': 31 } }, r2: { t: NOW - 30 * MIN, temps: { 'System Board Inlet Temp': 40 } } },
    hourly: { r1: rowsFull, r2: rowsShort },
  });
  const targets = [
    { key: 'K1', name: 'a-k1', vcenterId: 'vcA', idrac: { regId: 'r1' } }, { key: 'K1', name: 'b-k1', vcenterId: 'vcB', idrac: { regId: 'r2' } },
    { key: 'K3', name: 'a-k3', vcenterId: 'vcA', idrac: { regId: 'r3' } }, { key: 'K4', name: 'a-k4', vcenterId: 'vcA', idrac: { regId: 'r4' } }, { key: 'K5', name: 'a-k5', vcenterId: 'vcA', idrac: { regId: 'r5' } },
  ];
  const rules = rulesOf({ rack: {}, inlet: {}, surge: {}, powerCap: {} }, { power: { racksText: 'vcA,R1,1.0,K1 K3\nvcA,R2,0.2,K4 K5\nvcB,R3,,K1' } });
  const items = await PA.powerAlertItems({ targets, rules, now: NOW, deps: { sources: src } });
  const srv = items.filter((x) => x.power.kind === 'server');
  const racks = items.filter((x) => x.power.kind === 'rack');
  assert.equal(srv.length, 5, '서버 칸은 대상마다');
  assert.deepEqual(racks.map((x) => x.key).sort(), ['rack:vcA|R1', 'rack:vcA|R2'], '상한 없는 랙(vcB R3 — 서버 있음) · 미매핑은 항목이 없다');
  const r1 = racks.find((x) => x.key === 'rack:vcA|R1');
  assert.equal(r1.power.marginPct, 5, '(1.0 − 0.95) / 1.0'); assert.equal(PA.powerCondition('rack', r1), true);
  assert.equal(r1.members.length, 2);
  const r2 = racks.find((x) => x.key === 'rack:vcA|R2');
  assert.equal(r2.power.marginPartial, true); assert.equal(PA.powerCondition('rack', r2), null, 'K5 미측정 — 부분 합으로 판정하지 않는다');
  const a1 = srv.find((x) => x.vcenterId === 'vcA' && x.key === 'K1'); const b1 = srv.find((x) => x.vcenterId === 'vcB' && x.key === 'K1');
  assert.ok(a1 && b1, '같은 키 · 다른 법인은 두 항목');
  assert.equal(PA.powerCondition('powerCap', a1), true, '900 ≥ 900 × 98%'); assert.equal(a1.power.capState, 'set');
  assert.equal(PA.powerCondition('powerCap', b1), null, '상한 값 없음(unset)은 보류'); assert.equal(b1.power.capState, 'unset');
  assert.equal(PA.powerCondition('inlet', a1), true);
  assert.equal(b1.power.tempState, 'stale'); assert.equal(PA.powerCondition('inlet', b1), null, '30분 낡은 센서(신선도 15분) = 보류');
  // 피크 급증 — 24시간(E 이후) 1300 vs 앞 7일(E 전) 1000 · E 의 행은 앞 7일에 들어가지 않는다
  assert.equal(a1.power.surge.state, 'ok'); assert.equal(a1.power.surge.peakW, 1300); assert.equal(a1.power.surge.baseW, 1000);
  assert.equal(a1.power.surge.baseHours, 7 * 24, '앞 7일은 정확히 168시간(E 의 행은 24시간 쪽)');
  assert.equal(PA.powerCondition('surge', a1), true, '+30%');
  assert.equal(b1.power.surge.state, 'short'); assert.equal(PA.powerCondition('surge', b1), null, '앞 7일 50시간뿐');
  assert.equal(srv.find((x) => x.key === 'K5').power.w, null); assert.equal(PA.powerCondition('powerCap', srv.find((x) => x.key === 'K5')), null);
  // 같은 창 끝(E) 안에서는 앞 7일을 다시 읽지 않는다(정시마다 한 번)
  let reads = 0; let readsEmpty = 0; let other = 0;
  const src2 = async () => { const s = await src(); const db = await s.powerDb(); return { ...s, powerDb: async () => ({ hourlyStats: (k, f, t) => { if (t === E) { if (k === 'r1' || k === 'r2') reads += 1; else readsEmpty += 1; } else if (t !== NOW + MIN) other += 1; return db.hourlyStats(k, f, t); } }) }; };
  await PA.powerAlertItems({ targets, rules, now: NOW + MIN, deps: { sources: src2 } });
  assert.equal(reads, 0, '앞 7일 요약은 캐시(값이 있는 계열 — 같은 창 끝 안)');
  assert.equal(other, 0, '알림 판정은 월 누적(끝난 날 행)을 읽지 않는다 — 24시간 · 앞 7일만');
  assert.ok(readsEmpty >= 1, '값이 없던 계열은 다시 읽는다(늦게 채워지는 행 — 없음을 담지 않는다)');
  // 켠 규칙이 없으면 항목도 없다
  assert.deepEqual(await PA.powerAlertItems({ targets, rules: rulesOf({ use: {} }), now: NOW, deps: { sources: src } }), []);
});

test('③ 실제 규칙 엔진 — 지속 = 서로 다른 표본 · 낡음은 잇지도 끊지도 않음 · 해제 · 재발 억제 · 하루 상한 · 채널 · 이슈 · 법인 예외', async () => {
  A._resetPerfAlertsForTest();
  const { sends, deps } = depsOf();
  const rules = rulesOf({ inlet: { sustain: 3, repeatMin: 60, channels: ['webhook'] } });
  const at = (i) => NOW + i * 5 * MIN;
  const step = async (i, p) => A.runPerfAlerts([srvItem('K1', 'vcA', p), srvItem('K1', 'vcB', { inletC: 20, tempAt: at(i) - MIN })], { rules, now: at(i), deps });
  const st = () => STATE().rules['inlet|vcA|K1'];
  await step(0, { inletC: 31, tempAt: at(0) - MIN });
  assert.equal(st().streak, 1);
  await step(1, { inletC: 31, tempAt: at(0) - MIN });
  assert.equal(st().streak, 1, '같은 표본은 지속에 한 번만');
  await step(2, { inletC: 31, tempAt: at(2) - MIN });
  assert.equal(st().streak, 2);
  await step(3, { inletC: 45, tempAt: at(3) - 40 * MIN, tempState: 'stale' });
  assert.equal(st().streak, 2, '낡은 센서 — 지속을 이어 세지 않는다'); assert.equal(st().active, false);
  assert.equal(sends.length, 0);
  let r = await step(4, { inletC: 31.5, tempAt: at(4) - MIN });
  await A._drainPerfAlertsForTest();
  assert.equal(r.fires, 1, '낡음이 사건을 끊지도 않았다(2 → 3)'); assert.equal(sends.length, 1);
  assert.match(sends[0].al.title, /^\[vcA\] bm-K1 흡기 31\.5 °C\(기준 27 °C 이상\)$/);
  assert.match(sends[0].al.detail, /3주기 지속\(서로 다른 표본\)/); assert.match(sends[0].al.detail, /설정값/);
  assert.ok(!/[`]|\*\*/.test(sends[0].al.title + sends[0].al.detail), '백틱 · ** 없음');
  assert.equal(sends[0].al.key, 'bmperf:inlet:vcA|K1', '알림 열쇠도 (법인, 키) 쌍');
  assert.equal(sends[0].cfg.channels.webhook.enabled, true); assert.equal(sends[0].cfg.channels.email.enabled, false, '규칙이 고른 채널만');
  assert.equal(STATE().rules['inlet|vcB|K1'].streak, 0, '같은 키 · 다른 법인은 다른 상태(20 °C — 아님)');
  await step(5, { inletC: 32, tempAt: at(5) - MIN });
  assert.equal(sends.length, 1, '진행 중 — 다시 보내지 않는다');
  await step(6, { inletC: 25, tempAt: at(6) - MIN });
  assert.equal(st().active, false); assert.equal(st().streak, 0, '해제');
  for (const i of [7, 8, 9]) await step(i, { inletC: 33, tempAt: at(i) - MIN });
  await A._drainPerfAlertsForTest();
  assert.equal(sends.length, 1, '새 사건이어도 재발 억제(60분) 안이면 보내지 않는다'); assert.equal(st().active, true);
  // 하루 상한 · 법인 예외 · 이슈(중앙 생성)
  A._resetPerfAlertsForTest();
  const d2 = depsOf();
  const rules2 = rulesOf({ powerCap: { sustain: 1, issue: true, corpsOff: ['vcB'] } }, { daily: { alerts: 1 } });
  const cap = (key, vc) => srvItem(key, vc, { w: 900, at: NOW - MIN, capW: 900, capPct: 100, capHit: true });
  r = await A.runPerfAlerts([cap('K1', 'vcA'), cap('K2', 'vcA'), cap('K1', 'vcB')], { rules: rules2, now: NOW, deps: d2.deps });
  await A._drainPerfAlertsForTest();
  assert.equal(r.fires, 2, 'vcB 는 법인 예외'); assert.equal(r.queued, 1); assert.equal(r.capped, 1, '법인 하루 상한 1');
  assert.equal(r.counts.fire, 2, '정정: 발화 수를 두 번 세지 않는다(예전 4)'); assert.equal(r.counts.corpOff, 1);
  assert.ok(!STATE().rules['powerCap|vcB|K1'], '예외 법인은 상태도 없다');
  assert.equal(d2.issues.length, 2, '중앙은 이슈 문지기에 넘긴다(하루 상한은 이슈 저장소가 센다)'); assert.equal(d2.issues[0].rule, 'powerCap');
  assert.match(d2.sends[0].al.title, /PowerCap 걸림 — 지금 900 W \/ 상한 900 W\(100% · 기준 98%\)/);
  // 엣지 — 이슈는 ‘pending-central’ 표시만(중앙이 봉투를 받을 때 문지기로 판단)
  const { config } = await import('../src/config.js');
  A._resetPerfAlertsForTest();
  const d3 = depsOf();
  config.agent.centralUrl = 'http://central.invalid';
  try { await A.runPerfAlerts([cap('K1', 'vcA')], { rules: rules2, now: NOW, deps: d3.deps }); } finally { config.agent.centralUrl = ''; }
  await A._drainPerfAlertsForTest();
  assert.equal(d3.issues.length, 0); assert.equal(A.perfAlertStatus().sent.at(-1).issue, 'pending-central');
  // 랙 — 일부만 측정이면 지속 1 이어도 걸리지 않는다 · 다 측정되면 걸린다(서로 다른 표본 2개)
  A._resetPerfAlertsForTest();
  const d4 = depsOf();
  const rk = (low, obs, partial = false) => ({ key: 'rack:vcA|R1', name: '랙 R1', vcenterId: 'vcA', members: [{ key: 'K1', vcenterId: 'vcA' }],
    power: { kind: 'rack', rack: 'R1', capKw: 1, nowKw: 0.95, marginPct: partial ? null : 5, low: partial ? null : low, marginPartial: partial, measured: partial ? 1 : 2, servers: 2, rackLowPct: 10, obs } });
  const rules4 = rulesOf({ rack: { sustain: 2 } });
  await A.runPerfAlerts([rk(null, 'o1', true)], { rules: rules4, now: NOW, deps: d4.deps });
  await A.runPerfAlerts([rk(null, 'o2', true)], { rules: rules4, now: NOW + 5 * MIN, deps: d4.deps });
  assert.equal(STATE().rules['rack|vcA|rack:vcA|R1'].streak, 0, '부분 합 = 보류');
  await A.runPerfAlerts([rk(true, 'o3')], { rules: rules4, now: NOW + 10 * MIN, deps: d4.deps });
  await A.runPerfAlerts([rk(true, 'o3')], { rules: rules4, now: NOW + 15 * MIN, deps: d4.deps });
  assert.equal(d4.sends.length, 0, '같은 표본(관측 표지 o3) 두 번은 1주기');
  await A.runPerfAlerts([rk(true, 'o4')], { rules: rules4, now: NOW + 20 * MIN, deps: d4.deps });
  await A._drainPerfAlertsForTest();
  assert.equal(d4.sends.length, 1); assert.match(d4.sends[0].al.title, /^\[vcA\] 랙 R1 상한 여유 5%\(기준 10% 미만\)$/);
  assert.match(d4.sends[0].al.detail, /측정 2\/2대/);
});

test('④ 실제 정비 창 — 서버 · 랙(배치 서버 전부가 창 안) 기록만 → 창 뒤 1회 · 창 안 해제는 억제하지 않는다', async () => {
  const S = await import('../src/bmusage/maint/schedule.js');
  const ST = await import('../src/bmusage/maint/store.js');
  const MR = await import('../src/bmusage/maint/runtime.js');
  ST._resetMaintStoreForTest(); MR._resetMaintRuntimeForTest();
  const T0 = Date.now();
  const loc = (ms) => S.fmtLocal('Asia/Seoul', ms).replace(' ', 'T');
  // 반증 n2 F2: 랙은 배치 서버 전부가 창 안일 때만 억제 — 이 창은 랙 R1 의 두 서버(K1 · K3)를 다 덮는다(한 대만 덮는 경우는 bmPowerAlertsN2 ②).
  const w = await ST.addWindow({ name: '전력 시험 창', reason: '시험', target: { kind: 'server', keys: ['K1', 'K3'], names: ['bm-K1', 'bm-K3'] }, vcenterId: 'vcA', tz: 'Asia/Seoul',
    schedule: { kind: 'once', start: loc(T0 - 30 * MIN), end: loc(T0 + 60 * MIN) }, scopes: { alerts: true } }, { by: 'op', now: T0 });
  const end = (await MR.maintJudge({ now: T0 })).stateFor({ key: 'K1', vcenterId: 'vcA' }, T0).until.alerts;
  assert.ok(end > T0);
  A._resetPerfAlertsForTest();
  const d = depsOf({ maintJudge: async (now) => MR.maintJudge({ now }), clock: () => Date.now() });
  const rules = rulesOf({ inlet: { sustain: 1, issue: true }, rack: { sustain: 1 } });
  const inl = (t, c = 31, vc = 'vcA') => srvItem('K1', vc, { inletC: c, tempAt: t - MIN });
  const rk = (t, low = true) => ({ key: 'rack:vcA|R1', name: '랙 R1', vcenterId: 'vcA', members: [{ key: 'K1', vcenterId: 'vcA' }, { key: 'K3', vcenterId: 'vcA' }],
    power: { kind: 'rack', rack: 'R1', capKw: 1, nowKw: 0.95, marginPct: low ? 5 : 50, low, marginPartial: false, measured: 2, servers: 2, rackLowPct: 10, obs: `o${t}` } });
  // 같은 키 · 다른 법인(vcB K1 — 창 밖)을 함께 — 대상은 항목이 가진 (법인, 키) 대상으로 판정한다(키 지도에서 다른 법인 대상을 집지 않는다)
  let r = await A.runPerfAlerts([inl(T0), inl(T0, 31, 'vcB'), rk(T0)], { rules, now: T0, deps: d.deps });
  await A._drainPerfAlertsForTest();
  assert.equal(r.maintenance, 2, '서버 · 랙(K1 · K3 모두 창 안) 기록만'); assert.equal(d.issues.length, 1, 'vcB 이슈만');
  assert.deepEqual(d.sends.map((x) => x.al.key), ['bmperf:inlet:vcB|K1'], '창 밖 vcB 는 보낸다 · vcA 는 창 안');
  const rec = A.perfAlertStatus().sent.filter((x) => x.result === 'maintenance');
  assert.deepEqual(rec.map((x) => `${x.rule}:${x.vcenterId}`).sort(), ['inlet:vcA', 'rack:vcA']); assert.deepEqual(rec[0].maint.ids, [w.id]);
  r = await A.runPerfAlerts([inl(T0 + 5 * MIN), inl(T0 + 5 * MIN, 31, 'vcB'), rk(T0 + 5 * MIN)], { rules, now: T0 + 5 * MIN, deps: d.deps });
  assert.equal(r.maintHeld, 2, '같은 창 반복은 한 번만 센다');
  r = await A.runPerfAlerts([inl(end + MIN), inl(end + MIN, 31, 'vcB'), rk(end + MIN)], { rules, now: end + MIN, deps: d.deps });
  await A._drainPerfAlertsForTest();
  assert.equal(r.afterMaint, 2); assert.equal(d.sends.length, 3, 'vcB 는 진행 중(다시 보내지 않음) · 창 뒤 vcA 서버 · 랙 1회씩');
  assert.ok(d.sends.slice(1).every((x) => /^\(정비 창 안부터 초과\) /.test(x.al.title)), JSON.stringify(d.sends.map((x) => x.al.title)));
  // 창 안에 해제 — 해제는 억제하지 않는다(상태가 지워져 창 뒤 발송도 없다)
  A._resetPerfAlertsForTest();
  const d2 = depsOf({ maintJudge: async (now) => MR.maintJudge({ now }), clock: () => Date.now() });
  await A.runPerfAlerts([inl(T0)], { rules, now: T0, deps: d2.deps });
  await A.runPerfAlerts([inl(T0 + 5 * MIN, 20)], { rules, now: T0 + 5 * MIN, deps: d2.deps });
  const s1 = STATE().rules['inlet|vcA|K1'];
  assert.equal(s1.active, false); assert.equal(s1.streak, 0); assert.ok(!s1.maint, '창 안 해제 — 창 표지도 지워진다');
  await A.runPerfAlerts([inl(end + MIN, 20)], { rules, now: end + MIN, deps: d2.deps });
  await A._drainPerfAlertsForTest();
  assert.equal(d2.sends.length, 0, '창 뒤 발송 없음');
  ST._resetMaintStoreForTest(); MR._resetMaintRuntimeForTest();
  for (const f of ['maintenance-windows.json', 'maintenance-windows-deployed.json']) { try { fs.unlinkSync(path.join(DIR, f)); } catch { /* */ } }
});

test('⑤ 실제 폴러 배선 — pollBmUsageOnce → 전력 규칙(실제 원천 · 판정 노드 = 이 노드인 서버만) → 발송 기록 · 상태 열쇠 쌍', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [{ id: 'r-w1', name: 'idrac-w1', host: '10.9.9.1', username: 'root', password: 'p', serviceTag: 'WTAG1', vcenterId: 'vcW' }] }));
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [{ id: 'o-w1', name: 'bm-w1', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: [] },
    { id: 'o-r1', name: 'bm-r1', host: '127.0.0.4', port: 9, username: 'mon', password: 'pw', mounts: [] }] }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcW: true }, osSsh: true, idracTelemetry: false }));
  const T = Date.now();
  // 이 노드 대상인데 전력이 **엣지 사본(remote)** 뿐인 서버 — 판정 주체가 아니다(원천이 엣지). 사본으로 판정하면 랙 W-2(상한 1 kW · 999 W)가 걸린다.
  (await import('../src/collector/state.js')).setRemoteHost('bm-r1', { collectorId: 'edge-x', watts: 999, ts: T - MIN, serviceTag: 'RTAG1', vcenterId: 'vcW', serverName: 'bm-r1', dbKey: 'rmt:bm-r1' });
  const idb = await (await import('../src/idrac/db.js')).getDb();
  idb.insert('r-w1', 445, T - MIN);
  (await import('../src/idrac/invCache.js')).setInventory('r-w1', { system: { serviceTag: 'WTAG1' }, powerCap: { limitWatts: 450 }, collectedAt: T - MIN });
  (await import('../src/idrac/sensorStore.js')).pushSensorSample('r-w1', { t: T - MIN, temps: [{ name: 'System Board Inlet Temp', celsius: 33 }] });
  const poller = await import('../src/bmusage/poller.js');
  const OSm = await import('../src/bmusage/collectors/osSsh.js');
  poller._setFleetForTest(async () => ({ bareMetal: [{ serverId: 'r-w1', name: 'bm-w1', serviceTag: 'WTAG1', vcenterId: 'vcW' }, { serverId: 'x-r1', name: 'bm-r1', serviceTag: 'RTAG1', vcenterId: 'vcW' }], virtualizationHosts: [] }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  const stdout = ['##STAT', 'cpu  10 0 10 1000 0 0 0 0 0 0', '##MEM', 'MemTotal: 1000000 kB', 'MemAvailable: 500000 kB', '##END'].join('\n');
  poller._setOsCollectorForTest(async () => { const sh = OSm.shapeLinux(stdout, []); return { ...sh, ok: true, peak: { windowS: 0 }, stderr: '' }; });
  t.after(() => { poller._setOsCollectorForTest(null); poller._setFleetForTest(null); poller._resetForTest(); R._resetPerfRulesForTest(); });
  R._resetPerfRulesForTest();
  R.savePerfRules({ rules: { inlet: { on: true, sustain: 1 }, powerCap: { on: true, sustain: 1 }, rack: { on: true, sustain: 1 } }, power: { rackLowPct: 20, racksText: 'vcW,W-1,0.5,WTAG1\nvcW,W-2,1.0,RTAG1' } }, { by: 'test' });
  A._resetPerfAlertsForTest();
  AG._resetPowerAggForTest();
  const r = await poller.pollBmUsageOnce({ trigger: 'manual' });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  await A._drainPerfAlertsForTest();
  assert.ok(r.perfAlerts && !r.perfAlerts.error, JSON.stringify(r.perfAlerts));
  const sent = A.perfAlertStatus().sent;
  assert.deepEqual(sent.map((x) => x.rule).sort(), ['inlet', 'powerCap', 'rack'], JSON.stringify(sent.map((x) => [x.rule, x.title])));
  assert.match(sent.find((x) => x.rule === 'inlet').title, /흡기 33 °C/);
  assert.match(sent.find((x) => x.rule === 'powerCap').title, /445 W \/ 상한 450 W/);
  assert.match(sent.find((x) => x.rule === 'rack').title, /\[vcW\] 랙 W-1 상한 여유 11%\(기준 20% 미만\)/);
  const keys = Object.keys(STATE().rules).sort();
  assert.ok(['inlet|vcW|WTAG1', 'powerCap|vcW|WTAG1', 'rack|vcW|rack:vcW|W-1'].every((k) => keys.includes(k)), JSON.stringify(keys));
  // 엣지 사본뿐인 서버(RTAG1)는 이 노드가 판정하지 않는다 — 랙 W-2 는 미측정(부분)이라 보류 · 서버 칸도 보류
  assert.ok(!sent.some((x) => x.key === 'rack:vcW|W-2' || x.key === 'RTAG1'), JSON.stringify(sent.map((x) => x.key)));
  assert.equal(STATE().rules['rack|vcW|rack:vcW|W-2'].streak, 0, '사본 999 W 로 판정하지 않는다(판정 노드 없음 — source-edge)');
  // 반증 n2 F3: 주기 상태에 판정 보류 수 · 전력 판정 항목 수가 남는다(0건과 가른다)
  assert.equal(r.perfAlerts.powerItems, 4, '서버 2 + 랙 2'); assert.ok(r.perfAlerts.held >= 1, JSON.stringify(r.perfAlerts));
  assert.equal(r.perfAlerts.powerError, undefined);
});

test('⑥ 엣지 PowerCap — 실제 collector 라우터 · pullBmUsage 왕복 → 정제 → 중앙 전력 보기 · 걸림 · 구버전(그때만 버전 안내) · 낡음', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  // 이 프로세스가 엣지 역할 — iDRAC 경로가 있는 대상(regId) · 인벤토리 캐시의 상한
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [{ id: 'r-e1', name: 'idrac-e1', host: '10.9.8.1', username: 'root', password: 'p', serviceTag: 'ETAG1', vcenterId: 'vcE' },
    { id: 'r-e2', name: 'idrac-e2', host: '10.9.8.2', username: 'root', password: 'p', serviceTag: 'ETAG2', vcenterId: 'vcE' }] }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcE: true }, osSsh: false, idracTelemetry: true }));
  const T = Date.now();
  const IC = await import('../src/idrac/invCache.js');
  IC.setInventory('r-e1', { powerCap: { limitWatts: 500 }, collectedAt: T - 5 * MIN });
  IC.setInventory('r-e2', { powerCap: { limitWatts: 0 }, collectedAt: T - 5 * MIN });
  const poller = await import('../src/bmusage/poller.js');
  poller._setFleetForTest(async () => ({ bareMetal: [{ serverId: 'r-e1', name: 'bm-e1', serviceTag: 'ETAG1', vcenterId: 'vcE' }, { serverId: 'r-e2', name: 'bm-e2', serviceTag: 'ETAG2', vcenterId: 'vcE' }], virtualizationHosts: [] }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  const express = (await import('express')).default;
  const { collectorRouter } = await import('../src/routes/collector.js');
  const app = express(); app.use('/api/collector', collectorRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const reg = await import('../src/collector/registry.js');
  assert.equal(reg.addCollector({ id: 'pw-edge', name: 'pw-edge', url: `http://127.0.0.1:${srv.address().port}`, token: 'tok-pw' }).ok, true);
  const E = await import('../src/central/bmUsageEdgePull.js');
  t.after(() => { srv.close(); poller._setFleetForTest(null); E._resetForTest(); });
  const env = await E.pullBmUsage('pw-edge');
  assert.equal(env.ok, true, JSON.stringify(env).slice(0, 300));
  const sn = env.rec.snap;
  assert.equal(sn.powerCapVer, 1, '표지(정제를 지나도)');
  assert.deepEqual(sn.powerCaps.map((x) => [x.key, x.limitWatts, x.enabled]).sort(), [['ETAG1', 500, true], ['ETAG2', null, false]]);
  assert.equal(sn.powerCaps.find((x) => x.key === 'ETAG1').at, T - 5 * MIN);
  // 중앙 전력 보기 — 이 노드 대상은 비우고(같은 프로세스) 엣지 보관분 + 그 엣지 사본 전력(remote)으로
  const P = await import('../src/routes/api/bmPower.js');
  AG._resetPowerAggForTest();
  const old = { agent: 'old-edge', snapAt: T, snap: { targets: [{ key: 'OTAG1', name: 'bm-o1', vcenterId: 'vcO' }] } };
  const stale = { agent: 'stale-edge', snapAt: T, snap: { powerCapVer: 1, targets: [{ key: 'STAG1', name: 'bm-s1', vcenterId: 'vcS' }], powerCaps: [{ key: 'STAG1', limitWatts: 300, enabled: true, at: T - 3 * HOUR }] } };
  const measured = [
    { serverId: 'remote:pw-edge:1', watts: 495, ts: T - MIN, vcenterId: 'vcE', serviceTag: 'ETAG1', source: 'remote', dbKey: 'rmt:bm-e1' },
    { serverId: 'remote:old-edge:1', watts: 300, ts: T - MIN, vcenterId: 'vcO', serviceTag: 'OTAG1', source: 'remote', dbKey: 'rmt:bm-o1' },
    { serverId: 'remote:stale-edge:1', watts: 299, ts: T - MIN, vcenterId: 'vcS', serviceTag: 'STAG1', source: 'remote', dbKey: 'rmt:bm-s1' },
  ];
  const deps = { currentTargets: async () => ({ targets: [] }), listEdgeBmUsage: async () => [...E.listEdgeBmUsage(), old, stale], now: () => T,
    rules: async () => R.normalizeRules({}, { strict: false }).value, minEdgeVersion: async () => '9.9.9',
    sources: async () => ({ ...(await sourcesOf({ measured, analysis: [] })()), powerDb: async () => ({ hourlyStats: () => [] }) }) };
  const view = await P.bmPowerView({ user: { username: 'adm', role: 'admin' }, query: {} }, { vcenters: [] }, deps);
  const all = [...view.hot, ...view.capHit];
  const e1 = all.find((x) => x.key === 'ETAG1');
  assert.ok(e1, JSON.stringify(view.capHit));
  assert.equal(e1.capW, 500); assert.equal(e1.capState, 'set'); assert.equal(e1.capHit, true, '495 ≥ 500 × 98% — 엣지 상한으로 걸림 판정');
  assert.equal(view.fleet.capSet, 1, '상한 있는 서버는 엣지 1대(ETAG1 — ETAG2 는 값 없음 · 구버전 · 낡음은 세지 않는다)');
  assert.equal(view.capOldEdge, 1); assert.equal(view.capMinEdgeVersion, '9.9.9', '구버전 엣지가 있을 때만 버전 안내');
  const rows = (vc) => P.bmPowerView({ user: { username: 'adm', role: 'admin' }, query: { rack: `${vc}|` } }, { vcenters: [] }, deps);
  const o1 = (await rows('vcO')).rackServers.rows[0];
  assert.equal(o1.capState, 'old-version'); assert.equal(o1.capW, null);
  const s1 = (await rows('vcS')).rackServers.rows[0];
  assert.equal(s1.capState, 'stale', '엣지가 읽은 지 3시간 — 지금 사실이 아니다'); assert.equal(s1.capW, null); assert.equal(s1.capHit, null, '낡은 상한으로 걸림을 판정하지 않는다');
  const e2 = (await rows('vcE')).rackServers.rows.find((x) => x.key === 'ETAG2');
  assert.equal(e2.capState, 'unset');
  // 구버전 엣지가 없으면 버전 안내도 없다(못 읽음 · 낡음에 버전 이유를 붙이지 않는다)
  const v2 = await P.bmPowerView({ user: { username: 'adm', role: 'admin' }, query: {} }, { vcenters: [] }, { ...deps, listEdgeBmUsage: async () => [...E.listEdgeBmUsage(), stale] });
  assert.equal(v2.capOldEdge, undefined); assert.equal(v2.capMinEdgeVersion, undefined);
});

test('⑥-2 정제(순수) — 아는 필드 · 수치 · 상한 · 대상 밖 키 · 중복 · 모순 · 시각 clamp(원본 따로)', async () => {
  const C = await import('../src/central/bmPowerCapSanitize.js');
  const keys = new Set(['A', 'B', 'C', 'D', 'E']);
  const r = C.sanitizePowerCaps([
    { key: 'A', limitWatts: '400', enabled: true, at: NOW - MIN, evil: 'x', __proto__: { y: 1 } },
    { key: 'B', limitWatts: 1e9, enabled: true, at: NOW },
    { key: 'C', limitWatts: 300, enabled: 'yes', at: NOW + 10 * DAY },
    { key: 'A', limitWatts: 1, enabled: true, at: NOW },
    { key: 'Z', limitWatts: 1, enabled: true, at: NOW },
    'junk', null,
    { key: 'D', limitWatts: null, enabled: false, at: '12' },
  ], { targetKeys: keys, now: NOW });
  assert.deepEqual(r.list.map((x) => Object.keys(x).sort().join(',')), ['at,enabled,key,limitWatts', 'at,enabled,key,limitWatts', 'at,atRaw,enabled,key,limitWatts', 'at,enabled,key,limitWatts']);
  assert.deepEqual(r.list.map((x) => [x.key, x.limitWatts, x.enabled]), [['A', 400, true], ['B', null, null], ['C', 300, null], ['D', null, false]]);
  assert.equal(r.list.find((x) => x.key === 'C').at, NOW, '엣지 미래 시각은 수신 시각으로'); assert.equal(r.list.find((x) => x.key === 'C').atRaw, NOW + 10 * DAY);
  assert.equal(r.list.find((x) => x.key === 'D').at, 12, '문자열 수치는 수로');
  assert.equal(r.dropped, 4, '중복 A · 대상 밖 Z · 객체 아님 2');
  const big = C.sanitizePowerCaps(Array.from({ length: C.POWER_CAPS_MAX + 5 }, (_, i) => ({ key: `k${i}` })), { targetKeys: new Set(), now: NOW });
  assert.equal(big.dropped, C.POWER_CAPS_MAX + 5);
  // 봉투 전체 정제(sanitizeBmUsageSnap)도 같은 규칙 · 표지는 작은 양의 정수만
  const { sanitizeBmUsageSnap } = await import('../src/central/bmUsageEdgePull.js');
  const s = sanitizeBmUsageSnap({ node: { agent: 'e' }, targets: [{ key: 'A' }], powerCapVer: 1, powerCaps: [{ key: 'A', limitWatts: 400, enabled: true, at: NOW }, { key: 'X', limitWatts: 1, enabled: true }] }, { receivedAt: NOW });
  assert.equal(s.powerCapVer, 1); assert.equal(s.powerCaps.length, 1); assert.equal(s.powerCapsDropped, 1);
  assert.equal(sanitizeBmUsageSnap({ node: {}, powerCapVer: '1' }).powerCapVer, undefined);
  const idx = C.edgeCapIndex(s);
  assert.deepEqual(idx('A'), { state: 'set', limitWatts: 400, at: NOW }); assert.deepEqual(idx('Q'), { state: 'unread' });
  assert.deepEqual(C.edgeCapIndex({ targets: [] })('A'), { state: 'old-version' }, '표지 없음 = 구버전(그때만)');
  // 엣지 봉투 필드(순수 부분) — 대상 밖 · regId 없음 · 인벤토리 없음 · PowerLimit 미보고는 싣지 않는다
  const EP = await import('../src/bmusage/edgePull.js');
  const inv = { r1: { powerCap: { limitWatts: 410.4 }, collectedAt: NOW }, r2: { powerCap: { limitWatts: 0 }, collectedAt: NOW }, r3: { collectedAt: NOW } };
  const env = EP.envelopePowerCaps([{ key: 'A', idrac: { regId: 'r1' } }, { key: 'B', idrac: { regId: 'r2' } }, { key: 'C', idrac: { regId: 'r3' } }, { key: 'D' }, { key: 'OUT', idrac: { regId: 'r1' } }, { key: 'E', idrac: { regId: 'r9' } }],
    new Set(['A', 'B', 'C', 'D', 'E']), { inventoryOf: (id) => inv[id] || null });
  assert.equal(env.powerCapVer, 1);
  assert.deepEqual(env.powerCaps, [{ key: 'A', limitWatts: 410, enabled: true, at: NOW }, { key: 'B', limitWatts: null, enabled: false, at: NOW }]);
});

test('⑦ 중앙 이력 재구성(랙 · capacity 정정) · 최소 엣지 버전 표지 · 설정 정규화', async () => {
  const OP = await import('../src/central/bmPerfOpsPull.js');
  const sent = OP.sanitizeAlertSent([
    { id: 'a1', at: NOW, rule: 'capacity', key: 'T1', name: 'x', vcenterId: 'vcA', title: 't', channels: [], result: 'sent' },
    { id: 'a2', at: NOW, rule: 'rack', key: 'rack:vcEVIL|R-9', name: 'x', vcenterId: 'vcEVIL', title: 'http://evil.example', channels: [], result: 'sent' },
    { id: 'a3', at: NOW, rule: 'inlet', key: 'T1', name: 'x', vcenterId: 'vcA', title: 't', channels: [], result: 'sent' },
    { id: 'a4', at: NOW, rule: 'rack', key: 'rack:vcA|\u0001bad', name: 'x', vcenterId: 'vcA', title: 't', channels: [], result: 'sent' },
    { id: 'a5', at: NOW, rule: 'nope', key: 'T1', name: 'x', vcenterId: 'vcA', title: 't', channels: [], result: 'sent' },
  ], NOW);
  assert.deepEqual(sent.map((x) => x.rule), ['capacity', 'rack', 'inlet', 'rack', 'use'], '정정: capacity 가 ‘use’ 로 바뀌지 않는다(규칙 id 는 규칙 목록 하나)');
  const resolveVc = async (p) => ({ id: p.claimedVcenterId === 'vcA' ? 'vcA' : 'vcA', name: 'A' });   // 그 엣지 담당은 vcA 하나
  const c = await OP.centralizeEdgeSent('edge-a', { perfAlertSent: sent, targets: [{ key: 'T1', name: 'bm-t1', vcenterId: 'vcA', serviceTag: '' }] }, { resolveVc });
  const rack = c.list.find((x) => x.rule === 'rack');
  assert.equal(rack.key, 'rack:vcA|R-9', '키 안의 법인도 중앙이 정한 것으로 다시 만든다'); assert.equal(rack.vcenterId, 'vcA');
  assert.equal(rack.title, '랙 R-9 — 랙 여유 부족(수집 노드 edge-a)', '엣지 제목 글자는 쓰지 않는다');
  assert.equal(c.list.filter((x) => x.rule === 'rack').length, 1, '제어문자 랙 이름은 버린다'); assert.equal(c.dropped, 1);
  assert.equal(c.list.find((x) => x.rule === 'inlet').title, 'bm-t1 — 흡기 온도 지속 초과(수집 노드 edge-a)');
  assert.equal(c.list.find((x) => x.rule === 'capacity').title, 'bm-t1 — 용량 소진 예측(수집 노드 edge-a)');
  // 최소 엣지 버전 — 릴리스 노트 표지(숫자를 박지 않는다)
  const F = await import('../src/central/featureMinEdgeVersion.js');
  const notes = path.join(DIR, 'notes.json');
  fs.writeFileSync(notes, JSON.stringify({ notes: [{ version: '2.950.0', title: '베어메탈 사용률 — 전력 알림 규칙 · 엣지 PowerCap(랙 여유 · 흡기 · 피크 급증 · PowerCap)' }, { version: '2.951.0', title: '베어메탈 사용률 — 전력 알림 규칙 · 엣지 PowerCap 후속' }] }));
  F._resetFeatureMinEdgeVersionForTest(F.POWER_ALERT_TITLE_RE);
  assert.equal(F.powerCapMinEdgeVersion({ notesFile: notes }), '2.950.0');
  F._resetFeatureMinEdgeVersionForTest(F.POWER_ALERT_TITLE_RE);
  assert.equal(F.powerCapMinEdgeVersion({ notesFile: path.join(DIR, 'none.json'), fallback: () => '2.960.0' }), '2.960.0');
  F._resetFeatureMinEdgeVersionForTest(F.POWER_ALERT_TITLE_RE);
  // 설정 — 전력 규칙은 자동 집중 꺼짐 · 피크 기준 범위 · 기본 꺼짐
  const v = R.normalizeRules({ rules: { inlet: { on: true, autoFocus: true }, surge: { on: true, autoFocus: true } }, power: { surgePct: 35 } }).value;
  assert.equal(v.rules.inlet.autoFocus, false); assert.equal(v.rules.surge.autoFocus, false); assert.equal(v.power.surgePct, 35);
  assert.throws(() => R.normalizeRules({ power: { surgePct: 4 } }), /power\.surgePct/);
  assert.deepEqual(Object.keys(R.normalizeRules({}).value.rules), [], '기본 꺼짐');
  for (const id of R.POWER_RULE_IDS) { assert.ok(R.RULE_IDS.includes(id)); assert.ok(R.AUTOFOCUS_OFF.includes(id)); assert.equal(R.RULE_DEFAULTS[id].autoFocus, false); }
  const { BMPERF_RULE_LABEL, planBmPerfIssues } = await import('../src/issues/alertIssues.js');
  for (const id of R.RULE_IDS) assert.ok(BMPERF_RULE_LABEL[id], `이슈 라벨 ${id}`);
  // 이슈 열쇠 — 전력 규칙은 (법인, 키) 쌍(같은 노드 · 같은 키 · 다른 법인은 다른 이슈) · 예전 규칙은 예전 열쇠
  const plan = planBmPerfIssues([{ id: 'i1', at: NOW, rule: 'inlet', key: 'K1', vcenterId: 'vcA', agent: 'n' }, { id: 'i2', at: NOW, rule: 'inlet', key: 'K1', vcenterId: 'vcB', agent: 'n' },
    { id: 'u1', at: NOW, rule: 'use', key: 'K1', vcenterId: 'vcA', agent: 'n' }]);
  assert.deepEqual(plan.actions.map((a) => [a.type, a.alertKey]), [['create', 'bmperf:n|vcA|K1|inlet'], ['create', 'bmperf:n|vcB|K1|inlet'], ['create', 'bmperf:n|K1|use']]);
});
