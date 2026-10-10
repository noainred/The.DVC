/**
 * test/audit2732i3_peerTrustRoute.test.js — 점검 2회차(v2.732) 그룹 i3: 장비 신뢰 관리 API 가 '쓸 수 없음'(B4-03 writeBlocked)을
 * 사유와 함께 409 로 말하는가.
 *
 * 배경: v2.732 그룹 e 가 peer-trust.json 을 읽지 못했고 원본도 옮기지 못하면 관리자 동작(승인·거부·삭제·관찰 일괄 승인·정책)을
 * **메모리를 바꾸기 전에** 거절하게 했다(security/peerTrust.js assertWritable — status 409 · code 'peer-trust-unwritable').
 * 그런데 라우트가 그 오류를 잡지 않아 전역 오류 처리기(index.js)가 `{ok:false, error:'bad request'}` 로 바꿨다 — 화면은 사유 없이
 * '처리하지 못했습니다' 만 보였다(권한·재시작 조치를 말하지 못한다). 이 테스트는 실제 라우터를 띄우고 index.js 와 같은 모양의
 * 전역 오류 처리기를 붙여, 다섯 경로 모두 409 + reason + code 를 받는지 본다. 쓸 수 있는 정상 경로는 그대로 200 이다.
 * fs 는 그 파일에 한해서만 막는다(root 로는 EACCES 를 만들 수 없다 — audit2732e_peerTrust 와 같은 방법).
 */
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a2732i3-peer-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'false';
delete process.env.SSH_HOSTKEY_POLICY;
delete process.env.TLS_PEER_POLICY;
delete process.env.CENTRAL_URL;

const pt = await import('../src/security/peerTrust.js');
const FILE = path.join(DIR, 'peer-trust.json');
const FP_A = 'SHA256:' + 'A'.repeat(43);
const FP_B = 'SHA256:' + 'B'.repeat(43);

const realRead = fs.readFileSync;
const realRename = fs.renameSync;
function unpatch() { fs.readFileSync = realRead; fs.renameSync = realRename; }
function blockFile() {
  fs.readFileSync = function (p, ...a) {
    if (String(p) === FILE) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; }
    return realRead.call(fs, p, ...a);
  };
  fs.renameSync = function (from, to) {
    if (String(from) === FILE) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; }
    return realRename.call(fs, from, to);
  };
}
function wipe() {
  unpatch();
  for (const f of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, f), { recursive: true, force: true });
  pt._resetPeerTrustForTest();
}
beforeEach(wipe);
after(() => {
  unpatch();
  try { pt.flushPeerTrust(); } catch { /* */ }
  pt._resetPeerTrustForTest();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

function seedOriginal() {
  const orig = { v: 1, policy: { ssh: 'enforce', tls: 'enforce' }, origin: {}, entries: [
    { kind: 'ssh', host: '10.0.0.5', port: 22, trusted: { fp: FP_A, state: 'approved', at: 1 } },
  ] };
  fs.writeFileSync(FILE, JSON.stringify(orig), { mode: 0o600 });
  return JSON.stringify(orig);
}

const ADMIN = { username: 'admin1', role: 'admin', scope: { vcenters: [], regions: [] } };

async function withApp(fn) {
  const express = (await import('express')).default;
  const { registerPeerTrust } = await import('../src/routes/admin/peerTrust.js');
  const { wrapAsyncRouter } = await import('../src/util/asyncRoute.js');
  const r = express.Router();
  wrapAsyncRouter(r);
  registerPeerTrust(r);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = ADMIN; next(); });
  app.use('/api/admin', r);
  // index.js 전역 오류 처리기와 같은 모양 — 라우트가 잡지 않은 오류는 사유 없이 'bad request' 가 된다.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = Number(err?.status || err?.statusCode) || 500;
    res.status(status).json({ ok: false, error: status >= 400 && status < 500 ? 'bad request' : 'internal error' });
  });
  const srv = http.createServer(app);
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${srv.address().port}/api/admin/security/peer-trust`;
  const call = async (p, method = 'GET', body) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  try { return await fn(call); } finally { await new Promise((res) => srv.close(res)); }
}

test('① 쓸 수 없는 동안(writeBlocked) 관리 동작 5가지 — 409 + 사유 + code (전역 처리기의 bad request 가 아니다)', async () => {
  const orig = seedOriginal();
  blockFile();
  pt._resetPeerTrustForTest();
  pt.initPeerTrust();
  assert.equal(pt.peerTrustStatus().loadError?.writeBlocked, true, '전제: 원본을 옮기지 못해 쓰기가 막혔다');
  pt.checkPeer('ssh', '10.0.0.9', 22, FP_B); // 대기 지문 하나(승인·거부 대상)
  await withApp(async (call) => {
    const g = await call('?kind=ssh');
    assert.equal(g.status, 200);
    assert.equal(g.body.status?.loadError?.writeBlocked, true, 'GET 은 그대로 상태를 준다');
    const cases = [
      ['/approve', 'POST', { kind: 'ssh', host: '10.0.0.9', port: 22, fp: FP_B, confirmVerified: true }],
      ['/reject', 'POST', { kind: 'ssh', host: '10.0.0.9', port: 22, fp: FP_B }],
      ['/remove', 'POST', { kind: 'ssh', host: '10.0.0.9', port: 22 }],
      ['/approve-observed', 'POST', { kind: 'ssh', confirmVerified: true }],
      ['/policy', 'PUT', { kind: 'ssh', mode: 'observe' }],
    ];
    for (const [p, m, b] of cases) {
      const r = await call(p, m, b);
      assert.equal(r.status, 409, `${p} 는 409`);
      assert.equal(r.body.ok, false, `${p} ok:false`);
      assert.equal(r.body.code, 'peer-trust-unwritable', `${p} code`);
      assert.match(String(r.body.reason || ''), /저장하지 않습니다/, `${p} 는 사유(권한·재시작)를 말한다 — 'bad request' 가 아니다`);
      assert.notEqual(r.body.error, 'bad request', `${p} 가 전역 처리기로 새지 않는다`);
    }
  });
  // 거절된 동작이 메모리·파일에 남지 않는다(그룹 e 의 판정 그대로)
  assert.equal(pt.getPeerPolicy('ssh').mode, 'enforce');
  unpatch();
  assert.equal(realRead.call(fs, FILE, 'utf8'), orig, '원본 파일은 그대로');
});

test('② 쓸 수 있으면 같은 동작은 예전처럼 200(가드가 정상 경로를 막지 않는다)', async () => {
  seedOriginal();
  pt._resetPeerTrustForTest();
  pt.initPeerTrust();
  assert.equal(pt.peerTrustStatus().loadError, null);
  pt.checkPeer('ssh', '10.0.0.9', 22, FP_B);
  await withApp(async (call) => {
    let r = await call('/approve', 'POST', { kind: 'ssh', host: '10.0.0.9', port: 22, fp: FP_B, confirmVerified: true });
    assert.equal(r.status, 200); assert.equal(r.body.ok, true);
    r = await call('/policy', 'PUT', { kind: 'ssh', mode: 'observe' });
    assert.equal(r.status, 200); assert.equal(r.body.ok, true);
    r = await call('/remove', 'POST', { kind: 'ssh', host: '10.0.0.9', port: 22 });
    assert.equal(r.status, 200);
    // 다른 오류는 예전 응답 그대로(가드가 모든 오류를 409 로 바꾸지 않는다)
    r = await call('/remove', 'POST', { kind: 'ssh', host: '10.0.0.9', port: 22 });
    assert.equal(r.status, 404);
  });
});
