import { describe, it, expect } from 'vitest';
import { layoutCommMap, arcPath, labelAnchor, LABEL_MAX, R_EDGE, R_RES } from './commMapLayout.js';

const res = (n, kind = 'storage', omitted = 0) => ({ [kind]: { items: Array.from({ length: n }, (_, i) => ({ id: `${kind}${i}`, name: `${kind}${i}`, state: 'registered' })), total: n + omitted, omitted } });
const data = (edges, direct = {}) => ({ edges, hub: { direct } });

describe('layoutCommMap', () => {
  it('엣지 노드는 자기 부채꼴 가운데에 있고 자원은 그 부채꼴 안에 있다', () => {
    const L = layoutCommMap(data([{ id: 'a', name: 'A', state: 'ok', resources: res(3) }, { id: 'b', name: 'B', state: 'ok', resources: res(1, 'vcenter') }]), { size: 1000 });
    expect(L.edges).toHaveLength(2);
    for (const e of L.edges) {
      expect(e.angle).toBeCloseTo((e.sector[0] + e.sector[1]) / 2, 9);
      for (const r of L.resources.filter((x) => x.owner === e.id)) { expect(r.angle).toBeGreaterThan(e.sector[0]); expect(r.angle).toBeLessThan(e.sector[1]); }
      expect(Math.hypot(e.x - 500, e.y - 500)).toBeCloseTo(1000 * R_EDGE, 0);
    }
    expect(L.resources).toHaveLength(4);
    for (const r of L.resources) expect(Math.hypot(r.x - 500, r.y - 500)).toBeCloseTo(1000 * R_RES, 0);
    expect(L.labelsHidden).toBe(false);
    expect(L.directSector).toBeNull();
  });
  it('부채꼴 폭은 자원 수에 비례하고 전체 합은 2π 다', () => {
    const L = layoutCommMap(data([{ id: 'big', name: 'B', state: 'ok', resources: res(9) }, { id: 'small', name: 'S', state: 'ok', resources: {} }]));
    const w = (e) => e.sector[1] - e.sector[0];
    const big = L.edges.find((e) => e.id === 'big'); const small = L.edges.find((e) => e.id === 'small');
    expect(w(big)).toBeGreaterThan(w(small));
    expect(w(big) + w(small)).toBeCloseTo(Math.PI * 2, 9);
    expect(w(small)).toBeGreaterThan(0); // 자원 0개 엣지도 자리를 갖는다
  });
  it('생략(omitted)은 +N 노드로 그리고, 직접 자원은 허브 부채꼴에 둔다', () => {
    const L = layoutCommMap(data([{ id: 'a', name: 'A', state: 'ok', resources: res(2, 'storage', 5) }], res(3, 'vcenter', 1)));
    expect(L.more.map((m) => [m.owner, m.count])).toEqual([['a', 5], ['(central)', 1]]);
    expect(L.directSector.count).toBe(3); expect(L.directSector.omitted).toBe(1);
    expect(L.resources.filter((r) => r.owner === '(central)')).toHaveLength(3);
  });
  it('바깥 노드가 LABEL_MAX 를 넘으면 labelsHidden 이고 개수를 밝힌다', () => {
    const L = layoutCommMap(data([{ id: 'a', name: 'A', state: 'ok', resources: res(LABEL_MAX + 1) }]));
    expect(L.labelsHidden).toBe(true); expect(L.outerCount).toBe(LABEL_MAX + 1);
  });
  it('데이터가 없거나 엣지가 0곳이어도 허브는 있다', () => {
    expect(layoutCommMap(null).hub).toEqual({ x: 500, y: 500, r: 75 });
    expect(layoutCommMap(data([])).edges).toEqual([]);
  });
});

describe('arcPath / labelAnchor', () => {
  it('두 점을 잇는 2차 곡선이고 bend 부호로 두 가닥이 갈린다', () => {
    expect(arcPath(0, 0, 100, 0, 0.1)).toBe('M 0 0 Q 50 10 100 0');
    expect(arcPath(100, 0, 0, 0, 0.1)).toBe('M 100 0 Q 50 -10 0 0');
  });
  it('오른쪽은 start · 왼쪽은 end · 위아래는 middle', () => {
    expect(labelAnchor(0)).toBe('start'); expect(labelAnchor(Math.PI)).toBe('end');
    expect(labelAnchor(-Math.PI / 2)).toBe('middle'); expect(labelAnchor(Math.PI / 2)).toBe('middle');
  });
});
