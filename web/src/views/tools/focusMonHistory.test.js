// v3.13.0 ⑭ 서버 집중 모니터링 긴 구간 · 사건 · 가장 변했나 · 링크 — 순수 함수(시안 History · 사용자 "기본값대로 모두 구현해줘").
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { winText, isLongWin, windowCaption } from './focusMonText.js';
import {
  HISTORY_POLL_MS, pollMsFor, rawOnlyText, axisTime, linkSeg, parseLinkSeg, linkHash, EVENT_KIND_TEXT, eventMarks, eventLine,
  localInputValue, fromLocalInput, changeValText, changeRatioText, overlapText, changesCaption,
} from './focusMonHistoryText.js';
import { bandPath } from './focusMonChart.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

describe('구간 글자 · 긴 구간 판정', () => {
  it('분 · 시간 · 일', () => {
    expect([1, 30, 60, 360, 1440, 10080, 43200].map(winText)).toEqual(['1분', '30분', '1시간', '6시간', '24시간', '7일', '30일']);
    expect(winText(null)).toBe('—');
    expect(isLongWin(30)).toBe(false); expect(isLongWin(60)).toBe(true);
  });
  it('긴 구간 캡션 — 요약 출처를 밝히고 짧은 구간의 슬라이더 설명은 빼고', () => {
    const c = windowCaption({ past: false, from: 0, to: 86_400_000, win: 1440 });
    expect(c).toMatch(/24시간 · 칸마다 1분 요약/);
    expect(c).not.toMatch(/슬라이더/);
    expect(windowCaption({ past: false, from: 0, to: 1, win: 10080 })).toMatch(/1시간 요약/);
    expect(windowCaption({ past: false, from: 0, to: 1, win: 5 })).toMatch(/5분 · 슬라이더/);
    // 반증 F14: 서버 상세 1시간은 원본 — 캡션이 요약이라고 말하지 않는다
    expect(windowCaption({ past: false, from: 0, to: 1, win: 60, raw: true })).toMatch(/1시간 · 원본 표본/);
    expect(windowCaption({ past: false, from: 0, to: 1, win: 60, raw: true })).not.toMatch(/요약/);
  });
  it('화면 — 서버 상세 1시간 캡션은 원본 · 가장 변했나는 앞 구간이 보관 기간 밖이면 잠근다 · 긴 구간 표 주석은 평균을 말하지 않는다(반증 F7 · F14)', () => {
    const tool = read('./FocusMonTool.jsx'); const hist = read('./FocusMonHistory.jsx');
    expect(tool).toMatch(/raw: route\?\.tab === 'server' && tb\.win <= 60/);
    expect(hist).toMatch(/const beyond = retentionDays > 0 && tb\.win >= retentionDays \* 1440;/);
    expect(hist).toMatch(/disabled=\{state\.busy \|\| !ids\.length \|\| beyond\}/);
    expect((tool.match(/\{tb\.long \? '긴 구간에는 구간 평균이 없어/g) || []).length).toBe(2);
  });
  it('조회 주기 — 과거 0 · 긴 구간 30초(보는 화면 심박 60초보다 짧게) · 그 밖은 기본값', () => {
    expect(pollMsFor(1440, 123, 2000)).toBe(0);
    expect(pollMsFor(1440, null, 2000)).toBe(HISTORY_POLL_MS);
    expect(HISTORY_POLL_MS).toBeLessThan(60_000);
    expect(pollMsFor(5, null, 2000)).toBe(2000);
  });
  it('원본만 되는 화면 안내 · 하루 넘는 축은 날짜', () => {
    expect(rawOnlyText('프로세스 목록', [1, 5, 10, 30])).toMatch(/1분 · 5분 · 10분 · 30분/);
    const t = new Date(2026, 10, 15, 9, 5, 7).getTime();
    expect(axisTime(t, 10080)).toBe('11-15 09:05');
    expect(axisTime(t, 30)).toBe('09:05:07');
    expect(axisTime(null, 30)).toBe('—');
  });
});

describe('링크 — 해시 끝 ‘@’ 칸 · 아는 값만', () => {
  const allowed = [1, 5, 10, 30, 60, 360, 1440, 10080, 43200];
  it('왕복', () => {
    const seg = linkSeg({ win: 1440, end: 1794700000000, cmp: '1d' });
    expect(seg).toBe('@w=1440&e=1794700000000&c=1d');
    expect(parseLinkSeg(seg, allowed)).toEqual({ win: 1440, end: 1794700000000, cmp: '1d' });
    expect(linkSeg({ win: 5 })).toBe('@w=5');
  });
  it('모르는 값 · 칸은 버린다', () => {
    expect(parseLinkSeg('@w=999&e=12&c=9d&x=1', allowed)).toEqual({ win: null, end: null, cmp: null });
    expect(parseLinkSeg('w=5', allowed).win).toBe(null);
    expect(parseLinkSeg('@w=5&e=1794700000000', allowed)).toEqual({ win: 5, end: 1794700000000, cmp: null });
  });
  it('해시 — 앱이 도구를 고르는 첫 두 칸을 건드리지 않는다(물음표 없음) · 서버는 id 만', () => {
    const h = linkHash({ tab: 'server', server: 'fm-a b', win: 360, cmp: '7d' });
    expect(h).toBe('#/tools/focus-mon/server/fm-a%20b/@w=360&c=7d');
    expect(h.includes('?')).toBe(false);
    expect(linkHash({ tab: 'overview', win: 5 })).toBe('#/tools/focus-mon/@w=5');
    expect(linkHash({ tab: 'compare', win: 60 })).toBe('#/tools/focus-mon/compare/@w=60');
  });
  it('화면은 ‘@’ 칸을 탭 · 서버 판별에서 뺀다', () => {
    const src = read('./FocusMonTool.jsx');
    expect(src).toMatch(/filter\(\(x\) => !x\.startsWith\('@'\)\)/);
  });
});

describe('사건', () => {
  it('종류 글은 서버 events.EVENT_TEXT 와 1:1', () => {
    const src = read('../../../../server/src/focusmon/events.js');
    const m = /EVENT_TEXT = Object\.freeze\(\{([^}]*)\}\)/.exec(src);
    const srv = Object.fromEntries([...m[1].matchAll(/(\w+): '([^']*)'/g)].map((x) => [x[1], x[2]]));
    expect(Object.keys(EVENT_KIND_TEXT).sort()).toEqual(Object.keys(srv).sort());
    for (const k of Object.keys(srv)) expect(EVENT_KIND_TEXT[k].label).toBe(srv[k]);
  });
  it('차트 표시 — 구간 안만 · 0~1 · 겹치면 줄을 바꾼다', () => {
    const ev = [{ n: 1, at: 100, kind: 'start' }, { n: 2, at: 101, kind: 'reboot' }, { n: 3, at: 500, kind: 'user' }, { n: 4, at: 5000, kind: 'stop' }];
    const m = eventMarks(ev, 0, 1000);
    expect(m.map((x) => x.n)).toEqual([1, 2, 3]);
    expect(m[0].x).toBeCloseTo(0.1); expect(m[0].row).toBe(0); expect(m[1].row).toBe(1); expect(m[2].row).toBe(0);
    expect(m[1].tone).toBe('warn');
    expect(eventMarks(ev, 10, 10)).toEqual([]);
    expect(eventLine({ n: 2, at: null, kind: 'reboot', text: 'x' })).toMatch(/^2\. — · 재부팅 — x$/);
  });
  it('시각 입력 왕복 · 빈 값은 지금(null)', () => {
    const t = new Date(2026, 10, 15, 14, 20).getTime();
    expect(fromLocalInput(localInputValue(t))).toBe(t);
    expect(fromLocalInput('')).toBe(null); expect(fromLocalInput('2026-13-99')).toBe(null);
  });
});

describe('가장 변했나 · 띠', () => {
  it('값 · 비 · 겹침 글', () => {
    expect(changeValText(12.345, '%')).toBe('12.35%');
    expect(changeValText(null, '%')).toBe('—');
    expect(changeValText(1234.5, '/s')).toBe('1235 /s');
    expect(changeRatioText(3.24)).toBe('×3.2 늘었음');
    expect(changeRatioText(0.4)).toBe('×0.4 줄었음');
    expect(changeRatioText(null)).toBe('—');
    expect(overlapText(0.123)).toBe('겹침 12%');
    expect(changesCaption({ src: 'm', a: { from: 0 }, b: { from: 1, to: 2 }, targets: 3, keys: 16 })).toMatch(/1분 요약 평균 · 서버 3대 × 지표 16개/);
  });
  it('띠 — 둘 다 있는 이어진 칸만(못 읽은 칸은 비운다)', () => {
    const y = (v) => 100 - v;
    const d = bandPath([1, 2, null, 4, 5], [3, 4, 5, 6, 7], { x0: 0, x1: 4, y });
    expect(d.match(/M/g).length).toBe(2);
    expect(d).toContain('Z');
    expect(bandPath([], [], { x0: 0, x1: 1, y })).toBe('');
  });
});
