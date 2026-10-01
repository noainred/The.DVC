/**
 * v2.681 감사 R2 그룹 b — 엣지 → 중앙 헤더·중앙 수신 4건.
 *
 * R2F-01: `X-Agent-Hostname: os.hostname()` 원문은 비-Latin1 호스트명(한글 Windows 엣지)에서 undici 가 요청을 보내기 **전에**
 *   던졌다 — 실제 fetch 로 목 서버에 보내 요청이 도착하는지 본다(원문 헤더는 던지는 것도 함께 고정 — 전제 확인).
 * R2F-02: GPU 게스트 수집 진단의 상한 퇴출이 검증 여부를 보지 않았다 — 미검증 이름 256개가 검증된 엣지 진단을 밀어냈다.
 * R2F-03: 통신 점검 엣지 보고가 중앙 DB 를 못 써도 ok:true · stored:N 이었다 → dbUnavailable + 라우트 503.
 * R2F-04: vmseries·curuser 설정 배포의 '이 엣지 vCenter' 가 인벤토리 캐시 소유만이라 캐시가 비면 빈 대상을 200 으로 내렸다
 *   → 등록부 위임과 합집합, 그래도 비면 필드를 빼고 엣지는 '필드 없음 = 직전 유지'.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2681b-'));
process.env.CONFIG_DIR = DIR;
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.CENTRAL_TOKEN = 'ctok-2681b';
process.env.DATA_SOURCE = 'mock';
process.env.SVCMON_WORKERS = '0';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

let central; let centralPort;
before(async () => {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use(express.json());
  app.use('/api/central', centralRouter);
  central = http.createServer(app);
  centralPort = await listen(central);
});
after(() => { try { central?.close(); } catch { /* */ } fs.rmSync(DIR, { recursive: true, force: true }); });

/* ── R2F-01 ── */
test('R2F-01 — hostnameHeaderValue: ASCII 는 원문, 비-ASCII 는 퍼센트 인코딩, 비거나 너무 길면 싣지 않는다', async () => {
  const { hostnameHeaderValue, agentHostnameHeader } = await import('../src/agent/agentNameCarry.js');
  assert.equal(hostnameHeaderValue('edge-01.corp'), 'edge-01.corp');
  assert.equal(hostnameHeaderValue('서울-엣지01'), encodeURIComponent('서울-엣지01'));
  assert.equal(hostnameHeaderValue('café-pc'), encodeURIComponent('café-pc')); // Latin1 도 인코딩(ASCII 로 좁힌다)
  assert.equal(hostnameHeaderValue(''), '');
  assert.equal(hostnameHeaderValue('가'.repeat(200)), '');
  assert.equal(hostnameHeaderValue('\ud800'), ''); // 짝 없는 서로게이트 — encodeURIComponent 가 던진다
  assert.deepEqual(agentHostnameHeader('서울'), { 'X-Agent-Hostname': encodeURIComponent('서울') });
  assert.deepEqual(agentHostnameHeader(''), {});
  for (const v of Object.values(agentHostnameHeader())) assert.match(v, /^[\x20-\x7e]{1,255}$/);
});

test('R2F-01 — 비-ASCII 호스트명이어도 실제 fetch 가 요청을 보낸다(원문 헤더는 던진다 — 전제)', async () => {
  const { agentHostnameHeader } = await import('../src/agent/agentNameCarry.js');
  const got = [];
  const srv = http.createServer((req, res) => { got.push(req.headers['x-agent-hostname']); res.end('{}'); });
  const port = await listen(srv);
  try {
    await assert.rejects(fetch(`http://127.0.0.1:${port}/x`, { headers: { 'X-Agent-Hostname': '홍길동-PC' } }));
    const r = await fetch(`http://127.0.0.1:${port}/x`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...agentHostnameHeader('홍길동-PC') }, body: '{}' });
    assert.equal(r.status, 200);
    assert.deepEqual(got, [encodeURIComponent('홍길동-PC')]);
  } finally { srv.close(); }
});

test('R2F-01 — push 4종이 agentHostnameHeader 를 쓰고 os.hostname() 원문을 헤더에 싣지 않는다', () => {
  for (const f of ['agent/inventoryPush.js', 'agent/vmSeriesPush.js', 'agent/guestDiskPush.js', 'agent/curUserPush.js']) {
    const s = stripComments(read(f));
    assert.ok(/agentHostnameHeader\(\)/.test(s), `${f}: agentHostnameHeader 사용`);
    assert.ok(!/os\.hostname\(\)/.test(s), `${f}: os.hostname() 원문`);
  }
});

/* ── R2F-02 ── */
test('R2F-02 — 미검증 이름이 검증된 엣지 진단을 밀어내지 못한다', async () => {
  const m = await import('../src/central/gpuGuestDiag.js');
  m._resetGpuGuestDiagForTest();
  assert.equal(m.setGpuGuestDiag('edge-real', { vcenters: [] }, {}, { verified: true }).stored, true);
  for (let i = 0; i < m.MAX_AGENTS + 10; i++) m.setGpuGuestDiag(`fake${i}`, { vcenters: [] }, {});
  const all = m.getAllGpuGuestDiag();
  assert.ok(all.length <= m.MAX_AGENTS);
  assert.ok(all.some((x) => x.agent === 'edge-real' && x.verified === true), '검증된 엣지 진단이 남아야 한다');
  // 미검증끼리는 가장 오래된 것부터 민다(공유 토큰 엣지의 새 보고가 영원히 막히지 않게)
  assert.ok(all.some((x) => x.agent === `fake${m.MAX_AGENTS + 9}`), '가장 최근 미검증 보고는 들어가야 한다');
  assert.ok(!all.some((x) => x.agent === 'fake0'), '가장 오래된 미검증이 밀려나야 한다');
  // 미검증 요청은 검증된 기록을 덮어쓰지 않는다
  const r = m.setGpuGuestDiag('edge-real', { mode: 'x', vcenters: [] }, {});
  assert.equal(r.stored, false);
  assert.equal(r.reason, 'verified-entry');
  // 검증된 것으로 꽉 차면 미검증 새 이름은 거절 + 개수
  m._resetGpuGuestDiagForTest();
  for (let i = 0; i < m.MAX_AGENTS; i++) m.setGpuGuestDiag(`v${i}`, {}, {}, { verified: true });
  const before = m.gpuGuestDiagOmitted();
  const r2 = m.setGpuGuestDiag('intruder', {}, {});
  assert.equal(r2.stored, false);
  assert.equal(r2.reason, 'full-of-verified');
  assert.equal(m.gpuGuestDiagOmitted(), before + 1);
  assert.ok(!m.getAllGpuGuestDiag().some((x) => x.agent === 'intruder'));
  // 새 검증 기록은 가장 오래된 검증 기록을 민다
  assert.equal(m.setGpuGuestDiag('v-new', {}, {}, { verified: true }).stored, true);
  assert.equal(m.getAllGpuGuestDiag().length, m.MAX_AGENTS);
  m._resetGpuGuestDiagForTest();
});

test('R2F-02 — 라우트가 검증 여부를 진단 저장에 넘긴다', () => {
  const s = stripComments(read('routes/central.js'));
  assert.match(s, /setGpuGuestDiag\([^;]*\{\s*verified:\s*verifiedGpu\s*\}/);
});

/* ── R2F-03 ── */
test('R2F-03 — 통신 점검 DB 를 못 쓰면 dbUnavailable(stored 0)이고 라우트는 503', async () => {
  const dbm = await import('../src/linkcheck/db.js');
  dbm._resetForTest();
  // DB 파일 자리에 디렉터리를 두어 open 을 실패시킨다
  fs.mkdirSync(path.join(DIR, 'link-check.db'), { recursive: true });
  const colFile = path.join(DIR, 'collectors.json');
  fs.writeFileSync(colFile, JSON.stringify({ collectors: [{ id: 'GM1', name: 'GM1', url: 'https://10.1.1.1:4000', token: 'x' }] }));
  try {
    const { putEdgeLinkReport, edgeLinkReport, _resetEdgeLinkReportsForTest } = await import('../src/central/linkCheckEdge.js');
    _resetEdgeLinkReportsForTest();
    const out = await putEdgeLinkReport('GM1', { results: [
      { link: { id: 'edge->central|GM1|central', kind: 'edge->central', from: 'GM1', to: 'central', host: 'c', port: 443 },
        verdict: { ok: true, phase: 'ok', totalMs: 5 }, steps: { tcp: { ok: true, ms: 2 } }, summary: 'x' },
    ] });
    assert.equal(out.ok, false, JSON.stringify(out));
    assert.equal(out.dbUnavailable, true);
    assert.equal(out.stored, 0);
    assert.equal(edgeLinkReport('GM1')?.dbOk, false, '보고 상태(원인)는 남는다');
  } finally {
    fs.rmSync(colFile, { force: true });
    fs.rmSync(path.join(DIR, 'link-check.db'), { recursive: true, force: true });
    dbm._resetForTest();
  }
  const s = stripComments(read('routes/central.js'));
  assert.match(s, /if \(out\?\.dbUnavailable\) return res\.status\(503\)/);
  const w = stripComments(read('agent/linkCheckWorker.js'));
  assert.match(w, /dbUnavailable/);
});

/* ── R2F-04 ── */
async function getCfg(p, agent) {
  const r = await fetch(`http://127.0.0.1:${centralPort}/api/central/${p}?agent=${encodeURIComponent(agent)}`, { headers: { 'X-Central-Token': 'ctok-2681b' } });
  assert.equal(r.status, 200);
  return r.json();
}

test('R2F-04 — 인벤토리 캐시가 비어도 등록부 위임(site + remoteAgent, 대소문자 무시)으로 이 엣지 vCenter 를 안다', async () => {
  const V = await import('../src/vmseries/settings.js');
  const C = await import('../src/curuser/settings.js');
  V.saveVmSeriesSettings({ scope: 'selected', targets: { 'vc-site': { all: true }, 'vc-other': { all: true } } });
  C.save({ vcenters: { 'vc-site': { enabled: true, folders: ['F'] }, 'vc-other': { enabled: true, folders: ['G'] } } });
  const vcFile = path.join(DIR, 'vcenters.json');
  fs.writeFileSync(vcFile, JSON.stringify({ vcenters: [
    { id: 'vc-site', name: 'S', host: 'https://10.0.0.1', collectMode: 'site', remoteAgent: 'Edge-A' },
    { id: 'vc-other', name: 'O', host: 'https://10.0.0.2', collectMode: 'site', remoteAgent: 'Edge-B' },
  ] }));
  try {
    const v = await getCfg('vmseries-config', 'edge-a');
    assert.deepEqual(Object.keys(v.settings.targets), ['vc-site']);
    assert.equal(v.targetsHeld, undefined);
    const c = await getCfg('curuser-config', 'EDGE-A');
    assert.deepEqual(Object.keys(c.settings.vcenters), ['vc-site']);
  } finally { fs.rmSync(vcFile, { force: true }); }
  // 등록부·캐시 둘 다 없으면 필드를 빼고(빈 객체로 지우지 않게) 그 사실을 밝힌다
  const v2 = await getCfg('vmseries-config', 'edge-a');
  assert.equal('targets' in v2.settings, false);
  assert.equal(v2.targetsHeld, true);
  const c2 = await getCfg('curuser-config', 'edge-a');
  assert.equal('vcenters' in c2.settings, false);
  assert.equal(c2.vcentersHeld, true);
});

test('R2F-04 — 엣지 vmseries pull 은 targets 필드가 없으면 직전 값을 유지하고, 빈 객체면 지운다(구버전 중앙 호환)', async () => {
  const { config } = await import('../src/config.js');
  const V = await import('../src/vmseries/settings.js');
  const pull = await import('../src/agent/vmSeriesConfigPull.js');
  let reply = null;
  const srv = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(reply)); });
  const port = await listen(srv);
  const prevUrl = config.agent.centralUrl; const prevName = config.agent.name;
  config.agent.centralUrl = `http://127.0.0.1:${port}`; config.agent.name = 'edge-a';
  try {
    V.saveVmSeriesSettings({ enabled: true, scope: 'selected', targets: { 'vc-site': { all: true } } });
    const base = { enabled: true, intervalMin: 50, retentionDays: 60, thresholds: V.loadVmSeriesSettings().thresholds, scope: 'selected' };
    reply = { ok: true, settings: { ...base }, targetsHeld: true };
    const r1 = await pull.pullVmSeriesConfigNow();
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.deepEqual(Object.keys(V.loadVmSeriesSettings().targets), ['vc-site'], '필드 없음 = 직전 유지');
    reply = { ok: true, settings: { ...base, targets: {} } };
    const r2 = await pull.pullVmSeriesConfigNow();
    assert.equal(r2.ok, true);
    assert.deepEqual(V.loadVmSeriesSettings().targets, {}, '명시적 빈 객체는 배정 해제');
  } finally {
    config.agent.centralUrl = prevUrl; config.agent.name = prevName;
    srv.close();
  }
});

test('R2F-04 — curuser applyCentral 은 vcenters 가 없으면 직전 배정을 유지한다(병합)', async () => {
  const C = await import('../src/curuser/settings.js');
  C.save({ enabled: true, vcenters: { 'vc-site': { enabled: true, folders: ['F'] } } });
  const prevLocal = process.env.CURUSER_LOCAL; delete process.env.CURUSER_LOCAL;
  try {
    C.applyCentral({ enabled: true, intervalMs: C.load().intervalMs });
    assert.deepEqual(Object.keys(C.load().vcenters), ['vc-site']);
  } finally { if (prevLocal !== undefined) process.env.CURUSER_LOCAL = prevLocal; }
});
