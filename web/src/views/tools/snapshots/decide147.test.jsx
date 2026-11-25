// 147회차 — 143회차 결정 D1(138 결정) 권장안: 스냅샷 이력 추이에서 REST 수집 vCenter 를 ‘빠진 날’ 이 아니라 ‘뺀 vCenter’ 로.
//  서버 history.aggregateDays 가 'no-snap' 을 점검중 · 비활성처럼 그날 묶음에서 빼고(excluded) 그 가운데 수를 excludedRest 로 싣는다.
//  화면: 설명은 그 날들에 실제로 있던 사유만(점검중 · 비활성 / REST 수집 — 한 사유로 단정하지 않는다) · 빼고 더한 날은 그림 아래 띠(부분 합을 표시 없이 잇지 않는다) ·
//        뺀 vCenter 뿐이라 합이 없는 날도 설명한다(예전에는 처음 값이 있으면 말하지 않았다 — REST 날이 빠진 날에서 옮겨 오며 설명이 사라지지 않게).
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
const vm = (vc, name) => ({ id: `${vc}:${name}`, vcenterId: vc, name, powerState: 'POWERED_ON', cluster: 'C1', host: 'h1', snapshotCount: 1, snapshotSizeGB: 20, snapshotOldestTs: NOW - 20 * DAY });
const data = snapshotToolView({ vcenters: [{ id: 'va', name: 'VC-A', status: 'connected' }, { id: 'vr', name: 'VC-R', status: 'connected', collectSource: 'rest' },
  { id: 'vm2', name: 'VC-M', status: 'connected' }, { id: 'vs', name: 'VC-S', status: 'connected' }], datastores: [], vms: [vm('va', 'a1'), vm('vm2', 'm1'), vm('vs', 's1')] }, { hygiene: HY, now: NOW });

const days = Array.from({ length: 6 }, (_, i) => `2026-11-${String(10 + i).padStart(2, '0')}`);
const row = (day, id, status, gb) => ({ day, vcenter_id: id, status, vms: status === 'ok' ? 1 : null, snaps: status === 'ok' ? 1 : null, gb: status === 'ok' ? gb : null, gb_unknown: status === 'ok' ? 0 : null, over: 0 });
// va 10 GB 매일 · vr REST 처음부터 · vm2 30 GB 뒤 3일 점검중 · vs 5 GB SOAP ↔ REST 날마다
const rows = days.flatMap((d, i) => [row(d, 'va', 'ok', 10), row(d, 'vr', 'no-snap'), row(d, 'vm2', i >= 3 ? 'maintenance' : 'ok', 30), row(d, 'vs', i % 2 ? 'no-snap' : 'ok', 5)]);
const first = new Map(['va', 'vr', 'vm2', 'vs'].map((id) => [id, days[0]]));
const hist = (ids) => ({ ok: true, status: { available: true, recordHour: 3, retentionDays: 400, started: days[0] }, days,
  series: aggregateDays(days, rows, new Set(ids), first),
  byCorp: Object.fromEntries(ids.map((id) => [`vc:${id}`, aggregateDays(days, rows, new Set([id]), first)])), gaps: [], gone: [], ago7: null });
const trendPanel = (html) => { const i = html.indexOf('aria-label="추이와 신호"'); return html.slice(i, html.indexOf('</section>', i)); };
const exCount = (s) => (s.match(/class="ex"/g) || []).length;

describe('147 — 뺀 사유는 그 날들에 있던 것만(단정하지 않는다)', () => {
  it('REST 수집만 · 점검중만 · 둘 다 · 예전 서버 응답(excludedRest 없음)', () => {
    expect(T.trendOf(hist(['va', 'vr']), '', 'gb')).toMatchObject({ first: 10, last: 10, missingDays: 0, excludedDays: 6, excludedWhy: 'REST 수집' });
    expect(T.trendOf(hist(['va', 'vm2']), '', 'gb')).toMatchObject({ excludedDays: 3, excludedWhy: '점검중 · 비활성' });
    expect(T.trendOf(hist(['va', 'vr', 'vm2']), '', 'gb')).toMatchObject({ first: 40, last: 10, excludedDays: 6, excludedWhy: '점검중 · 비활성 · REST 수집' });
    const old = hist(['va', 'vm2']); old.series = old.series.map((p) => { const q = { ...p }; delete q.excludedRest; return q; });
    expect(T.trendOf(old, '', 'gb').excludedWhy).toBe('점검중 · 비활성');
    expect(T.excludedWhyText([{ excluded: 2, excludedRest: 1 }])).toBe('점검중 · 비활성 · REST 수집');
    expect(T.excludedWhyText([{ excluded: 0, excludedRest: 1 }])).toBe('');   // 이상한 값(뺀 수보다 큰 REST 수)은 뺀 수까지만
    expect(T.excludedWhyText([])).toBe('');
  });
  it('뺀 vCenter 뿐이라 합이 없는 날의 사유도 따로', () => {
    const t = T.trendOf(hist(['vr']), '', 'gb');
    expect([t.first, t.missingDays, t.excludedDays, t.excludedOnlyDays, t.excludedOnlyWhy]).toEqual([null, 0, 0, 6, 'REST 수집']);
    const s = T.trendOf(hist(['vs']), '', 'gb');   // SOAP ↔ REST 혼자 — REST 날은 합이 없다
    expect([s.first, s.excludedDays, s.excludedOnlyDays, s.excludedOnlyWhy]).toEqual([5, 0, 3, 'REST 수집']);
  });
  it('뺀 날의 위치 — 그림에 값이 있는 날만(SOAP ↔ REST 를 오가면 REST 날마다)', () => {
    const t = T.trendOf(hist(['va', 'vs']), '', 'gb');
    expect(t.values).toEqual([15, 10, 15, 10, 15, 10]);
    expect(t.excludedIdx).toEqual([1, 3, 5]);
    expect(T.trendOf(hist(['vs']), '', 'gb').excludedIdx).toEqual([]);   // 합이 없는 날은 띠가 아니라 빗금(선이 끊김)
    expect(T.excludedMarks([{ excluded: 1 }, { excluded: 0 }, null], [3, 4, null])).toEqual([0]);
    // 설명의 ‘빼고 더한 날 N일(아래 띠)’ 은 띠와 같은 날 — 크기를 못 읽은 VM 이 있는 날(크기 합 null · VM 수는 있음)은 크기 그림에 띠도 수도 없다
    const h = { series: [{ vms: 2, gb: null, gbUnknown: 1, missing: 0, excluded: 1, excludedRest: 1 }, { vms: 2, gb: 4, gbUnknown: 0, missing: 0, excluded: 1, excludedRest: 1 }] };
    expect([T.trendOf(h, '', 'gb').excludedDays, T.trendOf(h, '', 'gb').excludedIdx]).toEqual([1, [1]]);
    expect([T.trendOf(h, '', 'vms').excludedDays, T.trendOf(h, '', 'vms').excludedIdx]).toEqual([2, [0, 1]]);
  });
});

describe('147 — 화면', () => {
  it('REST 수집 vCenter 가 있어도 합을 그린다 · 사유를 밝히고 그날을 그림에 표시한다', () => {
    const html = renderToStaticMarkup(<SnapshotTool initial={data} initialHist={hist(['va', 'vr', 'vm2', 'vs'])} />);
    const p = trendPanel(html);
    expect(p).not.toMatch(/기록한 날마다 값을 못 읽은 vCenter 가 있어 합을 그리지 않았습니다/);   // 예전(D1): REST vCenter 하나가 매일 비웠다
    // 149회차: 처음 · 마지막이 일부 vCenter 를 뺀 합이면 그 값에 붙여 말한다(뺀 수가 달라 생긴 45 → 10 이 정리된 양처럼 읽히지 않게 — rebut149.test.jsx)
    expect(p).toMatch(/30일 중 처음 45 GB\(일부 vCenter 를 뺀 합\) → 마지막 10 GB\(일부 vCenter 를 뺀 합\)/);
    expect(p).toMatch(/점검중 · 비활성 · REST 수집 vCenter 를 빼고 더한 날 6일\(아래 띠\)/);
    expect(exCount(p)).toBe(6);
    // 법인 카드 그림 — REST 를 오가는 VC-S 줄은 합이 없는 날(빗금)이지 띠가 아니다 · 띠가 있는 카드가 없으면 머리말에 띠 설명을 싣지 않는다
    expect(html).not.toMatch(/아래 띠 = 일부 vCenter 를 빼고 더한 날/);
  });
  it('점검중만 뺀 날은 예전 문구 그대로(사유를 REST 로 넓히지 않는다)', () => {
    const p = trendPanel(renderToStaticMarkup(<SnapshotTool initial={data} initialHist={hist(['va', 'vm2'])} />));
    expect(p).toMatch(/점검중 · 비활성 vCenter 를 빼고 더한 날 3일\(아래 띠\)/);
    expect(p).not.toMatch(/REST/);
    expect(exCount(p)).toBe(3);
  });
  it('REST 수집 vCenter 뿐이면 그 사유로 합을 그리지 않았다고 말한다 · 처음 값이 있어도 합이 없는 날을 설명한다', () => {
    const p1 = trendPanel(renderToStaticMarkup(<SnapshotTool initial={data} initialHist={hist(['vr'])} />));
    expect(p1).toMatch(/REST 수집 vCenter 뿐이라 합을 그리지 않았습니다/);
    expect(p1).not.toMatch(/점검중/);
    const p2 = trendPanel(renderToStaticMarkup(<SnapshotTool initial={data} initialHist={hist(['vs'])} />));
    expect(p2).toMatch(/처음 5 GB → 마지막 5 GB/);
    expect(p2).toMatch(/REST 수집 vCenter 뿐이라 합이 없는 날 3일\(선이 끊김\)/);
  });
  it('법인 카드 그림에도 빼고 더한 날을 표시한다(법인 하나에 vCenter 가 여럿 — DataCenter 묶음)', () => {
    const h = hist(['va', 'vs']);
    h.byCorp = { 'vc:va': aggregateDays(days, rows, new Set(['va', 'vs']), first) };   // VC-A 법인 = va + vs
    const html = renderToStaticMarkup(<SnapshotTool initial={data} initialHist={h} />);
    const card = html.slice(html.indexOf('VC-A —'), html.indexOf('</button>', html.indexOf('VC-A —')));
    expect(exCount(card)).toBe(3);
    expect(html).toMatch(/빗금 = 빠진 날 · 아래 띠 = 일부 vCenter 를 빼고 더한 날/);
  });
});
