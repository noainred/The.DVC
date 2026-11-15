/**
 * 베어메탈 사용률 점검 반복 1회차 — 새 사유 code(D3 · D4 대상 제외 · D5 iDRAC 실패)가 화면 문구 표마다 있다(모르는 code 를 글자 그대로 보이지 않게) · 백틱 없음.
 *   서버 열거와 1:1 은 bmStage6Text(REASON_TEXT ↔ HEALTH_REASON_CODES) · bmPerfOpsText(FOCUS_MISS_TEXT ↔ FOCUS_MISS) · server bmFolders2992(WHY_CODES ↔ whyText)가 고정한다.
 */
import { describe, it, expect } from 'vitest';
import { SKIP_LABEL, MISSING_MARK, skippedNotes, missingFootnotes, missingMark, edgeDelegatedByAgent, edgeDelegatedChip, edgeDelegatedGuide } from './bmUsageText.js';
import { MISS_REASON_TEXT } from './bmOnboardText.js';
import { WHY_TEXT } from './bmFolders/whyText.js';
import { REASON_TEXT } from './bmCollectText.js';
import { FOCUS_MISS_TEXT } from './bmPerfOpsText.js';
import { NO_PATH_REASON } from '../../../../server/src/bmusage/targets.js';
import { agentNoteOf, AGENT_UNKNOWN_TEXT, AGENT_UNKNOWN_HINT } from './bmOsSuggestText.js';

const SKIP_NEW = ['idrac-disabled', 'os-disabled', 'os-edge'];
const IDRAC_NEW = ['forbidden', 'ids-unmatched', 'cert-untrusted'];

describe('점검 반복 1회차 — 새 사유 문구', () => {
  it('대상 제외 사유(D3 · D4): 서버 문구 · 짧은 이름 · 행 표지 · 각주 · 누락 점검 · 물리서버 폴더', () => {
    for (const c of SKIP_NEW) {
      for (const [name, map] of [['NO_PATH_REASON', NO_PATH_REASON], ['SKIP_LABEL', SKIP_LABEL], ['MISSING_MARK', MISSING_MARK], ['MISS_REASON_TEXT', MISS_REASON_TEXT], ['WHY_TEXT', WHY_TEXT]]) {
        expect(map[c], `${name} ${c}`).toBeTruthy();
      }
      expect(missingMark([c])).not.toBe(c);
      expect(missingFootnotes([{ missing: [c] }]).length).toBe(1);
      expect(skippedNotes({ [c]: 2 }, NO_PATH_REASON)[0]).toContain('2대');
    }
  });
  it('iDRAC 실패 사유(D5): 수집 건강 · 집중 모니터링 문구', () => {
    for (const c of IDRAC_NEW) { expect(REASON_TEXT[c]?.label, c).toBeTruthy(); expect(FOCUS_MISS_TEXT[c], c).toBeTruthy(); }
    expect(REASON_TEXT.forbidden.action).toMatch(/비밀번호 문제가 아닙니다/);
  });
  it('문구에 백틱이 없다', () => {
    const all = [...SKIP_NEW.flatMap((c) => [NO_PATH_REASON[c], SKIP_LABEL[c], MISSING_MARK[c], MISS_REASON_TEXT[c], WHY_TEXT[c].s, WHY_TEXT[c].l, WHY_TEXT[c].a, ...missingFootnotes([{ missing: [c] }])]),
      ...IDRAC_NEW.flatMap((c) => [REASON_TEXT[c].label, REASON_TEXT[c].action, FOCUS_MISS_TEXT[c]])];
    for (const v of all) expect(String(v).includes('`')).toBe(false);
  });
  it('OS 주소 제안 — 어느 엣지인지 모르면 한 줄(못 읽음 · 항목 없음) · 아니면 빈 글자', () => {
    expect(agentNoteOf({ agentUnknown: 'unread' })).toMatch(/못 읽음/);
    expect(agentNoteOf({ agentUnknown: 'not-found' })).toMatch(/수집 서버 없음/);
    for (const r of [{}, { agent: 'edge-a' }, { agentUnknown: '__proto__' }, null]) expect(agentNoteOf(r)).toBe('');
    for (const v of [...Object.values(AGENT_UNKNOWN_TEXT), AGENT_UNKNOWN_HINT]) { expect(v.includes('`')).toBe(false); expect(v.length).toBeLessThan(80); }
    expect(AGENT_UNKNOWN_HINT).toMatch(/중앙 직접/);
  });
  it('재확인 N1 — OS 등록 엣지 지정 위임은 ‘엣지가 수집’ 을 단정하지 않는다(칩 · 안내 · 사유 · 각주)', () => {
    const ok = { state: 'ok', label: '정상' };
    const only = edgeDelegatedByAgent([{ reason: 'edge-delegated', agent: 'edge-pl', delegatedBy: 'os-registry' }], { stateOf: () => ok });
    expect(only[0].osReg).toBe(1); expect(only[0].state).toBe(null, '엣지 표 상태(‘정상’ 초록 테두리)를 붙이지 않는다');
    expect(edgeDelegatedGuide([...only, ...edgeDelegatedByAgent([{ reason: 'edge-delegated', agent: 'edge-us' }], { stateOf: () => ok })])).not.toMatch(/표에 없는 엣지는/);
    expect(edgeDelegatedChip(only[0])).toBe('‘edge-pl’ 1대 · OS 등록 엣지 지정(그 엣지에 OS 등록 확인 필요)');   // 예전: ‘edge-pl’ 1대 · 정상
    const g = edgeDelegatedGuide(only);
    expect(g).not.toMatch(/그 엣지가 수집\*\*합니다/); expect(g).toMatch(/그 엣지 포탈에 이 서버의 OS 등록이 있어야 수집합니다/);
    const mixed = edgeDelegatedByAgent([{ reason: 'edge-delegated', agent: 'edge-pl', delegatedBy: 'os-registry' }, { reason: 'edge-delegated', agent: 'edge-pl', delegatedBy: 'collector' }], { stateOf: () => ok });
    expect(edgeDelegatedChip(mixed[0])).toBe('‘edge-pl’ 2대 · 정상 · 그중 1대는 OS 등록 엣지 지정(그 엣지에 OS 등록 확인 필요)');
    expect(edgeDelegatedGuide(mixed)).toMatch(/그 엣지가 수집\*\*합니다[\s\S]*OS 등록 엣지 지정/);
    expect(edgeDelegatedGuide(edgeDelegatedByAgent([{ reason: 'edge-delegated', agent: 'edge-us' }], { stateOf: () => ok }))).not.toMatch(/OS 등록 엣지 지정/);
    for (const v of [NO_PATH_REASON['os-edge'], NO_PATH_REASON['edge-delegated'], MISS_REASON_TEXT['os-edge'], ...missingFootnotes([{ missing: ['os-edge'] }]), WHY_TEXT['os-edge'].a, g]) {
      expect(v).not.toMatch(/엣지가 맡습니다|엣지가 수집하는 서버입니다/); expect(v.includes('`')).toBe(false);
    }
    expect(NO_PATH_REASON['os-edge']).toMatch(/그 엣지 포탈에 이 서버의 OS 등록이 있어야/);
  });
  it('재확인 N4 — 집중 모니터링 결측 사유 os-disabled · os-edge 문구(키 · 계정 설정이 아니다)', () => {
    for (const c of ['os-disabled', 'os-edge']) { expect(FOCUS_MISS_TEXT[c], c).toBeTruthy(); expect(FOCUS_MISS_TEXT[c]).not.toMatch(/키 · 계정/); expect(FOCUS_MISS_TEXT[c].includes('`')).toBe(false); }
  });
});
