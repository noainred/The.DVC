/**
 * test/cvpBugRound342.test.js — v3.42 CVP 버그 점검 1회차(5축 × 반증 1인) 확정분 회귀.
 *  ① 토폴로지 — MLAG 리프 쌍 층 · 관리 포트 제외 · 법인 간 동명 장비 · duplex 모름 · portId 없는 같은 케이블 · 양쪽 설명 링크는 합치지 않음
 *  ② 포트 구성도 — 이웃 여럿 · 설명 낱말(앵커 · '/' · '_' · 인터페이스 접미) · 속도 모르는 예비
 *  ③ 위치 찾기 — 가상화 호스트 포트는 MAC 이 많아도 가장자리
 *  ④ 판정 — 버그 기록 없음 · 추세 오래됨 · GBIC 창(날짜) · 고갈 used>total · 포화 상한 · 스냅샷 깨짐 · 그대로 수 · QSFP 레인 · MLAG 도메인만
 *  ⑤ 엣지 정제 — bootAt 수신 시각 · readKinds 중복 · 포트 상한 → 일부 표지
 *  ⑥ DB — 일부 목록이면 옛 포트 행을 지우지 않음 · 포트 못 읽은 장비 제외 · 스냅샷 저장 중 삭제 · 관리 포트는 포트 수에서 제외
 *  ⑦ 실제 라우터 — 채널 소속 '' 복원(양끝 · 전후 비교) · 범위가 다른 스냅샷 비교 400 · 비-admin MLAG 가림(장비 목록 · 이중화)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvpbug342-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';

const TP = await import('../src/cvp/topology.js');
const PM = await import('../src/cvp/portmap.js');
const LC = await import('../src/cvp/locate.js');
const CP = await import('../src/cvp/compliance.js');
const T = await import('../src/cvp/trend.js');
const OT = await import('../src/cvp/opticstrend.js');
const PP = await import('../src/cvp/portplan.js');
const SD = await import('../src/cvp/snapdiff.js');
const P = await import('../src/cvp/parse.js');
const E = await import('../src/central/cvpEdge.js');
const DAY = 86_400_000;
// 기준 시각: 실제 시각을 UTC 자정으로 떨어뜨려 고정(docs/rules/common.md)
const NOW = Math.floor(Date.now() / DAY) * DAY + 12 * 3_600_000;

const D = (key, hostname, cvpId = 'c1', agent = '') => ({ agent, cvpId, key, hostname });
const L = (key, port, sysName, portId = '', cvpId = 'c1', agent = '') => ({ agent, cvpId, key, port, sysName, portId });
const layers = (t) => Object.fromEntries(t.nodes.map((n) => [n.hostname, n.layer]));

test('① 토폴로지', () => {
  // MLAG 리프 쌍(피어 링크) · 서버 LLDP 없음 → 리프가 '스파인' 으로 오르지 않는다(A1-04)
  const devs = ['sp1', 'sp2', 'lf1', 'lf2', 'lf3', 'lf4'].map((k) => D(k, k));
  const ll = [];
  const link = (a, ap, b, bp) => { ll.push(L(a, ap, b, bp)); ll.push(L(b, bp, a, ap)); };
  ['lf1', 'lf2', 'lf3', 'lf4'].forEach((lf, i) => { link(lf, 'Ethernet49/1', 'sp1', `Ethernet${i + 1}`); link(lf, 'Ethernet50/1', 'sp2', `Ethernet${i + 1}`); });
  link('lf1', 'Ethernet47', 'lf2', 'Ethernet47'); link('lf3', 'Ethernet47', 'lf4', 'Ethernet47');
  assert.deepEqual(layers(TP.buildTopology({ devices: devs, lldp: ll })), { sp1: 'spine', sp2: 'spine', lf1: 'leaf', lf2: 'leaf', lf3: 'leaf', lf4: 'leaf' });
  // 삼각형(스파인 하나를 공유하는 리프 둘이 서로 연결)은 피어로 보지 않는다 — 공유 이웃 2 이상만
  const tri = TP.buildTopology({ devices: ['s', 'a', 'b'].map((k) => D(k, k)), lldp: [L('a', 'E1', 's', 'E1'), L('s', 'E1', 'a', 'E1'), L('b', 'E1', 's', 'E2'), L('s', 'E2', 'b', 'E1'), L('a', 'E2', 'b', 'E2'), L('b', 'E2', 'a', 'E2')] });
  assert.equal(tri.links.length, 3);

  // 관리 포트 LLDP(CVP 밖 OOB 스위치)는 층 · 이웃 수 · 업링크에 넣지 않는다(A1-05)
  const mg = [...ll, ...devs.map((d) => L(d.key, 'Management1', 'oob-sw01', 'Gi0/1'))];
  const tm = TP.buildTopology({ devices: devs, lldp: mg });
  assert.equal(layers(tm).sp1, 'spine');
  assert.equal(tm.nodes.find((n) => n.hostname === 'sp1').otherNeighbors, 0);
  const up = TP.uplinkPortsOf([L('lf1', 'Management1', 'sp1', 'Ethernet9'), L('lf1', 'Ethernet49/1', 'sp1', 'Ethernet1')], TP.switchIndex(devs));
  assert.deepEqual([...up.get('\u0000c1\u0000lf1')], [TP.normPort('Ethernet49/1')]);

  // 법인(CVP) 간 같은 이름 — 보고한 장비와 같은 CVP 후보를 고른다(A1-06)
  const two = [D('SA', 'spine1', 'cA', 'eA'), D('LA', 'leaf1', 'cA', 'eA'), D('SB', 'spine1', 'cB', 'eB'), D('LB', 'leaf1', 'cB', 'eB')];
  const idx = TP.switchIndex(two);
  assert.equal(idx.find('spine1'), null, '어느 CVP 인지 모르면 맞추지 않는다');
  assert.equal(idx.find('spine1', 'eB\u0000cB\u0000LB'), 'eB\u0000cB\u0000SB');
  assert.equal(idx.find('spine1.kr.corp', 'eA\u0000cA\u0000LA'), 'eA\u0000cA\u0000SA', '짧은 이름 충돌도 같은 CVP 로');
  const t2 = TP.buildTopology({ devices: two, lldp: [L('LB', 'Ethernet49', 'spine1', 'Ethernet1', 'cB', 'eB'), L('SB', 'Ethernet1', 'leaf1', 'Ethernet49', 'cB', 'eB')] });
  assert.equal(t2.links.length, 1); assert.equal(t2.links[0].kind, 'both');
  assert.ok(t2.links[0].a.includes('cB') && t2.links[0].b.includes('cB'), '다른 법인 장비로 꽂히지 않는다');

  // duplex 'unknown' 은 못 읽은 값(A1-11)
  const c = TP.compareEnds({ duplex: 'duplexUnknown', speedBps: 1e9 }, { duplex: 'duplexFull', speedBps: 1e9 });
  assert.equal(c.find((x) => x.field === 'duplex')?.state ?? 'na', 'na');

  // 한쪽 portId 가 비어도 같은 케이블은 한 줄(A1-12 ②) · 양쪽 설명 링크는 짝을 지어내지 않는다(반증 D-6)
  const one = TP.buildTopology({ devices: [D('A', 'swa'), D('B', 'swb')], lldp: [L('A', 'Ethernet1', 'swb', ''), L('B', 'Ethernet7', 'swa', 'Ethernet1')] });
  assert.equal(one.links.length, 1);
  const ds = TP.buildTopology({ devices: [D('A', 'sw-a1'), D('B', 'sw-b1')], lldp: [],
    ports: [{ agent: '', cvpId: 'c1', key: 'A', port: 'Ethernet1', oper: 'up', desc: 'to sw-b1' }, { agent: '', cvpId: 'c1', key: 'A', port: 'Ethernet2', oper: 'up', desc: 'to sw-b1' },
      { agent: '', cvpId: 'c1', key: 'B', port: 'Ethernet1', oper: 'up', desc: 'to sw-a1' }] });
  assert.ok(ds.links.every((l) => l.kind === 'desc' && l.bPort == null), '설명 링크의 상대 포트를 지어내지 않는다');
});

test('② 포트 구성도', () => {
  const up = { oper: 'up' };
  assert.deepEqual(PM.evidenceOf({ ...up, desc: 'esx-02 vmnic0' }, [{ sysName: 'fw-01' }, { sysName: 'esx-02.corp.local' }], true), { ev: 'match', device: 'esx-02.corp.local', lldpUnread: false });
  assert.equal(PM.evidenceOf({ ...up, desc: 'svr-01_eth0' }, [{ sysName: 'svr-01' }], true).ev, 'match');
  assert.equal(PM.evidenceOf({ ...up, desc: 'spine1/Et1' }, [{ sysName: 'spine1' }], true).ev, 'match');
  assert.equal(PM.evidenceOf({ ...up, desc: 'esx01-vmnic0' }, [{ sysName: 'esx01' }], true).ev, 'match');
  assert.equal(PM.evidenceOf({ ...up, desc: 'old-host vmnic0' }, [{ sysName: 'esx01' }], true).ev, 'mismatch');
  assert.equal(PM.deviceNameFromDesc('TESTDB01 vlan100'), 'TESTDB01', '접두가 te 인 호스트 이름을 인터페이스로 보지 않는다');
  assert.equal(PM.deviceNameFromDesc('POD1LEAF01 Et49'), 'POD1LEAF01');
  assert.equal(PM.deviceNameFromDesc('port-channel10 uplink'), '', '포트 채널 이름은 장비가 아니다');
  assert.equal(PM.deviceNameFromDesc('esx01-vmnic2'), 'esx01');
  assert.equal(PM.deviceNameFromDesc('te-sw01 trunk'), 'te-sw01');
  // ReDoS 가드: 긴 입력도 선형(길이를 먼저 자른다)
  // ReDoS 가드는 비율로(루트 CLAUDE.md — 절대 시간은 CPU 에 따라 깨진다): 입력 10배에 시간이 초선형으로 늘지 않는다(앞에서 200자로 자른다).
  const tm = (n) => { const t = performance.now(); for (let i = 0; i < 50; i++) { PM.deviceNameFromDesc(`${'a-'.repeat(n)}vmnic1`); PM.descTokens('x_'.repeat(n)); } return performance.now() - t; };
  tm(500); const small = tm(500); const big = tm(5000);
  assert.ok(big < small * 30 + 20, `5,000 → ${big.toFixed(1)}ms · 500 → ${small.toFixed(1)}ms(선형이면 10배 이하)`);
  // 속도를 못 읽은 예비가 있으면 '40G 이상 예비' 를 0 으로 단정하지 않는다(A2-F4)
  const s = PM.summaryRow({ model: 'DCS-7050SX3-48YC8', ports: [{ name: 'Ethernet1', oper: 'nolink', admin: 'up', desc: '', speedBps: null }, { name: 'Ethernet2', oper: 'nolink', admin: 'up', desc: '', speedBps: null }] });
  assert.equal(s.spareHigh, null); assert.equal(s.spareSpeedUnknown, 2);
  const k = PM.summaryRow({ model: 'DCS-7050SX3-48YC8', ports: [{ name: 'Ethernet49/1', oper: 'nolink', admin: 'up', desc: '', speedBps: 100e9 }] });
  assert.equal(k.spareHigh, 1);
});

test('③ 위치 찾기 — 가상화 호스트 포트', () => {
  const dk = '\u0000c1\u0000L1';
  const fdb = [{ agent: '', cvpId: 'c1', key: 'L1', hostname: 'leaf', mac: '005056aabbcc', port: 'Ethernet5' }];
  const macCount = new Map([[dk, new Map([['Ethernet5', 80]])]]);
  assert.equal(LC.placeRows({ fdb, uplinks: new Map([[dk, new Set()]]), macCount }).transit.length, 1, '대조: 호스트 표지가 없으면 MAC 수 규칙');
  const hp = TP.hostPortsOf([L('L1', 'Ethernet5', 'esx-07.corp', 'vmnic0'), L('L1', 'Management1', 'esx-07', 'x')], new Set(['esx-07']));
  assert.deepEqual([...hp.get(dk)], [TP.normPort('Ethernet5')]);
  const r = LC.placeRows({ fdb, uplinks: new Map([[dk, new Set()]]), macCount, hostPorts: hp });
  assert.equal(r.edge.length, 1, 'VM 이 많은 ESXi 포트도 가장자리'); assert.equal(r.transit.length, 0);
});

test('④ 판정', () => {
  const rk = ['enrich', 'lifecycle', 'bugs'];
  assert.deepEqual([CP.bugState({ readKinds: rk }).state, CP.bugState({ readKinds: rk }).bugCount], ['norecord', null]);
  // 추세 — 마지막 기록이 오래되면 그 값을 지금으로 쓰지 않는다
  const old = Array.from({ length: 100 }, (_, i) => [NOW - (160 - i) * DAY, i]);
  assert.equal(T.forecast(old, { target: 200, minDays: 90, now: NOW }).state, 'stale');
  // GBIC 창은 날짜(최근 30일) — 61일 전에 끊긴 하강 기록이 '오늘 도달' 이 되지 않는다(A1-07)
  const k = '\u0000c1\u0000S1\u0000Ethernet1';
  const pts = Array.from({ length: 30 }, (_, i) => [NOW - (90 - i) * DAY, -6 - i * 0.1]);
  const ot = OT.opticTrends({ series: new Map([[k, pts]]), names: new Map(), now: NOW });
  assert.equal(ot.rows[0].state, 'stale'); assert.equal(ot.rows[0].current, null); assert.equal(ot.counts.stale, 1);
  // 고갈 — 하루 안에 목록이 줄어 used_max > total 인 날은 쓰지 않는다(A1-08)
  const ser = new Map([['\u0000c1\u0000S1', Array.from({ length: 100 }, (_, i) => [NOW - (99 - i) * DAY, 48, i === 99 ? 50 : 20])]]);
  const ex = PP.exhaustForecast({ devices: [{ agent: '', cvpId: 'c1', key: 'S1', hostname: 's1' }], series: ser, now: NOW });
  assert.notEqual(ex.rows[0].state, 'already');
  // 포화 — 응답 상한 · 생략 수
  const ups = Array.from({ length: PP.SAT_ROWS_MAX + 5 }, (_, i) => ({ agent: '', cvpId: 'c1', key: 'S1', hostname: 's1', port: `Ethernet${i}` }));
  const sat = PP.saturationForecast({ uplinks: ups, series: new Map(), now: NOW });
  assert.equal(sat.rows.length, PP.SAT_ROWS_MAX); assert.equal(sat.omitted, 5);
  // 스냅샷 — 깨진 행은 '새로 생김' 이 아니라 비교 못 함 · 비교 못 한 장비는 '그대로' 에 세지 않는다
  const body = (h) => SD.snapshotBody({ device: { hostname: h, portsRead: true }, ports: [{ port: 'Ethernet1', oper: 'up', admin: 'up' }] });
  const d = SD.diffSnapshots(new Map([['a', body('sw1')]]), new Map([['a', body('sw1')], ['b', body('sw2')]]), { broken: new Set(['b']) });
  assert.equal(d.counts.added, 0); assert.equal(d.devices.find((x) => x.hostname === 'sw2')?.state, 'na');
  const na = SD.diffSnapshots(new Map([['k', { ...body('sw3'), p: null }]]), new Map([['k', body('sw3')]]));
  assert.equal(na.unchanged, 0);
  // QSFP — 트랜시버 이름이 칸(Ethernet49)이고 포트는 레인(Ethernet49/1)이면 레인으로 링크를 본다(A1-03)
  const parts = [{ kind: 'xcvr', name: 'xcvr › Ethernet49', state: 'ok', dom: { rxPower: -3 } }];
  const j = P.judgeOptics(parts, [{ name: 'Ethernet49/1', oper: 'up' }], {});
  assert.equal(j[0].optic?.linked, true);
  // MLAG — 도메인 · 로컬 인터페이스만 있고 상태가 없으면 값으로 보지 않는다(로컬 · 엣지 판정이 같게)
  const segs = (p) => p.split('/').filter(Boolean);
  const n = (p, u) => JSON.stringify({ notifications: [{ timestamp: '1737996752057206753', path_elements: segs(p), updates: u }] });
  assert.equal(P.parseMlag(n('/Sysdb/mlag/status', { domainId: { value: 'D1' }, localInterface: { value: 'Vlan4094' } })).status, null);
  assert.ok(P.parseMlag(n('/Sysdb/mlag/status', { domainId: { value: 'D1' }, mlagState: { value: { Name: 'mlagStateActive' } } })).status, '대조: 상태가 있으면 값');
});

test('⑤ 엣지 정제', () => {
  const now = NOW;
  assert.equal(E.cleanInfo({ bootAt: now + 10 * 365 * DAY }, now).bootAt, now, '미래 bootAt 은 수신 시각으로 자른다');
  assert.deepEqual(E.cleanInfo({ readKinds: Array.from({ length: 1000 }, () => 'bugs') }, now).readKinds, ['bugs']);
  const many = Array.from({ length: 5000 }, (_, i) => ({ name: `Ethernet${i}`, oper: 'up', admin: 'up' }));
  const dv = E.cleanDevice({ key: 'k', ts: now - 1000, ports: many }, now);
  assert.equal(dv.portsPartial, true, '상한으로 잘린 목록은 일부 표지');
  assert.equal(E.cleanDevice({ key: 'k', ts: now - 1000, ports: many.slice(0, 3) }, now).portsPartial, undefined);
});

let srv; let base; let cdb; let cvpId; let cvpId2; let who = { username: 'adm', role: 'admin', scope: null };
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
  cvpId = reg.saveServer({ name: 'CVP-B1', host: 'https://10.99.0.21', authMode: 'token', token: 't', agent: '' }).id;
  cvpId2 = reg.saveServer({ name: 'CVP-B2', host: 'https://10.99.0.22', authMode: 'token', token: 't', agent: '' }).id;
});
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('⑥ DB', async () => {
  if (!(await cdb.available())) return;
  const t0 = Date.now() - 60_000;
  const port = (name, oper = 'up') => ({ name, oper, admin: 'up', desc: '', speedBps: 25e9 });
  await cdb.saveDevices({ agent: '', cvpId: 'dz', devices: [{ key: 'P1', ts: t0, hostname: 'p1', ports: [port('Ethernet1'), port('Ethernet2'), port('Ethernet3'), port('Management1')] }] });
  // 일부 목록(portsPartial)이면 목록에 없는 포트를 지우지 않는다
  await cdb.saveDevices({ agent: '', cvpId: 'dz', devices: [{ key: 'P1', ts: t0 + 1000, hostname: 'p1', portsPartial: true, ports: [port('Ethernet1')] }] });
  let pr = await cdb.portRowsOf([{ agent: '', cvpId: 'dz', key: 'P1', portsRead: true }]);
  assert.equal(pr.rows.length, 4, '잘린 목록이 옛 포트 행을 지우지 않는다');
  await cdb.saveDevices({ agent: '', cvpId: 'dz', devices: [{ key: 'P1', ts: t0 + 2000, hostname: 'p1', ports: [port('Ethernet1'), port('Management1')] }] });
  pr = await cdb.portRowsOf([{ agent: '', cvpId: 'dz', key: 'P1', portsRead: true }]);
  assert.equal(pr.rows.length, 2, '대조: 온전한 목록이면 사라진 포트를 지운다');
  // 포트를 못 읽은 장비의 옛 행은 싣지 않는다
  pr = await cdb.portRowsOf([{ agent: '', cvpId: 'dz', key: 'P1', portsRead: false }]);
  assert.deepEqual([pr.rows.length, pr.unread], [0, 1]);
  // 관리 포트는 포트 수(고갈 예측)에 넣지 않는다
  const dp = await cdb.devPortSeries({ days: 1 });
  assert.equal(dp.map.get('\u0000dz\u0000P1').at(-1)[1], 1, '전체 = 데이터 포트만');
  // 스냅샷 저장 중에 지우면 성공으로 돌려주지 않는다
  const body = SD.snapshotBody({ device: { hostname: 'x', portsRead: true }, ports: [] });
  const bodies = Array.from({ length: 160 }, (_, i) => ({ agent: '', cvpId: 'dz', key: `K${i}`, body }));
  const p = cdb.createSnap({ by: 't', bodies });
  const gone = assert.rejects(p, (e) => e.code === 'SNAP_GONE');   // 처리기를 먼저 단다(기다리는 사이 거부되면 처리 안 된 거부가 된다)
  let id = null;
  for (let i = 0; i < 200 && id == null; i++) { await new Promise((r) => setImmediate(r)); id = (await cdb.listSnaps()).rows.find((x) => !x.done)?.id ?? null; }
  assert.ok(id != null, '저장 중 행이 보인다');
  await cdb.deleteSnap(id);
  await gone;
  assert.equal((await cdb.listSnaps()).rows.some((x) => x.id === id), false, '반쪽 스냅샷을 남기지 않는다');
});

test('⑦ 실제 라우터', async () => {
  if (!(await cdb.available())) return;
  const ts = Date.now() - 600_000;
  const cfg = { vlan: ts, lag: ts };
  const pt = (lag) => [{ name: 'Ethernet1', desc: '', oper: 'up', admin: 'up', speedBps: 25e9, lag, vlan: 'trunk' }];
  await cdb.saveDevices({ agent: '', cvpId, devices: [
    { key: 'A', ts, hostname: 'sw-a', model: 'DCS-7050SX3-48YC8', cfgReadAt: cfg, ports: pt('Port-Channel10'),
      mlagStatus: { state: 'active', negotiation: 'connected', peerLinkState: 'up', domain: 'mlag-10.77.1.1', peerLink: 'Port-Channel1000', localIntf: 'Vlan4094', at: ts } },
    { key: 'B', ts, hostname: 'sw-b', model: 'DCS-7050SX3-48YC8', cfgReadAt: cfg, ports: pt('') },
  ] });
  await cdb.saveL2('', cvpId, [{ key: 'A', ts, lldp: [{ port: 'Ethernet1', idx: '1', sysName: 'sw-b', portId: 'Ethernet1' }] }, { key: 'B', ts, lldp: [{ port: 'Ethernet1', idx: '1', sysName: 'sw-a', portId: 'Ethernet1' }] }]);
  const get = async (p) => { const r = await fetch(`${base}${p}`); return { s: r.status, j: await r.json() }; };
  // 채널 소속 '' 는 DB 에서 NULL 이지만 소속을 읽은 장비면 '없음' 으로 복원 — 한쪽만 채널이면 '다름'(C1)
  let { j } = await get(`/tools/cvp/topology?cvpId=${cvpId}`);
  const lg = j.links[0].items.find((x) => x.field === 'lag');
  assert.equal(lg.state, 'diff'); assert.deepEqual([lg.a, lg.b].sort(), ['no', 'yes']);
  // 전후 비교 — 채널 가입이 보인다
  let r = await fetch(`${base}/tools/cvp/snapshots`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: '전', cvpId }) });
  const snapA = (await r.json()).id;
  await cdb.saveDevices({ agent: '', cvpId, devices: [{ key: 'B', ts: ts + 1000, hostname: 'sw-b', model: 'DCS-7050SX3-48YC8', cfgReadAt: { vlan: ts + 1000, lag: ts + 1000 }, ports: pt('Port-Channel10') }] });
  ({ j } = await get(`/tools/cvp/compare?a=${snapA}&b=now`));
  const b = j.devices.find((x) => x.hostname === 'sw-b');
  assert.ok(b && b.changes.some((c) => c.field === 'lag' && c.before === '' && c.after === 'Port-Channel10'), JSON.stringify(b));
  // 범위가 다른 스냅샷끼리 비교는 400(전부 사라짐을 지어내지 않는다)
  await cdb.saveDevices({ agent: '', cvpId: cvpId2, devices: [{ key: 'Z', ts, hostname: 'sw-z', ports: pt('') }] });
  r = await fetch(`${base}/tools/cvp/snapshots`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: '다른 CVP', cvpId: cvpId2 }) });
  const snapB = (await r.json()).id;
  assert.equal((await get(`/tools/cvp/compare?a=${snapA}&b=${snapB}`)).s, 400);
  // 비-admin — MLAG 도메인 문자열의 주소는 장비 목록 · 이중화 모두 가린다(C11)
  who = { username: 'op', role: 'operator', scope: null };
  for (const p of [`/tools/cvp/devices?cvpId=${cvpId}`, `/tools/cvp/redundancy?cvpId=${cvpId}`]) {
    ({ j } = await get(p));
    assert.ok(!JSON.stringify(j).includes('10.77.1.1'), `${p} 가 MLAG 주소를 싣지 않는다`);
  }
  who = { username: 'adm', role: 'admin', scope: null };
  ({ j } = await get(`/tools/cvp/redundancy?cvpId=${cvpId}`));
  assert.ok(JSON.stringify(j).includes('10.77.1.1'), '대조: admin 은 원문');
});
