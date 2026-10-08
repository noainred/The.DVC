// v2.703(A13) — 코어 라이선스 문구. vSAN 가정 키가 서버와 1:1 인지 대조한다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { VSAN_TIB_PER_CORE } from '../../../../server/src/corelicense/analyze.js';
import { VSAN_PLAN_LABEL, fmtInt, fmtTib, coverageNote, reportedText, ADDON_BOUND_NOTE, addonText } from './coreLicenseText.js';
import { addonBoundOf } from '../../../../server/src/corelicense/analyze.js';

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

// v2.721(감사 B1-03) — vSAN 추가분의 확정 여부. 서버 addonBoundOf 와 키 1:1.
describe('vSAN 추가분 확정 여부(v2.721)', () => {
  it('서버가 내는 bound 값마다 문구 키가 있다', () => {
    const bounds = new Set([addonBoundOf(0, 0, 1), addonBoundOf(1, 0, 1), addonBoundOf(0, 1, 1), addonBoundOf(1, 1, 1)]);
    expect([...bounds].sort()).toEqual(Object.keys(ADDON_BOUND_NOTE).sort());
  });
  it('상한·하한·산정 불가를 표기한다', () => {
    expect(addonText(22, 'exact')).toBe('22 TiB');
    expect(addonText(22, 'upper')).toBe('최대 22 TiB');
    expect(addonText(22, 'lower')).toBe('최소 22 TiB');
    expect(addonText(null, 'unknown')).toBe('산정 불가');
    expect(addonText(null, null)).toBe('—');
  });
  it('coverageNote 가 확정이 아닌 추가분의 방향을 말한다', () => {
    expect(coverageNote({ unknown: 2, vsanAddonBound: 'upper' })).toMatch(/실제보다 클 수 있습니다\(상한\)/);
    expect(coverageNote({ vsanUnknown: 1, vsanAddonBound: 'lower' })).toMatch(/실제보다 작을 수 있습니다\(하한\)/);
    expect(coverageNote({ vsanAddonBound: 'exact' })).toBeNull();
  });
});

// v2.727(감사 C-02): used 를 보고하지 않은 코어 라이선스가 있으면 '없음' 이 아니라 '일부 미상' 이고 비교하지 않는다.
describe('coreLicenseText v2.727', () => {
  it('reportedUsedUnknown 이 있으면 일부 미상 문구 · 비교 안 함', () => {
    const t = reportedText({ reportedCoreUsed: null, reportedDiff: null, reportedUsedUnknown: 1, coreLicenses: 1 });
    expect(t.tone).toBe('muted');
    expect(t.text).toMatch(/일부 미상/); expect(t.text).toMatch(/1개/); expect(t.text).not.toMatch(/없음/);
    expect(reportedText({ reportedCoreUsed: null, reportedUsedUnknown: 0 }).text).toContain('없음');
  });
});
