// 164회차(결정 6): 긴급중단으로 건너뛴 로그 수집 주기를 '수집 꺼짐' · '켜고 저장하세요'(틀린 조치)로 말하지 않는다 — 서버 logs/poller.js 의 emergencyStop 표지.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { vcLogRunText, vcLogCollectText } from './VcenterLogs.jsx';

const fmt = () => 'T';

describe('164 — vCenter 로그 수집: 긴급중단 표지', () => {
  it('상태 줄은 긴급중단이라고 말하고 수집 꺼짐이라고 하지 않는다', () => {
    const t = vcLogRunText({ at: 1, collected: 0, skipped: true, emergencyStop: true }, fmt);
    expect(t).toContain('긴급중단 중이라 수집하지 않음');
    expect(t).not.toContain('수집 꺼짐');
    expect(vcLogRunText({ at: 1, collected: 0, skipped: true }, fmt)).toContain('수집 꺼짐');
  });
  it('지금 수집 결과도 긴급중단을 말하고 켜고 저장하라고 하지 않는다', () => {
    const t = vcLogCollectText({ ok: true, at: 1, collected: 0, skipped: true, emergencyStop: true }, fmt);
    expect(t).toContain('긴급중단 중이라 수집하지 않았습니다');
    expect(t).not.toContain('켜고');
  });
  it('서버가 실제로 그 표지를 싣는다(대조)', () => {
    const src = fs.readFileSync(new URL('../../../server/src/logs/poller.js', import.meta.url), 'utf8');
    expect(src).toMatch(/if \(isStopped\(\)\) \{ lastRun = \{ at: Date\.now\(\), collected: 0, skipped: true, emergencyStop: true \}; return lastRun; \}/);
  });
});
