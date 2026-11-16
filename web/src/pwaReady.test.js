import { describe, it, expect } from 'vitest';
import { swReadyWithin } from './pwa.js';

// 2차 공통 기능 점검 6회차: serviceWorker.ready 가 끝나지 않으면(등록 실패) 알림이 영원히 막혔다 — 시한 뒤 null 로 넘어간다.
describe('swReadyWithin', () => {
  it('끝나지 않는 ready 는 시한 뒤 null', async () => {
    const t0 = Date.now();
    const r = await swReadyWithin({ ready: new Promise(() => {}) }, 50);
    expect(r).toBe(null);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it('준비된 등록은 그대로 · 서비스 워커 없음 · 거부는 null', async () => {
    const reg = { showNotification() {} };
    expect(await swReadyWithin({ ready: Promise.resolve(reg) }, 50)).toBe(reg);
    expect(await swReadyWithin(undefined, 50)).toBe(null);
    expect(await swReadyWithin({ ready: Promise.reject(new Error('x')) }, 50)).toBe(null);
  });
});
