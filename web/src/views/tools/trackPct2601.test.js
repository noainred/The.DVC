// v2.601(감사 LO2601-05): VM·스토리지 추이 화면이 '모르는 사용률'(null)을 0% 로 그리지 않는다.
// 두 화면은 recharts 를 끌어오는 큰 컴포넌트라 소스로 규칙을 고정하고, 표기는 unitText 를 실제로 호출해 본다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { unitText } from '../unitText.js';

const read = (f) => fs.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');

describe('LO2601-05 추이 사용률 null', () => {
  for (const f of ['VmTrackTool.jsx', 'StorageTrackTool.jsx']) {
    it(`${f}: dsUsagePct 를 0 으로 메우지 않는다`, () => {
      const s = read(f);
      expect(s).not.toMatch(/dsUsagePct \?\? 0/);
      expect(s).not.toMatch(/dsUsagePct \|\| 0/);
      expect(s).not.toMatch(/`\$\{[pr]\.dsUsagePct[^}]*\}%`/);   // 단위를 값 없이 붙이는 템플릿
      expect(s).toMatch(/unitText\([pr]\.dsUsagePct, '%'\)/);
    });
  }
  it('값이 없으면 단위 없이 —', () => {
    expect(unitText(null, '%')).toBe('—');
    expect(unitText(25.5, '%')).toBe('25.5%');
  });
});
