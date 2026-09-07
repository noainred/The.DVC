/**
 * remoteCommand 회귀 테스트(v2.416) — 원격 명령(RMA) 화면의 판정·문구.
 */
import { describe, it, expect } from 'vitest';
import { ago, durationText, uptimeText, agentStatus, resultSummary, defaultArgs, argsIssue, groupCatalog, modeLabel, targetHint, statusTone, statusLabel } from './remoteCommand.js';

describe('agentStatus', () => {
  it('미배포(하트비트 없음)·오프라인·온라인을 구분한다', () => {
    expect(agentStatus({ notDeployed: true })).toBe('none');
    expect(agentStatus({ instances: [] })).toBe('none');
    expect(agentStatus({ instances: [{ online: false }] })).toBe('offline');
    expect(agentStatus({ instances: [{ online: false }, { online: true }] })).toBe('online');
  });
});

describe('resultSummary', () => {
  it('거부·타임아웃·성공·절단·실패 순으로 판정한다', () => {
    expect(resultSummary({ rejected: true, reason: '서명 불일치' })).toEqual({ tone: 'bad', text: '거부: 서명 불일치' });
    expect(resultSummary({ timedOut: true, durationMs: 30_000 }).tone).toBe('bad');
    expect(resultSummary({ ok: true, durationMs: 120 }).text).toContain('성공');
    expect(resultSummary({ ok: true, clipped: true }).text).toContain('앞부분만');
    expect(resultSummary({ ok: false, truncated: true }).tone).toBe('warn');
    expect(resultSummary({ ok: false, exitCode: 2 }).text).toBe('실패 (exit 2)');
    expect(resultSummary(null).tone).toBe('muted');
  });
});

describe('argsIssue / defaultArgs', () => {
  const preset = { params: [{ name: 'host', label: '대상', type: 'host', required: true }, { name: 'count', label: '횟수', type: 'int', min: 1, max: 20, def: 4 }] };
  it('기본값을 채우고 필수 누락·범위·선행 - 를 잡는다', () => {
    expect(defaultArgs(preset)).toEqual({ count: '4' });
    expect(argsIssue(preset, {})).toMatch(/대상/);
    expect(argsIssue(preset, { host: '10.0.0.1' })).toBeNull();
    expect(argsIssue(preset, { host: '10.0.0.1', count: '0' })).toMatch(/1 이상/);
    expect(argsIssue(preset, { host: '10.0.0.1', count: '21' })).toMatch(/20 이하/);
    expect(argsIssue(preset, { host: '10.0.0.1', count: 'x' })).toMatch(/정수/);
    expect(argsIssue(preset, { host: '-h' })).toMatch(/-로 시작/);
  });
  it('자유 명령(shell)은 형식 검사를 하지 않는다(엣지 정책이 판단)', () => {
    expect(argsIssue({ params: [{ name: 'command', label: '명령', type: 'shell', required: true }] }, { command: '-la' })).toBeNull();
  });
});

describe('targetHint', () => {
  const modes = [];
  it('인스턴스 지정·온라인 없음·모드별 문구', () => {
    const g = { mode: 'active-active', instances: [{ instance: 'a', online: true }, { instance: 'b', online: false }] };
    expect(targetHint(g, 'b', modes)).toContain("'b'");
    expect(targetHint({ ...g, instances: [] }, '', modes)).toContain('온라인 인스턴스 없음');
    expect(targetHint(g, '', modes)).toContain('Active-Active');
    expect(targetHint({ ...g, mode: 'balance' }, '', modes)).toContain('부하 분산');
    expect(targetHint({ ...g, mode: 'active-backup', activePrimary: 'a' }, '', modes)).toContain("'a'");
  });
});

describe('포맷 헬퍼', () => {
  it('ago / durationText / uptimeText / groupCatalog / modeLabel', () => {
    const now = 1_000_000_000;
    expect(ago(null)).toBe('—');
    expect(ago(now - 2000, now)).toBe('방금');
    expect(ago(now - 90_000, now)).toBe('2분 전');
    expect(durationText(null)).toBe('—');
    expect(durationText(250)).toBe('250ms');
    expect(durationText(1500)).toBe('1.5초');
    expect(uptimeText(90_000)).toBe('1일 1시간');
    expect(groupCatalog([{ id: 'a', group: 'X' }, { id: 'b', group: 'Y' }, { id: 'c', group: 'X' }])).toEqual([{ group: 'X', items: [{ id: 'a', group: 'X' }, { id: 'c', group: 'X' }] }, { group: 'Y', items: [{ id: 'b', group: 'Y' }] }]);
    expect(modeLabel('balance', [{ id: 'balance', label: '부하 분산' }])).toBe('부하 분산');
    expect(modeLabel('', [])).toBe('전역 기본');
  });
});

describe('v2.418 점검 상태 헬퍼', () => {
  it('statusTone / statusLabel', () => {
    const T = { ok: 'g', warn: 'y', bad: 'r', muted: 'm' };
    expect(statusTone('ok', T)).toBe('g'); expect(statusTone('warn', T)).toBe('y'); expect(statusTone('bad', T)).toBe('r'); expect(statusTone('unknown', T)).toBe('m');
    expect(statusLabel('ok')).toBe('정상'); expect(statusLabel('bad')).toBe('실패'); expect(statusLabel(undefined)).toBe('—');
  });
});
