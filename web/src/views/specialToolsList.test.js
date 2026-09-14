// 특수 기능 도구 목록 회귀 — 이름을 바꿀 때 **키를 같이 바꾸면** 각 법인이 저장해 둔
// 권한 거부 설정(toolsDenied)과 사용자 북마크(#/tools/<k>)가 조용히 깨진다. 그 경계를 고정한다.
import { describe, it, expect } from 'vitest';
import { TOOLS } from './specialToolsList.js';

const byKey = (k) => TOOLS.find((t) => t.k === k);

describe('도구 키는 이름과 독립적으로 유지된다', () => {
  it("'자원 최적화' 의 키는 여전히 waste 다(v2.507 이름 변경)", () => {
    const t = byKey('waste');
    expect(t).toBeTruthy();
    expect(t.label).toBe('자원 최적화 (CPU/Memory/Disk)');
  });

  it('키가 중복되지 않는다(중복이면 카드·권한 매칭이 어긋난다)', () => {
    const keys = TOOLS.map((t) => t.k);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('모든 항목이 키·라벨을 갖는다', () => {
    for (const t of TOOLS) {
      expect(typeof t.k).toBe('string');
      expect(t.k.length).toBeGreaterThan(0);
      expect(typeof t.label).toBe('string');
      expect(t.label.trim().length).toBeGreaterThan(0);
    }
  });

  it('이름이 바뀐 도구는 옛 이름으로도 검색된다', () => {
    // 카드 검색은 label+desc 만 본다(SpecialTools.jsx). 옛 이름을 어디에도 남기지 않으면
    // 기존 이름으로 찾던 사용자가 기능을 못 찾는다 — 이름 변경의 실제 비용은 여기다.
    const hay = (t) => `${t.label} ${t.desc || ''}`.toLowerCase();
    expect(hay(byKey('waste'))).toContain('낭비');
  });

  it('라벨이 도구가 실제로 하는 일과 어긋나지 않는다', () => {
    // 이름이 CPU/Memory/Disk 를 약속하므로 설명에도 그 항목이 있어야 한다
    // (CapacityTools.jsx 의 탭: off·snap·tools·cpu·mem·trend).
    const d = byKey('waste').desc;
    expect(d).toMatch(/CPU/);
    expect(d).toMatch(/메모리/);
  });
});
