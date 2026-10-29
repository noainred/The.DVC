import { describe, it, expect } from 'vitest';
import { portalMark, pointSource, rpText, rpSort, pickHandoff, RUN_STATUS, RUN_STATUS_ORDER, VM_STATE, powerText, runSummary, ago, saveHandoff, takeHandoff, HANDOFF_KEY } from './backupRunText.js';
import { visibleTabs, VEEAM_TABS } from './VeeamHeader.jsx';

// v2.818 Backup 현황 › 백업 실행 — 서버 판정을 글자로만 바꾼다(판정 복제 금지). 못 읽은 값은 '—'.
const memStore = () => { const m = new Map(); return { setItem: (k, v) => m.set(k, String(v)), getItem: (k) => (m.has(k) ? m.get(k) : null), removeItem: (k) => m.delete(k), m }; };

describe('backupRunText', () => {
  it('실행 상태 6종 문구 · 확인 불가·보내지 않음은 회색(성공도 실패도 아님)', () => {
    expect(RUN_STATUS_ORDER).toEqual(['protected', 'in-job', 'unprotected', 'agent', 'elsewhere', 'unknown', 'unmapped']);
    for (const k of RUN_STATUS_ORDER) expect(RUN_STATUS[k].label).toBeTruthy();
    expect(VM_STATE.unknown.cls).toBe('gray'); expect(VM_STATE.skipped.cls).toBe('gray'); expect(VM_STATE.failed.cls).toBe('red');
  });
  it('전원·요약·상대 시각', () => {
    expect(powerText('POWERED_ON')).toBe('켜짐'); expect(powerText('')).toBe('—');
    expect(runSummary({ vms: [{ state: 'running' }, { state: 'success' }, { state: 'unknown' }] })).toBe('진행 1 · 성공 1 · 확인 불가 1');
    expect(runSummary({ vms: [] })).toBe('—');
    expect(ago(null)).toBe('—');
  });
  it('Detail → 백업 실행 넘김: 한 번만 읽힌다 · 10분 지나면 버린다 · 모양이 틀리면 버린다', () => {
    const s = memStore();
    expect(saveHandoff('vc1', ['vc1:vm-1', 'vc1:vm-2'], s)).toBe(true);
    expect(takeHandoff(s)).toEqual({ vcenterId: 'vc1', vmIds: ['vc1:vm-1', 'vc1:vm-2'] });
    expect(takeHandoff(s)).toBe(null);
    saveHandoff('vc1', ['a'], s);
    expect(takeHandoff(s, Date.now() + 11 * 60_000)).toBe(null);
    s.setItem(HANDOFF_KEY, '{"vcenterId":1}');
    expect(takeHandoff(s)).toBe(null);
  });
  it('백업 실행 탭은 관리자 + 도구 허용일 때만', () => {
    expect(visibleTabs({ admin: false, runOk: true })).toEqual(VEEAM_TABS);
    expect(visibleTabs({ admin: true, runOk: false })).toEqual(VEEAM_TABS);
    expect(visibleTabs({ admin: true, runOk: true }).map((t) => t[0])).toEqual(['summary', 'detail', 'em', 'run']);
    // v2.822 Bareos 탭 — 같은 게이트(관리자 + 도구 허용), 백업 실행 탭과 독립
    expect(visibleTabs({ admin: true, runOk: true, bareosOk: true }).map((t) => t[0])).toEqual(['summary', 'detail', 'em', 'run', 'bareos']);
    expect(visibleTabs({ admin: true, runOk: false, bareosOk: true }).map((t) => t[0])).toEqual(['summary', 'detail', 'em', 'bareos']);
    expect(visibleTabs({ admin: false, runOk: true, bareosOk: true })).toEqual(VEEAM_TABS);
  });
});

describe('v2.819 portalMark · pointSource', () => {
  it('상태별 배지 — 삭제·빼냄이 우선 · 진행 중 · 결과 기호 · 값 없으면 null', () => {
    expect(portalMark(null)).toBe(null);
    const t = new Date(2026, 9, 29, 21, 27).getTime();
    expect(portalMark({ how: 'portal', lastAt: t, lastState: 'success' })).toMatchObject({ label: 'Portal ✓ 10-29', cls: 'green' });
    expect(portalMark({ how: 'portal', lastAt: t, lastState: 'failed' }).label).toBe('Portal ✕ 10-29');
    expect(portalMark({ how: 'quick', lastAt: t, lastState: 'running' }).label).toBe('Portal 백업 중');
    expect(portalMark({ how: 'portal', lastAt: t, lastState: 'success', excludedAt: t }).label).toBe('Portal 잡에서 뺌');
    expect(portalMark({ how: 'portal', lastAt: t, lastState: 'success', excludedAt: t, deletedAt: t }).label).toBe('Portal 백업 삭제됨');
    expect(portalMark({ lastState: 'unknown' }).label).toBe('Portal ?');   // 시각이 없으면 붙이지 않는다
  });
  it('복원 지점 출처', () => {
    expect(pointSource({ jobName: 'PORTAL-x', portal: true })).toEqual({ name: 'PORTAL-x', portal: true });
    expect(pointSource({ backupName: 'Daily' })).toEqual({ name: 'Daily', portal: false });
    expect(pointSource({})).toEqual({ name: '—', portal: false });
  });
});

describe('v2.820.1 B2·B4', () => {
  it('B2 복원 지점 수 — -1 은 \'있음(개수 모름)\'(모니터링 코어 표기) · 없으면 —', () => {
    expect(rpText(-1)).toBe('있음(개수 모름)');
    expect(rpText(12)).toBe('12');
    expect(rpText(0)).toBe('0');
    expect(rpText(null)).toBe('—');
    expect(rpText(undefined)).toBe('—');
    expect([3, -1, 0, null].map(rpSort)).toEqual([3, 0.5, 0, '']);
  });
  it('B4 넘겨받은 VM — 고를 수 있는 행만(연결 서버 없음·조회 전용 제외)', () => {
    const rows = [{ id: 'a', name: 'A', run: { status: 'protected' } }, { id: 'b', name: 'B', run: { status: 'unmapped' } }, { id: 'c', name: 'C', run: { status: 'unknown' } }];
    expect([...pickHandoff(rows, ['a', 'b', 'c', 'zz'], true).keys()]).toEqual(['a', 'c']);
    expect(pickHandoff(rows, ['a'], false).size).toBe(0);
    expect(pickHandoff(rows, [], true).size).toBe(0);
  });
});
