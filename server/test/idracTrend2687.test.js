// v2.687 — iDRAC 통합 추이 › 서버 표 · 조건 검색:
//   ① ESXi 계열 3개(호스트 vCenter CPU · GPU 사용률 · GPU 메모리)를 **매칭 호스트 id** 로 요약해 표에 싣는다(서버 id 와 섞지 않는다)
//   ② 시간별 평균·최대·최소 라우트(/idrac/:id/trend/hourly) — '어느 날 어느 시간에 얼마나' 목록의 원천. 표와 같은 창·같은 롤업.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'idractrend2687-'));
process.env.CONFIG_DIR = DIR;
process.env.TEMP_DB_PATH = path.join(DIR, 'host-temp.db');
process.env.IDRAC_DB_PATH = path.join(DIR, 'idrac-power.db');
process.env.AUTH_ENABLED = 'false';
process.env.DATA_SOURCE = 'mock';

const { buildTableRows, mergeHourly, TABLE_HOST_KEYS, HOURLY_KEYS, HOST_CPU_METRIC } = await import('../src/routes/admin/idracTrend.js');
const { TREND_METRICS } = await import('../src/idrac/serverTrendSeries.js');
const { store } = await import('../src/store.js');
const { getMetricsDb } = await import('../src/metrics/db.js');
const { getDb: getPowerDb } = await import('../src/idrac/db.js');

const HOUR = 3_600_000;

test('① 표 행 — ESXi 계열은 매칭 호스트 id 로 찾고, 매칭 호스트가 없으면 null(0 아님)', () => {
  assert.deepEqual(Object.keys(TABLE_HOST_KEYS), ['hostCpuPct', 'hostGpuPct', 'hostGpuMemPct']);
  const st = { avg: 30, min: 10, max: 70, n: 12 };
  const stats = { hostCpuPct: new Map([['vc1:host-1', st]]), cpuTemp: new Map([['s1', { avg: 50, min: 40, max: 60, n: 12 }]]) };
  const latest = { hostCpuPct: [new Map([['vc1:host-1', { v: 33.33, ts: 5000 }]])] };
  const rows = buildTableRows([{ id: 's1', hostId: 'vc1:host-1' }, { id: 'vc1:host-1', hostId: null }], { stats, latest, since: 1000 });
  assert.deepEqual(rows[0].hostCpuPct, { ...st, cur: 33.3 }, '호스트 id 로 찾는다');
  assert.equal(rows[0].hostGpuPct, null, '값이 없으면 null');
  assert.equal(rows[1].hostCpuPct, null, '서버 id 가 우연히 호스트 id 와 같아도 매칭 호스트가 없으면 쓰지 않는다');
  assert.equal(rows[0].cpuTemp.max, 60, 'iDRAC 계열은 예전대로 서버 id');
  const old = buildTableRows([{ id: 's1', hostId: 'vc1:host-1' }], { stats, latest: { hostCpuPct: [new Map([['vc1:host-1', { v: 9, ts: 10 }]])] }, since: 1000 });
  assert.equal(old[0].hostCpuPct.cur, null, '창 이전 값을 현재라 하지 않는다');
});

test('② mergeHourly — 같은 시간 칸의 출처를 합친다(최소의 최소 · 최대의 최대) · 숫자가 아닌 점은 버린다', () => {
  const r = mergeHourly([
    [{ ts: HOUR, avg: 20, min: 10, max: 30 }, { ts: 2 * HOUR, avg: null, min: 1, max: 2 }],
    [{ ts: HOUR, avg: 40, min: 5, max: 50 }, { ts: 3 * HOUR, avg: 1, min: 1, max: 1 }],
    null,
  ]);
  assert.deepEqual(r, [{ ts: HOUR, avg: 30, min: 5, max: 50 }, { ts: 3 * HOUR, avg: 1, min: 1, max: 1 }]);
  assert.deepEqual(mergeHourly([]), []);
});

test('③ 라우트 — 시간별 평균·최대·최소 · ESXi 계열 · 전력 · 키 허용 목록 · 400/404', async () => {
  await store.refresh({ force: true });
  const host = (store.get().hosts || [])[0];
  assert.ok(host, '목 호스트가 있다');
  const { addServer } = await import('../src/idrac/registry.js');
  addServer({ id: 'srv87', name: `${String(host.name).split('.')[0].toUpperCase()}.t87.example`, host: '10.0.0.87', username: 'root', password: 'x' });
  const db = await getMetricsDb();
  const now = Date.now();
  const h0 = Math.floor(now / HOUR) * HOUR - 3 * HOUR;
  // 세 시간 칸: 평온 · 급등 · 평온 — 같은 시간 안에 표본 두 개(롤업 최소·최대 확인)
  for (const [t, cpu, hc] of [[h0 + 60_000, 20, 10], [h0 + 120_000, 22, 12], [h0 + HOUR + 60_000, 80, 90], [h0 + HOUR + 120_000, 60, 40], [h0 + 2 * HOUR + 60_000, 21, 11]]) {
    db.insertMany([{ metric: TREND_METRICS.cpuPct, k: 'srv87', v: cpu }, { metric: HOST_CPU_METRIC, k: String(host.id), v: hc }], t);
  }
  const pdb = await getPowerDb();
  pdb.insert('srv87', 400, h0 + 60_000); pdb.insert('srv87', 700, h0 + HOUR + 60_000); pdb.insert('srv87', 500, h0 + HOUR + 120_000);

  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express(); app.use(express.json()); app.use('/api/admin', adminRouter);
  const srv = app.listen(0); await new Promise((ok) => srv.once('listening', ok));
  const base = `http://127.0.0.1:${srv.address().port}/api/admin`;
  try {
    const r = await (await fetch(`${base}/idrac/srv87/trend/hourly?hours=6&keys=cpuPct,hostCpuPct,powerW,bogus`)).json();
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r.series).sort(), ['cpuPct', 'hostCpuPct', 'powerW'], '허용 목록 밖 키는 버린다');
    const spike = r.series.cpuPct.find((p) => p.ts === h0 + HOUR);
    assert.deepEqual([spike.min, spike.max, spike.avg], [60, 80, 70], '그 시간의 최소·최대·평균');
    assert.equal(r.series.cpuPct.length, 3, '값이 없는 시간은 행이 없다(0 으로 채우지 않는다)');
    assert.equal(r.series.hostCpuPct.find((p) => p.ts === h0 + HOUR)?.max, 90, 'ESXi 계열은 매칭 호스트 id 로 읽는다');
    const pw = r.series.powerW.find((p) => p.ts === h0 + HOUR);
    assert.deepEqual([pw.min, pw.max, pw.avg], [500, 700, 600], '전력도 시간별 최소·최대');
    // 표가 넘긴 창(since)을 그대로 쓴다 — 시간 정렬이 아니거나 너무 오래되면 hours 로 계산
    const s2 = await (await fetch(`${base}/idrac/srv87/trend/hourly?hours=6&since=${h0 + HOUR}&keys=cpuPct`)).json();
    assert.equal(s2.since, h0 + HOUR); assert.equal(s2.series.cpuPct[0].ts, h0 + HOUR);
    const s3 = await (await fetch(`${base}/idrac/srv87/trend/hourly?hours=6&since=${h0 + 5}&keys=cpuPct`)).json();
    assert.notEqual(s3.since, h0 + 5, '정렬되지 않은 since 는 받지 않는다');
    const all = await (await fetch(`${base}/idrac/srv87/trend/hourly?hours=6`)).json();
    assert.deepEqual(Object.keys(all.series).sort(), [...HOURLY_KEYS].sort(), 'keys 가 없으면 전 계열');
    assert.equal((await fetch(`${base}/idrac/srv87/trend/hourly?hours=0`)).status, 400);
    assert.equal((await fetch(`${base}/idrac/srv87/trend/hourly?hours=721`)).status, 400);
    assert.equal((await fetch(`${base}/idrac/nope/trend/hourly?hours=6`)).status, 404);
    // 표 — 매칭된 서버 행에 hostId 와 ESXi 계열 요약이 실린다
    const t = await (await fetch(`${base}/idrac/trend/table?hours=6`)).json();
    const row = t.rows.find((x) => x.id === 'srv87');
    assert.equal(row.hostId, String(host.id));
    assert.equal(row.hostCpuPct.max, 90); assert.equal(row.cpuPct.max, 80);
    const expect = (host.gpus || []).length ? 'gpu' : 'cpu';
    assert.equal(row.gpuState, expect, '매칭 호스트의 GPU 목록으로 판정한다(빈 목록 = CPU 만)');
    const only = await (await fetch(`${base}/idrac/trend/table?hours=6&gpu=${expect}&kind=esxi`)).json();
    assert.ok(only.rows.some((x) => x.id === 'srv87') && only.rows.every((x) => x.gpuState === expect && x.kind === 'esxi'), '종류 필터');
  } finally { srv.close(); }
});

test('④ 서버 종류 — GPU 판정 근거 셋 · CPU 만은 0 장으로 읽었을 때만 · 구버전 gpuOnly 호환', async () => {
  const { gpuStateOf, typeFilterOf, matchType } = await import('../src/routes/admin/idracTrend.js');
  const { gpuCardsOf } = await import('../src/idrac/serverForHost.js');
  // 입력은 실제 gpuCardsOf 결과 모양({cards,total}) — 배열로 시험하면 실제 모양과 어긋난 판정이 통과한다(v2.687 초판의 실제 결함).
  assert.equal(gpuStateOf({ temp: true }), 'gpu', 'GPU 온도');
  assert.equal(gpuStateOf({ idrac: gpuCardsOf([{ model: 'A40' }, { model: 'A40' }]) }), 'gpu', 'iDRAC 인벤토리 GPU');
  assert.equal(gpuStateOf({ esxi: gpuCardsOf([{ model: 'A40' }]), idrac: gpuCardsOf([]) }), 'gpu', 'ESXi 호스트 GPU 가 있으면 인벤토리 0 장보다 우선');
  assert.equal(gpuStateOf({ idrac: gpuCardsOf([]) }), 'cpu', '0 장으로 읽었다');
  assert.equal(gpuStateOf({ esxi: gpuCardsOf([]) }), 'cpu', 'ESXi 호스트 GPU 목록이 비었다');
  assert.equal(gpuStateOf({ esxi: gpuCardsOf(null), idrac: null }), 'unknown', '목록을 못 읽음');
  assert.equal(gpuStateOf({}), 'unknown', '근거 없음 — CPU 만이라 하지 않는다');
  assert.deepEqual(typeFilterOf({ gpuOnly: '1' }), { gpu: 'gpu', kind: '' });
  assert.deepEqual(typeFilterOf({ gpu: 'cpu', kind: 'esxi' }), { gpu: 'cpu', kind: 'esxi' });
  assert.deepEqual(typeFilterOf({ gpu: 'x', kind: 'y' }), { gpu: '', kind: '' }, '모르는 값은 거르지 않는다');
  const rows = [{ gpuState: 'gpu', kind: 'esxi' }, { gpuState: 'cpu', kind: 'baremetal' }, { gpuState: 'unknown', kind: 'esxi' }];
  assert.equal(rows.filter((r) => matchType(r, { gpu: 'cpu', kind: '' })).length, 1);
  assert.equal(rows.filter((r) => matchType(r, { gpu: '', kind: 'esxi' })).length, 2);
  assert.equal(rows.filter((r) => matchType(r, { gpu: 'gpu', kind: 'baremetal' })).length, 0);
});
