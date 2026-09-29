/**
 * test/cvpOptics2646.test.js — v2.646 트랜시버(GBIC) DOM·광신호 판정.
 *  ① DOM 하위 노드(`… › domInfo`)를 트랜시버 개체에 합치고 값을 읽는다 — 장착만 알고 DOM 이 없으면 여전히 상태 미확인(정상 아님)
 *  ② judgeOptics — 링크가 올라온 포트만 판정 · 장비 임계가 먼저 · 없으면 포탈 기준(warn/fault dBm) · 빈 슬롯은 absent 유지
 *  ③ 설정 — 장애 기준이 주의보다 높으면 맞춘다 · 빈 칸은 이전 값
 *  ④ 라우트 /tools/cvp/optics — 판정한 것 먼저 · 수신 광량 낮은 순 · 개수(링크 없음·DOM 없음)
 *  ⑤ 추종 — xcvr 는 한 단계 더 따라가되 그 단계에서는 dom 이 들어간 포인터만
 *  ⑥ 엣지 수신 정제가 dom·optic 을 아는 필드만 옮긴다
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvpoptics2646-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';

const P = await import('../src/cvp/parse.js');

const leaf = (name, updates) => JSON.stringify({ notifications: [{ path: `/leaf/${encodeURIComponent(name)}`, updates: Object.fromEntries(Object.entries(updates).map(([k, v]) => [k, { key: k, value: v }])) }] });

test('① DOM 하위 노드를 합치고 값을 읽는다 · DOM 없으면 여전히 unknown', () => {
  const text = [
    leaf('all › Ethernet49', { xcvrPresence: 'xcvrPresent' }),
    leaf('all › Ethernet49 › domInfo', { rxPower: { float: -3.25 }, txPower: -2.1, temperature: 35.5 }),
    leaf('all › Ethernet1', { xcvrPresence: 'xcvrPresent' }),
    leaf('all › Ethernet2', { xcvrPresence: 'xcvrNotPresent' }),
  ].join('\n');
  const r = P.parseParts(text, 'xcvr');
  const by = Object.fromEntries(r.parts.map((p) => [p.name, p]));
  assert.equal(r.parts.length, 3, 'domInfo 는 별도 부품이 아니다');
  assert.equal(by['all › Ethernet49'].dom.rxPower, -3.25);
  assert.match(by['all › Ethernet49'].detail, /Rx -3\.25/);
  assert.equal(by['all › Ethernet1'].state, 'unknown', '장착만 알면 상태 미확인(정상이라 말하지 않는다)');
  assert.match(by['all › Ethernet1'].detail, /장착/);
  assert.equal(by['all › Ethernet2'].state, 'absent');
});

test('② judgeOptics — 링크 올라온 포트만 · 장비 임계 먼저 · 포탈 기준', () => {
  const mk = (name, dom, domJudge = { otherState: null, rxDevice: null }) => ({ kind: 'xcvr', name, state: 'unknown', detail: '', dom, domJudge });
  const parts = [
    mk('all › Ethernet49', { rxPower: -16 }),
    mk('all › Ethernet50', { rxPower: -11 }),
    mk('all › Ethernet51', { rxPower: -3 }),
    mk('all › Ethernet52', { rxPower: -40 }),              // 링크 없음 — 바닥이 정상
    mk('all › Ethernet53', { rxPower: -12 }, { otherState: null, rxDevice: 'ok' }), // 장비 임계가 정상이라 함
    { kind: 'xcvr', name: 'all › Ethernet54', state: 'absent', detail: '' },
    { kind: 'psu', name: 'PowerSupply1', state: 'ok', detail: '' },
  ];
  const ports = ['Ethernet49', 'Ethernet50', 'Ethernet51', 'Ethernet53'].map((name) => ({ name, oper: 'up' })).concat([{ name: 'Ethernet52', oper: 'down' }]);
  const out = P.judgeOptics(parts, ports, { warnDbm: -10, faultDbm: -14 });
  const by = Object.fromEntries(out.map((p) => [p.name, p]));
  assert.equal(by['all › Ethernet49'].state, 'fault'); assert.match(by['all › Ethernet49'].detail, /약함/);
  assert.equal(by['all › Ethernet49'].optic.basis, 'portal');
  assert.equal(by['all › Ethernet50'].state, 'warn');
  assert.equal(by['all › Ethernet51'].state, 'ok');
  assert.equal(by['all › Ethernet52'].state, 'unknown', '링크 없는 포트의 낮은 광량을 장애로 세지 않는다');
  assert.equal(by['all › Ethernet52'].optic.judged, false); assert.match(by['all › Ethernet52'].detail, /판정 안 함/);
  assert.equal(by['all › Ethernet53'].state, 'ok'); assert.equal(by['all › Ethernet53'].optic.basis, 'device');
  assert.equal(by['all › Ethernet54'].state, 'absent');
  assert.equal(by.PowerSupply1.state, 'ok');
  assert.ok(out.every((p) => !Object.hasOwn(p, 'domJudge')), '판정 재료는 저장하지 않는다');
  // 포트를 못 읽었으면 판정하지 않는다
  const unk = P.judgeOptics([mk('all › Ethernet49', { rxPower: -30 })], null, {});
  assert.equal(unk[0].state, 'unknown'); assert.match(unk[0].detail, /포트 상태 모름/);
});

test('② xcvrDom — 장비 임계로 판정(Rx 는 따로)', () => {
  const x = P.xcvrDom({ rxPower: -20, rxPowerLowAlarm: -18, temperature: 80, temperatureHighWarn: 70 });
  assert.equal(x.rxDevice, 'fault'); assert.equal(x.otherState, 'warn');
  assert.equal(P.xcvrDom({ rxPower: -20 }).rxDevice, null, '임계가 없으면 장비 판정 없음');
});

test('③ 설정 — 장애 기준은 주의 기준 이하로 · 빈 칸은 이전 값', async () => {
  const S = await import('../src/cvp/settings.js');
  const n = S.normalizeSettings({ xcvrRxWarnDbm: -12, xcvrRxFaultDbm: -8 });
  assert.equal(n.xcvrRxFaultDbm, -12);
  const d = S.normalizeSettings({});
  assert.equal(d.xcvrRxWarnDbm, -10); assert.equal(d.xcvrRxFaultDbm, -14);
  const m = S.mergeSettings(S.normalizeSettings({ xcvrRxWarnDbm: -9 }), { xcvrRxWarnDbm: '' });
  assert.equal(m.xcvrRxWarnDbm, -9);
});

test('⑤ 추종 — xcvr 는 dom 포인터만 한 단계 더(소스 확인)', () => {
  const src = fs.readFileSync(new URL('../src/cvp/client.js', import.meta.url), 'utf8');
  assert.match(src, /xcvr: 3/);
  assert.match(src, /followChild\(kind, depth, c\.key\)/);
  assert.match(src, /P\.judgeOptics\(/);
});

test('⑥ 엣지 수신 정제 — dom·optic 의 아는 필드만', async () => {
  const src = fs.readFileSync(new URL('../src/central/cvpEdge.js', import.meta.url), 'utf8');
  assert.match(src, /opticOf\(p\)/);
});

let srv, base, cdb, reg;
before(async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  cdb = await import('../src/cvp/db.js');
  reg = await import('../src/cvp/registry.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
  const a = reg.saveServer({ name: 'CVP-T', host: 'https://10.99.0.1', authMode: 'token', token: 't', agent: '' });
  const now = Date.now();
  const parts = P.judgeOptics([
    { kind: 'xcvr', name: 'all › Ethernet49', state: 'unknown', detail: '', dom: { rxPower: -16 }, domJudge: {} },
    { kind: 'xcvr', name: 'all › Ethernet50', state: 'unknown', detail: '', dom: { rxPower: -2 }, domJudge: {} },
    { kind: 'xcvr', name: 'all › Ethernet51', state: 'unknown', detail: '', dom: { rxPower: -40 }, domJudge: {} },
    { kind: 'xcvr', name: 'all › Ethernet1', state: 'unknown', detail: '장착(xcvrPresent)' },
    { kind: 'xcvr', name: 'all › Ethernet2', state: 'absent', detail: '' },
  ], [{ name: 'Ethernet49', oper: 'up' }, { name: 'Ethernet50', oper: 'up' }, { name: 'Ethernet51', oper: 'down' }], {});
  await cdb.saveDevices({ agent: cdb.LOCAL_AGENT, cvpId: a.id, devices: [{ key: 'SN1', ts: now, hostname: 'leaf1', model: 'M', serial: 'SN1', streaming: true, parts, partsAt: now, ports: [] }], samples: false });
});
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('④ /tools/cvp/optics — 판정한 것 먼저·낮은 순 · 개수', async () => {
  const r = await fetch(`${base}/tools/cvp/optics`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.optics.map((o) => o.intf), ['Ethernet49', 'Ethernet50', 'Ethernet51']);
  assert.equal(j.optics[0].rxState, 'fault');
  assert.equal(j.counts.fault, 1); assert.equal(j.counts.ok, 1); assert.equal(j.counts.notLinked, 1);
  assert.equal(j.counts.noDom, 1); assert.equal(j.counts.absent, 1);
  assert.deepEqual(j.thresholds, { warnDbm: -10, faultDbm: -14 });
});
