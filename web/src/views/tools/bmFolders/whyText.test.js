import { describe, it, expect } from 'vitest';
import { whyOf, whyShort, whyBands, agoText, pickAll, pickNotInFolder, pickNote } from './whyText.js';
import { filterRows } from '../bmFoldersText.js';

describe('v2.992 값 없음 사유(설계 bm-folders §12)', () => {
  it('모르는 코드는 확인 못 함 · 오래됨은 경과 시간', () => {
    expect(whyOf('zzz').s).toBe('확인 못 함');
    const now = 10 * 3600_000;
    expect(whyShort({ code: 'stale', at: now - (2 * 60 + 14) * 60_000 }, now)).toBe('오래됨 · 2시간 14분 전');
    expect(whyShort({ code: 'no-os-cred' })).toBe('OS 계정 없음');
    expect(agoText(null)).toBe('');
  });
  it('사유 띠는 값이 없는 행만 · 많은 순 · 띠를 누르면 그 사유만 거른다', () => {
    const rows = [{ key: 'a', cpu: null, mem: null, why: { code: 'no-os-cred' } }, { key: 'b', cpu: null, mem: null, why: { code: 'no-os-cred' } }, { key: 'c', cpu: null, mem: null, why: { code: 'off' } }, { key: 'd', cpu: 5, mem: 6 }];
    expect(whyBands(rows).map((b) => [b.code, b.n])).toEqual([['no-os-cred', 2], ['off', 1]]);
    expect(filterRows(rows, '', 'why:no-os-cred').map((r) => r.key)).toEqual(['a', 'b']);
  });
});

describe('v2.992 고르기 버튼(서버 찾아 등록)', () => {
  const rows = [{ key: 'a', place: 'manual' }, { key: 'b', place: null }, { key: 'c', place: 'auto' }];
  it('전체 · 폴더에 없는 서버만(손 등록 없는 서버 — 자동 규칙만인 서버 포함) · 결과 문장', () => {
    expect([...pickAll(rows)]).toEqual(['a', 'b', 'c']);
    const n = pickNotInFolder(rows);
    expect([...n]).toEqual(['b', 'c']);
    expect(pickNote('notin', rows, n)).toBe('폴더에 없는 2대를 골랐습니다 — 이미 폴더에 있는 1대는 뺐습니다(자동 규칙으로만 놓인 1대 포함).');
    expect(pickNote('all', rows, pickAll(rows))).toBe('찾은 3대를 모두 골랐습니다.');
  });
});
