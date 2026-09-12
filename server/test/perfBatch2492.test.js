// v2.492 — 다중 VM QueryPerf 응답 파싱·기간 요약(순수) 회귀 고정.
//
// 가장 중요한 고정: (1) `<returnval>` 이 여러 개일 때 **VM 전부** 읽는가(기존 parsePerfMultiXml 은
// 첫 개만 읽는다 — 그 함수를 재사용하면 첫 VM 값만 나온다), (2) 계열 컨테이너 `<value xsi:type=…>` 와
// 표본 `<value>N</value>` 가 같은 태그명인 함정에서 표본을 잃지 않는가(v2.445 회귀와 동일 원인),
// (3) 결측(-1)을 0 으로 채우지 않는가(0% 는 '유휴' 로 오해된다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  USAGE_DAYS, normDays, intervalForDays, parseEntityPerfBatchXml,
  summarizePoints, coverageDaysOf, summarizeVmUsage,
} from '../src/vcenter/perfBatch.js';
import { parsePerfMultiXml } from '../src/vcenter/soapClient.js';

// 실제 vCenter 응답 형태를 따른 픽스처: 엔티티 2개 × 카운터 2개(6=cpu.usage, 24=mem.usage),
// 계열 래퍼가 xsi:type 속성을 갖고 표본도 <value> 인 구조.
const entity = (ref, times, cpu, mem) => `
  <returnval xsi:type="PerfEntityMetric">
    <entity type="VirtualMachine">${ref}</entity>
    ${times.map((t) => `<sampleInfo><interval>7200</interval><timestamp>${t}</timestamp></sampleInfo>`).join('')}
    <value xsi:type="PerfMetricIntSeries">
      <id><counterId>6</counterId><instance></instance></id>
      ${cpu.map((v) => `<value>${v}</value>`).join('')}
    </value>
    <value xsi:type="PerfMetricIntSeries">
      <id><counterId>24</counterId><instance></instance></id>
      ${mem.map((v) => `<value>${v}</value>`).join('')}
    </value>
  </returnval>`;
const T = ['2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', '2026-09-03T00:00:00Z'];
const XML = `<soapenv:Envelope><soapenv:Body><QueryPerfResponse>
  ${entity('vm-11', T, [1000, 2000, 3000], [4000, 4000, 4000])}
  ${entity('vm-22', T, [500, 500, 500], [9000, 9100, 8900])}
</QueryPerfResponse></soapenv:Body></soapenv:Envelope>`;

test('기간·롤업 매핑 — 기본 30일, 30일 이하는 month(2h)·초과는 year(1일)', () => {
  assert.deepEqual(USAGE_DAYS, [7, 30, 90, 180, 365]);
  assert.equal(normDays(undefined), 30);
  assert.equal(normDays('7'), 7);
  assert.equal(normDays(45), 30);       // 목록 밖 → 기본값
  assert.equal(intervalForDays(7), 'month');
  assert.equal(intervalForDays(30), 'month');
  assert.equal(intervalForDays(90), 'year');
  assert.equal(intervalForDays(365), 'year');
});

test('다중 엔티티 파싱 — returnval 이 여러 개면 VM 전부 읽는다', () => {
  const m = parseEntityPerfBatchXml(XML, ['6', '24']);
  assert.deepEqual([...m.keys()], ['vm-11', 'vm-22']);
  assert.deepEqual(m.get('vm-11').get('6').map((p) => p.v), [1000, 2000, 3000]);
  assert.deepEqual(m.get('vm-22').get('24').map((p) => p.v), [9000, 9100, 8900]);
  assert.equal(m.get('vm-11').get('6')[0].t, T[0]);
});

test('기존 parsePerfMultiXml 은 첫 엔티티만 읽는다(이 파서가 따로 필요한 이유를 고정)', () => {
  const single = parsePerfMultiXml(XML, ['6', '24']);
  // 첫 returnval(vm-11)의 값만 나온다 — vm-22 를 구분할 방법이 없다.
  assert.deepEqual(single.get('6').map((p) => p.v), [1000, 2000, 3000]);
});

test('계열이 인스턴스별로 여러 번 와도 집계(빈 instance)를 우선한다', () => {
  const xml = `<returnval><entity type="VirtualMachine">vm-9</entity>
    <sampleInfo><timestamp>${T[0]}</timestamp></sampleInfo>
    <value xsi:type="PerfMetricIntSeries"><id><counterId>6</counterId><instance>0</instance></id><value>100</value></value>
    <value xsi:type="PerfMetricIntSeries"><id><counterId>6</counterId><instance></instance></id><value>7000</value></value>
  </returnval>`;
  const m = parseEntityPerfBatchXml(xml, ['6']);
  assert.deepEqual(m.get('vm-9').get('6').map((p) => p.v), [7000]);
});

test('엔티티 타입이 다르면(호스트) VM 요청에서 제외된다', () => {
  const xml = `<returnval><entity type="HostSystem">host-1</entity>
    <sampleInfo><timestamp>${T[0]}</timestamp></sampleInfo>
    <value xsi:type="PerfMetricIntSeries"><id><counterId>6</counterId><instance></instance></id><value>500</value></value></returnval>`;
  assert.equal(parseEntityPerfBatchXml(xml, ['6']).size, 0);
  assert.equal(parseEntityPerfBatchXml(xml, ['6'], 'HostSystem').size, 1);
});

test('요약 — %×100 환산, 결측(-1) 제외, 표본 0 이면 null(0 으로 채우지 않는다)', () => {
  assert.deepEqual(summarizePoints([{ t: T[0], v: 1000 }, { t: T[1], v: 3000 }], 100), { avg: 20, max: 30, samples: 2 });
  assert.deepEqual(summarizePoints([{ t: T[0], v: -1 }, { t: T[1], v: 2000 }], 100), { avg: 20, max: 20, samples: 1 });
  assert.equal(summarizePoints([{ t: T[0], v: -1 }], 100), null);
  assert.equal(summarizePoints([], 100), null);
  assert.equal(summarizePoints(null, 100), null);
});

test('커버리지 — 표본이 실제로 덮는 기간(일). 표본 1개면 0, 없으면 null', () => {
  assert.equal(coverageDaysOf([{ t: T[0], v: 1 }, { t: T[2], v: 1 }]), 2);
  assert.equal(coverageDaysOf([{ t: T[0], v: 1 }]), 0);
  assert.equal(coverageDaysOf([]), null);
  assert.equal(coverageDaysOf([{ t: T[0], v: -1 }]), null); // 결측만 있으면 덮은 기간 없음
});

test('VM 한 건 요약 — cpu/mem 평균·최대·커버리지, 둘 다 없으면 null', () => {
  const m = parseEntityPerfBatchXml(XML, ['6', '24']);
  assert.deepEqual(summarizeVmUsage(m.get('vm-11'), { cpuId: '6', memId: '24' }),
    { cpuPct: 20, cpuMax: 30, memPct: 40, memMax: 40, samples: 3, coverageDays: 2 });
  // 한쪽 카운터가 vCenter 에 없으면 그쪽만 null(나머지는 살린다)
  assert.deepEqual(summarizeVmUsage(m.get('vm-22'), { cpuId: '6', memId: null }),
    { cpuPct: 5, cpuMax: 5, memPct: null, memMax: null, samples: 3, coverageDays: 2 });
  assert.equal(summarizeVmUsage(undefined, { cpuId: '6', memId: '24' }), null);
});

// ── v2.494: 호스트/클러스터 추이 ─────────────────────────────────────────────
import { intervalForRangeMs, averageByTimestamp } from '../src/vcenter/perfBatch.js';

test('기간(ms) → 롤업: 1h realtime · 24h 이하 day · 7일 week · 30일 month · 그 이상 year', () => {
  const H = 3_600_000, D = 86_400_000;
  assert.equal(intervalForRangeMs(H), 'realtime');
  assert.equal(intervalForRangeMs(6 * H), 'day');
  assert.equal(intervalForRangeMs(24 * H), 'day');
  assert.equal(intervalForRangeMs(7 * D), 'week');
  assert.equal(intervalForRangeMs(30 * D), 'month');
  assert.equal(intervalForRangeMs(60 * D), 'year');
  assert.equal(intervalForRangeMs(365 * D), 'year');
  assert.equal(intervalForRangeMs(0), 'day');        // 비정상 입력은 안전한 기본
  assert.equal(intervalForRangeMs('x'), 'day');
});

test('클러스터 평균 — 타임스탬프별로 호스트 평균, 결측(-1)·값 없는 호스트는 분모에서 제외', () => {
  const t0 = '2026-09-01T00:00:00Z', t1 = '2026-09-01T00:05:00Z';
  const mk = (pts) => new Map([['6', pts]]);
  const byRef = new Map([
    ['host-1', mk([{ t: t0, v: 2000 }, { t: t1, v: 4000 }])],
    ['host-2', mk([{ t: t0, v: 4000 }, { t: t1, v: -1 }])],   // t1 결측
    ['host-3', mk([])],                                        // 값 없음
  ]);
  const out = averageByTimestamp(byRef, '6', 100);
  assert.deepEqual(out, [
    { ts: Date.parse(t0), avg: 30, n: 2 },   // (20+40)/2
    { ts: Date.parse(t1), avg: 40, n: 1 },   // 결측 제외 → host-1 만
  ]);
  assert.deepEqual(averageByTimestamp(new Map(), '6'), []);
  assert.deepEqual(averageByTimestamp(null, '6'), []);
});
