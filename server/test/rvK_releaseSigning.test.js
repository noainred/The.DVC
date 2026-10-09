/**
 * rvK_releaseSigning.test.js — 검토 S-10: 업그레이드 번들의 **배포자 서명**(Ed25519 manifest)을 설치 전에 검증한다.
 *
 * 재현했던 결함: `downloadArchive` 에 교체한 번들과 그 번들의 새 sha 를 함께 넣으면 받아들였다(sha 는 같은 채널).
 * 여기서는 실제 함수·실제 라우터(express 에 진짜 upgradeRouter·collectorRouter·dlSourceRouter 를 마운트)·실제 tar.gz 로 본다.
 * 키는 테스트 안에서 `crypto.generateKeyPairSync('ed25519')` 로 **임시로** 만들고, 신뢰 공개키는 임시 CONFIG_DIR 의
 * 호스트 파일(release-signing-keys.conf)로 넣는다 — 저장소 파일(빈 목록)은 건드리지 않는다. 개인키 파일을 쓰지 않는다.
 *
 *  ① 코어: 정상 · payload 변조 · 모르는 키 · 회수 키 · 이름표만 바꾼 키 항목
 *  ② 원격: 정상 설치 · 번들+SHA 동시 교체 거부 · manifest 변조 거부 · 미서명 거부(warn 이면 경고 후 진행) ·
 *          모르는 키 거부 · 회수 키 거부 · 다른 버전 manifest 재사용 거부 · 신뢰 키 0개 거부 · 서명 미확인이면 번들을 받지 않음
 *  ③ 키 교체: 옛 키로 서명된 릴리스가 새 키를 실어 오면 다음 릴리스(새 키 서명)를 받는다
 *  ④ 감시 폴더 · ⑤ 중앙 → 엣지 push(/api/upgrade/bundle) · ⑥ 중앙 → 수집기 push(/api/collector/upgrade) ·
 *  ⑦ 중앙 /dl 소스 → 엣지 자동 적용 · ⑧ 오프라인(verifyCli + install.sh 의 확인 함수) — 전부 같은 decideSignature
 *  ⑨ 서명 키는 manifest·로그·서버 코드·패키지에 들어가지 않는다 · CI 사전 점검은 공개키 목록이 비면 실패한다
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'rvK-sign-'));
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
async function listen(appOrHandler) {
  const s = http.createServer(appOrHandler);
  servers.push(s);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${s.address().port}`;
}

const K1 = crypto.generateKeyPairSync('ed25519');
const K2 = crypto.generateKeyPairSync('ed25519');
const K3 = crypto.generateKeyPairSync('ed25519'); // 신뢰 목록에 없는 키
const kid = (k) => core.keyIdOf(k.publicKey);
const keyEntry = (k, extra = {}) => ({ keyId: kid(k), publicKey: core.spkiBase64Of(k.publicKey), ...extra });
const HOST = path.join(CFG, 'release-signing-keys.conf');
function setHostTrust(keys, revoked = []) {
  fs.writeFileSync(HOST, JSON.stringify({ format: core.KEYS_FORMAT, schema: 1, keys: keys.map((k) => keyEntry(k)), revoked }), { mode: 0o600 });
  fs.chmodSync(HOST, 0o600);
}
function clearHostTrust() { try { fs.rmSync(HOST); } catch { /* */ } }

let seq = 0;
/** 실제 tar.gz 번들(vmware-portal/package.json + 선택 파일) */
function makeBundle(version, { extra = {}, marker = '' } = {}) {
  const work = fs.mkdtempSync(path.join(CFG, `b${seq++}-`));
  const pkg = path.join(work, 'vmware-portal');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'vmware-portal', version }));
  fs.writeFileSync(path.join(pkg, 'marker.txt'), marker || `release ${version}`);
  for (const [rel, body] of Object.entries(extra)) { fs.mkdirSync(path.dirname(path.join(pkg, rel)), { recursive: true }); fs.writeFileSync(path.join(pkg, rel), body); }
  const out = path.join(work, `vmware-portal-${version}.tar.gz`);
  execFileSync('tar', ['-czf', out, '-C', work, 'vmware-portal']);
  return { path: out, bytes: fs.readFileSync(out), name: path.basename(out) };
}
/** 서명 manifest(봉투 글). files: [{name, bytes, kind}] */
function signFor(key, version, files) {
  const m = core.buildManifest({
    version, keyId: kid(key),
    files: files.map((f) => ({ name: f.name, kind: f.kind || 'bundle', platform: 'any', size: f.bytes.length, sha256: core.sha256Hex(f.bytes) })),
  });
  return core.serializeEnvelope(core.signManifest(m, key.privateKey));
}
function freshInstall(tag) {
  const dir = path.join(CFG, `inst-${tag}-${seq++}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '9.0.0' }));
  return dir;
}
const installedVersion = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;

/** 원격 소스 목 서버 — files: name → Buffer|string, 404 이면 없음. 요청 기록. */
async function remoteSource(files) {
  const hits = [];
  const base = await listen((q, r) => {
    const name = decodeURIComponent(q.url.split('?')[0].slice(1));
    hits.push(name);
    if (!(name in files)) { r.statusCode = 404; return r.end('not found'); }
    r.end(files[name]);
  });
  return { base, hits };
}
const versionsFor = (latest, bundle, extra = {}) => JSON.stringify({ latest, versions: [{ version: latest, tar_gz: bundle.name, size_bytes: bundle.bytes.length, sha256: core.sha256Hex(bundle.bytes), ...extra }] });

// ─────────────────────────────────────────────────────────────────────────────
test('S-10 ① 코어 — 정상 검증 · payload 변조 · 모르는 키 · 회수 키 · 이름표만 바꾼 키 항목', () => {
  const b = { name: 'vmware-portal-9.9.1.tar.gz', bytes: Buffer.from('bundle'), kind: 'bundle' };
  const text = signFor(K1, '9.9.1', [b]);
  const trust = core.mergeTrust([core.parseKeysDoc({ keys: [keyEntry(K1)] })]);
  const v = core.verifyEnvelopeText(text, trust);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(core.matchArtifact(v.manifest, { name: b.name, kind: 'bundle', size: 6, sha256: core.sha256Hex(b.bytes), expectVersion: '9.9.1' }).ok, true);

  const env = JSON.parse(text);
  const p = JSON.parse(Buffer.from(env.payload, 'base64').toString());
  p.files[0].sha256 = 'f'.repeat(64);
  env.payload = Buffer.from(JSON.stringify(p)).toString('base64');
  assert.equal(core.verifyEnvelopeText(JSON.stringify(env), trust).code, 'bad-signature');

  assert.equal(core.verifyEnvelopeText(signFor(K3, '9.9.1', [b]), trust).code, 'unknown-key');
  const revokedTrust = core.mergeTrust([core.parseKeysDoc({ keys: [keyEntry(K1)] }), core.parseKeysDoc({ revoked: [kid(K1)] })]);
  assert.equal(core.verifyEnvelopeText(text, revokedTrust).code, 'revoked-key');
  // 이름표(keyId)만 K1 으로 적고 공개키는 K3 — 그 항목은 버린다(K3 를 K1 이름으로 믿게 만들 수 없다)
  const forged = core.parseKeysDoc({ keys: [{ keyId: kid(K1), publicKey: core.spkiBase64Of(K3.publicKey) }] });
  assert.equal(forged.keys.length, 0);
  assert.match(forged.errors.join(), /맞지 않아/);
  // 정책 — 모르는 값은 require
  assert.equal(sigmod.signaturePolicy({ UPGRADE_SIGNATURE_POLICY: 'off' }).policy, 'require');
  assert.equal(sigmod.signaturePolicy({ UPGRADE_SIGNATURE_POLICY: 'off' }).invalid, 'off');
  assert.equal(sigmod.signaturePolicy({}).policy, 'require');
  assert.equal(sigmod.signaturePolicy({ UPGRADE_SIGNATURE_POLICY: 'warn' }).policy, 'warn');
});

test('S-10 ② 원격 — 정상 서명이면 설치되고 manifest 가 번들 옆에 저장된다', async () => {
  setHostTrust([K1]);
  const b = makeBundle('9.9.1');
  const { base } = await remoteSource({ 'versions.json': versionsFor('9.9.1', b), [b.name]: b.bytes, 'vmware-portal-9.9.1.manifest.json': signFor(K1, '9.9.1', [b]) });
  const inst = freshInstall('ok');
  const dlDir = path.join(CFG, 'dl-ok');
  const r = await upg.upgradeFromRemote(base, inst, '9.0.0', dlDir, { timeout: 10_000, pkgName: 'vmware-portal' });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.signature.verified, true);
  assert.equal(r.signature.keyId, kid(K1));
  assert.equal(installedVersion(inst), '9.9.1');
  assert.ok(fs.existsSync(path.join(dlDir, 'vmware-portal-9.9.1.manifest.json')), 'push 가 실을 manifest 를 남긴다');
  const st = sigmod.signatureStatus();
  assert.equal(st.trustedKeys, 1);
  assert.equal(st.policy, 'require');
  assert.equal(st.last.verified, true);
});

test('S-10 ② 원격 — 번들과 versions.json 의 SHA 를 함께 바꿔도(재현 시나리오) 서명에서 거부한다', async () => {
  setHostTrust([K1]);
  const good = makeBundle('9.9.1');
  const evil = makeBundle('9.9.1', { marker: 'EVIL PAYLOAD' });
  const manifest = signFor(K1, '9.9.1', [good]);
  // ⓐ downloadArchive 직접(검토의 격리 재현과 같은 호출): 교체 내용 + 그 내용의 새 sha
  const { base } = await remoteSource({ [evil.name]: evil.bytes });
  const dir = path.join(CFG, 'dl-evil');
  const d = await upg.downloadArchive(`${base}/${evil.name}`, dir, { sha256: core.sha256Hex(evil.bytes), manifestText: manifest, timeout: 10_000 });
  assert.equal(d.ok, false, '예전에는 교체 내용 + 새 sha 를 받아들였다');
  assert.match(d.signature.code, /^(sha|size)-mismatch$/);
  assert.equal(fs.existsSync(path.join(dir, evil.name)), false, '거부한 번들은 디스크에 쓰지 않는다');
  // ⓑ 전체 경로: versions.json 도 공격자 것
  const src = await remoteSource({ 'versions.json': versionsFor('9.9.1', evil), [evil.name]: evil.bytes, 'vmware-portal-9.9.1.manifest.json': manifest });
  const inst = freshInstall('evil');
  const r = await upg.upgradeFromRemote(src.base, inst, '9.0.0', path.join(CFG, 'dl-evil2'), { timeout: 10_000, pkgName: 'vmware-portal' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /서명 검증 실패/);
  assert.equal(installedVersion(inst), '9.0.0');
  assert.equal(src.hits.includes(evil.name), false, '사전 확인에서 걸려 번들을 받지 않는다(versions.json 의 sha 가 서명값과 다르다)');
});

test('S-10 ② 원격 — manifest 변조·미서명·모르는 키·회수 키·다른 버전 manifest·신뢰 키 0개는 설치 전 거부', async () => {
  const b = makeBundle('9.9.2');
  const good = signFor(K1, '9.9.2', [b]);
  const tampered = (() => { const e = JSON.parse(good); const p = JSON.parse(Buffer.from(e.payload, 'base64').toString()); p.createdAt = '2000-01-01'; e.payload = Buffer.from(JSON.stringify(p)).toString('base64'); return JSON.stringify(e); })();
  const b1 = makeBundle('9.9.1');
  const other = signFor(K1, '9.9.1', [b1, { name: b.name, bytes: b.bytes }]); // 9.9.1 manifest 가 9.9.2 번들을 담아도 버전이 다르다
  const cases = [
    { label: 'manifest 변조', manifest: tampered, code: 'bad-signature', trust: () => setHostTrust([K1]) },
    { label: '미서명(404)', manifest: null, code: 'manifest-missing', trust: () => setHostTrust([K1]) },
    { label: '모르는 키', manifest: signFor(K3, '9.9.2', [b]), code: 'unknown-key', trust: () => setHostTrust([K1]) },
    { label: '회수 키', manifest: good, code: 'revoked-key', trust: () => setHostTrust([K1], [kid(K1)]) },
    { label: '다른 버전 manifest 재사용', manifest: other, code: 'version-mismatch', trust: () => setHostTrust([K1]) },
    { label: '신뢰 키 0개', manifest: good, code: 'no-trusted-keys', trust: () => clearHostTrust() },
  ];
  for (const c of cases) {
    c.trust();
    const files = { 'versions.json': versionsFor('9.9.2', b), [b.name]: b.bytes };
    if (c.manifest) files['vmware-portal-9.9.2.manifest.json'] = c.manifest;
    const { base, hits } = await remoteSource(files);
    const inst = freshInstall('rej');
    const r = await upg.upgradeFromRemote(base, inst, '9.0.0', path.join(CFG, `dl-rej-${seq++}`), { timeout: 10_000, pkgName: 'vmware-portal' });
    assert.equal(r.ok, false, `${c.label}: 설치되면 안 된다`);
    assert.equal(r.signature?.code, c.code, `${c.label}: ${r.reason}`);
    assert.equal(installedVersion(inst), '9.0.0', `${c.label}: 설치 경로 그대로`);
    assert.equal(hits.includes(b.name), false, `${c.label}: 서명을 확인할 수 없으면 번들을 받지 않는다`);
  }
  setHostTrust([K1]);
});

test('S-10 정책 — warn 은 "서명 없음" 만 경고 후 허용하고, 틀린 서명은 여전히 거부한다', async () => {
  setHostTrust([K1]);
  process.env.UPGRADE_SIGNATURE_POLICY = 'warn';
  try {
    const b = makeBundle('9.9.3');
    const { base } = await remoteSource({ 'versions.json': versionsFor('9.9.3', b), [b.name]: b.bytes });
    const inst = freshInstall('warn');
    const r = await upg.upgradeFromRemote(base, inst, '9.0.0', path.join(CFG, 'dl-warn'), { timeout: 10_000, pkgName: 'vmware-portal' });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.signature.verified, false);
    assert.equal(r.signature.warned, true);
    assert.equal(installedVersion(inst), '9.9.3');
    assert.equal(sigmod.signatureStatus().last.warned, true, '상태가 경고를 기록한다');
    // 틀린 서명은 warn 이어도 거부
    const bad = signFor(K1, '9.9.3', [{ name: b.name, bytes: Buffer.from('other') }]);
    const r2 = await upg.downloadArchive(`${base}/${b.name}`, path.join(CFG, 'dl-warn2'), { sha256: core.sha256Hex(b.bytes), manifestText: bad, timeout: 10_000 });
    assert.equal(r2.ok, false);
    assert.match(r2.signature.code, /^(sha|size)-mismatch$/);
  } finally { delete process.env.UPGRADE_SIGNATURE_POLICY; }
});

test('S-10 ③ 키 교체 — 옛 키(K1)로 서명된 릴리스가 새 키(K2)를 실어 오면, 설치 뒤에는 K2 서명 릴리스를 받는다', async () => {
  setHostTrust([K1]);
  const rotatedKeys = JSON.stringify({ format: core.KEYS_FORMAT, schema: 1, keys: [keyEntry(K1), keyEntry(K2)] });
  const rel1 = makeBundle('9.9.4', { extra: { 'server/src/upgrade/release-signing-keys.json': rotatedKeys } });
  const watch1 = fs.mkdtempSync(path.join(CFG, 'w-rot-'));
  fs.copyFileSync(rel1.path, path.join(watch1, rel1.name));
  fs.writeFileSync(path.join(watch1, 'vmware-portal-9.9.4.manifest.json'), signFor(K1, '9.9.4', [rel1]));
  const inst = freshInstall('rot');
  const r1 = upg.upgradeFromArchive(path.join(watch1, rel1.name), inst, '9.0.0', 'vmware-portal');
  assert.equal(r1.ok, true, r1.reason);
  // 다음 릴리스는 새 키로만 서명됐다
  const rel2 = makeBundle('9.9.5');
  const watch2 = fs.mkdtempSync(path.join(CFG, 'w-rot2-'));
  fs.copyFileSync(rel2.path, path.join(watch2, rel2.name));
  fs.writeFileSync(path.join(watch2, 'vmware-portal-9.9.5.manifest.json'), signFor(K2, '9.9.5', [rel2]));
  // 옛 신뢰(K1 만)로는 받지 못한다
  const old = upg.upgradeFromArchive(path.join(watch2, rel2.name), freshInstall('rot-old'), '9.9.4', 'vmware-portal');
  assert.equal(old.signature?.code, 'unknown-key');
  // 설치된 릴리스의 신뢰 목록(K1+K2)으로는 받는다 — 실제 설치본의 키 파일을 읽는다
  clearHostTrust();
  const trust = sigmod.loadTrust({ repoFile: path.join(inst, 'server/src/upgrade/release-signing-keys.json') });
  assert.equal(trust.activeCount, 2);
  const r2 = upg.upgradeFromArchive(path.join(watch2, rel2.name), inst, '9.9.4', 'vmware-portal', { trust });
  assert.equal(r2.ok, true, r2.reason);
  assert.equal(r2.signature.keyId, kid(K2));
  assert.equal(installedVersion(inst), '9.9.5');
  setHostTrust([K1]);
});

test('S-10 ④ 감시 폴더 — manifest 가 있으면 설치, 없으면 거부, 번들 안의 버전이 서명 버전과 다르면 거부', () => {
  setHostTrust([K1]);
  const b = makeBundle('9.9.6');
  const w = fs.mkdtempSync(path.join(CFG, 'watch-'));
  const arch = path.join(w, b.name);
  fs.copyFileSync(b.path, arch);
  const noMan = upg.upgradeFromArchive(arch, freshInstall('w0'), '9.0.0', 'vmware-portal');
  assert.equal(noMan.ok, false);
  assert.equal(noMan.signature.code, 'manifest-missing');
  fs.writeFileSync(path.join(w, 'vmware-portal-9.9.6.manifest.json'), signFor(K1, '9.9.6', [b]));
  const inst = freshInstall('w1');
  const ok = upg.upgradeFromArchive(arch, inst, '9.0.0', 'vmware-portal');
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(installedVersion(inst), '9.9.6');
  // 이름표는 9.9.7 이고 내용은 9.9.6 인 번들을 9.9.7 로 서명한 경우(내용-버전 불일치)
  const mis = makeBundle('9.9.6', { marker: 'mislabeled' });
  const w2 = fs.mkdtempSync(path.join(CFG, 'watch2-'));
  const arch2 = path.join(w2, 'vmware-portal-9.9.7.tar.gz');
  fs.copyFileSync(mis.path, arch2);
  fs.writeFileSync(path.join(w2, 'vmware-portal-9.9.7.manifest.json'), signFor(K1, '9.9.7', [{ name: 'vmware-portal-9.9.7.tar.gz', bytes: mis.bytes }]));
  const r = upg.upgradeFromArchive(arch2, freshInstall('w2'), '9.0.0', 'vmware-portal');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'content-version-mismatch');
});

test('S-10 ⑤ 중앙 → 엣지 push — 실제 /api/upgrade/bundle 이 헤더의 manifest 로 검증한다', async () => {
  setHostTrust([K1]);
  const { upgradeRouter } = await import('../src/routes/upgrade.js');
  let restarts = 0;
  upg.setShutdownHandler(() => { restarts += 1; }); // restart=true 가 실제 프로세스를 끝내지 않게
  const app = express();
  app.use('/api/upgrade', upgradeRouter);
  const url = await listen(app);
  fs.rmSync(EDGE_APP, { recursive: true, force: true });
  fs.mkdirSync(EDGE_APP, { recursive: true });
  fs.writeFileSync(path.join(EDGE_APP, 'package.json'), JSON.stringify({ version: '9.0.0' }));
  const b = makeBundle('9.9.8');
  const dir = fs.mkdtempSync(path.join(CFG, 'push-'));
  const arch = path.join(dir, b.name);
  fs.copyFileSync(b.path, arch);
  // manifest 없음 → 거부
  const r0 = await upg.pushBundleToEdge({ url, token: '' }, arch, { timeout: 20_000 });
  assert.equal(r0.ok, false);
  assert.match(String(r0.reason), /서명/);
  // 변조 번들 + 원래 manifest → 거부
  const evil = makeBundle('9.9.8', { marker: 'evil' });
  const archEvil = path.join(fs.mkdtempSync(path.join(CFG, 'push-e-')), b.name);
  fs.copyFileSync(evil.path, archEvil);
  const rE = await upg.pushBundleToEdge({ url }, archEvil, { timeout: 20_000, manifestText: signFor(K1, '9.9.8', [b]) });
  assert.equal(rE.ok, false);
  assert.equal(installedVersion(EDGE_APP), '9.0.0');
  // 정상 — 번들 옆 manifest 를 싣는다
  fs.writeFileSync(path.join(dir, 'vmware-portal-9.9.8.manifest.json'), signFor(K1, '9.9.8', [b]));
  const r1 = await upg.pushBundleToEdge({ url }, arch, { timeout: 20_000 });
  assert.equal(r1.ok, true, r1.reason);
  assert.equal(installedVersion(EDGE_APP), '9.9.8');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(restarts, 1, '성공한 push 만 재시작한다');
  upg.setShutdownHandler(null);
});

test('S-10 ⑥ 중앙 → 수집기 push — 실제 /api/collector/upgrade 가 같은 판정을 쓴다(force 재설치 포함)', async () => {
  setHostTrust([K1]);
  const { collectorRouter } = await import('../src/routes/collector.js');
  const { pushBundleToCollector } = await import('../src/collector/upgradePush.js');
  const app = express();
  app.use('/api/collector', collectorRouter);
  const url = await listen(app);
  fs.rmSync(EDGE_APP, { recursive: true, force: true });
  fs.mkdirSync(EDGE_APP, { recursive: true });
  fs.writeFileSync(path.join(EDGE_APP, 'package.json'), JSON.stringify({ version: '9.0.0' }));
  const c = { id: 'c1', url, token: 'COLLECT-TOK' };
  const b = makeBundle('9.9.9');
  const man = signFor(K1, '9.9.9', [b]);
  const noSig = await pushBundleToCollector(c, b.bytes, { restart: false, timeout: 20_000 });
  assert.equal(noSig.ok, false);
  assert.match(noSig.reason, /서명/);
  const unknown = await pushBundleToCollector(c, b.bytes, { restart: false, timeout: 20_000, manifest: signFor(K3, '9.9.9', [b]) });
  assert.equal(unknown.ok, false);
  const ok = await pushBundleToCollector(c, b.bytes, { restart: false, timeout: 20_000, manifest: man });
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(installedVersion(EDGE_APP), '9.9.9');
  // force(같은 버전 재설치)도 서명이 필요하다
  const forceNoSig = await pushBundleToCollector(c, b.bytes, { restart: false, force: true, timeout: 20_000 });
  assert.equal(forceNoSig.ok, false);
  // 수집기로 밀 번들을 고르는 쪽(bundleSource)도 서명을 확인하고 manifest 를 함께 돌려준다
  const { resolveBundleBytes, lastBundleReject } = await import('../src/upgrade/bundleSource.js');
  const w = fs.mkdtempSync(path.join(CFG, 'bs-'));
  const nb = makeBundle('99.0.0');
  fs.copyFileSync(nb.path, path.join(w, nb.name));
  assert.equal(await resolveBundleBytes({ watchDir: w }), null, 'manifest 가 없으면 밀지 않는다');
  assert.match(String(lastBundleReject()), /서명/);
  fs.writeFileSync(path.join(w, 'vmware-portal-99.0.0.manifest.json'), signFor(K1, '99.0.0', [nb]));
  const got = await resolveBundleBytes({ watchDir: w });
  assert.equal(got?.version, '99.0.0');
  assert.ok(got.manifest && got.manifest.includes(core.MANIFEST_FORMAT), 'push 에 실을 manifest');
});

test('S-10 ⑦ 중앙 /dl 소스 → 엣지 자동 적용 — 중앙이 패키지와 manifest 를 받아 두고, 엣지가 /dl 에서 받아 검증한다', async () => {
  setHostTrust([K1]);
  const b = makeBundle('10.0.1');
  const man = signFor(K1, '10.0.1', [b]);
  // GitHub 롤링 릴리스 역할의 목 서버 → 중앙 downloadPackage
  const gh = await remoteSource({ 'versions.json': versionsFor('10.0.1', b), [b.name]: b.bytes, 'vmware-portal-10.0.1.manifest.json': man });
  const { downloadPackage } = await import('../src/upgrade/fetchPackage.js');
  const pkgDir = fs.mkdtempSync(path.join(CFG, 'pkgs-'));
  const d = await downloadPackage({ kind: 'bundle', baseUrl: gh.base, dir: pkgDir });
  assert.equal(d.ok, true, d.reason);
  assert.equal(d.signature.verified, true);
  assert.ok(fs.existsSync(path.join(pkgDir, 'vmware-portal-10.0.1.manifest.json')));
  // 미서명 릴리스는 중앙 패키지 폴더에도 들이지 않는다
  const gh2 = await remoteSource({ 'versions.json': versionsFor('10.0.1', b), [b.name]: b.bytes });
  const d2 = await downloadPackage({ kind: 'bundle', baseUrl: gh2.base, dir: fs.mkdtempSync(path.join(CFG, 'pkgs2-')) });
  assert.equal(d2.ok, false);
  // 중앙 /dl — 실제 dlSourceRouter(PACKAGE_DIR 기본 = CONFIG_DIR/packages)
  const central = path.join(CFG, 'packages');
  fs.mkdirSync(central, { recursive: true });
  for (const f of fs.readdirSync(pkgDir)) fs.copyFileSync(path.join(pkgDir, f), path.join(central, f));
  const { dlSourceRouter } = await import('../src/routes/dlsource.js');
  const app = express();
  app.use('/dl', dlSourceRouter);
  const cbase = `${await listen(app)}/dl`;
  const vj = await (await fetch(`${cbase}/versions.json`)).json();
  const e = vj.versions.find((x) => x.version === '10.0.1');
  assert.equal(e.manifest, 'vmware-portal-10.0.1.manifest.json');
  const mr = await fetch(`${cbase}/vmware-portal-10.0.1.manifest.json`);
  assert.equal(mr.status, 200);
  // 엣지(EDGE_MODE=all 의 remoteBase = 중앙 /dl)
  const inst = freshInstall('dl');
  const r = await upg.upgradeFromRemote(cbase, inst, '9.0.0', path.join(CFG, 'dl-edge'), { timeout: 10_000, pkgName: 'vmware-portal' });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.signature.verified, true);
  assert.equal(installedVersion(inst), '10.0.1');
});

test('S-10 ⑧ 오프라인 — verifyCli(같은 판정) 종료 코드 0/1/2 와 install.sh 확인 함수', async () => {
  setHostTrust([K1]);
  const { runVerify } = await import('../src/upgrade/verifyCli.js');
  const work = fs.mkdtempSync(path.join(CFG, 'off-'));
  const pkgName = 'vmware-portal-offline-10.0.2-el9-x64';
  const pkg = path.join(work, `${pkgName}.tar.gz`);
  fs.writeFileSync(pkg, crypto.randomBytes(4096));
  const pkgBytes = fs.readFileSync(pkg);
  const man = path.join(work, 'vmware-portal-10.0.2.manifest.json');
  fs.writeFileSync(man, signFor(K1, '10.0.2', [{ name: `${pkgName}.tar.gz`, bytes: pkgBytes, kind: 'installer' }]));
  const lines = [];
  assert.equal(await runVerify(['--file', pkg, '--manifest', man], { log: (l) => lines.push(l) }), 0, lines.join('\n'));
  assert.equal(sigmod.signatureStatus().last.where, 'offline', '같은 판정 함수(decideSignature)를 탄다');
  const evil = path.join(fs.mkdtempSync(path.join(CFG, 'off-e-')), `${pkgName}.tar.gz`);
  fs.writeFileSync(evil, crypto.randomBytes(4096));
  assert.equal(await runVerify(['--file', evil, '--manifest', man], { log: () => {} }), 1, '변조 패키지 = 1');
  assert.equal(await runVerify(['--file', pkg, '--manifest', path.join(work, 'none.json')], { log: () => {} }), 2, 'manifest 없음 = 2');

  // install.sh 가 source 하는 확인 함수 — 가짜 PREFIX(기존 설치본 = 이 저장소 코드 + 현재 node)로 실제 bash 실행
  const prefix = fs.mkdtempSync(path.join(CFG, 'prefix-'));
  fs.mkdirSync(path.join(prefix, 'runtime/node/bin'), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(prefix, 'runtime/node/bin/node'));
  fs.mkdirSync(path.join(prefix, 'app/server'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'server/src'), path.join(prefix, 'app/server/src'));
  const sdir = path.join(work, pkgName);
  fs.mkdirSync(sdir);
  const lib = path.join(ROOT, 'packaging/offline/release-verify-lib.sh');
  const run = (pkgArg, manArg, skip) => spawnSync('bash', ['-c', `set -euo pipefail; source "${lib}"; verify_release_package "$@"`, '_', prefix, sdir, CFG, '10.0.2', pkgArg, manArg, skip], { encoding: 'utf8' });
  const ok = run('', '', '0'); // 기본 위치(풀린 폴더 옆)에서 찾는다
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /서명 확인/);
  const bad = run(evil, man, '0');
  assert.equal(bad.status, 1, `변조 패키지면 설치를 멈춘다: ${bad.stdout}${bad.stderr}`);
  const missing = run('', path.join(work, 'none.json'), '0');
  assert.equal(missing.status, 1, '기존 설치본이 있으면 manifest 없이 진행하지 않는다');
  const skipped = run(evil, man, '1');
  assert.equal(skipped.status, 0);
  assert.match(skipped.stdout, /skip-signature-check/);
  // 신규 설치(기존 설치본 없음) + manifest 없음 → 안내 후 계속
  const fresh = spawnSync('bash', ['-c', `source "${lib}"; verify_release_package "$@"`, '_', path.join(CFG, 'no-prefix'), sdir, CFG, '10.0.3', '', '', '0'], { encoding: 'utf8' });
  assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
  // install.sh 가 실제로 이 함수를 부르고, 런타임을 지우기 전에 부른다
  const sh = fs.readFileSync(path.join(ROOT, 'packaging/offline/install.sh'), 'utf8');
  assert.ok(sh.indexOf('verify_release_package "$PREFIX"') > 0);
  assert.ok(sh.indexOf('verify_release_package "$PREFIX"') < sh.indexOf('rm -rf "$PREFIX/runtime/node"'), '기존 런타임(신뢰 기준)을 지우기 전에 확인한다');
  const bp = fs.readFileSync(path.join(ROOT, 'packaging/offline/build-package.sh'), 'utf8');
  assert.match(bp, /release-verify-lib\.sh/);
  assert.match(bp, /release-verify\.sh" "\$APP\/release-verify\.sh"/);
});

test('S-10 ⑨ 서명 키는 manifest·로그·서버 코드·패키지에 들어가지 않는다 · CI 사전 점검은 공개키 목록이 비면 실패한다', async () => {
  const sign = await import('../../scripts/release-sign.mjs');
  const pem = K1.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const der = K1.privateKey.export({ type: 'pkcs8', format: 'der' });
  const seed = der.subarray(der.length - 32).toString('base64');
  const work = fs.mkdtempSync(path.join(CFG, 'ci-'));
  const dist = path.join(work, 'dist');
  fs.mkdirSync(dist);
  const v = '10.1.0';
  for (const n of sign.requiredNames(v)) fs.writeFileSync(path.join(dist, n), crypto.randomBytes(512));
  const keysFile = path.join(work, 'keys.json');
  fs.writeFileSync(keysFile, JSON.stringify({ format: core.KEYS_FORMAT, schema: 1, keys: [keyEntry(K1)] }));
  const emptyKeys = path.join(work, 'empty.json');
  fs.writeFileSync(emptyKeys, JSON.stringify({ format: core.KEYS_FORMAT, schema: 1, keys: [] }));
  const script = path.join(ROOT, 'scripts/release-sign.mjs');
  // 사전 점검: 공개키 목록이 비면 실패 · 비밀이 없으면 실패 · 다른 키면 실패
  const env0 = { ...process.env };
  delete env0.RELEASE_SIGNING_KEY;
  const c1 = spawnSync(process.execPath, [script, '--check', '--keys', emptyKeys], { encoding: 'utf8', env: { ...env0, RELEASE_SIGNING_KEY: pem } });
  assert.equal(c1.status, 1);
  assert.match(c1.stderr, /쓸 수 있는 키가 없습니다/);
  const c2 = spawnSync(process.execPath, [script, '--check', '--keys', keysFile], { encoding: 'utf8', env: env0 });
  assert.equal(c2.status, 1);
  assert.match(c2.stderr, /RELEASE_SIGNING_KEY/);
  const c3 = spawnSync(process.execPath, [script, '--check', '--keys', keysFile], { encoding: 'utf8', env: { ...env0, RELEASE_SIGNING_KEY: K2.privateKey.export({ type: 'pkcs8', format: 'pem' }) } });
  assert.equal(c3.status, 1);
  assert.match(c3.stderr, /목록에 없습니다/);
  const c4 = spawnSync(process.execPath, [script, '--check', '--keys', keysFile], { encoding: 'utf8', env: { ...env0, RELEASE_SIGNING_KEY: Buffer.from(pem).toString('base64') } });
  assert.equal(c4.status, 0, c4.stderr);
  // 서명 — 출력·manifest 에 개인키가 없다
  const s = spawnSync(process.execPath, [script, '--version', v, '--dist', dist, '--keys', keysFile], { encoding: 'utf8', env: { ...env0, RELEASE_SIGNING_KEY: pem } });
  assert.equal(s.status, 0, s.stderr);
  const out = s.stdout + s.stderr + c1.stderr + c2.stderr + c3.stderr + c4.stdout;
  const pemBody = pem.split('\n').filter((l) => l && !l.startsWith('-----')).join('');
  for (const secret of [pemBody, seed, 'PRIVATE KEY']) assert.ok(!out.includes(secret), '로그에 개인키가 없다');
  const manText = fs.readFileSync(path.join(dist, `vmware-portal-${v}.manifest.json`), 'utf8');
  for (const secret of [pemBody, seed, 'PRIVATE']) assert.ok(!manText.includes(secret), 'manifest 에 개인키가 없다');
  const mv = core.verifyEnvelopeText(manText, core.mergeTrust([core.parseKeysDoc(JSON.parse(fs.readFileSync(keysFile, 'utf8')))]));
  assert.equal(mv.ok, true);
  assert.deepEqual(mv.manifest.files.map((f) => f.kind).sort(), ['bundle', 'installer', 'installer_cent9', 'windows']);
  // 저장소: 공개키 목록에는 공개키만 · 서버 코드는 서명 비밀을 읽지 않는다 · 패키지는 scripts/ 를 담지 않는다
  const repoKeys = fs.readFileSync(path.join(ROOT, 'server/src/upgrade/release-signing-keys.json'), 'utf8');
  assert.doesNotMatch(repoKeys, /PRIVATE|BEGIN/);
  for (const k of JSON.parse(repoKeys).keys) assert.ok(core.publicKeyFromBase64(k.publicKey), '공개키(SPKI)만');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(path.join(ROOT, 'server/src')).filter((x) => x.endsWith('.js'))) {
    const t = fs.readFileSync(f, 'utf8');
    assert.ok(!t.includes('RELEASE_SIGNING_KEY'), `${path.relative(ROOT, f)} 가 서명 비밀을 읽는다`);
    assert.ok(!/createPrivateKey\(/.test(t), `${path.relative(ROOT, f)} 가 개인키를 읽는다`);
  }
  const bp = fs.readFileSync(path.join(ROOT, 'packaging/offline/build-package.sh'), 'utf8').replace(/^\s*#.*$/gm, '');
  assert.doesNotMatch(bp, /REPO_ROOT\/scripts/, '설치 패키지·번들에 scripts/(서명 도구)를 담지 않는다');
  // CI: 비밀은 점검·서명 단계에만, 사전 점검은 빌드보다 앞
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
  assert.equal((yml.match(/secrets\.RELEASE_SIGNING_KEY/g) || []).length, 2);
  assert.ok(yml.indexOf('release-sign.mjs --check') < yml.indexOf('build-package.sh'), '사전 점검이 빌드보다 앞');
  assert.ok(yml.indexOf('release-sign.mjs --version') < yml.indexOf('update-versions.mjs'), 'versions.json 전에 서명');
  assert.match(yml, /REQUIRE_MANIFEST: '1'/);
  assert.doesNotMatch(yml, /continue-on-error:\s*true[\s\S]{0,200}release-sign/);
});
