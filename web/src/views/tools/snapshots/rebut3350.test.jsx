// 반증 r3350(v3.35.0 보류 목록 4c7d5880) — 쓰기 범위 밖 보류(서버 holdRows writable:false)는 풀기 · 고르기를 잠근다.
//   예전에는 쓰기를 줄인 관리자에게도 모든 줄에 풀기 · 고르기를 열어, ‘보이는 보류 모두 고르기 → 고른 것 풀기’ 가 매번 403(아무것도 풀지 않음)이었다.
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const { holdRows } = await import('../../../../../server/src/snaphist/view.js');
const { default: HoldList } = await import('./HoldList.jsx');

const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const INV = {
  vcenters: [{ id: 'v1', name: 'VC-1', status: 'connected' }, { id: 'v2', name: 'VC-2', status: 'connected' }], datastores: [],
  vms: [{ id: 'v1:a', vcenterId: 'v1', name: 'erp-app-02', snapshotCount: 1, snapshotSizeGB: 5, snapshotOldestTs: NOW - DAY },
    { id: 'v2:b', vcenterId: 'v2', name: 'web-eu-0205', snapshotCount: 1, snapshotSizeGB: 5, snapshotOldestTs: NOW - DAY }],
};
const H = (vcenterId, vmId, vmName) => ({ vcenterId, vmId, vmName, until: NOW + 20 * DAY, reason: 'r', by: 'kim.ops', at: NOW - DAY });
const HOLDS = [H('v1', 'v1:a', 'erp-app-02'), H('v2', 'v2:b', 'web-eu-0205'), H('v2', 'v2:gone', 'old-eu-01')];
const btn = (html, label) => (html.match(new RegExp(`>${label}</button>`, 'g')) || []).length;
const render = (rows) => renderToStaticMarkup(React.createElement(HoldList, { rows, isAdmin: true, now: NOW, ExtendForm: () => null }));

describe('쓰기 범위 밖 보류', () => {
  it('writable:false 줄에는 풀기 · 연장 · 고르기가 없고 ‘쓰기 범위 밖’ 이라 적는다', () => {
    const rows = holdRows(INV, HOLDS, { now: NOW, writable: new Set(['v1']), registered: new Set(['v1', 'v2']), admin: true });
    expect(rows.map((r) => r.writable)).toEqual([true, false, false]);
    const raw = render(rows);
    expect(btn(raw, '풀기')).toBe(1); expect(btn(raw, '연장…')).toBe(1);
    expect(raw).toMatch(/aria-label="erp-app-02 고르기"/);
    expect(raw).not.toMatch(/aria-label="web-eu-0205 고르기"/); expect(raw).not.toMatch(/aria-label="old-eu-01 고르기"/);
    expect((raw.match(/쓰기 범위 밖/g) || []).length).toBe(2);
  });
  it('쓰기 범위 제한이 없으면 예전 그대로 — 모든 줄에 풀기 · 고르기', () => {
    const raw = render(holdRows(INV, HOLDS, { now: NOW, registered: new Set(['v1', 'v2']), admin: true }));
    expect(btn(raw, '풀기')).toBe(3);
    expect((raw.match(/ 고르기"/g) || []).length).toBe(4);   // 줄 3 + 머리 ‘보이는 보류 모두 고르기’
    expect(raw).not.toMatch(/쓰기 범위 밖/);
  });
});
