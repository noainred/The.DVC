/**
 * 리눅스 성능 8b단계 ㉒ — 전력 · 온도 집계(미측정 제외 · 랙 · 미매핑 · 피크 · kWh · 교차 검증 · 원천 모으기 · 범위 · 랙 배치 설정).
 *   ① 집계(순수): 미측정(iDRAC 없음 · 읽기 실패 · 0 W)은 합계에서 빼고 사유별로 센다 · 랙 상한 여유 · PowerCap 걸림(≥98%) · 피크는 측정 서버가 다 모인 시간만 · kWh = 시간 평균 합
 *   ② **교차 검증**: 같은 측정 목록 → 전력 대시보드(/power-breakdown — insights/powerBreakdown.js computePowerBreakdown)의 법인 합 = 이 집계의 법인 지금 합(한 소스 · 두 화면)
 *   ③ 원천 모으기(gatherPower): 대상 ↔ 측정(등록부 id · 서비스 태그 · 같은 법인) · 0 W = zero · iDRAC 없음 · 읽기 실패 · 시간 롤업 24h · 월 누적(끝난 날 캐시) · 온도(분류 · 신선도) · 팬(파트 장애)
 *   ④ 라우트: 범위로 서버를 **먼저** 거른 뒤 합한다(범위 밖 서버가 합 · 랙에 섞이지 않는다) · 랙 배치도 보이는 법인 것만 · ?rack 목록
 *   ⑤ 랙 배치 설정: 텍스트 → 랙(서버가 해석) · 같은 랙 두 번 · 한 서버 두 랙 · 상한 범위 · 엄격 = 400
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm8bpow-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 20 * 60_000;
const A = await import('../src/bmusage/powerAgg.js');

const hours = (w, n = 24, base = NOW) => Array.from({ length: n }, (_, i) => ({ ts: base - (n - i) * HOUR, avg: w, max: w + 10 }));
// 월 누적의 기대값(제품과 따로 센다 — 포탈 날 = util/dayKey.js 오프셋 · 기본 KST). 시험 ③ · ③-2 가 같이 쓴다.
const { DAY_OFFSET_MIN, DAY_MS } = await import('../src/util/dayKey.js');
const OFF = DAY_OFFSET_MIN * 60_000;
const kstDayStart = (ts) => Math.floor((ts + OFF) / DAY_MS) * DAY_MS - OFF;
const kstMonthStart = (ts) => { const d = new Date(ts + OFF); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - OFF; };
const finishedDays = (ts) => Math.round((kstDayStart(ts) - kstMonthStart(ts)) / DAY_MS);
const todayHours = (ts) => Math.min(24, Math.floor((ts - kstDayStart(ts)) / HOUR));   // 24시간 조회 행(정시 - k시간) 중 오늘 것
const kwhOf = (w, ts) => { const h = finishedDays(ts) * 24 + todayHours(ts); return h ? Math.round(((h * w) / 1000) * 10) / 10 : null; };
const srv = (key, vc, w, extra = {}) => ({ key, name: key, vcenterId: vc, node: '', via: 'local', w, unmeasured: w == null ? (extra.unmeasured || 'read-fail') : null, h24: w == null ? null : A.hourSummary(hours(w)), kwhMonth: w == null ? null : 100, capW: null, inletC: null, maxC: null, ...extra });

test('① 집계 — 미측정 제외 · 랙 · 미매핑 · 여유 · 걸림 · 피크 · kWh', () => {
  const servers = [srv('A1', 'v1', 400, { capW: 405, inletC: 31.2, maxC: 78 }), srv('A2', 'v1', 300, { inletC: 24 }), srv('A3', 'v1', null, { unmeasured: 'zero' }), srv('A4', 'v1', null, { unmeasured: 'no-idrac' }), srv('B1', 'v2', 200)];
  const racks = [{ vcenterId: 'v1', rack: 'A-07', capKw: 0.75, servers: [{ key: 'A1', u: 38 }, { key: 'A2', u: 36 }, { key: 'A3', u: 30 }] }];
  const r = A.aggregatePower(servers, { racks, cfg: { inletWarnC: 27, capHitPct: 98, rackLowPct: 10 } });
  assert.equal(r.fleet.nowKw, 0.9, '측정분만(400+300+200)'); assert.equal(r.fleet.measured, 3); assert.equal(r.fleet.unmeasuredN, 2);
  assert.deepEqual(r.fleet.unmeasured, { 'no-idrac': 1, 'read-fail': 0, zero: 1 }, '0 W 보고는 따로 센다(합에 0 으로 넣지 않는다)');
  const a07 = r.racks.find((x) => x.rack === 'A-07');
  // 반증 F6: A-07 은 3대 중 A3 미측정(0 W 보고) — 부분 합(0.7 kW)으로 여유를 판정하지 않는다(나머지가 쓰면 실제 여유는 더 작다)
  assert.equal(a07.servers, 3); assert.equal(a07.nowKw, 0.7, '합은 측정분만(따로 표시)');
  assert.equal(a07.marginPct, null, '일부만 측정된 랙은 여유를 내지 않는다(예전 6.7%)'); assert.equal(a07.low, null, '낮음 판정 보류(false 도 아니다)'); assert.equal(a07.marginPartial, true);
  assert.equal(r.fleet.minMargin, null, '여유 최소 후보는 다 측정된 랙만'); assert.equal(r.fleet.partialRacks, 1);
  // 다 측정된 랙은 그대로 판정(A3 를 측정했다고 하자)
  const full = A.aggregatePower([srv('A1', 'v1', 400), srv('A2', 'v1', 300), srv('A3', 'v1', 0.000001)], { racks, cfg: { rackLowPct: 10 } });
  const f07 = full.racks.find((x) => x.rack === 'A-07');
  assert.equal(f07.marginPct, 6.7); assert.equal(f07.low, true, '여유 10% 미만'); assert.equal(f07.marginPartial, false);
  assert.deepEqual(full.fleet.minMargin, { vcenterId: 'v1', rack: 'A-07', pct: 6.7 }); assert.equal(full.fleet.partialRacks, 0);
  // 반증 재현(rv8b/rack.mjs): 상한 5 kW · 4대 중 1대만 4,000 W → 예전 여유 20% · 주의 아님 — 이제 판정 없음
  const rp = A.aggregatePower([srv('R1', 'v', 4000), srv('R2', 'v', null), srv('R3', 'v', null), srv('R4', 'v', null, { unmeasured: 'zero' })],
    { racks: [{ vcenterId: 'v', rack: 'R1', capKw: 5, servers: ['R1', 'R2', 'R3', 'R4'].map((key) => ({ key })) }] });
  assert.equal(rp.racks[0].marginPct, null); assert.equal(rp.racks[0].low, null); assert.equal(rp.fleet.minMargin, null);
  const un = r.racks.find((x) => x.vcenterId === 'v1' && x.unmapped);
  assert.equal(un.servers, 1, 'A4 = 미매핑'); assert.equal(un.nowKw, null, '측정 0대면 합은 —(0 이 아니다)');
  assert.equal(r.fleet.capHit, 1, '400 ≥ 405 × 98% = 걸림'); assert.equal(r.capHit[0].key, 'A1');
  assert.equal(r.fleet.hotCount, 1); assert.equal(r.hot[0].key, 'A1'); assert.equal(r.hot[0].rack, 'A-07'); assert.equal(r.hot[0].u, 38);
  assert.equal(r.fleet.kwh24, Math.round((400 * 24 + 300 * 24 + 200 * 24) / 1000 * 10) / 10);
  assert.equal(r.fleet.peak24Kw, 0.9); assert.equal(r.fleet.partialHours, 0);
  // 피크 — 한 서버가 마지막 시간에만 빠지면 그 시간은 부분 합 → 피크에서 뺀다
  const p = A.aggregatePower([srv('X1', 'v', 1000, { h24: A.hourSummary(hours(1000)) }), srv('X2', 'v', 500, { h24: A.hourSummary(hours(500, 23, NOW - HOUR).concat([{ ts: NOW - 30 * HOUR, avg: 5000, max: 5000 }])) })]);
  assert.equal(p.fleet.partialHours, 2); assert.equal(p.fleet.peak24Kw, 1.5, '부분 시간(5,000 W 한 대만 있는 시간)을 피크로 쓰지 않는다');
  // 같은 (법인, 키) 두 번은 한 대
  assert.equal(A.aggregatePower([srv('D', 'v', 100), srv('D', 'v', 100), srv('D', 'w', 100)]).fleet.servers, 2);
  // 흡기 분포
  assert.equal(r.bins.find((b) => b.lo === 29).n, 1); assert.equal(r.bins.find((b) => b.lo === 24).n, 1);
  // 응답에 실리는 cfg 는 기준값만 — 설정 원본(전 법인 랙 · 서버 키)을 넘겨도 싣지 않는다(이중 방어 · 라우트도 뗀다)
  const leak = A.aggregatePower([], { cfg: { inletWarnC: 30, racks: [{ vcenterId: 'vcX', rack: 'SECRET-RACK', servers: [{ key: 'SECRETKEY' }] }], racksText: 'vcX,SECRET-RACK,,SECRETKEY' } });
  assert.equal(leak.cfg.inletWarnC, 30); assert.ok(!JSON.stringify(leak.cfg).includes('SECRET'), '집계 cfg 에 랙 원본이 없다');
});

test('② 교차 검증 — 전력 대시보드(computePowerBreakdown)와 같은 입력 · 같은 법인 합', async () => {
  const { computePowerBreakdown } = await import('../src/insights/powerBreakdown.js');
  const measured = [
    { serverId: 'r1', serverName: 'bm-1', watts: 412, vcenterId: 'vcA', serviceTag: 'T1', source: 'idrac', host: 'bm-1', hostNames: ['bm-1'] },
    { serverId: 'r2', serverName: 'bm-2', watts: 0, vcenterId: 'vcA', serviceTag: 'T2', source: 'idrac', host: 'bm-2', hostNames: ['bm-2'] },
    { serverId: 'remote:e:3', serverName: 'bm-3', watts: 255.5, vcenterId: 'vcB', serviceTag: 'T3', source: 'remote', host: 'bm-3', hostNames: ['bm-3'], dbKey: 'rmt:bm-3' },
    { serverId: 'r4', serverName: 'bm-4', watts: 180, vcenterId: 'vcB', serviceTag: 'T4', source: 'ome', host: 'bm-4', hostNames: ['bm-4'] },
  ];
  const snap = { vcenters: [{ id: 'vcA' }, { id: 'vcB' }], hosts: [] };
  const pb = computePowerBreakdown(snap, measured, {});
  const targets = measured.map((m, i) => ({ key: `K${i}`, name: m.serverName, vcenterId: m.vcenterId, serviceTag: m.serviceTag, idrac: m.source === 'idrac' ? { regId: m.serverId } : null, paths: ['idrac'], node: '', via: 'local' }));
  const deps = { measured: async () => measured, analysisServers: async () => [], fanFaults: async () => null, powerDb: async () => null, inventoryOf: () => null, sensorLatest: () => null,
    temps: { classify: () => 'other', maxAgeOf: () => 900_000 }, yielder: async () => {} };
  const servers = await A.gatherPower({ targets, deps, now: NOW });
  const ag = A.aggregatePower(servers);
  for (const vc of ['vcA', 'vcB']) {
    const theirs = pb.byVcenter.find((x) => x.vcId === vc).watts;
    const ours = ag.corps.find((x) => x.vcenterId === vc).nowW;
    assert.equal(ours, theirs, `${vc}: 이 집계 ${ours} W = 전력 대시보드 ${theirs} W(같은 입력 · 같은 합)`);
  }
  assert.equal(ag.fleet.nowW, pb.totals.watts, '함대 합도 같다');
  assert.equal(pb.byVcenter.find((x) => x.vcId === 'vcA').servers - ag.corps.find((x) => x.vcenterId === 'vcA').measured, 1, '대수 차이는 0 W 보고 1대뿐(대시보드는 0 W 를 센다 · 여기는 미측정)');
  // vCenter 추정 전력은 넣지 않는다(power/total.js 와 같은 규칙)
  const withVc = await A.gatherPower({ targets: [{ key: 'V', name: 'esx', vcenterId: 'vcA', serviceTag: 'TV', idrac: null, paths: [] }], deps: { ...deps, measured: async () => [{ serverId: 'vc:x', watts: 999, vcenterId: 'vcA', serviceTag: 'TV', source: 'vcenter' }] }, now: NOW });
  assert.equal(withVc[0].w, null); assert.equal(withVc[0].unmeasured, 'no-idrac');
});

test('③ 원천 모으기 — 매칭 · 사유 · 24h · 월 누적(값은 ③-2 와 같은 식) · 온도 · 팬', async () => {
  A._resetPowerAggForTest();
  const idb = { hourlyStats: (key, from, to) => (key === 'r1' ? hours(400, Math.min(24 * 40, Math.floor((to - from) / HOUR)), to) : key === 'rmt:bm-3' ? hours(250) : []) };
  const measured = [{ serverId: 'r1', watts: 400, vcenterId: 'vcA', serviceTag: 'T1', source: 'idrac' }, { serverId: 'r9', watts: 0, vcenterId: 'vcA', serviceTag: 'T9', source: 'idrac' },
    { serverId: 'remote:e:3', watts: 250, vcenterId: 'vcB', serviceTag: 'T3', source: 'remote', dbKey: 'rmt:bm-3' }];
  const analysis = [{ id: 'r1', serviceTag: 'T1' }, { id: 'edge:3', serviceTag: 'T3', remote: true, sensors: { t: NOW - 60_000, temps: { 'System Board Inlet Temp': 28.5, 'CPU1 Temp': 70, 'DIMM A1': 40 } } }, { id: 'r5', serviceTag: 'T5' }];
  const classify = (n) => (/inlet/i.test(n) ? 'inlet' : /cpu/i.test(n) ? 'cpu' : 'other');
  const deps = { measured: async () => measured, analysisServers: async () => analysis, powerDb: async () => idb,
    fanFaults: async () => [{ kind: 'fan', deviceId: 'r1', deviceKey: 'T1' }],
    inventoryOf: (a, regId) => (regId === 'r1' ? { powerCap: { limitWatts: 500 } } : null), sensorLatest: (id) => (id === 'r1' ? { t: NOW - 3 * 3_600_000, temps: { 'Inlet Temp': 22 } } : null),
    temps: { classify, maxAgeOf: () => 15 * 60_000 }, yielder: async () => {} };
  const targets = [
    { key: 'K1', name: 'bm-1', vcenterId: 'vcA', serviceTag: 'T1', idrac: { regId: 'r1' }, paths: ['idrac'] },
    { key: 'K9', name: 'bm-9', vcenterId: 'vcA', serviceTag: 'T9', idrac: { regId: 'r9' }, paths: ['idrac'] },
    { key: 'K3', name: 'bm-3', vcenterId: 'vcB', serviceTag: 'T3', idrac: null, paths: [], via: 'edge' },
    { key: 'K5', name: 'bm-5', vcenterId: 'vcA', serviceTag: 'T5', idrac: null, paths: [] },
    { key: 'K6', name: 'bm-6', vcenterId: 'vcA', serviceTag: 'T6', idrac: null, paths: ['os'] },
  ];
  const s = Object.fromEntries((await A.gatherPower({ targets, deps, now: NOW })).map((x) => [x.key, x]));
  assert.equal(s.K1.w, 400); assert.equal(s.K1.capW, 500); assert.equal(s.K1.fanWarn, 1); assert.equal(s.K1.h24.hours, 24);
  assert.equal(s.K1.inletC, null, '3시간 전 센서 표본은 낡았다 — 지금 값이 아니다'); assert.equal(s.K1.fanRead, false, '센서가 낡으면 팬은 못 읽음(정상으로 세지 않는다)');
  assert.equal(s.K9.w, null); assert.equal(s.K9.unmeasured, 'zero');
  assert.equal(s.K3.w, 250, '엣지 서버 = 중앙 사본(서비스 태그)'); assert.equal(s.K3.h24.avgW, 250, '시간 롤업은 rmt: 계열'); assert.equal(s.K3.inletC, 28.5); assert.equal(s.K3.maxC, 70);
  assert.equal(s.K5.unmeasured, 'read-fail', 'iDRAC 등록(서버 분석)은 있는데 전력 표본이 없다 = 읽기 실패');
  assert.equal(s.K6.unmeasured, 'no-idrac');
  assert.equal(s.K1.kwhMonth, kwhOf(400, NOW), '월 누적 = 이번 달 끝난 날 + 오늘 지난 시간(KST · 1일 00시대는 값 없음 = null)');
  // 함대 공유 — 같은 열쇠 60초 안에는 한 번만 계산
  let n = 0; const compute = async () => { n += 1; return []; };
  await Promise.all([A.sharedPowerFleet('k', compute, { now: NOW }), A.sharedPowerFleet('k', compute, { now: NOW + 1000 })]);
  assert.equal(n, 1, '동시 요청은 같은 프라미스');
  await A.sharedPowerFleet('k', compute, { now: NOW + 61_000 });
  assert.equal(n, 2);
});

/*
 * ③-2 월 누적 캐시 — **시각과 무관하게**(2026-11-08 고침). 예전 시험은 실제 시각 NOW(정시 -20분) 하나로 돌며
 *   ⓐ ‘월 조회’ 를 `to >= NOW - 1` 로 걸렀다 — NOW + TTL(6시간)이 KST 자정을 넘으면 그 조회의 끝(새 오늘 시작)이 NOW 뒤라 세지 않았다
 *      → KST 18:40~23:40 NOW(실제 19:00~00:59)마다 ‘담은 값도 TTL 뒤 다시 읽는다’ 가 실패(제품은 다시 읽었다 — 시험 결함).
 *   ⓑ 월말 같은 시각대는 새 달에 끝난 날이 없어 다시 읽을 것이 없는데도 ‘늘었다’ 를 요구했다.
 *   ⓒ ‘끝난 날이 있나’ 를 프로세스 시간대의 getDate() 로 봤다 — UTC 프로세스에서 KST 1일 00:40~08:40 은 전달 마지막 날로 보여 단언이 돌고 실패.
 *   ⓓ 1일 00:40 은 이번 달 지난 시간이 0 이라 kwhMonth 가 null 인데 ‘> 0’ 을 요구했다.
 * 이제 이번 달(실제 시각의 KST 달)의 정해진 KST 벽시계 시각마다 같은 순서를 돌리고, 기대값(조회 구간 · kWh)을 KST 달력으로 따로 센다.
 */
async function monthCacheCase(T) {
  A._resetPowerAggForTest();
  const calls = []; let callNow = 0; let late = false;
  const rowsOf = (w, from, to) => hours(w, Math.min(24 * 40, Math.floor((to - from) / HOUR)), to);
  const idb = { hourlyStats: (key, from, to) => {
    if (!(to === callNow && to - from === DAY_MS)) calls.push({ key, from, to });   // 24시간 조회(지금까지)는 빼고 월 누적 조회만 센다
    if (key === 'r1') return rowsOf(400, from, to);
    if (key === 'r9' && late) return rowsOf(300, from, to);
    return [];
  } };
  const measured = [{ serverId: 'r1', watts: 400, vcenterId: 'vcA', serviceTag: 'T1', source: 'idrac' }, { serverId: 'r9', watts: 0, vcenterId: 'vcA', serviceTag: 'T9', source: 'idrac' }];
  const deps = { measured: async () => measured, analysisServers: async () => [{ id: 'r1', serviceTag: 'T1' }], powerDb: async () => idb, fanFaults: async () => [],
    inventoryOf: () => null, sensorLatest: () => null, temps: { classify: () => 'other', maxAgeOf: () => 15 * 60_000 }, yielder: async () => {} };
  const targets = [{ key: 'K1', name: 'bm-1', vcenterId: 'vcA', serviceTag: 'T1', idrac: { regId: 'r1' }, paths: ['idrac'] },
    { key: 'K9', name: 'bm-9', vcenterId: 'vcA', serviceTag: 'T9', idrac: { regId: 'r9' }, paths: ['idrac'] }];
  const gather = async (now) => { callNow = now; return Object.fromEntries((await A.gatherPower({ targets, deps, now })).map((x) => [x.key, x])); };
  const runsOf = (key, from = 0) => calls.filter((c) => c.key === key).slice(from).map((c) => [c.from, c.to]);
  const allFinished = (ts) => (finishedDays(ts) ? [[kstMonthStart(ts), kstDayStart(ts)]] : []);
  const L = `${new Date(T + OFF).toISOString().slice(0, 16)} KST`;
  // 1) 처음 — 이번 달 끝난 날을 한 묶음으로 읽는다 · 값 = 끝난 날 + 오늘 지난 시간
  let s = await gather(T);
  assert.deepEqual(runsOf('r1'), allFinished(T), `${L}: 끝난 날 묶음 하나`);
  assert.equal(s.K1.kwhMonth, kwhOf(400, T), `${L}: 월 누적`);
  // 2) 같은 시각 다시 — 값이 있던 날(r1)은 캐시 · 값이 없던 날(r9)은 담지 않고 다시 읽는다
  const n1 = runsOf('r1').length; const n9 = runsOf('r9').length;
  await gather(T);
  assert.equal(runsOf('r1').length, n1, `${L}: 끝난 날 Wh 는 캐시(요청마다 한 달을 다시 읽지 않는다)`);
  assert.deepEqual(runsOf('r9', n9), allFinished(T), `${L}: 값이 없던 날은 캐시하지 않는다(늦게 채워지는 롤업을 놓치지 않게)`);
  // 3) 늦게 채워진 날 — 처음엔 없던 r9 의 지난 날 롤업이 생기면 다음 계산이 반영한다
  late = true;
  s = await gather(T + 1000);
  assert.equal(s.K9.kwhMonth, kwhOf(300, T + 1000), `${L}: 늦게 온 롤업 반영`);
  // 4) TTL 뒤 — 담은 날도 다시 읽는다: 그 시각의 끝난 날 전부(날 · 달이 바뀌었으면 바뀐 기준 — 새 달 첫날이면 읽을 날이 없다)
  const T2 = T + A.DAY_WH_TTL_MS + 1; const m1 = runsOf('r1').length;
  s = await gather(T2);
  assert.deepEqual(runsOf('r1', m1), allFinished(T2), `${L}: 담은 값도 TTL 뒤 다시 읽는다`);
  assert.equal(s.K1.kwhMonth, kwhOf(400, T2), `${L}: TTL 뒤 월 누적`);
  // 5) TTL 안에 KST 자정을 넘김(30분 뒤) — 담긴 날은 그대로 · 새로 끝난 날 하나만 읽는다(달이 바뀌었으면 읽을 날이 없다 · 지난 시간 0 이면 null)
  A._resetPowerAggForTest(); calls.length = 0; late = false;
  await gather(T);
  const T3 = T + 30 * 60_000; const k1 = runsOf('r1').length;
  s = await gather(T3);
  const crossed = kstDayStart(T3) !== kstDayStart(T) && kstMonthStart(T3) === kstMonthStart(T);
  assert.deepEqual(runsOf('r1', k1), crossed ? [[kstDayStart(T), kstDayStart(T3)]] : [], `${L}: 30분 뒤 — 새로 끝난 날만`);
  assert.equal(s.K1.kwhMonth, kwhOf(400, T3), `${L}: 30분 뒤 월 누적`);
  return { T2, T3 };
}

test('③-2 월 누적 캐시 — KST 자정 · UTC 자정 · 월말 · 1일 · 2일 · 실제 시각(시각과 무관하게 같은 결과)', async () => {
  const M0 = kstMonthStart(NOW);                                   // 실제 시각의 KST 달(규약: 기준은 실제 시각에서 — 달 길이 · 연말도 그 달 그대로)
  const lastDay = Math.round((kstMonthStart(M0 + 32 * DAY_MS) - M0) / DAY_MS);
  const at = (day, hh, mm) => M0 + (day - 1) * DAY_MS + hh * HOUR + mm * 60_000;   // 이번 달 day 일 hh:mm(KST 벽시계)
  const kd = (ts) => kstDayStart(ts); const ud = (ts) => new Date(ts).toISOString().slice(0, 10);
  const cases = [
    ['실제 시각(정시 -20분)', NOW, null],
    ['15일 10:40 — TTL 이 같은 KST 날 안', at(15, 10, 40), ({ T, T2 }) => kd(T2) === kd(T)],
    ['15일 19:40 — TTL 이 KST 자정을 넘는다(예전 시험 실패 시각대)', at(15, 19, 40), ({ T, T2 }) => kd(T2) !== kd(T)],
    ['15일 08:40 — TTL 이 UTC 자정만 넘는다(KST 날은 그대로)', at(15, 8, 40), ({ T, T2 }) => ud(T2) !== ud(T) && kd(T2) === kd(T)],
    ['15일 23:40 — 30분 뒤 KST 자정(담긴 날 + 새로 끝난 날 하나)', at(15, 23, 40), ({ T, T3 }) => kd(T3) !== kd(T)],
    [`말일(${lastDay}일) 19:40 — TTL 이 달을 넘는다(새 달은 끝난 날 없음)`, at(lastDay, 19, 40), ({ T, T2 }) => kstMonthStart(T2) !== kstMonthStart(T)],
    [`말일(${lastDay}일) 23:40 — 30분 뒤 새 달 00:10(값 없음 = null · 0 이 아니다)`, at(lastDay, 23, 40), ({ T, T3 }) => kstMonthStart(T3) !== kstMonthStart(T) && kwhOf(400, T3) === null],
    ['1일 00:40 — 끝난 날도 지난 시간도 없다(null)', at(1, 0, 40), ({ T }) => finishedDays(T) === 0 && kwhOf(400, T) === null],
    ['1일 08:40 — UTC 로는 전달 마지막 날(프로세스 시간대와 무관)', at(1, 8, 40), ({ T }) => finishedDays(T) === 0 && ud(T) !== new Date(T + OFF).toISOString().slice(0, 10)],
    ['2일 10:40 — 끝난 날 하나', at(2, 10, 40), ({ T }) => finishedDays(T) === 1],
  ];
  for (const [name, T, shape] of cases) {
    const r = await monthCacheCase(T);
    if (shape) assert.ok(shape({ T, ...r }), `사례가 말한 경계를 실제로 지난다 — ${name}`);
  }
});

test('④ 라우트 — 범위 먼저 · 랙 배치 범위 · ?rack', async () => {
  const R = await import('../src/routes/api/bmPower.js');
  A._resetPowerAggForTest();
  const measured = [{ serverId: 'rA', watts: 500, vcenterId: 'vcA', serviceTag: 'TA', source: 'idrac' }, { serverId: 'rB', watts: 700, vcenterId: 'vcB', serviceTag: 'TB', source: 'idrac' }];
  const deps = {
    currentTargets: async () => ({ targets: [{ key: 'KA', name: 'bm-a', vcenterId: 'vcA', serviceTag: 'TA', idrac: { regId: 'rA' }, paths: ['idrac'] }, { key: 'KB', name: '10.0.0.9', vcenterId: 'vcB', serviceTag: 'TB', idrac: { regId: 'rB' }, paths: ['idrac'] }] }),
    listEdgeBmUsage: async () => [], bmAddressHosts: async () => ['10.0.0.9'],
    rules: async () => ({ power: { inletWarnC: 27, capHitPct: 98, rackLowPct: 10, racks: [{ vcenterId: 'vcA', rack: 'RA', capKw: 1, servers: [{ key: 'KA', u: 1 }] }, { vcenterId: 'vcB', rack: 'RB', capKw: 1, servers: [{ key: 'KB', u: 2 }] }] } }),
    sources: async () => ({ measured: async () => measured, analysisServers: async () => [], fanFaults: async () => null, powerDb: async () => null, inventoryOf: () => null, sensorLatest: () => null, temps: { classify: () => 'other', maxAgeOf: () => 1 } }),
    now: () => NOW,
  };
  const adm = { user: { username: 'adm', role: 'admin', scope: null }, query: {} };
  const a = await R.bmPowerView(adm, { vcenters: [] }, deps);
  assert.equal(a.fleet.nowKw, 1.2); assert.equal(a.racksConfigured, 2);
  const opA = { user: { username: 'op', role: 'operator', scope: { vcenters: ['vcA'] } }, query: {} };
  const o = await R.bmPowerView(opA, { vcenters: [] }, deps);
  assert.equal(o.fleet.nowKw, 0.5, '범위 밖(vcB) 서버는 합에 섞이지 않는다'); assert.equal(o.racksConfigured, 1); assert.ok(o.racks.every((r) => r.vcenterId === 'vcA'));
  assert.ok(!JSON.stringify(o).includes('KB'), '범위 밖 서버 키 · 랙이 응답에 없다');
  const rq = await R.bmPowerView({ ...adm, query: { rack: 'vcA|RA' } }, { vcenters: [] }, deps);
  assert.equal(rq.rackServers.rows[0].key, 'KA'); assert.equal(rq.rackServers.rows[0].u, 1);
  const rqo = await R.bmPowerView({ ...opA, query: { rack: 'vcB|RB' } }, { vcenters: [] }, deps);
  assert.deepEqual(rqo.rackServers.rows, [], '범위 밖 랙 목록은 비운다');
  const op = { user: { username: 'op2', role: 'operator', scope: null }, query: {} };
  const m = await R.bmPowerView(op, { vcenters: [] }, deps);
  assert.ok(!JSON.stringify(m.racks).includes('10.0.0.9') && !JSON.stringify(m.hot).includes('10.0.0.9'), '비관리자 — 주소 이름 가림');
});

test('⑤ 랙 배치 설정 — 텍스트 해석 · 중복 · 두 랙 · 상한 · 엄격 400', async () => {
  const P = await import('../src/bmusage/perfRules.js');
  const ok = P.normalizeRules({ power: { racksText: '# 주석\nvcA,A-07,10.2,T1@38 T2\nvcA,A-08,,T3\n' } }, { strict: true }).value.power;
  assert.deepEqual(ok.racks, [{ vcenterId: 'vcA', rack: 'A-07', capKw: 10.2, servers: [{ key: 'T1', u: 38 }, { key: 'T2', u: null }] }, { vcenterId: 'vcA', rack: 'A-08', capKw: null, servers: [{ key: 'T3', u: null }] }]);
  assert.equal(P.racksToText(ok.racks), 'vcA,A-07,10.2,T1@38 T2\nvcA,A-08,,T3');
  for (const bad of ['vcA,A-07,10,T1\nvcA,A-07,5,T2', 'vcA,A-07,10,T1\nvcA,A-08,5,T1', 'vcA,A-07,0,T1', 'vcA,A-07,10,T1@99', 'bad vc,A,1,T', 'vcA,A-07']) {
    assert.throws(() => P.normalizeRules({ power: { racksText: bad } }, { strict: true }), (e) => e.status === 400 && /power\.racks/.test(e.field), bad);
  }
  const loose = P.normalizeRules({ power: { racksText: 'vcA,A-07,10,T1\nvcA,A-08,5,T1' } }, { strict: false });
  assert.equal(loose.value.power.racks.length, 2); assert.equal(loose.value.power.racks[1].servers.length, 0, '느슨 = 그 서버만 버린다'); assert.equal(loose.dropped, 1);
  // 기준값 범위
  assert.throws(() => P.normalizeRules({ power: { inletWarnC: 99 } }, { strict: true }), (e) => e.status === 400);
  assert.throws(() => P.normalizeRules({ idle: { watch: 80, candidate: 70 } }, { strict: true }), (e) => e.field === 'idle.watch');
  assert.ok(P.rulesAuditSummary({ power: { inletWarnC: 27 } }, { power: { inletWarnC: 30 } }).includes('power'), '감사 요약에 바뀐 절');
});

test('⑥ 알림 규칙 GET — 랙 배치 · 편집 텍스트는 보이는 법인 것만', async () => {
  const P = await import('../src/bmusage/perfRules.js');
  P._resetPerfRulesForTest();
  P.savePerfRules({ power: { racksText: 'vcA,RA,1,KA@1\nvcB,RB,2,KB@2' } }, { by: 't' });
  const { bmRulesRead } = await import('../src/routes/api/bmPerfOps.js');
  const opA = { user: { username: 'op', role: 'admin', scope: { vcenters: ['vcA'] } }, query: {}, params: {} };
  const r = await bmRulesRead(opA, { vcenters: [{ id: 'vcA' }, { id: 'vcB' }] }, { listEdgeBmUsage: async () => [], currentTargets: async () => ({ targets: [] }), bmAddressHosts: async () => [] });
  assert.deepEqual(r.rules.power.racks.map((x) => x.rack), ['RA']); assert.equal(r.rules.power.racksText, 'vcA,RA,1,KA@1');
  assert.ok(!JSON.stringify(r).includes('vcB,RB'), '다른 법인 랙 · 서버 키가 응답에 없다');
  P._resetPerfRulesForTest();
});
