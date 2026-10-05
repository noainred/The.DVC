// v2.703(A15) — 태그 점검 문구. 상태 키가 서버와 1:1 인지 대조한다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { TAG_STATES } from '../../../../server/src/tags/analyze.js';
import { TAG_STATE_TEXT, pctText, coverageNote, policyNote, vmTagLine } from './vmTagsText.js';

describe('vmTagsText', () => {
  it('상태 키가 서버와 1:1', () => { expect(Object.keys(TAG_STATE_TEXT).sort()).toEqual([...TAG_STATES].sort()); });
  it('비율 — 분모 0 이면 —', () => { expect(pctText(1, 0)).toBe('—'); expect(pctText(1, 4)).toBe('25%'); });
  it('확인 범위 — 못 읽은 vCenter 의 VM 은 다 붙어 있다가 아니다 · 필수 카테고리 부재', () => {
    expect(coverageNote({ uncheckedVms: 0 }, [])).toBeNull();
    const n = coverageNote({ uncheckedVms: 5 }, [{ name: 'A', state: 'error' }, { name: 'B', state: 'ok', requiredAbsent: ['Env'] }]);
    expect(n).toContain('VM 5대'); expect(n).toContain('B: Env');
  });
  it('정책 없음 안내', () => { expect(policyNote({ requiredCategories: [] })).toContain('필수 카테고리'); expect(policyNote({ requiredCategories: ['x'] })).toBeNull(); });
  it('VM 한 줄 — 모름·없음·있음을 나눈다', () => {
    expect(vmTagLine({ tags: null, state: 'unsupported' })).toContain('태그 API');
    expect(vmTagLine({ tags: null, state: 'not-collected' })).toContain('아직');
    expect(vmTagLine({ tags: [] })).toBe('붙은 태그 없음');
    expect(vmTagLine({ tags: [{ category: 'Env', tag: 'Prod' }] })).toBe('Env: Prod');
  });
  it('문구·화면에 백틱 없음', () => {
    for (const f of ['src/views/tags/vmTagsText.js', 'src/views/tools/VmTagsTool.jsx']) {
      const s = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(s.includes('\\`')).toBe(false);
    }
  });
});
