// v2.501 — 대기 3초 이상일 때 '무슨 작업인지' 표시 판정 회귀 고정(node 환경 — 순수 함수만).
import { describe, it, expect } from 'vitest';
import { taskLabel, secText, taskRows, visibleProgress } from './taskLabel.js';
import { normPath } from '../perfClientLogic.js';

describe('경로 → 작업 이름', () => {
  it('아는 경로는 사람 말로 바꾼다', () => {
    expect(taskLabel('/tools/waste')).toMatchObject({ label: '낭비 리소스 분석', known: true, slow: false });
    expect(taskLabel('/summary').label).toBe('전 vCenter 요약 집계');
    expect(taskLabel('/compare/matrix').label).toBe('비교 매트릭스 집계');
  });
  it('설계상 오래 걸리는 작업만 slow 로 표시한다', () => {
    expect(taskLabel('/tools/waste/export').slow).toBe(true);
    expect(taskLabel('/search/nl').slow).toBe(true);
    expect(taskLabel('/summary').slow).toBe(false);
    expect(taskLabel('/hosts').slow).toBe(false);
  });
  it('접두 일치는 더 구체적인 것이 이긴다', () => {
    // '/tools/' 일반 규칙보다 '/tools/waste' 정확 일치가 우선.
    expect(taskLabel('/tools/waste').label).toBe('낭비 리소스 분석');
    // 표에 없는 tools 하위는 일반 규칙으로.
    expect(taskLabel('/tools/무언가').label).toBe('특수 기능 조회');
    // /admin/perf 는 /admin/ 보다 앞에 있어야 한다.
    expect(taskLabel('/admin/perf').label).toBe('서버 성능 측정 조회');
    expect(taskLabel('/admin/users').label).toBe('관리 설정 조회');
  });
  it('모르는 경로는 지어내지 않고 경로를 다듬어 보여준다', () => {
    const t = taskLabel('/brand/new/thing');
    expect(t.known).toBe(false);
    expect(t.label).toBe('brand › new › thing');
    expect(t.slow).toBe(false);
  });
  it('빈 경로도 크래시하지 않는다', () => {
    expect(taskLabel('').label).toBe('요청');
    expect(taskLabel(undefined).label).toBe('요청');
  });
});

describe('시간 표기', () => {
  it("1초 미만을 '0초' 라고 쓰지 않는다(안 기다린 것처럼 보인다)", () => {
    expect(secText(0)).toBe('1초 미만');
    expect(secText(400)).toBe('1초 미만');
  });
  it('초 단위 반올림', () => {
    expect(secText(3_000)).toBe('3초');
    expect(secText(3_600)).toBe('4초');
    expect(secText(null)).toBe('1초 미만');
  });
});

describe('진행 중 목록 → 표시 행', () => {
  const rows = [
    { path: '/tools/waste?vcenterId=vc-1', ms: 4_000 },
    { path: '/summary', ms: 9_000 },
    { path: '/summary', ms: 2_000 },
    { path: '/hosts', ms: 1_000 },
  ];
  it('오래 기다린 것부터, 같은 작업은 하나로 묶고 건수를 붙인다', () => {
    const out = taskRows(rows, { normalize: normPath });
    expect(out[0]).toMatchObject({ label: '전 vCenter 요약 집계', ms: 9_000, count: 2 });
    expect(out[1]).toMatchObject({ label: '낭비 리소스 분석', ms: 4_000, count: 1 });
    expect(out).toHaveLength(3);
  });
  it('상한을 지킨다', () => {
    expect(taskRows(rows, { limit: 1, normalize: normPath })).toHaveLength(1);
  });
  it('쿼리스트링은 정규화로 사라진다(검색어 노출 방지)', () => {
    const out = taskRows([{ path: '/tools/deep-search?q=사내비밀', ms: 5_000 }], { normalize: normPath });
    expect(JSON.stringify(out)).not.toContain('사내비밀');
    expect(out[0].label).toBe('전체 심층 검색');
  });
  it('빈 입력에도 안전', () => {
    expect(taskRows([], { normalize: normPath })).toEqual([]);
    expect(taskRows(null)).toEqual([]);
  });
});

describe('전역 진행 표시 판정 — 3초 문턱', () => {
  it('문턱 미만이면 아무것도 그리지 않는다(빠른 요청에 깜빡임을 만들지 않는다)', () => {
    const p = visibleProgress([{ path: '/summary', ms: 900 }], { detailMs: 3_000 });
    expect(p.show).toBe(false);
    expect(p.tasks).toEqual([]);
  });
  it('가장 오래 기다린 요청이 문턱을 넘으면 보인다', () => {
    const p = visibleProgress([{ path: '/summary', ms: 3_200 }, { path: '/hosts', ms: 500 }],
      { detailMs: 3_000, normalize: normPath });
    expect(p.show).toBe(true);
    expect(p.oldestMs).toBe(3_200);
    expect(p.tasks[0].label).toBe('전 vCenter 요약 집계');
  });
  it('진행 중 요청이 없으면 보이지 않는다', () => {
    expect(visibleProgress([], { detailMs: 3_000 }).show).toBe(false);
    expect(visibleProgress(null).show).toBe(false);
  });
  it('문턱은 주입값을 따른다(뷰가 3초를 하드코딩하지 않는다)', () => {
    const rows = [{ path: '/summary', ms: 5_000 }];
    expect(visibleProgress(rows, { detailMs: 10_000 }).show).toBe(false);
    expect(visibleProgress(rows, { detailMs: 1_000 }).show).toBe(true);
  });
});
