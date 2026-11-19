import { describe, it, expect } from 'vitest';
import { isChunkLoadError, claimAutoReload, RELOAD_KEY, RELOAD_GAP_MS } from './chunkReload.js';

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };

describe('v2.977 업그레이드 뒤 화면 조각 404', () => {
  it('브라우저별 청크 오류 문구를 알아본다 · 다른 오류는 아니다', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/VmHygieneTool-abc.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(Object.assign(new Error('x'), { name: 'ChunkLoadError' }))).toBe(true);
    expect(isChunkLoadError(new Error("Cannot read properties of undefined (reading 'map')"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
  it('자동 새로고침은 같은 탭에서 60초에 한 번 — 저장소를 못 쓰면 하지 않는다(무한 새로고침 방지)', () => {
    const s = mem();
    expect(claimAutoReload(s, 1_000_000)).toBe(true);
    expect(s.getItem(RELOAD_KEY)).toBe('1000000');
    expect(claimAutoReload(s, 1_000_000 + RELOAD_GAP_MS - 1)).toBe(false);
    expect(claimAutoReload(s, 1_000_000 + RELOAD_GAP_MS)).toBe(true);
    expect(claimAutoReload(null, 1)).toBe(false);
    expect(claimAutoReload({ getItem: () => { throw new Error('denied'); }, setItem: () => {} }, 1)).toBe(false);
  });
  // v3.10.8(공통 기능 점검 6회차): 남긴 시각이 미래면(시계를 되돌림) 예전엔 그 시각까지 자동 새로고침이 막혔다.
  it('미래 기록은 믿지 않는다 — 지금 시각으로 다시 적고 한 번 새로 읽는다', () => {
    const s = mem();
    s.setItem(RELOAD_KEY, String(10_000_000));
    expect(claimAutoReload(s, 10_000_000 - 3_600_000)).toBe(true);
    expect(s.getItem(RELOAD_KEY)).toBe(String(10_000_000 - 3_600_000));
    expect(claimAutoReload(s, 10_000_000 - 3_600_000 + 1)).toBe(false); // 그 뒤로는 다시 60초 간격
  });
});
