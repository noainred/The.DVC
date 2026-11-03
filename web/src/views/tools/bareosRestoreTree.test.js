import { describe, it, expect } from 'vitest';
import * as T from './bareosRestoreTree.js';

const J = (id, vmName, folder, o = {}) => ({ id, vmName, folder, dc: 'NJ-DC', vcenterId: 'vc-nj', directorId: 'D1', writable: true, restores: [], storageGB: 100, powerState: 'POWERED_ON', lastRun: { state: 'ok', level: 'I' }, lastOk: { at: Date.parse('2026-11-03T04:00:00') }, ...o });
const F = (folder, vms, o = {}) => ({ vcenterId: 'vc-nj', dc: 'NJ-DC', folder, vms, ...o });

describe('v2.866 복원 › 폴더 표', () => {
  const jobs = [
    J('a', 'ADMCON01', '/A.MGMT/Admin_Console'),
    J('b', 'GLUE01', '/B.Service/GLUE', { storageGB: null }),
    J('c', 'GLUE02', '/B.Service/GLUE', { restores: [{ jobid: 9, state: 'running' }] }),
    J('x', 'OTHER01', '/X', { vcenterId: 'vc-pl', directorId: 'D2', dc: 'PL-DC' }),
  ];
  const folders = [F('/A.MGMT/Admin_Console', 4), F('/A.MGMT/00.Console', 51), F('/B.Service/GLUE', 7), F('/', 3), F('/Z', 9, { vcenterId: 'vc-none' })];

  it('트리 — vCenter › 폴더 › VM · 데이터센터가 하나면 그 단계를 접는다 · 대상이 없는 vCenter 는 그리지 않는다', () => {
    const rows = T.restoreFolderRows(jobs, folders, { vcNames: { 'vc-nj': 'vcenter-nj-01', 'vc-pl': 'vcenter-pl-01' }, dirNames: { D1: 'NJ Bareos' } });
    expect(rows.map((r) => `${r.depth}:${r.kind}:${r.label}`)).toEqual([
      '0:vc:vcenter-nj-01', '1:folder:A.MGMT', '2:folder:Admin_Console', '3:vm:ADMCON01',
      '1:folder:B.Service', '2:folder:GLUE', '3:vm:GLUE01', '3:vm:GLUE02',
      '0:vc:vcenter-pl-01', '1:folder:X', '2:vm:OTHER01',
    ]);
    const vc = rows[0];
    expect([vc.dc, vc.director]).toEqual(['NJ-DC', 'NJ Bareos']);
    expect([vc.targets, vc.total]).toEqual([3, 4 + 51 + 7 + 3]);
    expect(T.targetsText(rows[1])).toBe('1/55');
    expect(T.targetsPct(rows[1])).toBe(2);
  });

  it('고를 수 있는 id — 진행 중 복원 · 다른 법인은 빠진다(지금 복원과 같은 pickBlock)', () => {
    const rows = T.restoreFolderRows(jobs, folders, { lockedDir: 'D1' });
    expect(rows.find((r) => r.label === 'GLUE').ids).toEqual(['b']);
    expect(rows.find((r) => r.label === 'GLUE02').why).toBe('복원 진행 중');
    expect(rows.find((r) => r.label === 'OTHER01').why).toMatch(/다른 법인/);
    expect(rows.find((r) => r.kind === 'vc' && r.label === 'vc-nj').ids).toEqual(['a', 'b']);
    expect(rows.find((r) => r.label === 'GLUE').openRestores).toBe(1);
  });

  it('v2.869 감사 A4-03 — 인벤토리에 VM 이 없는 vCenter 는 그 법인만 전체 모름(3/0 이 아니다)', () => {
    const rows = T.restoreFolderRows(jobs, [F('/B.Service/GLUE', 5)]);
    const pl = rows.find((r) => r.kind === 'vc' && r.label === 'vc-pl');
    expect(pl.total).toBe(null);
    expect(T.targetsText(pl)).toBe('1/—');
    expect(rows.find((r) => r.label === 'GLUE').total).toBe(5);   // 수를 아는 법인은 그대로
  });

  it('폴더 수를 못 읽으면 전체는 null(0 이 아니다) · 용량을 모르는 VM 은 부분 합 표시', () => {
    const rows = T.restoreFolderRows(jobs, null);
    const g = rows.find((r) => r.label === 'GLUE');
    expect(g.total).toBe(null);
    expect(T.targetsText(g)).toBe('2/—');
    expect(T.targetsPct(g)).toBe(null);
    expect([g.sizeGB, g.sizeUnknown]).toEqual([100, 1]);
    expect(T.sizeText(g.sizeGB, g.sizeUnknown)).toBe('100 GB+');
  });

  it('대상이 없는 폴더는 기본으로 숨기고, 끄면 보인다 · 접은 행의 아래는 그리지 않는다 · 찾기는 모두 펼친다', () => {
    const on = T.restoreFolderRows(jobs, folders, {});
    expect(on.some((r) => r.label === '00.Console')).toBe(false);
    const off = T.restoreFolderRows(jobs, folders, { onlyTargets: false });
    const c = off.find((r) => r.label === '00.Console');
    expect([c.targets, c.total, c.ids.length]).toEqual([0, 51, 0]);
    const closed = T.restoreFolderRows(jobs, folders, { open: new Set(['vc:vc-nj']) });
    expect(closed.map((r) => r.label)).toEqual(['vc-nj', 'A.MGMT', 'B.Service', 'vc-pl']);
    const found = T.restoreFolderRows(jobs, folders, { q: 'glue02', open: new Set() });
    expect(found.map((r) => r.label)).toEqual(['vc-nj', 'B.Service', 'GLUE', 'GLUE02']);
    expect(found[0].total).toBe(null);   // 찾기 중에는 폴더 전체 수를 섞지 않는다(걸러진 대상과 맞지 않는다)
  });

  it('데이터센터가 둘 이상이면 데이터센터 단계를 둔다', () => {
    const rows = T.restoreFolderRows([J('a', 'A1', '/F'), J('b', 'B1', '/F', { dc: 'DC2' })], null);
    expect(rows.filter((r) => r.depth === 1).map((r) => r.label)).toEqual(['DC2', 'NJ-DC']);
    expect(rows[0].dc).toBe('');
  });

  it('칸 글자 — 모르면 —(0 아님)', () => {
    expect([T.sizeText(null), T.sizeText(undefined), T.sizeText(-1), T.sizeText(410), T.sizeText(2048), T.sizeText(0, 2)]).toEqual(['—', '—', '—', '410 GB', '2.0 TB', '—']);
    expect([T.powerText('POWERED_ON'), T.powerText('POWERED_OFF'), T.powerText(null)]).toEqual(['켜짐', '꺼짐', '—']);
    expect(T.lastRunText({ lastRun: null }).text).toBe('실행 기록 없음');
    expect(T.lastRunText({ lastRun: { state: 'error', level: 'F' } }).tone).toBe('bad');
    expect(T.lastOkText({ lastOk: null }).text).toBe('포탈 기록에 없음');
    expect(T.lastOkText({ lastOk: { at: Date.parse('2026-11-03T04:00:00') } }).text).toMatch(/11-03/);
    const now = Date.parse('2026-11-03T06:00:00');
    expect(T.restoreStateText({ restores: [{ jobid: 1, state: 'running' }] }, now).text).toBe('복원 진행 중');
    expect(T.restoreStateText({ restores: [{ jobid: 1, state: 'ok', at: now - 86_400_000 }] }, now).text).toMatch(/^복원 성공/);
    expect(T.restoreStateText({ restores: [{ jobid: 1, state: 'ok', at: now - 86_400_000, verify: true, finish: { verify: 'failed' } }] }, now).text).toMatch(/^검증 실패/);
    expect(T.restoreStateText({ restores: [{ jobid: 1, state: 'ok', at: now - 30 * 86_400_000 }] }, now).text).toBe('—');
    expect(T.pickedSize([{ storageGB: 100 }, { storageGB: null }])).toBe('100 GB+');
    for (const s of [T.lastOkText({}).title, T.restoreStateText({ restores: [] }).text]) expect(s).not.toMatch(/`|\*\*/);
  });

  it('보기 기억 — 못 읽으면 간단 목록 · 모르는 값은 무시', () => {
    const mem = {};
    const st = { getItem: (k) => mem[k] ?? null, setItem: (k, v) => { mem[k] = v; } };
    expect(T.loadRestoreView(st)).toBe('list');
    T.saveRestoreView('table', st);
    expect(T.loadRestoreView(st)).toBe('table');
    mem['bareos.restore.view'] = 'evil';
    expect(T.loadRestoreView(st)).toBe('list');
    const bad = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(T.loadRestoreView(bad)).toBe('list');
    expect(() => T.saveRestoreView('table', bad)).not.toThrow();
    expect(T.loadRestoreView(null)).toBe('list');
  });
});
