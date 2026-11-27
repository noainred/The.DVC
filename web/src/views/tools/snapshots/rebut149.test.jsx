// 149회차 — 147회차(143 결정 D1: REST 수집 vCenter 를 추이에서 ‘뺀 vCenter’ 로) 반증. 입력은 실제 서버 history.aggregateDays 출력.
//  D149-1: REST 수집 vCenter 뿐인 법인 줄(그림은 전부 빗금)에 빠진 날이 하루라도 있으면(오늘 기록 전 포함 — 기본 0~3시) 설명이
//          ‘기록한 날마다 값을 못 읽은 vCenter 가 있어 …’ · ‘빠진 날 1일’ 뿐 — REST 로 뺀 나머지 날을 말하지 않았다(Chromium 재현 — 30칸 빗금에 ‘빠진 날 1일’).
//  D149-2: ‘처음 → 마지막’ 이 일부 vCenter 를 뺀 합(띠가 있는 날)이어도 표시 없이 견줬다 — 마지막 날만 REST 면 ‘처음 100 GB → 마지막 10 GB’(정리된 90 GB 처럼 읽힌다).
//  D149-3: 크기를 못 읽은 VM 이 있는 날(크기 합 null — 빗금)은 설명이 없었고, 모든 날이 그러면 ‘아직 기록이 없습니다’ 였다(147 N147-2 가 그날을 ‘빼고 더한 날’ 수에서 빼며 설명이 사라졌다).
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
const vm = (vc, name) => ({ id: `${vc}:${name}`, vcenterId: vc, name, powerState: 'POWERED_ON', cluster: 'C1', host: 'h1', snapshotCount: 1, snapshotSizeGB: 20, snapshotOldestTs: NOW - 20 * DAY });
const data = snapshotToolView({ vcenters: [{ id: 'va', name: 'VC-A', status: 'connected' }, { id: 'vr', name: 'VC-R', status: 'connected', collectSource: 'rest' },
  { id: 'vs', name: 'VC-S', status: 'connected' }], datastores: [], vms: [vm('va', 'a1'), vm('vs', 's1')] }, { hygiene: HY, now: NOW });

const days = Array.from({ length: 6 }, (_, i) => `2026-11-${String(10 + i).padStart(2, '0')}`);
const row = (day, id, status, gb, gbu = 0) => ({ day, vcenter_id: id, status, vms: status === 'ok' ? 1 : null, snaps: status === 'ok' ? 1 : null,
  gb: status === 'ok' ? gb : null, gb_unknown: status === 'ok' ? gbu : null, over: 0 });
const histOf = (rows, ids) => {
  const first = new Map(ids.map((id) => [id, days[0]]));
  return { ok: true, status: { available: true, recordHour: 3, retentionDays: 400, started: days[0] }, days,
    series: aggregateDays(days, rows, new Set(ids), first), byCorp: {}, gaps: [], gone: [], ago7: null };
};
const panel = (hist) => { const html = renderToStaticMarkup(<SnapshotTool initial={data} initialHist={hist} />); const i = html.indexOf('aria-label="추이와 신호"'); return html.slice(i, html.indexOf('</section>', i)); };
const cap = (hist, metric = 'gb', valueText = (v) => (v == null ? '—' : `${v} GB`)) => T.trendCaption(T.trendOf(hist, '', metric), 30, valueText);

describe('D149-1 — 합이 없을 때 사유가 둘 이상이면 한 사유로 단정하지 않고 수를 나눠 적는다', () => {
  // vr 하나 — REST 수집 5일 + 오늘은 아직 기록 전(행 없음 — 빠진 날)
  const rows = days.slice(0, 5).map((d) => row(d, 'vr', 'no-snap'));
  it('REST 수집 vCenter 뿐인 날 5일 + 빠진 날 1일', () => {
    const h = histOf(rows, ['vr']);
    expect(h.series.map((p) => [p.missing, p.excluded])).toEqual([[0, 1], [0, 1], [0, 1], [0, 1], [0, 1], [1, 0]]);
    const [head, tail] = cap(h);
    expect(head).not.toMatch(/기록한 날마다/);   // 예전: 다섯 날은 못 읽은 날이 아니라 REST 로 뺀 날이다
    expect(head).toBe('합을 그린 날이 없습니다 — 사유는 아래와 같습니다');
    expect(tail).toBe('빠진 날 1일(선이 끊김) · REST 수집 vCenter 뿐이라 합이 없는 날 5일(선이 끊김)');   // 예전: ‘빠진 날 1일(선이 끊김)’ 만
    const p = panel(h);
    expect(p).toMatch(/REST 수집 vCenter 뿐이라 합이 없는 날 5일/);
  });
  it('사유가 하나뿐이면 예전 문구 그대로(143 · 147 판)', () => {
    expect(cap(histOf(days.map((d) => row(d, 'vr', 'no-snap')), ['vr']))).toEqual(['REST 수집 vCenter 뿐이라 합을 그리지 않았습니다', '']);
    expect(cap(histOf(days.map((d) => row(d, 'vr', 'unreachable')), ['vr']))).toEqual(['기록한 날마다 값을 못 읽은 vCenter 가 있어 합을 그리지 않았습니다', '빠진 날 6일(선이 끊김)']);
    expect(cap({ series: days.map((day) => ({ day, vms: null, gb: null, missing: 0, excluded: 0 })) })).toEqual(['아직 기록이 없습니다', '']);
  });
});

describe('D149-2 — 처음 · 마지막이 일부 vCenter 를 뺀 합이면 그 값에 붙여 말한다', () => {
  it('마지막 날만 REST(부분 합) — 표시 없이 ‘처음 100 GB → 마지막 10 GB’ 로 견주지 않는다', () => {
    const h = histOf(days.flatMap((d, i) => [row(d, 'va', 'ok', 10), row(d, 'vs', i === 5 ? 'no-snap' : 'ok', 90)]), ['va', 'vs']);
    const t = T.trendOf(h, '', 'gb');
    expect([t.first, t.last, t.firstEx, t.lastEx]).toEqual([100, 10, false, true]);
    expect(cap(h)).toEqual(['30일 중 처음 100 GB → 마지막 10 GB(일부 vCenter 를 뺀 합)', 'REST 수집 vCenter 를 빼고 더한 날 1일(아래 띠)']);
    expect(panel(h)).toMatch(/30일 중 처음 100 GB → 마지막 10 GB\(일부 vCenter 를 뺀 합\)/);
  });
  it('처음 날만 뺀 합 · 뺀 날이 없으면 표시 없음(예전 그대로)', () => {
    const h = histOf(days.flatMap((d, i) => [row(d, 'va', 'ok', 10), row(d, 'vs', i === 0 ? 'no-snap' : 'ok', 90)]), ['va', 'vs']);
    expect(cap(h)[0]).toBe('30일 중 처음 10 GB(일부 vCenter 를 뺀 합) → 마지막 100 GB');
    const ok = histOf(days.flatMap((d) => [row(d, 'va', 'ok', 10), row(d, 'vs', 'ok', 90)]), ['va', 'vs']);
    expect(cap(ok)).toEqual(['30일 중 처음 100 GB → 마지막 100 GB', '']);
  });
  it('크기를 못 읽어 처음 · 마지막에 쓰지 않은 날은 띠 판정에 들지 않는다(값이 있는 날로 고른다)', () => {
    // 마지막 날: REST 로 뺐지만 크기도 못 읽음(크기 합 null) → 크기 그림의 마지막 값은 그 전날(전체 합)
    const h = histOf(days.flatMap((d, i) => [row(d, 'va', 'ok', 10, i === 5 ? 1 : 0), row(d, 'vs', i === 5 ? 'no-snap' : 'ok', 90)]), ['va', 'vs']);
    const t = T.trendOf(h, '', 'gb');
    expect([t.last, t.lastEx, t.unknownDays]).toEqual([100, false, 1]);
    expect(T.trendOf(h, '', 'vms').lastEx).toBe(true);   // VM 수 그림의 마지막 값은 그날(REST 를 뺀 합)
  });
  it('오늘이 아직 기록 전(빠진 날)이면 마지막 값은 어제 — 어제가 뺀 합이면 표시', () => {
    const rows = days.slice(0, 5).flatMap((d, i) => [row(d, 'va', 'ok', 10), row(d, 'vs', i === 4 ? 'no-snap' : 'ok', 90)]);
    const t = T.trendOf(histOf(rows, ['va', 'vs']), '', 'gb');
    expect([t.last, t.lastEx, t.missingDays]).toEqual([10, true, 1]);
    expect(cap(histOf(rows, ['va', 'vs']))[0]).toBe('30일 중 처음 100 GB → 마지막 10 GB(일부 vCenter 를 뺀 합)');
  });
});

describe('D149-3 — 크기를 못 읽은 VM 이 있는 날(크기 합 null)을 설명한다', () => {
  it('하루 — 빗금의 사유와 수 · VM 수 그림에는 해당 없음', () => {
    const h = histOf(days.map((d, i) => row(d, 'va', 'ok', 10, i === 2 ? 1 : 0)), ['va']);
    expect(cap(h)).toEqual(['30일 중 처음 10 GB → 마지막 10 GB', '크기를 못 읽은 VM 이 있어 크기 합이 없는 날 1일(선이 끊김)']);
    expect(T.trendOf(h, '', 'vms').unknownDays).toBe(0);
    expect(cap(h, 'vms')[1]).toBe('');
  });
  it('모든 날 — ‘아직 기록이 없습니다’ 가 아니다', () => {
    const h = histOf(days.map((d) => row(d, 'va', 'ok', 10, 1)), ['va']);
    expect(cap(h)).toEqual(['크기를 못 읽은 VM 이 있어 크기 합을 그리지 않았습니다', '']);
    expect(panel(h)).not.toMatch(/아직 기록이 없습니다/);
  });
});
