/**
 * 전체 소스 점검 6회차(백업 화면) 확정분.
 *  W-1 리전이 바뀌면 '백업 안 된 VM 찾기' 의 고른 법인을 비운다(서버가 법인 ∧ 리전으로 걸러 '0대' 초록이 나오던 것)
 *  W-2 리전 보기에서 메일 알림 패널은 '지금 찾기 조건과 같음' 이라 하지 않고 '알림은 전 법인' 을 밝힌다
 *  W-3 리전을 바꾸면 에러 로그 서랍을 닫는다
 *  W-4 재해 복구 첫 진입의 빈 기준 시각은 빨간 오류가 아니라 안내
 *  W-5 Director 자동 설정의 풀 값 — 미리 보기 = 보낼 값 · 서버 범위 밖이면 OTP 전에 잠근다
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import BackupSummaryAlert from './BackupSummaryAlert.jsx';
import { dirPoolsOf, dirPoolsIssue } from './BareosSettings.jsx';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const rd = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');
const ALERT = { canEdit: true, settings: { enabled: true, time: '08:30', savedAt: 1, q: { n: 7, unit: 'd', src: 'all', excludeNone: true, onlyOn: true, includeNever: true, vc: '' } }, status: null, mail: { enabled: true, kindEnabled: true } };
const FINDER = { n: 7, unit: 'd', src: 'all', excludeNone: true, onlyOn: true, includeNever: true, vc: '' };

describe('W-2 메일 알림 패널 — 리전 보기', () => {
  it('리전이 없으면 같은 조건은 같음', () => {
    const html = renderToStaticMarkup(<BackupSummaryAlert alert={ALERT} finder={FINDER} vcName={(x) => x} />);
    expect(html).toContain('지금 찾기 조건과 같음');
    expect(html).not.toContain('리전');
  });
  it('리전 보기면 같음이라 하지 않고 알림은 전 법인임을 밝힌다', () => {
    const html = renderToStaticMarkup(<BackupSummaryAlert alert={ALERT} finder={FINDER} vcName={(x) => x} region="유럽" />);
    expect(html).not.toContain('지금 찾기 조건과 같음');
    expect(html).toContain('지금 찾기 조건과 다름(리전)');
    expect(html).toContain('리전 유럽 보기 중');
    expect(html).toContain('알림 메일은 전 법인에서 찾습니다');
  });
});

describe('W-5 Director 자동 설정 풀 값', () => {
  it('보낼 값과 미리 보기가 같은 하나 — 빈 칸을 기본값으로 바꾸지 않는다', () => {
    expect(dirPoolsOf({ fullDays: '', incrDays: '30', maxVolumeGB: '50' })).toEqual({ fullDays: 0, incrDays: 30, maxVolumeGB: 50 });
  });
  it('서버(autoSetup.normVmwareExtras)와 같은 범위 — 빈 칸 · 0 · 상한 초과는 잠근다', () => {
    expect(dirPoolsIssue({ fullDays: '90', incrDays: '30', maxVolumeGB: '50' })).toBe('');
    expect(dirPoolsIssue({ fullDays: '', incrDays: '30', maxVolumeGB: '50' })).toMatch(/1~3650/);
    expect(dirPoolsIssue({ fullDays: '3651', incrDays: '30', maxVolumeGB: '50' })).toMatch(/1~3650/);
    expect(dirPoolsIssue({ fullDays: '90', incrDays: '0', maxVolumeGB: '50' })).toMatch(/1~3650/);
    expect(dirPoolsIssue({ fullDays: '90', incrDays: '30', maxVolumeGB: '2048' })).toMatch(/1~1024/);
  });
  it('소스 — body · 미리 보기 둘 다 dirPoolsOf · 범위 밖이면 dReady 가 잠긴다', () => {
    const src = rd('BareosSettings.jsx');
    expect(src).toMatch(/\.\.\.\(d\.usePools \? \{ pools: dirPoolsOf\(d\) \} : \{\}\)/);
    expect(src).toMatch(/pools: d\.usePools \? dirPoolsOf\(d\) : null/);
    expect(src).toMatch(/const dReady = [^\n]*!poolsBad/);
    expect(src).not.toMatch(/Number\(d\.fullDays\) \|\| 90/);
  });
});

describe('W-1 · W-3 · W-4 소스', () => {
  it('W-1 리전이 바뀌면 고른 법인을 비운다', () => {
    const src = rd('BackupSummaryStale.jsx');
    expect(src).toMatch(/if \(regionMoved\) setO\(\(cur\) => \(cur\.vc \? \{ \.\.\.cur, vc: '' \} : cur\)\);/);
    expect(src).toMatch(/region=\{scope\?\.region \|\| ''\}/);
  });
  it('W-3 리전을 바꾸면 서랍을 닫는다', () => {
    expect(rd('BackupSummaryErrors.jsx')).toMatch(/setDrawer\(null\); \}, \[kind, src, days, view, region\]\)/);
  });
  it('W-4 빈 기준 시각은 안내(info) · 읽지 못한 글자만 오류(bad)', () => {
    const src = rd('BareosDisaster.jsx');
    expect(src).toMatch(/beforeMs === null && \(String\(beforeText \|\| ''\)\.trim\(\)\n\s*\? <Note tone="bad">/);
    expect(src).toMatch(/: <Note tone="info">기준 시각을 고르세요/);
  });
});
