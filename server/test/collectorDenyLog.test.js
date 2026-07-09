import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

// 라우터가 COLLECTOR_TOKEN 설정 상태로 로드되도록 import 전에 env 세팅.
process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coldeny-'));
process.env.COLLECTOR_TOKEN = 'RIGHT-TOKEN';

let server, base;
before(async () => {
  const { collectorRouter } = await import('../src/routes/collector.js');
  const app = express();
  app.use('/api/collector', collectorRouter);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/collector`;
});
after(() => { try { server?.close(); } catch { /* */ } });

// console.warn을 잠시 가로채 로그를 수집한다.
function captureWarn(fn) {
  const orig = console.warn;
  const lines = [];
  console.warn = (...a) => lines.push(a.join(' '));
  return Promise.resolve(fn()).finally(() => { console.warn = orig; }).then(() => lines);
}

test('collector 인증 거부: 틀린 토큰이면 403 + 진단 로그(토큰 값 미노출)', async () => {
  const lines = await captureWarn(async () => {
    const r = await fetch(`${base}/export`, { headers: { 'X-Collector-Token': 'WRONG' } });
    assert.equal(r.status, 403);
  });
  const denyLine = lines.find((l) => l.includes('인증 거부(export)'));
  assert.ok(denyLine, '거부 로그가 남아야 함');
  assert.match(denyLine, /토큰 불일치/);
  assert.match(denyLine, /제공됨\(len=5\)/, '요청 토큰 길이만 남김');
  assert.ok(!denyLine.includes('WRONG'), '토큰 값 자체는 절대 로그하지 않음');
  assert.ok(!denyLine.includes('RIGHT-TOKEN'), '설정 토큰도 로그하지 않음');
});

test('collector 인증 거부: 토큰 없이 요청하면 원인이 "없음"으로 로그', async () => {
  const lines = await captureWarn(async () => {
    const r = await fetch(`${base}/idrac-scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 403);
  });
  const denyLine = lines.find((l) => l.includes('인증 거부(idrac-scan)'));
  assert.ok(denyLine, 'idrac-scan 거부 로그');
  assert.match(denyLine, /X-Collector-Token 없음/);
  assert.match(denyLine, /요청토큰=없음/);
});

test('collector 인증 거부: (endpoint,ip)별 30초 스로틀 — 반복 요청은 1회만 로그', async () => {
  const lines = await captureWarn(async () => {
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${base}/ping`, { headers: { 'X-Collector-Token': 'WRONG' } });
      assert.equal(r.status, 403);
    }
  });
  const pingLines = lines.filter((l) => l.includes('인증 거부(ping)'));
  assert.equal(pingLines.length, 1, '30초 내 반복은 1회만 로그(스팸 방지)');
});
