/**
 * v2.732 그룹 g — B3-02: SAN 포트 상세(GET /tools/sanswitch/devices/:id/ports)가 비-admin 에 extra 원본을 주던 것.
 *
 * 수정 전(재현 — verify-B3): operator 응답이 `host:'' · addressHidden:true` 를 말하면서 `extra.credFp.user`(SSH 계정명)와
 * `extra.fabricMembers.switches[].enetIp`(자기·이웃 스위치 관리 IP)를 그대로 줬다. 같은 operator 의 목록에서는 계정명이 비어 있었다.
 * 고정하는 것(실제 api 라우터 + 사용자 주입):
 *   ① operator 응답 텍스트에 관리 IP·계정명 0건 · credFp.user '' · 구성원 enetIp/fcIp '' · RASLog 본문의 알려진 주소도 가림
 *   ② admin 은 원값 그대로 ③ maskSnapAddress 단위 — 원본을 바꾸지 않고, 이름이 IP 인 구성원은 라벨 · snapAddressList
 *   ④ 엣지 사본처럼 스냅샷에 host 가 없어도 등록부 주소로 가린다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a2732g-sanmask-'));
process.env.CONFIG_DIR = DIR;
process.env.DB_DIR = DIR;
process.env.TEMP_DB_PATH = path.join(DIR, 'host-temp.db');
process.env.IDRAC_DB_PATH = path.join(DIR, 'idrac-power.db');
process.env.AUTH_ENABLED = 'false';
process.env.DATA_SOURCE = 'mock';

const express = (await import('express')).default;
const { api } = await import('../src/routes/api.js');
const sanStore = await import('../src/sanswitch/store.js');
const sanReg = await import('../src/sanswitch/registry.js');
const mask = await import('../src/auth/addressMask.js');

const mk = (user) => { const app = express(); app.use(express.json()); app.use((req, _r, next) => { req.user = user; next(); }); app.use('/api', api); return app; };
const start = async (app) => { const s = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); }); return { s, base: `http://127.0.0.1:${s.address().port}` }; };
const get = async (base, p) => { const r = await fetch(base + p); const text = await r.text(); return { status: r.status, text, body: text ? JSON.parse(text) : null }; };

const admin = await start(mk({ username: 'root', role: 'admin', scope: null }));
const oper = await start(mk({ username: 'op', role: 'operator', scope: null }));
test.after(() => { admin.s.close(); oper.s.close(); fs.rmSync(DIR, { recursive: true, force: true }); });

const HOST = '10.99.1.10';
const PEER = '10.99.1.11';
const FCIP = '10.99.2.20';
const extra = () => ({
  credFp: { user: 'svc-san', len: 8, hash: 'a1b2', space: false, empty: false, userSpace: false },
  credFpSource: 'central',
  fabricMembers: {
    parsed: true, count: 3, principal: 1,
    switches: [
      { domain: 1, switchId: 'fffc01', wwn: '10:00:00:05:1e:00:00:01', enetIp: HOST, fcIp: FCIP, name: 'SW-A' },
      { domain: 2, switchId: 'fffc02', wwn: '10:00:00:05:1e:00:00:02', enetIp: PEER, fcIp: '', name: 'SW-B' },
      { domain: 3, switchId: 'fffc03', wwn: '10:00:00:05:1e:00:00:03', enetIp: '10.99.1.12', fcIp: '', name: '10.99.1.12' },
    ],
  },
  raslog: { parsed: true, counts: { total: 1 }, list: [{ id: 'SEC-1203', at: null, severity: 'warning', text: `[SEC-1203] Login information: Login failed via TELNET IP Addr: ${PEER}` }] },
  switchType: '165.3',
});

let dev;
test.before(() => {
  dev = sanReg.saveDevice({ type: 'brocade', name: 'SW-A', host: HOST, username: 'svc-san', password: 'p', collectMethod: 'ssh' });
  sanStore.putSnapshot({
    deviceId: dev.id, type: 'brocade', name: 'SW-A', host: HOST, ok: true, collectedAt: Date.now(),
    ports: { total: 0, list: [] }, sections: { ports: 'ok' }, extra: extra(),
  });
});

test('① operator — 관리 IP·SSH 계정명이 응답 어디에도 없다(extra 포함)', async () => {
  const r = await get(oper.base, `/api/tools/sanswitch/devices/${dev.id}/ports`);
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.equal(r.body.addressHidden, true);
  assert.equal(r.body.host, '');
  for (const ip of [HOST, PEER, FCIP, '10.99.1.12']) assert.ok(!r.text.includes(ip), `${ip} 가 샜다`);
  assert.ok(!r.text.includes('svc-san'), 'SSH 계정명이 샜다');
  assert.equal(r.body.extra.credFp.user, '');
  assert.equal(r.body.extra.credFp.hash, 'a1b2', '지문 해시는 남긴다(인증 진단)');
  const sw = r.body.extra.fabricMembers.switches;
  assert.deepEqual(sw.map((m) => [m.enetIp, m.fcIp]), [['', ''], ['', ''], ['', '']]);
  assert.deepEqual(sw.slice(0, 2).map((m) => m.name), ['SW-A', 'SW-B'], '이름(주소 아님)은 그대로');
  assert.match(sw[2].name, /이름 가림/);
  assert.match(r.body.extra.raslog.list[0].text, /\(주소 가림\)/);
  assert.equal(r.body.extra.switchType, '165.3', '주소가 아닌 값은 그대로');
});

test('② admin — 원값 그대로', async () => {
  const r = await get(admin.base, `/api/tools/sanswitch/devices/${dev.id}/ports`);
  assert.equal(r.status, 200);
  assert.equal(r.body.host, HOST);
  assert.equal(r.body.addressHidden, undefined);
  assert.equal(r.body.extra.credFp.user, 'svc-san');
  assert.equal(r.body.extra.fabricMembers.switches[1].enetIp, PEER);
  assert.ok(r.body.extra.raslog.list[0].text.includes(PEER));
});

test('③ maskSnapAddress — 원본 불변 · 구성원 IP 비움 · snapAddressList', () => {
  const snap = { deviceId: 'd1', type: 'brocade', name: 'SW-A', host: HOST, extra: extra() };
  const before = JSON.stringify(snap);
  const m = mask.maskSnapAddress(snap);
  assert.equal(JSON.stringify(snap), before, '원본을 바꾸지 않는다');
  assert.ok(!JSON.stringify(m.extra.fabricMembers).includes('10.99.'));
  assert.equal(m.extra.fabricMembers.count, 3, '개수·principal 등은 그대로');
  assert.deepEqual(mask.snapAddressList(snap, 'sw-a.corp').sort(), ['10.99.1.10', '10.99.1.11', '10.99.1.12', '10.99.2.20', 'sw-a.corp'].sort());
  assert.deepEqual(mask.maskSnapAddress({ extra: { fabricMembers: { switches: [null, 'x', { enetIp: '' }] } } }).extra.fabricMembers.switches, [null, 'x', { enetIp: '' }], '이상한 원소는 그대로 둔다(던지지 않는다)');
});

test('④ 스냅샷에 host 가 없는 사본도 등록부 주소로 가린다', async () => {
  sanStore.putSnapshot({
    deviceId: dev.id, type: 'brocade', name: HOST, ok: true, collectedAt: Date.now() + 1,
    ports: { total: 0, list: [] }, sections: { ports: `오류: ${HOST}:443 응답이 없습니다` }, extra: extra(),
  });
  const r = await get(oper.base, `/api/tools/sanswitch/devices/${dev.id}/ports`);
  assert.equal(r.status, 200);
  for (const ip of [HOST, PEER, FCIP]) assert.ok(!r.text.includes(ip), `${ip} 가 샜다`);
  assert.match(r.body.name, /이름 가림/);
});
