import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vmSearchTerm, vmSearchSummary, vcNameOf, powerLabel, memText, vmSearchScopeParams, vmSearchScopeText } from './vcVmSearchText.js';

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

describe('v3.12.2 — VM 이름 조회가 허브 범위(리전 · vCenter)를 따른다', () => {
  it('vmSearchScopeParams — vCenter 가 있으면 vCenter 만 · 없으면 리전 · 둘 다 없으면 빈 객체(전체 — v2.671)', () => {
    expect(vmSearchScopeParams({ region: '유럽', vcenterId: 'vc1' })).toEqual({ vcenterId: 'vc1' });
    expect(vmSearchScopeParams({ region: ' 유럽 ' })).toEqual({ region: '유럽' });
    expect(vmSearchScopeParams({})).toEqual({}); expect(vmSearchScopeParams(null)).toEqual({});
  });
  it('범위 글자 — scopeLabel 의 ‘전체’ 만 ‘전체 vCenter’ · 0건 문구에 범위를 적는다', () => {
    expect(vmSearchScopeText('전체')).toBe('전체 vCenter'); expect(vmSearchScopeText('')).toBe('전체 vCenter');
    expect(vmSearchScopeText('리전 유럽 · 3법인')).toBe('리전 유럽 · 3법인');
    expect(vmSearchSummary('web', { total: 0, items: [] }, '리전 유럽 · 3법인')).toBe('VM 이름에 "web" 이 들어간 VM 이 없습니다(리전 유럽 · 3법인).');
    expect(vmSearchSummary('web', { total: 0, items: [] })).toBe('VM 이름에 "web" 이 들어간 VM 이 없습니다(전체 vCenter).');
  });
  it('소스 계약 — 화면이 범위를 요청과 제목에 싣고, 범위가 바뀌면 다시 찾는다', () => {
    const src = fs.readFileSync(path.join(HERE, 'VCenters.jsx'), 'utf8');
    expect(src).toMatch(/limit: VM_SEARCH_LIMIT, \.\.\.vmSearchScopeParams\(scope\) \}/);
    expect(src).toMatch(/\[term, allowed, scope\?\.region, scope\?\.vcenterId\]/);
    expect(src).toMatch(/<b>VM 이름 검색 — \{scopeText\}<\/b>/);
    expect(src).toMatch(/<VmNameSearch term=\{vmSearchTerm\(query\)\} sites=\{sites\} scope=\{\{ region: regSel, vcenterId: vcSel \}\} scopeText=\{vmSearchScopeText\(kpiScope\)\} \/>/);
  });
});
