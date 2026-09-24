import { describe, it, expect } from 'vitest';
import { releaseLineText } from './releaseNoteText.js';
import { boldParts } from '../components/boldText.jsx';

describe('releaseLineText (WEB2607-08)', () => {
  it('백틱 구간을 ‘ ’ 로 바꾸고 강조는 BoldText 가 굵게 한다', () => {
    const t = releaseLineText('**BUG-D — 무음 반환**: `statusOnly` 본문을 보낸다');
    expect(t).toBe('**BUG-D — 무음 반환**: ‘statusOnly’ 본문을 보낸다');
    const parts = boldParts(t);
    expect(parts[0]).toEqual({ b: true, t: 'BUG-D — 무음 반환' });
    expect(parts.map((p) => p.t).join('').includes('*')).toBe(false);
  });
  it('짝 없는 백틱·일반 문자열은 그대로', () => {
    expect(releaseLineText('a ` b')).toBe('a ` b');
    expect(releaseLineText('plain')).toBe('plain');
    expect(releaseLineText(null)).toBe('');
  });
});
