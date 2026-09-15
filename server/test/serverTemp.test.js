import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  avgWindowMs, avgWindowLabel, BASE_AVG_WINDOW_MS,
  summarizeSensors, hostsByServiceTag, classifyServer,
  aggregate, splitAggregate, buildServerTempReport,
} from '../src/tools/serverTemp.js';

/**
 * v2.512 '서버 온도' 회귀 고정.
 * 세 요구가 한 화면에 걸려 있다 — ① iDRAC 온도 표시 ② 물리/가상화 분리·평균 ③ 5분 평균 수정.
 * 특히 ③ 은 '창이 고정 5분이라 샘플 주기가 그보다 길면 영원히 비는' 실제 버그였다.
 */

/* ── ③ 평균 창 ─────────────────────────────────────────────────────────────── */

test('avgWindowMs: 샘플 주기가 짧으면 기존과 같은 5분 창', () => {
  assert.equal(avgWindowMs(60_000), BASE_AVG_WINDOW_MS);      // 기본 1분
  assert.equal(avgWindowMs(10_000), BASE_AVG_WINDOW_MS);
  assert.equal(avgWindowMs(150_000), BASE_AVG_WINDOW_MS);     // 2.5분 × 2 = 5분
});

test('avgWindowMs: ★ 주기가 5분을 넘으면 창을 넓힌다(이게 안 되면 평균이 영원히 빈다)', () => {
  assert.equal(avgWindowMs(10 * 60_000), 20 * 60_000);        // 10분 주기 → 20분 창
  assert.equal(avgWindowMs(60 * 60_000), 120 * 60_000);       // 1시간 주기 → 2시간 창
});

test('avgWindowMs: 값이 없거나 이상하면 안전하게 5분', () => {
  for (const v of [0, -1, null, undefined, NaN, 'abc']) assert.equal(avgWindowMs(v), BASE_AVG_WINDOW_MS);
});

test('avgWindowLabel: 실제 창을 라벨로 — 20분을 평균내고 "5분" 이라 쓰지 않는다', () => {
  assert.equal(avgWindowLabel(5 * 60_000), '5분');
  assert.equal(avgWindowLabel(20 * 60_000), '20분');
  assert.equal(avgWindowLabel(120 * 60_000), '2시간');
  assert.equal(avgWindowLabel(90 * 60_000), '1.5시간');
});

/* ── 센서 요약 ─────────────────────────────────────────────────────────────── */

test('summarizeSensors: iDRAC 객체 형태 — 종류별 최고값 + 전체 최고', () => {
  const s = summarizeSensors({ 'Inlet Temp': 22, 'Exhaust Temp': 38, 'CPU1 Temp': 61, 'CPU2 Temp': 65, 'Board Temp': 44 });
  assert.deepEqual(s, { inlet: 22, exhaust: 38, cpu: 65, max: 65, count: 5 });
});

test('summarizeSensors: ESXi 배열 형태({name,c})도 같은 규약으로 처리', () => {
  const s = summarizeSensors([{ name: 'Ambient', c: 20 }, { name: 'System Board Exhaust', c: 35 }]);
  assert.equal(s.inlet, 20);
  assert.equal(s.exhaust, 35);
  assert.equal(s.max, 35);
});

test('summarizeSensors: max 는 분류 불가(other) 센서도 포함한다', () => {
  const s = summarizeSensors({ 'Inlet Temp': 20, 'PSU1 Temp': 70 });   // PSU 는 other
  assert.equal(s.inlet, 20);
  assert.equal(s.cpu, null);
  assert.equal(s.max, 70);
});

test('summarizeSensors: 빈 값·비숫자는 세지 않는다(0 으로 채우지 않음)', () => {
  assert.deepEqual(summarizeSensors(null), { inlet: null, exhaust: null, cpu: null, max: null, count: 0 });
  const s = summarizeSensors({ 'Inlet Temp': 'N/A', 'CPU1 Temp': 55 });
  assert.equal(s.count, 1);
  assert.equal(s.inlet, null);
});

/* ── ② 물리 / 가상화 ───────────────────────────────────────────────────────── */

const HOSTS = [
  { id: 'vc1:host-1', name: 'esx01', vcenterId: 'vc1', cluster: 'C1', serviceTag: 'ABC1234', tempC: 21, tempMaxC: 30, temps: [{ name: 'Ambient', c: 21 }] },
  { id: 'vc1:host-2', name: 'esx02', vcenterId: 'vc1', cluster: 'C1', serviceTag: 'DEF5678', tempC: 23, tempMaxC: 33, temps: [] },
];

test('classifyServer: serviceTag 가 ESXi 호스트와 맞으면 가상화, 아니면 물리', () => {
  const m = hostsByServiceTag(HOSTS);
  assert.equal(classifyServer({ serviceTag: 'ABC1234' }, m).kind, 'virtual');
  assert.equal(classifyServer({ serviceTag: 'abc1234' }, m).kind, 'virtual');   // 대소문자 무관
  assert.equal(classifyServer({ serviceTag: ' ABC1234 ' }, m).kind, 'virtual'); // 공백 무관
  assert.equal(classifyServer({ serviceTag: 'ZZZ9999' }, m).kind, 'physical');
  assert.equal(classifyServer({ serviceTag: '' }, m).kind, 'physical');
});

test('aggregate: 결측은 평균 분모에서 빠진다(0 으로 채우면 평균이 내려가 오판)', () => {
  const a = aggregate([
    { curC: 20, maxC: 30, inletC: 20, exhaustC: null, cpuC: 60 },
    { curC: 30, maxC: 40, inletC: 30, exhaustC: 40, cpuC: null },
  ]);
  assert.equal(a.servers, 2);
  assert.equal(a.avgC, 25);
  assert.equal(a.maxC, 40);
  assert.equal(a.avgExhaustC, 40);  // 표본 1개
  assert.equal(a.exhaustN, 1);
  assert.equal(a.avgCpuC, 60);
  assert.equal(a.cpuN, 1);
});

test('aggregate: 빈 목록은 예외 없이 null 통계', () => {
  const a = aggregate([]);
  assert.equal(a.servers, 0);
  assert.equal(a.avgC, null);
  assert.equal(a.maxC, null);
});

test('splitAggregate: 물리/가상화/전체를 각각 낸다', () => {
  const s = splitAggregate([
    { kind: 'physical', curC: 30, maxC: 40 },
    { kind: 'virtual', curC: 20, maxC: 25 },
    { kind: 'virtual', curC: 22, maxC: 27 },
  ]);
  assert.equal(s.all.servers, 3);
  assert.equal(s.physical.servers, 1);
  assert.equal(s.physical.avgC, 30);
  assert.equal(s.virtual.servers, 2);
  assert.equal(s.virtual.avgC, 21);
});

/* ── ① 리포트 통합 ─────────────────────────────────────────────────────────── */

const IDRAC = [
  { id: 'i-1', name: 'srv-esx01', ip: '10.0.0.1', serviceTag: 'ABC1234', datacenterId: 'MIL' },   // = esx01 → 가상화
  { id: 'i-2', name: 'srv-db01', ip: '10.0.0.2', serviceTag: 'ZZZ9999', datacenterId: 'MIL' },    // 매칭 없음 → 물리
];
const SENSORS = {
  'i-1': { t: 1_000, temps: { 'Inlet Temp': 22, 'CPU1 Temp': 60 } },
  'i-2': { t: 1_000, temps: { 'Inlet Temp': 26, 'Exhaust Temp': 41 } },
};
const opts = { idracServers: IDRAC, hosts: HOSTS, latestOf: (s) => SENSORS[s.id], now: 1_000, maxAgeMs: 0 };

test('buildServerTempReport: iDRAC 값을 쓰고 물리/가상화를 나눈다', () => {
  const r = buildServerTempReport(opts);
  const byId = new Map(r.rows.map((x) => [x.id, x]));
  assert.equal(byId.get('i-1').kind, 'virtual');
  assert.equal(byId.get('i-1').source, 'idrac');
  assert.equal(byId.get('i-1').hostName, 'esx01');          // ESXi 호스트와 연결됨
  assert.equal(byId.get('i-1').cluster, 'C1');
  assert.equal(byId.get('i-2').kind, 'physical');
  assert.equal(byId.get('i-2').exhaustC, 41);
  assert.equal(r.summary.physical.servers, 1);
});

test('buildServerTempReport: ★ iDRAC 이 없는 ESXi 호스트는 사라지지 않는다(교체가 아니라 보완)', () => {
  // esx02(DEF5678)는 iDRAC 등록이 없다 — vCenter 센서로 남아야 한다.
  const r = buildServerTempReport(opts);
  const esx02 = r.rows.find((x) => x.id === 'vc1:host-2');
  assert.ok(esx02, 'iDRAC 미등록 ESXi 호스트가 누락되면 안 된다');
  assert.equal(esx02.source, 'esxi');
  assert.equal(esx02.kind, 'virtual');     // ESXi 호스트는 정의상 가상화
  assert.equal(esx02.curC, 23);
  assert.equal(r.counts.idrac, 2);
  assert.equal(r.counts.esxi, 1);
});

test('buildServerTempReport: 같은 장비는 iDRAC 값을 쓰고 ESXi 행을 중복 생성하지 않는다', () => {
  const r = buildServerTempReport(opts);
  assert.equal(r.rows.filter((x) => x.serviceTag === 'ABC1234').length, 1);
  assert.equal(r.rows.find((x) => x.serviceTag === 'ABC1234').curC, 22);   // iDRAC 흡기(ESXi 21 아님)
});

test('buildServerTempReport: 대표 온도는 흡기 우선, 흡기가 없으면 최고값', () => {
  const r = buildServerTempReport({
    ...opts, idracServers: [{ id: 'i-3', name: 'x', serviceTag: 'QQQ', datacenterId: 'D' }],
    latestOf: () => ({ t: 1_000, temps: { 'CPU1 Temp': 70, 'Board Temp': 44 } }),
    hosts: [],
  });
  assert.equal(r.rows[0].curC, 70);
  assert.equal(r.rows[0].inletC, null);
});

test('buildServerTempReport: 법인별로 물리/가상화 평균을 낸다', () => {
  const r = buildServerTempReport({ ...opts, dcName: (id) => ({ MIL: '밀양' }[id] || id) });
  const mil = r.byDatacenter.find((d) => d.key === 'MIL');
  assert.ok(mil, '법인 묶음이 있어야 한다');
  assert.equal(mil.name, '밀양');
  assert.equal(mil.physical.servers, 1);
  assert.equal(mil.physical.avgC, 26);
  assert.equal(mil.virtual.servers, 1);
  assert.equal(mil.virtual.avgC, 22);
});

test('buildServerTempReport: 오래된 표본은 stale 로 표시하되 버리지 않는다', () => {
  const r = buildServerTempReport({ ...opts, now: 10_000_000, maxAgeMs: 60_000 });
  assert.equal(r.counts.stale, 2);
  assert.ok(r.rows.every((x) => x.source !== 'idrac' || x.stale === true));
  assert.equal(r.counts.idrac, 2, 'stale 이어도 행은 남는다(값이 사라지면 화면이 빈다)');
});

test('buildServerTempReport: 센서가 없는 iDRAC 서버는 집계에서 빼고 사유를 센다', () => {
  const r = buildServerTempReport({ ...opts, latestOf: () => ({ t: 1_000, temps: {} }) });
  assert.equal(r.counts.noSensors, 2);
  assert.equal(r.counts.idrac, 0);
  // 그 서버가 ESXi 호스트이기도 하면 ESXi 센서로 대체된다(빈칸으로 두지 않는다).
  assert.ok(r.rows.some((x) => x.id === 'vc1:host-1' && x.source === 'esxi'));
});

test('buildServerTempReport: 빈 입력도 예외 없이 동작', () => {
  const r = buildServerTempReport({});
  assert.deepEqual(r.rows, []);
  assert.equal(r.summary.all.servers, 0);
  assert.deepEqual(r.byDatacenter, []);
});
