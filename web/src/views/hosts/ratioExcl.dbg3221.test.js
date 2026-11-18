// dbg3221 8회차 — Hypervisor ‘분석’ 여러 법인 비율(ratiosOf): 할당을 전부 못 읽은 법인(서버 vcpu · memVmMB null)의 코어 · 메모리가 분모에 남던 결함.
//   예전: 법인 A(vcpu null · 코어 100) + 법인 B(vcpu 200 · 코어 100) → 분석 1.0 : 1 이상 · ‘법인별’ 요약(corpKpis v3.19.1)은 2.0 : 1 — 같은 범위가 두 값으로 갈렸다.
//   지금: 그 법인을 분자 · 분모 양쪽에서 빼고 ‘vCPU 못 읽은 N곳 제외’ 로 밝힌다(corpKpis 와 같은 입력 · 같은 값).
import { describe, it, expect } from 'vitest';
import { sumHostRows, kpiView, allocMarks } from './hostInsightText.js';
import { corpKpis } from '../hostCorpText.js';

const GB = 1024;
const A = { id: 'A', hosts: { total: 2 }, cores: 100, capUnknown: 0, vcpu: null, vcpuUnknown: 10, memTotalMB: 1000 * GB, memVmMB: null, memUnknown: 10, vcpuPerCore: null, ramPct: null };
const B = { id: 'B', hosts: { total: 2 }, cores: 100, capUnknown: 0, vcpu: 200, vcpuUnknown: 0, memTotalMB: 1000 * GB, memVmMB: 500 * GB, memUnknown: 0, vcpuPerCore: 2, ramPct: 50 };
const corpRatio = (rows) => corpKpis({ corps: rows.map((r) => ({ ...r, hosts: r.hosts.total })), totals: {} }).find((k) => k.key === 'ratio');

describe('dbg3221 8회차 — 할당을 전부 못 읽은 법인은 비율의 분자 · 분모 양쪽에서 뺀다', () => {
  it('vCPU : 코어 — ‘법인별’ 요약(corpKpis)과 같은 값', () => {
    const s = sumHostRows([A, B]);
    expect(s.vcpuPerCore).toBe(2);
    expect(corpRatio([A, B]).value).toBe('2.0 : 1');
    const am = allocMarks(s);
    expect(am.ratioOne).toBe('2 : 1');   // 비율에 든 법인(B)은 VM 을 다 읽었다 — ‘이상’ 아님
    expect(am.vcpuExclNote).toBe('vCPU 못 읽은 1곳 제외');
    expect(kpiView(s, 2).find((k) => k.key === 'cores').sub).toContain('코어 하나에 2 · vCPU 못 읽은 1곳 제외');
  });

  it('메모리 % — 같은 규칙(B 만 → 50%)', () => {
    const s = sumHostRows([A, B]);
    expect(s.ramPct).toBe(50);
    const am = allocMarks(s);
    expect(am.ram).toBe('50%');
    expect(am.memExclNote).toBe('메모리 할당 못 읽은 1곳 제외');
    expect(kpiView(s, 2).find((k) => k.key === 'mem').sub).toContain('50% · 메모리 할당 못 읽은 1곳 제외');
  });

  it('여러 법인 무작위 대조 — 분석 비율과 corpKpis 비율이 같다', () => {
    let seed = 7;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let i = 0; i < 200; i++) {
      const rows = Array.from({ length: 2 + rnd(4) }, (_, j) => {
        const cores = 8 + rnd(200); const unread = rnd(3) === 0;
        return { id: `c${j}`, hosts: { total: 1 + rnd(5) }, cores, capUnknown: 0, vcpu: unread ? null : rnd(800), vcpuUnknown: unread ? 1 + rnd(9) : 0, memTotalMB: 1000 * GB, memVmMB: 100 * GB, memUnknown: 0 };
      });
      const s = sumHostRows(rows);
      const k = corpRatio(rows);
      const expected = k.value === '—' ? null : Number(k.value.replace(' : 1', ''));
      expect(s.vcpuPerCore).toBe(expected);
    }
  });

  it('일부 VM 만 못 읽은 법인이 비율에 들면 ‘이상’ · 다 뺀 법인의 못 읽은 VM 은 비율 표지에 들지 않는다', () => {
    const C = { ...B, id: 'C', vcpuUnknown: 3 };
    expect(allocMarks(sumHostRows([A, C])).ratioOne).toBe('2 : 1 이상');
    expect(allocMarks(sumHostRows([A, B])).vcpuText).toBe('200 이상');   // 합 자체는 A 의 VM 을 못 읽어 최소값 그대로
  });

  it('모든 법인이 할당을 못 읽었으면 비율 ‘—’ 이고 ‘제외’ 문구도 붙이지 않는다', () => {
    const s = sumHostRows([A, { ...A, id: 'A2' }]);
    expect(s.vcpuPerCore).toBeNull();
    expect(s.ramPct).toBeNull();
    const am = allocMarks(s);
    expect(am.ratioOne).toBe('—');
    expect(am.vcpuExclNote).toBe('');
    expect(am.memExclNote).toBe('');
  });

  it('비율에 넣는 법인의 코어를 못 읽었으면 0 으로 더하지 않고 null', () => {
    const s = sumHostRows([{ ...B, cores: null }, { ...B, id: 'B2' }]);
    expect(s.vcpuPerCore).toBeNull();
  });
});
