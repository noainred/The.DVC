/**
 * shellStyles.test.js — 셸 CSS 규약 고정(v2.556 → v2.726 좌측 사이드바).
 *
 * 왜 소스(CSS)를 검사하는가: 메뉴 규칙을 전역 `.tab` 으로 되돌리면 **앱 전역의 일반 버튼 수십 개**
 * (접속확인·필터 초기화·CSV 선택·집계 단위 …)가 테두리 없는 밑줄 글자가 된다. v2.726 부터 메뉴는
 * 좌측 사이드바(`.sb`)이고 상단 메뉴 규칙(`.topbar .tabs`·`.subtabs`)은 지웠다 — 사이드바 규칙은
 * 전부 `.sb` 아래로 한정하고, 전역 `.tab` 은 그대로다. Chromium 으로 확인했지만 그 검증은 매 커밋마다
 * 돌지 않으므로 여기서 계약을 고정한다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CSS = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8');
/** 주석을 지운 CSS — 규칙을 설명하는 주석이 통과 근거가 되면 안 된다(v2.535 규약). */
const BODY = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** 선택자 목록 → 규칙 블록(선택자, 본문). 중첩 블록(@media) 안도 한 단계 들어간다. */
function rules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const sel = m[1].trim();
    if (sel.startsWith('@')) continue;
    out.push({ sel, body: m[2] });
  }
  return out;
}

describe('좌측 사이드바 셸 (v2.726)', () => {
  it('★ 상단 메뉴 규칙(.topbar .tabs · .subtabs · .tab-count · 1600px 한 줄 합치기)은 지웠다', () => {
    expect(BODY).not.toMatch(/\.topbar\s+\.tabs/);
    expect(BODY).not.toMatch(/\.subtabs/);
    expect(BODY).not.toMatch(/\.tab-count/);
    expect(BODY).not.toMatch(/min-width:\s*1600px/);
  });

  it('★★ 사이드바·편집 창 규칙은 .sb / .me / .app-body 아래로만 — 전역 .tab·.btn 을 건드리지 않는다', () => {
    const sb = rules(BODY).filter((r) => /\.sb\b|\.sb-|\.me\b|\.me-|\.app-body/.test(r.sel));
    expect(sb.length).toBeGreaterThan(40);
    for (const r of sb) {
      for (const one of r.sel.split(',')) {
        const t = one.trim();
        // .statusbar .sb-cell / .sb-label / .sb-val 은 v2.556 하단 상태바 규칙(이름만 같다) — 사이드바와 무관.
        if (t.startsWith('.statusbar')) continue;
        expect(t, t).toMatch(/^(\.sb(-[a-z-]+)?|\.me(-[a-z-]+)?|\.app-body)(\b|[.:\s>])/);
      }
      expect(r.body, r.sel).not.toMatch(/text-transform/);
    }
  });

  it('사이드바 높이는 App 이 재서 넘기는 --topbar-h·--statusbar-h 로 정한다(숫자를 박지 않는다)', () => {
    const sb = rules(BODY).find((r) => r.sel === '.sb');
    expect(sb).toBeTruthy();
    expect(sb.body).toMatch(/top:\s*var\(--topbar-h\)/);
    expect(sb.body).toMatch(/calc\(100vh - var\(--topbar-h\) - var\(--statusbar-h\)\)/);
    // 레일 플라이아웃이 갇히지 않게 .sb 에는 backdrop-filter·transform 을 걸지 않는다.
    expect(sb.body).not.toMatch(/backdrop-filter|transform/);
  });

  it('레일은 64px · 플라이아웃은 .sb-nav overflow:visible 위에서 hover/focus-within 으로 뜬다 · 서랍은 닫히면 visibility hidden', () => {
    expect(BODY).toMatch(/\.sb-rail\s*\{[^}]*width:\s*64px/);
    expect(BODY).toMatch(/\.sb-rail\s+\.sb-nav\s*\{[^}]*overflow:\s*visible/);
    expect(BODY).toMatch(/\.sb-rail\s+\.sb-group:hover\s+\.sb-sub,\s*\.sb-rail\s+\.sb-group:focus-within\s+\.sb-sub\s*\{/);
    expect(BODY).toMatch(/\.sb-drawer\s*\{[^}]*visibility:\s*hidden/);
    expect(BODY).toMatch(/\.sb-drawer\.open\s*\{[^}]*visibility:\s*visible/);
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
