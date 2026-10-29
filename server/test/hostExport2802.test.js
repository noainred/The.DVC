/**
 * v2.802 — vCenter 화면 '호스트 · 클러스터 엑셀'(호스트 1대 = 시트 1장 · 승인 시안 https://claude.ai/artifact/HKxFuVeie66ddR2i8VxmFX).
 *  ① 시트 이름 — 31자 · 금지 글자 · 예약 이름 · 대소문자 무시 중복
 *  ② 내용(buildHostExport) — 못 읽은 값은 0 이 아니다 · 템플릿은 셈에서 뺀다 · 판정은 구성 점검 함수 그대로(드리프트 행 포함) · 업링크 끊김 · 클러스터 고르기(ref 묶음)
 *  ③ 권한으로 뺀 묶음은 사유와 함께(구성 점검 · 클러스터 점검 · 관리자 판본) — 조용히 빼지 않는다
 *  ④ iDRAC 맞추기(서비스 태그 · 등록 안 됨 null · 인벤토리 없음 undefined) · 부품 판정은 inventoryView 그대로
 *  ⑤ 워크북 — 시트 순서 · 시트 안 링크는 location 만(외부 관계 없음) · 요소 순서 · 수식 칸 없음 · '—' · 워커 경로
 *  ⑥ 서버 글자(hostcfg/text.js)와 웹 글자(hostCfgText.js)가 같은 말을 한다 · 묶음 키 · 시트 이름 대조
 *  ⑦ 실제 라우트 — data.csv 게이트 · 범위 밖 404 · 묶음 권한 · 400 · 상한 · 409 · 감사 한 줄
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hostexport2802-'));
Object.assign(process.env, { CONFIG_DIR: DIR, DATA_SOURCE: 'live', AUTH_ENABLED: 'true' });
const VC = 'vc-a'; const OUT = 'vc-out';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: VC, name: 'vc-a', host: 'vca.corp.local', username: 'u', password: 'p', collectMode: 'site' },
  { id: OUT, name: 'vc-out', host: 'vco.corp.local', username: 'u', password: 'p', collectMode: 'site' },
] }));
// operator 는 '구성 점검' 도구만 막는다(묶음 권한 판정 accessOf 를 본다). data.csv 는 관리자 전용 키라 operator 에게 줄 수 없다(permissions.js adminOnly).
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 3, matrix: {
  operator: ['dashboard', 'tools', 'data.csv'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: ['host-hygiene'], viewer: [] } } }));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

// 동적 import 는 전부 여기서(테스트 정의 사이 top-level await 금지)
const HX = await import('../src/vcenter/hostExport.js');
const XL = await import('../src/vcenter/hostExportXlsx.js');
const T = await import('../src/hostcfg/text.js');
const WEB = await import('../../web/src/views/hostcfg/hostCfgText.js');
const WX = await import('../../web/src/views/hostExportText.js');
const R = await import('../src/routes/api/hostExport.js');
const { listAudit, auditSkipped } = await import('../src/audit.js');
const EB = await import('../src/util/exportBusy.js');
const { store } = await import('../src/store.js');
const ExcelJS = (await import('exceljs')).default;
const express = (await import('express')).default;
const JSZip = createRequire(createRequire(import.meta.url).resolve('exceljs'))('jszip');

const H = 3_600_000; const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / H) * H;   // 정시로 떨어뜨린 실제 시각(docs/rules/common.md)

const hcfg = (over = {}) => ({
  at: NOW - H, lockdown: 'disabled', rebootRequired: false,
  services: { ssh: { running: true, policy: 'off' }, shell: { running: false, policy: 'off' }, ntpd: { running: true, policy: 'on' } },
  ntpServers: ['10.0.0.1'], dnsServers: ['10.0.0.53'], syslogHost: 'udp://10.0.0.60:514', lockFailures: 5, shellTimeout: 900, mob: false, acceptance: 'partner',
  certNotAfter: NOW + 10 * DAY, mp: { luns: 4, shared: 2, paths: 8, dead: 1, deadLuns: ['naa.1'], singlePath: 0, singleLuns: [], policies: { VMW_PSP_RR: 4 } },
  vsan: { enabled: false, diskIssues: null, members: null },
  net: { switches: [{ name: 'vSwitch0', kind: 'vss', uplinks: ['vmnic0', 'vmnic1'], pgs: 2 }], pgs: [{ name: 'Mgmt', vlan: 10, sw: 'vSwitch0', promisc: false }], pgsTotal: 1 },
  scratch: '/vmfs/volumes/ds1/.locker', logDir: '[] /scratch/log', diagPartition: true, bsodTimeout: 120, ...over,
});
const host = (id, name, cluster, ref, over = {}) => ({
  id: `${VC}:${id}`, vcenterId: VC, name, cluster, clusterRef: ref, vcDatacenter: 'DC1', connectionState: 'CONNECTED', powerState: 'POWERED_ON',
  cpuCores: 32, cpuSockets: 2, cpuThreads: 64, cpuTotalMhz: 64000, cpuUsageMhz: 25600, cpuUsagePct: 40, memTotalMB: 262144, memUsageMB: 157286, memUsagePct: 60,
  cpuModel: 'Intel Xeon Gold 6338', bootTime: NOW - 10 * DAY, version: '8.0.3', build: '24022510', mgmtIp: '10.0.0.11', vendor: 'Dell Inc.', model: 'PowerEdge R750', serviceTag: `TAG-${id}`,
  nics: [{ device: 'vmnic0', link: true, speedMb: 25000, maxSpeedMb: 25000 }, { device: 'vmnic1', link: false, speedMb: 0, maxSpeedMb: 25000 }, { device: 'vmnic2', link: false }],
  hbas: [{ name: 'vmhba64', type: 'FibreChannel', model: 'QLE2772', speedGbps: 32, wwn: '20:00:aa', status: 'online' }],
  temps: [{ name: 'Inlet', c: 24 }], tempC: 24, tempMaxC: 61, powerWatts: 400, hcfg: hcfg(), ...over,
});
function fixture() {
  const hosts = [
    host('h1', 'esx01.corp.local', 'CL1', 'domain-c1'),
    host('h2', 'esx02.corp.local', 'CL1', 'domain-c1', { hcfg: hcfg({ ntpServers: ['10.0.0.2'] }) }),
    host('h4', 'esx04.corp.local', 'CL1', 'domain-c1'),
    host('h3', 'esx03.corp.local', 'CL2', 'domain-c2', { connectionState: 'DISCONNECTED', cpuCores: null, cpuUsagePct: 5, hcfg: undefined, nics: [], powerWatts: null }),
    host('h5', 'esx05.corp.local', 'standalone', undefined, { hcfg: undefined }),
    { ...host('x1', 'other.corp.local', 'CLX', 'domain-c9'), id: `${OUT}:x1`, vcenterId: OUT },
  ];
  const vms = [
    { id: `${VC}:vm-1`, vcenterId: VC, host: 'esx01.corp.local', name: 'web01', powerState: 'POWERED_ON', cpuCount: 4, memMB: 8192, cpuUsagePct: 91, memUsagePct: 40, storageGB: 100, folder: 'vm/Prod', dev: { disks: [{ datastore: 'DS-A' }] } },
    { id: `${VC}:vm-2`, vcenterId: VC, host: 'esx01.corp.local', name: 'db01', powerState: 'POWERED_OFF', cpuCount: null, memMB: 4096 },
    { id: `${VC}:vm-3`, vcenterId: VC, host: 'esx01.corp.local', name: 'tmpl-rhel', powerState: 'POWERED_OFF', template: true, cpuCount: 2, memMB: 4096 },
    { id: `${VC}:vm-4`, vcenterId: VC, host: 'esx02.corp.local', name: 'app01', powerState: 'POWERED_ON', cpuCount: 8, memMB: 16384, dev: { disks: [{ datastore: 'DS-A' }, { datastore: 'DS-B' }] } },
  ];
  const datastores = [{ vcenterId: VC, name: 'DS-A', type: 'VMFS', capacityGB: 1000, freeGB: 100, usagePct: 90 }];
  const vc = { id: VC, name: 'vc-a', version: '8.0.3', clusterCfg: [{ ref: 'domain-c1', name: 'CL1', at: NOW - H, ha: { enabled: true, admission: false, hostMon: 'enabled', vmMon: 'vmMonitoringDisabled' }, drs: { enabled: true, behavior: 'fullyAutomated' }, rules: [{ inCompliance: true }, { inCompliance: false }], rulesTotal: 2, evc: '', numHosts: 3, numEffectiveHosts: 3 }] };
  return { vc, hosts, vms, datastores };
}
const ALL = new Set(HX.HOST_EXPORT_PARTS);

test('① 시트 이름 — 첫 마디 · 겹치면 전체 이름 · 31자 · 금지 글자 · 예약 이름 · 대소문자 무시', () => {
  const n = HX.hostSheetNames([
    { id: 'a', name: 'esx01.corp.local' }, { id: 'b', name: 'ESX01.other.local' }, { id: 'c', name: 'esx02.corp.local' },
    { id: 'd', name: '요약' }, { id: 'e', name: 'a/b:c*d?[e].x' }, { id: 'f', name: `${'x'.repeat(40)}.y` }, { id: 'g', name: `${'x'.repeat(40)}.z` }, { id: 'h', name: "'quoted'" },
  ]);
  assert.equal(n.get('a'), 'esx01.corp.local', '첫 마디가 겹치면 전체 이름');
  assert.equal(n.get('b'), 'ESX01.other.local');
  assert.equal(n.get('c'), 'esx02');
  assert.notEqual(n.get('d').toLowerCase(), '요약', '예약 시트 이름과 겹치지 않는다');
  assert.equal(n.get('e'), 'a_b_c_d__e_');
  assert.equal(n.get('h'), 'quoted');
  const all = [...n.values()];
  assert.ok(all.every((x) => x.length <= HX.SHEET_NAME_MAX && !/[\\/?*[\]:]/.test(x) && !/^'|'$/.test(x)));
  assert.equal(new Set(all.map((x) => x.toLowerCase())).size, all.length, '대소문자 무시 중복 없음');
  assert.deepEqual(HX.RESERVED_SHEETS, XL.HOST_XLSX_SHEETS, '예약 이름 = 워크북 고정 시트(워커는 hostExport.js 를 불러오지 않는다 — 대조)');
});

test('② 내용 — 0 대신 모름 · 템플릿 제외 · 구성 점검 판정 그대로(드리프트) · 업링크 끊김 · 클러스터 표 · 확인할 것', () => {
  const p = HX.buildHostExport(fixture(), { parts: ALL, now: NOW, offsetMin: 540 });
  assert.equal(p.hosts.length, 5, '그 vCenter 호스트만(다른 vCenter 제외)');
  assert.deepEqual(p.hosts.map((h) => h.name), ['esx01.corp.local', 'esx02.corp.local', 'esx04.corp.local', 'esx03.corp.local', 'esx05.corp.local'], '클러스터 → 이름 순 · 독립 호스트는 끝');
  const h1 = p.hosts[0];
  assert.equal(h1.vms, 2, '템플릿은 VM 셈에서 뺀다'); assert.equal(h1.templates, 1);
  assert.equal(h1.vcpuUnknown, 1); assert.equal(h1.cpuRatio, null, 'vCPU 를 모르는 VM 이 있으면 비율을 확정하지 않는다');
  assert.equal(h1.vmRows.length, 3); assert.equal(h1.vmRows[2].power, '템플릿', '템플릿은 표 끝에 표시');
  assert.equal(h1.uplinkDown, 1, '쓰는 스위치 업링크(vmnic1)만 — 안 쓰는 vmnic2 는 업링크 셈에서 빠진다');
  assert.equal(h1.nicLinkDown, 2, '링크 내려간 NIC 사실(안 쓰는 포트 포함)');
  const codes = h1.sec.findings.map((f) => f.code);
  for (const c of ['ssh-running', 'lockdown-off', 'cert-expiring', 'mp-dead', 'net-uplink-down']) assert.ok(codes.includes(c), c);
  const ssh = h1.sec.rows.find((r) => r.label === 'SSH');
  assert.equal(ssh.verdict, `⚠ ${T.HOST_CFG_TITLE['ssh-running']}`);
  assert.equal(h1.sec.rows.find((r) => r.label === 'MOB').verdict, '✓');
  const h2 = p.hosts[1];
  assert.ok(h2.sec.rows.some((r) => r.label === '클러스터와 다름: NTP 서버' && r.value.includes('10.0.0.2') && r.value.includes('10.0.0.1')), '다수와 다른 호스트에 드리프트 행');
  assert.ok(!h1.sec.rows.some((r) => r.label.startsWith('클러스터와 다름')), '다수 쪽에는 드리프트 행이 없다');
  const h3 = p.hosts[3];
  assert.equal(h3.cores, null); assert.equal(h3.cpuPct, null, '연결 끊긴 호스트의 사용률은 쓰지 않는다'); assert.equal(h3.uptimeDays, null);
  assert.equal(h3.sec.state, 'disconnected'); assert.equal(h3.uplinkDown, null);
  assert.equal(p.summary.cores.unknown, 1, '코어를 모르는 호스트는 따로 센다'); assert.equal(p.summary.cores.sum, 32 * 4);
  assert.equal(p.summary.powerW.unknown, 1);
  const cl1 = p.clusters.find((c) => c.name === 'CL1');
  assert.equal(cl1.key, 'r:domain-c1', '모든 클러스터 호스트가 ref 를 실었으면 ref 로 묶는다');
  assert.equal(cl1.hosts, 3); assert.equal(cl1.cfg.rulesOk, 1); assert.equal(cl1.cfg.rulesTotal, 2); assert.equal(cl1.cpuRatio, null, 'vCPU 모름 VM 이 있는 클러스터 비율은 확정하지 않는다');
  assert.equal(p.clusters.find((c) => c.name === 'CL2').cfg, null, '구성을 못 읽은 클러스터');
  assert.equal(p.hosts[4].cluster, '독립 호스트'); assert.equal(p.hosts[4].clusterCfg, null);
  const chk = Object.fromEntries(p.checks.map((c) => [c.id, c.hosts.map((x) => x.name)]));
  assert.deepEqual(chk.disc, ['esx03.corp.local']);
  assert.deepEqual(chk.uplinkDown, ['esx01.corp.local', 'esx02.corp.local', 'esx04.corp.local']);
  assert.ok(chk.drift.includes('esx02.corp.local'));
  // 데이터스토어 — 이 호스트 VM 이 쓰는 것(스냅샷에 없는 이름은 용량 모름)
  const ds = p.hosts[1].st.datastores;
  assert.deepEqual(ds.map((d) => [d.name, d.vms, d.capGB]), [['DS-A', 1, 1000], ['DS-B', 1, null]]);
  assert.equal(p.hosts[0].st.vmNoDev, 2, '장치 정보 없는 VM 은 따로 센다(템플릿 포함)');
  // 클러스터 고르기 — ref 열쇠
  const q = HX.buildHostExport(fixture(), { parts: ALL, now: NOW, clusters: ['r:domain-c2', 'standalone'] });
  assert.deepEqual(q.hosts.map((h) => h.name), ['esx03.corp.local', 'esx05.corp.local']);
  assert.equal(q.meta.target, '클러스터 2개');
  assert.deepEqual(HX.clusterChoices(fixture().hosts, VC).map((c) => [c.key, c.name, c.hosts]), [['r:domain-c1', 'CL1', 3], ['r:domain-c2', 'CL2', 1], ['standalone', '독립 호스트', 1]]);
  // 이름 모드 — ref 를 싣지 않은 클러스터 호스트가 하나라도 있으면 이름으로 묶는다(clustercfg 규칙 한 벌)
  const f2 = fixture(); f2.hosts[1].clusterRef = undefined;
  assert.deepEqual(HX.clusterChoices(f2.hosts, VC).map((c) => c.key), ['n:CL1', 'n:CL2', 'standalone']);
});

test('③ 권한으로 뺀 묶음은 사유와 함께 — 조용히 빼지 않는다', () => {
  const p = HX.buildHostExport(fixture(), { parts: ALL, now: NOW, access: { hygiene: false, cluster: false, hw: false } });
  for (const k of ['sec', 'boot', 'cluster', 'hw']) assert.ok(p.meta.omitted[k]?.length > 5, k);
  assert.ok(!p.meta.parts.includes('sec') && !p.meta.parts.includes('hw') && p.meta.parts.includes('net'));
  const h1 = p.hosts[0];
  assert.equal(h1.sec, null); assert.equal(h1.boot, null); assert.equal(h1.hw, null); assert.equal(h1.clusterCfg, null);
  assert.equal(h1.net.switches, null, '스위치 · 포트그룹(구성 캐시)은 구성 점검 권한이 있을 때만');
  assert.equal(h1.st.mp, null, '멀티패스도');
  assert.equal(h1.uplinkDown, null, '업링크 판정도 구성 점검 판정이다');
  assert.ok(!p.checks.some((c) => c.id === 'ssh-running' || c.id === 'hw'), '뺀 묶음의 확인 항목도 없다');
  assert.equal(p.clusters[0].cfg, null);
});

test('④ iDRAC — 서비스 태그로 맞춤 · 등록 안 됨(null) · 인벤토리 없음(undefined) · 부품 판정은 inventoryView 그대로', () => {
  const inv = { system: { biosVersion: '2.1.0', health: 'OK', serialNumber: 'SN1' }, idrac: { firmwareVersion: '7.00' }, psus: [{ name: 'PSU1', health: 'OK', state: 'Enabled' }, { name: 'PSU2', health: 'Critical', state: 'Enabled' }] };
  const idracFor = R.makeIdracFor({ registry: [{ id: 'i1', serviceTag: 'tag-h1' }, { id: 'i2', serviceTag: 'TAG-h2' }], remote: [{ serviceTag: 'TAG-h4', inv: null }], getInv: (id) => (id === 'i1' ? { data: inv } : null) });
  const p = HX.buildHostExport(fixture(), { parts: ALL, now: NOW, idracFor });
  const [h1, h2, h4] = p.hosts;
  assert.equal(h1.hw.state, 'ok', '대소문자 무시로 맞춘다');
  assert.equal(h1.hw.bios, '2.1.0'); assert.equal(h1.hw.idracFw, '7.00');
  const psu = h1.hw.groups.find((g) => g.key === 'psus');
  assert.deepEqual([psu.ok, psu.fault, psu.state], [1, 1, 'fault']);
  assert.equal(h1.hw.bad[0].name, 'PSU2');
  assert.equal(h2.hw.state, 'pending', '등록됐는데 인벤토리 없음');
  assert.equal(h4.hw.state, 'pending', '엣지 원격 서버(인벤토리 없음)');
  assert.equal(p.hosts[3].hw.state, 'none', '등록 안 됨');
  assert.deepEqual(p.checks.find((c) => c.id === 'hw').hosts.map((x) => x.name), ['esx01.corp.local']);
});

/** 최상위 자식 이름(깊이 1 의 여는 태그) — xlsxSheetPr2799.test.js 와 같은 방식. */
function childTags(xml, from, to) {
  const out = []; let depth = 0; let i = from;
  while (i < to) {
    const lt = xml.indexOf('<', i); if (lt < 0 || lt >= to) break;
    const gt = xml.indexOf('>', lt); const tag = xml.slice(lt + 1, gt);
    if (tag.startsWith('/')) depth--;
    else if (!tag.startsWith('?') && !tag.startsWith('!')) { if (depth === 0) out.push(tag.split(/[\s/]/)[0]); if (!tag.endsWith('/')) depth++; }
    i = gt + 1;
  }
  return out;
}
const WS_ORDER = ['sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData', 'sheetCalcPr', 'sheetProtection', 'protectedRanges', 'scenarios',
  'autoFilter', 'sortState', 'dataConsolidate', 'customSheetViews', 'mergeCells', 'phoneticPr', 'conditionalFormatting', 'dataValidations', 'hyperlinks',
  'printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks', 'customProperties', 'cellWatches', 'ignoredErrors', 'smartTags',
  'drawing', 'legacyDrawing', 'legacyDrawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst'];
const SHEETPR_ORDER = ['tabColor', 'outlinePr', 'pageSetUpPr'];
const inOrder = (tags, order) => tags.every((t, k) => order.includes(t) && (k === 0 || order.indexOf(tags[k - 1]) < order.indexOf(t)));

async function checkXml(buf) {
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files);
  for (const n of names.filter((x) => /^xl\/worksheets\/_rels\//.test(x))) {
    const rels = await zip.file(n).async('string');
    assert.ok(!/Hyperlink/.test(rels), `${n}: 시트 안 링크는 외부 관계를 만들지 않는다`);
  }
  let links = 0;
  for (const n of names.filter((x) => /^xl\/worksheets\/sheet\d+\.xml$/.test(x))) {
    const xml = await zip.file(n).async('string');
    const ws = xml.indexOf('<worksheet'); const top = childTags(xml, xml.indexOf('>', ws) + 1, xml.lastIndexOf('</worksheet>'));
    assert.ok(inOrder(top, WS_ORDER), `${n}: 요소 순서 ${top.join(',')}`);
    const a = xml.indexOf('<sheetPr>'); const b = xml.indexOf('</sheetPr>');
    if (a >= 0) assert.ok(inOrder(childTags(xml, a + 9, b), SHEETPR_ORDER), `${n}: sheetPr 순서`);
    assert.ok(!/<f[ >]/.test(xml), `${n}: 수식 칸 없음`);
    for (const m of xml.matchAll(/<hyperlink [^>]*>/g)) { links++; assert.ok(/location="/.test(m[0]) && !/r:id=/.test(m[0]), m[0]); }
  }
  return links;
}

test('⑤ 워크북 — 시트 순서 · 링크(location 만) · 요소 순서 · 수식 없음 · 모름은 — · 워커 경로도 같은 파일', async () => {
  const p = HX.buildHostExport(fixture(), { parts: ALL, now: NOW, offsetMin: 540, veeam: { linked: true, byId: new Map() } });
  p.meta.offsetLabel = 'KST';
  const out = await XL.buildHostExportWorkbook(p);
  assert.equal(out.meta.sheets, 9);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(out.buffer);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['요약', '클러스터', '호스트 목록', 'esx01', 'esx02', 'esx04', 'esx03', 'esx05', '읽는 법']);
  // ⚠ exceljs 는 읽을 때 시트 안 링크(location)를 되살리지 않는다(관계 기반만 읽는다) — 링크는 XML 로 본다. Excel·LibreOffice·openpyxl 은 location 을 읽는다.
  const list = wb.getWorksheet('호스트 목록');
  assert.equal(list.getCell('A3').text, 'esx01.corp.local');
  assert.equal(list.getCell(6, 8).value, '—', '코어를 모르는 호스트는 — (0 이 아니다)');
  const zip = await JSZip.loadAsync(out.buffer);
  const x3 = await zip.file('xl/worksheets/sheet3.xml').async('string');
  assert.ok(x3.includes('<hyperlink ref="A3" location="&apos;esx01&apos;!A1"/>'), '호스트 이름 → 그 호스트 시트');
  const x4 = await zip.file('xl/worksheets/sheet4.xml').async('string');
  assert.ok(x4.includes('<hyperlink ref="A1" location="&apos;호스트 목록&apos;!A3"/>'), '← 호스트 목록 은 그 호스트 줄로');
  const s1 = wb.getWorksheet('esx01');
  const texts = []; s1.eachRow((row) => row.eachCell((c) => texts.push(typeof c.value === 'string' ? c.value : c.value?.richText ? c.value.richText.map((x) => x.text).join('') : '')));
  const flat = texts.join('\n');
  for (const t of ['구성 · 보안 점검', '네트워크', '스토리지', '최근 재부팅', 'VM — 이 호스트 2대', `⚠ ${T.HOST_CFG_TITLE['ssh-running']}`, '템플릿', '최근 1일 백업']) assert.ok(flat.includes(t), t);
  const links = await checkXml(out.buffer);
  assert.ok(links >= 5 + 5 + 3, `링크 수 ${links}`);
  const guide = wb.getWorksheet('읽는 법'); let g = ''; guide.eachRow((row) => row.eachCell((c) => { g += `${c.value}\n`; }));
  assert.ok(g.includes('0 으로 쓰지 않습니다'));
  // 워커 경로(기본) — 같은 내용으로 열리는 파일
  const w = await XL.renderHostExportWorkbook(p);
  const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(w.buffer);
  assert.equal(wb2.worksheets.length, 9);
  await checkXml(w.buffer);
});

test('⑥ 서버 글자 = 웹 글자(제목 · 드리프트 · 재부팅 · 구성 표 라벨·값) · 묶음 키 · 시트 수', () => {
  for (const [code, t] of Object.entries(WEB.HOST_CFG_TEXT)) assert.equal(T.HOST_CFG_TITLE[code], t.title, code);
  assert.deepEqual(Object.keys(T.HOST_CFG_TITLE).sort(), Object.keys(WEB.HOST_CFG_TEXT).sort());
  assert.deepEqual(T.DRIFT_LABEL, WEB.DRIFT_LABEL);
  assert.deepEqual(T.SEV_LABEL, WEB.SEV_LABEL);
  for (const [k, v] of Object.entries(WEB.REBOOT_KIND)) assert.equal(T.REBOOT_LABEL[k], v.label, k);
  const DATE_ROWS = new Set(['마지막 부팅', '인증서 만료']);   // 화면은 브라우저 지역 시각, 엑셀은 포탈 시각 — 날짜 줄만 다르다
  for (const h of [host('a', 'a', 'CL', 'r'), host('b', 'b', 'CL', 'r', { hcfg: hcfg({ lockdown: 'strict', mob: true, net: null, mp: null, vsan: { enabled: true, members: 3, diskIssues: 1 }, syslogHost: '', lockFailures: 0, shellTimeout: 0, bsodTimeout: 0, diagPartition: false, scratch: null }) })]) {
    const s = T.hostCfgTableRows(h, { now: NOW }); const w = WEB.hostCfgRows(h, NOW);
    assert.deepEqual(s.rows.map((r) => r.label), w.rows.map((r) => r.label));
    for (let i = 0; i < s.rows.length; i++) if (!DATE_ROWS.has(s.rows[i].label)) assert.equal(s.rows[i].value, w.rows[i].value, s.rows[i].label);
    for (const r of s.rows) for (const c of r.codes) assert.ok(c in T.HOST_CFG_TITLE, `${r.label}: ${c}`);
  }
  assert.deepEqual(WX.PARTS.map((x) => x[0]).filter((k) => k !== 'base'), [...HX.HOST_EXPORT_PARTS], '웹 묶음 키 = 서버');
  assert.equal(WX.RESERVED_SHEETS, XL.HOST_XLSX_SHEETS.length);
});

test('⑦ 실제 라우트 — data.csv · 범위 밖 404 · 묶음 권한 · 400 · 상한 · 409 · 감사 한 줄', async () => {
  const prev = store.snapshot;
  const f = fixture();
  store.snapshot = { source: 'live', generatedAt: new Date(NOW).toISOString(), vcenters: [f.vc, { id: OUT, name: 'vc-out' }], hosts: f.hosts, vms: f.vms, datastores: f.datastores };
  let user = { username: 'adm', role: 'admin', scope: { vcenters: [VC] } };
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); R.registerHostExport(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  closers.push(async () => { store.snapshot = prev; });
  const base = `http://127.0.0.1:${srv.address().port}/api/tools`;
  const post = (vc, body) => fetch(`${base}/host-export.xlsx?vcenterId=${encodeURIComponent(vc)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const status = (vc) => fetch(`${base}/host-export/status?vcenterId=${encodeURIComponent(vc)}`);

  let r = await status(VC);
  assert.equal(r.status, 200);
  let j = await r.json();
  assert.deepEqual(j.access, { hygiene: true, cluster: true, hw: true });
  assert.deepEqual(j.clusters.map((c) => c.key), ['r:domain-c1', 'r:domain-c2', 'standalone']);
  assert.deepEqual(j.sources.hcfg, { read: 3, total: 5 });
  assert.equal(j.sources.clusterCfg.read, 1); assert.equal(j.sources.clusterCfg.total, 2);
  assert.equal((await status(OUT)).status, 404, '범위 밖 vCenter 는 404');
  assert.equal((await status('nope')).status, 404);
  assert.equal((await post(OUT, {})).status, 404);
  // 400 — 모르는 묶음 · 이 vCenter 에 없는 클러스터 · 빈 선택
  assert.equal((await post(VC, { parts: ['bad'] })).status, 400);
  assert.equal((await post(VC, { clusters: ['r:domain-c9'] })).status, 400, '다른 vCenter 의 클러스터 열쇠');
  assert.equal((await post(VC, { clusters: [] })).status, 400);
  // 관리자 — 전부
  r = await post(VC, { parts: [...ALL], clusters: ['r:domain-c1'] });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /hosts-vc-a-clusters-\d{8}-\d{4}\.xlsx/);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  assert.equal(wb.worksheets.length, 3 + 4);
  assert.ok(auditSkipped('POST', '/api/tools/host-export.xlsx'), '자동 감사는 건너뛴다(라우트가 한 줄)');
  const a = listAudit({ limit: 50 }).items.filter((x) => x.action === 'host-export.xlsx');
  assert.equal(a.length, 1); assert.equal(a[0].target, VC); assert.match(a[0].detail, /호스트 3대/);
  // operator — data.csv 는 관리자 전용(행렬에 적어도 주지 않는다) → 403. 묶음 권한 판정(accessOf)은 그 기능 화면과 같다(구성 점검 도구 막힘 · 관리자 판본 아님).
  user = { username: 'op', role: 'operator', scope: {} };
  assert.equal((await status(VC)).status, 403); assert.equal((await post(VC, {})).status, 403);
  assert.deepEqual(R.accessOf({ user }), { hygiene: false, cluster: true, hw: false });
  assert.deepEqual(R.accessOf({ user: { username: 'adm', role: 'admin', scope: {} } }), { hygiene: true, cluster: true, hw: true });
  // viewer — data.csv 없음
  user = { username: 'v', role: 'viewer', scope: {} };
  assert.equal((await status(VC)).status, 403); assert.equal((await post(VC, {})).status, 403);
  // 데모 계정(관리자 문맥) — data.csv 는 관리자 전용 키라 막힌다
  user = { username: 'thedvcdemp', role: 'admin', demoGuest: true, scope: {} };
  assert.equal((await post(VC, {})).status, 403);
  // 409 — 동시 1건
  user = { username: 'adm', role: 'admin', scope: {} };
  const lock = EB.acquireExport('host-export.xlsx', { user: { username: 'someone' } });
  assert.ok(lock.ok);
  r = await post(VC, {});
  assert.equal(r.status, 409);
  lock.release();
  // 상한 — 한 파일 최대 HOSTS_MAX 대
  const many = Array.from({ length: HX.HOSTS_MAX + 1 }, (_, i) => host(`m${i}`, `m${i}.corp.local`, 'BIG', 'domain-c7'));
  store.snapshot = { ...store.snapshot, hosts: many };
  r = await post(VC, {});
  assert.equal(r.status, 400);
  assert.equal((await r.json()).tooMany, true);
});

test('⑧ 본문 해석 — 기본 묶음 · Veeam 은 VM 목록이 있어야 · 형식 검사', () => {
  const keys = new Set(['r:a', 'standalone']);
  let s = R.hostExportSelOf({}, keys);
  assert.ok(s.ok); assert.deepEqual([...s.parts].sort(), HX.HOST_EXPORT_PARTS.filter((p) => p !== 'vmVeeam').sort()); assert.equal(s.clusters, null);
  s = R.hostExportSelOf({ parts: ['vmVeeam'] }, keys);
  assert.ok(s.ok); assert.ok(!s.parts.has('vmVeeam'), 'VM 목록 없이 Veeam 칸만은 넣지 않는다');
  assert.equal(R.hostExportSelOf({ parts: 'sec' }, keys).ok, false);
  assert.equal(R.hostExportSelOf({ clusters: 'r:a' }, keys).ok, false);
  assert.equal(R.hostExportSelOf({ clusters: [1] }, keys).ok, false);
  assert.deepEqual(R.hostExportSelOf({ clusters: ['r:a', 'r:a'] }, keys).clusters, ['r:a'], '중복 제거');
  // 웹 본문 도우미 — 권한 없는 묶음은 싣지 않는다
  const st = { access: { hygiene: false, cluster: true, hw: true }, hosts: 5, max: 300, clusters: [{ key: 'r:a', hosts: 3 }, { key: 'standalone', hosts: 2 }] };
  const ui = WX.initialState(st);
  assert.deepEqual(WX.exportBody(st, ui).parts, ['net', 'st', 'hw', 'vm']);
  assert.equal(WX.sheetLine(st, { ...ui, mode: 'pick', picked: { 'r:a': true } }).text, '시트 7장');
  assert.equal(WX.sheetLine({ ...st, max: 2 }, ui).ok, false);
});
