import { describe, it, expect } from 'vitest';
import { RUN_STATUS, RUN_STATUS_ORDER, VM_STATE, powerText, runSummary, ago, saveHandoff, takeHandoff, HANDOFF_KEY } from './backupRunText.js';
import { visibleTabs, VEEAM_TABS } from './VeeamHeader.jsx';

// v2.818 Backup 현황 › 백업 실행 — 서버 판정을 글자로만 바꾼다(판정 복제 금지). 못 읽은 값은 '—'.
const memStore = () => { const m = new Map(); return { setItem: (k, v) => m.set(k, String(v)), getItem: (k) => (m.has(k) ? m.get(k) : null), removeItem: (k) => m.delete(k), m }; };

describe('backupRunText', () => {
  it('실행 상태 6종 문구 · 확인 불가·보내지 않음은 회색(성공도 실패도 아님)', () => {
    expect(RUN_STATUS_ORDER).toEqual(['protected', 'in-job', 'unprotected', 'elsewhere', 'unknown', 'unmapped']);
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
  });
});
