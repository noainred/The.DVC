// v2.603 감사 WEB2603-02 — 로그 분석의 주 실행 버튼('분석'·'저널 읽고 분석'·'붙여넣은 로그 분석')이
// 전역 .tab(테두리·배경 없음)이라 맨 글자로 보였다. 주 동작 버튼은 채움 스타일(login-btn)이어야 한다.
import { it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'LogAnalysis.jsx'), 'utf8');

it('WEB2603-02 실행 버튼(run 호출)은 className="tab" 이 아니다', () => {
  const buttons = [...SRC.matchAll(/<button\b[^>]*onClick=\{\(\) => run\([^)]*\)\}[^>]*>/g)].map((m) => m[0]);
  expect(buttons.length).toBe(2);
  for (const b of buttons) {
    expect(b).not.toMatch(/className="tab"/);
    expect(b).toMatch(/className="login-btn"/);
  }
});
