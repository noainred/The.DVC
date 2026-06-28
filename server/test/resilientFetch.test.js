import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { resilientFetch, retryTransient, _internals } from '../src/util/resilientFetch.js';

let server, base, hits;
before(async () => {
  hits = { count: 0 };
  server = http.createServer((req, res) => {
    hits.count++;
    // 경로로 동작 제어: /flaky = 처음 2번 503 후 200, /always503 = 항상 503, /ok = 200
    if (req.url === '/flaky') {
      if (hits.count < 3) { res.writeHead(503); res.end('busy'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return;
    }
    if (req.url === '/always503') { res.writeHead(503); res.end('down'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('isTransientErr: 연결 리셋/타임아웃은 일시 오류, 그 외는 아님', () => {
  assert.equal(_internals.isTransientErr({ code: 'ECONNRESET' }), true);
  assert.equal(_internals.isTransientErr({ message: 'fetch failed', cause: { code: 'ETIMEDOUT' } }), true);
  assert.equal(_internals.isTransientErr({ name: 'TimeoutError', message: 'The operation was aborted due to timeout' }), true);
  assert.equal(_internals.isTransientErr({ message: 'Not Found 404' }), false);
});

test('5xx 게이트웨이는 재시도 후 성공(503 두 번 → 200)', async () => {
  hits.count = 0;
  const res = await resilientFetch(`${base}/flaky`, { retries: 3, retryBackoffMs: 5, timeoutMs: 5000 });
  assert.equal(res.status, 200);
  assert.equal(hits.count, 3); // 2회 503 + 1회 200
  const j = await res.json();
  assert.equal(j.ok, true);
});

test('재시도 소진 후에는 마지막 응답(503)을 그대로 반환', async () => {
  hits.count = 0;
  const res = await resilientFetch(`${base}/always503`, { retries: 2, retryBackoffMs: 5, timeoutMs: 5000 });
  assert.equal(res.status, 503);
  assert.equal(hits.count, 3); // 1 + 2 재시도
});

test('연결 불가(포트 닫힘)는 일시 오류로 재시도 후 throw', async () => {
  await assert.rejects(
    resilientFetch('http://127.0.0.1:1/api', { retries: 1, retryBackoffMs: 5, timeoutMs: 1500 }),
    (e) => e instanceof Error,
  );
});

test('retryTransient: 일시 오류는 재시도, 비일시 오류는 즉시 throw', async () => {
  let n = 0;
  const v = await retryTransient(async () => { n++; if (n < 3) { const e = new Error('reset'); e.code = 'ECONNRESET'; throw e; } return 'ok'; }, { retries: 3, backoffMs: 5 });
  assert.equal(v, 'ok');
  assert.equal(n, 3);
  // 비일시(인증 실패 등)는 재시도 안 함
  let m = 0;
  await assert.rejects(retryTransient(async () => { m++; throw new Error('토큰 불일치(인증 실패)'); }, { retries: 3, backoffMs: 5 }));
  assert.equal(m, 1);
});

test('정상 응답은 재시도 없이 1회', async () => {
  hits.count = 0;
  const res = await resilientFetch(`${base}/ok`, { retries: 2, retryBackoffMs: 5, timeoutMs: 5000 });
  assert.equal(res.status, 200);
  assert.equal(hits.count, 1);
});
