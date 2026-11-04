/**
 * markdown.test.js — 위키 마크다운 파서(v2.881): 안전(HTML · 위험 주소) · 기능 · 선형 시간(ReDoS 회귀는 비율로).
 */
import { describe, it, expect } from 'vitest';
import { parseMarkdown, parseInline, safeHref, safeImg, inlineText, issueKeysIn } from './markdown.js';

const flat = (nodes, out = []) => { for (const n of nodes || []) { out.push(n); if (n.c) flat(n.c, out); } return out; };
const allInline = (doc) => {
  const out = [];
  const walk = (bs) => {
    for (const b of bs) {
      if (b.inl) flat(b.inl, out);
      if (b.title) flat(b.title, out);
      if (b.head) b.head.forEach((c) => flat(c, out));
      if (b.rows) b.rows.forEach((r) => r.forEach((c) => flat(c, out)));
      if (b.items) b.items.forEach((it) => { flat(it.inl, out); walk(it.children); });
      if (b.blocks) walk(b.blocks);
    }
  };
  walk(doc.blocks);
  return out;
};

describe('안전 — HTML 은 글자, 위험 주소는 링크가 아니다', () => {
  it('HTML 태그 · 이벤트 속성은 text 마디로만 남는다', () => {
    const doc = parseMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<a href="javascript:alert(1)">x</a>');
    const nodes = allInline(doc);
    expect(nodes.every((n) => ['text', 'br', 'a', 'i', 'b'].includes(n.t))).toBe(true);
    expect(nodes.filter((n) => n.t === 'a')).toEqual([]);
    expect(nodes.filter((n) => n.t === 'text').map((n) => n.v).join('')).toContain('<script>alert(1)</script>');
  });
  it('javascript: · data: · vbscript: · 대소문자 · 앞 공백 주소는 링크가 되지 않는다', () => {
    for (const u of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:msgbox', '//evil.example/x', 'mailto:a@b.c?x=1:2', 'file:///etc/passwd']) {
      expect(safeHref(u), u).toBe(null);
      const nodes = flat(parseInline(`[누르기](${u})`));
      expect(nodes.some((n) => n.t === 'a'), u).toBe(false);
    }
  });
  it('안전한 주소만 링크 — http(s) · 포탈 주소 · mailto', () => {
    expect(safeHref('https://a.example/x?y=1')).toBe('https://a.example/x?y=1');
    expect(safeHref('#/issues/list/ISS-3')).toBe('#/issues/list/ISS-3');
    expect(safeHref('mailto:ops@example.com')).toBe('mailto:ops@example.com');
    const a = flat(parseInline('[보드](#/issues/board)')).find((n) => n.t === 'a');
    expect(a).toMatchObject({ href: '#/issues/board', ext: false });
    const e = flat(parseInline('[외부](https://example.com)')).find((n) => n.t === 'a');
    expect(e.ext).toBe(true);
  });
  it('그림은 같은 출처 경로와 data:image(png/jpeg/gif/webp)만 — 바깥 주소 · svg 는 그림이 아니다', () => {
    expect(safeImg('/api/x.png')).toBe('/api/x.png');
    expect(safeImg('data:image/png;base64,iVBORw0KGgo=')).toBeTruthy();
    expect(safeImg('//evil.example/x.png')).toBe(null);
    expect(safeImg('https://evil.example/x.png')).toBe(null);
    expect(safeImg('data:image/svg+xml;base64,PHN2Zz4=')).toBe(null);
    const n = flat(parseInline('![그림](https://evil.example/t.png)'));
    expect(n.some((x) => x.t === 'img')).toBe(false);
    expect(n.find((x) => x.t === 'a').href).toBe('https://evil.example/t.png'); // CSP 가 막는 바깥 그림은 링크로 내린다
  });
});

describe('기능', () => {
  const md = [
    '# 제목 #', '[[toc]]', '', '**굵게** *기울임* ~~취소~~ `코드` ISS-12 @kim [[W3|런북]] [[운영 절차]] https://x.example/a.', '',
    '- 하나', '  - 중첩', '- [x] 끝남', '- [ ] 남음', '', '3. 셋', '4. 넷', '',
    '| 이름 | 값 |', '|:--|--:|', '| a \\| b | 1 |', '', '```bash', 'echo **안 굵게**', '```', '',
    '> 인용', '', ':::danger 위험', '본문', ':::', '', ':::fold 더 보기', '숨김', ':::', '', '---', '각주[^n]', '', '[^n]: 설명',
  ].join('\n');
  const doc = parseMarkdown(md);
  const types = doc.blocks.map((b) => b.t);
  it('블록 종류', () => {
    expect(types).toEqual(['h', 'toc', 'p', 'ul', 'ol', 'table', 'code', 'quote', 'callout', 'fold', 'hr', 'p']);
    expect(doc.blocks[0]).toMatchObject({ level: 1, id: 'wh-1' });
    expect(inlineText(doc.blocks[0].inl)).toBe('제목');
  });
  it('인라인 — 강조 · 코드 · 이슈 · 멘션 · 문서 링크 · 맨 주소(문장 끝 마침표 제외)', () => {
    const p = flat(doc.blocks[2].inl);
    expect(p.map((n) => n.t)).toEqual(expect.arrayContaining(['b', 'i', 's', 'code', 'iss', 'mention', 'page', 'a']));
    expect(p.find((n) => n.t === 'iss').key).toBe('ISS-12');
    expect(p.find((n) => n.t === 'mention').user).toBe('kim');
    expect(p.filter((n) => n.t === 'page').map((n) => [n.ref, n.label])).toEqual([['W3', '런북'], ['운영 절차', '']]);
    expect(p.find((n) => n.t === 'a').href).toBe('https://x.example/a');
  });
  it('목록 — 중첩 · 체크리스트 · 시작 번호', () => {
    const ul = doc.blocks[3];
    expect(ul.items.map((i) => i.task)).toEqual([null, true, false]);
    expect(ul.items[0].children[0].t).toBe('ul');
    expect(doc.blocks[4].start).toBe(3);
  });
  it('표 — 정렬 · 이스케이프한 |', () => {
    const t = doc.blocks[5];
    expect(t.align).toEqual(['left', 'right']);
    expect(inlineText(t.rows[0][0])).toBe('a | b');
  });
  it('코드 블록 안은 해석하지 않는다', () => {
    expect(doc.blocks[6]).toMatchObject({ lang: 'bash', text: 'echo **안 굵게**' });
  });
  it('콜아웃 · 접기 · 각주', () => {
    expect(doc.blocks[8]).toMatchObject({ t: 'callout', kind: 'danger' });
    expect(doc.blocks[9].t).toBe('fold');
    expect(doc.footnotes).toEqual([{ id: 'n', n: 1, inl: [{ t: 'text', v: '설명' }] }]);
  });
  it('밑줄 _ 은 낱말 안에서 강조가 아니다(snake_case)', () => {
    expect(flat(parseInline('vm_host_name 과 _강조_')).filter((n) => n.t === 'i').length).toBe(1);
  });
  it('닫히지 않은 울타리 · 콜아웃은 끝까지', () => {
    expect(parseMarkdown('```\na\nb').blocks).toEqual([{ t: 'code', lang: '', text: 'a\nb' }]);
    expect(parseMarkdown(':::info\n본문').blocks[0].t).toBe('callout');
  });
  it('이슈 키 모으기 — 중복 제거 · 50개 상한', () => {
    expect(issueKeysIn('ISS-1 ISS-2 ISS-1 xISS-3')).toEqual(['ISS-1', 'ISS-2']);
    expect(issueKeysIn(Array.from({ length: 80 }, (_, i) => `ISS-${i}`).join(' ')).length).toBe(50);
  });
});

describe('선형 시간 — 병적인 입력이 2배가 되면 시간도 대략 2배(제곱이면 4배)', () => {
  // 3회 중 최솟값 — GC · JIT 한 번의 튐이 비율을 흔들지 않게
  const time = (fn) => { let best = Infinity; for (let k = 0; k < 3; k += 1) { const t0 = performance.now(); fn(); best = Math.min(best, performance.now() - t0); } return best; };
  const cases = {
    '닫히지 않은 [': (n) => '['.repeat(n),
    '[[ 반복': (n) => '[['.repeat(n / 2),
    '* 반복': (n) => '* '.repeat(n / 2),
    '** 반복': (n) => '**a '.repeat(n / 4),
    '` 반복': (n) => '`a'.repeat(n / 2),
    '공백 뒤 글자(제목)': (n) => `# ${' #'.repeat(n / 2)}x`,
    '울타리 뒤 공백': (n) => `\`\`\`${' '.repeat(n)}!`,
    '표 구분 공백': (n) => `a|b\n|---|---${' '.repeat(n)}x`,
    '줄 끝 공백 줄바꿈': (n) => `a${' '.repeat(n)}b  \nc`,
    '중첩 인용': (n) => '>'.repeat(n),
    '깊은 목록': (n) => Array.from({ length: n / 40 }, (_, i) => `${' '.repeat((i % 6) * 2)}- x`).join('\n'),
  };
  for (const [name, gen] of Object.entries(cases)) {
    it(name, () => {
      const small = gen(16_000); const big = gen(32_000);
      parseMarkdown(small); // 데우기
      const a = Math.max(1, time(() => parseMarkdown(small)));
      const b = time(() => parseMarkdown(big));
      expect(b, `${name}: ${a.toFixed(1)}ms → ${b.toFixed(1)}ms`).toBeLessThan(Math.max(a * 3.2, 60));
    });
  }
});
