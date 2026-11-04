/**
 * wikiExport.js — 위키 문서 인라인 댓글 선택 · 찾기 · 내보내기(v2.886 · C-5). DOM 을 읽기만 한다(innerHTML 로 그리지 않는다 —
 * 인쇄 창은 React 가 이미 글자로 넣은 문서 DOM 을 복제해 싣는다).
 */

/** 본문 안에서 고른 글 → { text(공백 하나로 · 상한), rect } · 본문 밖이거나 비었으면 null. */
export function selectionQuote(sel, container, max = 200) {
  if (!sel || sel.isCollapsed || !container || sel.rangeCount < 1) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const text = quoteText(sel.toString(), max);
  if (!text) return null;
  return { text, rect: range.getBoundingClientRect() };
}
/** 글 정리(순수) — 공백 하나로 · 앞뒤 공백 제거 · 상한(넘으면 자르고 '…'). 2글자 미만은 ''. */
export function quoteText(raw, max = 200) {
  const t = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (t.length < 2) return '';
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** 본문에서 인용 글을 찾아 고르고 그 자리로 스크롤 — 찾으면 true. 잘린 인용('…')은 앞부분으로 찾는다. */
export function findQuote(container, quote) {
  if (!container || !quote) return false;
  const needle = String(quote).replace(/…$/, '').slice(0, 120);
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes = []; let joined = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) { nodes.push({ n, at: joined.length }); joined += n.nodeValue; }
  const norm = (s) => s.replace(/\s+/g, ' ');
  // 공백을 정리한 글에서 찾고, 원래 위치로 되돌린다(공백 정리로 줄어든 길이를 따라간다)
  const map = []; let flat = '';
  for (let i = 0; i < joined.length; i += 1) { const ch = /\s/.test(joined[i]) ? ' ' : joined[i]; if (ch === ' ' && flat.endsWith(' ')) continue; map.push(i); flat += ch; }
  const k = flat.indexOf(norm(needle));
  if (k < 0) return false;
  const startAbs = map[k]; const endAbs = map[Math.min(map.length - 1, k + norm(needle).length - 1)] + 1;
  const locate = (abs) => { let last = nodes[0]; for (const x of nodes) { if (x.at > abs) break; last = x; } return { node: last.n, off: Math.min(abs - last.at, last.n.nodeValue.length) }; };
  const a = locate(startAbs); const b = locate(endAbs);
  const range = document.createRange();
  range.setStart(a.node, a.off); range.setEnd(b.node, b.off);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  (a.node.parentElement || container).scrollIntoView({ behavior: 'smooth', block: 'center' });
  return true;
}

/** .md 파일 이름 — 'W12-런북_vCenter_재시작.md'(파일 이름에 못 쓰는 글자는 _). */
export function exportMarkdownName(page) {
  const t = String(page?.title || '문서').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, '_').slice(0, 80);
  return `${page?.id || 'W'}-${t}.md`;
}

/**
 * 인쇄 · PDF — 지금 보이는 문서 DOM(매크로 값 · 첨부 그림 포함)을 새 창에 복제해 인쇄한다. 앱 머리 · 옆 칸은 싣지 않는다.
 * 첨부 상자 · 고르기 단추 · 매크로의 '다시 읽기' 는 뺀다. 스타일은 지금 문서의 것을 그대로 쓴다.
 */
export function printDocument(el, title, sub = '') {
  if (!el) return false;
  const w = window.open('', '_blank');
  if (!w) return false;
  const clone = el.cloneNode(true);
  for (const x of clone.querySelectorAll('.attach-box, .wiki-pick, .md-macro-head button, .md-copy, input[type=checkbox]')) x.remove();
  const d = w.document;
  d.open(); d.write('<!doctype html><html lang="ko"><head><meta charset="utf-8"><title></title></head><body class="wiki-print"></body></html>'); d.close();
  d.title = title || '문서';
  for (const n of document.querySelectorAll('link[rel="stylesheet"], style')) d.head.appendChild(n.cloneNode(true));
  const h = d.createElement('h1'); h.textContent = title || ''; h.className = 'wiki-print-title';
  const s = d.createElement('div'); s.textContent = sub; s.className = 'wiki-print-sub';
  d.body.appendChild(h); d.body.appendChild(s); d.body.appendChild(d.importNode(clone, true));
  setTimeout(() => { try { w.focus(); w.print(); } catch { /* 인쇄 창을 막는 브라우저 — 창은 열려 있다 */ } }, 400);
  return true;
}
