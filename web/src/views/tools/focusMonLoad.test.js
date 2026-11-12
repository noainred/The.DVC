/**
 * focusMonLoad.test.js — v2.983 서버 집중 모니터링 '수집 부하' 탭(시안 ⑪ · '구현해줘' + '늘 잼 · 세 묶음').
 *  · 판정 이름은 서버 load.judgeLoad 와 같다(light · mid · heavy) · 문턱 글은 응답 settings 로
 *  · 바이트 속도 글 · 묶음 이름 · 줄이는 방법(추정이 없으면 말하지 않는다) · 묶음 합(모르는 묶음이 있으면 그 합은 null — 0 아님)
 *  · 화면 소스: 탭 키 'load' · 줄 아래 패널(Fragment colSpan) · 최근 구간만 30초 폴링 · 설정 저장의 ok:false 를 성공으로 읽지 않는다 · 백틱 없음
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  TABS, LOAD_JUDGE, loadJudgeNote, byteRateText, loadGroupLabel, LOAD_GROUPS, LOAD_GROUP_WHAT, loadReduceTips, LOAD_HOW, NODE_LOAD_NOTE, sumEstimates, DASH,
} from './focusMonText.js';

const W = { cpuPct: 2.5, bps: 3000, interval: 2, procs: 300, groups: { base: { pct: 1 }, topo: { pct: 0.3 }, proc: { pct: 1.2 } } };
const EST = {
  byInterval: { 1: { cpuPct: 4, bps: 5000 }, 2: { cpuPct: 2.5, bps: 3000 }, 5: { cpuPct: 1.6, bps: 2000 }, 10: { cpuPct: 1.4, bps: 1800 } },
  byProcEvery: { 5: { cpuPct: 2.5, bps: 3000 }, 15: { cpuPct: 1.7, bps: 1500 }, 30: { cpuPct: 1.5, bps: 1200 } },
};

describe('판정 · 문턱', () => {
  it('서버 judgeLoad 의 이름 셋과 1:1', () => {
    const srv = fs.readFileSync(new URL('../../../../server/src/focusmon/load.js', import.meta.url), 'utf8');
    for (const k of ['light', 'mid', 'heavy']) expect(srv).toMatch(new RegExp(`'${k}'`));
    expect(Object.keys(LOAD_JUDGE).sort()).toEqual(['heavy', 'light', 'mid']);
  });
  it('문턱 글은 응답 값으로(숫자를 박지 않는다)', () => {
    expect(loadJudgeNote({ loadWarnPct: 2, loadCritPct: 7 })).toEqual([['light', '2% 미만'], ['mid', '2~7%'], ['heavy', '7% 이상']]);
    expect(loadJudgeNote(null)[0][1]).toBe('1% 미만');
  });
});

describe('글', () => {
  it('바이트 속도 · 값 없으면 —', () => {
    expect(byteRateText(3000)).toBe('2.9 KB/s');
    expect(byteRateText(0)).toBe('0 B/s');
    expect(byteRateText(null)).toBe(DASH);
    expect(byteRateText('')).toBe(DASH);
  });
  it('묶음 이름 · 프로세스 묶음은 표본 주기', () => {
    expect(LOAD_GROUPS).toEqual(['base', 'topo', 'proc']);
    expect(loadGroupLabel('proc', 30)).toMatch(/^프로세스\(30초/);
    for (const g of LOAD_GROUPS) expect(LOAD_GROUP_WHAT[g]).toBeTruthy();
  });
  it('줄이는 방법 — 큰 묶음 · 더 긴 표본 주기 · 더 긴 주기 · 중앙 직접이면 엣지 안내 · 추정이 없으면 말하지 않는다', () => {
    const tips = loadReduceTips({ load: W, est: EST, procEvery: 5, agent: '', demo: false });
    expect(tips[0]).toMatch(/가장 큰 묶음은 프로세스\(5초.*48%\(프로세스 300개\)/);
    expect(tips.some((t) => /표본 주기 15초: 약 1.70%/.test(t))).toBe(true);
    expect(tips.some((t) => /표본 주기 30초: 약 1.50%/.test(t))).toBe(true);
    expect(tips.some((t) => /주기 5초: 약 1.60%/.test(t))).toBe(true);
    expect(tips.some((t) => /엣지가 맡으면/.test(t))).toBe(true);
    expect(loadReduceTips({ load: W, est: EST, procEvery: 30, agent: 'edge-pl' }).some((t) => /표본 주기/.test(t))).toBe(false);
    expect(loadReduceTips({ load: W, est: EST, procEvery: 5, agent: 'edge-pl' }).some((t) => /엣지가 맡으면/.test(t))).toBe(false);
    expect(loadReduceTips({ load: null, est: null })).toEqual([]);
    expect(loadReduceTips({ load: W, est: { byInterval: {}, byProcEvery: { 15: { cpuPct: null } } }, procEvery: 5, agent: 'x' }).some((t) => /표본 주기/.test(t))).toBe(false);
  });
});

describe('묶음 합 — 모든 서버를 이 주기로', () => {
  it('합 · 모르는 묶음이 하나라도 있으면 그 합은 null(0 아님) · 추정이 없는 서버는 뺀다', () => {
    const rows = [{ e: { by: { base: 1, topo: 0.2, proc: 0.5 }, bps: 100 } }, { e: { by: { base: 2, topo: 0.1, proc: 1 }, bps: 300 } }, { e: null }];
    expect(sumEstimates(rows, (r) => r.e)).toEqual({ n: 2, by: { base: 3, topo: 0.3, proc: 1.5 }, cpuPct: 4.8, bps: 400 });
    const s = sumEstimates([...rows, { e: { by: { base: 1, topo: null, proc: 1 }, bps: null } }], (r) => r.e);
    expect(s.by.topo).toBe(null); expect(s.cpuPct).toBe(null); expect(s.bps).toBe(null); expect(s.by.base).toBe(4);
    expect(sumEstimates([], (r) => r.e)).toBe(null);
  });
});

describe('화면 소스', () => {
  const src = fs.readFileSync(new URL('./FocusMonLoad.jsx', import.meta.url), 'utf8');
  const tool = fs.readFileSync(new URL('./FocusMonTool.jsx', import.meta.url), 'utf8');
  it('탭 키 load · 메인에서 그 탭을 그린다', () => {
    expect(TABS.map((t) => t.key)).toContain('load');
    expect(tool).toMatch(/route\.tab === 'load' \? <LoadTab main=\{main\} tb=\{tb\} \/>/);
  });
  it('최근 구간만 30초 폴링 · 과거 구간은 한 번', () => {
    expect(src).toMatch(/usePoll\('\/tools\/focus-mon\/load', params, tb\.end == null \? 30_000 : 0, true\)/);
  });
  it('줄 아래 패널(Fragment · colSpan = 열 수) · 키보드로도 연다', () => {
    const th = (src.match(/<thead><tr><th>서버<\/th>[\s\S]*?<\/tr><\/thead>/) || [''])[0].match(/<th[ >]/g) || [];
    expect(th.length).toBe(11);
    expect(src).toMatch(/<td colSpan=\{11\}>/);
    expect(src).toMatch(/React\.Fragment key=\{r\.id\}/);
    expect(src).toMatch(/e\.key === 'Enter' \|\| e\.key === ' '/);
  });
  it('설정 저장의 ok:false 를 성공으로 읽지 않는다', () => {
    expect(src).toMatch(/if \(r\?\.ok === false\) setMsg\(\{ tone: 'bad'/);
  });
  it('화면 글에 백틱 · 대문자 변환 없음', () => {
    for (const t of [...LOAD_HOW, NODE_LOAD_NOTE, ...Object.values(LOAD_GROUP_WHAT), ...loadReduceTips({ load: W, est: EST, procEvery: 5, agent: '' })]) expect(t).not.toMatch(/`/);
    const css = fs.readFileSync(new URL('./focusMon.css', import.meta.url), 'utf8');
    expect(css).not.toMatch(/text-transform:\s*uppercase/);
  });
});
