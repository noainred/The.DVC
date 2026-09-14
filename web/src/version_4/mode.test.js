// version_4/mode.js 회귀(v2.508) — 모드 판정은 '권한'이 아니라 '보기'다. 우선순위와 역할 기본값을 고정한다.
import { describe, it, expect } from 'vitest';
import { MODES, normMode, defaultMode, resolveMode, modeSpec, viewFromHash } from './mode.js';

describe('모드 판정', () => {
  it('아는 값만 통과한다', () => {
    expect(normMode('exec')).toBe('exec');
    expect(normMode('ENG')).toBe('eng');
    expect(normMode('admin')).toBe(null);
    expect(normMode(undefined)).toBe(null);
    expect(normMode('')).toBe(null);
  });

  it('역할 기본값 — operator 만 엔지니어', () => {
    expect(defaultMode('admin')).toBe('exec');
    expect(defaultMode('operator')).toBe('eng');
    expect(defaultMode('viewer')).toBe('exec');
    expect(defaultMode(undefined)).toBe('exec'); // 역할을 모르면 경영(잠긴 벽을 덜 본다)
  });

  it('우선순위: query > localStorage > 역할', () => {
    expect(resolveMode({ query: 'eng', stored: 'exec', role: 'admin' })).toBe('eng');
    expect(resolveMode({ query: null, stored: 'eng', role: 'admin' })).toBe('eng');
    expect(resolveMode({ role: 'operator' })).toBe('eng');
    // 저장값이 깨졌으면(수동 편집·구버전) 무시하고 역할 기본값으로 떨어진다.
    expect(resolveMode({ stored: 'garbage', role: 'admin' })).toBe('exec');
  });

  it('modeSpec 은 보기 항목만 바꾼다 — 권한·임계값 키가 없다', () => {
    for (const m of MODES) {
      const s = modeSpec(m);
      expect(Object.keys(s).sort()).toEqual(['collect', 'days', 'rawCols', 'rows', 'unit']);
      expect(s).not.toHaveProperty('perm');
      expect(s).not.toHaveProperty('warnPct');
    }
    expect(modeSpec('eng').rows).toBeGreaterThan(modeSpec('exec').rows);
    expect(modeSpec('eng').rawCols).toBe(true);
    expect(modeSpec('exec').rawCols).toBe(false);
  });

  it('해시 질의에서 view 를 읽는다', () => {
    expect(viewFromHash('#/v4/overview?view=eng')).toBe('eng');
    expect(viewFromHash('#/v4/overview?a=1&view=exec')).toBe('exec');
    expect(viewFromHash('#/v4/overview')).toBe(null);
    expect(viewFromHash('#/v4/overview?view=nope')).toBe(null);
    expect(viewFromHash('')).toBe(null);
  });
});
