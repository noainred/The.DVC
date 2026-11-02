/**
 * edgeAutoUpgrade2859.test.js — v2.859 사용자 요청 "중앙 포탈이 자동 업그레이드 되면 엣지도 모두 자동으로 업그레이드 · 기본값 켬".
 *
 *  ① 설정 edgeAutoUpgrade — 기본 켬(env UPGRADE_EDGE_AUTO=false 로 끔) · 저장·가림(redact) · 라우트 허용 목록
 *  ② planEdgeSync 판정 — 최신·구버전·중앙보다 새 버전·버전 모름·닿지 않음·중지·대기(settle)·백오프 · 주기·백오프·보관 개수 클램프
 *  ③ 적용 직후 — 번들을 패키지 폴더에 보관(+manifest·기록)하고 수집기에 push · edgeAutoUpgrade=false 면 push 하지 않고 그 사실을 기록
 *  ④ 주기 동기화(EdgeSyncRunner) — 뒤처진·닿는 엣지에만 중앙 버전 번들을 민다 · '이미 최신' 응답은 성공 · settle 동안 다시 밀지 않는다 ·
 *     실패는 백오프 · 확인·적용 중이면 건너뜀 · 꺼짐 · 번들을 못 구하면 사유
 *  ⑤ 중앙 /dl 이 보관한 번들을 내준다(엣지 자체 확인 경로)
 *  ⑥ 매니저 — 설정 저장이 동기화 타이머를 무장·해제한다 · 적용은 진행 중인 동기화 push 가 끝난 뒤 자기 push 를 한다
 *  ⑦ 소스 스윕 — upToDate 전달 · 상태 파일 등록·문서 · 게이트
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'edgeauto2747-'));
const PKG = path.join(CFG, 'packages');
Object.assign(process.env, { CONFIG_DIR: CFG, DATA_SOURCE: 'mock', SSRF_ALLOW_LOOPBACK: 'true', UPGRADE_CHECK_TIMEOUT_MS: '5000', PACKAGE_DIR: PKG });
for (const k of ['UPGRADE_SIGNATURE_POLICY', 'UPGRADE_ALLOW_UNVERIFIED', 'UPGRADE_WATCH_DIR', 'UPGRADE_ENABLED', 'UPGRADE_REMOTE_BASE', 'UPGRADE_INSTALL_DIR', 'EDGE_MODE', 'CENTRAL_URL', 'UPGRADE_SCAN_DEFER_MAX_MS', 'UPGRADE_EDGE_AUTO', 'UPGRADE_EDGE_SYNC_INTERVAL_MS', 'UPGRADE_KEEP_BUNDLES', 'UPGRADE_EDGES']) delete process.env[k];

const core = await import('../src/upgrade/signatureCore.js');
const sigmod = await import('../src/upgrade/signature.js');
const EMPTY_REPO_KEYS = path.join(CFG, 'repo-release-signing-keys.json');
fs.writeFileSync(EMPTY_REPO_KEYS, JSON.stringify({ format: core.KEYS_FORMAT, schema: 1, keys: [], revoked: [] }));
sigmod._setRepoKeysFileForTest(EMPTY_REPO_KEYS);
const settings = await import('../src/upgrade/settings.js');
const fleet = await import('../src/upgrade/fleetBundle.js');
const sync = await import('../src/upgrade/edgeSync.js');
const bsrc = await import('../src/upgrade/bundleSource.js');
const { UpgradeManager } = await import('../src/upgrade/manager.js');
const { config, currentVersion } = await import('../src/config.js');
const state = await import('../src/collector/state.js');
const { isRuntimeStateFile } = await import('../src/backup/service.js');
const { isRegisteredStateFile } = await import('../src/util/stateFiles.js');
const { dlSourceRouter } = await import('../src/routes/dlsource.js');

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
const HOST = path.join(CFG, 'release-signing-keys.conf');
fs.writeFileSync(HOST, JSON.stringify({ format: core.KEYS_FORMAT, schema: 1, keys: [{ keyId: kid(K1), publicKey: core.spkiBase64Of(K1.publicKey) }], revoked: [] }), { mode: 0o600 });
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
  const m = core.buildManifest({ version, keyId: kid(key), files: files.map((f) => ({ name: f.name, kind: 'bundle', platform: 'any', size: f.bytes.length, sha256: core.sha256Hex(f.bytes) })) });
  return core.serializeEnvelope(core.signManifest(m, key.privateKey));
}
/** 감시 폴더에 서명된 번들 + manifest 를 둔다. */
function watchWith(version) {
  const watch = fs.mkdtempSync(path.join(CFG, `w-${version}-`));
  const b = makeBundle(version);
  fs.copyFileSync(b.path, path.join(watch, b.name));
  fs.writeFileSync(path.join(watch, `vmware-portal-${version}.manifest.json`), signFor(K1, version, [b]));
  return { watch, bundle: b };
}
function freshInstall(tag) {
  const dir = path.join(CFG, `inst-${tag}-${seq++}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: currentVersion() }));
  return dir;
}
/** 설정을 메모리에서만 바꾼 매니저(저장·타이머 없음). */
function makeManager(s) {
  const m = new UpgradeManager();
  m.settings = { ...m.settings, packageName: 'vmware-portal', edges: [], downloadDir: path.join(CFG, `dl-${seq++}`), ...s };
  return m;
}
const COLLECTORS = path.join(CFG, 'collectors.json');
function setCollectors(list) { fs.writeFileSync(COLLECTORS, JSON.stringify({ collectors: list })); }
/** 가짜 수집 서버 — 경로 앞머리(/e1 …)로 엣지를 가른다. behave[id] = (req) => {status, body}. */
async function fakeEdges(behave, pushes) {
  return listen((q, r) => {
    const chunks = [];
    q.on('data', (c) => chunks.push(c));
    q.on('end', () => {
      const m = /^\/(e\d+)\/api\/collector\/upgrade/.exec(q.url);
      const id = m?.[1];
      const body = Buffer.concat(chunks);
      pushes.push({ id, url: q.url, sha: core.sha256Hex(body), manifest: sigmod.decodeManifestHeader(q.headers[sigmod.MANIFEST_HEADER]), token: q.headers['x-collector-token'] });
      const out = (behave[id] || (() => ({ status: 200, body: { ok: true, version: 'x' } })))(q);
      r.statusCode = out.status; r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(out.body));
    });
  });
}
const NOW = Date.UTC(2026, 10, 2, 13, 20, 0); // 고정 기준 시각(정시와 떨어뜨림)
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
test('① 설정 edgeAutoUpgrade — 기본 켬 · 저장 끔/켬 · 가림에 실린다 · 라우트 허용 목록 · env 끔', () => {
  const eff = settings.loadSettings();
  assert.equal(eff.edgeAutoUpgrade, true, '저장값이 없으면 기본 켬(config.js UPGRADE_EDGE_AUTO !== false)');
  assert.equal(settings.redactSettings(eff).edgeAutoUpgrade, true);
  const off = settings.saveSettings({ edgeAutoUpgrade: false });
  assert.equal(off.edgeAutoUpgrade, false);
  assert.match(fs.readFileSync(path.join(CFG, 'upgrade.json'), 'utf8'), /"edgeAutoUpgrade":\s*false/);
  assert.equal(settings.redactSettings(off).edgeAutoUpgrade, false);
  assert.equal(settings.saveSettings({ edgeAutoUpgrade: 'yes' }).edgeAutoUpgrade, true, '불리언으로 굳힌다');
  assert.equal(settings.saveSettings({ enabled: false }).edgeAutoUpgrade, true, '다른 칸만 저장하면 유지');
  assert.equal(settings.redactSettings({ enabled: true }).edgeAutoUpgrade, true, '옛 upgrade.json(키 없음) 은 켬으로 읽는다');
  const route = read('routes/upgrade.js');
  assert.match(route, /const allowed = \[[^\]]*'edgeAutoUpgrade'[^\]]*\]/, 'PUT /settings 가 저장을 받는다');
  assert.match(read('config.js'), /edgeAutoUpgrade: process\.env\.UPGRADE_EDGE_AUTO !== 'false'/, '기본 켬 — false 라고 적을 때만 끈다');
  assert.ok(config.upgrade.edgeAutoUpgrade === true);
});

test('② planEdgeSync 판정 · 주기/백오프/보관 개수 클램프', () => {
  const cur = '2.747.0';
  const collectors = [
    { id: 'ok', name: '최신', url: 'https://a', enabled: true },
    { id: 'old', name: '구버전', url: 'https://b', enabled: true },
    { id: 'new', name: '앞선', url: 'https://c', enabled: true },
    { id: 'nov', name: '보고없음', url: 'https://d', enabled: true },
    { id: 'never', name: 'pull전', url: 'https://e', enabled: true },
    { id: 'down', name: '닿지않음', url: 'https://f', enabled: true },
    { id: 'stop', name: '중지', url: 'https://g', enabled: false },
    { id: 'wait', name: '대기', url: 'https://h', enabled: true },
    { id: 'bo', name: '백오프', url: 'https://i', enabled: true },
    { id: 'bo2', name: '백오프끝', url: 'https://j', enabled: true },
    { id: 'junk', name: '표기이상', url: 'https://k', enabled: true },
    null, { name: 'id없음' },
  ];
  const statuses = {
    ok: { ok: true, version: '2.747.0' }, old: { ok: true, version: 'v2.746.0' }, new: { ok: true, version: '2.748.1' }, nov: { ok: true },
    down: { ok: false, version: '2.740.0', error: 'export -> 503' }, stop: { ok: true, version: '1.0.0' }, wait: { ok: true, version: '2.746.0' },
    bo: { ok: true, version: '2.746.0' }, bo2: { ok: true, version: '2.746.0' }, junk: { ok: true, version: 'dev' },
  };
  const attempts = {
    wait: { at: NOW - 10 * 60_000, ok: true, target: cur, attempts: 0 },
    bo: { at: NOW - 15 * 60_000, ok: false, target: cur, attempts: 2, reason: 'HTTP 403' },   // 2회 실패 → 10분 × 2 = 20분 대기 중
    bo2: { at: NOW - 25 * 60_000, ok: false, target: cur, attempts: 2, reason: 'HTTP 403' },  // 20분이 지났다 → 다시 민다
  };
  const p = sync.planEdgeSync({ collectors, statusOf: (id) => statuses[id] || null, attemptsOf: (id) => attempts[id] || null, currentVersion: cur, now: NOW, intervalMs: 600_000 });
  const st = Object.fromEntries(p.edges.map((e) => [e.id, e.state]));
  assert.deepEqual(st, { ok: 'up-to-date', old: 'behind', new: 'ahead', nov: 'unknown', never: 'unknown', down: 'unreachable', stop: 'disabled', wait: 'waiting', bo: 'backoff', bo2: 'behind', junk: 'unknown' });
  assert.deepEqual(p.push, ['old', 'bo2'], '뒤처지고 닿는 엣지만 민다 — 모름·앞선·닿지 않음·대기·백오프는 밀지 않는다');
  assert.equal(p.total, 11); assert.equal(p.counts.unknown, 3); assert.equal(p.counts.behind, 2);
  assert.equal(p.edges.find((e) => e.id === 'wait').nextAt, NOW - 10 * 60_000 + sync.SYNC_SETTLE_MS);
  assert.equal(p.edges.find((e) => e.id === 'bo').nextAt, NOW - 15 * 60_000 + 20 * 60_000);
  assert.equal(p.edges.find((e) => e.id === 'bo').reason, 'HTTP 403');
  assert.equal(p.edges.find((e) => e.id === 'never').reason, '아직 수집(pull) 기록 없음');
  assert.equal(p.edges.find((e) => e.id === 'nov').reason, '엣지가 버전을 보고하지 않음');
  assert.match(p.edges.find((e) => e.id === 'junk').reason, /읽을 수 없음\(‘dev’\)/);
  const pd = sync.planEdgeSync({ collectors: [collectors[3]], statusOf: () => ({ ok: false, error: 'export -> ECONNREFUSED' }), currentVersion: cur, now: NOW });
  assert.equal(pd.edges[0].state, 'unknown'); assert.match(pd.edges[0].reason, /닿지 않아 버전을 모름 — export -> ECONNREFUSED/, '한 번도 닿지 못한 엣지는 왜 모르는지 말한다');
  assert.equal(p.edges.find((e) => e.id === 'down').reason, 'export -> 503');
  // 지난 버전을 향한 기록은 지금 버전 판정에 쓰지 않는다(중앙이 또 올라갔다)
  const p2 = sync.planEdgeSync({ collectors: [collectors[7]], statusOf: () => ({ ok: true, version: '2.746.0' }), attemptsOf: () => ({ at: NOW - 1000, ok: true, target: '2.746.9', attempts: 0 }), currentVersion: cur, now: NOW });
  assert.deepEqual(p2.push, ['wait']);
  // 중앙 버전을 모르면 아무도 밀지 않는다
  assert.deepEqual(sync.planEdgeSync({ collectors, statusOf: (id) => statuses[id] || null, currentVersion: null, now: NOW }).push, []);

  assert.equal(sync.edgeSyncIntervalMs(undefined), 600_000); assert.equal(sync.edgeSyncIntervalMs('0'), 600_000); assert.equal(sync.edgeSyncIntervalMs('abc'), 600_000);
  assert.equal(sync.edgeSyncIntervalMs('1000'), 60_000, '하한 1분'); assert.equal(sync.edgeSyncIntervalMs(String(99 * 86_400_000)), 86_400_000, '상한 24시간(setInterval 24.8일 안)');
  assert.equal(sync.backoffMs(1, 600_000), 600_000); assert.equal(sync.backoffMs(3, 600_000), 2_400_000); assert.equal(sync.backoffMs(40, 600_000), sync.SYNC_BACKOFF_MAX_MS, '상한 6시간');
  assert.equal(fleet.keepBundlesOf(undefined), 3); assert.equal(fleet.keepBundlesOf('0'), 1); assert.equal(fleet.keepBundlesOf('99'), 20); assert.equal(fleet.keepBundlesOf('x'), 3);
  for (const s of sync.EDGE_SYNC_STATES) assert.ok(s in p.counts);
  assert.ok(sync.EDGE_SYNC_OUTCOMES.includes('pushed') && sync.EDGE_SYNC_OUTCOMES.includes('no-bundle'));
});

test('③ 적용 직후 — 번들을 패키지 폴더에 보관(+manifest·기록)하고 수집기에 push · edgeAutoUpgrade=false 면 push 하지 않는다', async () => {
  const pushes = [];
  const base = await fakeEdges({ e1: () => ({ status: 200, body: { ok: true, version: '99.0.3' } }) }, pushes);
  setCollectors([{ id: 'e1', name: 'e1', url: `${base}/e1`, token: 'T', enabled: true }]);
  try {
    const { watch, bundle } = watchWith('99.0.3');
    const m = makeManager({ enabled: true, autoApply: true, watchDir: watch, remoteBase: '', installDir: freshInstall('a'), pollIntervalMs: 0 });
    assert.equal(m.settings.edgeAutoUpgrade, true, '기본 켬');
    const r = await m.apply({ source: 'watch', restart: false, trigger: 'manual' });
    assert.equal(r.ok, true, r.reason);
    assert.equal(pushes.length, 1, '수집기 push 1건'); assert.equal(pushes[0].sha, core.sha256Hex(bundle.bytes));
    assert.ok(pushes[0].manifest?.includes(core.MANIFEST_FORMAT), '서명 manifest 를 함께 싣는다');
    // 보관 — 패키지 폴더(/dl 이 내주는 곳)에 번들 + manifest + 기록
    const kept = path.join(PKG, 'vmware-portal-99.0.3.tar.gz');
    assert.ok(fs.existsSync(kept), '패키지 폴더에 번들을 보관한다');
    assert.equal(core.sha256Hex(fs.readFileSync(kept)), core.sha256Hex(bundle.bytes));
    assert.ok(fs.existsSync(path.join(PKG, 'vmware-portal-99.0.3.manifest.json')), 'manifest 도 옆에');
    assert.deepEqual(fleet.keptBundles().map((k) => k.name), ['vmware-portal-99.0.3.tar.gz']);
    assert.ok(isRegisteredStateFile(fleet.KEPT_FILE_NAME) && isRuntimeStateFile(fleet.KEPT_FILE_NAME), '보관 기록은 상태 파일(백업 감시 제외)');
    assert.equal(m.lastResult.edgePush, undefined, 'UPGRADE_EDGES 가 없으면 edgePush 요약은 없다(예전과 같다)');

    // 끔 — push 하지 않고 '하지 않음' 을 기록한다. 보관은 그대로(엣지 자체 확인 /dl 경로는 설정과 무관하게 열어 둔다).
    pushes.length = 0;
    const w2 = watchWith('99.0.4');
    const m2 = makeManager({ enabled: true, autoApply: true, watchDir: w2.watch, remoteBase: '', installDir: freshInstall('b'), pollIntervalMs: 0, edgeAutoUpgrade: false });
    const r2 = await m2.apply({ source: 'watch', restart: false, trigger: 'manual' });
    assert.equal(r2.ok, true, r2.reason);
    assert.equal(pushes.length, 0, '꺼져 있으면 수집기 push 를 하지 않는다');
    assert.deepEqual(m2.lastResult.edgePush, { total: 0, ok: 0, failed: [], skipped: 'edge-auto-off' });
    assert.deepEqual(m2.status().lastResult.edgePush, { total: 0, ok: 0, failed: [], skipped: 'edge-auto-off' }, '정제를 지나도 남는다');
    assert.ok(fs.existsSync(path.join(PKG, 'vmware-portal-99.0.4.tar.gz')));
    assert.deepEqual(fleet.keptBundles().map((k) => k.name).sort(), ['vmware-portal-99.0.3.tar.gz', 'vmware-portal-99.0.4.tar.gz']);

    // 보관 규칙 — 같은 이름의 다른 내용은 덮어쓰지 않는다 · 관리자가 둔 파일은 기록하지 않는다(정리 대상 아님) · 보관 개수 초과는 오래된 것부터
    const other = makeBundle('99.0.3', { marker: 'different-build' });
    const k1 = fleet.keepBundle({ bytes: other.bytes, version: '99.0.3' });
    assert.equal(k1.ok, false); assert.match(k1.reason, /덮어쓰지 않습니다/);
    const admin = makeBundle('98.0.0'); fs.copyFileSync(admin.path, path.join(PKG, admin.name));
    const k2 = fleet.keepBundle({ bytes: admin.bytes, version: '98.0.0' });
    assert.equal(k2.ok, true); assert.equal(k2.existing, true);
    assert.ok(!fleet.keptBundles().some((k) => k.name === admin.name), '관리자가 내려받은 파일은 기록하지 않는다 — 지우지 않게');
    const k3 = fleet.keepBundle({ bytes: makeBundle('99.0.5').bytes, version: '99.0.5', keep: 2, now: Date.now() + 1000 });
    assert.equal(k3.ok, true); assert.deepEqual(k3.pruned, ['vmware-portal-99.0.3.tar.gz'], '보관 개수를 넘으면 가장 오래된 보관본부터');
    assert.ok(!fs.existsSync(path.join(PKG, 'vmware-portal-99.0.3.tar.gz')) && !fs.existsSync(path.join(PKG, 'vmware-portal-99.0.3.manifest.json')));
    assert.ok(fs.existsSync(path.join(PKG, admin.name)), '관리자 파일은 남는다');
    assert.equal(fleet.keepBundle({ archivePath: '/x/vmware-portal-1.0.0.zip', version: '1.0.0' }).ok, false, 'zip 은 보관하지 않는다(push·/dl 이 tar.gz 만 다룬다)');
    assert.equal(fleet.keepBundle({ bytes: Buffer.from('x') }).ok, false, '버전을 모르면 보관하지 않는다');
    // 다음 테스트를 위해 99.0.3 을 다시 보관
    fs.rmSync(path.join(PKG, 'vmware-portal-99.0.5.tar.gz'), { force: true }); fs.rmSync(path.join(PKG, 'vmware-portal-99.0.5.manifest.json'), { force: true });
    const k4 = fleet.keepBundle({ archivePath: path.join(watch, bundle.name), version: '99.0.3' });
    assert.equal(k4.ok, true); assert.equal(k4.manifest, true);
  } finally { fs.rmSync(COLLECTORS, { force: true }); }
});

test('④ 주기 동기화 — 뒤처진·닿는 엣지에만 중앙 버전 번들 · 이미 최신 응답은 성공 · settle · 백오프 · 건너뜀 · 꺼짐 · 번들 없음', async () => {
  const pushes = [];
  let e6Fails = true;
  const base = await fakeEdges({
    e1: () => ({ status: 200, body: { ok: true, version: '99.0.3' } }),
    e5: () => ({ status: 200, body: { ok: false, upToDate: true, reason: 'not newer (99.0.3 <= 99.0.3)', version: '99.0.3' } }),
    e6: () => (e6Fails ? { status: 500, body: { ok: false, reason: 'swap failed: EACCES' } } : { status: 200, body: { ok: true, version: '99.0.3' } }),
  }, pushes);
  const mk = (id, extra = {}) => ({ id, name: id, url: `${base}/${id}`, token: 'T', enabled: true, ...extra });
  setCollectors([mk('e1'), mk('e2'), mk('e3'), mk('e4'), mk('e5'), mk('e6'), mk('e7', { enabled: false })]);
  state.setCollectorStatus('e1', { ok: true, version: '99.0.2' });
  state.setCollectorStatus('e2', { ok: false, version: '99.0.2', error: 'export -> ETIMEDOUT' });
  state.setCollectorStatus('e3', { ok: true, version: '99.0.3' });
  state.setCollectorStatus('e4', { ok: true });
  state.setCollectorStatus('e5', { ok: true, version: '99.0.1' });
  state.setCollectorStatus('e6', { ok: true, version: '99.0.0' });
  state.setCollectorStatus('e7', { ok: true, version: '1.0.0' });
  let now = NOW; let busy = false;
  const s = { enabled: true, edgeAutoUpgrade: true, watchDir: '', remoteBase: '', token: '' };
  const logs = [];
  const runner = new sync.EdgeSyncRunner({ settings: () => s, busy: () => busy, now: () => now, currentVersion: () => '99.0.3', intervalMs: 600_000, log: { log: (m) => logs.push(m), warn: (m) => logs.push(m) } });
  try {
    const r1 = await runner.run();
    assert.equal(r1.outcome, 'pushed', JSON.stringify(r1));
    assert.deepEqual(pushes.map((p) => p.id).sort(), ['e1', 'e5', 'e6'], '구버전+닿는 엣지만 — 닿지 않음(e2)·최신(e3)·모름(e4)·중지(e7)는 밀지 않는다');
    assert.ok(pushes.every((p) => p.sha === core.sha256Hex(fs.readFileSync(path.join(PKG, 'vmware-portal-99.0.3.tar.gz')))), '패키지 폴더의 중앙 버전 번들을 민다');
    assert.ok(pushes.every((p) => p.manifest?.includes(core.MANIFEST_FORMAT) && p.token === 'T'));
    assert.equal(r1.pushed, 3); assert.equal(r1.ok, 2, "e5 '이미 최신' 은 성공, e6 500 은 실패");
    assert.deepEqual(r1.failed.map((f) => f.id), ['e6']); assert.match(r1.failed[0].reason, /EACCES/);
    assert.equal(r1.source, 'package'); assert.equal(r1.version, '99.0.3');
    assert.ok(state.getCollectorStatus('e5').upgrade.upToDate === true, '수집 서버 상태에도 upToDate 가 남는다');
    assert.ok(logs.some((l) => /2\/3 성공/.test(l)));

    // 바로 다시 — settle(성공)·백오프(실패) 라 아무도 밀지 않는다
    pushes.length = 0; now += 60_000;
    const r2 = await runner.run();
    assert.equal(r2.outcome, 'idle'); assert.equal(pushes.length, 0);
    const st = runner.status(now);
    assert.equal(st.enabled, true); assert.equal(st.currentVersion, '99.0.3'); assert.equal(st.total, 7);
    const pend = Object.fromEntries(st.pending.map((e) => [e.id, e.state]));
    assert.deepEqual(pend, { e1: 'waiting', e2: 'unreachable', e4: 'unknown', e5: 'waiting', e6: 'backoff' });
    assert.equal(st.counts['up-to-date'], 1); assert.equal(st.counts.disabled, 1);
    assert.equal(st.pending.find((e) => e.id === 'e6').nextAt, NOW + 600_000, '1회 실패 → 주기(10분) 뒤');

    // 백오프가 끝나면 다시 민다(이번엔 성공) · e1 은 새 버전을 보고해 최신이 됐다
    e6Fails = false; now = NOW + 600_000 + 1; state.setCollectorStatus('e1', { ok: true, version: '99.0.3' });
    pushes.length = 0;
    const r3 = await runner.run();
    assert.equal(r3.outcome, 'pushed'); assert.deepEqual(pushes.map((p) => p.id), ['e6']); assert.equal(r3.ok, 1);
    assert.equal(runner.attempts.get('e6').attempts, 0);

    // 확인·적용 중이면 건너뛴다 · 설정이 꺼지면 아무것도 하지 않는다
    busy = true; const r4 = await runner.run(); assert.equal(r4.outcome, 'skipped'); assert.match(r4.reason, /진행 중/); busy = false;
    s.edgeAutoUpgrade = false; const r5 = await runner.run(); assert.equal(r5.outcome, 'off'); assert.equal(runner.status(now).enabled, false); assert.deepEqual(runner.status(now).pending, []); s.edgeAutoUpgrade = true;
    s.enabled = false; assert.equal((await runner.run()).outcome, 'off'); s.enabled = true;

    // 겹치지 않는다 — 진행 중이면 같은 약속을 돌려준다
    pushes.length = 0; now += 3_600_000; state.setCollectorStatus('e5', { ok: true, version: '99.0.1' });
    const a = runner.run(); const b = runner.run(); assert.equal(a, b, '단일 진행'); await a; assert.equal(runner.inflight, null);

    // 번들을 못 구하면 사유를 남기고(원격은 1시간에 한 번만 묻는다) 엣지 기록은 건드리지 않는다
    // 중앙이 99.0.9 인데 그 번들이 어디에도 없다(엣지들은 99.0.x 구버전)
    const r7runner = new sync.EdgeSyncRunner({ settings: () => ({ enabled: true, edgeAutoUpgrade: true, watchDir: '', remoteBase: '', token: '' }), now: () => now, currentVersion: () => '99.0.9', intervalMs: 600_000, log: { log() {}, warn() {} } });
    const r7 = await r7runner.run();
    assert.equal(r7.outcome, 'no-bundle', JSON.stringify(r7)); assert.equal(r7.version, '99.0.9'); assert.ok(r7.behind >= 1); assert.match(r7.reason, /99\.0\.9/);
    assert.equal(r7runner.remoteAskedAt, now, '원격을 물은 시각을 기억한다');
    const r8 = await r7runner.run();
    assert.equal(r8.outcome, 'no-bundle'); assert.match(r8.reason, /1시간에 한 번만/, '1시간 안에는 원격을 다시 묻지 않고 그 사실을 말한다');
    // 중앙보다 새 원격 최신은 받지 않는다(exactVersion)
    const nb = makeBundle('99.9.9');
    const rem = await listen((q, r) => { r.end(q.url.endsWith('versions.json') ? JSON.stringify({ latest: '99.9.9', versions: [{ version: '99.9.9', tar_gz: nb.name, size_bytes: nb.bytes.length, sha256: core.sha256Hex(nb.bytes) }] }) : nb.bytes); });
    const rb = await bsrc.resolveBundleBytes({ remoteBase: rem, watchDir: '', token: '' }, { exactVersion: '97.0.0', localDirs: [PKG] });
    assert.equal(rb, null); assert.match(bsrc.lastBundleReject(), /최신은 v99\.9\.9 — 중앙 현재 버전\(v97\.0\.0\)/);
    // 등록된 수집 서버가 없으면 할 일이 없다
    fs.rmSync(COLLECTORS, { force: true });
    assert.equal((await runner.run()).outcome, 'no-edges');
  } finally { fs.rmSync(COLLECTORS, { force: true }); }
});

test('⑤ 중앙 /dl 이 보관한 번들을 내준다 — 엣지의 자체 확인(1시간 주기)이 새 버전을 본다', async () => {
  const app = express();
  app.use('/dl', dlSourceRouter);
  const srv = http.createServer(app); servers.push(srv);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const v = await (await fetch(`${base}/dl/versions.json`)).json();
  const e = (v.versions || []).find((x) => x.version === '99.0.3');
  assert.ok(e, `보관한 99.0.3 이 /dl/versions.json 에 있다: ${JSON.stringify(v)}`);
  assert.equal(e.tar_gz, 'vmware-portal-99.0.3.tar.gz'); assert.equal(e.manifest, 'vmware-portal-99.0.3.manifest.json');
  assert.equal(e.sha256, core.sha256Hex(fs.readFileSync(path.join(PKG, 'vmware-portal-99.0.3.tar.gz'))));
  const f = await fetch(`${base}/dl/vmware-portal-99.0.3.tar.gz`);
  assert.equal(f.status, 200); assert.equal(core.sha256Hex(Buffer.from(await f.arrayBuffer())), e.sha256);
  assert.equal((await fetch(`${base}/dl/vmware-portal-99.0.3.manifest.json`)).status, 200);
});

test('⑥ 매니저 — 설정 저장이 동기화 타이머를 무장·해제한다 · 적용은 진행 중인 동기화 push 가 끝난 뒤 자기 push 를 한다', async (t) => {
  const m = new UpgradeManager();
  t.after(() => { m.edgeSync.disarm(); if (m.timer) clearInterval(m.timer); });
  m.updateSettings({ enabled: true, watchDir: '', remoteBase: '', installDir: '/tmp/x', autoApply: false, pollIntervalMs: 0, edgeAutoUpgrade: true });
  assert.ok(m.edgeSync.timer && m.edgeSync.firstTimer, '켜져 있으면 타이머를 무장한다');
  let st = m.status();
  assert.equal(st.edgeAutoUpgrade, true); assert.equal(st.edgeSync.enabled, true); assert.equal(st.edgeSync.armed, true);
  assert.equal(st.edgeSync.intervalMs, sync.edgeSyncIntervalMs());
  assert.ok(st.edgeSync.nextRunAt > Date.now() && st.edgeSync.nextRunAt <= Date.now() + sync.SYNC_FIRST_DELAY_MS, '첫 실행은 기동 2분 뒤');
  m.updateSettings({ edgeAutoUpgrade: false });
  assert.equal(m.edgeSync.timer, null, '끄면 해제한다');
  st = m.status(); assert.equal(st.edgeAutoUpgrade, false); assert.equal(st.edgeSync.enabled, false); assert.equal(st.edgeSync.nextRunAt, null);
  m.updateSettings({ edgeAutoUpgrade: true, enabled: false });
  assert.equal(m.edgeSync.timer, null, '기능 자체가 꺼지면 동기화도 없다');
  m.edgeSync.disarm();

  // 적용 ↔ 동기화 push 순서
  const { watch } = watchWith('99.0.6');
  const m2 = makeManager({ enabled: true, autoApply: true, watchDir: watch, remoteBase: '', installDir: freshInstall('c'), pollIntervalMs: 0 });
  const order = [];
  m2.pushToEdges = async () => { order.push('apply-push'); return []; };
  m2.pushToCollectors = async () => { order.push('apply-push-collectors'); return []; };
  m2.edgeSync.inflight = new Promise((r) => setTimeout(() => { order.push('sync-done'); r(); }, 80));
  const r = await m2.apply({ source: 'watch', restart: false, trigger: 'manual' });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(order, ['sync-done', 'apply-push', 'apply-push-collectors'], '진행 중인 동기화 push 가 끝난 뒤에 적용 push');
  // 반대 방향 — 적용 중에는 동기화가 건너뛴다(busy). 위에서 손으로 넣은 inflight 는 runner 가 만든 것이 아니라 스스로 지우지 않는다 — 치운다.
  m2.edgeSync.inflight = null;
  m2._applying = true;
  assert.equal((await m2.edgeSync.run()).outcome, 'skipped');
  m2._applying = false;
});

test('⑦ 소스 스윕 — upToDate 전달 · 게이트 · 상태 파일 등록·문서 · 1시간 원격 재질의', () => {
  const push = read('collector/upgradePush.js');
  assert.match(push, /body\.upToDate === true \? \{ upToDate: true \}/, "엣지의 '이미 최신' 을 push 결과에 싣는다");
  assert.match(push, /r\.upToDate \? \{ upToDate: true \}/, '수집 서버 상태에도');
  const mgr = read('upgrade/manager.js');
  assert.match(mgr, /if \(s\.edgeAutoUpgrade === false\) \{/, '적용 직후 push 는 설정을 따른다');
  assert.match(mgr, /skipped: 'edge-auto-off'/);
  assert.match(mgr, /await this\.edgeSync\.inflight\.catch/, '적용은 동기화 push 를 기다린다');
  assert.match(mgr, /this\.edgeSync\.arm\(\)/);
  assert.match(mgr, /keepBundle\(\{ archivePath: res\.appliedArchive/);
  assert.match(read('backup/service.js'), /'upgrade-kept-bundles\.json'/, '상태 파일 목록(이중 안전망)');
  assert.match(fs.readFileSync(path.resolve(HERE, '../../scripts/config-doc.mjs'), 'utf8'), /'upgrade-kept-bundles\.json'/, 'CONFIG-FILES 생성기 설명');
  assert.match(fs.readFileSync(path.resolve(HERE, '../../docs/CONFIG-FILES.md'), 'utf8'), /upgrade-kept-bundles\.json/, 'docs/CONFIG-FILES.md 재생성(node scripts/config-doc.mjs)');
  const env = fs.readFileSync(path.resolve(HERE, '../../docs/ENV.md'), 'utf8');
  for (const k of ['UPGRADE_EDGE_AUTO', 'UPGRADE_EDGE_SYNC_INTERVAL_MS', 'UPGRADE_KEEP_BUNDLES']) assert.ok(env.includes(`\`${k}\``), `docs/ENV.md 에 ${k} (node scripts/env-doc.mjs)`);
  assert.match(read('upgrade/edgeSync.js'), /SYNC_REMOTE_RETRY_MS = 3_600_000/);
  assert.match(read('routes/dlsource.js'), /getPackageDir\(\)/, '/dl 은 패키지 폴더를 내준다(보관본이 엣지 자체 확인에 보인다)');
});
