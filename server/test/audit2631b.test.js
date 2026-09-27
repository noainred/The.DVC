// v2.631 감사 그룹 b — 회귀 고정.
//   EDGE2631-01 중앙 설정 파일 손상 → 배포 pull 503 settingsUnreadable(엣지 사본 유지) · EDGE2631-02 bmstor PUSH 시한 대수 비례 ·
//   EDGE2631-03 SAN 사용량 push 404 판정 · A6-2631-01 CVP '지금 수집' 기준선·완료는 엣지 시계 원본 ·
//   AX3-01 원격 게이트웨이 WS maxPayload · AX3-02 프록시 저장 시 배포 주소 차단 대역 검사.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2631b-'));
process.env.CONFIG_DIR = tmp;
process.env.CENTRAL_TOKEN = 'ctok-2631b';
process.env.COLLECTOR_TOKEN = 'coltok-2631b';
delete process.env.SSRF_ALLOW_LOOPBACK;
delete process.env.PARTFAULT_ENABLED;
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

// EDGE2631-01: 배포되는 중앙 설정 파일을 **손상된 채로** 둔다(모듈을 불러오기 전에).
const SETTINGS_FILES = ['bmusage-distribute.json', 'bmusage-settings.json', 'vmseries.json', 'curuser-settings.json', 'partfault-settings.json', 'cvp-settings.json', 'rma-schedules.json'];
for (const f of SETTINGS_FILES) fs.writeFileSync(path.join(tmp, f), '{ 손상된 JSON');

const servers = [];
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
let base;
before(async () => {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use('/api/central', express.json({ limit: '16mb' }), centralRouter);
  const srv = http.createServer(app);
  servers.push(srv);
  base = `http://127.0.0.1:${await listen(srv)}/api/central`;
});
after(() => { for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch { /* */ } } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const cget = (p, tok = 'ctok-2631b') => fetch(`${base}${p}`, { headers: { 'X-Central-Token': tok, 'X-Agent-Name': 'edge-a' } });
const PULLS = ['/bmusage-config', '/vmseries-config', '/curuser-config', '/partfault-config'];

// ── EDGE2631-01 ────────────────────────────────────────────────────────────
test('EDGE2631-01: 설정 파일이 손상됐으면 배포 pull 4종이 503 settingsUnreadable(기본값 200 금지)', async () => {
  for (const p of PULLS) {
    const r = await cget(`${p}?agent=edge-a`);
    const j = await r.json();
    assert.equal(r.status, 503, `${p} 는 503 이어야 한다(수정 전: 200 + 기본값/distribute:false) — ${JSON.stringify(j)}`);
    assert.equal(j.reason, 'settingsUnreadable');
    assert.equal(j.ok, false);
    assert.ok(!('settings' in j) && !('distribute' in j), '기본값을 싣지 않는다');
    assert.ok(/손상 보존본/.test(j.detail), j.detail);
  }
});

test('EDGE2631-01: 재시작 뒤(파일 없음 + 손상 보존본만)에도 못 읽은 것 — 저장·정상 파일이면 풀린다', async () => {
  // 첫 로드가 손상본을 .corrupt.* 로 옮겼다 — 원본이 없다.
  for (const f of ['vmseries.json', 'curuser-settings.json', 'partfault-settings.json']) {
    assert.ok(!fs.existsSync(path.join(tmp, f)), `${f} 는 보존본으로 옮겨졌어야 한다`);
    assert.ok(fs.readdirSync(tmp).some((n) => n.startsWith(`${f}.corrupt.`)));
  }
  const cu = await import('../src/curuser/settings.js');
  const pf = await import('../src/partfault/settings.js');
  const vs = await import('../src/vmseries/settings.js');
  cu._resetForTest(); pf._resetForTest();   // 재시작 흉내
  for (const p of ['/vmseries-config', '/curuser-config', '/partfault-config']) {
    assert.equal((await cget(`${p}?agent=edge-a`)).status, 503, `${p}: 보존본만 있으면 여전히 503`);
  }
  // 관리자 저장 → 풀린다
  vs.saveVmSeriesSettings({ enabled: true });
  cu.save({ enabled: true });
  pf.savePartFaultSettings({ enabled: true });
  assert.equal(vs.vmSeriesSettingsLoadError(), null);
  assert.equal(cu.curUserSettingsLoadError(), null);
  assert.equal(pf.partFaultSettingsLoadError(), null);
  for (const p of ['/vmseries-config', '/curuser-config', '/partfault-config']) {
    const r = await cget(`${p}?agent=edge-a`);
    assert.equal(r.status, 200, p);
    const j = await r.json();
    assert.equal(j.settings.enabled, true, `${p}: 저장한 값이 내려간다`);
  }
});

test('EDGE2631-01: bmusage 는 배포 설정·로컬 설정 둘 다 읽어야 200', async () => {
  const bm = await import('../src/bmusage/settings.js');
  assert.ok(bm.bmUsageSettingsLoadError(), '둘 다 손상');
  bm.saveDistribution({ enabled: true });
  assert.ok(bm.bmUsageSettingsLoadError(), '로컬 설정이 아직 손상(보존본만)');
  assert.ok(/bmusage-settings/.test(bm.bmUsageSettingsLoadError().reason));
  assert.equal((await cget('/bmusage-config?agent=edge-a')).status, 503);
  fs.writeFileSync(path.join(tmp, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { 'vc-a': true } }));
  assert.equal(bm.bmUsageSettingsLoadError(), null);
  const r = await cget('/bmusage-config?agent=edge-a');
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.distribute, true);
  assert.equal(j.settings.enabled, true);
  // 처음부터 없던 설정(보존본 없음)은 오류가 아니다 — 기본값이 곧 관리자가 정한 값이다.
  const { makeSettingsLoadError } = await import('../src/util/settingsLoadError.js');
  const le = makeSettingsLoadError(() => path.join(tmp, 'never-existed.json'));
  le.missing();
  assert.equal(le.get(), null);
});

test('EDGE2631-01: cvp-config 는 설정이 손상이면 settings 를 싣지 않는다(목록·지금 수집은 그대로)', async () => {
  const r = await cget('/cvp-config?agent=edge-a');
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.ok(!('settings' in j), '기본값 설정을 싣지 않는다(엣지 applyCentralSettings 는 settings 가 없으면 현장 값을 둔다)');
  assert.ok(j.settingsUnreadable && /보존본|설정 파일/.test(j.settingsUnreadable.reason), JSON.stringify(j));
  assert.ok(Array.isArray(j.servers));
  const cs = await import('../src/cvp/settings.js');
  cs.saveSettings({});
  const j2 = await (await cget('/cvp-config?agent=edge-a')).json();
  assert.ok(j2.settings && typeof j2.settings === 'object');
  assert.ok(!('settingsUnreadable' in j2));
  // 엣지는 settings 가 없으면 적용하지 않는다
  assert.equal(cs.applyCentralSettings(undefined), false);
});

test('EDGE2631-01: rma-poll 은 스케줄이 손상이면 결과를 받기 전에 503(엣지 outbox 유지)', async () => {
  const { issueAgentToken } = await import('../src/central/agentTokens.js');
  const tok = issueAgentToken('edge-rma31').token;
  const HA = { 'Content-Type': 'application/json', 'X-Central-Token': tok };
  const r = await fetch(`${base}/rma-poll`, { method: 'POST', headers: HA, body: JSON.stringify({ instance: 'i0', wait: 0, results: [{ id: 't_x', status: 'ok' }] }) });
  const j = await r.json();
  assert.equal(r.status, 503, `수정 전: 200 + 빈 스케줄 배포 · 결과 폐기 — ${JSON.stringify(j)}`);
  assert.equal(j.reason, 'settingsUnreadable');
  assert.ok(!('schedule' in j) && !('accepted' in j));
  const sch = await import('../src/rma/schedules.js');
  sch.upsertScheduleItem('edge-rma31', { name: 'gw', test: 'ping', args: { host: '10.0.0.1' }, intervalSec: 300 });
  assert.equal(sch.rmaSchedulesLoadError(), null);
  const r2 = await fetch(`${base}/rma-poll`, { method: 'POST', headers: HA, body: JSON.stringify({ instance: 'i0', wait: 0 }) });
  const j2 = await r2.json();
  assert.equal(r2.status, 200, JSON.stringify(j2));
  assert.equal(j2.schedule.tests.length, 1);
});

test('EDGE2631-01: 엣지 pull 은 비-2xx 를 실패로 본다(사본을 지우지 않는다) — 소스 확인', () => {
  for (const f of ['agent/bmUsageConfigPull.js', 'agent/vmSeriesConfigPull.js', 'agent/curUserConfigPull.js', 'agent/partFaultConfigPull.js']) {
    const s = stripComments(read(f));
    const iNotOk = s.search(/if \(!res\.ok\) throw/);
    assert.ok(iNotOk > 0, `${f}: 비-2xx 면 throw`);
    for (const call of ['clearCentralBmUsage()', 'applyCentralBmUsage(', 'saveVmSeriesSettings(', 'applyCentral(']) {
      const i = s.indexOf(call, s.search(/resilientFetch\(/));
      if (i >= 0) assert.ok(i > iNotOk, `${f}: ${call} 는 비-2xx 판정 뒤에만`);
    }
  }
  const rma = stripComments(read('rma/agent.js'));
  assert.ok(/if \(!r\.ok\) throw/.test(rma), 'rma/agent 는 비-2xx 면 throw(outbox 유지)');
});

// ── EDGE2631-02 ────────────────────────────────────────────────────────────
test('EDGE2631-02: bmstor PUSH 시한은 서버 수에 비례(60초 + 서버당 20초, 상한 10분) · 예전 180초가 하한', async () => {
  const { pushTimeoutMsFor } = await import('../src/bmstor/poller.js');
  assert.equal(pushTimeoutMsFor(1), 180_000, '적은 대수에서 예전보다 짧아지지 않는다');
  assert.equal(pushTimeoutMsFor(10), 260_000);
  assert.equal(pushTimeoutMsFor(200), 600_000, '상한 10분(jobs 경로와 같은 식)');
  assert.equal(pushTimeoutMsFor(1000), 600_000);
  assert.equal(pushTimeoutMsFor(20, 900_000), 900_000, '하한(env)이 더 크면 하한');
  const s = stripComments(read('bmstor/poller.js'));
  assert.ok(/timeoutMs:\s*pushTimeoutMsFor\(servers\.length\)/.test(s), 'collectViaEdge 가 대수 비례 시한을 쓴다');
  assert.ok(!/timeoutMs:\s*PUSH_TIMEOUT_MS\b/.test(s), '고정 시한을 직접 쓰지 않는다');
});

// ── A6-2631-01 ─────────────────────────────────────────────────────────────
test('A6-2631-01: CVP 상태는 엣지 시계 원본을 싣고, 기준선·완료 판정이 그 값을 쓴다(빠른 시계의 재전송이 완료로 보이지 않는다)', async () => {
  const edge = await import('../src/central/cvpEdge.js');
  const cr = await import('../src/cvp/collectRequests.js');
  cr._resetForTest();
  const now = Date.UTC(2026, 8, 27, 3, 30, 0);   // 고정 기준 시각(Date.now() 를 기준으로 쓰지 않는다)
  const ahead = 10 * 60_000;
  const T = now + ahead;                          // 엣지 시계가 10분 빠르다
  const st1 = edge.cleanStatus({ cvpId: 'cvp-31', ok: true, collectedAt: T }, now);
  assert.equal(st1.collectedAt, now, '표시용은 예전처럼 수신 시각으로 clamp');
  assert.equal(st1.edgeCollectedAt, T, '원본 엣지 시각');
  assert.equal(st1.edgeClockAheadMs, ahead);
  assert.equal(edge.cleanStatus({ cvpId: 'x', collectedAt: now - 1000 }, now).edgeClockAheadMs, undefined, '앞서지 않으면 싣지 않는다');
  assert.equal(edge.cleanStatus({ cvpId: 'x', collectedAt: 'abc' }, now).edgeCollectedAt, null, '못 읽으면 null(0 금지)');
  edge.saveEdgeCvpStatus('edge-cvp', [st1], { now });
  cr.requestCvpCollect('cvp-31', 'edge-cvp');
  assert.equal(cr.takeCvpRequests('edge-cvp').length, 1);
  // 재수집 전 같은 수집 시각의 상태 push(1분 뒤 수신) — 수정 전에는 clamp 값이 수신 시각으로 올라가 완료 처리됐다.
  const now2 = now + 60_000;
  edge.saveEdgeCvpStatus('edge-cvp', [edge.cleanStatus({ cvpId: 'cvp-31', ok: true, collectedAt: T }, now2)], { now: now2 });
  assert.equal(cr.hasPendingCvpRequest('cvp-31'), true, '새 수집 없이 완료되면 안 된다');
  // 실제 새 수집(엣지 시계로 더 늦은 값) → 완료
  const now3 = now + 120_000;
  edge.saveEdgeCvpStatus('edge-cvp', [edge.cleanStatus({ cvpId: 'cvp-31', ok: true, collectedAt: T + 90_000 }, now3)], { now: now3 });
  assert.equal(cr.hasPendingCvpRequest('cvp-31'), false, '새 수집이 도착하면 완료');
  cr._resetForTest();
});

// ── AX3-01 ─────────────────────────────────────────────────────────────────
test('AX3-01: 원격 SSH·RDP 게이트웨이 WebSocketServer 에 maxPayload(ws 기본 100MiB 금지)', async () => {
  const ssh = await import('../src/proxy/sshGateway.js');
  const gd = await import('../src/proxy/guacdTunnel.js');
  assert.equal(ssh.SSH_WS_MAX_PAYLOAD, 256 * 1024);
  assert.equal(gd.GUAC_WS_MAX_PAYLOAD, 4 * 1024 * 1024);
  for (const [f, name] of [['proxy/sshGateway.js', 'SSH_WS_MAX_PAYLOAD'], ['proxy/guacdTunnel.js', 'GUAC_WS_MAX_PAYLOAD']]) {
    const s = stripComments(read(f));
    const all = s.match(/new WebSocketServer\(\{[^}]*\}\)/g) || [];
    assert.ok(all.length >= 1, f);
    for (const m of all) assert.ok(m.includes(`maxPayload: ${name}`), `${f}: ${m}`);
  }
  // 실제 동작: 상한을 넘는 프레임은 1009 로 닫힌다(ws 계약 — 이 상한값으로 서버를 띄워 확인)
  const { WebSocketServer, WebSocket } = await import('ws');
  const srv = http.createServer();
  const wss = new WebSocketServer({ server: srv, maxPayload: ssh.SSH_WS_MAX_PAYLOAD });
  const got = [];
  wss.on('connection', (ws) => { ws.on('message', (m) => got.push(m.length)); ws.on('error', () => {}); });
  const port = await listen(srv);
  const code = await new Promise((resolve) => {
    const c = new WebSocket(`ws://127.0.0.1:${port}`);
    c.on('open', () => c.send(Buffer.alloc(ssh.SSH_WS_MAX_PAYLOAD + 1, 97)));
    c.on('close', (cd) => resolve(cd));
    c.on('error', () => {});
  });
  assert.equal(code, 1009);
  assert.equal(got.length, 0, '초과 프레임은 처리되지 않는다');
  wss.close(); srv.close();
});

// ── AX3-02 ─────────────────────────────────────────────────────────────────
test('AX3-02: 프록시 저장이 배포 SSH 호스트·Data Plane URL 의 차단 대역을 검사한다(시험 라우트와 대칭)', async () => {
  const reg = await import('../src/proxy/registry.js');
  let r = reg.saveProxy({ name: 'p1', deploy: { host: '169.254.169.254' } });
  assert.equal(r.ok, false, '메타데이터 주소 배포 호스트 저장 거부');
  assert.ok(/배포 SSH 호스트가 차단/.test(r.reason), r.reason);
  r = reg.saveProxy({ name: 'p2', dataplane: { url: 'http://127.0.0.1:5555' } });
  assert.equal(r.ok, false, '루프백 Data Plane URL 저장 거부');
  assert.ok(/Data Plane URL 이 차단/.test(r.reason), r.reason);
  r = reg.saveProxy({ name: 'p3', deploy: { host: '10.20.1.5' }, dataplane: { url: 'http://10.20.1.5:5555' } });
  assert.equal(r.ok, true, '사내 대역은 허용');
  r = reg.saveProxy({ name: 'p4', deploy: { host: '' } });
  assert.equal(r.ok, true, '비어 있으면 통과(미설정 허용)');
  assert.throws(() => reg.saveConfig({ deploy: { host: '0.0.0.0' } }), (e) => e.status === 400 && /차단/.test(e.message));
  assert.throws(() => reg.saveConfig({ dataplane: { url: 'http://[::1]:5555' } }), (e) => e.status === 400);
});

// ── EDGE2631-03 (마지막 — 엣지 config 를 바꾼다) ─────────────────────────────
test('EDGE2631-03: SAN 사용량 push 404 는 central 꺼짐과 엔드포인트 없음을 가른다', async () => {
  const { savePerfSample, available, _resetForTest } = await import('../src/sanswitch/perfDb.js');
  if (!(await available())) return;
  _resetForTest();
  const t0 = Date.UTC(2026, 8, 27, 3, 30, 0);
  await savePerfSample('sw-31', t0 - 60_000, { 0: 1000 }, [], 3650);
  await savePerfSample('sw-31', t0, { 0: 1100 }, [], 3650);
  let mode = 'disabled';
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (mode === 'disabled') { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, reason: 'central 비활성화' })); }
      else { res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('<pre>Cannot POST /api/central/sanswitch-perf</pre>'); }
    });
  });
  const port = await listen(srv);
  const { config } = await import('../src/config.js');
  const prev = { ...config.agent };
  try {
    config.agent.centralUrl = `http://127.0.0.1:${port}`;
    config.agent.centralToken = 'tok';
    config.agent.name = 'agent-31';
    const { pushPerfNow, sanSwitchPerfPushStatus } = await import('../src/sanswitch/perfPush.js');
    let r = await pushPerfNow();
    assert.equal(r.ok, false);
    let st = sanSwitchPerfPushStatus();
    assert.ok(/central 기능이 꺼져/.test(st.error), `수정 전: 'v2.423 미만' 으로 오진 — ${st.error}`);
    assert.ok(!/v2\.423/.test(st.error));
    assert.equal(st.kind, 'central-disabled');
    mode = 'html';
    r = await pushPerfNow();
    st = sanSwitchPerfPushStatus();
    assert.ok(/엔드포인트가 없습니다/.test(st.error), st.error);
    assert.equal(st.kind, 'central-no-endpoint');
  } finally { Object.assign(config.agent, prev); srv.close(); _resetForTest(); }
});
