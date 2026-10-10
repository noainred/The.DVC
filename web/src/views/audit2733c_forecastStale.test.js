/**
 * v2.733 점검 3회차 그룹 c — C2-07(웹 절반): 용량 예측 행의 '마지막 표본 N일 전' 표지.
 *   서버는 마지막 점 시각(lastTs)·stale 을 싣고 소진일을 그 시점에서 센다 — 화면은 그 뒤의 추세를 모른다는 사실을 말한다.
 */
import { describe, it, expect } from 'vitest';
import { forecastStaleText, FORECAST_STALE_TITLE } from './forecastRowText.js';

const D = 86_400_000, H = 3_600_000;
const NOW = 1_800_000_000_000;

describe('C2-07 마지막 표본 표지', () => {
  it('stale 이면 나이를 일·시간으로 말한다(내림)', () => {
    expect(forecastStaleText({ stale: true, lastTs: NOW - 5 * D - 30 * 60_000 }, NOW)).toBe('마지막 표본 5일 전');
    expect(forecastStaleText({ stale: true, lastTs: NOW - 4 * H - 1 }, NOW)).toBe('마지막 표본 4시간 전');
  });
  it('신선하거나 lastTs 를 모르면 표지 없음(지어내지 않는다)', () => {
    expect(forecastStaleText({ stale: false, lastTs: NOW - 5 * D }, NOW)).toBe('');
    expect(forecastStaleText({ stale: true }, NOW)).toBe('');
    expect(forecastStaleText({ stale: true, lastTs: null }, NOW)).toBe('');
    expect(forecastStaleText({ stale: true, lastTs: '' }, NOW)).toBe('');
    expect(forecastStaleText({ synthesized: true, daysToLimit: 10 }, NOW)).toBe('');
    expect(forecastStaleText(null, NOW)).toBe('');
  });
  it('설명은 백틱·별표 없이 한 벌', () => {
    expect(FORECAST_STALE_TITLE).not.toMatch(/[`*]/);
    expect(FORECAST_STALE_TITLE).toContain('마지막 표본');
  });
});
