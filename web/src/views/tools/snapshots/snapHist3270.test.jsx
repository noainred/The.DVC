// v3.27.0 — 스냅샷 화면 2단계: 스냅샷 이력 DB 로 그리는 것(7일 변화 · 정리된 VM · 추이 선 끊김 · 정리된 것 탭).
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const { snapshotToolView } = await import('../../../../../server/src/snaphist/view.js');
const { aggregateDays } = await import('../../../../../server/src/snaphist/history.js');
vi.mock('../../../api.js', async (orig) => ({ ...(await orig()), fetchJson: () => new Promise(() => {}), canCsv: () => true, toolAllowed: () => true }));
const T = await import('./snapText.js');
const { default: SnapshotTool } = await import('./SnapshotTool.jsx');

const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const HY = { snapAgeDays: 7, snapCount: 3, snapSizeGB: 100, exceptions: [], notify: { enabled: false, hour: 9 } };
const vm = (vc, name, o = {}) => ({ id: `${vc}:${name}`, vcenterId: vc, name, powerState: 'POWERED_ON', cluster: 'C1', host: 'h1', ...o });
const DATA = snapshotToolView({ vcenters: [{ id: 'va', name: 'VC-A' }, { id: 'vb', name: 'VC-B', stale: true }], datastores: [], vms: [
  vm('va', 'grew', { snapshotCount: 1, snapshotSizeGB: 60, snapshotOldestTs: NOW - 20 * DAY }),
  vm('va', 'same', { snapshotCount: 1, snapshotSizeGB: 5, snapshotOldestTs: NOW - 20 * DAY }),
  vm('va', 'brand-new', { snapshotCount: 1, snapshotSizeGB: 2, snapshotOldestTs: NOW - 2 * DAY }),
  vm('va', 'size-unknown', { snapshotCount: 1, snapshotSizeGB: 0, snapshotOldestTs: NOW - 20 * DAY }),
  vm('vb', 'other', { snapshotCount: 1, snapshotSizeGB: 1, snapshotOldestTs: NOW - 20 * DAY }),
] }, { hygiene: HY, now: NOW });
const AGO7 = { day: 'x', okVcenters: ['va'], rows: [
  { vcenterId: 'va', vmId: 'va:grew', count: 1, gb: 40 }, { vcenterId: 'va', vmId: 'va:same', count: 1, gb: 5 },
  { vcenterId: 'va', vmId: 'va:size-unknown', count: 1, gb: 3 }, { vcenterId: 'va', vmId: 'va:cleared', count: 2, gb: 80 },
  { vcenterId: 'vb', vmId: 'vb:gone-but-stale', count: 1, gb: 9 },
] };

describe('snapText 2단계', () => {
  it('7일 변화 — 7일 전 기록이 없는 vCenter 는 모름 · 못 읽은 크기는 변화 모름', () => {
    const m = T.changeMap(DATA.items, AGO7);
    expect(m.get('va\nva:grew')).toEqual({ kind: 'grew', gb: 20 });
    expect(m.get('va\nva:same').kind).toBe('same');
    expect(m.get('va\nva:brand-new').kind).toBe('new');
    expect(m.get('va\nva:size-unknown')).toEqual({ kind: 'same', gb: null });
    expect(m.has('vb\nvb:other')).toBe(false);
    expect(T.matchKey(DATA.items.find((x) => x.name === 'grew'), 'grow', m)).toBe(true);
    expect(T.changeMap(DATA.items, null).size).toBe(0);
  });
  it('정리된 VM — 값이 낡은 vCenter 는 모른다(뺀다)', () => {
    expect(T.clearedSince(DATA.items, AGO7, new Set(['vb']))).toEqual({ n: 1, gb: 80, gbUnknown: 0 });
    expect(T.clearedSince(DATA.items, null)).toBe(null);
  });
  it('꺾은선 — 빠진 날(null)은 선을 끊는다(0 으로 잇지 않는다)', () => {
    const g = T.lineGeom([1, 2, null, 4], 100, 30);
    expect((g.d.match(/M/g) || []).length).toBe(2);
    expect(g.gaps).toEqual([2]);
    expect(T.lineGeom([null, null]).d).toBe('');
  });
  it('서버 추이(aggregateDays)의 빠진 날이 그대로 끊김이 된다', () => {
    const s = aggregateDays(['d1', 'd2', 'd3'], [
      { day: 'd1', vcenter_id: 'a', status: 'ok', vms: 2, gb: 1, gb_unknown: 0, over: 0 }, { day: 'd2', vcenter_id: 'a', status: 'stale' },
      { day: 'd3', vcenter_id: 'a', status: 'ok', vms: 3, gb: 2, gb_unknown: 0, over: 1 }], new Set(['a']), new Map([['a', 'd1']]));
    expect(T.seriesValues(s, 'vms')).toEqual([2, null, 3]);
    expect(T.lineGeom(T.seriesValues(s, 'vms')).gaps).toEqual([1]);
  });
  it('정리 실적 — VM 이 없어진 것은 실적에 넣지 않는다 · 생성일을 모르면 처음 본 날부터(이상)', () => {
    const rows = T.goneRows([
      { vcenterId: 'va', vmId: 'a', name: 's1', createTs: NOW - 10 * DAY, firstSeen: NOW - 5 * DAY, lastSeen: NOW - 2 * DAY, goneAt: NOW - DAY, reason: 'snap' },
      { vcenterId: 'va', vmId: 'b', name: 's2', createTs: null, firstSeen: NOW - 4 * DAY, lastSeen: NOW - 2 * DAY, goneAt: NOW - DAY, reason: 'snap' },
      { vcenterId: 'va', vmId: 'c', name: 's3', createTs: NOW - 30 * DAY, firstSeen: NOW - 30 * DAY, lastSeen: NOW - 2 * DAY, goneAt: NOW - DAY, reason: 'vm' },
    ], () => 'VC-A', 7);
    expect(rows.map((r) => [r.lived, r.inTime, r.fromCreate])).toEqual([[9, false, true], [3, true, false], [29, false, true]]);
    expect(T.goneSummary(rows)).toEqual({ n: 2, vm: 1, avgLived: 6, inTimePct: 50 });
  });
});

describe('SnapshotTool 2단계 렌더', () => {
  const series = [{ day: 'd1', vms: 3, gb: 50, over: 1, missing: 0 }, { day: 'd2', vms: null, gb: null, over: null, missing: 1 }, { day: 'd3', vms: 4, gb: 67, over: 3, missing: 0 }];
  const HIST = { ok: true, status: { available: true, started: '2026-11-01', recordHour: 3, retentionDays: 400 }, days: ['d1', 'd2', 'd3'], series,
    byCorp: { 'vc:va': series }, gaps: [{ vcenterId: 'va', days: 1 }], ago7: AGO7,
    gone: [{ vcenterId: 'va', vmId: 'va:x', vmName: 'x', name: 'old-snap', createTs: NOW - 9 * DAY, firstSeen: NOW - 9 * DAY, lastSeen: NOW - 2 * DAY, goneAt: NOW - DAY, reason: 'snap' }], goneMore: false };
  const html = renderToStaticMarkup(React.createElement(SnapshotTool, { initial: DATA, initialHist: HIST }));
  const t = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  it('7일 변화 열 · 커짐 표시 · 지난 7일 숫자', () => {
    expect((html.match(/aria-sort=/g) || []).length).toBe(8);
    expect(t).toMatch(/\+20 GB/);
    expect(t).toMatch(/커짐/);
    expect(t).toMatch(/지난 7일 \+1 · −1 /);
    expect(t).toMatch(/7일 사이 10 GB 넘게 커짐/);
  });
  it('추이 — 빠진 날을 말하고 선이 끊긴다 · 법인 카드 그림', () => {
    expect(t).toMatch(/빠진 날 1일\(선이 끊김\)/);
    expect((html.match(/class="snp-spark/g) || []).length).toBeGreaterThanOrEqual(2);
    expect((html.match(/class="gap"/g) || []).length).toBeGreaterThanOrEqual(2);
  });
  it('‘정리된 것’ 탭 단추에 기간 · 수', () => {
    expect(t).toMatch(/정리된 것 · 30일 1/);
  });
  it('이력을 쓸 수 없으면 추이 · 탭 · 7일 변화가 없다', () => {
    const h2 = renderToStaticMarkup(React.createElement(SnapshotTool, { initial: DATA, initialHist: { ok: true, status: { available: false, error: 'x' } } }));
    expect(h2).not.toMatch(/7일 변화/);
    expect(h2).not.toMatch(/정리된 것 ·/);
    expect(h2).toMatch(/스냅샷 이력을 쓸 수 없습니다/);
  });
});
