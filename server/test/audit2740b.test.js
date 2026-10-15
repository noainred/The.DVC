/**
 * audit2740b.test.js — v2.740 감사 B·D 의 업그레이드 그룹(B-02·B-03·B-05·B-07·B-08·B-10·B-11) 회귀.
 *
 *  B-02 감시 폴더 번들 적용 실패가 원격 확인 결과(특히 '이미 최신')에 덮여 사라지지 않는다 · 확인 기록의 latest 는 두 출처 중 큰 쪽
 *  B-03 원격으로 적용한 직후 수집기 push 는 **방금 적용한 번들**을 민다(감시 폴더의 옛 번들이 아니라) ·
 *       resolveBundleBytes 는 감시 폴더 번들의 서명이 틀리면 원격으로 넘어간다
 *  B-05 저장소 키 파일에 형식 오류만 있으면(유효 키 0) '키 미설정' warn 이 아니라 require — CI(release-sign.mjs)와 같은 판정
 *  B-07 스캔 대기 뒤 적용 문구가 실제로 기다린 시간을 말한다(예전엔 언제나 '0분 기다림')
 *  B-08 미룸 사유의 시각은 포탈 시각(localStamp) — UTC ISO 가 아니다
 *  B-10 번들 내용 버전 불일치(content-version-mismatch) 실패가 '이미 지난 실패' 로 숨지 않는다(대상 버전 = 서명된 버전)
 *  B-11 패키지 받기의 manifest 시한 사유가 공용 metaTimeoutReason 을 쓴다(헤더 대기/본문 · 시도 횟수)
 *
 * 키는 테스트 안에서 임시로 만들고(신뢰 공개키는 임시 CONFIG_DIR 의 호스트 파일), 저장소 키 파일은 빈 목록 파일로 바꿔 둔다
 * (rvK_releaseSigning 과 같은 방식 — 운영 판정 코드는 그대로).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2740b-'));
Object.assign(process.env, { CONFIG_DIR: CFG, DATA_SOURCE: 'mock', SSRF_ALLOW_LOOPBACK: 'true', UPGRADE_CHECK_TIMEOUT_MS: '5000' });
for (const k of ['UPGRADE_SIGNATURE_POLICY', 'UPGRADE_ALLOW_UNVERIFIED', 'UPGRADE_WATCH_DIR', 'UPGRADE_ENABLED', 'UPGRADE_REMOTE_BASE', 'UPGRADE_INSTALL_DIR', 'EDGE_MODE', 'CENTRAL_URL', 'UPGRADE_SCAN_DEFER_MAX_MS']) delete process.env[k];

const core = await import('../src/upgrade/signatureCore.js');
const sigmod = await import('../src/upgrade/signature.js');
const EMPTY_REPO_KEYS = path.join(CFG, 'repo-release-signing-keys.json');
fs.writeFileSync(EMPTY_REPO_KEYS, JSON.stringify({ format: core.KEYS_FORMAT, schema: 1, keys: [], revoked: [] }));
sigmod._setRepoKeysFileForTest(EMPTY_REPO_KEYS);
const upg = await import('../src/upgrade/upgrade.js');
const auto = await import('../src/upgrade/autoState.js');
const bsrc = await import('../src/upgrade/bundleSource.js');
const { UpgradeManager } = await import('../src/upgrade/manager.js');
const { currentVersion } = await import('../src/config.js');
const sj = await import('../src/util/scanJournal.js');
const { localStamp } = await import('../src/util/dayKey.js');

const servers = [];
after(() => { for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch { /* */ } } });
async function listen(handler) {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${s.address().port}`;
}

const K1 = crypto.generateKeyPairSync('ed25519');
const kid = (k) => core.keyIdOf(k.publicKey);
const keyEntry = (k) => ({ keyId: kid(k), publicKey: core.spkiBase64Of(k.publicKey) });
const HOST = path.join(CFG, 'release-signing-keys.conf');
fs.writeFileSync(HOST, JSON.stringify({ format: core.KEYS_FORMAT, schema: 1, keys: [keyEntry(K1)], revoked: [] }), { mode: 0o600 });
fs.chmodSync(HOST, 0o600);

let seq = 0;
function makeBundle(version, { marker = '' } = {}) {
  const work = fs.mkdtempSync(path.join(CFG, `b${seq++}-`));
  const pkg = path.join(work, 'vmware-portal');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'vmware-portal', version }));
  fs.writeFileSync(path.join(pkg, 'marker.txt'), marker || `release ${version}`);
  const out = path.join(work, `vmware-portal-${version}.tar.gz`);
  execFileSync('tar', ['-czf', out, '-C', work, 'vmware-portal']);
  return { path: out, bytes: fs.readFileSync(out), name: path.basename(out) };
}
function signFor(key, version, files) {
  const m = core.buildManifest({
    version, keyId: kid(key),
    files: files.map((f) => ({ name: f.name, kind: 'bundle', platform: 'any', size: f.bytes.length, sha256: core.sha256Hex(f.bytes) })),
  });
  return core.serializeEnvelope(core.signManifest(m, key.privateKey));
}
function freshInstall(tag) {
  const dir = path.join(CFG, `inst-${tag}-${seq++}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: currentVersion() }));
  return dir;
}
/** 원격 소스 목 서버 — files: name → Buffer|string. 없는 이름은 404. */
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
const versionsFor = (latest, bundle) => JSON.stringify({ latest, versions: [{ version: latest, tar_gz: bundle.name, size_bytes: bundle.bytes.length, sha256: core.sha256Hex(bundle.bytes) }] });
/** 설정을 메모리에서만 바꾼 매니저(저장·타이머 없음). */
function makeManager(settings) {
  const m = new UpgradeManager();
  m.settings = { ...m.settings, packageName: 'vmware-portal', edges: [], downloadDir: path.join(CFG, `dl-${seq++}`), ...settings };
  return m;
}
const codes = (st) => (st?.issues || []).map((i) => i.code);

// ─────────────────────────────────────────────────────────────────────────────
test('B-02 감시 폴더 번들 거부가 원격 \'이미 최신\' 에 덮이지 않는다 · lastTick latest 는 두 출처 중 큰 쪽', async () => {
  const cur = currentVersion();
  const watch = fs.mkdtempSync(path.join(CFG, 'w02-'));
  fs.writeFileSync(path.join(watch, 'vmware-portal-99.0.0.tar.gz'), 'garbage-unsigned'); // 서명 manifest 없음 → 거부된다
  const curBundle = makeBundle(cur);
  const rem = await remoteSource({ 'versions.json': versionsFor(cur, curBundle) }); // 원격은 지금 버전 = 최신
  const m = makeManager({ enabled: true, autoApply: true, watchDir: watch, remoteBase: rem.base, installDir: freshInstall('b02'), pollIntervalMs: 0 });

  const r = await m.apply({ source: 'auto', restart: false, trigger: 'manual' });
  assert.equal(r.ok, false);
  assert.notEqual(r.upToDate, true, "감시 폴더 번들을 거부했는데 '이미 최신' 으로 보고하지 않는다");
  assert.match(String(r.reason), /감시 폴더/, `감시 폴더 실패 사유가 결과에 남는다: ${r.reason}`);
  assert.match(String(r.reason), /서명 manifest 가 없습니다/);
  assert.equal(m.lastResult.ok, false);
  assert.ok(codes(m.status().auto).includes('apply-failed'), '화면이 적용 실패를 말한다(매 주기 같은 거부가 반복된다)');

  await m.tick();
  assert.equal(m.lastTick.outcome, 'apply-failed');
  assert.equal(m.lastTick.latest, '99.0.0', `확인 기록의 latest 는 감시 폴더의 더 새 버전(원격 ${cur} 이 아니라): ${m.lastTick.latest}`);
  assert.match(String(m.lastTick.reason), /감시 폴더/);
});

test('B-03 ① 원격 적용 직후 수집기 push 는 방금 적용한 번들(옛 감시 폴더 번들이 아니라)', async () => {
  const cur = currentVersion();
  // 지난번에 쓰고 남긴 '지금 버전' 번들 — 서명도 맞다(그래서 예전 코드는 이것을 골라 수집기에 밀었다)
  const watch = fs.mkdtempSync(path.join(CFG, 'w03-'));
  const old = makeBundle(cur, { marker: 'old-leftover' });
  fs.copyFileSync(old.path, path.join(watch, old.name));
  fs.writeFileSync(path.join(watch, `vmware-portal-${cur}.manifest.json`), signFor(K1, cur, [old]));
  // 원격에는 새 버전(서명됨)
  const nb = makeBundle('99.0.2');
  const man = signFor(K1, '99.0.2', [nb]);
  const rem = await remoteSource({ 'versions.json': versionsFor('99.0.2', nb), [nb.name]: nb.bytes, 'vmware-portal-99.0.2.manifest.json': man });
  // 수집기 목 서버 — 받은 번들의 sha256 과 manifest 헤더를 기록한다
  const pushes = [];
  const cbase = await listen((q, r) => {
    const chunks = [];
    q.on('data', (c) => chunks.push(c));
    q.on('end', () => {
      const body = Buffer.concat(chunks);
      pushes.push({ url: q.url, sha: core.sha256Hex(body), manifest: sigmod.decodeManifestHeader(q.headers[sigmod.MANIFEST_HEADER]) });
      r.setHeader('content-type', 'application/json');
      r.end(JSON.stringify({ ok: true, version: '99.0.2' }));
    });
  });
  fs.writeFileSync(path.join(CFG, 'collectors.json'), JSON.stringify({ collectors: [{ id: 'c1', name: 'c1', url: cbase, token: 'T', enabled: true }] }));
  try {
    const m = makeManager({ enabled: true, autoApply: true, watchDir: watch, remoteBase: rem.base, installDir: freshInstall('b03'), pollIntervalMs: 0 });
    const r = await m.apply({ source: 'auto', restart: false, trigger: 'manual' });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.version, '99.0.2');
    assert.equal(pushes.length, 1, `수집기 push 1건: ${JSON.stringify(pushes)}`);
    assert.equal(pushes[0].sha, core.sha256Hex(nb.bytes), '방금 적용한 99.0.2 번들을 민다(감시 폴더의 옛 번들이 아니라)');
    assert.notEqual(pushes[0].sha, core.sha256Hex(old.bytes));
    assert.ok(pushes[0].manifest && pushes[0].manifest.includes(core.MANIFEST_FORMAT), '서명 manifest 를 함께 싣는다');
  } finally {
    fs.rmSync(path.join(CFG, 'collectors.json'), { force: true });
  }
});

test('B-03 ② resolveBundleBytes — 감시 폴더 번들의 서명이 틀리면 원격으로 넘어간다', async () => {
  const cur = currentVersion();
  const watch = fs.mkdtempSync(path.join(CFG, 'w03b-'));
  fs.writeFileSync(path.join(watch, `vmware-portal-${cur}.tar.gz`), 'old-bundle-without-manifest');
  const nb = makeBundle('99.0.3');
  const rem = await remoteSource({ 'versions.json': versionsFor('99.0.3', nb), [nb.name]: nb.bytes, 'vmware-portal-99.0.3.manifest.json': signFor(K1, '99.0.3', [nb]) });
  const b = await bsrc.resolveBundleBytes({ watchDir: watch, remoteBase: rem.base });
  assert.ok(b, `원격 번들을 돌려줘야 한다(감시 폴더 거부 사유: ${bsrc.lastBundleReject()})`);
  assert.equal(b.source, 'remote');
  assert.equal(b.version, '99.0.3');
  assert.equal(core.sha256Hex(b.bytes), core.sha256Hex(nb.bytes));
  // 원격도 없으면 null 이고 감시 폴더 거부 사유가 남는다
  const none = await bsrc.resolveBundleBytes({ watchDir: watch, remoteBase: '' });
  assert.equal(none, null);
  assert.match(String(bsrc.lastBundleReject()), /서명/);
});

test('B-05 키 파일에 형식 오류만 있으면 require — CI 사전 점검과 같은 판정', async () => {
  const bad = path.join(CFG, 'repo-bad-keys.json');
  const noHost = path.join(CFG, 'no-such-host.conf');
  // 공개키는 맞는데 keyId 이름표가 틀린 항목 — parseKeysDoc 이 버리고 errors 에 남긴다(유효 키 0 · 회수 0)
  const docs = {
    'keyId 오타': { format: core.KEYS_FORMAT, schema: 1, keys: [{ keyId: 'ed25519:0000000000000000', publicKey: core.spkiBase64Of(K1.publicKey) }], revoked: [] },
    '공개키 잘림': { format: core.KEYS_FORMAT, schema: 1, keys: [{ publicKey: core.spkiBase64Of(K1.publicKey).slice(0, 20) }], revoked: [] },
    'keys 가 배열 아님': { format: core.KEYS_FORMAT, schema: 1, keys: {}, revoked: [] },
    'format 틀림': { format: 'something-else', keys: [] },
  };
  const sign = await import('../../scripts/release-sign.mjs');
  for (const [name, doc] of Object.entries(docs)) {
    fs.writeFileSync(bad, JSON.stringify(doc));
    const t = sigmod.loadTrust({ repoFile: bad, hostFile: noHost });
    assert.ok(t.errors.length > 0, `${name}: 오류가 있어야 한다`);
    assert.equal(t.activeCount, 0);
    assert.equal(core.trustUnconfigured(t), false, `${name}: 키 파일 오류가 있으면 '설정 안 됨' 이 아니다`);
    const pol = sigmod.signaturePolicy({}, t);
    assert.equal(pol.policy, 'require', `${name}: ${JSON.stringify(pol)}`);
    const d = sigmod.decideSignature({ manifestText: null, bytes: Buffer.from('x'), name: 'vmware-portal-9.9.9.tar.gz', where: 'watch', trust: t });
    assert.equal(d.ok, false, `${name}: 서명 없는 번들을 설치하지 않는다`);
    // CI(release-sign.mjs)도 같은 상태를 '서명 없이 게시 불가' 로 본다
    assert.equal(sign.unsignedAllowed({ env: {}, keysFile: bad }).ok, false, `${name}: CI 판정`);
  }
  // 대조 — 완전히 빈 목록은 여전히 '키 미설정' warn(v2.735.1 결정 그대로)
  fs.writeFileSync(bad, JSON.stringify({ format: core.KEYS_FORMAT, schema: 1, keys: [], revoked: [] }));
  const t0 = sigmod.loadTrust({ repoFile: bad, hostFile: noHost });
  assert.equal(sigmod.signaturePolicy({}, t0).policy, 'warn');
  assert.equal(sign.unsignedAllowed({ env: {}, keysFile: bad }).ok, true);
});

test('B-07·B-08 스캔 대기 — 미룸 사유 시각은 포탈 시각 · 끝난 뒤 문구가 실제 기다린 시간을 말한다', async () => {
  const watch = fs.mkdtempSync(path.join(CFG, 'w07-'));
  fs.writeFileSync(path.join(watch, 'vmware-portal-99.0.0.tar.gz'), 'garbage'); // 적용은 실패한다(재시작하지 않는다)
  const m = makeManager({ enabled: true, autoApply: true, watchDir: watch, remoteBase: '', installDir: freshInstall('b07'), pollIntervalMs: 0 });
  sj.scanStarted('isidu', 'audit2740b', { label: 'demo du' });
  const realSI = globalThis.setInterval;
  const captured = [];
  globalThis.setInterval = (fn, ms) => { const h = realSI(() => {}, 1e9); captured.push({ fn, ms, h }); return h; };
  let realNow = null;
  const realLog = console.log;
  try {
    await m.tick();
    globalThis.setInterval = realSI;
    assert.equal(m.lastTick.outcome, 'deferred');
    const until = m.deferral.until;
    assert.doesNotMatch(String(m.lastTick.reason), /\d{4}-\d\d-\d\dT\d\d:\d\d/, `UTC ISO 시각을 싣지 않는다: ${m.lastTick.reason}`);
    assert.ok(String(m.lastTick.reason).includes(localStamp(until)), `포탈 시각(localStamp)으로 말한다: ${m.lastTick.reason}`);

    const cb = captured.find((c) => c.ms === 60_000);
    assert.ok(cb, '대기 중 1분 재확인 타이머');
    sj.scanFinished('isidu', 'audit2740b');
    realNow = Date.now;
    const t0 = realNow();
    Date.now = () => t0 + 45 * 60_000; // 45분 뒤
    const logs = [];
    console.log = (...a) => { logs.push(a.join(' ')); };
    cb.fn();
    for (let i = 0; i < 100 && !(m.lastTick && m.lastTick.outcome !== 'applying' && m.lastTick.outcome !== 'deferred'); i += 1) await new Promise((r) => setTimeout(r, 30));
    console.log = realLog;
    const note = logs.find((l) => /실행 중이던 스캔이 끝나 적용합니다/.test(l));
    assert.ok(note, `적용 문구: ${logs.join(' / ')}`);
    assert.match(note, /45분 기다림/, `실제로 기다린 시간: ${note}`);
    assert.equal(m.deferral, null);
  } finally {
    globalThis.setInterval = realSI;
    console.log = realLog;
    if (realNow) Date.now = realNow;
    sj.scanFinished('isidu', 'audit2740b');
    for (const c of captured) clearInterval(c.h);
  }
});

test('B-10 내용 버전 불일치 실패는 지난 실패로 숨지 않는다 — 대상은 서명된 버전', () => {
  const cur = currentVersion();
  // 이름표·서명은 99.0.1 인데 내용은 지금 버전인 번들(미러가 이름만 새 버전인 옛 번들을 준 경우)
  const mis = makeBundle(cur, { marker: 'mislabeled' });
  const w = fs.mkdtempSync(path.join(CFG, 'w10-'));
  const arch = path.join(w, 'vmware-portal-99.0.1.tar.gz');
  fs.copyFileSync(mis.path, arch);
  fs.writeFileSync(path.join(w, 'vmware-portal-99.0.1.manifest.json'), signFor(K1, '99.0.1', [{ name: 'vmware-portal-99.0.1.tar.gz', bytes: mis.bytes }]));
  const r = upg.upgradeFromArchive(arch, freshInstall('b10'), cur, 'vmware-portal');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'content-version-mismatch');
  const rec = auto.sanitizeResult({ at: Date.now(), source: 'watch', trigger: 'auto', ...r });
  assert.equal(auto.failureMoot(rec, null, cur), false, `내용 버전(${cur})이 지금 버전이어도 대상(99.0.1)은 아직 설치되지 않았다`);
  const st = auto.autoUpgradeState({ settings: { enabled: true, remoteBase: 'https://x.invalid/dl', installDir: '/opt/x', autoApply: true }, intervalMs: 3_600_000, armedAt: Date.now(), lastResult: rec, currentVersion: cur, now: Date.now() });
  assert.ok(codes(st).includes('apply-failed'), '매 주기 반복되는 실패를 화면이 말한다');
  // 그 대상 버전이 실제로 설치되면 그때는 지난 실패다
  assert.equal(auto.failureMoot(rec, null, '99.0.1'), true);
});

test('B-11 패키지 받기 manifest 시한 사유 — 공용 metaTimeoutReason(헤더 대기 · 시도 횟수)', { timeout: 30_000 }, async () => {
  const b = makeBundle('99.0.4');
  const files = { 'versions.json': versionsFor('99.0.4', b), [b.name]: b.bytes };
  const base = await listen((q, r) => {
    const name = decodeURIComponent(q.url.split('?')[0].slice(1));
    if (name in files) return r.end(files[name]);
    if (name.endsWith('.manifest.json')) return; // 응답하지 않는다(헤더 대기 시한)
    r.statusCode = 404; r.end('nf');
  });
  const { downloadPackage } = await import('../src/upgrade/fetchPackage.js');
  const d = await downloadPackage({ kind: 'bundle', baseUrl: base, dir: fs.mkdtempSync(path.join(CFG, 'pkg11-')) });
  assert.equal(d.ok, false);
  assert.match(String(d.reason), /서명 manifest 을 전체 시한\(5초\) 안에 다 받지 못해 중단했습니다/, d.reason);
  assert.match(String(d.reason), /저장소가 응답\(헤더\)을 시작하지 않았습니다/);
  assert.match(String(d.reason), /시도 \d+번/);
});
