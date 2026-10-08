// v2.727(A안 — 사용자 선택) — iDRAC 통합 추이 위쪽 재배치 계약.
//   ① 보기 탭 + 법인·서비스·서버 한 줄 ② 종류 칩 + 도구 버튼 한 줄 ③ KPI 카드는 값 옆에 평균·최대.
//   예전 도구 줄(margin '-6px 0 12px')과 오른쪽 정렬만 하던 선택 줄을 되살리지 않는다(왼쪽이 비고 차트가 밀린다).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { stripComments } from '../../test/_stripComments.js';

const read = (p) => stripComments(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));

describe('iDRAC 통합 추이 A안 배치', () => {
  const src = read('./IdracTrendTool.jsx');
  const css = read('../../styles.css');
  it('행 두 개(idrac-trend-row)가 탭·선택과 칩·도구를 묶는다', () => {
    const rows = src.match(/className="idrac-trend-row"/g) || [];
    expect(rows.length).toBeGreaterThanOrEqual(3); // 차트 보기 2줄 + 표 보기 1줄
    expect(src).toMatch(/idrac-trend-row-end idrac-trend-tools/);
    expect(src).not.toMatch(/margin: '-6px 0 12px'/);
    expect(src).not.toMatch(/justifyContent: 'flex-end' \}\}>\s*\{sel\('법인'/);
  });
  it('KPI 카드는 값과 평균·최대를 한 줄(idrac-trend-kpi-val)에 둔다', () => {
    expect(src).toMatch(/className="idrac-trend-kpi-val"/);
    expect(src).not.toMatch(/fontSize: 22, fontWeight: 800/);
  });
  it('CSS 가 행·오른쪽 덩어리·값 줄을 정의하고 좁은 폭에서 왼쪽 정렬로 바꾼다', () => {
    for (const sel of ['.idrac-trend-row', '.idrac-trend-row-end', '.idrac-trend-kpi-val']) expect(css).toContain(`${sel} {`);
    expect(css).toMatch(/@media \(max-width: 720px\) \{ \.idrac-trend-row-end \{ margin-left: 0; \} \}/);
  });
});
