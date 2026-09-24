// v2.605(감사 LEFT2605-06): IPAM 스캔 설정 폼 → 저장 본문. 빈 칸은 보내지 않는다(서버가 이전 값 유지).
import { describe, it, expect } from 'vitest';
import { intervalMinText, scanSettingsBody } from './ipamScanForm.js';

describe('ipamScanForm', () => {
  const saved = { enabled: true, ranges: ['10.0.0.0/24'], intervalMs: 12 * 3_600_000, concurrency: 64, timeoutMs: 700, retentionDays: 90 };
  it('손대지 않은 저장값은 그대로 보낸다', () => {
    const b = scanSettingsBody(saved, 'edge-a');
    expect(b).toMatchObject({ agent: 'edge-a', intervalMs: 12 * 3_600_000, concurrency: 64, retentionDays: 90 });
    expect('intervalMin' in b).toBe(false);
  });
  it('빈 칸은 undefined(보내지 않음) — 보존 0(정리 안 함)·주기 기본 60분으로 둔갑하지 않는다', () => {
    const b = scanSettingsBody({ ...saved, intervalMin: '', concurrency: '', retentionDays: '' }, 'edge-a');
    expect(b.intervalMs).toBeUndefined();
    expect(b.concurrency).toBeUndefined();
    expect(b.retentionDays).toBeUndefined();
    expect(JSON.parse(JSON.stringify(b))).not.toHaveProperty('retentionDays');
  });
  it('명시한 값은 숫자로 — 주기 분은 ms, 보존 0 은 값', () => {
    const b = scanSettingsBody({ ...saved, intervalMin: '30', retentionDays: '0', timeoutMs: '900' }, 'x');
    expect([b.intervalMs, b.retentionDays, b.timeoutMs]).toEqual([1_800_000, 0, 900]);
  });
  it('표시용 주기 분', () => {
    expect(intervalMinText(saved)).toBe('720');
    expect(intervalMinText({ ...saved, intervalMin: '' })).toBe('');
  });
});
