// 물리서버 기능 디버깅 회차 7 — 엣지 축 회귀(엣지 설정으로 도는 별도 프로세스). 보내지 못한 urgent 는 다음 push 에 싣는다 · 이벤트 읽기 자리 몫 ·
//   중앙 ‘곧 판정’ 묶음 5초. 픽스처는 합성(SYNTH · 127.0.0.1 가짜 중앙 · 가짜 iDRAC).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmdebug5-'));
const rmTmp = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } };
after(() => { rmTmp(); process.once('exit', rmTmp); });
const express = (await import('express')).default;
let gateOpen = false; const seen = [];
let holdMode = false; const held = [];   // holdMode — 응답을 붙잡아 재전송 고리를 회차마다 손으로 넘긴다(8회차 엣지 #1)
const releaseOne = () => { const f = held.shift(); if (f) f(); };
const releaseAll = () => { while (held.length) held.shift()(); };
const gate = express();
gate.use(express.raw({ type: '*/*', limit: '16mb' }));   // gzip 은 express 가 푼다
gate.use(async (req, res) => {
  let j = null; try { j = JSON.parse(String(req.body)); } catch { j = null; }
  seen.push({ open: gateOpen, urgent: j?.urgent === true });   // 도착을 먼저 적고(시험이 회차 도착을 기다린다) 붙잡는다
  if (holdMode) await new Promise((r) => { held.push(r); });
  if (!gateOpen) return res.status(503).json({ ok: false });
  return res.json({ ok: true, centralEnabled: true, rejected: 0 });
});
const gsrv = await new Promise((r) => { const s = gate.listen(0, '127.0.0.1', () => r(s)); });
after(() => { gsrv.closeAllConnections?.(); gsrv.close(); });
Object.assign(process.env, { CONFIG_DIR: tmp, DB_DIR: tmp, DATA_SOURCE: 'live', SSRF_ALLOW_LOOPBACK: 'true', AUTH_ENABLED: 'false', PARTFAULT_ENABLED: 'true',
  CENTRAL_URL: `http://127.0.0.1:${gsrv.address().port}`, CENTRAL_TOKEN: 'tok-dbg5', AGENT_NAME: 'synth-edge' });

test('7회차 엣지 #3 — 보내지 못한 urgent 는 다음 push(주기 포함)에 싣고 · 성공하면 놓는다', async () => {
  const PU = await import('../src/partfault/push.js');
  PU._resetPushUrgentForTest();
  gateOpen = false;
  const r1 = await PU.pushPartFaultsNow({ reason: 'event' });
  assert.equal(r1.ok, false, '중앙이 503');
  assert.ok(seen.length >= 1 && seen.every((x) => x.urgent), '실패한 시도들도 urgent');
  gateOpen = true; seen.length = 0;
  const r2 = await PU.pushPartFaultsNow({ reason: 'timer' });
  assert.equal(r2.ok, true);
  assert.deepEqual(seen.map((x) => x.urgent), [true], '다음 주기 push 가 urgent 를 싣는다');
  seen.length = 0;
  await PU.pushPartFaultsNow({ reason: 'timer' });
  assert.deepEqual(seen.map((x) => x.urgent), [false], '성공한 뒤에는 놓는다');
});

test('7회차 엣지 #1 — 중앙 ‘곧 판정’ 묶음은 5초(엣지가 묶음 안에서 여러 번 보고해도 둘째 보고가 30초를 기다리지 않음)', async () => {
  const PF = await import('../src/partfault/poller.js');
  assert.equal(PF.PART_FAULT_SOON_MS, 5_000);
  // 8회차 성능 P1 — 다음 ‘곧 판정’ 은 앞 판정이 끝난 뒤 max(5초, 20 × 앞 판정 길이) · 조용한 뒤 첫 보고는 바로
  const T = Date.now();
  assert.equal(PF.soonWaitMs(T, 0, 0), 0, '처음 · 조용한 뒤에는 바로');
  assert.equal(PF.soonWaitMs(T + 1_000, T, 100), 4_000, '짧은 판정 — 5초 바닥');
  assert.equal(PF.soonWaitMs(T + 1_000, T, 400), 7_000, '400ms 판정 — 8초(20배)');
  assert.equal(PF.soonWaitMs(T + 9_000, T, 400), 0);
});

test('7회차 엣지 #4 — 동시 상한 2 이상이면 이벤트 읽기에 자리 몫: 함대가 상한보다 커도 주기 꼬리까지 기다리지 않는다', async (t) => {
  const { config } = await import('../src/config.js');
  const keep = config.idrac.pollConcurrency;
  config.idrac.pollConcurrency = 4;   // 몫 1
  const log = []; let evFired = false;
  const app = express();
  app.use('/bmc/:box', async (req, res) => { log.push([req.params.box, evFired]); await new Promise((r) => setTimeout(r, 10)); res.status(404).end(); });
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { config.idrac.pollConcurrency = keep; srv.closeAllConnections?.(); srv.close(); });
  const base = `http://127.0.0.1:${srv.address().port}/bmc`;
  const boxes = ['e', ...Array.from({ length: 23 }, (_, i) => `s${i}`)];
  const registry = await import('../src/idrac/registry.js');
  registry.importServers(boxes.map((b) => ({ id: `sh-${b}`, name: `synth-sh${b}`, host: `${base}/${b}`, username: 'u', password: 'p', serviceTag: `SYNTHSH${b}` })), 'replace');
  const P = await import('../src/idrac/poller.js');
  const cyc = P.pollNowManual();
  while (!log.some(([b]) => b === 's6')) await new Promise((r) => setTimeout(r, 2));   // 주기가 e 를 지나 함대 중간
  evFired = true;
  const ev = P.pollNowForEvent(['sh-e']);
  await Promise.all([cyc, ev]);
  const firstEv = log.findIndex(([b, f]) => f && b === 'e');
  const lastCycle = log.reduce((m, [b, f], i) => (b !== 'e' && f ? i : m), -1);
  assert.ok(firstEv >= 0 && firstEv < lastCycle, `이벤트 읽기가 주기 끝 전에 시작(이벤트 첫 요청 ${firstEv} · 주기 마지막 요청 ${lastCycle})`);
});

test('7회차 성능 P1 — 묶음 안 판정은 첫 판정 · (앞 판정 끝 뒤 15초마다) · 묶음 끝 한 번 — 서버마다 판정이 쉬지 않고 이어지지 않는다', async (t) => {
  const C = await import('../src/idrac/invCache.js');
  const app = express();
  let n = 0;
  app.use('/bmc/:box', async (req, res) => { n += 1; await new Promise((r) => setTimeout(r, 4 + (Number(req.params.box.slice(1)) % 10) * 6)); res.status(404).end(); });
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { srv.closeAllConnections?.(); srv.close(); });
  const base = `http://127.0.0.1:${srv.address().port}/bmc`;
  const boxes = Array.from({ length: 12 }, (_, i) => `j${i}`);
  const registry = await import('../src/idrac/registry.js');
  registry.importServers(boxes.map((b) => ({ id: `jl-${b}`, name: `synth-jl${b}`, host: `${base}/${b}`, username: 'u', password: 'p', serviceTag: `SYNTHJL${b}` })), 'replace');
  const P = await import('../src/idrac/poller.js');
  const E = await import('../src/idrac/eventSub.js');
  const judged = [];
  E._resetEventsForTest();
  // 장비가 404 라 인벤토리 읽기는 빈 값으로 끝난다 — 다시 읽은 서버마다 kick 이 온다(판정 고리만 본다)
  E._setEventDepsForTest({ debounceMs: 5, judgeFirstHoldMs: 30, judge: async () => { judged.push(Date.now()); await new Promise((r) => setTimeout(r, 40)); } });
  try {
    const s = { enabled: true, base: 'https://portal.example.test', secret: 'E'.repeat(43), ctxKey: 'F'.repeat(43) };
    for (const b of boxes) E.acceptEvents(s, { context: E.contextOf(s, `jl-${b}`), events: [{ sev: 'critical' }] });
    for (let i = 0; i < 1500 && !(E.eventStatus().checkedAt && !E.eventStatus().running); i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.ok(n > 0 && E.eventStatus().checkedAt, '묶음이 돌았다');
    assert.ok(judged.length >= 1 && judged.length <= 2, `판정은 첫 판정 + 묶음 끝 한 번까지(${judged.length}회 · 서버 ${boxes.length}대)`);
  } finally { E._setEventDepsForTest(null); E._resetEventsForTest(); for (const b of boxes) C.removeInventory(`jl-${b}`); void P; }
});

test('7회차 성능 P2 — 상한 1 에서 정규 주기가 읽던 그 서버를 기다린 이벤트도 주기 도중 자리를 가로채지 않는다', async (t) => {
  const { config } = await import('../src/config.js');
  const keep = config.idrac.pollConcurrency;
  config.idrac.pollConcurrency = 1;
  const log = []; let xSeen = null; const xStarted = new Promise((r) => { xSeen = r; });
  const app = express();
  app.use('/bmc/:box', async (req, res) => { log.push(req.params.box); if (req.params.box === 'x') xSeen(); await new Promise((r) => setTimeout(r, 15)); res.status(404).end(); });
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { config.idrac.pollConcurrency = keep; srv.closeAllConnections?.(); srv.close(); });
  const base = `http://127.0.0.1:${srv.address().port}/bmc`;
  const registry = await import('../src/idrac/registry.js');
  registry.importServers(['r1', 'x', 'r2', 'r3'].map((b) => ({ id: `p2-${b}`, name: `synth-p2${b}`, host: `${base}/${b}`, username: 'u', password: 'p', serviceTag: `SYNTHP2${b}` })), 'replace');
  const P = await import('../src/idrac/poller.js');
  const cyc = P.pollNowManual();
  await xStarted;   // 주기가 x 를 읽는 중 — 이벤트는 그 방문이 끝나기를 기다린다
  const ev = P.pollNowForEvent(['p2-x']);
  await Promise.all([cyc, ev]);
  assert.ok(log.lastIndexOf('x') > log.lastIndexOf('r3'), `x 의 이벤트 읽기는 주기의 r2 · r3 뒤(순서 ${log.filter((b, i) => b !== log[i - 1]).join('→')})`);
});

test('8회차 엣지 #1 — 재전송이 5회 연속 겹쳐 끝나도 마지막에 합류한 urgent 는 다음 push 에 싣는다', async () => {
  const PU = await import('../src/partfault/push.js');
  PU._resetPushUrgentForTest();
  gateOpen = true; seen.length = 0; holdMode = true;
  const waitReq = async (n) => { for (let i = 0; i < 500 && seen.length < n; i += 1) await new Promise((r) => setTimeout(r, 5)); };
  try {
    const first = PU.pushPartFaultsNow({ reason: 'timer' });
    for (let k = 1; k <= 5; k += 1) {
      await waitReq(k);   // k 번째 회차가 날아가는 중
      PU.pushPartFaultsNow({ reason: k === 5 ? 'event' : 'timer' });   // 합류 — 마지막(5회차 중)은 이벤트 보고
      releaseOne();
    }
    await first;
    assert.equal(seen.length, 5, '5회에서 멈춘다');
    holdMode = false; seen.length = 0;
    await PU.pushPartFaultsNow({ reason: 'timer' });
    assert.deepEqual(seen.map((x) => x.urgent), [true], '상한 출구에서 잃지 않고 다음 push 에 urgent');
  } finally { holdMode = false; releaseAll(); }
});

test('8회차 엣지 #2 — 엣지 이벤트 묶음은 마지막 판정 push(WAN)를 기다리지 않고 끝난다', async (t) => {
  const C = await import('../src/idrac/invCache.js');
  const app = express();
  app.use('/bmc/:box', (req, res) => res.status(404).end());
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { srv.closeAllConnections?.(); srv.close(); });
  const registry = await import('../src/idrac/registry.js');
  registry.importServers([{ id: 'wq-1', name: 'synth-wq1', host: `http://127.0.0.1:${srv.address().port}/bmc/q`, username: 'u', password: 'p', serviceTag: 'SYNTHWQ1' }], 'replace');
  const E = await import('../src/idrac/eventSub.js');
  E._resetEventsForTest();
  let judgeDone = false;
  E._setEventDepsForTest({ debounceMs: 5, judgeFirstHoldMs: 10, judge: async () => { await new Promise((r) => setTimeout(r, 1500)); judgeDone = true; } });   // 끊긴 중앙으로 가는 push 흉내
  try {
    const s = { enabled: true, base: 'https://portal.example.test', secret: 'E'.repeat(43), ctxKey: 'F'.repeat(43) };
    E.acceptEvents(s, { context: E.contextOf(s, 'wq-1'), events: [{ sev: 'critical' }] });
    for (let i = 0; i < 300 && !(E.eventStatus().checkedAt && !E.eventStatus().running); i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.ok(E.eventStatus().checkedAt, '묶음이 끝났다');
    assert.equal(judgeDone, false, 'push 가 끝나기 전에 묶음이 끝난다(다음 이벤트 묶음이 기다리지 않음)');
    for (let i = 0; i < 300 && !judgeDone; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal(judgeDone, true, 'push 는 뒤에서 끝까지 간다');
  } finally { E._setEventDepsForTest(null); E._resetEventsForTest(); C.removeInventory('wq-1'); }
});
