// 143회차(138회차 반증) — 스냅샷 화면.
//  N143-1: 점검중 vCenter(store.js 가 캐시를 stale 없이 서빙 — VM 이 목록 · 수에 든다)를 요약이 ‘지금 값을 못 읽은 vCenter 1곳은 빠졌습니다’ 로 적었다.
//  N143-6: 법인을 고르면 추이 그림은 그 법인 줄인데 처음 → 마지막 · 빠진 날은 전체 줄에서 셌다 · 서버가 싣는 excluded(점검중 · 비활성으로 뺀 날)를
//          말하지 않았다 · 모든 날에 빠진 vCenter 가 있으면 ‘아직 기록이 없습니다’ 로 적었다.
// 입력은 서버 snaphist/view.js · history.aggregateDays 가 만든 실제 응답 모양.
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
const vm = (vc, name, o = {}) => ({ id: `${vc}:${name}`, vcenterId: vc, name, powerState: 'POWERED_ON', cluster: 'C1', host: 'h1',
  snapshotCount: 1, snapshotSizeGB: 20, snapshotOldestTs: NOW - 20 * DAY, ...o });
const view = (vb, vbVms = []) => snapshotToolView({ vcenters: [{ id: 'va', name: 'VC-A', status: 'connected' }, vb], datastores: [], vms: [vm('va', 'a1'), ...vbVms] }, { hygiene: HY, now: NOW });

describe('N143-1 — 요약의 ‘지금 값을 못 읽은 vCenter’', () => {
  it('점검중 캐시(목록 · 수에 VM 이 든다)는 ‘빠졌습니다’ 가 아니라 ‘직전 값으로 셌습니다’', () => {
    const d = view({ id: 'vb', name: 'VC-B', status: 'maintenance', maintenance: true }, [vm('vb', 'b1')]);
    const cards = T.corpCards(d.items, d.corps);
    expect(T.summaryOf(d.items).vms).toBe(2);   // b1 이 수에 들어 있다
    const t = T.unreadSumText(cards, '');
    expect(t).not.toMatch(/빠졌습니다/);
    expect(t).toMatch(/지금 값을 못 읽은 vCenter 1곳은 직전 값으로 셌습니다/);
    expect(T.unreadSumText(cards, 'vc:vb')).toMatch(/직전 값으로 셌습니다/);
    expect(T.unreadSumText(cards, 'vc:va')).toBe('');
  });
  it('VM 이 목록에 없는 못 읽은 vCenter(보존 창이 지난 unreachable · 점검중 캐시 없음)는 그대로 ‘빠졌습니다’', () => {
    for (const vb of [{ id: 'vb', name: 'VC-B', status: 'unreachable' }, { id: 'vb', name: 'VC-B', status: 'maintenance', maintenance: true }]) {
      const d = view(vb);
      const t = T.unreadSumText(T.corpCards(d.items, d.corps), '');
      expect(t).toMatch(/지금 값을 못 읽은 vCenter 1곳은 빠졌습니다/);
      expect(t).not.toMatch(/직전 값/);
    }
  });
  it('일부만 못 읽은 법인 카드 — 말줄임 한 줄에서 ‘지금 값을 못 읽은’ 이 앞에 온다 · 카드 title 에도 있다(Chromium 1440 에서 잘려 보이지 않았다)', () => {
    const d = view({ id: 'vb', name: 'VC-B', status: 'maintenance', maintenance: true }, [vm('vb', 'b1')]);
    const b = T.corpCards(d.items, d.corps).find((c) => c.id === 'vc:vb');
    expect(T.corpFootText(b).startsWith('지금 값을 못 읽은 vCenter 1곳')).toBe(true);
    const html = renderToStaticMarkup(<SnapshotTool initial={d} initialHist={{ ok: true, status: { available: false } }} />);
    expect(html).toContain('title="VC-B — 스냅샷이 있는 VM 1대(기준 넘김 1대) · 20 GB · 지금 값을 못 읽은 vCenter 1곳 — 누르면');
  });
  it('화면 — 점검중 캐시 vCenter 를 수에 넣은 채 ‘빠졌습니다’ 로 적지 않는다', () => {
    const d = view({ id: 'vb', name: 'VC-B', status: 'maintenance', maintenance: true }, [vm('vb', 'b1')]);
    const html = renderToStaticMarkup(<SnapshotTool initial={d} initialHist={{ ok: true, status: { available: false } }} />);
    expect(html).not.toMatch(/못 읽은 vCenter 1곳은 빠졌습니다/);
    expect(html).toMatch(/못 읽은 vCenter 1곳은 직전 값으로 셌습니다/);
  });
});

describe('N143-6 — 추이 설명은 그림과 같은 줄', () => {
  const days = Array.from({ length: 6 }, (_, i) => `2026-11-${String(10 + i).padStart(2, '0')}`);
  const row = (day, id, status, gb) => ({ day, vcenter_id: id, status, vms: status === 'ok' ? 1 : null, snaps: status === 'ok' ? 1 : null, gb: status === 'ok' ? gb : null, gb_unknown: status === 'ok' ? 0 : null, over: 0 });
  // va 10 GB 매일 정상 · vm2 30 GB — 뒤 3일 점검중(뺀 날) · vb 처음부터 못 읽음(빠진 날)
  // 147회차(143 결정 D1): REST 수집(no-snap)은 이제 점검중처럼 묶음에서 뺀다 — ‘빠진 날’ 재료는 unreachable 로 바꿨다(REST 는 decide147.test.jsx)
  const rows = days.flatMap((d, i) => [row(d, 'va', 'ok', 10), row(d, 'vm2', i >= 3 ? 'maintenance' : 'ok', 30), row(d, 'vb', 'unreachable')]);
  const first = new Map([['va', days[0]], ['vm2', days[0]], ['vb', days[0]]]);
  const hist = (ids) => ({ ok: true, status: { available: true, recordHour: 3, retentionDays: 400, started: days[0] }, days,
    series: aggregateDays(days, rows, new Set(ids), first),
    byCorp: Object.fromEntries(ids.map((id) => [`vc:${id}`, aggregateDays(days, rows, new Set([id]), first)])), gaps: [], gone: [], ago7: null });
  it('법인을 고르면 처음 · 마지막 · 빠진 날을 그 법인 줄에서 센다', () => {
    const h = hist(['va', 'vm2', 'vb']);
    const all = T.trendOf(h, '', 'gb');
    expect(all.first).toBe(null); expect(all.missingDays).toBe(6);   // 못 읽은 vCenter 하나가 전체 합을 매일 비운다(일시 실패 — 빠진 날)
    const a = T.trendOf(h, 'vc:va', 'gb');
    expect([a.first, a.last, a.missingDays]).toEqual([10, 10, 0]);
    expect(a.values).toEqual(T.seriesValues(h.byCorp['vc:va'], 'gb'));
  });
  it('점검중으로 뺀 날(값이 있는 날만)을 센다', () => {
    const h = hist(['va', 'vm2']);
    const t = T.trendOf(h, '', 'gb');
    expect([t.first, t.last, t.excludedDays, t.missingDays]).toEqual([40, 10, 3, 0]);
    expect(T.trendOf(h, 'vc:vm2', 'gb').excludedDays).toBe(0);   // vm2 하나뿐인 줄의 그날은 null — 더한 것이 없다
    expect(T.trendOf(h, 'vc:vm2', 'gb').excludedOnlyDays).toBe(3);
    expect(T.trendOf(h, '', 'gb').excludedOnlyDays).toBe(0);
  });
  it('못 읽은 vCenter 가 둘 다 있으면(빠짐 · 직전 값) 한 문장으로 짧게', () => {
    const d = snapshotToolView({ vcenters: [{ id: 'va', name: 'VC-A', status: 'connected' }, { id: 'vb', name: 'VC-B', status: 'maintenance', maintenance: true },
      { id: 'vc', name: 'VC-C', status: 'unreachable' }], datastores: [], vms: [vm('va', 'a1'), vm('vb', 'b1')] }, { hygiene: HY, now: NOW });
    expect(T.unreadSumText(T.corpCards(d.items, d.corps), '')).toBe(' · 지금 값을 못 읽은 vCenter 2곳(1곳은 빠졌고 1곳은 직전 값으로 셌습니다)');
  });
  it('화면 — 모든 날에 빠진 vCenter 가 있으면 ‘아직 기록이 없습니다’ 가 아니다 · 뺀 날을 밝힌다', () => {
    const d = view({ id: 'vb', name: 'VC-B', status: 'connected' });
    const h1 = renderToStaticMarkup(<SnapshotTool initial={d} initialHist={hist(['va', 'vm2', 'vb'])} />);
    expect(h1).not.toMatch(/아직 기록이 없습니다/);
    expect(h1).toMatch(/기록한 날마다 값을 못 읽은 vCenter 가 있어 합을 그리지 않았습니다/);
    expect(h1).toMatch(/빠진 날 6일/);
    const h2 = renderToStaticMarkup(<SnapshotTool initial={d} initialHist={hist(['va', 'vm2'])} />);
    expect(h2).toMatch(/점검중 · 비활성 vCenter 를 빼고 더한 날 3일/);
  });
});
