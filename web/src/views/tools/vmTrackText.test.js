// v3.10.20 — 순증감 · 생성 · 삭제 요약 한 벌: 차이(미집계)를 숨기지 않는다 · 허브 카드와 도구가 같은 함수를 쓴다
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { vmNetSummary, vmNetMetaText, vmNetUnaccountedTitle, signed } from './vmTrackText.js';

const P = (total, added = 0, removed = 0, extra = {}) => ({ total, added, removed, ...extra });

describe('vmNetSummary', () => {
  it('순증감 = 마지막 − 처음 · 생성 · 삭제 합 · 미집계 = 순증감 − (생성 − 삭제) · 기준선 · 건너뛴 슬롯 수', () => {
    const s = vmNetSummary([P(100, 0, 0, { baseline: true }), P(104, 5, 1), P(110, 2, 0, { skipped: 1 })]);
    expect(s).toEqual({ net: 10, added: 7, removed: 1, unaccounted: 4, baselines: 1, skippedSlots: 1 });
    expect(vmNetSummary([P(100), P(103, 3, 0)]).unaccounted).toBe(0);
    expect(vmNetSummary([P(100), P(97, 0, 3)]).unaccounted).toBe(0);
  });
  it('점이 없거나 total 이 수가 아니면 net · 미집계 null(화면 —) · 문자열 수치는 수로', () => {
    expect(vmNetSummary([])).toEqual({ net: null, added: 0, removed: 0, unaccounted: null, baselines: 0, skippedSlots: 0 });
    expect(vmNetSummary(null).net).toBe(null);
    expect(vmNetSummary([{ total: 'x' }]).net).toBe(null);
    expect(vmNetSummary([{ total: '10', added: '1' }, { total: '12' }])).toMatchObject({ net: 2, added: 1, unaccounted: 1 });
  });
  it('문구 — 차이가 없으면 생성 · 삭제만, 있으면 미집계 ±N · title 은 이유(기준선 · 건너뜀)를 적는다 · 데모 백필(생성 0 · 삭제 0 · 순증 +61)도 숨기지 않는다', () => {
    expect(vmNetMetaText(vmNetSummary([P(100), P(103, 3, 0)]))).toBe('생성 +3 · 삭제 −0');
    const demo = vmNetSummary([P(2181, 0, 0, { baseline: true }), P(2200), P(2242)]);
    expect(vmNetMetaText(demo)).toBe('생성 +0 · 삭제 −0 · 미집계 +61');
    expect(vmNetUnaccountedTitle(demo)).toMatch(/차이 \+61/); expect(vmNetUnaccountedTitle(demo)).toMatch(/기준선 슬롯 1개/);
    expect(vmNetUnaccountedTitle(vmNetSummary([P(100), P(103, 3, 0)]))).toBe('');
    expect(vmNetMetaText(vmNetSummary([]))).toBe('');
    expect(signed(-3)).toBe('-3'); expect(signed(0)).toBe('0'); expect(signed(1234)).toBe('+1,234');
  });
  it('소스 계약 — 허브 카드(VCenters TrendKpis)와 VM 수량 추이 도구가 vmNetSummary 를 쓰고 따로 reduce 하지 않는다', () => {
    const vc = fs.readFileSync(new URL('../VCenters.jsx', import.meta.url), 'utf8');
    expect(vc).toMatch(/vmNetSummary\(pts\)/); expect(vc).toMatch(/vmNetMetaText\(/); expect(vc).not.toMatch(/pts\.reduce\(\(a, p\) => a \+ \(p\.added/);
    const t = fs.readFileSync(new URL('./VmTrackTool.jsx', import.meta.url), 'utf8');
    expect(t).toMatch(/vmNetSummary\(points\)/); expect(t).not.toMatch(/points\.reduce\(\(a, p\) => a \+ \(p\.added/);
    expect(t).toMatch(/vmNetUnaccountedTitle\(/);
  });
});
