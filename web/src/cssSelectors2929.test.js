/**
 * cssSelectors2929.test.js — styles.css 에서 같은 클래스 이름을 두 화면이 따로 정의하는 '이름 겹침' 을 막는다(v2.929).
 *
 * 왜: 한 파일(styles.css)에 2,500개 넘는 규칙이 있어 새 화면의 클래스가 예전 화면의 같은 이름을 뒤에서 덮어도 아무도 모른다.
 *   v2.882 필터 화면의 `.iss-filters`(격자)가 보드 필터 줄 · 활동 머리(줄 배치)를 덮었고(v2.908 에 발견), 그 v2.908 이 SLA 업무 시간
 *   입력에 `.iss-cal` 을 써서 이슈 캘린더 화면(`.iss-cal`)에 점선 · 여백을 덧붙였다(v2.929 에 발견 — 같은 실수를 이름 하나만 막아 두 번 했다).
 * 무엇을: @media 밖 최상위 규칙에서 **클래스 하나짜리 선택자**(예: `.iss-cal`)가 두 규칙 이상에 나오면 목록에 오른다. 지금 있는 것은
 *   전부 '묶음 규칙 + 그 클래스만 덧붙임'(예: `.iss-card-top, .iss-card-foot {…}` 뒤 `.iss-card-foot { flex-wrap }`)이라 KNOWN 에 적어 둔다.
 *   새 이름이 목록에 오르면 먼저 `grep -n '^\.<이름>' src/styles.css` 로 다른 화면의 같은 이름인지 보고, 겹침이면 이름을 바꾸고
 *   의도한 덧붙임이면 KNOWN 에 사유와 함께 더한다.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 최상위(@media 밖) 규칙의 선택자 → 나온 줄 번호들. 주석은 줄 수를 지키며 지우고, 괄호 안 쉼표(:where(a, b))는 나누지 않는다. */
export function topLevelSelectors(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const out = new Map();
  const splitTop = (sel) => {
    const r = []; let d = 0; let b = '';
    for (const ch of sel) { if (ch === '(') d += 1; if (ch === ')') d -= 1; if (ch === ',' && d === 0) { r.push(b); b = ''; } else b += ch; }
    r.push(b);
    return r.map((x) => x.trim().replace(/\s+/g, ' ')).filter(Boolean);
  };
  let depth = 0; let cur = ''; let line = 1; let start = 1;
  for (const ch of src) {
    if (ch === '\n') line += 1;
    if (ch === '{') {
      const sel = cur.trim();
      if (depth === 0 && sel && !sel.startsWith('@')) for (const s of splitTop(sel)) { if (!out.has(s)) out.set(s, []); out.get(s).push(start); }
      depth += 1; cur = '';
    } else if (ch === '}') { depth -= 1; cur = ''; } else if (ch === ';' && depth === 0) { cur = ''; } else {
      if (!cur.trim() && ch.trim()) start = line;
      cur += ch;
    }
  }
  return out;
}

/** 의도한 덧붙임(묶음 규칙 뒤 그 클래스만 고침) — 사유 한 줄씩. */
const KNOWN = Object.freeze({
  '.input': '.input, .select 묶음 뒤 .input 최소 폭',
  '.error-box': '.loading, .error-box 묶음 뒤 글자색',
  '.pc-thead': '관제 콘솔 표 격자 묶음 뒤 머리 고정',
  '.pc-tr': '관제 콘솔 표 격자 묶음 뒤 줄 테두리',
  '.pc-group': '관제 콘솔 표 격자 묶음 뒤 묶음 줄',
  '.pc-ctx-tag': '오른쪽 정렬 묶음 뒤 꼬리표 모양',
  '.st-n': '.st-tab-n, .st-n 묶음 뒤 배경 없앰',
  '.iss-card-top': '카드 위 · 아래 줄 묶음 뒤 줄바꿈(v2.882)',
  '.iss-card-foot': '카드 위 · 아래 줄 묶음 뒤 줄바꿈(v2.908)',
  '.wiki-doc-main': '본문 상자 뒤 인라인 댓글 위치 기준(relative)',
  '.iss-scard': '에픽 왼쪽 띠 묶음 뒤 스프린트 카드 커서',
});

describe('styles.css 클래스 이름 겹침', () => {
  const css = fs.readFileSync(path.join(HERE, 'styles.css'), 'utf8');
  const sels = topLevelSelectors(css);
  it('클래스 하나짜리 선택자가 두 규칙 이상에 나오면 KNOWN(의도한 덧붙임)에 있어야 한다', () => {
    const dups = [...sels].filter(([s, lines]) => lines.length > 1 && /^\.[\w-]+$/.test(s)).map(([s, lines]) => `${s} @ ${lines.join(',')}`);
    const fresh = dups.filter((d) => !Object.hasOwn(KNOWN, d.split(' @ ')[0]));
    expect(fresh, `다른 화면의 같은 클래스 이름일 수 있다 — 이름을 바꾸거나(겹침) KNOWN 에 사유와 함께 더하라(덧붙임):\n${fresh.join('\n')}`).toEqual([]);
    // KNOWN 이 낡지 않게 — 더 이상 겹치지 않는 이름은 목록에서 뺀다
    for (const k of Object.keys(KNOWN)) expect((sels.get(k) || []).length, `${k} 는 더 이상 두 번 나오지 않는다 — KNOWN 에서 뺄 것`).toBeGreaterThan(1);
  });
  it('v2.908 의 겹침 두 건은 한 번씩만 — .iss-filters(줄 배치) · .iss-cal(이슈 캘린더). SLA 입력은 .iss-slacal · 필터 화면은 .iss-filterview', () => {
    expect((sels.get('.iss-filters') || []).length).toBe(1);
    expect((sels.get('.iss-cal') || []).length).toBe(1);
    expect((sels.get('.iss-slacal') || []).length).toBe(1);
    const iss = fs.readFileSync(path.join(HERE, 'views/issues/Issues.jsx'), 'utf8');
    expect(iss).toMatch(/className="iss-slacal"/);
    expect(iss).not.toMatch(/className="iss-cal"/);
    expect(fs.readFileSync(path.join(HERE, 'views/issues/IssueCalendar.jsx'), 'utf8')).toMatch(/className="iss-cal"/);
  });
  it('파서 — 괄호 안 쉼표는 나누지 않고 @media 안은 세지 않는다', () => {
    const m = topLevelSelectors('.a, .b:where(.c, .d) { x: 1 }\n@media (max-width: 9px) { .a { y: 2 } }\n/* .a { } */\n.a { z: 3 }');
    expect([...m.keys()]).toEqual(['.a', '.b:where(.c, .d)']);
    expect(m.get('.a')).toEqual([1, 4]);
  });
});
