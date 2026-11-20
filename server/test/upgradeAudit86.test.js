/**
 * 전체 점검 86회차 — 업그레이드 · 자동 업그레이드 · 서명 · 엣지 push(server/src/upgrade/).
 *  F1 기본 downloadDir(<앱>/server/.upgrade-cache)은 설치 디렉터리 안이라 스왑이 받은 번들을 백업으로 옮긴다 — 적용 직후 보관 · 엣지/수집 서버 push 가
 *     옮기기 전 경로를 읽어 ENOENT 로 실패했다(재현: 실제 원격 소스 + 실제 매니저 apply). 옮겨진 경로를 돌려준다.
 *  F2 적용 기록의 수집 서버 push 정제(autoState.sanitizeCollectorPush)가 '이미 최신' · '설치 대기' 표지를 버려, 재시작한 중앙의 수집 서버 표가
 *     보류한 엣지를 '적용'(초록)으로 보였다(51회차 반증 A2 의 형제 칸).
 *  F3 옛 방식 엣지 push 수신(/api/upgrade/bundle)이 설치 전 WAL 체크포인트를 하지 않았다(형제 수집기 라우트 · 자동 적용 · 보류 해제는 한다).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'upg86-'));
const PKG = path.join(CFG, 'packages');
Object.assign(process.env, { CONFIG_DIR: CFG, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', SSRF_ALLOW_LOOPBACK: 'true', UPGRADE_CHECK_TIMEOUT_MS: '5000', PACKAGE_DIR: PKG });
for (const k of ['UPGRADE_SIGNATURE_POLICY', 'UPGRADE_ALLOW_UNVERIFIED', 'UPGRADE_WATCH_DIR', 'UPGRADE_ENABLED', 'UPGRADE_REMOTE_BASE', 'UPGRADE_INSTALL_DIR', 'UPGRADE_DOWNLOAD_DIR',
  'EDGE_MODE', 'CENTRAL_URL', 'UPGRADE_SCAN_DEFER_MAX_MS', 'UPGRADE_EDGE_AUTO', 'UPGRADE_EDGES']) delete process.env[k];
const servers = [];
after(() => {
  for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch { /* */ } }
  fs.rmSync(CFG, { recursive: true, force: true });
  process.once('exit', () => { try { fs.rmSync(CFG, { recursive: true, force: true }); } catch { /* 종료 중 */ } });
});

const core = await import('../src/upgrade/signatureCore.js');
const sigmod = await import('../src/upgrade/signature.js');
const EMPTY_REPO_KEYS = path.join(CFG, 'repo-keys.json');
fs.writeFileSync(EMPTY_REPO_KEYS, JSON.stringify({ format: core.KEYS_FORMAT, schema: 1, keys: [], revoked: [] }));
sigmod._setRepoKeysFileForTest(EMPTY_REPO_KEYS);
const K1 = crypto.generateKeyPairSync('ed25519');
const kid = core.keyIdOf(K1.publicKey);
const HOST = path.join(CFG, 'release-signing-keys.conf');
fs.writeFileSync(HOST, JSON.stringify({ format: core.KEYS_FORMAT, schema: 1, keys: [{ keyId: kid, publicKey: core.spkiBase64Of(K1.publicKey) }], revoked: [] }), { mode: 0o600 });
fs.chmodSync(HOST, 0o600);
sigmod._setRunningAsRootForTest(false);

const NOW = Date.UTC(2026, 10, 17, 4, 37); // 정시 경계에서 떨어진 고정 시각
let seq = 0;
function makeBundle(version) {
  const work = fs.mkdtempSync(path.join(CFG, `b${seq++}-`));
  const pkg = path.join(work, 'vmware-portal');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'vmware-portal', version }));
  fs.writeFileSync(path.join(pkg, 'marker.txt'), `release ${version}`);
  const out = path.join(work, `vmware-portal-${version}.tar.gz`);
  execFileSync('tar', ['-czf', out, '-C', work, 'vmware-portal']);
  return { path: out, bytes: fs.readFileSync(out), name: path.basename(out) };
}
function signFor(version, b) {
  const m = core.buildManifest({ version, keyId: kid, files: [{ name: b.name, kind: 'bundle', platform: 'any', size: b.bytes.length, sha256: core.sha256Hex(b.bytes) }] });
  return core.serializeEnvelope(core.signManifest(m, K1.privateKey));
}
/** 설치본 — 기본 배치처럼 downloadDir 이 그 안(<설치>/server/.upgrade-cache)에 있다. */
function installWithCache(tag) {
  const dir = path.join(CFG, `inst-${tag}-${seq++}`);
  fs.mkdirSync(path.join(dir, 'server', 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  return { dir, cache: path.join(dir, 'server', '.upgrade-cache') };
}
async function listen(handler) {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${s.address().port}`;
}

test('F1: 설치 디렉터리 안의 번들 — 스왑 뒤 옮겨진 경로를 돌려주고 보관 · push 용 재확인이 그 파일을 읽는다', async () => {
  const up = await import('../src/upgrade/upgrade.js');
  const fleet = await import('../src/upgrade/fleetBundle.js');
  const bsrc = await import('../src/upgrade/bundleSource.js');
  const { dir, cache } = installWithCache('unit');
  fs.mkdirSync(cache, { recursive: true });
  const b = makeBundle('99.1.1');
  const arch = path.join(cache, b.name);
  fs.copyFileSync(b.path, arch);
  fs.writeFileSync(path.join(cache, core.manifestNameFor('99.1.1')), signFor('99.1.1', b));
  const r = up.upgradeFromArchive(arch, dir, '1.0.0', 'vmware-portal', { where: 'remote' });
  assert.equal(r.ok, true, r.reason);
  assert.ok(r.backup && fs.existsSync(r.backup), '옛 설치는 백업으로');
  assert.equal(fs.existsSync(arch), false, '전제: 받은 번들은 설치 디렉터리와 함께 백업으로 옮겨졌다');
  assert.ok(fs.existsSync(r.appliedArchive), `돌려준 경로가 실제로 있다: ${r.appliedArchive}`);
  assert.ok(r.appliedArchive.startsWith(r.backup + path.sep), '백업 안의 경로');
  assert.equal(core.sha256Hex(fs.readFileSync(r.appliedArchive)), core.sha256Hex(b.bytes));
  const back = bsrc.bundleFromArchive(r.appliedArchive);
  assert.ok(back, `push 용 재확인(서명 포함)이 통과한다: ${bsrc.lastBundleReject()}`);
  assert.ok(back.manifest?.includes(core.MANIFEST_FORMAT), '옆의 manifest 도 같이 옮겨졌다');
  const k = fleet.keepBundle({ archivePath: r.appliedArchive, version: '99.1.1' });
  assert.equal(k.ok, true, k.reason); assert.equal(k.manifest, true);
  // 밖에 있는 번들은 예전 그대로(원래 경로)
  const out = makeBundle('99.1.2');
  fs.writeFileSync(path.join(path.dirname(out.path), core.manifestNameFor('99.1.2')), signFor('99.1.2', out));
  const { dir: dir2 } = installWithCache('outside');
  const r2 = up.upgradeFromArchive(out.path, dir2, '1.0.0', 'vmware-portal', { where: 'watch' });
  assert.equal(r2.ok, true, r2.reason); assert.equal(r2.appliedArchive, out.path);
  // 경로 판정(순수에 가깝다) — 설치 디렉터리 밖 · 이름이 '..' 로 시작하는 형제는 안이 아니다
  assert.equal(up.archiveRelInInstall('/opt/app/server/.upgrade-cache/x.tar.gz', '/opt/app'), path.join('server', '.upgrade-cache', 'x.tar.gz'));
  assert.equal(up.archiveRelInInstall('/opt/app2/x.tar.gz', '/opt/app'), null);
  assert.equal(up.archiveRelInInstall('/opt/x.tar.gz', '/opt/app'), null);
});

test('F1: 실제 원격 소스 + 실제 매니저 적용 — 기본 downloadDir(설치 안)에서도 패키지 폴더에 보관하고 수집 서버에 민다', async () => {
  const { UpgradeManager } = await import('../src/upgrade/manager.js');
  const b = makeBundle('99.2.1');
  const man = signFor('99.2.1', b);
  const remote = await listen((q, r) => {
    if (q.url.endsWith('/versions.json')) { r.setHeader('content-type', 'application/json'); return r.end(JSON.stringify({ latest: '99.2.1', versions: [{ version: '99.2.1', tar_gz: b.name, size_bytes: b.bytes.length, sha256: core.sha256Hex(b.bytes) }] })); }
    if (q.url.endsWith(`/${b.name}`)) return r.end(b.bytes);
    if (q.url.endsWith(`/${core.manifestNameFor('99.2.1')}`)) return r.end(man);
    r.statusCode = 404; r.end('');
  });
  const pushes = [];
  const edge = await listen((q, r) => {
    const chunks = []; q.on('data', (c) => chunks.push(c));
    q.on('end', () => { pushes.push({ url: q.url, sha: core.sha256Hex(Buffer.concat(chunks)) }); r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ ok: true, version: '99.2.1' })); });
  });
  const COL = path.join(CFG, 'collectors.json');
  fs.writeFileSync(COL, JSON.stringify({ collectors: [{ id: 'e1', name: 'e1', url: `${edge}/e1`, token: 'T', enabled: true }] }));
  try {
    const { dir, cache } = installWithCache('mgr');
    const m = new UpgradeManager();
    m.settings = { ...m.settings, enabled: true, autoApply: true, watchDir: '', remoteBase: `${remote}/dl`, token: '', installDir: dir, downloadDir: cache, packageName: 'vmware-portal', edges: [], pollIntervalMs: 0, edgeAutoUpgrade: true };
    const r = await m.apply({ source: 'remote', restart: false, trigger: 'manual' });
    assert.equal(r.ok, true, r.reason);
    assert.equal(pushes.length, 1, `적용 직후 수집 서버 push 1건(예전: 번들을 다시 확인하지 못해 0건) — ${JSON.stringify(m.lastResult.collectorPush)}`);
    assert.equal(pushes[0].sha, core.sha256Hex(b.bytes));
    assert.equal(m.lastResult.collectorPush?.skipped, undefined, '생략 사유가 없다');
    assert.ok(fs.existsSync(path.join(PKG, b.name)), '패키지 폴더에 보관(재시작 뒤 엣지 동기화 · /dl 이 쓴다)');
    assert.ok(fs.existsSync(path.join(PKG, core.manifestNameFor('99.2.1'))), 'manifest 도 보관');
  } finally { fs.rmSync(COL, { force: true }); }
});

test('F2: 적용 기록의 수집 서버 push — 이미 최신 · 설치 대기 표지가 파일 정제 · 재시작 복원을 지나 수집 서버 표까지 간다', async () => {
  const { summarizeCollectorPush } = await import('../src/upgrade/manager.js');
  const { sanitizeResult, restoreStatus } = await import('../src/upgrade/autoState.js');
  const { mergeAutoPushStatus } = await import('../src/collector/upgradePush.js');
  const col = await import('../../web/src/views/collectorUpgradeText.js');
  const cp = summarizeCollectorPush([
    { id: 'c1', name: 'c1', ok: true, status: 200, version: '3.18.7', deferred: true, waitMs: 3_600_000, reason: '진행 중 작업 1건(Bareos 등록)이 끝나면 v3.18.7 를 설치하고 재시작합니다' },
    { id: 'c2', name: 'c2', ok: false, status: 200, version: '3.18.7', upToDate: true, reason: 'HTTP 200 — not newer (3.18.7 <= 3.18.7)' },
    { id: 'c3', name: 'c3', ok: true, status: 200, version: '3.18.7' },
  ]);
  const lr = { at: NOW, source: 'auto', ok: true, version: '3.18.7', restarting: true, collectorPush: cp };
  // 재시작 전에 파일로(sanitizeResult) → 재시작 뒤 되살림(restoreStatus) — 중앙은 자동 적용 직후 언제나 재시작한다
  const restored = restoreStatus({ lastResult: JSON.parse(JSON.stringify(sanitizeResult(lr))) }, '3.18.7').lastResult;
  const items = Object.fromEntries(restored.collectorPush.items.map((x) => [x.id, x]));
  assert.equal(items.c1.deferred, true, '설치 대기 표지가 남는다');
  assert.equal(items.c2.upToDate, true, '이미 최신 표지가 남는다');
  assert.equal(items.c3.deferred, undefined); assert.equal(items.c3.upToDate, undefined);
  // 수집 서버 표 — 재시작 직후 메모리 상태(pull 전)는 비어 있다
  const st = mergeAutoPushStatus({}, restored);
  const c1 = col.upgradeCell(st.c1.upgrade);
  assert.match(c1.text, /설치 대기/); assert.doesNotMatch(c1.text, /적용/); assert.equal(c1.tone, 'warn');
  const c2 = col.upgradeCell(st.c2.upgrade);
  assert.match(c2.text, /이미 최신/); assert.equal(c2.tone, 'ok', '이미 최신은 실패(빨강)가 아니다');
  assert.match(col.upgradeCell(st.c3.upgrade).text, /적용/);
  // 화면 응답(status().lastResult)도 같은 정제를 지난다
  assert.equal(sanitizeResult(lr).collectorPush.items[0].deferred, true);
  // 아는 값만 — true 가 아니면 싣지 않는다
  const odd = sanitizeResult({ at: NOW, ok: true, collectorPush: { total: 1, ok: 1, items: [{ id: 'x', ok: true, deferred: 'yes', upToDate: 1 }] } });
  assert.equal(odd.collectorPush.items[0].deferred, undefined); assert.equal(odd.collectorPush.items[0].upToDate, undefined);
});

test('F3: 옛 방식 엣지 push 수신(/api/upgrade/bundle) — 설치 전에 설정 디렉터리의 WAL SQLite 를 체크포인트한다', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const express = (await import('express')).default;
  const { upgradeRouter } = await import('../src/routes/upgrade.js');
  const { upgradeManager } = await import('../src/upgrade/manager.js');
  const dbFile = path.join(CFG, 'f3-series.db');
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(a INTEGER, b TEXT);');
  const ins = db.prepare('INSERT INTO t VALUES (?, ?)');
  for (let i = 0; i < 200; i++) ins.run(i, 'x'.repeat(200));
  const walSize = () => { try { return fs.statSync(`${dbFile}-wal`).size; } catch { return 0; } };
  assert.ok(walSize() > 0, '전제: -wal 에 아직 본 .db 로 옮기지 않은 페이지가 있다');
  const saved = upgradeManager.settings;
  const { dir } = installWithCache('f3');
  upgradeManager.settings = { ...saved, enabled: true, installDir: dir, packageName: 'vmware-portal' };
  const app = express();
  app.use((req, _res, next) => { req.user = { username: 'admin', role: 'admin', scope: null }; next(); });
  app.use('/api/upgrade', upgradeRouter);
  const srv = http.createServer(app); servers.push(srv);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const bytes = crypto.randomBytes(256);   // 서명 없는 번들 — 설치는 거부되지만 체크포인트는 그 전에 돈다(수집기 라우트와 같은 순서)
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/upgrade/bundle`, {
      method: 'POST', headers: { 'content-type': 'application/gzip', 'x-bundle-sha256': core.sha256Hex(bytes) }, body: bytes,
    });
    const j = await res.json();
    assert.equal(j.ok, false, '서명 manifest 가 없어 설치는 거부');
    assert.equal(walSize(), 0, '설치(설정 디렉터리 복사) 전에 -wal 을 본 .db 로 옮겨 비웠다');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get().n, 200, '데이터는 그대로');
  } finally { upgradeManager.settings = saved; db.close(); }
});

test('개선: 엣지 보류 시한(holdUntil)이 중앙 재시작을 넘는다 — settle 이 지나도 보류 상한 안이면 다시 밀지 않는다 · 상한 밖 값은 버린다', async () => {
  const sync = await import('../src/upgrade/edgeSync.js');
  const store = await import('../src/upgrade/statusStore.js');
  const { sanitizeEdgeSyncState } = await import('../src/upgrade/autoState.js');
  const HOUR = 3_600_000;
  const mk = () => new sync.EdgeSyncRunner({
    settings: () => ({ enabled: true, edgeAutoUpgrade: true, edges: [] }), now: () => NOW, currentVersion: () => '3.18.7', intervalMs: 600_000,
    collectors: () => [{ id: 'c1', name: 'c1', url: 'https://edge.example:8443', enabled: true }],
    statusOf: () => ({ ok: true, version: '3.18.6' }), log: { log() {}, warn() {} },
  });
  const r1 = mk();
  r1.attempts.set('c1', { at: NOW - 40 * 60_000, ok: true, target: '3.18.7', attempts: 0, reason: null, holdUntil: NOW + 2 * HOUR });
  const file = path.join(CFG, 'upgrade-status-86.json');
  assert.equal(store.writeUpgradeStatus(file, { edgeSyncState: r1.persistState() }), null);
  const r2 = mk();
  r2.restoreState(store.readUpgradeStatus(file).doc.edgeSyncState);
  const p = r2.plan(NOW);
  assert.equal(p.edges[0].state, 'waiting', `재시작 뒤에도 보류 상한까지 기다린다(예전: settle 30분 뒤 behind): ${p.edges[0].state}`);
  assert.deepEqual(p.push, []);
  // 정제 — 실패 기록 · 기록 시각보다 앞 · 12시간 넘는 시한은 되살리지 않는다
  const bad = sanitizeEdgeSyncState({ attempts: [
    ['a', { at: NOW, ok: false, target: '3.18.7', attempts: 1, holdUntil: NOW + HOUR }],
    ['b', { at: NOW, ok: true, target: '3.18.7', attempts: 0, holdUntil: NOW - 1 }],
    ['c', { at: NOW, ok: true, target: '3.18.7', attempts: 0, holdUntil: NOW + 13 * HOUR }],
    ['d', { at: NOW, ok: true, target: '3.18.7', attempts: 0, holdUntil: NOW + HOUR }],
  ] });
  const by = Object.fromEntries(bad.attempts);
  assert.equal(by.a.holdUntil, undefined); assert.equal(by.b.holdUntil, undefined); assert.equal(by.c.holdUntil, undefined);
  assert.equal(by.d.holdUntil, NOW + HOUR);
});

test('F4: 받은 번들을 쓰다 디스크가 차면(ENOSPC) 반쯤 쓴 파일을 남기지 않는다 — 원격 업그레이드 · 패키지 받기', async () => {
  const up = await import('../src/upgrade/upgrade.js');
  const pkgMod = await import('../src/upgrade/fetchPackage.js');
  const b = makeBundle('99.3.1');
  const man = signFor('99.3.1', b);
  const remote = await listen((q, r) => {
    if (q.url.endsWith('/versions.json')) { r.setHeader('content-type', 'application/json'); return r.end(JSON.stringify({ latest: '99.3.1', versions: [{ version: '99.3.1', tar_gz: b.name, size_bytes: b.bytes.length, sha256: core.sha256Hex(b.bytes) }] })); }
    if (q.url.endsWith(`/${b.name}`)) return r.end(b.bytes);
    if (q.url.endsWith(`/${core.manifestNameFor('99.3.1')}`)) return r.end(man);
    r.statusCode = 404; r.end('');
  });
  // 큰 쓰기(번들)만 절반 쓰고 ENOSPC — 작은 쓰기(기록 파일)는 그대로
  const origWS = fs.writeSync; const origWFS = fs.writeFileSync;
  const enospc = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  fs.writeSync = function (fd, buf, ...rest) {
    if (Buffer.isBuffer(buf) && buf.length === b.bytes.length) { origWS.call(fs, fd, buf, 0, buf.length >> 1); throw enospc(); }
    return origWS.call(fs, fd, buf, ...rest);
  };
  fs.writeFileSync = function (file, data, ...rest) {
    if (Buffer.isBuffer(data) && data.length === b.bytes.length) { origWFS.call(fs, file, data.subarray(0, data.length >> 1)); throw enospc(); }
    return origWFS.call(fs, file, data, ...rest);
  };
  const leftovers = (d) => { try { return fs.readdirSync(d).filter((n) => n.includes('99.3.1') && n.endsWith('.tar.gz') || n.includes('.tmp-')); } catch { return []; } };
  try {
    const dest = path.join(CFG, 'dl-f4');
    const r = await up.downloadArchive(`${remote}/dl/${b.name}`, dest, { sha256: core.sha256Hex(b.bytes), manifestUrl: `${remote}/dl/${core.manifestNameFor('99.3.1')}`, expectVersion: '99.3.1' });
    assert.equal(r.ok, false); assert.match(r.reason, /ENOSPC/);
    assert.deepEqual(leftovers(dest), [], '반쯤 쓴 번들 · 임시 파일이 남지 않는다');
    const pdir = path.join(CFG, 'pkg-f4');
    await assert.rejects(pkgMod.downloadPackage({ kind: 'bundle', baseUrl: `${remote}/dl`, dir: pdir }), /ENOSPC/);
    assert.deepEqual(leftovers(pdir), [], '패키지 폴더(/dl 이 내준다)에도 남지 않는다');
  } finally { fs.writeSync = origWS; fs.writeFileSync = origWFS; }
  // 디스크가 정상이면 그대로 받는다(정식 이름 · 내용 같음)
  const ok = await up.downloadArchive(`${remote}/dl/${b.name}`, path.join(CFG, 'dl-f4b'), { sha256: core.sha256Hex(b.bytes), manifestUrl: `${remote}/dl/${core.manifestNameFor('99.3.1')}`, expectVersion: '99.3.1' });
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(core.sha256Hex(fs.readFileSync(ok.path)), core.sha256Hex(b.bytes));
});
