import { describe, it, expect } from 'vitest';
import { coverageText, journalFailText, kpis, entityText, filterFindings, SOURCES, PASTE_HINT } from './logAnalysisText.js';

describe('logAnalysisText (v2.583)', () => {
  it('누적 구간이 요청보다 짧으면 그 앞은 모른다고 말한다', () => {
    const t = coverageText({ source: 'live', hours: 24, lines: 1200, partial: true, trackingSince: Date.parse('2026-09-23T02:00:00Z'), status: {} });
    expect(t.tone).toBe('warn');
    expect(t.text).toContain('그 앞은 모릅니다');
    expect(coverageText({ source: 'live', hours: 24, lines: 0, partial: true, trackingSince: null, status: {} }).text).toContain('아직 누적된 로그가 없습니다');
    expect(coverageText({ source: 'live', enabled: false }).tone).toBe('bad');
  });
  it('저널 권한 없음은 로그 없음이 아니라 조치를 말한다', () => {
    const t = coverageText({ source: 'journal', ok: false, reason: 'permission', unit: 'vmware-portal', lines: 0 });
    expect(t.tone).toBe('bad');
    expect(t.text).toContain('systemd-journal');
    expect(t.text).toContain("'로그 없음' 이 아닙니다");
    expect(journalFailText({ reason: 'no-journalctl' }).text).toContain('systemd 가 아닌');
    expect(journalFailText({ reason: 'busy' }).text).toContain('잠시 뒤');
    expect(journalFailText({ reason: 'no-journal' }).text).toContain('저널 파일이 없습니다');
    expect(coverageText({ source: 'journal', ok: true, unit: 'u', hours: 1, lines: 0 }).text).toContain('기록이 없습니다');
  });
  it('수준이 없는 원천은 경고·오류를 0 이 아니라 null 로 둔다', () => {
    expect(kpis({ levels: { unknown: 50 }, coverage: { lines: 50 } })).toMatchObject({ hasLevels: false, warn: null, error: null, lines: 50 });
    expect(kpis({ levels: { info: 3, warn: 2, error: 1 }, findingCounts: { critical: 1, high: 2, medium: 3, low: 1, info: 4 } }))
      .toMatchObject({ hasLevels: true, warn: 2, error: 1, urgent: 3, medium: 3, minor: 5 });
  });
  it('대상 칩 — 요청 ID·비율을 함께 적는다', () => {
    expect(entityText({ name: 'GET /api/x → 500', count: 3, rid: 'wa-1', maxMs: 1200 })).toBe('GET /api/x → 500 ×3 (최대 1,200ms · 요청 ID wa-1)');
    expect(entityText({ name: 'edge-a', count: 2 })).toBe('edge-a ×2');
  });
  it('심각도 필터', () => {
    const f = [{ severity: 'info' }, { severity: 'medium' }, { severity: 'critical' }];
    expect(filterFindings(f, 'medium')).toHaveLength(2);
  });
  it('문구에 백틱이 없다', () => {
    const all = JSON.stringify({ SOURCES, PASTE_HINT, j: ['permission', 'no-journal', 'no-journalctl', 'busy', 'x'].map((reason) => journalFailText({ reason })) });
    expect(all).not.toMatch(/`/);
  });
});

describe('규칙 목록 문구 (v2.583 카탈로그)', () => {
  it('개수·출처를 밝힌다', async () => {
    const { ruleListNote, ruleOriginText } = await import('./logAnalysisText.js');
    const n = ruleListNote([{ origin: 'core' }, { origin: 'catalog', edge: true }, { origin: 'catalog' }]);
    expect(n).toMatch(/규칙 3개/);
    expect(n).toMatch(/직접 작성 1개 · 코드 전수 스캔 2개/);
    expect(n).toMatch(/엣지 로그에서만 찍히는 문장 1개/);
    expect(ruleOriginText({ origin: 'catalog', edge: true })).toBe('코드 스캔 · 엣지');
    expect(ruleOriginText({})).toBe('—');
    expect(n.includes('`')).toBe(false);
  });
});
