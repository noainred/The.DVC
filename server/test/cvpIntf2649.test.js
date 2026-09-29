/**
 * test/cvpIntf2649.test.js — v2.649 인터페이스 세부 정보.
 *  ① parseInterfaces — duplex·forwarding model·MAC·MTU·원문 상태, 설명 없으면 null(''과 구분)
 *  ② parseIntfConfig·mergeIntfConfig — 설정 노드의 설명
 *  ③ xcvrTypeText·parseParts — 트랜시버 종류
 *  ④ fillDescs — 사이 주기에는 캐시 설명을 채운다
 *  ⑤ DB — 설명·세부 열은 NULL 이면 직전 값 유지, '' 은 '설명 없음' 으로 저장 · /tools/cvp/device 가 싣는다
 *  ⑥ 엣지 정제 — 새 필드·설명 null 보존·media
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvpintf2649-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';

const P = await import('../src/cvp/parse.js');
const leaf = (name, updates) => JSON.stringify({ notifications: [{ path: `/leaf/${encodeURIComponent(name)}`, updates: Object.fromEntries(Object.entries(updates).map(([k, v]) => [k, { key: k, value: v }])) }] });

test('① parseInterfaces 세부 필드', () => {
  const t = [leaf('Ethernet1', { linkStatus: 'linkUp', duplex: 'duplexFull', forwardingModel: 'intfForwardingModelBridged', burnedInAddr: 'A4:3F:68:85:30:2E', mtu: 9214, speed: 'speed1Gbps' }),
    leaf('Ethernet2', { linkStatus: 'linkDown', description: 'srv-b' })].join('\n');
  const { ports } = P.parseInterfaces(t);
  const by = Object.fromEntries(ports.map((p) => [p.name, p]));
  assert.deepEqual([by.Ethernet1.duplex, by.Ethernet1.fwdModel, by.Ethernet1.mac, by.Ethernet1.mtu, by.Ethernet1.operRaw], ['full', 'bridged', 'a4:3f:68:85:30:2e', 9214, 'linkUp']);
  assert.equal(by.Ethernet1.desc, null, '설명 필드가 없으면 null(못 읽음)');
  assert.equal(by.Ethernet2.desc, 'srv-b');
  assert.equal(by.Ethernet2.duplex, null); assert.equal(by.Ethernet2.mac, null);
  assert.equal(P.intfDetailOf({ burnedInAddr: 'nope', mtu: -1 }, null).mac, null);
  assert.equal(P.enumWord({}), null);
});

test('② parseIntfConfig·mergeIntfConfig', () => {
  const t = [leaf('Ethernet1', { description: 'L03_Image_A_iDRAC', enabledState: 'enabled' }), leaf('Ethernet2', { description: '' }), leaf('Ethernet3', { enabledState: 'enabled' })].join('\n');
  const { descs } = P.parseIntfConfig(t);
  assert.equal(descs.get('Ethernet1'), 'L03_Image_A_iDRAC'); assert.equal(descs.get('Ethernet2'), ''); assert.equal(descs.has('Ethernet3'), false);
  assert.equal(P.parseIntfConfig('{"notifications":[]}').descs, null);
  const m = P.mergeIntfConfig([{ name: 'Ethernet1', desc: null }, { name: 'Ethernet3', desc: null }], descs);
  assert.equal(m[0].desc, 'L03_Image_A_iDRAC'); assert.equal(m[1].desc, null);
});

test('③ 트랜시버 종류', () => {
  assert.equal(P.xcvrTypeText('xcvr1000BaseT'), '1000BASE-T');
  assert.equal(P.xcvrTypeText('xcvr25GBaseSr'), '25GBASE-SR');
  assert.equal(P.xcvrTypeText('100GBASE-LR4'), '100GBASE-LR4');
  assert.equal(P.xcvrTypeText('xcvrUnknown'), null); assert.equal(P.xcvrTypeText(''), null);
  assert.equal(P.xcvrTypeText('Some Vendor Thing'), 'Some Vendor Thing', '모르는 형태는 원문');
  const r = P.parseParts(leaf('all › Ethernet49', { xcvrPresence: 'xcvrPresent', mediaType: 'xcvr10GBaseSr' }), 'xcvr');
  assert.equal(r.parts[0].media, '10GBASE-SR');
});

test('④ fillDescs — 캐시', async () => {
  const { fillDescs } = await import('../src/cvp/poller.js');
  const cache = new Map();
  fillDescs(cache, { key: 'D', descsAt: 1, ports: [{ name: 'Ethernet1', desc: 'a' }, { name: 'Ethernet2', desc: null }] });
  const d = { key: 'D', ports: [{ name: 'Ethernet1', desc: null }, { name: 'Ethernet2', desc: null }] };
  fillDescs(cache, d);
  assert.equal(d.ports[0].desc, 'a'); assert.equal(d.ports[1].desc, null);
});

test('⑥ 엣지 정제 — 세부 필드·설명 null·media', async () => {
  const E = await import('../src/central/cvpEdge.js');
  const d = E.cleanDevice({ key: 'K', ts: Date.now(), ports: [{ name: 'Ethernet1', desc: null, oper: 'up', admin: 'up', duplex: 'full', fwdModel: { x: 1 }, mac: 'a4:3f:68:85:30:2e', mtu: '9214', operRaw: 'linkUp' }],
    parts: [{ kind: 'xcvr', name: 'all › Ethernet1', state: 'unknown', media: '1000BASE-T' }], partsAt: Date.now() });
  assert.equal(d.ports[0].desc, null); assert.equal(d.ports[0].duplex, 'full'); assert.equal(d.ports[0].fwdModel, null);
  assert.equal(d.ports[0].mtu, 9214); assert.equal(d.parts[0].media, '1000BASE-T');
});

let srv, base, cdb, cvpId;
before(async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  cdb = await import('../src/cvp/db.js');
  const reg = await import('../src/cvp/registry.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
  cvpId = reg.saveServer({ name: 'CVP-T', host: 'https://10.99.0.1', authMode: 'token', token: 't', agent: '' }).id;
});
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('⑤ DB — NULL 이면 유지, "" 은 저장 · /tools/cvp/device 가 싣는다', async () => {
  const t0 = Date.now() - 10_000;
  const dev = (ts, ports) => ({ key: 'SN1', ts, hostname: 'leaf1', model: 'M', serial: 'SN1', streaming: true, ports });
  await cdb.saveDevices({ agent: cdb.LOCAL_AGENT, cvpId, devices: [dev(t0, [
    { name: 'Ethernet1', desc: 'srv-a', oper: 'up', admin: 'up', duplex: 'full', fwdModel: 'bridged', mac: 'a4:3f:68:85:30:2e', mtu: 9214, operRaw: 'linkUp' },
    { name: 'Ethernet2', desc: 'old', oper: 'nolink', admin: 'up' }])], samples: false });
  await cdb.saveDevices({ agent: cdb.LOCAL_AGENT, cvpId, devices: [dev(t0 + 5000, [
    { name: 'Ethernet1', desc: null, oper: 'up', admin: 'up', duplex: null, mac: null, mtu: null },
    { name: 'Ethernet2', desc: '', oper: 'nolink', admin: 'up' }])], samples: false });
  const r = await fetch(`${base}/tools/cvp/device?cvpId=${encodeURIComponent(cvpId)}&key=SN1`);
  assert.equal(r.status, 200);
  const j = await r.json();
  const by = Object.fromEntries(j.ports.map((p) => [p.name, p]));
  assert.equal(by.Ethernet1.desc, 'srv-a', '못 읽은 주기(null)는 직전 설명 유지');
  assert.equal(by.Ethernet1.duplex, 'full'); assert.equal(by.Ethernet1.mac, 'a4:3f:68:85:30:2e'); assert.equal(by.Ethernet1.mtu, 9214);
  assert.equal(by.Ethernet2.desc, '', "'' 은 설명을 지운 것으로 저장");
});
