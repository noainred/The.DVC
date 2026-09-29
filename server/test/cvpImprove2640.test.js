/**
 * test/cvpImprove2640.test.js — v2.640 CVP 개선의 **라우트 계약**을 실제 api 라우터로 고정한다(AUTH_ENABLED=true — 꺼져 있으면
 * requireRole 이 전부 admin 으로 통과한다).
 *  ① BGP 피어 주소·원문 표본은 admin 에게만(비-admin 은 peer '' + samplesHidden) — AUTHZ2611-06
 *  ② 파서 시험은 adminOnly · 왕복 0 · 모르는 kind 400 · 빈 본문 400
 *  ③ 장애 이력 조회(tools + 전체 범위) · 수동 닫기(adminOnly · 사유 필수) · 지금 판정(admin·operator)
 *  ④ 장비 CSV — BOM · 수식 가드 · 비-admin 은 관리 주소 빈 칸 · 값 없는 칸은 빈 칸(0 아님)
 *  ⑤ 설정 PUT 이 faultAlerts·faultAlertsClosed 불리언을 받고 되돌린다(구버전 파일은 기본 false/true)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvpimprove2640-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';

let srv, base, cdb, reg;
const USERS = {
  admin: { username: 'adm', role: 'admin', scope: null },
  op: { username: 'op', role: 'operator', scope: null },
  viewer: { username: 'vw', role: 'viewer', scope: null },
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-us-east'] } },
};
before(async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  cdb = await import('../src/cvp/db.js');
  reg = await import('../src/cvp/registry.js');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
  // 중앙 직접 CVP 1대 + 장비 1대(BGP 피어 down · PSU fault · 포트 down) 적재
  const saved = reg.saveServer({ name: 'CVP-T', host: 'https://10.99.0.1', authMode: 'token', token: 'tok', agent: '' });
  const now = Date.now();
  await cdb.saveDevices({ agent: cdb.LOCAL_AGENT, cvpId: saved.id, devices: [{
    key: 'SN1', ts: now, hostname: 'leaf1', model: 'DCS', serial: 'SN1', mgmtIp: '10.99.1.1', eosVersion: '4.30', streaming: true, telemetry: 'ok',
    parts: [{ kind: 'psu', name: 'PowerSupply1', state: 'fault', detail: 'powerLoss' }, { kind: 'fan', name: 'Fan1', state: 'ok', detail: '' }], partsAt: now,
    bgp: [{ peer: '10.99.2.2', asn: '65001', vrf: 'default', state: 'Idle', prefixes: null }, { peer: '10.99.2.3', asn: '65001', vrf: 'default', state: 'Established', prefixes: 12 }],
    ports: [{ name: 'Ethernet1', desc: 'up', speedBps: 1e10, oper: 'up', admin: 'up', inBps: 100, outBps: 200 }, { name: 'Ethernet2', desc: '=hack', speedBps: 1e10, oper: 'down', admin: 'up' }],
  }], samples: false });
  globalThis.__cvpId = saved.id;
});
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

async function call(u, method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  // Response.text() 는 BOM 을 벗긴다 — CSV 의 BOM 은 원시 바이트로 본다.
  const buf = Buffer.from(await r.arrayBuffer());
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const t = (bom ? buf.subarray(3) : buf).toString('utf8');
  let j = null; try { j = JSON.parse(t); } catch { /* CSV */ }
  return { s: r.status, t, j, h: r.headers, bom };
}

test('① BGP 피어 주소는 admin 에게만 — 비-admin 은 peer 가 비고 samplesHidden', async () => {
  const id = globalThis.__cvpId;
  const a = await call('admin', 'GET', `/tools/cvp/device?cvpId=${id}&key=SN1`);
  assert.equal(a.s, 200);
  assert.equal(a.j.bgp.peers[0].peer, '10.99.2.2');
  assert.equal(a.j.device.mgmtIp, '10.99.1.1');
  assert.ok(!a.j.samplesHidden);
  const o = await call('op', 'GET', `/tools/cvp/device?cvpId=${id}&key=SN1`);
  assert.equal(o.s, 200);
  assert.deepEqual(o.j.bgp.peers.map((p) => p.peer), ['', '']);
  assert.equal(o.j.bgp.summary.down, 1, '요약(개수)은 그대로 — 가리는 것은 주소뿐');
  assert.equal(o.j.device.mgmtIp, '');
  assert.equal(o.j.samplesHidden, true);
  assert.equal(o.j.addressHidden, true);
  assert.equal(JSON.stringify(o.j).includes('10.99.'), false, '비-admin 응답에 IPv4 가 없다');
  // 목록 응답의 status 도 samples 를 싣지 않는다
  const list = await call('op', 'GET', '/tools/cvp');
  assert.equal(list.s, 200);
  assert.equal(JSON.stringify(list.j).includes('"samples"'), false);
});

test('② 파서 시험 — adminOnly · 모르는 kind·빈 본문 400 · 오류 본문은 ok:false + keys', async () => {
  const bad = await call('op', 'POST', '/tools/cvp/parse-preview', { kind: 'inventory', text: '{}' });
  assert.equal(bad.s, 403);
  const k = await call('admin', 'POST', '/tools/cvp/parse-preview', { kind: 'nope', text: '{}' });
  assert.equal(k.s, 400);
  assert.ok(Array.isArray(k.j.kinds) && k.j.kinds.includes('inventory'));
  const e = await call('admin', 'POST', '/tools/cvp/parse-preview', { kind: 'inventory', text: '   ' });
  assert.equal(e.s, 400);
  const ok = await call('admin', 'POST', '/tools/cvp/parse-preview', { kind: 'inventory', text: JSON.stringify([{ serialNumber: 'S1', hostname: 'h1', modelName: 'M', version: '4.1' }]) });
  assert.equal(ok.s, 200);
  assert.equal(ok.j.preview.ok, true);
  assert.equal(ok.j.preview.count, 1);
  assert.equal(ok.j.preview.items[0].hostname, 'h1');
  const err = await call('admin', 'POST', '/tools/cvp/parse-preview', { kind: 'interfaces', text: '{"errorCode":"112498","errorMessage":"Unauthorized"}' });
  assert.equal(err.s, 200);
  assert.equal(err.j.preview.ok, false);
  assert.ok(err.j.preview.keys.includes('errorMessage'), '응답에 있던 필드가 곧 다음 후보의 근거다');
});

test('③ 장애 이력 — 판정 → 열린 장애 3건(PSU·포트·BGP) · 비-admin 은 BGP 피어 주소 가림 · 수동 닫기 adminOnly + 사유 필수', async () => {
  const id = globalThis.__cvpId;
  const vw = await call('viewer', 'POST', '/tools/cvp/faults/scan', {});
  assert.equal(vw.s, 403, 'viewer 는 판정을 실행할 수 없다');
  const run = await call('op', 'POST', '/tools/cvp/faults/scan', {});
  assert.equal(run.s, 200, run.t);
  assert.equal(run.j.result.opened, 3);
  const a = await call('admin', 'GET', `/tools/cvp/faults?cvpId=${id}`);
  assert.equal(a.s, 200);
  assert.equal(a.j.open.length, 3);
  assert.deepEqual(a.j.open.map((f) => f.kind).sort(), ['bgp', 'port', 'psu']);
  assert.equal(a.j.open.find((f) => f.kind === 'bgp').faultKey, 'bgp:default|10.99.2.2');
  assert.equal(a.j.counts.open, 3);
  assert.equal(a.j.settings.faultAlerts, false, '알림은 기본 꺼짐(기록만)');
  assert.ok(a.j.scan && a.j.scan.at, '마지막 판정 시각');
  const o = await call('op', 'GET', `/tools/cvp/faults?cvpId=${id}`);
  assert.equal(o.s, 200);
  const bg = o.j.open.find((f) => f.kind === 'bgp');
  assert.equal(bg.faultKey, '(가림)');
  assert.equal(JSON.stringify(o.j).includes('10.99.'), false, '비-admin 장애 응답에 IPv4 가 없다');
  const sadm = await call('sadm', 'GET', '/tools/cvp/faults');
  assert.equal(sadm.s, 403, '범위 제한 계정은 403(CVP 는 vCenter 축이 없다)');
  // 수동 닫기
  const psu = a.j.open.find((f) => f.kind === 'psu');
  const noReason = await call('admin', 'POST', '/tools/cvp/faults/close', { agent: psu.agent, cvpId: psu.cvpId, deviceKey: psu.deviceKey, faultKey: psu.faultKey, reason: ' ' });
  assert.equal(noReason.s, 400);
  const opClose = await call('op', 'POST', '/tools/cvp/faults/close', { agent: psu.agent, cvpId: psu.cvpId, deviceKey: psu.deviceKey, faultKey: psu.faultKey, reason: 'x' });
  assert.equal(opClose.s, 403);
  const closed = await call('admin', 'POST', '/tools/cvp/faults/close', { agent: psu.agent, cvpId: psu.cvpId, deviceKey: psu.deviceKey, faultKey: psu.faultKey, reason: '장비 철거' });
  assert.equal(closed.s, 200, closed.t);
  const again = await call('admin', 'POST', '/tools/cvp/faults/close', { agent: psu.agent, cvpId: psu.cvpId, deviceKey: psu.deviceKey, faultKey: psu.faultKey, reason: '다시' });
  assert.equal(again.s, 404, '이미 닫힌 장애');
  const after1 = await call('admin', 'GET', `/tools/cvp/faults?cvpId=${id}`);
  assert.equal(after1.j.open.length, 2);
  const ev = after1.j.events.find((e) => e.event === 'close');
  assert.ok(ev && String(ev.closeReason).startsWith('manual:adm'), `수동 닫기 이벤트: ${JSON.stringify(ev)}`);
  // 목록 응답의 faults 개수 KPI
  const main = await call('admin', 'GET', '/tools/cvp');
  assert.equal(main.j.faults.open, 2);
  assert.ok(main.j.faultScan && main.j.faultScan.at);
});

test('④ 장비 CSV — BOM·수식 가드·비-admin 주소 빈 칸·값 없는 칸은 빈 칸', async () => {
  const id = globalThis.__cvpId;
  const a = await call('admin', 'GET', `/tools/cvp/devices.csv?cvpId=${id}`);
  assert.equal(a.s, 200, a.t);
  assert.match(String(a.h.get('content-type')), /text\/csv/);
  assert.match(String(a.h.get('content-disposition')), /cvp-devices-\d{8}-\d{4}\.csv/);
  assert.ok(a.bom, 'BOM(UTF-8 EF BB BF)');
  const lines = a.t.replace(/\r\n$/, '').split('\r\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('호스트명'));
  assert.ok(lines[1].includes('10.99.1.1'), 'admin 은 관리 주소를 받는다');
  const cells = lines[1].split(',');
  assert.equal(cells[0], 'leaf1');
  const o = await call('op', 'GET', `/tools/cvp/devices.csv?cvpId=${id}`);
  // v2.643: CSV 가져오기/내보내기는 관리자 이상(data.csv) — operator 는 403 이다(주소 가림 이전에 막힌다).
  assert.equal(o.s, 403);
  assert.equal(o.t.includes('10.99.1.1'), false, '비-admin 은 관리 주소 없음');
  const vw = await call('viewer', 'GET', '/tools/cvp/devices.csv');
  assert.equal(vw.s, 403, 'viewer 는 tools 권한이 없다');
  const sadm = await call('sadm', 'GET', '/tools/cvp/devices.csv');
  assert.equal(sadm.s, 403);
  // 수식 가드: 셀이 = 로 시작하면 작은따옴표
  const { guardCell } = await import('../src/util/csv.js');
  assert.equal(guardCell('=hack'), "'=hack");
  const q = await call('admin', 'GET', `/tools/cvp/devices.csv?cvpId=${id}&q=zzz-none`);
  assert.equal(q.t.replace(/\r\n$/, '').split('\r\n').length, 1, '검색이 반영된다(머리글만)');
});

test('⑤ 설정 — faultAlerts·faultAlertsClosed 불리언 왕복 · 미지정은 기본(false·true)', async () => {
  const s0 = await call('admin', 'GET', '/tools/cvp/settings');
  assert.equal(s0.j.settings.faultAlerts, false);
  assert.equal(s0.j.settings.faultAlertsClosed, true);
  const p = await call('admin', 'PUT', '/tools/cvp/settings', { faultAlerts: true, faultAlertsClosed: false });
  assert.equal(p.s, 200);
  assert.equal(p.j.settings.faultAlerts, true);
  assert.equal(p.j.settings.faultAlertsClosed, false);
  const p2 = await call('admin', 'PUT', '/tools/cvp/settings', { intervalMs: 120_000 });
  assert.equal(p2.j.settings.faultAlerts, true, '빈 패치는 이전 값 유지');
  const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'cvp-settings.json'), 'utf8'));
  assert.equal(raw.faultAlerts, true);
  const op = await call('op', 'PUT', '/tools/cvp/settings', { faultAlerts: false });
  assert.equal(op.s, 403);
});

test('등록 삭제는 그 CVP 의 열린 장애를 지운다(이벤트 이력은 남긴다)', async () => {
  const id = globalThis.__cvpId;
  const before1 = await cdb.faultCounts();
  assert.equal(before1.open, 2);
  const d = await call('admin', 'DELETE', `/tools/cvp/servers/${encodeURIComponent(id)}`);
  assert.equal(d.s, 200, d.t);
  const after1 = await cdb.faultCounts();
  assert.equal(after1.open, 0);
  const ev = await cdb.recentFaultEvents({ cvpId: id });
  assert.ok(ev.rows.length >= 3, '이벤트 이력은 남는다');
});
