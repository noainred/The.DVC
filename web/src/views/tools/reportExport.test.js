import { describe, it, expect } from 'vitest';
import { safeFileName, exportFileName, pageSlices } from './reportExport.js';

/**
 * 리포트 PDF/JPG 저장의 **순수 부분**만 고정한다(v2.449).
 * 캡처 자체(html2canvas)는 DOM·캔버스가 필요해 node 환경 테스트가 불가하므로,
 * 파일명 생성과 A4 페이지 분할처럼 틀리면 조용히 망가지는 계산을 여기서 회귀로 잡는다.
 */

describe('safeFileName', () => {
  it('경로·와일드카드 문자를 _ 로 바꾼다(한글은 보존)', () => {
    expect(safeFileName('자원축소_LES/AIR:PS*01')).toBe('자원축소_LES_AIR_PS_01');
  });
  it('빈 값이면 report 로 폴백한다', () => {
    expect(safeFileName('')).toBe('report');
    expect(safeFileName(null)).toBe('report');
  });
  it('과도하게 긴 이름은 120자로 자른다(파일시스템 상한 회피)', () => {
    expect(safeFileName('a'.repeat(300)).length).toBe(120);
  });
});

describe('exportFileName', () => {
  it('VM·기간·타임스탬프·확장자를 담는다', () => {
    const n = exportFileName('LESAAIRPS01', 90, 'pdf', new Date(2026, 8, 9, 7, 5));
    expect(n).toBe('자원축소근거_LESAAIRPS01_최근90일_20260909-0705.pdf');
  });
  it('VM 이름의 공백은 _ 가 되어 셸에서 다루기 쉬운 이름이 된다', () => {
    const n = exportFileName('web 01', 7, 'jpg', new Date(2026, 0, 2, 3, 4));
    expect(n).toBe('자원축소근거_web_01_최근7일_20260102-0304.jpg');
  });
});

describe('pageSlices', () => {
  const W = 1000;
  it('한 페이지에 들어가면 1장', () => {
    // A4 가용 높이/폭 = 281/194mm → 1000px 폭이면 한 장에 약 1448px 까지 들어간다.
    const s = pageSlices(W, 800);
    expect(s.length).toBe(1);
    expect(s[0]).toMatchObject({ sy: 0, sh: 800 });
  });
  it('길면 여러 장으로 나누고 조각이 원본 전체를 빠짐없이 덮는다', () => {
    const H = 5000;
    const s = pageSlices(W, H);
    expect(s.length).toBeGreaterThan(1);
    expect(s[0].sy).toBe(0);
    // 조각들이 연속(앞 조각 끝 = 다음 조각 시작)이고 합이 전체 높이와 같아야 한다 —
    // 어긋나면 PDF 에서 몇 픽셀씩 잘리거나 겹쳐 보인다.
    for (let i = 1; i < s.length; i++) expect(s[i].sy).toBe(s[i - 1].sy + s[i - 1].sh);
    expect(s.reduce((a, x) => a + x.sh, 0)).toBe(H);
  });
  it('마지막 조각은 남은 만큼만 잘라 빈 여백을 늘리지 않는다', () => {
    const s = pageSlices(W, 5000);
    const last = s[s.length - 1];
    expect(last.sh).toBeLessThanOrEqual(s[0].sh);
    expect(last.sy + last.sh).toBe(5000);
  });
  it('그릴 높이(mm)는 페이지 가용 높이를 넘지 않는다', () => {
    for (const p of pageSlices(W, 5000)) expect(p.hMm).toBeLessThanOrEqual(297 - 8 * 2 + 1e-9);
  });
  it('비정상 크기는 빈 계획(예외 없이)', () => {
    expect(pageSlices(0, 100)).toEqual([]);
    expect(pageSlices(100, 0)).toEqual([]);
    expect(pageSlices(NaN, NaN)).toEqual([]);
  });
});
