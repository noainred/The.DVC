// v3.10.16 — 넘치는 탭 줄에서 열린 탭이 보이게 줄만 옮긴다(창 스크롤 없음). HubTabs 의 규칙을 상세 · 개체 보기 탭 줄이 함께 쓴다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { keepActiveTabInView } from './useActiveTabInView.js';

const strip = ({ left = 0, right = 400, scrollWidth = 900, clientWidth = 400, tab }) => ({
  scrollLeft: 0, scrollWidth, clientWidth,
  getBoundingClientRect: () => ({ left, right }),
  querySelector: (sel) => (sel === '[aria-selected="true"]' && tab ? { getBoundingClientRect: () => tab } : null),
});

describe('keepActiveTabInView', () => {
  it('오른쪽 밖이면 오른쪽으로, 왼쪽 밖이면 왼쪽으로 8px 여유를 두고 옮긴다 · 보이면 그대로', () => {
    const a = strip({ tab: { left: 620, right: 700 } });
    expect(keepActiveTabInView(a)).toBe(true); expect(a.scrollLeft).toBe(308);
    const b = strip({ tab: { left: -90, right: -10 } });
    expect(keepActiveTabInView(b)).toBe(true); expect(b.scrollLeft).toBe(-98);
    const c = strip({ tab: { left: 10, right: 90 } });
    expect(keepActiveTabInView(c)).toBe(false); expect(c.scrollLeft).toBe(0);
  });
  it('넘치지 않거나 열린 탭이 없거나 줄이 없으면 아무것도 하지 않는다', () => {
    const d = strip({ scrollWidth: 400, clientWidth: 400, tab: { left: 620, right: 700 } });
    expect(keepActiveTabInView(d)).toBe(false); expect(d.scrollLeft).toBe(0);
    expect(keepActiveTabInView(strip({ tab: null }))).toBe(false);
    expect(keepActiveTabInView(null)).toBe(false);
    expect(keepActiveTabInView(undefined)).toBe(false);
  });
  it('탭 줄 세 곳(허브 · vCenter 상세 · 개체 보기)이 같은 훅을 쓴다(소스 계약) · 창을 내리는 scrollIntoView 는 쓰지 않는다', () => {
    for (const f of ['../views/platform/HubTabs.jsx', '../views/VCenterDetail.jsx', '../views/vcd/ObjectShell.jsx']) {
      const s = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(s).toMatch(/useActiveTabInView\(/);
    }
    expect(fs.readFileSync(new URL('./useActiveTabInView.js', import.meta.url), 'utf8')).not.toMatch(/scrollIntoView/);
  });
});
