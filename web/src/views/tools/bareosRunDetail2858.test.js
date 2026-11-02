/**
 * v2.858 실행 중 작업 상세(사용자 승인 시안) — 판정은 bareosLiveText.js 하나(진행 현황 행 펼침 · 실행 현황 · 이력 표가 같이 쓴다).
 *  ① 추정 진척 기준: 지난 같은 레벨 → (Full 만) VM 용량 → 없음(Incremental 을 VM 용량으로 나눈 뜻 없는 % 를 만들지 않는다)
 *  ② 남은 시간 · 지금 단계 · 남은 단계 ③ 원장 + 진행 현황 행 합치기(못 받은 값은 null — 0 이 아니다) ④ 대기 사유 요약
 *  ⑤ 대기 배지는 회색(실행 중 파랑이 묻히지 않게) ⑥ 상세는 주기 폴링하지 않는다 · 상자 목록이 표로 바뀌었다(소스 대조)
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  progressBasis, etaSec, runPhase, futurePhases, liveRowIndex, waitSummary, runRowOf, levelKey,
} from './bareosLiveText.js';
import { stateBadge } from './bareosText.js';

const GiB = 1024 ** 3;

describe('① 추정 진척 기준', () => {
  it('지난 같은 레벨 실행 바이트가 있으면 그것', () => {
    const p = progressBasis({ level: 'I', bytes: 9.81e9, sizeGb: 428.4, prev: { jobid: 18, level: 'I', bytes: 14.2e9 } });
    expect(p.kind).toBe('prev');
    expect(p.pct).toBe(69);
    expect(p.label).toContain('jobid 18');
    expect(p.over).toBe(false);
  });
  it('Full 은 지난 Full 이 없으면 VM 용량', () => {
    const p = progressBasis({ level: 'F', bytes: 100 * GiB, sizeGb: 400, prev: null });
    expect(p.kind).toBe('size');
    expect(p.pct).toBe(25);
  });
  it('Incremental 인데 지난 기록이 없으면 진척을 만들지 않는다(VM 용량으로 나누지 않는다)', () => {
    const p = progressBasis({ level: 'Incremental', bytes: 9.81e9, sizeGb: 428.4, prev: null });
    expect(p.kind).toBe(null);
    expect(p.pct).toBe(null);
    expect(p.label).toContain('Incremental');
  });
  it('진행량을 모르면(FD 보고 없음) % 없음 · 기준을 넘으면 100 + over', () => {
    expect(progressBasis({ level: 'I', bytes: null, prev: { jobid: 1, level: 'I', bytes: 10 } }).pct).toBe(null);
    const o = progressBasis({ level: 'I', bytes: 30, prev: { jobid: 1, level: 'I', bytes: 10 } });
    expect([o.pct, o.over]).toEqual([100, true]);
  });
  it('레벨 글자 — 서버 levelKey 와 같은 판정', () => {
    expect(['Full', 'F', 'Incremental', 'Differential', 'VirtualFull', '', null, 'x'].map(levelKey)).toEqual(['F', 'F', 'I', 'D', 'V', '', '', '']);
  });
});

describe('② 남은 시간 · 단계', () => {
  it('남은 시간 = (기준 − 진행량) ÷ 지금 속도 — 하나라도 모르면 null', () => {
    const r = { level: 'I', bytes: 600, rateNow: 100, prev: { jobid: 1, level: 'I', bytes: 1_000 } };
    expect(etaSec(r)).toBe(4);
    expect(etaSec({ ...r, rateNow: null })).toBe(null);
    expect(etaSec({ ...r, rateNow: 0 })).toBe(null);
    expect(etaSec({ ...r, bytes: 2_000 })).toBe(null, '이미 넘었으면 계산하지 않는다');
    expect(etaSec({ ...r, prev: null })).toBe(null);
  });
  it('지금 단계는 지금까지의 로그 단계로', () => {
    const st = (...t) => t.map((title) => ({ title }));
    expect(runPhase(st('시작', 'FD 연결')).key).toBe('prep');
    expect(runPhase(st('시작', 'FD 연결', '데이터 백업 시작')).key).toBe('data');
    expect(runPhase(st('시작', '데이터 백업 시작', '임시 스냅샷 정리')).key).toBe('tail');
    expect(runPhase([]).key).toBe('none');
    expect(runPhase(st('시작'), true).key).toBe('done');
    expect(futurePhases('data')).toContain('종료');
    expect(futurePhases('done')).toBe('');
  });
});

describe('③ 원장 + 진행 현황 행', () => {
  const live = { corps: [{ vcenterId: 'oc2', live: { ok: true }, running: 1, waiting: 2, waitGroups: [{ reason: 'maxjobs', n: 2 }], rows: [{ jobid: 30, state: 'running', vmName: 'BSS2', bytes: 5, rateNow: 7, level: 'I' }] }] };
  const idx = liveRowIndex(live);
  it('진행 현황에 있으면 그 값(FD · Director)', () => {
    const j = { id: 'bj_1', vcenterId: 'oc2', vmName: 'BSS2', pending: { jobid: 30, state: 'running', since: 1 } };
    const x = runRowOf(j, idx, 100);
    expect(x.key).toBe('oc2|30');
    expect(x.row.bytes).toBe(5);
    expect(x.row.id).toBe('bj_1');
    expect(x.corp.vcenterId).toBe('oc2');
  });
  it('없으면 원장 값만 — 진행량 · 속도 · Director 상태는 null(0 이 아니다)', () => {
    const j = { id: 'bj_2', vcenterId: 'oc2', vmName: 'BSS3', lastRun: { jobid: 31, state: 'queued', level: 'I', startedAt: 40 } };
    const x = runRowOf(j, idx, 100);
    expect(x.corp).toBe(null);
    expect([x.row.bytes, x.row.rateNow, x.row.dirStatus, x.row.prev]).toEqual([null, null, null, null]);
    expect([x.row.state, x.row.since, x.row.elapsed, x.row.trigger]).toEqual(['queued', 40, 60, 'schedule']);
  });
  it('④ 대기 사유 요약 — 법인들의 사유별 묶음을 합친다 · 대기가 없으면 null', () => {
    expect(waitSummary(live)).toEqual({ waiting: 2, running: 1, top: { reason: 'maxjobs', n: 2 }, kinds: 1 });
    expect(waitSummary({ corps: [{ waiting: 0, running: 1 }] })).toBe(null);
    expect(waitSummary(null)).toBe(null);
  });
});

describe('⑤ ⑥ 배지 · 소스 대조', () => {
  it('대기 배지는 회색 · 실행 중은 파랑', () => {
    expect(stateBadge('queued', 'C')).toEqual({ label: '대기 · C', cls: 'gray' });
    expect(stateBadge('waiting').cls).toBe('gray');
    expect(stateBadge('running', 'R').cls).toBe('blue');
  });
  const read = (f) => fs.readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
  it('상세는 주기 폴링하지 않는다(로그는 펼칠 때 한 번 + 단추 — 무거운 Director 조회)', () => {
    const src = read('./BareosRunDetail.jsx');
    expect(src).not.toMatch(/usePolling|setInterval/);
    expect(src).toMatch(/로그 다시 읽기/);
  });
  it('실행 현황 · 이력의 실행 중 목록은 상자 격자가 아니라 표 + 상세 · 진행 현황은 행 펼침', () => {
    const tool = read('./BareosBackupTool.jsx');
    expect(tool).not.toMatch(/repeat\(auto-fill, minmax\(320px, 1fr\)\)/);
    expect(tool).toMatch(/<BareosRunDetail /);
    const liveTab = read('./BareosLiveTab.jsx');
    expect(liveTab).toMatch(/<BareosRunDetail /);
    expect(liveTab).toMatch(/aria-expanded=\{open\}/);
  });
});
