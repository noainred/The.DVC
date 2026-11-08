/**
 * test/sanStorage2948.test.js — v2.948 'SAN 스토리지 성능'(독립 도구 san-storage · 설계 docs/design/san-storage-perf · 컨펌 2026-11-08).
 *  ① directorOf — 벤더별 이름 규칙(PowerMax FA-1D · SAF-1d · FA-7E:0 · OR-1C / PowerStore NodeA / Unity SPA) · 평평한 이름은 null · 별칭 폴백 · 긴 입력
 *  ② storageList — 지금(한계 안) · 24시간 평균/피크(결측 제외) · 7일 대비(비교 구간 부족이면 null) · 디렉터 편중(24시간) · 회선 사용률 · 상태 코드
 *  ③ storagePerfCheck — unknown 을 ok 로 흡수하지 않는다 · 어레이 측은 이 판에서 unknown · 임계값 null 은 판정 안 함 · 벤더에 없는 항목은 na
 *  ④ storageCheckSettings — 기본값은 벤더 문서 값만(응답 시간은 비움) · 범위 · 주의 ≤ 이상 · null 과 빈 값의 뜻이 다르다 · 손상 보존
 *  ⑤ directorMap — 형식 검사(키 꼴 · 그룹 글자) · 바뀐 항목만 변경자 · 시각 갱신 · 손상 보존
 *  ⑥ 실제 라우트(mock · 인증 끔): 현황 지금 합계 == 트래픽 카드(traffic-total) · 디렉터 · 편중 · 점검 · 매핑 저장 뒤 분류 반영 · 임계값 저장 · 포트 이름 CSV · 상세
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sanstorage2948-'));
process.env.CONFIG_DIR = tmp;
process.env.SANSW_PERF_ROLLUP_BACKFILL = '0';
Object.assign(process.env, { DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', IPAM_WRITE_WORKER: '0' });

const MIN = 60_000; const HOUR = 3_600_000; const DAY = 24 * HOUR;
// 기준 시각은 실제 시각에서 정시 경계로 떨어뜨려 고정한다(CLAUDE.md).
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 2 * HOUR + 17 * MIN;

let D; let L; let C; let S; let M;
before(async () => {
  D = await import('../src/sanswitch/directorOf.js');
  L = await import('../src/sanswitch/storageList.js');
  C = await import('../src/sanswitch/storagePerfCheck.js');
  S = await import('../src/sanswitch/storageCheckSettings.js');
  M = await import('../src/sanswitch/directorMap.js');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('① directorOf — 벤더별 이름 규칙 · 평평한 이름 · 별칭 · 긴 입력', () => {
  assert.deepEqual(D.directorOf('SYMMETRIX::000197900123::FA-1D 4::FC::5978_711'), { vendor: 'powermax', group: 'FA-1D', port: '4', confidence: 'name' });
  assert.deepEqual(D.directorOf('SYMMETRIX::000497700230::SAF-1d 4::FC::5876'), { vendor: 'powermax', group: 'SAF-1D', port: '4', confidence: 'name' });
  assert.equal(D.directorOf('SYMMETRIX::000197900123::FA-7E:0::FC::5978').group, 'FA-7E');
  assert.equal(D.directorOf('SYMMETRIX::000197900123::FA-7E:0::FC::5978').port, '0');
  assert.deepEqual(D.directorOf('PowerMax::000120200111::OR-1C 1::FC::10.1'), { vendor: 'powermax', group: 'OR-1C', port: '1', confidence: 'name' });
  assert.deepEqual(D.directorOf('PowerStore::PS1A2B3C4D5E::NodeA FC0::FC::3.6.0'), { vendor: 'powerstore', group: 'Node A', port: 'FC0', confidence: 'name' });
  assert.deepEqual(D.directorOf('UNITY::APM00212345678::SPA FC0::FC::5.3.0'), { vendor: 'unity', group: 'SPA', port: 'FC0', confidence: 'name' });
  // 평평한 이름 — 추정하지 않는다
  assert.deepEqual(D.directorOf('HITACHI HUS VM 2109 CL1-A'), { vendor: 'other', group: null, port: '', confidence: 'none' });
  assert.equal(D.directorOf('Emulex PPN-10:00:00:90:fa:xx').group, null);
  // 셋째 조각이 규칙에 안 맞는 어레이 이름 → null(구분 못 함)
  assert.equal(D.directorOf('SYMMETRIX::000197900123::WEIRD::FC').group, null);
  // 별칭 폴백 — Unity_SPA0_p8 · unity-spb-p1 은 SPA/SPB, ESXSPARE · SPAIN 은 아니다
  assert.deepEqual(D.directorOf('', { alias: 'Unity_SPA0_p8' }), { vendor: 'unity', group: 'SPA', port: '', confidence: 'alias' });
  assert.equal(D.directorOf('', { alias: 'unity-spb-p1' }).group, 'SPB');
  assert.equal(D.directorOf('', { alias: 'ESXSPARE_hba0' }).group, null);
  assert.equal(D.directorOf('', { alias: 'SPAIN_host' }).group, null);
  // 길이 상한 — 2만 자 입력도 즉시 none
  // 길이 상한(200자) 뒤는 입력이 100배 길어도 일이 늘지 않아야 한다 — 절대 시간이 아니라 비율로(CPU 에 따라 깨지는 상한 금지 · v2.611 규약)
  const long = D.directorOf('X'.repeat(20_000)); assert.equal(long.group, null);
  const bench = (len, n = 200) => { const inp = 'X'.repeat(len); const t0 = process.hrtime.bigint(); for (let i = 0; i < n; i++) D.directorOf(inp); return Number(process.hrtime.bigint() - t0); };
  bench(200, 50); const short = bench(200); const huge = bench(20_000);
  assert.ok(huge < short * 20 + 2_000_000, `2만 자가 200자의 ${(huge / Math.max(short, 1)).toFixed(1)}배 — 길이 상한이 풀렸다`);
  // 수동 재정의가 이긴다
  assert.deepEqual(D.applyDirectorOverride(D.directorOf('HITACHI HUS VM CL1-A'), { group: 'CL1', note: 'ctl1' }), { vendor: 'other', group: 'CL1', port: '', confidence: 'manual', note: 'ctl1' });
  assert.equal(D.groupLabel(null), D.UNPARSED_GROUP);
  assert.equal(D.vendorOf('VMAX::0001::FA-1D 0'), 'powermax');
});

/** 합성 집계 — 스위치 A/B 각 2포트(FA-1D · FA-2D) + 호스트 1포트. FA-2D 가 3배. */
function synthAggs({ nowGap = 0, dropLastHours = 0, prevHours = 144, withHost = true } = {}) {
  const until = NOW;
  const b1 = Array.from({ length: 60 }, (_, i) => until - (59 - i) * MIN);
  const b7 = Array.from({ length: 168 }, (_, i) => until - (167 - i) * HOUR);
  const name = (dir, p) => `SYMMETRIX::000197900123::${dir} ${p}::FC::5978`;
  const ports = [
    { deviceId: 'swA', port: 1, name: name('FA-1D', 4), speed: '32G', v: 50e6 }, { deviceId: 'swB', port: 1, name: name('FA-1D', 5), speed: '32G', v: 50e6 },
    { deviceId: 'swA', port: 2, name: name('FA-2D', 4), speed: '32G', v: 150e6 }, { deviceId: 'swB', port: 2, name: name('FA-2D', 5), speed: '32G', v: 150e6 },
  ];
  const fill = (buckets, v, { dropLast = 0, keepFromEnd = null } = {}) => buckets.map((t, i) => {
    if (i >= buckets.length - dropLast) return null;
    if (keepFromEnd != null && i < buckets.length - keepFromEnd) return null;
    return v;
  });
  const sum1 = b1.map((_, i) => (i >= 60 - nowGap ? null : 400e6));
  const sum7 = fill(b7, 400e6, { dropLast: dropLastHours, keepFromEnd: prevHours + 24 });
  const series7 = {
    key: 'SYMMETRIX::000197900123', group: 'dcK', deviceIds: ['swA', 'swB'], ports: ports.map((p) => ({ deviceId: p.deviceId, port: p.port })),
    sum: sum7, peak: sum7.map((v) => (v == null ? null : v * 1.2)), partial: [], partialBuckets: 0, carriedCells: 0,
    avgTotal: 400e6, maxTotal: 400e6, peakAvg: 480e6, peakTotal: 480e6,
    portsDetail: ports.map((p) => ({ deviceId: p.deviceId, port: p.port, name: p.name, speed: p.speed, portType: 'F', avg: fill(b7, p.v, { dropLast: dropLastHours, keepFromEnd: prevHours + 24 }), peak: fill(b7, p.v * 1.2, { dropLast: dropLastHours, keepFromEnd: prevHours + 24 }) })),
  };
  const host7 = { key: 'Emulex PPN-k1', group: 'dcK', deviceIds: ['swA'], ports: [{ deviceId: 'swA', port: 3 }], sum: fill(b7, 10e6), peak: fill(b7, 12e6), partial: [], partialBuckets: 0, carriedCells: 0, avgTotal: 10e6, maxTotal: 10e6, peakAvg: 12e6, peakTotal: 12e6,
    portsDetail: [{ deviceId: 'swA', port: 3, name: 'Emulex PPN-k1', speed: '16G', portType: 'F', avg: fill(b7, 10e6), peak: fill(b7, 12e6) }] };
  const agg7d = { buckets: b7, bucketMs: HOUR, since: b7[0], until, carryMs: 10 * MIN, computedAt: until, source: { kind: 'rollup' }, series: withHost ? [series7, host7] : [series7] };
  const agg1h = { buckets: b1, bucketMs: MIN, since: b1[0], until, carryMs: 10 * MIN, computedAt: until, series: [{ ...series7, sum: sum1, peak: sum1.map((v) => (v == null ? null : v * 1.2)), portsDetail: undefined }] };
  return { agg1h, agg7d, until };
}
const META = new Map([['swA', { name: 'SW-A', datacenterId: 'dcK', datacenterName: 'KR1', agent: '' }], ['swB', { name: 'SW-B', datacenterId: 'dcK', datacenterName: 'KR1', agent: '' }]]);
const kindOf = (key) => (key.includes('::') ? 'array' : 'host');
const directorFor = (p) => D.directorOf(p.name);

test('② storageList — 지금 · 24시간 · 7일 대비 · 디렉터 편중 · 회선 사용률 · 상태', () => {
  const { agg1h, agg7d } = synthAggs();
  const lastTs = new Map([['swA', NOW], ['swB', NOW]]);
  const { rows, counts } = L.buildStorageRows({ agg1h, agg7d, deviceMeta: META, deviceLastTs: lastTs, kindOf, capacityOf: () => null, directorFor, now: NOW, carryMs: 10 * MIN });
  assert.deepEqual(counts, { array: 1, host: 1, unknown: 0 });
  assert.equal(rows.length, 1, '호스트는 행이 아니라 개수');
  const r = rows[0];
  assert.equal(r.now.bps, 400e6); assert.equal(r.now.stale, false);
  assert.equal(r.avg24, 400e6); assert.equal(r.peak24, 480e6); assert.equal(r.measured24, 24);
  assert.equal(r.prevHours, 144); assert.equal(r.delta7d, 0, '값이 같으니 0%');
  assert.equal(r.speedSumBps, 4 * 4e9); assert.equal(r.unknownSpeedPorts, 0);
  assert.equal(r.utilPct, 2.5, '400MB/s ÷ 16GB/s = 2.5%');
  assert.deepEqual(r.directors.map((d) => [d.group, d.ports, d.avg24, d.ratio]), [['FA-1D', 2, 100e6, 0.5], ['FA-2D', 2, 300e6, 1.5]]);
  assert.deepEqual(r.imbalance, { group: 'FA-2D', ratio: 1.5 });
  assert.equal(r.unparsedPorts, 0);
  assert.deepEqual(r.fabrics.map((f) => [f.name, f.ports, f.avg24]), [['SW-A', 2, 200e6], ['SW-B', 2, 200e6]]);
  assert.equal(r.ports.find((p) => p.port === 2 && p.deviceId === 'swA').peakSatPct, 4.5, '180MB/s ÷ 4GB/s');
  assert.equal(r.state, 'ok'); assert.equal(r.serial, '000197900123'); assert.equal(r.vendor, 'powermax');
  assert.deepEqual(L.rowTotals(rows), { avg24: 400e6, speedSumBps: 16e9, unknownSpeedPorts: 0, imbalance: 1, unmeasured: 0, unparsedArrays: 0, arrays: 1 });

  // 마지막 표본이 한계(10분 + 1분 칸)보다 오래됐으면 '지금' 없음 + stale
  const g = synthAggs({ nowGap: 15 });
  const r2 = L.buildStorageRows({ agg1h: g.agg1h, agg7d: g.agg7d, deviceMeta: META, deviceLastTs: lastTs, kindOf, capacityOf: () => null, directorFor, now: NOW, carryMs: 10 * MIN }).rows[0];
  assert.equal(r2.now.bps, null); assert.equal(r2.now.stale, true); assert.equal(r2.state, 'stale'); assert.equal(r2.utilPct, null, '지금이 없으면 사용률도 없다 — 0 아님');
  // 비교 구간이 6시간 미만이면 7일 대비 null · 사유를 셀 수 있게 prevHours
  const p = synthAggs({ prevHours: 3 });
  const r3 = L.buildStorageRows({ agg1h: p.agg1h, agg7d: p.agg7d, deviceMeta: META, deviceLastTs: lastTs, kindOf, capacityOf: () => null, directorFor, now: NOW, carryMs: 10 * MIN }).rows[0];
  assert.equal(r3.delta7d, null); assert.equal(r3.prevHours, 3);
  // 엣지 위임인데 표본이 한 번도 안 왔으면 edge-missing
  const edgeMeta = new Map([['swA', { ...META.get('swA'), agent: 'edge-k' }], ['swB', { ...META.get('swB'), agent: 'edge-k' }]]);
  const r4 = L.buildStorageRows({ agg1h, agg7d, deviceMeta: edgeMeta, deviceLastTs: new Map(), kindOf, capacityOf: () => null, directorFor, now: NOW, carryMs: 10 * MIN }).rows[0];
  assert.equal(r4.state, 'edge-missing');
  // 7일 집계가 전부 null 이고 부분 합만 있으면 partial-only · 전혀 없으면 no-sample
  const e = synthAggs(); e.agg7d.series[0].sum = e.agg7d.series[0].sum.map(() => null); e.agg7d.series[0].partialBuckets = 3;
  assert.equal(L.buildStorageRows({ agg1h: e.agg1h, agg7d: e.agg7d, deviceMeta: META, deviceLastTs: lastTs, kindOf, capacityOf: () => null, directorFor, now: NOW, carryMs: 10 * MIN }).rows[0].state, 'partial-only');
  // 순수 보조 함수
  assert.equal(L.delta7dOf(110, 100, 6), 10); assert.equal(L.delta7dOf(110, 100, 5), null); assert.equal(L.delta7dOf(110, 0, 10), null);
  assert.deepEqual(L.nowOf([1, null, 3, null], [0, 1, 2, 3], { until: 3, carryMs: 0, bucketMs: 1 }), { bps: 3, ts: 2, stale: false });
  assert.deepEqual(L.nowOf([1, null, null, null], [0, 1, 2, 3], { until: 3, carryMs: 0, bucketMs: 1 }), { bps: null, ts: 0, stale: true });
  assert.equal(L.nowOf([null, null], [0, 1], { until: 1 }), null);
  const dirs = L.directorsOf([{ group: 'A', confidence: 'name', avg24: 15 }, { group: 'B', confidence: 'name', avg24: null }, { group: null, confidence: 'none', avg24: 5 }], { minBps: 1, ratio: 1.4 });
  assert.equal(dirs.unparsedPorts, 1); assert.equal(dirs.directors[0].group, 'A'); assert.equal(dirs.directors.at(-1).group, D.UNPARSED_GROUP);
  assert.deepEqual(dirs.imbalance, { group: 'A', ratio: 1.5 }, '측정된 그룹(A · 구분 못 함) 평균 10 · A 15 → 1.5배');
  assert.equal(dirs.directors.find((d) => d.group === 'B').avg24, null, '측정 없는 그룹은 0 이 아니라 null');
  assert.equal(L.directorsOf([{ group: 'A', confidence: 'name', avg24: 10 }, { group: 'C', confidence: 'name', avg24: 5 }], { minBps: 1, ratio: 1.4 }).imbalance, null, '1.33배는 편중 아님');
});

test('③ storagePerfCheck — unknown 을 ok 로 흡수하지 않는다 · 어레이 측 unknown · 임계값 null 은 판정 안 함 · na', () => {
  const { agg1h, agg7d } = synthAggs();
  const lastTs = new Map([['swA', NOW], ['swB', NOW]]);
  const row = L.buildStorageRows({ agg1h, agg7d, deviceMeta: META, deviceLastTs: lastTs, kindOf, capacityOf: () => null, directorFor, now: NOW, carryMs: 10 * MIN }).rows[0];
  const settings = S.normalizeCheckSettings({});
  const r = C.checkArray(row, settings);
  assert.equal(r.items.imbalance.status, 'warn'); assert.match(r.items.imbalance.text, /FA-2D 1\.5×/);
  assert.equal(r.items.fabric.status, 'ok'); assert.equal(r.items.fabric.share, 50);
  assert.equal(r.items.portSat.status, 'ok'); assert.match(r.items.portSat.text, /SW-[AB]:2/);
  for (const k of ['dirBusy', 'resp', 'queue']) assert.equal(r.items[k].status, 'unknown', k); assert.match(r.items.dirBusy.text, /미수집/);
  assert.equal(r.items.cpu.status, 'na', 'PowerMax 에 노드 CPU 항목 없음');
  assert.equal(r.items.collect.status, 'ok');
  assert.equal(r.overall, 'warn'); assert.equal(r.uncheckedCount, 4);
  // 편중 2배 이상 → 이상
  const row2 = { ...row, imbalance: { group: 'FA-2D', ratio: 2.1 } };
  assert.equal(C.checkArray(row2, settings).items.imbalance.status, 'bad');
  // 표본 없는 행은 스위치 측 항목이 전부 unknown · 종합은 unknown(ok 로 뭉개지 않음)
  const none = { ...row, state: 'no-sample', stateText: '표본 없음', directors: [], fabrics: [], ports: [], now: null };
  const rn = C.checkArray(none, settings);
  assert.equal(rn.items.imbalance.status, 'unknown'); assert.equal(rn.items.collect.status, 'unknown'); assert.equal(rn.overall, 'unknown');
  // 임계값이 있는데 값이 있으면 판정 · null 이면 '기준 없음'
  assert.equal(C.thresholdJudge(72, null, 70).status, 'bad'); assert.equal(C.thresholdJudge(50, null, 70).status, 'ok');
  assert.equal(C.thresholdJudge(50, null, null).status, 'unknown'); assert.match(C.thresholdJudge(50, null, null).text, /기준 없음/);
  assert.equal(C.judgeArraySide('cpu', { value: 74 }, settings.values, 'powerstore').status, 'bad', 'PowerStore 노드 CPU 70 이상');
  assert.equal(C.judgeArraySide('cpu', { value: 74 }, settings.values, 'unity').status, 'warn', 'Unity SP CPU 70~90');
  assert.equal(C.judgeArraySide('resp', { value: 50 }, settings.values, 'powermax').status, 'unknown', '응답 시간 기본 비움');
  assert.equal(C.judgeArraySide('compare', { value: 35 }, settings.values, 'powermax').status, 'warn');
  const sum = C.summarizeChecks([r, rn, { overall: 'ok', uncheckedCount: 2 }]);
  assert.deepEqual(sum, { arrays: 3, ok: 1, warn: 1, bad: 0, unknown: 1, na: 0, partiallyUnchecked: 1 });
  // 팹 1대면 na · 한쪽 0 이면 bad
  assert.equal(C.checkArray({ ...row, fabrics: [row.fabrics[0]] }, settings).items.fabric.status, 'na');
  assert.equal(C.checkArray({ ...row, fabrics: [{ ...row.fabrics[0] }, { ...row.fabrics[1], avg24: 0 }] }, settings).items.fabric.status, 'bad');
  assert.equal(C.checkArray({ ...row, fabrics: [{ ...row.fabrics[0], avg24: 400e6 }, { ...row.fabrics[1], avg24: 50e6 }] }, settings).items.fabric.status, 'warn', '11% < 30%');
});

test('④ storageCheckSettings — 벤더 값 기본 · 비움 · 범위 · 주의 ≤ 이상 · null 과 빈 값 · 손상 보존', () => {
  S._resetForTest();
  const d = S.defaultThresholds();
  assert.equal(d.dirBusyBadPct, 70); assert.equal(d.queueBadPct, 75); assert.equal(d.unityCpuWarnPct, 70); assert.equal(d.unityCpuBadPct, 90);
  assert.equal(d.pstoreCpuWarnPct, 50); assert.equal(d.pstoreCpuBadPct, 70); assert.equal(d.portSatWarnPct, 70); assert.equal(d.portSatBadPct, 90);
  assert.equal(d.respWarnMs, null); assert.equal(d.respBadMs, null); assert.equal(d.dirBusyWarnPct, null);
  assert.deepEqual(S.loadCheckSettings().userSet, []);
  assert.match(S.saveCheckSettings({ values: { nope: 1 } }).issue, /모르는 항목/);
  assert.match(S.saveCheckSettings({ values: { portSatWarnPct: 150 } }).issue, /안이어야/);
  assert.match(S.saveCheckSettings({ values: { portSatWarnPct: 95, portSatBadPct: 90 } }).issue, /주의 ≤ 이상/);
  assert.match(S.saveCheckSettings({ values: { respBadMs: 'abc' } }).issue, /숫자 또는 null/);
  const ok = S.saveCheckSettings({ values: { respBadMs: 20, dirBusyBadPct: null, portSatWarnPct: '' } }, { by: 'admin1' });
  assert.ok(!ok.issue, ok.issue);
  assert.equal(ok.settings.values.respBadMs, 20); assert.equal(ok.settings.values.dirBusyBadPct, null, 'null 은 비움'); assert.equal(ok.settings.values.portSatWarnPct, 70, '빈 값은 기본값');
  assert.deepEqual([...ok.settings.userSet].sort(), ['dirBusyBadPct', 'respBadMs']);
  assert.equal(ok.settings.updatedBy, 'admin1');
  S._resetForTest();
  assert.equal(S.loadCheckSettings().values.respBadMs, 20, '다시 읽어도 같다');
  const file = path.join(tmp, 'storage-perf-check.json');
  fs.writeFileSync(file, '{ broken');
  S._resetForTest();
  assert.equal(S.loadCheckSettings().values.respBadMs, null, '손상이면 기본값');
  assert.ok(fs.readdirSync(tmp).some((f) => f.startsWith('storage-perf-check.json.corrupt.')), '손상 원본 보존');
  const pub = S.publicCheckSettings();
  assert.ok(pub.items.every((it) => it.source && it.label && it.unit));
});

test('⑤ directorMap — 형식 검사 · 바뀐 항목만 변경자 갱신 · 손상 보존', () => {
  M._resetForTest();
  assert.match(M.saveDirectorMap({ kinds: { k1: 'maybe' } }).issue, /array · host/);
  assert.match(M.saveDirectorMap({ directors: { 'bad-key': { group: 'A' } } }).issue, /꼴입니다/);
  assert.match(M.saveDirectorMap({ directors: { 'k|sw|1': { group: 'CL1;drop' } } }).issue, /형식/);
  assert.match(M.saveDirectorMap({ directors: { 'k|sw|1': { group: 'A'.repeat(41) } } }).issue, /형식/);
  const r1 = M.saveDirectorMap({ kinds: { 'HITACHI HUS': 'array' }, directors: { 'HITACHI HUS|sw|1': { group: 'CL1', note: 'ctl 1', name: 'HITACHI HUS CL1-A' } } }, { by: 'u1', now: 1000 });
  assert.ok(!r1.issue, r1.issue);
  assert.equal(r1.map.kinds['HITACHI HUS'].kind, 'array'); assert.equal(r1.map.kinds['HITACHI HUS'].by, 'u1'); assert.equal(r1.map.directors['HITACHI HUS|sw|1'].at, 1000);
  const r2 = M.saveDirectorMap({ kinds: { 'HITACHI HUS': 'array' }, directors: { 'HITACHI HUS|sw|1': { group: 'CL1', note: 'ctl 1', name: 'HITACHI HUS CL1-A' }, 'HITACHI HUS|sw|2': { group: 'CL2' } } }, { by: 'u2', now: 2000 });
  assert.equal(r2.map.directors['HITACHI HUS|sw|1'].at, 1000, '안 바뀐 항목은 예전 기록'); assert.equal(r2.map.directors['HITACHI HUS|sw|2'].by, 'u2');
  assert.equal(M.kindOverrideOf('HITACHI HUS').kind, 'array'); assert.equal(M.directorOverrideOf('HITACHI HUS', 'sw', 2).group, 'CL2'); assert.equal(M.directorOverrideOf('x', 'y', 1), null);
  assert.deepEqual(M.directorMapStatus(), { kinds: 1, directors: 2, updatedAt: 2000, updatedBy: 'u2' });
  M._resetForTest();
  assert.equal(M.loadDirectorMap().directors['HITACHI HUS|sw|2'].group, 'CL2');
  fs.writeFileSync(path.join(tmp, 'san-storage-map.json'), '[1,2]');
  M._resetForTest();
  assert.deepEqual(M.loadDirectorMap().kinds, {}); assert.ok(fs.readdirSync(tmp).some((f) => f.startsWith('san-storage-map.json.corrupt.')));
  assert.equal(M.directorMapKey('a', 'b', '3'), 'a|b|3');
});

test('⑥ 실제 라우트 — 현황 합계 == 트래픽 카드 · 디렉터 · 점검 · 매핑 · 임계값 · CSV · 상세', async () => {
  M._resetForTest(); S._resetForTest();
  fs.rmSync(path.join(tmp, 'san-storage-map.json'), { force: true }); fs.rmSync(path.join(tmp, 'storage-perf-check.json'), { force: true });
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const reg = await import('../src/sanswitch/registry.js');
  const { SAN_SWITCH_TYPES } = await import('../src/sanswitch/types.js');
  const { importSamples, invalidatePerfQueries } = await import('../src/sanswitch/perfDb.js');
  const swType = SAN_SWITCH_TYPES.find((t) => t.implemented)?.type || SAN_SWITCH_TYPES[0].type;
  reg.saveDevice({ type: swType, name: 'SW-KA', host: '10.72.9.1', username: 'u', password: 'p', datacenterId: 'dcK' });
  reg.saveDevice({ type: swType, name: 'SW-KB', host: '10.72.9.2', username: 'u', password: 'p', datacenterId: 'dcK' });
  const devA = reg.listDevices().find((d) => d.name === 'SW-KA'); const devB = reg.listDevices().find((d) => d.name === 'SW-KB');
  const now = Date.now();
  const nm = (dir, p) => `SYMMETRIX::000197900123::${dir} ${p}::FC::5978`;
  const meta = [
    { d: devA.id, p: 1, ts: now, name: nm('FA-1D', 4), wwn: '50:00:09:73:00:00:00:01', speed: '32G', type: 'F' }, { d: devB.id, p: 1, ts: now, name: nm('FA-1D', 5), wwn: '50:00:09:73:00:00:00:02', speed: '32G', type: 'F' },
    { d: devA.id, p: 2, ts: now, name: nm('FA-2D', 4), wwn: '50:00:09:73:00:00:00:03', speed: '32G', type: 'F' }, { d: devB.id, p: 2, ts: now, name: nm('FA-2D', 5), wwn: '50:00:09:73:00:00:00:04', speed: '32G', type: 'F' },
    { d: devA.id, p: 3, ts: now, name: 'Emulex PPN-k1', wwn: '10:00:00:90:fa:00:00:01', speed: '16G', type: 'F' },
    { d: devB.id, p: 7, ts: now, name: 'HITACHI HUS VM 2109 CL1-A', wwn: '50:06:0e:80:00:00:00:01', speed: '8G', type: 'F' },
  ];
  const val = { [`${devA.id}|1`]: 50e6, [`${devB.id}|1`]: 50e6, [`${devA.id}|2`]: 150e6, [`${devB.id}|2`]: 150e6, [`${devA.id}|3`]: 10e6, [`${devB.id}|7`]: 20e6 };
  const rows = [];
  for (let k = 7 * 24; k >= 1; k--) for (const m of meta) rows.push({ d: m.d, ts: now - k * HOUR, p: m.p, b: val[`${m.d}|${m.p}`] });   // 7일 · 1시간 간격
  for (let k = 60; k >= 0; k--) for (const m of meta) rows.push({ d: m.d, ts: now - k * MIN, p: m.p, b: val[`${m.d}|${m.p}`] });   // 최근 1시간 · 1분 간격
  await importSamples(rows, meta, 90);
  invalidatePerfQueries();
  const app = express(); app.use(express.json()); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const get = async (p) => { const r = await fetch(base + p); return { s: r.status, j: await r.json().catch(() => null), r }; };
  const put = async (p, body) => { const r = await fetch(base + p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { s: r.status, j: await r.json().catch(() => null) }; };
  try {
    const list = await get('/tools/san-storage?datacenterId=dcK');
    assert.equal(list.s, 200, JSON.stringify(list.j).slice(0, 300));
    assert.equal(list.j.rows.length, 1, '어레이 1 · 호스트(Emulex · 평평한 HITACHI)는 개수');
    assert.deepEqual(list.j.counts, { array: 1, host: 2, unknown: 0 });
    const row = list.j.rows[0];
    assert.equal(row.key, 'SYMMETRIX::000197900123'); assert.equal(row.vendor, 'powermax'); assert.equal(row.datacenterId, 'dcK');
    assert.deepEqual(row.directors.map((d) => [d.group, d.ports]), [['FA-1D', 2], ['FA-2D', 2]]);
    assert.deepEqual(row.imbalance, { group: 'FA-2D', ratio: 1.5 });
    assert.equal(row.now.bps, 400e6); assert.equal(row.utilPct, 2.5); assert.equal(row.state, 'ok');
    assert.equal(row.spark.sum.filter((v) => v != null).length >= 55, true, '최근 1시간 스파크');
    // 지금 합계 == 트래픽 카드(같은 함수 · 같은 분류)
    const tt = await get('/tools/sanswitch/perf/traffic-total?hours=1&datacenterId=dcK');
    assert.equal(tt.s, 200); assert.equal(list.j.totals.nowBps, tt.j.now.bps, '두 숫자가 다르면 결함');
    assert.equal(list.j.totals.nowBps, 400e6);
    assert.ok(list.j.windows && list.j.imbalanceRule.ratio > 1 && list.j.minPrevHours >= 1);
    // 점검
    const chk = await get('/tools/san-storage/check?datacenterId=dcK');
    assert.equal(chk.s, 200); assert.equal(chk.j.results.length, 1);
    const c0 = chk.j.results[0];
    assert.equal(c0.items.imbalance.status, 'warn'); assert.equal(c0.items.fabric.status, 'ok'); assert.equal(c0.items.portSat.status, 'ok'); assert.equal(c0.items.dirBusy.status, 'unknown'); assert.equal(c0.overall, 'warn');
    assert.equal(chk.j.summary.warn, 1); assert.ok(chk.j.settings.items.length >= 10); assert.equal(chk.j.items.length, 9);
    // 매핑 — 평평한 이름을 어레이로 지정 + 포트 디렉터 수동
    const mp = await get('/tools/san-storage/mapping?datacenterId=dcK');
    assert.equal(mp.s, 200); assert.ok(mp.j.targets.some((t) => t.key === 'SYMMETRIX::000197900123')); assert.equal(mp.j.ports.length, 0, '어레이 포트는 전부 이름 규칙으로 읽혔다');
    const bad = await put('/tools/san-storage/mapping', { directors: { [`HITACHI HUS VM 2109 CL1-A|${devB.id}|7`]: { group: 'CL1;drop' } } });
    assert.equal(bad.s, 400); assert.match(bad.j.reason, /형식/);
    const okm = await put('/tools/san-storage/mapping', { kinds: { 'HITACHI HUS VM 2109 CL1-A': 'array' }, directors: { [`HITACHI HUS VM 2109 CL1-A|${devB.id}|7`]: { group: 'CL1', note: '컨트롤러 1' } } });
    assert.equal(okm.s, 200, JSON.stringify(okm.j));
    const list2 = await get('/tools/san-storage?datacenterId=dcK');
    assert.equal(list2.j.rows.length, 2, '수동 분류로 어레이 2');
    const hus = list2.j.rows.find((r) => r.key === 'HITACHI HUS VM 2109 CL1-A');
    assert.equal(hus.kindBasis, 'manual'); assert.deepEqual(hus.directors.map((d) => [d.group, d.confidence]), [['CL1', 'manual']]); assert.equal(hus.vendor, 'other');
    assert.equal(list2.j.counts.host, 1);
    const mp2 = await get('/tools/san-storage/mapping?datacenterId=dcK');
    assert.ok(mp2.j.ports.some((p) => p.key === 'HITACHI HUS VM 2109 CL1-A' && p.override?.group === 'CL1'));
    // 임계값
    const bs = await put('/tools/san-storage/check-settings', { values: { portSatWarnPct: 95, portSatBadPct: 90 } });
    assert.equal(bs.s, 400);
    const gs = await put('/tools/san-storage/check-settings', { values: { respBadMs: 20 } });
    assert.equal(gs.s, 200); assert.deepEqual(gs.j.userSet, ['respBadMs']);
    const gs2 = await get('/tools/san-storage/check-settings');
    assert.equal(gs2.j.values.respBadMs, 20); assert.equal(gs2.j.values.dirBusyBadPct, 70);
    // 상세
    const det = await get(`/tools/san-storage/array?key=${encodeURIComponent('SYMMETRIX::000197900123')}&datacenterId=dcK&hours=24`);
    assert.equal(det.s, 200, JSON.stringify(det.j).slice(0, 200));
    assert.equal(det.j.ports.length, 4); assert.deepEqual(det.j.directors.map((d) => d.group), ['FA-1D', 'FA-2D']); assert.equal(det.j.fabrics.length, 2);
    assert.equal(det.j.buckets.length, det.j.sum.length); assert.ok(det.j.directors[0].sum.length === det.j.buckets.length);
    assert.equal(det.j.offsetMin, 540);
    assert.equal((await get('/tools/san-storage/array?datacenterId=dcK')).s, 400);
    assert.equal((await get(`/tools/san-storage/array?key=${encodeURIComponent('NOPE::1')}&datacenterId=dcK`)).s, 404);
    // 포트 이름 CSV
    const csv = await fetch(`${base}/tools/san-storage/port-names.csv?datacenterId=dcK`);
    assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type'), /text\/csv/);
    const text = await csv.text();
    assert.match(text, /FA-1D/); assert.match(text, /HITACHI HUS VM 2109 CL1-A/); assert.match(text.split('\r\n')[0], /심볼릭|연결 장비 이름/);
  } finally { srv.close(); }
});
