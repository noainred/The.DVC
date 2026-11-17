/**
 * 원격 콘솔 창의 위치 · 크기(릴리스 전 Chromium 검증 — 400px 에서 창이 화면 밖으로 나가 '재시도' 를 누를 수 없었다).
 */
import { describe, it, expect } from 'vitest';
import { remoteWindowGeo, windowModeAvailable, NARROW_PX } from './windowGeo.js';

const DEF = { minimized: false, maximized: false, x: 140, y: 88, w: 860, h: 560 };

describe('remoteWindowGeo', () => {
  it('넓은 화면(1440×900)에서는 저장된 위치 · 크기 그대로', () => {
    expect(remoteWindowGeo(DEF, 1440, 900)).toEqual({ left: 140, top: 88, width: 860, height: 560 });
  });
  it('휴대폰 폭(400)에서는 화면 전체 — 창의 어느 부분도 화면 밖에 있지 않다', () => {
    const g = remoteWindowGeo(DEF, 400, 900);
    expect(g).toEqual({ left: 8, top: 8, width: 'calc(100vw - 16px)', height: 'calc(100vh - 16px)' });
    expect(windowModeAvailable(400)).toBe(false);
    expect(windowModeAvailable(NARROW_PX)).toBe(true);
  });
  it('창보다 좁지만 휴대폰은 아닌 폭(800) — 크기를 화면에 맞추고 창 전체가 보이게 당긴다', () => {
    const g = remoteWindowGeo(DEF, 800, 500);
    expect(g.width).toBe(784); expect(g.height).toBe(484);
    expect(g.left).toBe(8); expect(g.top).toBe(8);
    expect(g.left + g.width).toBeLessThanOrEqual(800 - 8);
    expect(g.top + g.height).toBeLessThanOrEqual(500 - 8);
  });
  it('끌어서 화면 밖으로 나간 위치도 화면 안으로(저장된 값은 바꾸지 않는다)', () => {
    const win = { ...DEF, x: 5000, y: -300 };
    const g = remoteWindowGeo(win, 1440, 900);
    expect(g.left).toBe(1440 - 860 - 8); expect(g.top).toBe(8);
    expect(win.x).toBe(5000);
  });
  it('최대화는 화면 전체 · 깨진 값(NaN · 없음)은 기본 자리', () => {
    expect(remoteWindowGeo({ ...DEF, maximized: true }, 1440, 900).width).toBe('calc(100vw - 16px)');
    expect(remoteWindowGeo({ x: NaN }, 1440, 900)).toEqual({ left: 140, top: 88, width: 860, height: 560 });
    expect(remoteWindowGeo(null, undefined, undefined)).toEqual({ left: 140, top: 88, width: 860, height: 560 });
  });
});
