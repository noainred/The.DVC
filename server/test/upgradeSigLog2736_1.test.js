/**
 * upgradeSigLog2736_1.test.js — v2.736.1: 업그레이드 화면 '릴리스 서명 › 마지막 검증' 기록이 재시작 뒤에도 남는다.
 *
 * 사용자 신고(2.736.0 캡처): 서명 필수 · 신뢰 공개키 1개인데 '마지막 검증 — 아직 검증한 번들이 없습니다'. 기록이 프로세스 메모리에만
 * 있었고 업그레이드는 검증 직후 재시작하므로 그 기록이 늘 사라졌다. 여기서는 실제 decideSignature(임시 Ed25519 키로 서명한 실제
 * manifest)로 기록을 만들고, 메모리를 비운 뒤(= 재시작) 다시 읽어 보인다.
 *
 *  ① import 만으로는 파일을 쓰지 않는다(오프라인 확인 도구·테스트 — root 소유 파일 방지)
 *  ② 서버가 켜면 동기로 남기고, 재시작 뒤에도 마지막 기록이 보인다(누적 개수는 프로세스 기준 그대로) · 파일 권한 0600
 *  ③ 재시작 전 기록은 beforeStart · 최신 먼저 · 최대 SIG_LOG_MAX 개 · 거부 기록도 남는다
 *  ④ 손상 파일은 보존(.corrupt.<ts>) 후 새로 시작하고 사실을 상태에 싣는다
 *  ⑤ 읽을 때도 아는 필드만·길이 상한(손으로 고친 파일이 화면을 깨지 않게)
 *  ⑥ 쓰기 실패는 판정을 바꾸지 않고 상태에 사유를 남긴다
 *  ⑦ 상태 파일로 등록(백업 '설정 변경' 감시 제외) · index.js 가 켜고 verifyCli.js 는 켜지 않는다
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-log-'));
Object.assign(process.env, { CONFIG_DIR: CFG, DATA_SOURCE: 'mock' });
delete process.env.UPGRADE_SIGNATURE_POLICY;

const core = await import('../src/upgrade/signatureCore.js');
const sig = await import('../src/upgrade/signature.js');
const { isRegisteredStateFile } = await import('../src/util/stateFiles.js');
const { currentVersion } = await import('../src/config.js');

// 저장소 공개키 목록은 비우고(테스트 전용 경로) 신뢰는 임시 호스트 파일로 — 실제 운영 키를 쓰지 않는다.
const EMPTY_REPO = path.join(CFG, 'repo-keys.json');
fs.writeFileSync(EMPTY_REPO, JSON.stringify({ format: core.KEYS_FORMAT, schema: 1, keys: [], revoked: [] }));
sig._setRepoKeysFileForTest(EMPTY_REPO);
const K = crypto.generateKeyPairSync('ed25519');
const HOST = path.join(CFG, 'release-signing-keys.conf');
fs.writeFileSync(HOST, JSON.stringify({ format: core.KEYS_FORMAT, schema: 1, keys: [{ keyId: core.keyIdOf(K.publicKey), publicKey: core.spkiBase64Of(K.publicKey) }], revoked: [] }), { mode: 0o600 });
fs.chmodSync(HOST, 0o600);

const bundle = (v) => Buffer.from(`bundle ${v} ${'x'.repeat(64)}`);
function signedFor(version, bytes) {
  const name = `vmware-portal-${version}.tar.gz`;
  const m = core.buildManifest({ version, keyId: core.keyIdOf(K.publicKey), files: [{ name, kind: 'bundle', platform: 'any', size: bytes.length, sha256: core.sha256Hex(bytes) }] });
  return { name, text: core.serializeEnvelope(core.signManifest(m, K.privateKey)) };
}
function verifyOk(version, where = 'remote') {
  const b = bundle(version);
  const s = signedFor(version, b);
  return sig.decideSignature({ manifestText: s.text, bytes: b, name: s.name, kind: 'bundle', expectVersion: version, where });
}
function verifyBad(version) {
  const b = bundle(version);
  const s = signedFor(version, b);
  return sig.decideSignature({ manifestText: s.text, bytes: Buffer.concat([b, Buffer.from('tampered')]), name: s.name, kind: 'bundle', expectVersion: version, where: 'push-edge' });
}
const LOG = () => sig.sigLogFile(CFG);
const restart = () => { sig._resetSignatureStatusForTest(); };

test('① import 만으로는 파일을 쓰지 않는다 — 켜기 전 검증은 메모리에만', () => {
  restart();
  try { fs.rmSync(LOG()); } catch { /* */ }
  const d = verifyOk('2.900.0', 'offline');
  assert.equal(d.verified, true);
  assert.equal(fs.existsSync(LOG()), false, '오프라인 확인 도구(install.sh 가 root 로 부를 수 있다)가 CONFIG_DIR 에 쓰지 않는다');
  const st = sig.signatureStatus();
  assert.equal(st.log.enabled, false);
  assert.equal(st.last.where, 'offline', '메모리 기록은 그대로 보인다(예전 동작)');
});

test('② 켜면 동기로 남기고, 재시작 뒤에도 마지막 기록이 보인다 — 누적 개수는 이 프로세스 기준', () => {
  restart();
  try { fs.rmSync(LOG()); } catch { /* */ }
  assert.deepEqual(sig.enableSignatureLog({ configDir: CFG }), { loaded: 0, error: null });
  const d = verifyOk('2.900.1');
  assert.equal(d.verified, true);
  assert.equal(fs.existsSync(LOG()), true, '검증 직후(재시작 전) 파일에 있어야 한다 — 디바운스하면 업그레이드 재시작이 지운다');
  assert.equal(fs.statSync(LOG()).mode & 0o777, 0o600);
  const doc = JSON.parse(fs.readFileSync(LOG(), 'utf8'));
  assert.equal(doc.recent[0].version, '2.900.1');
  assert.equal(doc.recent[0].keyId, core.keyIdOf(K.publicKey));
  assert.equal(doc.recent[0].appVersion, currentVersion(), '어느 버전의 포탈이 남긴 기록인지 함께');

  restart(); // = 프로세스 재시작(메모리 비움)
  assert.equal(sig.signatureStatus().last, null, '켜기 전에는 비어 있다(재시작 직후)');
  assert.deepEqual(sig.enableSignatureLog({ configDir: CFG }), { loaded: 1, error: null });
  const st = sig.signatureStatus();
  assert.equal(st.last.verified, true);
  assert.equal(st.last.version, '2.900.1');
  assert.equal(st.last.where, 'remote');
  assert.equal(st.counts.verified, 0, "누적 개수는 '프로세스 시작 뒤' 만 센다(화면 문구 그대로)");
  assert.equal(st.currentVersion, currentVersion());
  assert.equal(st.log.enabled, true);
  assert.equal(st.log.error, null);
});

test('③ 재시작 전 기록은 beforeStart · 최신 먼저 · 최대 SIG_LOG_MAX · 거부도 남는다', () => {
  restart();
  const old = Date.now() - Math.round(process.uptime() * 1000) - 60_000; // 이 프로세스 시작 1분 전
  fs.writeFileSync(LOG(), JSON.stringify({ v: 1, recent: [{ at: old, where: 'remote', ok: true, verified: true, version: '2.899.0', keyId: 'ed25519:0123456789abcdef', policy: 'require' }] }));
  sig.enableSignatureLog({ configDir: CFG });
  let st = sig.signatureStatus();
  assert.equal(st.last.beforeStart, true, '업그레이드 직전(재시작 전)에 남긴 기록');
  verifyBad('2.900.2');
  st = sig.signatureStatus();
  assert.equal(st.last.verified, false);
  assert.equal(st.last.ok, false, '거부');
  assert.equal(st.last.beforeStart, false, '이 프로세스가 남긴 기록');
  assert.equal(st.recent[1].version, '2.899.0', '최신 먼저');
  for (let i = 0; i < sig.SIG_LOG_MAX + 3; i++) verifyOk(`2.901.${i}`);
  const doc = JSON.parse(fs.readFileSync(LOG(), 'utf8'));
  assert.equal(doc.recent.length, sig.SIG_LOG_MAX, '상한');
  assert.equal(doc.recent[0].version, `2.901.${sig.SIG_LOG_MAX + 2}`, '가장 최근이 맨 앞');
  assert.ok(sig.signatureStatus().recent.length <= 5, '화면에는 최근 5건만');
});

test('③-b 다시 읽을 때 쓴 순서를 지킨다 — 그사이 시계가 뒤로 맞춰져도 재시작 전후 마지막이 같다', () => {
  restart();
  try { fs.rmSync(LOG()); } catch { /* */ }
  sig.enableSignatureLog({ configDir: CFG });
  const now = Date.now();
  // 먼저 기록한 거부(60초 전) → 시계가 뒤로 1시간 조정된 뒤 기록한 확인(벽시계로는 더 이른 시각)
  sig.recordVerification({ at: now - 60_000, where: 'push-edge', ok: false, verified: false, version: '2.736.9', policy: 'require' });
  sig.recordVerification({ at: now - 3_600_000, where: 'remote', ok: true, verified: true, version: '2.737.0', policy: 'require' });
  assert.equal(sig.signatureStatus().last.version, '2.737.0', '재시작 전 마지막');
  restart();
  sig.enableSignatureLog({ configDir: CFG });
  assert.equal(sig.signatureStatus().last.version, '2.737.0', '재시작 뒤에도 같은 기록이 마지막이다(시각으로 다시 정렬하지 않는다)');
});

test('④ 손상 파일은 보존 후 새로 시작하고, 그 사실을 상태에 싣는다', () => {
  restart();
  for (const f of fs.readdirSync(CFG)) if (f.includes('.corrupt.')) fs.rmSync(path.join(CFG, f));
  fs.writeFileSync(LOG(), '{"v":1,"recent":[{"at":');
  const r = sig.enableSignatureLog({ configDir: CFG });
  assert.match(String(r.error), /손상/);
  const kept = fs.readdirSync(CFG).filter((f) => f.startsWith('upgrade-signature-log.json.corrupt.'));
  assert.equal(kept.length, 1, '원본을 옆으로 보존한다');
  const st = sig.signatureStatus();
  assert.equal(st.last, null);
  assert.match(String(st.log.error), /손상/);
  assert.equal(st.log.corruptKept, kept[0]);
  verifyOk('2.902.0');
  assert.equal(JSON.parse(fs.readFileSync(LOG(), 'utf8')).recent[0].version, '2.902.0', '다음 기록이 새 파일을 만든다');
  assert.equal(sig.signatureStatus().log.error, null, '정상으로 쓰면 오류 표시를 거둔다');
  // 모양이 틀린 JSON(recent 가 배열이 아님)도 손상이다
  restart();
  fs.writeFileSync(LOG(), JSON.stringify({ v: 1, recent: 'x' }));
  assert.match(String(sig.enableSignatureLog({ configDir: CFG }).error), /손상/);
});

test('⑤ 읽을 때도 아는 필드만·길이 상한 — 시각이 숫자가 아닌 줄과 객체가 아닌 줄은 버린다', () => {
  restart();
  const now = Date.now();
  fs.writeFileSync(LOG(), JSON.stringify({ v: 1, recent: [
    { at: now, where: 'w'.repeat(500), ok: true, verified: true, version: 'abc', reason: 'r'.repeat(5000), password: 'SECRET-SHOULD-DROP', keyId: 'k'.repeat(500), policy: 'off', appVersion: '<b>' },
    { at: 'x', where: 'remote' }, null, 'string', 7,
  ] }));
  assert.equal(sig.enableSignatureLog({ configDir: CFG }).loaded, 1);
  const l = sig.signatureStatus().last;
  assert.equal('password' in l, false);
  assert.ok(l.where.length <= 40 && l.reason.length <= 400 && l.keyId.length <= 80);
  assert.equal(l.version, null, '버전 형식이 아니면 null');
  assert.equal(l.policy, null);
  assert.equal(l.appVersion, null);
  assert.equal(sig.sanitizeSigEntry({ at: 0 }), null);
  assert.equal(sig.sanitizeSigEntry({ at: -5 }), null);
});

test('⑥ 쓰기 실패는 판정을 바꾸지 않고 상태에 사유를 남긴다', () => {
  restart();
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-log-bad-'));
  fs.mkdirSync(path.join(bad, 'upgrade-signature-log.json')); // 같은 이름의 디렉터리 — 읽기도 쓰기도 실패한다
  const r = sig.enableSignatureLog({ configDir: bad });
  assert.match(String(r.error), /읽지 못했습니다/);
  assert.equal(fs.statSync(path.join(bad, 'upgrade-signature-log.json')).isDirectory(), true, '파일이 아닌 것을 옮기지 않는다');
  const d = verifyOk('2.903.0');
  assert.equal(d.ok, true);
  assert.equal(d.verified, true, '기록 실패가 판정을 바꾸지 않는다');
  assert.match(String(sig.signatureStatus().log.error), /남기지 못했습니다/);
  assert.equal(sig.signatureStatus().last.version, '2.903.0', '메모리 기록은 남는다');
});

test('⑦ 상태 파일 등록 · index.js 가 켜고 verifyCli.js 는 켜지 않는다', () => {
  assert.equal(isRegisteredStateFile('upgrade-signature-log.json'), true, "백업 '설정 변경' 감시에서 빠진다");
  const idx = stripComments(fs.readFileSync(path.join(HERE, '../src/index.js'), 'utf8'));
  assert.match(idx, /enableSignatureLog\(\)/, '서버 기동이 기록을 켠다');
  const cli = stripComments(fs.readFileSync(path.join(HERE, '../src/upgrade/verifyCli.js'), 'utf8'));
  assert.doesNotMatch(cli, /enableSignatureLog/, '오프라인 확인 도구는 파일을 쓰지 않는다');
});
