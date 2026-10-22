import { describe, it, expect } from 'vitest';
import { veeamBadge, veeamSummary, veeamCounts, resultLabel, shortTime, sizeText, durationText, veeamDetailView } from './veeamBadge.js';

describe('veeamBadge (v2.751)', () => {
  it('백업 대상은 완료 시각을 붙이고 · 백업 중은 진행률 · 대기', () => {
    expect(veeamBadge(null)).toBe(null);
    const lb = new Date(2026, 9, 22, 1, 12).getTime();
    const ok = veeamBadge({ jobs: ['BJ-Web'], run: 0, rp: 14, lb, lbSrc: 'task', lastRun: lb, lastResult: 'Success', servers: ['VBR-A'] });
    expect(ok.label).toBe('Veeam 10-22 01:12'); expect(ok.color).toBe('green'); expect(ok.progress).toBe(null);
    expect(ok.title).toMatch(/마지막 백업 완료/); expect(ok.title).toMatch(/복원 지점 14개/); expect(ok.title).toMatch(/누르면 백업 상세/);
    expect(veeamBadge({ rp: 3 }).label).toBe('Veeam'); // 완료 시각을 모르면 날짜를 지어내지 않는다
    expect(veeamBadge({ lb, lbSrc: 'rp' }).title).toMatch(/최신 복원 지점 생성/); // 복원 지점 시각은 완료 시각이라 말하지 않는다
    const run = veeamBadge({ jobs: ['J'], run: 1, pg: 42, by: 'task' });
    expect(run.label).toBe('백업 중 42%'); expect(run.color).toBe('amber'); expect(run.progress).toBe(42);
    const job = veeamBadge({ jobs: ['J'], run: 1, pg: null, by: 'job' });
    expect(job.label).toBe('백업 중'); expect(job.progress).toBe(null); // 진행률을 모르면 % 도 막대도 없다
    expect(veeamBadge({ run: 2 }).label).toBe('대기');
    expect(veeamBadge({ rp: -1 }).title).toMatch(/개수 모름/);
  });
  it('보조 포맷 — 값이 없으면 단위를 붙이지 않는다', () => {
    expect(resultLabel('Failed')).toBe('실패'); expect(resultLabel('None')).toBe(''); expect(resultLabel('Odd')).toBe('Odd');
    expect(shortTime(null)).toBe('');
    expect(sizeText(null)).toBe('—'); expect(sizeText(0)).toBe('0 B'); expect(sizeText(5 * 1024 ** 4)).toBe('5.0 TB');
    expect(durationText(null)).toBe('—'); expect(durationText(42 * 60)).toBe('42분'); expect(durationText(3725)).toBe('1시간 2분'); expect(durationText(9)).toBe('9초');
  });
});

describe('veeamSummary (v2.751 요약 카드)', () => {
  it('미등록 · 읽기 실패는 백업 없음으로 단정하지 않는다', () => {
    const u = veeamSummary({ configured: false });
    expect(u.kind).toBe('unconfigured'); expect(u.text).toMatch(/Veeam 백업 서버에서 등록/); expect(u.stats).toBe(null);
    const e = veeamSummary(null, { error: 'HTTP 500' });
    expect(e.tone).toBe('warn'); expect(e.text).toMatch(/백업이 없다는 뜻이 아닙니다/);
  });
  it('집계·출처·기준 시각 · 서버 실패는 경고 · 대조 못 한 항목은 자세히 · 백틱 없음', () => {
    const d = { configured: true, servers: [{ name: 'A', ok: true, lastOkTs: Date.UTC(2026, 9, 22) }, { name: 'B', ok: false, error: '인증 실패(401)', authStopped: true, lastOkTs: null }],
      byVm: { a: { run: 1 }, b: { run: 0 }, c: { run: 2 } }, otherVcenter: 3, ambiguous: 1, unmatched: 2 };
    expect(veeamCounts(d.byVm)).toEqual({ total: 3, running: 1, pending: 1 });
    const s = veeamSummary(d, { vmTotal: 240 });
    expect(s.tone).toBe('warn'); expect(s.kind).toBe('ok');
    expect(s.stats).toEqual({ total: 3, running: 1, pending: 1, vmTotal: 240 });
    expect(s.source).toBe('서버 A, B'); expect(s.basis).toMatch(/^기준 /);
    expect(s.warnings.join('\n')).toMatch(/B 인증 실패로 주기 수집을 멈췄습니다/);
    expect(s.details.join('\n')).toMatch(/다른 vCenter 로 적은 VM 3개/);
    expect(s.details.join('\n')).toMatch(/고르지 못한 항목 1개/);
    expect(s.details.join('\n')).toMatch(/찾지 못한 Veeam 항목 2개/);
    expect([...s.warnings, ...s.details].join('')).not.toMatch(/`/);
  });
});

describe('veeamDetailView (v2.751 상세 창)', () => {
  it('정보가 없으면 백업 안 됨으로 단정하지 않는다', () => {
    const v = veeamDetailView(null);
    expect(v.sections).toEqual([]); expect(v.status.text).toMatch(/단정하지 않습니다/);
  });
  it('마지막 백업·복원 지점·용량 — 모르는 값은 — 과 이유', () => {
    const v = veeamDetailView({
      running: null, pending: false, lastBackup: Date.UTC(2026, 9, 21, 16, 42), lastBackupSrc: 'task',
      lastTask: { result: 'Success', job: 'BJ-Web', start: Date.UTC(2026, 9, 21, 16), end: Date.UTC(2026, 9, 21, 16, 42), durationSec: 2520, processed: null, read: null, transferred: null, message: '' },
      restorePoints: { count: 14, oldest: 1, latest: 2, recent: [2, 1] }, vmSize: null, backups: [{ id: 'b', name: 'BJ-Web' }], jobs: [{ name: 'BJ-Web' }],
    });
    expect(v.status.tone).toBe('green'); expect(v.status.text).toMatch(/마지막 백업 완료/);
    const last = v.sections.find((x) => x.title === '마지막 백업');
    expect(last.rows).toContainEqual(['소요 시간', '42분']);
    expect(last.rows).toContainEqual(['처리한 데이터', '—']);
    expect(last.note).toMatch(/처리 용량을 주지 않았습니다/);
    expect(v.sections.find((x) => x.title === '복원 지점').rows[0]).toEqual(['개수', '14개']);
    expect(v.sections.find((x) => x.title === '용량').note).toMatch(/공유/);
    expect(v.recent).toEqual([2, 1]); expect(v.backups.length).toBe(1);
  });
  it('백업 중이면 진행률', () => {
    const v = veeamDetailView({ running: { progress: 37, by: 'task' }, restorePoints: {} });
    expect(v.status.progress).toBe(37); expect(v.status.text).toMatch(/37%/);
  });
});

describe('에이전트 백업 표시 (v2.752)', () => {
  it('배지·상세가 이름으로 맞췄다는 근거를 말한다', () => {
    expect(veeamBadge({ rp: 7, ag: 1, servers: ['OC'] }).title).toMatch(/에이전트 백업 — .*컴퓨터 이름으로/);
    expect(veeamBadge({ rp: 7, servers: ['OC'] }).title).not.toMatch(/에이전트/);
    expect(veeamDetailView({ agent: true, restorePoints: { count: 7 }, lastBackup: Date.UTC(2026, 9, 22), lastBackupSrc: 'rp' }).status.text).toMatch(/에이전트 백업\(컴퓨터 이름으로 맞춤\)/);
  });
});
