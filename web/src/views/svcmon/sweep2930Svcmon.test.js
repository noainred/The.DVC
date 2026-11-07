// v2.930 — 최근 변경 점검 D1-08(주기·상한 숫자를 화면에 박지 않는다 — API 값) · D1-09(전체 범위 관리자 판정은 한 군데).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { periodText, detectText } from './syncLogic.js';
import { isFullScopeAdmin } from './svcmonAccess.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

describe('D1-08 periodText · detectText — 서버가 준 ms 만 쓰고 못 읽으면 숫자 없이', () => {
  it('ms → 사람이 읽는 주기', () => {
    expect(periodText(20_000)).toBe('20초');
    expect(periodText(300_000)).toBe('5분');
    expect(periodText(60_000)).toBe('1분');
    expect(periodText(90_000)).toBe('1분 30초');
    expect(periodText(7_200_000)).toBe('2시간');
    expect(periodText(5_400_000)).toBe('1시간 30분');
  });
  it('못 읽은 값은 null(0 이나 기본값을 지어내지 않는다)', () => {
    for (const v of [null, undefined, '', 'x', 0, -5, NaN, [], {}]) expect(periodText(v)).toBe(null);
  });
  it('감지 문구 — 값이 있으면 그 값, 없으면 숫자 없이', () => {
    expect(detectText({ intervalMs: 600_000, firstDelayMs: 30_000 })).toEqual({ every: '10분', empty: '포탈 기동 30초 뒤부터 10분마다 쌓입니다' });
    expect(detectText(undefined)).toEqual({ every: null, empty: '포탈 기동 뒤 주기 감지마다 쌓입니다' });
    expect(detectText({ intervalMs: 300_000 }).empty).not.toMatch(/\d/);
  });
  it('화면 파일에 서버 상수 문구가 없다', () => {
    expect(read('AlertTab.jsx')).not.toMatch(/20초 안에 6건/);
    expect(read('AlertTab.jsx')).toMatch(/d\.batch\?\.summaryFrom/);
    expect(read('SettingsSyncTab.jsx')).not.toMatch(/1분 뒤부터 5분마다|5분 감지/);
    expect(read('SettingsSyncTab.jsx')).toMatch(/detectText\(data\.detect\)/);
    expect(read('../SvcMonitor.jsx')).not.toMatch(/5분 주기/);
    expect(read('../SvcMonitor.jsx')).toMatch(/periodText\(drift\?\.intervalMs\)/);
    expect(read('OverviewDash.jsx')).not.toMatch(/최근 24시간|최근 60건/);
  });
});

describe('D1-09 isFullScopeAdmin — 서버 adminOnly + fullScopeOnly 와 같은 기준', () => {
  it('판정', () => {
    expect(isFullScopeAdmin({ role: 'admin' })).toBe(true);
    expect(isFullScopeAdmin({ role: 'admin', scope: { vcenters: [], regions: [] } })).toBe(true);
    expect(isFullScopeAdmin({ role: 'admin', scope: { vcenters: ['vc-pl'] } })).toBe(false);
    expect(isFullScopeAdmin({ role: 'admin', scope: { regions: ['EU'] } })).toBe(false);   // scopedVcenterIds 는 지역 범위도 범위다
    expect(isFullScopeAdmin({ role: 'admin', demoGuest: true })).toBe(false);              // 데모 계정은 조회·저장이 서버에서 막힌다
    expect(isFullScopeAdmin({ role: 'operator' })).toBe(false);
    expect(isFullScopeAdmin(null)).toBe(false);
  });
  it('Monitoring 화면 세 곳이 이 판정 하나를 쓴다(role 직접 비교로 저장을 열지 않는다)', () => {
    const cfg = read('../SvcMonConfig.jsx');
    expect(cfg).toMatch(/const adminFull = isFullScopeAdmin\(me\)/);
    expect(cfg).toMatch(/<SettingsSyncTab canEdit=\{adminFull\} \/>/);
    expect(cfg).toMatch(/<AlertTab isAdmin=\{adminFull\} \/>/);
    expect(read('../SvcMonitor.jsx')).toMatch(/const isAdminFull = isFullScopeAdmin\(me\)/);
    expect(read('BulkTab.jsx')).toMatch(/const isAdminUser = isFullScopeAdmin\(getCurrentUser\(\)\)/);
  });
});
