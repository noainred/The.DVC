/**
 * test/sweep2931Bm.test.js — v2.931 최근 변경 점검(축 1 · 5) 확정분: 베어메탈 성능 · CVP 업링크 · SAN 귀속 · 엣지 정제.
 *  ① A1-01(=E1-01) bm-ports 응답 캐시 열쇠에 사용자별 CVP 도구 판정 — 허용 사용자가 연 응답을 거부 사용자가 받지 않는다(반대도)
 *  ② E1-08 상세·추이 열쇠에 엣지 보관분 세대(snapAt) · 엣지 대행 실패는 no-store(ETag·304 없음)
 *  ③ A1-06(=E1-07) 엣지 최신값 행 정제 — 실제 usage_latest 의 모든 열이 남는다(PRAGMA 대조) · 피크 수치화 · 피크 시각 자르기 · peak_src enum
 *  ④ A1-02 · A1-03 · A1-07 /hosts/:id/net-uplinks — 비관리자 가림 · 범위 + 법인 미지정은 CVP 0 · vmnic 3번째 MAC 도 찾는다
 *  ⑤ A1-04 SAN 귀속 — 측정 못 한 후보가 있으면 나누지 않는다(0 B 로 확정하지 않는다)
 *  ⑥ E1-06 L2 고아 정리 — l2_meta 로 고른 고아만 지우고, 전체 훑기는 간격마다 한 번
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep2931bm-'));
Object.assign(process.env, { CONFIG_DIR: DIR, DATA_SOURCE: 'live', AUTH_ENABLED: 'true' });
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
fs.writeFileSync(path.join(DIR, 'datacenters.json'), JSON.stringify({ datacenters: [{ id: 'corp-a', name: 'A' }, { id: 'corp-b', name: 'B' }], assign: { 'vc-a': 'corp-a' } }));
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 3, matrix: { operator: ['dashboard', 'tools', 'inv.hosts'], viewer: ['dashboard', 'tools', 'inv.hosts'] }, toolsDenied: { operator: [], viewer: [] } }));

const H = 3_600_000;
const NOW = Math.floor(Date.now() / H) * H - 30 * 60_000;   // 정시에서 떨어뜨린 기준 시각(규약 — 실제 시각 기준)

const { store } = await import('../src/store.js');
const { memoJson } = await import('../src/routes/api/shared.js');
const B = await import('../src/routes/api/bmUsage.js');
const PERM = await import('../src/auth/permissions.js');

function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined, headersSent: false,
    set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    getHeader(k) { return this.headers[String(k).toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; }, end(b) { if (b !== undefined) this.body = b; return this; },
  };
}
const reqOf = (user, url) => ({ user, params: { key: 'S' }, query: {}, originalUrl: url, headers: {}, get() { return undefined; } });

test('① A1-01 bm-ports — CVP 도구 판정이 캐시 열쇠에 들어가 허용 · 거부 사용자가 서로의 응답을 받지 않는다', async () => {
  assert.equal(PERM.setUserTools('opB', { mode: 'deny', tools: ['cvp'], by: 'admin' }).ok, true);
  store.snapshot = { source: 'live', generatedAt: new Date(NOW).toISOString(), vcenters: [{ id: 'vc1', name: 'vc1' }], hosts: [], vms: [], datastores: [] };
  const target = { key: 'S', name: 'bm-kr1-db01', vcenterId: 'vc1', paths: ['os'] };
  const deps = {
    currentTargets: async () => ({ targets: [target] }), bmAddressHosts: async () => [], listEdgeBmUsage: async () => [],
    nicLatestFor: async () => ({ ok: true, nics: [{ nic: 'eno1', at: NOW, spanMs: 300_000, rxBps: 500_000, txBps: 1_000_000 }] }),
    cvpServers: async () => [{ id: 'c1', datacenterId: 'DC-KR' }], datacenterOfVcenter: async () => 'DC-KR',
    portLatestRows: async () => ({ rows: [{ cvp_id: 'c1', device_key: 'SW1', port: 'Et1', descr: 'bm-kr1-db01 eno1', in_bps: 8e6, out_bps: 4e6, rate_ts: NOW, hostname: 'sw1' }] }),
    portsByDesc: async () => ({ rows: [{ cvpId: 'c1', key: 'SW1', port: 'Et1', desc: 'bm-kr1-db01 eno1', hostname: 'sw1' }] }),
    cvpIntervalMs: async () => 300_000,
    listPortMap: async () => [{ nic: 'eno1', cvpId: 'c1', deviceKey: 'SW1', port: 'Et1', by: 'admin', at: 1 }],
  };
  const uA = { username: 'opA', role: 'operator' }; const uB = { username: 'opB', role: 'operator' };
  assert.notEqual(await B.portsKey(reqOf(uA, '/x')), await B.portsKey(reqOf(uB, '/x')), '열쇠가 도구 판정으로 갈린다');
  const run = async (u, url) => { const req = reqOf(u, url); const res = mkRes(); await memoJson(req, res, 'bm-ports', (snap) => B.bmPortsView(req, snap, deps), { extraKey: await B.portsKey(req) }); return res.body; };
  // A 먼저 → B 는 no-permission
  assert.equal((await run(uA, '/api/tools/bm-usage/perf/S/ports')).cvpAccess, true);
  const b1 = await run(uB, '/api/tools/bm-usage/perf/S/ports');
  assert.equal(b1.cvpAccess, false);
  assert.ok(b1.nics.every((n) => n.state === 'no-permission' && !n.port), 'B 는 포트 값을 받지 않는다');
  // B 먼저 → A 는 허용 응답
  assert.equal((await run(uB, '/api/tools/bm-usage/perf/S/ports?o=2')).cvpAccess, false);
  assert.equal((await run(uA, '/api/tools/bm-usage/perf/S/ports?o=2')).cvpAccess, true);
});

test('② E1-08 — 열쇠에 엣지 보관분 세대 · 엣지 대행 실패는 no-store(ETag 없음)', async () => {
  const E = await import('../src/central/bmUsageEdgePull.js');
  E._resetForTest();
  const u = { username: 'opA', role: 'operator' };
  const k0 = await B.perfKey(reqOf(u, '/x'));
  E.putEdgeBmUsage('edge-kr', { ok: true, snap: { node: { agent: 'edge-kr' }, rows: [], targets: [] } });
  const k1 = await B.perfKey(reqOf(u, '/x'));
  assert.notEqual(k0, k1, '엣지가 새 보관분을 올리면 열쇠가 바뀐다');
  // 실패 본문 → no-store, ETag 없음
  const fail = B.noStoreFail({ ok: false, via: 'edge', agent: 'edge-kr', reason: 'timeout' });
  assert.equal(fail.__noStore, true);
  assert.equal(B.noStoreFail({ ok: true, via: 'edge' }).__noStore, undefined, '성공은 그대로');
  assert.equal(B.noStoreFail({ __status: 404, ok: false, via: 'edge' }).__noStore, undefined, '__status 경로는 그대로');
  const res = mkRes();
  await memoJson(reqOf(u, '/api/tools/bm-usage/perf/S/history?t=fail'), res, 'bm-trend-test', async () => fail, { extraKey: 'k' });
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers.etag, undefined);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.__noStore, undefined, '표지는 본문에 싣지 않는다');
  E._resetForTest();
});

test('③ A1-06 엣지 최신값 행 정제 — 실제 usage_latest 열이 모두 남고 · 피크는 수 · 피크 시각은 수신 시각으로 · peak_src 는 아는 값만', async () => {
  const D = await import('../src/bmusage/db.js');
  const db = await D.mainDbForMigration();
  assert.ok(db, 'bmusage DB 를 연다');
  const cols = db.prepare('PRAGMA table_info(usage_latest)').all().map((c) => c.name).filter((c) => c !== 'detail_json' && c !== 'tuning_json');
  assert.ok(cols.length > 64, `행 칸이 예전 상한(64)을 넘는다 — ${cols.length}`);
  const row = Object.fromEntries(cols.map((c) => [c, c === 'key' ? 'K1' : c === 'name' ? 'n1' : c === 'peak_src' ? 'sampler' : 1]));
  const { sanitizeBmUsageSnap } = await import('../src/central/bmUsageEdgePull.js');
  const out = sanitizeBmUsageSnap({ rows: [row] }, { receivedAt: NOW });
  const r = out.rows[0];
  const lost = cols.filter((c) => !Object.hasOwn(r, c));
  assert.deepEqual(lost, [], '빠진 열이 없다(dev_over 포함)');
  assert.equal(out.sanitizeDropped, undefined);
  const peakCol = cols.find((c) => c.endsWith('_peak'));
  const peakAt = cols.find((c) => c.endsWith('_peak_at'));
  assert.ok(peakCol && peakAt);
  const out2 = sanitizeBmUsageSnap({ rows: [{ key: 'K2', name: 'n', [peakCol]: '95.5', [peakAt]: NOW + 10 * 24 * H, peak_src: 'forged', dev_over: '3' }] }, { receivedAt: NOW });
  const r2 = out2.rows[0];
  assert.equal(r2[peakCol], 95.5, '문자열 수치는 수로');
  assert.equal(r2[peakAt], NOW, '미래 피크 시각은 수신 시각으로 자른다');
  assert.equal(r2.peakAtRaw[peakAt], NOW + 10 * 24 * H, '원본은 따로');
  assert.equal(r2.peak_src, null, '모르는 출처는 null');
  assert.equal(r2.dev_over, 3);
  const r3 = sanitizeBmUsageSnap({ rows: [{ key: 'K3', name: 'n', [peakCol]: 'abc' }] }, { receivedAt: NOW }).rows[0];
  assert.equal(r3[peakCol], null, '못 읽은 피크는 null(0 이 아니다)');
});

test('④ A1-02 · A1-03 · A1-07 net-uplinks — 비관리자 가림 · 범위 + 법인 미지정은 CVP 0 · 3번째 vmnic MAC 도 찾는다', async () => {
  const cdb = await import('../src/cvp/db.js');
  if (!(await cdb.available())) return;   // node:sqlite 가 없는 환경
  const reg = await import('../src/cvp/registry.js');
  const R = await import('../src/routes/api/hostSan.js');
  const express = (await import('express')).default;
  const cvpA = reg.saveServer({ name: 'CVP-A', host: 'https://10.99.0.1', authMode: 'token', token: 't', agent: '', datacenterId: 'corp-a' }).id;
  const cvpN = reg.saveServer({ name: 'CVP-N', host: 'https://10.99.0.3', authMode: 'token', token: 't', agent: '' }).id;
  await cdb.saveDevices({ cvpId: cvpA, devices: [{ key: 'SNA', ts: NOW - 60_000, hostname: 'leafa', ports: [
    { name: 'Ethernet1', desc: 'esx77 vmnic0 to fw01 10.20.30.1 https://mgmt.corp/x', oper: 'up', admin: 'up', speedBps: 25e9, inBps: 1e9, outBps: 2e9 },
    { name: 'Ethernet3', desc: 'srv 0050.5677.0003', oper: 'up', admin: 'up', speedBps: 25e9, inBps: 1e9, outBps: 2e9 }] }] });
  await cdb.saveDevices({ cvpId: cvpN, devices: [{ key: 'SNN', ts: NOW - 60_000, hostname: 'leafn', ports: [{ name: 'Ethernet9', desc: 'esx01 vmnic0 corpB-db 10.77.0.9', oper: 'up', admin: 'up', speedBps: 25e9, inBps: 5e9, outBps: 6e9 }] }] });
  await cdb.saveEvents('', cvpA, [{ key: 'ev1', ts: NOW - 30_000, severity: 'WARNING', title: 'Link flap 10.20.30.1', desc: 'peer https://mgmt.corp/x 10.20.30.1 down', type: 'LINK', devices: ['SNA'] }]);
  const nics = ['00:50:56:77:00:00', '00:50:56:77:00:01', '00:50:56:77:00:02', '00:50:56:77:00:03'].map((mac, i) => ({ device: `vmnic${i}`, mac }));
  store.snapshot = { source: 'live', generatedAt: new Date(NOW).toISOString(), vcenters: [{ id: 'vc-a', name: 'vc-a' }, { id: 'vc-x', name: 'vc-x' }],
    hosts: [{ id: 'vc-a:h77', name: 'esx77.corp.local', vcenterId: 'vc-a', nics }, { id: 'vc-x:h01', name: 'esx01.x.local', vcenterId: 'vc-x', nics: [{ device: 'vmnic0', mac: '00:50:56:01:00:00' }] }], vms: [], datastores: [] };
  let user = null;
  const app = express();
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); R.registerHostSan(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const get = async (p) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}/api${p}`); return { status: r.status, j: await r.json() }; };
  try {
    user = { username: 'op1', role: 'operator' };
    let r = await get(`/hosts/${encodeURIComponent('vc-a:h77')}/net-uplinks`);
    assert.equal(r.status, 200);
    const all = JSON.stringify(r.j.uplinks) + JSON.stringify(r.j.events);
    assert.doesNotMatch(all, /10\.20\.30\.1|https:\/\/mgmt/, 'A1-02 비관리자 응답에 주소 · URL 이 없다');
    assert.equal(r.j.addressHidden, true);
    assert.ok(r.j.events.length >= 1, '이벤트는 남는다(글자만 가림)');
    assert.ok(r.j.uplinks.some((u) => u.port === 'Ethernet3'), 'A1-07 vmnic3 MAC(점 표기)만 적힌 포트도 찾는다');
    user = { username: 'adm', role: 'admin' };
    r = await get(`/hosts/${encodeURIComponent('vc-a:h77')}/net-uplinks`);
    assert.ok(r.j.uplinks.some((u) => /10\.20\.30\.1/.test(u.desc)), '관리자는 원문');
    assert.equal(r.j.addressHidden, undefined);
    user = { username: 'sx', role: 'viewer', scope: { vcenters: ['vc-x'] } };
    r = await get(`/hosts/${encodeURIComponent('vc-x:h01')}/net-uplinks`);
    assert.equal(r.status, 200);
    assert.equal(r.j.corpMissing, true);
    assert.equal(r.j.servers, 0, 'A1-03 범위 + 법인 미지정은 CVP 를 보지 않는다');
    assert.deepEqual(r.j.uplinks, []);
    user = { username: 'adm', role: 'admin' };   // 대조: 전체 범위는 예전처럼 법인 미지정 CVP 를 본다
    r = await get(`/hosts/${encodeURIComponent('vc-x:h01')}/net-uplinks`);
    assert.ok(r.j.uplinks.some((u) => u.cvpId === cvpN));
  } finally { srv.close(); }
  // portsByDesc 단서 상한 — 넘기면 termsTruncated
  const many = Array.from({ length: 40 }, (_, i) => `00505677${String(i).padStart(4, '0')}`);
  assert.equal((await cdb.portsByDesc(['esx77'], { macs: many })).termsTruncated, true);
  assert.equal((await cdb.portsByDesc(['esx77'], { macs: many.slice(0, 4) })).termsTruncated, undefined);
});

test('⑤ A1-04 SAN 귀속 — 후보 중 하나라도 타깃 바이트를 못 읽었으면 나누지 않는다', async () => {
  // 실제 함수로: 점검자 재현과 같은 구성(r1_split.mjs) — PMAX 타깃 포트는 표본 있음, PowerStore 타깃 포트는 없음
  const A = await import('../src/sanswitch/attribution.js');
  const H1 = '10:00:00:10:9b:00:00:01', T1 = '50:00:09:73:00:00:00:01', T2 = '58:cc:f0:00:00:00:00:c0';
  const port = (index, attached, attachedName) => ({ index, slotPort: `0/${index}`, name: `p${index}`, state: 'online', speed: '16G', attached, attachedName, inBps: 100, outBps: 200 });
  const snap = { deviceId: 'swA', name: 'SW-A', datacenterId: 'corp-a', collectedAt: NOW, ok: true,
    ports: { list: [port(0, [H1], 'Emulex PPN-x'), port(1, [T1], 'SYMMETRIX::000497700230::FA-1D:4'), port(2, [T2], 'PowerStore::PS12345::node-A')] },
    zoning: { available: true, zones: [{ name: 'Z1', members: [H1, T1] }, { name: 'Z2', members: [H1, T2] }] },
    nsRoles: { [H1]: 'initiator', [T1]: 'target', [T2]: 'target' } };
  const fab = A.buildFabrics([snap]);
  const host = { id: 'h', name: 'esx01', vcenterId: 'vc', hbas: [{ name: 'vmhba1', wwn: H1 }] };
  const pb = new Map([['swA|0', { bytes: 1000, measuredBuckets: 10, totalBuckets: 12 }], ['swA|1', { bytes: 3000, measuredBuckets: 10, totalBuckets: 12 }]]);
  const r = A.attributeHost(host, fab, { portBytes: pb });
  const h = r.hbas[0];
  assert.equal(h.targets.length, 2);
  assert.equal(h.conf, 'unsplit', '못 읽은 후보가 있으면 나누지 않는다');
  assert.match(h.basis, /1개의 타깃 포트 바이트를 읽지 못해/);
  assert.ok(h.targets.every((t) => t.share == null), 'share 를 0 · 1 로 확정하지 않는다');
  assert.ok(r.storages.every((s) => s.estimatedBytes == null), '0 B 로 확정한 스토리지가 없다');
  // 대조: 둘 다 측정되면 예전처럼 비율로 나눈다
  pb.set('swA|2', { bytes: 1000, measuredBuckets: 10, totalBuckets: 12 });
  const r2 = A.attributeHost(host, fab, { portBytes: pb });
  assert.equal(r2.hbas[0].conf, 'estimated');
  assert.deepEqual(r2.hbas[0].targets.map((t) => t.share).sort(), [0.25, 0.75]);
});

test('⑥ E1-06 L2 고아 정리 — 고아는 l2_meta 로 골라 지우고 전체 훑기는 간격마다', async () => {
  const src = fs.readFileSync(new URL('../src/cvp/db.js', import.meta.url), 'utf8');
  assert.match(src, /SELECT device_key AS k FROM l2_meta WHERE agent=\? AND cvp_id=\? AND device_key NOT IN/);
  assert.match(src, /Date\.now\(\) - last >= L2_FULL_SWEEP_MS/);
  const cdb = await import('../src/cvp/db.js');
  assert.ok(cdb.L2_FULL_SWEEP_MS >= 3_600_000);
});
