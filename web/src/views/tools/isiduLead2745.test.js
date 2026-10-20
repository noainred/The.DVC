/**
 * isiduLead2745.test.js — v2.745 검토 확정분 중 리드 통합분(웹).
 *   SCHED-04·WEB-2745-02·F5 대상 메일의 다음 발송·회차 표기는 서버가 준 포탈 시각 오프셋(offsetMin)을 쓰고, 540 이 아니면 '한국 시각' 이라 적지 않는다.
 *   SCHED-03 서버 TARGET_MAIL_CODES 의 'missed-clock' 문구(주의 톤 · 놓친 회차 수).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { portalTimeLabel, mailWhenPreview, mailStateText, TARGET_MAIL_CODE_TEXT, targetMailLine } from './isiduText.js';
import { stripComments } from '../../test/_stripComments.js';

const read = (p) => stripComments(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);   // 고정 시각(순수 계산) — 일요일 12:00 UTC = 일요일 21:00 KST

describe('포탈 시각 이름', () => {
  it('540 이면 한국 시각 · 그 밖은 UTC 오프셋', () => {
    expect(portalTimeLabel(540)).toBe('한국 시각');
    expect(portalTimeLabel(undefined)).toBe('한국 시각');
    expect(portalTimeLabel(0)).toBe('포탈 시각 UTC+0');
    expect(portalTimeLabel(-300)).toBe('포탈 시각 UTC−5');
    expect(portalTimeLabel(330)).toBe('포탈 시각 UTC+5:30');
  });
  it('미리보기는 그 오프셋으로 계산하고 이름도 그 오프셋을 따른다', () => {
    const f = { mailWhen: 'schedule', mailDays: [1], mailTime: '08:00' };
    const k = mailWhenPreview(f, NOW, 540);
    const u = mailWhenPreview(f, NOW, 0);
    expect(k.text).toMatch(/\(한국 시각\)$/);
    expect(u.text).toMatch(/\(포탈 시각 UTC\+0\)$/);
    expect(u.text).not.toMatch(/한국 시각/);
    expect(u.slots[0] - k.slots[0]).toBe(9 * 3_600_000);   // 같은 '월 08:00' 이 9시간 늦게
  });
  it('대상 화면이 서버 offsetMin 을 넘긴다(IsilonDirUsageTool · IsiduViews · IsiduSettings)', () => {
    expect(read('./IsilonDirUsageTool.jsx')).toMatch(/targetMailLine\(target, now, data\?\.offsetMin\)/);
    expect(read('./IsiduViews.jsx')).toMatch(/targetMailLine\(t, now, data\?\.offsetMin\)/);
    const s = read('./IsiduSettings.jsx');
    expect(s).toMatch(/portalTimeLabel\(mailOff\)/);
    expect(s).not.toMatch(/'정한 요일·시각\(한국 시각\)에/);
  });
  it('회차 표기는 오프셋을 따른다', () => {
    const t = { mail: { recipients: 1, when: 'schedule', days: [1], time: '08:00', next: [NOW] }, lastMail: null };
    expect(targetMailLine(t, NOW, 540).text).toMatch(/다음 10\/4\(일\) 21:00/);
    expect(targetMailLine(t, NOW, 0).text).toMatch(/다음 10\/4\(일\) 12:00/);
  });
});

describe('missed-clock', () => {
  it('서버 코드와 같은 키의 문구 · 주의 톤 · 놓친 회차 수', () => {
    expect(TARGET_MAIL_CODE_TEXT['missed-clock']).toMatch(/시계/);
    const r = mailStateText({ state: 'skipped', kind: 'result', schedule: true, slot: NOW, code: 'missed-clock', count: 3, at: NOW }, NOW);
    expect(r.tone).toBe('warn');
    expect(r.text).toMatch(/놓침/);
    expect(r.text).toMatch(/놓친 회차 3번/);
  });
});
