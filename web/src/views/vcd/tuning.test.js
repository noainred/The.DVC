import { describe, it, expect } from 'vitest';
import {
  usageLevel, dsLevel, vmTuningAxes, vmTuningPlan, hostTuningAxes, hostTuningPlan, heavyNeighbors, planCsv, planMarkdown,
  VM_TUNING_DAYS, DEFAULT_VM_TUNING_DAYS,
} from './tuning.js';
import { ratioLevel, RATIO_LEVELS } from '../vcdVirt.js';
import { normObjTab, TUNING_TAB } from './objTabs.js';

const st = (axes, k) => axes.find((a) => a.k === k);

describe('성능 튜닝(v2.897) — 기준값은 기존 화면 · 규칙과 같다', () => {
  it('사용률 75 · 90 · 데이터스토어 90 · 95(포탈 알람 규칙) · 가상화율 2.5 · 4 / 1.0 · 1.5(트리 색)', () => {
    expect([usageLevel(74), usageLevel(75), usageLevel(90), usageLevel(null)]).toEqual(['ok', 'warn', 'crit', null]);
    expect([dsLevel(90), dsLevel(91), dsLevel(96), dsLevel('')]).toEqual(['ok', 'warn', 'crit', null]);
    expect(RATIO_LEVELS).toEqual({ cpu: [2.5, 4], mem: [1.0, 1.5] });
    expect([ratioLevel(2.4), ratioLevel(2.5), ratioLevel(4), ratioLevel(1.0, true), ratioLevel(null)]).toEqual(['ok', 'warn', 'crit', 'warn', null]);
  });
  it('기간 칩은 서버가 받는 값 중 · 기본 30일 · 탭 키 tuning 은 VM · 호스트 둘 다', () => {
    expect(VM_TUNING_DAYS).toEqual([7, 30, 90]);
    expect(DEFAULT_VM_TUNING_DAYS).toBe(30);
    expect(normObjTab('vm', 'tuning')).toBe('tuning');
    expect(normObjTab('host', 'tuning')).toBe('tuning');
    expect(TUNING_TAB.label).toBe('성능 튜닝');
  });
});

describe('VM 진단 — 못 읽은 축은 unknown(정상으로 세지 않는다)', () => {
  const vmOn = { id: 'v', powerState: 'POWERED_ON' };
  it('꺼진 VM · 측정 없음 · 권한 없음 · 조회 실패', () => {
    const off = vmTuningAxes({ vm: { powerState: 'POWERED_OFF' } });
    expect(off.every((a) => a.state === 'unknown')).toBe(true);
    const a = vmTuningAxes({ vm: vmOn, rsDenied: true });
    expect(st(a, 'rightsize')).toMatchObject({ state: 'unknown', title: '권한 없음' });
    expect(st(a, 'cpu')).toMatchObject({ state: 'unknown', title: '측정하지 않음' });
    expect(st(a, 'mem').state).toBe('unknown');
    expect(st(a, 'storage').state).toBe('unknown');
    expect(st(a, 'config')).toMatchObject({ state: 'unknown', title: '아직 읽지 않음' });
    expect(st(vmTuningAxes({ vm: vmOn, rsError: 'vCenter 성능 조회 실패: 502' }), 'rightsize')).toMatchObject({ state: 'unknown', title: '조회 실패' });
  });
  it('서버 verdict 를 그대로 — reduce/hold 는 주의 · keep 은 적정 · insufficient 는 판정 보류', () => {
    const v = (state) => st(vmTuningAxes({ vm: vmOn, rs: { verdict: { state, summary: 's' } } }), 'rightsize');
    expect(v('reduce')).toMatchObject({ state: 'warn', title: '과다 할당' });
    expect(v('hold').state).toBe('warn');
    expect(v('keep')).toMatchObject({ state: 'ok', title: '적정' });
    expect(v('insufficient')).toMatchObject({ state: 'unknown', title: '근거 불충분' });
  });
  it('메모리 압박 — 표본이 있을 때만(스왑 > 벌룬 > 없음)', () => {
    const m = (balloon, swapped) => st(vmTuningAxes({ vm: vmOn, rs: { verdict: { state: 'keep' }, mem: { balloon, swapped } } }), 'mem');
    expect(m({ n: 0 }, { n: 0 }).state).toBe('unknown');
    expect(m({ n: 10, samplesAbove0: 0, max: 0 }, { n: 10, samplesAbove0: 0, max: 0 }).state).toBe('ok');
    expect(m({ n: 10, samplesAbove0: 3, max: 512 }, { n: 10, samplesAbove0: 0 }).state).toBe('warn');
    expect(m({ n: 10, samplesAbove0: 3 }, { n: 10, samplesAbove0: 1 }).state).toBe('crit');
  });
  it('CPU 경합 · 디스크 지연은 contention 규칙 · 데이터스토어 사용률이 높으면 스토리지 주의', () => {
    const vm = { ...vmOn, perfc: { readyPct: { avg: 12, max: 20 }, costopPct: { avg: 0.1 }, readMs: { avg: 3 }, writeMs: { avg: 28 }, disk: 'scsi0:0' }, cfg: {} };
    const a = vmTuningAxes({ vm, dsRows: [{ datastore: 'ds1', dsUsagePct: 92 }] });
    expect(st(a, 'cpu').state).toBe('crit');
    expect(st(a, 'storage').state).toBe('warn');
  });
});

describe('VM 조치 계획 — 근거에서만', () => {
  it('DS 여유 · 오래된 스냅샷 · 감축 가능 · Ready — 위험이 먼저', () => {
    const now = Date.parse('2026-11-05T00:00:00Z');
    const vm = { powerState: 'POWERED_ON', snapshotCount: 1, snapshotOldestTs: now - 35 * 86_400_000, perfc: { readyPct: { avg: 12, max: 15 } }, cfg: {} };
    const rs = { verdict: { state: 'reduce', summary: 'vCPU 4 → 2' }, cpu: { vcpu: 4, recommendedVcpu: 2, reductionVcpu: 2 }, mem: { allocMB: 16384, recommendedMB: 16384, reductionMB: 0 } };
    const plan = vmTuningPlan({ vm, rs, dsRows: [{ datastore: 'ds1', dsUsagePct: 92 }], now });
    expect(plan[0].lv).toBe('crit');                                    // Ready 매우 높음
    expect(plan.map((r) => r.k)).toEqual(expect.arrayContaining(['ds:ds1', 'snapshot', 'rightsize', 'cpu-ready-crit']));
    expect(plan.find((r) => r.k === 'rightsize').action).toBe('사양 줄이기 — vCPU 4 → 2');
    expect(vmTuningPlan({ vm: { powerState: 'POWERED_ON' } })).toEqual([]);   // 근거가 없으면 계획도 없다
  });
});

describe('호스트 진단 · 계획', () => {
  const host = { name: 'h', cpuCores: 64, cpuUsagePct: 44, memUsagePct: 71, memTotalMB: 1048576, connectionState: 'CONNECTED', hcfg: { at: 1 }, nics: [{ device: 'vmnic4', link: false, maxSpeedMb: 1000 }] };
  it('가상화율 · 메모리 · 경로 · NIC — 끊긴 호스트는 unknown', () => {
    const a = hostTuningAxes({ host, vcpuAlloc: 218, memAllocMB: 962560, onHost: [], dsRows: [{ datastore: 'ds1', usagePct: 96, vms: 3 }] });
    expect(st(a, 'cpu')).toMatchObject({ state: 'warn', title: '3.4:1' });
    expect(st(a, 'contention').state).toBe('unknown');
    expect(st(a, 'mem').state).toBe('ok');
    expect(st(a, 'storage').state).toBe('crit');
    expect(st(a, 'net').state).toBe('warn');
    const d = hostTuningAxes({ host: { ...host, connectionState: 'DISCONNECTED' }, vcpuAlloc: 10 });
    expect(st(d, 'cpu').state).toBe('unknown');
    expect(st(d, 'mem').state).toBe('unknown');
  });
  it('계획 — 가상화율 · DS · Ready VM', () => {
    const onHost = [{ name: 'a', powerState: 'POWERED_ON', perfc: { readyPct: { avg: 6 } } }];
    const plan = hostTuningPlan({ host, onHost, dsRows: [{ datastore: 'ds1', usagePct: 92, vms: 2 }], vcpuAlloc: 300 });
    expect(plan.map((r) => r.k)).toEqual(expect.arrayContaining(['ratio', 'ds:ds1', 'ready']));
  });
  it('무거운 VM — 꺼짐 · 사용률 모름은 뺀다', () => {
    const r = heavyNeighbors([{ id: 1, powerState: 'POWERED_ON', cpuUsagePct: 50, cpuCount: 4 }, { id: 2, powerState: 'POWERED_ON', cpuUsagePct: 90, cpuCount: 1 }, { id: 3, powerState: 'POWERED_OFF', cpuUsagePct: 99 }, { id: 4, powerState: 'POWERED_ON', cpuUsagePct: null }]);
    expect(r.map((v) => v.id)).toEqual([1, 2]);
  });
});

describe('체크리스트 내보내기', () => {
  const rows = [{ k: 'a', lv: 'crit', action: '=SUM(A1)', why: 'x, "y"', risk: '', where: 'w' }];
  it('CSV — BOM · 수식 주입 방지 · 따옴표', () => {
    const c = planCsv(rows, 't');
    expect(c.startsWith('﻿')).toBe(true);
    expect(c).toMatch(/'=SUM\(A1\)/);
    expect(c).toMatch(/"x, ""y"""/);
  });
  it('Markdown — 체크 상자 목록', () => {
    expect(planMarkdown(rows, '제목')).toMatch(/^## 제목\n\n- \[ \] 1\. \[위험\] =SUM\(A1\)/);
  });
});
