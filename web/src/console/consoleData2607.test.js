import { describe, it, expect } from 'vitest';
import { siteRows, hostFacilityRows } from './consoleData.js';

describe('consoleData v2.607 (WEB2607-05 · WEB2607-06)', () => {
  it('측정 서버 0대 vCenter 는 호스트 보고 전력으로 폴백한다(0 kW 아님)', () => {
    const sites = siteRows([{ id: 'vc1', metrics: { powerKw: 0, powerServers: 0 } }]);
    expect(sites[0].powerKw).toBe(null);
    const rows = hostFacilityRows([
      { vcenterId: 'vc1', powerWatts: 450 }, { vcenterId: 'vc1', powerWatts: 550 },
    ], sites);
    expect(rows[0].powerKw).toBe(1);
  });
  it('측정이 있으면 그 값을 쓴다', () => {
    expect(siteRows([{ id: 'vc1', metrics: { powerKw: 1.2, powerServers: 2 } }])[0].powerKw).toBe(1.2);
  });
  it('REST 폴백 vCenter 는 alarmsUnknown', () => {
    const r = siteRows([{ id: 'a', collectSource: 'rest', alarmsUnknown: true, metrics: {} }, { id: 'b', metrics: {} }]);
    expect(r.find((x) => x.id === 'a').alarmsUnknown).toBe(true);
    expect(r.find((x) => x.id === 'b').alarmsUnknown).toBe(false);
  });
});
