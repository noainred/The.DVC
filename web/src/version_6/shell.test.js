/**
 * V6 셸 소스 규약(v2.623) — 단위 테스트가 못 보는 연결을 소스로 고정한다.
 *   ① App 은 V6 를 lazy 로 불러오고, 콘솔·V4 판정이 먼저, V6 는 V5 보다 먼저 판정한다
 *   ② 해시 동기화가 V6 진입 신호·메뉴 주소(#/m/…)를 기존 탭 주소로 덮지 않는다
 *   ③ V6 셸은 /health·/vcenters 를 다시 폴링하지 않는다(App 것을 props 로 받는다)
 *   ④ /overview 는 서버 메뉴에서만 부른다(다른 메뉴 페이지는 폴링 0)
 *   ⑤ V6 CSS 는 .v6 아래로 한정 · uppercase 금지
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { stripComments } from '../test/_stripComments.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

describe('V6 셸 연결', () => {
  it('App 은 V6 를 lazy 로 불러오고 판정 순서는 콘솔 → V4 → V6 → V5', () => {
    const app = stripComments(read('../App.jsx'));
    expect(app).toMatch(/const V6Shell = lazy\(\(\) => import\('\.\/version_6\/V6Shell\.jsx'\)\)/);
    expect(app).not.toMatch(/import V6Shell from/);
    expect(app.indexOf('if (consoleOn)')).toBeLessThan(app.indexOf('if (v6On) {'));
    expect(app.indexOf('if (v4On)')).toBeLessThan(app.indexOf('if (v6On) {'));
    expect(app.indexOf('if (v6On) {')).toBeLessThan(app.indexOf('if (v5On) {'));
  });
  it('해시 동기화가 V6 진입 신호·메뉴 주소를 덮지 않는다', () => {
    const app = stripComments(read('../App.jsx'));
    expect(app).toMatch(/!isV6Hash\(window\.location\.hash\) && !isMenuHash\(window\.location\.hash\)\) window\.history\.replaceState/);
  });
  it('V6 셸은 /health · /vcenters 를 폴링하지 않는다', () => {
    const src = stripComments(read('./V6Shell.jsx'));
    expect(src).not.toMatch(/usePolling\(/);
  });
  it('/overview 는 서버 메뉴 전용 컴포넌트에서만 부른다', () => {
    const src = stripComments(read('./pages/MenuPage.jsx'));
    expect(src).toMatch(/function ServerExtras[\s\S]*usePolling\('\/overview'/);
    expect(src).toMatch(/m\.id === 'server' && <ServerExtras/);
    expect((src.match(/usePolling\(/g) || []).length).toBe(1);
  });
  it('CSS 는 .v6 아래로 한정하고 uppercase 를 쓰지 않는다', () => {
    const css = read('./v6.css').replace(/\/\*[\s\S]*?\*\//g, '').replace(/@keyframes[^{]+\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, '');
    expect(css).not.toMatch(/text-transform\s*:\s*uppercase/);
    const selectors = css.replace(/@media[^{]+\{/g, '').split('}').map((b) => b.split('{')[0].trim()).filter(Boolean);
    const bad = selectors.flatMap((s) => s.split(',').map((x) => x.trim())).filter((x) => !x.startsWith('.v6'));
    expect(bad).toEqual([]);
  });
  it('설정 › 신규 포탈 보기에 V6 입구가 있다', () => {
    const src = stripComments(read('../views/V4Portal.jsx'));
    expect(src).toMatch(/writeShellV6\(true\); window\.location\.hash = '#\/v6'/);
  });
});
