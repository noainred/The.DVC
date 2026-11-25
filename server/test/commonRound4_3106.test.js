/**
 * v3.10.6 — 공통 기능 개선 4회차: **클립보드 복사는 공용 `web/src/util/copyText.js` 하나로**.
 *
 * 고정하는 것:
 *  ① 웹 소스 어디에서도 `navigator.clipboard` 를 직접 부르지 않는다(공용 헬퍼만 — 테스트 파일 제외).
 *     포탈은 사내망 HTTP 로 여는 법인이 많다 — 그때 `navigator.clipboard` 는 없다(보안 컨텍스트 전용).
 *     직접 부르던 25곳 중 상당수가 그 경우 아무 말 없이 실패하거나(`?.writeText` → undefined),
 *     **복사하지 못했는데 '복사했습니다' 를 띄웠다**(FocusMonBulk `copyText` 가 동기로 true 를 돌려줬다).
 *  ② 공용 헬퍼의 결과(Promise<boolean>)를 '복사했습니다' 판정에 쓴다 — 동기 true 로 되돌리지 않는다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WEB = path.join(ROOT, 'web/src');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(jsx?|mjs)$/.test(e.name) && !/\.test\.(jsx?|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('① 웹 소스는 navigator.clipboard 를 직접 부르지 않는다 — 공용 util/copyText.js 만', () => {
  const files = walk(WEB);
  assert.ok(files.length > 200, `웹 소스 ${files.length}개 — 스윕 대상이 비었다`);
  const helper = path.join(WEB, 'util/copyText.js');
  assert.ok(files.includes(helper), '공용 헬퍼가 없다');
  const offenders = [];
  for (const f of files) {
    if (f === helper) continue;
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    src.split('\n').forEach((line, i) => { if (/navigator\s*\.\s*clipboard/.test(line)) offenders.push(`${path.relative(ROOT, f)}:${i + 1}`); });
  }
  assert.deepEqual(offenders, [], `공용 util/copyText.js 를 쓸 것:\n${offenders.join('\n')}`);
  // 헬퍼 자신은 Clipboard API 와 폴백을 함께 가진다(이 스윕이 헬퍼까지 지우게 만들지 않도록).
  const h = stripComments(fs.readFileSync(helper, 'utf8'));
  assert.match(h, /\.clipboard\.writeText\(/);
  assert.match(h, /execCommand\(\s*['"]copy['"]\s*\)/);
});

test('② 복사 결과로 판정한다 — FocusMonBulk copyText 는 공용 헬퍼의 Promise 를 돌려주고, 호출부는 await 한다', () => {
  const p = path.join(WEB, 'views/tools/FocusMonBulk.jsx');
  const src = stripComments(fs.readFileSync(p, 'utf8'));
  assert.match(src, /export function copyText\(t\) \{ return copyToClipboard\(t\); \}/);
  assert.equal(/return true;\s*\}\s*catch/.test(src), false, '동기 true 반환으로 되돌렸다');
  const calls = [...src.matchAll(/copyText\(/g)].length;
  const awaited = [...src.matchAll(/await copyText\(/g)].length;
  // 정의 1 + 호출부 전부 await.
  assert.equal(awaited, calls - 1, `copyText 호출 ${calls - 1}곳 중 await ${awaited}곳`);
});
