// v2.621 감사 그룹 C — 범위 제한 admin·비-admin 의 형제 경로 누락 회귀 고정.
//   SEC-01    원격 접속: 숨겨진 중계 프록시(범위 밖 vCenter 만 배정)에 health·test·deploy/test·deploy 가 접속했다
//   SEC-02    GPU 게스트 빠른 SSH 테스트(IP 만): 범위 계정·비정규 IPv4('000.0.0.0' → 루프백)·차단 대역
//   SEC-03    폴더 사용량 조회 4종: 엣지 목록(IP·호스트명·RMA 정책)·마운트 경로를 범위 admin 이 읽었다
//   RECENT-05 파트 장애 '지금 점검' 응답의 notify.results[].partKey(원문 주소)
//   RECENT-06 svcmon hostmap/parse 큰 본문은 범위 계정도 파싱한다(라우트가 canEdit 뿐)
//   RECENT-07 CVP status.missing·authStopped.reason 의 주소(리다이렉트 출처)
// 실제 api·adminRouter·remoteRouter 를 express 에 띄워 **상태코드·응답·소켓 접속 시도**로 본다(AUTH_ENABLED=true —
// 꺼져 있으면 requireRole 이 모두 admin 으로 통과한다). 장비 접속은 net.Socket.prototype.connect 를 가로채 기록만 하고
// 즉시 실패시킨다(실제 네트워크 0 — 테스트 서버로 가는 연결만 통과).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2621c-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
delete process.env.CENTRAL_URL;

// 중계 프록시 두 개 — US 는 범위 안(vc-us-east), EU 는 범위 밖(vc-eu-west)만 배정. 주소는 TEST-NET-1(192.0.2.0/24).
fs.writeFileSync(path.join(tmp, 'remote-access.json'), JSON.stringify({
  proxies: [
    { id: 'p-us', name: 'US-proxy', vcenterIds: ['vc-us-east'], deploy: { enabled: true, host: '192.0.2.10', port: 22, username: 'root', password: 'x' } },
    { id: 'p-eu', name: 'EU-proxy', vcenterIds: ['vc-eu-west'], deploy: { enabled: true, host: '192.0.2.20', port: 22, username: 'root', password: 'y' } },
  ],
  mappings: [],
}));

let srv, base, serverPort;
const attempts = [];
const origConnect = net.Socket.prototype.connect;
const USERS = {
  full: { username: 'full', role: 'admin', scope: null },
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-us-east'] } },
  op: { username: 'op', role: 'operator', scope: null },
  sop: { username: 'sop', role: 'operator', scope: { vcenters: ['vc-us-east'] } },
};

before(async () => {
  // 테스트 서버(127.0.0.1:serverPort)로 가는 연결만 통과시키고 나머지는 기록 후 즉시 실패시킨다.
  net.Socket.prototype.connect = function (...args) {
    const a0 = Array.isArray(args[0]) ? args[0][0] : args[0];
    let host; let port;
    if (a0 && typeof a0 === 'object') { host = a0.host; port = a0.port; } else { port = a0; host = typeof args[1] === 'string' ? args[1] : undefined; }
    if (serverPort && Number(port) === serverPort && (host == null || host === '127.0.0.1' || host === 'localhost' || host === '::1')) return origConnect.apply(this, args);
    attempts.push(`${host}:${port}`);
    process.nextTick(() => this.destroy(Object.assign(new Error(`connect ECONNREFUSED ${host}:${port} (test)`), { code: 'ECONNREFUSED' })));
    return this;
  };
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { adminRouter } = await import('../src/routes/admin.js');
  const { remoteRouter } = await import('../src/routes/remote.js');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api/admin', adminRouter);
  app.use('/api/remote', remoteRouter);
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  serverPort = srv.address().port;
  base = `http://127.0.0.1:${serverPort}/api`;
});
after(() => {
  net.Socket.prototype.connect = origConnect;
  try { srv?.close(); } catch { /* */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
});

async function call(u, method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, t, j };
}
const hits = (host) => attempts.filter((a) => a.startsWith(`${host}:`)).length;

test('SEC-01: 범위 admin 은 숨겨진 프록시(범위 밖 vCenter 만)에 health·test·deploy/test·deploy 로 접속하지 못한다', async () => {
  attempts.length = 0;
  const h = await call('sadm', 'POST', '/remote/proxies/p-eu/health');
  assert.equal(h.s, 404, `health ${h.s} ${h.t.slice(0, 200)}`);
  assert.doesNotMatch(h.t, /192\.0\.2\.20/, '숨긴 프록시의 SSH 주소가 응답에 새지 않는다');
  const dt = await call('sadm', 'POST', '/remote/deploy/test', { proxyId: 'p-eu' });
  assert.equal(dt.s, 404, `deploy/test ${dt.s} ${dt.t.slice(0, 200)}`);
  const tt = await call('sadm', 'POST', '/remote/test', { proxyId: 'p-eu' });
  assert.equal(tt.s, 404, `test ${tt.s} ${tt.t.slice(0, 200)}`);
  const d1 = await call('sadm', 'POST', '/remote/deploy', { proxyId: 'p-eu' });
  assert.equal(d1.s, 404, `deploy(p-eu) ${d1.s} ${d1.t.slice(0, 200)}`);
  // 전체 배포는 범위 안 프록시만 돌고, 건너뛴 개수를 밝힌다.
  const d = await call('sadm', 'POST', '/remote/deploy', {});
  assert.equal(d.s, 200);
  assert.deepEqual(d.j.results.map((r) => r.proxy), ['US-proxy'], JSON.stringify(d.j));
  assert.equal(d.j.omittedOutOfScope, 1);
  assert.equal(d.j.scoped, true);
  assert.equal(hits('192.0.2.20'), 0, `범위 밖 프록시에 SSH 접속을 시도했다: ${attempts.join(',')}`);
  assert.ok(hits('192.0.2.10') >= 1, '범위 안 프록시 배포는 그대로 시도한다');
  // 범위 안 프록시 health 는 그대로 돈다.
  const hu = await call('sadm', 'POST', '/remote/proxies/p-us/health');
  assert.equal(hu.s, 200);
  assert.equal(hu.j.method, 'ssh');
});

test('SEC-01: 전체 범위 admin 은 예전 그대로 모든 프록시에 배포·점검한다', async () => {
  attempts.length = 0;
  const h = await call('full', 'POST', '/remote/proxies/p-eu/health');
  assert.equal(h.s, 200);
  const d = await call('full', 'POST', '/remote/deploy', {});
  assert.equal(d.s, 200);
  assert.deepEqual(d.j.results.map((r) => r.proxy).sort(), ['EU-proxy', 'US-proxy']);
  assert.equal(d.j.omittedOutOfScope, undefined, '전체 범위 응답 모양은 예전 그대로');
  assert.ok(hits('192.0.2.20') >= 1 && hits('192.0.2.10') >= 1);
});

test('SEC-02: GPU 게스트 빠른 SSH 테스트 — 범위 계정 403 · 비정규 표기·차단 대역은 접속 전에 400', async () => {
  attempts.length = 0;
  const sc = await call('sadm', 'POST', '/admin/gpu-guest/test-ssh', { ip: '192.0.2.44', username: 'root', password: 'p' });
  assert.equal(sc.s, 403, `${sc.s} ${sc.t.slice(0, 200)}`);
  assert.equal(sc.j?.error, 'forbidden');
  for (const ip of ['000.0.0.0', '010.0.0.5', '0x7f.0.0.1', '10.1', 'gpu-host.corp']) {
    const r = await call('full', 'POST', '/admin/gpu-guest/test-ssh', { ip, username: 'root', password: 'p' });
    assert.equal(r.s, 400, `${ip} → ${r.s} ${r.t.slice(0, 200)}`);
    assert.match(r.j.error, /정규형 IPv4/);
  }
  for (const ip of ['0.0.0.0', '169.254.169.254']) {
    const r = await call('full', 'POST', '/admin/gpu-guest/test-ssh', { ip, username: 'root', password: 'p' });
    assert.equal(r.s, 400, `${ip} → ${r.s} ${r.t.slice(0, 200)}`);
    assert.match(r.j.error, /차단/);
  }
  assert.deepEqual(attempts, [], `거절한 입력으로 접속을 시도했다: ${attempts.join(',')}`);
  // 전체 범위 admin 의 정상 사설 IP 는 예전 그대로 SSH 를 시도한다(여기서는 가로채 즉시 실패).
  const ok = await call('full', 'POST', '/admin/gpu-guest/test-ssh', { ip: '192.0.2.44', username: 'root', password: 'p' });
  assert.equal(ok.s, 200, `${ok.s} ${ok.t.slice(0, 200)}`);
  assert.equal(ok.j.ip, '192.0.2.44');
  assert.ok(hits('192.0.2.44') >= 1, '정상 경로는 접속을 시도한다');
});

test('SEC-03: 폴더 사용량 조회 4종은 범위 admin 403(엣지 목록·마운트 경로를 싣는다) · 전체 범위는 그대로', async () => {
  for (const p of ['/admin/dir-usage', '/admin/dir-usage/history/t1', '/admin/dir-usage/scan/1', '/admin/dir-usage/preview/1']) {
    const sc = await call('sadm', 'GET', p);
    assert.equal(sc.s, 403, `${p} 범위 admin ${sc.s} ${sc.t.slice(0, 200)}`);
    assert.equal(sc.j?.error, 'forbidden');
    assert.equal(sc.j?.agents, undefined);
    const f = await call('full', 'GET', p);
    assert.notEqual(f.s, 403, `${p} 전체 범위 admin ${f.s} ${f.t.slice(0, 200)}`);
  }
  const f = await call('full', 'GET', '/admin/dir-usage');
  assert.equal(f.s, 200);
  assert.ok(Array.isArray(f.j.agents));
});

test('RECENT-05: 파트 장애 지금 점검 응답도 비-admin 에게 notify.results(원문 partKey)를 주지 않는다', async () => {
  const edge = await import('../src/central/partFaultEdge.js');
  const { PUSH_PROTOCOL } = await import('../src/partfault/types.js');
  edge._resetForTest(async () => ({ storage: new Set(), sanswitch: new Set() }));
  const report = (id) => ({ v: PUSH_PROTOCOL, at: 1_790_000_000_000, devices: [{
    scope: 'idrac', deviceId: id, deviceKey: id, deviceKeyKind: 'localId', deviceName: id, ok: true,
    open: [{ kind: 'psu', partId: 'PSU.Slot.1', keyKind: 'name', state: 'fault', rawState: 'Critical', label: 'PSU 1' }],
    states: { ok: [], unknown: [], absent: [] },
  }] });
  // 운영자(전체 범위) — 새 장애가 열려 알림이 나가는 주기
  const put1 = await edge.putEdgeReport('edge-a', report('10.77.1.5'));
  assert.equal(put1.ok, true, JSON.stringify(put1));
  const r = await call('op', 'POST', '/tools/part-faults/scan');
  assert.equal(r.s, 200, `${r.s} ${r.t.slice(0, 300)}`);
  assert.ok(r.j.stats && r.j.stats.opened >= 1, `전이가 일어나야 한다: ${r.t.slice(0, 300)}`);
  assert.ok(r.j.notify, `알림 기록이 있어야 한다: ${r.t.slice(0, 300)}`);
  assert.equal(r.j.notify.results, undefined, '결과 목록은 개수로만');
  assert.equal(r.j.notify.resultsHidden, true);
  assert.ok(r.j.notify.resultsCount >= 1);
  assert.doesNotMatch(r.t, /10\.77\.1\.5/, '원문 파트 키(주소)가 응답에 새지 않는다');
  // admin 은 원문 그대로(다른 장비로 새 전이를 만든다)
  await edge.putEdgeReport('edge-b', report('10.88.2.6'));
  const a = await call('full', 'POST', '/tools/part-faults/scan');
  assert.equal(a.s, 200, `${a.s} ${a.t.slice(0, 300)}`);
  assert.ok(Array.isArray(a.j.notify?.results) && a.j.notify.results.some((x) => /10\.88\.2\.6/.test(x.partKey)), a.t.slice(0, 300));
});

test('RECENT-06: svcmon hostmap/parse 큰 본문은 범위 계정도 파싱한다 — import 는 예전처럼 범위 계정 제외', async () => {
  const { sessionBigBodyAllowed } = await import('../src/util/bigJsonGate.js');
  const perms = { operator: new Set(['svcmon', 'tools']), viewer: new Set(['svcmon']) };
  const deps = { permsOf: (r) => perms[r] || new Set(), scoped: (u) => !!u.scoped };
  const HM = '/api/svcmon/targets/hostmap/parse/';   // 마운트 안: baseUrl + '/'
  const IM = '/api/svcmon/targets/import/';
  assert.equal(sessionBigBodyAllowed({ role: 'operator', scoped: true }, HM, deps), true, '범위 operator 의 hostmap/parse');
  assert.equal(sessionBigBodyAllowed({ role: 'admin', scoped: true }, HM, deps), true, '범위 admin 의 hostmap/parse');
  assert.equal(sessionBigBodyAllowed({ role: 'admin', scoped: true }, HM.slice(0, -1), deps), true, '끝 슬래시 없이도');
  assert.equal(sessionBigBodyAllowed({ role: 'viewer', scoped: true }, HM, deps), false, 'viewer 는 canEdit 에서 403');
  assert.equal(sessionBigBodyAllowed({ role: 'operator' }, HM, { ...deps, permsOf: () => new Set() }), false, 'svcmon 권한 없음');
  assert.equal(sessionBigBodyAllowed({ role: 'operator', scoped: true }, IM, deps), false, 'import 는 fullScopeOnly');
  assert.equal(sessionBigBodyAllowed({ role: 'operator' }, IM, deps), true);
  assert.equal(sessionBigBodyAllowed({ role: 'admin', scoped: true }, '/api/svcmon/targets/hostmap/parsex', deps), false, '비슷한 이름은 대상이 아니다');

  // 실제 게이트로 — 범위 operator 의 1.2MB 본문이 hostmap/parse 에서 파싱된다(예전에는 1MB 파서가 413).
  const express = (await import('express')).default;
  const { bigJsonGate } = await import('../src/util/bigJsonGate.js');
  const who = { username: 'sop', role: 'operator', scoped: true };
  const gate = bigJsonGate(express.json({ limit: '16mb' }), {
    session: () => who,
    sessionAllowed: (_req, u, full) => sessionBigBodyAllowed(u, full, deps),
  });
  const app = express();
  app.use('/api/svcmon/targets/hostmap/parse', gate);
  app.use('/api/svcmon/targets/import', gate);
  app.use(express.json({ limit: '1mb' }));
  app.post('/api/svcmon/targets/hostmap/parse', (req, res) => res.json({ ok: true, len: String(req.body?.b64 || '').length }));
  app.post('/api/svcmon/targets/import', (req, res) => res.json({ ok: true }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.type || 'error' })); // 413 스택을 콘솔에 찍지 않게
  const s2 = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const p2 = s2.address().port;
  serverPort = p2; // 가로채기 통과 대상
  try {
    const body = JSON.stringify({ b64: 'A'.repeat(1_200_000) });
    const r1 = await fetch(`http://127.0.0.1:${p2}/api/svcmon/targets/hostmap/parse`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(r1.status, 200);
    assert.equal((await r1.json()).len, 1_200_000);
    const r2 = await fetch(`http://127.0.0.1:${p2}/api/svcmon/targets/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(r2.status, 413, 'import 는 범위 계정이면 큰 파서를 타지 않는다(라우트가 403 — 여기서는 1MB 파서 413)');
  } finally {
    serverPort = srv.address().port;
    await new Promise((r) => s2.close(r));
  }
});

test('RECENT-07: CVP status.missing·authStopped.reason 의 주소도 비-admin 에게 가린다(목록·maskStatusText)', async () => {
  const cvpReg = await import('../src/cvp/registry.js');
  const cvpStore = await import('../src/cvp/store.js');
  const { maskStatusText } = await import('../src/routes/api/cvp.js');
  const saved = cvpReg.saveServer({ name: 'CVP-A', host: 'cvp1.corp.example', authMode: 'token', token: 'tok' });
  cvpStore.putStatus(saved.id, {
    ok: false, pending: false, collectedAt: null, lastAttemptAt: 1_790_000_000_000,
    error: '장비 인벤토리를 읽지 못했습니다 — /api/x: 리다이렉트로 응답했습니다(HTTP 302 → https://cvp1.corp.example)',
    missing: {
      inventory: '/api/resources/inventory/v1/Device/all: 리다이렉트로 응답했습니다(HTTP 302 → https://10.61.2.3:8443)',
      bgp: '2대 실패(리다이렉트로 응답했습니다(HTTP 302 → https://relay.other.example))',
      cvpVersion: '/cvpservice/cvpInfo/getCvpInfo.do: 버전 필드가 없습니다',
    },
    authStopped: { since: 1, at: 2, attempts: 3, reason: 'HTTP 401 https://10.61.2.9/login' },
    usedPaths: {}, seenFields: {},
  });
  const op = await call('op', 'GET', '/tools/cvp');
  assert.equal(op.s, 200, `${op.s} ${op.t.slice(0, 300)}`);
  const st = op.j.servers.find((x) => x.id === saved.id).status;
  assert.doesNotMatch(JSON.stringify(st), /10\.61\.2\.|relay\.other\.example|cvp1\.corp\.example/, JSON.stringify(st));
  assert.match(st.missing.cvpVersion, /버전 필드가 없습니다/, '주소가 없는 문구는 그대로');
  assert.equal(Object.keys(st.missing).length, 3, '칸을 지우지 않고 가린다');
  assert.equal(st.authStopped.attempts, 3);
  const ad = await call('full', 'GET', '/tools/cvp');
  const sa = ad.j.servers.find((x) => x.id === saved.id).status;
  assert.match(sa.missing.inventory, /10\.61\.2\.3/, 'admin 은 원문');
  // 순수 함수 — 모양이 다른 값에도 던지지 않는다
  assert.equal(maskStatusText(null), null);
  assert.deepEqual(maskStatusText({ error: null, missing: null }), { error: null, missing: null });
  const m = maskStatusText({ error: 'x', missing: { a: 'HTTP 302 → https://1.2.3.4' } }, []);
  assert.doesNotMatch(m.missing.a, /1\.2\.3\.4/);
  cvpStore.dropStatus(saved.id);
});
