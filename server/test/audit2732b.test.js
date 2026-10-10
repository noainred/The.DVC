/**
 * test/audit2732b.test.js — 점검 2회차(v2.732) 그룹 b: CVP 정직성·가림.
 *  B2-02 등록부 담당과 맞지 않는 옛 담당 행을 Overview '네트워크 장비' 수·전체 소비 전력에 섞지 않는다
 *        (판정은 cvp/overview.js rowBelongs 하나 — CVP 라우트와 같은 함수).
 *  B2-03 CVP '소비전력'·'GBIC 광신호' 합계·판정 KPI 에서 지금 값이 아닌 장비(수집 오래됨·부품 목록 오래됨)를 빼고 개수로 밝힌다.
 *  B3-04 포트 사용량의 포트 설명은 비-admin 에 주소를 가린다(장비 상세 maskDevicePorts 와 같은 가림).
 * 실제 api 라우터를 express 에 마운트하고 사용자를 주입해 응답 값·상태로 판정한다.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2732b-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';

const P = await import('../src/cvp/parse.js');

let srv; let base; let cdb; let reg; let ov;
const USERS = {
  admin: { username: 'adm', role: 'admin', scope: null },
  op: { username: 'op', role: 'operator', scope: null },
};
const ids = {};
const DAY = 86_400_000;

before(async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  cdb = await import('../src/cvp/db.js');
  reg = await import('../src/cvp/registry.js');
  ov = await import('../src/cvp/overview.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || USERS.admin; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
  const now = Date.now();

  // ── B2-02: 중앙 직접(LOCAL) 으로 수집하던 CVP 를 엣지 edgeB 로 재배정 — 옛 LOCAL 행이 남는다(옛 담당이 다시 push 하지 않는 경우).
  const a = reg.saveServer({ name: 'CVP-MOVE', host: 'https://10.99.0.1', authMode: 'token', token: 't', agent: '' });
  ids.move = a.id;
  const devA = (ts) => ({ key: 'SW-MOVE', ts, hostname: 'sw-move', model: 'M', serial: 'SW-MOVE', streaming: true,
    parts: [{ kind: 'psu', name: 'P1', state: 'ok', detail: '', power: { inW: 400, outW: null, capW: null } }], partsAt: ts, ports: [] });
  await cdb.saveDevices({ agent: cdb.LOCAL_AGENT, cvpId: a.id, devices: [devA(now - 60_000)], samples: false });
  reg.saveServer({ ...(reg.getServerWithSecret?.(a.id) || a), id: a.id, agent: 'edgeB' });
  await cdb.saveDevices({ agent: 'edgeB', cvpId: a.id, devices: [devA(now)], samples: false });

  // ── B2-03 · B3-04: 같은 CVP(중앙 직접)에 장비 셋 — 신선 / 수집 3일 전 / 수집은 지금인데 부품 목록만 3일 전.
  const b = reg.saveServer({ name: 'CVP-STALE', host: 'https://10.99.0.2', authMode: 'token', token: 't', agent: '' });
  ids.stale = b.id;
  const optic = (portUp) => P.judgeOptics(
    [{ kind: 'xcvr', name: 'all › Ethernet49', state: 'unknown', detail: '', dom: { rxPower: -16 }, domJudge: {} }],
    [{ name: 'Ethernet49', oper: portUp ? 'up' : 'down' }], {});
  const parts = (w) => [{ kind: 'psu', name: 'P1', state: 'ok', detail: '', power: { inW: w, outW: null, capW: null } }, ...optic(true)];
  await cdb.saveDevices({ agent: cdb.LOCAL_AGENT, cvpId: b.id, devices: [
    { key: 'SN-FRESH', ts: now, hostname: 'fresh', model: 'M2', serial: 'SN-FRESH', streaming: true, parts: parts(400), partsAt: now,
      ports: [{ name: 'Ethernet1', desc: 'uplink to core 10.20.30.40 (mgmt https://10.20.30.41/)', speedBps: 1e9, oper: 'up', admin: 'up', inBps: 5e8, outBps: 1e8, inUtil: 50, outUtil: 10 }] },
    { key: 'SN-OLD', ts: now - 3 * DAY, hostname: 'old', model: 'M2', serial: 'SN-OLD', streaming: true, parts: parts(500), partsAt: now - 3 * DAY, ports: [] },
    { key: 'SN-PARTSOLD', ts: now, hostname: 'partsold', model: 'M2', serial: 'SN-PARTSOLD', streaming: true, parts: parts(300), partsAt: now - 3 * DAY, ports: [] },
  ], samples: false });
});
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

async function call(u, p) {
  const r = await fetch(base + p, { headers: { 'x-u': u } });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, j, t };
}

test('B2-02 ① rowBelongs(공용 판정) — 등록부 담당과 맞는 행만 · 대소문자 무시 · 미지정 = 중앙 행', () => {
  assert.equal(typeof ov.rowBelongs, 'function', 'cvp/overview.js 가 rowBelongs 를 export 한다');
  const servers = [{ id: 'c1', agent: 'Edge-B' }, { id: 'c2', agent: '' }, { id: 'c3', agent: '  ' }];
  assert.equal(ov.rowBelongs({ cvpId: 'c1', agent: 'edge-b' }, servers), true, '대소문자만 다르면 같은 담당');
  assert.equal(ov.rowBelongs({ cvpId: 'c1', agent: '' }, servers), false, '옛 중앙 행');
  assert.equal(ov.rowBelongs({ cvpId: 'c1', agent: 'edgeA' }, servers), false, '옛 엣지 행');
  assert.equal(ov.rowBelongs({ cvpId: 'c2', agent: '' }, servers), true);
  assert.equal(ov.rowBelongs({ cvpId: 'c2', agent: 'edgeA' }, servers), false);
  assert.equal(ov.rowBelongs({ cvpId: 'c3', agent: '' }, servers), true, '공백만 있는 담당은 미지정');
  assert.equal(ov.rowBelongs({ cvpId: 'gone', agent: '' }, servers), false, '등록부에 없는 CVP');
  assert.equal(ov.rowBelongs(null, servers), false);
  assert.equal(cdb.LOCAL_AGENT, '', '중앙 행의 agent 는 빈 문자열이다(rowBelongs 가 기대하는 값)');
});

test('B2-02 ② Overview 네트워크 장비 수·전체 소비 전력은 옛 담당 행을 세지 않는다(CVP 화면과 같은 수)', async () => {
  const p = await call('admin', `/tools/cvp/power?cvpId=${encodeURIComponent(ids.move)}`);
  assert.equal(p.s, 200);
  assert.equal(p.j.totals.devices, 1, 'CVP 화면(기준)은 1대');
  const c = await call('admin', '/overview/cards');
  assert.equal(c.s, 200);
  // 장비 집합: 재배정 CVP 1대 + CVP-STALE 3대 = 4대(옛 LOCAL 행 제외)
  assert.equal(c.j.network.count, 4, 'Overview 네트워크 장비 수는 등록부 담당 행만');
  const t = await call('admin', '/tools/power-total');
  assert.equal(t.s, 200);
  assert.equal(t.j.network.devices, 4, '전체 소비 전력 네트워크 장비도 같은 집합');
  const moved = (t.j.network.items || []).filter((x) => String(x.id).startsWith(`${ids.move}/`));
  assert.equal(moved.length, 1, '재배정 장비는 한 번만 센다');
  assert.equal(moved[0].watts, 400);
});

test('B2-03 ① /tools/cvp/power — 지금 값이 아닌 장비는 합계·법인·모델에서 빼고 사유별로 센다(행은 남긴다)', async () => {
  const r = await call('admin', `/tools/cvp/power?cvpId=${encodeURIComponent(ids.stale)}`);
  assert.equal(r.s, 200);
  const tot = r.j.totals;
  assert.equal(tot.devices, 3);
  assert.equal(tot.read, 1, '읽은(지금 값) 장비는 1대');
  assert.equal(tot.watts, 400, '3일 전 부품 값(500 W·300 W)을 지금 값으로 더하지 않는다');
  assert.equal(tot.stale, 2);
  assert.equal(tot.staleBy.stale, 1, '수집 자체가 오래된 장비');
  assert.equal(tot.staleBy['parts-stale'], 1, '부품 목록만 오래된 장비');
  const unreadN = Object.values(tot.unread).reduce((s, v) => s + v, 0);
  assert.equal(tot.read + tot.stale + unreadN, tot.devices, '읽음 + 오래됨 + 못 읽음 = 장비');
  const by = Object.fromEntries(r.j.devices.map((d) => [d.key, d]));
  assert.equal(by['SN-FRESH'].watts, 400); assert.equal(by['SN-FRESH'].stale, false);
  assert.equal(by['SN-OLD'].watts, null, '오래된 값을 지금 소비전력 칸에 싣지 않는다');
  assert.equal(by['SN-OLD'].stale, true); assert.equal(by['SN-OLD'].staleReason, 'stale'); assert.equal(by['SN-OLD'].lastWatts, 500);
  assert.equal(by['SN-PARTSOLD'].stale, true); assert.equal(by['SN-PARTSOLD'].staleReason, 'parts-stale'); assert.equal(by['SN-PARTSOLD'].lastWatts, 300);
  assert.equal(r.j.corps.length, 1);
  assert.equal(r.j.corps[0].watts, 400); assert.equal(r.j.corps[0].read, 1); assert.equal(r.j.corps[0].stale, 2);
  const m = r.j.models.find((x) => x.model === 'M2');
  assert.equal(m.watts, 400); assert.equal(m.read, 1); assert.equal(m.avgW, 400); assert.equal(m.stale, 2);
});

test('B2-03 ② /tools/cvp/optics — 오래된 장비의 광량 판정은 KPI 에 넣지 않고 행에 표지', async () => {
  const r = await call('admin', `/tools/cvp/optics?cvpId=${encodeURIComponent(ids.stale)}`);
  assert.equal(r.s, 200);
  const c = r.j.counts;
  assert.equal(c.fault, 1, '3일 전 광량 장애 판정 2건을 지금 장애로 세지 않는다');
  assert.equal(c.judged, 1);
  assert.equal(c.staleDevices, 2); assert.equal(c.staleXcvr, 2);
  assert.equal(c.xcvr, 1, '판정에 쓴 트랜시버 집합은 지금 값 장비의 것만');
  assert.equal(r.j.optics.length, 3, '행은 남긴다');
  const stale = r.j.optics.filter((o) => o.stale === true);
  assert.equal(stale.length, 2);
  for (const o of stale) {
    assert.equal(o.judged, false, '오래된 행은 지금 판정이 아니다');
    assert.equal(o.rxState, null);
    assert.equal(o.lastRxState, 'fault', '직전 판정은 따로 남긴다');
  }
  assert.equal(r.j.optics[0].stale, false, '지금 판정한 행이 먼저');
  assert.equal(r.j.optics[0].rxState, 'fault');
});

test('B3-04 /tools/cvp/port-usage — 비-admin 은 포트 설명의 주소를 가린다(admin 은 원문)', async () => {
  const o = await call('op', `/tools/cvp/port-usage?cvpId=${encodeURIComponent(ids.stale)}`);
  assert.equal(o.s, 200);
  const row = o.j.ports.find((p) => p.key === 'SN-FRESH' && p.port === 'Ethernet1');
  assert.ok(row, '신선한 업링크 포트가 목록에 있다');
  assert.equal(/10\.20\.30\.4\d/.test(o.t), false, '비-admin 응답에 포트 설명 속 IPv4 가 없다');
  assert.match(row.desc, /uplink to core/, '주소 밖 글자는 남긴다');
  assert.match(row.desc, /주소 가림/);
  assert.equal(o.j.addressHidden, true);
  const a = await call('admin', `/tools/cvp/port-usage?cvpId=${encodeURIComponent(ids.stale)}`);
  const arow = a.j.ports.find((p) => p.key === 'SN-FRESH' && p.port === 'Ethernet1');
  assert.equal(arow.desc, 'uplink to core 10.20.30.40 (mgmt https://10.20.30.41/)', 'admin 은 원문');
  assert.equal(a.j.addressHidden, undefined);
});
