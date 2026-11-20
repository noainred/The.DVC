/**
 * 결정(56~75 남긴 것) 64 F2 시한 — 호스트 접근 되돌림 실패 배너 문구(HostAccessSettings.jsx revertBannerText).
 *  자동 재시도 중 / 시한이 지나 멈춤(수동 조치 필요)을 구분하고, 시한 숫자는 API 값으로만 말한다.
 */
import { describe, it, expect } from 'vitest';
import { revertBannerText } from './HostAccessSettings.jsx';

describe('revertBannerText', () => {
  it('실패가 없으면 빈 문자열', () => {
    expect(revertBannerText(null, 21_600_000)).toBe('');
    expect(revertBannerText({ deadline: 1 }, 21_600_000)).toBe('');
  });
  it('재시도 중 — 자동으로 다시 시도한다 · 시한은 API 값(6시간)', () => {
    const t = revertBannerText({ revertError: 'FirewallD is not running' }, 21_600_000);
    expect(t).toMatch(/자동으로 다시 시도합니다\(처음 실패부터 6시간까지\)/);
    expect(t).toMatch(/FirewallD is not running/);
    expect(t).not.toMatch(/수동 조치 필요/);
  });
  it('시한 지남(revertGaveUp) — 수동 조치 필요 · 자동 재시도를 멈췄다고 말한다', () => {
    const t = revertBannerText({ revertError: 'x', revertGaveUp: true }, 21_600_000);
    expect(t).toMatch(/^되돌림 실패 — 수동 조치 필요/);
    expect(t).toMatch(/처음 실패부터 6시간/);
    expect(t).not.toMatch(/자동으로 다시 시도합니다/);
  });
  it('시한 값을 모르면 숫자를 지어내지 않는다 · 백틱 없음', () => {
    const a = revertBannerText({ revertError: 'x' }, undefined);
    const b = revertBannerText({ revertError: 'x', revertGaveUp: true }, null);
    expect(a).not.toMatch(/시간까지/);
    expect(b).toMatch(/자동 재시도 시한/);
    expect(a + b).not.toMatch(/`/);
  });
});
