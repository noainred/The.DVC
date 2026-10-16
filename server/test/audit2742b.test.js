/**
 * test/audit2742b.test.js — v2.742 점검 GB 그룹(아이실론 '지금 수집' 대기열 · 자동 업그레이드 대기) 회귀.
 *
 *  · RECENT-02 = EDGE-02  '지금 수집' 대기열(v2.741 TIMING-02)이 메모리에만 있어 재시작·자동 업그레이드에 **기록 없이** 사라졌다
 *              (엣지 위임이면 중앙은 그 요청을 결과 시한까지 '진행 중' 으로 잡아 두었다). 이제 실행 중 스캔 기록(scanJournal)의
 *              `queued` 에 남고, 다음 기동(모듈 로드)에서 대기열로 돌아와 차례로 시작한다 — 실제 runNow·실제 틱·접속을 세는 TCP 서버로 본다.
 *              재시작 전에 **돌던** 조사(재개 대기)가 자리를 먼저 받는다. 대기 시한이 지난 것·SCAN_RESUME=0 은 다시 넣지 않고 이력에 남긴다.
 *              자동 업그레이드: 기록이 남은 대기 요청은 기다리지 않고(재시작 뒤 돌아온다) 사유를 남긴다 · 기록을 못 남긴 것은 기다린다.
 *  · TIMING-04  자동 업그레이드 대기가 진행 중인 에이전트 대량 배포를 보지 않았다 — 실제 startBulkDeploy(배포 함수만 주입)와 UpgradeManager.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2742b-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.SSH_HOSTKEY_POLICY = 'observe';
process.env.SSH_READY_TIMEOUT_MS = '5000';
process.env.ISIDU_SSH_KEY = '';
delete process.env.ISIDU_CONCURRENCY; // 기본 2
delete process.env.SCAN_RESUME;
delete process.env.UPGRADE_SCAN_DEFER_MAX_MS;
delete process.env.CENTRAL_URL;

const ROOT = '/ifs/data/workspace/users';
const MIN = 60_000;
const HOUR = 3_600_000;
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const J = await import('../src/util/scanJournal.js');
const S = await import('../src/isidu/settings.js');
const db = await import('../src/isidu/db.js');
const P = await import('../src/isidu/poller.js');
const reg = await import('../src/storage/registry.js');
const { pickAgent, pickDatacenter } = await import('../src/cvp/formChoices.js');
const { UpgradeManager } = await import('../src/upgrade/manager.js');
const BD = await import('../src/agent/bulkDeploy.js');
const { runningScanWarning } = await import('../../web/src/views/upgradeAutoText.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15_000, step = 20) => {
  const until = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > until) throw new Error('시간 초과'); await sleep(step); }
};
const journalFile = () => { try { return JSON.parse(fs.readFileSync(path.join(DIR, 'scan-journal.json'), 'utf8')); } catch { return null; } };

/* 장비 접속 흉내 — 접속을 세고, hold 동안은 끊지 않는다(release 로 한꺼번에 끊는다). */
let active = 0; let maxActive = 0; let total = 0; let hold = false; const socks = new Set();
let port = 0;
function release() { hold = false; for (const s of socks) { try { s.destroy(); } catch { /* */ } } }
const IDS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'];

before(async () => {
  const srv = net.createServer((sock) => {
    active++; total++; maxActive = Math.max(maxActive, active);
    socks.add(sock);
    sock.on('error', () => {});
    sock.on('close', () => { active--; socks.delete(sock); });
    if (!hold) setTimeout(() => sock.destroy(), 120);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  port = srv.address().port;
  closers.push(() => new Promise((r) => { release(); srv.close(() => r()); }));
  // enabled:false — 주기 틱이 스스로 시작하지 않는다(사람이 누른 것·재개만 돈다)
  const local = (id) => ({ id, label: `대상 ${id}`, host: '127.0.0.1', port, path: ROOT, auth: 'key', username: 'admin', intervalHours: 24, enabled: false });
  const r = S.saveSettings({ targets: IDS.map(local) }, { devices: reg.listDevices(), agents: [], dcs: [], pickAgent, pickDatacenter, ssrfBlockReason: () => null });
  assert.equal(r.ok, true, r.error);
});

function mkManager() {
  const m = new UpgradeManager();
  m.settings = { ...m.settings, enabled: true, autoApply: true, installDir: '/opt/x', remoteBase: 'https://example.invalid', pollIntervalMs: 3_600_000 };
  m.check = async () => ({ remote: { ok: true, latest: '9.9.9', available: true } });
  m.applied = 0;
  m.apply = async () => { m.applied++; return { ok: true, version: '9.9.9' }; };
  return m;
}
async function finish(m) {
  m.check = async () => ({ remote: { ok: true, latest: '1.0.0', available: false } });
  await m.tick();
  assert.equal(m.deferral, null);
  assert.equal(m.deferTimer, null);
}

/* ═══════════════ RECENT-02 ① 대기 요청은 실행 중 스캔 기록(파일)에 남고, 시작하면 지운다 ═══════════════ */

test("RECENT-02 '지금 수집' 대기 요청은 실행 중 스캔 기록 파일에 남고 · 차례로 시작하면 기록을 지운다", async () => {
  J._resetForTest(); P._resetForTest();
  total = 0; maxActive = 0; hold = true;
  const res = await P.runNow(['q1', 'q2', 'q3', 'q4'], { trigger: 'central' });
  assert.equal(res.started.length, 2, JSON.stringify(res));
  assert.equal(res.queued.length, 2);
  const doc = journalFile();
  assert.ok(doc, '기록 파일이 있다');
  const keys = (doc.queued || []).map((x) => x.key).sort();
  assert.deepEqual(keys, [...res.queued].sort(), `대기 요청이 파일에 남는다(재시작에도 남게): ${JSON.stringify(doc.queued)}`);
  for (const q of doc.queued) {
    assert.equal(q.kind, 'isidu');
    assert.equal(q.trigger, 'central');
    assert.ok(q.until > q.since && q.until - q.since === P.QUEUE_HOLD_MS, '대기 시한(보류에는 시한)');
  }
  assert.equal(J.journalFor('isidu').queued.length, 2, '상태에도 싣는다');
  assert.ok(J.queuedScans().every((x) => x.resumable === true), '기록이 남았으니 재시작 뒤 돌아온다(resumable)');
  release();
  await P.waitIdle();
  assert.equal(total, 4, `네 대상 모두 접속했다(실제 ${total})`);
  assert.ok(maxActive <= 2, `동시 상한(실제 최대 ${maxActive})`);
  assert.deepEqual(journalFile().queued || [], [], '시작한 대기 요청은 기록에서 지운다');
  assert.equal(P.isiduPollerStatus().queued.length, 0);
});

/* ═══════════════ RECENT-02 ② 재시작 — 다음 기동이 대기열로 되돌려 차례로 시작한다 ═══════════════ */

test('RECENT-02 재시작 뒤 대기 요청은 대기열로 돌아와 차례로 시작한다 · 대기 시한이 지난 것은 이력에 남기고 다시 넣지 않는다', async () => {
  J._resetForTest(); P._resetForTest();
  total = 0; hold = false;
  const now = Date.now();
  // 이전 프로세스: 대기 요청 둘(하나는 대기 시한이 지났다) — 재시작이 왔다.
  J.scanQueued('isidu', 'q5', { label: '대상 q5', trigger: 'central', since: now - 2 * MIN, holdMs: P.QUEUE_HOLD_MS, meta: { manual: true } });
  J.scanQueued('isidu', 'q6', { label: '대상 q6', trigger: 'manual', since: now - 7 * HOUR, holdMs: P.QUEUE_HOLD_MS, meta: { manual: true } });
  J._reloadForTest();
  const hist = J.journalFor('isidu').recent;
  assert.ok(hist.some((h) => h.key === 'q6' && h.outcome === 'expired'), `시한이 지난 대기 요청은 조용히 버리지 않고 이력에 남긴다: ${JSON.stringify(hist)}`);
  assert.deepEqual(J.queuedOf('isidu').map((x) => x.key), ['q5']);
  // 새 기동 — 폴러 모듈을 새로 읽는다(모듈 로드 때 대기열로 되돌린다).
  const P2 = await import('../src/isidu/poller.js?restart=b');
  const st = P2.isiduPollerStatus();
  assert.deepEqual(st.queued.map((x) => x.targetId), ['q5'], `대기 요청이 대기열로 돌아왔다: ${JSON.stringify(st.queued)}`);
  assert.equal(st.queued[0].since, now - 2 * MIN, '원래 넣은 시각 그대로(재시작이 대기 시한을 늘리지 않는다)');
  assert.equal(st.queued[0].restored, true);
  assert.equal(st.queued[0].trigger, 'central');
  await P2._tickForTest();
  await P2.waitIdle();
  assert.equal(total, 1, `돌아온 대기 요청이 실제로 접속했다(실제 ${total})`);
  const lat = await db.latestOf('', 'q5');
  assert.ok(lat?.lastTry && lat.lastTry.ts >= now, '그 대상의 조사 기록이 남았다');
  assert.deepEqual(J.queuedOf('isidu'), [], '시작했으니 기록에서 지운다');
});

test('RECENT-02 SCAN_RESUME=0 인 기동은 대기 요청을 다시 넣지 않고 이력에 사유를 남긴다', async () => {
  J._resetForTest();
  J.scanQueued('isidu', 'q4', { label: '대상 q4', trigger: 'manual', since: Date.now() - MIN, holdMs: P.QUEUE_HOLD_MS });
  process.env.SCAN_RESUME = '0';
  try {
    assert.equal(J.queuedScans()[0].resumable, false, '재개가 꺼져 있으면 재시작 뒤 돌아오지 않는다(업그레이드가 기다릴 대상)');
    J._reloadForTest();
    assert.deepEqual(J.queuedOf('isidu'), []);
    assert.ok(J.journalFor('isidu').recent.some((h) => h.key === 'q4' && h.outcome === 'skipped' && /SCAN_RESUME=0/.test(h.note)));
  } finally { delete process.env.SCAN_RESUME; J._resetForTest(); }
});

/* ═══════════════ RECENT-02 ③ 재시작 전에 돌던 조사가 자리를 먼저 받는다 ═══════════════ */

test('RECENT-02 되돌린 대기 요청은 재시작 전에 돌던 조사(재개 대기)의 자리를 먼저 차지하지 않는다', async () => {
  J._resetForTest(); P._resetForTest();
  total = 0; maxActive = 0; hold = true;
  // 이전 프로세스: q1·q2 를 조사하던 중(동시 상한 2를 다 썼다) + q3 대기 — 재시작이 왔다.
  J.scanStarted('isidu', 'q1', { label: '대상 q1', trigger: 'manual', meta: { manual: true } });
  J.scanStarted('isidu', 'q2', { label: '대상 q2', trigger: 'manual', meta: { manual: true } });
  J.scanQueued('isidu', 'q3', { label: '대상 q3', trigger: 'manual', since: Date.now(), holdMs: P.QUEUE_HOLD_MS });
  J._reloadForTest();
  assert.equal(J.journalFor('isidu').interrupted.length, 2);
  const P3 = await import('../src/isidu/poller.js?restart=c');
  assert.deepEqual(P3.isiduPollerStatus().queued.map((x) => x.targetId), ['q3']);
  // 첫 틱(기동 90초)이 재개(기동 2분)보다 먼저 온다 — 대기 요청이 자리를 먼저 차지하면 재개가 '다른 스캔 중' 으로 밀린다.
  await P3._tickForTest();
  assert.equal(P3.isiduPollerStatus().running.length, 0, '재개를 기다리는 조사의 자리는 비워 둔다');
  const r = await J.processScanResumes();
  assert.equal(r.pending, 0, '두 조사 모두 재개됐다(busy 로 밀리지 않았다)');
  const resumed = J.journalFor('isidu').recent.filter((h) => h.outcome === 'resumed').map((h) => h.key).sort();
  assert.deepEqual(resumed, ['q1', 'q2']);
  assert.deepEqual(P3.isiduPollerStatus().running.map((x) => x.targetId).sort(), ['q1', 'q2']);
  assert.deepEqual(P3.isiduPollerStatus().queued.map((x) => x.targetId), ['q3'], '대기 요청은 그 뒤 차례를 기다린다(버리지 않는다)');
  release();
  await P3.waitIdle();
  assert.equal(total, 3, `재개 둘 + 대기 하나가 차례로 접속했다(실제 ${total})`);
  assert.ok(maxActive <= 2, `동시 상한(실제 최대 ${maxActive})`);
  assert.deepEqual(J.queuedOf('isidu'), []);
});

/* ═══════════════ RECENT-02 ④ 자동 업그레이드 — 기록이 남은 대기 요청은 기다리지 않고, 못 남긴 것은 기다린다 ═══════════════ */

test('RECENT-02 자동 업그레이드: 기록이 남은 대기 요청은 기다리지 않고 사유를 남긴다 · 재시작 뒤 돌아오지 않을 대기 요청은 기다린다', async () => {
  J._resetForTest();
  J.scanQueued('isidu', 'q2', { label: '대상 q2', trigger: 'manual', since: Date.now(), holdMs: P.QUEUE_HOLD_MS });
  try {
    const m = mkManager();
    await m.tick();
    assert.equal(m.applied, 1, '돌아올 대기 요청 때문에 업그레이드를 미루지 않는다(분리 실행 du 와 같은 판단)');
    assert.match(m.lastTick.reason || '', /시작을 기다리는 '지금 수집' 1개\(대상 q2\)는 기다리지 않습니다\(재시작 뒤 대기열로 돌아와/, '조용히 넘기지 않는다');
    const st = m.status();
    assert.equal(st.queuedScans.length, 1, '화면 응답에 싣는다');
    assert.equal(st.queuedScans[0].resumable, true);
    assert.equal(runningScanWarning(st), null, '돌아오는 대기 요청만 있으면 수동 적용을 경고하지 않는다');
    // 재개가 꺼진 노드 — 재시작이 그 요청을 지우므로 기다린다(상한은 스캔과 같다).
    process.env.SCAN_RESUME = '0';
    const m2 = mkManager();
    await m2.tick();
    assert.equal(m2.applied, 0, '재시작 뒤 돌아오지 않을 대기 요청은 기다린다');
    assert.equal(m2.lastTick.outcome, 'deferred');
    assert.match(m2.lastTick.reason, /'지금 수집' 대기 대상 q2/);
    assert.ok(m2.status().auto.issues.some((x) => x.code === 'deferred-scans' && x.scans === 1));
    const w = runningScanWarning(m2.status());
    assert.match(w, /시작을 기다리는 ‘지금 수집’ 1개는 기록을 남기지 못해/);
    assert.ok(!w.includes('`'));
    J.scanDequeued('isidu', 'q2');
    delete process.env.SCAN_RESUME;
    await finish(m2);
  } finally { delete process.env.SCAN_RESUME; J._resetForTest(); }
});

/* ═══════════════ TIMING-04 — 진행 중인 에이전트 대량 배포를 기다린다 ═══════════════ */

test('TIMING-04 자동 적용은 진행 중인 에이전트 대량 배포가 끝나기를 기다리고, 수동 적용 경고도 그것을 말한다', async () => {
  J._resetForTest(); BD._resetForTest();
  let open; const gate = new Promise((r) => { open = r; });
  const started = BD.startBulkDeploy([{ host: '10.20.30.40', port: 22, username: 'root', password: 'pw' }, { host: '10.20.30.41', port: 22, username: 'root', password: 'pw' }],
    { saveTargets: false, registerCollector: false, concurrency: 1, by: 'admin', deploy: async () => { await gate; return { ok: false, reason: '테스트' }; } });
  assert.equal(started.ok, true);
  await waitFor(() => BD.getRun(started.runId).counts.running === 1, 5_000);
  const m = mkManager();
  try {
    await m.tick();
    assert.equal(m.applied, 0, '배포 중에는 적용하지 않는다(재시작이 원격 설치를 중간에 끊는다)');
    assert.equal(m.lastTick.outcome, 'deferred');
    assert.deepEqual(m.deferral.scans.map((x) => x.kind), ['bulk-deploy']);
    assert.match(m.lastTick.reason, /에이전트 대량 배포 2대\(진행 1 · 대기 1\)/);
    const st = m.status();
    assert.equal(st.runningDeploys.length, 1, '화면 응답에 싣는다');
    assert.ok(!JSON.stringify(st.runningDeploys).includes('pw'), '자격증명을 싣지 않는다');
    const w = runningScanWarning(st);
    assert.match(w, /지금 에이전트 대량 배포가 돌고 있습니다/);
    assert.match(w, /설치가 끝나지 않은 노드/);
    assert.ok(!w.includes('`'));
    // 상한을 넘겨 적용할 때 — 스캔이 아니므로 '자동 재개가 잇습니다' 라고 말하지 않는다.
    process.env.UPGRADE_SCAN_DEFER_MAX_MS = '1';
    const mf = mkManager();
    await mf.tick(); await sleep(5);
    const warns = [];
    const orig = console.warn;
    console.warn = (...a) => { warns.push(a.join(' ')); };
    try { await mf.tick(); } finally { console.warn = orig; }
    assert.equal(mf.applied, 1, '상한을 넘기면 적용한다(끝나지 않는 배포가 업그레이드를 막지 않게)');
    const line = warns.find((x) => /대기 상한/.test(x)) || '';
    assert.match(line, /에이전트 대량 배포 1건은 중간에 끊깁니다/);
    assert.doesNotMatch(line, /자동 재개가 잇습니다/, '배포는 재개되지 않는다 — 그렇게 말하지 않는다');
    delete process.env.UPGRADE_SCAN_DEFER_MAX_MS;
  } finally {
    delete process.env.UPGRADE_SCAN_DEFER_MAX_MS;
    open();
    await waitFor(() => BD.getRun(started.runId).status !== 'running', 5_000);
  }
  await m.tick();
  assert.equal(m.applied, 1, '배포가 끝나면 적용한다');
  assert.equal(m.deferral, null);
  BD._resetForTest(); J._resetForTest();
});
