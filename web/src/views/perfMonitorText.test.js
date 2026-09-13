// v2.498 — 설정 › 서버 성능 측정 문구·판정 회귀 고정(node 환경 — 순수 함수만).
import { describe, it, expect } from 'vitest';
import {
  ms, pct, ago, reasonLabel, loopBadge, loopNote, hangSummary, hangKindLabel, measureVerdict, slowRate, routeHint,
} from './perfMonitorText.js';

describe('표기', () => {
  it('ms/초 단위 전환과 없는 값', () => {
    expect(ms(null)).toBe('—');
    expect(ms(NaN)).toBe('—');
    expect(ms(420)).toBe('420ms');
    expect(ms(1500)).toBe('1.5초');
    expect(ms(65_000)).toBe('65초');
    expect(pct(91.2)).toBe('91.2%');
    expect(pct(null)).toBe('—');
  });
  it('경과 시간', () => {
    const now = 1_000_000_000;
    expect(ago(now - 5_000, now)).toBe('5초 전');
    expect(ago(now - 120_000, now)).toBe('2분 전');
    expect(ago(now - 7_200_000, now)).toBe('2시간 전');
    expect(ago(now - 2 * 86_400_000, now)).toBe('2일 전');
    expect(ago(0, now)).toBe('—');
  });
});

describe('느린 요청 사유 — 기다림과 막힘을 구분한다', () => {
  it('wall 은 주의, stall 이 섞이면 위험으로 표시', () => {
    expect(reasonLabel('wall').color).toBe('amber');
    expect(reasonLabel('wall').label).toBe('오래 걸림');
    expect(reasonLabel('stall').color).toBe('red');
    expect(reasonLabel('stall').label).toBe('루프 정체 겹침');
    expect(reasonLabel('wall+stall').label).toContain('정체 겹침');
    expect(reasonLabel(undefined).label).toBe('오래 걸림');
  });
  it('도움말이 무엇을 고쳐야 하는지 말하고, 창 단위 관측의 한계를 밝힌다', () => {
    expect(reasonLabel('stall').help).toContain('동기');
    expect(reasonLabel('stall').help).toContain('증명은 아니며');
    expect(reasonLabel('stall').help).toContain('30초');
    expect(reasonLabel('wall').help).toContain('기다린');
  });
});

describe('루프 상태', () => {
  it('임계 기준 배지', () => {
    expect(loopBadge(null).label).toBe('데이터 없음');
    expect(loopBadge({ maxMs: 20 }, 1000).color).toBe('green');
    expect(loopBadge({ maxMs: 700 }, 1000).color).toBe('amber');
    expect(loopBadge({ maxMs: 3000 }, 1000).color).toBe('red');
  });
  it('데이터가 없는 이유를 단정하지 않고 구분해 알린다', () => {
    expect(loopNote({ monitorEnabled: false })).toContain('LOOP_LAG_MONITOR=0');
    expect(loopNote({ monitorEnabled: true, windowCount: 0, windowMs: 30_000 })).toContain('30초마다');
    expect(loopNote({ monitorEnabled: true, windowCount: 5 })).toBe(null);
  });
});

describe('hang 이벤트 요약', () => {
  it('루프 정체 — 무엇이 돌던 중인지 밝히고, 없으면 그 사실도 말한다', () => {
    const s = hangSummary({ kind: 'loop', maxMs: 2500, p99Ms: 900, jobs: ['store.refresh'], inflightN: 3, rssMb: 812 });
    expect(s).toContain('2.5초');
    expect(s).toContain('store.refresh');
    expect(s).toContain('812MB');
    expect(hangSummary({ kind: 'loop', maxMs: 1200, jobs: [] })).toContain('계측된 작업 없음');
  });
  it('화면 로딩 — 대기 요청이 없으면 화면 상태 문제 가능성을 말한다', () => {
    const a = hangSummary({ kind: 'client', view: '#/insights/finops', ms: 187_000, clientInflight: [{ path: '/insights/finops/config', ms: 120_000 }], serverInflightN: 1 });
    expect(a).toContain('187초');
    expect(a).toContain('/insights/finops/config');
    const b = hangSummary({ kind: 'client', view: '#/x', ms: 90_000, clientInflight: [], serverInflightN: 0 });
    expect(b).toContain('화면 상태 문제');
    expect(hangSummary(null)).toBe('');
  });
  it('종류 라벨', () => {
    expect(hangKindLabel('client')).toBe('화면 로딩');
    expect(hangKindLabel('loop')).toBe('루프 정체');
    expect(hangKindLabel('x')).toBe('x');
  });
});

describe("'지금 측정' 판정", () => {
  it('p95 구간별 판정과 실패·표본 없음', () => {
    expect(measureVerdict(null).label).toBe('측정 실패');
    expect(measureVerdict({ ok: false, reason: '이미 측정 중' }).text).toContain('이미');
    expect(measureVerdict({ ok: true, immediate: {} }).label).toBe('판정 불가');
    expect(measureVerdict({ ok: true, immediate: { p95Ms: 2 } }).color).toBe('green');
    expect(measureVerdict({ ok: true, immediate: { p95Ms: 40 } }).color).toBe('amber');
    expect(measureVerdict({ ok: true, immediate: { p95Ms: 300 } }).color).toBe('red');
  });
  it('여유일 때 서버 루프 탓이 아님을 분명히 말한다', () => {
    expect(measureVerdict({ ok: true, immediate: { p95Ms: 1 } }).text).toContain('서버 루프 문제가 아닙니다');
  });
});

describe('라우트 표', () => {
  it('느림 비율은 건수 0 이면 null(0% 로 단정하지 않는다)', () => {
    expect(slowRate({ n: 0, slowN: 0 })).toBe(null);
    expect(slowRate({ n: 200, slowN: 5 })).toBe(2.5);
    expect(slowRate(null)).toBe(null);
  });
  it('라우트 힌트는 느린 요청 사유 분포로 판단한다', () => {
    const rows = [
      { route: '/api/a', reason: 'wall' }, { route: '/api/a', reason: 'wall' },
      { route: '/api/b', reason: 'stall' }, { route: '/api/c', reason: 'wall' }, { route: '/api/c', reason: 'wall+stall' },
    ];
    expect(routeHint('/api/a', rows)).toBe('대기형(외부 응답 기다림)');
    expect(routeHint('/api/b', rows)).toBe('정체 겹침형(동기 작업 의심)');
    expect(routeHint('/api/c', rows)).toContain('혼합');
    expect(routeHint('/api/c', rows)).toContain('정체 겹침');
    expect(routeHint('/api/none', rows)).toBe('');
  });
});
