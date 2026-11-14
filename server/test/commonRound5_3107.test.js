/**
 * v3.10.7 — 공통 기능 개선 5회차: 웹 · 서버 쌍둥이(cmpVersion) 와 웹 공용 포맷터(util/fmt.js).
 *
 * 고정하는 것:
 *  ① cmpVersion(서버 · 웹 두 벌) — 세그먼트는 숫자 글자만. 빈 세그먼트(`3..10`·`3.10.`)를 0 으로 읽지 않고 null(모르는 것).
 *     `0x10`·`1e3`·`-1`·` 5` 도 숫자가 아니다. 두 벌은 같은 입력에 같은 답을 낸다(웹은 서버 소스를 import 할 수 없다 — 번들 경계).
 *  ② 웹 linkCheckText 는 cmpVersion 사본을 갖지 않는다(공용 것을 다시 내보낸다 — 옛 사본은 빈 세그먼트를 0 으로 읽었다).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cmpVersion as S } from '../src/util/cmpVersion.js';
import { stripComments } from './_stripComments.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const CASES = [
  ['3.10.7', '3.10.6', 1], ['3.10.6', '3.10.7', -1], ['v3.10.7', '3.10.7', 0], ['3.10', '3.10.0', 0], [' 3.10.7 ', '3.10.7', 0],
  // 못 읽는 것 — 낮은 버전으로 보지 않는다(null).
  ['3..10', '3.0.10', null], ['3.10.', '3.10.0', null], ['.3.10', '0.3.10', null], ['3. 10', '3.10', null],
  ['0x10.0', '16.0', null], ['1e3', '1000', null], ['-1.0', '0.0', null], ['3.10.7-rc1', '3.10.7', null], ['', '1', null], [null, '1', null],
  ['dev', '1.0.0', null], ['2.x', '2.0.0', null],
];

test('① cmpVersion(서버) — 세그먼트는 숫자 글자만 · 빈 세그먼트는 0 이 아니라 null', () => {
  for (const [a, b, want] of CASES) assert.equal(S(a, b), want, `cmpVersion(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
});

test('① cmpVersion 웹 · 서버 두 벌이 같은 입력에 같은 답', async () => {
  const { cmpVersion: W } = await import('../../web/src/cmpVersion.js');
  for (const [a, b] of CASES) assert.equal(W(a, b), S(a, b), `웹/서버 불일치: ${JSON.stringify([a, b])}`);
});

test('② linkCheckText 는 cmpVersion 사본을 두지 않는다(공용 것을 다시 내보낸다)', () => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'web/src/views/tools/linkCheckText.js'), 'utf8'));
  assert.equal(/function\s+cmpVersion\b/.test(src), false, '사본이 되살아났다');
  assert.match(src, /import \{ cmpVersion \} from '\.\.\/\.\.\/cmpVersion\.js'/);
  assert.match(src, /export \{ cmpVersion \}/);
});
