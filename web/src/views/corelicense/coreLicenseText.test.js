// v2.703(A13) — 코어 라이선스 문구. vSAN 가정 키가 서버와 1:1 인지 대조한다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { VSAN_TIB_PER_CORE } from '../../../../server/src/corelicense/analyze.js';
import { VSAN_PLAN_LABEL, fmtInt, fmtTib, coverageNote, reportedText } from './coreLicenseText.js';

describe('coreLicenseText', () => {
  it('vSAN 가정 키가 서버와 1:1', () => {
    expect(Object.keys(VSAN_PLAN_LABEL).sort()).toEqual(Object.keys(VSAN_TIB_PER_CORE).sort());
  });
  it('값이 없으면 —(0 으로 지어내지 않는다)', () => {
    expect(fmtInt(null)).toBe('—'); expect(fmtTib(undefined)).toBe('—');
    expect(fmtInt(1234)).toBe('1,234'); expect(fmtTib(1.5)).toBe('1.5 TiB');
  });
  it('부분 합이면 하한임을 먼저 말한다', () => {
    expect(coverageNote({ unknown: 0, disconnected: 0, vsanUnknown: 0 })).toBeNull();
    expect(coverageNote({ unknown: 3, disconnected: 0, vsanUnknown: 0 })).toContain('하한');
    expect(coverageNote({ unknown: 0, disconnected: 2, vsanUnknown: 1 })).toContain('끊긴 호스트 2대');
  });
  it('보고 비교 — 코어 라이선스 없음 / 부분 합 / 일치 / 차이', () => {
    expect(reportedText({ reportedCoreUsed: null }).text).toContain('없음');
    expect(reportedText({ reportedCoreUsed: 10, reportedDiff: null }).tone).toBe('muted');
    expect(reportedText({ reportedCoreUsed: 10, reportedDiff: 0 }).tone).toBe('ok');
    expect(reportedText({ reportedCoreUsed: 10, reportedDiff: -6 }).text).toContain('-6');
  });
  it('문구·화면에 백틱 없음', () => {
    for (const f of ['src/views/corelicense/coreLicenseText.js', 'src/views/tools/CoreLicenseTool.jsx']) {
      const s = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(s.includes('\\`')).toBe(false);
    }
  });
});
