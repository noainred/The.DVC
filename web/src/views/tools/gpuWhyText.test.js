import { describe, it, expect } from 'vitest';
import { whyChip, whyBannerItems, vmChips, activityBar, WHY_CODES, srcText } from './gpuWhyText.js';

describe('gpuWhyText (v2.653)', () => {
  it('코드마다 짧은 글자·조치가 있고 모르는 코드는 원인 미상', () => {
    for (const c of WHY_CODES) { const x = whyChip({ code: c }); expect(x.short).toBeTruthy(); expect(x.title).toBeTruthy(); }
    expect(whyChip({ code: 'zzz' }).short).toBe('원인 미상');
    expect(whyChip(null)).toBeNull();
  });
  it('근거를 짧은 글자에 싣는다 — 버전·일부·분', () => {
    expect(whyChip({ code: 'edge-old', detail: '2.648.0' }).short).toContain('2.648.0');
    expect(whyChip({ code: 'partial', detail: '1/4' }).short).toContain('1/4');
    expect(whyChip({ code: 'edge-no-report', agent: 'EDGE-WA' }).title).toContain('EDGE-WA');
  });
  it('배너는 일부만 수집을 올리지 않는다', () => {
    const b = whyBannerItems([{ vcenterId: 'WA', code: 'edge-no-report', hosts: 3, vms: 12 }, { vcenterId: 'OC', code: 'partial', hosts: 1 }]);
    expect(b).toHaveLength(1); expect(b[0].text).toContain('WA'); expect(b[0].text).toContain('12');
  });
  it('칩은 켜진 VM 먼저·글자 수 상한·나머지 +N', () => {
    const r = vmChips([{ name: 'OFF-1', on: false }, { name: 'A', on: true }, { name: 'B', on: true }, { name: 'C', on: true }, { name: 'D', on: true }]);
    expect(r.chips.map((c) => c.name)).toEqual(['A', 'B', 'C']); expect(r.more).toBe(2);
    const long = vmChips(['X'.repeat(30), 'Y'.repeat(30)]);
    expect(long.chips).toHaveLength(1); expect(long.more).toBe(1);
    expect(vmChips(null)).toEqual({ chips: [], more: 0 });
  });
  it('동작 막대 비율 · 합 0 이면 null', () => {
    expect(activityBar({ busy: 1, held: 1, idle: 0, unknown: 2 })).toEqual({ busy: 25, held: 25, idle: 0, unknown: 50, total: 4 });
    expect(activityBar({ busy: 0 })).toBeNull();
    expect(srcText('esxi')).toBe('ESXi'); expect(srcText(null)).toBe('');
  });
  it('문구에 백틱이 없다', async () => {
    const fs = await import('node:fs'); const src = fs.readFileSync(new URL('./gpuWhyText.js', import.meta.url), 'utf8');
    for (const c of WHY_CODES) expect(whyChip({ code: c }).title).not.toMatch(/`/);
    expect(src.length).toBeGreaterThan(0);
  });
});
