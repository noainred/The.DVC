/**
 * v2.933(SAN·CVP 설계 C-③) — CVP EndpointLocation(MAC → 지금 배운 스위치 · 포트) 버튼 + 주기.
 *  ① 파서 — 깊이 상관없이 interface + 장비 식별자 객체 · 줄마다 JSON · JSON 아님은 parsed:false(위치 없음과 구분) · 상한
 *  ② 조회 — ok · none · error · 404/501 이면 미지원으로 멈춤 · 시간 예산
 *  ③ 대상 고르기 — 호스트 NIC → 최근 이동 VM → 오래된 VM 순 · 이번 창에 물은 MAC 은 건너뜀 · 상한 · 이동 기억
 *  ④ DB — MAC 마다 위치 교체(vMotion 뒤 옛 포트가 남지 않게) · 오류 · 미지원은 위치를 지우지 않음 · 담당 행만 · 장비 호스트명 · push 변경분 · 현황
 *  ⑤ 요청 큐 — CVP 마다 한 건(MAC 합침 · 64) · 그 agent 몫만 가져감 · TTL
 *  ⑥ 실제 중앙 라우트 — cvp-config 가 epNow 를 내려보내고 · cvp-data 의 ep 를 정제해 저장하고 saved.ep 를 늘 수로 답한다 · 엣지 push ack 판정
 *  ⑦ 매칭 · 실제 화면 라우트 — 근거 ‘CVP 위치(확정)’ · LLDP 와 다르면 disagree · 지금 조회(위임 CVP 는 큐) · 역할 · 범위 · VM 위치 판정
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvpep2933-'));
Object.assign(process.env, { CONFIG_DIR: DIR, DATA_SOURCE: 'live', AUTH_ENABLED: 'true', CENTRAL_TOKEN: 'ctok-2929', SSRF_ALLOW_LOOPBACK: 'true' });   // 직접 CVP 는 127.0.0.1:9(즉시 거부) — 이 테스트 전용
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
// viewer 도 도구(tools) · 인벤토리 권한이 있어야 '역할' 게이트(admin · operator)까지 간다 — 도구 키 403 과 역할 403 을 가른다.
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 3, matrix: { viewer: ['dashboard', 'tools', 'inv.hosts', 'inv.vms'], operator: ['dashboard', 'tools', 'inv.hosts', 'inv.vms'] } }));
fs.writeFileSync(path.join(DIR, 'datacenters.json'), JSON.stringify({ datacenters: [{ id: 'corp-a', name: 'A' }, { id: 'corp-b', name: 'B' }], assign: { 'vc-a': 'corp-a', 'vc-b': 'corp-b' } }));
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'vc-a', name: 'vc-a', host: 'vca.corp.local', username: 'u', password: 'p', collectMode: 'site' }, { id: 'vc-b', name: 'vc-b', host: 'vcb.corp.local', username: 'u', password: 'p', collectMode: 'site' }] }));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });
const H = 3_600_000;
const NOW = Math.floor(Date.now() / H) * H;   // 정시로 떨어뜨린 실제 시각(docs/rules/common.md)
const E = await import('../src/cvp/endpoint.js');

const SAMPLE = JSON.stringify({ value: { key: { searchTerm: '00:50:56:aa:00:01' }, deviceMap: { values: {
  JPE1: { deviceId: 'JPE1', locationList: { values: [{ deviceId: 'JPE1', interface: 'Ethernet5', vlanId: 100, learnedTime: '2026-11-07T01:00:00Z', macType: 'MAC_TYPE_LEARNED_DYNAMIC', likelihood: 'LIKELIHOOD_VERY_LIKELY' }] } },
  JPE2: { deviceId: 'JPE2', locationList: { values: [{ interface: 'Port-Channel10', vlanId: '100' }] } } } } }, time: '2026-11-07T01:00:00Z' });

test('① 파서', () => {
  const p = E.parseEndpointLocation(SAMPLE);
  assert.equal(p.parsed, true);
  assert.deepEqual(p.locations.map((l) => [l.device, l.port, l.vlan]), [['JPE1', 'Ethernet5', 100], ['JPE2', 'Port-Channel10', 100]], '장비 식별자가 없는 위치는 부모 장비');
  assert.equal(p.locations[0].macType, 'MAC_TYPE_LEARNED_DYNAMIC');
  const nd = E.parseEndpointLocation(`{"result":{"value":{"deviceMap":{"values":{"X":{"deviceId":"X","locationList":{"values":[{"interface":"Et1"}]}}}}}}}\nnot json\n`);
  assert.deepEqual(nd.locations.map((l) => [l.device, l.port]), [['X', 'Et1']], '줄마다 JSON');
  assert.deepEqual(E.parseEndpointLocation('<html>'), { locations: [], parsed: false }, 'JSON 아님은 위치 없음과 다르다');
  assert.deepEqual(E.parseEndpointLocation('{}'), { locations: [], parsed: true });
  const many = { values: Array.from({ length: 40 }, (_, i) => ({ deviceId: `D${i}`, interface: `Et${i}` })) };
  assert.equal(E.parseEndpointLocation(JSON.stringify(many)).locations.length, E.EP_LOC_MAX);
  assert.equal(E.epQueryPath('005056aa0001'), '/api/resources/endpointlocation/v1/EndpointLocation?key.searchTerm=00%3A50%3A56%3Aaa%3A00%3A01');
});

test('② 조회 — 상태 · 미지원 멈춤 · 예산', async () => {
  const calls = [];
  const sess = (map) => ({ get: async (p) => { calls.push(p); const mac = decodeURIComponent(p.split('=')[1]).replace(/:/g, ''); return map[mac] || { ok: false, status: 500, reason: 'HTTP 500' }; } });
  let r = await E.lookupEndpoints(sess({ '005056aa0001': { ok: true, status: 200, text: SAMPLE }, '005056aa0002': { ok: true, status: 200, text: '{}' }, '005056aa0003': { ok: true, status: 200, text: 'x' } }),
    ['00:50:56:aa:00:01', '005056aa0002', '005056aa0003', '005056aa0004', 'bad'], { concurrency: 1 });
  assert.deepEqual(r.results.map((x) => [x.mac, x.status]), [['005056aa0001', 'ok'], ['005056aa0002', 'none'], ['005056aa0003', 'error'], ['005056aa0004', 'error']]);
  assert.equal(r.unsupported, false);
  // 반증 H-2: 404 는 본문으로 가른다 — 구체적 not found 는 위치 없음 · 'Not Found' 한 마디는 가를 수 없다
  const macsN = (n) => Array.from({ length: n }, (_, i) => `005056ab${String(i).padStart(4, '0')}`);
  const plain404 = { ok: false, status: 404, reason: 'HTTP 404', head: '{"code":5,"message":"Not Found","details":[]}' };
  calls.length = 0;
  r = await E.lookupEndpoints({ get: async (p) => { calls.push(p); return plain404; } }, macsN(10), { concurrency: 1 });
  assert.equal(r.unsupported, true); assert.equal(calls.length, E.AMBIG_STOP, `가를 수 없는 404 가 ${E.AMBIG_STOP}번 이어지고 답한 MAC 이 없으면 미지원`);
  assert.ok(r.results.every((x) => x.status === 'unsupported')); assert.equal(r.cut, 10 - E.AMBIG_STOP);
  assert.match(r.results[0].reason, /본문: \{"code":5/, '첫 실캡처 표본을 사유에 남긴다');
  r = await E.lookupEndpoints({ get: async () => plain404 }, macsN(3), { concurrency: 1 });
  assert.equal(r.unsupported, false, 'pNIC MAC 몇 개가 안 배워졌다고 CVP 전체를 미지원으로 적지 않는다');
  assert.ok(r.results.every((x) => x.status === 'error' && /가르지 못했습니다/.test(x.reason)));
  r = await E.lookupEndpoints({ get: async () => ({ ok: false, status: 404, head: '{"code":5,"message":"endpoint location 00:50:56:ab:00:00 not found"}' }) }, macsN(3), { concurrency: 1 });
  assert.deepEqual(r.results.map((x) => x.status), ['none', 'none', 'none'], '구체적 not found = 위치 없음');
  let k = 0;
  r = await E.lookupEndpoints({ get: async () => (k++ === 0 ? { ok: true, status: 200, text: SAMPLE } : plain404) }, macsN(4), { concurrency: 1 });
  assert.deepEqual(r.results.map((x) => x.status).sort(), ['none', 'none', 'none', 'ok'], '같은 CVP 가 답한 적이 있으면 404 는 위치 없음');
  calls.length = 0;
  r = await E.lookupEndpoints({ get: async (p) => { calls.push(p); return { ok: false, status: 501, reason: 'HTTP 501' }; } }, macsN(3), { concurrency: 1 });
  assert.equal(r.unsupported, true); assert.equal(calls.length, 1, '501 은 바로 미지원');
  // 반증 L-6: 연결 실패 · 401 · 403 이 이어지면 그만 묻는다(틀린 자격증명으로 MAC 마다 요청하지 않게)
  calls.length = 0;
  r = await E.lookupEndpoints({ get: async (p) => { calls.push(p); return { ok: false, status: 403, reason: 'HTTP 403' }; } }, macsN(200), { concurrency: 1 });
  assert.equal(calls.length, E.FAIL_STOP); assert.equal(r.stopped, 'auth');
  r = await E.lookupEndpoints({ get: async () => ({ ok: false, status: 0, reason: '연결 실패' }) }, macsN(20), { concurrency: 1 });
  assert.equal(r.stopped, 'conn');
  r = await E.lookupEndpoints({ get: async () => { await new Promise((x) => setTimeout(x, 30)); return { ok: true, status: 200, text: '{}' }; } }, ['005056aa0001', '005056aa0002', '005056aa0003', '005056aa0004'], { concurrency: 1, budgetMs: 40 });
  assert.ok(r.cut >= 1, '예산을 넘기면 다음 MAC 을 시작하지 않는다');
});

test('③ 대상 고르기 · 이동 기억', () => {
  const asked = new Map([['h2', NOW - 60_000], ['v3', NOW - 5 * H], ['v4', NOW - 9 * H]]);
  const pick = E.pickEndpointMacs({ hostMacs: ['h1', 'h2', 'h1'], movedVmMacs: ['v1'], vmMacs: ['v1', 'v3', 'v4', 'v5'], askedAt: asked }, { now: NOW, max: 4, staleMs: 30 * 60_000 });
  assert.deepEqual(pick, ['h1', 'v1', 'v5', 'v4'], '호스트 NIC → 이동 VM → 한 번도 안 물은 VM → 오래된 VM · 이번 창에 물은 h2 는 건너뜀');
  // 반증 M-1: 호스트 MAC 이 상한보다 많아도 매 주기 같은 앞부분만 묻지 않는다 — 오래전에 물은 것부터 · 호스트 몫은 절반까지
  const hosts = Array.from({ length: 300 }, (_, i) => `h${i}`); const vms = Array.from({ length: 400 }, (_, i) => `v${i}`);
  const seen = new Set(); const askedM = new Map(); let t = NOW;
  for (let cyc = 0; cyc < 48; cyc++) {
    t += 31 * 60_000;
    for (const m of E.pickEndpointMacs({ hostMacs: hosts, vmMacs: vms, askedAt: askedM }, { now: t, max: 200, staleMs: 30 * 60_000 })) { seen.add(m); askedM.set(m, t); }
  }
  assert.equal(hosts.filter((m) => seen.has(m)).length, 300, '하루 안에 호스트 MAC 전부');
  assert.equal(vms.filter((m) => seen.has(m)).length, 400, '하루 안에 VM MAC 전부');
  const first = E.pickEndpointMacs({ hostMacs: hosts, vmMacs: vms, askedAt: new Map() }, { now: NOW, max: 200 });
  assert.equal(first.filter((m) => m.startsWith('h')).length, 100, 'VM 이 있으면 호스트 몫은 절반');
  E._resetVmHosts();
  assert.deepEqual([...E.noteVmHosts([{ id: 'a', host: 'h1' }], { now: NOW })], [], '첫 관측은 이동이 아니다');
  assert.deepEqual([...E.noteVmHosts([{ id: 'a', host: 'h2' }], { now: NOW + 1 })], ['a']);
  assert.deepEqual([...E.noteVmHosts([{ id: 'a', host: 'h2' }], { now: NOW + 25 * H })], [], '24시간이 지나면 최근 이동이 아니다');
});

test('④ DB — 교체 · 오류 보존 · 담당 · 호스트명 · 변경분 · 현황', async () => {
  const db = await import('../src/cvp/db.js');
  if (!(await db.available())) return;
  await db.saveDevices({ cvpId: 'cvp-1', devices: [{ key: 'JPE1', serial: 'JPE1', ts: NOW, hostname: 'leaf1', ports: [] }] });
  const loc = (port, vlan = 100) => ({ device: 'JPE1', port, vlan, learnedAt: 't', macType: 'MAC_TYPE_LEARNED_DYNAMIC', likelihood: null });
  await db.saveEndpoints('', 'cvp-1', [{ mac: '005056aa0001', at: NOW - 3000, status: 'ok', locations: [loc('Ethernet5'), loc('Ethernet6')] }, { mac: 'BAD', at: NOW, status: 'ok' }]);
  let r = await db.endpointsByMacs(['00:50:56:AA:00:01']);
  assert.deepEqual(r.rows.map((x) => [x.port, x.hostname, x.vlan]), [['Ethernet5', 'leaf1', 100], ['Ethernet6', 'leaf1', 100]]);
  await db.saveEndpoints('', 'cvp-1', [{ mac: '005056aa0001', at: NOW - 2000, status: 'ok', locations: [loc('Ethernet9', -1)] }]);
  r = await db.endpointsByMacs(['005056aa0001']);
  assert.deepEqual(r.rows.map((x) => [x.port, x.vlan]), [['Ethernet9', null]], '새 결과가 옛 위치를 바꾼다(vMotion 뒤 옛 포트가 남지 않게) · VLAN 모름 null');
  await db.saveEndpoints('', 'cvp-1', [{ mac: '005056aa0001', at: NOW - 1000, status: 'error', reason: 'HTTP 500' }]);
  r = await db.endpointsByMacs(['005056aa0001']);
  assert.equal(r.rows.length, 1, '오류는 직전 위치를 지우지 않는다'); assert.equal(r.meta.get('005056aa0001')[0].status, 'error');
  await db.saveEndpoints('edge-x', 'cvp-2', [{ mac: '005056aa0001', at: NOW, status: 'ok', locations: [loc('Et1')] }]);
  r = await db.endpointsByMacs(['005056aa0001'], { owners: [{ agent: '', cvpId: 'cvp-1' }] });
  assert.deepEqual(r.rows.map((x) => x.cvpId), ['cvp-1'], '담당 행만');
  // 반증 L-5: 커서는 시각이 아니라 쓸 때마다 늘어나는 순번 — 같은 at 이 여럿이거나 늦게 커밋된 더 작은 at 도 빠지지 않는다
  const all = await db.endpointsSince('', 'cvp-1', 0, 10);
  assert.deepEqual(all.map((x) => [x.mac, x.status]), [['005056aa0001', 'error']], 'MAC 마다 최신 하나');
  const cur = all[0].seq;
  await db.saveEndpoints('', 'cvp-1', Array.from({ length: 5 }, (_, i) => ({ mac: `005056bb000${i}`, at: NOW - 9999, status: 'none' })));   // 더 작은 at 이 나중에 커밋
  const after = await db.endpointsSince('', 'cvp-1', cur, 3);
  assert.equal(after.length, 3); assert.ok(after.every((x) => x.seq > cur), '순번 뒤의 것');
  const rest = await db.endpointsSince('', 'cvp-1', after[2].seq, 10);
  assert.equal(rest.length, 2, '같은 at 이 상한 경계에 걸려도 남은 것을 다음 페이지에서 받는다');
  const st = await db.epStatus([{ agent: '', cvpId: 'cvp-1' }, { agent: 'edge-x', cvpId: 'cvp-2' }]);
  assert.equal(st.macs, 7); assert.equal(st.lastAt, NOW);
  const stCase = await db.epStatus([{ agent: 'EDGE-X', cvpId: 'cvp-2' }]);
  assert.equal(stCase.macs, 1, '담당 엣지 이름 대소문자를 가리지 않는다(반증 M-5)');
  r = await db.endpointsByMacs(['005056aa0001'], { owners: [{ agent: 'Edge-X', cvpId: 'cvp-2' }] });
  assert.deepEqual(r.rows.map((x) => x.cvpId), ['cvp-2']);
  assert.ok((await db.epMetaFor('', 'cvp-1')).get('005056aa0001') === NOW - 1000);
});

test('⑤ 요청 큐', async () => {
  const Q = await import('../src/cvp/epRequests.js');
  Q._resetEpRequests();
  Q.requestEndpointLookup('edge-a', 'cvp-9', ['005056aa0001', 'bad'], NOW);
  assert.equal(Q.requestEndpointLookup('edge-a', 'cvp-9', ['005056aa0002', '005056aa0001'], NOW).queued, 2, '같은 CVP 는 한 건으로 합친다');
  Q.requestEndpointLookup('edge-b', 'cvp-8', Array.from({ length: 100 }, (_, i) => `005056aa${String(i).padStart(4, '0')}`), NOW);
  assert.deepEqual(Q.takeEndpointRequests('edge-x', NOW), []);
  const a = Q.takeEndpointRequests('edge-a', NOW);
  assert.deepEqual(a, [{ cvpId: 'cvp-9', macs: ['005056aa0001', '005056aa0002'] }]);
  assert.equal(Q.pendingEndpointRequest('cvp-9'), false, '가져가면 큐에서 지운다');
  assert.equal(Q.takeEndpointRequests('edge-b', NOW)[0].macs.length, Q.EP_REQ_MACS_MAX);
  Q.requestEndpointLookup('edge-c', 'cvp-7', ['005056aa0001'], NOW);
  assert.deepEqual(Q.takeEndpointRequests('edge-c', NOW + Q.EP_REQ_TTL_MS + 1), [], 'TTL 이 지나면 버린다');
  assert.equal(Q.epRequestStats().expired, 1);
});

let central; let cport;
before(async () => {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use('/api/central', centralRouter);
  central = http.createServer(app);
  cport = await new Promise((r) => central.listen(0, '127.0.0.1', () => r(central.address().port)));
  closers.push(() => new Promise((r) => central.close(() => r())));
});
const hdr = { 'Content-Type': 'application/json', 'X-Central-Token': 'ctok-2929', 'X-Agent-Name': 'edge-a' };

test('⑥ 실제 중앙 라우트 — cvp-config epNow · cvp-data ep · ack', async () => {
  const reg = await import('../src/cvp/registry.js');
  const db = await import('../src/cvp/db.js');
  const Q = await import('../src/cvp/epRequests.js');
  const { cleanEp } = await import('../src/central/cvpEdge.js');
  const { epAckOf } = await import('../src/cvp/push.js');
  const s = reg.saveServer({ name: 'CVP-edge', host: 'https://cvp.example.invalid', authMode: 'token', token: 'T', agent: 'edge-a' });
  Q._resetEpRequests();
  Q.requestEndpointLookup('edge-a', s.id, ['005056aa0101']);
  const cfg = await (await fetch(`http://127.0.0.1:${cport}/api/central/cvp-config?agent=edge-a`, { headers: hdr })).json();
  assert.deepEqual(cfg.epNow, [{ cvpId: s.id, macs: ['005056aa0101'] }], 'epNow 로 내려간다(MAC 목록뿐)');
  assert.equal(JSON.stringify(cfg.epNow).includes('token'), false);
  if (!(await db.available())) return;
  const post = (body) => fetch(`http://127.0.0.1:${cport}/api/central/cvp-data`, { method: 'POST', headers: hdr, body: JSON.stringify({ agent: 'edge-a', chunk: 0, chunks: 1, servers: [], ...body }) }).then(async (r) => ({ status: r.status, j: await r.json() }));
  let a = await post({});
  assert.equal(a.status, 200); assert.equal(a.j.saved.ep, 0, 'ep 가 없어도 saved.ep 는 수(새 중앙임을 엣지가 안다)'); assert.equal(epAckOf(a.j), 'acked');
  a = await post({ ep: [
    { cvpId: s.id, mac: '005056AA0101', at: Date.now() + 86_400_000, status: 'ok', locations: [{ device: 'SNE', port: 'Ethernet3', vlan: 5000, learnedAt: 't' }, { device: '', port: 'x' }] },
    { cvpId: 'not-mine', mac: '005056aa0102', at: NOW, status: 'ok', locations: [] },
    { cvpId: s.id, mac: 'zz', at: NOW, status: 'ok' },
    { cvpId: s.id, mac: '005056aa0103', at: NOW, status: 'weird' }] });
  assert.equal(a.status, 200, JSON.stringify(a.j)); assert.equal(a.j.saved.ep, 1);
  const r = await db.endpointsByMacs(['005056aa0101'], { owners: [{ agent: 'edge-a', cvpId: s.id }] });
  assert.deepEqual(r.rows.map((x) => [x.agent, x.port, x.vlan]), [['edge-a', 'Ethernet3', null]], '저장 키는 인증된 agent · VLAN 범위 밖은 null');
  assert.ok(r.rows[0].at <= Date.now(), '엣지 시각은 수신 시각으로 자른다');
  assert.equal(cleanEp({ mac: '005056aa0101', at: NOW, status: 'ok', locations: 'x' }).locations.length, 0);
  assert.equal(cleanEp({ mac: '005056aa0101', at: 0, status: 'ok' }), null);
  assert.equal(epAckOf({ saved: { l2: 0 } }), 'old-central'); assert.equal(epAckOf(null), 'unknown');
});

test('⑦ 매칭 · 화면 라우트 — 근거 · disagree · 지금 조회 · 역할 · 범위 · VM 위치', async () => {
  const M = await import('../src/cvp/hostMatch.js');
  const host = { nics: [{ device: 'vmnic0', mac: '00:50:56:77:00:00' }, { device: 'vmnic1', mac: '00:50:56:77:00:01' }] };
  const rows = [{ agent: '', cvpId: 'c', key: 'K1', hostname: 'leaf1', port: 'Et1', mac: '005056770000', vlan: 10, at: NOW }, { agent: '', cvpId: 'c', key: 'K2', hostname: 'leaf2', port: 'Et9', mac: '005056770001', at: NOW }, { agent: '', cvpId: 'c', key: 'K1', hostname: 'leaf1', port: 'Et2', mac: 'ffffffffffff' }];
  const l2 = [{ agent: '', cvpId: 'c', key: 'K1', hostname: 'leaf1', port: 'Et1', nic: 'vmnic0', basis: 'lldp' }, { agent: '', cvpId: 'c', key: 'K1', hostname: 'leaf1', port: 'Et3', nic: 'vmnic1', basis: 'lldp' }];
  const m = M.matchEndpoint({ host, epRows: rows, l2Uplinks: l2 });
  assert.deepEqual(m.uplinks.map((u) => [u.port, u.nic, u.basis]), [['Et1', 'vmnic0', 'endpoint'], ['Et9', 'vmnic1', 'endpoint']], '이 호스트 NIC MAC 만');
  assert.deepEqual(m.disagree, [{ nic: 'vmnic1', lldp: { hostname: 'leaf1', port: 'Et3' }, endpoint: { hostname: 'leaf2', port: 'Et9' } }]);
  const merged = M.mergeUplinks([], [...l2, ...m.uplinks]);
  assert.equal(merged.find((u) => u.port === 'Et1').basis, 'lldp', '같은 포트면 LLDP 가 앞 · CVP 위치는 also');
  assert.ok(merged.find((u) => u.port === 'Et1').also.some((x) => x.basis === 'endpoint'));
  assert.ok(M.BASIS_RANK.lldp < M.BASIS_RANK.endpoint && M.BASIS_RANK.endpoint < M.BASIS_RANK.mac);

  const db = await import('../src/cvp/db.js');
  if (!(await db.available())) return;
  const reg = await import('../src/cvp/registry.js');
  const Q = await import('../src/cvp/epRequests.js');
  Q._resetEpRequests();
  const local = reg.saveServer({ name: 'CVP-L', host: 'https://127.0.0.1:9', authMode: 'token', token: 't', agent: '', datacenterId: 'corp-a' });
  const deleg = reg.saveServer({ name: 'CVP-D', host: 'https://10.98.0.2', authMode: 'token', token: 't', agent: 'edge-a', datacenterId: 'corp-a' });
  await db.saveDevices({ cvpId: local.id, devices: [{ key: 'LF1', ts: NOW, hostname: 'leafL', ports: [{ name: 'Ethernet1', oper: 'up', admin: 'up', speedBps: 25e9, inBps: 5e8 }, { name: 'Ethernet2', oper: 'up', admin: 'up' }] }] });
  await db.saveEndpoints('', local.id, [{ mac: 'b8599f000001', at: NOW - 1000, status: 'ok', locations: [{ device: 'LF1', port: 'Ethernet1', vlan: null }] },
    { mac: '005056990001', at: NOW - 1000, status: 'ok', locations: [{ device: 'LF1', port: 'Ethernet1', vlan: 100 }] },
    { mac: '005056990002', at: NOW - 1000, status: 'ok', locations: [{ device: 'LF1', port: 'Ethernet2', vlan: 100 }] },
    { mac: '005056990003', at: NOW - 1000, status: 'none', locations: [] }]);
  const { store } = await import('../src/store.js');
  const R = await import('../src/routes/api/hostSan.js');
  const express = (await import('express')).default;
  const prev = store.snapshot;
  store.snapshot = { source: 'live', generatedAt: new Date(NOW).toISOString(), vcenters: [{ id: 'vc-a', name: 'vc-a' }, { id: 'vc-b', name: 'vc-b' }],
    hosts: [{ id: 'vc-a:h1', name: 'esx1.corp.local', vcenterId: 'vc-a', nics: [{ device: 'vmnic0', mac: 'b8:59:9f:00:00:01' }] }, { id: 'vc-b:h9', name: 'esx9', vcenterId: 'vc-b', nics: [{ device: 'vmnic0', mac: 'b8:59:9f:00:00:09' }] }],
    vms: [{ id: 'vc-a:vm1', name: 'app1', vcenterId: 'vc-a', host: 'esx1.corp.local', dev: { nics: [{ label: 'Network adapter 1', mac: '00:50:56:99:00:01' }, { label: 'Network adapter 2', mac: '00:50:56:99:00:02' }, { label: 'Network adapter 3', mac: '00:50:56:99:00:03' }, { label: 'Network adapter 4', mac: '00:50:56:99:00:04' }] } }],
    datastores: [] };
  let user = { username: 'adm', role: 'admin' };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); R.registerHostSan(api); app.use('/api', api);
  const srv = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  closers.push(async () => { store.snapshot = prev; });
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const h1 = encodeURIComponent('vc-a:h1');
  let j = await (await fetch(`${base}/hosts/${h1}/net-uplinks`)).json();
  const u = j.uplinks.find((x) => x.port === 'Ethernet1');
  assert.equal(u.basis, 'endpoint'); assert.equal(u.basisLabel.label, '확정'); assert.equal(u.nic, 'vmnic0'); assert.equal(u.inBps, 5e8, '지금 값을 붙인다');
  assert.equal(j.ep.canLocate, true); assert.ok(j.ep.macs >= 1);
  // VM 위치 — 일치(호스트 NIC 위치와 같은 포트) · 불일치 · 위치 없음 · 아직 안 물음
  j = await (await fetch(`${base}/vms/${encodeURIComponent('vc-a:vm1')}/endpoint-locations`)).json();
  assert.equal(j.hostPortsKnown, true);
  assert.deepEqual(j.rows.map((x) => [x.label, x.verdict]), [['Network adapter 1', 'match'], ['Network adapter 2', 'mismatch'], ['Network adapter 3', 'none'], ['Network adapter 4', 'not-asked']]);
  // 지금 조회 — 위임 CVP 는 큐(네트워크를 타지 않는다) · 직접 CVP 는 이 테스트에서 닿지 않아 실패로 보고(던지지 않는다)
  let r = await fetch(`${base}/hosts/${h1}/endpoint-locate`, { method: 'POST' });
  assert.equal(r.status, 200); j = await r.json();
  assert.ok(j.queued.some((x) => x.cvpId === deleg.id && x.agent === 'edge-a' && x.macs === 1), JSON.stringify(j.queued));
  assert.ok(j.queued.every((x) => x.agent === 'edge-a'), '법인 미지정 위임 CVP(⑥) 도 같은 규칙으로 큐에');
  assert.equal(Q.pendingEndpointRequest(deleg.id), true);
  assert.equal(j.direct.length, 1); assert.equal(j.direct[0].cvpId, local.id);
  assert.ok(j.direct[0].ok === false || j.direct[0].errors === 1, `닿지 않는 CVP 는 던지지 않고 실패 · 오류로 보고: ${JSON.stringify(j.direct[0])}`);
  // 역할 · 범위 · 도구 키
  user = { username: 'v', role: 'viewer' };
  r = await fetch(`${base}/hosts/${h1}/endpoint-locate`, { method: 'POST' }); assert.equal(r.status, 403); assert.deepEqual((await r.json()).requiredRole, ['admin', 'operator']);
  j = await (await fetch(`${base}/hosts/${h1}/net-uplinks`)).json(); assert.equal(j.ep.canLocate, false);
  user = { username: 'o', role: 'operator', scope: { vcenters: ['vc-b'] } };
  assert.equal((await fetch(`${base}/hosts/${h1}/endpoint-locate`, { method: 'POST' })).status, 404, '범위 밖은 존재도 흘리지 않는다');
  assert.equal((await fetch(`${base}/vms/${encodeURIComponent('vc-a:vm1')}/endpoint-locate`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${base}/vms/${encodeURIComponent('vc-a:vm1')}/endpoint-locations`)).status, 404);
  // 엣지 실행 — 이 엣지 몫이 아닌 CVP 요청은 무시한다(등록부가 원천)
  const { runEndpointRequests } = await import('../src/agent/cvpConfigPull.js');
  assert.equal(await runEndpointRequests([{ cvpId: 'not-registered', macs: ['005056aa0001'] }]), 0);
});
