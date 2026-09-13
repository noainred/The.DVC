/**
 * v2.504 — 서버별 iDRAC 온도 시계열 회귀 고정.
 *
 * 사용자 요청("idrac 에서 조사하는 온도를 차트로 보이게 해줘")으로 추가한 계열이다.
 * 여기서 고정하는 것은 **저장량 설계**(기본 서버당 1계열)와 **정직성 규약**(결측에 0 을 넣지 않는다,
 * 오래된 표본을 현재로 쓰지 않는다)이다 — 둘 다 되돌리면 조용히 사고가 난다.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-idractemp-'));

let M;
before(async () => { M = await import('../src/idrac/serverTempSeries.js'); });

const at = (t, temps) => ({ t, temps });

test('종류별 대표값 — 같은 종류가 여럿이면 최고값, max 는 전 센서 최댓값', () => {
  const k = M.serverTempKinds(at(1, {
    'CPU1 Temp': 34, 'CPU2 Temp': 38,            // cpu → 38
    'System Board Exhaust Temp': 31,             // exhaust
    'Inlet Temp': 18,                            // inlet
    'System Board SAS Temp': 45,                 // 분류 불가(other) — max 에는 포함된다
  }));
  assert.equal(k.cpu, 38);
  assert.equal(k.exhaust, 31);
  assert.equal(k.inlet, 18);
  assert.equal(k.max, 45, 'max 는 분류와 무관하게 모든 온도 센서의 최댓값이어야 한다(화면 머리글과 같은 값)');
  assert.equal(k.count, 5);
});

test('숫자가 아닌 값·빈 입력에 안전', () => {
  assert.deepEqual(M.serverTempKinds(null), { inlet: null, exhaust: null, cpu: null, max: null, count: 0 });
  const k = M.serverTempKinds(at(1, { 'Inlet Temp': 'N/A', 'CPU1 Temp': 30 }));
  assert.equal(k.inlet, null);
  assert.equal(k.max, 30);
});

test('오래된·시각 없는 표본은 적재하지 않는다(죽은 서버의 온도를 매 분 다시 쓰면 평탄선이 된다)', () => {
  const now = 1_000_000_000;
  assert.equal(M.sampleStaleReason(at(now, { 'Inlet Temp': 18 }), { now }), null);
  assert.equal(M.sampleStaleReason(at(now - 20 * 60_000, { 'Inlet Temp': 18 }), { now }), 'stale');
  assert.equal(M.sampleStaleReason({ temps: { 'Inlet Temp': 18 } }, { now }), 'no-timestamp');
  assert.equal(M.sampleStaleReason(at(now, {}), { now }), 'no-sensors');
  assert.equal(M.sampleStaleReason(null, { now }), 'no-sensors');
  // maxAgeMs<=0 이면 나이 검사를 끈다(호출부가 명시적으로 끈 경우).
  assert.equal(M.sampleStaleReason(at(0, { 'Inlet Temp': 18 }), { now, maxAgeMs: 0 }), null);
});

test('기본은 서버당 1계열 — 저장량 설계(연 845만 행 규모)를 유지한다', () => {
  const now = 2_000_000_000;
  const servers = [{ id: 'srv-1' }, { id: 'srv-2' }];
  const latestOf = () => at(now, { 'Inlet Temp': 18, 'System Board Exhaust Temp': 31, 'CPU1 Temp': 38 });
  const { rows, servers: n } = M.buildServerTempRows(servers, { now, latestOf, detail: false });
  assert.equal(n, 2);
  assert.equal(rows.length, 2, `서버당 1행이어야 한다(실제 ${rows.length}) — 기본이 3~4계열이 되면 연 3,380만 행이 된다`);
  assert.deepEqual(rows.map((r) => r.metric), ['idractemp_max', 'idractemp_max']);
  assert.equal(rows[0].v, 38);
});

test('상세 모드에서만 흡기·배기·CPU 가 함께 적재된다', () => {
  const now = 2_000_000_000;
  const latestOf = () => at(now, { 'Inlet Temp': 18, 'System Board Exhaust Temp': 31, 'CPU1 Temp': 38 });
  const { rows } = M.buildServerTempRows([{ id: 'srv-1' }], { now, latestOf, detail: true });
  assert.deepEqual(rows.map((r) => r.metric).sort(),
    ['idractemp_cpu', 'idractemp_exhaust', 'idractemp_inlet', 'idractemp_max']);
});

test('결측 종류는 행을 만들지 않는다 — 0 을 넣으면 급냉으로 보인다', () => {
  const now = 2_000_000_000;
  const latestOf = () => at(now, { 'CPU1 Temp': 38 });        // 흡기·배기 없음
  const { rows } = M.buildServerTempRows([{ id: 'srv-1' }], { now, latestOf, detail: true });
  const metrics = rows.map((r) => r.metric);
  assert.ok(!metrics.includes('idractemp_inlet'), '없는 흡기 값이 행으로 만들어졌다');
  assert.ok(!metrics.includes('idractemp_exhaust'));
  assert.deepEqual(metrics.sort(), ['idractemp_cpu', 'idractemp_max']);
});

test('제외 사유를 숨기지 않는다(조용히 줄이면 왜 비었는지 알 수 없다)', () => {
  const now = 2_000_000_000;
  const servers = [{ id: 'ok' }, { id: 'stale' }, { id: 'empty' }, { id: '' }];
  const latestOf = (s) => (s.id === 'ok' ? at(now, { 'CPU1 Temp': 40 })
    : s.id === 'stale' ? at(now - 3_600_000, { 'CPU1 Temp': 40 }) : at(now, {}));
  const r = M.buildServerTempRows(servers, { now, latestOf, detail: false });
  assert.equal(r.servers, 1);
  assert.equal(r.skipped.stale, 1);
  assert.equal(r.skipped.noSensors, 1);
});

test('위임(엣지) 서버의 최신 스냅샷도 적재된다 — 이 기능의 목적이다', () => {
  // 원격은 export 로 받은 s.sensors 를 쓴다(roomTemp.js·/idrac/temps 와 같은 규약).
  const now = 2_000_000_000;
  const remote = { id: 'edge-1', remote: true, sensors: at(now, { 'Inlet Temp': 20, 'CPU2 Temp': 52 }) };
  const { rows } = M.buildServerTempRows([remote], { now, detail: false });
  assert.equal(rows.length, 1, '위임 서버가 빠지면 중앙에 이력이 계속 0 이다(v2.493 이 보고한 그 상태)');
  assert.equal(rows[0].k, 'edge-1');
  assert.equal(rows[0].v, 52);
});

test('metaKey — 건수를 세지 않는다(파티션 풀스캔 방지) + 첫/마지막 관측 시각', async () => {
  const { getMetricsDb } = await import('../src/metrics/db.js');
  const db = await getMetricsDb();
  const base = Date.now() - 3 * 3_600_000;
  for (let i = 0; i < 3; i++) db.insertMany([{ metric: 'idractemp_max', k: 'srv-x', v: 30 + i }], base + i * 3_600_000);
  const m = db.metaKey('idractemp_max', 'srv-x');
  assert.equal(typeof m.firstTs, 'number');
  assert.ok(m.firstTs <= base + 1000 && m.lastTs >= base + 2 * 3_600_000 - 1000);
  assert.ok(!('count' in m), 'count 를 돌려주면 COUNT(*) 풀스캔이 다시 들어온다(감사 P2 #11)');
  // 없는 키는 null — 화면이 기준선을 그리지 않게.
  assert.deepEqual(db.metaKey('idractemp_max', 'nope'), { firstTs: null, lastTs: null });
});
