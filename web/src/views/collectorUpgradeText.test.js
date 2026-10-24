import { describe, it, expect } from 'vitest';
import { upgradeCell, autoPushLine } from './collectorUpgradeText.js';

const T = new Date(2026, 9, 24, 13, 5, 0).getTime();

describe('v2.775 수집 서버 업그레이드 결과 문구', () => {
  it('실패는 시각·자동 여부와 서버가 준 이유를 함께 — 이유가 없으면 그 사실을 말한다', () => {
    expect(upgradeCell({ at: T, ok: false, auto: true, reason: 'HTTP 403 · 토큰(COLLECTOR_TOKEN) 불일치' }))
      .toEqual({ text: '업그레이드 실패 · 10-24 13:05 (자동)', reason: 'HTTP 403 · 토큰(COLLECTOR_TOKEN) 불일치', tone: 'bad' });
    expect(upgradeCell({ at: T, ok: false }).reason).toBe('사유를 받지 못했습니다');
  });
  it('성공은 판·시각', () => {
    expect(upgradeCell({ at: T, ok: true, version: '2.775.0' })).toEqual({ text: '업그레이드 v2.775.0 적용 · 10-24 13:05', reason: '', tone: 'ok' });
    expect(upgradeCell(null)).toBeNull();
  });
  it('자동 push 요약 — 생략(번들 재확인 실패)·일부 실패·전부 성공·대상 없음', () => {
    expect(autoPushLine({ at: T, version: '2.775.0', total: 0, ok: 0, skipped: '번들을 다시 확인하지 못해 수집 서버에 보내지 않았습니다: 서명 없음' }))
      .toEqual({ text: '마지막 자동 업그레이드(10-24 13:05 · v2.775.0): 수집 서버에 보내지 않았습니다 — 번들을 다시 확인하지 못해 수집 서버에 보내지 않았습니다: 서명 없음', tone: 'bad' });
    expect(autoPushLine({ at: T, total: 5, ok: 3 })).toEqual({ text: '마지막 자동 업그레이드(10-24 13:05): 수집 서버 3/5 성공 — 실패한 서버는 표의 버전 칸에 이유가 있습니다.', tone: 'warn' });
    expect(autoPushLine({ at: T, total: 2, ok: 0 }).tone).toBe('bad');
    expect(autoPushLine({ at: T, total: 2, ok: 2 }).tone).toBe('ok');
    expect(autoPushLine({ at: T, total: 0, ok: 0 })).toBeNull();
    expect(autoPushLine(null)).toBeNull();
  });
  it('문구에 백틱 없음', () => {
    expect(autoPushLine({ at: T, total: 5, ok: 3 }).text).not.toContain('`');
    expect(upgradeCell({ at: T, ok: false, reason: 'x' }).text).not.toContain('`');
  });
});
