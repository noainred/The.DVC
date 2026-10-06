/**
 * v2.669 — SAN 스토리지 트래픽 합계(시안 'SAN Switch v2' 의 트래픽 카드).
 *  ① 어레이만 더한다(HBA 는 같은 트래픽의 반대편 — 더하면 두 배)
 *  ② 부분 합(빠진 포트가 있는 버킷)은 합계도 null
 *  ③ 팹 A/B 캡처 시각이 어긋나 한 시리즈가 빈 버킷은 한계 안에서 이월(합계 선이 반으로 떨어지지 않게)
 *  ④ 한계를 넘긴 결측·아직 캡처 전은 null(0 으로 세지 않는다)
 *  ⑤ 실제 라우트: DB 에 표본을 넣고 /tools/sanswitch/perf/traffic-total 을 부른다
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2669-'));
Object.assign(process.env, { CONFIG_DIR: CFG, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', IPAM_WRITE_WORKER: '0' });

const { sumArrayTraffic } = await import('../src/sanswitch/trafficTotal.js');

const M = 60_000;
const arr = (key, sum, extra = {}) => ({ key, group: extra.group ?? '', sum, partial: extra.partial || [] });
const isArray = (s) => s.key.includes('::');

test('① 어레이만 더한다 — HBA 시리즈는 합계에 들어가지 않는다', () => {
  const agg = { buckets: [0, M], series: [
    arr('SYMMETRIX::1', [100, 200]), arr('PowerStore::2', [10, 20]),
    arr('Emulex PPN-a', [999, 999]), arr('QLE2692 FW:1', [888, 888]),
  ] };
  const t = sumArrayTraffic(agg, { isArray, carryMs: 10 * M });
  assert.deepEqual(t.total, [110, 220]);
  assert.equal(t.arrays, 2);
  assert.deepEqual(t.now, { ts: M, bps: 220 });
  assert.equal(t.avg, 165);
  assert.deepEqual(t.peak, { bps: 220, ts: M });
});

test('② 부분 합으로 비운 버킷은 합계도 null — 평균·최고에서 빠진다', () => {
  const agg = { buckets: [0, M, 2 * M], series: [
    arr('SYMMETRIX::1', [100, null, 100], { partial: [1] }), arr('SYMMETRIX::2', [50, 50, 50]),
  ] };
  const t = sumArrayTraffic(agg, { isArray, carryMs: 10 * M });
  assert.deepEqual(t.total, [150, null, 150]);
  assert.equal(t.partialBuckets, 1);
  assert.equal(t.avg, 150);
});

test('③ 캡처 시각이 어긋난 빈 칸은 한계 안에서 이월한다(합계 선이 반으로 떨어지지 않게)', () => {
  // 팹 A 는 짝수, 팹 B 는 홀수 버킷에만 표본 — 예시 코드처럼 null 이면 합계 null 로 두면 선이 전부 사라진다.
  const agg = { buckets: [0, M, 2 * M, 3 * M], series: [
    arr('SYMMETRIX::A', [100, null, 100, null]), arr('SYMMETRIX::B', [null, 40, null, 40]),
  ] };
  const t = sumArrayTraffic(agg, { isArray, carryMs: 10 * M });
  // 버킷 0: B 가 아직 캡처 전이고 첫 값이 한계 안(1분 뒤) → 모른다(null). 이후는 이월로 완성.
  assert.deepEqual(t.total, [null, 140, 140, 140]);
  assert.ok(t.carriedCells >= 3);
  assert.deepEqual(t.now, { ts: 3 * M, bps: 140 });
});

test('④ 한계를 넘긴 결측은 null, 한참 뒤에 처음 나온 시리즈는 그 전에는 없던 것', () => {
  const agg = { buckets: [0, 30 * M, 60 * M], series: [
    arr('SYMMETRIX::A', [100, null, 100]), arr('SYMMETRIX::late', [null, null, 7]),
  ] };
  const t = sumArrayTraffic(agg, { isArray, carryMs: 10 * M });
  assert.equal(t.total[0], 100, '늦게 등장한 어레이는 그 전 구간을 모른다고 하지 않는다(없던 것)');
  assert.equal(t.total[1], null, 'A 의 직전 값이 한계(10분)를 넘었다 — 0 이 아니라 모름');
  assert.equal(t.total[2], 107);
});

test('④-b 어레이가 하나도 없으면 now·avg·peak 는 null(0 Gbps 가 아니다)', () => {
  const t = sumArrayTraffic({ buckets: [0], series: [arr('Emulex PPN-a', [5])] }, { isArray, carryMs: M });
  assert.deepEqual(t.total, [null]);
  assert.equal(t.now, null); assert.equal(t.avg, null); assert.equal(t.peak, null);
  const e = sumArrayTraffic({ buckets: [], series: [] }, { isArray, carryMs: M });
  assert.equal(e.now, null); assert.deepEqual(e.byGroupNow, {});
});

test('법인별 비중은 마지막 유효 버킷 기준이다', () => {
  const agg = { buckets: [0, M], series: [
    arr('SYMMETRIX::1', [10, 30], { group: 'dcA' }), arr('SYMMETRIX::2', [5, 7], { group: 'dcB' }),
  ] };
  assert.deepEqual(sumArrayTraffic(agg, { isArray, carryMs: M }).byGroupNow, { dcA: 30, dcB: 7 });
});

test('⑤ 실제 라우트 — 어레이 포트만 합산 · 법인 필터 · 단위 바이트/초 · 주소 미포함', async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const reg = await import('../src/sanswitch/registry.js');
  const { SAN_SWITCH_TYPES } = await import('../src/sanswitch/types.js');
  const { savePerfSample } = await import('../src/sanswitch/perfDb.js');
  const ps = await import('../src/sanswitch/perfSettings.js');
  const swType = SAN_SWITCH_TYPES.find((t) => t.implemented)?.type || SAN_SWITCH_TYPES[0].type;
  reg.saveDevice({ type: swType, name: 'FAB-A', host: '10.69.0.1', username: 'u', password: 'p', datacenterId: 'dcA' });
  reg.saveDevice({ type: swType, name: 'FAB-B', host: '10.69.0.2', username: 'u', password: 'p', datacenterId: 'dcB' });
  const [a, b] = reg.listDevices();
  const now = Date.now();
  const meta = [
    { port: 1, attachedName: 'SYMMETRIX::000111' }, { port: 2, attachedName: 'Emulex PPN-host1' },
  ];
  for (let k = 5; k >= 1; k--) {
    const ts = now - k * 5 * M;
    await savePerfSample(a.id, ts, { 1: 1_000_000, 2: 1_000_000 }, meta);   // 어레이 1MB/s + HBA 1MB/s
    await savePerfSample(b.id, ts + 20_000, { 1: 500_000, 2: 700_000 }, meta); // 20초 늦게 캡처
  }
  const app = express(); app.use(express.json()); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  try {
    const all = await (await fetch(`${base}/tools/sanswitch/perf/traffic-total?hours=1`)).json();
    assert.equal(all.ok, true); assert.equal(all.unit, 'bytesPerSec');
    assert.equal(all.now?.bps, 1_500_000, JSON.stringify(all.now) + ' — 어레이 포트만(1MB + 0.5MB), HBA 제외');
    assert.equal(all.switches, 2); assert.equal(all.datacenters, 2); assert.equal(all.enabled, ps.loadPerfSettings().enabled || true); // v2.708: mock(이 테스트의 DATA_SOURCE)은 켜진 것처럼(demoOn) — 저장 설정은 그대로
    assert.equal(all.intervalMs, ps.loadPerfSettings().intervalMs);
    assert.deepEqual(all.byDatacenter.map((x) => [x.datacenterId, x.bps]), [['dcA', 1_000_000], ['dcB', 500_000]]);
    assert.ok(!JSON.stringify(all).includes('10.69.0.'), '응답에 관리 주소가 없어야 한다');
    const one = await (await fetch(`${base}/tools/sanswitch/perf/traffic-total?hours=1&datacenterId=dcB`)).json();
    assert.equal(one.now?.bps, 500_000); assert.equal(one.switches, 1); assert.deepEqual(one.datacenterIds, ['dcB']);
  } finally { srv.close(); }
});

test('③-b 앞 시리즈가 판정을 깨도 뒤 시리즈의 직전 값은 그 버킷에서 갱신된다', () => {
  // 버킷 0: A 는 아직 캡처 전(깨짐), B 는 값 있음 → 합계 null. 버킷 1: A 값, B 없음 → B 는 버킷 0 값을 이월해야 한다.
  const agg = { buckets: [0, M, 2 * M], series: [
    arr('SYMMETRIX::A', [null, 100, 100]), arr('SYMMETRIX::B', [40, null, 40]),
  ] };
  const t = sumArrayTraffic(agg, { isArray, carryMs: 3 * M });
  assert.deepEqual(t.total, [null, 140, 140]);
});
