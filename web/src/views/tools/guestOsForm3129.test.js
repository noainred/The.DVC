// v3.13.7 — 실제 OS 확인 주기 스캔 설정: 이름 · 칸 · 단위 한 묶음(label) · 버튼 줄 flexWrap(400px 에서 칸과 이름이 떨어졌다)
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./GuestOsTools.jsx', import.meta.url), 'utf8');
describe('실제 OS 확인 — 주기 스캔 설정 칸 묶음', () => {
  it('네 칸(주기 · 최대 · 재스캔 · 동시)이 각각 <label className="flex" style={FIELD}> 안에 이름 · 칸 · 단위로 묶인다', () => {
    for (const name of ['주기', '최대', '재스캔', '동시']) {
      expect(src).toMatch(new RegExp(`<label className="flex" style=\\{FIELD\\}><span className="muted">${name}</span><input `));
    }
    expect(src).toMatch(/const FIELD = \{ alignItems: 'center', gap: 6, whiteSpace: 'nowrap' \};/);
    // 전역 .input { min-width: 220px } 를 풀어야 width 가 먹는다(안 풀면 nowrap 묶음이 400px 카드 밖으로 잘린다)
    for (const w of [90, 80, 70, 56]) expect(src).toMatch(new RegExp(`style=\\{\\{ width: ${w}, minWidth: 0 \\}\\}`));
  });
  it('저장 · 지금 스캔 버튼 줄은 flexWrap · 지금 스캔은 접히지 않는다', () => {
    expect(src).toMatch(/style=\{\{ marginTop: 12, alignItems: 'center', flexWrap: 'wrap', rowGap: 8 \}\}/);
    expect(src).toMatch(/style=\{\{ padding: '8px 16px', flex: 'none', whiteSpace: 'nowrap' \}\} disabled=\{busy === 'run'\}/);
  });
});

describe('v3.13.9 — Guest OS 종류/버전 필터: 이름 + 버튼 한 묶음(role=group) · aria-pressed', () => {
  it('전원 · 종류 묶음이 각각 role="group" 안에 이름과 버튼을 함께 둔다', () => {
    expect(src).toMatch(/<span role="group" aria-label="전원" className="flex" style=\{FILTER_GROUP\}>\s*<span className="muted" style=\{\{ fontSize: 12 \}\}>전원<\/span>/);
    expect(src).toMatch(/<span role="group" aria-label="종류" className="flex" style=\{FILTER_GROUP\}>\s*<span className="muted" style=\{\{ fontSize: 12 \}\}>종류<\/span>/);
    expect(src).toMatch(/aria-pressed=\{power === k\}/); expect(src).toMatch(/aria-pressed=\{kind === k\}/);
    expect(src).toMatch(/const FILTER_GROUP = \{ alignItems: 'center', gap: 6, flex: 'none' \};/);
  });
});
