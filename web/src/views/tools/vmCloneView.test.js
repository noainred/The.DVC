import { describe, it, expect } from 'vitest';
import {
  runTone, lastRunTones, lastVerify, cloneBytes, fmtBytes, agoText, durText, kpisOf, jobState, execText,
  corpEdgeState, corpCards, recentSessions, storageRows, capacityEstimate, restoreNameDefault, busyOp, phaseRows,
  keepText, triggerText, historyFilter, historyCsv, rpoText, rpoOverdueCount,
  rpoSummary, dayCounts, progressOf, jobFilter, jobFilterCounts, nextRunText, ganttRows, pointTimeline, meterOf, untilText,
} from './vmCloneView.js';

const NOW = Date.UTC(2026, 9, 26, 3, 0, 0);
const H = 3_600_000;

describe('VM 백업 센터 화면 판정(v2.793)', () => {
  it('runTone — 건너뜀은 성공도 실패도 아니다 · 경고(⚠)가 붙은 성공은 warn', () => {
    expect(runTone({ ok: true, detail: '클론 완료' })).toBe('ok');
    expect(runTone({ ok: true, detail: '클론 완료 ⚠ 스냅샷 삭제 실패' })).toBe('warn');
    expect(runTone({ ok: true, detail: '삭제 건너뜀 1건' })).toBe('warn');
    expect(runTone({ ok: false, skipped: 'auth-stopped' })).toBe('skip');
    expect(runTone({ ok: false })).toBe('fail');
    expect(runTone(null)).toBe('none');
  });

  it('lastRunTones — 백업만(검증·복구 제외) · 모자라면 앞을 none 으로', () => {
    const job = { history: [{ ok: true }, { kind: 'verify', ok: false }, { kind: 'backup', ok: false }] };
    expect(lastRunTones(job, 4)).toEqual(['none', 'none', 'ok', 'fail']);
  });

  it('사본 크기 — 모르는 사본은 0 이 아니라 따로 센다 · fmtBytes 는 모르면 —', () => {
    expect(cloneBytes([{ bytes: 1024 }, { bytes: null }, {}, { bytes: '2048' }])).toEqual({ bytes: 3072, known: 2, unknown: 2 });
    expect(fmtBytes(null)).toBe('—');
    expect(fmtBytes(undefined)).toBe('—');
    expect(fmtBytes(1.2 * 1024 ** 4)).toBe('1.2 TB');
    expect(fmtBytes(512)).toBe('512 B');
  });

  it('agoText · durText', () => {
    expect(agoText(NOW - 5_000, NOW)).toBe('방금');
    expect(agoText(NOW - 12_000, NOW)).toBe('12초 전');
    expect(agoText(NOW - 3 * H, NOW)).toBe('3시간 전');
    expect(agoText(0, NOW)).toBe('—');
    expect(durText(531_000)).toBe('8분 51초');
    expect(durText(-1)).toBe('—');
  });

  it('kpisOf — 24시간 안의 백업만 · 건너뜀 따로 · 크기 모름 따로 · 최근 검증 · 엣지 보고 없음', () => {
    const jobs = [
      { enabled: true, history: [{ at: NOW - H, ok: true }, { at: NOW - 30 * H, ok: false }, { at: NOW - 2 * H, kind: 'verify', ok: false }], clones: [{ at: NOW - 5 * 24 * H, bytes: 100 }, { at: NOW - H, verify: { at: NOW - H, ok: true } }] },
      { enabled: false, history: [{ at: NOW - H, ok: false, skipped: 'auth-stopped' }], clones: [], exec: { where: 'edge', agent: 'e', reported: false } },
      { enabled: true, history: [{ at: NOW - H, ok: false }], clones: [{ at: NOW - 2 * H, bytes: 50, verify: { at: NOW - H, ok: false } }] },
    ];
    const k = kpisOf(jobs, NOW);
    expect(k.protectedVms).toBe(2); expect(k.disabled).toBe(1);
    expect([k.ok24, k.fail24, k.skip24, k.total24]).toEqual([1, 1, 1, 2]);
    expect(k.points).toBe(3); expect(k.bytes).toBe(150); expect(k.unknownBytes).toBe(1);
    expect([k.verifyOk, k.verifyTotal]).toEqual([1, 2]);
    expect(k.noReport).toBe(1);
    expect(k.oldestPointAt).toBe(NOW - 5 * 24 * H);
  });

  it('lastVerify — 가장 최근 검증', () => {
    expect(lastVerify({ clones: [{ verify: { at: 1, ok: false } }, { verify: { at: 5, ok: true } }, {}] })).toEqual({ at: 5, ok: true });
    expect(lastVerify({ clones: [] })).toBe(null);
  });

  it('jobState · execText — 꺼짐 · 담당 미확정 · 실행 중 · 보고 없음 · 마지막 결과', () => {
    expect(jobState({ enabled: false })).toBe('off');
    expect(jobState({ exec: { where: 'conflict' } })).toBe('problem');
    expect(jobState({ exec: { where: 'edge', reported: true, runningPhase: '클론' } })).toBe('running');
    expect(jobState({ exec: { where: 'edge', reported: false } })).toBe('noreport');
    expect(jobState({ history: [{ ok: true }, { ok: false }] })).toBe('fail');
    expect(jobState({ history: [], lastRun: null })).toBe('none');
    expect(execText({ exec: { where: 'edge', agent: 'edge-va', reported: true, reportedAt: NOW - 8_000 } }, NOW)).toBe('담당 엣지 edge-va · 보고 방금');
    expect(execText({ exec: { where: 'edge', agent: 'edge-va', reported: false } }, NOW)).toBe('담당 엣지 edge-va · 아직 보고 없음');
    expect(execText({ exec: { where: 'local' } })).toBe('');
    expect(execText({ exec: { where: 'none', reason: '담당 엣지를 아직 모릅니다' } })).toBe('담당 엣지를 아직 모릅니다');
  });

  it('corpEdgeState · corpCards — 엣지 보고 없음·끊김·구버전·데모 · 저장소 요약', () => {
    expect(corpEdgeState({ key: 'central' }, NOW)).toBe('central');
    expect(corpEdgeState({ agent: 'e' }, NOW)).toBe('noreport');
    expect(corpEdgeState({ agent: 'e', edge: { at: NOW - 10 * 60_000, proto: 1 } }, NOW)).toBe('stale');
    expect(corpEdgeState({ agent: 'e', edge: { at: NOW, proto: 0 } }, NOW)).toBe('old');
    expect(corpEdgeState({ agent: 'e', edge: { at: NOW, proto: 1 } }, NOW)).toBe('ok');
    expect(corpEdgeState({ simulated: true }, NOW)).toBe('sim');
    expect(corpEdgeState({ problem: 'x' }, NOW)).toBe('problem');
    const cards = corpCards(
      [{ key: 'edge:e', label: '버지니아', agent: 'edge-va', vcenterIds: ['v1'], edge: { at: NOW - 8_000, proto: 1, version: '2.793.0', mounts: [{ label: 'NFS 마운트 m1', mounted: true }], runner: { running: null, queued: ['a'] } } }],
      [{ vcenterId: 'v1', history: [{ at: NOW - H, ok: true }] }, { vcenterId: 'v2', history: [{ at: NOW - H, ok: false }] }],
      [{ vcenterId: 'v1', name: 'va-bk02' }], NOW);
    expect(cards[0]).toMatchObject({ name: '버지니아', state: 'ok', jobs: 1, ok24: 1, total24: 1, queued: 1 });
    expect(cards[0].sub).toBe('엣지 edge-va · 보고 방금 · v2.793.0');
    expect(cards[0].storesText).toBe('NFS-DS va-bk02 · 엣지 NFS NFS 마운트 m1');
  });

  it('recentSessions — 이력 + 진행 중 작업 · 최신순', () => {
    const s = recentSessions(
      [{ id: 'j', vmName: 'db-01', history: [{ at: 1, ok: true, detail: 'a' }, { at: 3, kind: 'verify', ok: false, detail: 'b' }] }],
      [{ state: 'pending', kind: 'restore', label: '복구', where: 'edge', agent: 'edge-va', createdAt: 5, vmName: 'db-01', jobId: 'j' }, { state: 'done', kind: 'nfsds-attach', ok: true, doneAt: 2, target: 'va-bk02' }],
      10);
    expect(s.map((x) => [x.at, x.kind, x.tone])).toEqual([[5, 'restore', 'running'], [3, 'verify', 'fail'], [2, 'nfsds-attach', 'ok'], [1, 'backup', 'ok']]);
    expect(s[0].detail).toMatch(/가져가기 대기/);
  });

  it('storageRows — 대상별 사본 합 · 인벤토리 용량(NFS-DS 정의 포함)', () => {
    const rows = storageRows(
      [{ vcenterId: 'v', dest: { type: 'datastore', datastoreName: 'DS1' }, clones: [{ bytes: 10 }, {}] }, { vcenterId: 'v', dest: { type: 'datastore', datastoreName: 'DS1' }, clones: [{ bytes: 5 }] }, { vcenterId: 'v', dest: { type: 'nfs', mountId: 'm1' }, clones: [] }],
      [{ vcenterId: 'v', name: 'DS1', capacityGB: 100, freeGB: 40 }], []);
    expect(rows[0]).toMatchObject({ name: 'DS1', bytes: 15, unknown: 1, capacityGB: 100, freeGB: 40 });
    expect(rows[1]).toMatchObject({ name: 'NFS m1', kind: 'nfs', capacityGB: null });
  });

  it('capacityEstimate · restoreNameDefault · busyOp · phaseRows', () => {
    expect(capacityEstimate(172, 7, 2400)).toEqual({ needGB: 1204, keep: 7, freeGB: 2400, fits: true });
    expect(capacityEstimate(null, 7, 2400)).toBe(null);
    expect(capacityEstimate(100, 3, null)).toEqual({ needGB: 300, keep: 3, freeGB: null, fits: null });
    expect(restoreNameDefault('db-01', Date.UTC(2026, 9, 26, 3))).toMatch(/^db-01-restore-2026102[56]$/);
    expect(busyOp([{ state: 'running', jobId: 'j', kind: 'verify', ref: 'r1' }], 'j', 'verify', 'r1')).toBeTruthy();
    expect(busyOp([{ state: 'running', jobId: 'j', kind: 'verify', ref: 'r1' }], 'j', 'verify', 'r2')).toBe(null);
    expect(busyOp([{ state: 'done', jobId: 'j', kind: 'verify' }], 'j', 'verify')).toBe(null);
    expect(phaseRows({ phases: [{ n: 'a', ms: 1 }, { n: 'b', ms: 2, ok: false }] }, { phase: '클론' })).toEqual([
      { name: 'a', ms: 1, state: 'done' }, { name: 'b', ms: 2, state: 'fail' }, { name: '클론', ms: null, state: 'running' }]);
  });
});

describe('VM 백업 센터 v2.794 — 보존 문구 · 실행 사유 · 이력 필터 · CSV', () => {
  it('keepText · triggerText — 기간이 없으면 개수만 · 모르는 사유는 그대로', () => {
    expect(keepText({ keep: 7 })).toBe('7개');
    expect(keepText({ keep: 7, keepDays: 30 })).toBe('7개 · 30일');
    expect(triggerText('restart')).toBe('재시작 정리');
    expect(triggerText('resume')).toBe('재시작 뒤 재실행');
    expect(triggerText('weird')).toBe('weird');
  });
  it('historyFilter — 종류별 · 실패만(건너뜀 제외) · 전체는 그대로', () => {
    const h = [{ kind: 'backup', ok: true, detail: 'ok' }, { kind: 'verify', ok: false, detail: 'x' }, { ok: false, skipped: 'delegated', detail: 's' }, { kind: 'restore', ok: true }];
    expect(historyFilter(h, 'all')).toHaveLength(4);
    expect(historyFilter(h, 'backup')).toHaveLength(2);
    expect(historyFilter(h, 'verify')).toEqual([h[1]]);
    expect(historyFilter(h, 'fail')).toEqual([h[1]]);
  });
  it('historyCsv — 머리줄 · ISO 시각 · 수식 인젝션 가드 · 단계', () => {
    const csv = historyCsv({ vmName: 'web01', vcenterId: 'vcA' }, [
      { at: NOW, kind: 'backup', ok: false, ms: 61_000, trigger: 'schedule', detail: '=HYPERLINK("x")', phases: [{ n: '스냅샷', ms: 2000 }, { n: '클론', ms: 59000, ok: false }] },
    ]);
    const [head, row] = csv.split('\n');
    expect(head.startsWith('시각,VM,vCenter,종류')).toBe(true);
    expect(row).toContain(new Date(NOW).toISOString());
    expect(row).toContain('스케줄');
    expect(row).toContain('실패');
    expect(row).toContain('스냅샷 2s > 클론 59s(실패)');
    expect(row).not.toMatch(/,=HYPERLINK/);
  });
});

describe('VM 백업 센터 v2.795 — RPO 초과 문구(서버 판정을 그대로)', () => {
  it('rpoText · rpoOverdueCount — 초과가 아니면 빈 문구 · 성공 없음 · 주기', () => {
    expect(rpoText(null, NOW)).toBe('');
    expect(rpoText({ overdue: false, intervalMs: 24 * H }, NOW)).toBe('');
    expect(rpoText({ overdue: true, intervalMs: 24 * H, lastOkAt: NOW - 50 * H }, NOW)).toMatch(/^RPO 초과 · 마지막 성공 .+\(주기 24시간\)$/);
    expect(rpoText({ overdue: true, intervalMs: 6 * H, lastOkAt: null }, NOW)).toBe('RPO 초과 · 성공한 백업 없음(주기 6시간)');
    expect(rpoOverdueCount([{ rpo: { overdue: true } }, { rpo: null }, {}])).toBe(1);
  });
});

describe('VM 백업 센터 v2.797 — 화면 개편 계산(링·14일·필터·간트·타임라인·미터)', () => {
  const NOW = new Date(2026, 9, 26, 12, 0, 0).getTime(); // 브라우저 시각 기준 정오(일 경계 판정과 무관하게)
  const H = 3_600_000;

  it('rpoSummary — 서버 판정만 분모에, 수동·판정 없음·비활성은 따로 센다', () => {
    const s = rpoSummary([
      { enabled: true, schedule: { mode: 'daily' }, rpo: { overdue: false } },
      { enabled: true, schedule: { mode: 'daily' }, rpo: { overdue: true } },
      { enabled: true, schedule: { mode: 'manual' }, rpo: null },
      { enabled: true, schedule: { mode: 'interval', hours: 6 }, rpo: null },
      { enabled: false, schedule: { mode: 'daily' }, rpo: null },
      { enabled: true, schedule: { mode: 'daily' }, rpo: null, exec: { where: 'edge', reported: false } },
    ]);
    expect(s).toMatchObject({ judged: 2, ok: 1, overdue: 1, manual: 1, unjudged: 2, disabled: 1, noReport: 1, pct: 50 });
    expect(rpoSummary([{ enabled: true, schedule: { mode: 'manual' } }]).pct).toBe(null);
  });

  it('dayCounts — 백업만 날짜별로, 건너뜀은 total 에 넣지 않고, 이력이 가득 찬 잡의 가장 오래된 기록 이전은 partial', () => {
    const job = { history: [
      { at: NOW - 1 * H, ok: true },
      { at: NOW - 2 * H, ok: false },
      { at: NOW - 3 * H, ok: true, detail: '⚠ 스냅샷 삭제 실패' },
      { at: NOW - 4 * H, skipped: '인증 정지' },
      { at: NOW - 5 * H, kind: 'verify', ok: true },
      { at: NOW - 30 * 86_400_000, ok: true },
    ] };
    const days = dayCounts([job], NOW, 14, { historyMax: 30 });
    expect(days).toHaveLength(14);
    const today = days[13];
    expect(today).toMatchObject({ ok: 1, fail: 1, warn: 1, skip: 1, total: 3, partial: false });
    expect(days.slice(0, 13).every((d) => d.total === 0 && !d.partial)).toBe(true);
    // 이력이 상한(여기선 6)만큼 차 있으면 가장 오래된 기록 이전 날은 partial
    const full = dayCounts([{ history: job.history.slice(0, 5).concat([{ at: NOW - 3 * 86_400_000, ok: true }]) }], NOW, 14, { historyMax: 6 });
    expect(full[9].partial).toBe(true);    // 4일 전
    expect(full[10].partial).toBe(true);   // 3일 전 — 가장 오래된 기록이 있는 날도 그 이전 시각은 빠졌을 수 있다
    expect(full[10].ok).toBe(1);
    expect(full[11].partial).toBe(false);  // 2일 전
    // 상한을 모르면 판정하지 않는다
    expect(dayCounts([{ history: job.history }], NOW, 14).some((d) => d.partial)).toBe(false);
  });

  it('progressOf — 단계 문구 끝의 % 만, 없으면 null', () => {
    expect(progressOf('클론 → demo-nfs-bk01 · 42%')).toBe(42);
    expect(progressOf('스냅샷')).toBe(null);
    expect(progressOf('')).toBe(null);
    expect(progressOf('클론 · 250%')).toBe(null);
  });

  it('jobFilter·jobFilterCounts — 실패(담당 미확정 포함)·RPO 초과·검증 실패·비활성', () => {
    const jobs = [
      { id: 'a', enabled: true, history: [{ at: 1, ok: false }] },
      { id: 'b', enabled: true, history: [{ at: 1, ok: true }], rpo: { overdue: true }, clones: [{ verify: { ok: false, at: 2 } }] },
      { id: 'c', enabled: false, history: [] },
      { id: 'd', enabled: true, exec: { where: 'none' } },
    ];
    expect(jobFilterCounts(jobs)).toEqual({ all: 4, fail: 2, rpo: 1, verifyFail: 1, off: 1 });
    expect(jobFilter(jobs, 'fail').map((j) => j.id)).toEqual(['a', 'd']);
    expect(jobFilter(jobs, '없는필터')).toHaveLength(4);
  });

  it('nextRunText — 간격 잡만 계산하고 매일 잡은 포탈 시각이라 계산하지 않는다', () => {
    expect(nextRunText({ enabled: true, schedule: { mode: 'interval', hours: 6 }, lastRun: { at: NOW - 2 * H } }, NOW)).toBe('4시간 뒤 실행');
    expect(nextRunText({ enabled: true, schedule: { mode: 'interval', hours: 6 }, lastRun: { at: NOW - 7 * H } }, NOW)).toBe('주기 도래 · 곧 실행');
    expect(nextRunText({ enabled: true, schedule: { mode: 'interval', hours: 6 } }, NOW)).toBe('첫 실행 대기');
    expect(nextRunText({ enabled: true, schedule: { mode: 'daily', time: '02:00' }, lastRun: { at: NOW } }, NOW)).toBe('');
    expect(nextRunText({ enabled: false, schedule: { mode: 'interval', hours: 6 } }, NOW)).toBe('');
  });

  it('ganttRows — 누적 시각으로 배치, ms 모르는 단계는 폭 0', () => {
    const { rows, totalMs } = ganttRows({ phases: [{ n: '스냅샷', ms: 1000 }, { n: '클론', ms: 3000 }, { n: '정리', ok: false }] });
    expect(totalMs).toBe(4000);
    expect(rows[0]).toMatchObject({ name: '스냅샷', left: 0, width: 25, state: 'done' });
    expect(rows[1]).toMatchObject({ left: 25, width: 75 });
    expect(rows[2]).toMatchObject({ ms: null, width: 0, state: 'fail' });
    expect(ganttRows(null)).toEqual({ rows: [], totalMs: 0 });
  });

  it('pointTimeline — 최근 max 개를 시각 순으로, 시각 모르는 사본은 따로', () => {
    const clones = [
      { ref: 'x1', at: NOW - 48 * H, verify: { ok: true } },
      { ref: 'x2', at: NOW - 24 * H, verify: { ok: false } },
      { ref: 'x3', at: NOW },
      { ref: 'x4' },
    ];
    const t = pointTimeline(clones, NOW, 12);
    expect(t.unknown).toBe(1);
    expect(t.points.map((p) => [p.ref, Math.round(p.left), p.tone, p.latest])).toEqual([['x1', 0, 'ok', false], ['x2', 50, 'fail', false], ['x3', 100, 'none', true]]);
    expect(pointTimeline(clones, NOW, 2).points.map((p) => p.ref)).toEqual(['x2', 'x3']);
    expect(pointTimeline([{ ref: 'one', at: NOW - H }], NOW).points[0].left).toBe(50);
    expect(pointTimeline([], NOW).points).toEqual([]);
  });

  it('meterOf — 전체·여유를 모르면 null, 들어갈 양이 여유보다 크면 over', () => {
    expect(meterOf({ capacityGB: 1000, freeGB: 600, needGB: 200 })).toMatchObject({ usedPct: 40, needPct: 20, over: false });
    expect(meterOf({ capacityGB: 1000, freeGB: 100, needGB: 200 })).toMatchObject({ usedPct: 90, needPct: 10, over: true });
    expect(meterOf({ capacityGB: 1000, freeGB: 600 })).toMatchObject({ needPct: 0, over: false });
    expect(meterOf({ capacityGB: null, freeGB: 600 })).toBe(null);
    expect(meterOf({ capacityGB: 1000, freeGB: null })).toBe(null);
  });

  it('untilText — 지난 시각은 빈 문자열', () => {
    expect(untilText(NOW + 30 * 60_000, NOW)).toBe('30분 뒤');
    expect(untilText(NOW - 1, NOW)).toBe('');
  });
});
