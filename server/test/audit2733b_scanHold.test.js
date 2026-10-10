// v2.733(점검 3회차 C1-02 — v2.732 B4-02 가 만든 회귀): IP 스캔이 시한(SCAN_DEADLINE)을 넘기면 결과를 하나도 남기지 않았고,
//   해제 판정(sweepReleases — 주기×3, 최소 3시간)은 '마지막으로 본 시각' 만 보므로 그 대역의 살아 있는 IP 를 down 으로 바꾸고
//   down 이벤트를 찍었다(재현: $SCRATCH/r3/C1/repro02_scanDeadline.mjs). 엣지 경로(agent/ipScanWorker.js)도 같았다.
// 고친 것: ① 시한 초과·실패한 스캔은 그 에이전트의 '스캔 미완료'(시각·사유·연속 횟수)를 남긴다 ② 해제 판정은 그 에이전트의
//   **완료된** 스캔이 해제 기준 시간 안에 없으면 down 전환을 보류한다(시한 = 기준 + max(기준, 24시간) — 지나면 '미확인 해제' 로 기록)
//   ③ 워커가 시한 전에 찾은 생존 IP 를 부분 결과로 넘겨 마지막 확인 시각만 갱신한다 ④ 엣지는 실패를 기존 결과 보고(/ip-scan-result)에
//   incomplete 필드를 더해 알린다(2.733.0 이상 중앙에만 — 구버전 중앙은 그 보고를 '완료' 로 받는다).
// 실제 scanRunner·scanStore·scanPoller·central 라우터·엣지 워커를 호출해 값으로 판정한다(재시도 메인 재실행은 되살리지 않는다).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';

const TOKEN = 'tok-2733b-shared';
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2733b-'));
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2733b-bin-'));
const PINGLOG = path.join(BIN, 'pids');
// 가짜 ping: 자기 PID 를 남기고 sleep 으로 바뀐다 — 2단계(ping)에서 스캔을 시한까지 묶는다(1단계 TCP 생존은 이미 찾은 뒤).
fs.writeFileSync(path.join(BIN, 'ping'), `#!/bin/sh\necho $$ >> "${PINGLOG}"\nexec sleep 30\n`, { mode: 0o755 });
process.env.PATH = `${BIN}:${process.env.PATH}`;
process.env.CONFIG_DIR = CFG;
process.env.CENTRAL_TOKEN = TOKEN;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'true';
process.env.IPAM_WRITE_DEBOUNCE_MS = '60000';
process.env.IPAM_FPING = '0';
delete process.env.IPAM_SCAN_WORKER;

const H = 3_600_000;
const ss = await import('../src/ipam/scanStore.js');
const runner = await import('../src/ipam/scanRunner.js');
const { config } = await import('../src/config.js');
const LOCAL = ss.LOCAL;

const pids = () => { try { return fs.readFileSync(PINGLOG, 'utf8').split('\n').map((x) => Number(x)).filter((n) => n > 0); } catch { return []; } };
const listen = (handler) => new Promise((r) => { const s = (handler ? http.createServer(handler) : net.createServer((c) => c.end())); s.listen(0, '127.0.0.1', () => r(s)); });
const quiet = async (fn) => { const w = console.warn; const l = console.log; console.warn = () => {}; console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; } };
const hold = (agent) => (ss.releaseHoldStatus?.()?.agents || []).find((a) => a.agent === agent) || null;
const downEvents = (ip) => (ss.getIpHistory(ip)?.events || []).filter((e) => e.type === 'down');

let target; let tport;
before(async () => { target = await listen(); tport = target.address().port; });
after(() => {
  runner._setScanDeadlineOverrideForTest?.(null);
  target?.close();
  for (const pid of pids()) { try { process.kill(pid, 'SIGKILL'); } catch { /* 이미 끝남 */ } }
  fs.rmSync(BIN, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
test('① 중앙(이 포탈) 스캔이 시한을 넘기면 — 미완료 기록 · 부분 결과로 마지막 확인 갱신 · 해제 판정 보류(down 이벤트 없음) · 시한 뒤 미확인 해제', { timeout: 60_000 }, async () => {
  const poller = await import('../src/ipam/scanPoller.js');
  // 마지막 정상 스캔(T0)에서 살아 있던 IP. 그 뒤 스캔은 시한에 걸린다.
  const T0 = Date.now();
  ss.mergeScanResults([{ ip: '10.77.0.5', openPorts: [22], services: ['SSH'], hostname: 'h5' }], T0, LOCAL);
  ss.recordAgentReport(LOCAL, { scanned: 254, alive: 1, durationMs: 1000 });
  const completedAt = ss.getAgentReports()[LOCAL].at;

  // 이번 스캔: 127.0.0.1(열린 포트 — 1단계에서 찾음) + 192.0.2.1(포트 무응답 → 2단계 ping 이 가짜 sleep 으로 시한까지 묶인다)
  ss.saveScanSettings(LOCAL, { enabled: true, ranges: ['127.0.0.1', '192.0.2.1'], ports: [tport], timeoutMs: 3000, concurrency: 2, reverseDns: false, ping: true });
  runner._setScanDeadlineOverrideForTest(2500);
  const st0 = await quiet(() => poller.startScan({ manual: true }));
  assert.equal(st0.ok, true, JSON.stringify(st0));
  for (let i = 0; i < 80 && poller.scanStatus().running; i++) await new Promise((r) => setTimeout(r, 150));
  await new Promise((r) => setTimeout(r, 50));
  runner._setScanDeadlineOverrideForTest(null);
  const st = poller.scanStatus();
  assert.equal(st.running, false);
  assert.match(String(st.lastRun?.error), /데드라인/, JSON.stringify(st.lastRun));
  assert.equal(st.lastRun.incomplete, true, '실패한 스캔이 미완료로 표시되지 않았다');
  assert.equal(st.lastRun.code, 'SCAN_DEADLINE');

  // 미완료 기록 — 마지막 완료 시각(at)은 그대로, incomplete 가 더 새롭다
  const rep = ss.getAgentReports()[LOCAL];
  assert.equal(rep.at, completedAt, '실패한 스캔이 완료 시각을 덮었다');
  assert.equal(rep.incomplete?.code, 'SCAN_DEADLINE', JSON.stringify(rep));
  assert.ok(rep.incomplete.at >= completedAt);
  assert.equal(rep.incomplete.streak, 1);

  // 부분 결과 — 시한 전 1단계에서 찾은 127.0.0.1 의 마지막 확인 시각이 남는다(수정 전: 결과 0)
  const r127 = ss.getScanResults()['127.0.0.1'];
  assert.ok(r127, '시한 전에 찾은 생존 IP 가 결과에 남지 않았다');
  assert.ok(r127.lastSeen >= T0);
  assert.equal(st.lastRun.partialAlive, 1);

  // 해제 판정(releaseTimer 와 같은 함수·같은 임계) — 4시간 뒤: 완료된 스캔이 기준(3시간) 안에 없다 → 보류
  const idleMsByAgent = new Map([[LOCAL, 3 * H]]);
  const changed = ss.sweepReleases(3 * H, { idleMsByAgent, now: T0 + 4 * H });
  assert.equal(ss.getIpHistory('10.77.0.5').status, 'up', '시한 초과 뒤 살아 있는 IP 를 해제(down)로 바꿨다');
  assert.equal(downEvents('10.77.0.5').length, 0, 'down 이벤트가 찍혔다');
  assert.equal(changed, 0);
  const h = hold(LOCAL);
  assert.ok(h, JSON.stringify(ss.releaseHoldStatus?.()));
  assert.equal(h.reason, 'scan-incomplete');
  assert.ok(h.held >= 1);
  assert.equal(h.holdLimitMs, 3 * H + 24 * H);
  assert.equal(h.holdUntil, T0 + 27 * H, '보류 시한 = 가장 오래된 마지막 확인 + 기준 + max(기준, 24시간)');
  assert.equal(h.lastCompletedAt, completedAt);
  assert.ok(ss.releaseHoldStatus().held >= 1);

  // 보류 시한(27시간)이 지나면 — 영원히 보류하지 않는다. down 으로 바꾸되 '미확인' 표지와 사유를 남긴다
  ss.sweepReleases(3 * H, { idleMsByAgent, now: T0 + 28 * H });
  assert.equal(ss.getIpHistory('10.77.0.5').status, 'down');
  const ev = downEvents('10.77.0.5');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].unverified, true);
  assert.equal(ev[0].reason, 'scan-incomplete');
  assert.ok((ss.releaseHoldStatus().expired || 0) >= 1);
});

test('② 완료된 스캔이 해제 기준 시간 안에 있으면 — 예전처럼 해제(보류·미확인 표지 없음)', () => {
  const now = Date.now();
  ss.mergeScanResults([{ ip: '10.78.0.5', openPorts: [22], services: ['SSH'] }], now - 4 * H, 'edge-ok');
  ss.recordAgentReport('edge-ok', { scanned: 254, alive: 0 }); // 방금 끝난 완료 스캔이 그 IP 를 보지 못했다
  const changed = ss.sweepReleases(3 * H, { idleMsByAgent: new Map([['edge-ok', 3 * H]]), now });
  assert.ok(changed >= 1);
  assert.equal(ss.getIpHistory('10.78.0.5').status, 'down');
  const ev = downEvents('10.78.0.5');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].unverified, undefined, '완료 스캔 근거가 있는 해제에 미확인 표지를 붙였다');
  assert.equal(hold('edge-ok'), null);
});

test('③ 스캔 보고 자체가 멈춘 에이전트(완료 스캔이 기준 안에 없음)도 보류 — 사유 no-recent-scan', () => {
  const now = Date.now();
  ss.mergeScanResults([{ ip: '10.80.0.5', openPorts: [22], services: ['SSH'] }], now - 5 * H, 'edge-silent');
  ss.sweepReleases(3 * H, { idleMsByAgent: new Map([['edge-silent', 3 * H]]), now });
  assert.equal(ss.getIpHistory('10.80.0.5').status, 'up');
  assert.equal(downEvents('10.80.0.5').length, 0);
  assert.equal(hold('edge-silent')?.reason, 'no-recent-scan');
  // 다른 에이전트만 보는 sweep(이 포탈 스캔 직후의 { agent }) 은 남의 보류 기록을 지우지 않는다
  ss.sweepReleases(3 * H, { agent: LOCAL, now });
  assert.equal(hold('edge-silent')?.reason, 'no-recent-scan');
});

// ─────────────────────────────────────────────────────────────────────────────
test('④ 엣지: 시한 초과를 중앙(2.733.0 이상)에 미완료로 보고 — 부분 생존 IP 포함 · 구버전 중앙에는 보내지 않는다', { timeout: 60_000 }, async () => {
  const posted = [];
  let version = '2.733.0';
  const central = await listen((q, r) => {
    const ch = []; q.on('data', (c) => ch.push(c));
    q.on('end', () => {
      const p = q.url.split('?')[0];
      let json = { ok: true };
      if (p === '/api/central/health-probe') json = { ok: true, version };
      if (p === '/api/central/ip-scan-assignment') json = { ok: true, assigned: true, ranges: ['127.0.0.1', '192.0.2.1'], ports: [tport], concurrency: 2, timeoutMs: 3000, reverseDns: false, ping: true, intervalMs: 3_600_000 };
      if (p === '/api/central/ip-scan-result') { posted.push(JSON.parse(Buffer.concat(ch).toString() || '{}')); json = { ok: true, merged: 1, incomplete: true }; }
      r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify(json));
    });
  });
  config.agent.centralUrl = `http://127.0.0.1:${central.address().port}`;
  config.agent.centralToken = TOKEN;
  config.agent.name = 'edge-2733b';
  const w = await import('../src/agent/ipScanWorker.js');
  const cap = await import('../src/agent/centralStatusOnly.js');
  try {
    cap._resetStatusOnlyCapForTest();
    runner._setScanDeadlineOverrideForTest(2500);
    const r1 = await quiet(() => w.runIpScanAgentOnce());
    assert.match(String(r1.error), /데드라인/, JSON.stringify(r1));
    assert.equal(r1.phase, 'scan');
    assert.equal(posted.length, 1, '시한 초과를 중앙에 알리지 않았다(수정 전: 아무 보고도 없음)');
    const b = posted[0];
    assert.equal(b.incomplete?.code, 'SCAN_DEADLINE', JSON.stringify(b));
    assert.ok(Array.isArray(b.alive) && b.alive.some((x) => x.ip === '127.0.0.1'), '시한 전에 찾은 생존 IP 를 싣지 않았다');
    assert.equal(r1.incompleteReport?.sent, true, JSON.stringify(r1));

    // 구버전 중앙(미완료 필드를 모른다 — 보내면 완료 보고로 기록된다) → 보내지 않고 사유를 남긴다
    version = '2.732.0';
    cap._resetStatusOnlyCapForTest();
    w._resetIpScanAgentForTest();
    const r2 = await quiet(() => w.runIpScanAgentOnce());
    assert.equal(posted.length, 1, '구버전 중앙에 미완료 보고를 보냈다');
    assert.equal(r2.incompleteReport?.sent, false);
    assert.equal(r2.incompleteReport?.reason, 'central-too-old');
  } finally {
    runner._setScanDeadlineOverrideForTest(null);
    central.close();
    config.agent.centralUrl = '';
  }
});

// ─────────────────────────────────────────────────────────────────────────────
test('⑤ 중앙 수신(/api/central/ip-scan-result): incomplete 보고는 완료로 기록하지 않고 부분 결과만 병합 → 그 엣지 IP 해제 보류 · 다음 완료 보고가 미완료를 지운다', async () => {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use('/api/central', centralRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api/central`;
  const post = (body) => fetch(`${base}/ip-scan-result`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': TOKEN }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  try {
    const now = Date.now();
    ss.mergeScanResults([{ ip: '10.79.0.9', openPorts: [22], services: ['SSH'] }], now - 4 * H, 'edge-c');
    ss.mergeScanResults([{ ip: '10.79.0.7', openPorts: [22, 443], services: ['SSH', 'HTTPS'], hostname: 'h7' }], now - 4 * H, 'edge-c');
    const runsBefore = ss.getScanRuns(200).filter((x) => x.agent === 'edge-c').length;
    const r = await quiet(() => post({ agent: 'edge-c', scanned: 40, alive: [{ ip: '10.79.0.5', openPorts: [22], services: ['SSH'] }, { ip: '10.79.0.7', openPorts: [22], services: ['SSH'], hostname: '' }], incomplete: { code: 'SCAN_DEADLINE', reason: '스캔 데드라인(1200s) 초과 — 자식 종료', total: 254 } }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.incomplete, true, JSON.stringify(r.body));
    const rep = ss.getAgentReports()['edge-c'];
    assert.equal(rep?.incomplete?.code, 'SCAN_DEADLINE', JSON.stringify(rep));
    assert.equal(rep.at ?? null, null, '미완료 보고를 완료 시각으로 기록했다');
    assert.equal(ss.getScanRuns(200).filter((x) => x.agent === 'edge-c').length, runsBefore, '미완료 보고를 완료된 스캔 이력에 넣었다');
    assert.ok(ss.getScanResults()['10.79.0.5'], '부분 결과(생존 IP)를 받지 않았다');
    // 부분 결과는 이미 있는 IP 의 '마지막 확인' 만 갱신한다 — 호스트명(부분 결과엔 없다)·포트를 지우지 않는다
    const r7 = ss.getScanResults()['10.79.0.7'];
    assert.equal(r7.hostname, 'h7', '부분 결과가 호스트명을 지웠다');
    assert.deepEqual(r7.openPorts, [22, 443], '부분 결과가 포트 목록을 바꿨다');
    assert.ok(r7.lastSeen >= now, '부분 결과가 마지막 확인 시각을 갱신하지 않았다');
    assert.ok(ss.getIpHistory('10.79.0.7').lastSeen >= now);
    // 그 엣지의 IP 는 해제 판정에서 보류
    ss.sweepReleases(3 * H, { idleMsByAgent: new Map([['edge-c', 3 * H]]), now });
    assert.equal(ss.getIpHistory('10.79.0.9').status, 'up');
    assert.equal(hold('edge-c')?.reason, 'scan-incomplete');
    // 다음 완료 보고 → 미완료가 지워지고 그 완료 스캔을 근거로 예전처럼 해제
    const ok = await quiet(() => post({ agent: 'edge-c', scanned: 254, alive: [{ ip: '10.79.0.5', openPorts: [22], services: ['SSH'] }] }));
    assert.equal(ok.status, 200);
    assert.equal(ss.getAgentReports()['edge-c'].incomplete, undefined);
    ss.sweepReleases(3 * H, { idleMsByAgent: new Map([['edge-c', 3 * H]]), now: Date.now() });
    assert.equal(ss.getIpHistory('10.79.0.9').status, 'down');
    assert.equal(hold('edge-c'), null);
  } finally { srv.close(); }
});
