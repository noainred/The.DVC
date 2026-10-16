/**
 * 아이실론 종합 메일 설정 화면 판정(v2.742) — 서버 규칙의 사본이 서버와 같은 답을 내는지 같은 입력으로 대조한다.
 *  ① 받는 사람(recipientsOf ↔ digestRecipients) ② 다음 회차(nextSlots ↔ nextDigestSlots) ③ 요일 표기 ④ 기록 코드 표 1:1
 *  ⑤ 대상 상태(서버 statusOfRow ↔ 웹 targetStatus — 메일과 화면이 같은 상태를 말한다) ⑥ 실패 제목(FAIL_TITLE ↔ FAIL_TEXT)
 *  ⑦ 폼 ↔ 본문 · 입력 중 문제 · 탭 주소
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  recipientsOf, nextSlots, daysLabel, scheduleText, formFromDigest, digestBody, formIssues, toggleDay, minuteChoices,
  slotText, historyLine, sendResultText, MISSED_TEXT, SKIP_TEXT,
} from './isiduDigestText.js';
import { targetStatus, FAIL_TEXT } from './isiduText.js';
import { isiduSettingsTabOf, ISIDU_SETTINGS_DIGEST_HASH } from './isiduSettingsLink.js';
import { hashSegments } from '../../hooks/hashTab.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(here, '../../../../server/src');
const R = await import('../../../../server/src/isidu/digestRules.js');
const H = 3_600_000;
const D = 86_400_000;

describe('① 받는 사람 — 서버 digestRecipients 와 같은 답', () => {
  const cases = [
    [{ includeAdmin: true, to: 'lead@corp.local\nnew@corp.local' }, ['admin@corp.local', 'Lead@corp.local', 'bad']],
    [{ includeAdmin: false, to: 'x@corp.local, X@corp.local; y@corp.local' }, ['admin@corp.local']],
    [{ includeAdmin: true, to: '' }, []],
    [{ includeAdmin: true, to: 'a@corp.local a@corp.local' }, ['A@corp.local']],
  ];
  it.each(cases)('%j / %j', (f, admin) => {
    const web = recipientsOf(f, admin);
    const srv = R.digestRecipients({ includeAdmin: f.includeAdmin, to: f.to.split(/[\s,;]+/).filter(Boolean) }, admin);
    expect(web.count).toBe(srv.to.length);
    expect(web.fromAdmin).toBe(srv.fromAdmin);
    expect(web.fromExtra).toBe(srv.fromExtra);
  });
  it('형식이 틀린 주소는 세지 않고 알린다', () => {
    const r = recipientsOf({ includeAdmin: false, to: 'ok@corp.local\nnope' }, []);
    expect(r.count).toBe(1); expect(r.invalid).toEqual(['nope']);
  });
});

describe('② 다음 회차 — 서버 nextDigestSlots 와 같은 시각(KST)', () => {
  const nows = [Date.UTC(2026, 9, 16, 3, 0), Date.UTC(2026, 9, 18, 22, 59), Date.UTC(2026, 9, 18, 23, 0), Date.UTC(2026, 11, 31, 14, 50), Date.UTC(2027, 1, 28, 15, 1)];
  const defs = [
    { days: [1], hour: '08', minute: '00' }, { days: [1, 2, 3, 4, 5], hour: '23', minute: '50' }, { days: [0, 6], hour: '00', minute: '10' },
    { days: [0, 1, 2, 3, 4, 5, 6], hour: '12', minute: '05' }, { days: [3], hour: '09', minute: '30' },
  ];
  for (const now of nows) {
    for (const d of defs) {
      it(`${new Date(now).toISOString()} · ${d.days.join('')} ${d.hour}:${d.minute}`, () => {
        const web = nextSlots({ enabled: true, ...d }, now, 3, 540);
        const srv = R.nextDigestSlots({ enabled: true, days: d.days, time: `${d.hour}:${d.minute}` }, now, 3, 540);
        expect(web).toEqual(srv);
        for (const s of web) expect(slotText(s, 540)).toBe(R.slotLabel(s, 540));
      });
    }
  }
  it('꺼져 있거나 요일이 없으면 회차 없음', () => {
    expect(nextSlots({ enabled: false, days: [1], hour: '08', minute: '00' }, Date.now())).toEqual([]);
    expect(nextSlots({ enabled: true, days: [], hour: '08', minute: '00' }, Date.now())).toEqual([]);
  });
});

describe('③ 요일 표기 — 서버와 같은 글자', () => {
  it.each([[[1, 2, 3, 4, 5]], [[0, 1, 2, 3, 4, 5, 6]], [[1, 3, 5]], [[]], [[6, 0]]])('%j', (days) => {
    expect(daysLabel(days)).toBe(R.daysLabel(days));
  });
  it('일정 한 줄', () => {
    expect(scheduleText([1, 3, 5], '08:00')).toBe('매주 월·수·금 08:00');
    expect(scheduleText([1, 2, 3, 4, 5], '07:30')).toBe('평일 07:30');
  });
});

describe('④ 기록 코드 — 서버 목록과 1:1', () => {
  it('놓침 사유', () => { expect(Object.keys(MISSED_TEXT).sort()).toEqual([...R.DIGEST_MISSED_REASONS].sort()); });
  it('생략 사유', () => { expect(Object.keys(SKIP_TEXT).sort()).toEqual([...R.DIGEST_SKIP_CODES].sort()); });
  it('서버 digest.js 가 기록하는 code 는 전부 목록 안에 있다', () => {
    const src = fs.readFileSync(path.join(SERVER, 'isidu/digest.js'), 'utf8');
    const codes = new Set([...src.matchAll(/code:\s*'([a-z-]+)'/g)].map((m) => m[1]));
    for (const m of src.matchAll(/'([a-z-]+)'\s*:\s*'([a-z-]+)'/g)) { codes.add(m[1]); codes.add(m[2]); }
    for (const c of [...codes].filter((c) => !['manual', 'schedule', 'sent', 'skipped', 'failed', 'missed', 'edge'].includes(c))) {
      expect(R.DIGEST_SKIP_CODES.includes(c) || R.DIGEST_MISSED_REASONS.includes(c), c).toBe(true);
    }
  });
  it('기록 한 줄', () => {
    expect(historyLine({ state: 'sent', slot: Date.UTC(2026, 9, 18, 23, 0), to: 3, targets: 13, corps: 4 }).text).toBe('3명 · 대상 13개 · 법인 4곳');
    expect(historyLine({ state: 'missed', code: 'down', count: 2 }).text).toMatch(/꺼져 있던.*2번/);
    expect(historyLine({ state: 'skipped', code: 'no-new', kind: 'schedule' }).tag).toBe('생략');
    expect(historyLine({ state: 'failed', reason: 'SMTP 연결 실패', kind: 'manual' }).text).toBe('지금 보내기 · SMTP 연결 실패');
    expect(historyLine({ state: 'sent', slot: Date.UTC(2026, 9, 18, 23, 0) }).when).toBe('10/19(월) 08:00');
  });
  it('보내기 결과 문구', () => {
    expect(sendResultText({ ok: true, state: 'sent', to: 2, targets: 5 }).tone).toBe('ok');
    expect(sendResultText({ ok: false, state: 'skipped', code: 'no-recipients' }).text).toMatch(/받는 사람이 없습니다/);
    expect(sendResultText({ ok: false, state: 'failed', reason: 'x' }).tone).toBe('bad');
  });
});

describe('⑤ 대상 상태 — 메일(서버 statusOfRow)과 화면(targetStatus)이 같은 key·tone', () => {
  const now = Date.UTC(2026, 9, 16, 3, 0);
  const ok = { id: 1, ts: now - H, errLines: 0 };
  const rows = [
    null,
    { issue: 'device-missing' },
    { enabled: false },
    { deviceDisabled: true },
    { running: { since: now - H } },
    { interrupted: { since: now - H } },
    { request: { state: 'taken' } },
    { request: { state: 'queued' } },
    { authStopped: { at: now } },
    { okScan: ok, lastTry: { ok: false, ts: now, kind: 'timeout' } },
    { okScan: null, lastTry: { ok: false, ts: now, kind: 'auth' } },
    { okScan: null },
    { okScan: { ...ok, ts: now - 4 * D }, intervalHours: 24, timeoutMin: 120 },
    { okScan: { ...ok, ts: now - 4 * D }, intervalHours: 72, timeoutMin: 120 },
    { okScan: { ...ok, errLines: 3 } },
    { okScan: ok },
  ];
  it.each(rows.map((r, i) => [i, r]))('행 %i', (_i, t) => {
    const a = R.statusOfRow(t, now); const b = targetStatus(t, now);
    expect(a.key).toBe(b.key);
    expect(a.tone).toBe(b.tone);
  });
});

describe('⑥ 실패 제목 — 메일(FAIL_TITLE)과 화면(FAIL_TEXT)이 같은 글자', () => {
  it('키 집합과 제목', () => {
    expect(Object.keys(R.FAIL_TITLE).sort()).toEqual(Object.keys(FAIL_TEXT).sort());
    for (const k of Object.keys(FAIL_TEXT)) expect(R.FAIL_TITLE[k]).toBe(FAIL_TEXT[k].title);
  });
});

describe('⑦ 폼 ↔ 본문 · 입력 중 문제 · 탭 주소', () => {
  it('옛 설정(필드 없음)은 기본값', () => {
    const f = formFromDigest(undefined);
    expect(f).toMatchObject({ enabled: false, days: [1], hour: '08', minute: '00', includeAdmin: true, to: '', topN: 10, includeWatch: true, includeTargets: true, skipIfNoNew: false });
  });
  it('왕복하면 서버 정규화를 통과한다', () => {
    const f = formFromDigest({ enabled: true, days: [5, 1, 3], time: '07:30', to: ['a@corp.local'], topN: 20, skipIfNoNew: true });
    const body = digestBody(f);
    expect(body).toMatchObject({ enabled: true, days: [1, 3, 5], time: '07:30', to: 'a@corp.local', topN: 20, skipIfNoNew: true });
    const n = R.normalizeDigest({ ...body, to: body.to.split('\n') }, null, 1);
    expect(n.error).toBeUndefined();
    expect(n.digest.time).toBe('07:30');
  });
  it('10분 단위가 아닌 저장 값은 선택지에 넣어 보인다', () => {
    expect(minuteChoices('05')).toContain('05');
    expect(minuteChoices('20')).toEqual(['00', '10', '20', '30', '40', '50']);
  });
  it('요일 토글', () => { expect(toggleDay([1, 3], 3)).toEqual([1]); expect(toggleDay([1], 0)).toEqual([0, 1]); });
  it('입력 중 문제 — 서버와 같은 이유', () => {
    const base = formFromDigest({ enabled: true, days: [1], time: '08:00' });
    expect(formIssues({ ...base, days: [] }, []).days).toMatch(/요일/);
    expect(R.normalizeDigest({ enabled: true, days: [] }, null).field).toBe('digest.days');
    expect(formIssues({ ...base, to: 'nope' }, []).to).toMatch(/형식이 틀린 주소 1개/);
    expect(formIssues({ ...base, includeAdmin: false, to: '' }, ['a@corp.local']).noRecipients).toMatch(/받는 사람이 없습니다/);
    expect(formIssues({ ...base, includeAdmin: true, to: '' }, ['a@corp.local'])).toEqual({});
    expect(formIssues({ ...base, enabled: false, days: [] }, []).days).toBeUndefined();
  });
  it('탭 주소', () => {
    expect(isiduSettingsTabOf(hashSegments(ISIDU_SETTINGS_DIGEST_HASH))).toBe('digest');
    expect(isiduSettingsTabOf(['settings', 'metrics', 'digest'])).toBe('edit');
  });
  it('메일 본문의 \'바꾸는 곳\' 안내가 실제 탭 이름을 가리킨다', () => {
    const src = fs.readFileSync(path.join(SERVER, 'isidu/mailHtml.js'), 'utf8');
    expect(src).toMatch(/› 종합 메일/);
    const jsx = fs.readFileSync(path.join(here, 'IsiduSettings.jsx'), 'utf8');
    expect(jsx).toMatch(/>종합 메일</);
  });
});
