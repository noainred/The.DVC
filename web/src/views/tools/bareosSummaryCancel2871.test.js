/**
 * v2.871 감사 A1-03 · A4-07 — Bareos 요약 상단 '마지막 결과' 카드의 글자 · 막대 aria-label 에 취소(canceled) 수.
 *   v2.870 이 취소를 실패와 갈라 총계 막대(totBar)에 회색 조각을 넣었지만 카드 글자 · aria-label 은 '성공 · 경고 · 실패 · 진행' 만 말해
 *   칸 수의 합이 잡 수와 맞지 않고 회색이 무엇인지 화면에 없었다. 법인 행(같은 파일)과 같은 말로 적는다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'BareosSummaryTool.jsx'), 'utf8');

describe('BareosSummaryTool 총계 카드 — 취소 수', () => {
  it('글자 · aria-label 에 취소 · 부분 합 표지 목록에도 cancel', () => {
    const card = src.slice(src.indexOf('마지막 결과 (잡'), src.indexOf('label="확인 필요"'));
    expect(card).toMatch(/\{t\.cancel \? <span[^>]*>취소 \{partialText\(t, 'cancel'\)\}<\/span> : null\}/);
    expect(card).toMatch(/label=\{`성공 \$\{t\.ok\} · 경고 \$\{t\.warn\} · 실패 \$\{t\.fail\}\$\{t\.cancel \? ` · 취소 \$\{t\.cancel\}` : ''\} · 진행 \$\{t\.run\}`\}/);
    expect(src).toMatch(/\['ok', 'warn', 'fail', 'cancel', 'run',/);
  });
});
