import { describe, it, expect } from 'vitest';
import { rowSrcClass, srcCounts, metricSrcText, srcTitle } from './usageSrc.js';
import { suggestRowsOf, pickableOf, applyResultText, initialFilter } from '../bmOsSuggestText.js';

describe('v2.991 사용률 출처(설계 bm-folders §13 ①)', () => {
  it('행 분류 — 같은 출처 · 다르면 mixed · 서버가 구분 모름이면 mixed · 값 없으면 none', () => {
    expect(rowSrcClass({ cpu: 1, mem: 2, usrc: { cpu: 'os', mem: 'os' } })).toBe('os');
    expect(rowSrcClass({ cpu: 1, mem: 2, usrc: { cpu: 'os', mem: 'idrac' } })).toBe('mixed');
    expect(rowSrcClass({ cpu: 1, mem: 2, usrc: { cpu: null, mem: null, mixed: true } })).toBe('mixed');
    expect(rowSrcClass({ cpu: null, mem: null })).toBe('none');
    expect(rowSrcClass({ cpu: 5, mem: null })).toBe('unknown');
  });
  it('개수 · 지표별 글자 · 툴팁은 출처를 지어내지 않는다', () => {
    const rows = [{ cpu: 1, mem: 2, usrc: { cpu: 'os', mem: 'idrac' } }, { cpu: 3, mem: 4, usrc: { cpu: 'os', mem: 'os' } }, { cpu: null, mem: null }];
    expect(srcCounts(rows)).toMatchObject({ os: 1, mixed: 1, none: 1 });
    expect(metricSrcText(rows, 'cpu')).toBe('OS 2');
    expect(metricSrcText(rows, 'mem')).toBe('OS 1 · iDRAC 1');
    expect(srcTitle({ cpu: 5, mem: 6, usrc: { cpu: 'os', mem: null } })).toContain('메모리 — 출처 모름');
  });
});

describe('v2.991 OS 주소 제안 문구(설계 bm-folders §13 ②)', () => {
  const rows = [{ state: 'suggest' }, { state: 'pick' }, { state: 'none' }, { state: 'noname' }, { state: 'closed' }, { state: 'registered' }];
  it('못 찾음 거르기는 이름 없음 · SSH 닫힘을 함께 · 고를 수 있는 것은 제안 · 고르기만', () => {
    expect(suggestRowsOf(rows, 'none').map((r) => r.state)).toEqual(['none', 'noname', 'closed']);
    expect(suggestRowsOf(rows, 'all')).toHaveLength(6);
    expect(rows.filter(pickableOf).map((r) => r.state)).toEqual(['suggest', 'pick']);
    expect(applyResultText({ added: 2, refused: [{}] })).toContain('1건은 등록하지 않았습니다');
    expect([initialFilter({ suggest: 2 }), initialFilter({ suggest: 0, pick: 1 }), initialFilter({ none: 17 })]).toEqual(['suggest', 'pick', 'all']);
  });
});
