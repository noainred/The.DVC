// v3.52 설계 과제(사용자 결정 2026-11-27 — 디버깅 11회차 뒤 ‘여기서 릴리스’ 와 함께 고른 넷 가운데 셋 · 서버 린트 CI 게이트는 bmDebug 밖).
//   ② 이벤트 전용 자리 — 상한 밖 1 · 전체 동시 ≤ 상한 + 1 · 같은 장비 세션 1 · 자리 누수 없음
//   ③ 알림 발송 분리 — 판정 가드 밖 순차 큐 · 판정이 발송을 기다리지 않음 · 순서 · 발송 뒤 표시 · 넘침은 센다
//   ④ 이벤트 묶음 동시 실행 — 느린 서버가 낀 묶음이 끝날 때까지 다른 서버의 이벤트가 기다리지 않음 · 같은 서버는 두 묶음이 함께 읽지 않음 · 묶음 수 상한
// 픽스처는 합성(SYNTH · 127.0.0.1 가짜 iDRAC · 가짜 엣지 보고).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmdesign352-'));
const rmTmp = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } };
after(() => { rmTmp(); process.once('exit', rmTmp); });
Object.assign(process.env, { CONFIG_DIR: tmp, DB_DIR: tmp, DATA_SOURCE: 'live', SSRF_ALLOW_LOOPBACK: 'true', AUTH_ENABLED: 'false', PARTFAULT_ENABLED: 'true' });
delete process.env.CENTRAL_URL;
const express = (await import('express')).default;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 가짜 iDRAC — 서버별 동시 요청 · 전체 최대 동시 요청을 잰다. */
async function fakeBmc(t, { delay = () => 12 } = {}) {
  const st = { log: [], fly: new Map(), total: 0, peak: 0, sameBox: 0 };
  const app = express();
  app.use('/bmc/:box', async (req, res) => {
    const b = req.params.box; st.log.push([b, Date.now()]);
    st.fly.set(b, (st.fly.get(b) || 0) + 1); st.total += 1; st.peak = Math.max(st.peak, st.total); if (st.fly.get(b) > 1) st.sameBox += 1;
    await sleep(delay(b));
    st.fly.set(b, st.fly.get(b) - 1); st.total -= 1;
    res.status(404).end();
  });
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { srv.closeAllConnections?.(); srv.close(); });
  st.base = `http://127.0.0.1:${srv.address().port}/bmc`;
  return st;
}

for (const limit of [1, 3]) {
  test(`② 상한 ${limit} — 정규 주기 + 겹치는 이벤트 묶음 셋: 전체 동시 ≤ 상한 + 1 · 같은 장비 세션 1 · 자리 · 표시 누수 없음`, async (t) => {
    const { config } = await import('../src/config.js');
    const keep = config.idrac.pollConcurrency;
    config.idrac.pollConcurrency = limit;
    t.after(() => { config.idrac.pollConcurrency = keep; });
    const st = await fakeBmc(t, { delay: (b) => (b === 'k3' ? 40 : 8 + (b.charCodeAt(1) % 5) * 3) });
    const boxes = Array.from({ length: 10 }, (_, i) => `k${i}`);
    const registry = await import('../src/idrac/registry.js');
    registry.importServers(boxes.map((b) => ({ id: `d2-${limit}-${b}`, name: `synth-d2${b}`, host: `${st.base}/${b}`, username: 'u', password: 'p', serviceTag: `SYNTHD2${limit}${b}` })), 'replace');
    const P = await import('../src/idrac/poller.js');
    const id = (b) => `d2-${limit}-${b}`;
    const cyc = P.pollNowManual();
    await sleep(5);
    const evs = [P.pollNowForEvent([id('k3'), id('k5')]), P.pollNowForEvent([id('k3'), id('k7')]), P.pollNowForEvent([id('k1'), id('k9'), id('k5')])];
    const [m, ...rs] = await Promise.all([cyc, ...evs]);
    assert.equal(m.ran, true);
    for (const r of rs) assert.equal(r.busy, false, '이벤트 묶음끼리 막지 않는다(설계 ④)');
    assert.ok(st.peak <= limit + 1, `전체 동시 요청 ≤ 상한 ${limit} + 전용 1(최대 ${st.peak})`);
    assert.equal(st.sameBox, 0, '같은 장비에 동시 세션을 열지 않는다');
    assert.deepEqual(P._slotStateForTest(), { n: 0, ev: 0, ded: 0, q: 0, qe: 0 }, '자리 누수 없음');
    assert.deepEqual(P._eventStateForTest(), { batches: 0, pending: 0, reading: 0 }, '이벤트 표시 누수 없음');
  });
}

test('④ 폴러 — 다른 서버의 이벤트 묶음 둘은 함께 돌고 · 같은 서버를 맡은 둘째 묶음은 그 서버를 skipped 로 돌려준다(다시 잡게)', async (t) => {
  const { config } = await import('../src/config.js');
  const keep = config.idrac.pollConcurrency;
  config.idrac.pollConcurrency = 4;
  t.after(() => { config.idrac.pollConcurrency = keep; });
  const st = await fakeBmc(t, { delay: (b) => (b === 'slow' ? 120 : 10) });
  const registry = await import('../src/idrac/registry.js');
  registry.importServers(['slow', 'fast', 'f2'].map((b) => ({ id: `d4-${b}`, name: `synth-d4${b}`, host: `${st.base}/${b}`, username: 'u', password: 'p', serviceTag: `SYNTHD4${b}` })), 'replace');
  const P = await import('../src/idrac/poller.js');
  const t0 = Date.now();
  const a = P.pollNowForEvent(['d4-slow']);
  while (!st.log.some(([b]) => b === 'slow')) await sleep(2);
  const b = P.pollNowForEvent(['d4-fast', 'd4-slow']);
  const rb = await b; const tb = Date.now() - t0;
  const ra = await a; const ta = Date.now() - t0;
  assert.equal(rb.busy, false);
  assert.deepEqual(rb.skipped, ['d4-slow'], '느린 서버는 다른 묶음이 읽는 중 — 빼고 다시 잡게 돌려준다(같은 장비 세션 1)');
  assert.ok(st.log.some(([x]) => x === 'fast'), '빠른 서버는 읽었다');
  assert.ok(tb < ta, `둘째 묶음은 느린 묶음이 끝나기 전에 끝난다(둘째 ${tb}ms · 첫째 ${ta}ms)`);
  assert.deepEqual(ra.skipped, []);
  assert.equal(st.sameBox, 0);
  assert.deepEqual(P._eventStateForTest(), { batches: 0, pending: 0, reading: 0 });
});

test('④ eventSub — 느린 묶음이 도는 동안 다른 서버의 이벤트는 간격 뒤 새 묶음으로 · 도는 묶음의 서버는 그 묶음이 끝난 뒤 · 묶음 수 ≤ EVT_BATCH_CONC', async () => {
  const E = await import('../src/idrac/eventSub.js');
  E._resetEventsForTest();
  const runs = []; const gates = new Map(); let live = 0; let peak = 0;
  E._setEventDepsForTest({
    debounceMs: 40,
    runCheck: async (reason, ids) => {
      runs.push([...ids].sort()); live += 1; peak = Math.max(peak, live);
      try { if (ids.some((x) => x.startsWith('hold'))) await new Promise((r) => { gates.set(ids.join(','), r); }); else await sleep(5); } finally { live -= 1; }
      return { busy: false, retry: [] };
    },
  });
  const s = { enabled: true, base: 'https://portal.example.test', secret: 'E'.repeat(43), ctxKey: 'F'.repeat(43) };
  const send = (id) => E.acceptEvents(s, { context: E.contextOf(s, id), events: [{ sev: 'critical' }] });
  try {
    send('hold-a');
    for (let i = 0; i < 100 && !runs.length; i += 1) await sleep(5);
    assert.deepEqual(runs, [['hold-a']], '첫 이벤트는 바로');
    send('f2'); send('hold-a');   // 다른 서버 · 도는 묶음의 서버
    for (let i = 0; i < 100 && runs.length < 2; i += 1) await sleep(5);
    assert.deepEqual(runs[1], ['f2'], '느린 묶음이 끝나기 전에 다른 서버의 묶음이 돈다(도는 묶음의 서버는 넣지 않는다)');
    assert.equal(E.eventStatus().inflight >= 1, true);
    // 묶음 수 상한 — 더 붙잡는 묶음을 만든다
    send('hold-b'); for (let i = 0; i < 100 && runs.length < 3; i += 1) await sleep(5);
    send('hold-c'); for (let i = 0; i < 100 && runs.length < 4; i += 1) await sleep(5);
    send('hold-d'); await sleep(150);
    assert.ok(peak <= E.EVT_BATCH_CONC, `함께 도는 묶음 ≤ ${E.EVT_BATCH_CONC}(최대 ${peak})`);
    assert.ok(!runs.some((r) => r.includes('hold-d')), '상한이 차 있으면 기다린다');
    assert.ok(!runs.slice(1).some((r) => r.includes('hold-a')), '도는 묶음의 서버는 그 묶음이 끝나기 전에 다시 읽지 않는다');
    for (const g of [...gates.keys()]) if (g === 'hold-a') { gates.get(g)(); gates.delete(g); }
    for (let i = 0; i < 200 && !(runs.filter((r) => r.includes('hold-a')).length >= 2 && runs.some((r) => r.includes('hold-d'))); i += 1) {
      for (const [k, r] of gates) if (k !== 'hold-b' && k !== 'hold-c') { r(); gates.delete(k); }
      await sleep(10);
    }
    assert.ok(runs.filter((r) => r.includes('hold-a')).length >= 2, '느린 묶음이 끝난 뒤 그 서버를 다시 읽는다(그 묶음 도중 온 이벤트)');
    assert.ok(runs.some((r) => r.includes('hold-d')), '자리가 나면 기다린 서버를 읽는다');
  } finally {
    for (const r of gates.values()) r();
    for (let i = 0; i < 200 && E.eventStatus().running; i += 1) await sleep(10);
    E._setEventDepsForTest(null); E._resetEventsForTest();
  }
});

const report = (opens, urgent) => ({
  v: 2, agent: 'synth-site', version: '3.52.0', at: Date.now(), partIdents: 1, omitted: 0, scanned: { idrac: { devices: 1, ok: 1, failed: 0 } }, ...(urgent ? { urgent: true } : {}),
  devices: [{ scope: 'idrac', deviceId: 'synth-srv0', deviceKey: 'SYNTHTAG0', deviceKeyKind: 'serviceTag', deviceName: 'synth-srv0', ok: true, reason: '', failedKinds: [], capped: false, notCollected: [],
    states: { ok: ['fan:FAN.1', ...[1, 2, 3].filter((k) => !opens.includes(k)).map((k) => `psu:PSU.D3.${k}`)], unknown: [], absent: [] },
    open: opens.map((k) => ({ kind: 'psu', partId: `PSU.D3.${k}`, keyKind: 'name', state: 'fault', rawState: 'Critical', label: `PSU D3 ${k}`, detail: '' })) }],
});

test('③ 알림 발송 분리 — 판정은 발송을 기다리지 않고 · 다음 판정이 발송 중에도 돈다 · 판정 순서대로 보내고 · 보낸 뒤에 표시한다', async () => {
  const { putEdgeReport } = await import('../src/central/partFaultEdge.js');
  const PF = await import('../src/partfault/poller.js');
  const calls = []; const marks = []; let release = null; let gate = new Promise((r) => { release = r; });
  const pid = (k) => String(k).split(':').pop();
  PF._setNotifyDepsForTest({
    sendAlerts: async (alerts) => {
      calls.push({ opened: alerts.filter((a) => !a.closed).map((a) => pid(a.partKey)), closed: alerts.filter((a) => a.closed).map((a) => pid(a.partKey)), at: Date.now() });
      await gate;
      return { sent: alerts.length, skipped: 0, failed: 0, results: alerts.map((a) => ({ partKey: a.partKey, closed: a.closed, result: 'webhook:ok', outcome: 'delivered' })) };
    },
    markNotified: async (keys) => { marks.push({ n: keys.length, afterCalls: calls.length, firstSeen: keys.map((k) => typeof k.firstSeen) }); },
  });
  try {
    assert.equal((await putEdgeReport('synth-site', report([], false))).ok, true);
    await PF.runPartFaultsNow({ reason: 'baseline' });
    await PF._notifyIdleForTest();
    calls.length = 0; marks.length = 0;
    await putEdgeReport('synth-site', report([1], true));
    const t0 = Date.now();
    const r1 = await PF.runPartFaultsNow({ reason: 'event-1' });
    assert.equal(r1.ok, true); assert.equal(r1.stats.opened, 1);
    assert.equal(r1.notify.pending, true, '발송 대기 표지');
    assert.equal(r1.notify.queued, 1);
    assert.ok(Date.now() - t0 < 2_000, '판정이 발송(막힌 채널)을 기다리지 않는다');
    await putEdgeReport('synth-site', report([], true));   // 같은 부품이 해소됨
    const r2 = await PF.runPartFaultsNow({ reason: 'event-2' });
    assert.equal(r2.ok, true); assert.equal(r2.stats.closed, 1, '첫 판정의 알림이 막혀 있는 동안 다음 판정이 돈다');
    assert.equal(calls.length, 1, '발송 일꾼은 하나 — 둘째 판정의 알림은 첫째가 끝난 뒤');
    assert.equal(marks.length, 0, '보내기 전에 발송 표시를 하지 않는다');
    const st = (await PF.partFaultStatus()).notifyQueue;
    assert.deepEqual([st.waiting, st.running], [1, true]);
    release(); release = null;
    await PF._notifyIdleForTest();
    assert.deepEqual(calls.map((c) => [c.opened, c.closed]), [[['PSU.D3.1'], []], [[], ['PSU.D3.1']]], '열림 → 해소 순서');
    assert.deepEqual(marks.map((m) => [m.n, m.afterCalls, m.firstSeen]), [[1, 1, ['number']]], '열림 판정의 발송 뒤 표시 · 그 판정이 연 행(처음 감지 시각)으로');
    assert.equal(r1.notify.pending, false); assert.equal(r1.notify.sent, 1, '판정 결과의 표지가 발송 뒤 채워진다');
    assert.equal(r2.notify.pending, false);
  } finally { if (release) release(); PF._setNotifyDepsForTest(null); await PF._notifyIdleForTest(); }
});

test('③ 대기열 넘침 — 부품 수 상한을 넘으면 가장 오래된 대기 알림부터 보내지 않고 센다(조용히 버리지 않음 · 경고 로그)', async () => {
  const PF = await import('../src/partfault/poller.js');
  PF._resetNotifyForTest();
  let release = null; const gate = new Promise((r) => { release = r; }); const sentKeys = [];
  PF._setNotifyDepsForTest({ sendAlerts: async (list) => { sentKeys.push(list[0].partKey); await gate; return { results: [] }; }, markNotified: async () => {}, enabled: () => ({ enabled: true, source: 'saved' }) });
  const warns = []; const ow = console.warn; console.warn = (...a) => { warns.push(a.map(String).join(' ')); };
  try {
    const job = (j) => ({ opened: Array.from({ length: 200 }, (_, k) => ({ agent: '', partKey: `ov-${j}-${k}`, state: 'fault', scope: 'idrac', kind: 'psu', label: `PSU ${k}` })), updated: [], closed: [] });
    const views = Array.from({ length: 27 }, (_, j) => PF._enqueueNotifyForTest(job(j), `ov-${j}`));   // 5,400건 — 첫 건은 보내는 중
    const q = PF._notifyQueueStatusForTest();
    assert.deepEqual([q.waiting, q.overflowDropped], [PF.NOTIFY_QUEUE_MAX_ITEMS, 5_400 - 1 - PF.NOTIFY_QUEUE_MAX_ITEMS]);
    assert.deepEqual([views[0].queueDropped, views[1].queueDropped, views[1].pending, views[2].pending], [199, 200, false, true]);
    assert.ok(warns.some((w) => /알림 대기열이 넘쳐/.test(w)), '경고 로그');
    release();
    await PF._notifyIdleForTest();
    assert.equal(sentKeys[0], 'ov-0-0');
    assert.equal(sentKeys[1], 'ov-2-0', '뺀 것 말고는 순서대로 보낸다');
    assert.equal(sentKeys.length, 1 + PF.NOTIFY_QUEUE_MAX_ITEMS);
  } finally { console.warn = ow; PF._resetNotifyForTest(); release?.(); await PF._notifyIdleForTest(); PF._setNotifyDepsForTest(null); }
});
