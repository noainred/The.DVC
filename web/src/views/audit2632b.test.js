/**
 * audit2632b.test.js — v2.632 감사 그룹 B(웹 스토리지 합계 일관성).
 *
 * - WEB2632-01·AX1-2632-04: /summary storage.capacityTB 는 v2.631 부터 '사용량을 읽은 DS 만' 이다. 설치 용량 표시와
 *   프로비저닝 비교(할당/물리)는 capacityTBAll 을 써야 한다 — 아니면 미상 DS 가 많을수록 과할당이 거짓으로 부푼다.
 * - WEB2632-02: 개발 포탈 요약의 vCenter별 기여도 표가 첫 수집 중·비활성 행의 0 을 '합계' 에 더하지 않는다
 *   (V6 corpContribution 을 재사용 — 형제 비대칭 해소).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { capacityCards, totalTiles, corpContribution, contribNote, dsUnknownMark, physStorageTB } from '../version_6/v6Data.js';
import { stripComments } from '../test/_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => stripComments(fs.readFileSync(path.join(HERE, rel), 'utf8'));

const S = {
  compute: { cpuCores: 100, memTotalGB: 1000 },
  allocation: { vcpuAllocated: 200, ramAllocatedGB: 800, provisionedStorageTB: 150, vcpuPerCore: 2 },
  storage: { capacityTB: 100, capacityTBAll: 200, usedTB: 60, usageUnknown: 4 },
  counts: { clusters: 1 }, power: {},
};

describe('WEB2632-01·AX1-2632-04 설치 용량 기준', () => {
  it('프로비저닝 비율의 분모는 capacityTBAll(75%, 과할당 경고 아님)', () => {
    const sto = capacityCards(S).find((c) => c.id === 'sto');
    expect(sto.allocPct).toBe(75);
    expect(sto.warn).toBe(false);
    expect(sto.phys).toBe('200 TB');
    expect(sto.used).toContain('사용량 모름 DS 4개 제외');
  });
  it('스토리지 용량 타일은 설치 용량', () => {
    expect(totalTiles(S).find((t) => t.label === '스토리지 용량').value).toBe('200 TB');
  });
  it('옛 응답(capacityTBAll 없음)은 capacityTB 로 떨어지고, 둘 다 없으면 null', () => {
    expect(physStorageTB({ capacityTB: 100 })).toBe(100);
    expect(physStorageTB({})).toBe(null);
    const sto = capacityCards({ ...S, storage: { capacityTB: 0, capacityTBAll: 0 } }).find((c) => c.id === 'sto');
    expect(sto.allocPct).toBe(null);
  });
  it('개발 포탈 Summary.jsx 는 설치 용량으로 KPI·오버커밋 막대를 그린다', () => {
    const src = read('Summary.jsx');
    expect(src).toMatch(/physStorageTB\(st\)/);
    expect(src).not.toMatch(/OverBar title="스토리지" physical=\{st\.capacityTB\}/);
    expect(src).not.toMatch(/label="전체 스토리지" value=\{fmt\(st\.capacityTB\)\}/);
    // 물리 0 이면 '0%' 가 아니라 '—'
    expect(src).toMatch(/ratio == null \? '—'/);
  });
});

describe('WEB2632-02 기여도 표', () => {
  const s = { byVcenter: [
    { id: 'a', name: 'A', status: 'connected', hosts: 10, vms: 100, cpuCores: 20, memTotalGB: 100, storageTotalTB: 5, datastoresUsageUnknown: 2, vcpuAllocated: 50, ramAllocatedGB: 60, provisionedTB: 4, powerKw: 1 },
    { id: 'b', name: 'B', status: 'pending', hosts: 0, vms: 0, cpuCores: 0, memTotalGB: 0, storageTotalTB: 0, datastoresUsageUnknown: 0, vcpuAllocated: 0, ramAllocatedGB: 0, provisionedTB: 0, powerKw: 0 },
  ] };
  it('첫 수집 중 행은 — 이고 합계에서 빠지며 개수를 밝힌다', () => {
    const c = corpContribution(s);
    expect(c.rows[1].hosts).toBe(null);
    expect(c.total.hosts).toBe(10);
    expect(c.excluded).toBe(1);
    expect(c.dsUnknown).toBe(2);
    expect(contribNote(c)).toContain('사용량 미상 2개 제외');
    expect(dsUnknownMark(c.rows[0])).toBe('미상 2');
    expect(dsUnknownMark(c.rows[1])).toBe('');
  });
  it('개발 포탈 Summary.jsx 가 corpContribution 을 쓰고 byVcenter 를 직접 합산하지 않는다', () => {
    const src = read('Summary.jsx');
    expect(src).toMatch(/corpContribution\(s\)/);
    expect(src).toMatch(/contribTotalLabel\(contrib\)/);
    expect(src).not.toMatch(/s\.byVcenter\.reduce\(/);
    expect(src).not.toMatch(/\{s\.byVcenter\.map\(\(r\) => \(\s*<tr/);
  });
  it('V6 요약 표도 스토리지 셀에 미상 표지를 단다', () => {
    const src = read('../version_6/pages/Summary.jsx');
    expect(src).toMatch(/dsUnknownMark\(r\)/);
    expect(src).toMatch(/contrib\.dsUnknown > 0/);
  });
});
