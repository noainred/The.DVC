// vcdVirt 단위테스트(v2.334) — vCenter 상세의 CPU·MEM 가상화율 집계.
// 사용자 요구를 고정한다: 'Off VM 포함' 을 해제하면 꺼진 VM 의 할당(vCPU·RAM)이 빠져
// 가상화율이 함께 내려간다. 필터는 호출부(VCenterDetail 의 visibleVms) 책임이므로,
// 여기서는 "넘긴 목록만 합산한다"는 계약과 호스트 묶음 합계 산술을 검증한다.
import { describe, it, expect } from 'vitest';
import { allocByHost, countByHost, virtSum } from './vcdVirt.js';

// esx1: 켜진 VM 2대(4+2 vCPU, 8192+4096MB) + 꺼진 VM 1대(8 vCPU, 16384MB)
// esx2: 켜진 VM 1대(2 vCPU, 2048MB)
const VMS = [
  { name: 'on-a', host: 'esx1', cpuCount: 4, memMB: 8192, powerState: 'POWERED_ON' },
  { name: 'on-b', host: 'esx1', cpuCount: 2, memMB: 4096, powerState: 'POWERED_ON' },
  { name: 'off-c', host: 'esx1', cpuCount: 8, memMB: 16384, powerState: 'POWERED_OFF' },
  { name: 'on-d', host: 'esx2', cpuCount: 2, memMB: 2048, powerState: 'POWERED_ON' },
];
const HOSTS = [
  { name: 'esx1', cpuCores: 16, memTotalMB: 16384, vmCount: 3 },
  { name: 'esx2', cpuCores: 8, memTotalMB: 8192, vmCount: 1 },
];
const onlyOn = (vms) => vms.filter((v) => v.powerState !== 'POWERED_OFF');

describe('allocByHost', () => {
  it('호스트별 할당 vCPU·메모리(MB) 합계', () => {
    const { vcpu, vmem } = allocByHost(VMS);
    expect(vcpu.get('esx1')).toBe(14);        // 4 + 2 + 8
    expect(vmem.get('esx1')).toBe(28672);     // 8192 + 4096 + 16384
    expect(vcpu.get('esx2')).toBe(2);
    expect(vmem.get('esx2')).toBe(2048);
  });

  it('꺼진 VM 을 제외한 목록을 넘기면 그만큼 할당이 빠진다(Off VM 포함 해제 동작)', () => {
    const { vcpu, vmem } = allocByHost(onlyOn(VMS));
    expect(vcpu.get('esx1')).toBe(6);         // 8 vCPU 짜리 off-c 제외
    expect(vmem.get('esx1')).toBe(12288);
    expect(vcpu.get('esx2')).toBe(2);         // esx2 는 변화 없음
  });

  it('host 미지정·비숫자·빈 입력을 0/빈 맵으로 흘린다', () => {
    const { vcpu, vmem } = allocByHost([{ cpuCount: '3', memMB: null }, { host: 'esx9' }]);
    expect(vcpu.get('')).toBe(3);             // host 없으면 '' 키, 숫자 문자열은 변환
    expect(vmem.get('')).toBe(0);             // null → 0
    expect(vcpu.get('esx9')).toBe(0);
    expect(allocByHost(undefined).vcpu.size).toBe(0);
  });
});

describe('virtSum — 클러스터·DC 합계', () => {
  it('할당(분자)과 물리(분모), 호스트 VM 수를 합산한다', () => {
    const { vcpu, vmem } = allocByHost(VMS);
    const s = virtSum(HOSTS, vcpu, vmem);
    expect(s.alloc).toBe(16);                 // 14 + 2
    expect(s.cores).toBe(24);                 // 16 + 8
    expect(s.memAlloc).toBe(30720);           // 28672 + 2048
    expect(s.memPhys).toBe(24576);            // 16384 + 8192
    expect(s.vmc).toBe(4);                    // 호스트가 보고한 VM 수(전원 무관)
  });

  it('Off VM 제외 시 분자만 줄고 물리 분모는 그대로 — 가상화율이 내려간다', () => {
    const all = allocByHost(VMS);
    const on = allocByHost(onlyOn(VMS));
    const sAll = virtSum(HOSTS, all.vcpu, all.vmem);
    const sOn = virtSum(HOSTS, on.vcpu, on.vmem);
    expect(sOn.alloc).toBe(8);                // 16 - 8
    expect(sOn.cores).toBe(sAll.cores);
    expect(sOn.memAlloc).toBe(14336);         // 30720 - 16384
    expect(sOn.memPhys).toBe(sAll.memPhys);
    expect(sOn.alloc / sOn.cores).toBeLessThan(sAll.alloc / sAll.cores);
    expect(sOn.memAlloc / sOn.memPhys).toBeLessThan(sAll.memAlloc / sAll.memPhys);
  });

  it('vmCount 맵을 주면 VM 수를 그 맵으로 센다 — Off VM 포함 해제 시 켜진 VM 만(v2.336)', () => {
    const on = onlyOn(VMS);
    const s = virtSum(HOSTS, allocByHost(on).vcpu, allocByHost(on).vmem, countByHost(on));
    expect(s.vmc).toBe(3);                    // esx1 켜진 2 + esx2 켜진 1 (h.vmCount 4 가 아님)
    // 맵을 주지 않으면 기존대로 호스트 보고값(h.vmCount) 합계.
    expect(virtSum(HOSTS, undefined, undefined).vmc).toBe(4);
  });

  it('countByHost — 호스트별 VM 대수, host 미지정은 빈 키', () => {
    const m = countByHost(VMS);
    expect(m.get('esx1')).toBe(3);
    expect(m.get('esx2')).toBe(1);
    expect(countByHost([{ name: 'x' }]).get('')).toBe(1);
    expect(countByHost(undefined).size).toBe(0);
  });

  it('맵이 없거나 VM 없는 호스트도 0으로 안전하게 합산', () => {
    const s = virtSum([{ name: 'lonely', cpuCores: 4, memTotalMB: 4096 }], undefined, undefined);
    expect(s).toEqual({ alloc: 0, cores: 4, vmc: 0, memAlloc: 0, memPhys: 4096 });
    expect(virtSum(undefined, new Map(), new Map()).cores).toBe(0);
  });
});
