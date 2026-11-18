// v3.21.0 — VM 분석 화면 특수 기능 패널 5종: 고른 법인 합 · 구간 막대 · 상위 병합 · 부분 합 · 판정 밖(서버 요약 응답 모양 그대로의 입력).
import { describe, it, expect } from 'vitest';
import {
  gpBandOf, gpBandLabels, warmAt, WARM, osName, guestPartView, offAgeBands, offView, trackView, lifeView, slotText, contentionView, diskLatOf, hygieneView,
} from './vmToolPanelsText.js';

const GP = {
  ok: true, summary: true, tool: 'guest-partition', topN: 5,
  thresholds: { defaultThr: 80, thr: null, critPct: 95, soonDays: 30, growthDays: 7, overBinEdges: [85, 90, 95] },
  collect: { enabled: true, empty: false },
  rows: [
    { vcenterId: 'a', name: 'vc-a', guests: 100, reported: 90, notReported: 10, offNotReported: 4, overVms: 9, overParts: 12, crit: 2, soon: 1, stale: false, thr: null,
      osOver: { win: 5, lnx: 4, other: 0 }, overBins: [5, 4, 1, 2],
      top: { fullest: [{ vmId: 'a1', vmName: 'a1', path: 'C:', pct: 99, freeGB: 1 }, { vmId: 'a2', vmName: 'a2', path: '/', pct: 91, freeGB: 5 }], soonest: [{ vmId: 'a2', vmName: 'a2', path: '/', pct: 91, etaDays: 12 }] } },
    { vcenterId: 'b', name: 'vc-b', guests: 50, reported: 50, notReported: 0, offNotReported: 0, overVms: 3, overParts: 3, crit: 1, soon: 2, stale: true, thr: null,
      osOver: { win: 0, lnx: 3, other: 0 }, overBins: [1, 1, 0, 1],
      top: { fullest: [{ vmId: 'b1', vmName: 'b1', path: '/data', pct: 99, freeGB: 0.5 }], soonest: [{ vmId: 'b1', vmName: 'b1', path: '/data', pct: 99, etaDays: 2 }, { vmId: 'b2', vmName: 'b2', path: '/', pct: 88, etaDays: 20 }] } },
  ],
};

describe('디스크가 차 가는 VM — 게스트 파티션 요약', () => {
  it('구간 이름 · 색은 응답 경계로(기준값을 박지 않는다) · 마지막 구간은 빨강', () => {
    expect(gpBandLabels(80, [85, 90, 95])).toEqual(['80–85%', '85–90%', '90–95%', '95% 이상']);
    expect(gpBandLabels(70, [75, 90])).toEqual(['70–75%', '75–90%', '90% 이상']);
    expect(gpBandLabels(null, [85])).toEqual(['기준–85%', '85% 이상']);
    expect(gpBandOf(84.9, [85, 90, 95])).toBe(0);
    expect(gpBandOf(85, [85, 90, 95])).toBe(1);
    expect(gpBandOf(95, [85, 90, 95])).toBe(3);
    expect(gpBandOf(null, [85])).toBeNull();
    expect(warmAt(3, 4)).toBe(WARM[3]);
    expect(warmAt(1, 2)).toBe(WARM[3]);   // 구간이 둘이어도 위 칸은 빨강
  });
  it('전체 — 두 법인 합 · 오래된 법인 수 · 상위 병합(사용률 큰 순 → 남은 용량 작은 순)', () => {
    const v = guestPartView(GP, []);
    expect(v.overVms).toBe(12);
    expect(v.overParts).toBe(15);
    expect(v.crit).toBe(3);
    expect(v.notReported).toBe(10);
    expect(v.thr).toBe(80);
    expect(v.bands.map((b) => b.n)).toEqual([6, 5, 1, 3]);
    expect(v.bands[0].label).toBe('80–85%');
    expect(v.staleCorps).toBe(1);
    expect(v.os).toEqual({ win: 5, lnx: 7, other: 0 });
    expect(v.fullest.map((p) => p.vmName)).toEqual(['b1', 'a1', 'a2']);
    expect(v.fullest[0].vcenterId).toBe('b');
    expect(v.soonest.map((p) => p.etaDays)).toEqual([2, 12, 20]);
  });
  it('법인 하나를 고르면 그 법인 값만 — 서버 왕복 없이', () => {
    const v = guestPartView(GP, ['a']);
    expect(v.overVms).toBe(9);
    expect(v.fullest.map((p) => p.vmName)).toEqual(['a1', 'a2']);
    expect(v.missing).toEqual([]);
  });
  it('법인마다 기준이 다르면 한 숫자로 말하지 않는다', () => {
    const r = { ...GP, rows: [{ ...GP.rows[0], thr: 70 }, GP.rows[1]] };
    const v = guestPartView(r, []);
    expect(v.thrMixed).toBe(true);
    expect(v.thr).toBeNull();
    expect(v.bands[0].label).toBe('기준–85%');
  });
  it('응답이 없으면 null(빈 값을 지어내지 않는다)', () => {
    expect(guestPartView(null, [])).toBeNull();
  });
  it('파티션 OS 코드 → 이름(모르는 값은 그대로)', () => {
    expect([osName('win'), osName('lnx'), osName('other'), osName(''), osName('aix')]).toEqual(['Windows', 'Linux', '그 밖', '—', 'aix']);
  });
});

const WASTE = {
  summary: true, tool: 'waste', topN: 5, thresholds: { cpuIdlePct: 20, memIdlePct: 40 },
  rows: [
    { vcenterId: 'a', name: 'vc-a', vms: 100, poweredOff: 10, poweredOffGB: 2048, poweredOffStorageUnknown: 1, offVcpu: 20, offMemGB: 64, offAllocUnknown: 0, offWithSnapshots: 2,
      top: { poweredOff: [{ id: 'a:1', name: 'a-off1', storageGB: 900 }, { id: 'a:2', name: 'a-off2', storageGB: 100 }] } },
    { vcenterId: 'b', name: 'vc-b', vms: 50, poweredOff: 0, poweredOffGB: 0, poweredOffStorageUnknown: 0, offVcpu: 0, offMemGB: 0, offAllocUnknown: 0, offWithSnapshots: 0, top: { poweredOff: [] } },
    { vcenterId: 'c', name: 'vc-c', vms: 20, poweredOff: 3, poweredOffGB: 3000, poweredOffStorageUnknown: 0, offVcpu: 6, offMemGB: 12, offAllocUnknown: 1, offWithSnapshots: 1,
      top: { poweredOff: [{ id: 'c:1', name: 'c-off1', storageGB: 2500 }] } },
  ],
};
const OFFSINCE = {
  summary: true, tool: 'waste/off-since', ageEdges: [7, 30], topN: 5,
  rows: [
    { vcenterId: 'a', poweredOff: 10, buckets: { ge30: 2, d7: 3, lt7: 1, unknown: 4 }, top: { oldest: [{ id: 'a:1', name: 'a-off1', offDays: 40, exact: true, source: 'event' }, { id: 'a:3', name: 'a-off3', offDays: null }] } },
    { vcenterId: 'c', poweredOff: 3, buckets: { ge30: 0, d7: 0, lt7: 0, unknown: 3 }, top: { oldest: [] } },
  ],
};

describe('꺼진 VM — Optimization › 전원 꺼짐', () => {
  it('구간 이름은 응답 ageEdges 로 · 서버 buckets 키와 같은 순서', () => {
    expect(offAgeBands([7, 30]).map((b) => [b.key, b.label])).toEqual([['lt7', '7일 미만'], ['d7', '7–30일'], ['ge30', '30일 이상'], ['unknown', '모름']]);
    expect(offAgeBands([14, 60]).map((b) => b.label)).toEqual(['14일 미만', '14–60일', '60일 이상', '모름']);
  });
  it('합 · 못 읽은 수는 따로 · 법인별은 디스크 큰 순(0 인 법인은 빼고)', () => {
    const v = offView(WASTE, OFFSINCE, []);
    expect(v.count).toBe(13);
    expect(v.diskGB).toBe(5048);
    expect(v.diskUnknown).toBe(1);
    expect(v.allocUnknown).toBe(1);
    expect(v.vms).toBe(170);
    expect(v.byDisk.map((x) => x.name)).toEqual(['c-off1', 'a-off1', 'a-off2']);
    expect(v.corps.map((c) => c.vcenterId)).toEqual(['c', 'a']);
    expect(v.bands.map((b) => b.n)).toEqual([1, 3, 2, 7]);
  });
  it('오래 꺼진 순 — 꺼진 지를 모르는 VM 은 뒤로(0일로 넣지 않는다)', () => {
    const v = offView(WASTE, OFFSINCE, []);
    expect(v.byDays.map((x) => x.name)).toEqual(['a-off1', 'a-off3']);
  });
  it('off-since 를 아직 못 받았으면 구간 · 오래 꺼진 순은 null(지어내지 않는다) — 수 · 디스크는 먼저 그린다', () => {
    const v = offView(WASTE, null, ['a']);
    expect(v.count).toBe(10);
    expect(v.bands).toBeNull();
    expect(v.byDays).toBeNull();
  });
});

const TRACK = {
  ok: true, summary: true, tool: 'vm-track', days: 30, slots: ['2026-11-17T00', '2026-11-17T12', '2026-11-18T00'],
  rows: [
    { vcenterId: 'a', current: { slot: '2026-11-18T00', total: 110 }, base: { slot: '2026-11-17T00', total: 100 },
      points: [{ slot: '2026-11-17T00', total: 100 }, { slot: '2026-11-17T12', total: 105 }, { slot: '2026-11-18T00', total: 110 }] },
    { vcenterId: 'b', current: { slot: '2026-11-18T00', total: 50 }, base: { slot: '2026-11-17T12', total: 52 },
      points: [{ slot: '2026-11-17T12', total: 52 }, { slot: '2026-11-18T00', total: 50 }] },
  ],
};

describe('VM 수 추이 — 슬롯마다 합 · 빠진 법인이 있는 슬롯은 부분 합', () => {
  it('슬롯 합과 부분 합 표시', () => {
    const v = trackView(TRACK, []);
    expect(v.points.map((p) => [p.total, p.partial])).toEqual([[100, true], [157, false], [160, false]]);
    expect(v.partialPoints).toBe(1);
    expect(v.current).toBe(160);
    // dbg3221: b 의 첫 점은 17T12 — 법인마다 첫 슬롯이 달라 기준 합(100 + 52 = 152 · 서로 다른 시각)과 증감을 만들지 않는다
    expect(v.base).toBeNull();
    expect(v.baseSlot).toBeNull();
    expect(v.diff).toBeNull();
    expect(v.slotsMixed).toBe(true);
    expect(v.min).toBe(100);
  });
  it('한 법인이라도 지금 값을 모르면 합 · 증감을 말하지 않는다', () => {
    const r = { ...TRACK, rows: [TRACK.rows[0], { ...TRACK.rows[1], current: null }] };
    const v = trackView(r, []);
    expect(v.current).toBeNull();
    expect(v.diff).toBeNull();
  });
  it('이력이 없으면 빈 점(지어내지 않는다)', () => {
    const v = trackView({ ok: true, rows: [], slots: [], days: 30 }, []);
    expect(v.empty).toBe(true);
    expect(v.points).toEqual([]);
  });
  it('슬롯 표기', () => {
    expect(slotText('2026-11-18T12')).toBe('11-18 12시');
    expect(slotText('x')).toBe('x');
  });
});

describe('생성 · 삭제 — 같은 날끼리 더한다', () => {
  it('합 · 종류별 · 날마다(일부만 센 날 표시)', () => {
    const resp = { summary: true, days: 7, truncated: false, notCollected: [{ vcenterId: 'z' }], rows: [
      { vcenterId: 'a', added: 3, removed: 1, net: 2, byKind: { create: 2, clone: 1, remove: 1 }, series: [{ day: 1000, added: 1, removed: 0, partialFrom: 1500 }, { day: 2000, added: 2, removed: 1 }] },
      { vcenterId: 'b', added: 1, removed: 2, net: -1, byKind: { deploy: 1, remove: 2 }, series: [{ day: 1000, added: 0, removed: 1 }, { day: 2000, added: 1, removed: 1 }] },
    ] };
    const v = lifeView(resp, []);
    expect([v.added, v.removed, v.net]).toEqual([4, 3, 1]);
    expect(v.kinds.find((k) => k.key === 'remove').n).toBe(3);
    expect(v.series).toEqual([{ day: 1000, added: 1, removed: 1, partial: true }, { day: 2000, added: 3, removed: 2, partial: false }]);
    expect(v.seriesMax).toBe(5);
    expect(v.notCollected).toBe(1);
  });
});

describe('CPU 경합 · 디스크 지연', () => {
  const resp = { summary: true, topN: 5, thresholds: { readyWarn: 5, readyCrit: 10, diskWarn: 20, diskCrit: 50 }, scan: { refreshMs: 900000 },
    rows: [
      { vcenterId: 'a', coverage: { poweredOn: 10, measured: 9, notMeasured: 1, stale: 0 }, kpi: { readyWarn: 2, readyCrit: 1, costop: 1, diskWarn: 1, diskCrit: 1 },
        top: { ready: [{ id: 'a:1', name: 'r1', readyAvg: 12 }], disk: [{ id: 'a:2', name: 'd1', readAvg: 30, writeAvg: 70 }] } },
      { vcenterId: 'b', coverage: { poweredOn: 5, measured: 5, notMeasured: 0, stale: 2 }, kpi: { readyWarn: 1, readyCrit: 2, costop: 0, diskWarn: 0, diskCrit: 3 },
        top: { ready: [{ id: 'b:1', name: 'r2', readyAvg: 15 }], disk: [{ id: 'b:2', name: 'd2', readAvg: 60, writeAvg: 10 }] } },
    ] };
  it('합 · 측정 범위 · 상위는 대기 평균 큰 순 · 디스크는 max(읽기, 쓰기) 큰 순', () => {
    const v = contentionView(resp, []);
    expect([v.readyCrit, v.readyWarn, v.diskCrit, v.notMeasured, v.stale]).toEqual([3, 3, 4, 1, 2]);
    expect(v.ready.map((x) => [x.name, x.vcenterId])).toEqual([['r2', 'b'], ['r1', 'a']]);
    expect(v.disk.map((x) => x.name)).toEqual(['d1', 'd2']);
    expect(diskLatOf({ readAvg: null, writeAvg: null })).toBeNull();
    expect(v.th.readyCrit).toBe(10);
  });
});

describe('VM 구성 점검', () => {
  const resp = { summary: true, topN: 5, codes: { question: 'crit', consolidation: 'warn', 'cdrom-connected': 'warn', 'cbt-off': 'info', 'cpu-limit': 'warn' },
    rows: [
      { vcenterId: 'a', vms: 10, withFindings: 4, crit: 1, warn: 3, notCollected: 1, byCode: { question: 1, consolidation: 2, 'cbt-off': 5, 'cdrom-connected': 1, 'cpu-limit': 0 },
        top: { question: [{ id: 'a:1', name: 'zz', question: { text: 'q?' } }] } },
      { vcenterId: 'b', vms: 5, withFindings: 1, crit: 0, warn: 1, notCollected: 0, byCode: { consolidation: 1 }, top: { question: [{ id: 'b:1', name: 'aa' }] } },
    ] };
  it('심각 · 경고 코드만(정보 수준 · 0건 제외) · 심각이 먼저 · 이름 순 질문 목록', () => {
    const v = hygieneView(resp, []);
    expect(v.codes.map((c) => [c.code, c.n])).toEqual([['question', 1], ['consolidation', 3], ['cdrom-connected', 1]]);
    expect(v.consolidation).toBe(3);
    expect(v.notCollected).toBe(1);
    expect(v.questions.map((x) => x.name)).toEqual(['aa', 'zz']);
    expect(v.codes[0].title).not.toBe('question');   // 도구 문구(vmHygieneText)를 쓴다
  });
  it('고른 법인만', () => {
    const v = hygieneView(resp, ['b']);
    expect(v.crit).toBe(0);
    expect(v.codes.map((c) => c.code)).toEqual(['consolidation']);
  });
});
