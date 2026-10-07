/**
 * audit2721d.test.js — v2.721(감사 R2-04): 기여도 표 안내의 표시 조건은 contribNote(contrib) 문장 자체다.
 *   전력만 빠진 경우(excluded·carried·dsUnknown 모두 0)에도 안내가 보여야 한다 — 두 Summary 화면.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contribNote } from '../version_6/v6Data.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');

/** 화면의 표시 조건을 그대로 흉내 낸다 — 각 Summary 의 JSX 조건식을 소스에서 뽑아 평가한다. */
function guardOf(src) {
  const m = src.match(/\{([^{}]*(?:\([^()]*\))?[^{}]*?)\s*&&\s*<(?:span|div)[^>]*>\{contribNote\(contrib\)\}/);
  if (!m) throw new Error('기여도 안내 조건을 찾지 못했다');
  return new Function('contrib', 'contribNote', `return (${m[1]});`);
}

const powerOnly = { rows: [], total: { powerKw: 2.5 }, missing: { powerKw: 1 }, excluded: 0, carried: 0, dsUnknown: 0 };

describe('기여도 안내 표시 조건 (R2-04)', () => {
  it('전력만 빠진 경우 contribNote 는 문장을 만든다', () => {
    expect(contribNote(powerOnly)).toMatch(/전력 열은/);
  });
  for (const rel of ['../version_6/pages/Summary.jsx', './Summary.jsx']) {
    it(`${rel}: 전력만 빠져도 안내를 보이고, 문장이 없으면 숨긴다`, () => {
      const g = guardOf(read(rel));
      expect(!!g(powerOnly, contribNote)).toBe(true);
      expect(!!g({ excluded: 0, carried: 0, dsUnknown: 0, missing: {} }, contribNote)).toBe(false);
    });
  }
});
