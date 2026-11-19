// vmFinderText.test.js — 122회차(111회차 결정 3): '유휴 VM' 카드가 판정 불가(idleUnknown)를 말한다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { idleCardOf } from './vmFinderText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('idleCardOf — 유휴 VM 카드', () => {
  it("분석한 VM 전부의 평균을 못 읽었으면 초록 0 이 아니라 '—' 와 사유다", () => {
    const c = idleCardOf({ idleCount: 0, idleUnknown: 4, idleThreshold: 5, avgCap: 40 }, 4);
    expect(c.value).toBe('—');
    expect(c.accent).toBeUndefined();
    expect(c.meta).toBe('평균 CPU ≤ 5% · 분석한 4대 모두 평균을 읽지 못해 판정하지 못했습니다');
  });

  it('검색 결과가 상한보다 많으면 분석한 수는 상한(avgCap)이다', () => {
    const c = idleCardOf({ idleCount: 0, idleUnknown: 40, idleThreshold: 5, avgCap: 40 }, 1234);
    expect(c.value).toBe('—');
    expect(c.meta).toContain('분석한 40대 모두');
    // 상한 안에서 일부만 못 읽었다 — 유휴 수는 그대로, 판정 불가를 따로 말한다
    const p = idleCardOf({ idleCount: 3, idleUnknown: 10, idleThreshold: 5, avgCap: 40 }, 1234);
    expect(p.value).toBe(3);
    expect(p.accent).toBe('var(--red)');
    expect(p.meta).toBe('평균 CPU ≤ 5% · 판정 불가 10대(평균을 읽지 못함)');
  });

  it('일부를 못 읽었는데 유휴가 0 이면 초록이 아니다(전부를 본 것이 아니다)', () => {
    const c = idleCardOf({ idleCount: 0, idleUnknown: 2, idleThreshold: 10, avgCap: 40 }, 7);
    expect(c.value).toBe(0);
    expect(c.accent).toBe('var(--amber)');
    expect(c.meta).toBe('평균 CPU ≤ 10% · 판정 불가 2대(평균을 읽지 못함)');
  });

  it('전부 판정했으면 예전과 같다(유휴 0 = 초록 · 있으면 빨강) · idleUnknown 이 없는 옛 응답도 같다', () => {
    expect(idleCardOf({ idleCount: 0, idleUnknown: 0, idleThreshold: 5, avgCap: 40 }, 9)).toEqual({ value: 0, accent: 'var(--green)', meta: '평균 CPU ≤ 5%' });
    expect(idleCardOf({ idleCount: 2, idleUnknown: 0, idleThreshold: 5, avgCap: 40 }, 9)).toEqual({ value: 2, accent: 'var(--red)', meta: '평균 CPU ≤ 5%' });
    expect(idleCardOf({ idleCount: 2, idleThreshold: 5 }, 9)).toEqual({ value: 2, accent: 'var(--red)', meta: '평균 CPU ≤ 5%' });
    expect(idleCardOf({ idleThreshold: 5 }, 0)).toEqual({ value: 0, accent: 'var(--green)', meta: '평균 CPU ≤ 5%' });
  });

  it('문구에 백틱이 없다(BoldText · 화면 문구 규칙)', () => {
    for (const d of [{ idleCount: 0, idleUnknown: 4, idleThreshold: 5, avgCap: 40 }, { idleCount: 1, idleUnknown: 1, idleThreshold: 5, avgCap: 40 }]) {
      expect(idleCardOf(d, 4).meta).not.toContain('`');
    }
  });

  it('화면이 그 판정을 쓴다(카드가 idleCount 만 다시 보지 않게)', () => {
    const src = fs.readFileSync(path.join(HERE, 'VmFinderTool.jsx'), 'utf8');
    expect(src).toMatch(/<Card label="유휴 VM" \{\.\.\.idleCardOf\(data, items\.length\)\} \/>/);
    expect(src).not.toMatch(/value=\{data\.idleCount/);
  });
});
