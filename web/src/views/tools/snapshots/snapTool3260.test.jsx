// v3.26.0 — 특수 기능 ‘스냅샷 있는 VM’ 새 화면(시안 docs/design/snapshots). 입력은 서버 snaphist/view.js 가 만든 실제 응답 모양.
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const { snapshotToolView } = await import('../../../../../server/src/snaphist/view.js');
vi.mock('../../../api.js', async (orig) => ({ ...(await orig()), fetchJson: () => new Promise(() => {}), canCsv: () => true, toolAllowed: () => true }));
const T = await import('./snapText.js');
const { default: SnapshotTool } = await import('./SnapshotTool.jsx');

const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const HY = { snapAgeDays: 7, snapCount: 3, snapSizeGB: 100, uptimeDays: 365, exceptions: ['keep'], notify: { enabled: true, hour: 9 } };
const vm = (vc, name, o = {}) => ({ id: `${vc}:${name}`, vcenterId: vc, name, powerState: 'POWERED_ON', template: false, cluster: 'C1', host: 'h1', ...o });
const VMS = [
  vm('va', 'old-big', { snapshotCount: 2, snapshotSizeGB: 300, snapshotOldestTs: NOW - 200 * DAY, snapshotTree: [{ d: 0, name: 'first', ts: NOW - 200 * DAY, state: 'poweredOn' }, { d: 1, name: 'second', ts: NOW - 2 * DAY, current: true, desc: '패치 전' }] }),
  vm('va', 'mid', { snapshotCount: 1, snapshotSizeGB: 10, snapshotOldestTs: NOW - 40 * DAY }),
  vm('va', 'fresh', { snapshotCount: 1, snapshotSizeGB: 2, snapshotOldestTs: NOW - DAY, powerState: 'POWERED_OFF' }),
  vm('vb', 'size-unknown', { snapshotCount: 1, snapshotSizeGB: 0, snapshotOldestTs: NOW - 10 * DAY }),
  vm('vb', 'keep-this', { snapshotCount: 1, snapshotSizeGB: 50, snapshotOldestTs: NOW - 99 * DAY }),
];
const DATA = snapshotToolView({ vcenters: [{ id: 'va', name: 'VC-A' }, { id: 'vb', name: 'VC-B' }], vms: VMS, datastores: [] }, { hygiene: HY, now: NOW });
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('snapText — 거르기 · 정렬 · 묶기 · 세기', () => {
  it('빠른 보기와 신호 — 서버 sig 그대로', () => {
    const n = (k) => DATA.items.filter((x) => T.matchKey(x, k)).length;
    expect(n('old')).toBe(3);   // old-big · mid · size-unknown (keep-this 는 예외)
    expect(n('first')).toBe(1); // old-big(크기 100 GB 넘음)
    expect(n('skip')).toBe(1);
    expect(n('off')).toBe(1);
    expect(n('mem')).toBe(1);
  });
  it('정렬 — 못 읽은 값은 방향과 무관하게 뒤', () => {
    expect(T.sortItems(DATA.items, 'gb', 'desc').map((x) => x.name).at(-1)).toBe('size-unknown');
    expect(T.sortItems(DATA.items, 'gb', 'asc').map((x) => x.name).at(-1)).toBe('size-unknown');
    expect(T.sortItems(DATA.items, 'days', 'desc')[0].name).toBe('old-big');
  });
  it('합 — 못 읽은 크기는 빼고 수를 따로', () => {
    expect(T.gbSum(DATA.items)).toEqual({ gb: 362, unknown: 1 });
    const s = T.summaryOf(DATA.items);
    expect(s.over).toBe(3); expect(s.skip).toBe(1); expect(s.gbUnknown).toBe(1); expect(s.overGbUnknown).toBe(1);
  });
  it('묶기 — 법인 순서는 기준 넘긴 수 많은 순 · 나이 구간은 오래된 구간부터', () => {
    expect(T.groupItems(DATA.items, 'corp').map((g) => g.label)).toEqual(['VC-A', 'VC-B']);
    expect(T.groupItems(DATA.items, 'band', T.bandLabels(DATA.thresholds)).map((g) => g.key)).toEqual(['d90', 'd30', 'd7', 'new', 'skip']);
    expect(T.groupItems(DATA.items, 'none')).toHaveLength(1);
  });
  it('정리 요청 글 — 사내 기준 넘긴 VM 만 · 못 읽은 크기 표시', () => {
    const t = T.requestText('VC-B', DATA.items.filter((x) => x.vcenterId === 'vb'), DATA.thresholds);
    expect(t.split('\n')[0]).toMatch(/\[VC-B\] 스냅샷 정리 요청 — 사내 기준 7일을 넘긴 VM 1대 · 약 0 GB\(크기 못 읽음 1대 제외\)/);
    expect(t).not.toMatch(/keep-this/);
  });
  it('주소 — 쉼표 · 빗금 id 를 지키고, 모르는 보기는 null', () => {
    const h = T.buildSnapHash('old', ['KR,Seoul', 'a/b']);
    expect(h).toBe('#/tools/snapshots/old/KR%2CSeoul,a%2Fb');
    expect(T.parseSnapHash(h)).toEqual({ view: 'old', vcIds: ['KR,Seoul', 'a/b'] });
    expect(T.parseSnapHash('#/tools/snapshots/zzz')).toEqual({ view: null, vcIds: [] });
    expect(T.parseSnapHash('#/tools/other/old')).toEqual({ view: null, vcIds: [] });
    expect(T.buildSnapHash('nope')).toBe('#/tools/snapshots/all');
  });
  it('CSV 줄 — 못 읽은 값은 빈칸(0 이 아니다)', () => {
    const r = T.csvRow(DATA.items.find((x) => x.name === 'size-unknown'));
    expect(r[6]).toBe(''); expect(r).toHaveLength(T.CSV_HEAD.length);
  });
  it('나이 구간 이름은 응답의 기준값으로', () => {
    expect(T.bandLabels({ snapAgeDays: 3, ageEdgesDays: [30, 90] }).new).toBe('3일 미만');
  });
});

describe('SnapshotTool 렌더', () => {
  const html = renderToStaticMarkup(React.createElement(SnapshotTool, { initial: DATA, initialHist: { ok: true, status: { available: true, started: '2026-11-19', recordHour: 3, retentionDays: 400 } } }));
  const t = text(html);
  it('구역 순서 — 기준 · 요약 · 법인별 · 그림 · 신호 · 표', () => {
    let at = -1;
    for (const w of ['사내 기준', 'VMware 권고', '스냅샷 이력 DB', '스냅샷이 있는 VM', '법인별', '어느 것부터 볼까', '신호', '빠른 보기', '묶어 보기']) {
      const i = t.indexOf(w, at + 1); expect(i, w).toBeGreaterThan(at); at = i;
    }
  });
  it('요약 숫자 · 못 읽은 크기는 따로', () => {
    expect(t).toMatch(/스냅샷이 있는 VM 5 /);
    expect(t).toMatch(/크기 못 읽음 1대는 합에 없음/);
    expect(t).toMatch(/시작 2026-11-19/);
  });
  it('법인 묶음 머리줄 + 정리 요청 단추 · 표 제목은 클릭 정렬(aria-sort)', () => {
    expect(t).toMatch(/VC-A 3대 · 기준 넘김 2대/);
    expect((html.match(/정리 요청 보기/g) || []).length).toBe(2);
    expect((html.match(/aria-sort=/g) || []).length).toBe(7);
  });
  it('점 — 크기를 못 읽은 VM 은 그림에 없고 그 수를 말한다', () => {
    expect((html.match(/class="snp-dot/g) || []).length).toBe(4);
    expect(t).toMatch(/그림에 없는 VM 1대/);
  });
  it('7일 변화 신호는 이 판에 없다(이력이 쌓인 뒤)', () => {
    expect(t).not.toMatch(/7일 사이 10 GB/);
  });
});
