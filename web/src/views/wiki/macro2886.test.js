/**
 * macro2886.test.js — v2.889 C-4 · C-5: 매크로 줄 해석 · 마크다운 블록 · 첨부 주소(attach:) · 인라인 댓글 인용 정리 · 첨부 문구.
 */
import { describe, it, expect } from 'vitest';
import { parseMacroLine, issuesMacroArgs, includeTarget, MACROS } from './macro.js';
import { parseMarkdown, parseInline, attachId, safeHref } from './markdown.js';
import { quoteText, exportMarkdownName } from './wikiExport.js';
import { attachSizeText, attachFailText, attachMarkdown } from '../attach/attachText.js';

describe('매크로 줄', () => {
  it('아는 이름만 · 줄 통째로 · 인자(따옴표 · 키=값 · 위치)', () => {
    expect(parseMacroLine('{{issues query="type = incident AND status != done" limit=5}}')).toEqual({ name: 'issues', args: { _: [], query: 'type = incident AND status != done', limit: '5' } });
    expect(parseMacroLine('   {{include W12}}  ')).toEqual({ name: 'include', args: { _: ['W12'] } });
    expect(parseMacroLine('{{vcenters}}')).toEqual({ name: 'vcenters', args: { _: [] } });
    for (const bad of ['{{issue}}', '{{unknown}}', '문장 안 {{vcenters}}', '{{vcenters}} 뒤 글', '    {{vcenters}}', '{{issues query="닫히지 않음}}', '{{issues {x}}}', `{{issues q="${'x'.repeat(400)}"}}`]) {
      expect(parseMacroLine(bad), bad).toBe(null);
    }
    expect(MACROS).toEqual(['issues', 'include', 'vcenters', 'partfaults']);
  });
  it('인자 정리', () => {
    expect(issuesMacroArgs({ _: [] })).toEqual({ query: 'status != done ORDER BY updated DESC', limit: 10 });
    expect(issuesMacroArgs({ _: [], query: 'type = epic', limit: '99' })).toEqual({ query: 'type = epic', limit: 10 });
    expect(includeTarget({ _: ['w7'] })).toBe('W7');
    expect(includeTarget({ _: ['../x'] })).toBe(null);
  });
  it('마크다운 블록 — 코드 안 · 문장 안은 매크로가 아니다', () => {
    const doc = parseMarkdown('{{issues limit=3}}\n\n```\n{{vcenters}}\n```\n\n글 {{vcenters}}\n\n{{partfaults}}');
    expect(doc.blocks.map((b) => b.t)).toEqual(['macro', 'code', 'p', 'macro']);
    expect(doc.blocks[0]).toMatchObject({ name: 'issues', args: { limit: '3' } });
  });
  it('선형 시간 — 긴 줄 · 여는 괄호 반복', () => {
    const t0 = performance.now(); parseMarkdown(`{{${'{'.repeat(50_000)}`); parseMarkdown(`{{issues ${'a '.repeat(30_000)}}}`);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe('첨부 주소', () => {
  const id = 'a'.repeat(32);
  it('attach:<32자 hex> 만 — 링크 · 그림 노드에 attach id', () => {
    expect(attachId(`attach:${id}`)).toBe(id);
    expect(attachId('attach:../../x')).toBe(null);
    expect(attachId(`attach:${id}x`)).toBe(null);
    expect(safeHref(`attach:${id}`)).toBe(null, '일반 링크로는 허용하지 않는다(화면이 인증 붙여 받는다)');
    const a = parseInline(`[보고서](attach:${id})`).find((n) => n.t === 'a');
    expect(a).toMatchObject({ attach: id, href: '' });
    const img = parseInline(`![화면](attach:${id})`).find((n) => n.t === 'img');
    expect(img).toMatchObject({ attach: id, src: '' });
    expect(parseInline('[x](attach:zzz)').some((n) => n.t === 'a')).toBe(false);
  });
  it('첨부 문구', () => {
    expect(attachSizeText(8 * 1024 * 1024)).toBe('8.0 MB');
    expect(attachSizeText(2048 * 1024 * 1024)).toBe('2.0 GB');
    expect(attachSizeText(1536)).toBe('2 KB');
    expect(attachSizeText(null)).toBe('—');
    expect(attachFailText({ status: 413 }, { fileBytes: 8 * 1024 * 1024 })).toMatch(/8.0 MB/);
    expect(attachFailText({ code: 'attach-full', used: 1024, max: 2048 })).toMatch(/1 KB \/ 2 KB/);
    expect(attachMarkdown({ id, name: '그[림].png', image: true })).toBe(`![그림.png](attach:${id})`);
    expect(attachMarkdown({ id, name: 'a.pdf', image: false })).toBe(`[a.pdf](attach:${id})`);
  });
});

describe('인라인 댓글 · 내보내기', () => {
  it('인용 정리 — 공백 하나 · 2글자 미만은 빈 값 · 상한', () => {
    expect(quoteText('  첫\n\n 문단  ')).toBe('첫 문단');
    expect(quoteText('a')).toBe('');
    expect(quoteText('가'.repeat(300), 200)).toHaveLength(200);
    expect(quoteText('가'.repeat(300), 200).endsWith('…')).toBe(true);
  });
  it('.md 이름', () => {
    expect(exportMarkdownName({ id: 'W12', title: '런북: vCenter / 재시작?' })).toBe('W12-런북__vCenter___재시작_.md');
  });
});
