/**
 * edgeAutoUpgrade2865.test.js — v2.865 사용자 선택 '프로그램 개선' A·B·C·D(엣지 자동 업그레이드 후속).
 *
 *  A. 동기화 기록 보존 — run 마다 onRun 훅 · 매니저가 upgrade-status.json 에 lastEdgeSync 로 쓰고 재시작(새 매니저) 뒤 restored:true 로 되살린다 ·
 *     모르는 결과 코드는 'error' · 정제(sanitizeEdgeSync)는 아는 필드만
 *  B. 옛 방식 엣지(settings.edges) — 목록 정제(중복·스킴·SSRF 차단) · /api/health 버전 질의 · 뒤처진 엣지에 pushBundleToEdge(번들 파일) ·
 *     '이미 최신' 응답은 성공 · 번들 파일이 없으면 그 엣지만 사유와 함께 실패
 *  C. POST /api/upgrade/edge-sync(실제 라우터) — 관리자·전체 범위만 · 꺼져 있으면 409 · 결과와 상태를 돌려준다 · GET /admin/collectors 가 edgeSync 를 싣는다
 *  D. 반복 실패 알림 — 같은 대상 버전으로 백오프 상한(6시간)에 닿을 만큼 연속 실패하면 한 번 알리고, 그 뒤 성공하면 '해소' 를 한 번 알린다 · 본문에 백틱·별표 없음
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
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'edgeauto2865-'));
const PKG = path.join(CFG, 'packages');
Object.assign(process.env, { CONFIG_DIR: CFG, DATA_SOURCE: 'mock', SSRF_ALLOW_LOOPBACK: 'true', UPGRADE_CHECK_TIMEOUT_MS: '5000', PACKAGE_DIR: PKG });
for (const k of ['UPGRADE_SIGNATURE_POLICY', 'UPGRADE_ALLOW_UNVERIFIED', 'UPGRADE_WATCH_DIR', 'UPGRADE_ENABLED', 'UPGRADE_REMOTE_BASE', 'UPGRADE_INSTALL_DIR', 'EDGE_MODE', 'CENTRAL_URL', 'UPGRADE_EDGE_AUTO', 'UPGRADE_EDGE_SYNC_INTERVAL_MS', 'UPGRADE_KEEP_BUNDLES', 'UPGRADE_EDGES']) delete process.env[k];

const core = await import('../src/upgrade/signatureCore.js');
const sigmod = await import('../src/upgrade/signature.js');
const EMPTY_REPO_KEYS = path.join(CFG, 'repo-release-signing-keys.json');
fs.writeFileSync(EMPTY_REPO_KEYS, JSON.stringify({ format: core.KEYS_FORMAT, schema: 1, keys: [], revoked: [] }));
sigmod._setRepoKeysFileForTest(EMPTY_REPO_KEYS);
const sync = await import('../src/upgrade/edgeSync.js');
const auto = await import('../src/upgrade/autoState.js');
const store = await import('../src/upgrade/statusStore.js');
const fleet = await import('../src/upgrade/fleetBundle.js');
const { UpgradeManager, upgradeManager } = await import('../src/upgrade/manager.js');
const { currentVersion } = await import('../src/config.js');
const state = await import('../src/collector/state.js');

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
fs.writeFileSync(path.join(CFG, 'release-signing-keys.conf'), JSON.stringify({ format: core.KEYS_FORMAT, schema: 1, keys: [{ keyId: kid(K1), publicKey: core.spkiBase64Of(K1.publicKey) }], revoked: [] }), { mode: 0o600 });
let seq = 0;
function makeBundle(version) {
  const work = fs.mkdtempSync(path.join(CFG, `b${seq++}-`));
  const pkg = path.join(work, 'vmware-portal');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'vmware-portal', version }));
  const out = path.join(work, `vmware-portal-${version}.tar.gz`);
  execFileSync('tar', ['-czf', out, '-C', work, 'vmware-portal']);
  return { path: out, bytes: fs.readFileSync(out), name: path.basename(out) };
}
function signFor(key, version, files) {
  const m = core.buildManifest({ version, keyId: kid(key), files: files.map((f) => ({ name: f.name, kind: 'bundle', platform: 'any', size: f.bytes.length, sha256: core.sha256Hex(f.bytes) })) });
  return core.serializeEnvelope(core.signManifest(m, key.privateKey));
}
const CUR = '99.1.0';
const B = makeBundle(CUR);
const K = fleet.keepBundle({ bytes: B.bytes, version: CUR, manifestText: signFor(K1, CUR, [B]) });
assert.equal(K.ok, true, K.reason);
const NOW = Date.UTC(2026, 10, 2, 20, 50, 0); // 고정 기준 시각(정시와 떨어뜨림)
const COLLECTORS = path.join(CFG, 'collectors.json');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const quiet = { log() {}, warn() {} };

// ─────────────────────────────────────────────────────────────────────────────
test('A ① sanitizeEdgeSync — 아는 필드만 · 실패 목록 20건 · counts 는 소문자 키의 정수만 · 되살리면 restored', () => {
  const r = auto.sanitizeEdgeSync({ at: NOW, finishedAt: NOW + 5, outcome: 'pushed', version: 'v99.1.0', source: 'package', pushed: 3, ok: 2, behind: 3, reason: 'x'.repeat(700), evil: 1,
    failed: [...Array(25)].map((_, i) => ({ id: `e${i}`, name: `n${i}`, reason: 'r', extra: 1 })), counts: { 'up-to-date': 2, behind: '3', 'Bad Key': 1, waiting: 0 } });
  assert.deepEqual(Object.keys(r).sort(), ['at', 'behind', 'counts', 'failed', 'finishedAt', 'ok', 'outcome', 'pushed', 'reason', 'source', 'version'].sort());
  assert.equal(r.version, '99.1.0'); assert.equal(r.failed.length, 20); assert.deepEqual(Object.keys(r.failed[0]), ['id', 'name', 'reason']);
  assert.deepEqual(r.counts, { 'up-to-date': 2, waiting: 0 }); assert.equal(r.reason.length, 600);
  assert.equal(auto.sanitizeEdgeSync({ outcome: 'idle' }), null, '시각이 없으면 기록이 아니다');
  assert.equal(auto.sanitizeEdgeSync({ at: NOW }).outcome, 'error');
  const restored = auto.restoreStatus({ lastEdgeSync: { at: NOW, outcome: 'idle' } }, CUR);
  assert.deepEqual(restored.lastEdgeSync, { at: NOW, outcome: 'idle', restored: true });
});

test('A ② 매니저가 동기화 기록을 상태 파일에 남기고 재시작(새 매니저) 뒤 되살린다 · 모르는 코드는 error', async () => {
  const file = path.join(CFG, 'upgrade-status-A.json');
  const m = new UpgradeManager();
  m.settings = { ...m.settings, enabled: true, edgeAutoUpgrade: true, watchDir: '', remoteBase: '', installDir: '/tmp/x', pollIntervalMs: 0, edges: [] };
  m.enablePersistence(file);
  fs.rmSync(COLLECTORS, { force: true });
  const r = await m.edgeSync.run();
  assert.equal(r.outcome, 'no-edges');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.lastEdgeSync.outcome, 'no-edges'); assert.equal(doc.lastEdgeSync.at, r.at); assert.equal(doc.lastEdgeSync.restored, undefined, '되살림 표지는 파일에 쓰지 않는다');
  const m2 = new UpgradeManager();
  m2.settings = { ...m.settings };
  m2.enablePersistence(file);
  assert.equal(m2.edgeSync.lastRun.outcome, 'no-edges'); assert.equal(m2.edgeSync.lastRun.restored, true);
  assert.equal(m2.status().edgeSync.lastRun.restored, true, '화면 상태에도 재시작 전 기록으로 실린다');
  // 이 프로세스의 기록이 있으면 되살리지 않는다 · 모르는 결과 코드는 error
  assert.equal(m2.edgeSync.restore({ at: NOW, outcome: 'pushed' }), false);
  const m3 = new UpgradeManager(); m3.edgeSync.restore({ at: NOW, outcome: 'zzz' });
  assert.equal(m3.edgeSync.lastRun.outcome, 'error');
  assert.equal(store.readUpgradeStatus(file).doc.lastEdgeSync.outcome, 'no-edges');
});

test('B ① legacyEdgesOf — origin 으로 id·이름 · 중복 제거 · 스킴 아님·SSRF 차단 대역은 사유와 함께 뺀다', () => {
  const r = sync.legacyEdgesOf({ edges: [{ url: 'https://edge-a.example:4000/', token: 't' }, { url: 'https://edge-a.example:4000/x' }, { url: 'ftp://nope' }, { url: 'http://169.254.169.254/' }, { url: '' }, null, { url: 'https://edge-b.example' }] });
  assert.deepEqual(r.edges.map((e) => [e.id, e.name, e.kind, e.token]), [['edge:https://edge-a.example:4000', 'https://edge-a.example:4000', 'edge', 't'], ['edge:https://edge-b.example', 'https://edge-b.example', 'edge', '']]);
  assert.equal(r.dropped.length, 2); assert.match(r.dropped[0].reason, /URL/); assert.ok(r.dropped[1].reason, 'SSRF 차단 사유');
  assert.deepEqual(sync.legacyEdgesOf({}).edges, []);
  assert.ok(sync.isLegacyId('edge:https://x') && !sync.isLegacyId('c1'));
});

test('B ② probeEdgeVersion — /api/health 의 version · 비-2xx · version 없음 · 연결 실패', async () => {
  const base = await listen((q, r) => {
    if (q.url === '/ok/api/health') { r.setHeader('content-type', 'application/json'); return r.end(JSON.stringify({ status: 'ok', version: '99.0.9' })); }
    if (q.url === '/nover/api/health') { r.setHeader('content-type', 'application/json'); return r.end(JSON.stringify({ status: 'ok' })); }
    r.statusCode = 503; r.end('down');
  });
  const ok = await sync.probeEdgeVersion({ url: `${base}/ok` }, { now: () => NOW });
  assert.deepEqual(ok, { at: NOW, ok: true, version: '99.0.9' });
  const nov = await sync.probeEdgeVersion({ url: `${base}/nover/` });
  assert.equal(nov.ok, true); assert.equal(nov.version, undefined); assert.match(nov.error, /version 이 없습니다/);
  const bad = await sync.probeEdgeVersion({ url: `${base}/bad` });
  assert.equal(bad.ok, false); assert.match(bad.error, /HTTP 503/);
  const dead = await sync.probeEdgeVersion({ url: 'http://127.0.0.1:1' }, { timeoutMs: 2000 });
  assert.equal(dead.ok, false); assert.match(dead.error, /health 질의 실패/);
  // 판정: 옛 방식 엣지 행은 kind 'edge' 로 같은 planEdgeSync 를 탄다
  const p = sync.planEdgeSync({ collectors: [{ id: 'edge:https://e', name: 'https://e', url: 'https://e', kind: 'edge' }], statusOf: () => null, currentVersion: CUR, now: NOW });
  assert.equal(p.edges[0].kind, 'edge'); assert.equal(p.edges[0].state, 'unknown'); assert.match(p.edges[0].reason, /health 질의 기록 없음/);
});

/** 가짜 옛 방식 엣지 하나 — 자기 포트(=origin)를 가진다. health 는 version(null 이면 500), bundle 은 받은 push 를 기록하고 답한다. */
async function fakeEdge(version, { reply = { ok: true }, pushes = [] } = {}) {
  const base = await listen((q, r) => {
    if (q.url === '/api/health') {
      if (version == null) { r.statusCode = 500; return r.end('x'); }
      r.setHeader('content-type', 'application/json'); return r.end(JSON.stringify({ status: 'ok', version }));
    }
    if (q.url.startsWith('/api/upgrade/bundle')) {
      const chunks = []; q.on('data', (c) => chunks.push(c));
      q.on('end', () => {
        pushes.push({ base, url: q.url, auth: q.headers.authorization, sha: q.headers['x-bundle-sha256'], bodySha: core.sha256Hex(Buffer.concat(chunks)), manifest: sigmod.decodeManifestHeader(q.headers[sigmod.MANIFEST_HEADER]) });
        r.statusCode = reply.status || 200; r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(reply.body || { ok: true, version: CUR }));
      });
      return;
    }
    r.statusCode = 404; r.end('{}');
  });
  return base;
}

test('B ③ 동기화가 옛 방식 엣지에도 민다 — 버전은 health 로 · 뒤처진 것만 · Bearer 토큰·sha·manifest · 이미 최신은 성공', async () => {
  const pushes = [];
  const oldB = await fakeEdge('99.0.1', { pushes });
  const curB = await fakeEdge(CUR, { pushes });
  const deadB = await fakeEdge(null, { pushes });
  const sameB = await fakeEdge('99.0.0', { pushes, reply: { body: { ok: false, upToDate: true, reason: `not newer (${CUR} <= ${CUR})`, version: CUR } } });
  fs.rmSync(COLLECTORS, { force: true });
  const s = { enabled: true, edgeAutoUpgrade: true, watchDir: '', remoteBase: '', token: '', edges: [{ url: `${oldB}/`, token: 'TOK-OLD' }, { url: curB }, { url: deadB }, { url: sameB, token: 'TOK-SAME' }] };
  let now = NOW;
  const alerts = [];
  const runner = new sync.EdgeSyncRunner({ settings: () => s, now: () => now, currentVersion: () => CUR, intervalMs: 600_000, log: quiet, notifyFn: async (a) => { alerts.push(a); return ['slack:200']; } });
  const r1 = await runner.run();
  assert.equal(r1.outcome, 'pushed', JSON.stringify(r1));
  assert.deepEqual(pushes.map((p) => p.base).sort(), [oldB, sameB].sort(), '뒤처진 옛 방식 엣지에만 민다(최신·닿지 않음은 아니다)');
  const po = pushes.find((p) => p.base === oldB);
  assert.equal(po.auth, 'Bearer TOK-OLD'); assert.equal(po.url, '/api/upgrade/bundle?restart=true');
  assert.equal(po.sha, core.sha256Hex(B.bytes)); assert.equal(po.bodySha, core.sha256Hex(B.bytes)); assert.ok(po.manifest?.includes(core.MANIFEST_FORMAT), '서명 manifest 를 함께');
  assert.equal(r1.pushed, 2); assert.equal(r1.ok, 2, "'이미 최신' 응답은 성공"); assert.equal(r1.source, 'package');
  assert.equal(alerts.length, 0);
  const st = runner.status(now);
  assert.equal(st.legacy, 4); assert.equal(st.total, 4); assert.equal(st.counts['up-to-date'], 1);
  const pend = Object.fromEntries(st.pending.map((e) => [e.id, e.state]));
  assert.deepEqual(pend, { [`edge:${oldB}`]: 'waiting', [`edge:${deadB}`]: 'unknown', [`edge:${sameB}`]: 'waiting' });
  assert.equal(st.pending.find((e) => e.id === `edge:${deadB}`).kind, 'edge');
  assert.match(st.pending.find((e) => e.id === `edge:${deadB}`).reason, /닿지 않아 버전을 모름 — health -> HTTP 500/);
  assert.equal(runner.legacyStatus.get(`edge:${oldB}`).version, '99.0.1');
  // 다시 돌면 settle 중이라 밀지 않는다
  pushes.length = 0; now += 60_000;
  assert.equal((await runner.run()).outcome, 'idle'); assert.equal(pushes.length, 0);
});

test('B ④ 번들 파일이 패키지 폴더에 없으면 옛 방식 엣지만 사유와 함께 실패하고 수집 서버는 그대로 민다', async () => {
  const pushes = [];
  const oldB = await fakeEdge('99.0.1', { pushes });
  const cpush = [];
  const s = { enabled: true, edgeAutoUpgrade: true, watchDir: '', remoteBase: '', token: '', edges: [{ url: oldB }] };
  const runner = new sync.EdgeSyncRunner({
    settings: () => s, now: () => NOW, currentVersion: () => CUR, intervalMs: 600_000, log: quiet, notifyFn: async () => [],
    collectors: () => [{ id: 'c1', name: 'c1', url: 'https://c1', enabled: true }], statusOf: () => ({ ok: true, version: '99.0.5' }),
    pushFn: async (bytes, o) => { cpush.push(o.ids); return o.ids.map((id) => ({ id, name: id, ok: true, version: CUR })); },
    resolveBundle: async () => ({ bytes: B.bytes, version: CUR, source: 'remote', manifest: null, path: null }), // 보관 실패 → 파일 경로 없음
  });
  const r = await runner.run();
  assert.equal(r.outcome, 'pushed'); assert.deepEqual(cpush, [['c1']]); assert.equal(pushes.length, 0, '파일이 없으면 옛 방식 엣지에는 보내지 않는다');
  assert.equal(r.pushed, 2); assert.equal(r.ok, 1);
  assert.equal(r.failed[0].id, `edge:${oldB}`); assert.match(r.failed[0].reason, /번들 파일이 패키지 폴더에 없어/);
});

test('C ① POST /api/upgrade/edge-sync(실제 라우터) — 관리자·전체 범위만 · 꺼져 있으면 409 · 결과·상태를 돌려준다', async () => {
  const { upgradeRouter } = await import('../src/routes/upgrade.js');
  const app = express();
  app.use(express.json());
  const USERS = { admin: { username: 'adm', role: 'admin' }, scoped: { username: 'sc', role: 'admin', scope: { vcenters: ['vc1'] } }, op: { username: 'op', role: 'operator' } };
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api/upgrade', upgradeRouter);
  const srv = http.createServer(app); servers.push(srv);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = (u) => fetch(`${base}/api/upgrade/edge-sync`, { method: 'POST', headers: { 'x-u': u } });
  fs.rmSync(COLLECTORS, { force: true });
  const saved = upgradeManager.settings;
  try {
    upgradeManager.settings = { ...saved, enabled: true, edgeAutoUpgrade: true, watchDir: '', remoteBase: '', edges: [] };
    assert.equal((await call('op')).status, 403, '운영자는 못 한다');
    assert.equal((await call('scoped')).status, 403, '범위 관리자는 못 한다(포탈 전체에 영향)');
    const r = await call('admin');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true); assert.equal(j.run.outcome, 'no-edges'); assert.equal(j.edgeSync.enabled, true);
    assert.equal(upgradeManager.edgeSync.lastRun.outcome, 'no-edges', '주기 실행과 같은 runner');
    upgradeManager.settings = { ...saved, enabled: false };
    assert.equal((await call('admin')).status, 409, '기능이 꺼져 있으면 409(check·apply 와 같다)');
    upgradeManager.settings = { ...saved, enabled: true, edgeAutoUpgrade: false, edges: [] };
    const off = await (await call('admin')).json();
    assert.equal(off.ok, false); assert.equal(off.run.outcome, 'off');
  } finally { upgradeManager.settings = saved; upgradeManager.edgeSync.lastRun = null; }
  assert.match(read('routes/admin/collectorsDc.js'), /edgeSync: upgradeManager\.edgeSync\.status\(\)/, 'GET /admin/collectors 가 동기화 상태를 싣는다');
});

test('D 반복 실패 알림 — 백오프 상한에 닿는 연속 실패에 한 번 · 그 뒤 성공에 해소 한 번 · 본문에 백틱·별표 없음', async () => {
  const alerts = [];
  let fail = true;
  let now = NOW;
  const runner = new sync.EdgeSyncRunner({
    settings: () => ({ enabled: true, edgeAutoUpgrade: true, edges: [] }), now: () => now, currentVersion: () => CUR, intervalMs: 600_000, log: quiet,
    collectors: () => [{ id: 'pl', name: '폴란드', url: 'https://pl', enabled: true }], statusOf: () => ({ ok: true, version: '99.0.2' }),
    pushFn: async (bytes, o) => o.ids.map((id) => (fail ? { id, name: '폴란드', ok: false, status: 403, reason: 'HTTP 403 · 토큰 불일치' } : { id, name: '폴란드', ok: true, version: CUR })),
    resolveBundle: async () => ({ bytes: B.bytes, version: CUR, source: 'package', manifest: null, path: K.path }),
    notifyFn: async (a) => { alerts.push(a); return ['slack:200']; },
  });
  // 10분 주기: 백오프 10·20·40·80·160·320 → 7번째 실패에서 상한(360분)에 닿는다
  for (let i = 1; i <= 7; i += 1) {
    const r = await runner.run();
    assert.equal(r.outcome, 'pushed', `${i}: ${JSON.stringify(r)}`); assert.equal(r.ok, 0);
    assert.equal(runner.attempts.get('pl').attempts, i);
    assert.equal(alerts.length, i >= 7 ? 1 : 0, `${i}번째 실패 뒤 알림 수`);
    now += sync.backoffMs(i, 600_000) + 1; // 백오프가 끝난 다음 주기
  }
  const a = alerts[0];
  assert.equal(a.key, `edgesync:pl|${CUR}`); assert.equal(a.severity, 'warning');
  assert.match(a.title, /엣지 자동 업그레이드 실패 반복 — 폴란드 v99\.1\.0/); assert.match(a.detail, /연속 실패: 7회/); assert.match(a.detail, /HTTP 403/); assert.match(a.detail, /조치:/);
  assert.ok(!/[`]|\*\*/.test(a.title + a.detail), '알림 본문에 백틱·별표 없음');
  // 8번째 실패 — 또 알리지 않는다(이미 알렸다)
  const r8 = await runner.run(); assert.equal(r8.ok, 0); assert.equal(alerts.length, 1);
  now += sync.SYNC_BACKOFF_MAX_MS + 1;
  // 성공 → 해소 한 번, 그 뒤 성공에는 아무것도 없다
  fail = false;
  const r9 = await runner.run(); assert.equal(r9.ok, 1); assert.equal(alerts.length, 2);
  assert.equal(alerts[1].key, `edgesync:pl|${CUR}:close`); assert.equal(alerts[1].severity, 'info'); assert.match(alerts[1].title, /해소/);
  assert.equal(runner.attempts.get('pl').attempts, 0);
  now += sync.SYNC_SETTLE_MS + 1;
  assert.equal((await runner.run()).outcome, 'pushed'); assert.equal(alerts.length, 2);
  // 알림 발송이 던져도 동기화는 계속된다
  const r2 = new sync.EdgeSyncRunner({ settings: () => ({ enabled: true, edgeAutoUpgrade: true }), now: () => NOW, currentVersion: () => CUR, intervalMs: 600_000, log: quiet,
    collectors: () => [{ id: 'x', name: 'x', url: 'https://x', enabled: true }], statusOf: () => ({ ok: true, version: '1.0.0' }),
    pushFn: async (b, o) => o.ids.map((id) => ({ id, ok: false, reason: 'boom' })), resolveBundle: async () => ({ bytes: B.bytes, version: CUR, source: 'package', manifest: null, path: K.path }),
    notifyFn: async () => { throw new Error('channel down'); } });
  r2.attempts.set('x', { at: 0, ok: false, target: CUR, attempts: 6, reason: 'boom' });
  assert.equal((await r2.run()).outcome, 'pushed');
  assert.equal(sync.backoffCapped(7, 600_000), true); assert.equal(sync.backoffCapped(6, 600_000), false); assert.equal(sync.backoffCapped(4, 3_600_000), true);
  const txt = sync.edgeSyncAlert({ id: 'edge:https://e', name: 'https://e', kind: 'edge', target: CUR, attempts: 7, reason: 'x', intervalMs: 600_000 });
  assert.match(txt.title, /\(옛 방식 엣지\)/);
});

test('소스 스윕 — 상태 파일에 lastEdgeSync · onRun 훅 · pushBundleToEdge 의 upToDate · 문서', () => {
  assert.match(read('upgrade/statusStore.js'), /lastEdgeSync: strip\(sanitizeEdgeSync\(lastEdgeSync\)\)/);
  assert.match(read('upgrade/manager.js'), /onRun: \(\) => this\.#save\(\)/);
  assert.match(read('upgrade/manager.js'), /this\.edgeSync\.restore\(prev\.lastEdgeSync\)/);
  assert.match(read('upgrade/upgrade.js'), /body\.upToDate === true \? \{ upToDate: true \}/, 'pushBundleToEdge 도 이미 최신을 전한다');
  assert.match(read('upgrade/edgeSync.js'), /ssrfBlockReason\(url\)/, '옛 방식 엣지 주소도 SSRF 차단 대역을 거른다');
  const edgeDoc = fs.readFileSync(path.resolve(HERE, '../../docs/rules/edge.md'), 'utf8');
  assert.ok(edgeDoc.includes('v2.865'), 'docs/rules/edge.md 에 후속 기록');
});
