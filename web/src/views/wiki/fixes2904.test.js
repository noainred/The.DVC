/**
 * fixes2904.test.js — v2.904 위키 · 이슈 · 첨부 점검(웹) 확정분 회귀.
 * W-1 safeImg 역슬래시 · W-3 Content-Disposition UTF-8 이름 · W-4 짧은 줄 문단 선형 · W-7 크기 단위 경계 · W-8 첨부 이름 이스케이프 ·
 * S-1 체크 충돌 문구 · W-2 빈 값 정렬(자리표시 '~' 금지 — 소스 스윕).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeImg, parseMarkdown, parseInline } from './markdown.js';
import { conflictText } from './wikiText.js';
import { attachSizeText, attachMarkdown } from '../attach/attachText.js';
import { dispositionName } from '../../api.js';
import { compareKeys, sortKeyOf } from '../../components/sortableText.js';

describe('v2.904 위키 · 첨부', () => {
  it('W-1 그림 주소는 같은 출처 경로만 — 역슬래시 우회 거부', () => {
    expect(safeImg('/\\evil.com/x.png')).toBe(null);
    expect(safeImg('/a\\b.png')).toBe(null);
    expect(safeImg('//evil.com/x.png')).toBe(null);
    expect(safeImg('/api/attach/file/abc')).toBe('/api/attach/file/abc');
  });
  it('W-3 Content-Disposition — filename* 의 UTF-8 원래 이름을 먼저', () => {
    expect(dispositionName(`attachment; filename="___.txt"; filename*=UTF-8''${encodeURIComponent('보고서 1.txt')}`)).toBe('보고서 1.txt');
    expect(dispositionName('attachment; filename="plain.csv"')).toBe('plain.csv');
    expect(dispositionName('')).toBe('');
    expect(dispositionName("attachment; filename*=UTF-8''%E0%A4")).toBe(''); // 깨진 인코딩 → ASCII 이름도 없으면 ''
  });
  it('W-4 짧은 줄이 많은 문단도 선형(상한 200k 자에서 1초 안) · 줄 끝 공백 둘 = 줄바꿈은 그대로', () => {
    const t = Date.now();
    parseMarkdown('a\n'.repeat(100_000));
    expect(Date.now() - t).toBeLessThan(1000);
    expect(parseInline('a  \nb').map((n) => n.t)).toEqual(['text', 'br', 'text']);
    expect(parseInline('a \nb')).toEqual([{ t: 'text', v: 'a  b' }]);
  });
  it('W-7 크기 — 반올림이 1024 에 닿으면 위 단위', () => {
    expect(attachSizeText(1048575)).toBe('1.0 MB');
    expect(attachSizeText(1073741823)).toBe('1.0 GB');
    expect(attachSizeText(1023)).toBe('1023 B');
    expect(attachSizeText(1024)).toBe('1 KB');
    expect(attachSizeText(10 * 1024 * 1024)).toBe('10 MB');
  });
  it("W-8 첨부 마크다운 — 머리 '^' 는 빼고 '|' 는 이스케이프(각주 · 표 칸으로 읽히지 않게)", () => {
    const id = 'a'.repeat(32);
    const md = attachMarkdown({ name: '^notes.txt', id });
    expect(md).toBe(`[notes.txt](attach:${id})`);
    expect(parseInline(md)[0].attach).toBe(id);
    expect(attachMarkdown({ name: 'a|b.txt', id })).toBe(`[a\\|b.txt](attach:${id})`);
    expect(attachMarkdown({ name: '^', id })).toBe(`[첨부](attach:${id})`);
  });
  it('S-1 체크만 바뀐 충돌은 따로 말한다', () => {
    expect(conflictText({ kind: 'check', current: { by: 'bob', at: Date.now() } })).toMatch(/체크리스트가 바뀌었습니다/);
    expect(conflictText({ current: { version: 3, by: 'bob', at: Date.now() } })).toMatch(/먼저 저장했습니다/);
  });
  it("W-2 빈 값은 방향과 상관없이 뒤 — 이슈 표에 '~' 자리표시를 쓰지 않는다(Collator 에서 맨 앞)", () => {
    const asc = ['kim', '', 'lee'].map(sortKeyOf).sort(compareKeys).map((k) => k.v ?? '');
    expect(asc.at(-1)).toBe('');
    for (const f of ['../issues/Issues.jsx', '../issues/IssuesPlus.jsx']) {
      const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), f), 'utf8');
      expect(src.includes("'~'")).toBe(false);
    }
  });
});
