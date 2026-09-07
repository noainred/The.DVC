import { describe, it, expect } from 'vitest';
import { bucketText, perfQuery, parseLocalDt, toLocalDt, rangeIssueOf, retentionEstimate, MODES, RETENTION_PRESETS } from './sanSwitchPerfText.js';

describe('sanSwitchPerfText (v2.420)', () => {
  it('bucketText: 초/분/시간/일', () => {
    expect(bucketText(0)).toBe('—');
    expect(bucketText(60_000)).toBe('1분');
    expect(bucketText(720_000)).toBe('12분');
    expect(bucketText(6 * 3600_000)).toBe('6시간');
    expect(bucketText(1.5 * 86400_000)).toBe('1.5일');
  });
  it('perfQuery: 기간 지정이 있으면 from/to, 없으면 hours', () => {
    expect(perfQuery({ hours: 6 })).toEqual({ hours: '6' });
    expect(perfQuery({ hours: 6, range: { from: 1000, to: 2000 } })).toEqual({ from: '1000', to: '2000' });
    expect(perfQuery({ hours: 6, range: { from: 2000, to: 1000 } })).toEqual({ hours: '6' }); // 역전은 무시
  });
  it('parseLocalDt/toLocalDt 왕복', () => {
    const ms = parseLocalDt('2026-09-01T09:30');
    expect(ms).not.toBeNull();
    expect(toLocalDt(ms)).toBe('2026-09-01T09:30');
    expect(parseLocalDt('2026/09/01')).toBeNull();
  });
  it('rangeIssueOf: 검증 규칙(서버 rangeParams 와 동일)', () => {
    const now = parseLocalDt('2026-09-07T12:00');
    expect(rangeIssueOf('', '', now).issue).toMatch(/시작/);
    expect(rangeIssueOf('2026-09-07T11:00', '2026-09-07T10:00', now).issue).toMatch(/늦거나/);
    expect(rangeIssueOf('2025-01-01T00:00', '2026-09-01T00:00', now).issue).toMatch(/366일/);
    expect(rangeIssueOf('2026-09-08T00:00', '', now).issue).toMatch(/미래/);
    const ok = rangeIssueOf('2026-09-01T00:00', '', now);
    expect(ok.issue).toBeUndefined();
    expect(ok.to).toBe(now); // 끝 미입력 = 지금
  });
  it('retentionEstimate: 표본이 없으면 null, 있으면 행당 바이트 × 하루 행수 × 보관일', () => {
    expect(retentionEstimate({ rows: 0 })).toBeNull();
    const e = retentionEstimate({ rows: 1000, fileBytes: 100_000, rowsLastDay: 200, retentionDays: 10 });
    expect(e.bytesPerRow).toBe(100);
    expect(e.bytesAtRetention).toBe(200 * 100 * 10);
  });
  it('MODES/RETENTION_PRESETS 는 설명·라벨을 갖는다', () => {
    expect(MODES.map((m) => m[0])).toEqual(['avg', 'peak']);
    for (const m of MODES) expect(m[2].length).toBeGreaterThan(40);
    expect(RETENTION_PRESETS.some(([d]) => d === 90)).toBe(true);
  });
});
