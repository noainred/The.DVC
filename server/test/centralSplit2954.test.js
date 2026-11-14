/**
 * centralSplit2954.test.js — routes/central.js 영역별 분할(v2.954 · 개선 검토 4번 · 사용자 선택 '동작 그대로 영역별 파일 이동').
 *  분할 때 한 번: 분할 전(main 1164e80d) · 분할 뒤 centralRouter.stack 69칸을 (경로 · 메서드 · 순서 · 개수)로 대조해 0 차이 — ⚠ 정정(반증): '핸들러 본문 해시' 도 대조했다고
 *  적었으나 wrapAsyncRouter 래퍼 때문에 69칸 해시가 전부 같은 값이라 본문은 대조되지 않았다. 반증 담당이 acorn 원문 비교로 라우트 69건 본문 · 옮긴 최상위 선언을 따로 대조해 0 차이(의도한 onlyDelegated 경로 해석 1건 제외).
 *  여기서는 그 구조가 유지되는지 고정한다:
 *   ① 영역 파일은 central.js 를 import 하지 않는다(순환 금지 — archScan IMPORT_CYCLE_MAX) · 공용 판정은 register*(centralRouter, deps) 인자로
 *   ② central.js 의 register 호출 순서 == _centralSource.CENTRAL_PARTS == routes/central/ 의 파일 집합
 *   ③ 소스의 라우트 선언 수 == 실제 centralRouter 라우트 수(선언이 빠지거나 두 번 등록되지 않았다) · 영역 파일의 경로가 실제로 등록돼 있다
 *   ④ 경로 문자열로 동적 import 하는 공용 함수(onlyDelegated)는 routes/ 기준으로 푼다(분할 때 실제로 깨졌던 것 — 미위임 필터가 500)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CENTRAL_PARTS, centralSource } from './_centralSource.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'csplit2954-'));
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

test('① 영역 파일은 central.js 를 import 하지 않는다(순환 금지) · 공용 판정은 인자로', () => {
  for (const m of CENTRAL_PARTS) {
    const s = read(`routes/central/${m}.js`);
    assert.ok(!/from '\.\.\/central\.js'/.test(s) && !/import\('\.\.\/central\.js'\)/.test(s), `${m}: central.js 를 import 하면 순환이 생긴다`);
    assert.match(s, /export function register\w+\(centralRouter, deps\) \{/);
  }
});

test('② register 호출 순서 == CENTRAL_PARTS == 파일 집합', () => {
  const c = read('routes/central.js');
  const order = [...c.matchAll(/^register(\w+)\(centralRouter, \{/gm)].map((m) => m[1]);
  const files = fs.readdirSync(path.join(SRC, 'routes/central')).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3)).sort();
  assert.deepEqual([...CENTRAL_PARTS].sort(), files);
  assert.deepEqual(order.map((x) => x[0].toLowerCase() + x.slice(1)), [...CENTRAL_PARTS]);
});

test('③ 소스 라우트 선언 수 == 실제 라우트 수 · 영역 파일 경로가 등록돼 있다', async () => {
  const { centralRouter } = await import('../src/routes/central.js');
  const routes = centralRouter.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods).sort().join(',')} ${l.route.path}`);
  const decl = [...centralSource().matchAll(/^\s*centralRouter\.(get|post|put|delete|patch)\('([^']+)'/gm)].map((m) => `${m[1]} ${m[2]}`);
  assert.equal(routes.length, decl.length, '선언 수와 등록 수가 같다');
  assert.deepEqual(routes, decl, '등록 순서도 소스 순서(central.js 앞부분 → 영역 파일 → central.js 뒷부분 없음)와 같다');
  for (const m of CENTRAL_PARTS) {
    const paths = [...read(`routes/central/${m}.js`).matchAll(/centralRouter\.(get|post)\('([^']+)'/g)].map((x) => x[2]);
    assert.ok(paths.length > 0, m);
    for (const p of paths) assert.ok(routes.some((r) => r.endsWith(` ${p}`)), `${m}: ${p} 미등록`);
  }
});

test('④ onlyDelegated 는 routes/ 기준 경로로 등록부를 연다(분할 뒤 실제로 깨졌던 것)', async () => {
  const S = await import('../src/routes/central/storageRoutes.js');
  const r = await S.onlyDelegated([{ id: 'x' }], (d) => d.id, '../storage/registry.js');
  assert.ok(r && Array.isArray(r.list), JSON.stringify(r));
});
