/**
 * 베어메탈 사용률 점검 반복 3회차(기준판 5c6d87a6b) — 웹 쪽 문구 고정.
 *   D1 재확인 버튼이 합 규칙에 막힌 창의 안내(서버 표지 confirmOwner — 재확인 라우트와 같은 판정 · 숫자는 API limits)
 *   I1 알림 이력의 모르는 규칙(서버 정제가 'unknown' 으로 둔다)은 ‘알 수 없는 규칙’ — 다른 규칙 이름으로 보이지 않게
 *   서버 쪽(실제 라우터 · 판정 · 정제)은 server/test/bmUsageLoop3.test.js · bmUsageLoop3Edge.test.js.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { RULE_TEXT, sentRuleText, UNKNOWN_RULE_TEXT, UNKNOWN_RULE_HINT } from './bmPerfOpsText.js';
import { confirmOwnerNote } from './bmMaintText.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const src = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');

describe('I1 알림 이력 규칙 칸', () => {
  it('모르는 규칙은 ‘알 수 없는 규칙’ · 아는 규칙은 그 이름 · 값 없음은 —', () => {
    expect(sentRuleText('unknown')).toBe(UNKNOWN_RULE_TEXT);
    expect(sentRuleText('unknown')).not.toBe(RULE_TEXT.use.label);
    expect(sentRuleText('use')).toBe(RULE_TEXT.use.label);
    expect(sentRuleText('capacity')).toBe(RULE_TEXT.capacity.label);
    expect(sentRuleText('')).toBe('—');
    for (const s of [UNKNOWN_RULE_TEXT, UNKNOWN_RULE_HINT]) expect(s).not.toMatch(/`/);
  });
  it('알림 이력 표는 sentRuleText 로 그린다(RULE_TEXT 를 직접 찾아 원문 id 를 내보이지 않는다)', () => {
    const p = src('BmPerfRulesPanel.jsx');
    expect(p).toMatch(/data-sort=\{sentRuleText\(x\.rule\)\}/);
    expect(p).not.toMatch(/\{RULE_TEXT\[x\.rule\]\?\.label \|\| x\.rule\}/);
  });
  it('서버 정제의 모르는 규칙 값과 같은 글자(unknown)', () => {
    const server = fs.readFileSync(path.join(HERE, '../../../../server/src/central/bmPerfOpsPull.js'), 'utf8');
    expect(server).toMatch(/export const UNKNOWN_RULE = 'unknown';/);
  });
});

describe('D1 재확인 안내(합 규칙)', () => {
  it('숫자는 limits 값 · 없으면 — · 백틱 없음', () => {
    expect(confirmOwnerNote({ ownerOverMin: 720 })).toMatch(/12시간/);
    expect(confirmOwnerNote({ ownerOverMin: 720 })).toMatch(/고치기는 재확인이 아닙니다/);
    expect(confirmOwnerNote({})).toMatch(/—/);
    expect(confirmOwnerNote({ ownerOverMin: 720 })).not.toMatch(/`/);
  });
  it('정비 창 표는 서버 표지 confirmOwner 가 combined 일 때만 안내를 그린다(버튼은 canConfirm 그대로)', () => {
    const p = src('BmMaintPanel.jsx');
    expect(p).toMatch(/w\.confirmOwner === 'combined' && <div className="bmo-note">\{confirmOwnerNote\(resp\.limits \|\| \{\}\)\}<\/div>/);
    expect(p).toMatch(/\{w\.canConfirm && w\.schedule\?\.kind !== 'once' && <button/);
  });
});
