// 148회차 — 결정 145 K1 · 144 D1 의 공용 코어(순수).
//   K1: fillStep 경계 종류 critOp — 'gte'(처음값 · VM) · 'gt'(Hypervisor). critWord 는 범례 · 안내가 같은 경계를 말하게.
//   D1: staleScopeText — ‘오래됨 N곳’ 이 notCurrent 사유를 가른다(점검중만 따로 · 그 밖은 예전 문장 — 단정하지 않는다).
import { describe, it, expect } from 'vitest';
import { fillStep, critWord } from './treemap.js';
import { staleScopeText } from './insightCore.js';
import { fillDefs as hostFillDefs, hostScale } from '../hosts/hostInsightText.js';

describe('148 K1 — fillStep 경계 종류', () => {
  const steps = [50, 75];
  it('처음값(critOp 없음)은 이상(≥) — VM 과 예전 호출부 동작 그대로', () => {
    expect(fillStep(90, { steps, crit: 90 })).toEqual({ step: 2, over: true });
    expect(fillStep(89.99, { steps, crit: 90 }).over).toBe(false);
    expect(fillStep(90, { steps, crit: 90, critOp: 'gte' }).over).toBe(true);
    expect(fillStep(90, { steps, crit: 90, critOp: '모르는 값' }).over).toBe(true);   // 모르는 종류는 처음값(≥)
  });
  it("'gt' 는 초과(>) — 정확히 경계는 경고가 아니고 파랑 단계 그대로", () => {
    expect(fillStep(90, { steps, crit: 90, critOp: 'gt' })).toEqual({ step: 2, over: false });
    expect(fillStep(90.01, { steps, crit: 90, critOp: 'gt' })).toEqual({ step: 2, over: true });
    expect(fillStep(999, { steps, crit: 90, critOp: 'gt' }).over).toBe(true);           // N+1 ‘수용 불가’(999)는 경고
    expect(fillStep(null, { steps, crit: 90, critOp: 'gt' })).toEqual({ step: null, over: false });
    expect(fillStep(95, { steps, crit: null, critOp: 'gt' }).over).toBe(false);         // 경계 없는 기준은 빨강 없음
  });
  it('critWord — gt 만 ‘초과’, 그 밖은 ‘이상’', () => {
    expect(critWord({ critOp: 'gt' })).toBe('초과');
    expect(critWord({ critOp: 'gte' })).toBe('이상');
    expect(critWord({})).toBe('이상');
    expect(critWord(null)).toBe('이상');
  });
  it('Hypervisor 색 기준 넷 모두 초과 · 범례 ‘90% 초과(경고)’ — 서버 overloadPct(> ) · n1LimitPct(≤ 버팀)와 같은 말', () => {
    const defs = hostFillDefs({ overloadPct: 90, n1LimitPct: 90, usageEdges: [50, 75, 90] }, { cluster: true });
    expect(defs.map((d) => [d.key, d.critOp])).toEqual([['n1mem', 'gt'], ['max', 'gt'], ['cpu', 'gt'], ['mem', 'gt']]);
    for (const d of defs) {
      expect(fillStep(90, d).over).toBe(false);
      expect(fillStep(91, d).over).toBe(true);
      expect(hostScale(d).map((x) => x.text)).toContain('90% 초과(경고)');
    }
  });
});

describe('148 D1 — staleScopeText', () => {
  const name = (r) => r.name;
  const row = (name, notCurrent) => ({ id: name, name, stale: true, ...(notCurrent === undefined ? {} : { notCurrent }) });
  it('오래된 줄이 없으면 빈 글', () => {
    expect(staleScopeText([], name)).toBe('');
    expect(staleScopeText(null, name)).toBe('');
  });
  it('점검중이 없으면 예전 문장 그대로 — 사유 stale · unreachable · 없음 · 모르는 값', () => {
    const rows = [row('A', 'stale'), row('B', 'unreachable'), row('C'), row('D', 'new-reason'), row('E', null)];
    expect(staleScopeText(rows, name)).toBe('오래됨 5곳(A · B · C · D · E) — 값이 늦어 합에 넣지 않았습니다.');
  });
  it('점검중만 — ‘점검중 N곳’', () => {
    expect(staleScopeText([row('M', 'maintenance')], name)).toBe('오래됨 1곳 — 점검중 1곳(M) — 지금 값이 아니라 합에 넣지 않았습니다.');
  });
  it('섞이면 점검중 · 값 늦음으로 나눈다(받은 순서 유지)', () => {
    const rows = [row('S', 'stale'), row('M1', 'maintenance'), row('U', 'unreachable'), row('M2', 'maintenance'), row('X')];
    expect(staleScopeText(rows, name)).toBe('오래됨 5곳 — 점검중 2곳(M1 · M2) · 값 늦음 3곳(S · U · X) — 지금 값이 아니라 합에 넣지 않았습니다.');
  });
  it('문구 규칙 — 백틱 없음', () => {
    expect(staleScopeText([row('M', 'maintenance'), row('S', 'stale')], name)).not.toMatch(/`/);
  });
});
