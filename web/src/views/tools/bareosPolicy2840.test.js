/**
 * v2.840 Bareos 백업 메뉴 개편 2차-b — '보존 · 풀' 탭 · 그룹 카드 · 백업 대상 '적용 정책' · 실행 이력 거르기 · 통합 에러 로그 오류 볼륨.
 *   ① 글자 · 거르기(순수 — 판정은 서버) ② 서버와 같은 값(볼륨 상태 이름 · 겹침 모양) ③ 화면 소스 — 폴링 없음 · 같은 API · 즉시 조회는 권한 · 라우팅 · 하위 탭
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import * as T from './bareosPolicyText.js';
import * as B from './bareosText.js';
import { ERROR_KIND, errorOpen } from './backupSummaryPlan.js';
import * as PP from '../../../../server/src/bareos/policyParse.js';

describe('v2.840 보존 · 풀 글자', () => {
  it('볼륨 상태 칸 · 상한 · 켬/끔 · 쓰는 잡 · 표지', () => {
    expect(T.volStatusText({ status: { Append: 1, Full: 12, Error: 2, Archive: 1 }, other: 1 })).toBe('A 1 · F 12 · U 0 · P 0 · E 2 · 기타 2');
    expect(T.volStatusText({ status: {}, other: 0 })).toBe('A 0 · F 0 · U 0 · P 0 · E 0');
    expect(T.volStatusText(null)).toBe('—');
    expect([T.limitText(0), T.limitText(100), T.limitText(null), T.limitText(5, (x) => `${x}B`)]).toEqual(['제한 없음', '100', '—', '5B']);
    expect([T.onOff(true), T.onOff(false), T.onOff(null)]).toEqual(['켬', '끔', '—']);
    expect(T.usedText({ jobs: 3, groups: 1, jobdefs: [] })).toBe('포탈 잡 3 · 그룹 1');
    expect(T.usedText({ jobs: 0, groups: 0 })).toBe('포탈 잡 0');
    expect(T.usedText(null)).toBe('—');
    expect(T.usedRefs({ jobdefs: ['DefaultJob(Full)', 'X'] })).toBe('JobDefs DefaultJob(Full), X');
    expect(T.usedRefs({ jobdefs: [] })).toBe('');
    expect(T.poolTags({ full: true, vol: { status: { Error: 2 } }, enabled: false }).map((t) => t.text)).toEqual(['가득 참', '오류 볼륨 2', '꺼짐']);
    expect(T.poolTags({ full: null, vol: null })).toEqual([], '모름은 표지가 없다(가득 참으로 단정하지 않는다)');
  });
  it('풀 거르기 — Director · 가득 참 · 오류 볼륨 · 판정 모름', () => {
    const rows = [{ directorId: 'a', full: true, vol: { status: {} } }, { directorId: 'a', full: false, vol: { status: { Error: 1 } } }, { directorId: 'b', full: null, vol: null }];
    expect(T.filterPools(rows, {}).length).toBe(3);
    expect(T.filterPools(rows, { director: 'a' }).length).toBe(2);
    expect(T.filterPools(rows, { state: 'full' })).toEqual([rows[0]]);
    expect(T.filterPools(rows, { state: 'error' })).toEqual([rows[1]]);
    expect(T.filterPools(rows, { state: 'unknown' })).toEqual([rows[2]]);
  });
  it('볼륨 상태 머리글자는 서버 VOL_STATUSES 의 이름', () => {
    for (const [k] of T.VOL_SHORT) expect(PP.VOL_STATUSES).toContain(k);
  });
});

describe('v2.840 그룹 카드 · 백업 대상 적용 정책 줄', () => {
  it('적용 풀 · 보존 — 수집 전 · 목록에 없음 · 볼륨 기준 · 가득 참', () => {
    expect(T.groupPoolText(null, 'Full')).toBe('풀 Full · 보존 —(정책 수집 전)');
    expect(T.groupPoolText(null, '')).toBe('풀 기본 · 보존 —(정책 수집 전)');
    expect(T.groupPoolText({ name: 'X', missing: true })).toBe('풀 X · 수집한 풀 목록에 없음');
    expect(T.groupPoolText({ name: 'Full', from: 'site', retentionSec: 31536000, retentionFrom: 'pool', full: true, pct: null, errorVols: 0 })).toBe('풀 Full(법인 기본) · Volume Retention 1년 · 가득 참');
    expect(T.groupPoolText({ name: 'I', from: 'group', retentionSec: 2592000, retentionFrom: 'volumes', full: false, pct: 42.5, errorVols: 1 })).toBe('풀 I · Volume Retention 30일(볼륨 기준) · 사용 42.5% · 오류 볼륨 1');
    expect(T.groupPoolText({ name: 'I', from: 'group', retentionSec: null, retentionFrom: null, full: null, pct: null, errorVols: 0 })).toBe('풀 I · Volume Retention —');
  });
  it('겹침 줄 — 서버 groupOverlaps 한 그룹(없으면 null)', () => {
    const at = new Date(2026, 10, 1, 23, 30).getTime();
    expect(T.overlapLine({ gid: 'g', veeam: { from: at, to: at + 1, n: 2 }, bareos: null })).toBe('겹침 — Veeam 잡 2개(11-01 23:30부터 · 다음 24시간 추정)');
    expect(T.overlapLine({ gid: 'g', veeam: null, bareos: { from: at, to: at + 1, n: 1 } })).toBe('겹침 — 다른 Bareos 회차 1개(11-01 23:30부터 · 다음 24시간 추정)');
    expect(T.overlapLine({ gid: 'g', veeam: null, bareos: null })).toBe(null);
    expect(T.overlapLine(null)).toBe(null);
  });
  it('백업 대상 적용 정책 한 줄 — 그룹 · Director 스케줄 · 수동 · 모름', () => {
    const now = new Date(2026, 10, 1, 7, 0).getTime();
    const next = { at: new Date(2026, 10, 1, 21, 0).getTime(), level: 'Incremental' };
    expect(T.targetPolicyText({ verdict: 'policy', src: { kind: 'group', name: 'kr-night', text: '매일 23:30' }, next, pool: 'Full', poolFrom: 'group', retentionSec: 31536000, keep: 3, collected: true }, now))
      .toBe('그룹 kr-night · 다음 오늘 21:00 Incremental · 풀 Full(그룹) · 보존 1년 · Full 체인 3개');
    expect(T.targetPolicyText({ verdict: 'policy', src: { kind: 'director', name: 'VMwareNightly', text: '' }, next: null, pool: 'Full', poolFrom: 'job', retentionSec: null, keep: null, collected: true }, now))
      .toBe('Director 스케줄 VMwareNightly · 풀 Full');
    expect(T.targetPolicyText({ verdict: 'manual', src: null, next: null, pool: 'P', poolFrom: 'job', retentionSec: 2592000, keep: null, collected: true }, now)).toBe('예약 없음(수동만) · 풀 P · 보존 30일');
    expect(T.targetPolicyText({ verdict: 'unknown', src: null, next: null, pool: 'P', poolFrom: 'job', retentionSec: null, keep: null, collected: false }, now)).toBe('일정 모름(정책 수집 전) · 풀 P · 보존 —');
    expect(T.targetPolicyText(null)).toBe('적용 정책 모름(그룹 파일을 읽지 못함)');
    expect(T.targetPolicyText({ verdict: 'policy', src: { kind: 'group', name: 'g', text: '' }, next: null, pool: '', poolFrom: '', retentionSec: null, keep: null, collected: true, dup: 'VMwareNightly' }, now))
      .toBe('그룹 g · Director 스케줄 VMwareNightly 에도 있어 두 번 돌 수 있음');
  });
});

describe('v2.840 실행 이력 거르기 · 오류 볼륨', () => {
  it('결과 키 · 레벨 · 결과 거르기', () => {
    expect(['ok', 'warning', 'error', 'canceled', 'running', 'queued', 'waiting', 'unknown', '', 'zzz'].map(B.histResultKey))
      .toEqual(['ok', 'warning', 'error', 'canceled', 'active', 'active', 'active', 'unknown', 'unknown', 'unknown']);
    const rows = [{ level: 'F', state: 'ok' }, { level: 'I', state: 'error' }, { level: 'Incremental', state: 'running' }, { level: '', state: 'ok' }];
    expect(B.filterHistory(rows, { level: 'Full' })).toEqual([rows[0]]);
    expect(B.filterHistory(rows, { level: 'Incremental' })).toEqual([rows[1], rows[2]], '한 글자 · 이름 둘 다');
    expect(B.filterHistory(rows, { result: 'active' })).toEqual([rows[2]]);
    expect(B.filterHistory(rows, { level: 'Incremental', result: 'error' })).toEqual([rows[1]]);
    expect(B.filterHistory(rows, {}).length).toBe(4);
    expect(B.HIST_RESULT_OPTS.map(([k]) => k)).toEqual(['', 'ok', 'warning', 'error', 'canceled', 'active', 'unknown']);
  });
  it('오류 볼륨 — 종류 표지 · 열기는 조회 키 권한일 때 보존 · 풀', () => {
    expect(ERROR_KIND.volume.text).toBe('오류 볼륨');
    expect(errorOpen({ open: 'pools' }, { canBareosView: true })).toEqual({ key: 'hash', text: '보존 · 풀', hash: '#/tools/bareos-summary/pools' });
    expect(errorOpen({ open: 'pools' }, { canBareos: true, canBareosView: false })).toBe(null);
  });
});

describe('v2.840 화면 소스', () => {
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  const pools = read('./BareosPoolsTab.jsx');
  const groups = read('./BareosGroupsTab.jsx');
  const tool = read('./BareosBackupTool.jsx');
  const errs = read('./BackupSummaryErrors.jsx');
  it('보존 · 풀 탭 — 폴링 없음 · 같은 API · 즉시 조회는 관리 도구 권한 + 서버 canQuery · 표는 STable', () => {
    expect(pools).not.toMatch(/usePolling|setInterval|setTimeout\(load/);
    expect(pools).toMatch(/fetchJson\('\/tools\/bareos-summary\/pools'\)/);
    expect(pools).toMatch(/fetchJson\('\/tools\/bareos-backup\/policy\/volumes', \{ directorId: p\.directorId, pool: p\.name \}/);
    expect(pools).toMatch(/const canQuery = !!data\.canQuery && toolAllowed\('bareos-backup'\);/);
    expect(pools).not.toMatch(/<table/);
    expect(pools).not.toMatch(/'[^'\n]*\*\*[^'\n]*'/);   // BoldText 강조 표시를 화면 문구에 쓰지 않는다
  });
  it('그룹 카드 — 마지막 회차 · 적용 풀 · 겹침(Summary 권한일 때 일정 값 한 번)', () => {
    expect(groups).toMatch(/label="마지막 회차"/);
    expect(groups).toMatch(/groupPoolText\(g\.poolPolicy/);
    expect(groups).toMatch(/if \(!vc \|\| !vcKnown \|\| !toolAllowed\('backup-summary'\)\) \{ setOvl\(null\); return undefined; \}/);
    expect(groups).toMatch(/fetchJson\('\/tools\/backup-summary\/schedule'/);
  });
  it('백업 대상 적용 정책 줄 · 실행 이력 거르기 · 오류 볼륨 칩(있을 때만)', () => {
    expect(tool).toMatch(/targetPolicyText\(j\.policy\)/);
    expect(tool).toMatch(/data-hist-filters=""/);
    expect(tool).toMatch(/filterHistory\(hist, \{ level: levelF, result: resultF \}\)/);
    expect(errs).toMatch(/\(k !== 'volume' \|\| c\.volume > 0\)/);
    expect(groups).toMatch(/fin\(g\.dupVms\) && g\.dupVms > 0 && <InfoLine label="두 번 실행"/);
    expect(tool).toMatch(/k === 'groups' && toolAllowed\('bareos-summary'\)/);
    expect(tool).toMatch(/href="#\/tools\/bareos-summary\/pools"/);
  });
});
