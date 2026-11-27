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
  send('f2-slow');   // 도는 묶음이 맡은 서버에 새 이벤트 — 대기에도 들어가지만 서로 다른 서버 수는 그대로 1(13a G2 — 두 번 세지 않는다)
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

test('13b — 부품마다 마지막 대기 알림 하나(같은 부품의 뒤 알림이 대신) · 0건 판정은 넣지 않음 · 넘침은 오래된 것부터 셈 · 꺼지면 안 보냄 · 늦은 알림은 알림마다 판정 시각', async () => {
  const PF = await import('../src/partfault/poller.js');
  PF._resetNotifyForTest();
  let release = null; let gate = new Promise((r) => { release = r; }); const sent = []; let now = 1_000_000; let enabled = true;
  PF._setNotifyDepsForTest({
    sendAlerts: async (list, { note } = {}) => { for (const e of list) sent.push({ key: `${e.closed ? 'C' : 'O'}:${e.partKey}`, note }); await gate; return { sent: list.length, skipped: 0, failed: 0, results: list.map((e) => ({ partKey: e.partKey, closed: e.closed, result: 'webhook:ok', outcome: 'delivered' })) }; },
    markNotified: async () => {}, enabled: () => ({ enabled, source: 'saved' }), now: () => now,
  });
  const warns = []; const ow = console.warn; console.warn = (...a) => { warns.push(a.map(String).join(' ')); };
  try {
    // 12b #6 — 500건 판정: 대기 수는 200(상한까지) · 상한 밖 300 은 대기 중에도 밝힌다
    const v0 = PF._enqueueNotifyForTest(alertsOf(500, 'big'), 'big');
    assert.deepEqual([v0.queued, v0.capped, v0.total, v0.pending], [200, 300, 500, true]);
    // 같은 부품 200 이 열림 · 해소를 번갈아(채널 막힘) — 기다리던 앞 알림은 뒤 알림이 대신한다(부품마다 하나)
    const vs = [];
    for (let j = 0; j < 12; j += 1) vs.push(PF._enqueueNotifyForTest(alertsOf(200, 'flip', j % 2 === 1), `flip-${j}`));
    let q = PF._notifyQueueStatusForTest();
    assert.deepEqual([q.superseded, q.waiting], [11 * 200, 199 + 200], '앞 판정 11개의 200건씩을 대신 · 기다리는 것은 부품 수만큼');
    assert.deepEqual([vs[0].pending, vs[0].superseded, vs[10].pending, vs[11].pending], [false, 200, false, true], '대신된 판정은 끝남 · 마지막 판정(해소)이 남는다');
    // 13b N2 — 보낼 것이 없는 판정(키 이전만)은 큐에 넣지 않는다(진짜 알림을 밀어내지 않음)
    const mig = { opened: [{ agent: '', partKey: 'mig-1', migratedFrom: 'old', prevState: 'fault', state: 'fault', scope: 'idrac', kind: 'psu' }], updated: [], closed: [] };
    const vm = PF._enqueueNotifyForTest(mig, 'mig');
    assert.deepEqual([vm.pending, vm.queued, PF._notifyQueueStatusForTest().waiting], [false, 0, 399]);
    // 상한(부품 수) — 넘치면 가장 오래된 것부터 빼고 센다
    for (let j = 0; j < 25; j += 1) PF._enqueueNotifyForTest(alertsOf(200, `ov${j}`), `ov-${j}`);
    q = PF._notifyQueueStatusForTest();
    assert.deepEqual([q.waiting, q.overflowDropped], [PF.NOTIFY_QUEUE_MAX_ITEMS, 399]);
    assert.deepEqual([v0.queueDropped, v0.pending, vs[11].queueDropped, vs[11].pending], [199, true, 200, false], '가장 오래된 big 나머지 · flip 마지막 판정이 빠짐(센다) · big 은 보내는 중인 1건이 남아 대기');
    assert.ok(warns.some((w) => /알림 대기열이 넘쳐/.test(w)));
    // 12b #5 · 지연 — 2분 뒤 채널이 풀림 · 그 사이 점검을 끔 → 남은 대기는 보내지 않는다
    now += 120_000; enabled = false;
    release(); release = null;
    await PF._notifyIdleForTest();
    assert.equal(sent.length, 1, '보내던 것 하나만 — 꺼진 뒤의 대기는 보내지 않는다(#5)');
    q = PF._notifyQueueStatusForTest();
    assert.equal(q.disabledSkipped, PF.NOTIFY_QUEUE_MAX_ITEMS);
    // 13b D1 — 늦은 알림 표기는 알림마다(한 판정 안의 뒤쪽 알림도)
    enabled = true; gate = Promise.resolve();
    PF._enqueueNotifyForTest(alertsOf(1, 'late'), 'late');
    await PF._notifyIdleForTest();
    assert.equal(sent.at(-1).note, '', '바로 보내면 덧붙이지 않는다');
    let rel2 = null; gate = new Promise((r) => { rel2 = r; });
    PF._enqueueNotifyForTest(alertsOf(1, 'late2'), 'late2');   // 보내는 중(막힘)
    const v3 = PF._enqueueNotifyForTest(alertsOf(3, 'late3'), 'late3');
    now += 180_000; rel2();
    await PF._notifyIdleForTest();
    const notes = sent.slice(-3).map((x) => x.note);
    assert.equal(notes.length, 3);
    for (const n of notes) assert.match(n, /^판정 시각 .*알림 채널이 늦어 약 3분 뒤에 보냅니다/);
    assert.equal(v3.delayedMs, 180_000);
  } finally { console.warn = ow; PF._resetNotifyForTest(); release?.(); await PF._notifyIdleForTest(); PF._setNotifyDepsForTest(null); }
});

test('13b N5 · 대신함의 발송 표시 — 같은 partKey 라도 수집 주체가 다르면 따로 · 열림이 같은 부품의 변화 알림으로 대신되면 표시를 넘겨받음', async () => {
  const PF = await import('../src/partfault/poller.js');
  PF._resetNotifyForTest();
  let release = null; const gate = new Promise((r) => { release = r; }); const marks = [];
  PF._setNotifyDepsForTest({
    sendAlerts: async (list) => { await gate; return { results: list.map((e) => ({ partKey: e.partKey, closed: e.closed, result: '', outcome: e.agent === 'edge-a' ? 'failed' : 'delivered' })) }; },
    markNotified: async (k) => { marks.push(...k.map((m) => `${m.agent}|${m.partKey}|${m.firstSeen}`)); }, enabled: () => ({ enabled: true, source: 'saved' }),
  });
  try {
    const p = (agent, k, state = 'fault') => ({ agent, partKey: k, state, scope: 'idrac', kind: 'psu', label: 'PSU', firstSeenAt: 777 });
    PF._enqueueNotifyForTest({ opened: [p('edge-z', 'zz')], updated: [], closed: [] }, 'head');   // 보내는 중(막힘)
    PF._enqueueNotifyForTest({ opened: [p('edge-a', 'same'), p('edge-b', 'same')], updated: [], closed: [] }, 'two');
    // 열림(edge-c) 뒤 같은 부품의 변화(warn → fault) 알림이 대신 — 표시 정보를 넘겨받는다
    PF._enqueueNotifyForTest({ opened: [p('edge-c', 'chg', 'warn')], updated: [], closed: [] }, 'open-c');
    PF._enqueueNotifyForTest({ opened: [], updated: [{ ...p('edge-c', 'chg'), prevState: 'warn', sameState: false }], closed: [] }, 'change-c');
    release(); await PF._notifyIdleForTest();
    assert.deepEqual(marks.sort(), ['edge-b|same|777', 'edge-c|chg|777', 'edge-z|zz|777'], '받은 열림만 · 수집 주체까지 · 대신한 변화 알림이 열림 표시를 넘겨받음');
  } finally { release?.(); PF._setNotifyDepsForTest(null); PF._resetNotifyForTest(); }
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
  assert.deepEqual(R.queueView({ waiting: 2, sent: '7', failed: 3, overflowDropped: 400, superseded: 1, disabledSkipped: 0, running: true, secret: 'x', lastDoneAt: null }),
    { waiting: 2, maxItems: null, enqueued: null, sent: 7, failed: 3, skipped: null, overflowDropped: 400, superseded: 1, disabledSkipped: 0, lastDoneAt: null, running: true });
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

test('13c N1 — 판정 폴러의 가상 전이: DB 에 없는 기록의 장비를 읽지 못했거나 · 종류를 못 모았거나 · 보고에 빠졌으면(보류) 남기고 · 읽었고 정상이면 닫힘 근거(실제 판정 경로)', async () => {
  const { putEdgeReport } = await import('../src/central/partFaultEdge.js');
  const PF = await import('../src/partfault/poller.js');
  const E = await import('../src/partfault/escalation.js');
  const RUN = await import('../src/partfault/escalationRun.js');
  const CE = await import('../src/partfault/closeEvidence.js');
  PF._setNotifyDepsForTest({ sendAlerts: async (list) => ({ results: list.map((e) => ({ partKey: e.partKey, closed: e.closed, result: '', outcome: 'skipped' })) }) });
  const rep = (ok, open, failedKinds = [], okParts = [], devId = 'synth-n1d') => ({
    v: 2, agent: 'synth-n1', version: '3.54.0', at: Date.now(), partIdents: 1, omitted: 0, scanned: { idrac: { devices: 1, ok: ok ? 1 : 0, failed: ok ? 0 : 1 } },
    devices: [{ scope: 'idrac', deviceId: devId, deviceKey: 'SYNTHN1D', deviceKeyKind: 'serviceTag', deviceName: 'synth-n1d', ok, reason: ok ? '' : 'device-failed', failedKinds, capped: false, notCollected: [],
      states: { ok: ok ? ['fan:FAN.1', ...okParts] : [], unknown: [], absent: [] },
      open: open ? [{ kind: 'psu', partId: 'PSU.N1', keyKind: 'name', state: 'fault', rawState: 'Critical', label: 'PSU N1', detail: '' }] : [] }],
  });
  fs.writeFileSync(path.join(tmp, 'partfault-escalation.json'), JSON.stringify({ v: 1, enabled: true, enabledAt: 1, policies: [{ id: 'pf', name: 'fault', agents: [], states: ['fault'], steps: [{ afterMin: 15, emails: ['a1@example.test'], channels: false, oncall: false }] }], oncall: {}, at: 1, by: 'admin' }));
  E.escalationStore._resetForTest(); E._resetEscalationStateForTest();
  RUN._setEscalationDepsForTest({ partFaultSwitch: async () => ({ enabled: true, source: '' }), hold: async () => ({ hold: null, keyOf: null }), mail: async () => ({ ok: true }), channels: async () => [] });
  try {
    // 장애를 열고 진행 기록을 만든다(판정 재료 pk 가 실린다)
    assert.equal((await putEdgeReport('synth-n1', rep(true, true))).ok, true);
    await PF.runPartFaultsNow({ reason: 'n1-open' });
    await RUN.runEscalationNow();
    const key = Object.keys(E.loadEscalationState().items).find((k) => k.startsWith('synth-n1|'));
    assert.ok(key && E.loadEscalationState().items[key].pk?.deviceId === 'synth-n1d', `기록과 판정 재료(${key})`);
    // 14c M1 — 판정 재료(pk)가 없는 기록(업그레이드 전 · 확인 단추가 만든 것)도 열쇠와 sig 로 가상 장애를 만든다 — 재료를 지우고 진행
    const stFile = path.join(tmp, 'partfault-escalation-state.json');
    const st0 = JSON.parse(fs.readFileSync(stFile, 'utf8')); delete st0.items[key].pk; fs.writeFileSync(stFile, JSON.stringify(st0)); E._resetEscalationStateForTest();
    assert.equal(E.loadEscalationState().items[key].pk, undefined);
    assert.ok(E.phantomOf(key, E.loadEscalationState().items[key])?.deviceId === 'synth-n1d', 'sig 로 만든 가상 장애');
    // 새 DB 처럼 — 열린 행을 닫힘 이벤트 없이 지운다(그 열쇠의 마지막 이벤트는 ‘열림’ — DB 근거 없음)
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(path.join(tmp, 'part-faults.db'));
    raw.prepare('DELETE FROM part_state WHERE agent=?').run('synth-n1');
    raw.close();
    // ① 장비를 읽지 못함 → 가상 전이가 보류 → 근거 없음 → 기록 유지 · 정리 대상으로 세지 않음(일시적 — 15c P2)
    await putEdgeReport('synth-n1', rep(false, false));
    await PF.runPartFaultsNow({ reason: 'n1-devfail' });
    assert.equal(CE.judgedClosedKeys().has(key), false, '장비 실패는 닫힘이 아니다');
    const rDev = await RUN.runEscalationNow();
    assert.ok(Object.hasOwn(E.loadEscalationState().items, key), '기록을 남긴다(13c N1)');
    assert.equal(rDev.orphans, 0, '장비 실패 보류는 정리 대상이 아니다');
    // ② 그 종류를 모으지 못함 → 보류
    await putEdgeReport('synth-n1', rep(true, false, ['psu']));
    await PF.runPartFaultsNow({ reason: 'n1-kindfail' });
    assert.equal(CE.judgedClosedKeys().has(key), false, '컬렉션 실패도 닫힘이 아니다');
    // ③ 장비를 읽었는데 보고에 그 부품이 없음(누락) → 전이가 보류 → 근거 없음
    await putEdgeReport('synth-n1', rep(true, false));
    await PF.runPartFaultsNow({ reason: 'n1-missing' });
    assert.equal(CE.judgedClosedKeys().has(key), false, '보고에서 빠진 부품도 닫힘이 아니다(전이의 누락 보류)');
    // ④ 장비를 읽었고 그 부품이 정상 — 장비 IP(deviceId)가 바뀌어도 부품 열쇠(서비스 태그 기반)로 맞춰 가상 전이가 닫음 → 근거 → 기록 정리(반증 15c P1)
    await putEdgeReport('synth-n1', rep(true, false, [], ['psu:PSU.N1'], 'synth-n1d-newip'));
    await PF.runPartFaultsNow({ reason: 'n1-ok' });
    assert.equal(CE.judgedClosedKeys().has(key), true, '읽었고 정상이면 닫힘 근거');
    // 판정 재료가 없어도(sig) 닫힘을 가린다 — 이 회차는 기록을 정리한다(14c M1)
    await RUN.runEscalationNow();
    assert.equal(Object.hasOwn(E.loadEscalationState().items, key), false, '근거가 있으면 정리');
    // 14c M2 — 다시 보이지 않는 장비의 기록(근거가 영영 없음)은 관리자가 정리한다 · 회차가 센다
    //   15c P2 — 셀 때는 스스로 풀리지 않는 것만: 보고는 있는데 장비가 빠짐(unassigned) · 판정 재료 없음. 일시적 보류(장비 실패)는 세지 않는다
    const ghost = 'synth-n1|idrac:SYNTHGONE:disk:Disk.Bay.9';
    const noMat = 'synth-n1|idrac:SYNTHNOMAT:disk:Disk.Bay.8';
    const st1 = JSON.parse(fs.readFileSync(stFile, 'utf8'));
    st1.items[ghost] = { since: 1, sig: 'synth-n1|idrac|synth-n1-gone|disk|Disk.Bay.9', sent: [], ackedAt: 2, ackBy: 'oper', pol: 'pf', ps: {} };
    st1.items[noMat] = { since: 1, sig: 'x', sent: [], ackedAt: 2, ackBy: 'oper', pol: 'pf', ps: {} };
    fs.writeFileSync(stFile, JSON.stringify(st1)); E._resetEscalationStateForTest();
    await putEdgeReport('synth-n1', rep(true, false, [], ['psu:PSU.N1']));
    await PF.runPartFaultsNow({ reason: 'n1-ghost' });
    assert.equal(CE.judgedHeldReasons().get(ghost), 'unassigned', '보고에서 장비가 빠짐');
    const r0 = await RUN.runEscalationNow();
    assert.equal(r0.orphans, 2, '닫힘을 확인할 수 없는 기록 2건');
    assert.deepEqual(r0.orphanReasons, { unassigned: 1, unjudgeable: 1 });
    const f = await RUN.forgetEscalationOrphans();
    assert.deepEqual([f.ok, f.removed], [true, 2]);
    assert.equal(Object.hasOwn(E.loadEscalationState().items, ghost), false);
    assert.equal(RUN.escalationRunStatus().orphans, 0);
  } finally { RUN._setEscalationDepsForTest(null); PF._setNotifyDepsForTest(null); CE._resetJudgedClosedForTest(); await PF._notifyIdleForTest(); }
});

test('13a G1 — 묶음 A 에서 못 읽은 서버를 묶음 B 가 다시 읽어 성공하면 A 가 끝나도 강제 재읽기 표지가 남지 않는다(표지는 그 서버를 끝낸 자리에서)', async (t) => {
  const { config } = await import('../src/config.js');
  const keep = config.idrac.pollConcurrency; config.idrac.pollConcurrency = 4;
  t.after(() => { config.idrac.pollConcurrency = keep; });
  let xBad = true; const log = [];
  const app = express();
  app.use('/bmc/:box', async (req, res) => {
    const b = req.params.box; log.push([b, Date.now(), xBad]);
    await sleep(b === 'gslow' ? 150 : 5);
    if (b === 'gx' && xBad) return res.status(401).end();
    if (b === 'gx') {   // 고친 뒤에는 장비가 제대로 답한다(닿음 · 시스템 읽힘 — 반증 14a H1: 404 는 ‘읽음’ 이 아니다)
      const u = req.url.split('?')[0];
      if (u === '/redfish/v1/Systems') return res.json({ Members: [{ '@odata.id': '/redfish/v1/Systems/System.Embedded.1' }] });
      if (u === '/redfish/v1/Systems/System.Embedded.1') return res.json({ SKU: 'SYNTHG1X', SerialNumber: 'SERG1X', Model: 'PowerEdge R650', Manufacturer: 'Dell Inc.', PowerState: 'On', Status: { Health: 'OK' } });
      return res.json({ Members: [] });
    }
    res.status(404).end();
  });
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { srv.closeAllConnections?.(); srv.close(); });
  const base = `http://127.0.0.1:${srv.address().port}/bmc`;
  const registry = await import('../src/idrac/registry.js');
  const reg = (pw) => registry.importServers(['gslow', 'gx'].map((b) => ({ id: `g1-${b}`, name: `synth-${b}`, host: `${base}/${b}`, username: 'u', password: b === 'gx' ? pw : 'p', serviceTag: `SYNTHG1${b}` })), 'replace');
  reg('wrong');
  const C = await import('../src/idrac/invCache.js');
  const E = await import('../src/idrac/eventSub.js');
  E._resetEventsForTest();
  E._setEventDepsForTest({ debounceMs: 60, judge: async () => {} });
  t.after(() => { E._setEventDepsForTest(null); E._resetEventsForTest(); });
  const s = { enabled: true, base: 'https://portal.example.test', secret: 'E'.repeat(43), ctxKey: 'F'.repeat(43) };
  const send = (id) => E.acceptEvents(s, { context: E.contextOf(s, id), events: [{ sev: 'critical' }] });
  send('g1-gslow'); send('g1-gx');
  for (let i = 0; i < 400; i += 1) { await sleep(5); const xs = log.filter(([b]) => b === 'gx'); if (xs.length && Date.now() - xs.at(-1)[1] > 40) break; }
  assert.equal(C.isForcedStale('g1-gx'), true, 'A 에서 못 읽은 서버는 끝낸 자리에서 표지');
  xBad = false; reg('right');
  send('g1-gx');
  const tB = Date.now();
  for (let i = 0; i < 400 && !log.some(([b, a, bad]) => b === 'gx' && a > tB && !bad); i += 1) await sleep(5);
  for (let i = 0; i < 400; i += 1) { await sleep(5); const xs = log.filter(([b, a]) => b === 'gx' && a > tB); if (xs.length && Date.now() - xs.at(-1)[1] > 40) break; }
  for (let i = 0; i < 600 && E.eventStatus().running; i += 1) await sleep(10);
  assert.equal(C.isForcedStale('g1-gx'), false, 'B 의 성공 읽기 뒤에 A 의 끝이 헛 표지를 세우지 않는다');
  C.removeInventory('g1-gx'); C.removeInventory('g1-gslow');
});

test('14a H1 — 이벤트 뒤 다시 읽기에서 장비가 503 · 404 로 답하면 ‘읽음’ 이 아니다(재읽기 표지) · 앞 읽기에서 됐던 컬렉션이 실패해도 · 늘 실패하는 컬렉션은 세지 않음', async (t) => {
  let mode = 'busy'; const app = express();
  app.use('/bmc/:box', async (req, res) => {
    const u = req.url.split('?')[0];
    if (mode === 'busy') return res.status(503).end();
    if (u === '/redfish/v1/Systems') return res.json({ Members: [{ '@odata.id': '/redfish/v1/Systems/System.Embedded.1' }] });
    if (u === '/redfish/v1/Systems/System.Embedded.1') return res.json({ SKU: 'SYNTHH1', SerialNumber: 'SERH1', Model: 'PowerEdge R650', Manufacturer: 'Dell Inc.', PowerState: 'On', Status: { Health: 'OK' } });
    if (mode === 'partial' && !u.startsWith('/redfish/v1/Systems')) return res.status(503).end();
    return res.json({ Members: [] });
  });
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { srv.closeAllConnections?.(); srv.close(); });
  const registry = await import('../src/idrac/registry.js');
  registry.importServers([{ id: 'h1-x', name: 'synth-h1', host: `http://127.0.0.1:${srv.address().port}/bmc/x`, username: 'u', password: 'p', serviceTag: 'SYNTHH1' }], 'replace');
  const P = await import('../src/idrac/poller.js');
  const C = await import('../src/idrac/invCache.js');
  const readOf = async () => { const seen = []; await P.pollNowForEvent(['h1-x'], { onServerDone: (sid, info) => seen.push(info?.read) }); return seen; };
  assert.deepEqual(await readOf(), [false], '503 전부 — 닿지 않음');
  mode = 'ok';
  assert.deepEqual(await readOf(), [true], '정상');
  const okColl = Object.entries(C.getInventory('h1-x')?.collections || {}).filter(([, v]) => v === 'ok').map(([k]) => k);
  mode = 'partial';
  assert.ok(okColl.some((k) => k !== 'system'), `정상 읽기에서 부품 컬렉션이 됐다(${okColl.join(',')})`);
  assert.deepEqual(await readOf(), [false], '앞에서 됐던 컬렉션이 실패하면 못 읽음');
  assert.deepEqual(await readOf(), [false], '바쁜 읽기가 이어져도 못 읽음 — 기준은 마지막으로 됐던 상태(반증 15a J1)');
  assert.equal(C.isForcedStale('h1-x'), false, '표지는 호출부(eventSub)가 세운다 — 여기서는 판정만 본다');
  mode = 'ok';
  assert.deepEqual(await readOf(), [true], '다시 정상');
  C.removeInventory('h1-x');
});

test('15b S1 · 14b M3 · M2 — 같은 열쇠의 새 알림은 앞 차례를 그대로(깜박이는 부품도 굶지 않음) · 같은 물리 부품의 다른 열쇠(키 왕복)는 함께 대신 · 보내는 중 받지 못한 열림은 뒤 알림이 받을 때 표시', async () => {
  const PF = await import('../src/partfault/poller.js');
  PF._resetNotifyForTest();
  let release = null; let gate = new Promise((r) => { release = r; }); const order = []; const marks = [];
  PF._setNotifyDepsForTest({
    sendAlerts: async (list) => { for (const e of list) order.push(`${e.closed ? 'C' : 'O'}:${e.partKey}`); await gate; return { results: list.map((e) => ({ partKey: e.partKey, closed: e.closed, result: '', outcome: e.partKey === 'z' && !e.closed && order.filter((x) => x === 'O:z').length === 1 ? 'failed' : 'delivered' })) }; },
    markNotified: async (k) => { marks.push(...k.map((m) => `${m.partKey}|${m.firstSeen}`)); }, enabled: () => ({ enabled: true, source: 'saved' }),
  });
  try {
    const p = (k, state = 'fault', partId = k) => ({ agent: '', partKey: k, state, scope: 'idrac', deviceId: 'synth-d', kind: 'psu', partId, label: 'PSU', firstSeenAt: 55 });
    PF._enqueueNotifyForTest({ opened: [p('z')], updated: [], closed: [] }, 'z-open');   // 보내는 중(막힘) — 실패로 끝난다
    PF._enqueueNotifyForTest({ opened: [p('a')], updated: [], closed: [] }, 'a-open');
    PF._enqueueNotifyForTest({ opened: [p('b')], updated: [], closed: [] }, 'b-open');
    PF._enqueueNotifyForTest({ opened: [], updated: [], closed: [{ ...p('a'), closeReason: 'ok' }] }, 'a-close');   // a 의 열림을 대신 — 앞 차례 그대로
    // 키 왕복 — 같은 물리 부품(slot = synth-d · psu · PSU.K)이 열쇠 kA → kB → kA 로: 기다리던 다른 열쇠 알림도 대신(마지막 상태만)
    PF._enqueueNotifyForTest({ opened: [p('kA', 'warn', 'PSU.K')], updated: [], closed: [] }, 'kA-open');
    PF._enqueueNotifyForTest({ opened: [{ ...p('kB', 'fault', 'PSU.K'), migratedFrom: 'kA', prevState: 'warn' }], updated: [], closed: [] }, 'kB-worse');
    PF._enqueueNotifyForTest({ opened: [], updated: [], closed: [{ ...p('kA', 'fault', 'PSU.K'), closeReason: 'ok' }] }, 'kA-close');
    PF._enqueueNotifyForTest({ opened: [], updated: [{ ...p('z'), prevState: 'warn', sameState: false }], closed: [] }, 'z-change');
    release(); await PF._notifyIdleForTest();
    assert.deepEqual(order, ['O:z', 'C:a', 'O:b', 'C:kA', 'O:z'], '대신한 알림은 앞 차례 · 키 왕복은 마지막(해소)만');
    assert.deepEqual(marks.sort(), ['b|55', 'z|55'], '보내는 중 실패한 z 열림은 뒤 변화 알림이 받을 때 표시(14b M2) · 해소된 a · kA 는 표시 없음');
    // 15b S1 — 대기열이 계속 차 있는 동안 X 가 한 건 보낼 때마다 깜박여도 X 는 자기 차례에 나간다
    order.length = 0; gate = new Promise((r) => { release = r; });
    PF._enqueueNotifyForTest({ opened: [p('head')], updated: [], closed: [] }, 'head');   // 보내는 중
    PF._enqueueNotifyForTest({ opened: [p('x')], updated: [], closed: [] }, 'x-0');
    for (let i = 1; i <= 6; i += 1) {
      PF._enqueueNotifyForTest({ opened: [p(`o${i}`)], updated: [], closed: [] }, `o${i}`);
      PF._enqueueNotifyForTest(i % 2 ? { opened: [], updated: [], closed: [{ ...p('x'), closeReason: 'ok' }] } : { opened: [p('x')], updated: [], closed: [] }, `x-${i}`);
    }
    release(); await PF._notifyIdleForTest();
    assert.equal(order[1].endsWith(':x'), true, `x 는 자기 차례(두 번째)에 마지막 상태로 나간다(${order.join(' ')})`);
  } finally { release?.(); PF._setNotifyDepsForTest(null); PF._resetNotifyForTest(); }
});
