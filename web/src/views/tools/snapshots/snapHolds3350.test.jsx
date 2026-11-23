// v3.35.0 — 스냅샷 보류 탭(시안 ⑫ ⑬) · 400px 법인 카드 1열(⑮). 서버 holdRows 가 정한 지금 상태를 화면이 거르고 세기만 하는지 본다.
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

const { snapshotToolView, holdRows } = await import('../../../../../server/src/snaphist/view.js');
const role = { admin: true };
vi.mock('../../../api.js', async (orig) => ({ ...(await orig()), fetchJson: () => new Promise(() => {}), canCsv: () => true, toolAllowed: () => true, hasRole: () => role.admin }));
const T = await import('./snapText.js');
const { default: SnapshotTool } = await import('./SnapshotTool.jsx');
const { releaseHoldKeys } = await import('./HoldList.jsx');

const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const INV = {
  vcenters: [{ id: 'va', name: 'VC-A', status: 'connected' }, { id: 'vp', name: 'VC-P', status: 'pending' }], datastores: [],
  vms: [{ id: 'va:has', vcenterId: 'va', name: 'erp-app-02', snapshotCount: 3, snapshotSizeGB: 120, snapshotOldestTs: NOW - 41 * DAY },
    { id: 'va:none', vcenterId: 'va', name: 'db-ap-0133', snapshotCount: 0, snapshotSizeGB: 0 }],
};
const H = (vcenterId, vmId, vmName, days, by = 'kim.ops') => ({ vcenterId, vmId, vmName, until: NOW + days * DAY, reason: `사유-${vmName}`, by, at: NOW - DAY });
const HOLDS = [H('va', 'va:has', 'erp-app-02', 15), H('va', 'va:none', 'db-ap-0133', 4), H('va', 'va:gone', 'tmp-restore-eu-07', 12), H('vp', 'vp:x', 'mes-cn-011', 6)];
const rowsFor = (admin) => holdRows(INV, HOLDS, { now: NOW, registered: new Set(['va', 'vp']), admin });
const DATA = snapshotToolView(INV, { hygiene: { snapAgeDays: 7, snapCount: 3, snapSizeGB: 100, exceptions: [] }, now: NOW });
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const btn = (html, label) => (html.match(new RegExp(`>${label}</button>`, 'g')) || []).length;
const render = (holds) => renderToStaticMarkup(React.createElement(SnapshotTool, { initial: DATA, initialHist: { ok: false }, initialCreators: { ok: false }, initialHolds: holds, initialTab: 'hold' }));

describe('보류 — 거르기 · 세기(서버가 정한 상태 그대로)', () => {
  const rows = rowsFor(true);
  it('확인 못 함은 VM 없음 · 스냅샷 없음에 세지 않는다', () => {
    const s = T.holdSummary(rows, NOW);
    expect(s).toMatchObject({ n: 4, gone: 1, none: 1, unknown: 1, soon: 2, corps: 2 });
    expect(rows.find((r) => r.vmId === 'vp:x').state).toBe('unknown');
    expect(T.holdStateText(rows.find((r) => r.vmId === 'vp:x'))).toBe('확인 못 함 · 첫 수집 중');
    expect(T.holdStateText(rows.find((r) => r.vmId === 'va:has'))).toBe('스냅샷 3개 · 120 GB · 41일');
  });
  it('자리 글 — 법인 이름이 vCenter 이름과 같으면 한 번 · 사라진 VM 은 걸 때의 이름', () => {
    expect(T.holdPlaceText({ corpName: 'VC-A', vcName: 'VC-A', cluster: 'CL1', state: 'has' })).toBe('VC-A · CL1');
    expect(T.holdPlaceText({ corpName: 'Seoul 법인', vcName: 'VC-A', cluster: 'CL1', state: 'has' }, false)).toBe('Seoul 법인 · VC-A');
    expect(T.holdPlaceText({ corpName: 'VC-A', vcName: 'VC-A', state: 'gone', heldName: 'x' })).toBe('VC-A · 걸 때의 이름');
  });
  it('빠른 보기 · 남은 일수 · 기본 정렬(끝나는 날이 이른 것부터)', () => {
    expect(rows.filter((r) => T.holdMatch(r, 'soon', NOW)).map((r) => r.vmId).sort()).toEqual(['va:none', 'vp:x']);
    expect(T.holdLeftDays(rows.find((r) => r.vmId === 'va:has'), NOW)).toBe(15);
    expect(T.holdSort(rows).map((r) => r.vmId)).toEqual(['va:none', 'vp:x', 'va:gone', 'va:has']);
  });
});

describe('보류 탭 화면', () => {
  it('관리자 — 탭 수 · 요약 · 사라진 보류 안내 · 풀기(모든 줄) · 연장(스냅샷 있는 VM 만) · 건 사람', () => {
    role.admin = true;
    const raw = render({ ok: true, holds: rowsFor(true), unreadable: false, daysMax: 90, max: 2000, total: 4 });
    const h = text(raw);
    expect(btn(raw, '풀기')).toBe(4); expect(btn(raw, '연장…')).toBe(1);
    expect(raw).toMatch(/<th[^>]*>건 사람/);
    expect(h).toMatch(/보류 4/);
    expect(h).toMatch(/대상이 사라진 보류 1 VM 이 인벤토리에 없음/);
    expect(h).toMatch(/아래에서 바로 풀 수 있습니다/);
    expect(h).toMatch(/상한 2,000건\(전체 4건\)/);
    expect(h).toMatch(/kim\.ops/);
    expect(h).toMatch(/VM 없음/); expect(h).toMatch(/확인 못 함/);
    expect(h).not.toMatch(/`|\*\*/);
  });
  it('관리자가 아니면 — 풀기 · 연장 · 고르기 · 건 사람이 없다', () => {
    role.admin = false;
    const raw = render({ ok: true, holds: rowsFor(false), unreadable: false, daysMax: 90, max: 2000, total: null });
    const h = text(raw);
    expect(btn(raw, '풀기') + btn(raw, '연장…') + btn(raw, '고른 것 풀기')).toBe(0);
    expect(raw).not.toMatch(/<th[^>]*>건 사람/); expect(raw).not.toMatch(/보이는 보류 모두 고르기/);
    expect(h).toMatch(/관리자가 풀 수 있습니다/);
    expect(h).not.toMatch(/전체 \d+건/);
    role.admin = true;
  });
  it('보류 파일을 못 읽으면 — 목록은 보이고 풀기 · 연장은 잠근다', () => {
    const raw = render({ ok: true, holds: rowsFor(true), unreadable: true, daysMax: 90, max: 2000, total: 4 });
    expect(text(raw)).toMatch(/보류 목록 파일을 읽지 못했습니다/);
    expect(btn(raw, '풀기') + btn(raw, '연장…')).toBe(0);
    expect(text(raw)).toMatch(/tmp-restore-eu-07/);
  });
  it('보류 목록을 못 받으면 탭 수는 — 이고 0 이라 하지 않는다', () => {
    const h = text(render({ ok: false, error: '시간 초과' }));
    expect(h).toMatch(/보류 —/); expect(h).toMatch(/보류 목록을 받지 못했습니다\(시간 초과\)/);
  });
});

describe('풀기 요청', () => {
  it('키만 보내고 · 거절 본문은 사유를 던지고 · 성공은 푼 수를 말한다', async () => {
    const sent = [];
    const post = async (url, body) => { sent.push([url, body]); return { ok: true, released: 2 }; };
    const m = await releaseHoldKeys([{ vcenterId: 'va', vmId: 'va:gone', vmName: 'x', reason: 'y' }, { vcenterId: 'vp', vmId: 'vp:x' }], post);
    expect(m).toMatch(/^2건의 보류를 풀었습니다/);
    expect(sent[0][0]).toBe('/tools/snapshots/holds/release');
    expect(sent[0][1]).toEqual({ keys: [{ vcenterId: 'va', vmId: 'va:gone' }, { vcenterId: 'vp', vmId: 'vp:x' }] });
    await expect(releaseHoldKeys([{ vcenterId: 'va', vmId: 'a' }], async () => ({ ok: false, reason: '찾을 수 없는 보류가 1건 있어 아무것도 풀지 않았습니다' }))).rejects.toThrow(/아무것도 풀지 않았습니다/);
  });
});

describe('400px 법인 카드 1열(⑮)', () => {
  it('카드의 두 글자 줄에 자리 이름이 있고 · 720px 아래는 1열 + 글자가 접힌다', () => {
    const h = renderToStaticMarkup(React.createElement(SnapshotTool, { initial: DATA, initialHist: { ok: false }, initialCreators: { ok: false } }));
    expect(h).toMatch(/class="tx a"/); expect(h).toMatch(/class="tx f"/);
    const css = fs.readFileSync(new URL('./snapshots.css', import.meta.url), 'utf8');
    const narrow = css.slice(css.lastIndexOf('@media (max-width: 720px)'));
    expect(narrow).toMatch(/\.snp-cards \{ grid-template-columns: minmax\(0, 1fr\);/);
    expect(narrow).not.toMatch(/\.snp-cards \{ grid-template-columns: repeat\(2/);
    expect(narrow).toMatch(/\.snp-cc \.cn span, \.snp-cc \.tx \{ white-space: normal;/);
  });
});
