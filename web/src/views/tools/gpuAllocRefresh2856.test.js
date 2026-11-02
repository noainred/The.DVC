// v2.856 버그 수정 — GPU 할당 계층의 '⟳ 새로 고침' 이 법인 칩 상태 점(/vcenters)을 다시 읽지 않았다(v2.853 보고의 '한계').
// 소스 검사인 이유: node 환경(DOM 없음)이라 렌더 대신 계약(새로 고침 = 계층 + 상태 점 · 다시 읽기 실패는 직전 점 유지)을 고정한다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../test/_stripComments.js';

const src = stripComments(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'GpuAllocTree.jsx'), 'utf8'));

describe('GPU 할당 계층 새로 고침(v2.856)', () => {
  it('load() 가 계층과 함께 상태 점(/vcenters)도 다시 읽는다', () => {
    const at = src.indexOf('const load = () => {');
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf('};', at));
    expect(body).toMatch(/loadVcs\(\)/);
    expect(body).toMatch(/\/tools\/gpu-alloc/);
    expect(src).toMatch(/const loadVcs = \(\) => runVcs\(fetchJson\('\/vcenters'\)/);
  });
  it('상태 점을 마운트에 한 번만 읽던 별도 효과가 없다', () => {
    expect(src).not.toMatch(/useEffect\(\(\) => \{ runVcs\(fetchJson\('\/vcenters'\)/);
  });
  it('다시 읽기가 실패해도 직전 점을 지우지 않는다(처음 실패만 빈 목록)', () => {
    expect(src).toMatch(/\(\) => setVcs\(\(prev\) => prev \?\? \[\]\)/);
  });
  it('새로 고침 버튼은 load 를 부른다', () => {
    expect(src).toMatch(/disabled=\{loading\} onClick=\{load\}/);
  });
});
