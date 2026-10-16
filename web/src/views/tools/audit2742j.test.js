/**
 * v2.742 수정 그룹 GI1 — SAN 스위치 화면 문구(웹).
 *  DEV-06 처리량 미계산 사유를 사유별로 말한다(서버 sanswitch/rates.js reason 과 1:1) — 구버전 엣지(사유 없음)는 예전 문장
 *  DEV-02 팬·PSU 표기: 빈 슬롯은 장착 수와 따로 · 개수만 알면 'N개'
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { rateNotReadyText, RATE_REASON_TEXT, fruText } from './sanSwitchPorts.js';

describe('DEV-06 rateNotReadyText', () => {
  it('계산했으면 빈 문자열', () => {
    expect(rateNotReadyText({ rateReady: true })).toBe('');
    expect(rateNotReadyText(null)).toBe('');
  });
  it('첫 수집 · 사유 없음(구버전) 은 예전 문장', () => {
    expect(rateNotReadyText({ rateReady: false, rateReason: 'first' })).toBe(RATE_REASON_TEXT.first);
    expect(rateNotReadyText({ rateReady: false })).toBe(RATE_REASON_TEXT.first);
  });
  it("간격이 상한을 넘으면 '두 번째 수집부터' 라고 말하지 않고 간격·상한을 적는다", () => {
    const t = rateNotReadyText({ rateReady: false, rateReason: 'gap-too-long', rateGapSec: 3 * 3600 + 120, rateMaxGapSec: 2 * 3600 });
    expect(t).not.toMatch(/두 번째 수집부터/);
    expect(t).toMatch(/상한/);
    expect(t).toMatch(/간격 182분 · 상한 120분/);
    // 숫자를 모르면 괄호를 붙이지 않는다(지어내지 않는다)
    expect(rateNotReadyText({ rateReady: false, rateReason: 'gap-too-long' })).toBe(RATE_REASON_TEXT['gap-too-long']);
  });
  it('너무 짧은 간격', () => {
    expect(rateNotReadyText({ rateReady: false, rateReason: 'gap-too-short' })).toBe(RATE_REASON_TEXT['gap-too-short']);
  });
  it('사유 키는 서버 rates.js 의 reason 과 1:1', () => {
    const src = fs.readFileSync(new URL('../../../../server/src/sanswitch/rates.js', import.meta.url), 'utf8');
    const keys = [...new Set([...src.matchAll(/'(first|gap-too-short|gap-too-long)'/g)].map((m) => m[1]))].sort();
    expect(Object.keys(RATE_REASON_TEXT).sort()).toEqual(keys);
  });
  it('문구에 백틱·별표 강조 없음', () => {
    for (const v of Object.values(RATE_REASON_TEXT)) { expect(v).not.toMatch(/`/); expect(v).not.toMatch(/\*\*/); }
  });
});

describe('DEV-02 fruText', () => {
  it('빈 슬롯은 장착 수와 따로', () => {
    expect(fruText({ ok: 1, total: 1, absent: 1 })).toBe('1/1 정상 · 빈 슬롯 1');
    expect(fruText({ ok: 2, total: 2 })).toBe('2/2 정상');
    expect(fruText({ ok: null, total: 4 })).toBe('4개');
    expect(fruText(null)).toBe('');
  });
  it('SanSwitchTool 이 팬·PSU 를 fruText 로 그린다(인라인 사본 금지)', () => {
    const src = fs.readFileSync(new URL('./SanSwitchTool.jsx', import.meta.url), 'utf8');
    expect(src).toMatch(/\['팬', fruText\(h\.fans\)\]/);
    expect(src).toMatch(/\['전원공급장치', fruText\(h\.psus\)\]/);
    expect(src).toMatch(/rateNotReadyText\(d\.extra\)/);
    expect(src).not.toMatch(/처리량은 두 번째 수집부터 표시됩니다/);
  });
});
