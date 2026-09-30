// v2.661 — iDRAC 통합 추이: CPU 사용률 대체(bmusage·vCenter·bmusage 이력) · 엣지 서버 전력 키 · 엑셀(차트) 내보내기.
// 사용자 신고: "CPU 온도·GPU 온도는 나오는데 CPU 사용률과 소비 전력은 안 나와" + "엑셀로 차트를 그려 내보내는 기능".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'idractrend2661-'));
process.env.CONFIG_DIR = DIR;
process.env.TEMP_DB_PATH = path.join(DIR, 'host-temp.db');
process.env.IDRAC_DB_PATH = path.join(DIR, 'idrac-power.db');
process.env.AUTH_ENABLED = 'false';
process.env.DATA_SOURCE = 'mock';

const { mergeCpuSeries, powerKeyOf, uniqueSheetName, cpuSourceText, XLSX_SERVER_MAX } = await import('../src/routes/admin/idracTrend.js');
const { buildServerTrendRows, bmCpuOf, hostCpuFrom, TREND_METRICS, CPU_FALLBACK_METRICS } = await import('../src/idrac/serverTrendSeries.js');
const { cpuIndexOf } = await import('../src/tools/serverSensors.js');
const { chartXml, addLineCharts, colLetter, sheetRef } = await import('../src/util/xlsxChart.js');

const MIN = 60_000, HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * MIN; // 경계에서 떨어뜨린 기준 시각(v2.517 규약)

test('① CPU 대체 적재 — 텔레메트리 > bmusage(신선) > vCenter 호스트, 한 주기에 한 계열만', () => {
  const fresh = { t: NOW, temps: { 'CPU1 Temp': 55 } };
  const idx = cpuIndexOf([{ key: 'ABC1234', ts: NOW - 60_000, cpu_pct: 42.34, _freshMs: 30 * MIN }, { key: 'OLD9999', ts: NOW - 5 * HOUR, cpu_pct: 90, _freshMs: 30 * MIN }]);
  const hostCpuOf = hostCpuFrom([{ serviceTag: 'VCHOST1', cpuUsagePct: 33, connectionState: 'CONNECTED' }, { serviceTag: 'VCDOWN1', cpuUsagePct: 70, connectionState: 'DISCONNECTED' }]);
  const rows = buildServerTrendRows([
    { id: 'tel', serviceTag: 'ABC1234' },           // 텔레메트리가 있으면 대체를 쓰지 않는다
    { id: 'os', serviceTag: 'abc1234' },             // 대소문자 무시로 bmusage
    { id: 'old', serviceTag: 'OLD9999' },            // bmusage 가 오래됨 → 쓰지 않는다
    { id: 'vc', serviceTag: 'VCHOST1' },             // ESXi 호스트 CPU
    { id: 'down', serviceTag: 'VCDOWN1' },           // 연결 끊긴 호스트 값은 쓰지 않는다
  ], {
    now: NOW, detail: false, localCycle: null, cpuIndex: idx, hostCpuOf,
    latestOf: (s) => (s.id === 'tel' ? { ...fresh, cpu: 12 } : fresh),
  });
  const cpu = rows.filter((r) => [TREND_METRICS.cpuPct, ...Object.values(CPU_FALLBACK_METRICS)].includes(r.metric));
  assert.deepEqual(cpu.map((r) => [r.k, r.metric, r.v]), [
    ['tel', TREND_METRICS.cpuPct, 12],
    ['os', CPU_FALLBACK_METRICS.os, 42.3],
    ['vc', CPU_FALLBACK_METRICS.vcenter, 33],
  ]);
  assert.equal(bmCpuOf({ serviceTag: '' }, idx, NOW), null, '키가 없으면 null');
  assert.equal(bmCpuOf({ serviceTag: 'ABC1234' }, null, NOW), null, '색인이 없으면 null');
});

test('② CPU 계열 병합 — 버킷마다 우선순위 하나, 빈 버킷만 이력으로 채우고 출처를 센다', () => {
  const win = { start: NOW, end: NOW + 5 * MIN, bucketMs: MIN };
  const t = (i) => NOW + i * MIN;
  const r = mergeCpuSeries(win, {
    telemetry: [{ ts: t(0), v: 10 }],
    os: [{ ts: t(0), v: 99 }, { ts: t(1), v: 20 }],
    vcenter: [{ ts: t(2), avg: 30 }],
    history: [{ ts: t(1), v: 77 }, { ts: t(3), v: 40 }, { ts: t(4), v: 150 }], // 150 은 퍼센트가 아니다 — 버린다
  });
  assert.deepEqual(r.series.map((p) => [p.ts - NOW, p.v]), [[0, 10], [MIN, 20], [2 * MIN, 30], [3 * MIN, 40]]);
  assert.deepEqual(r.sources, { telemetry: 1, os: 1, vcenter: 1, history: 1 });
  assert.equal(cpuSourceText(r.sources), 'iDRAC 텔레메트리 1 · 베어메탈 사용률(OS·iDRAC) 1 · vCenter 호스트 1 · 베어메탈 사용률 이력 1');
  assert.equal(cpuSourceText({}), '없음');
});

test('③ 전력 키 — 중앙 등록은 id, 엣지 서버는 보고 항목의 dbKey, 없으면 법인 축 키만(추측 금지)', () => {
  assert.deepEqual(powerKeyOf({ id: 'bm-1' }), { key: 'bm-1', reason: 'local' });
  const edge = { id: '7', remote: true, collectorId: 'edge-a', name: 'Host01' };
  const entries = [{ collectorId: 'edge-b', serverId: '7', dbKey: 'rmt:other' }, { collectorId: 'edge-a', serverId: 7, dbKey: 'rmt:host01' }];
  assert.deepEqual(powerKeyOf(edge, { entries }), { key: 'rmt:host01', reason: 'edge-report' }, '다른 법인의 같은 서버 id 를 쓰지 않는다');
  assert.deepEqual(powerKeyOf(edge, { entries: [], hasSeries: (k) => k === 'rmt:edge-a:host01' }), { key: 'rmt:edge-a:host01', reason: 'collector-axis' });
  assert.deepEqual(powerKeyOf(edge, { entries: [], hasSeries: (k) => k === 'rmt:host01' }), { key: null, reason: 'no-edge-report' }, '법인 축 없는 키는 추측하지 않는다');
});

test('④ 시트 이름 — 금지 문자·31자·중복', () => {
  const used = new Set(['요약']);
  assert.equal(uniqueSheetName('a/b[c]:d*e?f', used), 'a_b_c__d_e_f');
  assert.equal(uniqueSheetName('A/B[C]:D*E?F', used), 'A_B_C__D_E_F(2)', '대소문자만 다르면 중복');
  assert.ok(uniqueSheetName('x'.repeat(60), used).length <= 31);
  assert.equal(colLetter(1), 'A'); assert.equal(colLetter(27), 'AA');
  assert.equal(sheetRef("it's"), "'it''s'");
  assert.ok(XLSX_SERVER_MAX > 0 && XLSX_SERVER_MAX <= 60);
});

test('⑤ 차트 XML — 빈 칸은 끊고, 전력은 보조 축, 스키마 순서', () => {
  const x = chartXml({ title: 'a&b', catRef: "'s'!$A$2:$A$9",
    series: [{ nameRef: "'s'!$B$1", ref: "'s'!$B$2:$B$9", color: '#3b82f6' }, { nameRef: "'s'!$C$1", ref: "'s'!$C$2:$C$9", color: 'f59e0b', axis: 'secondary' }],
    y1: { min: 0, max: 100 }, y2: { min: 0 } });
  assert.match(x, /<c:dispBlanksAs val="gap"\/>/, '결측을 0 으로 잇지 않는다');
  assert.equal((x.match(/<c:lineChart>/g) || []).length, 2, '보조 축은 별도 lineChart');
  assert.match(x, /<c:valAx><c:axId val="500400"\/>[\s\S]*?<c:axPos val="r"\/>/);
  assert.match(x, /a&amp;b/);
  assert.ok(!/<c:tickLblSkip val="AUTO"/.test(x), '정수가 아닌 tickLblSkip 금지');
  // CT_LineChart 순서: grouping → varyColors → ser* → marker → axId
  assert.match(x, /<c:grouping val="standard"\/><c:varyColors val="0"\/><c:ser>[\s\S]*<\/c:ser><c:marker val="1"\/><c:axId/);
});

test('⑥ 엑셀 파일 — 차트 파트·관계·콘텐츠 형식이 들어가고 exceljs 로 다시 읽힌다', async () => {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('요약').addRow(['x']);
  const ws = wb.addWorksheet('srv 01');
  ws.addRow(['시각', 'CPU']); for (let i = 0; i < 5; i += 1) ws.addRow([`t${i}`, i === 2 ? null : i * 10]);
  const raw = Buffer.from(await wb.xlsx.writeBuffer());
  const ref = sheetRef('srv 01');
  const out = await addLineCharts(raw, [{ sheet: 2, title: 't', catRef: `${ref}!$A$2:$A$6`, series: [{ nameRef: `${ref}!$B$1`, ref: `${ref}!$B$2:$B$6` }] }]);
  const JSZip = createRequire(createRequire(import.meta.url).resolve('exceljs'))('jszip');
  const zip = await JSZip.loadAsync(out);
  assert.ok(zip.file('xl/charts/chart1.xml') && zip.file('xl/drawings/drawing1.xml') && zip.file('xl/drawings/_rels/drawing1.xml.rels'));
  const types = await zip.file('[Content_Types].xml').async('string');
  assert.match(types, /\/xl\/charts\/chart1\.xml/); assert.match(types, /\/xl\/drawings\/drawing1\.xml/);
  const sx = await zip.file('xl/worksheets/sheet2.xml').async('string');
  const rels = await zip.file('xl/worksheets/_rels/sheet2.xml.rels').async('string');
  const rid = sx.match(/<drawing r:id="([^"]+)"\/>/)?.[1];
  assert.ok(rid && rels.includes(`Id="${rid}"`) && rels.includes('../drawings/drawing1.xml'), '시트 → 드로잉 관계');
  assert.ok(!/<drawing/.test(await zip.file('xl/worksheets/sheet1.xml').async('string')), '요약 시트에는 차트가 없다');
  const back = new ExcelJS.Workbook(); await back.xlsx.load(out);
  assert.equal(back.worksheets.length, 2);
  assert.equal(back.getWorksheet('srv 01').getRow(4).getCell(2).value, null, '결측 셀은 비어 있다');
});

test('⑦ 라우트 — 엑셀 내보내기 200·형식·파일 이름 · CSV 는 그대로 · 없는 서버 404', async () => {
  const { addServer } = await import('../src/idrac/registry.js');
  addServer({ id: 'bm-x', name: 'bm-x', host: '10.0.0.9', username: 'root', password: 'x' });
  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express(); app.use(express.json()); app.use('/api/admin', adminRouter);
  const srv = app.listen(0); await new Promise((ok) => srv.once('listening', ok));
  const base = `http://127.0.0.1:${srv.address().port}/api/admin`;
  try {
    const x = await fetch(`${base}/idrac/trend/export.xlsx?scope=server&id=bm-x&range=6h`);
    assert.equal(x.status, 200);
    assert.match(x.headers.get('content-type'), /spreadsheetml\.sheet/);
    assert.match(x.headers.get('content-disposition'), /filename="idrac-trend_6h_\d{8}-\d{4,6}\.xlsx"/);
    const buf = Buffer.from(await x.arrayBuffer());
    assert.deepEqual([...buf.subarray(0, 2)], [0x50, 0x4b], 'zip');
    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ['요약', 'bm-x']);
    assert.equal(wb.getWorksheet('bm-x').getRow(1).getCell(2).value, 'CPU 사용률(%)');
    const t = await (await fetch(`${base}/idrac/bm-x/trend?range=1h`)).json();
    assert.deepEqual(t.cpuSources, { telemetry: 0, os: 0, vcenter: 0, history: 0 });
    assert.deepEqual(t.power, { found: true, reason: 'local' });
    assert.equal((await fetch(`${base}/idrac/trend/export.xlsx?scope=server&id=none`)).status, 404);
    assert.equal((await fetch(`${base}/idrac/trend/export.xlsx?scope=server&id=bm-x&cols=zz`)).status, 400);
    assert.equal((await fetch(`${base}/idrac/trend/export.csv?scope=server&id=bm-x&range=1h`)).status, 200);
  } finally { srv.close(); }
});

test('⑧ 흡기·배기 — 전용 계열(dead-band 온도 정책), 상세 모드 계열과 이름이 다르다', async () => {
  const { trendValuesOf, TREND_METRICS: M } = await import('../src/idrac/serverTrendSeries.js');
  const { policyKeyFor } = await import('../src/metrics/deadband.js');
  const v = trendValuesOf({ t: NOW, temps: { 'System Board Inlet Temp': 22, 'System Board Exhaust Temp': 35, 'CPU1 Temp': 50 } });
  assert.equal(v.inletTemp, 22); assert.equal(v.exhaustTemp, 35);
  assert.equal(M.inletTemp, 'idractrend_inlet'); assert.equal(M.exhaustTemp, 'idractrend_exhaust');
  assert.equal(policyKeyFor('idractrend_inlet'), 'temp'); assert.equal(policyKeyFor('idractrend_exhaust'), 'temp');
  assert.equal(policyKeyFor('idractemp_inlet'), null, '상세 모드 계열은 예전대로 전량 저장');
  const rows = buildServerTrendRows([{ id: 'a' }], { now: NOW, detail: false, localCycle: null, latestOf: () => ({ t: NOW, temps: { 'System Board Inlet Temp': 22 } }) });
  assert.deepEqual(rows.map((r) => [r.metric, r.v]), [['idractrend_inlet', 22]]);
  const off = buildServerTrendRows([{ id: 'a' }], { now: NOW, detail: false, localCycle: null, airflow: false, latestOf: () => ({ t: NOW, temps: { 'System Board Inlet Temp': 22 } }) });
  assert.equal(off.length, 0, 'IDRAC_TREND_AIRFLOW=false');
});

test('⑨ v2.662 선 모양 — 쿼리는 허용 목록으로 거르고, 차트 XML 은 prstDash·굵기·점을 싣는다', async () => {
  const { parseExportStyles } = await import('../src/routes/admin/idracTrend.js');
  assert.deepEqual(parseExportStyles('inletTemp:dot:3:1,cpuPct:solid:9:0,zz:dash:2:0,gpuTemp:"x":2:0'),
    { inletTemp: { dash: 'dot', width: 3, marker: true }, cpuPct: { dash: 'solid', width: 2, marker: false } }, '모르는 계열·모양은 버리고 굵기 범위 밖은 2');
  assert.deepEqual(parseExportStyles(''), {});
  const x = chartXml({ title: 't', catRef: "'s'!$A$2:$A$9", series: [
    { nameRef: "'s'!$B$1", ref: "'s'!$B$2:$B$9", color: '06b6d4', dash: 'dash', width: 3, marker: true },
    { nameRef: "'s'!$C$1", ref: "'s'!$C$2:$C$9", color: 'ef4444', dash: '<evil>' },
  ] });
  assert.match(x, /<a:ln w="28575" cap="flat"><a:solidFill><a:srgbClr val="06b6d4"\/><\/a:solidFill><a:prstDash val="dash"\/><a:round\/><\/a:ln>/);
  assert.match(x, /<c:symbol val="circle"\/>/);
  assert.match(x, /<a:ln w="19050" cap="rnd"><a:solidFill><a:srgbClr val="ef4444"\/><\/a:solidFill><a:round\/><\/a:ln>/, '모르는 모양은 실선');
  assert.doesNotMatch(x, /evil/);
});

test('⑩ v2.663 서버 표 — 기간 검사 · CPU 계열 합치기 · 창 밖 현재값은 null · 전력 키 · 값 없음은 null', async () => {
  const { tableHoursOf, mergeStats, buildTableRows } = await import('../src/routes/admin/idracTrend.js');
  assert.equal(tableHoursOf(undefined), 24); assert.equal(tableHoursOf('6'), 6);
  for (const bad of ['0', '721', '1.5', 'x']) assert.equal(tableHoursOf(bad), null, bad);
  assert.deepEqual(mergeStats([{ avg: 10, min: 5, max: 20, n: 2 }, undefined, { avg: 40, min: 30, max: 90, n: 1 }]), { avg: 20, min: 5, max: 90, n: 3 });
  assert.equal(mergeStats([undefined, null]), null);
  const since = NOW - 6 * HOUR;
  const rows = buildTableRows([{ id: 'a' }, { id: 'b' }], {
    stats: { cpuPct: [new Map([['a', { avg: 50, min: 10, max: 95, n: 6 }]])], cpuTemp: new Map([['a', { avg: 60, min: 40, max: 81, n: 6 }]]), gpuTemp: new Map(), inletTemp: new Map(), exhaustTemp: new Map() },
    latest: { cpuTemp: [new Map([['a', { v: 55.26, ts: NOW }]])], cpuPct: [new Map([['a', { v: 70, ts: since - 1 }]])] },
    power: new Map([['a', { avg: 300, min: 200, peak: 500, count: 6 }]]), powerKeyFor: (r) => r.id, since,
  });
  assert.deepEqual(rows[0].cpuTemp, { avg: 60, min: 40, max: 81, n: 6, cur: 55.3 });
  assert.equal(rows[0].cpuPct.cur, null, '창 밖 최신값을 현재라 하지 않는다');
  assert.deepEqual(rows[0].powerW, { avg: 300, min: 200, max: 500, n: 6, cur: null });
  assert.equal(rows[1].cpuTemp, null); assert.equal(rows[1].powerW, null, '값 없음은 0 이 아니라 null');
});

test('⑪ v2.663 라우트 — /idrac/trend/table 200·행 · 잘못된 기간 400 · :id 라우트가 table 을 먹지 않는다', async () => {
  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express(); app.use(express.json()); app.use('/api/admin', adminRouter);
  const srv = app.listen(0); await new Promise((ok) => srv.once('listening', ok));
  const base = `http://127.0.0.1:${srv.address().port}/api/admin`;
  try {
    const r = await fetch(`${base}/idrac/trend/table?hours=6&corp=*&site=*`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.hours, 6); assert.ok(Array.isArray(j.rows)); assert.equal(j.total, j.rows.length);
    for (const row of j.rows) for (const k of ['cpuPct', 'cpuTemp', 'gpuTemp', 'inletTemp', 'exhaustTemp', 'powerW']) assert.ok(k in row, k);
    assert.equal((await fetch(`${base}/idrac/trend/table?hours=0`)).status, 400);
  } finally { srv.close(); }
});

test('⑫ v2.663 CPU 대체 — 태그가 인벤토리에만 있는 엣지 서버도 호스트를 찾고, 못 쓰는 사유를 코드로 준다', async () => {
  const { serviceTagOf, hostCpuFrom, cpuFallbackDiag } = await import('../src/idrac/serverTrendSeries.js');
  const edge = { id: 'e1', remote: true, serviceTag: '', inv: { system: { serviceTag: '6W4JNY3' } } };
  assert.equal(serviceTagOf(edge), '6W4JNY3', '최상위가 비면 인벤토리 태그');
  const hosts = [{ name: 'esx4', vcenterId: 'vc1', serviceTag: '6w4jny3', connectionState: 'CONNECTED', cpuUsagePct: 41 }];
  assert.equal(hostCpuFrom(hosts)(edge), 41, '예전엔 최상위 태그만 봐서 null 이었다');
  assert.equal(cpuFallbackDiag(edge, { hosts }).code, 'ok');
  assert.equal(cpuFallbackDiag(edge, { hosts }).source, 'vcenter');
  assert.equal(cpuFallbackDiag({ id: 'x', remote: true }, { hosts }).code, 'no-tag');
  assert.equal(cpuFallbackDiag({ id: 'x', serviceTag: 'ZZZ' }, { hosts }).code, 'no-host');
  const d = cpuFallbackDiag(edge, { hosts, unread: new Map([['vc1', 'stale']]) });
  assert.deepEqual([d.code, d.reason, d.host.name], ['vcenter-unread', 'stale', 'esx4']);
  assert.equal(cpuFallbackDiag(edge, { hosts: [{ ...hosts[0], connectionState: 'NOT_RESPONDING' }] }).code, 'host-disconnected');
  assert.equal(cpuFallbackDiag(edge, { hosts: [{ ...hosts[0], cpuUsagePct: null }] }).code, 'no-host-cpu');
  assert.equal(cpuFallbackDiag(edge, { hosts, latest: { at: Date.now(), cpu: 12 } }).source, 'telemetry');
});
