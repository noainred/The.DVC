/**
 * v2.744 회귀 검토 RC — v2.744 수정분(커밋 3b7816a · 후속 FB 16eafe8)이 남긴 GC-R1·GC-R2·GC-R3.
 *
 * GC-R1 503 무재시도 받기(util/postNo503Retry.js — fetchNo503Retry)가 시도마다 resilientFetch(retries:0)를 따로 불러, 데이터 흐름 기록
 *   (util/outboundStats.js)이 '최종 결과 1회' 가 아니라 **시도 수**로 쌓였다(502 → 200 한 번에 count 2 · failCount 1 · lastError 'HTTP 502').
 *   일반 경로(resilientFetch retries 2)는 같은 요청을 count 1 · failCount 0 으로 남긴다 — 같은 규칙이어야 한다(resilientFetch.js 머리말
 *   '기록은 최종 결과 1회'). 이제 재시도는 resilientFetch 안에서 돌고 503 은 noRetryStatus 옵션으로 다시 묻지 않는다.
 * GC-R2 관리 화면 '연결 테스트'·토큰 강제 동기화 재검증·배포 후 검증은 엣지 export 의 지속형 503(registryUnreadable — Retry-After 60)을
 *   resilientFetch 기본 규칙으로 Retry-After 만큼 기다렸다(실측 73초 · export 3회). 주기 pull 과 같은 무재시도 받기를 쓴다.
 * GC-R3 주기 경고의 '거절 우세' 분기가 응답 없던 엣지 개수를 빠뜨리고, 거절 앞의 시한 재시도 시간까지 '거절' 로 셌다.
 * 실제 puller·실제 수집 서버 등록부·실제 관리 라우트를 부른다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2744rc-'));
Object.assign(process.env, {
  CONFIG_DIR: CFG, DATA_SOURCE: 'live', AUTH_ENABLED: 'false', IPAM_WRITE_WORKER: '0', SSRF_ALLOW_LOOPBACK: 'true',
});
fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: [] }));

const express = (await import('express')).default;
const { config } = await import('../src/config.js');
const { resilientFetch } = await import('../src/util/resilientFetch.js');
const { postNo503Retry, fetchNo503Retry } = await import('../src/util/postNo503Retry.js');
const { outboundStats, resetOutboundStats } = await import('../src/util/outboundStats.js');
const puller = await import('../src/collector/puller.js');
const { addCollector, updateCollector, loadCollectors } = await import('../src/collector/registry.js');

const closers = [];
test.after(async () => {
  for (const c of closers.reverse()) { try { await c(); } catch { /* 정리는 best-effort */ } }
  try { fs.rmSync(CFG, { recursive: true, force: true }); } catch { /* */ }
});

/** 응답을 함수로 정하는 가짜 서버. hits[경로] 를 센다. */
async function fakeServer(handler) {
  const hits = {};
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const p = req.url.split('?')[0];
      hits[p] = (hits[p] || 0) + 1;
      handler(req, res, hits[p], p);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }));
  return { base: `http://127.0.0.1:${srv.address().port}`, hits };
}
const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
const rowsOf = (base) => outboundStats().rows.filter((r) => r.base === base && r.path === '/api/collector/export');
/** 이 파일이 만든 수집 서버를 모두 끈다(앞 테스트가 실패해도 뒤 테스트의 pull 주기에 섞이지 않게). */
function disableAllCollectors() {
  for (const c of loadCollectors()) if (c.enabled !== false) { try { updateCollector(c.id, { enabled: false }); } catch { /* */ } }
}
/** 배경 pull 주기(자동 등록 뒤 pullNow 등)가 끝날 때까지 기다린다 — 겹치면 재진입 가드가 이번 호출을 건너뛰고, 그 주기의 경고를 잘못 읽는다. */
async function waitPullerIdle() {
  for (let i = 0; i < 200 && puller.pullerStatus().running; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(puller.pullerStatus().running, false, '배경 pull 주기가 끝나지 않았다');
}
async function captureWarn(fn) {
  const lines = []; const orig = console.warn;
  console.warn = (...a) => { lines.push(a.map(String).join(' ')); };
  try { return { value: await fn(), lines }; } finally { console.warn = orig; }
}

/* ═══════════════ GC-R1 — 기록은 최종 결과 1회 ═══════════════ */

test('GC-R1 ① fetchNo503Retry 502 → 200 — 기록은 최종 결과 1회(count 1 · failCount 0) · 일반 경로와 같다 · lastMs 는 전체 시간', async () => {
  const { base, hits } = await fakeServer((_q, res, n) => {
    if (n % 2 === 1) setTimeout(() => json(res, 502, { error: 'bad gateway' }), 150);
    else json(res, 200, { ok: true });
  });
  resetOutboundStats();
  const retries = [];
  const r = await fetchNo503Retry(`${base}/api/collector/export`, { timeoutMs: 5000 }, { backoffMs: 5, onRetry: (i) => retries.push(i) });
  assert.equal(r.status, 200);
  assert.equal(hits['/api/collector/export'], 2);
  assert.deepEqual(retries, [{ attempt: 1, status: 502 }], 'onRetry 는 예전처럼 다시 보내기 직전에만');
  const [row] = rowsOf(base);
  assert.ok(row, '기록 행이 있다');
  assert.equal(row.count, 1, `수정 전: 시도마다 기록해 count 2 — ${JSON.stringify(row)}`);
  assert.equal(row.okCount, 1);
  assert.equal(row.failCount, 0, `수정 전: 중간 시도의 502 가 failCount 1 로 남았다 — ${JSON.stringify(row)}`);
  assert.equal(row.lastError, '');
  assert.ok(row.lastMs >= 140, `lastMs 는 마지막 시도가 아니라 전체(첫 502 지연 150ms 포함) — ${row.lastMs}ms`);

  // 같은 요청을 일반 경로(resilientFetch retries 2)로 — 기록 모양이 같다.
  resetOutboundStats(); hits['/api/collector/export'] = 0;
  const g = await resilientFetch(`${base}/api/collector/export`, { timeoutMs: 5000, retries: 2, retryBackoffMs: 5 });
  assert.equal(g.status, 200);
  const [grow] = rowsOf(base);
  assert.deepEqual([grow.count, grow.okCount, grow.failCount], [row.count, row.okCount, row.failCount], '일반 경로와 같은 규칙');
});

test('GC-R1 ② 503 은 여전히 한 번만 보내고 1회 기록 · 연결이 끝까지 실패하면 실패 1회 기록 · 일반 경로의 503 재시도는 그대로', async () => {
  const { base, hits } = await fakeServer((_q, res) => json(res, 503, { ok: false, reason: 'registryUnreadable' }, { 'Retry-After': '0' }));
  resetOutboundStats();
  const r = await postNo503Retry(`${base}/api/collector/export`, { timeoutMs: 5000, retries: 5 }, { backoffMs: 5 });
  assert.equal(r.status, 503);
  assert.equal(hits['/api/collector/export'], 1, '503 은 다시 묻지 않는다(init.retries 도 무시)');
  const [row] = rowsOf(base);
  assert.deepEqual([row.count, row.failCount, row.lastStatus], [1, 1, 503]);
  // 일반 경로(옵션 없음)는 503 을 예전처럼 재시도한다 — 옵션이 기본 동작을 바꾸지 않는다.
  hits['/api/collector/export'] = 0;
  const g = await resilientFetch(`${base}/api/collector/export`, { timeoutMs: 5000, retries: 2, retryBackoffMs: 5 });
  assert.equal(g.status, 503);
  assert.equal(hits['/api/collector/export'], 3, '일반 경로의 503 은 예전처럼 3번');

  // 닫힌 포트 — 일시 오류 재시도 2회 뒤 던진다. 기록은 실패 1회.
  const tmp = http.createServer(); await new Promise((ok) => tmp.listen(0, '127.0.0.1', ok));
  const dead = tmp.address().port; await new Promise((ok) => tmp.close(ok));
  resetOutboundStats();
  const errs = [];
  await assert.rejects(fetchNo503Retry(`http://127.0.0.1:${dead}/api/collector/export`, { timeoutMs: 3000 }, { backoffMs: 5, onRetry: (i) => errs.push(i) }));
  assert.equal(errs.length, 2, '연결 오류 재시도 로그 2회는 예전과 같다');
  const [drow] = rowsOf(`http://127.0.0.1:${dead}`);
  assert.deepEqual([drow.count, drow.failCount], [1, 1], `수정 전: 시도마다 기록해 count 3 — ${JSON.stringify(drow)}`);
  assert.ok(drow.lastError.length > 0);
});

test('GC-R1 ③ 실제 pullNow — 첫 시도 502 · 재시도 200 이면 export 기록은 성공 1건(데이터 흐름 지도의 횟수가 시도 수로 부풀지 않는다)', { timeout: 60_000 }, async () => {
  const { base, hits } = await fakeServer((_q, res, n) => {
    if (n % 2 === 1) json(res, 502, { error: 'bad gateway' });
    else json(res, 200, { agent: 'edge-rc1', version: '2.744.0', hostname: 'rc1', datacenter: '', servers: [] });
  });
  await waitPullerIdle();
  disableAllCollectors();
  puller._resetPullerForTest();
  const add = addCollector({ id: 'edge-rc1', name: 'edge-rc1', url: base, token: 'tok-rc1', enabled: true });
  assert.ok(add?.ok !== false, JSON.stringify(add));
  resetOutboundStats();
  try { await captureWarn(() => puller.pullNow()); } finally { updateCollector('edge-rc1', { enabled: false }); }
  assert.equal(hits['/api/collector/export'], 2, '502 는 예전처럼 호출 안에서 재시도');
  const rows = rowsOf(base);
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.equal(rows[0].tag, 'edge-rc1', '수집 서버 태그는 그대로');
  assert.deepEqual([rows[0].count, rows[0].okCount, rows[0].failCount, rows[0].lastError], [1, 1, 0, ''],
    `수정 전: {count:2, failCount:1, lastError:'HTTP 502'} — ${JSON.stringify(rows[0])}`);
});

/* ═══════════════ GC-R2 — 관리 화면의 엣지 export 받기도 503 을 다시 묻지 않는다 ═══════════════ */

const EDGE_503 = (_q, res) => json(res, 503, { ok: false, reason: 'registryUnreadable', detail: "idrac.json: Unexpected token" }, { 'Retry-After': '2', 'Cache-Control': 'no-store' });

async function adminApp(register) {
  const app = express(); app.use(express.json());
  app.use((req, _r, n) => { req.user = { username: 'boss', role: 'admin', scope: null }; n(); });
  const r = express.Router(); register(r); app.use('/api/admin', r);
  const srv = http.createServer(app);
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  closers.push(() => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(() => ok()); }));
  return `http://127.0.0.1:${srv.address().port}`;
}

test('GC-R2 ① 연결 테스트(/admin/collectors/test) — 엣지 export 지속형 503 이면 1회로 수 초 안에 사유를 말한다(Retry-After 를 기다리지 않는다)', { timeout: 60_000 }, async () => {
  const { registerCollectorsDc } = await import('../src/routes/admin/collectorsDc.js');
  const admin = await adminApp(registerCollectorsDc);
  const edge = await fakeServer(EDGE_503);
  const t0 = Date.now();
  const res = await fetch(`${admin}/api/admin/collectors/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: edge.base, token: 'tok-rc2' }) });
  const ms = Date.now() - t0;
  const j = await res.json();
  assert.equal(j.ok, false);
  assert.match(String(j.reason), /HTTP 503/);
  assert.match(String(j.reason), /registryUnreadable/, '엣지가 밝힌 사유를 그대로 싣는다');
  assert.equal(edge.hits['/api/collector/export'], 1, `수정 전: 503 을 Retry-After 만큼 기다리며 3회 — 요청 ${edge.hits['/api/collector/export']}회`);
  assert.equal(j.retried, 0, '503 은 재시도가 아니다');
  assert.ok(ms < 1_800, `Retry-After(2초 × 1~1.5 × 2회)를 기다리지 않는다 — ${ms}ms`);
});

test('GC-R2 ② 연결 테스트 — 503 이 아닌 일시 상태(502)는 예전처럼 재시도하고 retried 로 센다(고RTT 블립 흡수)', { timeout: 60_000 }, async () => {
  const { registerCollectorsDc } = await import('../src/routes/admin/collectorsDc.js');
  const admin = await adminApp(registerCollectorsDc);
  const edge = await fakeServer((_q, res) => json(res, 502, { error: 'bad gateway' }));
  const res = await fetch(`${admin}/api/admin/collectors/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: edge.base, token: 'tok-rc2' }) });
  const j = await res.json();
  assert.equal(j.ok, false);
  assert.match(String(j.reason), /HTTP 502/);
  assert.equal(edge.hits['/api/collector/export'], 3, '502 는 재시도 2회(예전과 같다)');
  assert.equal(j.retried, 2);
});

test('GC-R2 ③ 배포 후 검증(/admin/agent-deploy/collector-sync verify) — 지속형 503 을 기다리지 않는다', { timeout: 60_000 }, async () => {
  const { registerDeployLlm } = await import('../src/routes/admin/deployLlm.js');
  const { saveTarget } = await import('../src/agent/deployRegistry.js');
  const admin = await adminApp(registerDeployLlm);
  const edge = await fakeServer(EDGE_503);
  const port = Number(new URL(edge.base).port);
  const sv = saveTarget({ host: '127.0.0.1', portalPort: port, username: 'root', agentName: 'edge-rc-d', collectorToken: 'tok-rc-d' });
  assert.equal(sv.ok, true, JSON.stringify(sv));
  const t0 = Date.now();
  let row = {};
  try {
    const res = await fetch(`${admin}/api/admin/agent-deploy/collector-sync`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [sv.target?.id || sv.id], tokenDirection: 'add-only', verify: true, generateToken: false }) });
    const ms = Date.now() - t0;
    const j = await res.json();
    assert.equal(j.ok, true, JSON.stringify(j));
    row = j.results?.[0] || {};
    assert.equal(row.ok, true, JSON.stringify(row));
    assert.equal(row.verified?.ok, false);
    assert.match(String(row.verified?.reason), /HTTP 503/);
    assert.ok(ms < 1_800, `수정 전: retries 1 이라 Retry-After(2초 × 1~1.5) 1회 대기 — ${ms}ms`);
  } finally { disableAllCollectors(); } // 자동 등록된 수집 서버가 뒤 테스트의 pull 주기에 섞이지 않게
});

test('GC-R2 ④ 엣지 export 를 GET 하는 관리 경로는 재시도가 있으면 무재시도 받기(fetchNo503Retry)를 쓴다 — resilientFetch 로 export 를 부르는 곳은 retries 0 뿐', async () => {
  const { stripComments } = await import('./_stripComments.js');
  for (const rel of ['routes/admin/collectorsDc.js', 'routes/admin/deployLlm.js', 'collector/puller.js']) {
    const code = stripComments(fs.readFileSync(path.join(import.meta.dirname, '../src', rel), 'utf8'));
    const calls = [...code.matchAll(/resilientFetch\(([^;]*?\/api\/collector\/export[\s\S]*?)\}\)\)?;/g)].map((m) => m[1]);
    for (const c of calls) assert.match(c, /retries:\s*0\b/, `${rel}: export 를 resilientFetch 로 부르면서 재시도한다(지속형 503 을 Retry-After 만큼 기다린다) — ${c.slice(0, 160)}`);
  }
});

/* ═══════════════ GC-R3 — 주기 경고 ═══════════════ */

test('GC-R3 ① slowCycleText — 거절 우세 분기도 실패 엣지 개수·시간을 말한다 · 거절 앞 재시도가 있었으면 \'응답이 없던 것이 아니라\' 고 말하지 않는다', () => {
  const a = { took: 41000, count: 2, concurrency: 4, intervalMs: 60000, failedCount: 1, failedMs: 20400, suspectCount: 1, rejectedCount: 1, rejectedMs: 41000, rejectedBy: { registryUnreadable: 1 } };
  const t = puller.slowCycleText(a);
  assert.match(t, /거절/);
  assert.match(t, /실패 엣지 1곳 · 약 20초/, `수정 전: 거절 우세 분기가 실패 엣지를 빠뜨렸다 — ${t}`);
  // 거절 앞의 재시도 — 그 시간은 실패 쪽에 들어가고 문구가 그 사실을 말한다.
  const b = puller.slowCycleText({ ...a, failedCount: 1, failedMs: 40_500, rejectedMs: 500, rejectedAfterRetry: 1 });
  assert.ok(!b.includes('응답이 없던 것이 아니라'), b);
  assert.match(b, /그중 1곳은 거절 전에/);
  // 예전 인자만(거절 앞 재시도 없음)이면 예전 문구 그대로.
  const c = puller.slowCycleText({ took: 76_000, count: 1, concurrency: 4, intervalMs: 60_000, rejectedCount: 1, rejectedMs: 76_000, rejectedBy: { registryUnreadable: 1 } });
  assert.match(c, /응답이 없던 것이 아니라/);
  assert.ok(!c.includes('실패 엣지'), c);
  for (const s of [t, b, c]) assert.ok(!s.includes('`') && !s.includes('**'));
});

test('GC-R3 ② 실제 pullNow — 첫 시도 시한 초과 · 재시도에서 503 registryUnreadable 이면 시한 시간은 거절이 아니라 실패 쪽에 센다', { timeout: 60_000 }, async () => {
  const { base, hits } = await fakeServer((_q, res, n) => {
    if (n === 1) return; // 첫 요청은 응답하지 않는다(시한 초과) — 정리 때 closeAllConnections 로 닫는다
    json(res, 503, { ok: false, reason: 'registryUnreadable' }, { 'Retry-After': '60', 'Cache-Control': 'no-store' });
  });
  await waitPullerIdle();
  disableAllCollectors();
  puller._resetPullerForTest();
  const add = addCollector({ id: 'edge-rc3', name: 'edge-rc3', url: base, token: 'tok-rc3', enabled: true });
  assert.ok(add?.ok !== false, JSON.stringify(add));
  const saved = { iv: config.collector.pullIntervalMs, to: config.collector.timeoutMs };
  config.collector.pullIntervalMs = 10; // 주기 경고가 반드시 나오게
  config.collector.timeoutMs = 900;
  let lines;
  try { ({ lines } = await captureWarn(() => puller.pullNow())); } finally {
    config.collector.pullIntervalMs = saved.iv; config.collector.timeoutMs = saved.to;
    updateCollector('edge-rc3', { enabled: false });
  }
  assert.equal(hits['/api/collector/export'], 2, '시한 초과 1회 재시도 뒤 503 — 503 은 다시 묻지 않는다');
  const slow = lines.find((l) => l.includes('pull 주기 소요'));
  assert.ok(slow, lines.join(' | '));
  assert.match(slow, /엣지 1곳 · 동시/, `이 주기(엣지 rc3 하나)의 경고여야 한다 — ${slow}`);
  assert.match(slow, /거절/);
  assert.ok(!slow.includes('응답이 없던 것이 아니라'), `수정 전: 시한 재시도 시간까지 거절로 세고 '응답이 없던 것이 아니라' 라고 말했다 — ${slow}`);
  assert.match(slow, /그중 1곳은 거절 전에/);
  assert.match(slow, /(응답하지 않은|실패) 엣지 1곳/, `시한 초과 시간은 실패 엣지로 센다 — ${slow}`);
});
