// v3.13.4 — 표 행 key 고유화: 겹치는 key 는 ~n · 겹치지 않으면 그대로 · DataTable 이 쓴다
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { uniqueKeys, baseRowKey } from './tableKeys.js';

describe('uniqueKeys · baseRowKey', () => {
  it('겹치는 key 는 나온 차례대로 ~1 · ~2 · 첫 것과 겹치지 않는 key 는 그대로', () => {
    expect(uniqueKeys(['a', 'b', 'a', 'a', 'c'])).toEqual(['a', 'b', 'a~1', 'a~2', 'c']);
    expect(uniqueKeys(['x', 'y'])).toEqual(['x', 'y']);
    expect(uniqueKeys([1, '1'])).toEqual(['1', '1~1']);
    expect(uniqueKeys(null)).toEqual([]);
    const ks = uniqueKeys(Array.from({ length: 11 }, () => 'XXXXX-…-AAAAA'));
    expect(new Set(ks).size).toBe(11);   // 라이선스 표 재현 — 11 vCenter 의 같은 가림 키
  });
  it('baseRowKey — 예전 우선순위 그대로(id → key → 차례)', () => {
    expect(baseRowKey({ id: 'i', key: 'k' }, 3)).toBe('i');
    expect(baseRowKey({ key: 'k' }, 3)).toBe('k');
    expect(baseRowKey({}, 3)).toBe(3);
    expect(baseRowKey(null, 2)).toBe(2);
  });
  it('소스 계약 — DataTable 이 uniqueKeys(shown.map(baseRowKey)) 로 행 key 를 만든다(r.id || r.key || i 를 직접 쓰지 않는다)', () => {
    const s = fs.readFileSync(new URL('./primitives.jsx', import.meta.url), 'utf8');
    expect(s).toMatch(/const rowKeys = uniqueKeys\(shown\.map\(baseRowKey\)\);/);
    expect(s).toMatch(/const rk = rowKeys\[i\];/);
    expect(s).not.toMatch(/const rk = r\.id \|\| r\.key \|\| i;/);
  });
});
