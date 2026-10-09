/**
 * rvI_tlsClients.test.js — 2026-10-09 검토 S-02: 실제 장비 클라이언트가 인증서 판정 dispatcher 를 쓰는지(배선 회귀).
 *
 * 각 수집기의 **실제 진입 함수**를 가짜 HTTPS 장비(자체서명, test/fixtures/rvI-tls)에 붙인다:
 *   승인 전 — 자격증명(Authorization·로그인 본문)이 서버에 도착하지 않고, 오류는 인증 실패로 분류되지 않으며, 대기 지문이 남는다.
 *   승인 후 — 같은 호출이 자격증명을 실어 서버에 도착한다.
 * 마지막 테스트는 별도 프로세스에서 '예외 env(=false)는 그 수집기에만 적용되고 업그레이드·중앙↔엣지 TLS 는 약해지지 않는다' 를 본다
 * (env 는 모듈 로드 때 읽힌다).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(HERE, 'fixtures', 'rvI-tls');
const pem = (n) => fs.readFileSync(path.join(FX, n));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rvI-tlscl-'));
process.env.CONFIG_DIR = TMP;
process.env.SSRF_ALLOW_LOOPBACK = 'true';   // 가짜 장비가 127.0.0.1 이다(등록부·baseUrlOf 의 정적 SSRF 검사 통과용)
for (const k of ['TLS_PEER_POLICY', 'VC_TLS_REJECT_UNAUTHORIZED', 'HORIZON_TLS_VERIFY', 'STORAGE_TLS_VERIFY', 'SANSWITCH_TLS_VERIFY', 'NSX_TLS_REJECT_UNAUTHORIZED']) delete process.env[k];

let PT; let T; let isAuthFailureText;
before(async () => {
  PT = await import('../src/security/peerTrust.js');
  T = await import('../src/security/tlsTrust.js');
  ({ isAuthFailureText } = await import('../src/util/authGuard.js'));
  PT.setPeerPolicy('tls', 'enforce');
});
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

/** 가짜 장비: 경로별 응답(handler 가 없으면 200 {}). 받은 요청의 Authorization·본문을 기록한다. */
async function device(handler = null, cert = 'self-a', port = 0) {
  const got = [];
  const srv = https.createServer({ key: pem(`${cert}.key`), cert: pem(`${cert}.crt`) }, (req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      got.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', body });
      const out = handler ? handler(req, body) : null;
      res.statusCode = out?.status || 200;
      res.setHeader('content-type', out?.type || 'application/json');
      res.end(out?.body ?? '{}');
    });
  });
  srv.keepAliveTimeout = 1;
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  const p = srv.address().port;
  return {
    port: p, base: `https://127.0.0.1:${p}`, got,
    creds: () => got.filter((g) => g.auth || /SECRET-PW/.test(g.body)),
    close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }),
  };
}

function pendingFp(port) {
  const e = PT.listPeers({ kind: 'tls' }).find((x) => x.host === '127.0.0.1' && x.port === port);
  return e?.pending?.fp || null;
}
const approve = (port) => {
  const fp = pendingFp(port);
  assert.ok(fp, `127.0.0.1:${port} 대기 지문이 없다 — 판정 dispatcher 를 거치지 않았다`);
  assert.equal(PT.approvePeer('tls', '127.0.0.1', port, fp, { by: 'test' }).ok, true);
};
async function settle(p) { try { return { ok: true, v: await p }; } catch (e) { return { ok: false, err: e }; } }
const textOf = (r) => [r.err?.message, r.err?.cause?.message, r.v?.reason, r.v?.error].filter(Boolean).join(' | ');

/** 승인 전: 자격증명 0 · 인증 실패 아님 · 대기 지문. 승인 후: 자격증명 도착. */
async function scenario(name, dev, call, { authCheck = true } = {}) {
  const r1 = await settle(call());
  assert.equal(dev.creds().length, 0, `${name}: 승인 전에 자격증명이 도착했다 ${JSON.stringify(dev.creds())}`);
  const t1 = textOf(r1);
  assert.ok(pendingFp(dev.port), `${name}: 대기 지문이 없다(${t1})`);
  if (authCheck) {
    assert.equal(r1.err?.authFailed === true || r1.v?.authFailed === true, false, `${name}: 인증 실패로 표시됐다`);
    assert.equal(isAuthFailureText(t1), false, `${name}: 문구가 인증 실패로 읽힌다 — ${t1}`);
  }
  approve(dev.port);
  await settle(call());
  assert.ok(dev.creds().length >= 1, `${name}: 승인 뒤에도 자격증명이 도착하지 않았다 ${JSON.stringify(dev.got.map((g) => g.url))}`);
  return Object.assign(new String(t1), { first: r1 });
}

test('vCenter REST(VCenterClient.login) — 승인 전 Basic 미전송 · isVcAuthError 아님', async () => {
  const { VCenterClient, isVcAuthError } = await import('../src/vcenter/restClient.js');
  const dev = await device((req) => (req.url === '/api/session' ? { body: '"tok"' } : null));
  try {
    const vc = { id: 'vc-t', host: dev.base, username: 'svc', password: 'SECRET-PW' };
    let err = null;
    try { await new VCenterClient(vc).login(); } catch (e) { err = e; }
    assert.ok(err); assert.equal(isVcAuthError(err), false);
    await scenario('vcenter-rest', dev, () => new VCenterClient(vc).login());
  } finally { await dev.close(); }
});

test('vCenter SOAP(VimSoapClient.login) — 승인 전 요청 0 · isVcAuthError 아님', async () => {
  const { VimSoapClient } = await import('../src/vcenter/soapClient.js');
  const { isVcAuthError } = await import('../src/vcenter/restClient.js');
  const dev = await device(() => ({ status: 500, type: 'text/xml', body: '<faultstring>x</faultstring>' }));
  try {
    const vc = { id: 'vc-s', host: dev.base, username: 'svc', password: 'SECRET-PW' };
    let err = null;
    try { await new VimSoapClient(vc).login(); } catch (e) { err = e; }
    assert.ok(err);
    assert.equal(dev.got.length, 0, 'SOAP 요청이 서버에 닿았다');
    assert.equal(isVcAuthError(err), false);
    assert.ok(T.tlsPeerErrorOf(err), `TlsPeerError 가 아니다: ${err?.message}`);
    approve(dev.port);
    try { await new VimSoapClient(vc).login(); } catch { /* 가짜 서버는 SOAP 를 모른다 */ }
    assert.ok(dev.got.length >= 1, '승인 뒤 SOAP 요청이 닿지 않았다');
  } finally { await dev.close(); }
});

test('스토리지 REST(restCommon makeGetter) — 승인 전 Basic 미전송, 사유 문구에 지문', async () => {
  const { makeGetter } = await import('../src/storage/collectors/restCommon.js');
  const dev = await device();
  try {
    const d = { host: '127.0.0.1', username: 'svc', password: 'SECRET-PW' };
    const t = await scenario('storage-rest', dev, () => makeGetter(d, { port: dev.port })('/api/rest/x'));
    assert.match(String(t), /장비 인증서를 신뢰할 수 없어/);
  } finally { await dev.close(); }
});

test('스토리지 Isilon(get) — 승인 전 Basic 미전송', async () => {
  const dev = await device();
  try {
    process.env.STORAGE_ISILON_PORT = String(dev.port);   // 모듈 로드 때 읽는다 — 이 테스트에서 처음 import 한다
    const { get } = await import('../src/storage/collectors/isilon.js');
    await scenario('isilon', dev, () => get({ host: '127.0.0.1', username: 'svc', password: 'SECRET-PW' }, '/platform/1/cluster/config'));
  } finally { await dev.close(); delete process.env.STORAGE_ISILON_PORT; }
});

test('SAN 스위치 FOS REST(collect) — 승인 전 로그인 Basic 미전송', async () => {
  const { collect } = await import('../src/sanswitch/collectors/fosRest.js');
  const dev = await device();
  try {
    const t = await scenario('sanswitch', dev, () => collect({ id: 's1', host: '127.0.0.1', httpsPort: dev.port, username: 'svc', password: 'SECRET-PW' }));
    // 폴러는 snap.error = e.message 만 싣는다(sanswitch/poller.js) — cause 가 아니라 최상위 message 에 판정 문구가 있어야 한다.
    assert.match(String(t.first.err?.message), /장비 인증서를 신뢰할 수 없어/, 'SAN 오류가 판정 문구를 잃었다(화면엔 e.message 가 간다)');
  } finally { await dev.close(); }
});

test('iDRAC(probeIdrac) — 무인증 서비스 루트는 판정 없이 보되, 로그인은 승인 전 미전송 · 발견으로 세지 않는다', async () => {
  const { probeIdrac } = await import('../src/idrac/redfish.js');
  const dev = await device((req) => (req.url === '/redfish/v1' ? { body: '{"Vendor":"Dell","Oem":{"Dell":{}}}' } : { body: '{"Members":[]}' }));
  try {
    const r1 = await probeIdrac(dev.base, 'svc', 'SECRET-PW', 3000);
    assert.ok(dev.got.some((g) => g.url === '/redfish/v1' && !g.auth), '무인증 서비스 루트는 판정 없이 조회돼야 한다(스캔 1단계)');
    assert.equal(dev.creds().length, 0, '승인 전에 iDRAC 계정이 나갔다');
    assert.equal(r1.ok, false, '로그인을 못 했는데 발견(ok)으로 셌다');
    assert.equal(r1.tlsUntrusted, true);
    assert.equal(isAuthFailureText(r1.reason), false, r1.reason);
    approve(dev.port);
    const r2 = await probeIdrac(dev.base, 'svc', 'SECRET-PW', 3000);
    assert.ok(dev.creds().length >= 1, '승인 뒤 로그인이 닿지 않았다');
    assert.equal(r2.ok, true);
  } finally { await dev.close(); }
});

test('OME(testOme) — 승인 전 로그인 본문(비밀번호) 미전송', async () => {
  const { testOme } = await import('../src/idrac/ome.js');
  const dev = await device((req) => (req.url.startsWith('/api/SessionService') ? { status: 201, body: '{}' } : { body: '{"value":[]}' }));
  try {
    await scenario('ome', dev, () => testOme({ host: dev.base, username: 'svc', password: 'SECRET-PW' }));
  } finally { await dev.close(); }
});

test('Horizon(withHorizonSession) — 승인 전 AD 계정 미전송', async () => {
  const { withHorizonSession } = await import('../src/horizon/horizon.js');
  const dev = await device((req) => (req.url === '/rest/login' ? { body: '{"access_token":"t","refresh_token":"r"}' } : null));
  try {
    await scenario('horizon', dev, () => withHorizonSession({ id: 'hz1', host: dev.base, username: 'svc', password: 'SECRET-PW', domain: 'CORP' }, async () => 1));
  } finally { await dev.close(); }
});

test('CVP(openSession) — 기본(verifyTls 꺼짐)도 승인 전 계정 미전송 · verifyTls=true 는 승인 지문으로도 통과하지 않는다', async () => {
  const { openSession } = await import('../src/cvp/client.js');
  const dev = await device((req) => (req.url.includes('authenticate') ? { body: '{"sessionId":"abc"}' } : null));
  try {
    const srv = { id: 'c1', host: dev.base, authMode: 'password', username: 'svc', password: 'SECRET-PW' };
    await scenario('cvp', dev, () => openSession(srv));
    const before = dev.creds().length;
    const r = await settle(openSession({ ...srv, verifyTls: true }));
    assert.equal(r.ok, false, 'verifyTls=true(엄격)가 승인 지문으로 통과했다');
    assert.equal(dev.creds().length, before);
  } finally { await dev.close(); }
});

test('NSX(fetchGroupMembers) — 승인 전 Basic 미전송', async () => {
  const { fetchGroupMembers } = await import('../src/nsx/client.js');
  const dev = await device(() => ({ body: '{"results":[],"result_count":0}' }));
  try {
    const t = await scenario('nsx', dev, () => fetchGroupMembers({ id: 'n1', host: dev.base, username: 'svc', password: 'SECRET-PW' }, 'g1'));
    assert.match(String(t.first.err?.message), /장비 인증서를 신뢰할 수 없어/, 'NSX 오류가 판정 문구를 잃었다(그룹 멤버 화면은 e.message)');
  } finally { await dev.close(); }
});

test('상태 — 수집기별 판정 모드가 등록되고 예외는 없다(기본)', () => {
  const st = T.tlsTrustStatus();
  const subs = new Map(st.subsystems.map((s) => [s.subsystem, s]));
  for (const k of ['vcenter', 'storage', 'sanswitch', 'idrac', 'ome', 'horizon', 'cvp', 'nsx']) {
    assert.ok(subs.has(k), `${k} 가 상태에 없다`);
    assert.equal(subs.get(k).exception, false, `${k} 가 예외로 표시됐다`);
    assert.ok(subs.get(k).counts.rejected >= 1, `${k}: 거부가 기록되지 않았다`);
  }
  assert.deepEqual(st.exceptions, []);
  assert.ok(st.recentRejects.length >= 1);
});

test('예외 env(=false)는 그 수집기에만 — 다른 수집기·업그레이드·중앙↔엣지 TLS 는 그대로(별도 프로세스)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rvI-tlsexc-'));
  const script = `
    import https from 'node:https'; import fs from 'node:fs';
    const FX = ${JSON.stringify(FX)};
    const srv = https.createServer({ key: fs.readFileSync(FX + '/self-b.key'), cert: fs.readFileSync(FX + '/self-b.crt') }, (q, r) => { r.end('{}'); });
    srv.keepAliveTimeout = 1;
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const PT = await import(${JSON.stringify(new URL('../src/security/peerTrust.js', import.meta.url).href)});
    PT.setPeerPolicy('tls', 'enforce');
    const { makeGetter } = await import(${JSON.stringify(new URL('../src/storage/collectors/restCommon.js', import.meta.url).href)});
    const { withHorizonSession } = await import(${JSON.stringify(new URL('../src/horizon/horizon.js', import.meta.url).href)});
    const { upgradeAgent } = await import(${JSON.stringify(new URL('../src/upgrade/upgradeAgent.js', import.meta.url).href)});
    const { resilientFetch } = await import(${JSON.stringify(new URL('../src/util/resilientFetch.js', import.meta.url).href)});
    const T = await import(${JSON.stringify(new URL('../src/security/tlsTrust.js', import.meta.url).href)});
    const out = {};
    const tryit = async (k, f) => { try { await f(); out[k] = 'ok'; } catch (e) { out[k] = 'fail:' + (e?.cause?.code || e?.code || e?.message || e); } };
    await tryit('storage', () => makeGetter({ host: '127.0.0.1', username: 'u', password: 'p' }, { port })('/x'));
    await tryit('horizon', () => withHorizonSession({ id: 'h', host: 'https://127.0.0.1:' + port, username: 'u', password: 'p', domain: 'd' }, async () => 1));
    await tryit('upgrade', async () => { const r = await fetch('https://127.0.0.1:' + port + '/x', { dispatcher: upgradeAgent }); await r.text(); });
    await tryit('wan', async () => { const r = await resilientFetch('https://127.0.0.1:' + port + '/x', { retries: 0, timeoutMs: 5000 }); if (!r.ok && !r.status) throw new Error('no'); await r.text?.(); });
    out.exceptions = T.tlsTrustStatus().exceptions.map((x) => x.subsystem);
    srv.closeAllConnections?.(); srv.close();
    console.log('RESULT ' + JSON.stringify(out));
    process.exit(0);
  `;
  const env = { ...process.env, CONFIG_DIR: tmp, STORAGE_TLS_VERIFY: 'false', SSRF_ALLOW_LOOPBACK: 'true' };
  delete env.HORIZON_TLS_VERIFY; delete env.WAN_TLS_INSECURE; delete env.UPGRADE_TLS_INSECURE; delete env.TLS_PEER_POLICY; delete env.NODE_TEST_CONTEXT;
  let outText = '';
  try {
    outText = execFileSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } }
  const line = outText.split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, outText);
  const r = JSON.parse(line.slice(7));
  assert.equal(r.storage, 'ok', `STORAGE_TLS_VERIFY=false 예외가 스토리지에 적용되지 않았다 ${JSON.stringify(r)}`);
  assert.match(r.horizon, /^fail:.*ERR_TLS_PEER_UNTRUSTED|^fail:/, 'Horizon 까지 예외가 번졌다');
  assert.notEqual(r.horizon, 'ok');
  assert.notEqual(r.upgrade, 'ok', '업그레이드 TLS 가 약해졌다');
  assert.notEqual(r.wan, 'ok', '중앙↔엣지(WAN) TLS 가 약해졌다');
  assert.deepEqual(r.exceptions, ['storage']);
});
