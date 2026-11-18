/**
 * v3.19.2 — Summary 화면의 VM 할당 합(vCPU · 메모리) 글자.
 * 서버 /summary 가 못 읽은 cpuCount · memMB 를 0 으로 더하지 않게 됐다(합 null · vcpuUnknown · ramUnknown) — 화면이 그 null 을 0 으로 되돌리지 않는다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allocUnknownOf, allocCell, allocUnknownSub, minMark, ratioKpiSub, ratioBadgeTitle, osAllocTotals } from './summaryAllocText.js';
import { corpContribution, contribNote } from './corpContribution.js';
import { ratioOrNull } from './virtRatioText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => fs.readFileSync(path.join(HERE, rel), 'utf8');

describe('allocUnknownOf — 못 읽은 VM 수(없음 · 못 읽음 · 0 이하는 0)', () => {
  it('종류별 필드를 읽는다', () => {
    expect(allocUnknownOf({ vcpuUnknown: 3, ramUnknown: 5 }, 'vcpu')).toBe(3);
    expect(allocUnknownOf({ vcpuUnknown: 3, ramUnknown: 5 }, 'ram')).toBe(5);
    for (const v of [0, -1, null, undefined, '', 'x']) expect(allocUnknownOf({ vcpuUnknown: v })).toBe(0);
    expect(allocUnknownOf(null, 'ram')).toBe(0);
  });
});

describe('allocCell — 표의 할당 합 칸', () => {
  it('하나도 못 읽음(null) → — · 미상 N · 0 이 아니라고 말한다 · 정렬 값은 빈 글자(뒤로)', () => {
    const c = allocCell(null, 2, 'vcpu');
    expect(c.text).toBe('—'); expect(c.mark).toBe('미상 2'); expect(c.sort).toBe('');
    expect(c.title).toContain('vCPU 를 하나도 읽지 못했습니다'); expect(c.title).toContain('0 이 아닙니다');
    expect(allocCell('', 2, 'ram').text).toBe('—');            // '' 는 0 이 아니다
    expect(allocCell(undefined, 0).text).toBe('—');            // 옛 응답 · 뺀 행 — 표지 없이 —
    expect(allocCell(undefined, 0).mark).toBe('');
  });
  it('일부만 못 읽음 → 값 + 미상 N(최소값)', () => {
    const c = allocCell(1234, 3, 'ram');
    expect(c.text).toBe('1,234'); expect(c.mark).toBe('미상 3'); expect(c.sort).toBe(1234);
    expect(c.title).toContain('메모리를 못 읽은 VM 3대'); expect(c.title).toContain('최소값');
  });
  it('전부 읽음 → 값만(표지 · 툴팁 없음). 0 은 읽은 값이다', () => {
    expect(allocCell(0, 0)).toEqual({ text: '0', mark: '', title: '', sort: 0 });
    expect(allocCell(56, undefined).mark).toBe('');
  });
});

describe('KPI 부제 · ≥ 표지', () => {
  it('allocUnknownSub', () => {
    expect(allocUnknownSub(4, 'vcpu')).toBe('vCPU 미상 VM 4대 제외');
    expect(allocUnknownSub(1200, 'ram')).toBe('메모리 미상 VM 1,200대 제외');
    expect(allocUnknownSub(0)).toBe(''); expect(allocUnknownSub(null)).toBe('');
  });
  it('minMark — 부분 합일 때만 ≥, 비율이 없으면 붙이지 않는다', () => {
    expect(minMark(2.1, 3)).toBe('≥ '); expect(minMark(2.1, 0)).toBe(''); expect(minMark(null, 3)).toBe('');
  });
  it('ratioKpiSub — 비율이 없는 실제 이유를 말한다(용량 미상 호스트가 먼저)', () => {
    const k = { sub: '물리 자원 미수집 — 판정 보류' };
    expect(ratioKpiSub(null, k, { allocated: null, unknown: 2, kind: 'vcpu', capSub: '용량을 못 읽은 호스트 1대 — 판정 보류' })).toBe('용량을 못 읽은 호스트 1대 — 판정 보류');
    expect(ratioKpiSub(null, k, { allocated: null, unknown: 2, kind: 'vcpu' })).toBe('VM 2대의 vCPU 를 읽지 못했습니다 — 판정 보류');
    expect(ratioKpiSub(null, k, { allocated: null, unknown: 2, kind: 'ram' })).toBe('VM 2대의 메모리를 읽지 못했습니다 — 판정 보류');
    expect(ratioKpiSub(null, k, { allocated: 10, unknown: 0 })).toBe(k.sub);                 // 물리 쪽 사유는 예전 그대로
    expect(ratioKpiSub(2.1, { sub: '정상 범위' }, { allocated: 10, unknown: 3, kind: 'vcpu' })).toBe('정상 범위 · 최소값(vCPU 미상 VM 3대 제외)');
    expect(ratioKpiSub(2.1, { sub: '정상 범위' }, { allocated: 10, unknown: 0 })).toBe('정상 범위');
  });
  it('ratioBadgeTitle — 용량 미상 문구 → 할당을 하나도 못 읽음 → 물리 미수집 순', () => {
    const fb = '물리 자원(코어·RAM)을 아직 읽지 못해';
    expect(ratioBadgeTitle({ vcpuAllocated: null, vcpuUnknown: 2 }, 'vcpu', '용량 미상', fb)).toBe('용량 미상');
    expect(ratioBadgeTitle({ vcpuAllocated: null, vcpuUnknown: 2 }, 'vcpu', null, fb)).toContain('VM 2대의 vCPU 를 하나도 읽지 못해');
    expect(ratioBadgeTitle({ ramAllocatedGB: null, ramUnknown: 5 }, 'ram', null, fb)).toContain('메모리를 하나도 읽지 못해');
    expect(ratioBadgeTitle({ vcpuAllocated: 0, vcpuUnknown: 0 }, 'vcpu', null, fb)).toBe(fb);
  });
  it('할당이 null 이면 가상화율도 null(0 : 1 이 아니다) — RatioModal 이 쓰는 ratioOrNull', () => {
    expect(ratioOrNull(null, 64)).toBe(null); expect(ratioOrNull('', 64)).toBe(null); expect(ratioOrNull(0, 64)).toBe(0);
  });
});

describe('osAllocTotals — OS 표 합계 행', () => {
  it('읽은 행만 더하고 못 읽은 VM 수를 합한다', () => {
    const t = osAllocTotals([
      { name: 'Windows', vms: 3, vcpu: 20, ramGB: 74, diskGB: 100, vcpuUnknown: 1, ramUnknown: 0, storageUnknown: 0 },
      { name: 'RHEL', vms: 3, vcpu: 3, ramGB: 4, diskGB: 50, vcpuUnknown: 1, ramUnknown: 2, storageUnknown: 1 },
      { name: 'Ubuntu', vms: 2, vcpu: null, ramGB: null, diskGB: 0, vcpuUnknown: 2, ramUnknown: 2, storageUnknown: 2 },
    ]);
    expect(t).toEqual({ vms: 8, vcpu: 23, ramGB: 78, diskGB: 150, vcpuUnknown: 4, ramUnknown: 4, storageUnknown: 3 });
  });
  it('행이 있는데 전부 못 읽었으면 합은 null(0 이 아니다) · 행이 없으면 0', () => {
    const t = osAllocTotals([{ name: 'Ubuntu', vms: 2, vcpu: null, ramGB: null, diskGB: 0, vcpuUnknown: 2, ramUnknown: 2 }]);
    expect(t.vcpu).toBe(null); expect(t.ramGB).toBe(null); expect(t.vcpuUnknown).toBe(2);
    expect(osAllocTotals([])).toEqual({ vms: 0, vcpu: 0, ramGB: 0, diskGB: 0, vcpuUnknown: 0, ramUnknown: 0, storageUnknown: 0 });
    expect(osAllocTotals(undefined).vcpu).toBe(0);
  });
  it('옛 응답(unknown 필드 없음)은 예전과 같은 합', () => {
    const t = osAllocTotals([{ vms: 1, vcpu: 2, ramGB: 4, diskGB: 8 }, { vms: 2, vcpu: 3, ramGB: 5, diskGB: 9 }]);
    expect([t.vms, t.vcpu, t.ramGB, t.diskGB, t.vcpuUnknown]).toEqual([3, 5, 9, 17, 0]);
  });
});

describe('기여도 표 — 못 읽은 VM 수를 합해 안내한다', () => {
  const row = (id, extra) => ({ id, name: id, status: 'connected', hosts: 1, vms: 2, cpuCores: 8, memTotalGB: 64, storageTotalTB: 1, provisionedTB: 1, powerKw: 1, ...extra });
  const s = { byVcenter: [
    row('a', { vcpuAllocated: 23, ramAllocatedGB: 78, vcpuUnknown: 2, ramUnknown: 2 }),
    row('c', { vcpuAllocated: null, ramAllocatedGB: null, vcpuUnknown: 2, ramUnknown: 2 }),        // VM 을 하나도 못 읽은 vCenter
    row('d', { vms: 0, vcpuAllocated: 0, ramAllocatedGB: 0, vcpuUnknown: 0, ramUnknown: 0 }),
    { id: 'p', name: 'p', status: 'pending', hosts: 0, vms: 0, vcpuAllocated: 0, ramAllocatedGB: 0, vcpuUnknown: 0, ramUnknown: 0 },
  ] };
  it('null 행은 합계에서 빠지고(0 으로 더하지 않는다) 못 읽은 VM 수가 실린다', () => {
    const c = corpContribution(s);
    expect(c.total.vcpuAllocated).toBe(23); expect(c.total.ramAllocatedGB).toBe(78);
    expect(c.vcpuUnknown).toBe(4); expect(c.ramUnknown).toBe(4);
    expect(c.rows[1].vcpuAllocated).toBe(null);
    expect(contribNote(c)).toContain('할당 열(vCPU · RAM)은 값을 읽은 VM 만 합했습니다(vCPU 미상 4대 · 메모리 미상 4대 제외)');
  });
  it('못 읽은 VM 이 없으면 안내를 붙이지 않는다(옛 응답 포함)', () => {
    const c = corpContribution({ byVcenter: [row('a', { vcpuAllocated: 5, ramAllocatedGB: 6 })] });
    expect(c.vcpuUnknown).toBe(0); expect(c.ramUnknown).toBe(0);
    expect(contribNote(c)).not.toContain('할당 열');
  });
});

describe('Summary.jsx — null 을 0 으로 되돌리는 꼴이 없다', () => {
  const s = src('./Summary.jsx');
  it('할당 합 타일 · 표 칸은 fmt()(null → 0)를 쓰지 않는다', () => {
    expect(s).not.toMatch(/fmt\(al\.vcpuAllocated\)\} sub/);
    expect(s).not.toMatch(/value=\{fmt\(al\.(vcpuAllocated|ramAllocatedGB)\)\}/);
    expect(s).not.toMatch(/fmt\(o\.(vcpu|ramGB)\)/);
    expect(s).not.toMatch(/fmt\(osAllocTotals\.(vcpu|ramGB)\)/);
    expect(s).not.toMatch(/a\.vcpu \+= r\.vcpu/);
    expect(s).toMatch(/allocCell\(o\.vcpu, allocUnknownOf\(o, 'vcpu'\), 'vcpu'\)/);
    expect(s).toMatch(/allocCell\(r\.vcpuAllocated, allocUnknownOf\(r, 'vcpu'\), 'vcpu'\)/);
    expect(s).toMatch(/allocCell\(totals\.ramAllocatedGB, contrib\.ramUnknown, 'ram'\)/);
  });
  it('오버커밋 막대는 할당을 못 읽으면 0% 가 아니라 —', () => {
    expect(s).toMatch(/phys > 0 && allocated != null \?/);
  });
});
