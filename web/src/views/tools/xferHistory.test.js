/**
 * v2.902 전송 속도 상세 '히스토리 보기' 강화 · 버그 수정(사용자 요청 "히스토리 보는 기능 강화 및 버그 수정").
 *  B1 — 스크롤 범위가 전송 기록만 봐서 'Ping만' 보기에서 남은 Ping 과거로 못 넘어가던 것
 *  B2 — 과거 구간에서 '지금 측정' 이 '1분 안에 추이에 나온다' 고 안내하던 것
 *  C1 — 측정 기록 쪽 표시 · 창 대조 · 보관 안내 · C2 — 날짜로 이동
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  maxBackOf, windowEndOf, historyOldestOf, portalDateOf, jumpToDate, runOneText, logPagerText, sameLogWindow, logRetentionNote,
} from './xferSpeedText.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 2026-11-05 20:00 KST(= 11:00Z) — 정시에서 떨어진 고정 시각은 날짜 경계 계산만 본다(지금 시각에 기대지 않는다).
const NOW = Date.UTC(2026, 10, 5, 11, 0);
const kst = (y, m, d, h = 0) => Date.UTC(y, m - 1, d, h) - 9 * HOUR;

describe('B1 — 스크롤 범위는 전송·Ping 중 더 오래된 기록까지', () => {
  const hist = (over = {}) => ({ days: 1, rawMaxDays: 31, offsetMin: 540, oldest: { sampleTs: null, day: null }, ...over });
  it('전송 기록이 없으면 예전엔 0칸 — Ping 기록이 있으면 그만큼 간다', () => {
    expect(maxBackOf(hist(), NOW)).toBe(0);
    expect(maxBackOf(hist(), NOW, { extraOldestTs: NOW - 30 * DAY + HOUR })).toBe(29);
  });
  it('둘 다 있으면 더 오래된 쪽(Ping 365일 · 전송 원시 180일)', () => {
    const h = hist({ oldest: { sampleTs: NOW - 180 * DAY + HOUR } });
    expect(maxBackOf(h, NOW)).toBe(179);
    expect(maxBackOf(h, NOW, { extraOldestTs: NOW - 365 * DAY + HOUR })).toBe(364);
    expect(maxBackOf(h, NOW, { extraOldestTs: NOW - 10 * DAY })).toBe(179);   // Ping 이 더 짧으면 전송 기준 그대로
  });
  it('일 요약 기간은 일 요약의 첫 날 기준 + Ping', () => {
    const h = hist({ days: 90, oldest: { sampleTs: null, day: '2026-05-01' } });
    expect(historyOldestOf(h)).toBe(kst(2026, 5, 1));
    expect(historyOldestOf(h, { extraOldestTs: kst(2026, 1, 1) })).toBe(kst(2026, 1, 1));
    expect(historyOldestOf(hist())).toBeNull();
  });
});

describe('C2 — 날짜로 이동', () => {
  it('포탈 날짜', () => {
    expect(portalDateOf(kst(2026, 11, 5, 0))).toBe('2026-11-05');
    expect(portalDateOf(kst(2026, 11, 5, 0) - 1)).toBe('2026-11-04');
    expect(portalDateOf(null)).toBe('');
  });
  it('어제를 고르면 창 = 어제 0시~24시(포탈 시각) · ◀▶ 는 날짜 경계로 한 기간씩', () => {
    const j = jumpToDate('2026-11-04', { days: 1, now: NOW });
    expect(j.back).toBe(1);
    expect(j.anchor).toBeGreaterThanOrEqual(NOW);
    expect(windowEndOf(j.anchor, j.back, 1).end).toBe(kst(2026, 11, 5));
    expect(windowEndOf(j.anchor, j.back + 1, 1).end).toBe(kst(2026, 11, 4));   // ◀ 이전 = 11-03 하루
  });
  it('7일 기간 — 고른 날짜까지의 7일', () => {
    const j = jumpToDate('2026-10-20', { days: 7, now: NOW });
    const end = windowEndOf(j.anchor, j.back, 7).end;
    expect(end).toBe(kst(2026, 10, 21));
    expect(end - 7 * DAY).toBe(kst(2026, 10, 14));
  });
  it('오늘·미래·형식 오류는 최근 구간 · 기록보다 앞이면 가장 오래된 칸으로 자르고 알린다', () => {
    expect(jumpToDate('2026-11-05', { days: 1, now: NOW })).toEqual({ back: 0, anchor: null });
    expect(jumpToDate('2026-12-01', { days: 1, now: NOW })).toEqual({ back: 0, anchor: null });
    expect(jumpToDate('11/04', { days: 1, now: NOW })).toEqual({ back: 0, anchor: null });
    const c = jumpToDate('2026-01-01', { days: 1, now: NOW, maxBack: 20 });
    expect(c).toMatchObject({ back: 20, clamped: true });
    expect(jumpToDate('2026-01-01', { days: 1, now: NOW, maxBack: 0 })).toEqual({ back: 0, anchor: null, clamped: true });
  });
});

describe('B2 — 과거 구간의 지금 측정 안내', () => {
  it('과거 구간이면 최신 구간에 나온다고 말한다', () => {
    expect(runOneText({ ok: true }, false)).toMatch(/1분 안에 추이에 나옵니다/);
    expect(runOneText({ ok: true }, true)).toMatch(/최신 구간에 나옵니다/);
    expect(runOneText({ ok: true }, true)).not.toMatch(/1분 안에/);
    expect(runOneText({ ok: false, reason: '잴 수 없습니다' }, true)).toBe('잴 수 없습니다');
  });
});

describe('C1 — 측정 기록 쪽', () => {
  const page = (over = {}) => ({ ok: true, agent: 'Edge-Seoul', days: 1, past: true, end: NOW - DAY, start: NOW - 2 * DAY, only: 'all', total: 312, failTotal: 7, rows: Array.from({ length: 50 }, (_, i) => ({ ts: NOW - i })), ...over });
  it('쪽 표시', () => {
    expect(logPagerText(page(), { index: 0, limit: 50 })).toBe('1–50 / 312건');
    expect(logPagerText(page({ rows: page().rows.slice(0, 12) }), { index: 6, limit: 50 })).toBe('301–312 / 312건');
    expect(logPagerText(page({ only: 'fail', rows: page().rows.slice(0, 7) }), { index: 0, limit: 50 })).toBe('1–7 / 7건');
    expect(logPagerText(page({ rows: [] }))).toBe('');
  });
  it('다른 창의 응답은 그리지 않는다', () => {
    const hist = { agent: 'edge-seoul', days: 1, past: true, end: NOW - DAY };
    expect(sameLogWindow(page(), hist)).toBe(true);
    expect(sameLogWindow(page({ end: NOW - 2 * DAY }), hist)).toBe(false);
    expect(sameLogWindow(page({ days: 7 }), hist)).toBe(false);
    expect(sameLogWindow(page({ agent: 'Other' }), hist)).toBe(false);
    expect(sameLogWindow(page({ past: false, end: NOW }), { ...hist, past: false, end: NOW + 3 })).toBe(true);
    expect(sameLogWindow(null, hist)).toBe(false);
  });
  it('창이 원시 보관 기간보다 앞까지 걸치면 말한다', () => {
    expect(logRetentionNote(page({ oldest: { sampleTs: NOW - 3 * DAY }, retention: { sampleDays: 180 } }))).toBe('');
    const note = logRetentionNote(page({ start: NOW - 365 * DAY, oldest: { sampleTs: NOW - 180 * DAY }, retention: { sampleDays: 180 } }));
    expect(note).toMatch(/180일 보관/);
    expect(note).not.toMatch(/`/);
    expect(logRetentionNote(page({ oldest: { sampleTs: null } }))).toBe('');
  });
});

describe('화면 — 히스토리 연결', () => {
  it('추이 조회는 log=0(측정 기록은 /log) · 스크롤에 Ping 범위 · 날짜로 이동', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, 'XferSpeedTool.jsx'), 'utf8');
    expect(src).toMatch(/fetchJson\('\/tools\/xfer-speed\/history', end == null \? \{ agent, days, log: 0 \}/);
    expect(src).toMatch(/fetchJson\('\/tools\/xfer-speed\/log', q\)/);
    expect(src).toMatch(/extraOldest=\{pingOldest\}/);
    expect(src).toMatch(/type="date"/);
    expect(src).toMatch(/runOneText\(r, end != null\)/);
  });
});
