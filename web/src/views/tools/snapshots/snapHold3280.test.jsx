// v3.28.0 — 스냅샷 화면 3단계: 만든 계정(관리자 판본만 이름) · ‘만든 계정’ 묶음 · 보류 표지 · 보류 단추(관리자).
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const { snapshotToolView } = await import('../../../../../server/src/snaphist/view.js');
const role = { admin: true };
vi.mock('../../../api.js', async (orig) => ({ ...(await orig()), fetchJson: () => new Promise(() => {}), canCsv: () => true, toolAllowed: () => true, hasRole: () => role.admin }));
const T = await import('./snapText.js');
const { default: SnapshotTool, creatorText } = await import('./SnapshotTool.jsx');

const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const HY = { snapAgeDays: 7, snapCount: 3, snapSizeGB: 100, exceptions: [] };
Object.defineProperty(HY, 'holds', { value: new Map([['va\nva:held', { until: NOW + 10 * DAY, reason: '이관 중' }]]), enumerable: false });
const vm = (vc, name, o = {}) => ({ id: `${vc}:${name}`, vcenterId: vc, name, powerState: 'POWERED_ON', cluster: 'C1', host: 'h1', snapshotCount: 1, snapshotSizeGB: 10, snapshotOldestTs: NOW - 20 * DAY, ...o });
const DATA = snapshotToolView({ vcenters: [{ id: 'va', name: 'VC-A' }, { id: 'vs', name: 'VC-S', collectSource: 'site' }], datastores: [],
  vms: [vm('va', 'web'), vm('va', 'held'), vm('vs', 'far')] }, { hygiene: HY, now: NOW });
const CR_ADMIN = { ok: true, byVm: { 'va\nva:web': { user: 'kim.ops', ts: NOW - 3 * DAY } }, vcenters: { va: 'ok', vs: 'site' } };
const CR_MASKED = { ok: true, byVm: { 'va\nva:web': { user: null, ts: NOW - 3 * DAY } }, vcenters: { va: 'ok', vs: 'site' }, userMasked: true };
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('만든 계정', () => {
  it('관리자 판본 · 숨김 · 위임 법인 · 기록 없음', () => {
    const it = (n) => DATA.items.find((x) => x.name === n);
    expect(creatorText(CR_ADMIN, it('web'))).toMatch(/최근 만든 계정 kim\.ops/);
    expect(creatorText(CR_MASKED, it('web'))).toMatch(/관리자만 볼 수 있습니다/);
    expect(creatorText(CR_ADMIN, it('far'))).toMatch(/위임 법인/);
    expect(creatorText(CR_ADMIN, it('held'))).toMatch(/31일 안 기록 없음/);
  });
  it('정리 요청 글에 계정 · 묶어 보기 ‘만든 계정’', () => {
    const whoOf = (x) => CR_ADMIN.byVm[`${x.vcenterId}\n${x.id}`]?.user || null;
    expect(T.requestText('A', DATA.items, DATA.thresholds, { whoOf })).toMatch(/만든 계정 kim\.ops/);
    expect(T.groupItems(DATA.items, 'who', null, whoOf).map((g) => g.label).sort()).toEqual(['kim.ops', '만든 계정 모름']);
  });
  it('계정이 가려진 판본에는 ‘만든 계정’ 묶음 단추가 없다', () => {
    role.admin = false;
    const h = text(renderToStaticMarkup(React.createElement(SnapshotTool, { initial: DATA, initialHist: { ok: false }, initialCreators: CR_MASKED })));
    expect(h).not.toMatch(/ 만든 계정 법인|묶어 보기 법인 클러스터 나이 구간 만든 계정/);
    const h2 = text(renderToStaticMarkup(React.createElement(SnapshotTool, { initial: DATA, initialHist: { ok: false }, initialCreators: CR_ADMIN })));
    expect(h2).toMatch(/묶어 보기 법인 클러스터 나이 구간 만든 계정 묶지 않음/);
    role.admin = true;
  });
});

describe('보류', () => {
  it('보류한 VM 은 판정 안 함 · 표지에 기한', () => {
    const held = DATA.items.find((x) => x.name === 'held');
    expect(held.skip).toBe('hold'); expect(held.judged).toBe(false);
    expect(T.matchKey(held, 'old')).toBe(false); expect(T.matchKey(held, 'skip')).toBe(true);
    const h = text(renderToStaticMarkup(React.createElement(SnapshotTool, { initial: DATA, initialHist: { ok: false }, initialCreators: CR_ADMIN })));
    expect(h).toMatch(/보류 ~\d\d-\d\d/);
  });
});
