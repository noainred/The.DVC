/**
 * test/audit2733f_sanPull.test.js — 점검 3회차(v2.733) 그룹 f · C4-02.
 *
 * 엣지 SAN 설정 pull(agent/sanSwitchConfigPull.js)이 '지금 수집'(collectNow) 장비를 한 대씩 끝까지 await 한 **뒤에야** 같은 응답의
 * 연결 테스트 대행(testNow)을 시작했다 — 중앙 테스트 시한(startedAt 기준 대기 10분 + 결과 5분)을 수집 시간이 먹고, 그동안 다음 pull 도
 * 재진입 가드에 막혔다. 실제 pullSanSwitchConfigNow 를 목 중앙(HTTP)·응답 없는 스위치(SSH 배너를 보내지 않는 TCP 서버)로 부른다.
 *  ① pull 은 수집을 기다리지 않는다 · 테스트 결과가 수집 결과 push 보다 먼저 회신된다 · 바로 이어진 pull 이 막히지 않는다
 *  ② 같은 호스트의 테스트·수집은 SSH 세션을 겹치지 않는다(동시 세션 최대 1) — 그래도 테스트가 먼저다
 *  ③ 상태(collectJob·collectRun)가 진행·결과를 말한다(무음 금지)
 * 기준 시각에 Date.now() 를 판정 경계로 쓰지 않는다 — 사건의 **순서**만 본다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2733f-san-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSH_READY_TIMEOUT_MS = '1500';      // 응답 없는 스위치 한 대 ≈ 1.5초(운영 기본 60초의 축소)
process.env.SANSW_DEVICE_TIMEOUT_MS = '30000';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

/**
 * SSH 배너를 보내지 않는 스위치 — SSH 세션(클라이언트 식별 문자열이 온 연결)의 동시 개수 최대값과 도착 순서(label)를 센다.
 * 같은 호스트의 두 포트가 st 를 함께 쓰면 '그 호스트 전체' 의 동시 세션·순서가 된다.
 */
async function hangSwitch(host, { st = { active: 0, max: 0, sessions: 0, order: [] }, label = '' } = {}) {
  const srv = net.createServer((s) => {
    let counted = false;
    s.on('error', () => {});
    s.once('data', (d) => { if (String(d).startsWith('SSH-')) { counted = true; st.sessions++; st.active++; st.max = Math.max(st.max, st.active); st.order.push(label); } });
    s.on('close', () => { if (counted) st.active--; });
  });
  await new Promise((r) => srv.listen(0, host, r));
  return { srv, st, port: srv.address().port };
}

const servers = [];
after(() => { for (const s of servers) s.close(); fs.rmSync(DIR, { recursive: true, force: true }); });

/** 목 중앙 — 사건 순서(ev)를 기록한다. */
async function mockCentral(payload) {
  const ev = [];
  let seq = 0;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url.startsWith('/api/central/sanswitch-config')) { ev.push({ n: ++seq, kind: 'config' }); res.end(JSON.stringify(payload())); return; }
      if (req.url.startsWith('/api/central/sanswitch-test-result')) { ev.push({ n: ++seq, kind: 'test-result' }); res.end('{"ok":true}'); return; }
      if (req.url.startsWith('/api/central/sanswitch-data')) { ev.push({ n: ++seq, kind: 'data' }); res.end('{"ok":true}'); return; }
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv);
  return { ev, url: `http://127.0.0.1:${srv.address().port}` };
}

const { config } = await import('../src/config.js');
const pull = await import('../src/agent/sanSwitchConfigPull.js');

const dev = (id, host, port) => ({ id, name: id, type: 'brocade', host, sshPort: port, username: 'admin', password: 'x', collectMethod: 'ssh', agent: 'edge-a' });
const waitFor = async (pred, ms = 20_000) => { const until = Date.now() + ms; while (!pred() && Date.now() < until) await new Promise((r) => setTimeout(r, 25)); return pred(); };

test('C4-02 ① pull 은 수집을 기다리지 않고, 테스트 결과가 수집 push 보다 먼저 온다 · 다음 pull 이 막히지 않는다', async () => {
  const sw = await hangSwitch('127.0.0.1'); servers.push(sw.srv);
  const sw2 = await hangSwitch('127.0.0.2'); servers.push(sw2.srv);   // 테스트 대상은 다른 호스트
  const devices = [dev('s1', '127.0.0.1', sw.port), dev('s2', '127.0.0.1', sw.port)];
  let first = true;
  const c = await mockCentral(() => {
    if (!first) return { ok: true, devices };
    first = false;
    return { ok: true, devices, collectNow: ['s1', 's2'], testNow: [{ id: 'run-1', device: dev('t1', '127.0.0.2', sw2.port), timeoutMs: 30_000 }] };
  });
  config.agent.centralUrl = c.url; config.agent.centralToken = 'tok'; config.agent.name = 'edge-a';
  try {
    const r = await pull.pullSanSwitchConfigNow();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.collectRequested, 2);
    // 수정 전: pull 이 두 대를 끝까지 수집하고 push 한 뒤에 돌아왔다(그 사이 'data' 가 이미 와 있다)
    assert.equal(c.ev.filter((e) => e.kind === 'data').length, 0, 'pull 이 수집·push 를 기다렸다');
    assert.equal(pull.sanSwitchConfigPullStatus().collectJob.running, true, '수집 작업은 뒤에서 돌고 있어야 한다');
    // 바로 이어진 pull(다음 주기)은 막히지 않는다 — 수정 전: '이전 pull 진행 중(겹침 방지)'
    const r2 = await pull.pullSanSwitchConfigNow();
    assert.equal(r2.ok, true, `다음 pull 이 수집에 막혔다: ${JSON.stringify(r2)}`);
    assert.ok(await waitFor(() => c.ev.some((e) => e.kind === 'data') && c.ev.some((e) => e.kind === 'test-result')), JSON.stringify(c.ev));
    const tr = c.ev.find((e) => e.kind === 'test-result').n;
    const data = c.ev.find((e) => e.kind === 'data').n;
    assert.ok(tr < data, `테스트 결과(${tr})가 수집 결과 push(${data})보다 먼저여야 한다 — ${JSON.stringify(c.ev)}`);
    assert.ok(await waitFor(() => !pull.sanSwitchConfigPullStatus().collectJob.running));
    const st = pull.sanSwitchConfigPullStatus();
    assert.equal(st.collectRun.requested, 2);
    assert.equal(st.collectRun.collected, 2, '수집 시도 2대(실패 스냅샷도 결과다)');
    assert.equal(st.collectJob.queued, 0);
    assert.equal(sw.st.max, 1, '수집은 한 대씩(동시 세션 1)');
  } finally { config.agent.centralUrl = ''; }
});

test('C4-02 ② 같은 호스트의 테스트·수집은 세션을 겹치지 않는다 — 그래도 테스트가 먼저다', async () => {
  // 같은 호스트(127.0.0.1)의 두 포트 — 수집 장비는 A, 테스트(수정 중인 값으로 접속)는 B. 순서·동시 세션은 호스트 전체로 센다.
  const shared = { active: 0, max: 0, sessions: 0, order: [] };
  const sw = await hangSwitch('127.0.0.1', { st: shared, label: 'collect' }); servers.push(sw.srv);
  const swT = await hangSwitch('127.0.0.1', { st: shared, label: 'test' }); servers.push(swT.srv);
  const devices = [dev('s3', '127.0.0.1', sw.port), dev('s4', '127.0.0.1', sw.port)];
  let first = true;
  const c = await mockCentral(() => {
    if (!first) return { ok: true, devices };
    first = false;
    return { ok: true, devices, collectNow: ['s3', 's4'], testNow: [{ id: 'run-2', device: dev('s3', '127.0.0.1', swT.port), timeoutMs: 30_000 }] };
  });
  config.agent.centralUrl = c.url; config.agent.centralToken = 'tok'; config.agent.name = 'edge-a';
  try {
    const r = await pull.pullSanSwitchConfigNow();
    assert.equal(r.ok, true);
    assert.ok(await waitFor(() => c.ev.some((e) => e.kind === 'data') && c.ev.some((e) => e.kind === 'test-result') && !pull.sanSwitchConfigPullStatus().collectJob.running), JSON.stringify(c.ev));
    const tr = c.ev.find((e) => e.kind === 'test-result').n;
    const data = c.ev.find((e) => e.kind === 'data').n;
    assert.ok(tr < data, `테스트 결과가 수집 결과 push 보다 먼저여야 한다 — ${JSON.stringify(c.ev)}`);
    assert.deepEqual(shared.order, ['test', 'collect', 'collect'], '같은 호스트에서는 먼저 받은 테스트가 수집보다 먼저 세션을 연다');
    assert.equal(shared.max, 1, `같은 호스트에 SSH 세션이 겹쳤다(최대 ${shared.max})`);
  } finally { config.agent.centralUrl = ''; }
});

test('C4-02 ③ 수집 중 다시 온 같은 장비 요청은 한 번만 — 대기열이 중복을 받지 않는다', async () => {
  const sw = await hangSwitch('127.0.0.1'); servers.push(sw.srv);
  const devices = [dev('s5', '127.0.0.1', sw.port)];
  const c = await mockCentral(() => ({ ok: true, devices, collectNow: ['s5'] }));
  config.agent.centralUrl = c.url; config.agent.centralToken = 'tok'; config.agent.name = 'edge-a';
  try {
    const a = await pull.pullSanSwitchConfigNow();
    const b = await pull.pullSanSwitchConfigNow();   // 같은 장비를 다시 요청(중앙이 시한 뒤 재인출한 경우)
    assert.equal(a.collectQueued, 1);
    assert.equal(b.collectQueued, 0, '이미 수집 중인 장비를 다시 대기열에 넣었다');
    assert.equal(pull.sanSwitchConfigPullStatus().collectAlready, 1);
    assert.ok(await waitFor(() => !pull.sanSwitchConfigPullStatus().collectJob.running));
    assert.equal(pull.sanSwitchConfigPullStatus().collectRun.requested, 1);
    assert.equal(sw.st.sessions, 1);
  } finally { config.agent.centralUrl = ''; }
});
