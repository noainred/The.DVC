// v2.736.2 — 업그레이드 화면 '자동 업그레이드 동작' 칸 문구(사용자 신고: 자동 업그레이드가 안 되는데 이유가 화면에 없었다).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTO_TEXT, STATE_TEXT, TICK_TEXT, autoSummary, autoApplyRowText, noTickText, resultSummary, actionMsg, intervalText, inText, restoredNote,
} from './upgradeAutoText.js';
import { NO_RECORD_DETAIL } from './upgradeSignatureText.js';

const NOW = Date.UTC(2026, 9, 15, 2, 30, 0);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = fs.readFileSync(path.resolve(HERE, '../../../server/src/upgrade/autoState.js'), 'utf8');
const listOf = (name) => {
  const m = new RegExp(`export const ${name} = Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`).exec(serverSrc);
  if (!m) throw new Error(`${name} 를 서버 소스에서 찾지 못했습니다`);
  const body = m[1].split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n'); // 줄 주석 안의 따옴표 낱말을 코드로 읽지 않는다
  return [...body.matchAll(/'([^']+)'/g)].map((x) => x[1]);
};

describe('서버 코드 ↔ 화면 문구 1:1', () => {
  it('AUTO_CODES · AUTO_STATES · TICK_OUTCOMES 가 웹 표와 같다', () => {
    expect(Object.keys(AUTO_TEXT).sort()).toEqual(listOf('AUTO_CODES').sort());
    expect(Object.keys(STATE_TEXT).sort()).toEqual(listOf('AUTO_STATES').sort());
    expect(Object.keys(TICK_TEXT).sort()).toEqual(listOf('TICK_OUTCOMES').sort());
  });
  it('문구에 백틱·별표 강조가 없다(BoldText 가 글자로 그린다)', () => {
    const all = JSON.stringify({ AUTO_TEXT, STATE_TEXT, TICK_TEXT, NO_RECORD_DETAIL });
    expect(all.includes('`')).toBe(false);
    expect(all.includes('**')).toBe(false);
  });
});

describe('자동 업그레이드 동작 요약', () => {
  it('서버가 auto 를 보내지 않으면(구버전) 그리지 않는다', () => {
    expect(autoSummary({ enabled: true })).toBe(null);
    expect(autoSummary({ auto: { state: 'zzz' } })).toBe(null);
  });
  it('주기 0 — 자동 확인을 하지 않는다고 말하고 조치를 준다', () => {
    const s = { enabled: true, autoApply: true, auto: { state: 'manual', intervalMs: 0, nextCheckAt: null, issues: [{ code: 'no-interval' }] } };
    const a = autoSummary(s, NOW);
    expect(a.label).toBe(STATE_TEXT.manual.label);
    expect(a.next).toMatch(/확인 주기 0분/);
    expect(a.lines[0].title).toMatch(/자동 적용도 일어나지 않습니다/);
    expect(a.lines[0].fix).toMatch(/새 버전 확인/);
    expect(autoApplyRowText(s)).toMatch(/예 · 확인 주기 0분\(끔\)/);
    expect(noTickText(s)).toMatch(/자동 확인을 하지 않는 설정/);
  });
  it('동작 중 — 다음 확인 시각·주기 · 마지막 자동 확인 결과', () => {
    const s = {
      enabled: true, autoApply: true,
      auto: { state: 'on', intervalMs: 3_600_000, nextCheckAt: NOW + 25 * 60_000, issues: [] },
      lastTick: { at: NOW - 35 * 60_000, outcome: 'up-to-date', latest: '2.736.1' },
    };
    const a = autoSummary(s, NOW);
    expect(a.tone).toBe('ok');
    expect(a.next).toMatch(/25분 뒤/); expect(a.next).toMatch(/1시간 주기/);
    expect(a.tick).toMatch(/최신 — 받을 새 버전이 없었습니다 \(최신 v2\.736\.1\)/);
    expect(a.tickTone).toBe('ok');
    expect(autoApplyRowText(s)).toBe('예 · 1시간 주기');
  });
  it('동작 중이어도 마지막 확인·적용이 실패했으면 경고 톤 + 사유', () => {
    const s = { enabled: true, auto: { state: 'on', intervalMs: 3_600_000, nextCheckAt: NOW + 60_000, issues: [{ code: 'apply-failed', reason: '서명 검증 실패 — manifest 없음', at: NOW - 60_000 }] },
      lastTick: { at: NOW - 60_000, outcome: 'apply-failed', latest: '2.736.1', reason: '서명 검증 실패 — manifest 없음', restored: true } };
    const a = autoSummary(s, NOW);
    expect(a.tone).toBe('warn');
    expect(a.lines[0].reason).toMatch(/manifest 없음/);
    expect(a.tick).toMatch(/재시작 전 기록/);
    expect(a.tickTone).toBe('bad');
  });
  it('주기는 있는데 무장 시각을 모르면 시각을 지어내지 않는다 · 확인 중이면 그렇게 말한다', () => {
    expect(autoSummary({ enabled: true, auto: { state: 'on', intervalMs: 3_600_000, nextCheckAt: null, issues: [] } }, NOW).next).toMatch(/알 수 없습니다/);
    expect(autoSummary({ enabled: true, ticking: true, auto: { state: 'on', intervalMs: 3_600_000, nextCheckAt: NOW + 1, issues: [] } }, NOW).next).toBe('지금 확인 중입니다');
  });
  it('꺼짐', () => {
    const s = { enabled: false, autoApply: true, auto: { state: 'off', intervalMs: 0, nextCheckAt: null, issues: [{ code: 'disabled' }] } };
    expect(autoSummary(s, NOW).next).toMatch(/꺼짐/);
    expect(autoApplyRowText(s)).toMatch(/자동 업그레이드 꺼짐/);
  });
});

describe('버튼 결과 문구 — 확인 성공을 실패로 말하지 않는다', () => {
  it("'새 버전 확인' 응답에는 ok 가 없다 — 새 버전·최신·원격 실패를 나눠 말한다", () => {
    expect(actionMsg('check', { at: NOW, remote: { ok: true, available: true, latest: '2.736.1' } })).toMatchObject({ label: '새 버전 확인', ok: true });
    expect(actionMsg('check', { at: NOW, remote: { ok: true, available: true, latest: '2.736.1' } }).text).toMatch(/새 버전 v2\.736\.1/);
    expect(actionMsg('check', { at: NOW, remote: { ok: true, available: false, latest: '2.736.1' } })).toMatchObject({ ok: true, text: '최신입니다 (v2.736.1)' });
    expect(actionMsg('check', { at: NOW, remote: { ok: false, error: '원격 소스(versions.json) 접속 실패: ENOTFOUND' } })).toMatchObject({ ok: false });
    expect(actionMsg('check', { at: NOW, remote: { ok: false, error: '원격 소스(versions.json) 접속 실패: ENOTFOUND' } }).text).toMatch(/ENOTFOUND/);
  });
  it('적용·저장·재시작 결과', () => {
    expect(actionMsg('apply', { ok: true, version: '2.736.1', from: '2.736.0', restarting: true }).text).toBe('성공 — v2.736.0 → v2.736.1 · 재시작 중');
    expect(actionMsg('apply', { ok: false, reason: '서명 검증 실패' })).toMatchObject({ ok: false, text: '서명 검증 실패' });
    expect(actionMsg('save', { ok: true, note: '토큰을 폐기했습니다' })).toMatchObject({ ok: true, warn: true });
    expect(actionMsg('restart', { ok: true, restarting: true }).text).toBe('성공 · 재시작 중');
  });
});

describe('적용 결과 요약 · 주기·남은 시간 문구', () => {
  it('성공·이미 최신·실패 · 재시작 전 기록 표지', () => {
    expect(resultSummary({ at: NOW, ok: true, from: '2.736.0', version: '2.736.1', restarting: true, trigger: 'auto', restored: true }).text)
      .toMatch(/성공 — v2\.736\.0 → v2\.736\.1 · 재시작 · 자동\(백그라운드\).*재시작 전 기록/);
    expect(resultSummary({ at: NOW, ok: false, upToDate: true }).tone).toBe('muted');
    expect(resultSummary({ at: NOW, ok: false, code: 'no-install-dir', reason: '설치 경로(installDir)가 설정되지 않아 적용할 수 없습니다.' }).tone).toBe('bad');
    expect(resultSummary(null)).toBe(null);
    expect(restoredNote({ restored: true })).toBe('재시작 전 기록');
    expect(restoredNote({})).toBe(null);
  });
  it('주기·남은 시간', () => {
    expect(intervalText(0)).toBe(null);
    expect(intervalText(30 * 60_000)).toBe('30분');
    expect(intervalText(90 * 60_000)).toBe('1시간 30분');
    expect(intervalText(7 * 86_400_000)).toBe('7일');
    expect(inText(NOW + 30_000, NOW)).toBe('곧');
    expect(inText(NOW + 65 * 60_000, NOW)).toBe('1시간 5분 뒤');
    expect(inText(null, NOW)).toBe(null);
  });
  it('서명 칸의 기록 없음 안내가 원인(시도하지 않음)을 먼저 말한다', () => {
    expect(NO_RECORD_DETAIL).toMatch(/^서명 확인은 업그레이드를 시도할 때 합니다/);
    expect(NO_RECORD_DETAIL).toMatch(/자동 업그레이드 동작/);
  });
});
