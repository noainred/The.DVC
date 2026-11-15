// v3.10.19 — 누르는 카드의 키보드 접근 한 벌(pressable) · 허브 카드 · KPI 카드 · 법인별 비교 표 · primitives Kpi 가 같은 것을 쓴다
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { pressable, PRESS_KEYS } from './pressable.js';

describe('pressable', () => {
  it('onClick 이 있으면 role · tabIndex · onKeyDown(Enter/Space → onClick + preventDefault) · 다른 키는 무시', () => {
    const onClick = vi.fn(); const p = pressable(onClick);
    expect(p.role).toBe('button'); expect(p.tabIndex).toBe(0); expect(p.onClick).toBe(onClick);
    for (const key of PRESS_KEYS) { const e = { key, preventDefault: vi.fn() }; p.onKeyDown(e); expect(e.preventDefault).toHaveBeenCalledTimes(1); }
    expect(onClick).toHaveBeenCalledTimes(2);
    const e = { key: 'Tab', preventDefault: vi.fn() }; p.onKeyDown(e); expect(e.preventDefault).not.toHaveBeenCalled(); expect(onClick).toHaveBeenCalledTimes(2);
  });
  it('onClick 이 없거나 disabled 면 빈 props(장식 카드는 그대로 · tabIndex 도 없음)', () => {
    expect(pressable(null)).toEqual({}); expect(pressable(undefined)).toEqual({}); expect(pressable('x')).toEqual({});
    expect(pressable(() => {}, { disabled: true })).toEqual({});
  });
  it('소스 계약 — 허브 vCenter 카드 · KPI 카드 3장 · primitives Kpi 가 pressable 을 쓰고, 법인별 비교 표의 이름은 button · 포커스 CSS 가 있다', () => {
    const vc = fs.readFileSync(new URL('../views/VCenters.jsx', import.meta.url), 'utf8');
    expect((vc.match(/\{\.\.\.pressable\(/g) || []).length).toBe(4);
    expect(vc).not.toMatch(/className="card (kpi|vc-card)"[^\n]*\sonClick=/);   // 카드는 onClick 직접 금지 — pressable 로
    const pr = fs.readFileSync(new URL('./primitives.jsx', import.meta.url), 'utf8');
    expect(pr).toMatch(/\{\.\.\.pressable\(onClick\)\}/); expect(pr).not.toMatch(/onKeyDown=\{onClick \?/);
    const vt = fs.readFileSync(new URL('../views/platform/VcTable.jsx', import.meta.url), 'utf8');
    expect(vt).toMatch(/<button type="button" className="cell-link" style=\{\{ fontWeight: 700 \}\} onClick=\{\(e\) => \{ stop\(e\); onOpen\(s\.id\); \}\}/);
    const css = fs.readFileSync(new URL('../views/platform/platform.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.card\.kpi\[role="button"\]:focus-visible, \.card\.vc-card\[role="button"\]:focus-visible \{ outline: 2px solid var\(--accent\)/);
  });
});
