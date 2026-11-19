// v3.10.19 — 누르는 카드의 키보드 접근 한 벌(pressable) · 허브 카드 · KPI 카드 · 법인별 비교 표 · primitives Kpi 가 같은 것을 쓴다
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { pressable, PRESS_KEYS, onPressKey } from './pressable.js';

describe('pressable', () => {
  it('onClick 이 있으면 role · tabIndex · onKeyDown(Enter/Space → onClick + preventDefault) · 다른 키는 무시', () => {
    const onClick = vi.fn(); const p = pressable(onClick);
    expect(p.role).toBe('button'); expect(p.tabIndex).toBe(0); expect(p.onClick).toBe(onClick);
    for (const key of PRESS_KEYS) { const e = { key, preventDefault: vi.fn() }; p.onKeyDown(e); expect(e.preventDefault).toHaveBeenCalledTimes(1); }
    expect(onClick).toHaveBeenCalledTimes(2);
    const e = { key: 'Tab', preventDefault: vi.fn() }; p.onKeyDown(e); expect(e.preventDefault).not.toHaveBeenCalled(); expect(onClick).toHaveBeenCalledTimes(2);
  });
  it('안쪽 버튼에서 올라온 Enter/Space 는 무시한다(target ≠ currentTarget) — 카드가 대신 열리지 않고 버튼의 기본 클릭도 막지 않는다(v3.10.19 보완 · 반증 재현)', () => {
    const onClick = vi.fn(); const p = pressable(onClick); const card = {}; const btn = {};
    for (const key of PRESS_KEYS) { const e = { key, target: btn, currentTarget: card, preventDefault: vi.fn() }; p.onKeyDown(e); expect(e.preventDefault).not.toHaveBeenCalled(); }
    expect(onClick).not.toHaveBeenCalled();
    const own = { key: 'Enter', target: card, currentTarget: card, preventDefault: vi.fn() }; p.onKeyDown(own); expect(onClick).toHaveBeenCalledTimes(1); expect(own.preventDefault).toHaveBeenCalledTimes(1);
  });
  it('onClick 이 없거나 disabled 면 빈 props(장식 카드는 그대로 · tabIndex 도 없음)', () => {
    expect(pressable(null)).toEqual({}); expect(pressable(undefined)).toEqual({}); expect(pressable('x')).toEqual({});
    expect(pressable(() => {}, { disabled: true })).toEqual({});
  });
  it('소스 계약 — 허브 vCenter 카드 · primitives Kpi 가 pressable 을 쓰고 포커스 CSS 가 있다(v3.19.0: KPI 카드 3장 · 법인별 비교 표는 걷어냈다)', () => {
    const vc = fs.readFileSync(new URL('../views/VCenters.jsx', import.meta.url), 'utf8');
    expect((vc.match(/\{\.\.\.pressable\(/g) || []).length).toBe(1);   // vCenter 카드 하나
    expect(vc).not.toMatch(/className="card (kpi|vc-card)"[^\n]*\sonClick=/);   // 카드는 onClick 직접 금지 — pressable 로
    const pr = fs.readFileSync(new URL('./primitives.jsx', import.meta.url), 'utf8');
    expect(pr).toMatch(/\{\.\.\.pressable\(onClick\)\}/); expect(pr).not.toMatch(/onKeyDown=\{onClick \?/);
    const css = fs.readFileSync(new URL('../views/platform/platform.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.card\.kpi\[role="button"\]:focus-visible, \.card\.vc-card\[role="button"\]:focus-visible \{ outline: 2px solid var\(--accent\)/);
  });
});

describe('v3.13.2 — 정렬 열 머리 키보드(onPressKey 한 벌 · STable · DataTable)', () => {
  it('onPressKey — 자기 자신의 Enter/Space 만 · 안쪽에서 올라온 키 · 다른 키는 무시', () => {
    const fn = vi.fn(); const h = onPressKey(fn); const el = {};
    const e1 = { key: 'Enter', target: el, currentTarget: el, preventDefault: vi.fn() }; h(e1); expect(fn).toHaveBeenCalledTimes(1); expect(e1.preventDefault).toHaveBeenCalled();
    h({ key: ' ', target: {}, currentTarget: el, preventDefault: vi.fn() }); expect(fn).toHaveBeenCalledTimes(1);
    h({ key: 'a', target: el, currentTarget: el, preventDefault: vi.fn() }); expect(fn).toHaveBeenCalledTimes(1);
  });
  it('소스 계약 — STable 머리는 tabIndex · onPressKey(역할은 바꾸지 않는다 — role 없음) · DataTable 머리도 · 포커스 CSS', () => {
    const st = fs.readFileSync(new URL('./STable.jsx', import.meta.url), 'utf8');
    expect(st).toMatch(/tabIndex: th\.props\.tabIndex \?\? 0,/);
    expect(st).toMatch(/onPressKey\(\(\) => setSort\(\(c\) => nextSortState\(c, myCol\)\)\)\(e\)/);
    expect(st).not.toMatch(/role: 'button'/);
    const pr = fs.readFileSync(new URL('./primitives.jsx', import.meta.url), 'utf8');
    expect(pr).toMatch(/tabIndex=\{0\} onKeyDown=\{onPressKey\(\(\) => toggle\(c\.key\)\)\}/);
    const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(/th\[aria-sort\]:focus-visible \{ outline: 2px solid var\(--accent\)/);
    const vc = fs.readFileSync(new URL('../views/VCenters.jsx', import.meta.url), 'utf8');
    expect(vc).toMatch(/className="cell-link" onClick=\{\(e\) => \{ e\.stopPropagation\(\); setSel\(v\); \}\}/);
  });
});

describe('v3.13.3 — vCenter 상세 트리(노드 · 잎 · 호스트 이름) 키보드', () => {
  it('소스 계약 — Node · Tree(자식이 있을 때) · Leaf · 호스트 이름이 pressable · aria-expanded · 포커스 CSS', () => {
    const s = fs.readFileSync(new URL('../views/VCenterDetail.jsx', import.meta.url), 'utf8');
    expect(s).toMatch(/className="vcd-node vcd-root" \{\.\.\.pressable\(\(\) => setO\(\(v\) => !v\)\)\} aria-expanded=\{!!o\}/);
    expect(s).toMatch(/className="vcd-node" \{\.\.\.\(hasKids \? pressable\(\(\) => toggle\(k\)\) : \{ onClick: \(\) => toggle\(k\) \}\)\} aria-expanded=\{hasKids \? !!o : undefined\}/);
    expect(s).toMatch(/className="vcd-node vcd-leaf" \{\.\.\.pressable\(onClick\)\}/);
    expect(s).toMatch(/className="vcd-link" \{\.\.\.pressable\(\(e\) => \{ e\.stopPropagation\(\); setHostDrawer\(h\); \}\)\}/);
    expect(s).not.toMatch(/className="vcd-node[^"]*" onClick=/);
    const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.vcd-node\[role="button"\]:focus-visible, \.vcd-link\[role="button"\]:focus-visible/);
  });
});

describe('v3.13.5 — 허브 하위 도구의 마우스 전용 요소(VM 정밀 검색 필터 칩 · 현재 사용자 법인 행) · 누를 수 없는 머리의 손가락 커서', () => {
  it('소스 계약 — VmFinder 칩 pressable + aria-pressed · CurrentUsers 이름 버튼 · CSS', () => {
    const vf = fs.readFileSync(new URL('../views/tools/VmFinderTool.jsx', import.meta.url), 'utf8');
    expect(vf).toMatch(/\{\.\.\.pressable\(\(\) => onToggle\(x\)\)\} aria-pressed=\{sel\.includes\(x\)\}/);
    expect(vf).not.toMatch(/onClick=\{\(\) => onToggle\(x\)\}/);
    const cu = fs.readFileSync(new URL('../views/tools/CurrentUsers.jsx', import.meta.url), 'utf8');
    expect(cu).toMatch(/<button type="button" className="cell-link" aria-pressed=\{v\.vcenterId === picked\}/);
    const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(/thead th\[data-nosort\] \{ cursor: default; \}/);
    expect(css).toMatch(/\.badge\[role="button"\]:focus-visible/);
  });
});
