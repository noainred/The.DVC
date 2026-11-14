/**
 * boldText — 서버 안내 문구의 `**강조**` 파싱(v2.440).
 * 별표가 화면에 그대로 보이던 회귀(v2.439 중계 경로 판정문)를 고정한다.
 */
import { describe, it, expect } from 'vitest';
import { boldParts } from './boldText.jsx';

describe('boldParts', () => {
  it('강조 구간을 분리한다', () => {
    expect(boldParts('a **b** c')).toEqual([{ b: false, t: 'a ' }, { b: true, t: 'b' }, { b: false, t: ' c' }]);
  });
  it('여러 개를 처리한다', () => {
    expect(boldParts('**a**와 **b**')).toEqual([{ b: true, t: 'a' }, { b: false, t: '와 ' }, { b: true, t: 'b' }]);
  });
  it('닫는 표시가 없으면 강조로 보지 않는다(별표를 삼키지 않는다)', () => {
    expect(boldParts('a **b')).toEqual([{ b: false, t: 'a **b' }]);
  });
  it('빈 문자열·null 안전', () => {
    expect(boldParts('')).toEqual([{ b: false, t: '' }]);
    expect(boldParts(null)).toEqual([{ b: false, t: '' }]);
  });
  it('강조가 없으면 통째로 평문', () => {
    expect(boldParts('평범한 문장')).toEqual([{ b: false, t: '평범한 문장' }]);
  });
  it('실제 문구 — 별표가 남지 않는다', () => {
    const s = "지금 당장 스캔이 필요하면 **스캔 방식을 '중앙→엣지 직접(PUSH)'** 으로 바꾸세요.";
    const parts = boldParts(s);
    expect(parts.some((p) => p.b)).toBe(true);
    expect(parts.map((p) => p.t).join('')).not.toContain('**');
  });
  // v3.10.9(공통 기능 점검 7회차): '****'(빈 강조) 앞의 글자가 사라졌다('ab****cd' → '**cd').
  it('빈 강조(****)는 글자로 남고 앞뒤 글자를 잃지 않는다', () => {
    const join = (x) => boldParts(x).map((p) => p.t).join('');
    // 불변식: 강조 표시를 되붙이면 원문 그대로다(글자를 하나도 잃지 않는다).
    const back = (x) => boldParts(x).map((p) => (p.b ? `**${p.t}**` : p.t)).join('');
    expect(join('ab****cd')).toBe('ab****cd');
    expect(boldParts('ab****cd').some((p) => p.b)).toBe(false);
    for (const x of ['ab****cd', 'x****', '****', '앞 **** 뒤 **굵게** 끝', '**a******b**', 'a **b** ****']) expect(back(x)).toBe(x);
    expect(join('x****')).toBe('x****');
  });
});

