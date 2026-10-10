/**
 * test/audit2732e_peerTrust.test.js — 점검 2회차(v2.732) B4-03: peer-trust.json 읽기 실패(EACCES 등)·손상 뒤
 * ① 원본(승인 목록)이 보존되는가 ② 재시작해도 정책이 observe 로 내려가지 않는가 ③ 원본을 옮기지 못하면 덮어쓰지 않는가.
 *
 * 재현(수정 전): 읽기 실패 갈래는 preserveCorrupt 도 정책 기록도 없이 빈 상태로 진행해, 첫 연결 기록(2초 묶음 저장)이
 * `{policy:{}, entries:[새 장비]}` 로 원본을 덮었고 다음 기동이 정책 키 없는 파일을 '기존 현장' 으로 보고 observe 로 열었다.
 * 손상 갈래도 보존 뒤 아무것도 쓰지 않은 채 재시작하면 '파일 없음' → observe 였다.
 * 테스트는 root 로 EACCES 를 만들 수 없어 그 파일에 한해 fs.readFileSync 가 EACCES 를 던지게 바꾼다(peerTrust 는 기본 fs 객체를 쓴다).
 */
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a2732e-peer-'));
process.env.CONFIG_DIR = DIR;
delete process.env.SSH_HOSTKEY_POLICY;
delete process.env.TLS_PEER_POLICY;

const pt = await import('../src/security/peerTrust.js');
const FILE = path.join(DIR, 'peer-trust.json');
const FP_A = 'SHA256:' + 'A'.repeat(43);
const FP_B = 'SHA256:' + 'B'.repeat(43);

const realRead = fs.readFileSync;
const realRename = fs.renameSync;
function unpatch() { fs.readFileSync = realRead; fs.renameSync = realRename; }
function denyRead() {
  fs.readFileSync = function (p, ...a) {
    if (String(p) === FILE) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; }
    return realRead.call(fs, p, ...a);
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
  try { pt.flushPeerTrust(); } catch { /* */ } // 종료 flush 가 지운 임시 폴더를 다시 만들지 않게 먼저 비운다
  pt._resetPeerTrustForTest();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

// 기존 현장 표지(existingInstall 참) + 승인 지문 1개 · 두 종류 enforce 인 원본
function seedOriginal() {
  fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'vc1' }] }));
  const orig = { v: 1, policy: { ssh: 'enforce', tls: 'enforce' }, origin: {}, entries: [
    { kind: 'ssh', host: '10.0.0.5', port: 22, trusted: { fp: FP_A, state: 'approved', at: 1 } },
  ] };
  fs.writeFileSync(FILE, JSON.stringify(orig), { mode: 0o600 });
  return JSON.stringify(orig);
}
const corruptCopies = () => fs.readdirSync(DIR).filter((n) => n.startsWith('peer-trust.json.corrupt.'));

test('① 읽기 실패 → 원본 보존 · 연결 기록이 원본을 덮지 않는다 · 재시작 뒤에도 enforce(observe 로 내려가지 않음)', () => {
  const orig = seedOriginal();
  denyRead();
  pt._resetPeerTrustForTest();
  pt.initPeerTrust();
  const st = pt.peerTrustStatus();
  assert.equal(st.loadError?.code, 'unreadable');
  assert.equal(st.loadError?.detail, 'EACCES');
  assert.equal(pt.getPeerPolicy('ssh').mode, 'enforce');
  // 읽기 실패 동안 처음 보는 장비 — enforce 라 거부·대기 기록(2초 묶음 저장) → 즉시 flush
  assert.equal(pt.checkPeer('ssh', '10.0.0.9', 22, FP_B).ok, false);
  pt.flushPeerTrust();
  unpatch();
  // 원본의 승인 지문이 어딘가(보존본)에 그대로 남아 있어야 한다
  const copies = corruptCopies();
  assert.equal(copies.length, 1, '읽지 못한 원본을 .corrupt.* 로 보존한다');
  assert.equal(realRead.call(fs, path.join(DIR, copies[0]), 'utf8'), orig, '보존본은 원본 그대로');
  // 재시작 — 기존 현장 표지가 있어도 observe 로 열지 않는다
  pt._resetPeerTrustForTest();
  const ssh = pt.getPeerPolicy('ssh'); const tls = pt.getPeerPolicy('tls');
  assert.equal(ssh.mode, 'enforce', '재시작 뒤 ssh observe 하향 금지');
  assert.equal(tls.mode, 'enforce', '재시작 뒤 tls observe 하향 금지');
  assert.equal(ssh.origin, 'load-error');
  assert.notEqual(ssh.origin, 'upgrade-migration');
  // 새 파일은 닫힌 정책을 담는다(파일 자체가 근거)
  const now = JSON.parse(realRead.call(fs, FILE, 'utf8'));
  assert.deepEqual(now.policy, { ssh: 'enforce', tls: 'enforce' });
});

test('② 읽기 실패 직후 아무 연결 없이 재시작해도 enforce', () => {
  seedOriginal();
  denyRead();
  pt._resetPeerTrustForTest();
  pt.initPeerTrust();
  unpatch();
  assert.deepEqual(JSON.parse(realRead.call(fs, FILE, 'utf8')).policy, { ssh: 'enforce', tls: 'enforce' }, '닫힌 정책을 곧바로 파일에 남긴다');
  pt._resetPeerTrustForTest();
  assert.equal(pt.getPeerPolicy('ssh').mode, 'enforce');
  assert.equal(pt.getPeerPolicy('tls').mode, 'enforce');
  assert.equal(corruptCopies().length, 1);
});

test('③ 손상 파일 → 보존 뒤 쓰기 없이 재시작해도 enforce(예전: 파일 없음 → observe)', () => {
  seedOriginal();
  fs.writeFileSync(FILE, '{"v":1,"policy":{"ssh":"enforce"},"entries":[');
  pt._resetPeerTrustForTest();
  assert.equal(pt.peerTrustStatus().loadError?.code, 'corrupt');
  pt._resetPeerTrustForTest();
  assert.equal(pt.getPeerPolicy('ssh').mode, 'enforce');
  assert.equal(pt.getPeerPolicy('tls').mode, 'enforce');
  assert.equal(pt.getPeerPolicy('ssh').origin, 'load-error');
});

test('④ 손상 흔적(.corrupt.*)만 남고 파일이 없으면 기존 현장이어도 enforce(load-error)', () => {
  seedOriginal();
  fs.renameSync(FILE, `${FILE}.corrupt.123`);
  pt._resetPeerTrustForTest();
  const ssh = pt.getPeerPolicy('ssh');
  assert.equal(ssh.mode, 'enforce');
  assert.equal(ssh.origin, 'load-error');
  assert.equal(pt.getPeerPolicy('tls').mode, 'enforce');
});

test('⑤ 원본을 옮기지 못하면(rename 실패) 그 파일에 쓰지 않는다 — 원본이 그대로 남는다', () => {
  const orig = seedOriginal();
  denyRead();
  fs.renameSync = function (from, to) {
    if (String(from) === FILE) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; }
    return realRename.call(fs, from, to);
  };
  pt._resetPeerTrustForTest();
  pt.initPeerTrust();
  const st = pt.peerTrustStatus();
  assert.equal(st.loadError?.code, 'unreadable');
  assert.equal(st.loadError?.writeBlocked, true);
  assert.equal(pt.getPeerPolicy('ssh').mode, 'enforce');
  assert.equal(pt.checkPeer('ssh', '10.0.0.9', 22, FP_B).ok, false);
  pt.flushPeerTrust(); // 묶음 저장 — 막혀야 한다(throw 하지 않고 경고)
  assert.throws(() => pt.setPeerPolicy('ssh', 'observe'), (e) => e.status === 409 && /저장하지 않습니다/.test(e.message), '관리자 동작도 원본을 덮지 않는다(오류로 응답)');
  assert.equal(pt.getPeerPolicy('ssh').mode, 'enforce', '거절된 정책 변경이 메모리에 남지 않는다');
  assert.throws(() => pt.approvePeer('ssh', '10.0.0.9', 22, FP_B, { by: 't' }), /저장하지 않습니다/);
  assert.equal(pt.checkPeer('ssh', '10.0.0.9', 22, FP_B).ok, false, '거절된 승인은 메모리에도 없다');
  unpatch();
  assert.equal(realRead.call(fs, FILE, 'utf8'), orig, '원본이 그대로');
  pt._resetPeerTrustForTest();
  assert.equal(pt.getPeerPolicy('ssh').mode, 'enforce', '권한을 고치면 원본 정책(enforce)이 그대로 읽힌다');
  assert.equal(pt.listPeers({ kind: 'ssh' }).some((e) => e.host === '10.0.0.5'), true, '승인 지문 유지');
});

test('⑥ 정상 파일은 영향 없음 — 보존본·loadError 없음', () => {
  seedOriginal();
  pt._resetPeerTrustForTest();
  assert.equal(pt.peerTrustStatus().loadError, null);
  assert.equal(pt.checkPeer('ssh', '10.0.0.5', 22, FP_A).reason, 'approved');
  assert.equal(corruptCopies().length, 0);
});
