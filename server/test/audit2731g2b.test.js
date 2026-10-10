/**
 * v2.731 점검 1회차 — 그룹 G2b(중앙↔엣지 전송 계약).
 *
 *  A4-01 — `WAN_TLS_CA_FILE`(사설 CA, 기본 신뢰 목록에 덧붙임)이 `resilientFetch` 의 디스패처에만 들어가,
 *          중앙↔엣지 구간에서 **자체 Agent 를 만드는 두 경로**가 사설 CA 인증서를 거부했다.
 *          ① 통신 점검 `stepHttp`(수집 토큰·중앙 토큰을 실으면 WAN 검증을 따른다) → 정상 엣지가 'tls-fail'
 *          ② 업그레이드 엣지 push(`pushBundleToEdge` — upgradeAgent) → 'fetch failed'(원인 없이)
 *          고친 뒤: 같은 CA 로 둘 다 검증 통과 · 다른 CA 는 여전히 거부(검증을 끄는 것이 아니다) · 실패 사유에 원인이 붙는다.
 *  A4-02 — `TLS_PORT ≠ PORT` 로 HTTPS 만 열면 실제 포탈 포트가 바뀌는데 호스트 접근 허용목록·svcmon 엣지 진단 보고가
 *          `config.port` 를 썼다(허용목록이 실제 포트를 덮지 못해 모든 출처에 열린 채 남는다 · svcmon 이 듣지 않는 포트로 TCP 진단).
 *          고친 뒤: 듣는 포탈 포트 전부(HTTPS · TLS_HTTP_ALSO 면 HTTP 도)가 관리 대상·자기 잠금 검사에 들어가고,
 *          svcmon 은 실제 광고 포트를 보고한다.
 *
 * 인증서는 openssl 로 임시 디렉터리에 만든다(rvJ_s09Transport 와 같은 방식). 없으면 TLS 를 쓰는 항목은 건너뛴다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2731g2b-'));
const CFG = path.join(DIR, 'cfg'); fs.mkdirSync(CFG);
process.env.CONFIG_DIR = CFG;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.PORT = '4000';
delete process.env.WAN_TLS_INSECURE;
delete process.env.UPGRADE_TLS_INSECURE;
delete process.env.TLS_CERT_FILE; delete process.env.TLS_KEY_FILE; delete process.env.TLS_PORT; delete process.env.TLS_HTTP_ALSO;

function ssl(args) { execFileSync('openssl', args, { cwd: DIR, stdio: 'pipe' }); }
function makeCa(name) {
  ssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2',
    '-subj', `/CN=g2b ${name}`, '-keyout', `${name}.key`, '-out', `${name}.pem`,
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
}
function makeLeaf(name, ca) {
  fs.writeFileSync(path.join(DIR, `${name}.ext`), 'subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n');
  ssl(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-subj', '/CN=localhost',
    '-keyout', `${name}.key`, '-out', `${name}.csr`]);
  ssl(['x509', '-req', '-in', `${name}.csr`, '-CA', `${ca}.pem`, '-CAkey', `${ca}.key`, '-CAcreateserial', '-days', '2',
    '-out', `${name}.pem`, '-extfile', `${name}.ext`]);
  fs.chmodSync(path.join(DIR, `${name}.key`), 0o600);
}
let PKI = null;
try {
  makeCa('ca1'); makeCa('ca2');
  makeLeaf('srv1', 'ca1'); makeLeaf('srv2', 'ca2');
  const f = (n) => path.join(DIR, n);
  PKI = { ca1: f('ca1.pem'), srv1: { cert: f('srv1.pem'), key: f('srv1.key') }, srv2: { cert: f('srv2.pem'), key: f('srv2.key') } };
  process.env.WAN_TLS_CA_FILE = PKI.ca1; // ⚠ resilientFetch·upgradeAgent 를 import 하기 전에 — 모듈 로드 때 읽는다
} catch { PKI = null; }
const NO_PKI = !PKI && 'openssl 없음';

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const closeSrv = (srv) => new Promise((r) => srv.close(() => r()));
/** 사설 CA 로 발급된 https '엣지'(본문을 다 읽고 JSON 으로 답한다). */
async function edgeServer(leaf) {
  const hits = [];
  const srv = https.createServer({ cert: fs.readFileSync(leaf.cert), key: fs.readFileSync(leaf.key) }, (req, res) => {
    let n = 0; req.on('data', (c) => { n += c.length; });
    req.on('end', () => {
      hits.push({ url: req.url, bytes: n, token: req.headers['x-collector-token'] || req.headers.authorization || '' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, agent: 'edge-g2b', version: '2.731.0' }));
    });
  });
  const port = await listen(srv);
  return { srv, port, base: `https://127.0.0.1:${port}`, hits };
}
const quiet = async (fn) => {
  const o = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, o); }
};

after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

/* ── A4-01 ───────────────────────────────────────────────────────────────────────── */
test('A4-01 ① resilientFetch 가 사설 CA 연결 옵션을 한 곳에서 내준다(미리 만든 신뢰 컨텍스트 하나, 검증 정책은 호출자)', { skip: NO_PKI }, async () => {
  const rf = await import('../src/util/resilientFetch.js');
  assert.equal(typeof rf.wanTlsConnectOptions, 'function', 'wanTlsConnectOptions 를 export 해야 한다(사본 금지)');
  const o = rf.wanTlsConnectOptions();
  assert.equal(o.rejectUnauthorized, true, '기본은 WAN_TLS_VERIFY(검증 ON)');
  // ⚠ ca 배열을 연결 옵션으로 넘기면 tls.connect 가 연결마다 기본 목록 + 사설 CA 를 다시 파싱한다(실측 약 23ms 동기 / 미리 만든 컨텍스트 0.3ms).
  assert.ok(o.secureContext, '사설 CA 가 있으면 미리 만든 secureContext 를 싣는다');
  assert.equal('ca' in o, false, 'ca 배열을 연결마다 넘기지 않는다');
  assert.equal(rf.wanTlsConnectOptions().secureContext, o.secureContext, '컨텍스트는 프로세스에 하나다(호출마다 새로 만들지 않는다)');
  const o2 = rf.wanTlsConnectOptions({ verify: false });
  assert.equal(o2.rejectUnauthorized, false, '검증 정책은 호출자가 정할 수 있다(upgradeAgent 의 UPGRADE_TLS_INSECURE)');
  assert.equal(rf.wanTlsStatus().caCount, 1);
});

test('A4-01 ② 통신 점검 stepHttp(토큰 실음): 사설 CA 엣지 = 통과 · 다른 CA = 여전히 tls-fail · 토큰 없는 점검은 예전대로', { skip: NO_PKI }, async () => {
  const { stepHttp } = await import('../src/linkcheck/checks.js');
  const e1 = await edgeServer(PKI.srv1);
  const e2 = await edgeServer(PKI.srv2);
  try {
    const ok = await quiet(() => stepHttp({ url: `${e1.base}/api/collector/ping`, ip: '127.0.0.1', headers: { 'X-Collector-Token': 'tok-g2b' }, timeoutMs: 5000 }));
    assert.equal(ok.http?.ok, true, `사설 CA(WAN_TLS_CA_FILE)로 발급된 엣지를 거부했다: ${JSON.stringify(ok.http)}`);
    assert.equal(ok.http.status, 200);
    assert.equal(ok.auth?.ok, true);
    assert.equal(e1.hits.length, 1, '토큰이 실제로 그 엣지에 도착했다');

    const bad = await quiet(() => stepHttp({ url: `${e2.base}/api/collector/ping`, ip: '127.0.0.1', headers: { 'X-Collector-Token': 'tok-g2b' }, timeoutMs: 5000 }));
    assert.equal(bad.http?.ok, false, '신뢰하지 않은 CA 의 인증서는 거부해야 한다(검증을 끄는 수정이 아니다)');
    assert.equal(bad.http.failKind, 'tls-fail');
    assert.equal(e2.hits.length, 0, '거부된 TLS 로 토큰이 나가지 않았다');

    // 비밀이 없는 정체 확인은 자체서명이 흔해 예전처럼 검증하지 않는다(보낼 비밀이 없다) — 바뀌지 않았는지.
    const noSecret = await quiet(() => stepHttp({ url: `${e2.base}/api/collector/ping`, ip: '127.0.0.1', headers: {}, timeoutMs: 5000 }));
    assert.equal(noSecret.http?.ok, true, JSON.stringify(noSecret.http));
  } finally { await closeSrv(e1.srv); await closeSrv(e2.srv); }
});

test('A4-01 ③ 업그레이드 엣지 push(pushBundleToEdge): 사설 CA 엣지 = 성공 · 다른 CA = 실패하되 원인이 사유에 남는다', { skip: NO_PKI }, async () => {
  const { pushBundleToEdge } = await import('../src/upgrade/upgrade.js');
  const bundle = path.join(DIR, 'vmware-portal-2.731.0.tar.gz');
  fs.writeFileSync(bundle, Buffer.from('not-a-real-bundle'));
  const e1 = await edgeServer(PKI.srv1);
  const e2 = await edgeServer(PKI.srv2);
  try {
    const r = await quiet(() => pushBundleToEdge({ url: e1.base, token: 'edge-tok' }, bundle, { manifestText: null, timeout: 5000 }));
    assert.equal(r.ok, true, `사설 CA 엣지로의 번들 push 가 실패했다: ${JSON.stringify(r)}`);
    assert.equal(e1.hits.length, 1);
    assert.equal(e1.hits[0].bytes, fs.statSync(bundle).size, '번들 본문이 도착했다');

    const b = await quiet(() => pushBundleToEdge({ url: e2.base, token: 'edge-tok' }, bundle, { manifestText: null, timeout: 5000 }));
    assert.equal(b.ok, false, '신뢰하지 않은 CA 는 거부');
    assert.equal(e2.hits.length, 0, '거부된 TLS 로 토큰·번들이 나가지 않았다');
    assert.match(String(b.reason), /certificate|verify|self[- ]signed|UNABLE_TO/i,
      `실패 사유에 원인(err.cause)이 붙어야 한다 — 'fetch failed' 만으로는 원인을 알 수 없다: ${b.reason}`);
  } finally { await closeSrv(e1.srv); await closeSrv(e2.srv); }
});

test('A4-01 ④ upgradeAgent(엣지가 중앙 /dl 을 받을 때도 같은 디스패처)가 사설 CA 를 믿는다', { skip: NO_PKI }, async () => {
  const { upgradeAgent } = await import('../src/upgrade/upgradeAgent.js');
  const e1 = await edgeServer(PKI.srv1);
  try {
    const r = await fetch(`${e1.base}/dl/versions.json`, { dispatcher: upgradeAgent });
    assert.equal(r.status, 200);
    await r.text();
  } finally { await closeSrv(e1.srv); }
});

/* ── A4-02 ───────────────────────────────────────────────────────────────────────── */
const LIST_ALL = (ports) => `public (active)
  target: default
  icmp-block-inversion: no
  interfaces: ens192
  sources:
  services: cockpit dhcpv6-client ssh
  ports: ${ports}
  protocols:
  forward: yes
  masquerade: no
  rich rules:
`;
function fakeExec(listAll) {
  const calls = [];
  const fw = async (args) => {
    calls.push(args.join(' '));
    if (args[0] === '--state') return { ok: true, code: 0, stdout: 'running\n', stderr: '' };
    if (args[0] === '--get-default-zone') return { ok: true, code: 0, stdout: 'public\n', stderr: '' };
    if (args.includes('--list-all')) return { ok: true, code: 0, stdout: listAll, stderr: '' };
    return { ok: true, code: 0, stdout: 'success', stderr: '' };
  };
  return { calls, fw, sshdCtl: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }), sshdActive: async () => true, isSudoDenied: () => false };
}
/** 리스너 상태를 실제 createPortalServers 로 만든다(listen 은 하지 않는다). */
async function withListener(env, fn) {
  const hs = await import('../src/util/httpsServer.js');
  hs._resetHttpsServerState();
  const app = (req, res) => res.end('');
  const portal = await quiet(() => hs.createPortalServers(app, { port: 4000, env }));
  try { return await fn(hs); } finally { await new Promise((r) => portal.close(r)); hs._resetHttpsServerState(); }
}
const tlsEnv = (extra = {}) => ({ TLS_CERT_FILE: PKI.srv1.cert, TLS_KEY_FILE: PKI.srv1.key, TLS_RELOAD_CHECK_MS: '0', ...extra });

test('A4-02 ① httpsServer.listeningPortalPorts: TLS 만 = [TLS_PORT] · TLS_HTTP_ALSO = 둘 다 · 평문 = [PORT] · 리스너 전에는 env 로 판정', { skip: NO_PKI }, async () => {
  const hs = await import('../src/util/httpsServer.js');
  assert.equal(typeof hs.listeningPortalPorts, 'function', 'listeningPortalPorts 를 export 해야 한다');
  await withListener(tlsEnv({ TLS_PORT: '4443' }), (m) => assert.deepEqual(m.listeningPortalPorts(4000), [4443]));
  await withListener(tlsEnv({ TLS_PORT: '4443', TLS_HTTP_ALSO: 'true' }), (m) => assert.deepEqual(m.listeningPortalPorts(4000), [4443, 4000]));
  await withListener(tlsEnv(), (m) => assert.deepEqual(m.listeningPortalPorts(4000), [4000], 'TLS_PORT 없으면 PORT 를 HTTPS 로 바꾼다'));
  await withListener({}, (m) => assert.deepEqual(m.listeningPortalPorts(4000), [4000]));
  // 리스너를 만들기 전(기동 순서·도구)에는 env 로 같은 판정을 한다 — config.port 로 단정하지 않는다.
  hs._resetHttpsServerState();
  assert.deepEqual(hs.listeningPortalPorts(4000, { env: tlsEnv({ TLS_PORT: '4443' }) }), [4443]);
  assert.deepEqual(hs.listeningPortalPorts(4000, { env: {} }), [4000]);
  assert.deepEqual(hs.listeningPortalPorts(4000, { env: { TLS_CERT_FILE: 'x' } }), [4000], '잘못된 TLS 설정이면 기동이 멈춘다 — 평문 포트를 그대로 둔다');
});

test('A4-02 ② 호스트 접근: HTTPS 만(TLS_PORT=4443) — 허용목록이 실제 포트 4443 을 관리·차단하고 상태가 그 포트를 말한다', { skip: NO_PKI }, async () => {
  const S = await import('../src/hostaccess/service.js');
  const St = await import('../src/hostaccess/settings.js');
  await withListener(tlsEnv({ TLS_PORT: '4443' }), async () => {
    St._resetHostAccessCache();
    const ex = fakeExec(LIST_ALL('4443/tcp 22/tcp'));
    S._setExec(ex);
    try {
      const st = await S.hostAccessStatus({ requesterIp: '10.1.1.5' });
      assert.equal(st.portalPort, 4443, '상태의 포탈 포트는 실제로 듣는 포트');
      assert.deepEqual(st.portalPorts, [4443]);
      assert.ok(st.draft.web.ports.includes('4443'), `초안 web.ports 에 실제 포트: ${st.draft.web.ports}`);

      const p = await S.planHostAccess({ web: { mode: 'allowlist', allow: ['10.1.1.0/24'] } }, { requesterIp: '10.1.1.5' });
      assert.equal(p.ok, true, JSON.stringify(p.errors));
      const cmds = p.commands.map((c) => c.join(' '));
      assert.ok(cmds.includes('--zone=public --remove-port=4443/tcp'), `열린 4443/tcp 를 닫아야 허용목록이 효력이 있다: ${cmds.join(' | ')}`);
      assert.ok(cmds.some((c) => c.includes('port port="4443" protocol="tcp" accept') && c.includes('10.1.1.0/24')), '허용 출처에 4443 rich rule');

      // 자기 잠금 검사: 추가 규칙이 실제 포탈 포트를 전체 drop 하면 막는다.
      const lock = await S.planHostAccess({ web: { mode: 'open' }, firewall: { extra: [{ port: '4443', proto: 'tcp', action: 'drop', sources: [] }] } }, { requesterIp: '10.1.1.5' });
      assert.equal(lock.ok, false);
      assert.ok(lock.errors.some((e) => /4443\/tcp/.test(e) && /잠깁니다/.test(e)), lock.errors.join(' | '));

      const d = S.saveDraft({ web: { mode: 'open' } });
      assert.equal(d.ok, true);
      assert.ok(d.settings.web.ports.includes('4443'));
    } finally { S._setExec(null); St._resetHostAccessCache(); }
  });
});

test('A4-02 ③ 호스트 접근: HTTPS + HTTP 동시(TLS_HTTP_ALSO) — 두 포트 모두 관리 대상', { skip: NO_PKI }, async () => {
  const S = await import('../src/hostaccess/service.js');
  const St = await import('../src/hostaccess/settings.js');
  await withListener(tlsEnv({ TLS_PORT: '4443', TLS_HTTP_ALSO: 'true' }), async () => {
    St._resetHostAccessCache();
    S._setExec(fakeExec(LIST_ALL('4443/tcp 4000/tcp 22/tcp')));
    try {
      const st = await S.hostAccessStatus({ requesterIp: '10.1.1.5' });
      assert.deepEqual(st.portalPorts, [4443, 4000]);
      const p = await S.planHostAccess({ web: { mode: 'allowlist', allow: ['10.1.1.0/24'] } }, { requesterIp: '10.1.1.5' });
      assert.equal(p.ok, true, JSON.stringify(p.errors));
      const cmds = p.commands.map((c) => c.join(' '));
      for (const port of ['4443', '4000']) {
        assert.ok(cmds.includes(`--zone=public --remove-port=${port}/tcp`), `${port}: ${cmds.join(' | ')}`);
        assert.ok(cmds.some((c) => c.includes(`port port="${port}" protocol="tcp" accept`)), `${port} rich rule`);
      }
    } finally { S._setExec(null); St._resetHostAccessCache(); }
  });
});

test('A4-02 ④ svcmon 엣지 보고(caps.portalPort)는 실제로 듣는 포탈 포트(HTTPS 만이면 TLS_PORT)', { skip: NO_PKI }, async () => {
  const bodies = [];
  const central = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let buf = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
      try { bodies.push(JSON.parse(buf.toString('utf8'))); } catch { /* */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, accepted: 0 }));
    });
  });
  const port = await listen(central);
  const { config } = await import('../src/config.js');
  config.agent.centralUrl = `http://127.0.0.1:${port}`;
  config.agent.centralToken = 'tok-g2b';
  config.agent.name = 'edge-g2b';
  try {
    await withListener(tlsEnv({ TLS_PORT: '4443' }), async () => {
      const sv = await import('../src/agent/svcmonPush.js');
      await quiet(() => sv.pushSvcmonNow());
    });
    assert.ok(bodies.length >= 1, '중앙에 보고가 도착했다');
    assert.equal(bodies[0].caps?.portalPort, 4443, `듣지 않는 config.port(4000)를 보고하면 중앙 TCP 진단이 정상 엣지를 bad 로 본다: ${bodies[0].caps?.portalPort}`);
  } finally { await closeSrv(central); config.agent.centralUrl = ''; config.agent.centralToken = ''; }
});
