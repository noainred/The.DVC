/**
 * v2.920 — 호스트 ↔ SAN 조닝·트래픽 귀속 + CVP 업링크 매칭(설계 docs/design/san-cvp-traffic/README.md, 기본값 A 단계).
 *  ① 순수 귀속 엔진 — 확정(후보 1 + 네임서버 확정) · 추정(후보 2 → 타깃 포트 바이트 비율) · 분배 불가 · 조닝만 · 미확인 · 측정 없음(null — 0 금지) ·
 *     멀티패스 살아 있는 타깃으로 좁히면 확정 승격 · nsRoles 없는 패브릭은 후보가 하나여도 추정 · 확정분과 추정분을 합치지 않는다
 *  ② 함대 집계 — 호스트 × 스토리지 행 · 조닝만 표 · 개수
 *  ③ hostcfg 경로별 타깃 WWN(10진 → 콜론 16진) · 엣지 정제 화이트리스트(아는 필드만 · 상한 · 배열 아니면 키 없음)
 *  ④ CVP 설명 매칭 — 토큰 경계(esx01 ⊄ esx010) · MAC 표기 3종 · vmnic 글자만으로는 매칭하지 않는다 · 충돌
 *  ⑤ perfDb.portBytesMulti — 버킷 평균 × 구간 안 폭 · 표본 없는 포트는 Map 에 없다 · series
 *  ⑥ 실제 라우트 — 범위 밖 404 · 도구 키 거부 403 · 범위 계정은 자기 법인 스위치만 · 함대 라우트 fullScopeOnly · 응답 모양
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sanattrib2920-'));
Object.assign(process.env, { CONFIG_DIR: DIR, DATA_SOURCE: 'live', AUTH_ENABLED: 'true' });
const VC = 'vc-a'; const OUT = 'vc-out';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: VC, name: 'vc-a', host: 'vca.corp.local', username: 'u', password: 'p', collectMode: 'site' },
  { id: OUT, name: 'vc-out', host: 'vco.corp.local', username: 'u', password: 'p', collectMode: 'site' },
] }));
fs.writeFileSync(path.join(DIR, 'datacenters.json'), JSON.stringify({ datacenters: [{ id: 'corp-a', name: 'A 법인' }, { id: 'corp-b', name: 'B 법인' }], assign: { [VC]: 'corp-a', [OUT]: 'corp-b' } }));
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 3, matrix: {
  operator: ['dashboard', 'tools', 'inv.hosts'], viewer: ['dashboard', 'tools', 'inv.hosts'], toolsDenied: { operator: ['san-switch'], viewer: ['cvp'] } } }));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const A = await import('../src/sanswitch/attribution.js');
const H = 3_600_000;
const NOW = Math.floor(Date.now() / H) * H;   // 정시로 떨어뜨린 실제 시각(docs/rules/common.md)

const H1 = '10:00:00:10:9b:00:00:01', H1B = '10:00:00:10:9b:00:00:02', H3 = '10:00:00:10:9b:00:00:03', H4 = '10:00:00:10:9b:00:00:04', H2 = '10:00:00:10:9b:00:00:09';
const T1 = '50:00:09:73:00:00:00:01', T1B = '50:00:09:73:00:00:00:02', T2 = '58:cc:f0:00:00:00:00:c0';
const PMAX = 'SYMMETRIX::000497700230';
const port = (index, attached, attachedName, extra = {}) => ({ index, slotPort: `0/${index}`, name: `port${index}`, state: 'online', speed: '16G', attached, attachedName, inBps: 100, outBps: 200, ...extra });
const snapA = () => ({ deviceId: 'swA', name: 'SW-A', datacenterId: 'corp-a', collectedAt: NOW, ok: true,
  ports: { list: [port(0, [H1], 'Emulex PPN-10:00:00:10:9b:00:00:01', { inBps: 100, outBps: 200 }), port(1, [T1], `${PMAX}::FA-1D:4`), port(2, [T2], 'PowerStore::PS12345::node-A'), port(3, [H2], 'Emulex PPN-09')] },
  zoning: { available: true, zones: [{ name: 'Z1', members: [H1, T1] }, { name: 'Z2', members: [H1, T2] }, { name: 'Z3', members: [H2, T1] }, { name: 'Z5', members: [H3, T2] }] },
  nsRoles: { [H1]: 'initiator', [H2]: 'initiator', [T1]: 'target', [T2]: 'target' } });
const snapB = () => ({ deviceId: 'swB', name: 'SW-B', datacenterId: 'corp-a', collectedAt: NOW, ok: true,
  ports: { list: [port(5, [H1B], 'Emulex PPN-10:00:00:10:9b:00:00:02', { inBps: 10, outBps: 20 }), port(6, [T1B], `${PMAX}::FA-2D:4`)] },
  zoning: { available: true, zones: [{ name: 'Z4', members: [H1B, T1B] }] }, nsRoles: {} });
const storageOf = (serial) => (serial === '000497700230' ? { id: 'st1', name: 'PMAX-1', type: 'powermax', datacenterId: 'corp-a' } : null);
const bytesMap = (o) => new Map(Object.entries(o).map(([k, v]) => [k, { bytes: v, measuredBuckets: 10, totalBuckets: 12 }]));
const hostX = (over = {}) => ({ id: `${VC}:h1`, name: 'esx01.corp.local', vcenterId: VC, hbas: [
  { name: 'vmhba1', type: 'FibreChannel', wwn: H1 }, { name: 'vmhba2', type: 'FibreChannel', wwn: H1B }, { name: 'vmhba3', type: 'FibreChannel', wwn: H3 },
  { name: 'vmhba4', type: 'FibreChannel', wwn: H4 }, { name: 'vmhba64', type: 'iSCSI', wwn: '' }], ...over });

test('① 순수 귀속 엔진 — 추정(비율) · 확정 승격(멀티패스) · nsRoles 없는 패브릭은 추정 · 조닝만 · 미확인 · 측정 없음 null', () => {
  const fabrics = A.buildFabrics([snapA(), snapB()]);
  assert.equal(fabrics.length, 2); assert.equal(fabrics[0].nsKnown, true); assert.equal(fabrics[1].nsKnown, false); assert.equal(fabrics[0].zoneCount, 4);
  const pb = bytesMap({ 'swA|0': 1000, 'swA|1': 3000, 'swA|2': 1000, 'swB|5': 500 });
  const r = A.attributeHost(hostX(), fabrics, { storageOf, portBytes: pb });
  assert.equal(r.status, 'ok');
  const by = Object.fromEntries(r.hbas.map((x) => [x.hba, x]));
  // vmhba1: 후보 2(PMAX 등록 · PowerStore 미등록) → 타깃 포트 바이트 3000:1000 → 0.75/0.25 추정
  assert.equal(by.vmhba1.conf, 'estimated'); assert.equal(by.vmhba1.measured, true); assert.equal(by.vmhba1.bytes, 1000);
  assert.deepEqual(by.vmhba1.targets.map((t) => [t.id, t.registered, t.kind, t.share]), [['st:st1', true, 'array', 0.75], ['key:PowerStore::PS12345', false, 'array', 0.25]]);
  assert.equal(by.vmhba1.nowRead, 200, '스위치 Tx(outBps) = 읽기'); assert.equal(by.vmhba1.nowWrite, 100, 'Rx(inBps) = 쓰기');
  assert.equal(by.vmhba1.role.confidence, 'confirmed');
  // vmhba2(팹 B, nsRoles 없음): 후보 1 이지만 타깃 역할이 추정 → 추정. 같은 어레이(시리얼)로 합쳐진다.
  assert.equal(by.vmhba2.conf, 'estimated'); assert.match(by.vmhba2.basis, /네임서버 확정이 아님/);
  assert.equal(by.vmhba2.targets[0].id, 'st:st1');
  assert.equal(by.vmhba3.status, 'zoned-only'); assert.equal(by.vmhba3.conf, 'zoned-only'); assert.equal(by.vmhba3.port, null);
  assert.equal(by.vmhba4.status, 'unseen'); assert.equal(by.vmhba64.status, 'no-wwn');
  // 스토리지 행 — 확정분 null(없음) · 추정분 750+500
  const st = Object.fromEntries(r.storages.map((s) => [s.id, s]));
  assert.equal(st['st:st1'].name, 'PMAX-1'); assert.equal(st['st:st1'].confirmedBytes, null); assert.equal(st['st:st1'].estimatedBytes, 1250);
  assert.deepEqual(st['st:st1'].estimatedPorts, ['vmhba1@SW-A', 'vmhba2@SW-B']); assert.deepEqual(st['st:st1'].fabrics, ['swA', 'swB']);
  assert.equal(st['st:st1'].targetPorts.length, 2, '타깃 포트 — 팹 A 1번 · 팹 B 6번');
  assert.equal(st['key:PowerStore::PS12345'].estimatedBytes, 250); assert.deepEqual(st['key:PowerStore::PS12345'].zonedOnlyPorts, ['vmhba3@SW-A']);
  assert.equal(st['st:st1'].nowReadEst, 200 * 0.75 + 20); assert.equal(st['st:st1'].nowRead, null, '확정 포트가 없으면 확정 now 는 null');
  // 합계 — 호스트 합은 HBA 포트 카운터 그대로, 확정/추정 따로
  assert.deepEqual(r.totals, { hostBytes: 1500, confirmedBytes: null, estimatedBytes: 1500, unsplitBytes: null, unattributedBytes: null, measuredPorts: 2, unmeasuredPorts: 0, loggedIn: 2, zonedOnly: 1, unseen: 1, nowRead: 220, nowWrite: 110 });

  // 멀티패스 살아 있는 타깃이 T1 뿐 → vmhba1 은 후보 1 + 네임서버 확정 → 확정 승격
  const r2 = A.attributeHost(hostX({ hcfg: { mp: { targets: [{ adapter: 'vmhba1', wwn: T1, live: 2, dead: 0, luns: 4 }, { adapter: 'vmhba1', wwn: T2, live: 0, dead: 2, luns: 1 }] } } }), fabrics, { storageOf, portBytes: pb });
  const b2 = r2.hbas.find((x) => x.hba === 'vmhba1');
  assert.equal(b2.conf, 'confirmed'); assert.equal(b2.narrowed, true); assert.deepEqual(b2.targets.map((t) => t.id), ['st:st1']);
  assert.equal(r2.storages.find((s) => s.id === 'st:st1').confirmedBytes, 1000); assert.equal(r2.totals.confirmedBytes, 1000); assert.equal(r2.totals.estimatedBytes, 500);
  assert.equal(r2.storages.find((s) => s.id === 'st:st1').nowRead, 200); assert.equal(r2.mpTargets, 1, '살아 있는 타깃 수');

  // 타깃 포트 바이트가 없으면 나누지 못한다(분배 불가) — 어느 스토리지에도 주지 않는다
  const r3 = A.attributeHost(hostX(), fabrics, { storageOf, portBytes: bytesMap({ 'swA|0': 1000 }) });
  const b3 = r3.hbas.find((x) => x.hba === 'vmhba1');
  assert.equal(b3.conf, 'unsplit'); assert.equal(r3.totals.unsplitBytes, 1000); assert.equal(r3.totals.estimatedBytes, null);
  assert.equal(r3.storages.find((s) => s.id === 'st:st1').estimatedBytes, null); assert.deepEqual(r3.storages.find((s) => s.id === 'st:st1').unsplitPorts, ['vmhba1@SW-A']);
  // 측정 없음 — 0 이 아니라 null · measured false · unmeasuredPorts 로 센다
  const r4 = A.attributeHost(hostX(), fabrics, { storageOf, portBytes: null });
  const b4 = r4.hbas.find((x) => x.hba === 'vmhba1');
  assert.equal(b4.bytes, null); assert.equal(b4.measured, false); assert.equal(b4.conf, 'unsplit');
  assert.equal(r4.totals.hostBytes, null); assert.equal(r4.totals.unmeasuredPorts, 2);
  assert.ok(r4.storages.find((s) => s.id === 'st:st1').unmeasuredPorts.includes('vmhba2@SW-B'));
  // HBA 없는 호스트 · 스냅샷 없음
  assert.equal(A.attributeHost({ id: 'x', name: 'x', hbas: [] }, fabrics, {}).status, 'no-hba');
  assert.equal(A.attributeHost(hostX(), [], {}).status, 'unseen');
  assert.equal(A.buildFabrics([null, { deviceId: 'z', ports: { list: 'bad' }, zoning: { available: true, zones: 'bad' }, nsRoles: 'x' }]).length, 1, '모양이 틀린 스냅샷은 빈 문맥');
});

test('② 함대 집계 — 호스트 × 스토리지 행 · 조닝만 · 개수', () => {
  const fabrics = A.buildFabrics([snapA(), snapB()]);
  const pb = bytesMap({ 'swA|0': 1000, 'swA|1': 3000, 'swA|2': 1000, 'swB|5': 500 });
  const hosts = [hostX(), { id: 'h2', name: 'nohba', vcenterId: VC, hbas: [] }, { id: 'h3', name: 'unseen', vcenterId: VC, hbas: [{ name: 'vmhba1', wwn: H4 }] },
    { id: 'h4', name: 'esx02', vcenterId: VC, hbas: [{ name: 'vmhba1', wwn: H2 }] }];
  const f = A.attributeFleet(hosts, fabrics, { storageOf, portBytes: pb });
  assert.deepEqual(f.counts, { hosts: 4, noHba: 1, unseen: 1, ok: 2, zonedOnly: 0, confirmedPairs: 1, estimatedPairs: 2, unsplitPairs: 0, zonedOnlyPairs: 0 });
  const x = f.rows.filter((r) => r.hostId === `${VC}:h1`);
  assert.deepEqual(x.map((r) => [r.storageId, r.conf, r.confirmedBytes, r.estimatedBytes, r.measured]), [['st:st1', 'estimated', null, 1250, true], ['key:PowerStore::PS12345', 'estimated', null, 250, true]]);
  const y = f.rows.find((r) => r.hostId === 'h4');
  assert.equal(y.conf, 'confirmed'); assert.equal(y.confirmedBytes, null, 'esx02 포트(3)는 표본이 없다 → 측정 없음'); assert.equal(y.measured, false); assert.equal(y.ports.unmeasured, 1);
  assert.deepEqual(f.storages.map((s) => [s.id, s.hosts, s.hostsConfirmed, s.hostsEstimated, s.confirmedBytes, s.estimatedBytes, s.unmeasuredHosts]),
    [['st:st1', 2, 1, 1, null, 1250, 1], ['key:PowerStore::PS12345', 1, 0, 1, null, 250, 0]]);
  assert.equal(f.hosts.find((h) => h.id === 'h2').status, 'no-hba');
});

test('③ hostcfg — 경로별 FC 타깃 WWN(어댑터별 live/dead) · 엣지 정제 화이트리스트', async () => {
  const P = await import('../src/hostcfg/parse.js');
  assert.equal(P.wwnFromDec('5764689621520744449'), '50:00:4a:ab:0b:20:00:01'); assert.equal(P.wwnFromDec('abc'), null); assert.equal(P.wwnFromDec(''), null);
  const path_ = (lun, st, adapter, pwwn) => `<path><key>p</key><name>n</name><pathState>${st}</pathState><lun>${lun}</lun><adapter>key-vim.host.FibreChannelHba-${adapter}</adapter><transport xsi:type="HostFibreChannelTargetTransport"><nodeWorldWideName>1</nodeWorldWideName><portWorldWideName>${pwwn}</portWorldWideName></transport></path>`;
  const x = `<lun>${path_('L1', 'active', 'vmhba1', '5764689621520744449')}${path_('L1', 'dead', 'vmhba1', '5764689621520744450')}${path_('L2', 'active', 'vmhba1', '5764689621520744449')}${path_('L2', 'standby', 'vmhba2', '5764689621520744449')}`
    + `<path><name>i</name><pathState>active</pathState><lun>L3</lun><adapter>key-vim.host.InternetScsiHba-vmhba64</adapter><transport xsi:type="HostInternetScsiTargetTransport"></transport></path></lun>`;
  const m = P.parseMultipath(x);
  assert.deepEqual(m.targets, [
    { adapter: 'vmhba1', wwn: '50:00:4a:ab:0b:20:00:01', live: 2, dead: 0, luns: 2 }, { adapter: 'vmhba1', wwn: '50:00:4a:ab:0b:20:00:02', live: 0, dead: 1, luns: 1 },
    { adapter: 'vmhba2', wwn: '50:00:4a:ab:0b:20:00:01', live: 1, dead: 0, luns: 1 }]);
  assert.equal(m.paths, 5); assert.equal(m.dead, 1);
  // 정제 — 아는 필드만 · WWN 표준형 · 어댑터 이름 · 배열이 아니면 키 없음(구버전 엣지)
  const s = P.sanitizeHostCfg({ mp: { luns: 1, targets: [{ adapter: 'vmhba1', wwn: '50:00:4A:AB:0B:20:00:01', live: 2, dead: -1, luns: 'x', extra: 1 }, { adapter: 'bad name', wwn: '50:00:4a:ab:0b:20:00:01' }, { adapter: 'vmhba2', wwn: 'nope' }, null, 'str'] } }).mp;
  assert.deepEqual(s.targets, [{ adapter: 'vmhba1', wwn: '50:00:4a:ab:0b:20:00:01', live: 2, dead: 0, luns: 0 }]);
  assert.equal(Object.hasOwn(P.sanitizeHostCfg({ mp: { luns: 1 } }).mp, 'targets'), false);
  assert.equal(P.sanitizeHostCfg({ mp: { luns: 1, targets: new Array(200).fill({ adapter: 'vmhba1', wwn: '50:00:4a:ab:0b:20:00:01' }) } }).mp.targets.length, P.MP_TARGETS_MAX);
  // 엔진이 쓰는 모양
  assert.deepEqual([...A.liveTargetsByAdapter({ hcfg: { mp: m } }).get('vmhba1')], ['50:00:4a:ab:0b:20:00:01']);
  assert.equal(A.liveTargetsByAdapter({ hcfg: { mp: { luns: 1 } } }), null);
});

test('④ CVP 설명 매칭 — 토큰 경계 · MAC 표기 · vmnic 만으로는 안 됨 · 충돌', async () => {
  const M = await import('../src/cvp/hostMatch.js');
  const host = { name: 'esx01.corp.local', nics: [{ device: 'vmnic0', mac: 'A4:3F:68:85:30:2E' }, { device: 'vmnic1', mac: 'a4-3f-68-85-30-2f' }, { device: 'vmnic2', mac: '' }] };
  const ports = [
    { cvpId: 'c1', key: 'leaf1', hostname: 'leaf1', port: 'Ethernet1', desc: 'ESX01 vmnic0' },
    { cvpId: 'c1', key: 'leaf1', hostname: 'leaf1', port: 'Ethernet2', desc: 'esx010 uplink' },
    { cvpId: 'c1', key: 'leaf2', hostname: 'leaf2', port: 'Ethernet1', desc: 'srv a43f.6885.302f' },
    { cvpId: 'c1', key: 'leaf2', hostname: 'leaf2', port: 'Ethernet3', desc: 'vmnic1 only' },
    { cvpId: 'c1', key: 'leaf2', hostname: 'leaf2', port: 'Ethernet4', desc: 'to-esx01' },
    { cvpId: 'c1', key: 'leaf2', hostname: 'leaf2', port: 'Ethernet5', desc: '' },
  ];
  const r = M.matchUplinks(ports, host);
  assert.deepEqual(r.uplinks.map((u) => [u.port, u.nic, u.basis]), [['Ethernet1', 'vmnic0', 'desc-nic'], ['Ethernet1', 'vmnic1', 'desc-mac'], ['Ethernet4', null, 'desc-name']]);
  assert.deepEqual([...r.byNic.keys()], ['vmnic0', 'vmnic1']); assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.terms, { short: 'esx01', macs: 2, nics: 3 });
  assert.equal(M.descHasName('esx010 x', 'esx01'), false); assert.equal(M.descHasName('TO_ESX01-p1', 'esx01'), true);
  assert.deepEqual([...M.macsInDesc('a4:3f:68:85:30:2e | A43F.6885.302F | a43f6885302e')], ['a43f6885302e', 'a43f6885302f']);
  assert.equal(M.matchUplinks([{ port: 'E1', desc: 'xx' }], { name: 'ab' }).uplinks.length, 0, '짧은 이름(3자 미만)은 단서가 아니다');
  const c = M.matchUplinks([1, 2, 3].map((i) => ({ cvpId: 'c', key: `l${i}`, port: 'E1', desc: 'a4:3f:68:85:30:2e' })), host);
  assert.deepEqual(c.conflicts, [{ nic: 'vmnic0', ports: 3 }], '세 포트 이상에서 같은 MAC — 충돌 표시');
});

test('⑤ perfDb.portBytesMulti — 버킷 평균 × 구간 안 폭 · 표본 없는 포트는 없다 · series', async () => {
  const D = await import('../src/sanswitch/perfDb.js');
  if (!(await D.available())) return;
  D._resetForTest();
  const meta = [{ port: 0, attachedName: 'Emulex PPN-x', speed: '16G' }, { port: 1, attachedName: `${PMAX}::FA-1`, speed: '16G' }];
  const { since, bucketMs } = D.rangeOf({ hours: 1 });
  const b0 = Math.floor(since / bucketMs) * bucketMs + 2 * bucketMs;   // 구간 안쪽 버킷(가장자리 아님)
  await D.savePerfSample('sw-x', b0 + 1000, { 0: 100, 1: 50 }, meta);
  await D.savePerfSample('sw-x', b0 + 30_000, { 0: 300, 1: 150 }, meta);
  await D.savePerfSample('sw-x', b0 + bucketMs + 1000, { 0: 200 }, meta);
  const r = await D.portBytesMulti(['sw-x'], { hours: 1, series: true });
  assert.equal(r.bucketMs, bucketMs); assert.equal(r.buckets.length > 10, true);
  const p0 = r.ports.get('sw-x|0'); const p1 = r.ports.get('sw-x|1');
  assert.equal(p0.bytes, Math.round(200 * bucketMs / 1000 + 200 * bucketMs / 1000), '포트0: 버킷1 평균 200 · 버킷2 200');
  assert.equal(p0.measuredBuckets, 2); assert.equal(p1.bytes, Math.round(100 * bucketMs / 1000)); assert.equal(p1.measuredBuckets, 1);
  assert.equal(r.ports.has('sw-x|2'), false, '표본 없는 포트는 없다(0 이 아니다)');
  const i = r.buckets.indexOf(b0);
  assert.equal(p0.avg[i], 200); assert.equal(p0.avg[i + 1], 200); assert.equal(p0.avg[i + 2], null); assert.equal(p1.avg[i + 1], null);
  const e = await D.portBytesMulti(['sw-none'], { hours: 1 });
  assert.equal(e.ports.size, 0);
  const same = await D.portBytesMulti(['sw-x'], { hours: 1, series: true });
  assert.equal(same, r, '같은 조건은 heavyQuery 기억(같은 객체)');
  D._resetForTest();
});

test('⑥ 실제 라우트 — 범위 밖 404 · 도구 키 403 · 범위 계정은 자기 법인 스위치만 · 함대 fullScopeOnly · 응답 모양', async () => {
  const { store } = await import('../src/store.js');
  const R = await import('../src/routes/api/hostSan.js');
  const SR = await import('../src/sanswitch/registry.js'); const SS = await import('../src/sanswitch/store.js');
  const STR = await import('../src/storage/registry.js'); const STS = await import('../src/storage/store.js');
  const D = await import('../src/sanswitch/perfDb.js');
  const express = (await import('express')).default;
  const swA = SR.saveDevice({ type: 'brocade', name: 'SW-A', host: '10.1.1.10', username: 'admin', password: 'p', datacenterId: 'corp-a' });
  const swB = SR.saveDevice({ type: 'brocade', name: 'SW-B', host: '10.1.1.11', username: 'admin', password: 'p', datacenterId: 'corp-b' });
  SS.putSnapshot({ ...snapA(), deviceId: swA.id, name: 'from-device' });
  SS.putSnapshot({ ...snapB(), deviceId: swB.id });
  const st = STR.saveDevice({ type: 'powermax', name: 'PMAX-1', host: '10.2.2.2', username: 'u', password: 'p', datacenterId: 'corp-a' });
  STS.putSnapshot({ deviceId: st.id, ok: true, serial: '000497700230', capacity: { totalBytes: 10, usedBytes: 5, pct: 50 }, collectedAt: NOW });
  if (await D.available()) {
    D._resetForTest();
    // 조회 구간(최근 1시간) 안쪽 버킷에 표본을 둔다 — 정시 NOW 는 구간 밖일 수 있다(rangeOf 가 실제 시각을 쓴다).
    const { since, bucketMs } = D.rangeOf({ hours: 1 });
    const t = Math.floor(since / bucketMs) * bucketMs + 3 * bucketMs;
    for (const [dev, s] of [[swA.id, { 0: 1000, 1: 3000, 2: 1000 }], [swB.id, { 5: 500 }]]) { await D.savePerfSample(dev, t + 1000, s, []); await D.savePerfSample(dev, t + 30_000, s, []); }
  }
  const prev = store.snapshot;
  const hosts = [hostX(), { ...hostX(), id: `${OUT}:x1`, vcenterId: OUT, name: 'other.corp.local' }];
  store.snapshot = { source: 'live', generatedAt: new Date(NOW).toISOString(), vcenters: [{ id: VC, name: 'vc-a' }, { id: OUT, name: 'vc-out' }], hosts, vms: [], datastores: [] };
  let user = { username: 'adm', role: 'admin' };
  const app = express();
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); R.registerHostSan(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  closers.push(async () => { store.snapshot = prev; });
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const get = (p) => fetch(`${base}${p}`);
  const h1 = encodeURIComponent(`${VC}:h1`);

  let r = await get(`/hosts/${h1}/san-attribution?hours=1`);
  assert.equal(r.status, 200);
  let j = await r.json();
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(j.ok, true); assert.equal(j.status, 'ok'); assert.equal(j.switches, 2); assert.equal(j.corpLimited, false);
  assert.deepEqual(j.fabrics.map((f) => [f.name, f.datacenterId, f.nsKnown]), [['SW-A', 'corp-a', true], ['SW-B', 'corp-b', false]], '등록부 이름·법인을 쓴다(스냅샷 이름이 아니라)');
  const v1 = j.hbas.find((x) => x.hba === 'vmhba1');
  assert.equal(v1.conf, 'estimated'); assert.equal(v1.switch.name, 'SW-A');
  assert.equal(j.storages.find((s) => s.id === `st:${st.id}`).name, 'PMAX-1', '등록 스토리지 시리얼 일치');
  if (await D.available()) {
    assert.equal(v1.measured, true); assert.ok(v1.bytes > 0); assert.ok(j.series && j.series.buckets.length > 0 && j.series.ports === 2);
    assert.ok(j.series.sum.some((v) => v != null), '두 포트 모두 표본이 있는 버킷은 합이 있다');
  }
  assert.ok(Object.hasOwn(j, 'hbas') && Object.hasOwn(j, 'totals') && Object.hasOwn(j, 'mpTargets'));
  assert.equal(JSON.stringify(j).includes('10.1.1.10'), false, '응답에 스위치 관리 주소가 없다');
  // 범위 계정 — 범위 밖 호스트 404 · 자기 법인(corp-a) 스위치만
  user = { username: 'v', role: 'viewer', scope: { vcenters: [VC] } };
  assert.equal((await get(`/hosts/${encodeURIComponent(`${OUT}:x1`)}/san-attribution`)).status, 404);
  j = await (await get(`/hosts/${h1}/san-attribution?hours=1`)).json();
  assert.equal(j.corpLimited, true); assert.deepEqual(j.fabrics.map((f) => f.name), ['SW-A'], '다른 법인 스위치(SW-B)는 보이지 않는다');
  assert.equal(j.hbas.find((x) => x.hba === 'vmhba2').status, 'unseen', '팹 B 에만 있는 HBA 는 범위 계정에 미확인');
  assert.equal(j.addressHidden, true);
  // 도구 키 거부 — operator 는 san-switch 거부(403) · viewer 는 cvp 거부(403)
  user = { username: 'op', role: 'operator' };
  r = await get(`/hosts/${h1}/san-attribution`); assert.equal(r.status, 403); assert.equal((await r.json()).tool, 'san-switch');
  r = await get(`/hosts/${h1}/net-uplinks`); assert.equal(r.status, 200);
  j = await r.json(); assert.equal(j.ok, true); assert.deepEqual(j.uplinks, []); assert.equal(j.servers, 0); assert.deepEqual(j.direction, { in: '서버 송신', out: '서버 수신' });
  user = { username: 'v', role: 'viewer', scope: { vcenters: [VC] } };
  r = await get(`/hosts/${h1}/net-uplinks`); assert.equal(r.status, 403); assert.equal((await r.json()).tool, 'cvp');
  assert.equal((await get(`/hosts/${encodeURIComponent(`${OUT}:x1`)}/net-uplinks`)).status, 404, '범위 검사가 도구 키보다 먼저(존재 은닉)');
  // 함대 — fullScopeOnly · 법인 선택 · 행 모양
  assert.equal((await get('/tools/sanswitch/attribution')).status, 403);
  user = { username: 'adm', role: 'admin' };
  r = await get('/tools/sanswitch/attribution?hours=1&datacenterId=corp-a');
  assert.equal(r.status, 200); j = await r.json();
  assert.deepEqual(j.fabrics.map((f) => f.name), ['SW-A']); assert.equal(j.hostsWithHba, 1, 'corp-a vCenter 의 호스트만');
  assert.deepEqual(j.rows.map((x) => [x.hostName, x.storageName, x.conf, x.datacenterName]), [['esx01.corp.local', 'PMAX-1', 'estimated', 'A 법인'], ['esx01.corp.local', 'PowerStore::PS12345', 'estimated', 'A 법인']]);
  assert.equal(j.zonedOnly.length, 0); assert.equal(j.counts.hosts, 1);
  j = await (await get('/tools/sanswitch/attribution?hours=1')).json();
  assert.equal(j.hostsWithHba, 2); assert.equal(j.fabrics.length, 2);
  assert.equal((await get('/hosts/nope/san-attribution')).status, 404);
  user = { username: 'none', role: 'guest' };
  assert.equal((await get(`/hosts/${h1}/san-attribution`)).status, 403);
  if (await D.available()) D._resetForTest();
});
