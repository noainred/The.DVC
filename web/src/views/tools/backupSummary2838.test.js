/**
 * v2.838 Summary 를 시안 ① 에 맞추기 B(사용자 요청 '2.838 구현해줘').
 *   ① 용량 · 일정 배치(순수) ② 에러 로그 거르기 · 열기(권한) · 서버 코어와 같은 종류 ③ 알림 조건 글자 ④ 화면 소스 — 순서 · 폴링 없음 · 같은 API · 알림 버튼은 서버가 숨기면 없음
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import * as P from './backupSummaryPlan.js';
import * as ER from '../../../../server/src/veeam/backupErrors.js';
import * as SA from '../../../../server/src/veeam/staleAlert.js';

const H = 3_600_000;
const NOW = new Date(2026, 9, 31, 12, 30, 0).getTime();
const TB = 1024 ** 4;

describe('v2.838 용량 — 법인별 · 큰 순 · 모르면 빼고 부분 합 표지', () => {
  const rows = [
    { id: 'a', name: 'KR', veeamState: 'ok', pa: { vbytes: 2 * TB, vbytesN: 3, bbytes: TB, bbytesN: 1 } },
    { id: 'b', name: 'DE', veeamState: 'partial', pa: { vbytes: 4 * TB, vbytesN: 2, bbytes: 0, bbytesN: 0 } },
    { id: 'c', name: 'US', veeamState: 'unlinked', bareosUnknown: true, pa: { vbytes: 0, vbytesN: 0, bbytes: 0, bbytesN: 0 } },
    { id: 'd', name: 'PL', veeamState: 'unlinked', bareosUnknown: true, pa: { vbytes: 0, vbytesN: 0, bbytes: TB / 2, bbytesN: 2 } },
  ];
  it('크기를 읽은 VM 이 없는 법인은 빠진다 · 부분 합(*)', () => {
    const c = P.capacityRows(rows, 2);
    expect(c.items.map((x) => x.name)).toEqual(['DE', 'KR']);
    expect(c.more).toBe(1);
    expect(c.max).toBe(4 * TB);
    expect(c.items[0]).toMatchObject({ v: 4 * TB, b: null, partial: true });
    expect(c.items[1]).toMatchObject({ v: 2 * TB, b: TB, total: 3 * TB, partial: false });
    const all = P.capacityRows(rows, 0);
    expect(all.items.map((x) => x.name)).toEqual(['DE', 'KR', 'PL']);
    expect(all.items[2].partial).toBe(true);
    expect(P.capacityRows([], 5)).toEqual({ items: [], more: 0, max: 0 });
  });
  it('막대 · 선 · 저장소 경고', () => {
    expect([P.barPct(TB, 4 * TB), P.barPct(null, 4 * TB), P.barPct(TB, 0)]).toEqual([25, 0, 0]);
    expect(P.linePoints([[1, 10]])).toBe('');
    expect(P.linePoints([[1, 10], [2, 20], [3, 15]]).split(' ')).toHaveLength(3);
    expect(P.linePoints([[1, 10], [2, 20]])).toBe('2,40 218,4');
    expect(P.repoWarn(null)).toBe(null);
    expect(P.repoWarn({ repo: null }).head).toMatch(/읽은 값 없음/);
    const w = P.repoWarn({ repo: { overN: 3, over: [{ name: 'r1', pct: 94, daysLeft: 11, vc: ['KR'] }, { name: 'r2', pct: 91, daysLeft: null }] } });
    expect(w.head).toBe('Veeam 저장소 3곳 90% 넘음');
    expect(w.items.map((x) => x.left)).toEqual(['남은 일수 추정 11일', '남은 일수 추정 불가(이력 부족 · 증가 없음)']);
    expect(w.items[0].vc).toBe('KR');
    expect(w.more).toBe(1);
  });
});

describe('v2.838 일정 — 24시간 띠 · 7일 칸 · 겹침', () => {
  const from = P.hourStart(NOW);
  it('띠는 창 안으로 자르고 창 밖은 없음 · 짧아도 보인다', () => {
    expect(from).toBe(new Date(2026, 9, 31, 12, 0, 0).getTime());
    expect(P.hourLabels(from)).toHaveLength(24);
    expect(P.hourLabels(from)[0]).toBe('12');
    expect(P.barOf({ at: from + 6 * H, end: from + 12 * H }, from)).toEqual({ left: 25, width: 25 });
    expect(P.barOf({ at: from - 2 * H, end: from + H }, from)).toEqual({ left: 0, width: 4.2 }, '앞에서 시작한 실행은 0 부터');
    expect(P.barOf({ at: from + 23 * H, end: from + 26 * H }, from)).toEqual({ left: 95.8, width: 4.2 }, '끝은 창에서 자른다');
    expect(P.barOf({ at: from + 25 * H, end: from + 26 * H }, from)).toBe(null);
    expect(P.barOf({ at: from - 3 * H, end: from - H }, from)).toBe(null);
    expect(P.barOf({ at: from + H, end: from + H }, from).width).toBe(0.8);
    expect(P.barOf({ at: null, end: 1 }, from)).toBe(null);
  });
  it('7일 머리 · 겹침 글자 · 법인 정렬', () => {
    expect(P.dayLabel(new Date(2026, 9, 31).getTime(), 0)).toBe('오늘(토)');
    expect(P.dayLabel(new Date(2026, 10, 1).getTime(), 1)).toBe('일 11-01');
    expect(P.overlapText({ name: 'OC2', overlap: { from: new Date(2026, 9, 31, 21).getTime(), to: new Date(2026, 10, 1, 5).getTime(), veeam: 58, bareos: 19 } }))
      .toBe('OC2 21:00~05:00 Veeam 잡 58개와 Bareos 그룹 회차 19개가 같은 창');
    expect(P.overlapText({ name: 'X', overlap: null })).toBe('');
    const s = P.sortSchedRows([{ name: 'B', veeam: [{ at: 5 }], bareos: [] }, { name: 'C', veeam: [], bareos: null }, { name: 'A', veeam: [], bareos: [{ at: 3 }] }]);
    expect(s.map((x) => x.name)).toEqual(['A', 'B', 'C']);
  });
});

describe('v2.838 에러 로그 — 거르기 · 열기 · 서버와 같은 종류', () => {
  const rows = [{ kind: 'fail', src: 'veeam' }, { kind: 'warn', src: 'bareos' }, { kind: 'collect', src: 'collect' }, { kind: 'stuck', src: 'bareos' }];
  it('결과 · 솔루션 거르기(솔루션을 고르면 수집 오류는 빠진다)', () => {
    expect(P.filterErrors(rows, {})).toHaveLength(4);
    expect(P.filterErrors(rows, { kind: 'warn' })).toHaveLength(1);
    expect(P.filterErrors(rows, { src: 'bareos' })).toHaveLength(2);
    expect(P.filterErrors(rows, { kind: 'collect', src: 'veeam' })).toHaveLength(0);
    expect(P.filterErrors(null)).toEqual([]);
  });
  it('대상 칸 · 같은 원인 · 시각', () => {
    expect(P.errorTarget({ job: 'J1', vm: 'web01' })).toEqual({ main: 'J1', sub: 'web01' });
    expect(P.errorTarget({ job: 'vm-web01', vm: 'web01', jobid: 9 })).toEqual({ main: 'vm-web01', sub: 'web01 · jobid 9' });
    expect(P.errorTarget({ job: 'EJ', vm: '', server: 'VBR' })).toEqual({ main: 'EJ', sub: 'VBR' });
    expect(P.errorTarget({ job: '', vm: 'db01', jobid: 2 })).toEqual({ main: 'db01', sub: 'jobid 2' });
    expect([P.sameText(3), P.sameText(1), P.sameText(null)]).toEqual(['3건', '—', '—']);
    expect(P.mdhm(new Date(2026, 9, 31, 6, 41).getTime())).toBe('10-31 06:41');
  });
  it('열기 — 권한이 없으면 없음(링크로 막힌 화면에 보내지 않는다)', () => {
    const o = { canBareos: true, canBareosView: true, admin: true };
    expect(P.errorOpen({ open: 'detail' }, {})).toEqual({ key: 'detail', text: 'Detail' });
    expect(P.errorOpen({ open: 'bareos' }, o).hash).toBe('#/tools/bareos-backup/history');
    expect(P.errorOpen({ open: 'bareos' }, { canBareosView: true }).hash).toBe('#/tools/bareos-summary');
    expect(P.errorOpen({ open: 'bareos' }, {})).toBe(null);
    expect(P.errorOpen({ open: 'live' }, {})).toBe(null);
    expect(P.errorOpen({ open: 'live' }, o).hash).toBe('#/tools/bareos-backup/live');
    expect(P.errorOpen({ open: 'em' }, {}).hash).toBe('#/tools/backup-em');
    expect(P.errorOpen({ open: 'bareos-settings' }, { canBareos: true })).toBe(null);
    expect(P.errorOpen({ open: 'bareos-settings' }, o).hash).toBe('#/tools/bareos-backup/settings');
  });
  it('서버 코어와 같은 종류 · 같은 기간', () => {
    expect(P.ERROR_DAY_OPTS.map(([d]) => d)).toEqual([...ER.ERROR_DAYS]);
    const counts = ER.finishErrors([]).counts;
    for (const k of Object.keys(counts).filter((k) => !['all', 'veeam', 'bareos'].includes(k))) expect(P.ERROR_KIND[k], k).toBeTruthy();
    // 서버가 만드는 행의 open 값은 화면이 모두 안다
    const site = { id: 'v', name: 'V' };
    const made = [
      ...ER.veeamVmRows([{ id: 'v:1', name: 'a', v: { lr: 'Failed', lrt: NOW } }], site, 0),
      ...ER.bareosRows(new Map([['v:1', { vmId: 'v:1', lastRun: { jobid: 1, status: 'E', endedAt: NOW }, recentRuns: [] }]]), null, site, 0),
      ...ER.stuckRows([{ vmId: 'v:1', jobid: 2, stuck: 'zero' }], site, NOW),
      ...ER.emSessionRows([{ id: 'e', data: { sessions: { recentBad: [{ result: 'fail', end: NOW }] } } }], 0),
      ...ER.collectRows([{ at: NOW, src: 'veeam' }, { at: NOW, src: 'bareos' }], 0),
    ];
    expect(new Set(made.map((r) => r.open))).toEqual(new Set(['detail', 'bareos', 'live', 'em', 'bareos-settings']));
    for (const r of made) expect(P.errorOpen(r, { canBareos: true, canBareosView: true, admin: true }), r.open).toBeTruthy();
    for (const r of made) expect(P.ERROR_KIND[r.kind], r.kind).toBeTruthy();
  });
});

describe('v2.838 알림 조건 글자', () => {
  const finder = { n: 3, unit: 'd', src: 'policy', excludeNone: true, onlyOn: false, includeNever: true, vc: 'vc-a' };
  it('찾기 조건 → 저장 q(서버가 같은 값으로 정규화한다)', () => {
    const q = P.alertQueryOf(finder);
    expect(q).toEqual({ n: 3, unit: 'd', src: 'policy', excludeNone: true, onlyOn: false, includeNever: true, vc: 'vc-a' });
    expect(SA.normAlert({ time: '08:30', q }).q).toEqual(q);
    expect(P.alertQueryOf({ n: '5' }).n).toBe(5);
  });
  it('조건 한 줄 · 같은가 · 마지막 발송', () => {
    expect(P.alertCondText(finder, (id) => (id === 'vc-a' ? 'KR' : id))).toBe('최근 3일 · 정책에 맞는 백업만 · 법인 KR · 백업 안함 제외');
    expect(P.alertCondText({ n: 12, unit: 'h', src: 'all', excludeNone: false, onlyOn: true, includeNever: false, vc: '' })).toBe('최근 12시간 · 실제 백업 전부 · 전체 법인 · 켜진 VM 만 · 한 번도 없음 빼고');
    expect(P.sameAlertQuery(finder, { ...finder })).toBe(true);
    expect(P.sameAlertQuery(finder, { ...finder, vc: '' })).toBe(false);
    expect(P.sameAlertQuery(null, finder)).toBe(false);
    expect(P.alertStatusText(null)).toBe('아직 보낸 적 없음');
    expect(P.alertStatusText({ day: '2026-10-31', ok: true, n: 4 })).toBe('2026-10-31 보냄 — 4대');
    expect(P.alertStatusText({ day: '2026-10-31', ok: false, tries: 2, reason: '수신자 없음' })).toBe('2026-10-31 보내지 못함(2번 시도) — 수신자 없음');
  });
});

describe('v2.838 화면 소스', () => {
  const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
  const sum = read('./BackupSummaryTool.jsx'); const cs = read('./BackupSummaryCapSched.jsx'); const er = read('./BackupSummaryErrors.jsx');
  const al = read('./BackupSummaryAlert.jsx'); const st = read('./BackupSummaryStale.jsx');
  it('순서 — 트리 → 용량과 일정 → 통합 에러 로그 → 값 출처', () => {
    const i = (s) => sum.indexOf(s);
    expect(i('<BackupSummaryCapSched ')).toBeGreaterThan(i('<BackupSummaryTree '));
    expect(i('<BackupSummaryErrors ')).toBeGreaterThan(i('<BackupSummaryCapSched '));
    expect(i('data-backup-source')).toBeGreaterThan(i('<BackupSummaryErrors '));
  });
  it('무거운 집계는 폴링하지 않는다 — 처음 · 기간 · 새로고침만 · 늦게 온 응답은 버린다', () => {
    for (const s of [cs, er, al]) expect(s).not.toMatch(/usePolling|setInterval/);
    expect(cs).toMatch(/fetchJson\('\/tools\/backup-summary\/schedule'\)/);
    expect(er).toMatch(/fetchJson\('\/tools\/backup-summary\/errors', \{ days: String\(days\) \}\)/);
    for (const s of [cs, er]) expect(s).toMatch(/if \(my === gen\.current\) setData\(r\);/);
    expect(er).toMatch(/<STable minWidth=\{1000\} limit=\{all \? 0 : 50\}>/);
  });
  it('알림 — 같은 API · 서버가 숨기면 버튼도 없음 · 범위 계정 hidden', () => {
    expect(al).toMatch(/putJson\('\/tools\/backup-summary\/alert', \{ enabled, time, q: alertQueryOf\(finder\) \}\)/);
    expect(al).toMatch(/postJson\('\/tools\/backup-summary\/alert\/send', \{\}\)/);
    expect(al).toMatch(/if \(!alert \|\| alert\.hidden\) return null;/);
    expect(st).toMatch(/\{alert && !alert\.hidden && <button type="button"/);
    expect(st).toMatch(/이 조건을 알림으로\(메일\)/);
  });
  it('출처를 지어내지 않는다 — Director 수집본이 없으면 수집 전 · Veeam 은 다음 1회만(v2.839 에 2차 칸을 채웠다)', () => {
    expect(cs).toMatch(/bp \? '—\(풀 수집 실패\)' : '—\(수집 전\)'/);
    expect(cs).toMatch(/Bareos 그룹 예약 \+ Director 스케줄\(정책 수집본\)/);
    expect(cs).toMatch(/Veeam \{d\.veeam == null \? '—' : fmtNum\(d\.veeam\)\}/);
  });
});
