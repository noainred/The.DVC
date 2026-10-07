// v2.721(감사 R1-02·R2-01·R2-02) — 스토리지 사용량 분석: 피크 보기도 측정 없음을 null 로, 법인 합계는 측정분만.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { perfAvgOf, perfMaxOf, dcGrandTotals, dcUnmeasuredNote, dcSharePct } from './sanStorageSumText.js';
import { bytesPerSecText } from './sanSwitchPorts.js';

const unmeasured = { avgTotal: null, maxTotal: null, peakAvg: null, peakTotal: null };
const measured = { avgTotal: 1_000_000, maxTotal: 2_000_000, peakAvg: 2_000_000, peakTotal: 3_000_000 };

describe('R2-01 피크 보기의 측정 없음', () => {
  it('평균·피크 모두 null 을 유지한다(0 금지)', () => {
    expect(perfAvgOf(unmeasured, false)).toBe(null);
    expect(perfAvgOf(unmeasured, true)).toBe(null);
    expect(perfMaxOf(unmeasured, true)).toBe(null);
    expect(bytesPerSecText(perfAvgOf(unmeasured, true))).toBe('—');
    expect(perfAvgOf(measured, true)).toBe(2_000_000);
    expect(perfMaxOf(measured, false)).toBe(2_000_000);
    // 보고된 0 은 값이다.
    expect(perfAvgOf({ peakAvg: 0 }, true)).toBe(0);
  });
  it('화면이 이 판정을 쓴다(`|| 0` 사본 금지)', () => {
    const src = fs.readFileSync(new URL('./SanSwitchTool.jsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/peakAvg \|\| 0/);
    expect(src).not.toMatch(/peakTotal \|\| 0/);
    expect(src).toMatch(/perfAvgOf\(s, peak\)/);
    expect(src).toMatch(/dcGrandTotals\(dcTotals, peak\)/);
  });
});

describe('R2-02 법인 소계 KPI', () => {
  const dcs = [
    { datacenterId: 'a', storages: 2, unmeasured: 0, ...measured },
    { datacenterId: 'b', storages: 0, unmeasured: 3, ...unmeasured },
  ];
  it('측정 없는 법인은 합에서 빼고 개수를 밝힌다', () => {
    for (const peak of [false, true]) {
      const g = dcGrandTotals(dcs, peak);
      expect(g.avg).toBe(peak ? 2_000_000 : 1_000_000);
      expect(g.unmeasuredDcs).toBe(1);
      expect(g.unmeasuredSeries).toBe(3);
      expect(g.storages).toBe(2);
    }
  });
  it('전부 측정 없음이면 합계는 null(—)', () => {
    const g = dcGrandTotals([dcs[1]], true);
    expect(g.avg).toBe(null);
    expect(g.max).toBe(null);
    expect(bytesPerSecText(g.avg)).toBe('—');
  });
  it('법인 KPI 는 null 이면 — 이고 비율을 지어내지 않으며 측정 없음을 말한다', () => {
    expect(bytesPerSecText(perfAvgOf(dcs[1], false))).toBe('—');
    expect(dcSharePct(dcs[1], 1_000_000, false)).toBe(undefined);
    expect(dcSharePct(dcs[0], 1_000_000, false)).toBe(100);
    expect(dcUnmeasuredNote(dcs[1])).toMatch(/측정 없음 3개/);
    expect(dcUnmeasuredNote(dcs[0])).toBe('');
  });
});
