/**
 * test/cvpPower2647.test.js — v2.647 네트워크 장비 소비전력.
 *  ① psuPower — 후보 필드로 입력·출력·용량을 읽고, 음수·비숫자는 버린다 · parseParts 가 PSU 에 power 를 싣는다
 *  ② devicePower — 장착 PSU 입력 합 · 입력 모르면 출력(basis) · 값 없으면 null(0W 아님) · 일부만 읽으면 partial
 *  ③ /tools/cvp/power — 읽은 장비만 합산 · 못 읽은 사유별 개수 · 법인·모델 합
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvppower2647-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';

const P = await import('../src/cvp/parse.js');
const leaf = (name, updates) => JSON.stringify({ notifications: [{ path: `/leaf/${encodeURIComponent(name)}`, updates: Object.fromEntries(Object.entries(updates).map(([k, v]) => [k, { key: k, value: v }])) }] });

test('① psuPower·parseParts', () => {
  assert.deepEqual(P.psuPower({ inputPower: { float: 152.4 }, outputPower: 140, capacity: 500 }), { inW: 152.4, outW: 140, capW: 500 });
  assert.equal(P.psuPower({ inputPower: -3 }), null, '음수는 버린다');
  assert.equal(P.psuPower({ state: 'ok' }), null);
  const r = P.parseParts([leaf('powerSupply › PowerSupply1', { state: 'ok', inputPower: 120 }), leaf('powerSupply › PowerSupply2', { state: 'ok' })].join('\n'), 'psu');
  const by = Object.fromEntries(r.parts.map((p) => [p.name, p]));
  assert.equal(by['powerSupply › PowerSupply1'].power.inW, 120);
  assert.match(by['powerSupply › PowerSupply1'].detail, /입력 120W/);
  assert.equal(by['powerSupply › PowerSupply2'].power, undefined);
});

test('② devicePower — 0W 를 지어내지 않는다', () => {
  const psu = (name, power, state = 'ok') => ({ kind: 'psu', name, state, ...(power ? { power } : {}) });
  assert.deepEqual(P.devicePower([psu('A', { inW: 100 }), psu('B', { inW: 90 })]), { watts: 190, psus: 2, read: 2, partial: false, basis: 'input', capW: null });
  const partial = P.devicePower([psu('A', { inW: 100 }), psu('B', null)]);
  assert.equal(partial.partial, true); assert.equal(partial.watts, 100);
  assert.equal(P.devicePower([psu('A', { inW: null, outW: 80 })]).basis, 'output');
  assert.equal(P.devicePower([psu('A', null)]), null, '값이 없으면 null');
  assert.equal(P.devicePower([psu('A', { inW: 50 }, 'absent')]), null, '빈 슬롯은 세지 않는다');
  assert.equal(P.devicePower(null), null);
});

let srv, base;
before(async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const cdb = await import('../src/cvp/db.js');
  const reg = await import('../src/cvp/registry.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
  const a = reg.saveServer({ name: 'CVP-T', host: 'https://10.99.0.1', authMode: 'token', token: 't', agent: '' });
  const now = Date.now();
  const dev = (key, model, parts) => ({ key, ts: now, hostname: `h-${key}`, model, serial: key, streaming: true, parts, partsAt: parts === undefined ? undefined : now, ports: [] });
  await cdb.saveDevices({ agent: cdb.LOCAL_AGENT, cvpId: a.id, devices: [
    dev('S1', 'M1', [{ kind: 'psu', name: 'P1', state: 'ok', detail: '', power: { inW: 150, outW: null, capW: null } }, { kind: 'psu', name: 'P2', state: 'ok', detail: '', power: { inW: 140, outW: null, capW: null } }]),
    dev('S2', 'M1', [{ kind: 'psu', name: 'P1', state: 'ok', detail: '' }]),
    dev('S3', 'M2', [{ kind: 'fan', name: 'F1', state: 'ok', detail: '' }]),
    dev('S4', 'M2', undefined),
  ], samples: false });
});
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('③ /tools/cvp/power — 읽은 장비만 합산 · 사유별 개수', async () => {
  const r = await fetch(`${base}/tools/cvp/power`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.totals.devices, 4); assert.equal(j.totals.read, 1); assert.equal(j.totals.watts, 290);
  assert.deepEqual(j.totals.unread, { partsNotRead: 1, noPsu: 1, noPowerField: 1 });
  assert.equal(j.devices[0].key, 'S1'); assert.equal(j.devices.find((d) => d.key === 'S2').watts, null);
  assert.equal(j.corps[0].watts, 290);
  assert.equal(j.models.find((m) => m.model === 'M1').avgW, 290);
});
