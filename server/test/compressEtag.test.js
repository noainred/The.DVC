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

// ── v2.343 #6: payload 객체 identity 캐시(WeakMap) — 직렬화·gzip 스냅샷당 1회 ──

test('같은 payload 객체 재응답은 캐시된 직렬화 버퍼를 쓴다(응답 후 변형 금지 계약 포함)', () => {
  const body = { v: 1 };
  const first = run({ body });
  body.v = 2; // 캐시 대상 payload 는 불변 취급(memoJson 공유 객체 계약) — 변형해도 캐시 본문이 나가야 캐시가 실제 작동한 것
  const second = run({ body });
  assert.equal(String(second.out.body), String(first.out.body), '두 번째 응답이 캐시 버퍼(v:1)여야 한다');
  assert.equal(second.headers.get('etag'), first.headers.get('etag'), 'SHA-1 ETag 도 캐시 재사용');
});

// gzip 경로 비동기(첫 압축) 대응 러너 — end 시점을 promise 로 잡는다.
function runAsync({ headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = { method: 'GET', headers: { 'accept-encoding': 'gzip', ...headers } };
    const resHeaders = new Map();
    const res = {
      headersSent: false,
      statusCode: 200,
      setHeader: (k, v) => resHeaders.set(k.toLowerCase(), v),
      getHeader: (k) => resHeaders.get(k.toLowerCase()),
      end: (buf) => resolve({ status: res.statusCode, body: buf ?? null, headers: resHeaders, syncEnd: !settled }),
      json: () => reject(new Error('원본 res.json 폴백 금지')),
    };
    let settled = false;
    compression()(req, res, () => {});
    res.json(body);
    settled = true; // res.json 이 동기 리턴한 뒤 end 가 왔으면 async(첫 압축), 전이면 sync(캐시 히트)
  });
}

test('같은 payload 의 gzip 은 1회만 — 두 번째 응답은 캐시된 gz 를 동기 전송', async () => {
  const body = { big: 'x'.repeat(4096) }; // MIN_BYTES(1024) 초과 → gzip 경로
  const first = await runAsync({ body });
  assert.equal(first.headers.get('content-encoding'), 'gzip');
  assert.equal(first.syncEnd, false, '첫 응답은 zlib 비동기 콜백에서 종료');
  const second = await runAsync({ body });
  assert.equal(second.headers.get('content-encoding'), 'gzip');
  assert.equal(second.syncEnd, true, '두 번째는 entry.gz 재사용(동기 종료) — 재압축 없음');
  assert.equal(Buffer.compare(first.body, second.body), 0, '압축 본문 동일');
});
