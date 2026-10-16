/**
 * test/audit2743i.test.js — v2.743 점검 GI 그룹(아이실론 대기 기록 쓰기 묶기 · 엣지가 버린 '지금 수집' 요청 알림) 회귀.
 *
 *  · TIMING-03  '지금 수집' 이 동시 실행 상한(기본 2)을 넘는 대상마다 scanQueued 로 실행 중 스캔 기록 파일 전체를 원자 쓰기(fsync 2회)로
 *               다시 썼다 — 대상 N 개면 쓰기 N 번 × 파일 크기 O(N)(O(N²)). 이제 runNow 가 모아 scanQueuedMany 로 **한 번** 쓴다.
 *               실제 runNow · 접속을 붙잡는 TCP 서버 · 파일 교체(rename) 횟수로 본다.
 *  · LEFT-08    엣지가 중앙이 보낸 '지금 수집' 요청을 시작하지 않고 버려도(대기 6시간 초과 등) 중앙은 사유를 모르고 결과 시한(최대 약 10시간)을
 *               기다린 뒤 일반 'no-result' 로 버렸다. 이제 엣지 push 상태에 runDropped[{id, reason, ageMs}] 를 싣고, 중앙 isidu-data 수신이
 *               그 요청을 사유와 함께 즉시 폐기한다(collectRequestQueue drops — source 'edge'). 구버전 엣지(필드 없음)는 예전처럼 시한.
 *               실제 poller(runNow·대기열 꺼내기) · 실제 push.pushIsiduNow · 실제 centralRouter 로 본다.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const BASE = '/tmp/claude-0/-home-user-The-DVC/6697d1b4-2c16-59c4-a364-a62c466221b4/scratchpad/audit2743/fix-GI';
fs.mkdirSync(BASE, { recursive: true });
const DIR = fs.mkdtempSync(path.join(fs.existsSync(BASE) ? BASE : path.join(process.cwd(), '..', '..'), 'cfg-2743i-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.SSH_HOSTKEY_POLICY = 'observe';
process.env.SSH_READY_TIMEOUT_MS = '5000';
process.env.ISIDU_SSH_KEY = '';
process.env.CENTRAL_TOKEN = 'ctok-2743i';
delete process.env.ISIDU_CONCURRENCY; // 기본 2
delete process.env.SCAN_RESUME;
delete process.env.CENTRAL_URL;

const ROOT = '/ifs/data/workspace/users';
const HOUR = 3_600_000;
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const J = await import('../src/util/scanJournal.js');
const S = await import('../src/isidu/settings.js');
const P = await import('../src/isidu/poller.js');
const CR = await import('../src/isidu/collectRequests.js');
const { createCollectRequestQueue } = await import('../src/util/collectRequestQueue.js');
const reg = await import('../src/storage/registry.js');
const { pickAgent, pickDatacenter } = await import('../src/cvp/formChoices.js');
const { config } = await import('../src/config.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 벽시계가 아니라 performance.now 로 잰다(아래 한 테스트가 Date.now 를 앞으로 돌린다).
const waitFor = async (fn, ms = 20_000, step = 20) => {
  const until = performance.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (performance.now() > until) throw new Error('시간 초과'); await sleep(step); }
};
const journalFile = () => { try { return JSON.parse(fs.readFileSync(path.join(DIR, 'scan-journal.json'), 'utf8')); } catch { return null; } };

/* 장비 접속 흉내 — hold 동안은 끊지 않는다(release 로 한꺼번에 끊는다). 끊으면 조사가 곧바로 실패로 끝난다. */
let hold = false; const socks = new Set();
let port = 0;
function release() { hold = false; for (const s of socks) { try { s.destroy(); } catch { /* */ } } }

/* 실행 중 스캔 기록 파일의 교체(rename) 횟수 — atomicWriteFileSync 가 tmp → rename 으로 쓴다. */
let journalWrites = 0;
const realRename = fs.renameSync;
fs.renameSync = function renameSpy(from, to, ...rest) {
  if (String(to).endsWith(`${path.sep}scan-journal.json`)) journalWrites++;
  return realRename.call(this, from, to, ...rest);
};
closers.push(() => { fs.renameSync = realRename; });

const N = 100; // isidu/settings.js MAX_TARGETS
const IDS = Array.from({ length: N }, (_, i) => `t${String(i).padStart(3, '0')}`);

before(async () => {
  const srv = net.createServer((sock) => {
    socks.add(sock);
    sock.on('error', () => {});
    sock.on('close', () => { socks.delete(sock); });
    if (!hold) setTimeout(() => sock.destroy(), 30);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  port = srv.address().port;
  closers.push(() => new Promise((r) => { release(); srv.close(() => r()); }));
  assert.equal(S.MAX_TARGETS, N, '대상 상한이 바뀌었으면 이 테스트의 N 을 맞출 것');
  // enabled:false — 주기 틱이 스스로 시작하지 않는다(사람이 누른 것만 돈다)
  const local = (id) => ({ id, label: `대상 ${id}`, host: '127.0.0.1', port, path: ROOT, auth: 'key', username: 'admin', intervalHours: 24, enabled: false });
  const r = S.saveSettings({ targets: IDS.map(local) }, { devices: reg.listDevices(), agents: [], dcs: [], pickAgent, pickDatacenter, ssrfBlockReason: () => null });
  assert.equal(r.ok, true, r.error);
});

/** 진행 중인 조사(붙잡힌 접속)를 끝내고 대기열·기록을 비운다 — 다음 테스트가 깨끗하게 시작하게. */
async function settle() {
  P._resetForTest();      // 대기열·대기 기록을 비운다(남은 대상이 줄줄이 접속하지 않게)
  release();
  await waitFor(() => J.runningScans().length === 0);
  await sleep(50);
  J._resetForTest(); P._resetForTest();
}

/* ═══════════════ TIMING-03 ① scanQueuedMany — 쓰기 한 번 · 기록 모양은 scanQueued 와 같다 ═══════════════ */

test('TIMING-03 scanQueuedMany 는 대기 요청 여러 건을 쓰기 한 번으로 남기고, 기록 모양은 scanQueued 와 같다', () => {
  J._resetForTest();
  const since = Date.now() - 60_000;
  const recs = ['a1', 'a2', 'a3'].map((key) => ({ key, label: `대상 ${key}`, trigger: 'central', since, holdMs: P.QUEUE_HOLD_MS, meta: { manual: true } }));
  const w0 = journalWrites;
  assert.equal(J.scanQueuedMany('isidu', [...recs, null, { key: '' }, 'x']), 3, '형식이 틀린 항목은 빼고 센다');
  assert.equal(journalWrites - w0, 1, `쓰기 1회(실제 ${journalWrites - w0})`);
  const many = journalFile().queued;
  J._resetForTest();
  for (const r of recs) J.scanQueued('isidu', r.key, r);
  const one = journalFile().queued;
  assert.deepEqual(many, one, '한 번에 쓴 기록과 하나씩 쓴 기록이 같다');
  assert.equal(J.scanQueuedMany('isidu', []), 0);
  assert.equal(J.scanQueuedMany('BAD KIND', recs), 0, '종류 이름 규칙은 scanQueued 와 같다');
  J._resetForTest();
});

/* ═══════════════ TIMING-03 ② 실제 runNow — 대상 100개, 대기 기록은 쓰기 1회 ═══════════════ */

test("TIMING-03 '지금 수집' 대상 100개 — 대기열에 넣는 98개의 기록은 파일 쓰기 1회로 남는다(대상마다 다시 쓰지 않는다)", async () => {
  J._resetForTest(); P._resetForTest();
  hold = true;
  const w0 = journalWrites;
  const res = await P.runNow(IDS, { trigger: 'manual' });
  const writes = journalWrites - w0;
  try {
    assert.equal(res.started.length, 2, JSON.stringify(res.started));
    assert.equal(res.queued.length, N - 2);
    // 시작한 2개는 scanStarted 가 각각 쓴다(곧바로 재시작이 와도 남게) — 대기 98개는 한 번에.
    assert.equal(writes, res.started.length + 1, `기록 파일 쓰기 ${writes}회 — 수정 전에는 ${res.started.length + res.queued.length}회(대상마다 전체를 다시 썼다)`);
    const doc = journalFile();
    assert.deepEqual((doc.queued || []).map((x) => x.key).sort(), [...res.queued].sort(), '대기 요청 98개가 모두 파일에 남는다(재시작에도 남게)');
    assert.ok(doc.queued.every((q) => q.until - q.since === P.QUEUE_HOLD_MS && q.trigger === 'manual'));
    assert.equal(J.journalFor('isidu').queued.length, N - 2);
  } finally { await settle(); }
});

/* ═══════════════ LEFT-08 ① 큐 — 엣지가 버린 요청을 사유와 함께 폐기(그 엣지·버린 뒤 다시 받은 것은 아님) ═══════════════ */

test('LEFT-08 collectRequestQueue.dropTaken — 그 엣지가 가져간 요청만 사유와 함께 폐기하고, 버린 뒤 다시 인출한 요청·대기 요청은 건드리지 않는다', () => {
  const Q = createCollectRequestQueue({ ttlMs: 30 * 60_000, ackMs: 10 * 60_000, perItemMs: 121 * 60_000 });
  const t0 = 1_800_000_000_000;
  Q.request('x1', 'Edge-A', t0); Q.request('x2', 'edge-a', t0); Q.request('x3', 'edge-b', t0); Q.request('x4', 'edge-a', t0);
  assert.deepEqual(Q.take('edge-a', t0 + 1_000, 2), ['x1', 'x2']);
  assert.equal(Q.dropTaken('x1', 'edge-b', 'queue-hold', {}, t0 + 2_000), false, '남의 엣지 요청은 건드리지 않는다');
  assert.equal(Q.dropTaken('x4', 'edge-a', 'queue-hold', {}, t0 + 2_000), false, '아직 가져가지 않은(대기) 요청은 엣지가 버릴 수 없다');
  assert.equal(Q.dropTaken('x2', 'edge-a', 'queue-hold', { before: t0 + 500 }, t0 + 2_000), false, '버린 시각보다 뒤에 인출한 요청(다시 받은 것)은 건드리지 않는다');
  assert.equal(Q.dropTaken('x1', 'EDGE-A', 'queue-hold', { before: t0 + 1_500 }, t0 + 2_000), true);
  assert.equal(Q.state('x1', t0 + 2_000), null, '진행 중 표시가 꺼진다(결과 시한 약 10시간을 기다리지 않는다)');
  assert.equal(Q.state('x2', t0 + 2_000).state, 'taken');
  const d = Q.drops(t0 + 2_000);
  assert.equal(d.length, 1);
  assert.deepEqual({ id: d[0].id, agent: d[0].agent, reason: d[0].reason, source: d[0].source, tries: d[0].tries }, { id: 'x1', agent: 'edge-a', reason: 'queue-hold', source: 'edge', tries: 1 });
  // 이 메서드를 부르지 않는 큐(스토리지·SAN·PDU·CVP)의 폐기는 예전 그대로다(source 없음).
  const Q2 = createCollectRequestQueue({ ttlMs: 1_000, ackMs: 1_000 });
  Q2.request('s1', 'e', t0);
  assert.deepEqual(Q2.drops(t0 + 5_000), [{ id: 's1', agent: 'e', at: t0 + 5_000, tries: 0, reason: 'untaken' }]);
});

test('LEFT-08 applyIsiduEdgeDrops — 필드가 없으면 null(구버전 엣지) · 지금 돌리는·기다리는 대상(runHeld)·나중에 다시 받은 요청은 건드리지 않는다 · 모르는 사유는 edge-other', () => {
  CR._resetForTest();
  for (const id of ['g1', 'g2', 'g3', 'g4']) CR.requestIsiduCollect(id, 'edge-a');
  assert.deepEqual(CR.takeIsiduRequests('edge-a').sort(), ['g1', 'g2', 'g3', 'g4']);
  const now = Date.now();
  assert.equal(CR.applyIsiduEdgeDrops('edge-a', { poller: {} }), null, '구버전 엣지 — 예전처럼 결과 시한으로 정리한다');
  assert.equal(CR.applyIsiduEdgeDrops('edge-a', null), null);
  const r = CR.applyIsiduEdgeDrops('edge-a', {
    runDropped: [
      { id: 'g1', reason: 'queue-hold', ageMs: 0 },
      { id: 'g2', reason: 'not-here', ageMs: 0 },        // 지금 다시 기다리는 중 → 건드리지 않는다
      { id: 'g3', reason: 'queue-hold', ageMs: 3_600_000 }, // 한 시간 전에 버렸다 — 그 뒤(지금)에 가져간 요청이다
      { id: 'g4', reason: 'hack<script>', ageMs: 0 },
      null, { id: 7 }, 'g9',
    ],
    runHeld: ['g2'],
  }, now);
  assert.equal(r.applied, 2, JSON.stringify(r));
  assert.equal(CR.isiduRequestState('g1'), null);
  assert.equal(CR.isiduRequestState('g2').state, 'taken', 'runHeld — 엣지가 버린 뒤 다시 받아 기다리는 중');
  assert.equal(CR.isiduRequestState('g3').state, 'taken', '버린 뒤에 다시 인출한 요청');
  const drops = CR.recentIsiduDrops();
  assert.deepEqual(drops.map((d) => [d.id, d.reason, d.source]).sort(), [['g1', 'queue-hold', 'edge'], ['g4', 'edge-other', 'edge']]);
  assert.equal(CR.applyIsiduEdgeDrops('edge-b', { runDropped: [{ id: 'g3', reason: 'queue-hold', ageMs: 0 }] }).applied, 0, '남의 엣지 이름으로는 지우지 못한다');
  CR._resetForTest();
});

/* ═══════════════ LEFT-08 ② 엣지 — 버린 중앙 요청만 기록한다(대기 6시간 초과 · 사본에 없음 · 재시작 뒤 다시 넣지 않음) ═══════════════ */

test("LEFT-08 엣지 poller — 중앙 요청을 실은 대기가 6시간을 넘어 버려지면 'queue-hold' 로 기록한다 · 엣지에서 사람이 누른 대기는 기록하지 않는다 · 합쳐진 중앙 요청은 기록한다", async () => {
  J._resetForTest(); P._resetForTest();
  hold = true;
  const realNow = Date.now;
  try {
    const a = await P.runNow(['t000', 't001', 't002', 't003'], { trigger: 'manual' }); // 사람이 누른 것(엣지 화면)
    assert.deepEqual(a.started, ['t000', 't001']);
    assert.deepEqual(a.queued, ['t002', 't003']);
    const b = await P.runNow(['t002', 't004'], { trigger: 'central' });                 // 중앙 요청 — t002 는 이미 기다리던 대기에 합쳐진다
    assert.deepEqual(b.queued.sort(), ['t002', 't004']);
    assert.deepEqual(P.runDropsForPush().list, [], '아직 버린 것이 없다');
    // 7시간이 지났다 — 앞 조사가 끝나 대기열을 꺼낼 때 6시간 넘은 대기는 시작하지 않고 버린다.
    const skew = 7 * HOUR;
    Date.now = () => realNow() + skew;
    release();
    await waitFor(() => P.isiduPollerStatus().queued.length === 0);
    const rd = P.runDropsForPush();
    assert.deepEqual(rd.list.map((d) => [d.id, d.reason]).sort(), [['t002', 'queue-hold'], ['t004', 'queue-hold']], JSON.stringify(rd.list));
    assert.ok(rd.list.every((d) => d.ageMs >= 0 && d.ageMs < 60_000), 'ageMs 는 버린 뒤 지난 시간(엣지 시계의 길이)');
    assert.ok(!rd.list.some((d) => d.id === 't003'), '엣지에서 사람이 누른 대기는 중앙 요청이 아니다');
    P.ackRunDrops(rd.seq);
    assert.deepEqual(P.runDropsForPush().list, [], '중앙이 받은 뒤에는 지운다');
  } finally {
    Date.now = realNow;
    await settle();
  }
});

test("LEFT-08 엣지 poller — 중앙 요청 대상이 엣지 사본에 없으면 'not-here' · 재시작 전 대기가 시한을 넘겨 다시 넣지 않았으면 'queue-hold' 로 알린다", async () => {
  J._resetForTest(); P._resetForTest();
  const r = await P.runNow(['no-such'], { trigger: 'central' });
  assert.deepEqual(r.notHere, ['no-such']);
  assert.deepEqual(P.runDropsForPush().list.map((d) => [d.id, d.reason]), [['no-such', 'not-here']]);
  P._resetForTest();
  await P.runNow(['no-such'], { trigger: 'manual' });
  assert.deepEqual(P.runDropsForPush().list, [], '엣지 화면의 지금 수집은 중앙 요청이 아니다');
  // 재시작: 중앙이 보낸 대기 요청(시한 지남)과 사람이 누른 대기 요청 — 다음 기동이 다시 넣지 않은 것 중 중앙 요청만 알린다.
  const now = Date.now();
  J.scanQueued('isidu', 'b1', { label: '대상 b1', trigger: 'central', since: now - 7 * HOUR, holdMs: 6 * HOUR });
  J.scanQueued('isidu', 'b2', { label: '대상 b2', trigger: 'manual', since: now - 7 * HOUR, holdMs: 6 * HOUR });
  J._reloadForTest();
  const P2 = await import('../src/isidu/poller.js?boot=2743i');
  assert.deepEqual(P2.runDropsForPush().list.map((d) => [d.id, d.reason]), [['b1', 'queue-hold']]);
  assert.deepEqual(J.takeQueuedBootDrops('isidu'), [], '기동 때 한 번만 넘긴다');
  J._resetForTest(); P._resetForTest();
});

/* ═══════════════ LEFT-08 ③ 끝에서 끝 — 엣지 push(실제 호출) → 중앙 isidu-data(실제 centralRouter) → 큐 폐기 ═══════════════ */

let centralPort = 0;
before(async () => {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use('/api/central', centralRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  centralPort = srv.address().port;
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }));
});
const cpost = (url, body, agent = 'edge-a') => fetch(`http://127.0.0.1:${centralPort}/api/central${url}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': 'ctok-2743i', 'X-Agent-Name': agent }, body: JSON.stringify(body),
});

test("LEFT-08 끝에서 끝 — 엣지가 중앙 요청을 시작하지 못하면 다음 push 로 알리고, 중앙은 결과 시한을 기다리지 않고 사유와 함께 폐기한다 · 구버전 엣지(필드 없음)는 예전처럼 기다린다", async () => {
  const push = await import('../src/isidu/push.js');
  CR._resetForTest(); J._resetForTest(); P._resetForTest(); push._resetForTest();
  // 중앙: 엣지 edge-a 몫 요청 둘을 엣지가 설정 pull 로 가져갔다(진행 중).
  CR.requestIsiduCollect('isi-e1', 'edge-a');
  CR.requestIsiduCollect('isi-e2', 'edge-a');
  assert.deepEqual(CR.takeIsiduRequests('edge-a').sort(), ['isi-e1', 'isi-e2']);
  // 구버전 엣지의 상태 보고(필드 없음) — 아무것도 정리하지 않는다.
  const old = await cpost('/isidu-data?agent=edge-a', { agent: 'edge-a', status: { poller: { running: [] } } });
  assert.equal(old.status, 200);
  assert.equal((await old.json()).runDrops, undefined);
  assert.equal(CR.isiduRequestState('isi-e1').state, 'taken', '구버전 엣지 — 예전처럼 결과 시한까지 진행 중');
  const keep = { ...config.agent };
  const quiet = console.log; console.log = () => {};
  try {
    config.agent.centralUrl = `http://127.0.0.1:${centralPort}`;
    config.agent.centralToken = 'ctok-2743i';
    config.agent.name = 'edge-a';
    // 엣지: 받은 요청을 실행하려 했지만 이 엣지 사본에는 isi-e1 이 없다(대상 사본이 비어 있다).
    const run = await P.runNow(['isi-e1'], { trigger: 'central' });
    assert.deepEqual(run.notHere, ['isi-e1']);
    const r = await push.pushIsiduNow();
    assert.equal(r.ok, true, r.reason);
    assert.equal(push.isiduPushStatus().runDropped, 1, '버린 요청을 몇 건 알렸는지 상태에 남긴다');
    assert.deepEqual(P.runDropsForPush().list, [], '중앙이 받았으니 엣지 기록을 지운다');
  } finally { console.log = quiet; Object.assign(config.agent, keep); }
  assert.equal(CR.isiduRequestState('isi-e1'), null, '결과 시한(약 10시간)을 기다리지 않고 정리했다');
  assert.equal(CR.isiduRequestState('isi-e2').state, 'taken', '알려 오지 않은 요청은 그대로 결과를 기다린다');
  const d = CR.recentIsiduDrops().find((x) => x.id === 'isi-e1');
  assert.ok(d, '폐기 목록에 남는다(조용히 지우지 않는다)');
  assert.equal(d.reason, 'not-here');
  assert.equal(d.source, 'edge');
  assert.equal(d.agent, 'edge-a');
  // 화면 문구 — 엣지가 버렸다고 알려 온 사유와 조치를 말한다.
  const { collectDropNote } = await import('../../web/src/views/tools/collectDropText.js');
  const note = collectDropNote(CR.recentIsiduDrops(), (id) => id);
  assert.match(note, /시작하지 않고 버렸다고 알려 왔습니다/);
  assert.match(note, /대상 사본에 그 대상이 없음 1건/);
  assert.ok(!note.includes('`'));
  CR._resetForTest(); J._resetForTest(); P._resetForTest(); push._resetForTest();
});

/* ═══════════════ LEFT-08 ④ 사유 코드 — 엣지가 내는 코드 = 중앙이 받는 코드 = 화면 문구 키(1:1) ═══════════════ */

test('LEFT-08 사유 코드 — 엣지가 내는 코드는 전부 중앙 EDGE_DROP_REASONS 에 있고, 그 목록은 웹 EDGE_DROP_TEXT 키와 1:1 이다', async () => {
  const { EDGE_DROP_TEXT, collectDropNote } = await import('../../web/src/views/tools/collectDropText.js');
  assert.deepEqual(Object.keys(EDGE_DROP_TEXT).sort(), [...CR.EDGE_DROP_REASONS].sort());
  const { stripComments } = await import('./_stripComments.js');
  const src = (f) => stripComments(fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'));
  const emitted = new Set();
  for (const m of src('isidu/poller.js').matchAll(/noteRunDrop\([^)]*?,\s*'([a-z-]+)'/g)) emitted.add(m[1]);
  for (const m of src('util/scanJournal.js').matchAll(/_queuedBootDrops\.push\(\{[^}]*reason:\s*'([a-z-]+)'/g)) emitted.add(m[1]);
  assert.ok(emitted.size >= 4, `엣지가 내는 코드를 찾았다: ${[...emitted]}`);
  for (const c of emitted) assert.ok(CR.EDGE_DROP_REASONS.includes(c), `엣지 코드 ${c} 가 중앙 목록에 없다`);
  // 문구: 사유마다 이름·조치가 있고 백틱이 없다 · 엣지 폐기가 없으면 예전 문장 그대로다.
  const NOW = 1_800_000_000_000;
  for (const [code, t] of Object.entries(EDGE_DROP_TEXT)) {
    assert.ok(t.label && t.fix, code);
    const s = collectDropNote([{ id: 'a', agent: 'e1', at: NOW, tries: 1, reason: code, source: 'edge' }], undefined, NOW);
    assert.ok(s.includes(t.label) && s.includes(t.fix) && !s.includes('`'), s);
    assert.ok(!s.includes('한 번 더 요청한 뒤 버렸습니다'), '엣지가 버린 것을 결과 없음(수집 오류)으로 말하지 않는다');
  }
  const mixed = collectDropNote([
    { id: 'a', agent: 'e1', at: NOW, tries: 1, reason: 'queue-hold', source: 'edge' },
    { id: 'b', agent: 'e1', at: NOW, tries: 0, reason: 'untaken' },
  ], undefined, NOW);
  assert.match(mixed, /가져가지 않은 채/);
  assert.match(mixed, /그중 1건은 엣지가 요청을 받았지만 시작하지 않고 버렸다고/);
  const legacy = collectDropNote([{ id: 'b', agent: 'e1', at: NOW, tries: 2, reason: 'no-result' }], undefined, NOW);
  assert.ok(!legacy.includes('시작하지 않고 버렸다'), '엣지 폐기가 없으면 예전 문장');
});
