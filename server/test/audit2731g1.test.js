/**
 * test/audit2731g1.test.js — 점검 1회차(v2.731) G1: 장비 신뢰(security/peerTrust.js) 다중 지문 + 거부 문구의 승인 노드.
 *
 * A1-01(medium): 같은 주소(host:port)가 정상적으로 여러 인증서·호스트키를 내는 장비(로드밸런서·DNS 라운드로빈 뒤 여러 서버)는
 *   v2.730 에서 첫 지문만 관찰되고 나머지는 전부 'changed' 로 거부됐다. 관리자가 두 번째 지문을 승인하면 첫 지문이 다시
 *   'changed' 가 됐다(승인 = 교체) — 승인으로 풀 길이 없었다. 이제
 *     · 승인은 **추가**다(기존 승인 지문을 지우지 않는다). 교체는 명시 옵션(replace)일 때만.
 *     · 개별 지문을 회수(거부)할 수 있다 — 같은 주소의 다른 승인 지문은 그대로.
 *     · observe 에서 처음 보는 '두 번째 지문' 은 여전히 거부(보안 유지) — 승인하면 풀린다.
 *     · 옛 저장 형식(항목당 trusted 객체 1개)을 그대로 읽고, 저장 파일의 trusted 는 여전히 객체다(되돌림 설치 호환).
 * A1-02(low): 거부 문구가 '어느 노드에서 승인해야 하는지' 를 말한다 — 엣지(CENTRAL_URL 설정)면 그 엣지 이름.
 *   표지 문자열(SSH_HOSTKEY_UNTRUSTED·ERR_TLS_PEER_UNTRUSTED 문구)은 그대로.
 * ⚠ 기준 시각에 Date.now() 를 쓰지 않는다 — 시각 경계를 판정하지 않는다.
 */
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2731g1-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
delete process.env.SSH_HOSTKEY_POLICY;
delete process.env.TLS_PEER_POLICY;
delete process.env.CENTRAL_URL;
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const pt = await import('../src/security/peerTrust.js');
const sx = await import('../src/proxy/sshExec.js');
const T = await import('../src/security/tlsTrust.js');
const { config } = await import('../src/config.js');
const { isAuthFailureText, isPeerRejectText } = await import('../src/util/authGuard.js');

const FP = (c) => 'SHA256:' + c.repeat(43);
const TFP = (h) => Array.from({ length: 32 }, () => h).join(':');

const FILE = () => path.join(DIR, 'peer-trust.json');
function wipe() {
  for (const f of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, f), { recursive: true, force: true });
  pt._resetPeerTrustForTest();
}
const auditLines = () => { try { return fs.readFileSync(path.join(DIR, 'audit.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const ORIG_AGENT = { ...config.agent };
beforeEach(() => {
  delete process.env.SSH_HOSTKEY_POLICY; delete process.env.TLS_PEER_POLICY;
  config.agent.centralUrl = ORIG_AGENT.centralUrl; config.agent.name = ORIG_AGENT.name;
  wipe();
});
/** 업그레이드 현장(등록부가 있음) → observe 로 시작 */
const asUpgrade = () => { fs.writeFileSync(path.join(DIR, 'horizon.json'), JSON.stringify({ servers: [{ id: 'h1' }] })); pt._resetPeerTrustForTest(); };

test('A1-01 ① observe — 로드밸런서 뒤 서버 2~3대: 두 번째 지문은 거부되지만 승인(추가)하면 둘 다 통과한다', () => {
  asUpgrade();
  assert.equal(pt.getPeerPolicy('tls').mode, 'observe');
  const A = TFP('AA'); const B = TFP('BB'); const C = TFP('CC');
  assert.equal(pt.checkPeer('tls', 'hz.corp', 443, A).reason, 'observed-new');
  assert.deepEqual([pt.checkPeer('tls', 'hz.corp', 443, B).ok, pt.checkPeer('tls', 'hz.corp', 443, B).reason], [false, 'changed'],
    'observe 에서도 처음 보는 두 번째 지문은 거부(보안 유지)');
  const ap = pt.approvePeer('tls', 'hz.corp', 443, B, { by: 'admin1' });
  assert.equal(ap.ok, true);
  assert.equal(ap.trustedCount, 2, '승인은 추가 — 관찰 지문 A 는 남는다');
  assert.equal(pt.checkPeer('tls', 'hz.corp', 443, A).ok, true, 'B 승인 뒤에도 A 가 통과해야 한다(v2.730: changed)');
  assert.equal(pt.checkPeer('tls', 'hz.corp', 443, B).reason, 'approved');
  assert.equal(pt.checkPeer('tls', 'hz.corp', 443, C).reason, 'changed');
  assert.equal(pt.approvePeer('tls', 'hz.corp', 443, C, { by: 'admin1' }).ok, true);
  // A→B→A→C→B→C→A — 전부 통과(verify-A1 재현 순서)
  for (const fp of [A, B, A, C, B, C, A]) assert.equal(pt.checkPeer('tls', 'hz.corp', 443, fp).ok, true, fp);
  const e = pt.listPeers({ kind: 'tls' }).find((x) => x.host === 'hz.corp');
  assert.deepEqual(e.trustedList.map((t) => t.fp), [A, B, C]);
  assert.deepEqual(e.trustedList.map((t) => t.state), ['observed', 'approved', 'approved']);
  assert.equal(e.state, 'observed', '미승인(관찰) 지문이 남아 있으면 행 상태는 관찰(미승인)');
  // 일괄 승인은 관찰 지문 A 를 승인한다 — 그 뒤 enforce 로 바꿔도 셋 다 통과
  assert.equal(pt.approveAllObserved('tls', { by: 'admin1' }).approved, 1);
  assert.equal(pt.setPeerPolicy('tls', 'enforce', { by: 'owner' }).ok, true);
  for (const fp of [A, B, C]) assert.equal(pt.checkPeer('tls', 'hz.corp', 443, fp).reason, 'approved', fp);
  assert.equal(pt.listPeers({ kind: 'tls' }).find((x) => x.host === 'hz.corp').state, 'approved');
  assert.equal(pt.peerTrustStatus().kinds.tls.counts.approved, 1, '개수는 장비(항목) 단위');
});

test('A1-01 ② enforce — 승인 누적 · peek 은 집합 안이면 approved · 다른 지문은 changed + 감사 1회', () => {
  const A = FP('A'); const B = FP('B'); const D = FP('D');
  assert.equal(pt.getPeerPolicy('ssh').mode, 'enforce');
  pt.approvePeer('ssh', 'arr1', 22, A, { by: 'a' });
  pt.approvePeer('ssh', 'arr1', 22, B, { by: 'a' });
  assert.equal(pt.checkPeer('ssh', 'arr1', 22, A).reason, 'approved');
  assert.equal(pt.checkPeer('ssh', 'arr1', 22, B).reason, 'approved');
  const pk = pt.peekPeer('ssh', 'arr1', 22, B);
  assert.deepEqual([pk.state, pk.wouldPass], ['approved', true]);
  assert.deepEqual(pk.trustedFps, [A, B]);
  assert.equal(pt.peekPeer('ssh', 'arr1', 22, D).state, 'changed');
  const before = auditLines().length;
  assert.equal(pt.checkPeer('ssh', 'arr1', 22, D).reason, 'changed');
  pt.checkPeer('ssh', 'arr1', 22, D);
  const au = auditLines().slice(before).filter((x) => x.action === '장비 키 변경 감지(연결 거부)');
  assert.equal(au.length, 1);
  assert.ok(au[0].detail.includes(A) && au[0].detail.includes(B) && au[0].detail.includes(D), au[0].detail);
  // 같은 지문 재승인은 중복으로 쌓지 않는다
  assert.equal(pt.approvePeer('ssh', 'arr1', 22, A, { by: 'a' }).trustedCount, 2);
});

test('A1-01 ③ 개별 지문 회수(거부) — 다른 승인 지문은 그대로 · 승인하면 거부 목록에서 빠진다', () => {
  const A = FP('A'); const B = FP('B'); const C = FP('C');
  for (const fp of [A, B, C]) pt.approvePeer('ssh', 'lb', 22, fp, { by: 'a' });
  const r = pt.rejectPeer('ssh', 'lb', 22, B, { by: 'a' });
  assert.equal(r.ok, true);
  assert.equal(r.revoked, true, '승인 지문을 회수했다는 사실을 돌려준다');
  assert.equal(pt.checkPeer('ssh', 'lb', 22, B).reason, 'rejected');
  assert.equal(pt.checkPeer('ssh', 'lb', 22, A).reason, 'approved');
  assert.equal(pt.checkPeer('ssh', 'lb', 22, C).reason, 'approved');
  assert.deepEqual(pt.listPeers({ kind: 'ssh' })[0].trustedList.map((t) => t.fp), [A, C]);
  // 첫 지문(저장 파일의 trusted 객체)을 회수해도 나머지가 남는다
  assert.equal(pt.rejectPeer('ssh', 'lb', 22, A, { by: 'a' }).revoked, true);
  assert.equal(pt.checkPeer('ssh', 'lb', 22, C).reason, 'approved');
  assert.equal(JSON.parse(fs.readFileSync(FILE(), 'utf8')).entries[0].trusted.fp, C, '남은 지문이 첫 자리로 올라간다');
  // 회수한 지문을 다시 승인하면 통과
  assert.equal(pt.approvePeer('ssh', 'lb', 22, B, { by: 'a' }).ok, true);
  assert.equal(pt.checkPeer('ssh', 'lb', 22, B).reason, 'approved');
  // 대기 지문 거부(회수 아님)
  pt.checkPeer('ssh', 'lb', 22, FP('Z'));
  assert.equal(pt.rejectPeer('ssh', 'lb', 22, null, { by: 'a' }).revoked, false);
});

test('A1-01 ④ 교체(replace)는 명시 옵션 — 이전 지문은 신뢰하지 않고 prevFp 로 남는다', () => {
  const A = FP('A'); const B = FP('B'); const C = FP('C');
  pt.approvePeer('ssh', 'sw1', 22, A, { by: 'a' });
  pt.approvePeer('ssh', 'sw1', 22, B, { by: 'a' });
  const r = pt.approvePeer('ssh', 'sw1', 22, C, { by: 'a', replace: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.replaced, [A, B]);
  assert.equal(r.trustedCount, 1);
  assert.equal(pt.checkPeer('ssh', 'sw1', 22, A).reason, 'changed');
  assert.equal(pt.checkPeer('ssh', 'sw1', 22, B).reason, 'changed');
  assert.equal(pt.checkPeer('ssh', 'sw1', 22, C).reason, 'approved');
  const e = pt.listPeers({ kind: 'ssh' })[0];
  assert.equal(e.trusted.fp, C); assert.equal(e.trusted.prevFp, A);
});

test('A1-01 ⑤ 상한 — 한 장비 승인 지문 8개를 넘기면 거부(조용히 오래된 것을 지우지 않는다)', () => {
  const fps = 'ABCDEFGHI'.split('').map(FP);
  for (const fp of fps.slice(0, 8)) assert.equal(pt.approvePeer('ssh', 'big', 22, fp, { by: 'a' }).ok, true, fp);
  const r = pt.approvePeer('ssh', 'big', 22, fps[8], { by: 'a' });
  assert.deepEqual([r.ok, r.error], [false, 'trusted-full']);
  for (const fp of fps.slice(0, 8)) assert.equal(pt.checkPeer('ssh', 'big', 22, fp).reason, 'approved', fp);
  assert.equal(pt.approvePeer('ssh', 'big', 22, fps[0], { by: 'a' }).ok, true, '이미 있는 지문의 재승인은 상한과 무관');
  assert.equal(pt.approvePeer('ssh', 'big', 22, fps[8], { by: 'a', replace: true }).ok, true, '교체는 상한과 무관');
});

test('A1-01 ⑥ 옛 저장 형식(trusted 객체 1개)을 읽는다 · 저장 파일의 trusted 는 객체 그대로(되돌림 설치 호환)', () => {
  const A = FP('A'); const B = FP('B');
  fs.writeFileSync(FILE(), JSON.stringify({
    v: 1, policy: { ssh: 'enforce', tls: 'enforce' }, origin: {},
    entries: [{ kind: 'ssh', host: 'old1', port: 22, trusted: { fp: A, state: 'approved', at: 1, by: 'x', prevFp: FP('Q') }, firstSeen: 1, lastSeen: 2, lastSeenCount: 3 }],
  }));
  pt._resetPeerTrustForTest();
  assert.equal(pt.checkPeer('ssh', 'old1', 22, A).reason, 'approved');
  assert.equal(pt.checkPeer('ssh', 'old1', 22, B).reason, 'changed');
  pt.approvePeer('ssh', 'old1', 22, B, { by: 'y' });
  const disk = JSON.parse(fs.readFileSync(FILE(), 'utf8')).entries[0];
  assert.equal(typeof disk.trusted, 'object'); assert.ok(!Array.isArray(disk.trusted));
  assert.equal(disk.trusted.fp, A, '첫 지문(옛 판본이 읽는 자리)은 그대로');
  assert.deepEqual(disk.trustedMore.map((t) => t.fp), [B]);
  pt._resetPeerTrustForTest();
  assert.equal(pt.checkPeer('ssh', 'old1', 22, A).reason, 'approved', '파일에서 다시 읽어도 둘 다 승인');
  assert.equal(pt.checkPeer('ssh', 'old1', 22, B).reason, 'approved');
  // 손으로 고친 파일 — 중복·형식이 틀린 지문은 버린다
  const obj = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  obj.entries[0].trustedMore = [{ fp: B, state: 'approved' }, { fp: 'garbage', state: 'approved' }, null, { fp: A, state: 'approved' }];
  fs.writeFileSync(FILE(), JSON.stringify(obj));
  pt._resetPeerTrustForTest();
  assert.deepEqual(pt.listPeers({ kind: 'ssh' })[0].trustedList.map((t) => t.fp), [A, B]);
});

/* ─────────── 관리 API(실제 라우터) ─────────── */
async function withApp(user, fn) {
  const express = (await import('express')).default;
  const { registerPeerTrust } = await import('../src/routes/admin/peerTrust.js');
  const { wrapAsyncRouter } = await import('../src/util/asyncRoute.js');
  const r = express.Router();
  wrapAsyncRouter(r);
  registerPeerTrust(r);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api/admin', r);
  const srv = http.createServer(app);
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${srv.address().port}/api/admin/security/peer-trust`;
  const call = async (p, method = 'GET', body) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  try { return await fn(call); } finally { await new Promise((res) => srv.close(res)); }
}
const ADMIN = { username: 'admin1', role: 'admin', scope: { vcenters: [], regions: [] } };

test('A1-01 ⑦ API — 기본 승인은 추가(감사 detail 이 말한다) · replace:true 는 교체 · 상한 400 · 회수는 감사에 회수로', async () => {
  const A = FP('A'); const B = FP('B');
  pt.approvePeer('ssh', 'lb9', 22, A, { by: 'x' });
  pt.checkPeer('ssh', 'lb9', 22, B);
  await withApp(ADMIN, async (call) => {
    const before = auditLines().length;
    let r = await call('/approve', 'POST', { kind: 'ssh', host: 'lb9', port: 22, confirmVerified: true });
    assert.equal(r.status, 200); assert.equal(r.body.fp, B); assert.equal(r.body.trustedCount, 2);
    let a = auditLines().slice(before).find((x) => x.action === '장비 신뢰 지문 승인');
    assert.match(a.detail, /추가/); assert.doesNotMatch(a.detail, /교체/);
    assert.equal(pt.checkPeer('ssh', 'lb9', 22, A).reason, 'approved', 'API 기본 승인 뒤에도 A 는 신뢰');
    const g = await call('?kind=ssh');
    assert.deepEqual(g.body.peers[0].trustedList.map((t) => t.fp), [A, B]);
    // 회수(거부) — 감사 detail 이 '회수' 를 말한다
    const b2 = auditLines().length;
    r = await call('/reject', 'POST', { kind: 'ssh', host: 'lb9', port: 22, fp: A });
    assert.equal(r.status, 200); assert.equal(r.body.revoked, true);
    a = auditLines().slice(b2).find((x) => x.action === '장비 신뢰 지문 거부');
    assert.match(a.detail, /회수/);
    // 교체
    const C = FP('C');
    r = await call('/approve', 'POST', { kind: 'ssh', host: 'lb9', port: 22, fp: C, replace: true, confirmVerified: true });
    assert.equal(r.status, 200); assert.equal(r.body.trustedCount, 1);
    assert.equal(pt.checkPeer('ssh', 'lb9', 22, B).reason, 'changed');
    // 상한
    for (const c of 'DEFGHIJ') await call('/approve', 'POST', { kind: 'ssh', host: 'lb9', port: 22, fp: FP(c), confirmVerified: true });
    r = await call('/approve', 'POST', { kind: 'ssh', host: 'lb9', port: 22, fp: FP('K'), confirmVerified: true });
    assert.equal(r.status, 400); assert.equal(r.body.code, 'trusted-full'); assert.match(r.body.reason, /8개/);
    // 승인 화면이 있는 노드(A1-02) — GET 응답이 말한다
    assert.equal(g.body.node?.edge, false);
  });
});

/* ─────────── A1-02 거부 문구의 승인 노드 ─────────── */
function fakeTlsSocket(fp) {
  return {
    isSessionReused: () => false,
    getPeerCertificate: () => ({ fingerprint256: fp, subject: { CN: 'x' }, issuer: { CN: 'x' }, valid_to: '' }),
    authorized: false,
    authorizationError: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' },
  };
}

test('A1-02 ① 중앙(CENTRAL_URL 없음) — 이 포탈에서 승인 · 표지는 그대로', () => {
  config.agent.centralUrl = '';
  const e = sx.sshHostKeyError({ reason: 'unknown', fp: FP('A'), algo: 'ssh-ed25519' });
  assert.match(e.message, /설정 › 장비 신뢰/);
  assert.match(e.message, /이 포탈/);
  assert.doesNotMatch(e.message, /엣지/);
  assert.ok(e.message.endsWith('[SSH_HOSTKEY_UNTRUSTED]'));
  const v = T.judgeTlsSocket(fakeTlsSocket(TFP('AB')), { subsystem: 'g1test', mode: 'verify', host: 'vc.corp', port: 443 });
  assert.equal(v.ok, false);
  assert.match(v.error.message, /장비 인증서를 신뢰할 수 없어 연결을 끊었습니다/);
  assert.match(v.error.message, /이 포탈/);
  assert.doesNotMatch(v.error.message, /엣지/);
  assert.equal(v.error.code, 'ERR_TLS_PEER_UNTRUSTED');
});

test('A1-02 ② 엣지(CENTRAL_URL 설정) — 그 엣지 이름과 "중앙에서는 승인할 수 없다" 를 싣는다', async () => {
  config.agent.centralUrl = 'https://central.corp';
  config.agent.name = 'Edge-Seoul';
  const e = sx.sshHostKeyError({ reason: 'unknown', fp: FP('A'), algo: 'ssh-ed25519' });
  assert.match(e.message, /엣지 ‘Edge-Seoul’ 포탈의 설정 › 장비 신뢰/);
  assert.match(e.message, /중앙 포탈에서는 승인할 수 없습니다/);
  assert.ok(isPeerRejectText(e.message)); assert.equal(isAuthFailureText(e.message), false);
  assert.equal(sx.isSshAuthError(e), false);
  const v = T.judgeTlsSocket(fakeTlsSocket(TFP('CD')), { subsystem: 'g1test', mode: 'verify', host: 'arr.corp', port: 443 });
  assert.match(v.error.message, /엣지 ‘Edge-Seoul’ 포탈의 설정 › 장비 신뢰/);
  assert.match(v.error.message, /중앙 포탈에서는 승인할 수 없습니다/);
  assert.ok(isPeerRejectText(v.error.message));
  await withApp(ADMIN, async (call) => {
    const g = await call('');
    assert.deepEqual([g.body.node?.edge, g.body.node?.name], [true, 'Edge-Seoul']);
  });
});

test('A1-02 ③ 엣지 이름이 인증 판정 낱말(401·403·404·authentication)을 담으면 이름을 싣지 않는다', () => {
  config.agent.centralUrl = 'https://central.corp';
  for (const bad of ['edge-401', 'site 403', 'x-404', 'authentication-fail-edge', 'Login-Edge']) {
    config.agent.name = bad;
    const e = sx.sshHostKeyError({ reason: 'unknown', fp: FP('A') });
    assert.ok(!e.message.includes(bad), `${JSON.stringify(bad)} 가 문구에 실렸다`);
    assert.match(e.message, /엣지 포탈의 설정 › 장비 신뢰/);
    assert.doesNotMatch(e.message, /\b40[134]\b/);
  }
  config.agent.name = 'a\u0000b\nc';
  assert.match(sx.sshHostKeyError({ reason: 'unknown', fp: FP('A') }).message, /엣지 ‘abc’ 포탈/, '제어 문자는 지운다');
  config.agent.name = 'Edge-' + 'x'.repeat(200);
  assert.ok(sx.sshHostKeyError({ reason: 'unknown', fp: FP('A') }).message.length < 700, '이름 길이 상한');
});

test('A1-02 ④ changed 문구는 같은 주소 뒤 여러 서버(로드밸런서)일 수 있음을 말한다', () => {
  const e = sx.sshHostKeyError({ reason: 'changed', fp: FP('A') });
  assert.match(e.message, /로드밸런서/);
  pt.approvePeer('tls', 'lb.corp', 443, TFP('11'), { by: 'a' });
  const v = T.judgeTlsSocket(fakeTlsSocket(TFP('22')), { subsystem: 'g1test', mode: 'verify', host: 'lb.corp', port: 443 });
  assert.equal(v.reason, 'changed');
  assert.match(v.error.message, /로드밸런서/);
});

/* ─────────── A6-06 처음 보는 장비 기록은 묶어서 쓴다(바뀐 지문·관리자 동작은 즉시) ─────────── */
const diskHosts = () => { try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')).entries.map((x) => x.host); } catch { return null; } };

test('A6-06 ① 처음 보는 장비(관찰·대기)는 즉시 파일 전체를 다시 쓰지 않는다 — flush·종료 flush 로 한 번에 쓴다', async () => {
  asUpgrade(); // observe
  pt.getPeerPolicy('ssh'); // 기본 정책 저장(파일 생성)
  const before = fs.statSync(FILE()).mtimeMs;
  const raw0 = fs.readFileSync(FILE(), 'utf8');
  for (let i = 0; i < 50; i++) assert.equal(pt.checkPeer('ssh', `new-${i}`, 22, FP(String.fromCharCode(65 + (i % 26)))).reason, 'observed-new');
  assert.equal(fs.readFileSync(FILE(), 'utf8'), raw0, '관찰 50대가 장비마다 파일을 다시 쓰면 안 된다');
  assert.equal(fs.statSync(FILE()).mtimeMs, before);
  pt.flushPeerTrust();
  assert.equal(diskHosts().filter((h) => h.startsWith('new-')).length, 50, 'flush 하면 한 번에 쓴다');
  // 종료 flush(exitFlush 레지스트리)에도 등록돼 있다 — 정상 종료가 미뤄 둔 기록을 잃지 않는다.
  const { exitFlushNames } = await import('../src/util/exitFlush.js');
  pt.checkPeer('ssh', 'late-1', 22, FP('Q'));
  assert.ok(exitFlushNames().includes('peer-trust'));
  assert.ok(!diskHosts().includes('late-1'));
  // 디바운스 타이머가 실제로 쓴다(지연 뒤)
  await new Promise((r) => setTimeout(r, 2300));
  assert.ok(diskHosts().includes('late-1'), '지연 뒤 저장되어야 한다');
});

test('A6-06 ② enforce 의 처음 보는 장비(unknown)도 묶어서 · 바뀐 지문(changed)과 승인은 즉시 쓴다', () => {
  pt.getPeerPolicy('ssh');
  const raw0 = fs.readFileSync(FILE(), 'utf8');
  assert.equal(pt.checkPeer('ssh', 'u1', 22, FP('A')).reason, 'unknown');
  assert.equal(fs.readFileSync(FILE(), 'utf8'), raw0, 'unknown 은 묶어서 쓴다');
  assert.equal(pt.approvePeer('ssh', 'u1', 22, null, { by: 'a' }).ok, true);
  assert.ok(diskHosts().includes('u1'), '관리자 승인은 즉시 쓴다');
  const before = JSON.stringify(JSON.parse(fs.readFileSync(FILE(), 'utf8')).entries.find((x) => x.host === 'u1').pending ?? null);
  assert.equal(before, 'null');
  assert.equal(pt.checkPeer('ssh', 'u1', 22, FP('B')).reason, 'changed');
  const disk = JSON.parse(fs.readFileSync(FILE(), 'utf8')).entries.find((x) => x.host === 'u1');
  assert.equal(disk.pending?.fp, FP('B'), '바뀐 지문(보안 사건)은 즉시 파일에 남는다');
});
