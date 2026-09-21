/**
 * v2.574 — 웹 확정 결함 회귀 고정 (2026-09-21 감사 BUG-11·12·14·15).
 *
 * 이 넷의 공통점: **오류가 나지 않는다.** 화면은 정상처럼 보이고 값·색·문구만 거짓이라
 * 수치로는 안 잡히고 스크린샷을 읽거나 함수를 직접 돌려야 보인다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { kindAdvice } from './curUserText.js';
import { sparkPath } from './serverTemp/board.js';
import { boldParts } from '../../components/boldText.jsx';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, rel), 'utf8');

/* ── BUG-11 · BoldText 에 객체를 넘기지 않는다 ───────────────────────────────── */

describe('BUG-11 — kindAdvice 는 객체다. BoldText 에는 .text 를 넘긴다', () => {
  it('객체를 그대로 넘기면 [object Object] 가 된다 — 그 사실을 고정한다', () => {
    // 왜 이 단언이 있나: 다음 사람이 "객체를 넘겨도 되겠지" 라고 생각하지 않게.
    expect(boldParts(kindAdvice('no-agent')).map((p) => p.t).join('')).toBe('[object Object]');
  });

  it('HorizonSessionsPanel 이 .text 를 쓴다(객체를 넘기지 않는다)', () => {
    const src = read('HorizonSessionsPanel.jsx');
    expect(src).toMatch(/kindAdvice\(detail\.kind\)\.text/);
    // 객체를 그대로 넘기던 옛 형태가 남아 있으면 안 된다.
    expect(src).not.toMatch(/<BoldText text=\{kindAdvice\(detail\.kind\)\}/);
  });

  it('문구가 없는 kind 에서는 아무것도 렌더하지 않는다 — 객체는 항상 truthy 였다', () => {
    expect(kindAdvice('ok').text).toBe('');
    expect(Boolean(kindAdvice('ok'))).toBe(true);   // ← 옛 조건이 참이던 이유
  });
});

/* ── BUG-14 · BoldText 문구의 백틱 ──────────────────────────────────────────── */

describe('BUG-14 — 화면 문구에 백틱이 없다(BoldText 는 **강조** 만 해석한다)', () => {
  /** 문자열 리터럴만 훑는다 — 주석·템플릿 리터럴은 대상이 아니다. */
  const koreanStringsWithBacktick = (src) => {
    const out = []; let i = 0; const n = src.length;
    while (i < n) {
      const c = src[i];
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n && src[j] !== c) { if (src[j] === '\\') { j += 2; continue; } if (src[j] === '\n') break; j += 1; }
        const lit = src.slice(i, j + 1);
        if (lit.includes('`') && /[가-힣]/.test(lit)) out.push(lit.slice(0, 80));
        i = j + 1; continue;
      }
      if (c === '`') { let j = i + 1; while (j < n) { if (src[j] === '\\') { j += 2; continue; } if (src[j] === '`') break; j += 1; } i = j + 1; continue; }
      i += 1;
    }
    return out;
  };
  // 감사가 확정한 11곳이 있던 파일들.
  const FILES = [
    'curUserText.js', 'powermaxCapacityText.js', 'sanHealthText.js',
    'unityCapacityPlan.js', 'bulkIoText.js', 'BulkDeviceIo.jsx', 'BmUsage.jsx',
  ];
  for (const f of FILES) {
    it(`${f} — 한글 문구 안에 백틱 0`, () => {
      expect(koreanStringsWithBacktick(read(f))).toEqual([]);
    });
  }
  it('값 인용은 홑화살괄호로 바뀌었다(지웠는지 확인 — 조용히 사라지면 안 된다)', () => {
    expect(read('curUserText.js')).toContain('‘guestinfo.curuser.*’');
    expect(read('curUserText.js')).toContain('‘quser’');
  });
});

/* ── BUG-15 · 수집 공백을 선으로 잇지 않는다 ────────────────────────────────── */

describe('BUG-15 — sparkPath 는 결측 구간에서 subpath 를 끊는다', () => {
  const M = (d) => (d.match(/M/g) || []).length;

  it('결측이 없으면 M 은 하나(기존 동작)', () => {
    const sp = sparkPath([20, 21, 22, 23]);
    expect(M(sp.d)).toBe(1);
    expect(sp.gaps).toBe(false);
    expect(sp.area).toBeTruthy();
  });

  it('★ 가운데가 비면 선을 잇지 않는다 — M 이 둘', () => {
    const sp = sparkPath([20, 21, null, null, 26, 27]);
    expect(M(sp.d)).toBe(2);
    expect(sp.gaps).toBe(true);
  });

  it('★ 끊긴 계열은 면적을 채우지 않는다 — 채우면 공백이 메워져 보인다', () => {
    expect(sparkPath([20, 21, null, 26, 27]).area).toBe(null);
  });

  it('★ x 축은 결측까지 포함한 길이로 잡는다 — 버린 뒤 다시 세면 공백이 사라진다', () => {
    // 6점 중 3·4번이 결측. 마지막 점의 x 는 '6점 기준' 자리여야 한다.
    const gap = sparkPath([20, 21, null, null, 26, 27], { width: 84, pad: 2 });
    const full = sparkPath([20, 21, 22, 23, 26, 27], { width: 84, pad: 2 });
    const lastX = (d) => Number(d.split(/[ML]/).pop().split(',')[0]);
    expect(lastX(gap.d)).toBeCloseTo(lastX(full.d), 1);
  });

  it('결측은 여전히 0℃ 로 살아남지 않는다(v2.556 규약 유지)', () => {
    const sp = sparkPath([20, null, 21]);
    expect(sp.lo).toBe(20);      // 0 이면 v2.556 결함이 되살아난 것이다
    expect(sp.n).toBe(2);
  });

  it('값이 2개 미만이면 null — 한 점을 선으로 만들면 추세가 있는 것처럼 보인다', () => {
    expect(sparkPath([20, null, null])).toBe(null);
    expect(sparkPath([])).toBe(null);
  });
});

/* ── BUG-12 · null 사용률을 초록으로 칠하지 않는다 ──────────────────────────── */

describe('BUG-12 — 값이 없는 KPI 는 정상색이 아니다', () => {
  const toneOf = (pct) => (pct == null ? undefined : pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : 'ok');
  it('판정식 자체 — null 은 tone 없음', () => {
    expect(toneOf(null)).toBe(undefined);
    expect(toneOf(undefined)).toBe(undefined);
    expect(toneOf(95)).toBe('bad');
    expect(toneOf(80)).toBe('warn');
    expect(toneOf(50)).toBe('ok');
  });
  it('StorageGrowthTool 이 그 형태를 쓴다(옛 형태가 남아 있으면 안 된다)', () => {
    const src = read('StorageGrowthTool.jsx');
    expect(src).toMatch(/tone=\{t\.pct == null \? undefined/);
    expect(src).not.toMatch(/tone=\{t\.pct >= 90 \? 'bad'/);
  });
});
