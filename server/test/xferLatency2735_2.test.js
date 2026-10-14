/**
 * 법인 간 전송 속도 — ↑ 메인 → 엣지 행의 '지연'(v2.735.2, 사용자 신고 "응답 시작이 안 되는 부분이 있어").
 *
 * ↑ 방향은 응답 머리가 업로드를 다 받은 뒤에야 오므로 '응답 시작(ttfb)' 이 뜻이 없어 2.735.1 까지 늘 비어 있었다('—').
 * 같은 뜻(데이터가 흐르기 전·후의 연결 + 왕복)은 **전체 − 엣지 수신 구간** 이다 — 측정기가 그 값을 싣고, 옛 행은 읽을 때
 * `analyze.latencyMsOf` 가 같은 식으로 구한다. 보내는 쪽 전체 시간 기준(버퍼링 프록시)이면 구하지 않는다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xferlat2735-'));
process.env.CONFIG_DIR = TMP;
process.env.COLLECTOR_TOKEN = 'edge-token-latency';
process.env.DATA_SOURCE = 'live';
delete process.env.XFER_TEST_ENABLED;

const serve = await import('../src/xferspeed/serve.js');
const probe = await import('../src/xferspeed/probe.js');
const an = await import('../src/xferspeed/analyze.js');
const demo = await import('../src/mock/demo/xferspeed.js');
const express = (await import('express')).default;
const { collectorRouter } = await import('../src/routes/collector.js');

const MB = 1_048_576;
const plainFetch = (url, { timeoutMs = 10_000, retries, ...init } = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });

async function listen(app) {
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
}

test('① 측정기 — ↑ 행도 지연(전체 − 엣지 수신 구간)을 싣는다', async () => {
  serve._resetServeForTest();
  const app = express();
  app.use('/api/collector', collectorRouter);
  const e = await listen(app);
  try {
    const col = { id: 'edge-a', url: e.base, token: 'edge-token-latency' };
    const up = await probe.measureUp(col, { bytes: 2 * MB, timeoutMs: 15_000, fetchImpl: plainFetch });
    assert.equal(up.ok, true, JSON.stringify(up));
    assert.equal(up.basis, 'receiver');
    assert.ok(Number.isFinite(up.ttfbMs) && up.ttfbMs >= 0, `↑ 지연이 비어 있다: ${JSON.stringify(up)}`);
    assert.equal(up.ttfbMs, Math.round(up.totalMs - up.xferMs));
    // 저장된 값과 읽을 때 구한 값이 같은 식이다(옛 행과 새 행이 같은 뜻).
    assert.equal(an.latencyMsOf({ ...up, ttfbMs: null }), up.ttfbMs);
  } finally {
    await e.close();
    serve._resetServeForTest();
  }
});

test('② 버퍼링 프록시로 보이는 ↑(보내는 쪽 전체 시간 기준)은 지연을 구하지 않는다', async () => {
  // 엣지 수신 구간이 전체의 25% 미만이고 전체가 1초를 넘으면 sender-total — 수신 구간이 LAN 구간이라 '전체 − 수신' 은 뜻이 없다.
  const fakeFetch = async () => {
    await new Promise((r) => setTimeout(r, 1_100));
    return new Response(JSON.stringify({ ok: true, bytes: MB, recvMs: 5 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const up = await probe.measureUp({ id: 'edge-b', url: 'http://10.0.0.9:4000', token: 't' }, { bytes: MB, timeoutMs: 5_000, fetchImpl: fakeFetch, payload: Buffer.alloc(MB) });
  assert.equal(up.ok, true, JSON.stringify(up));
  assert.equal(up.basis, 'sender-total');
  assert.equal(up.ttfbMs, null);
  assert.equal(an.latencyMsOf(up), null);
});

test('③ latencyMsOf — 저장값 우선 · ↑ 옛 행 유도 · 실패·음수·↓ 결측은 null', () => {
  // ↓ 는 저장된 ttfb 만(전체 − 전송으로 지어내지 않는다 — ↓ 의 ttfb 는 그 자체로 측정값이다).
  assert.equal(an.latencyMsOf({ dir: 'down', ttfb_ms: 80, total_ms: 1000, xfer_ms: 900, basis: 'receiver' }), 80);
  assert.equal(an.latencyMsOf({ dir: 'down', ttfb_ms: null, total_ms: 1000, xfer_ms: 900, basis: 'receiver' }), null);
  // ↑ 옛 행(2.735.1 까지 ttfb 비어 있음) — 전체 − 전송.
  assert.equal(an.latencyMsOf({ dir: 'up', ttfb_ms: null, total_ms: 53_680, xfer_ms: 53_600, basis: 'receiver' }), 80);
  // ↑ 새 행 — 저장값이 이긴다.
  assert.equal(an.latencyMsOf({ dir: 'up', ttfb_ms: 77, total_ms: 53_680, xfer_ms: 53_600, basis: 'receiver' }), 77);
  // 보내는 쪽 전체 시간 기준·실패(전송 시간 없음)·음수는 구하지 않는다.
  assert.equal(an.latencyMsOf({ dir: 'up', total_ms: 5_000, xfer_ms: 5_000, basis: 'sender-total' }), null);
  assert.equal(an.latencyMsOf({ dir: 'up', total_ms: 120_000, xfer_ms: null, basis: null }), null);
  assert.equal(an.latencyMsOf({ dir: 'up', total_ms: 100, xfer_ms: 150, basis: 'receiver' }), null);
  // 화면 행 모양(camelCase)도 같다.
  assert.equal(an.latencyMsOf({ dir: 'up', ttfbMs: null, totalMs: 8_380, xferMs: 8_300, basis: 'receiver' }), 80);
});

test('④ 통계 — ↑ 지연 중앙값이 옛 행에서도 나온다', () => {
  const rows = [
    { dir: 'up', ok: 1, mbps: 1.5, ttfb_ms: null, total_ms: 53_690, xfer_ms: 53_600, basis: 'receiver' },
    { dir: 'up', ok: 1, mbps: 3.0, ttfb_ms: null, total_ms: 27_480, xfer_ms: 27_400, basis: 'receiver' },
    { dir: 'up', ok: 1, mbps: 10, ttfb_ms: 85, total_ms: 8_385, xfer_ms: 8_300, basis: 'receiver' },
    { dir: 'up', ok: 0, mbps: null, ttfb_ms: null, total_ms: 120_000, xfer_ms: null, basis: null },
  ];
  const s = an.statsOf(rows);
  assert.equal(s.ttfbMedian, 85);
  assert.equal(s.n, 4);
  assert.equal(s.ok, 3);
});

test('⑤ 데모 — ↑ 도 지연을 싣고 전체 = 전송 + 지연', () => {
  const col = { id: 'demo-edge-x', name: 'demo-edge-x' };
  for (const dir of ['down', 'up']) {
    const r = demo.demoXferResult(col, dir, { ts: Date.UTC(2026, 9, 14, 0, 0), bytes: 10 * MB });
    if (!r.ok) continue;
    assert.ok(Number.isFinite(r.ttfbMs), `${dir} 데모 지연이 비어 있다`);
    assert.equal(r.totalMs, Math.round(r.xferMs + r.ttfbMs));
  }
});
