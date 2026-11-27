// v3.54(설계 과제 반증 12a · 12b · 12c 반영) — 별도 프로세스. 픽스처는 합성(SYNTH · 127.0.0.1 가짜 iDRAC · 가짜 웹훅 · example.test).
//   12a F1 상한 1 이면 이벤트는 공용 자리를 빌리지 않음 · F2 서버를 다 읽으면 그 서버만 먼저 풀림 · F3 시험 초기화 세대 · F4 바로 읽기 상한은 대기 + 도는 묶음 합계
//   12b #1 큐 상태가 화면 응답에 · #3 무게 ≥ 1 · #4 그 판정이 연 행에만 발송 표시 · #5 꺼지면 안 보냄 · #6 대기 수는 상한까지 · 관찰: 채널 실패는 실패로 · 늦은 알림은 판정 시각 · 넘침은 뒤 알림으로 대신 먼저
//   12c D5 던진 판정 · 꺼짐 건너뜀도 판정 몫을 적음
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmdesign352b-'));
const rmTmp = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } };
after(() => { rmTmp(); process.once('exit', rmTmp); });
const express = (await import('express')).default;
let whStatus = 500; const whHits = [];
const wh = express(); wh.use(express.json({ limit: '1mb' }));
wh.post('/hook', (req, res) => { whHits.push(req.body); res.status(whStatus).json({ ok: whStatus < 300 }); });
const wsrv = await new Promise((r) => { const s = wh.listen(0, '127.0.0.1', () => r(s)); });
after(() => { wsrv.closeAllConnections?.(); wsrv.close(); });
fs.writeFileSync(path.join(tmp, 'alerts.json'), JSON.stringify({ channels: { webhook: { enabled: true, url: `http://127.0.0.1:${wsrv.address().port}/hook` } }, suppressWindowMin: 0 }));
Object.assign(process.env, { CONFIG_DIR: tmp, DB_DIR: tmp, DATA_SOURCE: 'live', SSRF_ALLOW_LOOPBACK: 'true', AUTH_ENABLED: 'false', PARTFAULT_ENABLED: 'true', PARTFAULT_DB_PATH: path.join(tmp, 'part-faults.db') });
delete process.env.CENTRAL_URL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fakeBmc(t, delayOf) {
  const st = { log: [] };
  const app = express();
  app.use('/bmc/:box', async (req, res) => { st.log.push([req.params.box, Date.now()]); await sleep(delayOf(req.params.box)); res.status(404).end(); });
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { srv.closeAllConnections?.(); srv.close(); });
  st.base = `http://127.0.0.1:${srv.address().port}/bmc`;
  return st;
}

test('12a F1 — 상한 1 · 이벤트 묶음 둘이 함께 돌아도 이벤트는 공용 자리를 빌리지 않는다(다음 정규 주기가 바로 시작)', async (t) => {
  const { config } = await import('../src/config.js');
  const keep = config.idrac.pollConcurrency; config.idrac.pollConcurrency = 1;
  t.after(() => { config.idrac.pollConcurrency = keep; });
  const st = await fakeBmc(t, (b) => (b.startsWith('e') ? 150 : 5));
  const registry = await import('../src/idrac/registry.js');
  registry.importServers(['c1', 'c2', 'e1', 'e2'].map((b) => ({ id: `f1-${b}`, name: `synth-f1${b}`, host: `${st.base}/${b}`, username: 'u', password: 'p', serviceTag: `SYNTHF1${b}` })), 'replace');
  const P = await import('../src/idrac/poller.js');
  const evs = [P.pollNowForEvent(['f1-e1']), P.pollNowForEvent(['f1-e2'])];
  await sleep(30);
  assert.deepEqual(P._slotStateForTest(), { n: 0, ev: 0, ded: 1, q: 0, qe: 1 }, '둘째 이벤트 읽기는 전용 자리를 기다린다(공용 자리를 쥐지 않음)');
  const t0 = Date.now();
  const cyc = P.pollNowManual();
  for (let i = 0; i < 400 && !st.log.some(([b, at]) => b.startsWith('c') && at >= t0); i += 1) await sleep(5);
  const firstC = st.log.find(([b, at]) => b.startsWith('c') && at >= t0);
  assert.ok(firstC && firstC[1] - t0 < 500, `정규 주기의 첫 요청 ${firstC ? firstC[1] - t0 : '없음'}ms(이벤트 읽기는 요청당 150ms — 기다렸으면 1초 넘게)`);
  await Promise.all([cyc, ...evs]);
  assert.deepEqual(P._slotStateForTest(), { n: 0, ev: 0, ded: 0, q: 0, qe: 0 });
});

test('12a F2 · F4 — 서버를 다 읽으면 그 서버만 먼저 풀려 새 이벤트가 같은 묶음의 느린 서버를 기다리지 않음 · 바로 읽기 상한은 대기 + 도는 묶음 합계', async (t) => {
  const E = await import('../src/idrac/eventSub.js');
  E._resetEventsForTest();
  const runs = []; let releaseSlow = null; const slowGate = new Promise((r) => { releaseSlow = r; });
  E._setEventDepsForTest({
    debounceMs: 30,
    runCheck: async (reason, ids, { onServerDone } = {}) => {
      runs.push([...ids].sort());
      for (const id of ids) if (id !== 'f2-slow') { await sleep(5); onServerDone?.(id); }   // 빠른 서버는 다 읽음
      if (ids.includes('f2-slow')) await slowGate;
      return { busy: false, retry: [] };
    },
  });
  const s = { enabled: true, base: 'https://portal.example.test', secret: 'E'.repeat(43), ctxKey: 'F'.repeat(43) };
  const send = (id) => E.acceptEvents(s, { context: E.contextOf(s, id), events: [{ sev: 'critical' }] });
  t.after(() => { releaseSlow?.(); E._setEventDepsForTest(null); E._resetEventsForTest(); });
  send('f2-slow'); send('f2-x');
  for (let i = 0; i < 100 && !runs.length; i += 1) await sleep(5);
  assert.deepEqual(runs[0], ['f2-slow', 'f2-x']);
  await sleep(20);
  send('f2-x');   // 첫 읽기가 끝난 x 에 새 이벤트 — 느린 서버가 끝나기 전에 다시 읽힌다
  for (let i = 0; i < 100 && runs.length < 2; i += 1) await sleep(5);
  assert.deepEqual(runs[1], ['f2-x'], '같은 묶음의 느린 서버를 기다리지 않는다(F2)');
  // F4 — 도는 묶음이 맡은 서버도 상한에 센다(EVT_BATCH_MAX). 느린 묶음이 1대를 쥔 채 상한까지 채우면 그 다음은 미룬다
  await sleep(40);   // 둘째 묶음(x)이 끝나 x 가 풀린 뒤 — 도는 묶음은 느린 서버 1대만 쥔다
  const d0 = E.eventStatus().deferred;
  for (let i = 0; i < E.EVT_BATCH_MAX; i += 1) send(`f4-${i}`);
  assert.equal(E.eventStatus().deferred - d0, 1, '대기 + 도는 묶음 합계가 상한 — 마지막 1대는 정규 주기로 미룬다(F4)');
  releaseSlow(); releaseSlow = null;
});

test('12a F3 — 묶음 도중 시험 초기화를 해도 카운트가 음수가 되지 않는다(세대)', async () => {
  const E = await import('../src/idrac/eventSub.js');
  E._resetEventsForTest();
  let rel = null;
  E._setEventDepsForTest({ debounceMs: 10, runCheck: async () => { await new Promise((r) => { rel = r; }); return { busy: false, retry: [] }; } });
  const s = { enabled: true, base: 'https://portal.example.test', secret: 'E'.repeat(43), ctxKey: 'F'.repeat(43) };
  E.acceptEvents(s, { context: E.contextOf(s, 'f3-a'), events: [{ sev: 'critical' }] });
  for (let i = 0; i < 100 && !rel; i += 1) await sleep(5);
  E._resetEventsForTest();
  rel(); await sleep(20);
  assert.equal(E.eventStatus().inflight, 0);
  E._setEventDepsForTest(null); E._resetEventsForTest();
});

const alertsOf = (n, pre, closed = false) => ({ opened: closed ? [] : Array.from({ length: n }, (_, k) => ({ agent: '', partKey: `${pre}-${k}`, state: 'fault', scope: 'idrac', kind: 'psu', label: `PSU ${k}`, firstSeenAt: 1000 + k })), updated: [], closed: closed ? Array.from({ length: n }, (_, k) => ({ agent: '', partKey: `${pre}-${k}`, state: 'fault', scope: 'idrac', kind: 'psu', label: `PSU ${k}`, closeReason: 'ok' })) : [] });

test('12b — 넘치면 같은 부품의 뒤 알림이 있는 앞 알림부터 대신(마지막 상태 유지) · 무게 ≥ 1 · 대기 수는 상한까지 · 꺼지면 안 보냄 · 늦은 알림은 판정 시각', async () => {
  const PF = await import('../src/partfault/poller.js');
  PF._resetNotifyForTest();
  let release = null; let gate = new Promise((r) => { release = r; }); const sent = []; let now = 1_000_000; let enabled = true;
  PF._setNotifyDepsForTest({
    sendAlerts: async (alerts, { note } = {}) => { sent.push({ keys: alerts.map((a) => `${a.closed ? 'C' : 'O'}:${a.partKey}`), note }); await gate; return { sent: alerts.length, skipped: 0, failed: 0, results: [] }; },
    markNotified: async () => {}, enabled: () => ({ enabled, source: 'saved' }), now: () => now,
  });
  const warns = []; const ow = console.warn; console.warn = (...a) => { warns.push(a.map(String).join(' ')); };
  try {
    // #6 — 500건 판정: 대기 수는 200(상한까지) · 상한 밖 300 은 대기 중에도 밝힌다
    const v0 = PF._enqueueNotifyForTest(alertsOf(500, 'big'), 'big');
    assert.deepEqual([v0.queued, v0.capped, v0.total], [200, 300, 500]);
    // 같은 부품 200 이 열림 · 해소를 번갈아(채널 막힘) — 넘치면 앞 알림을 뒤 알림으로 대신한다(마지막 상태가 남는다)
    const vs = [];
    for (let j = 0; j < 12; j += 1) vs.push(PF._enqueueNotifyForTest(alertsOf(200, 'flip', j % 2 === 1), `flip-${j}`));
    let q = PF._notifyQueueStatusForTest();
    assert.ok(q.superseded > 0 && q.overflowDropped === 0, `대신함 ${q.superseded} · 뺌 ${q.overflowDropped}`);
    assert.ok(q.waitingItems <= PF.NOTIFY_QUEUE_MAX_ITEMS);
    assert.equal(vs.at(-1).pending, true, '마지막 판정(해소)은 남는다');
    assert.ok(warns.some((w) => /뒤 알림이 있는 앞 알림/.test(w)));
    // #3 — 보낼 것이 없는 판정(키 이전만)도 1 로 센다 — 수천 개여도 상한이 지켜진다
    const mig = { opened: [{ agent: '', partKey: 'mig-1', migratedFrom: 'old', prevState: 'fault', state: 'fault', scope: 'idrac', kind: 'psu' }], updated: [], closed: [] };
    for (let j = 0; j < 2_500; j += 1) PF._enqueueNotifyForTest(mig, 'mig');
    q = PF._notifyQueueStatusForTest();
    assert.ok(q.waiting <= PF.NOTIFY_QUEUE_MAX_ITEMS, `대기 판정 ${q.waiting}개 ≤ 상한(무게 0 이면 끝없이 쌓였다)`);
    // #5 · 지연 — 2분 뒤 채널이 풀림 · 그 사이 점검을 끔 → 남은 대기는 보내지 않는다
    now += 120_000; enabled = false;
    release(); release = null;
    await PF._notifyIdleForTest();
    assert.equal(sent.length, 1, '보내던 것 하나만 — 꺼진 뒤의 대기는 보내지 않는다(#5)');
    q = PF._notifyQueueStatusForTest();
    assert.ok(q.disabledSkipped > 0);
    assert.equal(vs.at(-1).disabledSkipped, 200);
    // 지연 표기 — 켠 채 대기가 1분을 넘으면 본문 끝에 판정 시각
    enabled = true; gate = Promise.resolve();
    PF._enqueueNotifyForTest(alertsOf(1, 'late'), 'late');
    await PF._notifyIdleForTest();
    assert.equal(sent.at(-1).note, '', '바로 보내면 덧붙이지 않는다');
    let rel2 = null; gate = new Promise((r) => { rel2 = r; });
    PF._enqueueNotifyForTest(alertsOf(1, 'late2'), 'late2');
    const v2 = PF._enqueueNotifyForTest(alertsOf(1, 'late3'), 'late3');
    now += 180_000; rel2();
    await PF._notifyIdleForTest();
    assert.match(sent.at(-1).note, /^판정 시각 .*알림 채널이 늦어 약 3분 뒤에 보냅니다/);
    assert.equal(v2.delayedMs, 180_000);
  } finally { console.warn = ow; PF._resetNotifyForTest(); release?.(); await PF._notifyIdleForTest(); PF._setNotifyDepsForTest(null); }   // 실패해도 남은 대기를 실제 채널로 흘려보내지 않는다(먼저 비운다)
});

test('12b 관찰 · #4 — 채널 오류는 발송이 아니라 실패로 · 발송 표시는 받은 열림만 · 그 판정이 연 행에만(처음 감지 시각)', async () => {
  const N = await import('../src/partfault/notify.js');
  whStatus = 500;
  const r = await N.notifyTransition(alertsOf(1, 'wh'));
  assert.deepEqual([r.sent, r.failed, r.skipped], [0, 1, 0], `웹훅 500 은 실패(${r.results[0]?.result})`);
  whStatus = 200;
  const r2 = await N.notifyTransition(alertsOf(1, 'wh2'));
  assert.deepEqual([r2.sent, r2.failed], [1, 0]);
  const DB = await import('../src/partfault/db.js');
  const p = { agent: '', partKey: 'ns-1', scope: 'idrac', deviceId: 'SYNTH91', kind: 'psu', partId: 'p', state: 'fault', firstSeenAt: 5_000, lastSeenAt: 5_000 };
  await DB.applyTransition({ opened: [p], updated: [], closed: [], held: [] }, { now: 5_000 });
  assert.equal(await DB.markNotified([{ agent: '', partKey: 'ns-1', firstSeen: 4_000 }]), 0, '다른 판정이 연 행에는 찍지 않는다');
  assert.equal(await DB.markNotified([{ agent: '', partKey: 'ns-1', firstSeen: 5_000 }]), 1);
});

test('12b #1 — 화면 응답의 큐 상태는 아는 수 필드만', async () => {
  const R = await import('../src/routes/api/partFaults.js');
  assert.deepEqual(R.queueView({ waiting: 2, waitingItems: '7', overflowDropped: 400, superseded: 1, disabledSkipped: 0, running: true, secret: 'x', lastDoneAt: null }),
    { waiting: 2, waitingItems: 7, maxItems: null, enqueued: null, done: null, overflowDropped: 400, superseded: 1, disabledSkipped: 0, lastDoneAt: null, running: true });
  assert.equal(R.queueView(null), null);
});

test('12c D5 — 꺼져 건너뛴 회차는 판정 몫 0', async () => {
  const PF = await import('../src/partfault/poller.js');
  const keep = process.env.PARTFAULT_ENABLED;
  const S = await import('../src/partfault/settings.js');
  process.env.PARTFAULT_ENABLED = 'false';
  try {
    const en = S.partFaultEnabled();
    assert.equal(en.enabled, false, 'env 가 끔');
    const r = await PF.runPartFaultsNow({ reason: 'timer' });
    assert.equal(r.skipped, true);
    assert.equal(PF._lastJudgeCostForTest(), 0);
  } finally { process.env.PARTFAULT_ENABLED = keep; }
});
