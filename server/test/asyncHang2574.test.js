/**
 * v2.574 — **무응답(hang) 결함 3건** 회귀 고정 (2026-09-21 감사 BUG-01·02·03).
 *
 * ⚠⚠ 이 세 건의 공통 기전: **express 4 는 async 핸들러의 throw 를 잡지 않는다.**
 * 동기 throw 는 전역 에러 핸들러로 가지만 async reject 는 아무도 응답하지 않아
 * **그 요청이 영원히 매달리고 소켓 fd 가 잡힌다**. `index.js` 의 `unhandledRejection`
 * 리스너는 로그만 남기고 계속 실행하므로 프로세스는 죽지 않는다 — 그래서 더 안 보인다.
 *
 * 감사 실측(수정 전):
 *   · `GET /api/tools/pdu/series/power?ids=x&hours=1e400` → `code=000 / 8.002s`(무응답),
 *     서버 로그 `Error: no such column: Infinity at powerSeries (pdu/db.js:144:24)`.
 *     매달린 요청 40개에 프로세스 fd **111 → 151**.
 *   · `POST /api/svcmon/push-now`(중앙 불통) → `code=000 / 20.002s`.
 *     형제 `config-pull-now` 는 catch 가 있어 `202 / 0.0044s`.
 *
 * 수정 후 실측: 각각 `200 / 0.012s`, `202 / 0.015s`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { asyncRoute, wrapAsyncRouter } from '../src/util/asyncRoute.js';
import { rangeOf } from '../src/pdu/db.js';
// ⚠ 주석 제거는 공용 코어를 쓴다 — 정규식 2줄 판본은 줄 주석 안의 `/` `*` 조합에
//   걸려 **코드를 통째로 지운다**(이 테스트가 실제로 그 오탐을 냈다). `_stripComments.js` 머리말.
import { stripComments } from './_stripComments.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/* ── BUG-01 · pdu rangeOf 가 SQL 에 넣을 수 없는 값을 만들지 않는다 ───────────── */

describe('BUG-01 — pdu rangeOf 는 bucketMs 를 항상 유한한 양의 정수로 준다', () => {
  // ⚠ bucketMs 는 템플릿 리터럴로 SQL 에 보간된다(`(ts/${bucketMs})`). Infinity·NaN 이면
  //   SQLite 가 식별자로 파싱해 prepare() 가 던지고, 그 라우트가 매달린다.
  const HOSTILE = [
    { hours: '1e400' }, { to: '1e400' }, { from: '1e400' }, { points: '1e400' },
    { hours: Infinity }, { hours: -Infinity }, { hours: NaN }, { hours: 'abc' },
    { hours: '' }, { hours: null }, { hours: [] }, { hours: {} },
    { points: 0 }, { points: -5 }, { points: '1e400' },
    { from: 9e15, to: 1 },              // 뒤집힌 구간
    { from: 0 },                        // epoch — 보존기간 밖
    { to: 8.64e15 },                    // Date 상한 근처
    {},
  ];
  for (const opts of HOSTILE) {
    test(`적대적 입력 ${JSON.stringify(opts)}`, () => {
      const r = rangeOf(opts);
      assert.ok(Number.isSafeInteger(r.bucketMs), `bucketMs 가 안전 정수가 아니다: ${r.bucketMs}`);
      assert.ok(r.bucketMs > 0, `bucketMs 가 양수가 아니다: ${r.bucketMs}`);
      assert.ok(Number.isFinite(r.since) && Number.isFinite(r.until), 'since/until 이 유한하지 않다');
      assert.ok(r.since < r.until, 'since 가 until 보다 앞서야 한다');
      // SQL 에 그대로 들어가므로 숫자 이외의 글자가 섞이면 안 된다.
      assert.match(String(r.bucketMs), /^\d+$/);
    });
  }

  test('정상 입력은 예전과 같은 창을 준다(회귀 없음)', () => {
    const r = rangeOf({ hours: 24, points: 120 });
    assert.equal(Math.round((r.until - r.since) / 3_600_000), 24);
    assert.equal(r.bucketMs, 720_000);   // 24h / 120점 = 12분
  });

  test('보존 기간보다 더 과거는 받지 않는다 — 버킷 축이 무의미해지지 않게', () => {
    const r = rangeOf({ from: 0 });
    const days = (r.until - r.since) / 86_400_000;
    assert.ok(days <= 401, `보존기간(400일)을 넘겼다: ${days}일`);
  });
});

/* ── BUG-03 · async 라우트 래퍼 ──────────────────────────────────────────────── */

describe('BUG-03 — wrapAsyncRouter 가 async throw 를 전역 핸들러로 보낸다', () => {
  /** 실제 express 앱을 띄워 **응답이 오는지**로 본다(소스 grep 이 아니다 — v2.506 교훈). */
  const withApp = async (build, fn) => {
    const app = express();
    build(app);
    app.use((err, req, res, _next) => res.status(500).json({ error: 'internal error' }));
    const srv = app.listen(0);
    try { await fn(srv.address().port); } finally { srv.close(); }
  };
  const hit = async (port, p) => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(1500) });
      return r.status;
    } catch { return 'NO-RESPONSE'; }
  };

  test('감싼 라우터: async throw → 500 (무응답이 아니다)', async () => {
    await withApp((app) => {
      const r = wrapAsyncRouter(express.Router());
      r.get('/boom', async () => { throw new Error('boom'); });
      app.use('/t', r);
    }, async (port) => assert.equal(await hit(port, '/t/boom'), 500));
  });

  test('감싼 라우터: 동기 throw 도 그대로 500 (기존 동작 보존)', async () => {
    await withApp((app) => {
      const r = wrapAsyncRouter(express.Router());
      r.get('/boom', () => { throw new Error('boom'); });
      app.use('/t', r);
    }, async (port) => assert.equal(await hit(port, '/t/boom'), 500));
  });

  test('정상 라우트는 영향을 받지 않는다', async () => {
    await withApp((app) => {
      const r = wrapAsyncRouter(express.Router());
      r.get('/ok', (req, res) => res.json({ ok: true }));
      r.get('/aok', async (req, res) => res.json({ ok: true }));
      app.use('/t', r);
    }, async (port) => {
      assert.equal(await hit(port, '/t/ok'), 200);
      assert.equal(await hit(port, '/t/aok'), 200);
    });
  });

  test('미들웨어 체인(여러 핸들러)도 전부 감싸진다', async () => {
    await withApp((app) => {
      const r = wrapAsyncRouter(express.Router());
      r.get('/chain', (req, res, next) => next(), async () => { throw new Error('late'); });
      app.use('/t', r);
    }, async (port) => assert.equal(await hit(port, '/t/chain'), 500));
  });

  test('★ 동기 핸들러는 **동기로** 실행된다 — 라우터 스택을 직접 부르는 하니스가 있다', () => {
    /*
     * v2.574 초판이 `Promise.resolve().then(() => handler(...))` 로 감쌌다가
     * `test/collectorDiag2437.test.js:23`(라우터 스택에서 핸들러를 꺼내 **동기로 부르고 바로
     * 단언**하는 하니스)을 깨뜨렸다(6통과 → 3실패). 동기 throw 는 express 가 이미 잡으므로
     * 미룰 이유가 없다 — 되돌리지 말 것.
     */
    let ran = false;
    asyncRoute((req, res) => { ran = true; res.ok = true; })({}, {}, () => {});
    assert.equal(ran, true, '동기 핸들러가 마이크로태스크로 밀렸다');
  });

  test('동기 throw 는 **동기로** next(err) 로 간다', () => {
    let got = null;
    asyncRoute(() => { throw new Error('sync'); })({}, {}, (e) => { got = e; });
    assert.equal(got?.message, 'sync');
  });

  test('프라미스를 반환하는 동기 함수도 덮는다(async 키워드가 없어도)', async () => {
    let got = null;
    asyncRoute(() => Promise.reject(new Error('thenable')))({}, {}, (e) => { got = e; });
    await new Promise((r) => setImmediate(r));
    assert.equal(got?.message, 'thenable');
  });

  test('4-인자 에러 핸들러는 감싸지 않는다 — 감싸면 express 가 인식하지 못한다', () => {
    const eh = (err, req, res, next) => next(err);
    assert.equal(asyncRoute(eh), eh);
    assert.equal(asyncRoute(eh).length, 4);
  });

  test('이중 래핑하지 않는다(멱등)', () => {
    const h = async () => {};
    const once = asyncRoute(h);
    assert.equal(asyncRoute(once), once);
    const r = express.Router();
    assert.equal(wrapAsyncRouter(r), wrapAsyncRouter(r));
  });

  test('★ 라우터 14개가 전부 감싸져 있다 — 새 라우터가 조용히 빠지는 것을 막는다', () => {
    const files = fs.readdirSync(path.join(SRC, 'routes')).filter((f) => f.endsWith('.js'));
    const missing = [];
    for (const f of files) {
      const src = stripComments(fs.readFileSync(path.join(SRC, 'routes', f), 'utf8'));
      const decls = [...src.matchAll(/(?:export\s+)?const\s+(\w+)\s*=\s*(?:express\.)?Router\(\)/g)];
      for (const m of decls) {
        if (!new RegExp(`wrapAsyncRouter\\(\\s*${m[1]}\\s*\\)`).test(src)) missing.push(`${f}:${m[1]}`);
      }
    }
    assert.deepEqual(missing, [], `wrapAsyncRouter 가 빠진 라우터: ${missing.join(', ')}`);
  });

  test('★ 감싸기가 라우트 등록보다 앞에 있다 — 뒤에 있으면 그 앞 라우트는 보호되지 않는다', () => {
    const files = fs.readdirSync(path.join(SRC, 'routes')).filter((f) => f.endsWith('.js'));
    const late = [];
    for (const f of files) {
      const src = stripComments(fs.readFileSync(path.join(SRC, 'routes', f), 'utf8'));
      const m = /wrapAsyncRouter\(\s*(\w+)\s*\)/.exec(src);
      if (!m) continue;
      const wrapAt = m.index;
      const first = new RegExp(`\\b${m[1]}\\.(get|post|put|patch|delete|head|options|all)\\s*\\(`).exec(src);
      if (first && first.index < wrapAt) late.push(f);
    }
    assert.deepEqual(late, [], `라우트 등록 뒤에 감쌌다: ${late.join(', ')}`);
  });
});

/* ── BUG-02 · svcmon push 가 실패를 삼키지 않는다 ────────────────────────────── */

describe('BUG-02 — pushSvcmonNow 는 실패해도 던지지 않고 상태에 남긴다', () => {
  test('소스에 catch 가 있고 그 안에서 last 를 기록한다', () => {
    const src = stripComments(fs.readFileSync(path.join(SRC, 'agent', 'svcmonPush.js'), 'utf8'));
    const fn = src.slice(src.indexOf('export async function pushSvcmonNow'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
    assert.match(body, /\}\s*catch\s*\(/, 'pushSvcmonNow 에 catch 가 없다 — throw 가 라우트를 매달리게 한다');
    const cat = body.slice(body.search(/\}\s*catch\s*\(/));
    assert.match(cat, /last\s*=/, 'catch 안에서 last 를 기록하지 않는다 — 화면이 "아직 안 보냄" 이라 거짓말한다');
    assert.match(cat, /error/, 'catch 가 사유를 남기지 않는다');
  });

  test('★ push 진입 함수 전부가 catch 를 갖는다 — 무음 실패 금지(v2.549·2.561·2.566)', () => {
    const dir = path.join(SRC, 'agent');
    const bad = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      const src = stripComments(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const m of src.matchAll(/export async function (push\w*Now|run\w*Once)\b/g)) {
        const body = src.slice(m.index);
        const end = body.indexOf('\n}\n');
        const fnBody = end > 0 ? body.slice(0, end) : body;
        // 본문에 catch 가 있거나, 내부 함수에 위임(`Inner`/`_`)하고 그쪽에 catch 가 있으면 된다.
        if (/\bcatch\b/.test(fnBody)) continue;
        const dele = /return await (\w+)\(/.exec(fnBody);
        if (dele) {
          const inner = src.slice(src.indexOf(`function ${dele[1]}`));
          if (/\bcatch\b/.test(inner.slice(0, inner.indexOf('\n}\n')))) continue;
        }
        bad.push(`${f}::${m[1]}`);
      }
    }
    assert.deepEqual(bad, [], `catch 가 없는 push/pull 진입 함수: ${bad.join(', ')}`);
  });
});
