/**
 * `trendMeta.js` 회귀 — v2.578.
 *
 * 고정하는 계약(하나라도 풀리면 화면이 거짓을 말한다):
 *  · `sinceNote` 가 보존 경계에 붙은 첫 표본을 **단정하지 않는다**(`either`).
 *  · 단정 문구('기다리면 채워집니다')는 `kind==='start'` 일 때만 나온다 — v2.509 `waiting` 규약.
 *  · `Number(null) === 0` 함정: 결측이 0 으로 둔갑해 ‘1970년’·‘0분’ 이 되지 않는다.
 *  · 문구에 백틱이 없다(`BoldText` 는 강조 표기만 해석 — v2.576 전수 스윕과 같은 기준).
 */
import { describe, it, expect } from 'vitest';
import {
  bucketLabel, bucketAvgLabel, resolutionNote, sinceNote,
  normalizedDaysNote, sourceNote, truncationNote,
} from './trendMeta.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 22, 3, 0, 0); // 고정 기준 시각 — Date.now() 를 쓰지 않는다(CLAUDE.md v2.517)

describe('bucketLabel', () => {
  it('분·시간·일 경계', () => {
    expect(bucketLabel(5 * 60_000)).toBe('5분');
    expect(bucketLabel(30 * 60_000)).toBe('30분');
    expect(bucketLabel(3_600_000)).toBe('1시간');
    expect(bucketLabel(12 * 3_600_000)).toBe('12시간');
    expect(bucketLabel(DAY)).toBe('1일');
    expect(bucketLabel(7 * DAY)).toBe('7일');
  });
  it('정배수가 아니면 소수 한 자리', () => {
    expect(bucketLabel(90 * 60_000)).toBe('1.5시간');
    expect(bucketLabel(1.5 * DAY)).toBe('1.5일');
  });
  it('읽지 못한 값은 null — 0 으로 둔갑시키지 않는다', () => {
    for (const v of [null, undefined, '', '   ', [], {}, NaN, 0, -1]) {
      expect(bucketLabel(v)).toBeNull();
    }
    expect(bucketAvgLabel(null)).toBeNull();
    expect(bucketAvgLabel(DAY)).toBe('1일 평균');
  });
});

describe('sinceNote — D1: 기준선을 단정하지 않는다', () => {
  it('표본이 없으면 none', () => {
    const r = sinceNote({ collectedSince: null, retentionDays: 90, now: NOW });
    expect(r.kind).toBe('none');
    expect(r.waiting).toBe(true);
  });

  it('첫 표본이 보존 경계에 붙어 있으면 either — 두 원인을 함께 말한다', () => {
    const r = sinceNote({ collectedSince: NOW - 90 * DAY + 3_600_000, retentionDays: 90, now: NOW });
    expect(r.kind).toBe('either');
    expect(r.waiting).toBe(false);                       // 기다려서 될지 알 수 없다
    expect(r.text).toContain('보존 기간(90일)');
    expect(r.text).toContain('기다려도 채워지지 않습니다');
  });

  it('첫 표본이 보존 경계보다 한참 뒤면 start — 이때만 기다리라고 말한다', () => {
    const r = sinceNote({ collectedSince: NOW - 10 * DAY, retentionDays: 90, now: NOW });
    expect(r.kind).toBe('start');
    expect(r.waiting).toBe(true);
    expect(r.text).toContain('수집 시작');
  });

  it('보존 무제한(0)이면 경계가 없으므로 언제나 start', () => {
    const r = sinceNote({ collectedSince: NOW - 900 * DAY, retentionDays: 0, now: NOW });
    expect(r.kind).toBe('start');
  });

  it('보존일을 모르면(null) 단정하지 않되 start 로 둔다 — 없는 경계를 지어내지 않는다', () => {
    const r = sinceNote({ collectedSince: NOW - 90 * DAY, retentionDays: null, now: NOW });
    expect(r.kind).toBe('start');
  });

  it('기다리라는 문구는 waiting 인 갈래에만 있다', () => {
    const cases = [
      sinceNote({ collectedSince: null, retentionDays: 90, now: NOW }),
      sinceNote({ collectedSince: NOW - 90 * DAY, retentionDays: 90, now: NOW }),
      sinceNote({ collectedSince: NOW - 3 * DAY, retentionDays: 90, now: NOW }),
    ];
    for (const c of cases) {
      const promises = /그만큼 시간이 지나야 채워집니다|수집이 시작되면 쌓입니다/.test(c.text);
      expect(promises).toBe(c.waiting);
    }
  });
});

describe('normalizedDaysNote — D2', () => {
  it('같으면 배너를 만들지 않는다', () => {
    expect(normalizedDaysNote(30, 30)).toBeNull();
    expect(normalizedDaysNote(null, 30)).toBeNull();
    expect(normalizedDaysNote(14, null)).toBeNull();
  });
  it('다르면 두 값을 모두 말한다', () => {
    expect(normalizedDaysNote(14, 7)).toContain('14일');
    expect(normalizedDaysNote(14, 7)).toContain('7일');
    expect(normalizedDaysNote(60, 30)).toContain('30일 기준');
  });
});

describe('sourceNote — D4', () => {
  it('vCenter 롤업은 구간 초를 단위로 환산해 적는다', () => {
    expect(sourceNote({ source: 'vcenter', intervalSec: 1800 })).toBe('출처: vCenter 성능 롤업(30분 구간)');
    expect(sourceNote({ source: 'vcenter', intervalSec: 7200 })).toBe('출처: vCenter 성능 롤업(2시간 구간)');
    expect(sourceNote({ source: 'vcenter', intervalSec: 86400 })).toBe('출처: vCenter 성능 롤업(1일 구간)');
  });
  it('구간을 모르면 지어내지 않는다', () => {
    expect(sourceNote({ source: 'vcenter', intervalSec: null })).toBe('출처: vCenter 성능 롤업');
    expect(sourceNote({ source: 'portal', bucketMs: null })).toBe('출처: 포탈 시계열');
  });
  it('포탈 시계열은 버킷 평균임을 밝힌다', () => {
    expect(sourceNote({ source: 'portal', bucketMs: 3_600_000 })).toBe('출처: 포탈 시계열(1시간 평균)');
  });
});

describe('truncationNote — 조용한 상한 금지', () => {
  it('안 잘렸으면 null', () => {
    expect(truncationNote({ truncated: false, covered: 120, requestedDays: 365 })).toBeNull();
    expect(truncationNote({})).toBeNull();
  });
  it('잘렸으면 개수를 밝힌다', () => {
    const t = truncationNote({ truncated: true, covered: 125, requestedDays: 365 });
    expect(t).toContain('365일');
    expect(t).toContain('125일');
  });
  it('덮은 구간을 모르면 개수 없이 사실만 말한다', () => {
    expect(truncationNote({ truncated: true })).toContain('일부만 표시');
  });
});

describe('문구 위생', () => {
  it('백틱이 없다 — BoldText 는 강조 표기만 해석한다', async () => {
    const src = await (await import('node:fs/promises')).readFile(
      new URL('./trendMeta.js', import.meta.url), 'utf8',
    );
    // 템플릿 리터럴(코드)이 아니라 **사용자에게 보이는 문자열**에 백틱이 없는지 본다.
    const texts = [
      resolutionNote(12 * 3_600_000),
      sinceNote({ collectedSince: NOW - 90 * DAY, retentionDays: 90, now: NOW }).text,
      sinceNote({ collectedSince: NOW - 3 * DAY, retentionDays: 90, now: NOW }).text,
      sinceNote({ collectedSince: null }).text,
      normalizedDaysNote(14, 7),
      sourceNote({ source: 'vcenter', intervalSec: 1800 }),
      truncationNote({ truncated: true, covered: 125, requestedDays: 365 }),
    ];
    for (const t of texts) expect(t).not.toMatch(/`/);
    expect(src.length).toBeGreaterThan(0);
  });
});

describe('maxPctGapNote — 조용한 보정 금지', () => {
  it('0·결측이면 배너를 만들지 않는다', async () => {
    const { maxPctGapNote } = await import('./trendMeta.js');
    for (const v of [0, null, undefined, '', -3]) expect(maxPctGapNote(v)).toBeNull();
  });
  it('있으면 개수와 함께, 절대량에서는 보인다는 사실도 말한다', async () => {
    const { maxPctGapNote } = await import('./trendMeta.js');
    const t = maxPctGapNote(3);
    expect(t).toContain('3개');
    expect(t).toContain('절대량');
    expect(t).not.toMatch(/`/);
  });
});
