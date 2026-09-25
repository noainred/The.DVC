/**
 * V5 셸 소스 규약(v2.616) — 단위 테스트가 못 보는 연결을 소스로 고정한다.
 *   ① App 은 V5 를 lazy 로 불러온다(초기 번들 보호 — V4 와 같은 규약)
 *   ② V5 셸은 /health·/vcenters 를 다시 폴링하지 않는다(App 것을 props 로 받는다)
 *   ③ 통신 지도 호출은 '관리자 + 전체 범위 + 도구 허용' 조건 아래에서만(403 을 만들지 않는다)
 *   ④ V5 CSS 는 .v5 아래로 한정 · uppercase 금지
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { stripComments } from '../test/_stripComments.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

describe('V5 셸 연결', () => {
  it('App 은 V5 를 lazy 로 불러온다', () => {
    const app = stripComments(read('../App.jsx'));
    expect(app).toMatch(/const V5Shell = lazy\(\(\) => import\('\.\/version_5\/V5Shell\.jsx'\)\)/);
    expect(app).not.toMatch(/import V5Shell from/);
    // V4·콘솔 판정이 먼저다
    expect(app.indexOf('if (consoleOn)')).toBeLessThan(app.indexOf('if (v5On)'));
    expect(app.indexOf('if (v4On)')).toBeLessThan(app.indexOf('if (v5On)'));
  });
  it('V5 셸은 /health · /vcenters 를 폴링하지 않는다', () => {
    const src = stripComments(read('./V5Shell.jsx'));
    expect(src).not.toMatch(/usePolling\('\/health'/);
    expect(src).not.toMatch(/usePolling\('\/vcenters'/);
  });
  it('통신 지도는 조건부로만 부른다', () => {
    const src = stripComments(read('./V5Shell.jsx'));
    expect(src).toMatch(/const commOk = isAdmin && fullScope && toolAllowed\('comm-map'\)/);
    expect(src).toMatch(/usePolling\(commOk \? '\/tools\/comm-map' : ''/);
  });
  it('CSS 는 .v5 아래로 한정하고 uppercase 를 쓰지 않는다', () => {
    const css = read('./v5.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/text-transform\s*:\s*uppercase/);
    const selectors = css.replace(/@media[^{]+\{/g, '').split('}').map((b) => b.split('{')[0].trim()).filter(Boolean);
    const bad = selectors.flatMap((s) => s.split(',').map((x) => x.trim())).filter((x) => !x.startsWith('.v5'));
    expect(bad).toEqual([]);
  });
});
