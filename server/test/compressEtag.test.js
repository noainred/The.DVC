// compress 미들웨어 ETag 회귀 테스트(v2.342 성능 1차).
// 고정하는 계약: ① 라우트가 ETag 를 미리 설정(sendCached 의 weakEtag)했으면 compress 가
// SHA-1 태그로 덮어쓰지 않는다 — 종전엔 덮어써서 snapCache 의 '직렬화 전 조기 304' 경로가
// 클라이언트 태그 불일치로 영영 타지지 않았다(확정 버그). ② 라우트 태그가 없으면 기존대로
// 본문 SHA-1 약한 ETag 발급 + If-None-Match 일치 시 304(본문 0바이트).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compression } from '../src/util/compress.js';

// 미들웨어 실행용 최소 req/res 모의(가짜 Express) — res.json 래핑 경로만 검증한다.
function run({ method = 'GET', headers = {}, presetEtag = null, body = { a: 1 } }) {
  const req = { method, headers };
  const resHeaders = new Map();
  const out = { status: null, ended: false, body: null };
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader: (k, v) => resHeaders.set(k.toLowerCase(), v),
    getHeader: (k) => resHeaders.get(k.toLowerCase()),
    end: (buf) => { out.ended = true; out.status = res.statusCode; out.body = buf ?? null; },
    json: () => { throw new Error('원본 res.json 폴백은 이 테스트 경로에서 호출되면 안 된다'); },
  };
  compression()(req, res, () => {});
  if (presetEtag) res.setHeader('ETag', presetEtag); // 라우트(sendCached)가 태그를 먼저 설정한 상황
  res.json(body);
  return { out, headers: resHeaders };
}

test('라우트가 설정한 ETag 를 덮어쓰지 않는다(sendCached weakEtag 보존)', () => {
  const weak = 'W/"abc-key"';
  const { out, headers } = run({ presetEtag: weak });
  assert.equal(headers.get('etag'), weak, 'SHA-1 태그로 덮어쓰면 조기 304 경로가 죽는다');
  assert.equal(out.status, 200);
  assert.ok(out.body && out.body.length > 0, '본문은 정상 전송');
});

test('라우트 태그가 없으면 SHA-1 약한 ETag 발급 + INM 일치 시 304(본문 없음)', () => {
  const first = run({});
  const tag = first.headers.get('etag');
  assert.match(String(tag), /^W\//, '약한 ETag 발급');
  assert.equal(first.out.status, 200);

  const second = run({ headers: { 'if-none-match': tag } });
  assert.equal(second.out.status, 304);
  assert.equal(second.out.body, null, '304 는 본문 0바이트');
});

test('같은 본문이면 같은 태그(안정성) · 다른 본문이면 다른 태그', () => {
  const a1 = run({ body: { x: 1 } }).headers.get('etag');
  const a2 = run({ body: { x: 1 } }).headers.get('etag');
  const b = run({ body: { x: 2 } }).headers.get('etag');
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
});

test('GET 이 아니면 ETag 를 발급하지 않는다(기존 동작 유지)', () => {
  const { headers, out } = run({ method: 'POST' });
  assert.equal(headers.get('etag'), undefined);
  assert.equal(out.status, 200);
});
