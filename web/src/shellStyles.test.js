/**
 * shellStyles.test.js — 2단 상단 메뉴 CSS 규약 고정(v2.556).
 *
 * 왜 소스(CSS)를 검사하는가: 이 규칙을 전역 `.tab` 으로 되돌리면 **앱 전역의 일반 버튼 수십 개**
 * (접속확인·필터 초기화·CSV 선택·집계 단위 …)가 테두리 없는 밑줄 글자가 된다. Chromium 으로
 * 확인했지만(전역 .tab: radius 8px·active 파란 채움 / 헤더 탭: radius 0·청록 밑줄) 그 검증은
 * 매 커밋마다 돌지 않으므로 여기서 계약을 고정한다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CSS = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8');
/** 주석을 지운 CSS — 규칙을 설명하는 주석이 통과 근거가 되면 안 된다(v2.535 규약). */
const BODY = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

describe('2단 상단 메뉴 (v2.556)', () => {
  it('★ 밑줄 탭 규칙은 .topbar .tabs .tab 으로 한정된다', () => {
    expect(BODY).toMatch(/\.topbar\s+\.tabs\s+\.tab\s*\{/);
    expect(BODY).toMatch(/\.topbar\s+\.tabs\s+\.tab\.active\s*\{/);
  });

  it('★★ 전역 .tab 은 예전 스타일(둥근 모서리 + active 파란 채움)을 유지한다', () => {
    const global = BODY.match(/(?:^|\n)\.tab\s*\{([^}]*)\}/);
    expect(global, '전역 .tab 규칙이 사라졌습니다 — 앱 전역 버튼 수십 개가 영향을 받습니다').toBeTruthy();
    expect(global[1]).toMatch(/border-radius:\s*8px/);
    const active = BODY.match(/(?:^|\n)\.tab\.active\s*\{([^}]*)\}/);
    expect(active, '전역 .tab.active 규칙이 사라졌습니다').toBeTruthy();
    expect(active[1]).toMatch(/background:\s*var\(--accent\)/);
  });

  it('브랜드 행은 줄바꿈을 허용한다 — 좁은 폭 가로 넘침의 해법이다(실측 628px → 400px)', () => {
    const row = BODY.match(/\.topbar\s+\.tb-brandrow\s*\{([^}]*)\}/);
    expect(row, '.tb-brandrow 규칙이 없습니다').toBeTruthy();
    expect(row[1]).toMatch(/flex-wrap:\s*wrap/);
  });

  it('메뉴 행은 가로 스크롤한다(탭이 많아도 페이지를 밀지 않게)', () => {
    const tabs = BODY.match(/\.topbar\s+\.tabs\s*\{([^}]*)\}/);
    expect(tabs).toBeTruthy();
    expect(tabs[1]).toMatch(/overflow-x:\s*auto/);
  });

  it('시안 토큰 4개가 :root 에 있고 같은 색에 새 hex 를 늘리지 않았다', () => {
    const root = BODY.match(/:root\s*\{([\s\S]*?)\}/)[1];
    for (const v of ['--border-soft', '--panel-deep', '--teal', '--font-mono']) expect(root).toContain(v);
    // --teal 과 --font-mono 는 기존 값을 가리킨다(중복 정의 금지).
    expect(root).toMatch(/--teal:\s*var\(--mint-dim\)/);
    expect(root).toMatch(/--font-mono:\s*var\(--mono\)/);
  });

  it('서버 온도 표 규칙은 .st-table 로 한정된다(전역 table/thead th 를 건드리지 않는다)', () => {
    expect(BODY).toMatch(/\.st-table\s+thead\s+th\s*\{/);
    expect(BODY).toMatch(/\.st-table\s+tbody\s+td\s*\{/);
    // hover 가 임계 배경(인라인)보다 위여야 한다 — 그래서 !important 다.
    expect(BODY).toMatch(/\.st-table\s+tbody\s+tr:hover\s*\{[^}]*!important/);
  });

  it('반응형 접힘 경계 2개(1200/1100px)가 있다', () => {
    expect(BODY).toMatch(/max-width:\s*1200px\s*\)\s*\{\s*\.st-kpis/);
    expect(BODY).toMatch(/max-width:\s*1100px\s*\)\s*\{\s*\.st-mid/);
  });
});
