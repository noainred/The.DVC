// v2.962 — 비교 세트 문구 · 비율 · 후보 · 주소 규칙.
import { describe, it, expect } from 'vitest';
import {
  fmtIops, fmtMs, fmtPct, METRICS, kindLabel, kindBadge, sourceText, reasonText, ratioText, ppText, idsFromHash, hashForIds, normalizeIds,
  candidatesFrom, presetsFrom, labelFor, matrixRows, chartRows, showDots, gridText, SLOT_LABELS, SLOT_COLORS, MAX_TARGETS, wideSpread, axisIops,
} from './compareSetText.js';

const DATA = {
  datacenters: [{ id: 'dc-kr', name: '서울', servers: 2, arrays: 1 }, { id: 'dc-us', name: '미국', servers: 0, arrays: 1 }, { id: '__none__', name: '(법인 미지정)', servers: 1, arrays: 0 }],
  bm: {
    servers: [
      { id: 's1', name: 'db-01', datacenterId: 'dc-kr', datacenterName: '서울', groups: ['DB'], enabled: true },
      { id: 's2', name: 'db-02', datacenterId: 'dc-kr', datacenterName: '서울', groups: ['DB', 'HPC'], enabled: true },
      { id: 's3', name: 'old', datacenterId: '', datacenterName: '(법인 미지정)', groups: [], enabled: false },
    ],
    groups: [{ name: 'DB', servers: 2 }, { name: 'HPC', servers: 1 }, { name: '(그룹 없음)', servers: 1 }],
  },
  san: { arrays: [
    { id: 'st1', name: 'PMAX-KR', type: 'powermax', serial: '0001', datacenterId: 'dc-kr', datacenterName: '서울' },
    { id: 'st2', name: 'VMAX-US', type: 'vmax', serial: '0002', datacenterId: 'dc-us', datacenterName: '미국' },
    { id: 'st3', name: 'NEW', type: 'powermax', serial: '', datacenterId: 'dc-us', datacenterName: '미국' },
  ] },
};

describe('compareSetText', () => {
  it('형식 — 못 읽은 값은 단위 없이 —', () => {
    expect(fmtIops(null)).toBe('—'); expect(fmtIops(12345.6)).toBe('12,346 IOPS'); expect(fmtIops(12.34)).toBe('12.3 IOPS');
    expect(fmtMs(null)).toBe('—'); expect(fmtMs(0.834)).toBe('0.83 ms'); expect(fmtMs(7.46)).toBe('7.5 ms');
    expect(fmtPct('')).toBe('—'); expect(fmtPct(35)).toBe('35.0%');
    expect(METRICS.map((m) => m.k)).toEqual(['tput', 'iops', 'lat', 'busy']);
    expect(axisIops(48709)).toBe('48.7k'); expect(axisIops(40000)).toBe('40k'); expect(axisIops(600)).toBe('600'); expect(axisIops(2_500_000)).toBe('2.5M'); expect(axisIops(null)).toBe('');
    expect(SLOT_LABELS).toEqual(['A', 'B', 'C', 'D']); expect(SLOT_COLORS).toHaveLength(MAX_TARGETS);
  });
  it('종류 라벨 · 배지 · 출처 · 사유 문장(비교 세트 코드 먼저 · 나머지는 SAN 비교 문장)', () => {
    expect(kindLabel('bm')).toBe('베어메탈 서버'); expect(kindLabel('bmc')).toBe('법인 베어메탈 합계'); expect(kindLabel('san', 'powermax')).toBe('PowerMax');
    expect(kindBadge('san', 'vmax')).toBe('purple'); expect(kindBadge('bmg')).toBe('teal');
    expect(sourceText('switch-port')).toMatch(/스위치 포트/); expect(sourceText('array-fe-cpu')).toMatch(/CPU/); expect(sourceText('zz')).toBe('');
    expect(reasonText('fe-ssh')).toMatch(/SSH/); expect(reasonText('no-iops-data')).toMatch(/v2\.962/); expect(reasonText('serial-unmatched')).toMatch(/시리얼/);
    expect(reasonText('busy-avg-unknown')).toMatch(/v2\.971/);
    expect(reasonText('')).toBe(''); expect(reasonText('알 수 없는 원문')).toBe('알 수 없는 원문');
  });
  it('기준(A) 대비 — 배율 · %p · 기준 0/없음은 빈 문자열', () => {
    expect(ratioText(180, 100)).toBe('×1.80'); expect(ratioText(50, 100)).toBe('×0.50'); expect(ratioText(2000, 100)).toBe('×20');
    expect(ratioText(5, 0)).toBe(''); expect(ratioText(null, 5)).toBe('');
    expect(ppText(70, 62.5)).toBe('+7.5%p'); expect(ppText(60, 68.9)).toBe('−8.9%p'); expect(ppText(5, 5.01)).toBe('±0%p'); expect(ppText(null, 1)).toBe('');
  });
  it('주소 — 해시 왕복 · 모르는 종류 · 중복 · 상한 4', () => {
    const h = hashForIds(['san:0001', 'bm:s1', 'bmg:한글 그룹', 'bmc:dc-kr', 'bm:s2']);
    expect(h.startsWith('#/tools/bm-storage/set/')).toBe(true);
    expect(idsFromHash(h)).toEqual(['san:0001', 'bm:s1', 'bmg:한글 그룹', 'bmc:dc-kr']);
    expect(idsFromHash('#/tools/bm-storage/compare')).toEqual([]); expect(idsFromHash('#/tools/bm-storage/set/%E0%A4%A')).toEqual([]);
    expect(normalizeIds(['bm:a', 'bm:a', 'x:1', '', 'san:'])).toEqual(['bm:a']);
    expect(hashForIds([])).toBe('#/tools/bm-storage/set');
  });
  it('후보 — SAN 은 시리얼이 있어야 고를 수 있다 · 비활성 서버 · ‘그룹 없음’ · 서버 없는 법인은 뺀다', () => {
    const c = candidatesFrom(DATA);
    expect(c.san.map((x) => [x.id, !!x.disabled])).toEqual([['san:0001', false], ['san:0002', false], ['san-none:st3', true]]);
    expect(c.bm.map((x) => x.id)).toEqual(['bm:s1', 'bm:s2']);
    expect(c.bmg.map((x) => [x.id, x.dcId])).toEqual([['bmg:DB', 'dc-kr'], ['bmg:HPC', 'dc-kr']]);
    expect(c.bmc.map((x) => [x.id, x.dcId])).toEqual([['bmc:dc-kr', 'dc-kr'], ['bmc:__none__', '']]);
    const p = presetsFrom(c);
    expect(p.find((x) => x.k === 'san2').ids).toEqual(['san:0001', 'san:0002']);
    expect(p.find((x) => x.k === 'corp')).toMatchObject({ ok: true, ids: ['san:0001', 'bmc:dc-kr'], label: '서울: SAN ↔ 베어메탈' });
    expect(p.find((x) => x.k === 'groups').ok).toBe(true);
    expect(presetsFrom(candidatesFrom({})).every((x) => !x.ok)).toBe(true);
    expect(labelFor('bm:s2', c, [])).toBe('db-02'); expect(labelFor('bm:zz', c, [{ id: 'bm:zz', name: '지움' }])).toBe('지움'); expect(labelFor('bm:qq', c, [])).toBe('qq');
  });
  it('비교 표 — 첫 대상이 기준 · 못 읽은 값은 — 와 사유 · 용량은 %p · 지표는 배율', () => {
    const T = (pct, tput, lat, extra = {}) => ({ capacity: pct == null ? null : { pct, usedBytes: 1, totalBytes: 2 },
      metrics: { tput: { avgTotal: tput, peakTotal: tput == null ? null : tput * 2, source: 'switch-port' }, iops: { avgTotal: null, peakTotal: null, reason: 'fe-ssh' },
        lat: { avgTotal: lat, peakTotal: lat }, busy: { avgTotal: 10, peakTotal: 20 } }, ...extra });
    const rows = matrixRows([T(60, 100, 2), T(70, 250, null), T(null, null, 4, { missing: true, reason: 'unknown-target' })]);
    expect(rows.map((r) => r.key)).toEqual(['cap-pct', 'cap-used', 'tput-avg', 'tput-peak', 'iops-avg', 'iops-peak', 'lat-avg', 'lat-peak', 'busy-avg', 'busy-peak']);
    const cap = rows[0].cells; expect(cap[1].delta).toBe('+10.0%p'); expect(cap[2].text).toBe('—'); expect(cap[2].reason).toBe('unknown-target');
    const tp = rows.find((r) => r.key === 'tput-avg').cells; expect(tp[0].delta).toBe(''); expect(tp[1].delta).toBe('×2.50'); expect(tp[2].reason).toBe('no-data');
    expect(rows.find((r) => r.key === 'iops-avg').cells[0]).toMatchObject({ text: '—', reason: 'fe-ssh' });
    expect(rows.find((r) => r.key === 'lat-avg').cells[2].delta).toBe('×2.00');
    expect(matrixRows([])).toHaveLength(10);
  });
  it('차트 데이터 · 점 표시 · 격자 문구', () => {
    const rows = chartRows([0, 1], [{ metrics: { iops: { avg: [1, null], peak: [2, 3] } } }, { metrics: {} }], 'iops');
    expect(rows).toEqual([{ t: 0, 'A|avg': 1, 'A|peak': 2, 'B|avg': null, 'B|peak': null }, { t: 1, 'A|avg': null, 'A|peak': 3, 'B|avg': null, 'B|peak': null }]);
    // 로그 축 — 0 이하는 빈칸(0 으로 그리지 않는다) · null 은 그대로
    const lg = chartRows([0], [{ metrics: { iops: { avg: [0], peak: [5] } } }], 'iops', { log: true });
    expect(lg).toEqual([{ t: 0, 'A|avg': null, 'A|peak': 5 }]);
    expect(wideSpread([{ metrics: { iops: { avgTotal: 48709 } } }, { metrics: { iops: { avgTotal: 385 } } }], 'iops')).toBe(true);
    expect(wideSpread([{ metrics: { iops: { avgTotal: 100 } } }, { metrics: { iops: { avgTotal: 300 } } }], 'iops')).toBe(false);
    expect(wideSpread([{ metrics: { iops: { avgTotal: 100 } } }, { metrics: { iops: { avgTotal: null } } }], 'iops')).toBe(false);
    expect(showDots(new Array(7))).toBe(true); expect(showDots(new Array(120))).toBe(false);
    expect(gridText(600_000)).toBe('10분 격자'); expect(gridText(3_600_000)).toBe('1시간 격자'); expect(gridText(null)).toBe('');
  });
});
