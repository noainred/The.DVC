/**
 * cssVars.test.js — fallback 없이 쓰는 CSS 변수는 전부 정의돼 있어야 한다(v2.597, 감사 WEBUI-2597-01·03).
 *
 * 미정의 커스텀 속성을 `var(--x)` 로 쓰면 그 선언 전체가 계산값 시점에 무효가 되어 부모 값(대개 본문색)을
 * 물려받는다 — `var(--muted)` 104곳이 회색이 아니라 본문색으로 보였다. **수치로는 안 잡히고 스크린샷으로만** 보인다.
 * 정의는 CSS 의 `--x:` 또는 JSX 인라인의 `'--x':`/`['--x']:` 다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(jsx?|css)$/.test(e.name) && !/\.test\./.test(e.name)) files.push(p);
  }
})(ROOT);

describe('CSS 변수 (v2.597)', () => {
  it('★ var(--x) 로 fallback 없이 쓰는 변수는 전부 어딘가에 정의돼 있다', () => {
    const defs = new Set();
    const uses = new Map();
    for (const f of files) {
      const s = fs.readFileSync(f, 'utf8');
      for (const m of s.matchAll(/(?:^|[\s{;'"`[])(--[a-zA-Z0-9-]+)\s*['"`]?\s*\]?\s*:/g)) defs.add(m[1]);
      for (const m of s.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*\)/g)) if (!uses.has(m[1])) uses.set(m[1], path.relative(ROOT, f));
    }
    const missing = [...uses].filter(([v]) => !defs.has(v)).map(([v, f]) => `${v} (${f})`);
    expect(missing).toEqual([]);
  });
  it('--muted·--hover·--blue 는 :root 에 있다', () => {
    const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
    const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
    for (const v of ['--muted', '--hover', '--blue']) expect(root).toMatch(new RegExp(`${v}\\s*:`));
  });
  it('.btn-sm 규칙이 있다', () => {
    const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/\.btn\.btn-sm\s*\{/);
  });
});
