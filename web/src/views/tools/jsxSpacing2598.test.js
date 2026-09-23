/**
 * v2.598 WEBUI-2598-08 — JSX 줄바꿈이 문장 사이 공백을 지운다('보냅니다.상태가').
 * JSX 는 텍스트와 요소 사이의 '개행 + 들여쓰기' 를 통째로 지운다 — 문장 끝(마침표)에서 줄을 바꾸고
 * 다음 줄이 요소(<b> 등)로 시작하거나, 요소(</b>)로 끝난 줄 다음에 문장이 오면 두 문장이 붙는다.
 * 명시 공백 {' '} 이 있어야 한다. 이 파일은 PduTool.jsx 를 고정한다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function gluedLines(src) {
  const L = src.split('\n');
  const out = [];
  for (let i = 0; i < L.length - 1; i++) {
    const a = L[i].trimEnd(); const b = L[i + 1].trim(); const at = a.trim();
    if (at.startsWith('//') || at.startsWith('{') || at.startsWith('*') || at.startsWith('<')) {
      // 요소로 끝나는 줄 다음 문장
      if (/<\/(b|code|i)>$/.test(a) && /^[가-힣A-Za-z(]/.test(b)) out.push(i + 1);
      continue;
    }
    if (/[.다)\]]$/.test(a) && /^<(b|code|i|span)\b/.test(b)) out.push(i + 1);
    if (/<\/(b|code|i)>$/.test(a) && /^[가-힣A-Za-z(]/.test(b)) out.push(i + 1);
  }
  return out;
}

describe('JSX 문장 사이 공백', () => {
  it('PduTool.jsx 에 문장이 붙는 줄바꿈이 없다', () => {
    const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'PduTool.jsx'), 'utf8');
    expect(gluedLines(src)).toEqual([]);
  });
  it('검출기 자체 — 붙는 형태를 잡는다', () => {
    expect(gluedLines('  <div>\n    보냅니다.\n    <b>상태</b> 알림\n  </div>')).toEqual([2]);
    expect(gluedLines('  <div>\n    <b>않습니다.</b>\n    측정값\n  </div>')).toEqual([2]);
    expect(gluedLines("  <div>\n    보냅니다.{' '}\n    <b>상태</b>\n  </div>")).toEqual([]);
  });
});
