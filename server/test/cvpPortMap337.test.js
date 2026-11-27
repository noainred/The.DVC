/**
 * test/cvpPortMap337.test.js — v3.37 CVP 포트 구성도(docs/design/cvp-port-map).
 *  ① 배치표 — 모델 정규화 · 사진으로 확인한 5종 · 번호 규칙 · 모듈형 슬롯 · 배치표 밖 포트
 *  ② 분류 — 못 읽은 설명은 예비가 아니다 · 꺼짐 · 확인 필요 · GBIC 꽂힘/빈 케이지/구리/모름
 *  ③ 연결 근거 — 일치 · 불일치 · LLDP 만 · 설명만 · 근거 없음 · LLDP 못 읽음
 *  ④ 서버 xcvrMapOf ≡ 웹 xcvrMapOf(판정 코어 대조)
 *  ⑤ 정규식 선형 — 긴 설명
 *  ⑥ 실제 api 라우터 — /tools/cvp/portmap · /summary · 비-admin 가림 · 범위 계정 403
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvpportmap337-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';

const M = await import('../src/cvp/portmap.js');
const W = await import('../../web/src/views/tools/cvpIntfText.js');

test('① 배치표 — 정규화 · 확인한 모델 · 번호 규칙 · 모듈형', () => {
  assert.equal(M.normModel('DCS-7050SX3-48YC8-F'), '7050SX3-48YC8');
  assert.equal(M.normModel('dcs-7280sr3-48yc8-r'), '7280SR3-48YC8');
  assert.equal(M.normModel('CCS-720XP-48ZC2'), '720XP-48ZC2');
  const leafPorts = [...Array.from({ length: 48 }, (_, k) => ({ name: `Ethernet${k + 1}`, speedBps: 25e9 })), { name: 'Ethernet49/1', speedBps: 100e9 }, { name: 'Ethernet49/2', speedBps: 25e9 }];
  const f = M.faceplateFor('DCS-7050SX3-48YC8-F', leafPorts);
  assert.equal(f.source, 'model'); assert.equal(f.mgmt, 'rear');
  assert.deepEqual(f.groups.map((g) => g.cages[0]), [1, 13, 49, 25, 37], 'QSFP 49–56 은 가운데(사진 판독)');
  assert.deepEqual(f.extra, [], '브레이크아웃(49/2)은 칸 49 에 들어간다');
  assert.equal(M.faceplateFor('DCS-7060CX2-32S', []).groups[0].cages.join(), '33,34', '7060CX2: SFP+ 33·34 가 왼쪽');
  assert.equal(M.faceplateFor('DCS-7060CX2-32S', []).mgmt, 'front');
  const t = M.faceplateFor('DCS-7010TX-48', [{ name: 'Ethernet60', speedBps: 1e9 }]);
  assert.equal(t.groups[4].label.includes('SFP'), true); assert.deepEqual(t.extra, ['Ethernet60'], '배치표 밖 번호는 extra');
  assert.equal(M.isCopperCage(t, 12), true); assert.equal(M.isCopperCage(t, 50), false);
  const r = M.faceplateFor('DCS-7999X-ZZ', Array.from({ length: 30 }, (_, k) => ({ name: `Ethernet${k + 1}`, speedBps: k < 24 ? 10e9 : 100e9 })));
  assert.equal(r.source, 'rule'); assert.deepEqual(r.groups.map((g) => g.cages.length), [12, 12, 6], '12개씩 · 폼이 바뀌면 새 블록');
  assert.equal(M.isCopperCage(r, 1), false, '번호 규칙 장비는 구리를 단정하지 않는다');
  const c = M.faceplateFor('DCS-7504N', [{ name: 'Ethernet3/1', speedBps: 100e9 }, { name: 'Ethernet3/2' }, { name: 'Ethernet4/1/2', speedBps: 25e9 }, { name: 'Management1/1' }]);
  assert.equal(c.modular, true); assert.equal(c.cardRule, true); assert.deepEqual(c.slots.map((s) => s.slot), [3, 4]);
  assert.equal(M.isModularModel('DCS-7508N'), true); assert.equal(M.isModularModel('DCS-7050SX3-48YC8'), false);
  assert.deepEqual(M.portAddr('Ethernet3/17', true), { mgmt: false, slot: 3, cage: 17, lane: null });
  assert.deepEqual(M.portAddr('Ethernet49/1', false), { mgmt: false, slot: null, cage: 49, lane: 1 });
  assert.equal(M.portAddr('Port-Channel10', false), null); assert.equal(M.portAddr('Management1').mgmt, true);
});

test('② 분류 — 못 읽은 설명은 예비로 세지 않는다', () => {
  const C = (p, ctx) => M.classifyPort({ admin: 'up', ...p }, ctx);
  assert.equal(C({ oper: 'up', desc: '' }), 'use');
  assert.equal(C({ oper: 'up', admin: 'down', desc: '' }), 'off', '관리상 꺼짐이 먼저');
  assert.equal(C({ oper: 'nolink', desc: null }), 'unknown', '설명을 못 읽은 링크 없는 포트');
  assert.equal(C({ oper: 'unknown', desc: '' }), 'unknown');
  assert.equal(C({ oper: 'down', desc: 'esx-01' }), 'check');
  assert.equal(C({ oper: 'nolink', desc: '  ' }, { xcvr: { present: true } }), 'spareX', '공백뿐인 설명은 설명 없음');
  assert.equal(C({ oper: 'nolink', desc: '' }, { xcvr: { present: false } }), 'spareE');
  assert.equal(C({ oper: 'nolink', desc: '' }, { xcvr: undefined }), 'spareU', '트랜시버 목록 못 읽음');
  assert.equal(C({ oper: 'nolink', desc: '' }, { xcvr: null }), 'spareU', '목록에 그 포트가 없음');
  assert.equal(C({ oper: 'nolink', desc: '' }, { copper: true }), 'spareC');
  const rows = [{ sub: 'use' }, { sub: 'spareX' }, { sub: 'spareC' }, { sub: 'unknown' }, { sub: 'use', mgmt: true }];
  const n = M.countSubs(rows);
  assert.equal(n.total, 4, '관리 포트 제외'); assert.equal(n.spare, 2); assert.equal(n.unknown, 1);
});

test('③ 연결 근거', () => {
  const up = (desc) => ({ oper: 'up', desc });
  assert.equal(M.evidenceOf(up('esx-kr1-09 vmnic0'), [{ sysName: 'esx-kr1-09.corp.local' }], true).ev, 'match', '도메인을 뗀 이름이 설명 낱말과 같다');
  assert.equal(M.evidenceOf(up('esx-kr1-09.corp.local p1'), [{ sysName: 'ESX-KR1-09' }], true).ev, 'match');
  const mm = M.evidenceOf(up('esx-kr1-11 vmnic0'), [{ sysName: 'esx-kr1-14' }], true);
  assert.equal(mm.ev, 'mismatch'); assert.equal(mm.device, 'esx-kr1-14', '불일치면 LLDP(지금 붙은 상대)를 표시');
  assert.equal(M.evidenceOf(up(''), [{ sysName: 'kr1-spine-01' }], true).ev, 'lldp');
  const d = M.evidenceOf(up('MLAG peer kr1-leaf-a04 Et47'), [], true);
  assert.equal(d.ev, 'desc'); assert.equal(d.device, 'kr1-leaf-a04', '인터페이스 이름(Et47) · 일반 낱말은 장비 이름이 아니다');
  assert.equal(M.evidenceOf(up(''), [], true).ev, 'none');
  assert.equal(M.evidenceOf(up('fw-01'), [], false).lldpUnread, true, 'LLDP 못 읽음은 표시만 — 일치/불일치를 판정하지 않는다');
  assert.equal(M.evidenceOf({ oper: 'nolink', desc: 'x-01' }, [], true).ev, 'nolink');
  assert.equal(M.deviceNameFromDesc('TEMP migration'), '', '하이픈 · 숫자 없는 낱말은 이름이 아니다');
  assert.equal(M.deviceNameFromDesc('10.1.2.3 uplink'), '', 'IP 는 이름으로 뽑지 않는다');
  assert.equal(M.deviceNameFromDesc('vmnic0 esx-01'), 'esx-01');
});

test('④ 서버 xcvrMapOf ≡ 웹 xcvrMapOf', () => {
  const parts = [{ kind: 'xcvr', name: 'xcvr › Ethernet1', state: 'ok', media: '25GBASE-SR' }, { kind: 'xcvr', name: 'all › Ethernet49 › dom', state: 'ok' },
    { kind: 'xcvr', name: 'xcvr › Ethernet2', state: 'absent' }, { kind: 'psu', name: 'PowerSupply1', state: 'ok' }, { kind: 'xcvr', name: 'weird', state: 'ok' }];
  for (const input of [parts, [], null, [{ kind: 'psu', name: 'x' }]]) {
    const a = M.xcvrMapOf(input); const b = W.xcvrMapOf(input);
    assert.deepEqual(a == null ? null : [...a], b == null ? null : [...b]);
  }
  for (const n of ['xcvr › Ethernet1', 'all › Management1 › x', 'nothing', '']) assert.equal(M.intfOfPartName(n), W.intfOfPartName(n));
});

test('⑤ 긴 설명도 선형', () => {
  const long = `${'a-'.repeat(50_000)}!`;
  const t0 = process.hrtime.bigint();
  M.deviceNameFromDesc(long); M.descTokens(long);
  M.evidenceOf({ oper: 'up', desc: long }, [{ sysName: 'a'.repeat(5000) }], true);
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 200, '200ms 안');
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
  cvpId = reg.saveServer({ name: 'CVP-T', host: 'https://10.99.0.1', authMode: 'token', token: 't', agent: '' }).id;
});
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('⑥ 실제 라우터 — 장비 구성도 · 요약 · 가림 · 범위 403', async () => {
  if (!(await cdb.available())) return;
  const ts = Date.now() - 5000;
  const ports = [
    { name: 'Ethernet1', desc: 'esx-kr1-09 vmnic0', oper: 'up', admin: 'up', speedBps: 25e9 },
    { name: 'Ethernet2', desc: '', oper: 'nolink', admin: 'up', speedBps: 25e9 },
    { name: 'Ethernet3', desc: 'to 10.20.30.40 old', oper: 'nolink', admin: 'up', speedBps: 25e9 },
    { name: 'Ethernet4', desc: null, oper: 'nolink', admin: 'up', speedBps: 25e9 },
    { name: 'Ethernet49/1', desc: '', oper: 'up', admin: 'up', speedBps: 100e9 },
    { name: 'Ethernet50/1', desc: '', oper: 'nolink', admin: 'down', speedBps: 100e9 },
  ];
  await cdb.saveDevices({ agent: cdb.LOCAL_AGENT, cvpId, devices: [
    { key: 'SN1', ts, hostname: 'kr1-leaf-a03', model: 'DCS-7050SX3-48YC8-F', serial: 'SN1', streaming: true, ports,
      parts: [{ kind: 'xcvr', name: 'xcvr › Ethernet2', state: 'ok', media: '25GBASE-SR' }], partsAt: ts },
    { key: 'SN2', ts, hostname: 'kr1-spine-01', model: 'DCS-7504N', serial: 'SN2', streaming: true, ports: [{ name: 'Ethernet3/1', desc: '', oper: 'up', admin: 'up' }] },
  ], samples: false });
  await cdb.saveL2('', cvpId, [{ key: 'SN1', ts, lldp: [
    { port: 'Ethernet1', idx: '1', sysName: 'esx-kr1-09.corp', portId: 'vmnic0', portDesc: 'vmnic0 10.0.0.9', chassisId: '005056aabbcc' },
    { port: 'Ethernet49/1', idx: '1', sysName: 'kr1-spine-01', portId: 'Ethernet3/1', portDesc: '', chassisId: '' }] }]);
  let r = await fetch(`${base}/tools/cvp/portmap?cvpId=${encodeURIComponent(cvpId)}&key=SN1`);
  assert.equal(r.status, 200);
  let j = await r.json();
  const by = Object.fromEntries(j.ports.map((p) => [p.name, p]));
  assert.equal(j.faceplate.source, 'model'); assert.equal(j.lldp.read, true);
  assert.deepEqual([by.Ethernet1.sub, by.Ethernet1.ev], ['use', 'match']);
  assert.equal(by.Ethernet2.sub, 'spareX'); assert.equal(by.Ethernet3.sub, 'check'); assert.equal(by.Ethernet4.sub, 'unknown');
  assert.equal(by['Ethernet50/1'].sub, 'off');
  assert.deepEqual([by['Ethernet49/1'].ev, by['Ethernet49/1'].device, by['Ethernet49/1'].deviceKind], ['lldp', 'kr1-spine-01', 'switch'], 'CVP 장비 이름이면 스위치');
  assert.equal(j.counts.total, 6); assert.equal(j.counts.spare, 1); assert.equal(j.counts.unknown, 1);
  assert.ok(!JSON.stringify(j).includes('005056aabbcc'), 'chassisId(MAC)는 싣지 않는다');
  assert.ok(JSON.stringify(j).includes('10.20.30.40'), 'admin 은 원문');

  who = { username: 'op', role: 'operator', scope: null };
  j = await (await fetch(`${base}/tools/cvp/portmap?cvpId=${encodeURIComponent(cvpId)}&key=SN1`)).json();
  assert.ok(!JSON.stringify(j).includes('10.20.30.40') && !JSON.stringify(j).includes('10.0.0.9'), '비-admin 은 설명 · LLDP 의 주소를 가린다');
  assert.equal(j.addressHidden, true);

  r = await fetch(`${base}/tools/cvp/portmap/summary`);
  assert.equal(r.status, 200);
  j = await r.json();
  const s1 = j.devices.find((d) => d.key === 'SN1'); const s2 = j.devices.find((d) => d.key === 'SN2');
  assert.equal(s1.counts.spare, 1); assert.equal(s1.counts.check, 1); assert.equal(s1.source, 'model');
  assert.equal(s2.counts.use, 1);

  assert.equal((await fetch(`${base}/tools/cvp/portmap?cvpId=${encodeURIComponent(cvpId)}&key=NOPE`)).status, 404);
  assert.equal((await fetch(`${base}/tools/cvp/portmap?cvpId=nope&key=SN1`)).status, 404);
  who = { username: 'sc', role: 'operator', scope: { vcenters: ['vc-1'] } };
  assert.equal((await fetch(`${base}/tools/cvp/portmap?cvpId=${encodeURIComponent(cvpId)}&key=SN1`)).status, 403, '범위 계정은 CVP 전체가 403(형제 라우트와 같다)');
  assert.equal((await fetch(`${base}/tools/cvp/portmap/summary`)).status, 403);
  who = { username: 'adm', role: 'admin', scope: null };
});
