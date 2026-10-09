/**
 * test/rvH_peerTrust.test.js — 장비 신뢰 저장소(security/peerTrust.js)와 관리 API(routes/admin/peerTrust.js)
 * (2026-10-09 검토 S-01, 그룹 H).
 *
 * 고정하는 것:
 *  ① 호스트 정규화 — 대소문자·끝 점·IPv6 표기·대괄호는 같은 키, 비정규 IPv4(선행 0)는 **10진으로 접지 않고** 별개 키
 *     (실제 접속은 그것을 8진수로 읽는다), 포트가 다르면 다른 키(승계 없음)
 *  ② 새 설치 = enforce: 모르는 지문은 거부·대기 기록 · 승인 뒤 통과 · 바뀐 지문은 거부 + 감사 로그 · 교체 승인은 이전 지문을 남긴다
 *  ③ 기존 현장(장비 등록부가 있음) = observe: 처음 보는 지문은 '관찰' 로 통과, 바뀐 지문은 거부, 일괄 승인은 대기를 포함하지 않음,
 *     enforce 로 바꾸면 관찰 지문(미승인)은 거부
 *  ④ 거부 목록·삭제·env 강제·손상 파일(→ 두 종류 모두 enforce + 원본 보존)·peekPeer 무부작용·파일 왕복
 *  ⑤ 관리 API — admin + 전체 범위, 승인은 confirmVerified 필수, 정책은 설정 소유자, 변경은 감사 로그
 * ⚠ 기준 시각에 Date.now() 를 쓰지 않는다 — 시각 경계를 판정하지 않는다.
 */
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rvh-peertrust-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
delete process.env.SSH_HOSTKEY_POLICY;
delete process.env.TLS_PEER_POLICY;
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const pt = await import('../src/security/peerTrust.js');

const FP_A = 'SHA256:' + 'A'.repeat(43);
const FP_B = 'SHA256:' + 'B'.repeat(43);
const FP_C = 'SHA256:' + 'C'.repeat(43);
const TLS_A = 'AB:'.repeat(31) + 'AB';

function wipe() {
  for (const f of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, f), { recursive: true, force: true });
  pt._resetPeerTrustForTest();
}
const auditLines = () => { try { return fs.readFileSync(path.join(DIR, 'audit.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
beforeEach(() => { delete process.env.SSH_HOSTKEY_POLICY; wipe(); });

test('① 호스트 정규화 — 같은 장비 표기는 같은 키, 비정규 IPv4·다른 포트는 다른 키', () => {
  const k = (h, p) => pt.peerKey('ssh', h, p);
  assert.equal(k('Host.Example.COM.', 22), k('host.example.com', 22));
  assert.equal(k('::1', 22), k('[0:0:0:0:0:0:0:1]', 22));
  assert.equal(k('FE80::0001', 22), k('fe80::1', 22));
  assert.equal(k('host', undefined), k('host', 22), 'ssh 포트 기본 22');
  assert.equal(pt.peerKey('tls', 'h', undefined), pt.peerKey('tls', 'h', 443), 'tls 포트 기본 443');
  assert.notEqual(k('010.0.0.1', 22), k('10.0.0.1', 22), '선행 0 은 inet_aton 이 8진수로 읽는다 — 10.0.0.1 로 접으면 다른 목적지의 키가 섞인다');
  assert.notEqual(k('10.0.0.1', 22), k('10.0.0.1', 2222), '포트가 다르면 승계하지 않는다');
  assert.equal(pt.normalizePeerHost('a|b c'), 'abc', '키 구분자·공백 제거');
  assert.equal(pt.normalizeFingerprint('ssh', 'sha256:' + 'A'.repeat(43) + '='), FP_A);
  assert.equal(pt.normalizeFingerprint('ssh', 'MD5:aa'), '');
  assert.equal(pt.normalizeFingerprint('tls', TLS_A.replace(/:/g, '').toLowerCase()), TLS_A);
});

test('② 새 설치 = enforce — 모르는 지문 거부 · 승인 뒤 통과 · 변경 거부 + 감사 · 교체 승인', () => {
  assert.equal(pt.getPeerPolicy('ssh').mode, 'enforce');
  assert.equal(pt.getPeerPolicy('ssh').origin, 'new-install');
  let r = pt.checkPeer('ssh', 'sw1', 22, FP_A, { algo: 'ssh-ed25519' });
  assert.deepEqual([r.ok, r.reason], [false, 'unknown']);
  r = pt.checkPeer('ssh', 'sw1', 22, FP_A);
  assert.equal(r.ok, false);
  const e0 = pt.listPeers({ kind: 'ssh' })[0];
  assert.equal(e0.state, 'pending');
  assert.equal(e0.pending.fp, FP_A);
  assert.equal(e0.pending.algo, 'ssh-ed25519');
  assert.equal(e0.history.length, 1, '같은 대기 지문은 이력을 한 번만 남긴다');

  const ap = pt.approvePeer('ssh', 'SW1', 22, null, { by: 'admin1' });
  assert.equal(ap.ok, true); assert.equal(ap.fp, FP_A); assert.equal(ap.matchedPresented, true);
  r = pt.checkPeer('ssh', 'sw1.', 22, FP_A);
  assert.deepEqual([r.ok, r.reason], [true, 'approved']);

  const before = auditLines().length;
  r = pt.checkPeer('ssh', 'sw1', 22, FP_B);
  assert.deepEqual([r.ok, r.reason], [false, 'changed']);
  pt.checkPeer('ssh', 'sw1', 22, FP_B);
  const au = auditLines().slice(before);
  assert.equal(au.filter((a) => a.action === '장비 키 변경 감지(연결 거부)').length, 1, '바뀐 지문은 감사 로그에 1회');
  assert.match(au[0].detail, new RegExp(`${FP_A.slice(0, 20)}.*${FP_B.slice(0, 20)}`));
  assert.equal(pt.peerTrustStatus().kinds.ssh.counts.pendingChanged, 1);

  const ap2 = pt.approvePeer('ssh', 'sw1', 22, FP_B, { by: 'admin1' });
  assert.equal(ap2.ok, true);
  const e1 = pt.listPeers({ kind: 'ssh' })[0];
  assert.equal(e1.trusted.fp, FP_B); assert.equal(e1.trusted.prevFp, FP_A); assert.equal(e1.pending, undefined);
  assert.equal(pt.checkPeer('ssh', 'sw1', 22, FP_A).reason, 'changed', '교체 뒤 옛 지문은 바뀐 지문이다');
  assert.equal(pt.checkPeer('ssh', 'sw1', 2222, FP_B).reason, 'unknown', '다른 포트에는 승인이 승계되지 않는다');
  assert.equal(pt.checkPeer('ssh', 'sw1', 22, 'garbage').reason, 'bad-fingerprint');
});

test('③ 기존 현장 = observe — 관찰 통과 · 변경 거부 · 일괄 승인은 대기 제외 · enforce 전환 후 관찰 지문 거부', () => {
  fs.writeFileSync(path.join(DIR, 'storage-devices.json'), JSON.stringify({ devices: [{ id: 'x' }] }));
  pt._resetPeerTrustForTest();
  const pol = pt.getPeerPolicy('ssh');
  assert.equal(pol.mode, 'observe'); assert.equal(pol.origin, 'upgrade-migration');
  let r = pt.checkPeer('ssh', 'arr1', 22, FP_A);
  assert.deepEqual([r.ok, r.reason], [true, 'observed-new']);
  assert.equal(pt.checkPeer('ssh', 'arr1', 22, FP_A).reason, 'observed');
  r = pt.checkPeer('ssh', 'arr1', 22, FP_B);
  assert.deepEqual([r.ok, r.reason], [false, 'changed'], 'observe 에서도 바뀐 지문은 거부');
  assert.equal(pt.checkPeer('ssh', 'arr2', 22, FP_C).ok, true);
  const bulk = pt.approveAllObserved('ssh', { by: 'admin1' });
  assert.equal(bulk.approved, 2);
  const arr1 = pt.listPeers({ kind: 'ssh' }).find((e) => e.host === 'arr1');
  assert.equal(arr1.trusted.state, 'approved'); assert.equal(arr1.trusted.fp, FP_A);
  assert.equal(arr1.pending.fp, FP_B, '바뀐 지문(대기)은 일괄 승인에 포함되지 않는다');

  assert.equal(pt.checkPeer('ssh', 'arr3', 22, FP_A).reason, 'observed-new');
  assert.equal(pt.setPeerPolicy('ssh', 'enforce', { by: 'owner' }).ok, true);
  r = pt.checkPeer('ssh', 'arr3', 22, FP_A);
  assert.deepEqual([r.ok, r.reason], [false, 'not-approved'], 'enforce 에서 관찰 지문은 승인 전까지 통과하지 않는다');
  assert.equal(pt.checkPeer('ssh', 'arr2', 22, FP_C).reason, 'approved');
  assert.equal(pt.checkPeer('ssh', 'new-one', 22, FP_C).reason, 'unknown');
});

test('④-a 거부 목록 — 정책과 무관하게 통과하지 못한다 · 삭제하면 처음 보는 장비', () => {
  pt.setPeerPolicy('ssh', 'observe');
  assert.equal(pt.checkPeer('ssh', 'h', 22, FP_A).ok, true);
  assert.equal(pt.rejectPeer('ssh', 'h', 22, FP_A, { by: 'a' }).ok, true);
  assert.equal(pt.checkPeer('ssh', 'h', 22, FP_A).reason, 'rejected');
  assert.equal(pt.peekPeer('ssh', 'h', 22, FP_A).state, 'rejected');
  assert.equal(pt.removePeer('ssh', 'h', 22).ok, true);
  assert.equal(pt.checkPeer('ssh', 'h', 22, FP_A).reason, 'observed-new');
  assert.equal(pt.removePeer('ssh', 'nope', 22).ok, false);
});

test('④-b env 가 정책을 강제하면 화면 변경은 env-forced', () => {
  process.env.SSH_HOSTKEY_POLICY = 'observe';
  assert.deepEqual([pt.getPeerPolicy('ssh').mode, pt.getPeerPolicy('ssh').source], ['observe', 'env']);
  assert.equal(pt.setPeerPolicy('ssh', 'enforce').error, 'env-forced');
  assert.equal(pt.getPeerPolicy('tls').mode, 'enforce', '다른 종류에는 영향 없음');
});

test('④-c 손상 파일 — 원본 보존 + 두 종류 모두 enforce(관찰로 열지 않는다)', () => {
  fs.writeFileSync(path.join(DIR, 'storage-devices.json'), '{"devices":[{"id":"x"}]}');
  fs.writeFileSync(path.join(DIR, 'peer-trust.json'), '{"v":1,"policy":{"ssh":"observe"},"entries":[');
  pt._resetPeerTrustForTest();
  const st = pt.peerTrustStatus();
  assert.equal(st.loadError?.code, 'corrupt');
  assert.equal(st.kinds.ssh.policy.mode, 'enforce');
  assert.equal(st.kinds.tls.policy.mode, 'enforce');
  assert.ok(fs.readdirSync(DIR).some((n) => n.startsWith('peer-trust.json.corrupt.')), '손상 원본 보존');
  assert.equal(pt.checkPeer('ssh', 'h', 22, FP_A).ok, false);
});

test('④-d peekPeer 는 상태를 바꾸지 않는다 · 파일 왕복', () => {
  pt.approvePeer('ssh', 'h1', 22, FP_A, { by: 'a' });
  pt.approvePeer('tls', 'vc1', 443, TLS_A, { by: 'a' });
  const file = path.join(DIR, 'peer-trust.json');
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(pt.peekPeer('ssh', 'h1', 22, FP_A).state, 'approved');
  assert.equal(pt.peekPeer('ssh', 'h1', 22, FP_B).state, 'changed');
  assert.equal(pt.peekPeer('ssh', 'other', 22, FP_A).state, 'unknown');
  assert.equal(pt.peekPeer('ssh', 'h1', 22, FP_B).wouldPass, false);
  assert.equal(fs.readFileSync(file, 'utf8'), raw, 'peek 은 파일을 쓰지 않는다');
  assert.equal(pt.listPeers().length, 2, 'peek 은 항목을 만들지 않는다');
  pt._resetPeerTrustForTest();
  assert.equal(pt.checkPeer('tls', 'VC1', 443, TLS_A.toLowerCase()).reason, 'approved', '파일에서 다시 읽어도 같다');
  assert.equal(pt.checkPeer('ssh', 'h1', 22, FP_A).reason, 'approved');
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
});

test('④-e 연결마다 바뀌는 값은 last* 이름 — 백업 변경 감시(RUN_FIELD_RE)가 빼는 필드', () => {
  pt.approvePeer('ssh', 'h2', 22, FP_A, { by: 'a' });
  pt.checkPeer('ssh', 'h2', 22, FP_A); pt.checkPeer('ssh', 'h2', 22, FP_A);
  const e = pt.listPeers({ kind: 'ssh' }).find((x) => x.host === 'h2');
  assert.equal(e.lastSeenCount, 2);
  assert.equal('seenCount' in e, false);
  const RUN_FIELD_RE = /^(last[A-Z]|useCount$)/; // backup/service.js 와 같은 규칙
  const changing = ['lastSeen', 'lastSeenCount'];
  for (const k of changing) assert.ok(RUN_FIELD_RE.test(k), `${k} 는 실행 필드여야 한다`);
  // 옛 이름(seenCount)으로 저장된 파일도 옮겨 읽는다.
  const file = path.join(DIR, 'peer-trust.json');
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  obj.entries = obj.entries.map((x) => { const { lastSeenCount, ...r } = x; return { ...r, seenCount: 7 }; });
  fs.writeFileSync(file, JSON.stringify(obj));
  pt._resetPeerTrustForTest();
  assert.equal(pt.listPeers({ kind: 'ssh' }).find((x) => x.host === 'h2').lastSeenCount, 7);
});

/* ─────────── ⑤ 관리 API(실제 라우터) ─────────── */
async function withApp(user, fn) {
  const express = (await import('express')).default;
  const { Router } = express;
  const { registerPeerTrust } = await import('../src/routes/admin/peerTrust.js');
  const { wrapAsyncRouter } = await import('../src/util/asyncRoute.js');
  const r = Router();
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
const OWNER = { username: 'noainred', role: 'admin', superAdmin: true, scope: { vcenters: [], regions: [] } };

test('⑤-a 조회·변경은 admin + 전체 범위만', async () => {
  pt.checkPeer('ssh', 'sw9', 22, FP_A);
  await withApp({ username: 'op', role: 'operator', scope: {} }, async (call) => {
    assert.equal((await call('')).status, 403);
    assert.equal((await call('/approve', 'POST', { kind: 'ssh', host: 'sw9', port: 22, confirmVerified: true })).status, 403);
  });
  await withApp({ username: 'sa', role: 'admin', scope: { vcenters: ['vc-1'], regions: [] } }, async (call) => {
    assert.equal((await call('')).status, 403, '범위 제한 admin 거부');
  });
  await withApp(ADMIN, async (call) => {
    const g = await call('?kind=ssh');
    assert.equal(g.status, 200);
    assert.equal(g.body.peers[0].pending.fp, FP_A);
    assert.equal(g.body.status.kinds.ssh.policy.mode, 'enforce');
    // TLS 탭 원천(그룹 I tlsTrust.js 의 상태)도 같은 응답에 — admin + 전체 범위 게이트 뒤에서만 나간다.
    assert.ok(g.body.tls && typeof g.body.tls === 'object', 'tls 상태가 실린다');
    assert.ok(g.body.tls.caBundle && 'present' in g.body.tls.caBundle, '사설 CA 번들 상태');
    assert.ok(Array.isArray(g.body.tls.subsystems) && Array.isArray(g.body.tls.recentRejects) && Array.isArray(g.body.tls.exceptions));
    assert.equal(g.body.tlsError, null);
  });
});

test('⑤-b 승인은 confirmVerified 필수 · 형식 검사 · 감사 로그(교체 시 이전 지문)', async () => {
  pt.approvePeer('ssh', 'sw9', 22, FP_A, { by: 'x' });
  pt.checkPeer('ssh', 'sw9', 22, FP_B);
  await withApp(ADMIN, async (call) => {
    let r = await call('/approve', 'POST', { kind: 'ssh', host: 'sw9', port: 22 });
    assert.equal(r.status, 400); assert.equal(r.body.field, 'confirmVerified');
    r = await call('/approve', 'POST', { kind: 'ssh', host: 'sw9 |x', port: 22, confirmVerified: true });
    assert.equal(r.body.field, 'host');
    r = await call('/approve', 'POST', { kind: 'ssh', host: 'sw9', port: 70000, confirmVerified: true });
    assert.equal(r.body.field, 'port');
    r = await call('/approve', 'POST', { kind: 'ssh', host: 'sw9', port: 22, fp: 'nope', confirmVerified: true });
    assert.equal(r.body.field, 'fp');
    const before = auditLines().length;
    r = await call('/approve', 'POST', { kind: 'ssh', host: 'sw9', port: 22, confirmVerified: true });
    assert.equal(r.status, 200); assert.equal(r.body.fp, FP_B);
    const a = auditLines().slice(before).find((x) => x.action === '장비 신뢰 지문 승인');
    assert.ok(a, '승인은 감사 로그에 남는다');
    assert.equal(a.user, 'admin1');
    assert.match(a.detail, /이전 SHA256:A{10}.*교체/);
    r = await call('/reject', 'POST', { kind: 'ssh', host: 'sw9', port: 22, fp: FP_A });
    assert.equal(r.status, 200);
    assert.equal(pt.checkPeer('ssh', 'sw9', 22, FP_A).reason, 'rejected');
    r = await call('/remove', 'POST', { kind: 'ssh', host: 'sw9', port: 22 });
    assert.equal(r.status, 200);
    r = await call('/remove', 'POST', { kind: 'ssh', host: 'sw9', port: 22 });
    assert.equal(r.status, 404);
  });
});

test('⑤-c 정책 변경은 설정 소유자만 · 관찰 일괄 승인은 확인 필수', async () => {
  await withApp(ADMIN, async (call) => {
    const r = await call('/policy', 'PUT', { kind: 'ssh', mode: 'observe' });
    assert.equal(r.status, 403); assert.equal(r.body.requiredOwner, true);
  });
  await withApp(OWNER, async (call) => {
    let r = await call('/policy', 'PUT', { kind: 'ssh', mode: 'bogus' });
    assert.equal(r.status, 400);
    r = await call('/policy', 'PUT', { kind: 'ssh', mode: 'observe' });
    assert.equal(r.status, 200); assert.equal(r.body.policy.mode, 'observe');
    assert.ok(auditLines().some((a) => a.action === '장비 신뢰 정책 변경' && a.detail === 'observe'));
    pt.checkPeer('ssh', 'o1', 22, FP_A);
    r = await call('/approve-observed', 'POST', { kind: 'ssh' });
    assert.equal(r.status, 400);
    r = await call('/approve-observed', 'POST', { kind: 'ssh', confirmVerified: true });
    assert.equal(r.status, 200); assert.equal(r.body.approved, 1);
    process.env.SSH_HOSTKEY_POLICY = 'enforce';
    r = await call('/policy', 'PUT', { kind: 'ssh', mode: 'observe' });
    assert.equal(r.status, 409); assert.equal(r.body.code, 'env-forced');
  });
});
