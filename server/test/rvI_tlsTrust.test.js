/**
 * rvI_tlsTrust.test.js — 2026-10-09 검토 S-02 회귀: 자격증명을 보내는 HTTPS 연결의 상대 인증.
 *
 * 고정하는 것(전부 실제 undici Agent + 실제 HTTPS 서버 — 요청 바이트가 서버에 닿았는지를 서버 쪽에서 센다):
 *   ① 사설 CA 번들(CONFIG_DIR/tls-ca-bundle.pem)로 서명된 인증서는 통과하고 자격증명이 도착한다
 *   ② 신뢰하지 않는 인증서 · 호스트 이름 불일치 · 만료 인증서는 **요청 전에** 끊긴다(서버가 Authorization·본문을 받지 않는다)
 *   ③ 지문 승인 뒤에는 통과하고, observe 정책은 처음 본 장비를 통과시키되 바뀐 지문은 끊는다
 *   ④ strict(env=true) 는 승인 지문으로 대신하지 않는다 · insecure(env=false) 는 그 수집기에만 예외다
 *   ⑤ 거부 오류는 인증 실패로 읽히지 않는다(authGuard 문구 판정·util/errors.js 힌트)
 *   ⑥ TLS 세션 재개 연결도 지문 거부를 반영한다 · 상태(tlsTrustStatus)가 번들·예외·거부를 말한다
 * 인증서는 test/fixtures/rvI-tls(테스트 전용 — README).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(HERE, 'fixtures', 'rvI-tls');
const pem = (n) => fs.readFileSync(path.join(FX, n));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rvI-tls-'));
process.env.CONFIG_DIR = TMP;
delete process.env.TLS_PEER_POLICY;
delete process.env.SSH_HOSTKEY_POLICY;

let T; let PT; let undici;
before(async () => {
  undici = await import('undici');
  PT = await import('../src/security/peerTrust.js');
  T = await import('../src/security/tlsTrust.js');
});
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const BUNDLE = () => path.join(TMP, 'tls-ca-bundle.pem');
function setBundle(text) {
  if (text == null) { try { fs.unlinkSync(BUNDLE()); } catch { /* */ } }
  else fs.writeFileSync(BUNDLE(), text);
  T.loadCaBundle({ force: true });
}

/** 가짜 HTTPS 장비 — 받은 요청(Authorization·본문)과 TLS 연결 수를 기록한다. */
async function fakeDevice(certName, extra = {}) {
  const got = [];
  let tlsConns = 0;
  const srv = https.createServer({ key: pem(`${certName}.key`), cert: pem(`${certName}.crt`), ...extra }, (req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { got.push({ url: req.url, auth: req.headers.authorization || '', body }); res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
  });
  srv.on('connection', () => { tlsConns++; });   // TCP 접속 수 — 거부가 접속 이후(TLS 단계)에 일어났다는 증거(1.3 은 클라이언트가 Finished 직후 끊어 secureConnection 이 안 뜰 수 있다)
  srv.keepAliveTimeout = 1;
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    port: srv.address().port, got, conns: () => tlsConns,
    swap(name) { srv.setSecureContext({ key: pem(`${name}.key`), cert: pem(`${name}.crt`) }); },
    close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }),
  };
}

/** 연결 함수 하나로 Agent 를 새로 만들어 POST 한 번(keep-alive 소켓 재사용을 피해 매번 핸드셰이크가 일어나게). */
async function post(connect, port, { host = '127.0.0.1' } = {}) {
  const agent = new undici.Agent({ connect });
  try {
    const res = await fetch(`https://${host}:${port}/api/login`, {
      method: 'POST', dispatcher: agent,
      headers: { Authorization: 'Basic ' + Buffer.from('svc:SECRET-PW').toString('base64'), 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'SECRET-PW' }),
      signal: AbortSignal.timeout(8000),
    });
    await res.text();
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, err: e };
  } finally {
    await agent.close().catch(() => {});
  }
}

const mk = (subsystem, envRaw, envKey = 'RVI_TEST_TLS') => T.deviceTlsConnect({ subsystem, envKey, envRaw, tls: {} });

test('① 사설 CA 번들로 서명된 인증서는 통과하고 자격증명이 도착한다 — 번들이 없으면 같은 인증서가 요청 전에 끊긴다', async () => {
  PT._resetPeerTrustForTest();
  PT.setPeerPolicy('tls', 'enforce');
  const dev = await fakeDevice('server-ok');
  try {
    setBundle(null);
    const c1 = mk('rvi-ca', undefined);
    const r0 = await post(c1, dev.port);
    assert.equal(r0.ok, false, '번들 없이 사설 CA 인증서가 통과했다');
    assert.equal(T.tlsPeerErrorOf(r0.err)?.code, T.TLS_PEER_ERROR_CODE, String(r0.err?.cause?.message || r0.err));
    assert.equal(dev.got.length, 0, '거부했는데 서버가 요청(자격증명)을 받았다');
    assert.ok(dev.conns() >= 1, 'TLS 핸드셰이크조차 일어나지 않았다 — 판정 위치를 시험하지 못한다');

    setBundle(pem('ca.crt').toString());
    const r1 = await post(mk('rvi-ca', undefined), dev.port);
    assert.equal(r1.ok, true, String(r1.err?.cause?.message || r1.err));
    assert.equal(dev.got.length, 1);
    assert.match(dev.got[0].auth, /^Basic /, '자격증명이 도착해야 한다');
    // 체인으로 통과한 장비는 지문 저장소에 남지 않는다(관찰·대기 0)
    assert.equal(PT.listPeers({ kind: 'tls' }).filter((e) => e.port === dev.port && e.state !== 'pending').length, 0);
    const st = T.tlsTrustStatus();
    assert.equal(st.caBundle.present, true);
    assert.equal(st.caBundle.certs, 1);
    assert.ok(st.subsystems.find((s) => s.subsystem === 'rvi-ca').counts.chain >= 1);
  } finally { await dev.close(); setBundle(null); }
});

test('② 신뢰하지 않는 인증서 · 이름 불일치 · 만료 인증서는 자격증명 전송 전에 끊긴다(enforce)', async () => {
  PT._resetPeerTrustForTest();
  PT.setPeerPolicy('tls', 'enforce');
  setBundle(pem('ca.crt').toString());
  for (const [name, chainCode] of [['self-a', 'DEPTH_ZERO_SELF_SIGNED_CERT'], ['server-wronghost', 'ERR_TLS_CERT_ALTNAME_INVALID'], ['server-expired', 'CERT_HAS_EXPIRED']]) {
    const dev = await fakeDevice(name);
    try {
      const r = await post(mk('rvi-bad', undefined), dev.port);
      assert.equal(r.ok, false, `${name}: 통과했다`);
      const te = T.tlsPeerErrorOf(r.err);
      assert.ok(te, `${name}: TlsPeerError 가 아니다 — ${r.err?.cause?.message || r.err}`);
      assert.equal(te.tlsPeer.chainError, chainCode, `${name}: 체인 판정 코드`);
      assert.equal(dev.got.length, 0, `${name}: 서버가 Authorization·본문을 받았다`);
      assert.ok(dev.conns() >= 1, `${name}: 핸드셰이크가 없었다`);
      // 화면이 승인할 수 있게 대기 지문이 남는다(제시된 인증서의 SHA-256)
      const e = PT.listPeers({ kind: 'tls' }).find((x) => x.port === dev.port);
      assert.equal(e?.state, 'pending', `${name}: 대기 지문이 남지 않았다`);
      assert.ok(te.message.includes(e.pending.fp), `${name}: 문구에 제시된 지문이 없다`);
    } finally { await dev.close(); }
  }
  setBundle(null);
});

test('③ 지문 승인 뒤 통과 · 다른 지문(교체)은 다시 끊긴다 · 거부한 지문은 정책과 무관하게 끊긴다', async () => {
  PT._resetPeerTrustForTest();
  PT.setPeerPolicy('tls', 'enforce');
  setBundle(null);
  const dev = await fakeDevice('self-a');
  try {
    const r0 = await post(mk('rvi-pin', undefined), dev.port);
    assert.equal(r0.ok, false);
    const fp = PT.listPeers({ kind: 'tls' }).find((x) => x.port === dev.port).pending.fp;
    assert.equal(PT.approvePeer('tls', '127.0.0.1', dev.port, fp, { by: 'test' }).ok, true);
    const r1 = await post(mk('rvi-pin', undefined), dev.port);
    assert.equal(r1.ok, true, String(r1.err?.cause?.message || r1.err));
    assert.equal(dev.got.length, 1);

    dev.swap('self-b');
    const r2 = await post(mk('rvi-pin', undefined), dev.port);
    assert.equal(r2.ok, false, '교체된 인증서가 통과했다');
    assert.equal(T.tlsPeerErrorOf(r2.err).tlsPeer.reason, 'changed');
    assert.equal(dev.got.length, 1, '교체된 인증서에 자격증명이 나갔다');

    dev.swap('self-a');
    PT.rejectPeer('tls', '127.0.0.1', dev.port, fp, { by: 'test' });
    const r3 = await post(mk('rvi-pin', undefined), dev.port);
    assert.equal(r3.ok, false);
    assert.equal(T.tlsPeerErrorOf(r3.err).tlsPeer.reason, 'rejected');
    assert.equal(dev.got.length, 1);
  } finally { await dev.close(); }
});

test('③-b observe 정책: 처음 본 장비는 기록 후 통과, 바뀐 지문은 끊긴다(전환 단계)', async () => {
  PT._resetPeerTrustForTest();
  PT.setPeerPolicy('tls', 'observe');
  setBundle(null);
  const dev = await fakeDevice('self-a');
  try {
    const r1 = await post(mk('rvi-obs', undefined), dev.port);
    assert.equal(r1.ok, true, String(r1.err?.cause?.message || r1.err));
    const e = PT.listPeers({ kind: 'tls' }).find((x) => x.port === dev.port);
    assert.equal(e.state, 'observed', '관찰 기록이 남아야 한다(무음 TOFU 아님)');
    dev.swap('self-b');
    const r2 = await post(mk('rvi-obs', undefined), dev.port);
    assert.equal(r2.ok, false, 'observe 에서 바뀐 지문이 통과했다');
    assert.equal(T.tlsPeerErrorOf(r2.err).tlsPeer.reason, 'changed');
    assert.equal(dev.got.length, 1, '바뀐 지문에 자격증명이 나갔다');
    assert.ok(T.tlsTrustStatus().subsystems.find((s) => s.subsystem === 'rvi-obs').counts.observed >= 1);
  } finally { await dev.close(); PT.setPeerPolicy('tls', 'enforce'); }
});

test('④ strict(env=true) 는 승인 지문으로 대신하지 않는다 — CA 체인만', async () => {
  PT._resetPeerTrustForTest();
  PT.setPeerPolicy('tls', 'enforce');
  setBundle(null);
  const dev = await fakeDevice('self-a');
  try {
    // 지문을 미리 승인해 둔다 — 그래도 strict 는 끊어야 한다
    await post(mk('rvi-strict-pre', undefined), dev.port);
    const fp = PT.listPeers({ kind: 'tls' }).find((x) => x.port === dev.port).pending.fp;
    PT.approvePeer('tls', '127.0.0.1', dev.port, fp, { by: 'test' });
    assert.equal((await post(mk('rvi-strict-pre', undefined), dev.port)).ok, true, '기본 모드는 승인 지문으로 통과');
    const before = dev.got.length;
    const r = await post(mk('rvi-strict', 'true'), dev.port);
    assert.equal(r.ok, false, 'strict 가 승인 지문으로 통과했다');
    assert.equal(dev.got.length, before);
    assert.match(T.tlsPeerErrorOf(r.err).message, /RVI_TEST_TLS=true/);
  } finally { await dev.close(); }
  const ok = await fakeDevice('server-ok');
  try {
    setBundle(pem('ca.crt').toString());
    assert.equal((await post(mk('rvi-strict', 'true'), ok.port)).ok, true, 'strict 도 CA 체인은 통과');
  } finally { await ok.close(); setBundle(null); }
});

test('④-b insecure(env=false) 는 그 수집기에만 예외다 — 다른 수집기·같은 장비의 검증은 그대로', async () => {
  PT._resetPeerTrustForTest();
  PT.setPeerPolicy('tls', 'enforce');
  setBundle(null);
  const dev = await fakeDevice('self-b');
  try {
    const insecure = T.deviceTlsConnect({ subsystem: 'rvi-exc', envKey: 'RVI_EXC_TLS', envRaw: 'false', tls: {} });
    const r1 = await post(insecure, dev.port);
    assert.equal(r1.ok, true, '명시적 예외는 예전처럼 통과해야 한다');
    assert.equal(PT.listPeers({ kind: 'tls' }).filter((x) => x.port === dev.port).length, 0, '예외 경로가 지문 저장소를 건드렸다');
    const r2 = await post(mk('rvi-other', undefined), dev.port);
    assert.equal(r2.ok, false, '다른 수집기까지 예외가 번졌다');
    const st = T.tlsTrustStatus();
    assert.deepEqual(st.exceptions.map((x) => x.subsystem), ['rvi-exc'], JSON.stringify(st.exceptions));
    assert.equal(st.subsystems.find((s) => s.subsystem === 'rvi-exc').envRaw, 'false');
    // 전역 fetch(디스패처 미지정)는 이 예외의 영향을 받지 않는다 — 자체서명을 받지 않는다
    let globalErr = null;
    try { await fetch(`https://127.0.0.1:${dev.port}/x`, { signal: AbortSignal.timeout(5000) }); } catch (e) { globalErr = e; }
    assert.ok(globalErr, '전역 fetch 가 자체서명을 받아들였다 — 예외가 전역으로 번졌다');
  } finally { await dev.close(); }
});

test('⑤ 거부 오류는 인증 실패로 읽히지 않는다 — authGuard 문구·util/errors.js·storage netError', async () => {
  PT._resetPeerTrustForTest();
  PT.setPeerPolicy('tls', 'enforce');
  setBundle(null);
  const { isAuthFailureText } = await import('../src/util/authGuard.js');
  const { describeError } = await import('../src/util/errors.js');
  const { describeFetchError, isTransportError } = await import('../src/storage/collectors/netError.js');
  const dev = await fakeDevice('self-a');
  try {
    const r = await post(mk('rvi-auth', undefined), dev.port);
    assert.equal(r.ok, false);
    const te = T.tlsPeerErrorOf(r.err);
    assert.equal(te.authFailed, undefined);
    assert.equal(isAuthFailureText(te.message), false, te.message);
    assert.equal(isAuthFailureText(String(r.err.message), String(r.err.cause?.message)), false);
    const d = describeError(r.err);
    assert.equal(d.hint, null, `인증·인증서 힌트로 덮였다: ${d.hint}`);
    assert.ok(d.message.includes(te.tlsPeer.fingerprint));
    assert.equal(isTransportError(r.err), true);
    const s = describeFetchError(r.err, { host: '127.0.0.1', port: dev.port });
    assert.ok(s.includes(te.tlsPeer.fingerprint), `스토리지 사유 문구가 지문을 잃었다: ${s}`);
    assert.equal(isAuthFailureText(s), false, s);
  } finally { await dev.close(); }
});

test('⑥ TLS 세션 재개 연결도 지문 거부를 반영한다(재개는 인증서를 다시 보내지 않는다)', async () => {
  PT._resetPeerTrustForTest();
  PT.setPeerPolicy('tls', 'enforce');
  setBundle(null);
  const dev = await fakeDevice('self-a');
  try {
    const c = mk('rvi-resume', undefined);  // 같은 연결 함수 = 같은 세션 기억
    await post(c, dev.port);
    const fp = PT.listPeers({ kind: 'tls' }).find((x) => x.port === dev.port).pending.fp;
    PT.approvePeer('tls', '127.0.0.1', dev.port, fp, { by: 'test' });
    assert.equal((await post(c, dev.port)).ok, true);
    assert.equal((await post(c, dev.port)).ok, true);
    const sub = () => T.tlsTrustStatus().subsystems.find((s) => s.subsystem === 'rvi-resume');
    assert.ok(sub().counts.resumed >= 1, `세션 재개가 일어나지 않았다 — 시험이 무의미하다 ${JSON.stringify(sub().counts)}`);
    const before = dev.got.length;
    PT.rejectPeer('tls', '127.0.0.1', dev.port, fp, { by: 'test' });
    const r = await post(c, dev.port);
    assert.equal(r.ok, false, '재개된 세션이 거부된 지문을 통과시켰다');
    assert.equal(dev.got.length, before);
  } finally { await dev.close(); }
});

test('⑥-b 판정을 통과하지 못한 연결의 TLS 세션은 기억하지 않는다(TLS 1.2 — 세션이 핸드셰이크 중에 온다)', async () => {
  PT._resetPeerTrustForTest();
  PT.setPeerPolicy('tls', 'enforce');
  setBundle(null);
  const dev = await fakeDevice('self-a', { maxVersion: 'TLSv1.2' });
  try {
    const c = mk('rvi-nosess', undefined);
    for (let i = 0; i < 3; i++) {
      const r = await post(c, dev.port);
      assert.equal(r.ok, false, `${i + 1}번째 연결이 통과했다 — 거부된 연결의 세션이 재개됐다`);
    }
    assert.equal(dev.got.length, 0);
    assert.equal(T.tlsTrustStatus().subsystems.find((s) => s.subsystem === 'rvi-nosess').counts.resumed, 0);
  } finally { await dev.close(); }
});

test('⑦ 사설 CA 번들 상태 — 읽은 개수·읽지 못한 블록·인증서가 아닌 블록을 밝힌다', () => {
  setBundle(`${pem('ca.crt')}\n-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n-----BEGIN EC PRIVATE KEY-----\nx\n-----END EC PRIVATE KEY-----\n`);
  const b = T.tlsTrustStatus().caBundle;
  assert.equal(b.certs, 1);
  assert.equal(b.errors.length, 1);
  assert.equal(b.otherBlocks, 1, '개인키 블록을 밝히지 않았다');
  assert.equal(b.items[0].ca, true);
  setBundle(null);
  assert.equal(T.tlsTrustStatus().caBundle.present, false);
});

test('⑧ env 해석 — 미설정 verify · true strict · false insecure · 모르는 값은 verify(검증 안 함으로 읽지 않는다)', async () => {
  const { tlsModeInfo } = await import('../src/security/tlsMode.js');
  assert.equal(tlsModeInfo(undefined).mode, 'verify');
  assert.equal(tlsModeInfo('').mode, 'verify');
  assert.equal(tlsModeInfo('true').mode, 'strict');
  assert.equal(tlsModeInfo(' TRUE ').mode, 'strict');
  assert.equal(tlsModeInfo('false').mode, 'insecure');
  assert.equal(tlsModeInfo('0').mode, 'insecure');
  const u = tlsModeInfo('maybe');
  assert.equal(u.mode, 'verify'); assert.equal(u.unknown, true);
});

test('⑨ 소스 스윕 — 자격증명을 보내는 장비 클라이언트의 Agent 는 전부 deviceTlsConnect 를 쓴다(예외는 사유와 함께)', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const SRC = path.resolve(HERE, '../src');
  const FILES = ['vcenter/restClient.js', 'nsx/client.js', 'idrac/redfish.js', 'idrac/ome.js', 'horizon/horizon.js',
    'storage/collectors/restCommon.js', 'storage/collectors/isilon.js', 'sanswitch/collectors/fosRest.js', 'cvp/client.js'];
  // 자격증명을 싣지 않는 경로만 — 여기 줄을 더하려면 그 dispatcher 로 계정·토큰이 나가지 않는다는 근거가 있어야 한다.
  const ALLOW = { 'idrac/redfish.js': ['probeDispatcher'] };
  const offenders = [];
  for (const f of FILES) {
    const code = stripComments(fs.readFileSync(path.join(SRC, f), 'utf8'));
    const re = /(?:const|let)\s+(\w+)\s*=\s*new (?:Undici)?Agent\(\{([\s\S]*?)\}\);/g;
    let m; let n = 0;
    while ((m = re.exec(code))) {
      n++;
      if ((ALLOW[f] || []).includes(m[1])) continue;
      if (!/deviceTlsConnect\(/.test(m[2])) offenders.push(`${f}: ${m[1]}`);
    }
    assert.ok(n >= 1, `${f}: Agent 생성부를 찾지 못했다 — 스윕 정규식이 깨졌을 수 있다`);
    assert.doesNotMatch(code, /rejectUnauthorized:\s*process\.env\.\w+\s*===\s*'true'/, `${f}: 예전 opt-in 검증('true' 일 때만)이 남아 있다`);
  }
  assert.deepEqual(offenders, [], `판정 없는 장비 dispatcher:\n  ${offenders.join('\n  ')}`);
  // 예외 dispatcher 로는 로그인하지 않는다 — probeIdrac 의 서비스 루트 한 곳에서만 쓴다
  const rf = stripComments(fs.readFileSync(path.join(SRC, 'idrac/redfish.js'), 'utf8'));
  assert.equal((rf.match(/dispatcher:\s*probeDispatcher/g) || []).length, 1, 'probeDispatcher 를 서비스 루트 밖에서 쓴다');
});
