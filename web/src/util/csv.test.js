import { describe, it, expect } from 'vitest';
import { guardCell, csvCell, toCsv } from './csv.js';

describe('csv 수식 인젝션 가드', () => {
  it('guardCell: 수식 시작 문자는 작은따옴표로 무력화', () => {
    expect(guardCell('=HYPERLINK("http://x")')).toBe('\'=HYPERLINK("http://x")');
    expect(guardCell('+1+1')).toBe('\'+1+1');
    expect(guardCell('-2+3')).toBe('\'-2+3');
    expect(guardCell('@SUM(A1)')).toBe('\'@SUM(A1)');
    expect(guardCell('\tTAB')).toBe('\'\tTAB');
  });

  it('guardCell: 평범한 값·숫자·한글은 그대로', () => {
    expect(guardCell('web-01')).toBe('web-01');
    expect(guardCell(123)).toBe('123');
    expect(guardCell('서울-DC')).toBe('서울-DC');
    expect(guardCell(null)).toBe('');
    expect(guardCell(undefined)).toBe('');
  });

  it('csvCell: 가드 후 구분자/따옴표/개행 포함 시에만 인용', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    // 수식 가드가 먼저 걸리고, 따옴표가 없으면 인용 불필요.
    expect(csvCell('=cmd')).toBe("'=cmd");
    // 수식 + 구분자면 가드 + 인용 둘 다.
    expect(csvCell('=a,b')).toBe('"\'=a,b"');
  });

  it('toCsv: 행렬 → CRLF 본문(가드 적용)', () => {
    expect(toCsv([['name', 'val'], ['=evil', 'ok']])).toBe("name,val\r\n'=evil,ok");
  });
});
