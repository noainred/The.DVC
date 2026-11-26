/**
 * test/cvpNet338.test.js — v3.38 CVP 네트워크 기능(docs/design/cvp-network-features — 2차 범위).
 *  ① 추세 — 직선 · 기록 부족 · 예측 없음 · 이미 넘음 · 계단식 회복
 *  ② 링크 품질 — 교체 후보 · 플랩 · 상대 확인 · 관찰 · 판정 못 함(0 이 아니다)
 *  ③ 회수 · 예측 — 기록 시작 뒤 사용 없음 · 장비 기록 없음 · 관리 포트 제외 · 고갈/포화 상태
 *  ④ 토폴로지 — 양쪽 · 한쪽 · 설명 링크 · 층 · 같은 짧은 이름 둘이면 맞추지 않음 · 불일치 diff/na
 *  ⑤ 전후 비교 — 못 읽은 묶음은 '비교 못 함' · 추가 · 제거 · 포트 · BGP · 트랜시버 · LLDP
 *  ⑥ 위치 찾기 — 질의 해석 · 인벤토리 · 가장자리/지나는 곳
 *  ⑦ DB 기록 — 플랩(관리상 꺼짐 · 옛 레코드 제외) · 장비 포트 수 · GBIC 일 최저(링크 있음만 · 범위 밖 값 제외) · 마지막 링크 날 · 백필
 *  ⑧ 실제 라우터 — 7개 조회 200 · 비-admin 가림 · 범위 계정 403 · 스냅샷 역할 게이트 · 비교 · 삭제
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvpnet338-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';

const T = await import('../src/cvp/trend.js');
const LQ = await import('../src/cvp/linkq.js');
const PP = await import('../src/cvp/portplan.js');
const TP = await import('../src/cvp/topology.js');
const SD = await import('../src/cvp/snapdiff.js');
const LC = await import('../src/cvp/locate.js');
const OT = await import('../src/cvp/opticstrend.js');
const DAY = 86_400_000;
// 기준 시각: 실제 시각을 UTC 자정으로 떨어뜨려 고정(docs/rules/common.md — Date.now() 직접 · 고정 epoch 둘 다 깨진다)
const NOW = Math.floor(Date.now() / DAY) * DAY + 12 * 3_600_000;
const series = (n, f) => Array.from({ length: n }, (_, i) => [NOW - (n - 1 - i) * DAY, f(i)]);

test('① 추세', () => {
  const f = T.linFit(series(10, (i) => 2 * i + 1));
  assert.ok(Math.abs(f.slopePerDay - 2) < 1e-9);
  assert.equal(T.forecast(series(30, (i) => i), { target: 100, minDays: 90, now: NOW }).state, 'short', '90일 미만은 기록 부족');
  assert.equal(T.forecast(series(100, () => 5), { target: 100, minDays: 90, now: NOW }).state, 'flat', '늘지 않으면 예측 없음');
  const up = T.forecast(series(100, (i) => i * 0.5), { target: 100, minDays: 90, now: NOW });
  assert.equal(up.state, 'eta'); assert.ok(up.eta > NOW && up.eta < NOW + 120 * DAY);
  assert.equal(T.forecast(series(5, () => 120), { target: 100, now: NOW }).state, 'already');
  assert.equal(T.forecast([[NOW, null], [NOW - DAY, null]], { target: 1, minDays: 1, now: NOW }).state, 'short', 'null 은 점이 아니다');
  const r = T.sinceLastRecovery([[1, -12], [2, -12.5], [3, -9], [4, -9.2]], 2);
  assert.equal(r.points.length, 2); assert.equal(r.resetAt, 3);
});

test('② 링크 품질', () => {
  const dk = (k) => `\u0000c1\u0000${k}`;
  const ports = [
    { agent: '', cvpId: 'c1', key: 'S1', hostname: 'sw1', port: 'Ethernet1', oper: 'up', admin: 'up' },
    { agent: '', cvpId: 'c1', key: 'S1', hostname: 'sw1', port: 'Ethernet2', oper: 'up', admin: 'up' },
    { agent: '', cvpId: 'c1', key: 'S1', hostname: 'sw1', port: 'Ethernet3', oper: 'nolink', admin: 'up' },
    { agent: '', cvpId: 'c1', key: 'S1', hostname: 'sw1', port: 'Ethernet4', oper: 'up', admin: 'up' },
    { agent: '', cvpId: 'c1', key: 'S1', hostname: 'sw1', port: 'Ethernet5', oper: 'up', admin: 'up' },
    { agent: '', cvpId: 'c1', key: 'S1', hostname: 'sw1', port: 'Management1', oper: 'up', admin: 'up' },
  ];
  const parts = [{ kind: 'xcvr', name: 'xcvr › Ethernet1', state: 'ok', optic: { intf: 'Ethernet1', rx: -12.5, linked: true } },
    { kind: 'xcvr', name: 'xcvr › Ethernet2', state: 'ok', optic: { intf: 'Ethernet2', rx: -3, linked: true } }];
  const err = new Map([[`${dk('S1')}\u0000Ethernet1`, { inErr: 40, outErr: 0, errDays: 3, days: 7 }], [`${dk('S1')}\u0000Ethernet2`, { inErr: 5, outErr: null, errDays: 1, days: 7 }],
    [`${dk('S1')}\u0000Ethernet5`, { inErr: 0, outErr: 0, errDays: 7, days: 7 }]]);
  const flap = new Map([[`${dk('S1')}\u0000Ethernet3`, { downs: 5, byDay: [] }], [`${dk('S1')}\u0000Ethernet4`, { downs: 1, byDay: [] }]]);
  const r = LQ.rankLinks({ ports, devices: new Map([[dk('S1'), { parts }]]), err, flap, warnDbm: -10, flapMin: 3 });
  const v = Object.fromEntries(r.rows.map((x) => [x.port, x.verdict]));
  assert.deepEqual(v, { Ethernet1: 'replace', Ethernet2: 'peer', Ethernet3: 'flap', Ethernet4: 'observe' });
  assert.equal(r.rows[0].port, 'Ethernet1', '교체 후보가 맨 위');
  assert.equal(r.counts.noData, 1, 'Ethernet4 — 오류 카운터를 못 읽음(0 이 아니다)');
  assert.equal(r.counts.judged, 3);
  assert.equal(r.rows.find((x) => x.port === 'Ethernet3').errs, null, '링크 없는 포트의 오류는 null');
});

test('③ 회수 · 예측', () => {
  const p = (port, oper, extra = {}) => ({ agent: '', cvpId: 'c1', key: 'S1', hostname: 'sw1', port, oper, admin: 'up', desc: '', ...extra });
  const dk = '\u0000c1\u0000S1';
  const last = new Map([[`${dk}\u0000Ethernet1`, NOW - 200 * DAY], [`${dk}\u0000Ethernet2`, NOW - 10 * DAY]]);
  const first = new Map([[dk, NOW - 300 * DAY]]);
  const r = PP.reclaimCandidates({ ports: [p('Ethernet1', 'nolink'), p('Ethernet2', 'down'), p('Ethernet3', 'nolink'), p('Ethernet4', 'up'), p('Management1', 'nolink'),
    { ...p('Ethernet9', 'nolink'), key: 'S2' }], last, first, idleDays: 90, now: NOW });
  assert.deepEqual(r.rows.map((x) => [x.port, x.never, x.idleDays]), [['Ethernet1', false, 200], ['Ethernet3', true, null]]);
  assert.equal(r.counts.noHistory, 1, '장비 기록이 없으면 후보 아님');
  assert.equal(r.counts.byIdle[180], 1); assert.equal(r.counts.byIdle[30], 1);
  const ex = PP.exhaustForecast({ devices: [{ agent: '', cvpId: 'c1', key: 'S1', hostname: 'sw1' }, { agent: '', cvpId: 'c1', key: 'S2', hostname: 'sw2' }],
    series: new Map([[dk, Array.from({ length: 100 }, (_, i) => [NOW - (99 - i) * DAY, 48, 20 + Math.floor(i / 5)])]]), now: NOW });
  const byH = Object.fromEntries(ex.rows.map((x) => [x.hostname, x.state]));
  assert.equal(byH.sw1, 'eta'); assert.equal(byH.sw2, 'none');
  const sat = PP.saturationForecast({ uplinks: [{ agent: '', cvpId: 'c1', key: 'S1', hostname: 'sw1', port: 'Ethernet49/1' }],
    series: new Map([[`${dk}\u0000Ethernet49/1`, series(20, () => 30)]]), now: NOW });
  assert.equal(sat.rows[0].state, 'short'); assert.equal(sat.rows[0].max30, 30);
});

test('④ 토폴로지 · 양끝 불일치', () => {
  const D = (key, hostname) => ({ agent: '', cvpId: 'c1', key, hostname, model: 'DCS-7050SX3-48YC8' });
  const devices = [D('L1', 'kr-leaf-01.corp'), D('L2', 'kr-leaf-02'), D('S1', 'kr-spine-01'), D('S2', 'kr-spine-02'), D('X1', 'dup-01'), D('X2', 'dup-01.b')];   // v3.42: 같은 CVP 안에서 짧은 이름이 둘(다른 CVP 후보는 같은 CVP 쪽을 고른다 — cvpBugRound342)
  const L = (key, port, sysName, portId) => ({ agent: '', cvpId: 'c1', key, port, sysName, portId });
  const lldp = [
    L('L1', 'Ethernet49/1', 'kr-spine-01', 'Ethernet1'), L('S1', 'Ethernet1', 'kr-leaf-01.corp', 'Ethernet49/1'),   // both
    L('L1', 'Ethernet50/1', 'kr-spine-02', 'Et1'),                                                                   // one(상대 LLDP 없음)
    L('L2', 'Ethernet49/1', 'kr-spine-01', 'Ethernet2'), L('S1', 'Ethernet2', 'kr-leaf-02', 'Ethernet49/1'),
    L('L1', 'Ethernet1', 'esx-01', 'vmnic0'), L('L2', 'Ethernet1', 'nas-01', 'eth0'),
    L('L2', 'Ethernet9', 'dup-01.zz', 'x'),                                                                          // 짧은 이름이 둘 — 맞추지 않음
  ];
  const meta = new Map(['L1', 'L2', 'S1'].map((k) => [`\u0000c1\u0000${k}`, { at: NOW }]));
  const P = (key, port, x = {}) => ({ agent: '', cvpId: 'c1', key, port, oper: 'up', admin: 'up', speedBps: 100e9, mtu: 9214, duplex: 'duplexFull', lag: '', desc: '', ...x });
  const ports = [P('L1', 'Ethernet49/1', { mtu: 1500 }), P('S1', 'Ethernet1'), P('L2', 'Ethernet49/1', { mtu: null }), P('S1', 'Ethernet2', { desc: 'to kr-leaf-01.corp' })   /* v3.42: 설명 비교는 알려진 스위치 이름만(2회차 반증 R10) */,
    P('L1', 'Ethernet50/1'), P('L2', 'Ethernet48', { desc: 'peer kr-leaf-01' })];
  const t = TP.buildTopology({ devices, lldp, lldpMeta: meta, ports, hostNames: new Set(['esx-01']) });
  const k = (a, b) => t.links.find((l) => [l.aName, l.bName].sort().join('|') === [a, b].sort().join('|'));
  assert.equal(k('kr-leaf-01.corp', 'kr-spine-01').kind, 'both');
  assert.equal(k('kr-leaf-01.corp', 'kr-spine-02').kind, 'one');
  assert.equal(k('kr-leaf-02', 'kr-leaf-01.corp').kind, 'desc', '설명만으로 가리킨 링크');
  assert.ok(!t.links.some((l) => l.aName === 'dup-01' || l.bName === 'dup-01'), '같은 짧은 이름 둘이면 맞추지 않는다');
  const n = Object.fromEntries(t.nodes.map((x) => [x.hostname, x]));
  assert.equal(n['kr-spine-01'].layer, 'spine'); assert.equal(n['kr-leaf-01.corp'].layer, 'leaf'); assert.equal(n['kr-leaf-01.corp'].esxi, 1);
  assert.equal(n['kr-leaf-02'].otherNeighbors >= 1, true);
  const a = k('kr-leaf-01.corp', 'kr-spine-01').items;
  assert.deepEqual(a.filter((x) => x.state === 'diff').map((x) => x.field), ['mtu']);
  const b = k('kr-leaf-02', 'kr-spine-01').items;
  assert.ok(b.some((x) => x.field === 'mtu' && x.state === 'na'), '한쪽 못 읽음 = 비교 못 함');
  assert.ok(b.some((x) => x.field.startsWith('desc') && x.state === 'diff'), '설명이 다른 장비를 가리킴');
  assert.equal(TP.normPort('Ethernet 1/1'), TP.normPort('et1/1'));
  // 서버 LLDP 를 못 본 리프(이웃 = spine 둘)는 spine 줄로 올리지 않는다(v3.38 Chromium 판독)
  const F = (k) => ({ agent: '', cvpId: 'f', key: k, hostname: k });
  const fl = [];
  for (const lf of ['lf1', 'lf2', 'lf3']) for (const [i, sp] of ['sp1', 'sp2'].entries()) {
    fl.push({ agent: '', cvpId: 'f', key: lf, port: `Ethernet${49 + i}/1`, sysName: sp, portId: `Ethernet${lf.slice(2)}` });
    fl.push({ agent: '', cvpId: 'f', key: sp, port: `Ethernet${lf.slice(2)}`, sysName: lf, portId: `Ethernet${49 + i}/1` });
  }
  const ft = TP.buildTopology({ devices: ['lf1', 'lf2', 'lf3', 'sp1', 'sp2'].map(F), lldp: fl, lldpMeta: new Map(), ports: [] });
  assert.deepEqual(Object.fromEntries(ft.nodes.map((x) => [x.hostname, x.layer])), { lf1: 'leaf', lf2: 'leaf', lf3: 'leaf', sp1: 'spine', sp2: 'spine' });
  assert.equal(ft.counts.both, 6, '양쪽이 서로 본 링크');
  assert.deepEqual(TP.compareEnds(null, null), [{ field: 'port', a: null, b: null, state: 'na' }]);
});

test('⑤ 전후 비교', () => {
  const dev = (v, ports, extra = {}) => ({ hostname: 'sw1', eosVersion: v, portsRead: ports != null, bgpPeers: [{ peer: '10.0.0.1', vrf: 'default', state: 'Established' }], partsList: [{ kind: 'xcvr', name: 'xcvr › Ethernet1', state: 'ok', media: 'SR' }], ...extra });
  const a = SD.snapshotBody({ device: dev('4.30', null), ports: null, lldp: null });
  const b = SD.snapshotBody({ device: dev('4.31', [{ port: 'Ethernet1', oper: 'up' }]), ports: [{ port: 'Ethernet1', oper: 'up' }], lldp: { read: true, rows: [] } });
  const d = SD.diffDevice(a, b);
  assert.deepEqual(d.changes.map((c) => c.field), ['version']);
  assert.deepEqual(d.na.sort(), ['lldp', 'ports'], '한쪽이 못 읽은 묶음은 비교 못 함');
  const c1 = SD.snapshotBody({ device: dev('4.31', []), ports: [{ port: 'Ethernet1', oper: 'up', admin: 'up', desc: 'a' }, { port: 'Ethernet2', oper: 'up' }], lldp: { read: true, rows: [{ port: 'Ethernet1', sysName: 'x', portId: 'p' }] } });
  const c2 = SD.snapshotBody({ device: dev('4.31', [], { bgpPeers: [{ peer: '10.0.0.1', vrf: 'default', state: 'Active' }], partsList: [{ kind: 'xcvr', name: 'xcvr › Ethernet1', state: 'absent' }] }),
    ports: [{ port: 'Ethernet1', oper: 'nolink', admin: 'up', desc: null }, { port: 'Ethernet3', oper: 'up' }], lldp: { read: true, rows: [] } });
  const e = SD.diffDevice(c1, c2);
  const f = e.changes.map((x) => `${x.kind}:${x.item}:${x.field}`);
  for (const w of ['port:Ethernet1:oper', 'port:Ethernet2:removed', 'port:Ethernet3:added', 'bgp:default|10.0.0.1:state', 'xcvr:Ethernet1:pulled', 'lldp:Ethernet1:neighbor']) assert.ok(f.includes(w), w);
  assert.ok(!f.includes('port:Ethernet1:desc'), '설명을 못 읽은 쪽은 비교하지 않는다');
  const all = SD.diffSnapshots(new Map([['k1', c1], ['k2', c1]]), new Map([['k1', c2], ['k3', c2]]));
  assert.equal(all.counts.removed, 1); assert.equal(all.counts.added, 1); assert.equal(all.counts.devicesChanged, 1);
});

test('⑥ 위치 찾기', () => {
  assert.deepEqual(LC.parseQuery('00:50:56:AA:BB:CC'), { kind: 'mac', mac: '005056aabbcc' });
  assert.equal(LC.parseQuery('0050.56aa.bbcc').mac, '005056aabbcc');
  assert.equal(LC.parseQuery('10.1.2.3').kind, 'ip');
  assert.equal(LC.parseQuery('10.01.2.3').kind, 'bad', '비정규 IPv4 표기');
  assert.equal(LC.parseQuery('a').kind, 'bad'); assert.equal(LC.parseQuery('  ').kind, 'empty');
  assert.equal(LC.parseQuery('web-01').kind, 'name');
  const snap = { vms: [{ id: 'vm1', name: 'web-01', vcenterId: 'vc1', host: 'esx-01', ipAddress: '10.1.2.3', dev: { nics: [{ mac: '00:50:56:aa:bb:cc' }] } }],
    hosts: [{ id: 'h1', name: 'esx-01.corp', vcenterId: 'vc1', nics: [{ device: 'vmnic0', mac: 'aa:bb:cc:dd:ee:01' }] }] };
  assert.equal(LC.subjectsOf(LC.parseQuery('10.1.2.3'), snap).subjects[0].macs[0], '005056aabbcc');
  assert.deepEqual(LC.subjectsOf(LC.parseQuery('esx-01'), snap).subjects.map((x) => x.type), ['host'], '이름 일치만 — VM 이 올라간 호스트 이름으로 VM 을 고르지 않는다');
  const fdb = [{ agent: '', cvpId: 'c1', key: 'L1', hostname: 'leaf', port: 'Ethernet5', mac: '005056aabbcc', vlan: 10 },
    { agent: '', cvpId: 'c1', key: 'S1', hostname: 'spine', port: 'Ethernet1', mac: '005056aabbcc', vlan: 10 },
    { agent: '', cvpId: 'c1', key: 'L2', hostname: 'leaf2', port: 'Port-Channel1', mac: '005056aabbcc', vlan: 10 }];
  const ups = new Map([['\u0000c1\u0000S1', new Set(['et1'])], ['\u0000c1\u0000L1', new Set()]]);
  const mc = new Map([['\u0000c1\u0000L2', new Map([['Port-Channel1', 300]])]]);
  const r = LC.placeRows({ fdb, ep: [{ ...fdb[0], at: 1 }], uplinks: ups, macCount: mc });
  assert.deepEqual(r.edge.map((x) => x.hostname), ['leaf']); assert.deepEqual(r.edge[0].sources, ['fdb', 'cvp']);
  assert.deepEqual(r.transit.map((x) => [x.hostname, x.basis]), [['spine', 'lldp'], ['leaf2', 'macs']]);
});

test('⑥-2 GBIC 추세 · 재고', () => {
  const k = '\u0000c1\u0000S1\u0000Ethernet1';
  const pts = Array.from({ length: 30 }, (_, i) => [NOW - (29 - i) * DAY, -6 - i * 0.1, -2]);
  const t = OT.opticTrends({ series: new Map([[k, pts], ['\u0000c1\u0000S1\u0000Ethernet2', pts.slice(-5)]]), names: new Map([['\u0000c1\u0000S1', { hostname: 'sw1' }]]), warnDbm: -10, faultDbm: -14, now: NOW });
  const by = Object.fromEntries(t.rows.map((x) => [x.intf, x.state]));
  assert.equal(by.Ethernet1, 'eta'); assert.equal(by.Ethernet2, 'short');
  const inv = OT.opticInventory([{ partsList: [{ kind: 'xcvr', name: 'a', state: 'ok', media: 'SR', optic: { linked: true } }, { kind: 'xcvr', name: 'b', state: 'ok', media: 'SR', optic: { linked: false } },
    { kind: 'xcvr', name: 'c', state: 'absent' }] }, { partsList: null }]);
  assert.deepEqual(inv.rows[0], { type: 'SR', linked: 1, spare: 1, unknown: 0 }); assert.equal(inv.totals.empty, 1); assert.equal(inv.totals.devicesUnread, 1);
});

let srv; let base; let cdb; let cvpId; let who = { username: 'adm', role: 'admin', scope: null };
before(async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  cdb = await import('../src/cvp/db.js');
  const reg = await import('../src/cvp/registry.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = who; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
  cvpId = reg.saveServer({ name: 'CVP-N', host: 'https://10.99.0.2', authMode: 'token', token: 't', agent: '' }).id;
});
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('⑦ DB 기록 — 플랩 · 포트 수 · GBIC 일 최저 · 마지막 링크 날 · 백필', async () => {
  if (!(await cdb.available())) return;
  const t0 = Date.now() - 60_000;
  const port = (name, oper, admin = 'up') => ({ name, oper, admin, desc: '', speedBps: 25e9, inBps: oper === 'up' ? 1 : null, inErr: oper === 'up' ? 0 : null });
  const xc = (rx, linked = true) => [{ kind: 'xcvr', name: 'xcvr › Ethernet1', state: 'ok', media: 'SR', optic: { intf: 'Ethernet1', rx, linked } }];
  const save = (ts, ports, parts) => cdb.saveDevices({ agent: '', cvpId: 'cx', devices: [{ key: 'D1', ts, hostname: 'd1', ports, ...(parts ? { parts, partsAt: ts } : {}) }], samples: true });
  await save(t0, [port('Ethernet1', 'up'), port('Ethernet2', 'up'), port('Ethernet3', 'up')], xc(-5));
  await save(t0 + 1000, [port('Ethernet1', 'nolink'), port('Ethernet2', 'up', 'down'), port('Ethernet3', 'up')], xc(-7));
  await save(t0 + 500, [port('Ethernet1', 'up'), port('Ethernet2', 'up'), port('Ethernet3', 'down')], xc(-99));   // 옛 레코드 — 무시
  await save(t0 + 2000, [port('Ethernet1', 'up'), port('Ethernet2', 'up'), port('Ethernet3', 'up')], xc(-8, false));
  const fl = await cdb.flapWindow({ days: 1 });
  assert.equal(fl.map.get('\u0000cx\u0000D1\u0000Ethernet1')?.downs, 1, 'up → nolink 한 번');
  assert.equal(fl.map.has('\u0000cx\u0000D1\u0000Ethernet2'), false, '관리상 꺼짐은 플랩이 아니다');
  assert.equal(fl.map.has('\u0000cx\u0000D1\u0000Ethernet3'), false, '늦게 온 옛 레코드는 세지 않는다');
  const dp = await cdb.devPortSeries({ days: 1 });
  assert.deepEqual(dp.map.get('\u0000cx\u0000D1').map((x) => [x[1], x[2]]), [[3, 3]], '전체 3 · 사용 최대 3');
  const xs = await cdb.xcvrSeries({ days: 1 });
  assert.equal(xs.map.get('\u0000cx\u0000D1\u0000Ethernet1')[0][1], -7, '링크 있는 날 최저(-99 는 옛 레코드 · 링크 없는 -8 은 제외)');
  const ll = await cdb.lastLinkAll();
  assert.ok(ll.last.get('\u0000cx\u0000D1\u0000Ethernet1') != null); assert.ok(ll.first.get('\u0000cx\u0000D1') != null);
  const bf = await cdb.backfillLastLink();
  assert.equal(bf.done, true);
  assert.equal(await cdb.lastLinkBackfilled(), true);
  const e = await cdb.errWindow({ days: 1 });
  assert.equal(e.map.get('\u0000cx\u0000D1\u0000Ethernet1')?.inErr, 0, '읽은 0 은 0');
});

test('⑧ 실제 라우터 — 조회 · 가림 · 범위 403 · 스냅샷 · 비교', async () => {
  if (!(await cdb.available())) return;
  const ts = Date.now() - 5000;
  const ports = [
    { name: 'Ethernet1', desc: 'to 10.20.30.40 esx', oper: 'up', admin: 'up', speedBps: 25e9, inBps: 5, inErr: 7 },
    { name: 'Ethernet2', desc: '', oper: 'nolink', admin: 'up', speedBps: 25e9 },
    { name: 'Ethernet49/1', desc: '', oper: 'up', admin: 'up', speedBps: 100e9, inBps: 5, inErr: 0 },
  ];
  await cdb.saveDevices({ agent: cdb.LOCAL_AGENT, cvpId, devices: [
    { key: 'N1', ts, hostname: 'kr1-leaf-n1', model: 'DCS-7050SX3-48YC8-F', serial: 'N1', eosVersion: '4.30', ports, bgp: [{ peer: '10.9.9.9', vrf: 'default', state: 'Established' }] },
    { key: 'N2', ts, hostname: 'kr1-spine-n2', model: 'DCS-7504N', serial: 'N2', ports: [{ name: 'Ethernet3/1', desc: '', oper: 'up', admin: 'up', speedBps: 100e9 }] },
  ], samples: true });
  await cdb.saveL2('', cvpId, [{ key: 'N1', ts, lldp: [{ port: 'Ethernet49/1', idx: '1', sysName: 'kr1-spine-n2', portId: 'Ethernet3/1' }] },
    { key: 'N2', ts, lldp: [{ port: 'Ethernet3/1', idx: '1', sysName: 'kr1-leaf-n1', portId: 'Ethernet49/1' }] }]);
  const get = async (p) => { const r = await fetch(`${base}${p}`); return { s: r.status, j: await r.json() }; };
  for (const p of ['/tools/cvp/linkq', '/tools/cvp/portplan/reclaim', '/tools/cvp/portplan/forecast', '/tools/cvp/optics/trend', '/tools/cvp/topology', '/tools/cvp/locate?q=kr1', '/tools/cvp/snapshots']) {
    const { s } = await get(p);
    assert.equal(s, 200, p);
  }
  let { j } = await get('/tools/cvp/linkq');
  const e1 = j.rows.find((x) => x.port === 'Ethernet1' && x.key === 'N1');
  assert.equal(e1?.verdict, 'peer'); assert.ok(e1.desc.includes('10.20.30.40'), 'admin 은 원문');
  ({ j } = await get('/tools/cvp/topology'));
  assert.ok(j.links.some((l) => l.kind === 'both'), '양쪽이 서로 본 링크');
  ({ j } = await get('/tools/cvp/portplan/forecast'));
  assert.ok(j.saturation.rows.some((x) => x.port === 'Ethernet49/1' && x.basis === 'lldp' && x.state === 'short'));
  assert.equal((await get('/tools/cvp/locate?q=a')).s, 400);
  assert.equal((await get('/tools/cvp/linkq?cvpId=nope')).s, 404);

  who = { username: 'op', role: 'operator', scope: null };
  ({ j } = await get('/tools/cvp/linkq'));
  assert.ok(!JSON.stringify(j).includes('10.20.30.40'), '비-admin 은 설명의 주소를 가린다'); assert.equal(j.addressHidden, true);
  let r = await fetch(`${base}/tools/cvp/snapshots`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: '작업 전', cvpId }) });
  assert.equal(r.status, 200);
  const snapId = (await r.json()).id;
  // 바꾼다: 버전 · 포트 상태 · BGP
  await cdb.saveDevices({ agent: '', cvpId, devices: [{ key: 'N1', ts: ts + 1000, hostname: 'kr1-leaf-n1', model: 'DCS-7050SX3-48YC8-F', eosVersion: '4.31',
    ports: [{ ...ports[0], oper: 'nolink' }, ports[1], ports[2]], bgp: [{ peer: '10.9.9.9', vrf: 'default', state: 'Active' }] }] });
  ({ j } = await get(`/tools/cvp/compare?a=${snapId}&b=now`));
  const n1 = j.devices.find((d) => d.hostname === 'kr1-leaf-n1');
  const f = n1.changes.map((c) => `${c.kind}:${c.field}`);
  assert.ok(f.includes('device:version') && f.includes('port:oper') && f.includes('bgp:state'), f.join());
  assert.ok(!JSON.stringify(j).includes('10.9.9.9'), '비-admin 은 BGP 피어 주소를 가린다');
  assert.equal(j.scopeCvpId, cvpId);

  who = { username: 'vw', role: 'viewer', scope: null };
  r = await fetch(`${base}/tools/cvp/snapshots`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403, '조회 계정은 스냅샷을 찍지 못한다');
  r = await fetch(`${base}/tools/cvp/snapshots/${snapId}`, { method: 'DELETE' });
  assert.equal(r.status, 403);
  who = { username: 'sc', role: 'operator', scope: { vcenters: ['vc-1'] } };
  for (const p of ['/tools/cvp/linkq', '/tools/cvp/topology', '/tools/cvp/locate?q=kr1', `/tools/cvp/compare?a=${snapId}`, '/tools/cvp/optics/trend']) assert.equal((await get(p)).s, 403, `범위 계정 ${p}`);
  who = { username: 'adm', role: 'admin', scope: null };
  r = await fetch(`${base}/tools/cvp/snapshots/${snapId}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.equal((await get(`/tools/cvp/compare?a=${snapId}`)).s, 404);
});
