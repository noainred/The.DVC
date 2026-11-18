// dbg3221 3회차 — Hypervisor ‘분석’ 의 vCPU · 메모리 할당 부분 합 표지.
//   서버(vmSums.vmAllocOf)는 VM 을 전부 못 읽었을 때만 vcpu · memVmMB 를 null 로, 일부만 못 읽었으면 읽은 VM 만의 합(최소값)을 준다.
//   예전 화면: 요약 카드 ‘물리 코어’ 부제 · 통합 비율(vCPU : 물리 코어 · 메모리 %) · 분포 요약 줄이 부분 합을 전체처럼 보였다(‘모름’ · ‘이상’ 표지 없음).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../test/_stripComments.js';
import { sumHostRows, kpiView, allocMarks } from './hostInsightText.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const row = (o = {}) => ({
  id: 'vc-a', hosts: { total: 2, connected: 2, maint: 0, down: 0, unread: 0 }, cores: 64, capUnknown: 0, memTotalMB: 512 * 1024,
  vms: 10, vcpu: 8, vcpuUnknown: 8, memVmMB: 16 * 1024, memUnknown: 0, vcpuPerCore: 0.1, ramPct: 3, ...o,
});
const sub = (s, key) => kpiView(s, 1).find((k) => k.key === key).sub;

describe('dbg3221 3회차 — vCPU · 메모리 할당 부분 합 표지', () => {
  it('vCPU 를 일부 VM 에서 못 읽었으면 ‘물리 코어’ 부제의 합 · 비율에 ‘이상’ + ‘vCPU 모름 N대’', () => {
    const s = sumHostRows([row()]);
    expect(sub(s, 'cores')).toBe('vCPU 8 이상 · 코어 하나에 0.1 이상 · vCPU 모름 8대');
    expect(sub(s, 'mem')).toBe('VM 에 준 것 16 GB · 3%');
  });
  it('메모리 할당을 일부 못 읽었으면 메모리 부제에도 ‘이상’ · 다 읽었으면 표지 없음', () => {
    expect(sub(sumHostRows([row({ memUnknown: 2 })]), 'mem')).toBe('VM 에 준 것 16 GB 이상 · 3% 이상 · 할당 모름 2대');
    expect(sub(sumHostRows([row({ vcpuUnknown: 0 })]), 'cores')).toBe('vCPU 8 · 코어 하나에 0.1');
  });
  it('전부 못 읽어 값이 null 이면 ‘—’ 만(단위 · ‘이상’ 없음) — 못 읽은 수는 밝힌다', () => {
    const m = allocMarks({ vcpu: null, vcpuUnknown: 10, vcpuPerCore: null, memVmMB: null, memUnknown: 10, ramPct: null });
    expect(m.vcpuPartial).toBe(false);
    expect([m.vcpuText, m.ratio, m.ratioOne, m.vmMemText, m.ram]).toEqual(['—', '—', '—', '—', '—']);
    expect(m.vcpuNote).toBe('vCPU 못 읽은 VM 10대');
    expect(m.memNote).toBe('메모리 할당 못 읽은 VM 10대');
  });
  it('여러 법인 합 — 한 곳이라도 못 읽은 VM 이 있으면 다시 낸 비율에도 ‘이상’', () => {
    const s = sumHostRows([row({ vcpuUnknown: 0 }), row({ id: 'vc-b', vcpuUnknown: 3 })]);
    const m = allocMarks(s);
    expect(m.vcpuPartial).toBe(true);
    expect(m.ratioOne).toMatch(/ : 1 이상$/);
    expect(m.vcpuNote).toBe('vCPU 못 읽은 VM 3대');
  });
  it('화면 — 통합 비율 · 메모리 비율 · 분포 요약 줄이 allocMarks 를 쓴다(서버 비율을 표지 없이 그리지 않는다)', () => {
    const src = stripComments(fs.readFileSync(path.join(here, 'HostInsight.jsx'), 'utf8'));
    expect(src).toMatch(/value:\s*am\.ratioOne/);
    expect(src).toMatch(/value:\s*am\.ram\b/);
    expect(src).toMatch(/vCPU : 코어 \$\{allocMarks\(s\)\.ratio\}/);
    expect(src).not.toMatch(/s\.vcpuPerCore\s*==\s*null\s*\?/);
    expect(src).not.toMatch(/numOrNull\(s\.ramPct\)\s*==\s*null/);
  });
});
