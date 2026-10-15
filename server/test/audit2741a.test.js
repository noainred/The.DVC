/**
 * audit2741a.test.js — v2.741 점검 GA 그룹(업그레이드 · 실행 중 스캔 기록) 회귀.
 *
 *   RECENT-01  원격 확인 실패 한 번이 자동 업그레이드 대기(since·until)와 1분 재확인을 지워 '늦어도 X' 상한이 밀렸다
 *   RECENT-04  hedgedFetch(v2.740.1)가 429·503 의 Retry-After 를 보지 않고 400·800ms 뒤 다시 보냈고, 503 뒤에도 함께 보내기를 계속했다
 *   TIMING-03  자동 업그레이드가 재시작에 안전한 분리 실행 du(meta.jobId)까지 기다렸다
 *   TIMING-04  같은 키(iDRAC 'cycle')의 재개 대기 항목이 다음 재시작 때 이력 없이 사라졌다 · 재개가 같은 키의 다른 대기 항목까지 지웠다
 *   TIMING-07  업그레이드 번들 push 가 모든 수집 서버·엣지에 동시에(Promise.all) 나갔다
 *   TIMING-01③ 자동 업그레이드 대기가 실행 중 VM 복제 잡을 기다리지 않았다(재시작이 원본 VM 에 임시 스냅샷을 남긴다)
 *
 * 실제 함수(scanJournal·UpgradeManager·hedgedFetch·pushUpgradeToCollectors·vmclone runner)를 부르고, 네트워크는 루프백 HTTP 서버다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2741a-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';           // VM 복제 잡을 시뮬레이션(실제 vCenter 없이 2초) 으로 돌린다
process.env.SSRF_ALLOW_LOOPBACK = 'true';
delete process.env.SCAN_RESUME;
delete process.env.UPGRADE_SCAN_DEFER_MAX_MS;
delete process.env.UPGRADE_PUSH_CONCURRENCY;
delete process.env.UPGRADE_CHECK_HEDGE_MS;

const J = await import('../src/util/scanJournal.js');
const { UpgradeManager } = await import('../src/upgrade/manager.js');
const hf = await import('../src/upgrade/hedgedFetch.js');
const push = await import('../src/collector/upgradePush.js');

const servers = [];
after(() => {
  for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});
async function serve(handler) {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${s.address().port}`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10_000, step = 20) => {
  const until = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > until) throw new Error('시간 초과'); await sleep(step); }
};
const DOC = JSON.stringify({ latest: '9.9.9', versions: [] });

function mkManager(check) {
  const m = new UpgradeManager();
  m.settings = { ...m.settings, enabled: true, autoApply: true, installDir: '/opt/x', remoteBase: 'https://example.invalid', pollIntervalMs: 3_600_000 };
  m.check = check || (async () => ({ remote: { ok: true, latest: '9.9.9', available: true } }));
  m.applied = 0;
  m.apply = async () => { m.applied++; return { ok: true, version: '9.9.9' }; };
  return m;
}
/** 대기를 지운다(타이머 정리) — 확인에 성공했고 새 버전이 없다. */
async function finish(m) {
  m.check = async () => ({ remote: { ok: true, latest: '1.0.0', available: false } });
  await m.tick();
  assert.equal(m.deferral, null, '확인에 성공했고 받을 것이 없으면 대기를 끝낸다');
  assert.equal(m.deferTimer, null);
}

/* ═══════════════ RECENT-01 — 원격 확인 실패는 대기를 지우지 않는다 ═══════════════ */

test('RECENT-01 대기 중 원격 확인이 한 번 실패해도 since·until 과 1분 재확인을 그대로 둔다', async () => {
  J._resetForTest();
  const m = mkManager();
  J.scanStarted('ipscan', 'local', { label: '긴 스캔' });
  try {
    await m.tick();
    assert.equal(m.lastTick.outcome, 'deferred');
    const { since, until } = m.deferral;
    assert.ok(m.deferTimer, '1분 재확인 타이머');
    await sleep(5);
    m.check = async () => ({ remote: { ok: false, error: 'versions.json HTTP 503', available: false, lastGood: { latest: '9.9.9' } } });
    await m.tick();
    assert.equal(m.lastTick.outcome, 'check-failed');
    assert.ok(m.deferral, '확인하지 못한 것은 받을 것이 없어진 것이 아니다 — 대기 기록을 지우지 않는다');
    assert.equal(m.deferral.since, since);
    assert.equal(m.deferral.until, until);
    assert.ok(m.deferTimer, '재확인 타이머도 그대로');
    await sleep(5);
    m.check = async () => ({ remote: { ok: true, latest: '9.9.9', available: true } });
    await m.tick();
    assert.equal(m.lastTick.outcome, 'deferred');
    assert.equal(m.deferral.since, since, "다음 성공 확인에서 상한('늦어도 X')이 새로 시작하지 않는다");
    assert.equal(m.deferral.until, until);
    assert.equal(m.applied, 0);
  } finally {
    J.scanFinished('ipscan', 'local');
    await finish(m);
  }
});

test('RECENT-01 자동 적용을 끄면 확인이 실패해도 대기를 끝낸다', async () => {
  J._resetForTest();
  const m = mkManager();
  J.scanStarted('ipscan', 'local', { label: '긴 스캔' });
  try {
    await m.tick();
    assert.ok(m.deferral);
    m.settings = { ...m.settings, autoApply: false };
    m.check = async () => ({ remote: { ok: false, error: 'x', available: false } });
    await m.tick();
    assert.equal(m.deferral, null);
    assert.equal(m.deferTimer, null);
  } finally { J.scanFinished('ipscan', 'local'); J._resetForTest(); }
});

/* ═══════════════ RECENT-04 — Retry-After 를 따른다 ═══════════════ */

test('RECENT-04 503 + Retry-After 2 — 다음 시도는 2초 뒤(예전 400ms)', { timeout: 15_000 }, async () => {
  const times = [];
  const base = await serve((_q, r) => {
    times.push(Date.now());
    if (times.length === 1) { r.statusCode = 503; r.setHeader('retry-after', '2'); r.end('busy'); return; }
    r.setHeader('content-type', 'application/json'); r.end(DOC);
  });
  const { res, attempts } = await hf.hedgedFetch(`${base}/versions.json`, { totalMs: 20_000, hedgeMs: 3000, signal: AbortSignal.timeout(20_000) });
  assert.equal(res.status, 200);
  assert.equal(attempts, 2);
  assert.ok(times[1] - times[0] >= 1_900, `Retry-After 를 따른다(${times[1] - times[0]}ms)`);
  assert.ok(times[1] - times[0] < 3_500, '흔들림 상한(1.5배) 안');
});

test('RECENT-04 503 을 받은 뒤에는 함께 보내기를 멈춘다(과부하 저장소에 요청을 겹쳐 보내지 않는다)', { timeout: 20_000 }, async () => {
  let n = 0;
  const base = await serve((_q, r) => {
    const i = ++n;
    if (i === 1) { setTimeout(() => { if (!r.destroyed) { r.setHeader('content-type', 'application/json'); r.end(DOC); } }, 5_000); return; }
    r.statusCode = 503; r.setHeader('retry-after', '4'); r.end('busy');
  });
  const t0 = Date.now();
  const { res, attempts } = await hf.hedgedFetch(`${base}/versions.json`, { totalMs: 30_000, attemptMs: 10_000, hedgeMs: 1000, signal: AbortSignal.timeout(30_000) });
  assert.equal(res.status, 200, '앞 시도가 이긴다');
  assert.equal(n, 2, `503 뒤 400ms 만에 셋째 요청을 보내지 않는다(요청 ${n}번)`);
  assert.equal(attempts, 2);
  assert.ok(Date.now() - t0 >= 4_900);
});

test('RECENT-04 Retry-After 가 남은 전체 시한보다 길면 기다리지 않고 그 응답(HTTP 503)으로 결론', { timeout: 10_000 }, async () => {
  let n = 0;
  const base = await serve((_q, r) => { n++; r.statusCode = 503; r.setHeader('retry-after', '5'); r.end('busy'); });
  const t0 = Date.now();
  const { res, attempts } = await hf.hedgedFetch(`${base}/versions.json`, { totalMs: 1_500, hedgeMs: 3000, signal: AbortSignal.timeout(1_500) });
  assert.equal(res.status, 503);
  assert.equal(attempts, 1, '시한 안에 끝나지 못할 재시도를 보내지 않는다');
  assert.equal(n, 1);
  assert.ok(Date.now() - t0 < 1_000);
});

test('RECENT-04 Retry-After 없는 503 은 예전처럼 짧은 대기(400ms) 뒤 다시', { timeout: 10_000 }, async () => {
  const times = [];
  const base = await serve((_q, r) => {
    times.push(Date.now());
    if (times.length === 1) { r.statusCode = 503; r.end('busy'); return; }
    r.setHeader('content-type', 'application/json'); r.end(DOC);
  });
  const { res } = await hf.hedgedFetch(`${base}/versions.json`, { totalMs: 10_000, hedgeMs: 3000, signal: AbortSignal.timeout(10_000) });
  assert.equal(res.status, 200);
  assert.ok(times[1] - times[0] < 1_500, `${times[1] - times[0]}ms`);
});

/* ═══════════════ TIMING-04 — 같은 키의 재개 대기 항목 ═══════════════ */

test('TIMING-04 같은 키(cycle)의 대기 항목이 다음 재시작 때 사라지지 않고, 재개는 자기 항목만 지운다', async () => {
  J._resetForTest();
  // 재시작 #1 전: 수동 iDRAC 스캔(대역 r1·r2)
  J.scanStarted('idrac-scan', 'cycle', { label: '대역 r1·r2', trigger: 'manual', coversPending: false, meta: { ids: ['r1', 'r2'], manual: true } });
  J._reloadForTest();
  let st = J.scanJournalStatus();
  assert.equal(st.interrupted.length, 1);
  await sleep(3);
  // 재시작 #1 뒤: 주기 스캔(e1..e3)이 같은 키로 시작 — 대기 항목은 남는다(coversPending:false)
  J.scanStarted('idrac-scan', 'cycle', { label: '전체 3개 대역', trigger: 'periodic', coversPending: false, meta: { ids: ['e1', 'e2', 'e3'] } });
  assert.equal(J.scanJournalStatus().interrupted.length, 1);
  // 재시작 #2
  J._reloadForTest();
  st = J.scanJournalStatus();
  assert.equal(st.interrupted.length, 2, `두 대기 항목이 모두 남는다(예전에는 앞 항목이 이력 없이 사라졌다): ${JSON.stringify(st.interrupted)}`);
  const labels = st.interrupted.map((x) => x.label).sort();
  assert.deepEqual(labels, ['대역 r1·r2', '전체 3개 대역']);

  // 재개 — 첫 항목이 실행되는 동안 둘째는 기다린다(같은 잠금). 둘째를 'resumed' 로 지우지 않는다.
  let busy = false;
  const seen = [];
  J.registerScanResumer('idrac-scan', async (entry) => {
    seen.push(entry.meta.ids.join(','));
    if (busy) return { outcome: 'busy', note: '다른 스캔 중' };
    busy = true;
    J.scanStarted('idrac-scan', 'cycle', { label: '재개', trigger: 'resume', resumeOf: entry, coversPending: false, meta: { ids: entry.meta.ids } });
    return { outcome: 'started', note: `남은 대역 ${entry.meta.ids.length}개` };
  });
  await J.processScanResumes({ at: Date.now() });
  st = J.scanJournalStatus();
  assert.equal(seen.length, 2);
  assert.equal(st.interrupted.length, 1, '재개한 항목만 대기 목록에서 빠진다');
  assert.equal(st.interrupted[0].tries, 1, '남은 항목은 5분 뒤 다시 본다(busy)');
  const resumed = st.recent.filter((h) => h.outcome === 'resumed');
  assert.equal(resumed.length, 1, "다른 대기 항목을 'resumed' 로 적지 않는다");
  assert.match(resumed[0].note, /남은 대역/, '재개 함수의 설명은 그 항목 이력에 붙는다');
  J.scanFinished('idrac-scan', 'cycle');
  J._resetForTest();
});

test('TIMING-04 같은 키 대기 항목은 최근 4개까지 — 넘친 것은 이력(superseded)으로', async () => {
  J._resetForTest();
  for (let i = 0; i < 6; i++) {
    J.scanStarted('idrac-scan', 'cycle', { label: `실행 ${i}`, coversPending: false, meta: { ids: [`r${i}`] } });
    J._reloadForTest();
    await sleep(2);
  }
  const st = J.scanJournalStatus();
  assert.equal(st.interrupted.length, J.PER_KEY_MAX);
  assert.deepEqual(st.interrupted.map((x) => x.label).sort(), ['실행 2', '실행 3', '실행 4', '실행 5']);
  assert.equal(st.recent.filter((h) => h.outcome === 'superseded').length, 2, '조용히 버리지 않는다');
  J._resetForTest();
});

/* ═══════════════ TIMING-03 — 분리 실행 du 는 기다리지 않는다 ═══════════════ */

test('TIMING-03 runningScans 의 resumable — 분리 실행 작업 id 가 있고 재개가 켜져 있으며 상한 전일 때만', () => {
  J._resetForTest();
  J.scanStarted('isidu', 't1', { label: '아이실론 조사' });
  assert.equal(J.runningScans()[0].resumable, false, '작업 id 를 받기 전(SSH 연결·시작 중)에는 끊기면 잃는다');
  J.scanProgress('isidu', 't1', { jobId: 'dvc-isidu-abc', jobHost: '10.0.0.1' });
  assert.equal(J.runningScans()[0].resumable, true);
  process.env.SCAN_RESUME = '0';
  try { assert.equal(J.runningScans()[0].resumable, false, '자동 재개가 꺼져 있으면 다음 기동이 이어 받지 않는다'); }
  finally { delete process.env.SCAN_RESUME; }
  J.scanFinished('isidu', 't1');
  J.scanStarted('isidu', 't2', { label: '재개 2번째', resumeOf: { kind: 'isidu', key: 't2', since: 1, resumes: 1 }, meta: { jobId: 'dvc-isidu-x' } });
  assert.equal(J.runningScans()[0].resumable, false, '재개 상한에 닿으면 끊긴 뒤 이어 받지 않는다');
  J._resetForTest();
});

test('TIMING-03 자동 적용은 분리 실행 du 만 돌 때 기다리지 않고, 그 사실을 기록에 남긴다', async () => {
  J._resetForTest();
  const m = mkManager();
  J.scanStarted('isidu', 't1', { label: '사용자 폴더', meta: { jobId: 'dvc-isidu-abc', jobHost: 'h' } });
  try {
    await m.tick();
    assert.equal(m.applied, 1, '재시작 뒤 같은 작업에 다시 붙으므로 기다리지 않는다');
    assert.equal(m.lastTick.outcome, 'applied');
    assert.match(m.lastTick.reason || '', /분리 실행 중인 스캔 1개\(사용자 폴더\)는 기다리지 않습니다/);
    const st = m.status();
    assert.equal(st.runningScans[0].resumable, true, '화면 응답에도 싣는다');
    assert.equal(m.deferral, null);
    // 세션에 묶인 스캔이 함께 돌면 그것은 기다린다
    const m2 = mkManager();
    J.scanStarted('ipscan', 'local', { label: 'IP 스캔' });
    await m2.tick();
    assert.equal(m2.applied, 0);
    assert.equal(m2.lastTick.outcome, 'deferred');
    assert.deepEqual(m2.deferral.scans.map((x) => x.kind), ['ipscan'], '분리 실행 du 는 기다리는 목록에 넣지 않는다');
    J.scanFinished('ipscan', 'local');
    await finish(m2);
    // 재개가 꺼져 있으면 분리 실행 du 도 기다린다(끊기면 결과를 잃는다)
    process.env.SCAN_RESUME = '0';
    const m3 = mkManager();
    await m3.tick();
    assert.equal(m3.applied, 0);
    assert.equal(m3.lastTick.outcome, 'deferred');
    delete process.env.SCAN_RESUME;
    await finish(m3);
  } finally { delete process.env.SCAN_RESUME; J._resetForTest(); }
});

/* ═══════════════ TIMING-01 ③ — 실행 중 VM 복제 잡을 기다린다 ═══════════════ */

test('TIMING-01③ 자동 적용은 실행 중 VM 복제 잡이 끝나기를 기다리고, 수동 적용 경고도 그것을 말한다', { timeout: 20_000 }, async () => {
  J._resetForTest();
  const store = await import('../src/vmclone/store.js');
  const runner = await import('../src/vmclone/runner.js');
  const { runningScanWarning } = await import('../../web/src/views/upgradeAutoText.js');
  const job = store.saveJob({ vcenterId: 'vc-demo', vmId: 'vc-demo:vm-1', vmName: 'web01', dest: { type: 'datastore', datastoreName: 'ds1' } });
  runner.enqueueRun(job.id, 'manual');
  await waitFor(() => runner.runnerStatus().running?.jobId === job.id, 5_000);
  const m = mkManager();
  await m.tick();
  assert.equal(m.applied, 0, '복제 중에는 적용하지 않는다(재시작이 원본 VM 에 임시 스냅샷을 남긴다)');
  assert.equal(m.lastTick.outcome, 'deferred');
  assert.match(m.lastTick.reason, /VM 복제 web01/);
  const st = m.status();
  assert.equal(st.runningClones.length, 1);
  assert.equal(st.runningClones[0].label, 'VM 복제 web01');
  const w = runningScanWarning(st);
  assert.match(w, /지금 VM 복제 1개가 돌고 있습니다/);
  assert.match(w, /portal-clone/);
  assert.ok(!w.includes('`'));
  // 복제가 끝나면 적용한다
  await waitFor(() => !runner.runnerStatus().running, 10_000);
  await m.tick();
  assert.equal(m.applied, 1);
  assert.equal(m.deferral, null);
  store.deleteJob(job.id);
});

/* ═══════════════ TIMING-07 — 번들 push 동시 개수 ═══════════════ */

test('TIMING-07 pushConcurrencyOf — 빈 값·숫자 아님 = 4 · 1 미만 = 1 · 상한 32', () => {
  assert.equal(push.pushConcurrencyOf(undefined), 4);
  assert.equal(push.pushConcurrencyOf(''), 4);
  assert.equal(push.pushConcurrencyOf('abc'), 4);
  assert.equal(push.pushConcurrencyOf('0'), 1);
  assert.equal(push.pushConcurrencyOf('2'), 2);
  assert.equal(push.pushConcurrencyOf('999'), 32);
  assert.equal(push.UPGRADE_PUSH_CONCURRENCY, 4);
});

function counter(delayMs = 300) {
  let open = 0; let maxOpen = 0; let n = 0;
  const handler = (q, r) => {
    n++; open++; maxOpen = Math.max(maxOpen, open);
    q.on('data', () => {});
    q.on('end', () => setTimeout(() => { open--; r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ ok: true, version: '9.9.9' })); }, delayMs));
  };
  return { handler, count: () => n, maxOpen: () => maxOpen };
}

test('TIMING-07 수집 서버 push 는 동시 4개까지(예전: 전부 한꺼번에) — 결과 순서·모양은 그대로', { timeout: 20_000 }, async () => {
  const c = counter();
  const urls = [];
  for (let i = 0; i < 8; i++) urls.push(await serve(c.handler));
  fs.writeFileSync(path.join(DIR, 'collectors.json'), JSON.stringify({ collectors: urls.map((u, i) => ({ id: `c${i}`, name: `c${i}`, url: u, token: 'T', enabled: true })) }));
  try {
    const res = await push.pushUpgradeToCollectors(Buffer.from('bundle'));
    assert.equal(res.length, 8);
    assert.deepEqual(res.map((r) => r.id), urls.map((_, i) => `c${i}`), '입력 순서 보존');
    assert.ok(res.every((r) => r.ok === true));
    assert.equal(c.count(), 8);
    assert.ok(c.maxOpen() <= 4, `동시 업로드 ${c.maxOpen()}개`);
    assert.ok(c.maxOpen() >= 2, '병렬은 유지한다');
    process.env.UPGRADE_PUSH_CONCURRENCY = '2';
    const c2 = counter(100);
    const urls2 = [];
    for (let i = 0; i < 5; i++) urls2.push(await serve(c2.handler));
    fs.writeFileSync(path.join(DIR, 'collectors.json'), JSON.stringify({ collectors: urls2.map((u, i) => ({ id: `d${i}`, name: `d${i}`, url: u, token: 'T', enabled: true })) }));
    await push.pushUpgradeToCollectors(Buffer.from('bundle'));
    assert.ok(c2.maxOpen() <= 2, `env 로 줄인다(${c2.maxOpen()})`);
  } finally {
    delete process.env.UPGRADE_PUSH_CONCURRENCY;
    fs.rmSync(path.join(DIR, 'collectors.json'), { force: true });
  }
});

test('TIMING-07 엣지 번들 push(pushToEdges)도 동시 4개까지 — 번들 파일을 못 읽은 엣지는 그 엣지만 실패', { timeout: 20_000 }, async () => {
  const c = counter();
  const edges = [];
  for (let i = 0; i < 7; i++) edges.push({ url: await serve(c.handler), token: 'E' });
  const archive = path.join(DIR, 'vmware-portal-9.9.9.tar.gz');
  fs.writeFileSync(archive, 'bundle-bytes');
  const m = mkManager();
  m.settings = { ...m.settings, edges };
  const res = await m.pushToEdges(archive);
  assert.equal(res.length, 7);
  assert.ok(res.every((r) => r.ok === true), JSON.stringify(res));
  assert.ok(c.maxOpen() <= 4, `동시 업로드 ${c.maxOpen()}개`);
  assert.ok(c.maxOpen() >= 2);
  const res2 = await m.pushToEdges(path.join(DIR, 'missing.tar.gz'));
  assert.equal(res2.length, 7, '예전에는 첫 예외가 전체를 거부했다');
  assert.ok(res2.every((r) => r.ok === false && /ENOENT|no such file/i.test(r.reason)));
});
