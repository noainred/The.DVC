// 전체 점검 57회차 F2 — 합계 변화는 두 시점의 장비 구성이 같을 때만(새로 등록한 장비의 사용량 전체를 '증가' 로 세지 않는다).
// 웹 groupSummary · setChangeOf 는 서버 storage/usageReport.js · usageInsights.js 와 같은 규칙의 사본이다 — 같은 입력으로 대조한다.
import { describe, it, expect } from 'vitest';
import { groupSummary, setChangeOf } from './storageUsageText.js';

const S = await import('../../../../server/src/storage/usageReport.js');
const SI = await import('../../../../server/src/storage/usageInsights.js');
const TB = 1024 ** 4;
const TODAY = Math.floor(Date.now() / 86_400_000);   // 실제 시각을 하루 경계로 떨어뜨린 기준일

function report({ addB = true } = {}) {
  const periods = S.buildPeriods({ gran: 'weekly', asOfDay: TODAY, count: 4, weekday: 1 });
  const p = periods.map((x) => x.toDay);
  const rows = p.map((d, i) => ({ device_id: 'A', day: d, total_bytes: 100 * TB, used_bytes: (50 + i) * TB }));
  if (addB) rows.push({ device_id: 'B', day: p[p.length - 1], total_bytes: 500 * TB, used_bytes: 300 * TB });
  const devices = [{ id: 'A', name: 'A', type: 'unity', datacenterId: 'dc1' }, ...(addB ? [{ id: 'B', name: 'B', type: 'unity', datacenterId: 'dc1' }] : [])];
  const spans = { A: { firstDay: p[0], lastDay: p[p.length - 1] }, ...(addB ? { B: { firstDay: p[p.length - 1], lastDay: p[p.length - 1] } } : {}) };
  return { periods, devices: S.buildUsageReport({ rows, periods, devices, spans }) };
}

describe('57회차 F2 — 장비 구성이 바뀐 두 시점의 합계는 빼지 않는다', () => {
  it('새 장비가 든 주의 직전 대비 · 범위 · 평균은 null 이고 사유를 말한다', () => {
    const r = report();
    const g = groupSummary('all', '전체', r.devices, r.periods);
    expect(g.cur.partial).toBe(false);
    expect(g.delta).toBeNull();             // 예전 +301 TB
    expect(g.deltaWhy).toMatch(/장비 구성이 달라/);
    expect(g.range).toBeNull();
    expect(g.avg).toBeNull();
  });
  it('구성이 같으면 예전과 같다', () => {
    const r = report({ addB: false });
    const g = groupSummary('all', '전체', r.devices, r.periods);
    expect(g.delta).toBe(1 * TB);
    expect(g.range).toBe(3 * TB);
    expect(g.avg).toBe(1 * TB);
    expect(g.deltaWhy).toBe('');
  });
  it('setChangeOf · 직전 대비 판정이 서버와 같다', () => {
    for (const addB of [true, false]) {
      const r = report({ addB });
      const n = r.periods.length;
      expect(setChangeOf(r.devices, n - 2, n - 1)).toBe(S.setChangeOf(r.devices, n - 2, n - 1));
      const cells = S.aggregateCells(r.devices, r.periods);
      const srv = SI.aggTrendOf(cells, { devs: r.devices });
      const web = groupSummary('all', '전체', r.devices, r.periods);
      expect(web.delta).toBe(srv.delta);
      expect(!!web.deltaWhy).toBe(!!srv.deltaWhy);
    }
  });
});
