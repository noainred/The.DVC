import { describe, it, expect } from 'vitest';
import {
  MODE_OFF, MODE_ALLOW, MODE_DENY, MODE_LABEL, modeHelp, overrideBadge,
  overrideByText, toolsPermWarning, enforcementGapNote, saveSummary, SECTION_NOTE,
} from './userToolText.js';

const ALL = ['storage-mon', 'ipam', 'ping', 'gpu'];
const levelOf = (k) => (k === 'ipam' || k === 'storage-mon' ? 'server' : 'declared');

describe('userToolText (v2.555)', () => {
  it('모드 라벨·설명이 셋 다 있다 — 화면이 하드코딩하지 않게', () => {
    for (const m of [MODE_OFF, MODE_ALLOW, MODE_DENY]) {
      expect(MODE_LABEL[m]).toBeTruthy();
      expect(modeHelp(m).length).toBeGreaterThan(10);
    }
  });

  it('배지 — 허용 0개는 "전면 차단" 으로 말한다(제한 없음으로 읽히면 최악의 거짓)', () => {
    expect(overrideBadge(null)).toMatchObject({ mode: MODE_OFF, text: '역할 기준' });
    expect(overrideBadge({ mode: MODE_ALLOW, tools: [] })).toMatchObject({ tone: 'bad', text: '특수기능 전면 차단' });
    expect(overrideBadge({ mode: MODE_ALLOW, tools: ['a', 'b'] }).text).toBe('허용 2개만');
    expect(overrideBadge({ mode: MODE_DENY, tools: ['a'] }).text).toBe('추가 차단 1개');
  });

  it('설정자·시각이 없으면 null — 지어내지 않는다', () => {
    expect(overrideByText(null)).toBe(null);
    expect(overrideByText({ mode: MODE_ALLOW, tools: [], by: '', at: 0 })).toBe(null);
    expect(overrideByText({ by: 'admin', at: 0 })).toContain('시각 미기록');
    expect(overrideByText({ by: 'admin', at: 1_700_000_000_000 })).toContain('admin');
  });

  it('★ tools 권한이 없으면 허용 목록이 무의미하다는 사실을 말한다(무음 실패 금지)', () => {
    const w = toolsPermWarning({ entry: { mode: MODE_ALLOW, tools: ['ipam'] }, hasToolsPerm: false, role: 'viewer' });
    expect(w).toContain('특수 기능');
    expect(w).toContain('viewer');
    // 권한이 있으면 경고하지 않는다(없는 문제를 만들지 않는다)
    expect(toolsPermWarning({ entry: { mode: MODE_ALLOW, tools: ['ipam'] }, hasToolsPerm: true })).toBe(null);
    // 재정의가 없거나 추가 차단 모드면 이 경고의 뜻이 없다
    expect(toolsPermWarning({ entry: null, hasToolsPerm: false })).toBe(null);
    expect(toolsPermWarning({ entry: { mode: MODE_DENY, tools: ['ipam'] }, hasToolsPerm: false })).toBe(null);
  });

  it('★ 허용 목록 모드에서 "고르지 않은 전부" 를 차단 대상으로 보고 서버 집행 공백을 센다', () => {
    const n = enforcementGapNote({ mode: MODE_ALLOW, tools: ['storage-mon'] }, ALL, levelOf);
    // 차단 대상 = ipam·ping·gpu 이고 그중 서버가 막는 것은 ipam → 공백 2개
    expect(n.count).toBe(2);
    expect(n.keys.sort()).toEqual(['gpu', 'ping']);
  });

  it('추가 차단 모드는 "고른 것" 만 차단 대상이다', () => {
    expect(enforcementGapNote({ mode: MODE_DENY, tools: ['ipam'] }, ALL, levelOf)).toBe(null); // ipam 은 서버가 막는다
    expect(enforcementGapNote({ mode: MODE_DENY, tools: ['ping'] }, ALL, levelOf).count).toBe(1);
    expect(enforcementGapNote(null, ALL, levelOf)).toBe(null);
  });

  it('저장 요약이 숨기는 개수를 말한다 · 허용 0개는 경고한다', () => {
    expect(saveSummary(MODE_ALLOW, ['a'], 4)).toContain('숨김 3개');
    expect(saveSummary(MODE_ALLOW, [], 4)).toContain('전부');
    expect(saveSummary(MODE_DENY, [], 4)).toContain('역할 기준');
    expect(saveSummary(MODE_OFF, [], 4)).toContain('지웁니다');
  });

  it('문구에 백틱이 없어야 한다 — BoldText 는 **강조** 만 해석한다(v2.553 규약)', () => {
    const texts = [
      SECTION_NOTE, modeHelp(MODE_OFF), modeHelp(MODE_ALLOW), modeHelp(MODE_DENY),
      saveSummary(MODE_ALLOW, [], 3), saveSummary(MODE_DENY, [], 3), saveSummary(MODE_OFF, [], 3),
      toolsPermWarning({ entry: { mode: MODE_ALLOW }, hasToolsPerm: false, role: 'viewer' }),
      enforcementGapNote({ mode: MODE_ALLOW, tools: [] }, ALL, levelOf).text,
      ...Object.values(MODE_LABEL),
    ];
    for (const t of texts) expect(String(t)).not.toContain('`');
  });
});
