// v2.728 — iDRAC 상세 '하드웨어/버전' 의 빠진 정보(엣지 위임 서버) · NIC 포트 중복·링크 판정 · 서버 부품 상태 요약.
//
// 사용자 신고(PowerEdge R640 · iDRAC 7.00.00.183 · 엣지 위임 서버): PSU 이름 칸 공백·입력 '—'·상태 '—', 디스크 이름 공백,
// NIC.Integrated.1-1~1-4 가 두 번씩(8개) 전부 ⛔. 원인 ① 엣지 compactInv 가 부품 이름·상태를 빼고 보냈고 중앙 INV_SHAPE 도
// 몰랐다(짝으로 넓혀야 한다) ② fetchInventory 가 NetworkPorts·Ports 두 컬렉션을 모두 따라가 URL 로만 중복을 걸렀다
// ③ 화면이 못 읽은 링크를 ⛔ 로 칠했다. 추가 요청: 서버 부품 장애를 화면에 보이고 기존 '파트 장애' 기능(기본 꺼짐)과 연결.
//
// 실제 네트워크는 쓰지 않는다 — 가짜 Redfish 는 루프백 HTTP 서버, 라우트는 실제 admin 라우터를 express 에 마운트한다.
// 픽스처 식별자는 전부 합성(SYNTH…)이다(공개 저장소 — v2.513 규약).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'idracinv2728-'));
process.env.CONFIG_DIR = DIR;
process.env.PARTFAULT_DB_PATH = path.join(DIR, 'part-faults.db');
process.env.AUTH_ENABLED = 'false';
process.env.DATA_SOURCE = 'live';         // mock 이면 파트 장애가 '데모로 켜짐' 이 된다 — 기본(꺼짐) 경로를 본다
process.env.IDRAC_TIMEOUT_MS = '1500';
delete process.env.PARTFAULT_ENABLED;

const { compactInv } = await import('../src/collector/agent.js');
const { sanitizeRemoteInv, setCollectorServers, sanitizeRemoteServers } = await import('../src/collector/remoteInventory.js');
const { nicLinkState, dedupNicPorts, dedupNics } = await import('../src/idrac/nicPorts.js');
const { inventoryView, statusFieldsMissing } = await import('../src/idrac/invView.js');
const { summarizeServerParts, serverPartsCell, pickServerOpenFaults, serverPartFaultInfo, PARTS_REASON, _resetServerPartsCacheForTest } = await import('../src/idrac/serverParts.js');
const { fetchInventory } = await import('../src/idrac/redfish.js');

const NOW = Date.now();

/** fetchInventory 결과 모양의 합성 인벤토리 — R640 신고 화면과 같은 구성(PSU 2 · 디스크 4 · NIC 포트 중복). */
function synthInv({ psu2Health = 'Critical', dupPorts = true } = {}) {
  const port = (k, link, extra = {}) => ({ id: `NIC.Integrated.1-${k}`, link, speedMbps: 1000, mac: `B0:26:28:00:00:0${k}`, ...extra });
  const ports = [1, 2, 3, 4].map((k) => port(k, k === 1 ? 'Up' : 'Down'));
  return {
    collectedAt: NOW - 5 * 60_000,
    reachable: true,
    collections: { system: 'ok', psus: 'ok', disks: 'ok', storageControllers: 'ok', memoryDimms: 'ok', cpus: 'ok', gpus: 'ok', pcie: 'ok', fans: 'ok' },
    system: { model: 'PowerEdge R640', serviceTag: 'SYNTH01', biosVersion: '2.19.1', hostName: 'synth-r640', health: 'Critical', serialNumber: 'SYNTHSN-DROP', uuid: 'u-1' },
    cpu: { model: 'Xeon SYNTH', count: 2, cores: 48, health: 'OK' },
    memory: { totalGiB: 384, health: 'OK' },
    health: { overall: 'Critical', processor: 'OK', memory: 'OK', storage: 'OK', psu: 'Warning', fan: 'OK', battery: 'OK' },
    psus: [
      { name: 'PS1 Status', model: 'PWR SPLY,1100W', manufacturer: 'DELL', serial: 'SYNTHPS1-DROP', partNumber: 'PN-DROP', capacityWatts: 1100, inputWatts: 182, outputWatts: 170, lineInputVoltage: 230, health: 'OK', state: 'Enabled', firmware: 'FW-DROP' },
      { name: 'PS2 Status', model: 'PWR SPLY,1100W', manufacturer: 'DELL', serial: 'SYNTHPS2-DROP', capacityWatts: 1100, inputWatts: null, outputWatts: null, lineInputVoltage: 0, health: psu2Health, state: 'Enabled' },
    ],
    disks: [1, 2, 3, 4].map((i) => ({ name: `Physical Disk 0:1:${i}`, model: 'ST1200MM', serial: `SYNTHD${i}-DROP`, capacityGB: 1200, media: 'HDD', protocol: 'SAS', health: 'OK', state: 'Enabled', predictiveFailure: i === 4 ? null : false, rpm: 10000 })),
    memoryDimms: [
      { locator: 'DIMM.Socket.A1', sizeGB: 32, type: 'DDR4', speedMHz: 2933, manufacturer: 'SYNTH', partNumber: 'PN', serial: 'M-DROP', health: 'OK', state: 'Enabled' },
      { locator: 'DIMM.Socket.A2', sizeGB: null, type: '', health: '', state: 'Absent' },
    ],
    cpus: [{ socket: 'CPU.Socket.1', model: 'Xeon SYNTH', cores: 24, health: 'OK', state: 'Enabled' }, { socket: 'CPU.Socket.2', model: 'Xeon SYNTH', cores: 24, health: '', state: 'Enabled' }],
    gpus: [],
    storageControllers: [{ name: 'PERC H730P Mini', model: 'PERC H730P Mini', firmware: '25.5', protocols: 'SAS/SATA', health: 'OK' }],
    pcie: [{ name: 'BOSS-S1', model: 'BOSS-S1', manufacturer: 'DELL', deviceType: 'SingleFunction', health: 'OK' }],
    fans: [{ name: 'System Board Fan1A', model: '', partNumber: '', health: 'OK' }],
    nics: [{ name: 'NIC.Integrated.1', model: 'BRCM GbE 4P 5720-t rNDC', ports: dupPorts ? ports.concat(ports.map((p) => ({ ...p, link: p.link === 'Up' ? 'LinkUp' : 'LinkDown' }))) : ports }],
    firmware: [{ type: 'iDRAC', version: '7.00.00.183', name: 'Integrated Dell Remote Access Controller' }],
    idrac: { firmwareVersion: '7.00.00.183' },
    bios: { version: '2.19.1' },
  };
}

/** 2.728 이전 엣지의 축약 인벤토리 — 부품 health·state·이름 키가 **없다**(옛 compactInv 모양). */
function legacyCompact() {
  return {
    system: { model: 'PowerEdge R640', serviceTag: 'SYNTH02', biosVersion: '2.19.1', hostName: 'synth-old' },
    cpu: { model: 'Xeon SYNTH', count: 2, cores: 48 }, memory: { totalGiB: 384 }, gpus: [],
    firmware: [], nics: [{ name: 'NIC.Integrated.1', model: 'BRCM GbE 4P 5720-t rNDC', ports: [
      { id: 'NIC.Integrated.1-1', link: 'Up', speedMbps: 1000 }, { id: 'NIC.Integrated.1-1', link: 'LinkUp', speedMbps: 1000 },
    ] }],
    cpus: [{ socket: 'CPU.Socket.1', model: 'Xeon SYNTH', cores: 24 }],
    disks: [{ model: 'ST1200MM', capacityGB: 1200, media: 'HDD', protocol: 'SAS' }],
    psus: [{ model: 'PWR SPLY,1100W', manufacturer: 'DELL', capacityWatts: 1100 }],
    memoryDimms: [{ sizeGB: 32, type: 'DDR4', speedMHz: 2933, manufacturer: 'SYNTH', partNumber: 'PN' }],
    storageControllers: [], pcie: [], fans: [], collectedAt: NOW - 60_000,
  };
}

test('① compactInv → sanitizeRemoteInv 왕복: 부품 이름·상태·PSU 입력·예측 실패·롤업·컬렉션 메타가 살아남는다(짝)', () => {
  const c = compactInv(synthInv());
  const s = sanitizeRemoteInv(JSON.parse(JSON.stringify(c)));
  assert.deepEqual(s.psus[1], { name: 'PS2 Status', model: 'PWR SPLY,1100W', manufacturer: 'DELL', capacityWatts: 1100, inputWatts: null, outputWatts: null, lineInputVoltage: 0, health: 'Critical', state: 'Enabled' });
  assert.equal(s.psus[0].inputWatts, 182); assert.equal(s.psus[0].lineInputVoltage, 230);
  assert.equal(s.disks[0].name, 'Physical Disk 0:1:1'); assert.equal(s.disks[0].health, 'OK');
  assert.equal(s.disks[0].predictiveFailure, false);
  assert.equal(s.disks[3].predictiveFailure, null, '미확인 예측 실패는 null 그대로(false 로 굳히지 않는다)');
  assert.equal(s.memoryDimms[0].locator, 'DIMM.Socket.A1'); assert.equal(s.memoryDimms[1].state, 'Absent');
  assert.equal(s.cpus[1].health, '', '못 읽은 상태도 키는 남는다(빈 값)');
  assert.equal(s.storageControllers[0].name, 'PERC H730P Mini'); assert.equal(s.storageControllers[0].health, 'OK');
  assert.equal(s.pcie[0].name, 'BOSS-S1'); assert.equal(s.fans[0].health, 'OK');
  assert.equal(s.system.health, 'Critical'); assert.equal(s.cpu.health, 'OK'); assert.equal(s.memory.health, 'OK');
  assert.equal(s.health.psu, 'Warning');
  assert.equal(s.collections.psus, 'ok'); assert.equal(s.reachable, true);
  // 자산 정보는 싣지 않는다
  for (const k of ['psus', 'disks', 'memoryDimms']) for (const x of c[k]) assert.ok(!('serial' in x), `${k} serial`);
  assert.ok(!('serialNumber' in c.system) && !('partNumber' in c.psus[0]) && !('firmware' in c.psus[0]));
});

test('② 수신 정제: 모르는 키·객체 값·잘못된 컬렉션 값은 버린다', () => {
  const evil = compactInv(synthInv());
  evil.psus[0].evil = 'x';
  evil.psus[0].health = { toString: () => 'OK' };
  evil.disks[0].predictiveFailure = 'yes';
  evil.collections = { psus: 'ok', disks: 'maybe', __proto__x: 'ok', constructor: 'failed', evilKey: 'ok' };
  evil.reachable = 'true';
  evil.health = { overall: { a: 1 }, psu: 'Warning', nope: 'x' };
  const s = sanitizeRemoteInv(evil);
  assert.ok(!('evil' in s.psus[0]));
  assert.equal(s.psus[0].health, null, '객체는 글자로 받지 않는다');
  assert.equal(s.disks[0].predictiveFailure, 'yes', '글자는 글자(scalar) — 판정(classify)은 === true 만 예측 실패로 본다');
  assert.deepEqual(s.collections, { psus: 'ok' }, "아는 키 + 'ok'|'failed' 만");
  assert.ok(!('reachable' in s), '불리언이 아니면 버린다');
  assert.deepEqual(Object.keys(s.health).sort(), ['overall', 'psu']);
  assert.equal(s.health.overall, null);
});

test('③ 링크 판정: Up·LinkUp=up / Down·LinkDown·NoLink·Disabled=down / 빈 값·Enabled·Starting·충돌=unknown', () => {
  for (const v of ['Up', 'LinkUp', 'linkup', ' up ']) assert.equal(nicLinkState(v), 'up', v);
  for (const v of ['Down', 'LinkDown', 'NoLink', 'Disabled', 'Link_Down']) assert.equal(nicLinkState(v), 'down', v);
  for (const v of ['', null, undefined, 'Enabled', 'Starting', 'Training', 'Unknown', 'Absent', 'StandbyOffline']) assert.equal(nicLinkState(v), 'unknown', String(v));
  assert.equal(nicLinkState('Up | LinkDown'), 'unknown', '두 출처가 다르게 말하면 모른다');
  assert.equal(nicLinkState('Up | LinkUp'), 'up');
});

test('④ NIC 포트 중복 제거: Id(대소문자 무시)로 묶고 링크·속도·MAC 을 아는 쪽을 남긴다', () => {
  const r = dedupNicPorts([
    { id: 'NIC.Integrated.1-1', link: '', speedMbps: null, mac: '' },
    { id: 'nic.integrated.1-1', link: 'LinkUp', speedMbps: 1000, mac: 'AA' },
    { id: 'NIC.Integrated.1-2', link: 'Up', speedMbps: 1000, mac: 'BB' },
    { id: 'NIC.Integrated.1-2', link: 'LinkDown', speedMbps: 10000, mac: 'CC' },
    { id: '', link: 'Up' }, { id: '', link: 'Down' },
  ]);
  assert.equal(r.length, 4, '같은 Id 두 쌍은 하나씩, Id 없는 둘은 묶지 않는다');
  assert.deepEqual(r[0], { id: 'NIC.Integrated.1-1', link: 'LinkUp', speedMbps: 1000, mac: 'AA' });
  assert.equal(r[1].link, 'Up | LinkDown'); assert.equal(nicLinkState(r[1].link), 'unknown');
  assert.equal(r[1].speedMbps, 10000); assert.equal(r[1].mac, 'BB');
  // 축약(엣지)과 수신(중앙) 둘 다 묶는다 — 구버전 엣지가 보낸 중복도 중앙에서 한 번으로.
  assert.equal(compactInv(synthInv()).nics[0].ports.length, 4);
  assert.equal(sanitizeRemoteInv(legacyCompact()).nics[0].ports.length, 1);
  assert.equal(dedupNics(null), null);
});

test('⑤ fetchInventory: NetworkPorts·Ports 두 컬렉션 + 컨트롤러 Links 로 같은 포트가 나와도 4개(예전 8개)', async () => {
  const CH = '/redfish/v1/Chassis/System.Embedded.1';
  const A = `${CH}/NetworkAdapters/NIC.Integrated.1`;
  const routes = {
    '/redfish/v1/Chassis': { Members: [{ '@odata.id': CH }] },
    [`${CH}/NetworkAdapters`]: { Members: [{ '@odata.id': A }] },
    [A]: {
      Id: 'NIC.Integrated.1', Model: 'BRCM GbE 4P 5720-t rNDC',
      NetworkPorts: { '@odata.id': `${A}/NetworkPorts` }, Ports: { '@odata.id': `${A}/Ports` },
      Controllers: [{ Links: { NetworkPorts: [{ '@odata.id': `${A}/NetworkPorts/NIC.Integrated.1-1` }], Ports: [{ '@odata.id': `${A}/Ports/NIC.Integrated.1-1` }] } }],
    },
    [`${A}/NetworkPorts`]: { Members: [1, 2, 3, 4].map((k) => ({ '@odata.id': `${A}/NetworkPorts/NIC.Integrated.1-${k}` })) },
    [`${A}/Ports`]: { Members: [1, 2, 3, 4].map((k) => ({ '@odata.id': `${A}/Ports/NIC.Integrated.1-${k}` })) },
  };
  for (const k of [1, 2, 3, 4]) {
    routes[`${A}/NetworkPorts/NIC.Integrated.1-${k}`] = { Id: `NIC.Integrated.1-${k}`, LinkStatus: k === 1 ? 'Up' : 'Down', SupportedLinkCapabilities: [{ LinkSpeedMbps: 1000 }], AssociatedNetworkAddresses: [`B0:26:28:00:00:0${k}`] };
    routes[`${A}/Ports/NIC.Integrated.1-${k}`] = { Id: `NIC.Integrated.1-${k}`, LinkStatus: k === 1 ? 'LinkUp' : 'LinkDown', CurrentSpeedGbps: k === 1 ? 1 : 0 };
  }
  const srv = createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const r = routes[p];
    res.writeHead(r ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r || { error: { message: 'synthetic 404' } }));
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    const inv = await fetchInventory({ id: 'x', host: `http://127.0.0.1:${srv.address().port}`, username: 'u', password: 'p' });
    const nic = inv.nics.find((n) => n.model === 'BRCM GbE 4P 5720-t rNDC');
    assert.ok(nic, 'rNDC 어댑터');
    assert.deepEqual(nic.ports.map((p) => p.id), ['NIC.Integrated.1-1', 'NIC.Integrated.1-2', 'NIC.Integrated.1-3', 'NIC.Integrated.1-4']);
    assert.equal(nicLinkState(nic.ports[0].link), 'up'); assert.equal(nicLinkState(nic.ports[1].link), 'down');
    assert.equal(nic.ports[0].mac, 'B0:26:28:00:00:01');
  } finally { await new Promise((ok) => srv.close(ok)); }
});

test('⑥ inventoryView: 부품마다 partState(파트 장애와 같은 판정) · 포트마다 linkState · 원본 불변', () => {
  const inv = synthInv();
  const before = JSON.stringify(inv);
  const v = inventoryView(inv);
  assert.equal(JSON.stringify(inv), before, '저장된 인벤토리를 고치지 않는다');
  assert.equal(v.psus[1].partState, 'fault'); assert.equal(v.psus[0].partState, 'ok');
  assert.equal(v.memoryDimms[1].partState, 'absent', '빈 슬롯은 장애가 아니다');
  assert.equal(v.cpus[1].partState, 'unknown', '상태 빈 값은 확인 불가(정상 아님)');
  assert.equal(v.nics[0].ports.length, 4);
  assert.deepEqual(v.nics[0].ports.map((p) => p.linkState), ['up', 'down', 'down', 'down']);
  assert.equal(inventoryView(null), null);
});

test('⑦ statusFieldsMissing: 키가 없음(구버전 엣지) ≠ 빈 값(못 읽음)', () => {
  assert.equal(statusFieldsMissing(legacyCompact()), true);
  assert.equal(statusFieldsMissing(sanitizeRemoteInv(legacyCompact())), true, '정제 뒤에도');
  assert.equal(statusFieldsMissing(sanitizeRemoteInv(compactInv(synthInv()))), false);
  const blank = compactInv({ ...synthInv(), collections: undefined, health: undefined });
  delete blank.collections; delete blank.health;
  for (const k of ['psus', 'disks', 'memoryDimms', 'cpus', 'gpus', 'fans']) for (const x of blank[k]) { x.health = ''; }
  assert.equal(statusFieldsMissing(blank), false, '새 엣지가 못 읽은 값(빈 문자열)은 구버전이 아니다');
  assert.equal(statusFieldsMissing({ system: { model: 'x' }, psus: [], disks: [] }), false, '부품 0개면 단정하지 않는다');
});

test('⑧ 부품 요약: fault/warn/unknown/absent 를 따로 세고 판정 불가는 사유로', () => {
  const sv = { id: 'synth-1', name: 'synth', serviceTag: 'SYNTH01' };
  const a = summarizeServerParts(sv, synthInv(), { now: NOW });
  assert.equal(a.judged, true);
  assert.equal(a.fault, 1, 'PSU 2 Critical'); assert.equal(a.absent, 1, 'DIMM A2 빈 슬롯'); assert.equal(a.unknown, 1, 'CPU 2 상태 빈 값');
  assert.equal(a.warn, 0);
  assert.equal(a.total, a.ok + a.warn + a.fault + a.unknown + a.absent);
  assert.deepEqual(a.faults.map((f) => [f.kind, f.label, f.state]), [['psu', 'PS2 Status', 'fault']]);
  assert.equal(a.stale, false);
  // 예측 실패(OK + true) → 경고
  const pf = synthInv({ psu2Health: 'OK' }); pf.disks[0].predictiveFailure = true;
  const b = summarizeServerParts(sv, pf, { now: NOW });
  assert.equal(b.fault, 0); assert.equal(b.warn, 1);
  // 판정 불가 4종 — 0 건이라 말하지 않는다
  assert.equal(summarizeServerParts(sv, null).reason, PARTS_REASON.noInventory);
  assert.equal(summarizeServerParts(sv, { ...synthInv(), reachable: false }).reason, PARTS_REASON.unreachable);
  const sysFail = synthInv(); sysFail.collections = { ...sysFail.collections, system: 'failed' };
  assert.equal(summarizeServerParts({ id: 'x' }, sysFail).reason, PARTS_REASON.systemFailed, '등록부 서비스태그가 없으면 키가 흔들린다');
  assert.equal(summarizeServerParts(sv, sanitizeRemoteInv(legacyCompact()), { remote: true }).reason, PARTS_REASON.edgeOld);
  for (const r of [null, { ...synthInv(), reachable: false }]) {
    const x = summarizeServerParts(sv, r);
    assert.equal(x.judged, false); assert.equal(x.fault, 0);
  }
  // 오래된 인벤토리는 숨기지 않고 stale
  const old = synthInv(); old.collectedAt = NOW - 3 * 3_600_000;
  assert.equal(summarizeServerParts(sv, old, { now: NOW }).stale, true);
  // 새 엣지 축약 → 중앙 정제 경로도 같은 판정
  const rem = summarizeServerParts(sv, sanitizeRemoteInv(compactInv(synthInv())), { now: NOW, remote: true });
  assert.equal(rem.judged, true); assert.equal(rem.fault, 1); assert.equal(rem.absent, 1);
});

test('⑨ 목록 칸 기억: 같은 수집 시각이면 다시 추출하지 않고, stale 은 지금 시각으로', () => {
  _resetServerPartsCacheForTest();
  const inv = synthInv();
  const a = serverPartsCell({ id: 's1', serviceTag: 'SYNTH01' }, inv, { now: NOW });
  assert.ok(!('faults' in a));
  inv.psus[1].health = 'OK';   // 같은 collectedAt — 기억에서 나온다(인벤토리는 수집마다 새 객체로 바뀐다)
  assert.equal(serverPartsCell({ id: 's1', serviceTag: 'SYNTH01' }, inv, { now: NOW }).fault, 1);
  assert.equal(serverPartsCell({ id: 's1', serviceTag: 'SYNTH01' }, inv, { now: NOW + 4 * 3_600_000 }).stale, true);
  assert.equal(serverPartsCell({ id: 's1', serviceTag: 'SYNTH01' }, { ...inv, collectedAt: NOW }, { now: NOW }).fault, 0, '새 수집이면 다시 계산');
});

test('⑩ 열린 장애 고르기: 서비스태그(장비 키)면 법인 무관, 없으면 장비 id + 수집 주체', () => {
  const rows = [
    { scope: 'idrac', deviceKey: 'SYNTH01', deviceId: '10.0.0.5', agent: 'edge-a', kind: 'psu', label: 'PS2', state: 'fault', holdReason: null },
    { scope: 'idrac', deviceKey: '10.0.0.9', deviceId: '10.0.0.9', agent: '', kind: 'disk', label: 'D1', state: 'warn', holdReason: 'device-failed' },
    { scope: 'idrac', deviceKey: '10.0.0.9', deviceId: '10.0.0.9', agent: 'edge-b', kind: 'disk', label: 'D9', state: 'fault' },
    { scope: 'storage', deviceKey: 'SYNTH01', deviceId: 'st-1', agent: '', kind: 'disk', label: 'X', state: 'fault' },
  ];
  assert.deepEqual(pickServerOpenFaults(rows, { id: 'any', serviceTag: 'synth01' }).open.map((o) => o.label), ['PS2']);
  assert.deepEqual(pickServerOpenFaults(rows, { id: '10.0.0.9' }, { agents: [''] }).open.map((o) => o.label), ['D1'], '같은 IP 다른 법인 행을 섞지 않는다');
  assert.deepEqual(pickServerOpenFaults(rows, { id: '10.0.0.9' }, { agents: ['EDGE-B'] }).open.map((o) => o.label), ['D9']);
  assert.equal(pickServerOpenFaults(rows, { id: '10.0.0.9' }, { agents: [''] }).open[0].holdReason, 'device-failed');
});

test('⑪ 파트 장애 연결: 꺼짐 · 엣지별 꺼짐 · DB 없으면 만들지 않는다', async () => {
  const deps = (o) => ({ enabled: () => o.en, forAgent: () => ({ enabled: o.edge }), exists: () => o.exists, open: async () => o.rows || [] });
  const off = await serverPartFaultInfo({ id: 'a', serviceTag: 'SYNTH01' }, {}, deps({ en: { enabled: false, source: 'default' }, exists: false }));
  assert.deepEqual([off.enabled, off.dbAvailable, off.open.length], [false, false, 0]);
  const edgeOff = await serverPartFaultInfo({ id: 'a' }, { remote: true, agents: ['edge-a'] }, deps({ en: { enabled: true, source: 'central' }, edge: false, exists: true }));
  assert.equal(edgeOff.edgeEnabled, false);
  const on = await serverPartFaultInfo({ id: 'a', serviceTag: 'SYNTH01' }, {}, deps({ en: { enabled: true, source: 'central' }, exists: true, rows: [{ scope: 'idrac', deviceKey: 'SYNTH01', deviceId: 'a', agent: '', kind: 'psu', label: 'PS2', state: 'fault' }] }));
  assert.equal(on.open.length, 1); assert.equal(on.dbAvailable, true);
  // 실제 의존(기본 꺼짐) — DB 파일을 새로 만들지 않는다
  const real = await serverPartFaultInfo({ id: 'a' }, {});
  assert.equal(real.enabled, false); assert.equal(real.dbAvailable, false);
  assert.equal(fs.existsSync(process.env.PARTFAULT_DB_PATH), false, '조회가 DB 를 만들지 않는다');
});

test('⑫ 라우트(실제 admin 라우터): 목록 ?parts=1 · 상세 inventory/parts/partFault · 원격 statusMissing', async () => {
  const { addServer } = await import('../src/idrac/registry.js');
  const { setInventory } = await import('../src/idrac/invCache.js');
  const add = addServer({ id: 'synth-local-1', name: 'synth-local-1', host: '10.0.0.5', username: 'root', password: 'x', serviceTag: 'SYNTH01' });
  assert.equal(add.ok, true, add.reason);
  setInventory('synth-local-1', synthInv());
  setCollectorServers('edge-a', 'Seoul', [
    { id: 'synth-remote-new', name: 'synth-remote-new', host: '10.9.0.1', serviceTag: 'SYNTH03', type: 'idrac', vendor: 'dell', inv: compactInv({ ...synthInv(), system: { ...synthInv().system, serviceTag: 'SYNTH03' } }) },
    { id: 'synth-remote-old', name: 'synth-remote-old', host: '10.9.0.2', serviceTag: 'SYNTH02', type: 'idrac', inv: legacyCompact() },
  ]);
  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express(); app.use(express.json()); app.use('/api/admin', adminRouter);
  const srv = app.listen(0); await new Promise((ok) => srv.once('listening', ok));
  const base = `http://127.0.0.1:${srv.address().port}/api/admin`;
  try {
    const plain = await (await fetch(`${base}/idrac`)).json();
    assert.ok(plain.servers.every((s) => !('parts' in s)), '기본(60초 폴링)은 요약을 싣지 않는다');
    const list = await (await fetch(`${base}/idrac?parts=1`)).json();
    const byId = new Map(list.servers.map((s) => [s.id, s]));
    assert.equal(byId.get('synth-local-1').parts.fault, 1);
    assert.equal(byId.get('synth-remote-new').parts.fault, 1);
    assert.equal(byId.get('synth-remote-old').parts.judged, false);
    assert.equal(byId.get('synth-remote-old').parts.reason, 'edge-old');

    const d = await (await fetch(`${base}/idrac/synth-local-1/inventory`)).json();
    assert.equal(d.ok, true);
    assert.equal(d.inventory.nics[0].ports.length, 4, '중복 저장된 캐시도 상세에서는 4개');
    assert.equal(d.inventory.nics[0].ports[0].linkState, 'up');
    assert.equal(d.inventory.psus[1].partState, 'fault');
    assert.equal(d.parts.fault, 1); assert.equal(d.parts.faults[0].label, 'PS2 Status');
    assert.equal(d.partFault.enabled, false); assert.equal(d.partFault.dbAvailable, false);
    assert.ok(!('statusMissing' in d), '로컬 서버에는 싣지 않는다');

    const rn = await (await fetch(`${base}/idrac/synth-remote-new/inventory`)).json();
    assert.equal(rn.remote, true); assert.equal(rn.statusMissing, false);
    assert.equal(rn.inventory.psus[0].name, 'PS1 Status'); assert.equal(rn.inventory.psus[0].inputWatts, 182);
    assert.equal(rn.inventory.disks[0].name, 'Physical Disk 0:1:1');
    assert.equal(rn.parts.fault, 1);
    assert.equal(rn.partFault.edgeEnabled, false, '중앙 기본값(꺼짐)이 그 엣지에 내려간다');

    const ro = await (await fetch(`${base}/idrac/synth-remote-old/inventory`)).json();
    assert.equal(ro.statusMissing, true); assert.equal(ro.parts.reason, 'edge-old');
    assert.equal(ro.inventory.nics[0].ports.length, 1, '구버전 엣지가 보낸 중복도 중앙에서 한 번');
    assert.equal(fs.existsSync(process.env.PARTFAULT_DB_PATH), false, '상세 조회가 파트 장애 DB 를 만들지 않는다');
  } finally { srv.close(); }
});

test('⑭ 판정 불가 사유 코드 ↔ 웹 문구 1:1(한쪽만 늘면 화면이 코드를 그대로 보인다)', async () => {
  const web = await import('../../web/src/views/idrac/hwStatusText.js');
  assert.deepEqual(Object.values(PARTS_REASON).sort(), Object.keys(web.PARTS_REASON_TEXT).sort());
});

test('⑬ 정제 경로 형식: sanitizeRemoteServers 가 새 인벤토리 필드를 그대로 넘긴다', () => {
  const { servers } = sanitizeRemoteServers([{ id: 'x1', inv: compactInv(synthInv()) }]);
  assert.equal(servers[0].inv.psus[1].health, 'Critical');
  assert.equal(servers[0].inv.collections.disks, 'ok');
});
