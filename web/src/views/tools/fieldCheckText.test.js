// v2.938 — 포탈 점검 › 법인별 실환경 확인 문구(서버 판정 코드와 1:1).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_TEXT, CHECK_TEXT, stateOf, bannerText, kpiOf, checkSummary, rowRank } from './fieldCheckText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = fs.readFileSync(path.resolve(HERE, '../../../../server/src/fieldcheck/judge.js'), 'utf8');
const listOf = (name) => {
  const m = new RegExp(`export const ${name} = Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`).exec(serverSrc);
  if (!m) throw new Error(`${name} 를 서버 소스에서 찾지 못했습니다`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
};

describe('서버 코드 ↔ 화면 문구 1:1', () => {
  it('FIELD_STATES · FIELD_CHECKS', () => {
    expect(Object.keys(STATE_TEXT).sort()).toEqual(listOf('FIELD_STATES').sort());
    expect(Object.keys(CHECK_TEXT).sort()).toEqual(listOf('FIELD_CHECKS').sort());
  });
  it('문구에 백틱이 없다', () => {
    expect(JSON.stringify({ STATE_TEXT, CHECK_TEXT }).includes('`')).toBe(false);
    expect(bannerText({ corps: 3 }).includes('`')).toBe(false);
  });
});

describe('요약', () => {
  const data = { corps: 2, total: 8, counts: { confirmed: 3, failed: 1, pending: 2, na: 1, unknown: 1 },
    byCheck: { 'vapi-tags': { confirmed: 1, failed: 1, pending: 0, na: 0, unknown: 0 }, 'bareos-dir': { confirmed: 0, failed: 0, pending: 1, na: 1, unknown: 0 } } };
  it('KPI 는 겹치지 않는다 — 합계 = 다섯 칸의 합', () => {
    const k = kpiOf(data);
    expect(k.confirmed + k.failed + k.pending + k.na + k.unknown).toBe(k.total);
  });
  it('항목별 요약 · 배너 · 모르는 상태는 판정 불가', () => {
    expect(checkSummary(data, 'vapi-tags')).toBe('확인됨 1 / 대상 2 · 실패 1');
    expect(checkSummary(data, 'bareos-dir')).toBe('확인됨 0 / 대상 1 · 해당 없음 1');
    expect(bannerText(data)).toMatch(/법인 \*\*2곳\*\*/); expect(bannerText({ corps: 0 })).toMatch(/없습니다/); expect(bannerText(null)).toMatch(/불러오는/);
    expect(stateOf({ state: 'zzz' })).toBe(STATE_TEXT.unknown);
    expect(rowRank({ cells: { a: { state: 'confirmed' }, b: { state: 'failed' } } }, ['a', 'b'])).toBe(0);
  });
});
