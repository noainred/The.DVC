// v2.966 서버 하드웨어 정보 내보내기(승인 시안 docs/design/baremetal-hw-xlsx · 사용자 기본안 7가지 2026-11-11).
//   카탈로그(값 선택 · 관리자 전용) · 행 → 인벤토리 찾기 · 대상(물리/가상화/둘 다) · 법인 · 못 읽은 값은 빈 칸 · 엑셀(띠 · 법인별 시트 · 상세 · 사양서 · 목차 링크)
//   · CSV/ZIP · 사양서 파일 나눔 · 라우트 게이트(전체 범위 · data.csv · 동시 1건).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ExcelJS from 'exceljs';
import { HW_GROUPS, HW_FIELDS, LOCKED_KEYS, BASIC_KEYS, resolveFields, catalogForClient } from '../src/insights/hwExport/catalog.js';
import { makeInvOf, selectServers, buildHwModel, UNASSIGNED } from '../src/insights/hwExport/rows.js';
import { renderHwExport, csvTables, specSplitPlan, subsetModel, buildHwWorkbookPayload, hwExportLastRenderMode, _setHwExportWorkerUrlForTest } from '../src/insights/hwExport/render.js';
import { sheetNameOf, SUMMARY_SHEET, TOC_SHEET } from '../src/insights/hwExport/xlsx.js';
import { hwExportOpts, hwCorpRoster, hwExportFileBase } from '../src/routes/insights.js';
import { _resetExportBusy } from '../src/util/exportBusy.js';
import { internalLinkState } from '../src/util/xlsxInternalLink.js';
import { stripComments } from './_stripComments.js';

/* ── 가짜 데이터 ─────────────────────────────────────────────────────── */
const fullInv = (tag, extra = {}) => ({
  collectedAt: Date.UTC(2026, 10, 11, 1, 2),
  system: { hostName: `${tag.toLowerCase()}.corp.example`, model: 'PowerEdge R750', manufacturer: 'Dell Inc.', serviceTag: tag, serialNumber: 'SECRET-SN', uuid: 'uuid-1', assetTag: '', biosVersion: '1.12.1', powerState: 'On', health: 'OK' },
  cpu: { count: 2, cores: 64, threads: 128, model: 'Xeon Gold 6338' },
  memory: { totalGiB: 512 },
  cpus: [{ socket: 'CPU.Socket.1', model: 'Xeon Gold 6338', cores: 32, threads: 64 }, { socket: 'CPU.Socket.2', model: 'Xeon Gold 6338', cores: 32, threads: 64 }],
  memoryDimms: [{ locator: 'A1', sizeGB: 32, type: 'DDR4', speedMHz: 3200, manufacturer: 'Hynix', partNumber: 'HMA84', serial: 'DIMM-SN' }],
  disks: [{ name: 'Disk 0', model: 'SSD960', capacityGB: 960, media: 'SSD', protocol: 'SATA', serial: 'DSK-SN' }, { name: 'Disk 1', model: 'SSD960', capacityGB: null, media: 'SSD', protocol: 'SATA' }],
  nics: [{ name: 'NIC.Integrated.1', model: 'Broadcom 25G', firmware: '22.31.6', ports: [{ id: '1', link: 'Up', speedMbps: 25000, mac: '00:00:5E:00:53:10' }, { id: '2', link: 'Down', speedMbps: 0, mac: '00:00:5E:00:53:11' }] }],
  firmware: [{ type: 'BIOS', name: 'BIOS', version: '1.12.1' }, { type: 'iDRAC', name: 'iDRAC', version: '7.00.00.171' }],
  idrac: { firmwareVersion: '7.00.00.171', model: '15G' },
  network: [{ name: 'NIC.1', mac: 'AA:BB', hostName: 'idrac-x', fqdn: 'idrac-x.mgmt', ipv4: '192.0.2.21' }],
  idracUsers: [{ userName: 'root', role: 'Administrator' }],
  events: [{ severity: 'Critical', message: 'secret event' }],
  bios: { version: '1.12.1', attributes: { BootMode: 'Uefi', ProcVirtualization: 'Enabled' } },
  psus: [{ name: 'PS1', capacityWatts: 1400, firmware: '00.1D' }],
  health: { overall: 'OK', processor: 'OK' },
  collections: { gpus: 'ok', pcie: 'failed' },
  ...extra,
});
const INV = { 'reg-1': fullInv('TAG1'), 'reg-2': fullInv('TAG2'), 'reg-host': fullInv('HOSTTAG') };
const getInventory = (id) => INV[id] || null;
const registry = [{ id: 'reg-1', serviceTag: 'TAG1' }, { id: 'reg-2', serviceTag: 'TAG2' }, { id: 'reg-host', serviceTag: 'HOSTTAG' }, { id: 'ome-x', type: 'ome', serviceTag: 'OMETAG' }];
const remoteServers = [{ id: 'e1', collectorId: 'pl', serviceTag: 'EDGE1', inv: { system: { model: 'R640', hostName: '' }, cpu: { count: 2, cores: 32 }, memory: { totalGiB: 192 }, disks: [] } }];
const fleet = {
  bareMetal: [
    { serverId: 'reg-1', name: 'bm-db-01', serviceTag: 'TAG1', source: 'idrac', vcenterId: 'vc-b', vcenter: 'vcenter-b' },
    { serverId: 'remote:pl:e1', name: 'bm-edge-01', serviceTag: 'EDGE1', source: 'remote', vcenterId: 'vc-a', vcenter: 'vcenter-a' },
    { serverId: 'ome:1', name: 'bm-nas-01', serviceTag: 'NOTFOUND', source: 'ome', vcenterId: 'vc-a', vcenter: 'vcenter-a' },
    { serverId: 'reg-2', name: '10.0.0.5', serviceTag: 'TAG2', source: 'idrac', vcenterId: '', vcenter: '' },
  ],
  virtualizationHosts: [
    { name: 'esx-01', vcenterId: 'vc-a', vcenter: 'vcenter-a', serviceTag: 'HOSTTAG', idracBacked: true, idracServerId: 'reg-host', cpuCores: 48, memGB: 384 },
    { name: 'esx-02', vcenterId: 'vc-b', vcenter: 'vcenter-b', serviceTag: 'VCONLY', idracBacked: false, idracServerId: '', cpuCores: 24, memGB: 256 },
  ],
};
const invOf = makeInvOf({ getInventory, registry, remoteServers });
const allKeys = [...HW_FIELDS.keys()];

/* ── 카탈로그 ───────────────────────────────────────────────────────── */
test('카탈로그 — key 는 겹치지 않고, 잠긴 값 5개 · 기본 묶음 · 넣지 않는 것(시리얼 · iDRAC 계정 · 이벤트)', () => {
  assert.equal(new Set(allKeys).size, allKeys.length);
  assert.equal(HW_GROUPS.length, 13);
  assert.deepEqual(LOCKED_KEYS, ['id.sum.corp', 'id.sum.kind', 'id.sum.name', 'id.sum.hostName', 'id.sum.serviceTag']);
  for (const k of LOCKED_KEYS) assert.ok(BASIC_KEYS.includes(k));
  assert.ok(BASIC_KEYS.includes('cpu.sum.cores') && BASIC_KEYS.includes('mem.sum.gib') && BASIC_KEYS.includes('disk.sum.gb'));
  const src = stripComments(fs.readFileSync(new URL('../src/insights/hwExport/catalog.js', import.meta.url), 'utf8'));
  for (const bad of ['serial', 'idracUsers', 'events', 'userName']) assert.ok(!src.includes(bad), `카탈로그가 ${bad} 를 읽지 않는다`);
});

test('resolveFields — 모르는 key · 관리자 전용 값은 버리고, 잠긴 값은 늘 넣고, 카탈로그 순서로', () => {
  const r = resolveFields(['nic.det.mac', 'zzz.sum.x', 'mem.sum.gib', 'id.sum.uuid'], { admin: false });
  assert.ok(!r.includes('nic.det.mac') && !r.includes('id.sum.uuid') && !r.includes('zzz.sum.x'));
  assert.deepEqual(r, [...LOCKED_KEYS, 'mem.sum.gib']);
  assert.ok(resolveFields('nic.det.mac,id.sum.uuid', { admin: true }).includes('nic.det.mac'));
  const cli = catalogForClient({ admin: false });
  assert.ok(!JSON.stringify(cli).includes('nic.det.mac'), '비관리자 창에는 MAC 칩이 없다');
  assert.ok(!cli.find((g) => g.key === 'mgmt').det.length, 'iDRAC 관리 상세는 전부 관리자 전용');
  assert.ok(JSON.stringify(catalogForClient({ admin: true })).includes('nic.det.mac'));
});

/* ── 인벤토리 찾기 · 대상 ────────────────────────────────────────────── */
test('makeInvOf — 로컬 id → remote:<수집>:<id> → 등록부 태그 → 원격 태그, OME 등록 항목은 쓰지 않는다', () => {
  assert.equal(invOf({ serverId: 'reg-1' }).via, 'local');
  assert.equal(invOf({ serverId: 'remote:pl:e1' }).via, 'remote');
  assert.equal(invOf({ serverId: 'x', serviceTag: 'tag2' }).inv, INV['reg-2'], '태그는 대소문자 무시');
  assert.equal(invOf({ serverId: 'x', serviceTag: 'EDGE1' }).via, 'remote');
  assert.equal(invOf({ serverId: 'x', serviceTag: 'OMETAG' }).inv, null);
  assert.equal(invOf({ idracServerId: 'reg-host', serverId: '' }).via, 'local', '가상화 호스트는 idracServerId');
});

test('selectServers — 물리/가상화/둘 다 · 법인(미지정 포함) · 인벤토리 없음도 한 줄 · 가상화 받침 없음은 vCenter 값', () => {
  assert.equal(selectServers(fleet, { kind: 'bm', invOf }).length, 4);
  assert.equal(selectServers(fleet, { kind: 'vh', invOf }).length, 2);
  const both = selectServers(fleet, { kind: 'both', invOf });
  assert.equal(both.length, 6);
  assert.deepEqual(both.map((c) => c.corpName), ['vcenter-a', 'vcenter-a', 'vcenter-a', 'vcenter-b', 'vcenter-b', '미지정'], '법인 이름 순 · 미지정은 맨 뒤');
  assert.deepEqual(both.slice(0, 3).map((c) => c.kind), ['bm', 'bm', 'vh'], '같은 법인 안에서는 물리 먼저');
  const nas = both.find((c) => c.name === 'bm-nas-01');
  assert.equal(nas.inv, null);
  assert.match(nas.note, /^인벤토리 없음 — OME/);
  const esx2 = both.find((c) => c.name === 'esx-02');
  assert.equal(esx2.inv, null, '받침 없는 가상화 호스트는 태그로도 찾지 않는다(idracBacked 판정 그대로)');
  assert.equal(HW_FIELDS.get('cpu.sum.cores').get(esx2), 24);
  assert.equal(HW_FIELDS.get('mem.sum.gib').get(esx2), 256);
  assert.equal(selectServers(fleet, { kind: 'both', corps: new Set([UNASSIGNED]), invOf }).length, 1);
  assert.equal(selectServers(fleet, { kind: 'both', corps: new Set([]), invOf }).length, 0);
  const edge = both.find((c) => c.name === 'bm-edge-01');
  assert.match(edge.note, /Hostname 미보고/);
  assert.match(edge.note, /엣지 축약 인벤토리/);
});

test('비관리자 — 주소로 등록된 서버 이름 · Hostname 은 가린다(matcher 는 라우트가 준다)', () => {
  const match = (v) => v === '10.0.0.5';
  const r = selectServers(fleet, { kind: 'bm', invOf, match });
  assert.ok(r.some((c) => c.name === '(주소 가림)'));
  assert.ok(!r.some((c) => c.name === '10.0.0.5'));
});

/* ── 모델 ───────────────────────────────────────────────────────────── */
test('buildHwModel — 못 읽은 값은 null(0 아님) · 합계는 읽은 것만 · 상세는 부품 한 개 = 한 줄 · 법인 소계', () => {
  const servers = selectServers(fleet, { kind: 'both', invOf });
  const m = buildHwModel(servers, allKeys, { admin: true });
  const col = (k) => m.summary.cols.findIndex((c) => c.key === k);
  const nas = m.summary.rows.find((r) => r.cells[col('id.sum.name')] === 'bm-nas-01');
  assert.equal(nas.cells[col('cpu.sum.cores')], null);
  assert.equal(nas.cells[col('disk.sum.count')], null, '인벤토리가 없으면 디스크 수도 빈 칸(0 이 아니다)');
  const db = m.summary.rows.find((r) => r.cells[col('id.sum.name')] === 'bm-db-01');
  assert.equal(db.cells[col('disk.sum.gb')], 960, '용량을 못 읽은 디스크는 합에서 빠진다');
  assert.equal(db.cells[col('disk.sum.count')], 2);
  assert.equal(db.cells[col('nic.sum.maxGbps')], 25);
  const edge = m.summary.rows.find((r) => r.cells[col('id.sum.name')] === 'bm-edge-01');
  assert.equal(edge.cells[col('disk.sum.count')], 0, '빈 배열을 받았으면 0(읽었고 없음)');
  const nic = m.details.find((d) => d.key === 'nic');
  assert.ok(nic.rows.some((r) => r.cells.includes('00:00:5E:00:53:10')));
  const down = nic.rows.find((r) => r.cells.includes('Down'));
  assert.equal(down.cells[down.cells.length - 2], null, '속도 0 은 못 읽음(빈 칸)');
  const a = m.corps.find((c) => c.name === 'vcenter-a');
  assert.deepEqual([a.count, a.bm, a.vh, a.cores, a.memGiB], [3, 2, 1, 32 + 64, 192 + 512]);
  assert.equal(m.totals.noInventory, 2);
  const noAdmin = buildHwModel(servers, resolveFields(allKeys, { admin: false }), { admin: false, spec: true });
  assert.ok(!JSON.stringify(noAdmin).includes('00:00:5E:00:53:10'), '비관리자 모델에 MAC 이 없다');
  assert.ok(!JSON.stringify(noAdmin).includes('192.0.2.21'), '비관리자 사양서에 iDRAC 주소가 없다');
  assert.ok(!JSON.stringify(buildHwModel(servers, allKeys, { admin: true, spec: true })).match(/SECRET-SN|DIMM-SN|DSK-SN|secret event/), '시리얼 · 이벤트는 관리자에게도 없다');
});

/* ── 엑셀 ───────────────────────────────────────────────────────────── */
async function load(buf) { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb; }
const servers6 = () => selectServers(fleet, { kind: 'both', invOf });

test('엑셀(띠) — 서버 요약 · 상세 · 안내, 띠 줄 있음 · 자동 필터 없음 · 빈 칸은 빈 칸', async () => {
  const m = buildHwModel(servers6(), BASIC_KEYS.concat(['nic.det.port', 'nic.det.speedMbps', 'fw.det.version']), { admin: true });
  const { buffer } = await buildHwWorkbookPayload({ model: m, meta: { basis: 'x', kindText: 'y', band: 'band', admin: true } });
  const wb = await load(buffer);
  assert.deepEqual(wb.worksheets.map((w) => w.name), [SUMMARY_SHEET, 'NIC', '펌웨어', '안내']);
  const ws = wb.getWorksheet(SUMMARY_SHEET);
  const texts = []; ws.eachRow((r) => texts.push(String(r.getCell(1).value ?? '')));
  assert.equal(texts.filter((t) => t.startsWith('법인 ')).length, 3, '법인 3곳(미지정 포함)마다 띠');
  assert.ok(!ws.autoFilter, '띠 판본은 자동 필터가 없다');
  let nasRow = null; ws.eachRow((r) => { if (r.getCell(3).value === 'bm-nas-01') nasRow = r; });
  const coreCol = m.summary.cols.findIndex((c) => c.key === 'cpu.sum.cores') + 1;
  assert.equal(nasRow.getCell(coreCol).value, null);
});

test('엑셀(법인 열만 · 법인마다 시트) — 필터 · 시트 나눔', async () => {
  const m = buildHwModel(servers6(), BASIC_KEYS, { admin: true });
  const col = await load((await buildHwWorkbookPayload({ model: m, meta: { basis: '', kindText: '', band: 'col', admin: true } })).buffer);
  assert.ok(col.getWorksheet(SUMMARY_SHEET).autoFilter);
  const per = await load((await buildHwWorkbookPayload({ model: m, meta: { basis: '', kindText: '', band: 'sheet', admin: true } })).buffer);
  assert.deepEqual(per.worksheets.map((w) => w.name), ['요약 vcenter-a', '요약 vcenter-b', '요약 미지정', '안내']);
});

test('엑셀 사양서 — 서버마다 한 장 + 목차, 목차 링크가 가리키는 시트가 실제로 있다', async () => {
  const m = buildHwModel(servers6(), BASIC_KEYS, { admin: true, spec: true });
  const buf = (await buildHwWorkbookPayload({ model: m, meta: { basis: '', kindText: '', band: 'band', admin: true } })).buffer;
  const wb = await load(buf);
  const names = new Set(wb.worksheets.map((w) => w.name));
  assert.equal(wb.worksheets.length, 1 + 1 + 1 + 6, '요약 · 안내 · 목차 · 사양서 6');
  // 시트 안 링크는 읽어 들일 때 exceljs 가 값으로 되살리지 않는다(관계 없는 location — util/xlsxInternalLink.js) — 파일 XML 을 직접 본다.
  assert.equal(internalLinkState(), 'patched');
  const zip = await (await import('jszip')).default.loadAsync(buf);
  const tocIdx = wb.worksheets.findIndex((w) => w.name === TOC_SHEET) + 1;
  const tocXml = await zip.file(`xl/worksheets/sheet${tocIdx}.xml`).async('string');
  const targets = [...tocXml.matchAll(/<hyperlink ref="C\d+" location="&apos;(.+?)&apos;!A1"\/>/g)].map((x) => x[1].replace(/&apos;&apos;/g, "'"));
  assert.equal(targets.length, 6);
  for (const t of targets) assert.ok(names.has(t), `목차 링크 → ${t}`);
  const specXml = await zip.file(`xl/worksheets/sheet${tocIdx + 1}.xml`).async('string');
  assert.match(specXml, /location="&apos;목차&apos;!A1"/, '사양서 → 목차');
  const spec = wb.getWorksheet('bm-db-01');
  const all = []; spec.eachRow((r) => r.eachCell((c) => all.push(String(c.value?.text ?? c.value ?? ''))));
  for (const s of ['기본 식별', 'CPU', '메모리', '디스크', '네트워크 인터페이스', '펌웨어', 'BIOS · 부팅 설정', 'iDRAC 관리', '192.0.2.21']) assert.ok(all.includes(s), `사양서에 ${s}`);
  assert.ok(all.includes('읽지 못함'), 'PCIe 컬렉션 실패는 ‘읽지 못함’');
  assert.ok(all.includes('없음'), 'GPU 0장(읽었음)은 ‘없음’');
});

test('시트 이름 — 금지 문자 · 31자 · 대소문자 무시 겹침 ~2', () => {
  const taken = new Set([SUMMARY_SHEET.toLowerCase()]);
  assert.equal(sheetNameOf('a/b:c*d?[e]', taken), 'a_b_c_d__e_');
  assert.equal(sheetNameOf('서버 요약', taken), '서버 요약~2');
  const long = 'x'.repeat(40);
  assert.equal(sheetNameOf(long, taken).length, 31);
  assert.equal(sheetNameOf(long.toUpperCase(), taken), `${'X'.repeat(29)}~2`);
});

test('워커 경로와 인라인 경로가 둘 다 파일을 만든다', async () => {
  const m = buildHwModel(servers6(), BASIC_KEYS, { admin: true });
  const meta = { basis: '', kindText: '', band: 'band', admin: true };
  const out = await renderHwExport(m, { format: 'xlsx', baseName: 'b', meta });
  assert.equal(out.ext, 'xlsx');
  assert.equal(hwExportLastRenderMode(), 'worker');
  assert.equal((await load(out.buffer)).worksheets[0].name, SUMMARY_SHEET);
  _setHwExportWorkerUrlForTest(new URL('./no-such-worker.js', import.meta.url));
  try {
    const out2 = await renderHwExport(m, { format: 'xlsx', baseName: 'b', meta });
    assert.equal(hwExportLastRenderMode(), 'inline', '워커를 못 띄우면 메인에서 만든다');
    assert.equal((await load(out2.buffer)).worksheets[0].name, SUMMARY_SHEET);
  } finally { _setHwExportWorkerUrlForTest(null); }
});

/* ── CSV · ZIP · 나눔 ───────────────────────────────────────────────── */
test('CSV — 표 하나면 csv, 둘 이상이면 zip · 수식 주입 가드 · 빈 칸', async () => {
  const s = servers6();
  s[0].name = '=HYPERLINK("x")';
  const m1 = buildHwModel(s, BASIC_KEYS, { admin: true });
  const one = await renderHwExport(m1, { format: 'csv', baseName: 'b', meta: { band: 'band' } });
  assert.equal(one.ext, 'csv');
  const text = one.buffer.toString('utf8');
  assert.ok(text.startsWith('﻿'));
  assert.ok(text.includes(`"'=HYPERLINK(""x"")"`), '수식으로 시작하는 칸은 따옴표 + 작은따옴표');
  assert.ok(!/법인 vcenter/.test(text), 'CSV 에는 띠가 없다');
  const m2 = buildHwModel(s, BASIC_KEYS.concat(['nic.det.port']), { admin: true });
  const z = await renderHwExport(m2, { format: 'csv', baseName: 'b', meta: { band: 'sheet' } });
  assert.equal(z.ext, 'zip');
  assert.deepEqual(csvTables(m2, 'sheet').map((t) => t.name), ['servers_vcenter-a.csv', 'servers_vcenter-b.csv', 'servers_미지정.csv', 'nic.csv']);
});

test('사양서 파일 나눔 — 상한을 넘으면 법인마다(넘치는 법인은 쪼개서) · 빠지는 서버 없음 · 상세도 같이 자른다', () => {
  const m = buildHwModel(servers6(), BASIC_KEYS.concat(['cpu.det.socket']), { admin: true, spec: true });
  assert.equal(specSplitPlan(m, 10), null);
  const plan = specSplitPlan(m, 2);
  assert.deepEqual(plan.map((p) => p.label), ['vcenter-a-1', 'vcenter-a-2', 'vcenter-b', '미지정']);
  assert.equal(plan.reduce((a, p) => a + p.idxs.length, 0), 6);
  const sub = subsetModel(m, plan[2].idxs);
  assert.equal(sub.summary.rows.length, 2);
  assert.equal(sub.specs.length, 2);
  assert.ok(sub.details[0].rows.every((r) => r.corpId === 'vc-b'));
  assert.equal(sub.totals.servers, 2);
});

/* ── 라우트 ─────────────────────────────────────────────────────────── */
test('hwExportOpts — 기본값 · 사양서는 엑셀만 · 모르는 법인 id 는 버리고 남는 게 없으면 거부', () => {
  const d = hwExportOpts({}, { corpIds: ['vc-a'] });
  assert.deepEqual([d.format, d.kind, d.band, d.spec, d.corps], ['xlsx', 'bm', 'band', false, null]);
  assert.deepEqual(d.fields, BASIC_KEYS);
  assert.equal(hwExportOpts({ format: 'csv', spec: '1' }, {}).spec, false);
  assert.equal(hwExportOpts({ format: 'xlsx', spec: '1' }, {}).spec, true);
  assert.equal(hwExportOpts({ corps: 'zzz' }, { corpIds: ['vc-a'] }).ok, false);
  assert.deepEqual([...hwExportOpts({ corps: 'vc-a,zzz' }, { corpIds: ['vc-a'] }).corps], ['vc-a']);
  assert.ok(!hwExportOpts({ fields: 'nic.det.mac' }, { admin: false }).fields.includes('nic.det.mac'));
});

test('법인 목록 · 파일 이름', () => {
  const roster = hwCorpRoster({ vcenters: [{ id: 'vc-a', name: 'vcenter-a' }, { id: 'vc-b', name: 'vcenter-b' }, { id: 'vc-c', name: 'vcenter-c' }] }, fleet);
  assert.deepEqual(roster.map((c) => [c.id, c.bm, c.vh]), [['vc-a', 2, 1], ['vc-b', 1, 1], ['vc-c', 0, 0], [UNASSIGNED, 1, 0]]);
  assert.equal(hwExportFileBase({ kind: 'both', corps: null, roster, stamp: '20261111-1030' }), 'server-hardware_all-servers_all_20261111-1030');
  assert.equal(hwExportFileBase({ kind: 'bm', corps: new Set([UNASSIGNED]), roster, stamp: 's' }), 'server-hardware_baremetal_unassigned_s');
  assert.equal(hwExportFileBase({ kind: 'vh', corps: new Set(['vc-a', 'vc-b']), roster, stamp: 's' }), 'server-hardware_esxi-hosts_2corps_s');
});

test('라우트 게이트 — 세 라우트 모두 data.csv + 전체 범위 · 내려받기는 동시 1건 · 저장은 역할 게이트가 먼저', () => {
  _resetExportBusy();
  const src = stripComments(fs.readFileSync(new URL('../src/routes/insights.js', import.meta.url), 'utf8'));
  assert.match(src, /insightsRouter\.get\('\/fleet\/hardware-meta', hwCsvPerm, hwFullScopeOnly,/);
  assert.match(src, /insightsRouter\.put\('\/fleet\/hardware-prefs', requireRole\('admin', 'operator'\), hwCsvPerm, hwFullScopeOnly,/);
  assert.match(src, /insightsRouter\.get\('\/fleet\/hardware-export', hwCsvPerm, hwFullScopeOnly,/);
  assert.match(src, /const hwCsvPerm = requirePerm\('data\.csv'\)/);
  const body = src.slice(src.indexOf("'/fleet/hardware-export'"), src.indexOf("'/fleet/tag'"));
  assert.match(body, /acquireExport\('fleet\.hardware\.export', req\)/);
  assert.match(body, /finally \{[\s\S]*lock\.release\(\)/);
  assert.match(body, /match: admin \? null : insightsMatcher\(snap\)/, '비관리자는 주소 가림');
  assert.match(body, /hwExportOpts\(req\.query \|\| \{\}, \{ admin,/, '관리자 전용 값은 관리자 판본 판정으로');
});
