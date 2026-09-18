import { describe, it, expect } from 'vitest';
import { cpuModelText, cpuModelCell } from './cpuModelText.js';

describe('cpuModelText (v2.556)', () => {
  it('Intel 원문의 군더더기를 걷어낸다', () => {
    expect(cpuModelText('Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz')).toBe('Intel Xeon Gold 6338 @ 2.00GHz');
    expect(cpuModelText('Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz')).toBe('Intel Xeon Platinum 8358 @ 2.60GHz');
  });
  it('AMD 원문도 다듬는다', () => {
    expect(cpuModelText('AMD EPYC 7763 64-Core Processor')).toBe('AMD EPYC 7763 64-Core');
  });
  it('값이 없으면 빈 문자열 — 모델명을 지어내지 않는다', () => {
    for (const bad of ['', '   ', null, undefined]) expect(cpuModelText(bad)).toBe('');
  });
  it('모르는 형식은 원문을 그대로 남긴다(억지로 잘라내지 않는다)', () => {
    expect(cpuModelText('Some Unknown 12-Way Vector Unit')).toBe('Some Unknown 12-Way Vector Unit');
  });

  it('★ 셀은 값이 없을 때 이유를 말한다(빈칸으로 두지 않는다)', () => {
    const c = cpuModelCell('');
    expect(c.text).toBe('—');
    expect(c.title).toContain('보고하지 않았습니다');
  });
  it('★ 다듬은 값 옆에 원문을 툴팁으로 남긴다(정리가 빗나갈 수 있다)', () => {
    const c = cpuModelCell('Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz');
    expect(c.text).toBe('Intel Xeon Gold 6338 @ 2.00GHz');
    expect(c.title).toBe('Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz');
  });
  it('다듬어도 같은 값이면 툴팁을 중복해 붙이지 않는다', () => {
    expect(cpuModelCell('AMD EPYC 9354 32-Core').title).toBe('');
  });
});
