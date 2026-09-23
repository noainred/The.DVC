/**
 * v2.583 — '불러오는 중…' 의 지연 주체를 요청 ID 로 가리킨다(사용자 요청 "누가 이 메시지의 지연을
 * 발생시켰는지 ID 도 같이 보여줘"). 회귀 고정:
 *  ① ID 형식 검사(로그 한 줄 위조·길이 증폭 차단) ② 진행 중 → processing · 끝난 뒤 → done · 모름 → unknown
 *  ③ 소유자만 본다(남의 ID 를 알아도 경로·시간을 못 본다 — 관리자는 전부) ④ 느린 요청 기록에 ID 가 실린다
 *  ⑤ 실제 라우터(GET /perf/req-status)가 사용자로 거른다 ⑥ index.js 가 헤더를 읽고 돌려주고 라이브 로그에 싣는다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rid-'));
process.env.CONFIG_DIR = tmp;

const R = await import('../src/perf/requestId.js');
const M = await import('../src/perf/monitor.js');
const SET = await import('../src/perf/settings.js');

test('① sanitizeRid — 영숫자 시작 · [A-Za-z0-9._-] · 4~40자만 받는다', () => {
  assert.equal(R.sanitizeRid('wab12cd-1f'), 'wab12cd-1f');
  assert.equal(R.sanitizeRid('  wab1-2  '), 'wab1-2', '앞뒤 공백은 다듬는다');
  for (const bad of ['', 'abc', '-abcd', 'a b c d', 'ab\ncd', 'x'.repeat(41), '<script>', null, undefined, ['wab1-2'], { a: 1 }]) {
    assert.equal(R.sanitizeRid(bad), '', `거부해야 함: ${JSON.stringify(bad)}`);
  }
  const a = R.newRid(); const b = R.newRid();
  assert.notEqual(a, b);
  assert.equal(R.sanitizeRid(a), a, '서버가 만든 ID 도 같은 형식');
});

test('② ③ requestStatus — processing/done/unknown · 소유자만', () => {
  M._resetPerfMonitorForTest();
  let who = '';
  const id = M.beginRequest({ method: 'GET', path: '/api/admin/vclogs/settings', rid: 'wtest1-a', userOf: () => who });
  // 인증 전(사용자 모름)에는 일반 사용자에게도 보이지 않는다 — 누구의 요청인지 모르기 때문.
  assert.deepEqual(M.requestStatus(['wtest1-a'], { user: 'alice' }), { 'wtest1-a': { state: 'unknown' } });
  who = 'alice';
  const p = M.requestStatus(['wtest1-a', 'nope-1234', 'bad id'], { user: 'alice' });
  assert.equal(p['wtest1-a'].state, 'processing');
  assert.equal(p['wtest1-a'].method, 'GET');
  assert.equal(p['wtest1-a'].user, 'alice', 'v2.585: 요청자(로그인 계정)를 싣는다');
  assert.ok(p['wtest1-a'].serverMs >= 0);
  assert.equal(p['nope-1234'].state, 'unknown');
  assert.ok(!('bad id' in p), '형식이 틀린 ID 는 응답에 싣지 않는다');
  assert.equal(M.requestStatus(['wtest1-a'], { user: 'bob' })['wtest1-a'].state, 'unknown', '남의 요청은 보이지 않는다');
  assert.equal(M.requestStatus(['wtest1-a'], { user: 'bob', isAdmin: true })['wtest1-a'].state, 'processing', '관리자는 전부');
  M.endRequest(id, { method: 'GET', path: '/api/admin/vclogs/settings', route: '/api/admin/vclogs/settings', status: 200, ms: 6100, user: 'alice' });
  const d = M.requestStatus(['wtest1-a'], { user: 'alice' })['wtest1-a'];
  assert.equal(d.state, 'done');
  assert.equal(d.status, 200);
  assert.equal(d.user, 'alice', 'v2.585: 완료 기록에도 요청자');
  assert.equal(d.serverMs, 6100);
  assert.equal(M.requestStatus(['wtest1-a'], { user: 'bob' })['wtest1-a'].state, 'unknown');
});

test('② 계측이 꺼져 있어도 완료 기록은 남는다(로딩 표시가 기대는 사실)', () => {
  M._resetPerfMonitorForTest();
  SET.savePerfSettings({ enabled: false });
  const id = M.beginRequest({ method: 'GET', path: '/api/x', rid: 'woff-1', userOf: () => 'u1' });
  M.endRequest(id, { method: 'GET', path: '/api/x', status: 200, ms: 5, user: 'u1' });
  assert.equal(M.requestStatus(['woff-1'], { user: 'u1' })['woff-1'].state, 'done');
  SET.savePerfSettings({ enabled: true });
});

test('④ 느린 요청 기록과 진행 중 스냅샷에 요청 ID 가 실린다', () => {
  M._resetPerfMonitorForTest();
  SET.savePerfSettings({ enabled: true, slowRequestMs: 1000 });
  const a = M.beginRequest({ method: 'GET', path: '/api/slow', rid: 'wslow-1', userOf: () => 'u' });
  assert.equal(M.inflightSnapshot(5)[0].rid, 'wslow-1');
  M.endRequest(a, { method: 'GET', path: '/api/slow', route: '/api/slow', status: 200, ms: 4000, user: 'u' });
  const snap = M.perfSnapshot({});
  assert.equal(snap.slow[0].rid, 'wslow-1');
});

test('②-유계 — 완료 기록은 2,000건 상한(오래된 것부터 버린다)', () => {
  M._resetPerfMonitorForTest();
  for (let i = 0; i < 2050; i++) {
    const id = M.beginRequest({ method: 'GET', path: '/api/y', rid: `wcap-${i}`, userOf: () => 'u' });
    M.endRequest(id, { method: 'GET', path: '/api/y', status: 200, ms: 1, user: 'u' });
  }
  assert.equal(M.requestStatus(['wcap-0'], { user: 'u' })['wcap-0'].state, 'unknown');
  assert.equal(M.requestStatus(['wcap-2049'], { user: 'u' })['wcap-2049'].state, 'done');
});

test('⑤ GET /perf/req-status — 실제 등록 함수가 사용자로 거른다', async () => {
  M._resetPerfMonitorForTest();
  const { registerPerfClient } = await import('../src/routes/api/perfClient.js');
  const routes = {};
  const api = { get: (p, h) => { routes[`GET ${p}`] = h; }, post: (p, h) => { routes[`POST ${p}`] = h; } };
  registerPerfClient(api);
  const h = routes['GET /perf/req-status'];
  assert.equal(typeof h, 'function');
  const id = M.beginRequest({ method: 'POST', path: '/api/tools/x', rid: 'wroute-1', userOf: () => 'carol' });
  const call = (user, ids) => new Promise((resolve) => {
    const res = { set() { return res; }, json: (b) => resolve(b) };
    h({ query: { ids }, user }, res);
  });
  const mine = await call({ username: 'carol', role: 'viewer' }, 'wroute-1,zzzz-9');
  assert.equal(mine.items['wroute-1'].state, 'processing');
  assert.equal(mine.items['zzzz-9'].state, 'unknown');
  const other = await call({ username: 'dave', role: 'operator' }, 'wroute-1');
  assert.equal(other.items['wroute-1'].state, 'unknown');
  M.endRequest(id, { method: 'POST', path: '/api/tools/x', status: 500, ms: 12, user: 'carol' });
});

test('⑥ index.js 계측 미들웨어 — 헤더를 읽고, 응답 헤더로 돌려주고, 라이브 로그 줄 끝에 싣는다', () => {
  const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(src, /sanitizeRid\(req\.get\('x-request-id'\)\)\s*\|\|\s*newRid\(\)/);
  assert.match(src, /res\.setHeader\('X-Request-Id', rid\)/);
  assert.match(src, /\$\{req\.method\} \$\{url\} \$\{res\.statusCode\} \$\{ms\}ms\$\{rid \? ` #\$\{rid\}` : ''\}/, '앞부분 형식은 그대로, 끝에 #ID');
  assert.match(src, /beginRequest\(\{ method: req\.method, path: url, rid, userOf:/);
});
