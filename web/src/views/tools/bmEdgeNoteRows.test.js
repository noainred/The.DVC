import { describe, it, expect } from 'vitest';
import { edgeNoteRows } from './bmUsageText.js';

describe('엣지 보관분 안내 — 이름별 한 줄(v2.945.1)', () => {
  it('같은 이름(대소문자 · 공백 무시)은 첫 행 하나 + 개수', () => {
    const out = edgeNoteRows([{ agent: 'OC2SDBX' }, { agent: 'AZ' }, { agent: 'oc2sdbx ' }, { agent: 'OC2SDBX' }, null, { agent: 'MI' }]);
    expect(out.map((x) => [x.r.agent, x.dup])).toEqual([['OC2SDBX', 3], ['AZ', 1], ['MI', 1]]);
  });
  it('빈 입력 · 배열 아님', () => {
    expect(edgeNoteRows()).toEqual([]);
    expect(edgeNoteRows({})).toEqual([]);
  });
});
