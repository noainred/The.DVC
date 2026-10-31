/**
 * v2.839 Bareos '정책 · 일정' 탭(백업 메뉴 개편 2차-a).
 *   ① 글자 · 거르기(순수) ② 서버와 같은 명령 키 · 판정 값 ③ 화면 소스 — 폴링 없음(수집 중일 때만) · 같은 API · 지금 수집은 권한 · '기본'·'—' 규칙 · Summary 빈칸
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import * as T from './bareosPolicyText.js';
import * as PP from '../../../../server/src/bareos/policyParse.js';

describe('v2.839 글자', () => {
  it('보존 · 레벨 · 7일 칸 · 다음 실행', () => {
    expect([T.retentionText(2592000), T.retentionText(31536000), T.retentionText(7776000), T.retentionText(43200), T.retentionText(null), T.retentionText(0)]).toEqual(['30일', '1년', '90일', '12시간', '—', '0']);
    expect([T.levelShort('Full'), T.levelShort('Incremental'), T.levelShort('VirtualFull'), T.levelShort('')]).toEqual(['F', 'I', 'VF', '']);
    expect(T.weekLevels({ F: 8, D: 0, I: 604, other: 0 })).toBe('F 8 · I 604');
    expect(T.weekLevels({ F: 0, D: 0, I: 0, other: 0 })).toBe('F 0');
    expect(T.weekLevels({ F: 2, D: 180, I: 416, other: 4 })).toBe('F 2 · D 180 · I 416 · 기타 4');
    const now = new Date(2026, 10, 1, 7, 0).getTime();
    expect(T.nextRunText({ at: new Date(2026, 10, 1, 21, 0).getTime(), level: 'Incremental' }, now)).toBe('오늘 21:00 Incremental');
    expect(T.nextRunText({ at: new Date(2026, 10, 3, 1, 5).getTime(), level: '' }, now)).toBe('11-03 01:05');
    expect(T.nextRunText(null, now)).toBe('—');
  });
  it('JobDefs 빈 칸은 기본 · 풀 · 보존 칸', () => {
    expect([T.defText(''), T.defText(null), T.defText(undefined), T.defText('Full'), T.defText(0)]).toEqual(['기본', '기본', '기본', 'Full', '0']);
    expect(T.poolText({ fullPool: 'Full', incPool: 'Incremental', pool: 'X' })).toBe('Full / Incremental');
    expect(T.poolText({ fullPool: '', incPool: 'I', pool: 'X' })).toBe('X / I');
    expect(T.poolText({ pool: 'VMware-oc2' })).toBe('VMware-oc2');
    expect(T.poolText({})).toBe('—');
    expect(T.keepText({ keep: 4, retentionSec: 7776000 })).toBe('Full 체인 4개(포탈) · Volume Retention 90일');
    expect(T.keepText({ keep: null, retentionSec: null })).toBe('—');
    expect(T.srcText(null)).toBe('없음(수동)');
    expect(T.srcText({ kind: 'group', name: 'db-nightly' })).toBe('그룹 db-nightly');
    expect(T.srcText({ kind: 'director', name: 'AI-Daily' })).toBe('Director AI-Daily');
  });
  it('Director 결과 · 거르기', () => {
    expect(T.directorResult({ at: null })).toBe(null);
    const r = T.directorResult({ at: 1, cmds: { scheduler: { ok: true }, pools: { ok: true }, volumes: { ok: true }, schedules: { ok: false, code: 'denied' }, jobdefs: { ok: false, code: 'denied' }, filesets: { ok: null, code: 'off' } } });
    expect(r).toEqual({ ok: 3, total: 5, bad: ['Run 줄 권한 없음', 'JobDefs 권한 없음'], denied: true });
    expect(T.directorResult({ at: 1, cmds: { scheduler: { ok: false, code: 'timeout' } } }).denied).toBe(false);
    const rows = [{ src: 'director', jobs: 0 }, { src: 'director', jobs: 3 }, { src: 'group', jobs: 5 }];
    expect([T.filterSchedules(rows).length, T.filterSchedules(rows, 'director').length, T.filterSchedules(rows, 'group').length, T.filterSchedules(rows, 'unused').length]).toEqual([3, 2, 1, 1]);
    const vms = [{ verdict: 'manual', os: 'linux' }, { verdict: 'policy', os: 'windows' }, { verdict: 'manual', os: 'windows' }];
    expect([T.filterVms(vms).length, T.filterVms(vms, { verdict: 'manual' }).length, T.filterVms(vms, { verdict: 'manual', os: 'windows' }).length]).toEqual([3, 2, 1]);
  });
});

describe('v2.839 서버와 같은 값', () => {
  it('명령 키 · 판정 값', () => {
    expect(T.POLICY_CMD_KEYS).toEqual([...PP.POLICY_KEYS]);
    expect([...T.VERDICT_KEYS].sort()).toEqual(['manual', 'mismatch', 'policy', 'unknown', 'unregistered']);
  });
});

describe('v2.839 화면 소스', () => {
  const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
  const tab = read('./BareosPolicyTab.jsx'); const sum = read('./BareosSummaryTool.jsx'); const summary = read('./BackupSummaryTool.jsx'); const cs = read('./BackupSummaryCapSched.jsx');
  const settings = read('./BareosSettings.jsx'); const vt = read('./backupViewText.js');
  it('라우팅 — 같은 조회 전용 키 아래 하위 탭 · 통합 현황은 그대로', () => {
    expect(sum).toMatch(/useHashTab\(\{ base: \['tools', 'bareos-summary'\], valid: \['overview', 'policy'\], fallback: 'overview' \}\)/);
    expect(sum).toMatch(/return tab === 'policy' \? <BareosPolicyTab \/> : <BareosSummaryView \/>;/);
  });
  it('폴링하지 않는다 — 수집 중일 때만 5초 뒤 다시 · 늦게 온 응답은 버린다 · 같은 API', () => {
    expect(tab).not.toMatch(/usePolling|setInterval/);
    expect(tab).toMatch(/if \(!busy\) return undefined;\n\s*const t = setTimeout\(load, 5000\);/);
    expect(tab).toMatch(/fetchJson\('\/tools\/bareos-summary\/policy'\)/);
    expect(tab).toMatch(/postJson\('\/tools\/bareos-backup\/policy\/collect'/);
    expect(tab).toMatch(/if \(my === gen\.current\) setData\(r\);/);
    expect(tab).toMatch(/const canCollect = !!data\?\.canCollect && toolAllowed\('bareos-backup'\);/);
  });
  it('표는 STable · 못 읽은 값은 — · 권한 없음 안내', () => {
    expect((tab.match(/<STable /g) || []).length).toBe(5);
    expect(tab).toMatch(/Profile 의 Command ACL 에 show 가 없습니다/);
    expect(tab).not.toMatch(/`[^`]*\*\*/);
  });
  it('Summary 빈칸을 채웠다 — (2차) 문구가 남지 않는다 · Detail 다음 예정은 Director 스케줄도', () => {
    for (const s of [summary, cs, read('./BackupSummaryTree.jsx')]) expect(s).not.toMatch(/2차 수집 뒤|\(2차\)/);
    expect(summary).toMatch(/const bp = data\.bareosPolicy \|\| null;/);
    expect(vt).toMatch(/vm\.nx\.s \? `Bareos Director 스케줄 ‘\$\{vm\.nx\.s\}’ 다음 실행`/);
  });
  it('설정 — 정책 수집(켜기 · 시각 · 선택 명령 · 수집할 Director)', () => {
    expect(settings).toMatch(/data-bareos-policy-settings=""/);
    expect(settings).toMatch(/set\(\{ off: \[\.\.\.n\] \}\)/);
  });
});
