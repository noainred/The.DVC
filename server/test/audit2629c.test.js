/**
 * v2.629 감사 그룹 c — 엣지 → 중앙 이름 헤더(A6-01) · 성능점검 배정 교체(EDGE2629-01) · 엣지 무보고 감시(EDGE2629-02).
 *
 * A6-01: 원문 `'X-Agent-Name': config.agent.name` 은 한글 등 U+00FF 초과 이름에서 fetch 가 **요청 자체를 던졌다**.
 *   소스 스윕 + 실제 fetch 로 목 HTTP 서버에 보내 요청이 도착하고 이름이 `?agent=` 로 전달되는지 본다.
 * EDGE2629-01: 새 정의가 검증에서 거부되면 이전 central:* 배포분이 **남아 있어야** 하고, 같은 sig 는 백오프 동안 다시 받지 않는다.
 * EDGE2629-02: 중앙 기동 뒤 한 번도 보고하지 않은 배정 엣지를 유예 뒤 한 번 알린다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2629c-'));
process.env.SVCMON_WORKERS = '0';
process.env.SVCMON_CONFIG_PULL_MS = '3000000000';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const { config } = await import('../src/config.js');

/* ── A6-01 ── */
test('A6-01 — 엣지 워커 소스에 원문 X-Agent-Name 헤더가 0건이다', () => {
  const files = [
    ...fs.readdirSync(path.join(SRC, 'agent')).filter((f) => f.endsWith('.js') && f !== 'agentNameCarry.js').map((f) => `agent/${f}`),
    'sanswitch/push.js', 'sanswitch/perfPush.js', 'partfault/push.js',
  ];
  const bad = [];
  for (const f of files) {
    const s = stripComments(read(f));
    if (/['"]X-Agent-Name['"]\s*:/.test(s)) bad.push(f);
  }
  assert.deepEqual(bad, [], `원문 헤더가 남은 파일: ${bad.join(', ')}`);
});

test('A6-01 — withAgentQuery: 헤더로 못 싣는 이름만 쿼리로, 이미 agent 쿼리가 있으면 그대로', async () => {
  const { withAgentQuery, agentHeaders } = await import('../src/agent/agentNameCarry.js');
  assert.deepEqual(agentHeaders('edge-a'), { 'X-Agent-Name': 'edge-a' });
  assert.deepEqual(agentHeaders('서울-엣지'), {});
  assert.equal(withAgentQuery('http://c/api/central/x', 'edge-a'), 'http://c/api/central/x');
  assert.equal(withAgentQuery('http://c/api/central/x', '서울-엣지'), `http://c/api/central/x?agent=${encodeURIComponent('서울-엣지')}`);
  assert.equal(withAgentQuery('http://c/x?vcenters=a', '서울'), `http://c/x?vcenters=a&agent=${encodeURIComponent('서울')}`);
  assert.equal(withAgentQuery('http://c/x?agent=%EC%84%9C', '서'), 'http://c/x?agent=%EC%84%9C');
  assert.equal(withAgentQuery('http://c/x', ''), 'http://c/x');
});

async function mockCentral(handler) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    const ch = [];
    req.on('data', (c) => ch.push(c));
    req.on('end', () => {
      let buf = Buffer.concat(ch);
      if (req.headers['content-encoding'] === 'gzip') { try { buf = zlib.gunzipSync(buf); } catch { /* 그대로 */ } }
      const u = new URL(req.url, 'http://x');
      const hit = { method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body: buf.toString() };
      hits.push(hit);
      const out = handler(hit) || { status: 200, body: { ok: true } };
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { hits, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

test('A6-01 — 한글 이름 엣지의 push·pull 이 던지지 않고 도착하며 이름은 ?agent= 로 간다', async () => {
  const c = await mockCentral((h) => {
    if (h.path === '/api/central/partfault-config') return { status: 200, body: { ok: true, enabled: false } };
    if (h.path === '/api/central/link-check-config') return { status: 200, body: { ok: true, enabled: false, links: [] } };
    return { status: 200, body: { ok: true } };
  });
  const saved = { ...config.agent };
  const NAME = '서울-엣지';
  try {
    Object.assign(config.agent, { centralUrl: c.url, centralToken: 'tok', name: NAME });
    const { sendStatusOnly } = await import('../src/agent/centralStatusOnly.js');
    const st = await sendStatusOnly('/api/central/sanswitch-data', { reason: 'no-snapshots', registered: 0 }, { devices: [] });
    assert.equal(st.ok, true, `상태 전용 push 가 실패: ${st.reason}`);
    const { pullPartFaultConfigNow } = await import('../src/agent/partFaultConfigPull.js');
    await pullPartFaultConfigNow();
    const { runLinkCheckWorkerOnce } = await import('../src/agent/linkCheckWorker.js');
    await runLinkCheckWorkerOnce().catch(() => {});

    const paths = c.hits.map((h) => h.path);
    assert.ok(paths.includes('/api/central/sanswitch-data'), `POST 가 도착하지 않았다: ${paths}`);
    assert.ok(paths.includes('/api/central/partfault-config'), `GET 이 도착하지 않았다: ${paths}`);
    for (const h of c.hits) {
      assert.equal(h.headers['x-agent-name'], undefined, `${h.path}: 한글 이름을 헤더에 실으면 안 된다`);
      assert.equal(h.query.agent, NAME, `${h.path}: 이름이 쿼리로 전달돼야 한다`);
    }
    const post = c.hits.find((h) => h.path === '/api/central/sanswitch-data');
    assert.equal(JSON.parse(post.body).agent, NAME, '본문 agent 도 같은 값');

    // ASCII 이름은 예전처럼 헤더 · 쿼리 추가 없음
    c.hits.length = 0;
    config.agent.name = 'edge-ascii';
    await sendStatusOnly('/api/central/sanswitch-data', { reason: 'no-snapshots', registered: 0 }, { devices: [] });
    assert.equal(c.hits[0].headers['x-agent-name'], 'edge-ascii');
    assert.equal(c.hits[0].query.agent, undefined);
  } finally {
    Object.assign(config.agent, saved);
    await c.close();
  }
});

/* ── EDGE2629-01 ── */
const row = (name, host, type = 'ping') => ({ kind: 'infra', path: 'C.Central', name, host, tests: [{ name: 'T', type, intervalSec: 60 }] });

test('EDGE2629-01 — 새 정의가 검증에서 거부되면 이전 central:* 배포분을 유지하고, 같은 sig 는 백오프 동안 다시 받지 않는다', async () => {
  const store = await import('../src/svcmon/store.js');
  const pull = await import('../src/agent/svcmonConfigPull.js');
  let phase = 'a';
  const acks = [];
  const c = await mockCentral((h) => {
    if (h.path === '/api/central/svcmon-config-ack') { acks.push(JSON.parse(h.body)); return { status: 200, body: { ok: true } }; }
    if (h.path !== '/api/central/svcmon-config') return { status: 404, body: {} };
    if (phase === 'a') return { status: 200, body: { ok: true, assigned: true, sig: 'aaaa', tag: 'central:aaaa', targets: [row('h1', '10.9.0.1'), row('h2', '10.9.0.2')] } };
    if (h.query.sig === 'bbbb') return { status: 200, body: { ok: true, assigned: true, unchanged: true, sig: 'bbbb' } };
    return { status: 200, body: { ok: true, assigned: true, sig: 'bbbb', tag: 'central:bbbb',
      targets: [row('h1', '10.9.0.1'), row('h2', '10.9.0.2'), row('h3', '10.9.0.3', 'newtype')] } };
  });
  const saved = { ...config.agent };
  try {
    Object.assign(config.agent, { centralUrl: c.url, centralToken: 'tok', name: 'edge-sv' });
    pull._resetSvcmonPullForTest();
    const r1 = await pull.pullSvcmonConfigNow();
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.equal(store.batchCounts().get('central:aaaa')?.targets, 2);

    phase = 'b';
    const r2 = await pull.pullSvcmonConfigNow();
    assert.equal(r2.ok, false);
    assert.equal(r2.kept, true);
    assert.equal(store.batchCounts().get('central:aaaa')?.targets, 2, '이전 배포분이 사라지면 안 된다');
    assert.equal(store.batchCounts().get('central:bbbb'), undefined);
    const lastAck = acks.at(-1);
    assert.equal(lastAck.sig, 'bbbb');
    assert.equal(lastAck.removed, 0);
    assert.ok(lastAck.errors.some((e) => /newtype/.test(e)), JSON.stringify(lastAck.errors));
    assert.ok(lastAck.errors.some((e) => /이전 배포분을 그대로 유지/.test(e)));

    // 백오프 중 — 실패한 sig 로 물어 중앙이 unchanged 로 답한다(전문 재수신·재적용 없음)
    const r3 = await pull.pullSvcmonConfigNow();
    const cfgHits = c.hits.filter((h) => h.path === '/api/central/svcmon-config');
    assert.equal(cfgHits.at(-1).query.sig, 'bbbb');
    assert.equal(r3.failed, true);
    assert.equal(r3.ok, false);
    assert.equal(store.batchCounts().get('central:aaaa')?.targets, 2);
    assert.equal(pull.svcmonConfigPullStatus().failedSig, 'bbbb');
  } finally {
    Object.assign(config.agent, saved);
    await c.close();
  }
});

/* ── EDGE2629-02 ── */
test('EDGE2629-02 — 배정됐는데 중앙 기동 뒤 보고가 없는 엣지를 유예 뒤 한 번 알리고, 보고가 오면 재개로 전환한다', async () => {
  const T0 = Date.parse('2026-09-27T03:30:00Z');       // 고정 기준 시각(Date.now() 금지 규약)
  const assign = await import('../src/central/svcmonAssign.js');
  const silence = await import('../src/central/svcmonSilence.js');
  const edge = await import('../src/central/svcmonEdge.js');
  assign.setAssignment('edge-dead', { kind: 'infra', path: 'C.Central' }, [row('d1', '10.9.1.1')]);
  silence._resetSilenceState({ startedAt: T0 });

  // 유예 안 — 알리지 않는다
  const a = await silence.checkSilenceOnce({ now: T0 + 60_000 });
  assert.deepEqual(a.fired, []);
  assert.deepEqual(a.noReport, ['edge-dead']);

  // 유예(판정 임계) 뒤 — 한 번 알린다
  const limit = edge.silenceLimitMs(null);
  const b = await silence.checkSilenceOnce({ now: T0 + limit + 1_000 });
  assert.deepEqual(b.fired, [{ agent: 'edge-dead', kind: 'no-report' }]);
  const b2 = await silence.checkSilenceOnce({ now: T0 + limit + 60_000 });
  assert.deepEqual(b2.fired, [], '같은 엣지를 매 주기 다시 알리지 않는다');
  assert.ok(silence.silenceStatus().tracked.some((t) => t.agent === 'edge-dead' && t.noReport));

  // 보고가 오면 '재개' 전환
  const now = T0 + limit + 120_000;
  edge.ingestReport('edge-dead', { expectMs: 60_000, snapId: 's1', seq: 1, total: 1, rows: [] }, now);
  const c = await silence.checkSilenceOnce({ now: now + 1_000 });
  assert.deepEqual(c.fired, [{ agent: 'edge-dead', kind: 'recovered' }]);
  assert.deepEqual(c.noReport, []);
});
