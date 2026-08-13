import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v2.291 라우트 분할(routes/svcmon.js → routes/svcmon/*) 회귀 방지 — 라우트 등록 순서.
//
// 배경(분할 감사에서 확정된 유일한 HIGH 리스크): GET /targets/export.csv 는
// GET /targets/export.:format 패턴에도 매칭된다(format='csv'). 현재는 export.csv 가 먼저
// 등록돼 있고 :format 핸들러는 csv 요청을 404 처리하므로, 등록 순서가 뒤집히면 CSV 내보내기가
// 404 로 죽는데 **서버 기동은 정상**이라 무음 회귀가 된다. 분할 전에는 이 순서를 지키는 테스트가
// 하나도 없었다(감사 지적) — 정적(소스 순서) + 런타임(실제 mount 후 응답) 이중으로 잡는다.
//
// svcmon/store.js 는 import 시점 CONFIG_DIR 을 쓴다 → 저장소 오염 방지를 위해 격리 후 로드.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'svcmon-route-order-'));
process.env.CONFIG_DIR = TMP;

let server; let base;

before(async () => {
  const express = (await import('express')).default;
  const { svcmonRouter } = await import('../src/routes/svcmon.js');
  const app = express();
  app.use(express.json());
  // requireRole 은 req.user.role 을 검사한다(인증 비활성이면 AUTH_DISABLED_ROLE 기본 admin) —
  // 어느 쪽이든 admin 주입으로 canEdit 게이트를 통과시켜 라우팅 자체만 검증한다.
  app.use((req, _res, next) => { req.user = { username: 'route-test', role: 'admin' }; next(); });
  app.use('/api/svcmon', svcmonRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/svcmon`;
});
after(() => { try { server?.close(); } catch { /* */ } try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

test('정적: transfer.js 에서 export.csv 가 export.:format 보다 먼저 등록된다', () => {
  const src = fs.readFileSync(new URL('../src/routes/svcmon/transfer.js', import.meta.url), 'utf8');
  const iCsv = src.indexOf("get('/targets/export.csv'");
  const iFmt = src.indexOf("get('/targets/export.:format'");
  assert.ok(iCsv >= 0, 'export.csv 라우트 존재');
  assert.ok(iFmt >= 0, 'export.:format 라우트 존재');
  assert.ok(iCsv < iFmt, 'export.csv 는 export.:format 보다 먼저 등록돼야 함(역전 시 CSV 다운로드가 404 무음 파손)');
});

test('런타임: GET /targets/export.csv 가 CSV 를 반환한다(:format 의 404 분기에 먹히지 않음)', async () => {
  const r = await fetch(`${base}/targets/export.csv`);
  assert.equal(r.status, 200, 'export.csv 는 200 이어야 함(404 면 등록 순서 역전)');
  assert.match(r.headers.get('content-type') || '', /text\/csv/);
  const body = await r.text();
  assert.ok(body.length > 0, 'CSV 헤더 행이라도 있어야 함(빈 저장소여도 컬럼 행 출력)');
});

test('런타임: GET /targets/export.json 은 :format 경로로 정상 동작(분할로 다른 포맷이 깨지지 않음)', async () => {
  const r = await fetch(`${base}/targets/export.json`);
  assert.equal(r.status, 200);
});

test('런타임: 미지원 포맷은 404(json 오류) — :format 핸들러의 방어 분기 유지', async () => {
  const r = await fetch(`${base}/targets/export.bogus`);
  assert.equal(r.status, 404);
});

test('런타임: 분할 후 각 도메인 모듈의 대표 라우트가 전부 응답한다(등록 누락 감지)', async () => {
  // 모듈당 1개 대표 GET — 하나라도 404(라우트 미등록)면 셸의 register 호출 누락이다.
  // (express 404 는 JSON 이 아닌 HTML 이므로 상태코드로 판별.)
  const reps = [
    ['/state', 'overview'],
    ['/targets/csv-schema', 'transfer'],
    ['/templates', 'templates'],
    ['/batches', 'generate'],
    ['/assign', 'edge'],
    ['/log', 'logs'],
  ];
  for (const [p, mod] of reps) {
    const r = await fetch(`${base}${p}`);
    assert.equal(r.status, 200, `${mod} 모듈 대표 라우트 ${p} 는 200 이어야 함(404 면 register 누락)`);
  }
  // tree 모듈 대표는 GET 이 없어 POST /folders 검증(400=검증 오류라도 라우트는 존재).
  const rf = await fetch(`${base}/folders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.ok(rf.status === 400 || rf.status === 201, `tree 모듈 POST /folders 응답(${rf.status}) — 404 면 register 누락`);
});
