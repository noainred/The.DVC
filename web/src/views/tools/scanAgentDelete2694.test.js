// v2.694: 에이전트별 대역 삭제 — 확인·결과 문구(백틱 금지 · 이미 보고된 결과는 남는다는 사실을 말한다).
import { describe, it, expect } from 'vitest';
import { agentDeleteConfirmText, agentDeleteResultText } from './scanRangeImportText.js';

describe('agentDeleteConfirmText', () => {
  it('대역만 — 포트·주기가 남는다고 말한다 · 엣지는 스캔을 멈춘다', () => {
    const t = agentDeleteConfirmText({ name: 'agent-OC2', lines: 18 }, 'ranges');
    expect(t).toContain('스캔 대역 18줄'); expect(t).toContain('포트·주기 설정은 남습니다'); expect(t).toContain('스캔을 멈춥니다');
    expect(t).toContain('결과는 지우지 않습니다'); expect(t).not.toContain('`');
  });
  it('등록 삭제 — 표에서 빠진다 · 이 포탈은 다른 안내', () => {
    expect(agentDeleteConfirmText({ name: 'agent-WA', lines: 10 }, 'agent')).toContain('이 표에서 빠집니다');
    expect(agentDeleteConfirmText({ name: '__local__', lines: 2 }, 'ranges')).toContain('**이 포탈에서 직접**');
    expect(agentDeleteConfirmText(null, 'ranges')).toBe('');
  });
});

describe('agentDeleteResultText', () => {
  it('남은 스캔 결과 개수를 밝힌다', () => {
    expect(agentDeleteResultText({ agent: 'agent-OC2', mode: 'agent', removedRanges: 18, removedReport: true, resultsKept: 805 }))
      .toBe('agent-OC2 의 등록을 지웠습니다(대역 18줄 · 보고 기록). 이 에이전트가 보고한 스캔 결과 805개는 남아 있습니다.');
    expect(agentDeleteResultText({ agent: '__local__', mode: 'ranges', removedRanges: 3, resultsKept: 0 })).toBe('이 포탈에서 직접 의 스캔 대역 3줄을 지웠습니다.');
  });
});
