/**
 * v2.733 점검 3회차 — 그룹 e · C2-03 스토리지 증가량 합계(화면 쪽).
 *
 *  ① aggregateGrowth 가 실제 구간이 요청 기간의 1.1배(내림)를 넘는 장비를 합계에서 빼고 inexact 로 센다(서버 totalsOf 와 같은 답)
 *  ② totalCell 이 못 더한 사유를 나눠 말한다(기준선 없음 / 최신 관측 늦음 / 구간이 김) · 한계 안의 긴 구간(widened)도 밝힌다
 *  ③ 합계 각주(spanToleranceNote) — 기간별 한계를 기간에서 계산하고, 백틱이 없다(BoldText 는 **강조** 만 해석한다)
 *  ④ StorageGrowthTool 이 각주를 BoldText 로 그린다 · '합계가 전 장비 기준이 아닙니다' 안내가 구간 사유도 말한다
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as web from './storageGrowthText.js';
import * as srv from '../../../../server/src/storage/growth.js';

const TB = 1e12;
const AS_OF = 20000;
const row = (id, day, used, total = 2000 * TB) => ({ device_id: id, day, total_bytes: total, used_bytes: used, last_ts: day * 86_400_000, samples: 4 });
const P = [{ key: '7d', days: 7, label: '1주' }, { key: '30d', days: 30, label: '1개월' }, { key: '90d', days: 90, label: '3개월' }];

function repro() {
  const rows = [];
  for (let d = AS_OF - 400; d <= AS_OF; d++) rows.push(row('A', d, (100 + (d - (AS_OF - 400))) * TB));
  rows.push(row('B', AS_OF - 365, 10 * TB, 1000 * TB));
  for (let d = AS_OF - 20; d <= AS_OF; d++) rows.push(row('B', d, (300 + 0.1 * (d - (AS_OF - 20))) * TB, 1000 * TB));
  return srv.growthMatrix(rows, { periods: P, asOfDay: AS_OF });
}

describe('C2-03 ① aggregateGrowth — 구간이 크게 긴 장비는 합계에서 빠진다', () => {
  it('1개월 합계는 A 의 30TB 이고 B 는 inexact 로 센다(예전 322TB · partial:false)', () => {
    const m = repro();
    const a = web.aggregateGrowth(JSON.parse(JSON.stringify(m.devices)), P, { asOfDay: AS_OF });
    expect(Math.abs(a.growth['30d'].bytes - 30 * TB)).toBeLessThan(1e-3);
    expect(a.growth['30d'].inexact).toBe(1);
    expect(a.growth['30d'].partial).toBe(true);
    expect(a.growth['30d'].maxSpanDays).toBe(33);
    expect(Math.abs(a.growth['30d'].perDayBytes - TB)).toBeLessThan(1e-3);
    expect(a.growth['7d'].partial).toBe(false);
    for (const p of P) {
      for (const k of ['bytes', 'measured', 'missing', 'partial', 'inexact', 'widened', 'lagging', 'maxSpanDays']) {
        expect(a.growth[p.key][k], `${p.key}.${k}`).toEqual(m.totals.growth[p.key][k]);
      }
    }
  });

  it('실제 구간(spanDays)을 모르면 판정하지 않는다 — 예전처럼 더한다(지어내지 않는다)', () => {
    const a = web.aggregateGrowth([{ deviceId: 'x', latestDay: AS_OF, usedBytes: 1, totalBytes: 2, growth: { '30d': { bytes: 5 } } }], P, { asOfDay: AS_OF });
    expect(a.growth['30d'].bytes).toBe(5);
    expect(a.growth['30d'].inexact).toBeUndefined();
    expect(a.growth['30d'].perDayBytes).toBeNull();   // 장비 하루 증가량을 모르면 합도 지어내지 않는다
  });
});

describe('C2-03 ② totalCell — 못 더한 사유를 나눠 말한다', () => {
  it('기준선 없음 · 늦음 · 구간이 김 · 한계 안 긴 구간', () => {
    const c = web.totalCell({ bytes: 30 * TB, measured: 2, missing: 3, partial: true, lagging: 1, inexact: 1, widened: 1, maxSpanDays: 33, perDayBytes: TB }, 'tb');
    expect(c.partial).toBe(true);
    expect(c.title).toContain('2대만 합산');
    expect(c.title).toContain('1대는 이 기간의 기준선이 없어');
    expect(c.title).toContain('1대는 최신 관측이 기준일보다 늦어');
    expect(c.title).toContain('실제 비교 구간이 33일을 넘어');
    expect(c.title).toContain('최대 33일');
    expect(c.title).toContain('전체 합이 아닙니다');
    expect(c.title).not.toMatch(/`/);
  });
  it('한 대도 못 더했으면 그 사유와 함께 말한다', () => {
    const c = web.totalCell({ bytes: null, measured: 0, missing: 2, partial: false, inexact: 2, maxSpanDays: 7 });
    expect(c.title).toContain('2대 모두');
    expect(c.title).toContain('7일을 넘어');
    expect(c.text).toBe('—');
  });
});

describe('C2-03 ③ spanToleranceNote', () => {
  it('기간별 한계를 계산해 말하고 백틱이 없다', () => {
    const t = web.spanToleranceNote([{ key: '1d', days: 1, label: '1일' }, { key: '7d', days: 7, label: '1주' }, ...P.slice(1)]);
    expect(t).toContain('1개월 → 33일');
    expect(t).toContain('3개월 → 99일');
    expect(t).toContain('1일·1주 기간은 하루만 비어도');
    expect(t).toContain('**합계에서 뺍니다**');
    expect(t).not.toMatch(/`/);
    expect(web.spanToleranceNote([])).toBeNull();
    expect(web.spanToleranceNote(null)).toBeNull();
  });
  it('한계는 서버와 같은 값이다', () => {
    expect(web.GROWTH_SPAN_TOLERANCE).toBe(srv.GROWTH_SPAN_TOLERANCE);
    for (const d of [1, 7, 14, 30, 60, 90, 180, 365, 730, 1825, 3650]) expect(web.maxSpanDaysFor(d)).toBe(srv.maxSpanDaysFor(d));
  });
});

describe('C2-03 ④ StorageGrowthTool', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'StorageGrowthTool.jsx'), 'utf8');
  it('합계 각주를 BoldText 로 그린다', () => {
    expect(src).toMatch(/spanToleranceNote\(cols\) && <li><BoldText text=\{spanToleranceNote\(cols\)\} \/><\/li>/);
  });
  it("'합계가 전 장비 기준이 아닙니다' 안내가 구간 사유를 함께 말한다", () => {
    expect(src).toMatch(/합계가 전 장비 기준이 아닙니다\.[^`]*실제 비교 구간이 요청 기간보다 크게 긴 장비/);
  });
});
