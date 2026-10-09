/**
 * rvK_releaseSigning2.test.js — 검토 S-10 보강: 신뢰 키 파일의 fail-closed·회수 우선 · 정책 값 해석 ·
 * 자동 업그레이드 뒤 수집기 push(manager.pushToCollectors)가 manifest 를 싣는가 · CI 도구(update-versions REQUIRE_MANIFEST,
 * release-keygen 의 위치 검사·공개키 추가 — **키 생성(main)은 실행하지 않는다**).
 *
 * 키는 테스트 안에서 `crypto.generateKeyPairSync('ed25519')` 로 임시로 만든다(개인키 파일을 쓰지 않는다).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'rvK-sign2-'));
const EDGE_APP = path.join(CFG, 'edge-app');
Object.assign(process.env, {
  CONFIG_DIR: CFG, AUTH_ENABLED: 'false', UPGRADE_ENABLED: 'true', UPGRADE_INSTALL_DIR: EDGE_APP,
  COLLECTOR_TOKEN: 'COLLECT-TOK', SSRF_ALLOW_LOOPBACK: 'true', DATA_SOURCE: 'mock',
});
delete process.env.UPGRADE_SIGNATURE_POLICY;
delete process.env.UPGRADE_ALLOW_UNVERIFIED;
delete process.env.UPGRADE_WATCH_DIR;

const core = await import('../src/upgrade/signatureCore.js');
const sigmod = await import('../src/upgrade/signature.js');
const upg = await import('../src/upgrade/upgrade.js');

const servers = [];
after(() => { for (const s of servers) { try { s.close(); } catch { /* */ } } });
async function listen(app) {
  const s = http.createServer(app);
  servers.push(s);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${s.address().port}`;
}

const K1 = crypto.generateKeyPairSync('ed25519');
const K2 = crypto.generateKeyPairSync('ed25519');
const kid = (k) => core.keyIdOf(k.publicKey);
const keyEntry = (k, extra = {}) => ({ keyId: kid(k), publicKey: core.spkiBase64Of(k.publicKey), ...extra });
const HOST = path.join(CFG, 'release-signing-keys.conf');
const writeKeys = (file, keys, revoked = [], mode = 0o600) => {
  fs.writeFileSync(file, JSON.stringify({ format: core.KEYS_FORMAT, schema: 1, keys, revoked }));
  fs.chmodSync(file, mode);
};

let seq = 0;
function makeBundle(version) {
  const work = fs.mkdtempSync(path.join(CFG, `b${seq++}-`));
  const pkg = path.join(work, 'vmware-portal');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'vmware-portal', version }));
  fs.writeFileSync(path.join(pkg, 'marker.txt'), `release ${version}`);
  const out = path.join(work, `vmware-portal-${version}.tar.gz`);
  const r = spawnSync('tar', ['-czf', out, '-C', work, 'vmware-portal']);
  assert.equal(r.status, 0, String(r.stderr));
  return { name: path.basename(out), path: out, bytes: fs.readFileSync(out) };
}
function signFor(k, version, files) {
  const m = core.buildManifest({
    version, keyId: kid(k),
    files: files.map((f) => ({ name: f.name, kind: f.kind || 'bundle', platform: 'any', size: f.bytes.length, sha256: core.sha256Hex(f.bytes) })),
  });
  return core.serializeEnvelope(core.signManifest(m, k.privateKey));
}

test('S-10 ⑩ 호스트 신뢰 파일 — 그룹·기타 쓰기 가능·형식 오류면 검증을 멈춘다(fail-closed), 회수는 어느 출처든 이긴다', () => {
  const b = makeBundle('9.1.0');
  const man = signFor(K1, '9.1.0', [b]);
  const decide = (trust) => sigmod.decideSignature({ manifestText: man, bytes: b.bytes, name: b.name, kind: 'bundle', expectVersion: '9.1.0', where: 'watch', trust });
  // 정상
  writeKeys(HOST, [keyEntry(K1)]);
  assert.equal(decide().verified, true);
  // 그룹·기타 쓰기 가능 → 읽지 않고 멈춘다
  if (process.platform !== 'win32') {
    writeKeys(HOST, [keyEntry(K1)], [], 0o666);
    const d = decide();
    assert.equal(d.ok, false);
    assert.equal(d.code, 'trust-unreadable');
    assert.match(d.reason, /권한/);
    assert.equal(sigmod.signatureStatus().ready, false, '상태도 준비 안 됨으로 말한다');
  }
  // 있는데 형식 오류 → 회수 목록을 알 수 없으므로 멈춘다
  fs.writeFileSync(HOST, '{ not json'); fs.chmodSync(HOST, 0o600);
  const bad = decide();
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'trust-unreadable');
  // 회수는 어느 출처든 이긴다 — 저장소(임시 파일)에 K2, 호스트가 K2 회수 → 거부
  const repo = path.join(CFG, 'repo-keys.json');
  writeKeys(repo, [keyEntry(K2)]);
  writeKeys(HOST, [], [kid(K2)]);
  const b2 = makeBundle('9.1.1');
  const m2 = signFor(K2, '9.1.1', [b2]);
  const t = sigmod.loadTrust({ repoFile: repo, hostFile: HOST });
  const rv = sigmod.decideSignature({ manifestText: m2, bytes: b2.bytes, name: b2.name, kind: 'bundle', expectVersion: '9.1.1', where: 'watch', trust: t });
  assert.equal(rv.ok, false);
  assert.equal(rv.code, 'revoked-key');
  // 반대 방향 — 저장소가 회수한 키를 호스트 파일이 되살리지 못한다
  writeKeys(repo, [keyEntry(K2, { revoked: true })]);
  writeKeys(HOST, [keyEntry(K2)]);
  const t2 = sigmod.loadTrust({ repoFile: repo, hostFile: HOST });
  const rv2 = sigmod.decideSignature({ manifestText: m2, bytes: b2.bytes, name: b2.name, kind: 'bundle', expectVersion: '9.1.1', where: 'watch', trust: t2 });
  assert.equal(rv2.code, 'revoked-key');
  // warn 정책이어도 회수 키는 거부(확인했더니 틀림)
  process.env.UPGRADE_SIGNATURE_POLICY = 'warn';
  try {
    const rv3 = sigmod.decideSignature({ manifestText: m2, bytes: b2.bytes, name: b2.name, kind: 'bundle', expectVersion: '9.1.1', where: 'watch', trust: t2 });
    assert.equal(rv3.ok, false);
  } finally { delete process.env.UPGRADE_SIGNATURE_POLICY; }
});

test('S-10 ⑪ 정책 값 — 모르는 값은 필수로 보고(조용한 약화 금지), 그 사실을 상태가 말한다', () => {
  writeKeys(HOST, [keyEntry(K1)]);
  for (const v of ['off', 'false', '0', 'disabled', 'WARN ']) {
    const p = sigmod.signaturePolicy({ UPGRADE_SIGNATURE_POLICY: v });
    if (v.trim().toLowerCase() === 'warn') assert.equal(p.policy, 'warn');
    else { assert.equal(p.policy, 'require', v); assert.ok(p.invalid, v); }
  }
  assert.equal(sigmod.signaturePolicy({}).policy, 'require');
  assert.equal(sigmod.signaturePolicy({}).source, 'default');
  process.env.UPGRADE_SIGNATURE_POLICY = 'off';
  try {
    const b = makeBundle('9.2.0');
    const d = sigmod.decideSignature({ manifestText: null, bytes: b.bytes, name: b.name, kind: 'bundle', expectVersion: '9.2.0', where: 'watch' });
    assert.equal(d.ok, false, '"off" 는 끄는 값이 아니다 — 서명 없는 번들을 거부한다');
    assert.equal(sigmod.signatureStatus().policyInvalid, 'off');
  } finally { delete process.env.UPGRADE_SIGNATURE_POLICY; }
});

test('S-10 ⑫ 자동 업그레이드 뒤 수집기 push(manager.pushToCollectors) — 감시 폴더 번들의 manifest 를 함께 싣는다', async () => {
  writeKeys(HOST, [keyEntry(K1)]);
  const { collectorRouter } = await import('../src/routes/collector.js');
  const app = express();
  app.use('/api/collector', collectorRouter);
  const url = await listen(app);
  fs.rmSync(EDGE_APP, { recursive: true, force: true });
  fs.mkdirSync(EDGE_APP, { recursive: true });
  fs.writeFileSync(path.join(EDGE_APP, 'package.json'), JSON.stringify({ version: '9.0.0' }));
  fs.writeFileSync(path.join(CFG, 'collectors.json'), JSON.stringify({ collectors: [{ id: 'c1', name: 'c1', url, token: 'COLLECT-TOK', enabled: true }] }));
  let restarts = 0;
  upg.setShutdownHandler(() => { restarts += 1; });
  const { upgradeManager } = await import('../src/upgrade/manager.js');
  const w = fs.mkdtempSync(path.join(CFG, 'watch-'));
  const b = makeBundle('9.3.0');
  fs.copyFileSync(b.path, path.join(w, b.name));
  fs.writeFileSync(path.join(w, 'vmware-portal-9.3.0.manifest.json'), signFor(K1, '9.3.0', [b]));
  upgradeManager.settings = { ...upgradeManager.settings, watchDir: w };
  const results = await upgradeManager.pushToCollectors();
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true, results[0].reason);
  assert.equal(JSON.parse(fs.readFileSync(path.join(EDGE_APP, 'package.json'), 'utf8')).version, '9.3.0');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(restarts, 1);
  upg.setShutdownHandler(null);
});

test('S-10 ⑬ CI — update-versions 는 REQUIRE_MANIFEST=1 이면 manifest 없는 버전을 올리지 않고, 있으면 항목에 이름을 싣는다', () => {
  const dist = fs.mkdtempSync(path.join(CFG, 'dist-'));
  const v = '9.4.0';
  for (const n of [`vmware-portal-${v}.tar.gz`, `vmware-portal-offline-${v}-el9-x64.tar.gz`, `vmware-portal-offline-${v}-cent9-x64.tar.gz`, `vmware-portal-win-${v}-x64.zip`]) {
    fs.writeFileSync(path.join(dist, n), crypto.randomBytes(64));
  }
  const script = path.join(ROOT, 'packaging/release/update-versions.mjs');
  const out = path.join(dist, 'versions.json');
  const env = { ...process.env, REQUIRE_MANIFEST: '1' };
  const r1 = spawnSync(process.execPath, [script, v, dist, '-', out], { env, encoding: 'utf8' });
  assert.notEqual(r1.status, 0, 'manifest 없이 통과하면 안 된다');
  assert.match(r1.stderr, /manifest/);
  assert.equal(fs.existsSync(out), false);
  fs.writeFileSync(path.join(dist, `vmware-portal-${v}.manifest.json`), '{}');
  const r2 = spawnSync(process.execPath, [script, v, dist, '-', out], { env, encoding: 'utf8' });
  assert.equal(r2.status, 0, r2.stderr);
  const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(doc.versions[0].manifest, `vmware-portal-${v}.manifest.json`);
});

test('S-10 ⑭ release-keygen — 저장소 안에는 개인키를 쓰지 않고, 공개키 추가는 keyId 를 검사한다(키 생성 본체는 실행하지 않는다)', async () => {
  const kg = await import('../../scripts/release-keygen.mjs');
  // 임시 '저장소'(.git 폴더가 있는 곳) 안의 하위 폴더는 저장소 안이다 — 위로 올라가며 찾는다
  const fakeRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'rvK-kg-repo-'));
  fs.mkdirSync(path.join(fakeRepo, '.git'));
  fs.mkdirSync(path.join(fakeRepo, 'a', 'b'), { recursive: true });
  assert.equal(kg.insideGitTree(path.join(fakeRepo, 'a', 'b')), fakeRepo, '저장소 안을 알아본다');
  fs.rmSync(fakeRepo, { recursive: true, force: true });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rvK-kg-'));
  assert.equal(kg.insideGitTree(outside), null);
  const file = path.join(outside, 'keys.json');
  kg.addPublicKeyEntry(file, keyEntry(K1, { note: 't' }));
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.keys.length, 1);
  assert.equal(doc.keys[0].keyId, kid(K1));
  assert.ok(!JSON.stringify(doc).includes('PRIVATE'), '공개키만');
  assert.throws(() => kg.addPublicKeyEntry(file, keyEntry(K1)), /이미 있는/);
  assert.throws(() => kg.addPublicKeyEntry(file, { keyId: kid(K1).replace(/.$/, (c) => (c === '0' ? '1' : '0')), publicKey: core.spkiBase64Of(K2.publicKey) }), /검사 실패/);
  fs.rmSync(outside, { recursive: true, force: true });
});

test('S-10 ⑮ 에이전트 원격 배포용 — 산출물 옆 manifest 를 찾고, 이름을 바꿔 올리면(pkg.tar.gz) 확인 도구가 거부한다', async () => {
  writeKeys(HOST, [keyEntry(K1)]);
  const dir = fs.mkdtempSync(path.join(CFG, 'deploy-'));
  const name = 'vmware-portal-offline-9.5.0-el9-x64.tar.gz';
  const pkg = path.join(dir, name);
  fs.writeFileSync(pkg, crypto.randomBytes(2048));
  assert.equal(sigmod.manifestPathForArtifact(pkg), null, 'manifest 가 없으면 null(지어내지 않는다)');
  const man = path.join(dir, 'vmware-portal-9.5.0.manifest.json');
  fs.writeFileSync(man, signFor(K1, '9.5.0', [{ name, bytes: fs.readFileSync(pkg), kind: 'installer' }]));
  assert.equal(sigmod.manifestPathForArtifact(pkg), man);
  assert.equal(sigmod.manifestPathForArtifact(path.join(dir, 'vmware-portal-win-9.5.0-x64.zip')), man);
  assert.equal(sigmod.manifestPathForArtifact(path.join(dir, 'pkg.tar.gz')), null);
  const { runVerify } = await import('../src/upgrade/verifyCli.js');
  const quiet = () => {};
  assert.equal(await runVerify(['--file', pkg, '--manifest', man], { log: quiet }), 0);
  const renamed = path.join(dir, 'pkg.tar.gz');
  fs.copyFileSync(pkg, renamed);
  assert.equal(await runVerify(['--file', renamed, '--manifest', man, '--version', '9.5.0'], { log: quiet }), 1, '이름이 manifest 에 없으면 거부(원래 이름으로 올려야 한다)');
});
