// v3.12.5 — 표 행(tr) 안에서 셀 뒤 같은 줄에 공백 + {표현식}(주석 포함)을 두면 공백 텍스트 노드가 tr 의 자식이 된다 →
//   React 'validateDOMNesting: Whitespace text nodes cannot appear as a child of <tr>' (2차 루프 개발 빌드 스윕에서 v3.12.3 이 만든 것을 재현).
//   셀(td · th)을 닫은 뒤 같은 줄에 공백과 { 가 오면 막는다 — 주석은 셀 위 줄에 둔다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (p.endsWith('.jsx')) out.push(p);
  }
  return out;
}

describe('tr 안 공백 텍스트 노드 금지(셀 뒤 같은 줄의 공백 + {)', () => {
  it('web/src 의 .jsx 에 `</td>   {` · `</th>   {` 가 없다', () => {
    const bad = [];
    for (const f of walk(SRC)) {
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      lines.forEach((l, i) => { if (/<\/t[dh]>[ \t]+\{/.test(l)) bad.push(`${path.relative(SRC, f)}:${i + 1}`); });
    }
    expect(bad).toEqual([]);
  });
});
