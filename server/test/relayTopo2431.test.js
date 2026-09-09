/**
 * v2.431 — 중계 토폴로지(Main–Edge–IRS) 도구: 표 파싱·정규화(비밀 유지)·CSV 왕복·HAProxy 관리 블록 생성/병합/파싱/대조·
 * 입력 표 오류 점검·노드 접속 결정(IRS 는 중계 경유)·라우트(비밀 무반환·import/export)·경로 점검 대상 연동.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'relaytopo2431-'));
process.env.AUTH_ENABLED = 'false';
process.env.SSRF_ALLOW_LOOPBACK = 'true';

const SHEET = `Datacenter\tServer\tprivate IP\tpublic IP\tnote
OC2\tMain\t192.168.20.143\t10.94.40.217\t
AZ\tEdge\t192.168.30.221\t10.112.158.217\t
\tIRS\t192.168.31.11\t10.112.159.11\t
GM1\tEdge\t192.168.40.221\t10.113.158.217\t
\tIRS\t192.168.41.11\t10.113.159.11\t
NA\tEdge\t192.168.50.221\t10.114.158.217\t
LAB\tSandbox\t192.168.99.1\t10.99.0.1\t`;

test('store.parseTopologyTable: 스프레드시트 붙여넣기(DC 이월·Main/Edge/IRS·Sandbox 건너뜀)', async () => {
  const { parseTopologyTable } = await import('../src/relaytopo/store.js');
  const p = parseTopologyTable(SHEET);
  assert.equal(p.main.privateIp, '192.168.20.143'); assert.equal(p.main.publicIp, '10.94.40.217');
  assert.deepEqual(p.sites.map((s) => s.dc), ['AZ', 'GM1', 'NA']);
  assert.equal(p.sites[0].irs.privateIp, '192.168.31.11', 'DC 빈 셀은 직전 DC(AZ)로 이월');
  assert.equal(p.sites[2].irs.privateIp, '', 'NA 는 IRS 없음');
  assert.equal(p.skipped.length, 1, 'Sandbox 1행 건너뜀');
});

test('store.normalizeTopology/save: 비밀은 빈 값이면 유지·clear 로 삭제, 응답은 has* 플래그만, 파일 0600', async () => {
  const st = await import('../src/relaytopo/store.js');
  st._resetForTest();
  const saved = st.saveTopology({ main: { privateIp: '192.168.20.143', publicIp: '10.94.40.217' }, sites: [{ dc: 'AZ', edge: { privateIp: '192.168.30.221', publicIp: '10.112.158.217', ssh: { username: 'root', password: 'pw1' } }, irs: { privateIp: '192.168.31.11', ssh: { username: 'root', privateKey: '-----BEGIN KEY-----' } } }] });
  assert.equal(saved.sites[0].edge.ssh.hasPassword, true); assert.equal(saved.sites[0].edge.ssh.password, undefined, '응답에 비밀 없음');
  assert.equal(saved.sites[0].irs.ssh.hasPrivateKey, true);
  const again = st.saveTopology({ ...saved, sites: [{ ...saved.sites[0], edge: { ...saved.sites[0].edge, ssh: { username: 'root', password: '' } } }] });
  assert.equal(again.sites[0].edge.ssh.hasPassword, true, '빈 비밀은 기존 값 유지');
  assert.equal(st.loadTopologyRaw().sites[0].edge.ssh.password, 'pw1');
  const cleared = st.saveTopology({ ...again, sites: [{ ...again.sites[0], edge: { ...again.sites[0].edge, ssh: { username: 'root', clearPassword: true } } }] });
  assert.equal(cleared.sites[0].edge.ssh.hasPassword, false);
  const mode = fs.statSync(path.join(process.env.CONFIG_DIR, 'relay-topology.json')).mode & 0o777;
  assert.equal(mode, 0o600);
  st._resetForTest();
  assert.equal(st.loadTopologyRaw().sites[0].irs.ssh.privateKey, '-----BEGIN KEY-----', '재로드 후 키 유지');
});

test('store.topologyToCsv ↔ parseTopologyTable 왕복 + mergeImport(같은 DC 비밀 유지·replace)', async () => {
  const st = await import('../src/relaytopo/store.js');
  const t = st.normalizeTopology({ main: { name: 'OC2', privateIp: '192.168.20.143', publicIp: '10.94.40.217', ssh: { username: 'root' } }, sites: [{ dc: 'AZ', edge: { privateIp: '192.168.30.221', publicIp: '10.112.158.217', vcenterIp: '192.168.30.10', ssh: { username: 'ops', port: 2222 } }, irs: { privateIp: '192.168.31.11', vcenterIp: '192.168.31.10' }, note: 'a, "b"' }] });
  const csv = st.topologyToCsv(t);
  assert.match(csv, /^﻿dc,role,privateIp/);
  const p = st.parseTopologyTable(csv);
  assert.equal(p.main.privateIp, '192.168.20.143'); assert.equal(p.main.name, 'OC2');
  assert.equal(p.sites.length, 1); assert.equal(p.sites[0].edge.vcenterIp, '192.168.30.10'); assert.equal(p.sites[0].edge.ssh.username, 'ops'); assert.equal(String(p.sites[0].edge.ssh.port), '2222'); assert.equal(p.sites[0].note, 'a, "b"');
  const cur = st.normalizeTopology({ sites: [{ dc: 'AZ', edge: { privateIp: '1.1.1.1', ssh: { username: 'root', password: 'keep' } }, irs: {} }, { dc: 'OLD', edge: { privateIp: '2.2.2.2' }, irs: {} }] });
  const merged = st.normalizeTopology(st.mergeImport(cur, p));
  assert.equal(merged.sites.find((s) => s.dc === 'AZ').edge.privateIp, '192.168.30.221');
  // v2.435(감사 S1): 가져오기로 **host 가 바뀌면** 저장된 비밀을 잇지 않는다. 예전에는 이월했고,
  // 그 경로로 운영 서버 비밀번호를 임의 호스트에 보낼 수 있었다(불변조건 v2.257 M3 회귀).
  assert.equal(merged.sites.find((s) => s.dc === 'AZ').edge.ssh.password, '', 'IP 가 바뀌면 저장된 비밀을 버린다');
  // 같은 IP 로 다시 가져오면 기존 비밀은 유지된다(왕복 편집 편의).
  const same = st.normalizeTopology(st.mergeImport(cur, { sites: [{ dc: 'AZ', edge: { privateIp: '1.1.1.1', vcenterIp: '1.1.1.9' }, irs: {} }] }));
  assert.equal(same.sites.find((s) => s.dc === 'AZ').edge.ssh.password, 'keep', 'IP 가 같으면 유지');
  assert.ok(merged.sites.find((s) => s.dc === 'OLD'), '병합 모드는 기존 DC 유지');
  const replaced = st.normalizeTopology(st.mergeImport(cur, p, { replace: true }));
  assert.equal(replaced.sites.length, 1);
});

const SITE = { dc: 'AZ', edge: { privateIp: '192.168.30.221', publicIp: '10.112.158.217', vcenterIp: '192.168.30.10' }, irs: { privateIp: '192.168.31.11', publicIp: '', vcenterIp: '192.168.31.10' } };
const MAIN = { privateIp: '192.168.20.143', publicIp: '10.94.40.217', portalPort: 4000 };

test('haproxy.renderManagedBlock/mergeManagedBlock: 서비스별 listen 블록, 백엔드 누락은 주석, 병합은 멱등', async () => {
  const h = await import('../src/relaytopo/haproxy.js');
  const { DEFAULT_SERVICES } = await import('../src/relaytopo/store.js');
  const { text, missing } = h.renderManagedBlock(SITE, DEFAULT_SERVICES, MAIN);
  assert.equal(missing.length, 0);
  assert.match(text, /listen relay_portal_4068\n {4}bind \*:4068\n {4}mode tcp\n/);
  assert.match(text, /server portal 192\.168\.31\.11:4000 check/);
  assert.match(text, /server hq 10\.94\.40\.217:4000 check/);
  assert.match(text, /server edge-vcsa 192\.168\.30\.10:443 check/);
  const noIrs = h.renderManagedBlock({ ...SITE, irs: { privateIp: '', vcenterIp: '' } }, DEFAULT_SERVICES, MAIN);
  assert.deepEqual(noIrs.missing.map((m) => m.key), ['portal', 'ssh', 'vcsa']);
  assert.match(noIrs.text, /# \(건너뜀\) portal :4068/);
  const base = 'global\n    log /dev/log local0\ndefaults\n    mode tcp\n    timeout connect 5s\n    timeout client 1m\n    timeout server 1m\n';
  const m1 = h.mergeManagedBlock(base, text);
  assert.ok(m1.startsWith(base.trimEnd()), '기존 내용 보존');
  const m2 = h.mergeManagedBlock(m1, text);
  assert.equal(m2, m1, '두 번 병합해도 같음(블록 교체)');
  const m3 = h.mergeManagedBlock(m1, h.renderManagedBlock(SITE, DEFAULT_SERVICES.slice(0, 1), MAIN).text);
  assert.equal((m3.match(/listen relay_/g) || []).length, 1, '블록 교체로 이전 listen 제거');
});

test('haproxy.parseConfig/diffConfig: ok·self-loop·wrong-backend·missing·timeout·no-listener·서비스 다운', async () => {
  const h = await import('../src/relaytopo/haproxy.js');
  const { DEFAULT_SERVICES } = await import('../src/relaytopo/store.js');
  const cfg = `global
defaults
    timeout connect 5s
frontend fe_vc
    bind *:4066
    mode tcp
    default_backend be_vc
backend be_vc
    mode tcp
    timeout server 10m
    timeout client 10m
    server vc 192.168.31.10:443 check
listen irs_portal
    bind 0.0.0.0:4068  # 주석
    mode tcp
    timeout client 10m
    timeout server 10m
    server p 192.168.30.221:4000 check
listen irs_ssh
    bind *:4067
    timeout client 30s
    timeout server 30s
    server s 192.168.31.99:22 check
listen hq
    bind *:4001
    timeout client 10m
    timeout server 10m
    server hq 10.94.40.217:4000 check
`;
  const blocks = h.parseConfig(cfg);
  assert.deepEqual(blocks.map((b) => b.binds[0]).sort(), [4001, 4066, 4067, 4068]);
  assert.equal(blocks.find((b) => b.binds[0] === 4066).servers[0].host, '192.168.31.10', 'frontend→default_backend 연결');
  const rows = h.diffConfig(DEFAULT_SERVICES, SITE, MAIN, blocks, { listeners: [4066, 4067, 4068], active: true });
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(by.vcsa.status, 'ok');
  assert.equal(by.portal.status, 'self-loop'); assert.match(by.portal.fix, /192\.168\.31\.11:4000/);
  assert.equal(by.ssh.status, 'wrong-backend'); assert.match(by.ssh.issue, /192\.168\.31\.99:22/);
  assert.equal(by['edge-vcsa'].status, 'missing');
  assert.equal(by.hq.status, 'no-listener', 'cfg 에는 있으나 리스너 없음');
  const rows2 = h.diffConfig(DEFAULT_SERVICES.filter((s) => s.key === 'ssh'), { ...SITE, irs: { ...SITE.irs, privateIp: '192.168.31.99' } }, MAIN, blocks, { listeners: [4067], active: true });
  assert.equal(rows2[0].status, 'timeout', '백엔드는 맞지만 timeout 30s');
  const down = h.diffConfig(DEFAULT_SERVICES, SITE, MAIN, blocks, { listeners: [], active: false });
  assert.equal(down[0].key, '_service'); assert.match(down[0].fix, /enable --now haproxy/);
});

test('validate.validateTopology: 중복 IP·Edge=IRS·누락·포탈 포트 충돌·수집 서버 대조 / kindForService', async () => {
  const { validateTopology, kindForService } = await import('../src/relaytopo/validate.js');
  const { normalizeTopology, DEFAULT_SERVICES } = await import('../src/relaytopo/store.js');
  const topo = normalizeTopology({ main: MAIN, sites: [
    { dc: 'AZ', edge: { privateIp: '192.168.30.221', publicIp: '10.112.158.217', vcenterIp: '192.168.30.10' }, irs: { privateIp: '192.168.30.221', vcenterIp: '' } },
    { dc: 'GM1', edge: { privateIp: '192.168.40.221', publicIp: '10.112.158.217' }, irs: { privateIp: '192.168.41.11', vcenterIp: '192.168.41.10' } },
    { dc: 'NA', edge: { privateIp: '', publicIp: '' }, irs: {} },
  ] });
  const cols = [
    { id: 'AZ', url: 'http://10.112.158.217:4000', datacenter: 'GM1', enabled: true },
    { id: 'GM1-IRS', url: 'http://192.168.41.11:4000', datacenter: 'GM1', enabled: true },
  ];
  const issues = validateTopology(topo, cols);
  const codes = issues.map((i) => i.code);
  assert.ok(codes.includes('edge-eq-irs')); assert.ok(codes.includes('dup-ip'), 'public IP 두 사이트 중복');
  assert.ok(codes.includes('edge-missing')); assert.ok(codes.includes('irs-vc-missing'));
  assert.ok(codes.includes('collector-dc-mismatch'), 'AZ Edge 포탈 수집 서버의 법인이 GM1');
  assert.ok(codes.includes('collector-irs-missing')); assert.ok(codes.includes('collector-irs-direct'), 'IRS 직접 URL 경고');
  const bad = validateTopology(normalizeTopology({ main: MAIN, services: [{ key: 'x', listenPort: 4000, target: 'irs', targetPort: 4000 }] }), []);
  assert.ok(bad.some((i) => i.code === 'listen-portal-conflict' && i.level === 'error'));
  assert.deepEqual(DEFAULT_SERVICES.map((s) => kindForService(s, MAIN)), ['irs-portal', 'irs-ssh', 'irs-vcenter', 'edge-vcenter', 'hq-portal']);
  assert.equal(kindForService({ target: 'irs', targetPort: 8443 }, MAIN), null);
});

test('ops.resolveNodeAccess: 토폴로지 자격증명 우선, IRS 는 중계 엣지 SSH 포트 경유, 없으면 오류', async () => {
  const { resolveNodeAccess } = await import('../src/relaytopo/ops.js');
  const { normalizeTopology } = await import('../src/relaytopo/store.js');
  const topo = normalizeTopology({ main: MAIN, sites: [{ ...SITE, edge: { ...SITE.edge, ssh: { username: 'root', password: 'p' } }, irs: { ...SITE.irs, ssh: { username: 'irs', privateKey: 'k', port: 22 } } }] });
  const e = resolveNodeAccess(topo, topo.sites[0], 'edge');
  assert.equal(e.host, '10.112.158.217', 'Edge 는 public 우선'); assert.equal(e.port, 22); assert.equal(e.source, 'topology'); assert.equal(e.creds.password, 'p');
  const i = resolveNodeAccess(topo, topo.sites[0], 'irs');
  assert.equal(i.host, '10.112.158.217'); assert.equal(i.port, 4067, 'IRS SSH 는 중계 :4067 경유'); assert.match(i.via, /경유/); assert.equal(i.creds.username, 'irs');
  const none = resolveNodeAccess(normalizeTopology({ main: MAIN, sites: [SITE] }), SITE, 'edge');
  assert.match(none.error, /자격증명이 없습니다/);
  assert.match(resolveNodeAccess(topo, { dc: 'X', edge: { privateIp: '169.254.1.1', ssh: { username: 'a', password: 'b' } }, irs: {} }, 'edge').error, /링크로컬/);
});

test('routes: GET(비밀 무반환·issues·access) / PUT / import 미리보기·적용 / export json·csv / render / apply 확인 필요', async () => {
  const express = (await import('express')).default;
  const { registerRelayTopo } = await import('../src/routes/api/relaytopo.js');
  const st = await import('../src/relaytopo/store.js'); st._resetForTest();
  const app = express(); app.use(express.json({ limit: '2mb' }));
  // 실제 앱은 /api 앞에 authMiddleware 가 있어 req.user 가 항상 채워진다(auth.js:909).
  // v2.435 부터 조회 응답이 req.user.role 로 축약되므로(거부 기본값) 테스트도 같은 전제를 만든다.
  app.use((req, _res, next) => { req.user = { username: 'admin', role: 'admin' }; next(); });
  const api = express.Router(); registerRelayTopo(api); app.use('/api', api);
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r)); const base = `http://127.0.0.1:${srv.address().port}/api`;
  try {
    let r = await (await fetch(`${base}/tools/relaytopo`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ main: MAIN, sites: [{ ...SITE, edge: { ...SITE.edge, ssh: { username: 'root', password: 'secret-pw' } } }] }) })).json();
    assert.equal(r.ok, true); assert.equal(JSON.stringify(r).includes('secret-pw'), false, 'PUT 응답에 비밀 없음'); assert.equal(r.topology.sites[0].edge.ssh.hasPassword, true);
    r = await (await fetch(`${base}/tools/relaytopo`)).json();
    assert.equal(JSON.stringify(r).includes('secret-pw'), false, 'GET 응답에 비밀 없음');
    assert.equal(r.access.AZ.irs.port, 4067); assert.equal(r.access.AZ.edge.source, 'topology'); assert.ok(Array.isArray(r.issues));
    r = await (await fetch(`${base}/tools/relaytopo/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: SHEET }) })).json();
    assert.equal(r.ok, true); assert.equal(r.parsedSites, 3); assert.equal(r.preview.sites.length, 3, '미리보기(AZ 병합 + GM1·NA 추가)');
    assert.equal(st.loadTopologyRaw().sites.length, 1, '미리보기는 저장 안 함');
    r = await (await fetch(`${base}/tools/relaytopo/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: SHEET, apply: true }) })).json();
    assert.equal(r.topology.sites.length, 3); assert.equal(st.loadTopologyRaw().sites[0].edge.ssh.password, 'secret-pw', '가져오기 뒤에도 AZ 비밀 유지');
    const jr = await fetch(`${base}/tools/relaytopo/export?format=json`); const jt = await jr.text();
    assert.match(jr.headers.get('content-disposition'), /relay-topology-.*\.json/); assert.equal(jt.includes('secret-pw'), false); assert.equal(JSON.parse(jt).sites.length, 3);
    const cr = await fetch(`${base}/tools/relaytopo/export?format=csv`); const ct = await cr.text();
    assert.match(cr.headers.get('content-type'), /text\/csv/); assert.match(ct, /AZ,Edge,192\.168\.30\.221/); assert.equal(ct.includes('secret-pw'), false);
    r = await (await fetch(`${base}/tools/relaytopo/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: jt, replace: true }) })).json();
    assert.equal(r.format, 'json'); assert.equal(r.preview.sites.length, 3);
    r = await (await fetch(`${base}/tools/relaytopo/render/AZ`)).json();
    assert.match(r.text, /server portal 192\.168\.31\.11:4000 check/);
    r = await fetch(`${base}/tools/relaytopo/apply/AZ`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    assert.equal(r.status, 400); assert.match((await r.json()).reason, /confirm=true/);
    r = await (await fetch(`${base}/tools/relaytopo/test-ssh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dc: 'GM1', role: 'edge' }) })).json();
    assert.equal(r.ok, false); assert.match(r.reason, /자격증명이 없습니다/);
  } finally { srv.close(); }
});

test('relaycheck.buildTargets: 토폴로지 사이트의 Edge 주소가 대상에 추가되고 포트는 서비스 표 기준', async () => {
  const { buildTargets } = await import('../src/relaycheck/poller.js');
  const { normalizeSettings } = await import('../src/relaycheck/settings.js');
  const { normalizeTopology } = await import('../src/relaytopo/store.js');
  const topo = normalizeTopology({ main: MAIN, services: [{ key: 'portal', listenPort: 4068, target: 'irs', targetPort: 4000 }, { key: 'hq', listenPort: 4001, target: 'main', targetPort: 4000 }], sites: [SITE] });
  const t = buildTargets(normalizeSettings({}), [], topo);
  assert.deepEqual(t.map((x) => `${x.host}:${x.port}:${x.kind}`).sort(), ['10.112.158.217:4000:edge-portal', '10.112.158.217:4001:hq-portal', '10.112.158.217:4068:irs-portal']);
  assert.equal(t[0].site, 'AZ');
  assert.equal(buildTargets(normalizeSettings({ topologyHosts: false }), [], topo).length, 0);
  const cols = [{ id: 'AZ', url: 'http://10.112.158.217:4000', token: 'x', enabled: true }];
  assert.equal(buildTargets(normalizeSettings({}), cols, topo).length, 6, '수집 서버에 이미 있는 호스트는 기본 프로파일(6) 유지');
});
