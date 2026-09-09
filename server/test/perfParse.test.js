import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePerfMultiXml } from '../src/vcenter/soapClient.js';

/**
 * QueryPerf(다중 카운터) 파싱 회귀 고정 — v2.446.
 *
 * v2.445 는 `rv.split(/<value\b/)` 로 계열을 잘랐는데, PerfEntityMetric 은 계열 컨테이너와
 * 표본이 **같은 `<value>` 태그명**을 쓴다. 안쪽 표본까지 split 경계가 되어 counterId 를 가진
 * 조각에 표본이 하나도 안 남았고, 그 결과 자원 축소 근거 리포트가 모든 VM·모든 기간에서
 * '근거 불충분'(샘플 0/336)으로 나왔다. 아래 테스트가 그 형태를 그대로 고정한다.
 */

const HEAD = '<returnval xsi:type="PerfEntityMetric"><entity type="VirtualMachine">vm-123</entity>'
  + [0, 1, 2].map((i) => `<sampleInfo><interval>1800</interval><timestamp>2026-09-01T0${i}:00:00Z</timestamp></sampleInfo>`).join('');
/** vCenter 가 실제로 보내는 계열 블록: 컨테이너 <value …> 안에 표본 <value>N</value> 반복. */
const series = (cid, instance, vals) =>
  `<value xsi:type="PerfMetricIntSeries"><id><counterId>${cid}</counterId><instance>${instance}</instance></id>`
  + vals.map((v) => `<value>${v}</value>`).join('') + '</value>';

test('parsePerfMultiXml: 계열 컨테이너와 표본이 같은 <value> 태그여도 계열별 표본을 모두 뽑는다', () => {
  const xml = `${HEAD}${series(6, '', [100, 200, 300])}${series(24, '', [10, 20, 30])}</returnval>`;
  const out = parsePerfMultiXml(xml, ['6', '24']);
  assert.equal(out.get('6').length, 3);              // v2.445 는 여기가 0 이었다
  assert.equal(out.get('24').length, 3);
  assert.deepEqual(out.get('6')[0], { t: '2026-09-01T00:00:00Z', v: 100 });
  assert.deepEqual(out.get('24')[2], { t: '2026-09-01T02:00:00Z', v: 30 });
});

test('parsePerfMultiXml: 결측(-1)은 그대로 보존한다(0 으로 바꾸지 않는다)', () => {
  // -1 → null 변환은 상위(fetchVmRightsizeSeries)의 책임이다. 여기서 0 으로 뭉개면
  // 차트가 '사용량 0' 으로 오해하고 p95·평균이 아래로 끌린다.
  const out = parsePerfMultiXml(`${HEAD}${series(6, '', [100, -1, 300])}</returnval>`, ['6']);
  assert.equal(out.get('6')[1].v, -1);
});

test('parsePerfMultiXml: 요청했지만 응답에 없는 카운터는 빈 배열(키는 유지)', () => {
  const out = parsePerfMultiXml(`${HEAD}${series(6, '', [1, 2, 3])}</returnval>`, ['6', '99']);
  assert.deepEqual(out.get('99'), []);
  assert.equal(out.get('6').length, 3);
});

test('parsePerfMultiXml: 같은 카운터에 인스턴스 계열이 섞이면 집계(빈 instance)를 채택', () => {
  // 인스턴스 계열이 먼저 와도 집계로 승격되어야 한다 — 안 그러면 vCPU 한 개 값만 남는다.
  const xml = `${HEAD}${series(6, '0', [1, 1, 1])}${series(6, '1', [2, 2, 2])}${series(6, '', [100, 200, 300])}</returnval>`;
  assert.deepEqual(parsePerfMultiXml(xml, ['6']).get('6').map((p) => p.v), [100, 200, 300]);
});

test('parsePerfMultiXml: 집계 계열이 없으면 첫 인스턴스 계열만 쓴다(뒤 계열이 덮어쓰지 않음)', () => {
  const xml = `${HEAD}${series(6, '0', [7, 7, 7])}${series(6, '1', [9, 9, 9])}</returnval>`;
  assert.deepEqual(parsePerfMultiXml(xml, ['6']).get('6').map((p) => p.v), [7, 7, 7]);
});

test('parsePerfMultiXml: 표본이 타임스탬프보다 많아도 타임스탬프 수에서 끊는다', () => {
  const out = parsePerfMultiXml(`${HEAD}${series(6, '', [1, 2, 3, 4, 5])}</returnval>`, ['6']);
  assert.equal(out.get('6').length, 3);
});

test('parsePerfMultiXml: 빈 응답·표본 없는 응답·카운터 미지정은 안전하게 빈 결과', () => {
  assert.deepEqual([...parsePerfMultiXml('', ['6'])], [['6', []]]);
  assert.deepEqual([...parsePerfMultiXml('<returnval/>', ['6'])], [['6', []]]);
  assert.equal(parsePerfMultiXml(`${HEAD}</returnval>`, []).size, 0);
});
