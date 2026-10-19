// v2.744 감사 수정 그룹 GG — IP 원장(ipam/ledger.js)과 IP 관리상태 일괄 적용(ipam/overrides.js · routes/api/ipamExport.js).
//  · VC-01: FQDN 으로 vCenter 에 등록한 ESXi 호스트의 관리 IP(host.mgmtIp — 수집기가 첫 vnic 에서 싣는다)를 원장이 쓰지 않아,
//    스캔에 잡힌 그 IP 가 '(네트워크 스캔)' 미지 장비로 보이고 같은 IP 를 쓰는 다른 vCenter VM 과의 충돌도 잡히지 않았다(재현).
//  · WEB-02: 일괄 적용이 무효 IP 토큰(10.250.1.300 · 10.250.1)을 조용히 버리고 나머지만 적용했다 — 단건 PUT 은 같은 값을 400 으로 거부한다.
// 시각: 원장 행 판정은 시각에 기대지 않는다(예약 만료만 시각을 보는데 이 테스트는 예약 만료를 쓰지 않는다). 스캔 표본 시각은 정시 −30분 고정.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744g-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'true';
// 범위 계정 일괄 적용의 claimedVcenterId 가 '알 수 없는 vCenter' 로 먼저 걸리지 않게 등록부에 둔다(접속하지 않는다 — 주소는 .invalid).
fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: 'vc1', name: 'VC1', host: 'https://vc1.example.invalid', username: 'u', password: 'p', enabled: false },
] }));

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;

let ledger; let st; let ss; let settings; let ov;
const USERS = {
  op: { username: 'op', role: 'operator' },
  opA: { username: 'opA', role: 'operator', scope: { vcenters: ['vc1'] } },
};
let server; let base;
before(async () => {
  ledger = await import('../src/ipam/ledger.js');
  st = await import('../src/store.js');
  ss = await import('../src/ipam/scanStore.js');
  settings = await import('../src/ipam/settings.js');
  ov = await import('../src/ipam/overrides.js');
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => {
  try { server?.close(); } catch { /* */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
});

async function call(u, method, p, body) {
  const r = await fetch(`${base}${p}`, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* */ }
  return { status: r.status, body: j };
}

let gen = 0;
const snapOf = (hosts, vms = []) => ({
  generatedAt: `g2744-${++gen}`,
  vcenters: [{ id: 'vc1', name: 'VC1', status: 'connected' }, { id: 'vc2', name: 'VC2', status: 'connected' }],
  hosts, vms, datastores: [], networks: [], alarms: [],
});
const fqdnHost = (over = {}) => ({ id: 'vc1:host-1', vcenterId: 'vc1', name: 'esx01.corp.local', mgmtIp: '10.20.0.11', connectionState: 'CONNECTED', powerState: 'POWERED_ON', version: '8.0.2', cluster: 'C1', ...over });
const rowsAt = (out, ip) => out.rows.filter((r) => r.ip === ip);

// ---------------------------------------------------------------- VC-01

test('VC-01 ① FQDN 호스트의 관리 IP(mgmtIp)가 원장에 host 행으로 들어가고, 스캔된 같은 IP 는 미지 장비로 보이지 않는다', () => {
  ss.mergeScanResults([{ ip: '10.20.0.11', openPorts: [443, 902], services: ['https'], hostname: '' }], NOW, '__local__');
  const out = ledger.buildIpamRows(snapOf([fqdnHost()]), '', null);
  const at = rowsAt(out, '10.20.0.11');
  assert.equal(at.length, 1, `행 1개여야 한다: ${JSON.stringify(at.map((r) => r.ownerType))}`);
  const r = at[0];
  assert.equal(r.ownerType, 'host');
  assert.equal(r.serverType, 'BareMetal');
  assert.equal(r.vcenterId, 'vc1');
  assert.equal(r.vcenterName, 'VC1');
  assert.equal(r.ownerName, 'esx01.corp.local', 'ownerName 은 FQDN');
  assert.equal(r.hostName, 'esx01.corp.local', 'hostName 은 FQDN');
  assert.equal(r.discovery, 'both', 'vCenter 가 알고 스캔에도 잡혔다');
  assert.equal(r.ipNum, 0x0a14000b);
  assert.equal(out.rows.filter((x) => x.ownerType === 'scanned' && x.ip === '10.20.0.11').length, 0);
});

test('VC-01 ② FQDN 호스트 관리 IP 를 다른 vCenter VM 이 쓰면 두 행 모두 충돌(conflict)로 표시된다', () => {
  const vm = { id: 'vc2:vm-9', vcenterId: 'vc2', name: 'dupvm', ipAddresses: ['10.20.0.11'], ipAddress: '10.20.0.11', powerState: 'POWERED_ON', guestOS: 'Ubuntu', host: 'esx77', cluster: 'K' };
  const out = ledger.buildIpamRows(snapOf([fqdnHost()], [vm]), '', null);
  const at = rowsAt(out, '10.20.0.11');
  assert.deepEqual(at.map((r) => r.ownerType).sort(), ['host', 'vm']);
  for (const r of at) {
    assert.equal(r.reconcile, 'conflict', `${r.ownerType} 행이 충돌이 아니다`);
    assert.deepEqual([...r.conflictVcenters].sort(), ['vc1', 'vc2']);
    assert.equal(r.duplicate, true);
  }
  // 쓰기 범위 판정의 소유 맵도 같은 IP 를 그 호스트의 vCenter 로 본다(원장과 판정이 어긋나지 않게).
  const owners = ledger.ipVcenterOwners(snapOf([fqdnHost()], [vm]));
  assert.deepEqual([...(owners.get('10.20.0.11') || [])].sort(), ['vc1', 'vc2']);
});

test('VC-01 ①-b 다른 vCenter 를 고른 조회에서도 그 관리 IP 는 스캔 미지 장비로 보이지 않는다(known 은 전체 기준)', () => {
  ss.mergeScanResults([{ ip: '10.20.0.11', openPorts: [443], services: [], hostname: '' }], NOW, '__local__');
  const out = ledger.buildIpamRows(snapOf([fqdnHost()]), 'vc2', null);
  assert.equal(rowsAt(out, '10.20.0.11').length, 0, JSON.stringify(rowsAt(out, '10.20.0.11').map((r) => r.ownerType)));
});

test('VC-01 ③ 이름이 IP 인 호스트는 예전 그대로(이름이 관리 IP) · 비정규·IPv6·빈 mgmtIp 는 관리 IP 로 쓰지 않는다', () => {
  const hosts = [
    { id: 'vc1:host-2', vcenterId: 'vc1', name: '10.20.0.12', mgmtIp: '10.20.0.99', version: '8.0', cluster: 'C1' }, // 이름 우선
    fqdnHost({ id: 'vc1:host-3', name: 'esx03.corp.local', mgmtIp: '010.20.0.13' }), // 비정규(8진 오해석 위험) → 쓰지 않는다
    fqdnHost({ id: 'vc1:host-4', name: 'esx04.corp.local', mgmtIp: 'fe80::1' }),
    fqdnHost({ id: 'vc1:host-5', name: 'esx05.corp.local', mgmtIp: '' }),
    fqdnHost({ id: 'vc1:host-6', name: 'esx06.corp.local', mgmtIp: '0.0.0.0' }), // 미설정 표기
  ];
  const out = ledger.buildIpamRows(snapOf(hosts), '', null);
  const hostRows = out.rows.filter((r) => r.ownerType === 'host');
  assert.deepEqual(hostRows.map((r) => r.ip), ['10.20.0.12']);
  assert.equal(hostRows[0].ownerName, '10.20.0.12');
  assert.equal(rowsAt(out, '10.20.0.99').length, 0);
  assert.equal(rowsAt(out, '10.20.0.13').length, 0);
});

test('VC-01 ④ 무시 대역에 든 관리 IP 는 원장에서 숨긴다(이름 IP 호스트와 같은 판정)', () => {
  const before = ledger.buildIpamRows(snapOf([fqdnHost({ mgmtIp: '10.30.9.5' })]), '', null);
  assert.equal(rowsAt(before, '10.30.9.5').length, 1, '무시 대역이 없으면 관리 IP 행이 있다');
  settings.saveSettings({ global: ['10.30.9.0/24'] });
  try {
    const out = ledger.buildIpamRows(snapOf([fqdnHost({ mgmtIp: '10.30.9.5' })]), '', null);
    assert.equal(rowsAt(out, '10.30.9.5').length, 0);
    // 그 vCenter 의 무시 대역도 같다
    settings.saveSettings({ vcenters: { vc1: ['10.30.9.0/24'] } });
    assert.equal(rowsAt(ledger.buildIpamRows(snapOf([fqdnHost({ mgmtIp: '10.30.9.5' })]), '', null), '10.30.9.5').length, 0);
  } finally { settings.saveSettings({}); }
});

test('VC-01 ⑤ 동기판·양보판 원장이 같은 결과를 낸다(생성기 하나)', async () => {
  const vm = { id: 'vc2:vm-9', vcenterId: 'vc2', name: 'dupvm', ipAddresses: ['10.20.0.11'], powerState: 'POWERED_ON', guestOS: 'Ubuntu', host: 'esx77', cluster: 'K' };
  const s1 = snapOf([fqdnHost(), fqdnHost({ id: 'vc2:h7', vcenterId: 'vc2', name: 'esx07.corp.local', mgmtIp: '10.20.0.17' })], [vm]);
  const sync = ledger.buildIpamRows(s1, '', null);
  const s2 = { ...s1, generatedAt: `g2744-${++gen}` }; // 캐시를 피한다
  const asyn = await ledger.buildIpamRowsAsync(s2, '', null, { sliceMs: 0 });
  assert.ok(asyn, '양보판이 취소되지 않아야 한다');
  const strip = (rows) => rows.map(({ owner, ...rest }) => rest);
  assert.ok(isDeepStrictEqual(strip(sync.rows), strip(asyn.rows)), '두 판의 행이 같아야 한다');
  assert.ok(sync.rows.some((r) => r.ownerType === 'host' && r.ip === '10.20.0.17'));
});

test('VC-01 ⑥ mgmtIp 를 바꾸면 원장 서명과 입력 지문이 함께 바뀐다(v2.619 계약)', () => {
  const rowSig = (s) => st.ledgerSignature(ledger.buildIpamRows(s).rows);
  for (const nv of ['10.20.0.12', '', '10.9.9.9', 'x']) {
    const a = snapOf([fqdnHost()]); const b = snapOf([fqdnHost({ mgmtIp: nv })]);
    const rowDiff = rowSig(a) !== rowSig(b);
    const inDiff = st.ledgerInputSignature(a) !== st.ledgerInputSignature(b);
    assert.ok(rowDiff, `mgmtIp=${JSON.stringify(nv)} 가 원장 서명을 바꿔야 한다(원장이 mgmtIp 를 읽는다)`);
    assert.ok(inDiff, `mgmtIp=${JSON.stringify(nv)} 가 원장 서명은 바꾸는데 입력 지문은 그대로다`);
  }
  // 원장과 무관한 호스트 필드는 여전히 입력 지문을 바꾸지 않는다(생략이 실제로 일어난다).
  const a = snapOf([fqdnHost()]); const b = snapOf([fqdnHost({ cpuUsagePct: 99, memTotalMB: 1 })]);
  assert.equal(st.ledgerInputSignature(a), st.ledgerInputSignature(b));
});

// ---------------------------------------------------------------- WEB-02

test('WEB-02 ① splitBatchIps — 토큰을 정규형 IP 와 무효 원문으로 나눈다(단건 PUT 과 같은 canonIp 판정)', () => {
  const r = ov.splitBatchIps('10.250.1.5, 10.250.1.300, 10.250.1\n010.250.1.6 10.250.1.5 10.250.1');
  assert.deepEqual(r.ips, ['10.250.1.5', '10.250.1.6']);
  assert.deepEqual(r.invalid, ['10.250.1.300', '10.250.1']);
  assert.equal(r.tokens.length, 6);
  const arr = ov.splitBatchIps(['10.250.1.5', ' bad ', '', null, '999.1.1.1']);
  assert.deepEqual(arr.ips, ['10.250.1.5']);
  assert.deepEqual(arr.invalid, ['bad', '999.1.1.1']);
  // 함수 직접 호출: rejectInvalid 면 아무것도 쓰지 않고 거부, 아니면(예전 계약) 적용하되 버린 것을 밝힌다.
  const rej = ov.setOverrideBatch(['10.250.8.1', '10.250.8.300'], { status: 'reserved' }, { username: 't' }, { rejectInvalid: true });
  assert.equal(rej.ok, false);
  assert.equal(rej.invalidCount, 1);
  assert.equal(ov.getOverride('10.250.8.1'), null);
  const len = ov.setOverrideBatch(['10.250.8.1', '10.250.8.300'], { status: 'reserved' }, { username: 't' });
  assert.equal(len.ok, true);
  assert.equal(len.changed, 1);
  assert.deepEqual(len.invalid, ['10.250.8.300']);
  assert.equal(len.invalidCount, 1);
  ov.clearOverride('10.250.8.1');
});

test('WEB-02 ② 일괄 적용에 무효 토큰이 하나라도 있으면 400 + invalid 목록이고 아무것도 저장하지 않는다', async () => {
  let r = await call('op', 'POST', '/tools/ipam/bulk', { ips: '10.250.1.5, 10.250.1.300, 10.250.1', status: 'reserved', note: 'audit' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.ok, false);
  assert.deepEqual(r.body.invalid, ['10.250.1.300', '10.250.1']);
  assert.equal(r.body.invalidCount, 2);
  assert.match(r.body.reason, /전체를 적용하지 않았습니다/);
  assert.equal((await call('op', 'GET', '/tools/ipam/ip/10.250.1.5')).body.override, null, '유효한 IP 도 저장되면 안 된다');
  // 배열 입력도 같은 판정
  r = await call('op', 'POST', '/tools/ipam/bulk', { ips: ['10.250.1.5', '10.250.1.300', '10.250.1.7', '10.250.1'], status: 'reserved' });
  assert.equal(r.status, 400);
  assert.equal(r.body.invalidCount, 2);
  assert.equal(ov.getOverride('10.250.1.5'), null);
  assert.equal(ov.getOverride('10.250.1.7'), null);
});

test('WEB-02 ③ 유효한 토큰만이면 예전처럼 적용된다 · 범위 계정도 무효 토큰이면 범위 판정보다 먼저 400', async () => {
  const r = await call('op', 'POST', '/tools/ipam/bulk', { ips: '10.250.2.5, 10.250.2.6', status: 'reserved' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.changed, 2);
  assert.equal(ov.getOverride('10.250.2.5')?.status, 'reserved');
  const s = await call('opA', 'POST', '/tools/ipam/bulk', { ips: ['10.250.3.5', 'nope'], status: 'reserved', claimedVcenterId: 'vc1' });
  assert.equal(s.status, 400, JSON.stringify(s.body));
  assert.deepEqual(s.body.invalid, ['nope']);
  ov.clearOverride('10.250.2.5'); ov.clearOverride('10.250.2.6');
});

test('WEB-02 ④ 무효 목록은 응답에서 상한으로 자르고 전체 개수를 밝힌다', async () => {
  const bad = Array.from({ length: 80 }, (_, i) => `10.250.9.${300 + i}`);
  const r = await call('op', 'POST', '/tools/ipam/bulk', { ips: ['10.250.9.1', ...bad], status: 'reserved' });
  assert.equal(r.status, 400);
  assert.equal(r.body.invalidCount, 80);
  assert.ok(r.body.invalid.length <= 50 && r.body.invalid.length > 0, `목록 상한: ${r.body.invalid.length}`);
  assert.equal(ov.getOverride('10.250.9.1'), null);
});
