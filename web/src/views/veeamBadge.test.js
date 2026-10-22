import { describe, it, expect } from 'vitest';
import { veeamBadge, veeamSummary, veeamCounts, resultLabel } from './veeamBadge.js';

describe('veeamBadge (v2.751)', () => {
  it('백업 대상 · 백업 중(진행률) · 작업 단위 · 대기', () => {
    expect(veeamBadge(null)).toBe(null);
    const ok = veeamBadge({ jobs: ['BJ-Web'], run: 0, rp: 14, lastRun: Date.UTC(2026, 9, 21, 6, 0), lastResult: 'Success', servers: ['VBR-A'] });
    expect(ok.label).toBe('Veeam'); expect(ok.color).toBe('green');
    expect(ok.title).toMatch(/작업: BJ-Web/); expect(ok.title).toMatch(/복원 지점 14개/); expect(ok.title).toMatch(/\(성공\)/);
    const run = veeamBadge({ jobs: ['J'], run: 1, pg: 42, by: 'task' });
    expect(run.label).toBe('Veeam 백업 중 42%'); expect(run.color).toBe('amber');
    const job = veeamBadge({ jobs: ['J'], run: 1, pg: null, by: 'job' });
    expect(job.label).toBe('Veeam 백업 중'); // 값이 없으면 단위(%)를 붙이지 않는다
    expect(job.title).toMatch(/VM 단위로 알려 주지 않았습니다/);
    expect(veeamBadge({ run: 2 }).label).toBe('Veeam 대기');
    expect(veeamBadge({ rp: -1 }).title).toMatch(/개수 모름/);
  });
  it('resultLabel 은 모르는 값을 원문으로 · None 은 빈 값', () => {
    expect(resultLabel('Failed')).toBe('실패'); expect(resultLabel('None')).toBe(''); expect(resultLabel('Odd')).toBe('Odd');
  });
});

describe('veeamSummary (v2.751)', () => {
  it('미등록 · 읽기 실패는 백업 없음으로 단정하지 않는다', () => {
    expect(veeamSummary({ configured: false }).text).toMatch(/Veeam 백업 서버에서 등록/);
    const e = veeamSummary(null, { error: 'HTTP 500' });
    expect(e.tone).toBe('warn'); expect(e.text).toMatch(/백업이 없다는 뜻이 아닙니다/);
  });
  it('집계·서버 실패·대조 못 한 항목을 말한다 · 백틱 없음', () => {
    const d = { configured: true, servers: [{ name: 'A', ok: true, lastOkTs: Date.UTC(2026, 9, 22) }, { name: 'B', ok: false, error: '인증 실패(401)', authStopped: true, lastOkTs: null }],
      byVm: { a: { run: 1 }, b: { run: 0 }, c: { run: 2 } }, otherVcenter: 3, ambiguous: 1, unmatched: 2 };
    expect(veeamCounts(d.byVm)).toEqual({ total: 3, running: 1, pending: 1 });
    const s = veeamSummary(d);
    expect(s.tone).toBe('warn');
    expect(s.text).toMatch(/\*\*3 VM\*\*/); expect(s.text).toMatch(/백업 중 1/); expect(s.text).toMatch(/백업 안 됨이 아닙니다/);
    expect(s.details.join('\n')).toMatch(/B: 인증 실패로 주기 수집 정지/);
    expect(s.details.join('\n')).toMatch(/다른 vCenter 로 적은 VM 3개/);
    expect(s.details.join('\n')).toMatch(/고르지 못한 항목 1개/);
    expect(s.details.join('\n')).toMatch(/찾지 못한 Veeam 항목 2개/);
    expect([s.text, ...s.details].join('')).not.toMatch(/`/);
  });
  it('백업 중인 VM 이 없으면 그렇게 말한다', () => {
    expect(veeamSummary({ configured: true, servers: [{ name: 'A', ok: true }], byVm: { a: { run: 0 } } }).text).toMatch(/지금 백업 중인 VM 없음/);
  });
});
