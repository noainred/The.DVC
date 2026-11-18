// v3.21.0 — 보기 ‘과할당’: 원값(MHz · MB)으로 더한 뒤 바꾸기 · 갈래 전환 · 법인별 막대 · VM 5대 · 회수 가능 스토리지(wasteViewText 한 벌).
import { describe, it, expect } from 'vitest';
import { overTotals, kindCounts, corpBars, topVms, normKind, OVER_KINDS } from './vmOverText.js';
import { reclaimStorage } from '../../tools/wasteViewText.js';

const row = (id, o = {}) => ({
  vcenterId: id, name: `vc-${id}`, vms: 100, poweredOnVms: 80,
  cpu: { allocMhz: 10000.4, usedMhz: 4000.2, idleMhz: 6000.2, candidates: 5 },
  mem: { allocMB: 102400, usedMB: 51200, idleMB: 51200, candidates: 7 },
  usageUnknown: { cpu: 1, mem: 0 }, excludedNoHostMhz: 0,
  poweredOff: 4, poweredOffGB: 1000, poweredOffStorageUnknown: 0, offVcpu: 8, offMemGB: 16, offAllocUnknown: 0, offWithSnapshots: 1,
  snapshots: 3, snapshotGB: 300, noTools: 2, thinVms: 10, thinReclaimGB: 2000, thinUncommittedUnknown: 1,
  top: { mem: [], cpu: [], poweredOff: [], snapshots: [], noTools: [] },
  ...o,
});
const RESP = {
  summary: true, tool: 'waste', topN: 5, thresholds: { cpuIdlePct: 20, memIdlePct: 40 },
  rows: [
    row('a', { top: {
      mem: [{ id: 'a:1', name: 'ma', memIdleGB: 40, memUsagePct: 10 }, { id: 'a:2', name: 'mb', memIdleGB: 10, memUsagePct: 30 }],
      cpu: [{ id: 'a:3', name: 'ca', cpuIdleMhz: 9000, cpuUsagePct: 5 }],
      poweredOff: [{ id: 'a:4', name: 'oa', storageGB: 500 }],
      snapshots: [{ id: 'a:5', name: 'sa', snapshotSizeGB: 100, snapshotCount: 2 }],
      noTools: [{ id: 'a:6', name: 'zz-first' }, { id: 'a:7', name: 'aa-second' }],
    } }),
    row('b', { mem: { allocMB: 204800, usedMB: 51200, idleMB: 153600, candidates: 9 }, noTools: 0, top: {
      mem: [{ id: 'b:1', name: 'mc', memIdleGB: 40, memUsagePct: 5 }],
      cpu: [], poweredOff: [{ id: 'b:2', name: 'ob', storageGB: 800 }], snapshots: [], noTools: [],
    } }),
  ],
};

describe('과할당 — 합(고른 법인)', () => {
  it('할당 · 사용은 원값으로 더한다(반올림 전) · 기준은 응답 값', () => {
    const t = overTotals(RESP, []);
    expect(t.cpu.allocMhz).toBeCloseTo(20000.8, 5);
    expect(t.mem.idleMB).toBe(204800);
    expect(t.mem.candidates).toBe(16);
    expect(t.cpuIdlePct).toBe(20);
    expect(t.memIdlePct).toBe(40);
    expect(t.usageUnknown.cpu).toBe(2);
  });
  it('회수 가능 스토리지(추정) = 꺼진 VM 점유 + Thin 여유 — Optimization 화면과 같은 함수', () => {
    const t = overTotals(RESP, []);
    const same = reclaimStorage({ poweredOff: { storageGB: 2000, storageUnknown: 0 }, thinReclaim: { reclaimableGB: 4000, count: 20, uncommittedUnknown: 2 } });
    expect(t.reclaim).toEqual(same);
    expect(t.reclaim.totalGB).toBe(6000);
  });
  it('법인 하나만 고르면 그 줄만 · 없는 법인은 missing', () => {
    const t = overTotals(RESP, ['b', 'zz']);
    expect(t.mem.candidates).toBe(9);
    expect(t.missing).toEqual(['zz']);
  });
});

describe('갈래 전환 — 무엇을 볼지', () => {
  it('갈래 5개 · 키는 Optimization 하위 탭 키 · 모르는 키는 메모리', () => {
    expect(OVER_KINDS.map((k) => k.key)).toEqual(['mem', 'cpu', 'off', 'snap', 'tools']);
    expect(normKind('xx')).toBe('mem');
    expect(normKind('snap')).toBe('snap');
    expect(kindCounts(overTotals(RESP, []))).toEqual({ mem: 16, cpu: 10, off: 8, snap: 6, tools: 2 });
  });
  it('법인별 막대 — 과할당은 미사용 큰 순 · 길이는 할당 대비', () => {
    const t = overTotals(RESP, []);
    const mem = corpBars(t, 'mem');
    expect(mem.map((c) => c.vcenterId)).toEqual(['b', 'a']);
    expect(mem[0].w).toBe(100);
    expect(mem[1].w).toBe(50);
    expect(mem[0].used).toBe(51200);
    const tools = corpBars(t, 'tools');
    expect(tools.map((c) => c.vcenterId)).toEqual(['a']);   // 0 인 법인은 뺀다
    expect(corpBars(t, 'off').map((c) => c.value)).toEqual([1000, 1000]);
  });
  it('VM 5대 — 갈래마다 도구의 순서로 다시 고른다', () => {
    const t = overTotals(RESP, []);
    expect(topVms(t, 'mem').map((x) => x.name)).toEqual(['mc', 'ma', 'mb']);   // 미사용 같으면 사용률 낮은 순
    expect(topVms(t, 'off').map((x) => x.name)).toEqual(['ob', 'oa']);
    expect(topVms(t, 'snap').map((x) => x.name)).toEqual(['sa']);
    expect(topVms(t, 'tools').map((x) => x.name)).toEqual(['zz-first', 'aa-second']);   // 도구가 준 순서(순위가 아니다)
    expect(topVms(t, 'cpu')[0].vcenterId).toBe('a');
  });
  it('응답이 없으면 null · 빈 목록', () => {
    expect(overTotals(null, [])).toBeNull();
    expect(corpBars(null, 'mem')).toEqual([]);
    expect(topVms(null, 'mem')).toEqual([]);
  });
});
