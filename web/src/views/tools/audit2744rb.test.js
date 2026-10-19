/**
 * v2.744 회귀 검토 RB(웹) — GB-R1: 명목(nominal) 기준 포트의 100% 초과를 '데이터율을 크게 넘어 비움(대표값도 비움 · 알림 초과)' 으로
 *   말하지 않는다. 서버 parse/fcRate.js fcRepresentative·hbaBasis.summarizeHbaBasis 와 같은 규칙(데이터율 기준 포트만 blanked).
 */
import { describe, it, expect } from 'vitest';
import { hbaBasisFootnote, detailNotes } from './bmUsageText.js';

describe('GB-R1 detailNotes — 명목 초과와 데이터율 크게 초과를 나눠 말한다', () => {
  it('명목 기준 100% 초과 포트는 대표값을 비웠다·알림 초과라고 말하지 않는다', () => {
    const notes = detailNotes({ fc: [
      { host: 'host1', bps: 1.3e9, pct: null, pctBasis: 'nominal', pctOver: true, pctRaw: 104 },
      { host: 'host2', bps: 8e7, pct: 5, pctBasis: 'fc-data-rate' },
    ] });
    expect(notes.some((x) => x.includes('크게 나온 포트'))).toBe(false);
    const t = notes.find((x) => x.includes('명목 속도(Gbit)를 넘는'));
    expect(t).toBeTruthy();
    expect(t).toContain('속도 보고를 확인');
    expect(t).toContain('초과로 보지 않습니다');
  });

  it('데이터율 기준 크게 초과는 예전 문구 그대로(RECENT-02 설계 유지)', () => {
    const notes = detailNotes({ fc: [{ host: 'host1', bps: 2e9, pct: null, pctBasis: 'fc-data-rate', pctOver: true, pctRaw: 125 }] });
    expect(notes.some((x) => x.includes('크게 나온 포트 1개') && x.includes('초과로 봅니다'))).toBe(true);
    expect(notes.some((x) => x.includes('명목 속도(Gbit)를 넘는'))).toBe(false);
  });
});

describe('GB-R1 hbaBasisFootnote — nominalOver 를 blanked 와 따로 말한다', () => {
  it('nominalOver 만 있으면 \'크게 넘어 비운\' 문구를 내지 않는다', () => {
    const t = hbaBasisFootnote([{ key: 'a', hbaBasis: { ports: 2, dataRate: 1, nominal: 1, noSpeed: 0, clamped: 0, blanked: 0, nominalOver: 1, unread: 0, clampMaxPct: 110 } }]);
    expect(t).not.toContain('크게 넘어');
    expect(t).toContain('명목 속도**를 넘어 사용률을 비운 포트 1개');
    expect(t).toContain('알림은 초과로 보지 않습니다');
  });
  it('구버전 근거(nominalOver 필드 없음)도 그대로 읽는다', () => {
    const t = hbaBasisFootnote([{ key: 'a', hbaBasis: { ports: 1, dataRate: 1, blanked: 1 } }]);
    expect(t).toContain('크게 넘어 사용률을 **비운** 포트 1개');
    expect(t).not.toContain('명목 속도**를 넘어');
  });
});
