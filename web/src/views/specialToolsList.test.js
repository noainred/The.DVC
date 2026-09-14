// 특수 기능 도구 목록 회귀 — 이름을 바꿀 때 **키를 같이 바꾸면** 각 법인이 저장해 둔
// 권한 거부 설정(toolsDenied)과 사용자 북마크(#/tools/<k>)가 조용히 깨진다. 그 경계를 고정한다.
import { describe, it, expect } from 'vitest';
import { TOOLS } from './specialToolsList.js';
import { searchTools } from './toolSearch.js';

const byKey = (k) => TOOLS.find((t) => t.k === k);

describe('도구 키는 이름과 독립적으로 유지된다', () => {
  it("'Optimization' 의 키는 여전히 waste 다(v2.507 · v2.508 두 번의 이름 변경)", () => {
    const t = byKey('waste');
    expect(t).toBeTruthy();
    expect(t.label).toBe('Optimization');
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
    // 이름 변경의 실제 비용은 여기다 — 옛 이름을 남기지 않으면 기존 이름으로 찾던 사용자가 기능을 잃는다.
    // 이 도구는 두 번 바뀌었으므로(낭비 리소스 → 자원 최적화 → Optimization) **두 이름 모두** 걸려야 한다.
    for (const old of ['낭비', '자원 최적화']) {
      expect(searchTools(TOOLS, old).map((t) => t.k)).toContain('waste');
    }
  });

  it('라벨이 일반명이면 설명이 무엇을 하는지 말해야 한다', () => {
    // 라벨이 'Optimization' 이라 그 자체로는 대상을 말하지 않는다 — 설명이 CPU·메모리를 밝혀야
    // 카드만 보고 무슨 도구인지 안다(CapacityTools.jsx 의 탭: off·snap·tools·cpu·mem·trend).
    const d = byKey('waste').desc;
    expect(d).toMatch(/CPU/);
    expect(d).toMatch(/메모리/);
  });
});

describe('aka(구 명칭 별칭)와 공용 검색', () => {
  it("'낭비' 로 검색하면 Optimization 이 나온다(aka 경유)", () => {
    const hit = searchTools(TOOLS, '낭비');
    expect(hit.map((t) => t.k)).toContain('waste');
  });

  it('키로 검색된다 — 라벨에 없는 gpu·ipam·rma', () => {
    for (const k of ['gpu', 'ipam', 'rma']) {
      expect(searchTools(TOOLS, k).map((t) => t.k)).toContain(k);
    }
  });

  it('분류명으로 검색된다(분류 설정이 있을 때만)', () => {
    const catsOf = (t) => (t.k === 'orphanvmdk' ? ['스토리지'] : []);
    const hit = searchTools(TOOLS, '스토리지', { catsOf });
    expect(hit.map((t) => t.k)).toContain('orphanvmdk');
  });

  it('라벨 앞글자 일치가 설명 일치보다 먼저 나온다', () => {
    const hit = searchTools(TOOLS, 'gpu');
    // 라벨이 'GPU' 로 시작하는 항목이 있으면 그것이 1위여야 한다.
    const first = hit[0];
    expect(first.label.toLowerCase().startsWith('gpu') || first.k === 'gpu').toBe(true);
  });

  it('빈 검색어는 전체를 원래 순서로 돌려준다', () => {
    const all = searchTools(TOOLS, '  ');
    expect(all.length).toBe(TOOLS.length);
    expect(all[0].k).toBe(TOOLS[0].k);
  });

  it('aka 를 가진 도구는 aka 가 문자열 배열이다', () => {
    for (const t of TOOLS) {
      if (t.aka === undefined) continue;
      expect(Array.isArray(t.aka)).toBe(true);
      for (const a of t.aka) expect(typeof a).toBe('string');
    }
  });
});
