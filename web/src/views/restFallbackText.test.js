import { describe, it, expect } from 'vitest';
import { isRestFallback, alarmsUnknown, restFallbackBadge, alarmTotals } from './restFallbackText.js';

describe('restFallbackText (WEB2607-06 · LEFT2607-04)', () => {
  const rest = { id: 'a', collectSource: 'rest', restUnknown: ['cluster', 'vmPlacement', 'alarms'], alarmsUnknown: true, metrics: { alarmsCritical: 0, alarmsWarning: 0 } };
  const siteRest = { id: 'b', collectSource: 'site', collectMethod: 'rest', metrics: { alarmsCritical: 0 } };
  const soap = { id: 'c', collectSource: 'site', metrics: { alarmsCritical: 2, alarmsWarning: 1 } };
  it('REST 폴백·엣지 위임 REST(collectMethod) 둘 다 인식', () => {
    expect(isRestFallback(rest)).toBe(true);
    expect(isRestFallback(siteRest)).toBe(true);
    expect(isRestFallback(soap)).toBe(false);
    expect(alarmsUnknown(siteRest)).toBe(true);
    expect(alarmsUnknown(soap)).toBe(false);
  });
  it('배지는 미수집 항목을 말한다', () => {
    expect(restFallbackBadge(rest).title).toMatch(/클러스터·VM 배치\(호스트별 VM\)·경보/);
    expect(restFallbackBadge(soap)).toBe(null);
  });
  it('합계는 경보를 모르는 vCenter 를 0 으로 더하지 않고 개수를 센다', () => {
    expect(alarmTotals([rest, siteRest, soap])).toEqual({ critical: 2, warning: 1, total: 3, unknown: 2 });
  });
});
