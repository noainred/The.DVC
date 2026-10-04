/**
 * v2.689 G2 I8 — gzip single-flight. 같은 payload 객체(memoJson 공유)로 첫 압축이 끝나기 전에 동시에 온 요청 N개는
 * 진행 중인 압축 하나를 기다린다. 예전에는 요청마다 zlib.gzip 을 시작했다(스냅샷 교체 직후 수 MB × N).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { compression } from '../src/util/compress.js';

function fire(body) {
  const req = { method: 'GET', headers: { 'accept-encoding': 'gzip' } };
  const headers = new Map();
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader: (k, v) => headers.set(k.toLowerCase(), v),
    getHeader: (k) => headers.get(k.toLowerCase()),
    end: (buf) => resolve({ buf, headers }),
    json: () => { throw new Error('원본 res.json 폴백은 이 경로에서 호출되면 안 된다'); },
  };
  compression()(req, res, () => {});
  res.json(body);
  return done;
}

const bigBody = () => ({ rows: Array.from({ length: 2000 }, (_, i) => ({ i, name: `vm-${i}`, note: 'x'.repeat(20) })) });

test('같은 payload 동시 요청 5개 → zlib.gzip 1회 · 5개 모두 같은 gzip 본문', async () => {
  const orig = zlib.gzip;
  let calls = 0;
  zlib.gzip = (...a) => { calls++; return orig.apply(zlib, a); };
  try {
    const body = bigBody();
    const outs = await Promise.all([fire(body), fire(body), fire(body), fire(body), fire(body)]);
    assert.equal(calls, 1, `gzip 을 ${calls}번 했다 — 진행 중인 압축을 공유하지 않는다`);
    for (const o of outs) {
      assert.equal(o.headers.get('content-encoding'), 'gzip');
      assert.deepEqual(JSON.parse(zlib.gunzipSync(o.buf).toString('utf8')), body);
    }
    await fire(body);                 // 끝난 뒤의 요청은 캐시된 gz(재압축 없음)
    assert.equal(calls, 1);
  } finally { zlib.gzip = orig; }
});

test('압축이 실패하면 기다리던 요청은 원본으로 답하고, 다음 요청은 다시 시도한다', async () => {
  const orig = zlib.gzip;
  let calls = 0; let fail = true;
  zlib.gzip = (buf, cb) => { calls++; if (fail) { setImmediate(() => cb(new Error('boom'))); return undefined; } return orig.call(zlib, buf, cb); };
  try {
    const body = bigBody();
    const outs = await Promise.all([fire(body), fire(body)]);
    assert.equal(calls, 1);
    for (const o of outs) {
      assert.equal(o.headers.get('content-encoding'), undefined, '실패 시 원본');
      assert.deepEqual(JSON.parse(o.buf.toString('utf8')), body);
    }
    fail = false;
    await new Promise((r) => setImmediate(r));
    const again = await fire(body);
    assert.equal(calls, 2, '실패한 압축을 기억하지 않고 다시 시도한다');
    assert.equal(again.headers.get('content-encoding'), 'gzip');
  } finally { zlib.gzip = orig; }
});
