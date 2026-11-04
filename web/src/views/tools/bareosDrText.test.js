/**
 * 재해 복구 1차(시안 ② · 사용자 결정 '두 번에 나눠') — 화면 쪽 고르기 · 짝짓기 · 묶음(bareosDrText.js).
 *   서버가 같은 규칙을 다시 판정한다(drItemIssue · bulkRestorePlan) — 여기는 화면이 먼저 말하는 것과 보낼 모양.
 */
import { describe, it, expect } from 'vitest';
import * as T from './bareosDrText.js';
import { loadRestoreView, RESTORE_VIEWS } from './bareosRestoreTree.js';

const P = (jobid, startedAt, extra = {}) => ({ jobid, startedAt, chain: 2, level: 'I', ...extra });
const J = (id, extra = {}) => ({ id, vcenterId: 'vc-a', vmName: `vm-${id}`, dc: 'DC-OLD', folder: '/app', restores: [], writable: true, ...extra });

describe('재해 복구 1차 — 기준 시각 · 고르기', () => {
  it('기준 시각 이전에 시작한 마지막 지점(체인 있음) · 시작 시각을 모르면 고르지 않는다', () => {
    const before = T.drBeforeMs('2026-11-01T00:00');
    expect(before).toBe(new Date(2026, 10, 1, 0, 0).getTime());
    const pts = [P(30, new Date(2026, 10, 1, 2, 0).getTime()), P(20, new Date(2026, 9, 31, 22, 0).getTime()), P(10, new Date(2026, 9, 30, 22, 0).getTime()), P(25, null), P(22, new Date(2026, 9, 31, 23, 0).getTime(), { chain: null })];
    expect(T.drPickPoint(pts, before).jobid).toBe(20);
    expect(T.drPickPoint(pts, null)).toBe(null);
    expect(T.drPickPoint([P(5, '')], before)).toBe(null, "'' 을 0(아주 옛날)으로 보지 않는다");
    expect(T.drBeforeMs('2026-11-01')).toBe(null);
    expect(T.drBeforeText(before)).toBe('2026-11-01T00:00');
  });
  it('행 — 지점의 백업 때 위치(at) · 사유 · 이 vCenter 만', () => {
    const jobs = [J('a'), J('b'), J('c', { vcenterId: 'vc-b' }), J('d', { restores: [{ jobid: 9, state: 'running' }] })];
    const before = new Date(2026, 10, 1).getTime();
    const pts = new Map([
      ['a', { ok: true, points: [P(20, before - 1000, { at: { dc: 'DC-OLD', folder: '/A.MGMT/Infra', vmName: 'ADDC01' } })] }],
      ['b', { ok: true, points: [P(21, before + 1000)] }],
      ['d', { ok: true, points: [P(22, before - 1000)] }],
    ]);
    const rows = T.drRows(jobs, 'vc-a', pts, before, (j) => ((j.restores || []).length ? '복원 진행 중' : ''));
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b', 'd']);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect([by.a.why, by.a.at.vmName, by.a.path]).toEqual(['', 'ADDC01', 'DC-OLD › /A.MGMT/Infra']);
    expect(by.b.why).toMatch(/기준 시각 이전/);
    expect(by.d.why).toMatch(/진행 중/);
    expect(T.drRows(jobs, 'vc-a', null, before).every((r) => /읽기 전/.test(r.why))).toBe(true);
  });
});

describe('재해 복구 1차 — 짝짓기 · 묶음', () => {
  const targets = { dcs: ['DC-NEW'], clusters: [{ name: 'CL-1', dc: 'DC-NEW' }], datastores: [] };
  it('기본 짝 — 같은 이름 · 하나뿐인 데이터센터 · 하나뿐인 클러스터 · 사람이 고른 값은 덮지 않는다', () => {
    const src = [{ dc: 'DC-OLD', n: 3 }, { dc: 'DC-NEW', n: 1 }];
    const m = T.drDefaultMap(src, targets);
    expect(m['DC-OLD']).toEqual({ dc: 'DC-NEW', cluster: 'CL-1', datastore: '' });
    expect(m['DC-NEW'].dc).toBe('DC-NEW');
    const kept = T.drDefaultMap(src, targets, { 'DC-OLD': { dc: 'DC-NEW', cluster: '', datastore: 'ds-9' } });
    expect(kept['DC-OLD']).toEqual({ dc: 'DC-NEW', cluster: '', datastore: 'ds-9' });
    expect(T.drMapIssue(src, kept)).toMatch(/클러스터/);
    expect(T.drMapIssue(src, m)).toBe('');
    expect(T.drMapIssue([{ dc: 'X', n: 1 }], T.drDefaultMap([{ dc: 'X', n: 1 }], { dcs: ['A', 'B'], clusters: [] }))).toMatch(/데이터센터/);
  });
  it('보낼 항목 — 새 VM · 끊은 채 · 백업 때 이름 · 바뀐 데이터센터만 dc · 50대씩', () => {
    const row = { id: 'a', point: { jobid: 20 }, at: { dc: 'DC-OLD', folder: '/x', vmName: 'ADDC01' } };
    expect(T.drItem(row, { 'DC-OLD': { dc: 'DC-NEW', cluster: 'CL-1', datastore: '' } })).toEqual({ id: 'a', jobid: 20, mode: 'newVm', nic: 'disconnect', newVm: { name: 'ADDC01', dc: 'DC-NEW', cluster: 'CL-1' } });
    expect(T.drItem(row, { 'DC-OLD': { dc: 'DC-OLD', cluster: 'CL-1', datastore: 'ds-1' } }).newVm).toEqual({ name: 'ADDC01', cluster: 'CL-1', datastore: 'ds-1' });
    const rows = Array.from({ length: 120 }, (_, i) => ({ id: `v${i}`, why: i % 10 === 0 ? '없음' : '' }));
    const chunk = T.drNextChunk(rows, new Set(rows.map((r) => r.id)));
    expect(chunk.length).toBe(T.DR_CHUNK);
    expect(chunk.every((r) => !r.why)).toBe(true);
  });
  it('점검 — ✕ 만 막고 ? 는 막지 않는다 · 재해 복구 보기는 기억하지 않는다', () => {
    expect(T.drBlocking([{ state: 'ok' }, { state: 'unknown' }, { state: 'bad' }])).toBe(1);
    expect(RESTORE_VIEWS.map(([k]) => k)).toContain('dr');
    expect(loadRestoreView({ getItem: () => 'dr' })).toBe('list');
    expect(loadRestoreView({ getItem: () => 'table' })).toBe('table');
  });
});
