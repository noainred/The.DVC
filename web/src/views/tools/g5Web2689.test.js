/**
 * v2.689 G5(웹) — 선택을 바꾼 뒤 '이전 선택의 응답' 을 새 라벨 아래 그리지 않는다.
 *  B10-a/B3 Horizon 앱·데스크톱별 사용 현황: 응답에 요청 키(기간·서버)를 함께 두고, 지금 선택과 다르면 null.
 *  B10-b    BM 스토리지 추이: 응답에 요청 기간을 함께 두고, 고른 기간과 다르면 null.
 *  I7       CVP 장비 목록: 호스트명이 키보드로 상세를 연다(role=button·tabIndex·Enter/Space).
 * 순수 판정은 함수로, 화면 배선은 소스로 고정한다(웹 테스트는 DOM 없는 node 환경이다).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { usageReqKey, sameUsageKey, usageRepFor } from './horizonUsageText.js';
import { historyForPeriod } from './bmStorHistoryText.js';
import { stripComments } from '../../test/_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => stripComments(fs.readFileSync(path.resolve(HERE, f), 'utf8'));

describe('B10-a Horizon 사용 현황 — 요청 키가 다르면 그리지 않는다', () => {
  const repA = { totals: { users: 5 } };
  const gotA7 = { key: usageReqKey(7, 'hz-a'), rep: repA };

  it('같은 기간·서버면 응답을 돌려준다(숫자/문자열 기간 동일 취급)', () => {
    expect(usageRepFor(gotA7, 7, 'hz-a')).toBe(repA);
    expect(usageRepFor(gotA7, '7', 'hz-a')).toBe(repA);
  });
  it('서버를 바꾸면(응답 전·실패) 이전 서버 응답은 null', () => {
    expect(usageRepFor(gotA7, 7, 'hz-b')).toBeNull();
    expect(usageRepFor(gotA7, 7, '')).toBeNull();
  });
  it('기간을 바꾸면(응답 전·실패) 이전 기간 응답은 null', () => {
    expect(usageRepFor(gotA7, 30, 'hz-a')).toBeNull();
  });
  it('전체(서버 없음) 키는 빈 문자열로 맞춘다 — null/undefined 도 전체', () => {
    const gotAll = { key: usageReqKey(1, null), rep: repA };
    expect(usageRepFor(gotAll, 1, '')).toBe(repA);
    expect(usageRepFor(gotAll, 1, undefined)).toBe(repA);
  });
  it('응답이 없으면 null', () => {
    expect(usageRepFor(null, 7, '')).toBeNull();
    expect(usageRepFor({ key: usageReqKey(7, ''), rep: null }, 7, '')).toBeNull();
    expect(sameUsageKey(null, usageReqKey(7, ''))).toBe(false);
  });
  it('화면 배선: 요청 키와 함께 저장 · 판정 함수로 rep 를 고른다 · CSV 는 그려진 응답의 키로', () => {
    const s = src('HorizonUsagePanel.jsx');
    expect(s).toMatch(/setGot\(\{\s*key:\s*usageReqKey\(d,\s*sid\)/);
    expect(s).toMatch(/const rep = usageRepFor\(got,\s*days,\s*serverId\)/);
    expect(s).toMatch(/usageCsvPath\(repKey\.days,\s*repKey\.serverId\)/);
    expect(s).not.toMatch(/usageCsvPath\(days,\s*serverId\)/);
    expect(s).not.toMatch(/setRep\(/);
  });
});

describe('B10-b BM 스토리지 추이 — 기간이 다르면 그리지 않는다', () => {
  const d7 = { series: [], periods: [] };
  it('같은 기간이면 응답', () => {
    expect(historyForPeriod({ period: '7d', data: d7 }, '7d')).toBe(d7);
  });
  it('기간을 바꾼 조회가 실패·대기 중이면 이전 기간 응답은 null', () => {
    expect(historyForPeriod({ period: '7d', data: d7 }, '30d')).toBeNull();
  });
  it('응답이 없으면 null', () => {
    expect(historyForPeriod(null, '7d')).toBeNull();
    expect(historyForPeriod({ period: '7d', data: null }, '7d')).toBeNull();
  });
  it('화면 배선: 기간과 함께 저장 · 판정 함수로 data 를 고른다 · 새 조회 시작 때 오류를 지운다', () => {
    const s = src('BmStorHistoryPanel.jsx');
    expect(s).toMatch(/setGot\(\{\s*period,\s*data:\s*d\s*\}\)/);
    expect(s).toMatch(/const data = historyForPeriod\(got,\s*period\)/);
    expect(s).not.toMatch(/setData\(/);
    expect(s).toMatch(/setLoading\(true\);\s*setErr\(null\)/);
  });
});

describe('I7 CVP 장비 목록 — 호스트명이 키보드로 상세를 연다', () => {
  it('role=button · tabIndex · Enter/Space · 전파 차단 · 글자색 inherit', () => {
    const s = src('CvpTool.jsx');
    const i = s.indexOf('role="button" tabIndex={0} title="장비 상세 열기"');
    expect(i).toBeGreaterThan(0);
    const seg = s.slice(i, i + 800);
    expect(seg).toMatch(/color:\s*'inherit'/);
    expect(seg).toMatch(/e\.key === 'Enter' \|\| e\.key === ' '/);
    expect((seg.match(/e\.stopPropagation\(\)/g) || []).length).toBe(2);
    expect((seg.match(/setDetailKey\(/g) || []).length).toBe(2);
  });
});
