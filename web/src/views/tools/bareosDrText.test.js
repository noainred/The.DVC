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
    expect(T.drRows(jobs, 'vc-a', pts, null).find((r) => r.id === 'a').why).toMatch(/기준 시각을 고르세요/, '기준 시각이 비면 고르지 않는다(반증 R5 — 기본값 없음)');
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

describe('재해 복구 1차 — 반증 반영', () => {
  const now = Date.UTC(2026, 10, 4, 12, 0);
  it('R1 첫 재해 복구는 1대 — 그 법인 재해 복구 성공(7일 안)이 있으면 50대', () => {
    const jobs = [J('a', { restores: [{ dr: true, state: 'error', at: now - 1000 }] })];
    expect(T.drTrialOk(jobs, 'vc-a', now)).toBe(false);
    jobs[0].restores.push({ dr: true, state: 'ok', at: now - 5000, endedAt: now - 4000 });
    expect(T.drTrialOk(jobs, 'vc-a', now)).toBe(true);
    expect(T.drTrialOk(jobs, 'vc-b', now)).toBe(false);
    expect(T.drTrialOk(jobs, 'vc-a', now + T.DR_TRIAL_MS)).toBe(false);
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: `v${i}`, why: '' }));
    expect(T.drNextChunk(rows, new Set(rows.map((r) => r.id)), 1).length).toBe(1);
  });
  it('R3 최근 보낸 VM 은 끝났어도 다음 묶음에서 뺀다 · 실패 · 취소는 빼지 않는다(서버가 다시 판정)', () => {
    const job = J('a', { restores: [{ mode: 'newVm', target: { name: 'ADDC01' }, state: 'ok', at: now - 3600_000 }] });
    expect(T.drRecentlySent(job, 'addc01', now)).toBe(true);
    expect(T.drRecentlySent(J('b', { restores: [{ mode: 'newVm', target: { name: 'ADDC01' }, state: 'error', at: now - 1000 }] }), 'ADDC01', now)).toBe(false);
    expect(T.drRecentlySent(job, 'ADDC01', now + 25 * 3600_000)).toBe(false);
    const pts = new Map([['a', { ok: true, points: [P(20, now - 86_400_000, { at: { dc: 'D', folder: '/', vmName: 'ADDC01' } })] }]]);
    expect(T.drRows([job], 'vc-a', pts, now, () => '', now)[0].why).toMatch(/최근 보냄/);
  });
});

describe('재해 복구 2차 — 복구 순서(단계)', () => {
  const rows = ['a', 'b', 'c'].map((id) => ({ id, point: { jobid: 7 }, at: { dc: 'DC-OLD', folder: '/x', vmName: `VM-${id}` }, why: '' }));
  const map = { 'DC-OLD': { dc: 'DC-NEW', cluster: 'CL-1', datastore: '' } };
  it('단계 배정 · 보낼 모양 · 빈 단계는 화면이 먼저 막는다', () => {
    const waves = [T.drNewWave(0, 4), { ...T.drNewWave(1, 99), verify: true }];
    expect(waves.map((w) => [w.name, w.concurrency])).toEqual([['1단계', 4], ['2단계', T.DR_CHUNK]]);
    const assign = { b: 1, c: 7 };
    expect([T.drWaveOf(assign, 'a', 2), T.drWaveOf(assign, 'b', 2), T.drWaveOf(assign, 'c', 2)]).toEqual([0, 1, 0]);
    const rw = T.drRunWaves(waves, assign, rows, map);
    expect(rw[0].items.map((x) => x.id)).toEqual(['a', 'c']);
    expect(rw[1]).toEqual({ name: '2단계', concurrency: T.DR_CHUNK, verify: true, items: [{ id: 'b', jobid: 7, newVm: { name: 'VM-b', dc: 'DC-NEW', cluster: 'CL-1' } }] });
    expect(T.drWavesIssue(rw)).toBe('');
    expect(T.drWavesIssue(T.drRunWaves(waves, {}, rows, map))).toMatch(/2단계.*VM 이 없습니다/);
    expect(T.drWavesIssue([{ name: 'x', concurrency: 0, items: [{}] }])).toMatch(/1~50/);
    expect(T.drWavesIssue([])).toMatch(/1~10/);
    expect(T.drWavesIssue([{ name: 'x', concurrency: 1, items: Array.from({ length: T.DR_ITEMS_MAX + 1 }, () => ({})) }])).toMatch(/1000대/);
  });
  it('단계 지우기 — 그 VM 은 앞 단계로 · 뒤 단계 번호를 당긴다', () => {
    const waves = [T.drNewWave(0), T.drNewWave(1), T.drNewWave(2)];
    const r = T.drRemoveWave(waves, { a: 1, b: 2, c: 0 }, 1);
    expect([r.waves.length, r.assign]).toEqual([2, { a: 0, b: 1, c: 0 }]);
    expect(T.drRemoveWave(waves, { a: 0, b: 1 }, 0).assign).toEqual({ a: 0, b: 0 });
    expect(T.drRemoveWave([T.drNewWave(0)], { a: 0 }, 0).waves.length).toBe(1);
    expect(T.drRemoveWave([T.drNewWave(0), { ...T.drNewWave(1), name: 'DB' }, T.drNewWave(2)], {}, 0).waves.map((w) => w.name)).toEqual(['DB', '2단계'], '기본 이름만 새 자리에 맞춘다');
    expect([T.drWaveLabel({ name: '2단계' }, 1), T.drWaveLabel({ name: 'DB' }, 1), T.drWaveLabel({ name: ' ' }, 0)]).toEqual(['2단계', '2단계 · DB', '1단계']);
  });
  it('진행 카드 — 상태 줄 · 보일 회차 · 회차에 든 VM 은 고르기에서 막는다', () => {
    expect(T.drWaveCountsText({ total: 15, counts: { queued: 10, ok: 3, sent: 2 } })).toBe('성공 3 · 복원 중 2 · 대기 10 / 15대');
    expect(T.drWaveCountsText({})).toBe('— / —', '못 읽은 대수에 단위를 붙이지 않는다');
    const runs = [{ id: 'o', vcenterId: 'vc-a', state: 'done', at: 5 }, { id: 'p', vcenterId: 'vc-a', state: 'paused', at: 1 }, { id: 'q', vcenterId: 'vc-b', state: 'running', at: 9 }];
    expect(T.drCurrentRun(runs, 'vc-a').id).toBe('p');
    expect(T.drCurrentRun(runs.filter((r) => r.id !== 'p'), 'vc-a').id).toBe('o');
    expect(T.drCurrentRun(runs, 'vc-z')).toBe(null);
    const run = { state: 'running', waves: [{ items: [{ id: 'a', state: 'ok' }, { id: 'b', state: 'sent' }] }, { items: [{ id: 'c', state: 'queued' }] }] };
    expect([...T.drRunIds(run)].sort()).toEqual(['b', 'c']);
    expect(T.drRunIds({ ...run, state: 'stopped' }).size).toBe(0);
  });
});
