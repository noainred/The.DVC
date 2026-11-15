/**
 * 베어메탈 사용률 점검 반복 1회차 — 새 사유 code(D3 · D4 대상 제외 · D5 iDRAC 실패)가 화면 문구 표마다 있다(모르는 code 를 글자 그대로 보이지 않게) · 백틱 없음.
 *   서버 열거와 1:1 은 bmStage6Text(REASON_TEXT ↔ HEALTH_REASON_CODES) · bmPerfOpsText(FOCUS_MISS_TEXT ↔ FOCUS_MISS) · server bmFolders2992(WHY_CODES ↔ whyText)가 고정한다.
 */
import { describe, it, expect } from 'vitest';
import { SKIP_LABEL, MISSING_MARK, skippedNotes, missingFootnotes, missingMark } from './bmUsageText.js';
import { MISS_REASON_TEXT } from './bmOnboardText.js';
import { WHY_TEXT } from './bmFolders/whyText.js';
import { REASON_TEXT } from './bmCollectText.js';
import { FOCUS_MISS_TEXT } from './bmPerfOpsText.js';
import { NO_PATH_REASON } from '../../../../server/src/bmusage/targets.js';

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
});
