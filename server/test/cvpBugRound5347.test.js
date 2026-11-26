/**
 * test/cvpBugRound5347.test.js — v3.47 CVP 버그 점검 5회차(5축 × 반증 1인) 확정분 회귀.
 *  ① D-5 다시 설계 — 업그레이드 전 포트는 seed(장비 기록 시작일을 따른다) · 장비 단위 기억 · 데모 가져오기(이른 날 · seed 합치기)
 *  ② D-6 설명에 적힌 상대 포트와 짝이 다르면 합치지 않는다
 *  ③ D-7 장애 임계만 · 뒤집힌 임계 · 링크 없던 칸의 광량 · 높은 쪽 임계만(실시간)
 *  ④ 가림 — LLDP 글자는 주소 + MAC 하나로 · MAC 표기 변형 · 전후 비교 '가린 값이 바뀜' · 호스트 근거의 남의 MAC
 *  ⑤ 링크 품질 · 회수 판정은 요청 경로에서 양보(결과는 동기판과 같다)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvpbug5347-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';

const TP = await import('../src/cvp/topology.js');
const PM = await import('../src/cvp/portmap.js');
const PP = await import('../src/cvp/portplan.js');
const OT = await import('../src/cvp/opticstrend.js');
const LQ = await import('../src/cvp/linkq.js');
const P = await import('../src/cvp/parse.js');
const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / DAY) * DAY + 12 * 3_600_000;   // 실제 시각을 UTC 자정으로 떨어뜨려 정오로(docs/rules/common.md)
const src = (rel) => stripComments(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));

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
  cvpId = reg.saveServer({ name: 'CVP-5', host: 'https://10.99.0.41', authMode: 'token', token: 't', agent: '' }).id;
});
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('① D-5 — seed · 장비 단위 기억 · 데모 가져오기', async () => {
  if (!(await cdb.available())) return;
  const { dayIndex } = await import('../src/util/dayKey.js');
  const pt = (name, oper) => ({ name, oper, admin: 'up', desc: '' });
  const save = (key, ts, ports) => cdb.saveDevices({ agent: '', cvpId: 'm5', devices: [{ key, ts, hostname: key.toLowerCase(), ports }] });
  await save('A', NOW - 30 * DAY, [pt('Ethernet1', 'up'), pt('Ethernet2', 'down')]);
  await save('B', NOW - 30 * DAY, [pt('Ethernet1', 'up'), pt('Ethernet2', 'down')]);
  assert.ok(cdb._portFirstMemoHas('', 'm5', 'A') && cdb._portFirstMemoHas('', 'm5', 'B'));
  // A4-F1: 장비 A 의 포트가 사라져도 장비 B 의 기억은 남는다(예전: 함대 전체 기억을 비워 다음 주기에 전 포트를 다시 적었다)
  await save('A', NOW - 29 * DAY, [pt('Ethernet1', 'up')]);
  assert.deepEqual([cdb._portFirstMemoHas('', 'm5', 'A'), cdb._portFirstMemoHas('', 'm5', 'B')], [false, true]);
  // 재시작 뒤 첫 저장은 DB 에서 그 장비의 적힌 포트를 읽는다 — 이미 적힌 포트의 seed · 날짜가 바뀌지 않는다
  cdb._resetForTest();
  await save('B', NOW - 28 * DAY, [pt('Ethernet1', 'up'), pt('Ethernet2', 'down')]);
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path.join(tmp, 'cvp.db'));
  const rowsOf = (key) => raw.prepare("SELECT port, first_day, seed FROM port_firstseen WHERE cvp_id='m5' AND device_key=? ORDER BY port").all(key).map((r) => [r.port, dayIndex(NOW) - Number(r.first_day), Number(r.seed)]);
  assert.deepEqual(rowsOf('B'), [['Ethernet1', 30, 0], ['Ethernet2', 30, 0]], '장비 첫 레코드의 포트는 그날 · seed 아님');
  // A2-F2: 데모 · 시험 가져오기 — 겹치면 이른 날 · seed 는 하나라도 1 이면 1
  await cdb.importNetHistory('', { portFirst: [['m5', 'B', 'Ethernet1', dayIndex(NOW - 300 * DAY), 1], ['m5', 'B', 'Ethernet2', dayIndex(NOW - 20 * DAY), 0]] });
  assert.deepEqual(rowsOf('B'), [['Ethernet1', 300, 1], ['Ethernet2', 30, 0]]);
  await cdb.importNetHistory('', { portFirst: [['m5', 'B', 'Ethernet1', dayIndex(NOW - 5 * DAY), 0]] });
  assert.deepEqual(rowsOf('B')[0], ['Ethernet1', 300, 1], 'seed 는 0 으로 되돌아가지 않는다');
  // 이름 변형 모으기 — 옛 이름(seed 행)과 새 이름(첫 레코드 · 그날)이 겹치면 seed(장비 기록 시작일을 따른다)
  //   옛 이름 'Edge-Y' 로 업그레이드 전부터 있던 포트(seed) — 두 번 저장하고 그 사이 처음 본 날 행을 지워 업그레이드를 흉내 낸다
  const sy = (agent, ts) => cdb.saveDevices({ agent, cvpId: 'm5y', devices: [{ key: 'Y', ts, hostname: 'y', ports: [pt('Ethernet1', 'down')] }] });
  await sy('Edge-Y', NOW - 90 * DAY);
  raw.prepare("DELETE FROM port_firstseen WHERE cvp_id='m5y'").run(); cdb._resetForTest();
  await sy('Edge-Y', NOW - 80 * DAY);
  assert.deepEqual(raw.prepare("SELECT agent, seed FROM port_firstseen WHERE cvp_id='m5y'").all().map((r) => [r.agent, Number(r.seed)]), [['Edge-Y', 1]]);
  await sy('edge-y', NOW - DAY);   // 새 이름의 첫 레코드 — 그날 · seed 아님
  await cdb.adoptAgentVariants('edge-y', { wait: true });
  assert.deepEqual(raw.prepare("SELECT agent, seed FROM port_firstseen WHERE cvp_id='m5y'").all().map((r) => [r.agent, Number(r.seed)]), [['edge-y', 1]]);
  raw.close();
  // 데모 시드가 '기록 시작 뒤 사용 없음' 을 0 으로 만들지 않는다(소스 대조 — 시드가 portFirst 를 넘긴다)
  assert.match(src('../src/mock/demo/cvp.js'), /importNetHistory\(db\.LOCAL_AGENT, \{ devPort, xcvr, flap, lastLink, firstDay, util, portFirst \}\)/);
});

test('② D-6 — 설명에 적힌 상대 포트와 다르면 합치지 않는다', () => {
  const D = (key, hostname) => ({ agent: '', cvpId: 'c1', key, hostname });
  const Pt = (key, port, desc) => ({ agent: '', cvpId: 'c1', key, port, oper: 'up', desc });
  const run = (ps) => TP.buildTopology({ devices: [D('A', 'leaf1'), D('B', 'spine1')], lldp: [], ports: ps }).links;
  assert.equal(run([Pt('A', 'Ethernet49', 'spine1:Ethernet1'), Pt('B', 'Ethernet2', 'leaf1:Ethernet50')]).length, 2, '두 설명 모두와 어긋난 짝을 짓지 않는다');
  const ok = run([Pt('A', 'Ethernet49', 'spine1:Ethernet2'), Pt('B', 'Ethernet2', 'leaf1:Ethernet49')]);
  assert.deepEqual([ok.length, ok[0].bPort, ok[0].descPair], [1, 'Ethernet2', true]);
  assert.equal(run([Pt('A', 'Ethernet49', 'Et49 uplink spine1'), Pt('B', 'Ethernet2', 'to leaf1')]).length, 1, '자기 포트 이름은 상대 포트가 아니다');
  assert.deepEqual(PM.descPortsOf('leaf1:Et49 <-> spine1:Ethernet1 via esx01-vmnic2'), ['Et49', 'Ethernet1', 'vmnic2']);
});

test('③ D-7 — 장애 임계만 · 뒤집힌 임계 · 링크 없던 칸 · 높은 쪽 임계만', () => {
  // 장애 임계만(LowAlarm) — 하강 중이면 장애 임계 도달 예측(예전: '안정')
  const pts = Array.from({ length: 20 }, (_, i) => [NOW - (19 - i) * DAY, -10 - i * 0.25, null]);
  const k = '\u0000c\u0000k\u0000Ethernet1';
  const t = OT.opticTrends({ series: new Map([[k, pts]]), limits: new Map([[k, { basis: 'device', warnDbm: null, faultDbm: -20 }]]), now: NOW });
  assert.deepEqual([t.rows[0].state, t.rows[0].target, t.rows[0].warnEta], ['eta', 'fault', null]);
  assert.ok(t.rows[0].faultEta > NOW);
  // 뒤집힌 임계(LowWarn -20 < LowAlarm -16) — 실시간(장애 먼저)과 같게: 장애 -16 하나
  assert.deepEqual(OT.rxLimitsOf({ devWarnDbm: -20, devFaultDbm: -16 }), { basis: 'device', warnDbm: null, faultDbm: -16 });
  assert.deepEqual(OT.rxLimitsOf({ devWarnDbm: '' }, { warnDbm: -10, faultDbm: -14 }).basis, 'portal', "빈 글자는 0 이 아니다");
  const inv = P.judgeOptics([{ kind: 'xcvr', name: 'Ethernet1', state: 'ok', dom: { rxPower: -17 }, domJudge: { rxDevice: 'fault', rxLow: { warnDbm: -20, faultDbm: -16 } } }], [{ name: 'Ethernet1', oper: 'up' }], { warnDbm: -10, faultDbm: -14 });
  const err = new Map([['\u0000c\u0000k\u0000Ethernet1', { inErr: 3, outErr: 0, errDays: 1, days: 7 }]]);
  const port = [{ agent: '', cvpId: 'c', key: 'k', port: 'Ethernet1', oper: 'up' }];
  assert.equal(inv[0].optic.rxState, 'fault');
  assert.equal(LQ.rankLinks({ ports: port, devices: new Map([['\u0000c\u0000k', { parts: inv }]]), err, warnDbm: -10, faultDbm: -14 }).rows[0].verdict, 'replace', '실시간 장애 = 링크 품질 교체');
  // 부품을 읽을 때 링크가 없던 칸 · 레인 일부만 링크인 칸의 Rx 는 '교체' 근거가 아니다
  for (const optic of [{ intf: 'Ethernet1', rx: -40, linked: false }, { intf: 'Ethernet1', rx: -30, linked: false, lanesPartial: true }]) {
    const r = LQ.rankLinks({ ports: port, devices: new Map([['\u0000c\u0000k', { parts: [{ kind: 'xcvr', name: 'Ethernet1', state: 'ok', optic }] }]]), err, warnDbm: -10, faultDbm: -14 });
    assert.deepEqual([r.rows[0].verdict, r.rows[0].rx], ['peer', null], JSON.stringify(optic));
  }
});

test('④ 가림 — 함수', async () => {
  const C = await import('../src/routes/api/cvp.js');
  for (const v of ['001c-73aa-bb05', '0:50:56:a:dd:01', '0050-56AA-BB01']) assert.equal(C.maskMacText(v), '(MAC 가림)', v);
  for (const v of ['4-27-4-1-2-3', '12:30:45', 'Ethernet1/1', 'aa:bb:cc:dd:ee:ff:00']) assert.equal(C.maskMacText(v), v, v);
  assert.equal(C.maskLldpText('srv-2 10.77.3.8', []), 'srv-2 (주소 가림)');
  assert.equal(C.maskLldpText('00:50:56:ee:ee:02', []), '(MAC 가림)');
  const own = new Set(['005056000001']);
  assert.equal(C.maskForeignMacs('LLDP 이웃 esx01 · 00:50:56:00:00:01', own), 'LLDP 이웃 esx01 · 00:50:56:00:00:01', '이 호스트 NIC MAC 은 그대로');
  assert.equal(C.maskForeignMacs('LLDP 이웃 esx01 · 00:50:56:00:00:0b', own), 'LLDP 이웃 esx01 · (MAC 가림)');
  assert.equal(C.maskForeignMacs('LLDP 이웃 esx01 · 0:50:56:0:0:1', own), 'LLDP 이웃 esx01 · 0:50:56:0:0:1', '앞자리 0 생략 표기도 같은 MAC');
  // 호스트 업링크 근거가 이 함수를 지난다(라우트 소스)
  assert.match(src('../src/routes/api/hostSan.js'), /const mkS = \(x\) => maskForeignMacs\(mk\(x\), ownMacs\);/);
  // ReDoS — 길이 10배에 시간이 100배가 되지 않는다
  const tm = (n) => { const s = '0a:'.repeat(n); const t0 = process.hrtime.bigint(); for (let i = 0; i < 50; i++) C.maskMacText(s); return Number(process.hrtime.bigint() - t0); };
  tm(100); assert.ok(tm(1300) < tm(130) * 40);
});

test('④ 가림 — 실제 라우터(비관리자)', async () => {
  if (!(await cdb.available())) return;
  const ts = Date.now() - 60_000;
  const pt = (name) => ({ name, oper: 'up', admin: 'up', speedBps: 25e9, desc: '' });
  await cdb.saveDevices({ agent: '', cvpId, devices: [{ key: 'S1', ts, hostname: 'sw-1', model: 'DCS-7050SX3-48YC8', ports: [pt('Ethernet1'), pt('Ethernet2'), pt('Ethernet49')] }, { key: 'S2', ts, hostname: 'sw-2', ports: [pt('Ethernet50')] }] });
  await cdb.saveL2('', cvpId, [{ key: 'S1', ts, lldp: [{ port: 'Ethernet1', idx: '1', sysName: '00:50:56:ee:ee:02', portId: 'eth0' }, { port: 'Ethernet2', idx: '1', sysName: 'srv-2', portId: '10.77.3.8' }, { port: 'Ethernet49', idx: '1', sysName: 'sw-2', portId: 'Ethernet50' }] },
    { key: 'S2', ts, lldp: [{ port: 'Ethernet50', idx: '1', sysName: 'sw-1', portId: '10.77.3.9' }] }]);
  const get = async (p) => { const r = await fetch(`${base}${p}`); return { s: r.status, j: await r.json() }; };
  who = { username: 'op', role: 'operator', scope: null };
  let { j } = await get(`/tools/cvp/portmap?cvpId=${cvpId}&key=S1`);
  const by = Object.fromEntries(j.ports.map((p) => [p.name, p]));
  assert.equal(by.Ethernet1.lldp.sysName, '(MAC 가림)', 'MAC 모양 시스템 이름');
  assert.ok(!JSON.stringify(by.Ethernet1).includes('00:50:56:ee:ee:02'), 'device 칸에도 없다');
  assert.equal(by.Ethernet2.lldp.portId, '(주소 가림)', 'IP 모양 포트 ID');
  ({ j } = await get(`/tools/cvp/topology?cvpId=${cvpId}`));
  assert.ok(!JSON.stringify(j.links).includes('10.77.3.9'), JSON.stringify(j.links.map((l) => [l.aPort, l.bPort])));
  // 전후 비교 — 가린 부분만 바뀌면 '가린 값이 바뀜'
  const r = await fetch(`${base}/tools/cvp/snapshots`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: '5', cvpId }) });
  const snapA = (await r.json()).id;
  await cdb.saveL2('', cvpId, [{ key: 'S1', ts: ts + 1000, lldp: [{ port: 'Ethernet1', idx: '1', sysName: '00:50:56:ee:ee:03', portId: 'eth0' }, { port: 'Ethernet2', idx: '1', sysName: 'srv-2', portId: '10.77.3.8' }, { port: 'Ethernet49', idx: '1', sysName: 'sw-2', portId: 'Ethernet50' }] }]);
  ({ j } = await get(`/tools/cvp/compare?a=${snapA}&b=now`));
  const ch = j.devices.flatMap((d) => d.changes).find((c) => c.kind === 'lldp' && c.item === 'Ethernet1');
  assert.ok(ch && ch.before !== ch.after && /가린 값이 바뀜/.test(ch.after) && !JSON.stringify(ch).includes('00:50:56'), JSON.stringify(ch));
  who = { username: 'adm', role: 'admin', scope: null };
});

test('⑤ 링크 품질 · 회수 판정 — 요청 경로는 양보판(결과는 같다)', async () => {
  const ports = Array.from({ length: 300 }, (_, i) => ({ agent: '', cvpId: 'c', key: `k${i % 30}`, port: `Ethernet${i}`, oper: i % 3 ? 'down' : 'up', hostname: `k${i % 30}` }));
  const err = new Map(ports.filter((p) => p.oper === 'up').map((p, i) => [`\u0000c\u0000${p.key}\u0000${p.port}`, { inErr: i, outErr: 0, errDays: 1, days: 7 }]));
  assert.deepEqual(await LQ.rankLinksAsync({ ports, err }), LQ.rankLinks({ ports, err }));
  const first = new Map(Array.from({ length: 30 }, (_, i) => [`\u0000c\u0000k${i}`, NOW - (60 + i * 5) * DAY]));
  assert.deepEqual(await PP.reclaimCandidatesAsync({ ports, first, now: NOW }), PP.reclaimCandidates({ ports, first, now: NOW }));
  const route = src('../src/routes/api/cvpNet.js');
  assert.match(route, /await rankLinksAsync\(\{ ports: b\.ports,/);
  assert.match(route, /await reclaimCandidatesAsync\(\{ ports: b\.ports,/);
});

/* ── 5회차 수정 검토(반증 1인) V1~V7 ─────────────────────────────────────────────────────────────────────── */
test('⑥ 수정 검토 — seed 합치기 · 설명 포트 표기 · 과잉 가림 · 임계 범위 · 확인 지점 · 데모', async () => {
  // V2: 'Eth1' 은 'Et1' 과 같고, 포트 채널 · VLAN 언급은 상대 포트가 아니다
  const D = (key, hostname) => ({ agent: '', cvpId: 'c1', key, hostname });
  const Pt = (key, port, desc) => ({ agent: '', cvpId: 'c1', key, port, oper: 'up', desc });
  const run = (da, db) => TP.buildTopology({ devices: [D('A', 'leaf1'), D('B', 'spine1')], lldp: [], ports: [Pt('A', 'Ethernet49', da), Pt('B', 'Ethernet1', db)] }).links.length;
  assert.equal(run('spine1-Eth1', 'leaf1-Eth49'), 1);
  assert.equal(run('spine1 Po10 member', 'leaf1 Po10 member'), 1);
  assert.equal(run('spine1 vlan100 trunk', 'leaf1'), 1);
  assert.equal(run('spine1:Ethernet2', 'leaf1'), 2, '대조: 다른 물리 포트가 적혀 있으면 합치지 않는다');
  assert.equal(run('spine1-Eth2', 'leaf1'), 2, "'Eth2' 도 물리 포트 — 짝(Ethernet1)과 다르면 합치지 않는다");
  // V5: 십진수만인 4-4-4 · 한 자리 마디 십진 콜론은 MAC 이 아니다
  const C = await import('../src/routes/api/cvp.js');
  for (const v of ['1588-1234-5678', '2026-1126-0930', 'slot 1:1:1:1:1:1']) assert.equal(C.maskMacText(v), v, v);
  for (const v of ['dc01-a001-b002', '0050-56aa-bb01', '00:00:00:00:00:01']) assert.match(C.maskMacText(v), /MAC 가림/, v);
  // V6: 실시간 낮은 쪽 판정은 추세 · 링크 품질과 같은 함수(범위 밖 임계는 버리고 포탈로)
  const x = P.xcvrDom({ rxPower: -11, rxPowerLowWarn: 16, rxPowerLowAlarm: -12 });
  assert.equal(x.rxHigh, 'ok', '높은 쪽 임계가 없으면 높은 쪽은 정상');
  const j = (dj, rx) => P.judgeOptics([{ kind: 'xcvr', name: 'Ethernet1', state: 'ok', dom: { rxPower: rx }, domJudge: dj }], [{ name: 'Ethernet1', oper: 'up' }], { warnDbm: -10, faultDbm: -14 })[0].optic;
  assert.deepEqual([j({ rxHigh: null, rxLow: { warnDbm: null, faultDbm: -12 } }, -11).rxState, OT.rxLimitsOf({ devFaultDbm: -12 }).warnDbm], ['ok', null], '주의 없음 · 장애 -12 — -11 은 정상(추세와 같다)');
  assert.equal(j({ rxHigh: 'warn', rxLow: { warnDbm: -16, faultDbm: -20 } }, 3).rxState, 'warn', '높은 쪽 장비 임계는 그대로');
  assert.match(src('../src/cvp/parse.js'), /const lim = rxLimitsOf\(p\.domJudge\?\.rxLow \?/);
  // 확인 지점: 기다리는 요청이 없으면 양보판이 멈춘다
  const ports = Array.from({ length: 5000 }, (_, i) => ({ agent: '', cvpId: 'c', key: 'k', port: `Ethernet${i}`, oper: 'down', hostname: 'k' }));
  let n = 0; const stop = () => { if (++n > 0) throw Object.assign(new Error('멈춤'), { code: 'HEAVY_ABANDONED' }); };
  const slow = { first: new Map([['\u0000c\u0000k', NOW - 200 * DAY]]), now: NOW, ports };
  await assert.rejects(PP.reclaimCandidatesAsync(slow, { check: stop }), /멈춤/);
  await assert.rejects(LQ.rankLinksAsync({ ports: ports.map((p) => ({ ...p, oper: 'up' })) }, { check: stop }), /멈춤/);
  assert.equal((await PP.reclaimCandidatesAsync(slow)).counts.down, 5000, '대조: 확인 함수가 없으면 끝까지');
  assert.match(src('../src/routes/api/cvpNet.js'), /portFirst: ll\.portFirst, idleDays: idle \}, \{ check: hx\.check \}\)/);
  // V4 · V7: 업링크 설명에도 남의 MAC 가림 · 데모의 '20일 전에 단 포트' 에 이른 링크 날 없음(소스)
  assert.match(src('../src/routes/api/hostSan.js'), /desc: admin \? \(u\.desc \?\? ''\) : mkS\(u\.desc \?\? ''\)/);
  assert.match(src('../src/mock/demo/cvp.js'), /if \(young\) return;/);
  // V1: 모으기 — seed 는 이른 쪽 행의 값(옛 이름의 seed 0 · 20일 전 행이 새 이름 seed 행(오늘)에 덮이지 않는다)
  if (!(await cdb.available())) return;
  const { dayIndex } = await import('../src/util/dayKey.js');
  const pt = (name, oper) => ({ name, oper, admin: 'up', desc: '' });
  await cdb.saveDevices({ agent: 'Edge-W', cvpId: 'm5w', devices: [{ key: 'W', ts: NOW - 20 * DAY, hostname: 'w', ports: [pt('Ethernet9', 'down')] }] });
  await cdb.importNetHistory('edge-w', { portFirst: [['m5w', 'W', 'Ethernet9', dayIndex(NOW), 1]] });
  await cdb.adoptAgentVariants('edge-w', { wait: true });
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path.join(tmp, 'cvp.db'));
  assert.deepEqual(raw.prepare("SELECT agent, first_day, seed FROM port_firstseen WHERE cvp_id='m5w'").all().map((r) => [r.agent, dayIndex(NOW) - Number(r.first_day), Number(r.seed)]), [['edge-w', 20, 0]]);
  raw.close();
});
