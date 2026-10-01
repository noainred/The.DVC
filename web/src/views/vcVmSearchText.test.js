import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vmSearchTerm, vmSearchSummary, vcNameOf, powerLabel, memText } from './vcVmSearchText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('전체 vCenter VM 이름 조회(v2.671)', () => {
  it('한 글자는 조회하지 않는다 · 앞뒤 공백 제거', () => {
    expect(vmSearchTerm('w')).toBe('');
    expect(vmSearchTerm('  web ')).toBe('web');
    expect(vmSearchTerm(null)).toBe('');
  });
  it('요약 — 없음 · 상한으로 잘림을 밝힌다', () => {
    expect(vmSearchSummary('web', null)).toContain('찾는 중');
    expect(vmSearchSummary('web', { total: 0, items: [] })).toContain('없습니다');
    const s = vmSearchSummary('web', { total: 128, items: [{ vcenterId: 'a' }, { vcenterId: 'b' }, { vcenterId: 'a' }] });
    expect(s).toContain('128대'); expect(s).toContain('앞 3대만 표시'); expect(s).toContain('2개 vCenter');
    expect(vmSearchSummary('web', { total: 2, items: [{ vcenterId: 'a' }, { vcenterId: 'a' }] })).not.toContain('앞');
  });
  it('표시 도우미 — 모르면 —', () => {
    expect(vcNameOf([{ id: 'vc1', name: 'AZ' }], 'vc1')).toBe('AZ');
    expect(vcNameOf([], 'vc9')).toBe('vc9');
    expect(powerLabel('POWERED_ON')).toBe('On'); expect(powerLabel(null)).toBe('—');
    expect(memText(8192)).toBe('8 GB'); expect(memText(null)).toBe('—'); expect(memText('')).toBe('—');
  });
  it('화면은 이름 전용 조회를 쓰고 권한(inv.vms)을 먼저 본다 · 폴링하지 않는다', () => {
    const src = fs.readFileSync(path.join(HERE, 'VCenters.jsx'), 'utf8');
    expect(src).toMatch(/nameOnly: '1'/);
    expect(src).toMatch(/can\('inv\.vms'\)/);
    expect(src).not.toMatch(/usePolling\('\/vms'/);
  });
});
