// v2.660 — 특수 기능 › iDRAC 통합 추이 + 서버 분석의 법인 보강(미가상화 물리 → 스캔 에이전트 데이터센터).
// 실제 metrics DB·전력 DB(임시 파일)로 기간 조회를 부르고, 실제 admin 라우터를 express 에 마운트해 응답을 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'idractrend2660-'));
process.env.CONFIG_DIR = DIR;
process.env.TEMP_DB_PATH = path.join(DIR, 'host-temp.db');
process.env.IDRAC_DB_PATH = path.join(DIR, 'idrac-power.db');
process.env.AUTH_ENABLED = 'false';
process.env.DATA_SOURCE = 'mock';

const { parseWindow, bucketOf, mergeSeries, trendRetentionDays, PRESETS } = await import('../src/routes/admin/idracTrend.js');
const { trendValuesOf, buildServerTrendRows, TREND_METRICS } = await import('../src/idrac/serverTrendSeries.js');
const { rangeSpan, buildScanSiteIndex, scanSiteOf, hostIpNum, siteNameOf, SITE_OUTSIDE } = await import('../src/idrac/scanSite.js');
const { withScanDatacenter } = await import('../src/insights/analysisServers.js');
const { policyKeyFor } = await import('../src/metrics/deadband.js');
const { getMetricsDb } = await import('../src/metrics/db.js');
const { getDb: getPowerDb } = await import('../src/idrac/db.js');
const { sanitizeRemoteSensors } = await import('../src/collector/remoteInventory.js');
const { remoteSensorView } = await import('../src/idrac/sensorStore.js');

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
// 기준 시각은 경계에서 떨어뜨려 고정한다(CLAUDE.md v2.517 규약) — 정시 −30분.
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * MIN;

test('① 집계 단위 — 표본 ≤ 400, 핸드오프 표와 같다', () => {
  assert.equal(bucketOf(HOUR), MIN);
  assert.equal(bucketOf(DAY), 5 * MIN);
  assert.equal(bucketOf(7 * DAY), HOUR); // v2.729: 30분 → 1시간(롤업을 읽는다)
  assert.equal(bucketOf(30 * DAY), 2 * HOUR);
  assert.equal(bucketOf(90 * DAY), 6 * HOUR);
  assert.equal(bucketOf(365 * DAY), DAY);
  for (const span of Object.values(PRESETS)) assert.ok(span / bucketOf(span) <= 400, `${span} 은 400 표본 이내`);
});

test('② 기간 — 보관 밖·역순·1시간 미만·미래는 거부, 시작은 버킷 경계로', () => {
  assert.match(parseWindow({ start: NOW - 400 * DAY, end: NOW }, { now: NOW, retentionDays: 365 }).error, /보관 기간/);
  assert.ok(!parseWindow({ range: '1y' }, { now: NOW, retentionDays: 365 }).error);
  assert.match(parseWindow({ start: NOW, end: NOW - 1 }, { now: NOW }).error, /뒤여야/);
  assert.match(parseWindow({ start: NOW - 30 * MIN, end: NOW }, { now: NOW }).error, /최소 1시간/);
  assert.match(parseWindow({ start: NOW - DAY, end: NOW + HOUR }, { now: NOW }).error, /현재 이후/);
  const w = parseWindow({ range: '24h' }, { now: NOW });
  assert.equal(w.start % w.bucketMs, 0);
  assert.equal(parseWindow({ range: 'zzz' }, { now: NOW }).bucketMs, 5 * MIN, '모르는 범위는 24시간');
  assert.equal(trendRetentionDays(1830, {}), 365);
  assert.equal(trendRetentionDays(90, {}), 90, '롤업 보존이 더 짧으면 그 값');
  assert.equal(trendRetentionDays(0, {}), 365, '0 = 무제한 → 기본 365');
  assert.equal(trendRetentionDays(1830, { IDRAC_TREND_RETENTION_DAYS: '' }), 365, '빈 값은 미지정');
});

test('③ 한 시간축 — 결측은 null(0 금지)', () => {
  const win = { start: 0, end: 3 * MIN, bucketMs: MIN };
  const pts = mergeSeries(win, { cpuPct: [{ ts: 0, avg: 10 }], powerW: [{ ts: MIN, watts: 300 }], gpuTemp: [] });
  assert.equal(pts.length, 3);
  assert.deepEqual(pts[0], { t: 0, cpuPct: 10, powerW: null, gpuTemp: null });
  assert.equal(pts[1].powerW, 300);
  assert.equal(pts[2].cpuPct, null);
});

test('④ 적재 값 — GPU 는 센서 상세와 같은 역할 판정, 전원공급장치·범위 밖 퍼센트는 쓰지 않는다', () => {
  const v = trendValuesOf({ t: NOW, cpu: 42, temps: { 'CPU1 Temp': 61, 'CPU2 Temp': 64, 'GPU1 Temp': 55, 'GPU Temp 7': 58, 'PS1 Temp': 70 } });
  assert.deepEqual(v, { cpuPct: 42, cpuTemp: 64, gpuTemp: 58, inletTemp: null, exhaustTemp: null });
  assert.equal(trendValuesOf({ cpu: 150, temps: {} }).cpuPct, null, '0~100 밖은 퍼센트가 아니다');
  const rows = buildServerTrendRows([{ id: 's1' }, { id: 's2' }], {
    now: NOW, detail: false, localCycle: null, maxAgeMs: 10 * MIN,
    latestOf: (s) => (s.id === 's1' ? { t: NOW, cpu: 42, temps: { 'CPU1 Temp': 61 } } : { t: NOW - DAY, cpu: 1, temps: { 'CPU1 Temp': 1 } }),
  });
  assert.deepEqual(rows.map((r) => r.metric).sort(), [TREND_METRICS.cpuPct, TREND_METRICS.cpuTemp].sort(), '오래된 표본(s2)은 적재하지 않는다');
  const det = buildServerTrendRows([{ id: 's1' }], { now: NOW, detail: true, localCycle: null, maxAgeMs: 10 * MIN, latestOf: () => ({ t: NOW, temps: { 'CPU1 Temp': 61 } }) });
  assert.equal(det.length, 0, '상세 모드는 serverTempSeries 가 idractemp_cpu 를 적재한다 — 두 번 넣지 않는다');
  assert.equal(policyKeyFor('idractemp_gpu'), 'temp');
  assert.equal(policyKeyFor('idractemp_cpu'), 'temp');
  assert.equal(policyKeyFor('idractemp_max'), null, '기존 계열은 그대로(전량 저장)');
  assert.equal(policyKeyFor('idracusage_cpu'), null, '사용률은 dead-band 대상이 아니다');
});

test('⑤ 엣지 CPU 사용률 — 0~100 만 받고 remoteSensorView 가 전달한다', () => {
  assert.equal(sanitizeRemoteSensors({ t: NOW, temps: { a: 30 }, cpu: 33 }).cpu, 33);
  assert.equal('cpu' in sanitizeRemoteSensors({ t: NOW, temps: { a: 30 }, cpu: 300 }), false);
  assert.equal('cpu' in sanitizeRemoteSensors({ t: NOW, temps: { a: 30 } }), false, '구버전 엣지');
  const v = remoteSensorView({ sensors: { t: NOW, temps: { a: 30 }, cpu: 12 } });
  assert.equal(v.latest.cpu, 12); assert.equal(v.cpuSynced, true);
  assert.equal(remoteSensorView({ sensors: { t: NOW, temps: { a: 30 } } }).cpuSynced, false);
});

test('⑥ 스캔 대역 — 펼치지 않는 구간 비교, 겹치면 좁은 대역, 다른 법인 겹침은 귀속하지 않음', () => {
  assert.deepEqual(rangeSpan('10.0.0.0/24'), [hostIpNum('10.0.0.0'), hostIpNum('10.0.0.255')]);
  assert.deepEqual(rangeSpan('10.0.0.5-20'), [hostIpNum('10.0.0.5'), hostIpNum('10.0.0.20')]);
  assert.equal(rangeSpan('10.0.0.9-3'), null);
  assert.equal(rangeSpan('abc'), null);
  assert.equal(hostIpNum('https://10.0.0.7:443/redfish'), hostIpNum('10.0.0.7'));
  assert.equal(hostIpNum('idrac-01.corp'), null, '이름 등록은 DNS 를 보지 않는다');
  const idx = buildScanSiteIndex([
    { id: 'a', datacenterId: 'HG', service: 'HG-전체', ranges: ['10.0.0.0/16'], agent: 'edge-hg' },
    { id: 'b', datacenterId: 'HG', service: 'HG-GPU', ranges: ['10.0.5.0/24'], agent: 'edge-hg' },
    { id: 'c', datacenterId: 'NJ', service: 'NJ', ranges: ['10.9.0.1-10.9.0.50'], agent: '' },
    { id: 'd', datacenterId: 'WA', service: 'WA', ranges: ['10.9.0.40-60'], agent: '' },
  ], { agentDc: (a) => (a === 'edge-hg' ? 'HG-DC' : '') });
  const m = scanSiteOf(hostIpNum('10.0.5.9'), idx).match;
  assert.equal(m.site, 'HG-GPU', '더 좁은 대역');
  assert.equal(m.datacenterId, 'HG-DC', '에이전트가 속한 데이터센터가 우선');
  assert.equal(m.dcSource, 'agent');
  const c = scanSiteOf(hostIpNum('10.9.0.10'), idx).match;
  assert.equal(c.datacenterId, 'NJ'); assert.equal(c.dcSource, 'range', '중앙 직접 스캔 = 대역의 법인');
  const amb = scanSiteOf(hostIpNum('10.9.0.45'), idx);
  assert.equal(amb.match, null); assert.equal(amb.ambiguous, true);
  assert.equal(siteNameOf({ host: '10.200.0.1' }, idx), SITE_OUTSIDE);
  assert.equal(siteNameOf({ host: '10.9.0.45' }, idx), '(대역 겹침)');
});

test('⑦ 서버 분석 법인 보강 — 빈 법인만 채우고 기존 귀속·vCenter 할당은 건드리지 않는다', () => {
  const idx = buildScanSiteIndex([{ id: 'a', datacenterId: 'HG', service: 'HG', ranges: ['10.0.0.0/24'], agent: 'e1' }], { agentDc: () => 'HG-E' });
  const filled = withScanDatacenter({ id: 'x', host: '10.0.0.5' }, idx, {});
  assert.equal(filled.datacenterId, 'HG-E'); assert.equal(filled.dcSource, 'scan-agent');
  const kept = withScanDatacenter({ id: 'y', host: '10.0.0.5', datacenterId: 'NJ' }, idx, {});
  assert.equal(kept.datacenterId, 'NJ');
  const viaVc = withScanDatacenter({ id: 'z', host: '10.0.0.5', mappedVcenterId: 'vc1' }, idx, { vc1: 'WA' });
  assert.equal(viaVc.datacenterId, undefined, 'vCenter→법인 할당이 있으면 그 귀속을 쓴다(여기서 채우지 않음)');
  assert.equal(withScanDatacenter({ id: 'o', host: '10.1.0.5' }, idx, {}).datacenterId, undefined, '대역 밖은 지어내지 않는다');
});

test('⑧ metrics 기간 조회 — 끝이 있는 창, dead-band 온도는 step 채움, 1시간 버킷은 롤업', async () => {
  const db = await getMetricsDb();
  const base = NOW - 3 * HOUR;
  // idractemp_gpu(dead-band) 를 1분마다 같은 값으로 60분 넣는다 — 원본에는 첫 행만 남는다.
  for (let i = 0; i < 60; i++) db.insertMany([{ metric: 'idractemp_gpu', k: 's1', v: 50 }, { metric: 'idracusage_cpu', k: 's1', v: i }], base + i * MIN);
  const five = db.historyRange('idractemp_gpu', 's1', base, base + HOUR, 5 * MIN);
  assert.equal(five.length, 12, 'step 채움 — 안정 구간에 빈 버킷이 없다');
  assert.ok(five.every((p) => p.avg === 50));
  const past = db.historyRange('idracusage_cpu', 's1', base, base + 30 * MIN, 5 * MIN);
  assert.equal(past.length, 6, '끝(30분) 이후는 담지 않는다');
  assert.equal(past[0].avg, 2, '0~4 평균');
  const hourly = db.historyRange('idracusage_cpu', 's1', Math.floor(base / HOUR) * HOUR, NOW, HOUR);
  assert.ok(hourly.length >= 1 && hourly.length <= 2);
  assert.deepEqual(db.historyRange('idracusage_cpu', 'none', base, NOW, 5 * MIN), [], '없는 키는 빈 배열');
});

test('⑨ 전력 기간 조회 — dead-band 원본을 step 채움, 1시간은 롤업', async () => {
  const pdb = await getPowerDb();
  const base = NOW - 3 * HOUR;
  // 원본을 dead-band 처럼 성기게 둔다(0분·30분) — 사이 버킷은 step 채움이어야 한다.
  pdb.insert('s1', 400, base); pdb.insert('s1', 400, base + 30 * MIN);
  const five = pdb.bucketRange('s1', base, base + HOUR, 5 * MIN);
  assert.equal(five.length, 12);
  assert.ok(five.every((p) => p.watts === 400));
  const h = pdb.bucketRange('s1', Math.floor(base / HOUR) * HOUR, NOW, HOUR);
  assert.ok(h.length >= 1 && h.every((p) => p.watts === 400));
});

test('⑩ 라우트 — 실제 admin 라우터: 목록 200 · 추이 점 수 · 없는 서버 404 · CSV BOM·빈 칸 결측', async () => {
  const { addServer } = await import('../src/idrac/registry.js');
  const r = addServer({ id: 'bm-01', name: 'bm-01', host: '10.0.0.5', username: 'root', password: 'x' });
  const id = r?.server?.id || r?.id || (Array.isArray(r) ? r[0]?.id : null);
  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express(); app.use(express.json()); app.use('/api/admin', adminRouter);
  const srv = app.listen(0); await new Promise((ok) => srv.once('listening', ok));
  const base = `http://127.0.0.1:${srv.address().port}/api/admin`;
  try {
    const list = await (await fetch(`${base}/idrac/trend/servers`)).json();
    assert.equal(list.ok, true);
    assert.ok(Array.isArray(list.servers));
    assert.equal(list.retentionDays, 365);
    const sid = id || list.servers[0]?.id;
    assert.ok(sid, '등록한 서버가 목록에 있다');
    const row = list.servers.find((x) => x.id === sid);
    assert.equal(row.kind, 'baremetal'); assert.equal(row.site, SITE_OUTSIDE);
    const t = await (await fetch(`${base}/idrac/${encodeURIComponent(sid)}/trend?range=6h`)).json();
    assert.equal(t.ok, true); assert.equal(t.bucketMs, MIN);
    assert.ok(t.points.length >= 359 && t.points.length <= 361, `6시간 × 1분 ≈ 360점 (${t.points.length})`);
    assert.ok(t.points.every((p) => p.cpuPct === null && p.powerW === null), '수집 전 — 0 이 아니라 null');
    assert.equal((await fetch(`${base}/idrac/none/trend`)).status, 404);
    assert.equal((await fetch(`${base}/idrac/${encodeURIComponent(sid)}/trend?start=1&end=2`)).status, 400);
    const csv = await fetch(`${base}/idrac/trend/export.csv?scope=server&id=${encodeURIComponent(sid)}&range=1h`);
    assert.equal(csv.status, 200);
    const buf = Buffer.from(await csv.arrayBuffer());
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM');
    const lines = buf.toString('utf8').slice(1).split('\r\n');
    assert.match(lines[0], /^법인,서비스,서버,서비스태그,유형,시각,CPU 사용률\(%\)/);
    assert.match(lines[1], /,,,,$/, '결측은 빈 칸');
    assert.equal((await fetch(`${base}/idrac/trend/export.csv?scope=server&id=none`)).status, 404);
  } finally { srv.close(); }
});
