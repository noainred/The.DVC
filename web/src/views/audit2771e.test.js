/**
 * audit2771e.test.js — v2.771 점검 R6-F3-2(웹): /summary 의 오버커밋 비율이 용량 미상 호스트 때문에 null 이면
 * 요약 화면은 '—' 와 함께 그 이유(용량을 못 읽은 호스트 수)를 말한다. 예전 RAM KPI 부제는 al.ramOvercommitPct 를
 * 그대로 찍어 null 이면 '물리 RAM의 null%' 가 됐다(서버가 null 을 주게 된 뒤 생기는 결함 — 함께 막는다).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serverRatio, ratioLabel } from './virtRatioText.js';
import { stripComments } from '../test/_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = stripComments(fs.readFileSync(path.join(HERE, 'Summary.jsx'), 'utf8'));

describe('R6-F3-2 요약 화면 오버커밋 — 용량 미상 호스트', () => {
  it('서버가 준 null 비율은 물리 합계가 있어도 — 로 그린다', () => {
    expect(ratioLabel(serverRatio(null, 320))).toBe('—');
    expect(ratioLabel(serverRatio(null, 2560, 100))).toBe('—');
  });
  it('Summary.jsx 가 hostsCapacityUnknown 을 읽어 사유를 부제로 말한다', () => {
    expect(src).toMatch(/al\?\.hostsCapacityUnknown/);
    expect(src).toMatch(/용량을 못 읽은 호스트 \$\{capUnknown\.toLocaleString\(\)\}대/);
    expect(src).toMatch(/sub=\{cr == null && capUnknown \? capUnknownSub : k\.sub\}/);
    expect(src).toMatch(/sub=\{mr == null && capUnknown \? capUnknownSub : k\.sub\}/);
  });
  it('RAM KPI 부제가 null 비율을 퍼센트로 찍지 않는다', () => {
    expect(src).toMatch(/al\.ramOvercommitPct == null \?/);
  });
});
