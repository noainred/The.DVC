// v2.493 — 위임(엣지) 서버의 최신 센서를 상세 모달에 싣는 변환 회귀 고정.
//
// 배경(2026-09-12 사용자 신고): 같은 서버(서비스태그 8SDLJB4)가 '법인별 온도' 에서는 CPU1 Temp
// 52℃ 로 정상 표시되는데 iDRAC 상세 모달에서는 '온도 센서 0개 · 최근 0샘플 · 텔레메트리 미지원'
// 으로 보여 수집 중단으로 오해됐다. 원인은 상세 센서 라우트가 위임 서버에 하드코딩 빈 응답을
// 돌려준 것. '법인별 온도' 가 쓰는 값(s.sensors)을 같은 모양으로 변환해 싣는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remoteSensorView } from '../src/idrac/sensorStore.js';

test('위임 서버 최신 센서를 로컬 시계열과 같은 모양으로 변환한다', () => {
  const rs = { id: 'e1', remote: true, sensors: { t: 1757000000000, temps: { 'CPU2 Temp': 63, 'CPU1 Temp': 52 } } };
  const v = remoteSensorView(rs);
  assert.equal(v.remote, true);
  assert.equal(v.seriesAvailable, false);   // 중앙에 이력은 없다(엣지에만)
  assert.equal(v.cpuSynced, false);         // 엣지 export 에 CPU 사용량이 없다
  assert.deepEqual(v.sensors, ['CPU1 Temp', 'CPU2 Temp']); // 이름 정렬
  assert.equal(v.latest.t, 1757000000000);
  assert.equal(v.latest.cpu, null);
  assert.deepEqual(v.latest.temps, { 'CPU1 Temp': 52, 'CPU2 Temp': 63 });
  assert.equal(v.syncedAt, 1757000000000);
  // 없는 이력을 1점 차트로 지어내지 않는다
  assert.deepEqual(v.samples, []);
  assert.equal(v.count, 0);
});

test('엣지가 센서를 아직 안 보냈으면 latest 는 null(0 으로 채우지 않는다)', () => {
  for (const rs of [{}, { sensors: null }, { sensors: { t: 1, temps: {} } }, { sensors: { t: 1, temps: { a: null } } }]) {
    const v = remoteSensorView(rs);
    assert.equal(v.latest, null, JSON.stringify(rs));
    assert.deepEqual(v.sensors, []);
    assert.equal(v.seriesAvailable, false);
  }
});

test('숫자가 아닌 센서 값은 버린다(엣지 페이로드 방어)', () => {
  const v = remoteSensorView({ sensors: { t: 5, temps: { ok: 30, bad: 'x', nul: null } } });
  assert.deepEqual(v.sensors, ['ok']);
  assert.deepEqual(v.latest.temps, { ok: 30 });
});
