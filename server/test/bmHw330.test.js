// 물리서버 폴더 하드웨어(iDRAC) 요약 · OS 이름 · iDRAC 접속 주소(v3.3.0 — 사용자 요청 '여기 기능에 iDRAC 에서 수집한 데이터 보여줘
//   cpu/memory/disk/nic/hba/OS 종류/idrac IP · idrac ip 클릭하면 ssh/web 선택해서 접속' · 고른 방식: 표 요약 열 + 옆 패널 상세 · iDRAC 에서 OS 이름도 수집 ·
//   포탈 웹 SSH + 내 PC SSH · 전체 검증).
//   ① 요약 값 · 못 읽은 컬렉션은 0 이 아니라 null ② FC HBA 판정(Ethernet CNA · SAS HBA 는 아니다) ③ 엣지 계약 정제(아는 키만 · 문자열 수치 거부)
//   ④ 관리 주소 글자 ⑤ compactInv ↔ 중앙 INV_SHAPE 짝(osName) ⑥ 중앙 fleet: 요약 · 주소 정제, 요약만 바뀌면 fleet rev 그대로
//   ⑦ fetchInventory OS 이름($select · 4xx 한 번 다시 · 404 다시 묻지 않음 · HPE HostOS) ⑧ 목록 · 상세 응답 — 판본별 가림 · 범위 404 · 수집 서버 · 엣지 요약
//   픽스처 식별자는 전부 합성(SYNTH · 192.0.2.x — 공개 저장소 규약).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmhw330-'));
process.env.CONFIG_DIR = tmp;
process.env.IDRAC_TIMEOUT_MS = '1500';

const H = await import('../src/idrac/hwSummary.js');
const { compactInv } = await import('../src/collector/compactInv.js');
const rinv = await import('../src/collector/remoteInventory.js');
const cstate = await import('../src/collector/state.js');
const fleet = await import('../src/central/fleet.js');
const { fleetRev } = await import('../src/insights/fleetRev.js');
const { fetchInventory } = await import('../src/idrac/redfish.js');
const invCache = await import('../src/idrac/invCache.js');
const bs = await import('../src/bmfolders/store.js');
const sm = await import('../src/servicemap/store.js');
const registry = await import('../src/idrac/registry.js');
const { store } = await import('../src/store.js');
const { registerBmFolders } = await import('../src/routes/api/bmFolders.js');
const svcinv = await import('../src/routes/api/svcInventory.js');

const FC_MODEL = 'QLogic QLE2772 Dual Port 32Gb Fibre Channel to PCIe Adapter';
const INV = (o = {}) => ({
  collectedAt: 1_800_000_000_000,
  collections: { system: 'ok', psus: 'ok', disks: 'ok', storageControllers: 'ok', memoryDimms: 'ok', cpus: 'ok', gpus: 'ok', pcie: 'ok' },
  system: { hostName: 'synth-os-01', model: 'PowerEdge R750', manufacturer: 'Dell Inc.', serviceTag: 'SYNTH01', osName: 'Red Hat Enterprise Linux', osVersion: '9.2' },
  idrac: { firmwareVersion: '7.00.00.171', model: '15G Monolithic' },
  cpu: { count: 2, model: 'Synth Xeon 6342', cores: 48, threads: 96 },
  memory: { totalGiB: 512 },
  cpus: [{ socket: 'CPU.Socket.1', model: 'Synth Xeon 6342', cores: 24, threads: 48 }, { socket: 'CPU.Socket.2', model: 'Synth Xeon 6342', cores: 24, threads: 48 }],
  memoryDimms: Array.from({ length: 16 }, (_, i) => ({ locator: `A${i}`, sizeGB: 32, type: 'DDR4', speedMHz: 3200, manufacturer: 'Synth' })),
  disks: [
    { model: 'SYNTH-SSD', capacityGB: 960, media: 'SSD', protocol: 'SAS' }, { model: 'SYNTH-SSD', capacityGB: 960, media: 'SSD', protocol: 'SAS' },
    { model: 'SYNTH-NVME', capacityGB: 3840, media: 'SSD', protocol: 'NVMe' }, { model: 'SYNTH-HDD', capacityGB: 8000, media: 'HDD', protocol: 'SAS' },
  ],
  storageControllers: [{ name: 'PERC H755', model: 'PERC H755 Front', firmware: '52.21' }, { name: 'HBA355i', model: 'HBA355i Front', firmware: '24.15' }],
  nics: [
    { name: 'NIC.Embedded.1', model: 'Broadcom Gigabit Ethernet BCM5720', ports: [{ id: '1', link: 'Up', speedMbps: 1000 }, { id: '2', link: 'Down', speedMbps: 1000 }] },
    { name: 'NIC.Slot.3', model: 'Mellanox ConnectX-6 Lx 25GbE', ports: [{ id: '1', link: 'Up', speedMbps: 25000 }, { id: '2', link: 'Up', speedMbps: 25000 }] },
    { name: 'FC.Slot.5', model: FC_MODEL, ports: [{ id: '1', link: 'Up', speedMbps: 32000 }, { id: '2', link: 'Down', speedMbps: 32000 }] },
  ],
  pcie: [{ name: FC_MODEL, model: FC_MODEL, deviceType: 'MultiFunction' }, { name: 'HBA355i Front', model: 'HBA355i Front' }],
  network: [{ name: 'iDRAC.Embedded.1', ipv4: '192.0.2.50', mac: 'aa:bb', hostName: 'idrac-synth01' }],
  ...o,
});

// ───────── ① 요약 ─────────
test('① 요약 — CPU · 메모리 · 디스크 · NIC(FC 제외) · FC HBA · OS · 호스트명 · iDRAC 펌웨어', () => {
  const h = H.hwSummaryOf(INV());
  assert.deepEqual(h.cpu, { sockets: 2, cores: 48, threads: 96, model: 'Synth Xeon 6342' });
  assert.deepEqual(h.mem, { gib: 512, dimms: 16 });
  assert.deepEqual(h.disk, { n: 4, gb: 13760, ssd: 3, hdd: 1, nvme: 1 });
  assert.deepEqual(h.nic, { ports: 4, up: 3, maxGbps: 25, speeds: [[25, 2], [1, 2]] }, 'FC 어댑터 포트는 NIC 에 넣지 않는다');
  assert.deepEqual(h.hba, { n: 1, ports: 2 }, 'SAS HBA(HBA355i)는 FC HBA 가 아니다 · 포트 수는 같은 모델 NetworkAdapter 에서');
  assert.deepEqual(h.os, { name: 'Red Hat Enterprise Linux', ver: '9.2' });
  assert.equal(h.host, 'synth-os-01'); assert.equal(h.fw, '7.00.00.171'); assert.equal(h.at, 1_800_000_000_000);
  assert.equal(H.hwSummaryOf(null), null);
});

test('① 못 읽은 컬렉션은 0 이 아니라 null · 부분 합은 null(개수는 그대로) · 읽었고 없으면 0', () => {
  const failed = H.hwSummaryOf(INV({
    collections: { system: 'ok', disks: 'failed', memoryDimms: 'failed', pcie: 'failed', cpus: 'ok' },
    memory: {}, nics: [], network: [],
  }));
  assert.equal(failed.disk, null, '디스크 컬렉션 실패 → null(0개가 아니다)');
  assert.equal(failed.mem, null, '요약도 DIMM 도 못 읽음 → null');
  assert.equal(failed.nic, null, 'NIC 빈 배열 = 못 읽음(표식 없는 컬렉션)');
  assert.equal(failed.hba, null, 'PCIe 실패 + NIC 못 읽음 → HBA 모름(0 이 아니다)');
  const partial = H.hwSummaryOf(INV({ disks: [{ capacityGB: 960, media: 'SSD' }, { media: 'HDD' }] }));
  assert.deepEqual(partial.disk, { n: 2, gb: null, ssd: 1, hdd: 1, nvme: 0 }, '용량 하나를 못 읽으면 합은 null');
  const none = H.hwSummaryOf(INV({ disks: [], pcie: [], nics: [{ model: 'Broadcom 25Gb', ports: [{ id: '1', link: 'Up', speedMbps: 25000 }] }] }));
  assert.deepEqual(none.disk, { n: 0, gb: 0, ssd: 0, hdd: 0, nvme: 0 }, '읽었고 디스크 없음');
  assert.deepEqual(none.hba, { n: 0, ports: 0 }, '읽었고 FC 없음');
  const dimmOnly = H.hwSummaryOf(INV({ memory: {} }));
  assert.deepEqual(dimmOnly.mem, { gib: 512, dimms: 16 }, '요약 메모리가 없으면 DIMM 합');
  const noOs = H.hwSummaryOf(INV({ system: { hostName: '', serviceTag: 'SYNTH01' } }));
  assert.equal(noOs.os, null, 'iSM 없음 → os null(지어내지 않는다)');
});

// ───────── ② FC HBA 판정 ─────────
test('② FC HBA 판정 — FC 어댑터만(Ethernet CNA · SAS HBA · 일반 NIC 는 아니다)', () => {
  for (const m of [FC_MODEL, 'Emulex LPe35002-M2-D 2-Port 32Gb Fibre Channel Adapter', 'QLE2692', 'LPe31002', 'Synth 16Gb FC HBA', 'Brocade 1860 16G FC',
    'Synth Vendor 2-Port Fibre Channel Adapter' /* 'Fibre Channel' 글자로만 알아보는 경우(변이 검증에서 살아남았던 규칙) */]) {
    assert.equal(H.isFcHba({ model: m }), true, m);
  }
  for (const m of ['QLogic BCM57810 10Gb CNA', 'Emulex OneConnect OCe14102 10GbE', 'HBA355i Front', 'Dell HBA330 Mini', 'Broadcom Adv. Dual 25Gb Ethernet', 'Mellanox ConnectX-6', '']) {
    assert.equal(H.isFcHba({ model: m }), false, m);
  }
  assert.equal(H.isFcHba({ name: 'Emulex LPe35002 32Gb 2-Port PCIe Fibre Channel Adapter', model: 'LPe35002' }), true, '이름으로도');
});

// ───────── ③ 엣지 계약 정제 ─────────
test('③ sanitizeHwSummary — 아는 키만 · 문자열 수치는 버린다 · 글자 상한 · 형식이 아니면 null', () => {
  const good = H.hwSummaryOf(INV());
  assert.deepEqual(H.sanitizeHwSummary(JSON.parse(JSON.stringify(good))), good, '엣지가 만든 요약은 그대로 통과');
  const evil = { ...good, extra: 'x', cpu: { ...good.cpu, cores: '48', evil: 1 }, os: { name: 'A'.repeat(500), ver: { x: 1 } }, nic: { ...good.nic, speeds: [[25, 2], ['1', 2], 'x', [1e9, 1]] }, host: 7 };
  const s = H.sanitizeHwSummary(evil);
  assert.equal('extra' in s, false); assert.equal('evil' in s.cpu, false);
  assert.equal(s.cpu.cores, null, "문자열 '48' 은 받지 않는다(엣지는 수로 보낸다)");
  assert.equal(s.os.name.length, 128); assert.equal(s.os.ver, '');
  assert.deepEqual(s.nic.speeds, [[25, 2]], '형식이 아닌 속도 쌍은 버린다');
  assert.equal(s.host, '');
  assert.equal(H.sanitizeHwSummary({ ...good, v: 2 }), null);
  assert.equal(H.sanitizeHwSummary([good]), null);
  assert.equal(H.sanitizeHwSummary('x'), null);
  assert.equal(H.sanitizeHwSummary({ v: 1, cpu: { cores: -1 }, disk: { n: Infinity } }).cpu.cores, null, '음수 · 무한은 null');
});

// ───────── ④ 관리 주소 ─────────
test('④ mgmtHostOf — 스킴 · 경로를 떼고 호스트 글자만(링크에 넣을 값)', () => {
  const cases = [['https://192.0.2.5:443/x', '192.0.2.5:443'], ['idrac-synth.example.test', 'idrac-synth.example.test'], ['[2001:db8::5]', '[2001:db8::5]'],
    ['a b', ''], ['javascript:alert(1)', ''], ['x@y', ''], ['192.0.2.9"><img>', ''], [42, ''], ['', '']];
  for (const [v, want] of cases) assert.equal(H.mgmtHostOf(v), want, String(v));
});

// ───────── ⑤ 엣지 compactInv ↔ 중앙 정제 짝 ─────────
test('⑤ compactInv 가 OS 이름 · 버전을 싣고 중앙 sanitizeRemoteInv 가 받는다(한쪽만 넓히면 버려진다)', () => {
  const c = compactInv(INV());
  assert.equal(c.system.osName, 'Red Hat Enterprise Linux'); assert.equal(c.system.osVersion, '9.2');
  const back = rinv.sanitizeRemoteInv(JSON.parse(JSON.stringify(c)));
  assert.equal(back.system.osName, 'Red Hat Enterprise Linux'); assert.equal(back.system.osVersion, '9.2');
  assert.deepEqual(H.hwSummaryOf(back).os, { name: 'Red Hat Enterprise Linux', ver: '9.2' }, '수집 서버 경로 인벤토리에서도 같은 요약');
  assert.equal('osName' in compactInv(INV({ system: { serviceTag: 'SYNTH01' } })).system, false, '없으면 키를 만들지 않는다');
});

// ───────── ⑥ 중앙 fleet ─────────
test('⑥ 중앙 fleet — 엣지 요약 · 주소를 정제해 담고, 요약만 바뀌면 fleet rev 를 올리지 않는다', () => {
  fleet.resetEdgeFleet();
  const hw = H.hwSummaryOf(INV());
  const row = { fleetId: 'synth-f1', name: 'synth-app-01', serviceTag: 'SYNTH01', vcenterId: '', source: 'idrac' };
  fleet.setEdgeFleet('synth-edge', [{ ...row, hw: { ...hw, extra: 1 }, mgmtHost: 'https://192.0.2.9/redfish' }], 'g1');
  const r0 = fleetRev();
  let s = fleet.getEdgeFleetServers().find((x) => x.serverId === 'edge:synth-edge:synth-f1');
  assert.deepEqual(s.hw, hw, '모르는 키는 버린다'); assert.equal(s.mgmtHost, '192.0.2.9');
  fleet.setEdgeFleet('synth-edge', [{ ...row, hw: { ...hw, at: hw.at + 60_000, mem: { gib: 1024, dimms: 32 } }, mgmtHost: '192.0.2.9' }], 'g2');
  assert.equal(fleetRev(), r0, '요약만 바뀌었다 — 분류 서명에 넣지 않는다(캐시 무효화 폭증 방지)');
  s = fleet.getEdgeFleetServers().find((x) => x.serverId === 'edge:synth-edge:synth-f1');
  assert.equal(s.hw.mem.gib, 1024, '새 요약은 담긴다');
  fleet.setEdgeFleet('synth-edge', [{ ...row, hw: 'bad', mgmtHost: 'a b' }], 'g3');
  s = fleet.getEdgeFleetServers().find((x) => x.serverId === 'edge:synth-edge:synth-f1');
  assert.deepEqual([s.hw, s.mgmtHost], [null, ''], '형식이 아니면 비운다');
  fleet.resetEdgeFleet();
});

// ───────── ⑦ fetchInventory OS 이름 ─────────
async function fakeRedfish(routes, seen) {
  const srv = createServer((req, res) => {
    seen.push(req.url);
    const u = new URL(req.url, 'http://x');
    const key = routes[`${u.pathname}${u.search}`] !== undefined ? `${u.pathname}${u.search}` : u.pathname;
    const r = routes[key];
    const status = r == null ? 404 : (typeof r === 'number' ? r : 200);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? r : { error: { message: `synthetic ${status}` } }));
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return { srv, base: `http://127.0.0.1:${srv.address().port}` };
}
const SYS = (o = {}) => ({ '/redfish/v1/Systems': { Members: [{ '@odata.id': '/redfish/v1/Systems/System.Embedded.1' }] },
  '/redfish/v1/Systems/System.Embedded.1': { Manufacturer: 'Dell Inc.', Model: 'PowerEdge R750', SKU: 'SYNTH01', HostName: 'synth-os-01', ...o },
  '/redfish/v1/Managers': { Members: [{ '@odata.id': '/redfish/v1/Managers/iDRAC.Embedded.1' }] },
  '/redfish/v1/Managers/iDRAC.Embedded.1': { FirmwareVersion: '7.00.00.171', Model: '15G Monolithic' } });
const ATTR = '/redfish/v1/Managers/System.Embedded.1/Attributes';
const SEL = `${ATTR}?$select=Attributes/ServerOS.1.OSName,Attributes/ServerOS.1.OSVersion`;
test('⑦ fetchInventory — Dell ServerOS 속성을 $select 로(4xx 면 한 번만 전체로 · 404 는 다시 묻지 않음) · HPE HostOS', async () => {
  const run = async (routes, entry = {}) => {
    const seen = [];
    const { srv, base } = await fakeRedfish(routes, seen);
    try { return { inv: await fetchInventory({ host: base, username: 'u', password: 'p', ...entry }), seen }; } finally { srv.close(); }
  };
  // a) $select 응답
  let r = await run({ ...SYS(), [SEL]: { Attributes: { 'ServerOS.1.OSName': 'Red Hat Enterprise Linux', 'ServerOS.1.OSVersion': '9.2' } } });
  assert.deepEqual([r.inv.system.osName, r.inv.system.osVersion], ['Red Hat Enterprise Linux', '9.2']);
  assert.equal(r.seen.filter((x) => x.startsWith(ATTR)).length, 1, '$select 한 번');
  // b) $select 를 모르는 펌웨어(400) → 전체로 한 번
  r = await run({ ...SYS(), [SEL]: 400, [ATTR]: { Attributes: { 'ServerOS.1.OSName': 'VMware ESXi', 'ServerOS.1.OSVersion': '8.0.2', Other: 'x' } } });
  assert.deepEqual([r.inv.system.osName, r.inv.system.osVersion], ['VMware ESXi', '8.0.2']);
  assert.equal(r.seen.filter((x) => x.startsWith(ATTR)).length, 2, '$select 400 → 전체 1회');
  // c) 속성 자원 없음(404 — iDRAC8 등) → 다시 묻지 않고 빈 값
  r = await run({ ...SYS() });
  assert.equal(r.inv.system.osName, undefined); assert.equal(r.seen.filter((x) => x.startsWith(ATTR)).length, 1, '404 는 다시 묻지 않는다');
  assert.equal(r.inv.collections.system, 'ok', 'OS 실패는 인벤토리 판정을 바꾸지 않는다');
  // d) iSM 없음(빈 문자열) → 키 없음
  r = await run({ ...SYS(), [SEL]: { Attributes: { 'ServerOS.1.OSName': '', 'ServerOS.1.OSVersion': '' } } });
  assert.equal('osName' in r.inv.system, false);
  // e) HPE — System 응답 Oem.Hpe.HostOS, Dell 속성은 묻지 않는다
  r = await run({ ...SYS({ Manufacturer: 'HPE', Oem: { Hpe: { HostOS: { OsName: 'Microsoft Windows Server 2022 Standard', OsVersion: '10.0.20348' } } } }) }, { vendor: 'hpe' });
  assert.deepEqual([r.inv.system.osName, r.inv.system.osVersion], ['Microsoft Windows Server 2022 Standard', '10.0.20348']);
  assert.equal(r.seen.filter((x) => x.startsWith(ATTR)).length, 0, 'HPE 는 Dell 속성을 묻지 않는다');
  // f) 제조사를 모르면(Dell 이 아님) 묻지 않는다 — 비 Dell BMC 에 요청을 늘리지 않게
  r = await run({ ...SYS({ Manufacturer: 'Synth Vendor' }) });
  assert.equal(r.seen.filter((x) => x.startsWith(ATTR)).length, 0);
});

// ───────── ⑧ 목록 · 상세 응답 ─────────
const routes = new Map();
const reg = { get: (p, ...h) => routes.set(`GET ${p}`, h.at(-1)), post: (p, ...h) => routes.set(`POST ${p}`, h.at(-1)) };
registerBmFolders(reg); svcinv.registerSvcInventory(reg);
const ADMIN = { username: 'admin', role: 'admin', scope: { vcenters: [], regions: [], writeVcenters: [] } };
const VIEWER = { username: 'viewer1', role: 'viewer', scope: { vcenters: [], regions: [], writeVcenters: [] } };
const SCOPED_A = { username: 'scoped-a', role: 'admin', scope: { vcenters: ['vc-a'], regions: [], writeVcenters: [] } };
const SCOPED_B = { username: 'scoped-b', role: 'admin', scope: { vcenters: ['vc-b'], regions: [], writeVcenters: [] } };
let gen = 0;
async function call(key, { user = ADMIN, query = {}, body = {} } = {}) {
  const res = { statusCode: 200, headers: {}, body: undefined, headersSent: false,
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; this.headersSent = true; return this; },
    setHeader(k, v) { this.headers[k] = v; }, set(k, v) { this.headers[k] = v; return this; }, end() { this.headersSent = true; return this; }, send(x) { this.body = x; this.headersSent = true; return this; } };
  await routes.get(key)({ user, query, body, ip: '127.0.0.1', headers: {}, originalUrl: `${key.replace(/^\w+ /, '/api')}?${new URLSearchParams(query)}&u=${user.username}&g=${gen}` }, res);
  return res;
}
const snapOf = () => ({ ...store.snapshot, initial: false, generatedAt: Date.now() + 1000 + (gen += 7),
  vcenters: [{ id: 'vc-a', name: 'vcenter-a', status: 'ok' }, { id: 'vc-b', name: 'vcenter-b', status: 'ok' }], hosts: [], vms: [] });
const withSnap = async (fn) => { const prev = store.snapshot; try { store.snapshot = snapOf(); return await fn(); } finally { store.snapshot = prev; } };
function reset() {
  bs._resetForTest(); sm._resetForTest(); fleet.resetEdgeFleet();
  for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f), { recursive: true, force: true });
  fs.writeFileSync(path.join(tmp, 'service-map.json'), JSON.stringify({ rev: 0, globals: [], settings: { tagCategory: '' }, corps: {} }));
  fs.writeFileSync(path.join(tmp, 'service-map-pins.json'), JSON.stringify({ rev: 0, pins: {} }));
  // 관리 주소에 태그가 든 Dell 기본 이름 — 범위 판본에서 태그를 가리는지 본다
  registry.importServers([{ id: 's1', name: 'synth-db-01', host: 'https://idrac-synth01.example.test', username: 'root', password: 'x', serviceTag: 'SYNTH01', vcenterId: 'vc-a' }], 'replace');
  invCache.setInventory('s1', INV());
  cstate.clearCollectorHosts('c1'); rinv.clearCollectorServers('c1');
}

test('⑧ 목록 — 관리자: 요약 · OS 호스트명 · 관리 주소 / 비관리자: 요약만(주소 · 호스트명 없음) / 범위 관리자: 주소 속 태그를 가린다', async () => {
  reset();
  await withSnap(async () => {
    const a = (await call('GET /tools/bm-folders')).body.servers.find((x) => x.name === 'synth-db-01');
    assert.equal(a.hw.cpu.cores, 48); assert.deepEqual(a.hw.hba, { n: 1, ports: 2 }); assert.equal(a.hw.os.name, 'Red Hat Enterprise Linux');
    assert.equal(a.hw.host, 'synth-os-01'); assert.equal(a.addr, 'idrac-synth01.example.test'); assert.equal(a.hwVia, 'local');
    const v = (await call('GET /tools/bm-folders', { user: VIEWER })).body.servers.find((x) => x.model === 'PowerEdge R750' || x.hw);
    assert.ok(v && v.hw, '비관리자도 하드웨어 요약은 본다');
    assert.equal(v.hw.host, '', 'OS 호스트명은 관리자 판본만'); assert.equal(v.addr, undefined, '관리 주소는 관리자 판본만');
    const sa = (await call('GET /tools/bm-folders', { user: SCOPED_A })).body.servers.find((x) => x.hw);
    assert.ok(sa); assert.equal(/synth01/i.test(sa.addr || ''), false, `범위 판본 주소에 태그가 남으면 안 된다: ${sa.addr}`);
    assert.equal(sa.hw.host, 'synth-os-01', '호스트명에 태그가 없으면 그대로');
    const sb = (await call('GET /tools/bm-folders', { user: SCOPED_B })).body.servers;
    assert.equal(sb.some((x) => x.hw?.cpu?.cores === 48), false, '범위 밖 서버는 목록에 없다');
  });
});

test('⑧ 상세 /hw — 관리자: 부품 목록 · 관리 NIC IPv4 · 호스트명 / 비관리자: 가림 / 범위 밖 · 없는 키 404 / ESXi 아님', async () => {
  reset();
  await withSnap(async () => {
    const key = (await call('GET /tools/bm-folders')).body.servers.find((x) => x.name === 'synth-db-01').key;
    const a = (await call('GET /tools/bm-folders/hw', { query: { key } })).body;
    assert.equal(a.via, 'local'); assert.equal(a.addr, 'idrac-synth01.example.test');
    assert.equal(a.detail.idrac.ipv4, '192.0.2.50'); assert.equal(a.detail.os.host, 'synth-os-01');
    assert.deepEqual(a.detail.hbas, [{ model: FC_MODEL, ports: 2 }]);
    assert.deepEqual(a.detail.disks.map((x) => [x.model, x.n]), [['SYNTH-SSD', 2], ['SYNTH-NVME', 1], ['SYNTH-HDD', 1]]);
    assert.deepEqual(a.detail.nics.map((x) => [x.model, x.ports, x.up]), [['Broadcom Gigabit Ethernet BCM5720', 2, 1], ['Mellanox ConnectX-6 Lx 25GbE', 2, 2]], 'FC 는 NIC 목록에 없다');
    const vkey = (await call('GET /tools/bm-folders', { user: VIEWER })).body.servers.find((x) => x.hw).key;
    const v = (await call('GET /tools/bm-folders/hw', { user: VIEWER, query: { key: vkey } })).body;
    assert.equal(v.addr, undefined); assert.equal('ipv4' in v.detail.idrac, false); assert.equal(v.detail.os.host, ''); assert.equal(v.detail.summary.host, '');
    const skey = (await call('GET /tools/bm-folders', { user: SCOPED_A })).body.servers.find((x) => x.hw).key;
    const s = (await call('GET /tools/bm-folders/hw', { user: SCOPED_A, query: { key: skey } })).body;
    assert.equal('ipv4' in s.detail.idrac, false, '관리 NIC IPv4 는 전체 범위 관리자만'); assert.equal(/synth01/i.test(s.addr || ''), false);
    assert.equal((await call('GET /tools/bm-folders/hw', { user: SCOPED_B, query: { key: skey } })).statusCode, 404, '범위 밖은 404(존재 은닉)');
    assert.equal((await call('GET /tools/bm-folders/hw', { user: SCOPED_B, query: { key } })).statusCode, 404);
    assert.equal((await call('GET /tools/bm-folders/hw', { query: { key: 'st:nope' } })).statusCode, 404);
    assert.equal((await call('GET /tools/bm-folders/hw', { query: { key: ['x'] } })).statusCode, 404, '배열 키는 글자가 아니다');
  });
});

test('⑧ 수집 서버 경로 — 축약 인벤토리로 요약 · 상세, 관리 주소는 그 수집 서버가 보낸 iDRAC 주소', async () => {
  reset();
  fs.writeFileSync(path.join(tmp, 'collectors.json'), JSON.stringify({ collectors: [{ id: 'c1', name: 'synth-site', url: 'https://192.0.2.200:8443', enabled: true, vcenterId: 'vc-b' }] }));
  cstate.setCollectorStatus('c1', { ok: true, hosts: 1, at: Date.now() });
  rinv.setCollectorServers('c1', 'SY', [{ id: 'r1', name: 'synth-app-02', serviceTag: 'SYNTH02', host: 'https://192.0.2.21', inv: compactInv(INV({ system: { ...INV().system, serviceTag: 'SYNTH02', osName: 'Ubuntu', osVersion: '22.04' } })) }]);
  cstate.setRemoteHost('192.0.2.21', { watts: 300, ts: Date.now(), collectorId: 'c1', serverName: 'synth-app-02', serverId: 'r1', serviceTag: 'SYNTH02', vcenterId: 'vc-b', source: 'remote', dbKey: 'rmt:192.0.2.21' });
  await withSnap(async () => {
    const row = (await call('GET /tools/bm-folders')).body.servers.find((x) => x.name === 'synth-app-02');
    assert.ok(row, '수집 서버 서버가 목록에 있다');
    assert.equal(row.hwVia, 'remote'); assert.deepEqual(row.hw.os, { name: 'Ubuntu', ver: '22.04' }); assert.equal(row.addr, '192.0.2.21');
    const d = (await call('GET /tools/bm-folders/hw', { query: { key: row.key } })).body;
    assert.equal(d.via, 'remote'); assert.equal(d.detail.hbas.length, 1); assert.equal(d.addr, '192.0.2.21');
  });
});

test('⑧ 엣지가 올린 서버 — 요약만(상세 summary-only) · 요약이 없으면 edge-none · 주소는 엣지가 보낸 값', async (t) => {
  // 엣지 push 베어메탈은 중앙(central.token 있음 · agent.centralUrl 없음)일 때만 함대에 병합된다(insights/fleetInventory.js)
  const { config } = await import('../src/config.js');
  const prevTok = config.central.token; config.central.token = 'synth-central-token';
  t.after(() => { config.central.token = prevTok; });
  reset();
  const hw = H.hwSummaryOf(INV());
  fleet.setEdgeFleet('synth-edge', [{ fleetId: 'synth03', name: 'synth-edge-03', serviceTag: 'SYNTH03', vcenterId: 'vc-a', source: 'idrac', hw, mgmtHost: '192.0.2.33' },
    { fleetId: 'synth04', name: 'synth-edge-04', serviceTag: 'SYNTH04', vcenterId: 'vc-a', source: 'idrac' }], 'g1', { vcAllowed: () => true });
  await withSnap(async () => {
    const rows = (await call('GET /tools/bm-folders')).body.servers;
    const e3 = rows.find((x) => x.name === 'synth-edge-03'); const e4 = rows.find((x) => x.name === 'synth-edge-04');
    assert.ok(e3 && e4, JSON.stringify(rows.map((x) => x.name)));
    assert.equal(e3.hwVia, 'edge'); assert.equal(e3.hw.cpu.cores, 48); assert.equal(e3.addr, '192.0.2.33');
    assert.deepEqual([e4.hwVia, e4.hw], ['edge', null], '구버전 엣지 — 요약 없음(지어내지 않는다)');
    const d3 = (await call('GET /tools/bm-folders/hw', { query: { key: e3.key } })).body;
    assert.equal(d3.why, 'summary-only'); assert.equal(d3.summary.cpu.cores, 48); assert.equal(d3.detail, undefined);
    const d4 = (await call('GET /tools/bm-folders/hw', { query: { key: e4.key } })).body;
    assert.equal(d4.why, 'edge-none');
  });
});

// ───────── ⑨ 엣지 → 중앙 실제 push(진입 함수를 실제로 부른다 — CLAUDE.md 테스트 규약) ─────────
test('⑨ 엣지 pushFleetNow 가 하드웨어 요약 · iDRAC 주소를 싣고, 중앙 정제를 거쳐 물리서버 폴더 행이 된다', async (t) => {
  const http = await import('node:http');
  const zlib = await import('node:zlib');
  const got = [];
  const central = http.createServer((q, r) => {
    const ch = []; q.on('data', (c) => ch.push(c));
    q.on('end', () => {
      let b = Buffer.concat(ch); if ((q.headers['content-encoding'] || '') === 'gzip') b = zlib.gunzipSync(b);
      let body = null; try { body = JSON.parse(b.toString('utf8') || 'null'); } catch { body = null; }
      got.push({ path: q.url.split('?')[0], body });
      r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ ok: true, accepted: Array.isArray(body?.baremetal) ? body.baremetal.length : 0 }));
    });
  });
  await new Promise((ok) => central.listen(0, '127.0.0.1', ok));
  const { config } = await import('../src/config.js');
  const prev = { url: config.agent.centralUrl, tok: config.agent.centralToken, name: config.agent.name, ctok: config.central.token };
  t.after(() => { central.close(); Object.assign(config.agent, { centralUrl: prev.url, centralToken: prev.tok, name: prev.name }); config.central.token = prev.ctok; });
  reset();
  config.agent.centralUrl = `http://127.0.0.1:${central.address().port}`; config.agent.centralToken = 'synth-edge-token'; config.agent.name = 'synth-edge';
  const fp = await import('../src/agent/fleetPush.js');
  fp._setFleetWithholdSinceForTest(null, null);
  const w = console.warn; const l = console.log; console.warn = () => {}; console.log = () => {};
  let r;
  try { r = await withSnap(() => fp.pushFleetNow()); } finally { console.warn = w; console.log = l; }
  assert.equal(r?.ok, true, JSON.stringify(r));
  const f = got.find((g) => g.path === '/api/central/fleet');
  assert.ok(f, '목 중앙에 도착');
  const b = f.body.baremetal.find((x) => x.serviceTag === 'SYNTH01');
  assert.ok(b, JSON.stringify(f.body.baremetal));
  assert.equal(b.hw.cpu.cores, 48); assert.deepEqual(b.hw.hba, { n: 1, ports: 2 }); assert.equal(b.hw.os.name, 'Red Hat Enterprise Linux');
  assert.equal(b.mgmtHost, 'idrac-synth01.example.test', '등록부 주소에서 스킴을 뗀 호스트');
  // 중앙 쪽: 같은 본문을 받으면 정제본이 함대 행에 실린다
  config.agent.centralUrl = prev.url;   // 이제 이 프로세스를 중앙으로
  fleet.resetEdgeFleet();
  fleet.setEdgeFleet('synth-edge', f.body.baremetal.map((x) => ({ ...x, vcenterId: 'vc-a' })), 'g1');
  const s = fleet.getEdgeFleetServers().find((x) => x.serviceTag === 'SYNTH01');
  assert.deepEqual(s.hw, b.hw); assert.equal(s.mgmtHost, 'idrac-synth01.example.test');
  fleet.resetEdgeFleet();
});
