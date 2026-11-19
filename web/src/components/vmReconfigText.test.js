// 54회차 F4 — VM 사양 변경 창: 서버가 못 읽은 vCPU · RAM · 디스크 용량을 null 로 주면 '—' 로 보이고 그 항목을 잠근다(계획 · 확인 문구에 싣지 않는다).
// 아는 값의 동작은 예전 인라인 buildPlan/summary 와 같다(2차 공통 기능 점검 8회차 · v2.480 WB-1 판정 포함).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { stripComments } from '../test/_stripComments.js';
import { cpuKnown, memKnown, diskCapKnown, ramGB0, curText, reconfigPlan, reconfigSummary, lockedItems } from './vmReconfigText.js';

const DISK = { key: 2000, label: '하드 디스크 1', capacityKB: 52428800, capacityGB: 50 };
const NIC = { key: 4000, label: 'NIC 1', network: 'VM Network', macAddress: '00:50:56:01:02:03', connected: true };
const KNOWN = { cpu: 4, coresPerSocket: 2, memMB: 8192, cpuHotAdd: true, memHotAdd: true, powerState: 'poweredOff', disks: [DISK], scsi: [{ key: 1000 }], nics: [NIC] };
const UNKNOWN = { ...KNOWN, cpu: null, coresPerSocket: null, memMB: null, disks: [{ ...DISK, capacityKB: null, capacityGB: null }] };
const form = (o = {}) => ({ cpu: '', cps: 1, ramGB: '', grows: {}, adds: [], nicAdds: [], nicRemoves: new Set(), nicConn: { 4000: true }, ...o });

describe('현재 값 판정', () => {
  it('null · 0 · 글자는 못 읽음 — 읽은 양의 정수만 안다', () => {
    for (const v of [null, undefined, 0, -1, '4', 2.5, NaN]) {
      expect(cpuKnown({ cpu: v }), String(v)).toBe(false);
      expect(memKnown({ memMB: v }), String(v)).toBe(false);
    }
    expect(cpuKnown(KNOWN)).toBe(true); expect(memKnown(KNOWN)).toBe(true);
    expect(cpuKnown(null)).toBe(false);
    expect(diskCapKnown(DISK)).toBe(true); expect(diskCapKnown({ capacityGB: null })).toBe(false); expect(diskCapKnown({ capacityGB: 0 })).toBe(false);
    expect(ramGB0(KNOWN)).toBe(8); expect(ramGB0(UNKNOWN)).toBe(null);
    expect(curText(null)).toBe('—'); expect(curText(null, 'GB')).toBe('—'); expect(curText(50, 'GB')).toBe('50GB');
  });
});

describe('못 읽은 항목은 계획 · 확인 문구에 싣지 않는다(잠금)', () => {
  it('vCPU · 코어/소켓 · RAM · 디스크 증설 — 무엇을 입력해도 보내지 않는다', () => {
    // 예전 인라인 판정은 numOr('', null) = 0 이 null 과 달라 '아무것도 안 해도' numCPUs:0 · memoryMB:0 을 보냈다
    for (const f of [form(), form({ cpu: '64', cps: '4', ramGB: '512', grows: { 2000: '4000' } }), form({ cpu: '1', ramGB: '1' })]) {
      const plan = reconfigPlan(UNKNOWN, f);
      expect(plan.numCPUs).toBeUndefined();
      expect(plan.coresPerSocket).toBeUndefined();
      expect(plan.memoryMB).toBeUndefined();
      expect(plan.diskGrows).toBeUndefined();
      expect(reconfigSummary(UNKNOWN, f)).toEqual([]);
    }
    expect(lockedItems(UNKNOWN)).toEqual(['vCPU · 코어/소켓', 'RAM', '디스크 증설 1개']);
    expect(lockedItems(KNOWN)).toEqual([]);
  });
  it('잠그지 않은 항목(디스크 추가 · NIC)은 그대로 보낸다', () => {
    const plan = reconfigPlan(UNKNOWN, form({ adds: [{ gb: '10', ctrl: '', ds: '' }], nicConn: { 4000: false } }));
    expect(plan.diskAdds).toEqual([{ sizeGB: 10, controllerKey: undefined, datastore: undefined }]);
    expect(plan.nicConnects).toEqual([{ key: 4000, connected: false }]);
  });
});

describe('아는 값 — 예전 동작 그대로', () => {
  it('바뀐 것만 보낸다 · 확인 문구는 계획과 같은 기준', () => {
    const f0 = form({ cpu: 4, cps: 2, ramGB: 8 });
    expect(reconfigPlan(KNOWN, f0)).toEqual({});
    expect(reconfigSummary(KNOWN, f0)).toEqual([]);
    const f = form({ cpu: '8', cps: '4', ramGB: '16', grows: { 2000: '60' } });
    expect(reconfigPlan(KNOWN, f)).toEqual({ numCPUs: 8, coresPerSocket: 4, memoryMB: 16384, diskGrows: [{ key: 2000, newGB: 60 }] });
    expect(reconfigSummary(KNOWN, f)).toEqual(['vCPU 4→8', '코어/소켓 →4', 'RAM 8→16GB', '하드 디스크 1 50→60GB']);
    // 디스크는 현재보다 큰 값만(작거나 같으면 싣지 않는다)
    expect(reconfigPlan(KNOWN, form({ cpu: 4, cps: 2, ramGB: 8, grows: { 2000: '50' } }))).toEqual({});
    // v2.480 WB-1: 1.5GB VM 은 표시 2GB 를 그대로 두면 보내지 않는다
    expect(reconfigPlan({ ...KNOWN, memMB: 1536 }, form({ cpu: 4, cps: 2, ramGB: 2 }))).toEqual({});
  });
});

describe('화면(VmReconfig.jsx)은 이 판정을 쓴다 — 소스 스윕', () => {
  const src = stripComments(fs.readFileSync(new URL('./VmReconfig.jsx', import.meta.url), 'utf8'));
  it('계획 · 확인 문구는 순수 모듈 하나(인라인 사본 없음)', () => {
    expect(src).toMatch(/reconfigPlan\(hw, form, networks\)/);
    expect(src).toMatch(/reconfigSummary\(hw, form, networks\)/);
    expect(src).not.toMatch(/const numOr = /);
  });
  it('못 읽은 항목은 입력을 잠그고 현재 값을 \'—\' 로', () => {
    // 입력 칸마다(vCPU · 코어/소켓 · RAM · 디스크 증설) — 한 칸만 빠져도 잡도록 값 묶음과 함께 본다
    expect(src).toMatch(/value=\{cpu\} disabled=\{cpuBlocked \|\| !cpuOk\}/);
    expect(src).toMatch(/value=\{cps\} disabled=\{cpuBlocked \|\| !cpuOk\}/);
    expect(src).toMatch(/value=\{ramGB\} disabled=\{memBlocked \|\| !memOk\}/);
    expect(src).toMatch(/value=\{grows\[d\.key\] \?\? ''\} disabled=\{!diskCapKnown\(d\)\}/);
    expect(src).toMatch(/curText\(cpuOk \? hw\.cpu : null\)/);
    expect(src).toMatch(/curText\(ramGB0\(hw\)\)/);
    expect(src).toMatch(/setCpu\(cpuKnown\(r\.hw\) \? r\.hw\.cpu : ''\)/);
  });
});
