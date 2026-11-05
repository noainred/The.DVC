/**
 * features2908.test.js — v2.908 기능 추천 6~10 화면 판정(알림함 · 리포트 · 멈춤 배지 · 업무 시간 달력 · 다른 알람 출처).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inboxKindText, pctText, hoursText, minToHHMM, hhmmToMin, splitDates, staleText, originText, slaBadge } from './issueText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('v2.908 기능 6~10 문구', () => {
  it('알림함 종류 · 퍼센트 · 시간 — 값이 없으면 — (0 으로 적지 않는다)', () => {
    expect(inboxKindText('mention')).toBe('언급');
    expect(inboxKindText('created')).toBe('할당');
    expect(inboxKindText('??')).toBe('알림');
    expect(pctText(null)).toBe('—');
    expect(pctText(0)).toBe('0%');
    expect(pctText(33.3)).toBe('33.3%');
    expect(hoursText(null)).toBe('—');
    expect(hoursText(6)).toBe('6시간');
    expect(hoursText(72)).toBe('3일');
  });
  it('업무 시간 입력 — HH:MM ↔ 분 · 휴일 나누기', () => {
    expect(minToHHMM(540)).toBe('09:00');
    expect(minToHHMM(1440)).toBe('24:00');
    expect(minToHHMM(-1)).toBe('');
    expect(hhmmToMin('18:30')).toBe(1110);
    expect(hhmmToMin('9:5')).toBe(null);
    expect(hhmmToMin('10:75')).toBe(null);
    expect(splitDates('2026-12-25, 2027-01-01\n2026-12-25')).toEqual(['2026-12-25', '2027-01-01']);
  });
  it('멈춤 배지 · 알람/백업 출처 · 업무 시간 SLA 설명', () => {
    expect(staleText(8)).toBe('멈춤 8일');
    expect(staleText(null)).toBe('');
    expect(originText({ kind: 'alert', title: 'vCenter 수집 실패: A', reopen: 2, resolvedAt: 1 })).toBe('자동 · 알람 · vCenter 수집 실패: A · 다시 발생 2회 · 해소됨');
    expect(originText({ kind: 'backup', deviceName: 'vm-a', parts: 3 })).toBe('자동 · 백업 실패 · vm-a · 실패 3회');
    const b = slaBadge({ resolve: { state: 'breached', targetMin: 60, usedMin: 90 }, calendar: { mode: 'business', tz: 'Europe/Warsaw' } });
    expect(b.title).toMatch(/업무 시간 기준\(Europe\/Warsaw\)/);
  });
  it('화면 — 알림함 · 리포트는 폴링하지 않는다(마운트 1회 + 버튼) · 리포트 수치는 서버 값 그대로', () => {
    const src = fs.readFileSync(path.join(HERE, 'IssuesR4.jsx'), 'utf8');
    expect(src).not.toMatch(/setInterval/);
    expect(src).toMatch(/fetchJson\('\/issues\/report'/);
    expect(src).toMatch(/fetchJson\('\/issues\/inbox'/);
    const wiki = fs.readFileSync(path.join(HERE, '../wiki/Wiki.jsx'), 'utf8');
    expect(wiki).toMatch(/href="#\/issues\/inbox"/);
    expect(wiki).not.toMatch(/setInterval\([^)]*inbox/);
  });
});
