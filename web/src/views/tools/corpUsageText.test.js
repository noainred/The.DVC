import { describe, it, expect } from 'vitest';
import {
  pctText, coresText, memText, coverageText, srcText, isPartial, countedOf,
  filterCorps, groupCounts, noticesOf, footnotes, csvOf,
} from './corpUsageText.js';

const agg = (o = {}) => ({ servers: 10, unread: 1, stale: 1, noCap: 0, src: { idrac: 5, os: 2, vcenter: 1 },
  cpu: { used: 12.3, total: 48, pct: 25.6 }, mem: { used: 300, total: 1024, pct: 29.3 }, ...o });

describe('corpUsageText', () => {
  it('값이 없으면 — 이고 단위를 붙이지 않는다', () => {
    expect(pctText(null)).toBe('—');
    expect(pctText('')).toBe('—');
    expect(pctText(0)).toBe('0%');
    expect(coresText({ used: 0, total: 0 })).toBe('—');
    expect(coresText(null)).toBe('—');
    expect(memText({ used: null, total: null })).toBe('—');
  });
  it('절대량 표기 — 코어 · GB · 큰 값은 TB', () => {
    expect(coresText({ used: 12.3, total: 48 })).toBe('12.3 / 48 코어');
    expect(memText({ used: 300.4, total: 1024 })).toBe('300 / 1,024 GB');
    expect(memText({ used: 5120, total: 20480 })).toBe('5.0 / 20.0 TB');
  });
  it('합계에서 뺀 서버를 밝힌다 · 0 인 사유는 적지 않는다', () => {
    expect(countedOf(agg())).toBe(8);
    expect(coverageText(agg())).toBe('반영 8/10대 · 못 읽음 1 · 오래됨 1');
    expect(coverageText({ servers: 0 })).toBe('서버 없음');
    expect(isPartial(agg())).toBe(true);
    expect(isPartial(agg({ unread: 0, stale: 0 }))).toBe(false);
    expect(srcText(agg())).toBe('iDRAC 5 · OS 2 · vCenter 1');
    expect(srcText({ src: {} })).toBe('');
  });
  it('구분·범위 필터와 개수', () => {
    const corps = [{ vcenterId: 'a', group: 'davinci' }, { vcenterId: 'b', group: 'irs' }, { vcenterId: 'c', group: 'davinci' }];
    expect(filterCorps(corps, 'irs').map((c) => c.vcenterId)).toEqual(['b']);
    expect(filterCorps(corps, 'all', 'c').map((c) => c.vcenterId)).toEqual(['c']);
    expect(groupCounts(corps)).toEqual({ all: 3, davinci: 2, irs: 1 });
  });
  it('안내 — 꺼짐 · vCenter 대체 · 켠 법인 없음 · 엣지', () => {
    const off = noticesOf({ settings: { enabled: false }, corps: [], edgeSnaps: { count: 0 } });
    expect(off.some((n) => n.text.includes('꺼져 있습니다'))).toBe(true);
    const on = noticesOf({ settings: { enabled: true, idracTelemetry: true, includeVirtualization: false }, corps: [{ collectOn: false }], edgeSnaps: { count: 2 } });
    expect(on.map((n) => n.text).join('\n')).toMatch(/vCenter 값입니다/);
    expect(on.map((n) => n.text).join('\n')).toMatch(/켠 법인이 없습니다/);
    expect(on.map((n) => n.text).join('\n')).toMatch(/2곳/);
    const err = noticesOf({ settings: { enabled: true, idracTelemetry: true, includeVirtualization: true }, corps: [{ collectOn: true }], sourceErrors: ['분류: x'] });
    expect(err[0].tone).toBe('bad');
    expect(noticesOf(null)).toEqual([]);
  });
  it('v2.626 — 법인을 못 정한 물리 서버·규칙으로 채운 수를 안내한다', () => {
    const txt = noticesOf({ settings: { enabled: true, idracTelemetry: true, includeVirtualization: true }, corps: [{ collectOn: true }],
      unassigned: { bm: agg({ servers: 12 }) }, attributed: { filled: 480 }, edgeSnaps: { count: 0 } }).map((n) => n.text).join('\n');
    expect(txt).toMatch(/법인을 정하지 못한 물리 서버 12대/);
    expect(txt).toMatch(/물리 서버 480대는/);
    expect(txt).toMatch(/그 엣지 포탈의/);
    const none = noticesOf({ settings: { enabled: true }, corps: [], attributed: { filled: null }, edgeSnaps: {} }).map((n) => n.text).join('\n');
    expect(none).not.toMatch(/정하지 못한|대는 등록부/);
  });
  it('각주 — 귀속 없는 물리 서버를 밝힌다 · 백틱 없음', () => {
    const f = footnotes({ unassigned: { bm: agg({ servers: 3, unread: 0, stale: 0 }) } });
    expect(f.join('\n')).toMatch(/귀속 없는 물리 서버 3대/);
    for (const s of [...f, ...noticesOf({ settings: {}, corps: [], edgeSnaps: {} }).map((n) => n.text)]) expect(s).not.toMatch(/`/);
  });
  it('CSV — 수식 가드 · null 은 빈 칸', () => {
    const csv = csvOf([{ name: '=cmd', group: 'irs', all: { servers: 1, cpu: { pct: null } }, bm: {}, virt: {} }]);
    const line = csv.split('\r\n')[1];
    expect(line.startsWith("'=cmd,IRS,1,")).toBe(true);
  });
});
