import { describe, it, expect } from 'vitest';
import { missingView, facetOptions, clampPageSize, nodeOf, corpOf, PAGE_SIZE_DEFAULT } from './bmMissingView.js';

const mk = (i, o = {}) => ({ key: `k${i}`, name: `srv-${String(i).padStart(3, '0')}`, serviceTag: '', vcenterId: '', via: 'local', bucket: 'untracked', reason: 'registry-only', idracHost: '', osHost: '', ...o });

describe('누락 점검 필터 · 쪽 나누기(v2.945.1)', () => {
  const rows = [
    mk(1, { name: '192.168.21.239', osHost: '192.168.21.239' }),
    mk(2, { name: 'db01.corp.example', vcenterId: 'vc-a', corp: '법인A', bucket: 'none', reason: 'no-os-cred', idracHost: '10.1.2.3' }),
    mk(3, { name: 'gpu07', via: 'edge', agent: 'OC2', vcenterId: 'vc-b', corp: '법인B', bucket: 'unknown', reason: 'edge-no-record', serviceTag: 'ABC1234' }),
    mk(4, { name: 'both01', bucket: 'both', reason: '' }),
    mk(5, { name: 'masked', idracHost: '(가림)' }),
  ];

  it('기본: 둘 다 칸은 숨기고 전체 수 · 걸린 수를 따로 준다', () => {
    const v = missingView(rows, {});
    expect(v.total).toBe(5);
    expect(v.matched).toBe(4);
    expect(v.rows.map((r) => r.key)).not.toContain('k4');
  });
  it('검색: IP · 호스트명 · 서비스 태그 · iDRAC 주소 · OS 주소, 여러 낱말은 모두 맞아야 한다', () => {
    expect(missingView(rows, { q: '192.168.21' }).rows.map((r) => r.key)).toEqual(['k1']);
    expect(missingView(rows, { q: 'DB01' }).rows.map((r) => r.key)).toEqual(['k2']);
    expect(missingView(rows, { q: '10.1.2' }).rows.map((r) => r.key)).toEqual(['k2']);
    expect(missingView(rows, { q: 'abc1234' }).rows.map((r) => r.key)).toEqual(['k3']);
    expect(missingView(rows, { q: 'gpu07 abc' }).rows.map((r) => r.key)).toEqual(['k3']);
    expect(missingView(rows, { q: 'gpu07 zzz' }).matched).toBe(0);
  });
  it('가림 값은 검색에 닿지 않는다(가린 주소를 낱말로 추측할 수 없게)', () => {
    expect(missingView(rows, { q: '가림' }).matched).toBe(0);
  });
  it('법인 · 수집 노드 · 사유 · 칸 필터', () => {
    expect(missingView(rows, { corp: '법인A' }).rows.map((r) => r.key)).toEqual(['k2']);
    expect(missingView(rows, { corp: '미귀속' }).rows.map((r) => r.key)).toEqual(['k1', 'k5']);
    expect(missingView(rows, { node: '엣지 OC2' }).rows.map((r) => r.key)).toEqual(['k3']);
    expect(missingView(rows, { node: '이 노드' }).matched).toBe(3);
    expect(missingView(rows, { reason: 'no-os-cred' }).rows.map((r) => r.key)).toEqual(['k2']);
    expect(missingView(rows, { bucket: 'both' }).rows.map((r) => r.key)).toEqual(['k4']);
  });
  it('쪽 나누기: 기본 30 · 정렬 뒤 자르기 · 범위 밖 쪽은 마지막 쪽으로', () => {
    const many = Array.from({ length: 75 }, (_, i) => mk(i + 1));
    const v1 = missingView(many, {});
    expect(v1.pageSize).toBe(PAGE_SIZE_DEFAULT);
    expect(v1.pages).toBe(3);
    expect([v1.from, v1.to]).toEqual([1, 30]);
    const v3 = missingView(many, { page: 9 });
    expect(v3.page).toBe(3);
    expect([v3.from, v3.to]).toEqual([61, 75]);
    // 내림 정렬은 전체를 정렬한 뒤 첫 쪽이 가장 큰 이름부터
    const d = missingView(many, { sortCol: 'name', sortDir: 'desc' });
    expect(d.rows[0].name).toBe('srv-075');
    expect(missingView(many, { pageSize: 50 }).pages).toBe(2);
  });
  it('쪽 크기 정규화: 하한 10 · 상한 500 · 못 읽으면 30', () => {
    expect(clampPageSize('abc')).toBe(30);
    expect(clampPageSize(0)).toBe(30);
    expect(clampPageSize(3)).toBe(10);
    expect(clampPageSize(9999)).toBe(500);
    expect(clampPageSize('45.7')).toBe(45);
  });
  it('빈 값은 정렬 방향과 무관하게 뒤로', () => {
    const r2 = [mk(1, { reason: '' }), mk(2, { reason: 'b' }), mk(3, { reason: 'a' })];
    expect(missingView(r2, { sortCol: 'reason', sortDir: 'asc' }).rows.map((r) => r.key)).toEqual(['k3', 'k2', 'k1']);
    expect(missingView(r2, { sortCol: 'reason', sortDir: 'desc' }).rows.map((r) => r.key)).toEqual(['k2', 'k3', 'k1']);
  });
  it('고르기 목록은 거르기 전 전체 기준', () => {
    const f = facetOptions(rows);
    expect(f.nodes.map((x) => x.value)).toEqual(['엣지 OC2', '이 노드']);
    expect(f.corps.find((x) => x.value === '미귀속').n).toBe(3);
    expect(nodeOf({ via: 'edge', agent: 'NJ' })).toBe('엣지 NJ');
    expect(corpOf({ vcenterId: 'vc-x' })).toBe('vc-x');
  });
});
