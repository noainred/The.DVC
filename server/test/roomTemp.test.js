// 법인 전산실 운영 온도 집계 — 센서 분류·stale 제외·그룹 키 규약 회귀 테스트(v2.390).
// 이 모듈은 v2.381~2.383 에서 데이터 소스를 두 번 갈아엎었고(iDRAC 레지스트리 → vCenter 스냅샷
// → 서버 분석 동일 소스), v2.387 에서 stale 제외와 미지정 그룹 예약키를 도입했다.
// 그 규약들이 코드 주석만으로 방어되고 있어 테스트로 고정한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifySensor, inletStatus, roomTempReport, UNASSIGNED_KEY, DEFAULT_MAX_AGE_MS,
} from '../src/idrac/roomTemp.js';

const NOW = 1_700_000_000_000;
/** 원격(엣지 위임) 서버 — 온도는 s.sensors 에 온다(analysisServersWithRemote 계약). */
const remote = (id, dc, ageMin, temps, extra = {}) => ({
  id, name: id, datacenterId: dc, vcenterId: '', remote: true,
  sensors: { t: NOW - ageMin * 60_000, temps }, ...extra,
});

test('classifySensor: 실제 Dell 센서명 분류', () => {
  // 흡기 — ASHRAE 대역 비교의 기준이라 가장 중요.
  for (const n of ['System Board Inlet Temp', 'Inlet Ambient', 'Intake Temp', 'Front Panel Temp']) {
    assert.equal(classifySensor(n), 'inlet', n);
  }
  for (const n of ['System Board Exhaust Temp', 'Outlet Temp', 'Exhaust', 'Rear Temp']) {
    assert.equal(classifySensor(n), 'exhaust', n);
  }
  // ⚠ 회귀 방지: \bcpu\b 로는 'CPU1 Temp'(숫자 접미) 가 잡히지 않는다 — v2.381 실제 버그.
  for (const n of ['CPU1 Temp', 'CPU2 Temp', 'CPU 2 Temp', 'Proc 1 Package', 'CPU Die', 'Core 0 Temp']) {
    assert.equal(classifySensor(n), 'cpu', n);
  }
  // 성격이 다른 센서는 집계에서 빼야 한다(섞으면 '전산실 온도' 의미가 무너진다).
  for (const n of ['DIMM Temp', 'PSU1 Temp', 'System Board Temp', 'Diode Bay']) {
    assert.equal(classifySensor(n), 'other', n);
  }
  // 겹치면 흡기 우선(급기 판정이 더 중요).
  assert.equal(classifySensor('CPU Inlet Temp'), 'inlet');
});

test('inletStatus: ASHRAE A1 권장 18~27℃ 경계', () => {
  assert.equal(inletStatus(null), null);
  assert.equal(inletStatus(14.9), 'cold');
  assert.equal(inletStatus(18), 'lowok');
  assert.equal(inletStatus(18.1), 'ok');
  assert.equal(inletStatus(27), 'ok');
  assert.equal(inletStatus(27.1), 'warn');
  assert.equal(inletStatus(32), 'warn');
  assert.equal(inletStatus(32.1), 'hot');
});

test('법인별 범위 집계 — 서버 내 동종 센서는 최댓값이 대표값', () => {
  const r = roomTempReport([
    remote('s1', 'dc-a', 1, { 'Inlet Temp': 22, 'Exhaust Temp': 38, 'CPU1 Temp': 55, 'CPU2 Temp': 61, 'DIMM Temp': 40 }),
    remote('s2', 'dc-a', 1, { 'Ambient Temp': 26, 'Outlet Temp': 44, 'Proc 1 Package': 70 }),
  ], { now: NOW });
  const g = r.groups.find((x) => x.id === 'dc-a');
  assert.deepEqual([g.inlet.min, g.inlet.max], [22, 26]);
  assert.equal(g.inlet.avg, 24);
  assert.equal(g.exhaust.max, 44);
  assert.equal(g.cpu.max, 70);              // s1 은 61(CPU2), s2 는 70 → 그룹 최댓값
  assert.equal(g.otherSensorCount, 1);      // DIMM 은 집계 제외, 개수만
  assert.equal(g.deltaAvg, 17);             // (38-22)=16, (44-26)=18 → 평균 17
  assert.equal(r.totals.withData, 2);
});

test('stale 표본 제외 — 죽은 서버의 동결 온도를 현재값으로 쓰지 않는다', () => {
  const servers = [
    remote('fresh', 'dc-a', 1, { 'Inlet Temp': 22 }),
    remote('dead', 'dc-a', 30, { 'Inlet Temp': 99 }),   // 30분 전 = 기본 15분 초과
  ];
  const r = roomTempReport(servers, { now: NOW });
  const g = r.groups.find((x) => x.id === 'dc-a');
  assert.equal(g.inlet.max, 22, '99℃ 동결값이 반영되면 안 된다');
  assert.equal(g.staleCount, 1);
  assert.equal(r.totals.stale, 1);
  assert.equal(r.staleMs, DEFAULT_MAX_AGE_MS);

  // 타임스탬프가 없는 표본은 나이를 알 수 없으므로 stale 로 취급(추정으로 통과 금지).
  const noTs = roomTempReport([{ id: 'x', name: 'x', datacenterId: 'dc-a', remote: true, sensors: { temps: { 'Inlet Temp': 50 } } }], { now: NOW });
  assert.equal(noTs.totals.stale, 1);
  assert.equal(noTs.totals.withData, 0);

  // maxAgeMs=0 이면 검사하지 않는다(호출부가 명시적으로 끈 경우 — 하위호환).
  const off = roomTempReport(servers, { now: NOW, maxAgeMs: 0 });
  assert.equal(off.groups.find((x) => x.id === 'dc-a').inlet.max, 99);
});

test('그룹 키 규약 — 미지정은 예약키, 빈 문자열은 쓰지 않는다', () => {
  // 빈 문자열을 쓰면 시계열에서 '전체 합계'(k='')와 충돌해 두 계열이 모두 오염된다(v2.387 수정).
  const r = roomTempReport([
    remote('a', 'dc-a', 1, { 'Inlet Temp': 20 }),
    { id: 'nodc', name: 'nodc', datacenterId: '', vcenterId: 'vc-x', remote: true, sensors: { t: NOW, temps: { 'Inlet Temp': 25 } } },
    { id: 'orphan', name: 'orphan', datacenterId: '', vcenterId: '', remote: true, sensors: { t: NOW, temps: { 'Inlet Temp': 29 } } },
  ], { now: NOW });
  const ids = r.groups.map((x) => x.id);
  assert.ok(ids.includes(UNASSIGNED_KEY), `예약키 누락: ${ids.join(',')}`);
  assert.ok(!ids.includes(''), '빈 문자열 그룹 키 금지');
  assert.equal(r.groups.find((x) => x.id === 'vc-x').inlet.max, 25, 'DataCenter 없으면 vCenter 로 그룹');
  assert.equal(r.groups.find((x) => x.id === UNASSIGNED_KEY).inlet.max, 29);
});

test('센서 없음·정렬·빈 입력 안전성', () => {
  const r = roomTempReport([
    remote('hot', 'dc-hot', 1, { 'Inlet Temp': 31 }),
    remote('cool', 'dc-cool', 1, { 'Inlet Temp': 19 }),
    remote('nosens', 'dc-cool', 1, {}),                            // temps 비어 있음
    remote('otheronly', 'dc-cool', 1, { 'DIMM Temp': 45 }),        // 3종 미해당
  ], { now: NOW });
  assert.equal(r.groups[0].id, 'dc-hot', '흡기 최고가 높은 법인이 먼저');
  const cool = r.groups.find((x) => x.id === 'dc-cool');
  assert.equal(cool.noSensorCount, 2);
  assert.equal(cool.inlet.max, 19);
  assert.equal(r.groups.find((x) => x.id === 'dc-hot').status, 'warn');

  // 빈/누락 입력에도 크래시하지 않는다(수집 전 기동 직후 경로).
  assert.equal(roomTempReport([]).totals.servers, 0);
  assert.equal(roomTempReport(undefined).totals.servers, 0);
  assert.equal(roomTempReport(null).groups.length, 0);
});
