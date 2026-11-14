// v2.915 설정 연동 기술 뷰 — 패싯(다른 축 선택만 반영) · 필터 · 칩 문구 · 스파크라인(점 1개면 그리지 않음) · 누적 막대 · 표기.
import { describe, it, expect } from 'vitest';
import {
  emptySelection, filterRows, facetCounts, chipValue, toggleFacet, sparkPoints, stackedBars, fmtMs, fmtAge, SELECTABLE, SYNC_STATE_META,
} from './syncLogic.js';

const rows = [
  { key: 'a', state: 'new', kind: 'set:vcenter', kindLabel: 'vCenter', corp: 'PL', agent: 'edge-fra', depth: 'identity', name: 'vc-a', host: '10.0.0.1' },
  { key: 'b', state: 'linked', kind: 'set:vcenter', kindLabel: 'vCenter', corp: 'KR', agent: '', depth: 'identity', name: 'vc-b', host: 'vc-b.corp' },
  { key: 'c', state: 'new', kind: 'set:idrac', kindLabel: 'iDRAC', corp: 'PL', agent: 'edge-fra', depth: 'identity', name: 'r750', host: '10.0.0.9' },
  { key: 'd', state: 'gone', kind: 'set:pdu', kindLabel: 'PDU', corp: '', agent: '', depth: 'ssh', name: 'pdu1', host: 'p' },
];

describe('syncLogic', () => {
  it('패싯 — 같은 축 선택은 그 축 건수에 반영하지 않고 다른 축은 반영한다', () => {
    let sel = emptySelection();
    sel = toggleFacet(sel, 'kind', 'set:vcenter');
    const f = facetCounts(rows, sel);
    expect(f.kind.find((x) => x.v === 'set:idrac').n).toBe(1);      // 자기 축 선택을 빼고 센다
    expect(f.state.find((x) => x.v === 'new').n).toBe(1);           // 다른 축(kind=vCenter)은 반영
    expect(f.corp.map((x) => x.v)).toEqual(expect.arrayContaining(['PL', 'KR']));
    expect(f.edge.find((x) => x.v === '중앙(직접)').n).toBe(1);
    expect(filterRows(rows, sel).map((r) => r.key)).toEqual(['a', 'b']);
  });
  it('선택했는데 0건인 값도 남는다(체크를 풀 수 있어야)', () => {
    let sel = toggleFacet(emptySelection(), 'corp', 'NOWHERE');
    const f = facetCounts(rows, sel);
    expect(f.corp.find((x) => x.v === 'NOWHERE').n).toBe(0);
    sel = toggleFacet(sel, 'corp', 'NOWHERE');
    expect(sel.corp.size).toBe(0);
  });
  it('검색 — 이름·호스트·종류·법인', () => {
    expect(filterRows(rows, emptySelection(), '10.0.0').map((r) => r.key)).toEqual(['a', 'c']);
    expect(filterRows(rows, emptySelection(), 'idrac').map((r) => r.key)).toEqual(['c']);
  });
  it('상태 축은 정해진 순서(할 일 먼저)', () => {
    expect(facetCounts(rows, emptySelection()).state.map((x) => x.v)).toEqual(['new', 'gone', 'linked']);
  });
  it('칩 문구 — 없으면 *, 셋 이상이면 +n', () => {
    let sel = emptySelection();
    expect(chipValue(sel, 'state')).toBe('*');
    for (const v of ['new', 'changed', 'gone']) sel = toggleFacet(sel, 'state', v);
    expect(chipValue(sel, 'state')).toBe('new,changed +1');
  });
  it('스파크라인 — 점이 둘 미만이면 그리지 않는다(평평한 선을 지어내지 않는다)', () => {
    expect(sparkPoints([5])).toBe('');
    expect(sparkPoints([])).toBe('');
    const p = sparkPoints([1, 3, 2], 84, 24, 2).split(' ');
    expect(p).toHaveLength(3);
    expect(p[0].startsWith('0,')).toBe(true);
  });
  it('누적 막대 — 최댓값 0 이면 막대 없음 · 칸별로 쌓는다', () => {
    expect(stackedBars([{ new: 0 }], ['new']).bars).toHaveLength(0);
    const { bars, max } = stackedBars([{ at: 1, new: 2, gone: 1 }, { at: 2, new: 1 }], ['new', 'gone']);
    expect(max).toBe(3);
    expect(bars).toHaveLength(3);
  });
  it('표기 — 값이 없으면 —(0 으로 쓰지 않는다)', () => {
    expect(fmtMs(null)).toBe('—');
    expect(fmtMs(1500)).toBe('1.5 s');
    expect(fmtMs(12)).toBe('12 ms');
    expect(fmtAge(undefined)).toBe('—');
    expect(fmtAge(125_000)).toBe('2m 5s');
  });
  it('적용 가능 상태는 새 항목·변경·사라짐뿐 · 모든 상태에 라벨', () => {
    expect([...SELECTABLE].sort()).toEqual(['changed', 'gone', 'new']);
    for (const s of ['new', 'linked', 'changed', 'gone', 'held', 'problem', 'excluded']) expect(SYNC_STATE_META[s]?.label).toBeTruthy();
  });
});
