/**
 * v2.682 리드 통합분 — R3A-05: 같은 이름 로컬 계정 때문에 AD 를 시도하지 않은 로그인 실패는 감사 detail 에 그 사유를 남긴다
 * (로그인 응답은 그대로 'invalid credentials' — 계정 열거 단서를 만들지 않는다).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripComments } from './_stripComments.js';

const src = stripComments(fs.readFileSync(new URL('../src/routes/auth.js', import.meta.url), 'utf8'));

test('R3A-05 로그인 실패 감사 detail 이 adShadowBlockOf 사유를 싣는다', () => {
  assert.match(src, /adShadowBlockOf\(username\)/);
  assert.match(src, /action: '로그인 실패',\s*detail: \(foldedNote\(sum\.folded\) \+ shadow\)/);
  assert.match(src, /action: '로그인 실패\(잠금 발동\)', detail: shadow/);
  // 응답 본문은 그대로다.
  assert.match(src, /status\(401\)\.json\(\{ error: 'invalid credentials' \}\)/);
});
