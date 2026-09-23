// v2.589 — ErrorBox 는 message 와 error 둘 다 받는다. 26곳이 error= 로 넘기는데 message 만 읽어 빈 '오류:' 가 떴다
// (403 안내·일시적 미가용 안내도 함께 사라졌다). 컴포넌트 렌더 테스트가 불가한 node 환경이라 소스로 고정한다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./primitives.jsx', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('ErrorBox props (v2.589)', () => {
  it('error 를 message 대신 받는다', () => {
    expect(src).toMatch(/export function ErrorBox\(\{\s*message: msgProp,\s*error,/);
    expect(src).toMatch(/const message = msgProp \?\? error \?\? null;/);
  });
  it('.btn·.banner 규칙이 있다(없으면 브라우저 기본 버튼·맨 글자로 보인다)', () => {
    expect(css).toMatch(/(^|\n)\.btn\s*\{/);
    expect(css).toMatch(/(^|\n)\.banner\s*\{/);
    expect(css).toMatch(/\.banner\.warn\s*\{/);
  });
});
