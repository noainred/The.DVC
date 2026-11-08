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
const srv = (key, vc, w, extra = {}) => ({ key, name: key, vcenterId: vc, node: '', via: 'local', w, unmeasured: w == null ? (extra.unmeasured || 'read-fail') : null, h24: w == null ? null : A.hourSummary(hours(w)), kwhMonth: w == null ? null : 100, capW: null, inletC: null, maxC: null, ...extra });

test('① 집계 — 미측정 제외 · 랙 · 미매핑 · 여유 · 걸림 · 피크 · kWh', () => {
  const servers = [srv('A1', 'v1', 400, { capW: 405, inletC: 31.2, maxC: 78 }), srv('A2', 'v1', 300, { inletC: 24 }), srv('A3', 'v1', null, { unmeasured: 'zero' }), srv('A4', 'v1', null, { unmeasured: 'no-idrac' }), srv('B1', 'v2', 200)];
  const racks = [{ vcenterId: 'v1', rack: 'A-07', capKw: 0.75, servers: [{ key: 'A1', u: 38 }, { key: 'A2', u: 36 }, { key: 'A3', u: 30 }] }];
  const r = A.aggregatePower(servers, { racks, cfg: { inletWarnC: 27, capHitPct: 98, rackLowPct: 10 } });
  assert.equal(r.fleet.nowKw, 0.9, '측정분만(400+300+200)'); assert.equal(r.fleet.measured, 3); assert.equal(r.fleet.unmeasuredN, 2);
  assert.deepEqual(r.fleet.unmeasured, { 'no-idrac': 1, 'read-fail': 0, zero: 1 }, '0 W 보고는 따로 센다(합에 0 으로 넣지 않는다)');
  const a07 = r.racks.find((x) => x.rack === 'A-07');
  assert.equal(a07.servers, 3); assert.equal(a07.nowKw, 0.7); assert.equal(a07.marginPct, 6.7); assert.equal(a07.low, true, '여유 10% 미만');
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

test('③ 원천 모으기 — 매칭 · 사유 · 24h · 월 누적 캐시 · 온도 · 팬', async () => {
  A._resetPowerAggForTest();
  let monthCalls = 0;
  const idb = { hourlyStats: (key, from, to) => { if (to - from > 30 * HOUR) monthCalls += 1; return key === 'r1' ? hours(400, Math.min(24 * 40, Math.floor((to - from) / HOUR)), to) : key === 'rmt:bm-3' ? hours(250) : []; } };
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
  assert.ok(s.K1.kwhMonth > 0);
  // 끝난 날은 캐시 — 두 번째 모으기는 월 범위를 다시 읽지 않는다
  const before = monthCalls;
  await A.gatherPower({ targets, deps, now: NOW });
  assert.equal(monthCalls, before, '끝난 날 Wh 는 캐시(요청마다 한 달을 다시 읽지 않는다)');
  // 함대 공유 — 같은 열쇠 60초 안에는 한 번만 계산
  let n = 0; const compute = async () => { n += 1; return []; };
  await Promise.all([A.sharedPowerFleet('k', compute, { now: NOW }), A.sharedPowerFleet('k', compute, { now: NOW + 1000 })]);
  assert.equal(n, 1, '동시 요청은 같은 프라미스');
  await A.sharedPowerFleet('k', compute, { now: NOW + 61_000 });
  assert.equal(n, 2);
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
