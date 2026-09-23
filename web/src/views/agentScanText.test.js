import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countText, durationText, strField } from './agentScanText.js';

describe('agentScanText (v2.598 CENTRAL-03)', () => {
  it('유한한 숫자만 글자로, null·객체·문자열은 —(0 으로 칠하지 않는다)', () => {
    expect(countText(0)).toBe('0');
    expect(countText(12)).toBe('12');
    expect(countText(null)).toBe('—');
    expect(countText(undefined)).toBe('—');
    expect(countText({ a: 1 })).toBe('—');
    expect(countText('3')).toBe('—');
    expect(countText(NaN)).toBe('—');
  });
  it('소요 시간은 양수일 때만', () => {
    expect(durationText(12_000)).toBe(' · 12s');
    expect(durationText(null)).toBe('');
    expect(durationText({ x: 1 })).toBe('');
  });
  it('found 글자 필드는 문자열만', () => {
    expect(strField('10.0.0.1')).toBe('10.0.0.1');
    expect(strField({ $: 1 })).toBe('');
    expect(strField(7)).toBe('');
  });
  it('AgentScans.jsx 가 스캔 수치를 헬퍼 없이 그리지 않는다', () => {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'AgentScans.jsx'), 'utf8');
    for (const k of ['foundCount', 'scanned', 'unreachable', 'notIdrac', 'authFailed']) {
      expect(src).not.toMatch(new RegExp(`\\{r\\.${k}\\}`));
      expect(src).toMatch(new RegExp(`countText\\(r\\.${k}\\)`));
    }
  });
});
