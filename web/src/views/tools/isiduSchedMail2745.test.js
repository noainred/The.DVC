/**
 * v2.745 아이실론 디렉터리 사용량 — 대상별 결과 메일 '보내는 때'(조사가 끝날 때마다 / 정한 요일·시각) 화면 계약.
 *
 * 판정은 서버(`isidu/mailRules.js normalizeTargetMail`·`targetMailOf` · `digestRules.nextDigestSlots` · `bulk.js normalizeBulkPatch`)가 한다.
 * 화면은 입력 중에 미리 알려 줄 뿐이고, 웹은 서버 소스를 import 할 수 없어(번들 경계) 같은 규칙의 순수 사본을 둔다 —
 * 이 테스트가 같은 입력으로 서버 함수와 대조한다(isiduDigestText.test.js 와 같은 방식). 기준 시각은 고정한다(Date.now() 금지).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  blankTarget, formFromTarget, targetBody, mailStateText, targetMailLine,
  MAIL_WHEN_CHOICES, mailDaysOf, isMailTime, mailDaysText, mailScheduleText, nextMailSlots, mailSlotShort,
  mailScheduleIssue, firstMailScheduleIssue, mailWhenPreview, TARGET_MAIL_CODE_TEXT,
} from './isiduText.js';
import { nextSlots as digestNextSlots, slotShort as digestSlotShort, daysLabel as digestDaysLabel, scheduleText as digestScheduleText } from './isiduDigestText.js';
import { BULK_FIELD_KEYS, blankBulk, bulkPatchFrom, patchSummary } from './isiduBulkText.js';
import { stripComments } from '../../test/_stripComments.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(here, '../../../../server/src');
const M = await import('../../../../server/src/isidu/mailRules.js');
const R = await import('../../../../server/src/isidu/digestRules.js');
const B = await import('../../../../server/src/isidu/bulk.js');

const NOW = Date.UTC(2026, 9, 20, 2, 30);   // 2026-10-20(화) 11:30 KST — 고정
const OFF = 540;

describe('① 폼 ↔ 저장 본문 — 보내는 때·요일·시각·새 조사 없으면 생략', () => {
  it('새 대상·옛 저장값(mail 없음)은 서버 기본값(조사가 끝날 때마다 · 월 · 08:00 · 생략 켬)과 같다', () => {
    const D = M.TARGET_MAIL_DEFAULTS;
    for (const f of [blankTarget(), formFromTarget({ id: 'old', path: '/ifs/a' }), formFromTarget({ id: 'old2', path: '/ifs/a', mail: { to: ['a@corp.local'] } })]) {
      expect(f.mailWhen).toBe(D.when);
      expect(f.mailDays).toEqual([...D.days]);
      expect(f.mailTime).toBe(D.time);
      expect(f.mailSkipIfNoNew).toBe(D.skipIfNoNew);
    }
  });
  it('저장된 정기 발송 설정을 그대로 폼에 싣고, 저장 본문이 서버 정규화를 거쳐 같은 값으로 돌아온다', () => {
    const saved = { id: 't', path: '/ifs/a', mail: { to: ['a@corp.local'], when: 'schedule', days: [4, 1], time: '07:30', skipIfNoNew: false, since: 123 } };
    const f = formFromTarget(saved);
    expect(f).toMatchObject({ mailWhen: 'schedule', mailDays: [1, 4], mailTime: '07:30', mailSkipIfNoNew: false });
    const body = targetBody(f).mail;
    expect(body).toMatchObject({ when: 'schedule', days: [1, 4], time: '07:30', skipIfNoNew: false });
    expect('since' in body).toBe(false);   // since 는 서버가 정한다 — 화면이 보내지 않는다
    const r = M.normalizeTargetMail(body, saved.mail, NOW);
    expect(r.error).toBeUndefined();
    expect(r.mail).toMatchObject({ when: 'schedule', days: [1, 4], time: '07:30', skipIfNoNew: false });
    expect(r.mail.since).toBe(123);   // 정의가 같으면 서버가 since 를 유지한다(소급 발송 금지 기준이 흔들리지 않게)
    expect(M.targetMailOf({ mail: r.mail })).toMatchObject({ when: f.mailWhen, days: f.mailDays, time: f.mailTime, skipIfNoNew: f.mailSkipIfNoNew });
  });
  it('저장값과 같은 폼은 변경이 아니다 — 옛 저장값(필드 없음)과 기본값 폼의 저장 본문이 같다(일괄 탭 잠금이 거짓으로 걸리지 않게)', () => {
    const a = formFromTarget({ id: 't', path: '/ifs/a' });
    const b = formFromTarget({ id: 't', path: '/ifs/a', mail: { when: 'scan', days: [1], time: '08:00', skipIfNoNew: true } });
    expect(JSON.stringify(targetBody(a))).toBe(JSON.stringify(targetBody(b)));
  });
  it('보내는 때 선택지 키 = 서버 TARGET_MAIL_WHEN', () => {
    expect(MAIL_WHEN_CHOICES.map(([k]) => k)).toEqual([...M.TARGET_MAIL_WHEN]);
  });
});

describe('② 요일·시각 판정 — 서버 mailDaysOf·isMailTime·normalizeTargetMail 과 같은 답', () => {
  const dayInputs = [[1], [4, 1, 1], [0, 6], [7, -1, 3], ['2', '5'], [], [1.5, 2], [0, 1, 2, 3, 4, 5, 6]];
  it.each(dayInputs.map((d) => [d]))('요일 %j', (d) => { expect(mailDaysOf(d)).toEqual(M.mailDaysOf(d)); });
  const timeInputs = ['08:00', ' 07:30 ', '23:59', '00:00', '24:00', '8:00', '08:60', '', 'ab:cd', '12:5'];
  it.each(timeInputs.map((t) => [t]))('시각 %j', (t) => { expect(isMailTime(t)).toBe(M.isMailTime(t)); });
  it('정기 발송인데 요일이 없으면 저장을 잠그고, 서버도 같은 칸(mail.days)으로 거부한다', () => {
    const f = { ...blankTarget(), mailWhen: 'schedule', mailDays: [] };
    const iss = mailScheduleIssue(f);
    expect(iss).toMatchObject({ field: 'mail.days' });
    expect(iss.text).toMatch(/요일을 하나 이상/);
    expect(M.normalizeTargetMail(targetBody(f).mail, null, NOW).field).toBe('mail.days');
  });
  it('조사가 끝날 때마다면 요일이 비어도 잠그지 않는다(서버도 받는다)', () => {
    const f = { ...blankTarget(), mailWhen: 'scan', mailDays: [] };
    expect(mailScheduleIssue(f)).toBe(null);
    expect(M.normalizeTargetMail(targetBody(f).mail, null, NOW).error).toBeUndefined();
  });
  it('시각 형식이 틀리면 잠그고 서버도 mail.time 으로 거부한다', () => {
    const f = { ...blankTarget(), mailWhen: 'schedule', mailDays: [1], mailTime: '24:00' };
    expect(mailScheduleIssue(f)).toMatchObject({ field: 'mail.time' });
    expect(M.normalizeTargetMail(targetBody(f).mail, null, NOW).field).toBe('mail.time');
  });
  it('여러 대상 중 첫 문제를 대상 번호와 함께 짚는다(선택하지 않은 대상의 문제도 저장을 막는다)', () => {
    const forms = [blankTarget(), { ...blankTarget(), label: '본사', mailWhen: 'schedule', mailDays: [] }];
    expect(firstMailScheduleIssue(forms)).toMatchObject({ index: 1, field: 'mail.days' });
    expect(firstMailScheduleIssue(forms).text).toMatch(/본사/);
    expect(firstMailScheduleIssue([blankTarget()])).toBe(null);
  });
});

describe('③ 다음 발송 미리보기 — 서버 nextDigestSlots 와 같은 시각(KST) · 종합 메일 화면 사본과도 같다', () => {
  const nows = [NOW, Date.UTC(2026, 9, 18, 22, 59), Date.UTC(2026, 9, 18, 23, 0), Date.UTC(2026, 11, 31, 14, 50), Date.UTC(2027, 1, 28, 15, 1)];
  const defs = [{ days: [1], time: '08:00' }, { days: [1, 4], time: '08:00' }, { days: [0, 6], time: '00:10' }, { days: [0, 1, 2, 3, 4, 5, 6], time: '23:50' }, { days: [3], time: '09:05' }];
  for (const now of nows) {
    for (const d of defs) {
      it(`${new Date(now).toISOString()} · ${d.days.join('')} ${d.time}`, () => {
        const web = nextMailSlots(d, now, 3, OFF);
        expect(web).toEqual(R.nextDigestSlots({ enabled: true, days: d.days, time: d.time }, now, 3, OFF));
        expect(web).toEqual(digestNextSlots({ enabled: true, days: d.days, hour: d.time.slice(0, 2), minute: d.time.slice(3, 5) }, now, 3, OFF));
        for (const s of web) expect(mailSlotShort(s, OFF)).toBe(digestSlotShort(s, OFF));
      });
    }
  }
  it('요일 표기·일정 한 줄 — 서버·종합 메일 화면과 같은 글자', () => {
    for (const d of [[1, 2, 3, 4, 5], [0, 1, 2, 3, 4, 5, 6], [1, 4], [], [6, 0]]) {
      expect(mailDaysText(d)).toBe(R.daysLabel(d));
      expect(mailDaysText(d)).toBe(digestDaysLabel(d));
      expect(mailScheduleText(d, '08:00')).toBe(digestScheduleText(d, '08:00'));
    }
  });
  it('미리보기 — 정기면 다음 3회, 요일이 없거나 조사가 끝날 때마다면 회차 없음', () => {
    const p = mailWhenPreview({ ...blankTarget(), mailWhen: 'schedule', mailDays: [1, 4], mailTime: '08:00' }, NOW, OFF);
    expect(p.slots).toHaveLength(3);
    expect(p.text).toMatch(/^다음 발송: 10\/22\(목\) 08:00 · 10\/26\(월\) 08:00 · 10\/29\(목\) 08:00/);
    expect(mailWhenPreview({ ...blankTarget(), mailWhen: 'schedule', mailDays: [] }, NOW, OFF).slots).toEqual([]);
    expect(mailWhenPreview({ ...blankTarget(), mailWhen: 'scan' }, NOW, OFF).slots).toEqual([]);
  });
});

describe('④ 마지막 메일 기록의 code — 서버 TARGET_MAIL_CODES 와 1:1', () => {
  it('문구 표 키 = 서버 목록(소스에서 뽑은 것 · import 한 것 둘 다)', () => {
    const src = fs.readFileSync(path.join(SERVER, 'isidu/mailRules.js'), 'utf8');
    const m = src.match(/export const TARGET_MAIL_CODES = Object\.freeze\(\[([^\]]*)\]\)/);
    expect(m).toBeTruthy();
    const fromSrc = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect(Object.keys(TARGET_MAIL_CODE_TEXT).sort()).toEqual([...fromSrc].sort());
    expect(Object.keys(TARGET_MAIL_CODE_TEXT).sort()).toEqual([...M.TARGET_MAIL_CODES].sort());
  });
  it('서버 notify.js 가 기록하는 code 는 전부 목록 안에 있다', () => {
    const src = fs.readFileSync(path.join(SERVER, 'isidu/notify.js'), 'utf8');
    const codes = new Set([...src.matchAll(/code:\s*'([a-z-]+)'/g)].map((x) => x[1]));
    for (const x of src.matchAll(/\?\s*'(missed-[a-z]+)'\s*:\s*'(missed-[a-z]+)'/g)) { codes.add(x[1]); codes.add(x[2]); }
    expect(codes.size).toBeGreaterThan(3);
    for (const c of codes) expect(M.TARGET_MAIL_CODES, c).toContain(c);
  });
  it('정기 회차 기록 한 줄 — 회차·사유를 말하고, 놓친 회차는 주의 · DB 실패는 실패', () => {
    const slot = Date.UTC(2026, 9, 19, 23, 0);   // 10/20(화) 08:00 KST
    const a = mailStateText({ kind: 'result', schedule: true, slot, state: 'skipped', code: 'no-new', at: NOW - 60_000, reason: '서버 문장' }, NOW);
    expect(a.text).toMatch(/정기 결과 메일\(10\/20\(화\) 08:00 회차\)/);
    expect(a.text).toContain(TARGET_MAIL_CODE_TEXT['no-new']);
    expect(a.tone).toBe('muted');
    const m = mailStateText({ kind: 'result', schedule: true, slot, state: 'skipped', code: 'missed-down', count: 3, at: NOW }, NOW);
    expect(m.tone).toBe('warn');
    expect(m.text).toMatch(/놓침/);
    expect(m.text).toMatch(/3번/);
    const f = mailStateText({ kind: 'result', schedule: true, slot, state: 'failed', code: 'no-report', at: NOW, reason: '결과 DB 를 열지 못해 보내지 않았습니다.' }, NOW);
    expect(f.tone).toBe('bad');
    expect(f.text).toMatch(/DB/);
    const s = mailStateText({ kind: 'result', schedule: true, slot, state: 'sent', at: NOW, to: 2, accepted: 2 }, NOW);
    expect(s.tone).toBe('ok');
    expect(s.text).toMatch(/정기 결과 메일.*보냄 · 2명/);
    // 모르는 코드는 서버 사유를 그대로 쓴다(지어내지 않는다).
    expect(mailStateText({ kind: 'result', state: 'skipped', code: 'xyz', at: NOW, reason: '서버가 말한 사유' }, NOW).text).toMatch(/서버가 말한 사유/);
  });
});

describe('⑤ 목록·상태 화면의 메일 칸 — 정기 발송이면 일정과 다음 회차를 말한다', () => {
  const next = [Date.UTC(2026, 9, 21, 23, 0), Date.UTC(2026, 9, 25, 23, 0)];
  it('정기 · 요일 시각 · 다음 회차(서버 rows 의 next)', () => {
    const l = targetMailLine({ mail: { recipients: 2, when: 'schedule', days: [1, 4], time: '08:00', skipIfNoNew: true, next } }, NOW);
    expect(l.text).toMatch(/결과 메일: 받는 사람 2명 · 정기 · 월·목 08:00 · 다음 10\/22\(목\) 08:00 · 새 조사 없으면 생략/);
  });
  it('다음 회차가 없으면 —', () => {
    const l = targetMailLine({ mail: { recipients: 1, when: 'schedule', days: [1], time: '08:00', skipIfNoNew: false, next: [] } }, NOW);
    expect(l.text).toMatch(/정기 · 월 08:00 · 다음 —/);
    expect(l.text).not.toMatch(/새 조사 없으면 생략/);
  });
  it('조사가 끝날 때마다(옛 응답 — when 없음 포함)는 예전 문구 그대로', () => {
    expect(targetMailLine({ mail: { recipients: 2, onlyOnChange: true, onFailure: true } }, NOW).text).toMatch(/받는 사람 2명 · 변화 없으면 생략 · 실패 알림 · 아직 보낸 적 없음/);
    expect(targetMailLine({ mail: { recipients: 2, when: 'scan', onlyOnChange: false, onFailure: false, next: [] } }, NOW).text).not.toMatch(/정기/);
  });
  it('정기 발송의 실패 알림은 조사 직후라고 말한다', () => {
    expect(targetMailLine({ mail: { recipients: 2, when: 'schedule', days: [1], time: '08:00', onFailure: true, next } }, NOW).text).toMatch(/실패 알림\(조사 직후\)/);
  });
  it('표 칸용 조각(parts)은 문장과 같은 내용을 한 줄씩 — 좁은 칸에서 글자 단위로 쪼개지지 않게', () => {
    const l = targetMailLine({ mail: { recipients: 2, when: 'schedule', days: [1, 4], time: '08:00', skipIfNoNew: true, onFailure: true, next } }, NOW);
    expect(l.parts).toEqual(['받는 사람 2명', '정기 · 월·목 08:00', '다음 10/22(목) 08:00', '새 조사 없으면 생략', '실패 알림(조사 직후)', '아직 보낸 적 없음']);
    expect(`결과 메일: ${l.parts.join(' · ')}`).toBe(l.text);
    const noRcpt = targetMailLine({ mail: { recipients: 0 }, lastMail: { kind: 'result', state: 'sent', at: NOW - 60_000, count: 1 } }, NOW);
    expect(noRcpt.parts[0]).toBe('받는 사람이 없습니다(지금은 보내지 않습니다)');
    expect(noRcpt.parts.length).toBe(2);
  });
  it('수집 상태 표의 메일 칸은 조각을 줄마다 그리고 칸 폭을 지킨다', () => {
    const V = stripComments(fs.readFileSync(path.join(here, 'IsiduViews.jsx'), 'utf8'));
    expect(V).toMatch(/ml\.parts\.map\(/);
    expect(V).toMatch(/className="isd-note isd-mailcell"/);
    const C = stripComments(fs.readFileSync(path.join(here, "isidu.css"), "utf8"));
    expect(C).toMatch(/\.isd \.isd-mailcell \{[^}]*min-width:\s*160px/);
  });
});

describe('⑥ 일괄 변경 4항목 — 서버 normalizeBulkPatch 와 같은 답', () => {
  it('항목 키가 있다(전체 키 대조는 isiduOverview2739.test.js)', () => {
    for (const k of ['mailWhen', 'mailDays', 'mailTime', 'mailSkipIfNoNew']) expect(BULK_FIELD_KEYS).toContain(k);
    for (const k of ['mailWhen', 'mailDays', 'mailTime', 'mailSkipIfNoNew']) expect(B.BULK_KEYS).toContain(k);
  });
  it('고른 값이 patch 로 가고 서버가 같은 값으로 받는다', () => {
    const { patch, issues } = bulkPatchFrom({ ...blankBulk(), mailWhen: 'schedule', mailDays: [4, 1], mailTime: '07:30', mailSkipIfNoNew: 'off' });
    expect(issues).toEqual([]);
    expect(patch).toEqual({ mailWhen: 'schedule', mailDays: [1, 4], mailTime: '07:30', mailSkipIfNoNew: false });
    const r = B.normalizeBulkPatch(patch);
    expect(r.error).toBeUndefined();
    expect(r.patch).toMatchObject(patch);
    const s = patchSummary(patch);
    expect(s).toMatch(/정한 요일·시각/); expect(s).toMatch(/월·목/); expect(s).toMatch(/07:30/); expect(s).toMatch(/새 조사 없으면 생략 끄기/);
  });
  it('요일을 지정하고 하나도 고르지 않으면 화면이 막고, 서버도 mailDays 로 거부한다', () => {
    const { patch, issues } = bulkPatchFrom({ ...blankBulk(), mailDays: [] });
    expect(issues.map((x) => x.key)).toContain('mailDays');
    expect('mailDays' in patch).toBe(false);
    expect(B.normalizeBulkPatch({ mailDays: [] }).field).toBe('mailDays');
  });
  it('그대로(빈 값)는 싣지 않는다', () => {
    expect(bulkPatchFrom(blankBulk()).patch).toEqual({});
  });
});

describe('⑦ 화면 소스 — 저장 잠금·안내·공용 컴포넌트', () => {
  const S = stripComments(fs.readFileSync(path.join(here, 'IsiduSettings.jsx'), 'utf8'));
  it('정기 발송 문제가 있으면 저장 버튼을 잠근다', () => {
    expect(S).toMatch(/firstMailScheduleIssue\(forms\)/);
    expect(S).toMatch(/disabled=\{locked \|\| saving \|\| !!schedIssue\}/);
  });
  it('실패 알림은 정한 시각과 무관하게 조사 직후라는 안내가 있다', () => {
    expect(S).toMatch(/조사 실패 알림은 정한 시각과 무관하게 조사 직후 보냅니다/);
  });
  it('요일 칩은 종합 메일 화면과 같은 모양(isd-days · isd-day)이고 날 select 를 쓰지 않는다', () => {
    expect(S).toMatch(/className="isd-days"/);
    expect(S).toMatch(/isd-day\$\{on \? ' on' : ''\}/);
    expect(S).not.toMatch(/<select\b/);
  });
});

describe('⑧ 일괄 변경 화면·CSS — 4항목을 실제로 그리고 400px 에서 줄이 넘치지 않는다', () => {
  const S = stripComments(fs.readFileSync(path.join(here, 'IsiduBulk.jsx'), 'utf8'));
  const C = stripComments(fs.readFileSync(path.join(here, 'isidu.css'), 'utf8'));
  it('요일(days)·시각(time) 종류를 각자 그린다 — 다른 종류로 떨어지면 입력할 길이 없다', () => {
    expect(S).toMatch(/f\.kind === 'days'/);
    expect(S).toMatch(/f\.kind === 'time'/);
    expect(S).toMatch(/className="isd-bulkdays"/);
    expect(S).toMatch(/className="isd-bulktime"/);
  });
  it('보내는 때 선택지는 isiduBulkText 의 MAIL_WHEN_OPTIONS(= 서버 TARGET_MAIL_WHEN) 를 쓴다', () => {
    expect(S).toMatch(/f\.key === 'mailWhen'\) opts = MAIL_WHEN_OPTIONS/);
    expect(S).not.toMatch(/<select\b/);
  });
  it('정기 발송 칸·일괄 시각 줄은 좁은 폭에서 줄을 바꾼다(flex-wrap) · 일괄 요일 칩은 7칸 minmax(0,1fr)', () => {
    const rule = (sel) => { const i = C.indexOf(`${sel} {`); return i < 0 ? '' : C.slice(i, C.indexOf('}', i)); };
    expect(rule('.isd-form .isd-mailsched .row')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule('.isd-form .isd-bulktime')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule('.isd-form .isd-bulkdays .isd-days')).toMatch(/repeat\(7,\s*minmax\(0,\s*1fr\)\)/);
    expect(rule('.isd-form .isd-mailsched')).toMatch(/min-width:\s*0/);
  });
});
