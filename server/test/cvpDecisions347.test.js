/**
 * test/cvpDecisions347.test.js — v3.47 CVP 결정 6건(사용자 선택 2026-11-26) 회귀.
 *  D-1 LLDP 포트 ID 가 MAC 모양이면 비-admin 에 가린다(포트 구성도 · 토폴로지 · 전후 비교)
 *  D-3 GBIC 일 기록(xcvr_daily) 보존 120일 — 읽는 창보다 길게
 *  D-5 회수 '기록 시작 뒤 사용 없음' 의 기준 = 포트를 처음 본 날(나중에 단 포트는 그날부터 · 업그레이드 전 포트는 장비 기록 시작일)
 *  D-6 두 스위치가 서로를 설명으로 가리키는 포트가 양쪽에 하나씩일 때만 한 줄로 합친다
 *  D-7 GBIC 추세 · 링크 품질도 장비 Rx 임계(LowWarn · LowAlarm)가 먼저 — 실시간 판정과 같은 기준
 *  D-9 부품 주기의 읽기 순서: 부품 → LLDP · MAC 테이블 → VLAN · 채널 · MLAG
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvpdec347-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';

const TP = await import('../src/cvp/topology.js');
const PP = await import('../src/cvp/portplan.js');
const OT = await import('../src/cvp/opticstrend.js');
const LQ = await import('../src/cvp/linkq.js');
const P = await import('../src/cvp/parse.js');
const E = await import('../src/central/cvpEdge.js');
const DAY = 86_400_000;
// 기준 시각: 실제 시각을 UTC 자정으로 떨어뜨려 정오로 고정(docs/rules/common.md)
const NOW = Math.floor(Date.now() / DAY) * DAY + 12 * 3_600_000;

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
  cvpId = reg.saveServer({ name: 'CVP-D', host: 'https://10.99.0.31', authMode: 'token', token: 't', agent: '' }).id;
});
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('D-1 MAC 모양 포트 ID 가림 — 함수 · 포트 구성도 · 토폴로지 · 전후 비교', async () => {
  const { maskMacText } = await import('../src/routes/api/cvp.js');
  for (const v of ['00:50:56:aa:bb:cc', '00-50-56-AA-BB-CC', '0050.56aa.bbcc', '005056aabbcc']) assert.equal(maskMacText(v), '(MAC 가림)', v);
  for (const v of ['Ethernet1', 'vmnic0', 'eth0', 'aa:bb:cc:dd:ee:ff:00', '10:00:00:00:c9:aa:bb:cc', '']) assert.equal(maskMacText(v), v, `${v} 는 MAC 이 아니다`);
  assert.equal(maskMacText('esx01 00:50:56:aa:bb:cc, sw2 Ethernet3'), 'esx01 (MAC 가림), sw2 Ethernet3');
  // ReDoS 회귀는 비율로(docs/rules/common.md) — 길이 10배에 시간이 100배가 되지 않는다
  const t = (n) => { const s = 'a1:'.repeat(n); const t0 = process.hrtime.bigint(); for (let i = 0; i < 50; i++) maskMacText(s); return Number(process.hrtime.bigint() - t0); };
  t(100); assert.ok(t(1300) < t(130) * 40, '선형');
  if (!(await cdb.available())) return;
  const ts = Date.now() - 60_000;
  const pt = (name, desc = '') => ({ name, oper: 'up', admin: 'up', speedBps: 25e9, desc });
  await cdb.saveDevices({ agent: '', cvpId, devices: [{ key: 'S1', ts, hostname: 'sw-1', model: 'DCS-7050SX3-48YC8', ports: [pt('Ethernet1'), pt('Ethernet49')] }, { key: 'S2', ts, hostname: 'sw-2', ports: [pt('Ethernet50')] }] });
  // 스위치 ↔ 스위치인데 상대가 포트 ID 를 MAC 으로 알리는 경우(LLDP 포트 ID 하위형식 macAddress) — 토폴로지 링크의 상대 포트로 들어간다
  await cdb.saveDevices({ agent: '', cvpId, devices: [{ key: 'S3', ts, hostname: 'sw-3', ports: [pt('Ethernet1')] }] });
  await cdb.saveL2('', cvpId, [{ key: 'S1', ts, lldp: [{ port: 'Ethernet1', idx: '1', sysName: 'esx-77', portId: '00:50:56:aa:bb:cc' }, { port: 'Ethernet49', idx: '1', sysName: 'sw-2', portId: 'Ethernet50' }] },
    { key: 'S2', ts, lldp: [{ port: 'Ethernet50', idx: '1', sysName: 'sw-1', portId: 'Ethernet49' }] },
    { key: 'S3', ts, lldp: [{ port: 'Ethernet1', idx: '1', sysName: 'sw-1', portId: '00:1c:73:aa:bb:01' }] }]);
  const get = async (p) => { const r = await fetch(`${base}${p}`); return { s: r.status, j: await r.json() }; };
  who = { username: 'op', role: 'operator', scope: null };
  let { s, j } = await get(`/tools/cvp/portmap?cvpId=${cvpId}&key=S1`);
  assert.equal(s, 200);
  const e1 = j.ports.find((p) => p.name === 'Ethernet1');
  assert.equal(e1.lldp.portId, '(MAC 가림)', '비-admin 포트 구성도');
  assert.equal(j.ports.find((p) => p.name === 'Ethernet49').lldp.portId, 'Ethernet50', '인터페이스 이름은 그대로');
  ({ j } = await get(`/tools/cvp/topology?cvpId=${cvpId}`));
  assert.ok(j.links.some((l) => l.bPort === '(MAC 가림)'), JSON.stringify(j.links.map((l) => [l.aName, l.bName, l.bPort])));
  assert.ok(!JSON.stringify(j).includes('00:1c:73:aa:bb:01'), '비-admin 토폴로지에 MAC 포트 ID 가 없다');
  who = { username: 'adm', role: 'admin', scope: null };
  ({ j } = await get(`/tools/cvp/portmap?cvpId=${cvpId}&key=S1`));
  assert.equal(j.ports.find((p) => p.name === 'Ethernet1').lldp.portId, '00:50:56:aa:bb:cc', '대조: admin 은 원문');
  ({ j } = await get(`/tools/cvp/topology?cvpId=${cvpId}`));
  assert.ok(JSON.stringify(j).includes('00:1c:73:aa:bb:01'), '대조: admin 토폴로지는 원문');
  // 전후 비교 — LLDP 이웃 변경 문자열
  const r = await fetch(`${base}/tools/cvp/snapshots`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'd1', cvpId }) });
  const snapA = (await r.json()).id;
  await cdb.saveL2('', cvpId, [{ key: 'S1', ts: ts + 1000, lldp: [{ port: 'Ethernet1', idx: '1', sysName: 'esx-77', portId: '00:50:56:aa:bb:dd' }, { port: 'Ethernet49', idx: '1', sysName: 'sw-2', portId: 'Ethernet50' }] }]);
  who = { username: 'op', role: 'operator', scope: null };
  ({ j } = await get(`/tools/cvp/compare?a=${snapA}&b=now`));
  const ch = JSON.stringify(j.devices);
  assert.ok(ch.includes('(MAC 가림)') && !ch.includes('00:50:56:aa:bb'), ch.slice(0, 300));
  who = { username: 'adm', role: 'admin', scope: null };
  ({ j } = await get(`/tools/cvp/compare?a=${snapA}&b=now`));
  assert.ok(JSON.stringify(j.devices).includes('00:50:56:aa:bb:dd'), '대조: admin 은 원문');
});

test('D-3 GBIC 일 기록 보존 120일(읽는 창보다 길게 · 일 롤업 보존이 더 짧으면 그쪽)', async () => {
  assert.equal(cdb.XCVR_KEEP_DAYS, 120);
  assert.ok(cdb.XCVR_KEEP_DAYS > OT.TREND_DAYS + 7, '추세가 읽는 창(TREND_DAYS + 7)보다 길어야 한다');
  const routeSrc = stripComments(fs.readFileSync(new URL('../src/routes/api/cvpNet.js', import.meta.url), 'utf8'));
  for (const m of routeSrc.matchAll(/xcvrSeries\(\{ days: ([^,}]+)/g)) assert.equal(m[1].trim(), 'TREND_DAYS + 7', '새로 xcvr_daily 를 읽는 곳이 생기면 보존일과 대조할 것');
  if (!(await cdb.available())) return;
  const { dayIndex } = await import('../src/util/dayKey.js');
  const today = dayIndex(NOW);
  await cdb.importNetHistory('', { xcvr: [['cx', 'X', 'Ethernet1', today - 121, -5, -2], ['cx', 'X', 'Ethernet1', today - 119, -5, -2], ['cx', 'X', 'Ethernet1', today - 1, -5, -2]] });
  await cdb.prune({ rawRetentionDays: 7, dailyRetentionDays: 730, now: NOW });
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path.join(tmp, 'cvp.db'));
  const days = () => raw.prepare("SELECT day FROM xcvr_daily WHERE cvp_id='cx' ORDER BY day").all().map((r) => today - Number(r.day));
  assert.deepEqual(days(), [119, 1], '120일 넘은 날만 지운다');
  await cdb.prune({ rawRetentionDays: 7, dailyRetentionDays: 30, now: NOW });
  assert.deepEqual(days(), [1], '일 롤업 보존이 더 짧으면 그쪽');
  raw.close();
});

test('D-5 회수 기준 = 포트를 처음 본 날', async () => {
  // 순수 판정: 포트 처음 본 날이 있으면 그것, 없으면 장비 기록 시작일(예전)
  const port = { agent: '', cvpId: 'c', key: 'K', port: 'Ethernet3', oper: 'down', hostname: 'k' };
  const first = new Map([['\u0000c\u0000K', NOW - 120 * DAY]]);
  const r1 = PP.reclaimCandidates({ ports: [port], last: new Map(), first, portFirst: new Map([['\u0000c\u0000K\u0000Ethernet3', NOW - 10 * DAY]]), idleDays: 90, now: NOW });
  assert.deepEqual([r1.rows.length, r1.counts.young, r1.counts.never], [0, 1, 0], '나중에 단 포트는 아직 판단 못 함');
  const r0 = PP.reclaimCandidates({ ports: [port], last: new Map(), first, idleDays: 90, now: NOW });
  assert.equal(r0.rows.length, 1, '대조: 처음 본 날이 없으면 장비 기록 시작일(예전 판정)');
  if (!(await cdb.available())) return;
  const pt = (name, oper) => ({ name, oper, admin: 'up', desc: '' });
  const save = (ts, ports) => cdb.saveDevices({ agent: '', cvpId: 'cf', devices: [{ key: 'F', ts, hostname: 'f', ports }] });
  await save(NOW - 120 * DAY, [pt('Ethernet1', 'up'), pt('Ethernet2', 'down')]);
  await save(NOW - 10 * DAY, [pt('Ethernet1', 'up'), pt('Ethernet2', 'down'), pt('Ethernet3', 'down'), pt('Management1', 'down')]);
  const ll = await cdb.lastLinkAll();
  const { dayStartMs, dayIndex } = await import('../src/util/dayKey.js');
  assert.equal(ll.portFirst.get('\u0000cf\u0000F\u0000Ethernet3'), dayStartMs(dayIndex(NOW - 10 * DAY)), '새 포트는 처음 본 날');
  assert.equal(ll.portFirst.get('\u0000cf\u0000F\u0000Ethernet2'), dayStartMs(dayIndex(NOW - 120 * DAY)));
  assert.equal(ll.portFirst.has('\u0000cf\u0000F\u0000Management1'), false, '관리 포트는 적지 않는다');
  // 업그레이드 전부터 있던 포트(처음 본 날 행이 없다)는 첫 저장 때 **seed**(장비 기록 시작일을 따른다) — 날짜로 굳히지 않는다
  //   (5회차 A1-1 · A2-F1: 첫 저장 순간의 장비 시작일로 굳혔더니 그 뒤 백필이 시작일을 앞당겨도 따라가지 않아 예전 후보가 '아직 판단 못 함' 으로 빠졌다)
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path.join(tmp, 'cvp.db'));
  raw.prepare("DELETE FROM port_firstseen WHERE cvp_id='cf'").run();
  raw.prepare("UPDATE dev_linkhist SET first_day=? WHERE cvp_id='cf'").run(dayIndex(NOW - 3 * DAY));   // 백필 전 — 장비 기록 시작일이 아직 3일 전
  cdb._resetForTest();
  await save(NOW - 9 * DAY, [pt('Ethernet1', 'up'), pt('Ethernet2', 'down'), pt('Ethernet3', 'down')]);
  const seeds = () => Object.fromEntries(raw.prepare("SELECT port, seed FROM port_firstseen WHERE cvp_id='cf'").all().map((r) => [r.port, Number(r.seed)]));
  assert.deepEqual(seeds(), { Ethernet1: 1, Ethernet2: 1, Ethernet3: 1 });
  let l2 = await cdb.lastLinkAll();
  assert.equal(l2.portFirst.has('\u0000cf\u0000F\u0000Ethernet2'), false, 'seed 행은 portFirst 에 싣지 않는다(장비 기록 시작일로 떨어진다)');
  // 백필이 장비 기록 시작일을 앞당기면 회수 판정이 따라간다
  raw.prepare("UPDATE dev_linkhist SET first_day=? WHERE cvp_id='cf'").run(dayIndex(NOW - 200 * DAY));
  l2 = await cdb.lastLinkAll();
  const ports2 = [{ agent: '', cvpId: 'cf', key: 'F', port: 'Ethernet2', oper: 'down', hostname: 'f' }];
  const rc = PP.reclaimCandidates({ ports: ports2, last: l2.last, first: l2.first, portFirst: l2.portFirst, idleDays: 90, now: NOW });
  assert.deepEqual([rc.counts.never, rc.counts.young], [1, 0], '예전 판정 그대로(장비 기록 시작일 200일 전)');
  const fd = () => Object.fromEntries(raw.prepare("SELECT port, first_day FROM port_firstseen WHERE cvp_id='cf' AND seed=0").all().map((r) => [r.port, dayIndex(NOW) - Number(r.first_day)]));
  // 장비에서 사라진 포트는 지우고, 다시 나타나면 그날부터
  await save(NOW - 8 * DAY, [pt('Ethernet1', 'up'), pt('Ethernet3', 'down')]);
  assert.equal(fd().Ethernet2, undefined);
  await save(NOW - 7 * DAY, [pt('Ethernet1', 'up'), pt('Ethernet2', 'down'), pt('Ethernet3', 'down')]);
  assert.equal(fd().Ethernet2, 7);
  // 일부 목록에서 빠진 포트는 지우지 않는다(장비에서 사라진 것이 아니다)
  await cdb.saveDevices({ agent: '', cvpId: 'cf', devices: [{ key: 'F', ts: NOW - 6 * DAY, hostname: 'f', portsPartial: true, ports: [pt('Ethernet1', 'up')] }] });
  assert.equal(fd().Ethernet2, 7);
  raw.close();
});

test('D-6 양쪽 설명 링크 — 하나씩일 때만 합친다', () => {
  const D = (key, hostname) => ({ agent: '', cvpId: 'c1', key, hostname });
  const Pt = (key, port, desc) => ({ agent: '', cvpId: 'c1', key, port, oper: 'up', desc });
  const one = TP.buildTopology({ devices: [D('A', 'sw-a1'), D('B', 'sw-b1')], lldp: [], ports: [Pt('A', 'Ethernet1', 'to sw-b1'), Pt('B', 'Ethernet7', 'to sw-a1')] });
  assert.equal(one.links.length, 1);
  assert.deepEqual([one.links[0].aPort, one.links[0].bPort, one.links[0].kind, one.links[0].descPair, one.links[0].items], ['Ethernet1', 'Ethernet7', 'desc', true, null], '양끝 비교는 하지 않는다');
  const two = TP.buildTopology({ devices: [D('A', 'sw-a1'), D('B', 'sw-b1')], lldp: [], ports: [Pt('A', 'Ethernet1', 'to sw-b1'), Pt('A', 'Ethernet2', 'to sw-b1'), Pt('B', 'Ethernet7', 'to sw-a1'), Pt('B', 'Ethernet8', 'to sw-a1')] });
  assert.equal(two.links.length, 4, '케이블이 여럿이면 짝을 지어내지 않는다');
  assert.ok(two.links.every((l) => l.bPort == null && !l.descPair));
  const oneSide = TP.buildTopology({ devices: [D('A', 'sw-a1'), D('B', 'sw-b1')], lldp: [], ports: [Pt('A', 'Ethernet1', 'to sw-b1')] });
  assert.deepEqual([oneSide.links.length, oneSide.links[0].bPort], [1, null]);
});

test('D-7 장비 Rx 임계가 먼저 — 실시간 · 엣지 정제 · 링크 품질 · GBIC 추세', () => {
  const parts = [{ kind: 'xcvr', name: 'Ethernet1', state: 'ok', dom: { rxPower: -18 }, domJudge: { otherState: null, envState: null, rxDevice: 'ok', rxLow: { warnDbm: -20, faultDbm: -24 } } }];
  const j = P.judgeOptics(parts, [{ name: 'Ethernet1', oper: 'up', admin: 'up' }], { warnDbm: -10, faultDbm: -14 });
  assert.deepEqual([j[0].optic.rxState, j[0].optic.basis, j[0].optic.devWarnDbm, j[0].optic.devFaultDbm], ['ok', 'device', -20, -24]);
  // 엣지 정제 — 새 필드도 화이트리스트에(범위 밖 값은 버린다)
  const cl = E.cleanDevice({ key: 'k', ts: NOW - 1000, parts: j }, NOW);
  assert.deepEqual([cl.parts[0].optic.devWarnDbm, cl.parts[0].optic.devFaultDbm], [-20, -24]);
  const bad = E.cleanDevice({ key: 'k', ts: NOW - 1000, parts: [{ ...j[0], optic: { ...j[0].optic, devWarnDbm: -999, devFaultDbm: '-24' } }] }, NOW);
  assert.deepEqual([bad.parts[0].optic.devWarnDbm, bad.parts[0].optic.devFaultDbm], [undefined, -24]);
  // 링크 품질 — 장비 임계(-20)보다 높은 Rx(-18)는 '교체' 가 아니다(포탈 -10 이면 교체였다)
  const dev = new Map([['\u0000c\u0000k', { parts: j }]]);
  const err = new Map([['\u0000c\u0000k\u0000Ethernet1', { inErr: 5, outErr: 0, errDays: 1, days: 7 }]]);
  const lq = LQ.rankLinks({ ports: [{ agent: '', cvpId: 'c', key: 'k', port: 'Ethernet1', oper: 'up' }], devices: dev, err, warnDbm: -10, faultDbm: -14 });
  assert.deepEqual([lq.rows[0].verdict, lq.rows[0].rxBasis, lq.rows[0].rxLowDbm], ['peer', 'device', -20]);
  const noDev = [{ kind: 'xcvr', name: 'Ethernet1', state: 'ok', dom: { rxPower: -18 } }];
  const lq0 = LQ.rankLinks({ ports: [{ agent: '', cvpId: 'c', key: 'k', port: 'Ethernet1', oper: 'up' }], devices: new Map([['\u0000c\u0000k', { parts: P.judgeOptics(noDev, [{ name: 'Ethernet1', oper: 'up' }], { warnDbm: -10, faultDbm: -14 }) }]]), err, warnDbm: -10, faultDbm: -14 });
  assert.deepEqual([lq0.rows[0].verdict, lq0.rows[0].rxBasis], ['replace', 'portal'], '대조: 장비 임계가 없으면 포탈 임계');
  // GBIC 추세 — 같은 광모듈이 '이미 장애' 가 아니다
  const pts = Array.from({ length: 20 }, (_, i) => [NOW - (19 - i) * DAY, -18, null]);
  const series = new Map([['\u0000c\u0000k\u0000Ethernet1', pts]]);
  const limits = OT.deviceRxLimits([{ agent: '', cvpId: 'c', key: 'k', partsList: cl.parts }], { warnDbm: -10, faultDbm: -14 });
  const t = OT.opticTrends({ series, warnDbm: -10, faultDbm: -14, limits, now: NOW });
  assert.deepEqual([t.rows[0].state, t.rows[0].basis, t.rows[0].warnDbm, t.deviceBasis], ['flat', 'device', -20, 1]);
  assert.equal(OT.opticTrends({ series, warnDbm: -10, faultDbm: -14, now: NOW }).rows[0].state, 'alreadyFault', '대조: 포탈 임계');
  // 장비 임계가 하나만 있으면 없는 쪽은 예측하지 않는다(포탈 값과 섞지 않는다)
  assert.deepEqual(OT.rxLimitsOf({ devWarnDbm: -20 }, { warnDbm: -10, faultDbm: -14 }), { basis: 'device', warnDbm: -20, faultDbm: null });
});

test('D-9 읽기 순서 — 부품 → LLDP · MAC 테이블 → VLAN · 채널 · MLAG', () => {
  const s = stripComments(fs.readFileSync(new URL('../src/cvp/client.js', import.meta.url), 'utf8'));
  const iParts = s.indexOf('for (const k of Object.keys(PART_KINDS))');
  const iLldp = s.indexOf("readKind('lldp'");
  const iFdb = s.indexOf("readKind('fdb'");
  const iCfg = s.indexOf('await readL2Cfg(dev, serial, server.id);');
  assert.ok(iParts > 0 && iLldp > 0 && iFdb > 0 && iCfg > 0);
  assert.ok(iParts < iLldp && iLldp < iFdb && iFdb < iCfg, `순서 ${[iParts, iLldp, iFdb, iCfg]}`);
});
