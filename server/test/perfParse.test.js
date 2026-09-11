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

/* ── v2.449: 계열이 빈 '이유' 를 세 가지로 구분해 알리는지 ───────────────────────
 * v2.445~2.448 은 카탈로그 없음·표본 없음·전부 결측을 전부 똑같이 '—' 로만 보여줘,
 * mem.active·mem.swapped 가 왜 비는지(통계 레벨 문제인지 기간 문제인지) 알 수 없었다. */
const { analyzeRightsize } = await import('../src/tools/rightsize.js');

const okSeries = (n, v) => Array.from({ length: n }, (_, i) => ({ t: new Date(Date.UTC(2026, 0, 1) + i * 1800_000).toISOString(), v }));
/** 근거 게이트를 통과하는 최소 입력(8일치 30분 표본). */
const baseArgs = () => ({
  vm: { id: 'vc:vm-1', name: 'x', powerState: 'POWERED_ON', cpuCount: 8, memMB: 65536 },
  hostMhzPerCore: 2400, intervalSec: 1800, days: 7,
  now: Date.UTC(2026, 0, 9),
  series: { cpuUsageMhz: okSeries(400, 1000), memConsumedMB: okSeries(400, 8192) },
});

test('analyzeRightsize: missing/empty/noData 를 서로 다른 문구로 구분해 보고한다', () => {
  const r = analyzeRightsize({
    ...baseArgs(),
    missing: ['memActiveMB(mem.active.average)'],
    empty: ['memSwappedMB(mem.swapped.average)'],
    noData: ['memBalloonMB(mem.vmmemctl.average)'],
  });
  const joined = r.evidence.reasons.join('\n');
  assert.match(joined, /카운터 없음: memActiveMB\(mem\.active\.average\)/);
  assert.match(joined, /표본 없음: memSwappedMB\(mem\.swapped\.average\)/);
  assert.match(joined, /값 전부 결측: memBalloonMB\(mem\.vmmemctl\.average\)/);
  // 세 문구가 서로 달라야 원인 구분이 된다(같은 문구면 진단 가치가 없다).
  assert.equal(new Set(r.evidence.reasons).size, 3);
});

test('analyzeRightsize: 계열이 비어도 근거가 충분하면 판정은 계속된다(진단은 안내일 뿐)', () => {
  // 진단 문구가 판정을 막으면 안 된다 — CPU 는 그대로 '감축 가능'.
  // v2.481: 메모리는 워킹셋(active/usage/실시간) 기준이라 consumed 만 있으면 산정하지 않고(skipReason) 보류로도 바꾸지 않는다.
  const r = analyzeRightsize({ ...baseArgs(), missing: ['memActiveMB(mem.active.average)'] });
  assert.equal(r.evidence.sufficient, true);
  assert.equal(r.verdict.state, 'reduce');
  assert.equal(r.mem.recommendedMB, null);
  assert.match(r.mem.skipReason, /워킹셋/);
  // 구 산식(정책 memBasis=consumed)에서는 consumed p95 로 권장치가 나온다.
  const old = analyzeRightsize({ ...baseArgs(), missing: ['memActiveMB(mem.active.average)'], policy: { memBasis: 'consumed' } });
  assert.ok(old.mem.recommendedMB > 0);
});

test('analyzeRightsize: 진단 배열을 안 넘겨도(구버전 호출) 예외 없이 동작한다', () => {
  const r = analyzeRightsize(baseArgs());
  assert.equal(r.evidence.reasons.length, 0);
  assert.equal(r.evidence.sufficient, true);
});
