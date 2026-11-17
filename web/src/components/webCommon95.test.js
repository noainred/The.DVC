// 전체 점검 95회차 — 웹 공통 컴포넌트(모달 배경 닫기 · 표 정렬 키 · 결과 수) + 물리 GPU 등록부 손상 배너 문구.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { backdropClose } from './backdropClose.js';
import { sortKeyOf, compareKeys } from './sortableText.js';
import { ResultCount } from './primitives.jsx';
import { Modal } from './Modal.jsx';
import { physicalLoadErrorText } from '../views/gpu-guest/physicalGpuText.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('backdropClose — 누름과 뗌이 모두 배경일 때만 닫는다(Chromium: 창 안에서 끌다 배경에서 떼면 click 이 배경으로 간다)', () => {
  const overlay = () => ({ dataset: {} });
  it('창 안에서 누르고 배경에서 뗀 click 은 닫지 않는다', () => {
    let n = 0; const p = backdropClose(() => { n += 1; }); const ov = overlay();
    p.onMouseDown({ currentTarget: ov, target: { inner: true } });
    p.onClick({ currentTarget: ov, target: ov });
    expect(n).toBe(0);
  });
  it('배경을 누르고 배경에서 뗀 click 은 닫는다 · 다음 click 은 다시 누름을 본다', () => {
    let n = 0; const p = backdropClose(() => { n += 1; }); const ov = overlay();
    p.onMouseDown({ currentTarget: ov, target: ov });
    p.onClick({ currentTarget: ov, target: ov });
    expect(n).toBe(1);
    p.onClick({ currentTarget: ov, target: ov });   // 누름 없이 온 click(합성) — 닫지 않는다
    expect(n).toBe(1);
  });
  it('창 안 click 은 닫지 않는다 · disabled(진행 중)면 닫지 않는다(함수도 받는다)', () => {
    let n = 0; const ov = overlay();
    const p = backdropClose(() => { n += 1; });
    p.onMouseDown({ currentTarget: ov, target: { inner: true } });
    p.onClick({ currentTarget: ov, target: { inner: true } });
    const q = backdropClose(() => { n += 1; }, { disabled: true });
    q.onMouseDown({ currentTarget: ov, target: ov }); q.onClick({ currentTarget: ov, target: ov });
    const r = backdropClose(() => { n += 1; }, { disabled: () => true });
    r.onMouseDown({ currentTarget: ov, target: ov }); r.onClick({ currentTarget: ov, target: ov });
    expect(n).toBe(0);
  });
  it('공용 모달(components/*)은 배경 click 판정을 직접 쓰지 않고 backdropClose 를 쓴다 · Modal 은 대화상자 표지', () => {
    for (const f of ['components/Modal.jsx', 'components/CsvBulkModals.jsx', 'components/VmConsole.jsx', 'components/ExportPreviewModal.jsx']) {
      const s = stripComments(read(f));
      expect(s, f).not.toMatch(/onClick=\{\(e\) => \{ if \(e\.target === e\.currentTarget/);
      expect(s, f).toMatch(/\{\.\.\.backdropClose\(onClose/);
    }
    const html = renderToStaticMarkup(React.createElement(Modal, { title: '제목', onClose: () => {} }, '본문'));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="제목"');
  });
});

describe('sortKeyOf — 상대 시각 · 긴 글자', () => {
  const order = (arr) => [...arr].sort((a, b) => compareKeys(sortKeyOf(a), sortKeyOf(b)));
  it("'N초/분/시간/일 전' 은 지금에서 뺀 시각 — 오름차순은 오래된 것 먼저(날짜 셀과 같은 축) · '방금' 은 지금 · '—' 은 뒤", () => {
    expect(order(['3분 전', '10초 전', '2시간 전', '1일 전', '방금', '45분 전', '—'])).toEqual(['1일 전', '2시간 전', '45분 전', '3분 전', '10초 전', '방금', '—']);
    expect(sortKeyOf('3분 전').kind).toBe('num');
  });
  it('예전 수 · 단위 판정은 그대로(부호 · 단위 · 기간)', () => {
    expect(sortKeyOf('1.5 GB').v).toBe(1.5e9);
    expect(sortKeyOf('−7%').v).toBe(-7);
    expect(sortKeyOf('3일').v).toBe(3 * 86400);
    expect(sortKeyOf('2026. 11. 17. 오후 6:07').kind).toBe('num');
  });
  it('긴 글자는 수 판정을 하지 않는다 — 1,000번 8,000자가 즉시(예전 앞뒤 \\s* 역추적: 한 번 약 63ms)', () => {
    const s = `1${' '.repeat(8000)}x`;
    expect(sortKeyOf(s).kind).toBe('str');
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) sortKeyOf(s);
    expect(performance.now() - t0).toBeLessThan(2000);
    // 긴 글 속 날짜는 그대로 찾는다(앞 256자)
    expect(sortKeyOf(`2026. 11. 17. 오후 6:07 ${'가'.repeat(100)}`).kind).toBe('num');
  });
});

describe('ResultCount — 못 읽은 total 은 0 도 크래시도 아니다 · 호출부 인자 이름', () => {
  it("null · 글자 total 은 '—'(toLocaleString 이 던지지 않는다) · 수는 그대로", () => {
    expect(renderToStaticMarkup(React.createElement(ResultCount, { total: null, label: 'VM' }))).toContain('—');
    expect(renderToStaticMarkup(React.createElement(ResultCount, { total: 1234, shown: 10, label: 'VM' }))).toContain('1,234');
    expect(renderToStaticMarkup(React.createElement(ResultCount, { total: 1234, shown: 10, label: 'VM' }))).toContain('상위 10개');
  });
  it('모든 <ResultCount> 호출은 total 을 준다(예전 스냅샷 나이 화면이 count= 로 넘겨 늘 \'총 0개\')', () => {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const bad = [];
    for (const f of walk(SRC).filter((x) => /\.jsx$/.test(x) && !/\.test\./.test(x))) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/<ResultCount\b[^>]*>/g)) if (!/\btotal=/.test(m[0])) bad.push(path.relative(SRC, f));
    }
    expect(bad).toEqual([]);
  });
});

describe('물리 GPU 등록부 로드 오류 배너(physicalLoadErrorText)', () => {
  it('없으면 빈 글자 · 읽기 오류는 저장을 막는다고 · 손상은 보존본 · 저장 결과를 말한다 · 백틱 없음', () => {
    expect(physicalLoadErrorText(null)).toBe('');
    const r = physicalLoadErrorText({ code: 'read-error', text: '등록부 읽기 오류(EACCES)', readError: true });
    expect(r).toContain('원본은 그대로');
    expect(r).toContain('등록 · 수정 · 삭제를 막습니다');
    const c = physicalLoadErrorText({ code: 'parse-error', text: 'JSON 형식 오류(1줄 5칸)', readError: false });
    expect(c).toContain('보존본');
    expect(c).toContain('등록이 없다는 뜻이 아닙니다');
    for (const t of [r, c]) expect(t).not.toContain('`');
  });
});
