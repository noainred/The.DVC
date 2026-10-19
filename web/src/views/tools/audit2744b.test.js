/**
 * v2.744 감사 GB 회귀(웹) — 베어메탈 사용률 화면의 HBA 문구.
 *
 *  LEFT-08 ② HBA 사용률(%)의 분모 근거(FC 표준 데이터율 · 명목 분모 포트 · 소폭 초과를 100% 로 표시한 포트 · 크게 넘어 비운 포트)를
 *            표 아래 각주 **한 번**으로 말한다(v2.509 — 행마다 반복하지 않는다). 근거가 없으면 문구를 만들지 않는다.
 *  RECENT-02 상세 문구가 '조금 넘어 100% 로 표시' 와 '크게 넘어 비움' 을 나눠 말한다(예전에는 둘 다 '비웠다' 고 했다).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hbaBasisFootnote, detailNotes } from './bmUsageText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('LEFT-08 ② hbaBasisFootnote', () => {
  it('근거가 없으면 빈 문자열(지어내지 않는다)', () => {
    expect(hbaBasisFootnote([])).toBe('');
    expect(hbaBasisFootnote([{ key: 'a' }, { key: 'b', hbaBasis: null }, { key: 'c', hbaBasis: { ports: 0 } }])).toBe('');
  });

  it('보이는 행의 포트 수를 합산해 분모 기준·명목 분모·소폭 초과·비움을 말한다', () => {
    const rows = [
      { key: 'a', hbaBasis: { ports: 4, dataRate: 3, nominal: 1, noSpeed: 0, clamped: 1, blanked: 0, unread: 0, clampMaxPct: 110 } },
      { key: 'b', hbaBasis: { ports: 2, dataRate: 2, nominal: 0, noSpeed: 0, clamped: 0, blanked: 1, unread: 1, clampMaxPct: 110 } },
      { key: 'c' },
    ];
    const t = hbaBasisFootnote(rows);
    expect(t).toContain('FC 표준 데이터율');
    expect(t).toContain('서버 2대');
    expect(t).toContain('포트 6개 중 데이터율 기준 5개');
    expect(t).toContain('명목 속도');
    expect(t).toContain('포트 1개');
    expect(t).toContain('110% 까지');
    expect(t).toContain('100% 로 표시한');
    expect(t).toContain('비운');
    expect(t).toContain("'-1' 표지");
  });

  it('해당 종류가 없으면 그 조각은 말하지 않는다(모두 데이터율 기준 · 초과 없음)', () => {
    const t = hbaBasisFootnote([{ key: 'a', hbaBasis: { ports: 2, dataRate: 2, nominal: 0, noSpeed: 0, clamped: 0, blanked: 0, unread: 0 } }]);
    expect(t).toContain('FC 표준 데이터율');
    expect(t).not.toContain('명목 속도');
    expect(t).not.toContain('100% 로 표시한');
    expect(t).not.toContain('비운');
  });

  it('화면 문구에 백틱이 없다(BoldText 는 별표만 해석한다)', () => {
    const t = hbaBasisFootnote([{ key: 'a', hbaBasis: { ports: 3, dataRate: 1, nominal: 1, noSpeed: 1, clamped: 1, blanked: 1, unread: 1 } }]);
    expect(t.includes('`')).toBe(false);
  });

  it('BmUsage.jsx 가 표 아래에서 이 각주를 한 번 그린다', () => {
    const src = fs.readFileSync(path.join(HERE, 'BmUsage.jsx'), 'utf8');
    expect(src).toMatch(/hbaBasisFootnote\(shown\)/);
    expect((src.match(/hbaBasisFootnote\(/g) || []).length).toBeLessThanOrEqual(2);   // 조건 + 본문 한 쌍
  });
});

describe('RECENT-02 detailNotes — 소폭 초과(100% 표시)와 크게 초과(비움)를 나눠 말한다', () => {
  it('소폭 초과 포트는 100% 로 표시했다고 말하고 비웠다고 말하지 않는다', () => {
    const notes = detailNotes({ fc: [{ host: 'h1', bps: 3.4e9, pct: 100, pctBasis: 'fc-data-rate', pctOver: true, pctClamped: true }] });
    expect(notes.some((x) => x.includes('100% 로 표시'))).toBe(true);
    expect(notes.some((x) => x.includes('크게 나온'))).toBe(false);
  });
  it('크게 넘은 포트는 서버 대표값까지 비웠다고 말한다', () => {
    const notes = detailNotes({ fc: [{ host: 'h1', bps: 4e9, pct: null, pctBasis: 'fc-data-rate', pctOver: true }] });
    expect(notes.some((x) => x.includes('크게 나온') && x.includes('서버 대표'))).toBe(true);
    expect(notes.some((x) => x.includes('속도를 읽지 못한 FC'))).toBe(false);
  });
});
