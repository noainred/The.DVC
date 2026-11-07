// v2.920 — SAN 호스트 귀속 보기 문구: 확정/추정 분리 · null 은 뒤로 · 막대 폭은 전체 합 기준.
import { describe, it, expect } from 'vitest';
import { attribKpis, storageBars, sortRows, filterRows, rowTotalText, attribStateText } from './sanHostAttribText.js';

const d = { counts: { ok: 3, unseen: 1, zonedOnly: 0, noHba: 2, confirmedPairs: 2, estimatedPairs: 1, unsplitPairs: 0, zonedOnlyPairs: 1 },
  storages: [{ id: 'a', name: 'PMAX', kind: 'array', registered: {}, hosts: 2, confirmedBytes: 3000, estimatedBytes: 1000 }, { id: 'b', name: 'PS', kind: 'array', hosts: 1, confirmedBytes: null, estimatedBytes: null, unmeasuredHosts: 1 }],
  fabrics: [{}, {}], hostsWithHba: 4, hostsTotal: 10 };
describe('호스트 귀속 문구', () => {
  it('KPI — 확정·추정 따로 · 비중', () => {
    const k = attribKpis(d);
    // v2.929(C-①): 확정 · 실측 비율 · 추정을 따로(실측 값이 없으면 —)
    expect(k[0].v).toBe('3.9 KB'); expect(k[0].s).toBe('● 2.9 KB · ● — · ◐ 1000 B'); expect(k[1].v).toBe('3');
    expect(k[2].v).toBe('확정 2 · 실측 0 · 추정 1'); expect(k[2].s).toContain('근거 있는 몫 75%'); expect(k[3].v).toBe('실측 0 · IPF 0 · 비율 0'); expect(k[4].v).toBe('2 · 4');
    const m = attribKpis({ ...d, counts: { ...d.counts, measuredPairs: 1, ipfPorts: 2 }, storages: [{ ...d.storages[0], measuredBytes: 4000 }] });
    expect(m[0].v).toBe('7.8 KB'); expect(m[2].s).toContain('근거 있는 몫 88%'); expect(m[3].v).toBe('실측 0 · IPF 2 · 비율 0');
    expect(attribKpis({ storages: [] })[0].v).toBe('—');
  });
  it('막대 — 폭은 전체 합 기준 · 값 없음 0 폭', () => {
    const b = storageBars(d.storages, 1);
    expect(b.rows[0]).toMatchObject({ name: 'PMAX', pctC: 75, pctE: 25, share: 100 }); expect(b.omitted).toBe(1); expect(b.total).toBe(4000);
    expect(storageBars(d.storages).rows[1]).toMatchObject({ pctC: 0, pctE: 0, share: null, unmeasuredHosts: 1 });
  });
  it('정렬 — null 뒤로 · 필터', () => {
    const rows = [{ hostName: 'b', storageName: 'x', conf: 'estimated', confirmedBytes: null, estimatedBytes: 10 }, { hostName: 'a', storageName: 'y', conf: 'confirmed', confirmedBytes: 5, estimatedBytes: null }, { hostName: 'c', storageName: 'z', conf: 'unsplit', confirmedBytes: null, estimatedBytes: null }];
    expect(sortRows(rows, 'total', 'desc').map((r) => r.hostName)).toEqual(['b', 'a', 'c']);
    expect(sortRows(rows, 'total', 'asc').map((r) => r.hostName)).toEqual(['a', 'b', 'c']);
    expect(sortRows(rows, 'conf', 'asc').map((r) => r.conf)).toEqual(['confirmed', 'estimated', 'unsplit']);
    expect(filterRows(rows, { confirmedOnly: true }).length).toBe(1); expect(filterRows(rows, { q: 'Z' }).length).toBe(1);
    expect(rowTotalText(rows[2])).toBe('—'); expect(rowTotalText(rows[0])).toBe('10 B');
  });
  it('상태 문구', () => {
    expect(attribStateText({ fabrics: [] })).toContain('스냅샷이 없습니다'); expect(attribStateText({ fabrics: [1], hostsWithHba: 0 })).toContain('HBA 정보');
    expect(attribStateText({ fabrics: [1], hostsWithHba: 1, perfUnavailable: true })).toContain('DB'); expect(attribStateText(d)).toBe('');
  });
});
