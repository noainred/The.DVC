// v2.974 시리얼 조회 UUID 는 관리자 판본만(사용자 요청 2026-11-11 'R3 시리얼 조회 UUID 도 관리자만 보이게').
//   하드웨어 내보내기(UUID adminOnly) · 서버 상세 인벤토리(maskInventoryForViewer)와 같은 기준. 행 · 개수 · CSV 모두.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { serialRowsForViewer, ADMIN_ONLY_SERIAL_TYPES } from '../src/routes/api/serialLookup.js';
import { stripComments } from './_stripComments.js';

const rows = [
  { kind: 'server', serialType: '서비스 태그', key: 'abc1234' },
  { kind: 'server', serialType: 'UUID', key: '4c4c4544' },
  { kind: 'server', serialType: '자산 태그', key: 'a77' },
  { kind: 'disk', serialType: '', key: 's1' },
];

test('비관리자는 UUID 행을 받지 않는다 · 관리자는 그대로(같은 배열)', () => {
  assert.deepEqual(serialRowsForViewer(rows, false).map((r) => r.key), ['abc1234', 'a77', 's1']);
  assert.equal(serialRowsForViewer(rows, true), rows);
  assert.deepEqual(serialRowsForViewer(null, false), []);
  assert.deepEqual([...ADMIN_ONLY_SERIAL_TYPES], ['UUID']);
});

test('화면 · CSV 두 라우트가 모두 걸러진 행으로 검색 · 집계한다(개수로 존재를 흘리지 않게)', () => {
  const src = stripComments(fs.readFileSync(new URL('../src/routes/api/serialLookup.js', import.meta.url), 'utf8'));
  assert.equal((src.match(/serialRowsForViewer\(idx\.rows, /g) || []).length, 2, '두 라우트');
  assert.doesNotMatch(src, /searchSerials\(idx\.rows/, '원본 행으로 검색하지 않는다');
  assert.doesNotMatch(src, /for \(const r of idx\.rows\)/, '원본 행으로 세지 않는다');
  assert.match(src, /total: all\.length/); assert.match(src, /uniqueSerials: new Set\(all\.map/);
  // 이 UUID 행의 이름표는 수집 쪽(insights/serialLookup.js)의 'UUID' 와 같아야 한다 — 이름표가 바뀌면 거르지 못한다.
  const col = fs.readFileSync(new URL('../src/insights/serialLookup.js', import.meta.url), 'utf8');
  assert.match(col, /\['uuid', 'UUID'\]/);
});
