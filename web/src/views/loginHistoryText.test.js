// v2.912 — 설정 › 로그 › 최근 로그인 · 로그인 횟수: 기간 계산 · 문구(순수 함수) + 화면 소스 규약.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOGIN_PERIOD_KEYS, periodLabel, accountText, fmtDateTime, fmtDay, agoText, dayRangeToQuery, defaultCustomDays,
  periodSpanText, partialNote,
} from './loginHistoryText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 기준 시각: 실제 시각을 정시로 떨어뜨린다(docs/rules/common.md).
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

describe('loginHistoryText', () => {
  it('기간 키는 서버 응답 키와 같고, 1달의 일수는 서버 windows 에서 읽는다', () => {
    expect(LOGIN_PERIOD_KEYS).toEqual(['d1', 'd7', 'd30', 'range']);
    expect(periodLabel('d30', [{ key: 'd30', days: 30 }])).toBe('최근 1달(30일)');
    expect(periodLabel('d30', [{ key: 'd30', days: 31 }])).toBe('최근 1달(31일)');
    expect(periodLabel('d30')).toBe('최근 1달');
    expect(periodLabel('d1', [])).toBe('최근 1일');
    expect(periodLabel('range')).toBe('사용자 정의');
  });

  it('계정 종류 문구', () => {
    expect(accountText('local')).toBe('로컬');
    expect(accountText('ad')).toBe('AD');
    expect(accountText('deleted')).toBe('삭제된 로컬 계정');
    expect(accountText('unknown')).toBe('모름');
    expect(accountText(undefined)).toBe('모름');
  });

  it('값이 없으면 — (0 이나 1970 년이 아니다)', () => {
    expect(fmtDateTime(null)).toBe('—');
    expect(fmtDateTime(undefined)).toBe('—');
    expect(agoText(null, NOW)).toBe('—');
    expect(fmtDay(NaN)).toBe('');
  });

  it('경과 문구', () => {
    expect(agoText(NOW - 10_000, NOW)).toBe('방금');
    expect(agoText(NOW - 5 * 60_000, NOW)).toBe('5분 전');
    expect(agoText(NOW - 3 * HOUR, NOW)).toBe('3시간 전');
    expect(agoText(NOW - 12 * DAY, NOW)).toBe('12일 전');
    expect(agoText(NOW + HOUR, NOW)).toBe('방금'); // 시계가 조금 어긋나도 음수 문구를 만들지 않는다
  });

  it('날짜 두 개 → [시작일 0시, 종료일 다음날 0시) · 잘못된 입력은 오류', () => {
    const r = dayRangeToQuery('2026-11-01', '2026-11-05', NOW);
    expect(r).toEqual({ from: new Date(2026, 10, 1).getTime(), to: new Date(2026, 10, 6).getTime() });
    const one = dayRangeToQuery('2026-11-05', '2026-11-05', NOW);
    expect(one.to - one.from).toBeGreaterThanOrEqual(23 * HOUR); // 하루(서머타임이면 23~25시간)
    expect(dayRangeToQuery('', '2026-11-05', NOW).error).toBeTruthy();
    expect(dayRangeToQuery('2026-02-30', '2026-03-01', NOW).error).toBeTruthy();
    expect(dayRangeToQuery('2026-11-06', '2026-11-05', NOW).error).toBeTruthy();
    expect(dayRangeToQuery(fmtDay(NOW + 3 * DAY), fmtDay(NOW + 4 * DAY), NOW).error).toBeTruthy();
  });

  it('사용자 정의 기본값은 오늘 포함 14일이고 그대로 조회할 수 있다', () => {
    const d = defaultCustomDays(NOW);
    expect(d.toDay).toBe(fmtDay(NOW));
    const q = dayRangeToQuery(d.fromDay, d.toDay, NOW);
    expect(q.error).toBeUndefined();
    expect(Math.round((q.to - q.from) / DAY)).toBe(14);
  });

  it('구간 문구 · partial 안내', () => {
    const data = {
      now: NOW, coverageFrom: NOW - 3 * DAY,
      windows: [{ key: 'd1', days: 1, from: NOW - DAY }, { key: 'd7', days: 7, from: NOW - 7 * DAY }],
      range: { from: new Date(2026, 10, 1).getTime(), to: new Date(2026, 10, 6).getTime() },
      partial: { d1: false, d7: true, range: true },
    };
    expect(periodSpanText(data, 'd1')).toBe(`${fmtDateTime(NOW - DAY)} ~ ${fmtDateTime(NOW)}`);
    expect(periodSpanText(data, 'range')).toBe('2026-11-01 ~ 2026-11-05');
    expect(partialNote(data, 'd1')).toBe('');
    expect(partialNote(data, 'd7')).toContain('0 회라는 뜻이 아닙니다');
    expect(partialNote(data, 'd7')).toContain(fmtDateTime(NOW - 3 * DAY));
    expect(partialNote({ ...data, coverageFrom: null }, 'd7')).toContain('아직 로그인 기록이 없습니다');
  });
});

describe('화면 소스 규약', () => {
  const src = fs.readFileSync(path.join(HERE, 'LoginHistory.jsx'), 'utf8');
  const settings = fs.readFileSync(path.join(HERE, 'Settings.jsx'), 'utf8');
  it('폴링하지 않는다(열 때 한 번 + 새로고침 버튼) · 표는 STable · 늦은 응답은 버린다', () => {
    expect(src).not.toMatch(/setInterval\(/);
    expect(src).not.toMatch(/<table\b/);
    expect(src).toMatch(/my === seq\.current/);
    expect(src).toMatch(/fetchJson\(`\/admin\/login-history\$\{q\}`\)/);
  });
  it('설정 › 로그 묶음에 두 화면이 있다', () => {
    expect(settings).toMatch(/\{ k: 'recent-logins', label: '최근 로그인', C: RecentLogins, group: 'log' \}/);
    expect(settings).toMatch(/\{ k: 'login-counts', label: '로그인 횟수', C: LoginCounts, group: 'log' \}/);
  });
  it('문구에 백틱 · 별표 강조가 없다', () => {
    const text = [...src.matchAll(/>([^<>{}]+)</g)].map((m) => m[1]).join('\n');
    expect(text).not.toMatch(/`|\*\*/);
  });
});
