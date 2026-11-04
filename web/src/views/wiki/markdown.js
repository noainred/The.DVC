/**
 * views/wiki/markdown.js — 위키 본문 마크다운 → 구문 나무(순수, v2.881). 그리기는 MdView.jsx 가 React 요소로 한다.
 *
 * 안전(시안 §4.1 '렌더러 sanitize'):
 *  · **HTML 은 해석하지 않는다** — `<script>` 든 `<b>` 든 글자 그대로다(React 가 글자로 넣는다 · innerHTML 을 쓰지 않는다).
 *  · 링크는 `http(s)://` · 포탈 주소 `#/…` · `mailto:` 만 링크가 된다. 그 밖(`javascript:` · `data:` · `vbscript:` · 상대 경로 꾀기)은 글자로 남긴다.
 *  · 그림은 CSP(`img-src 'self' data: blob:`)가 허락하는 것만 — 같은 출처 경로(`/…`)와 `data:image/(png|jpeg|gif|webp)`. 바깥 주소 그림은 링크로 내린다.
 *  · 정규식은 앵커가 있고 길이가 묶인 것만 쓴다. 인라인 짝 찾기는 앞으로만 훑고, 닫는 짝이 없는 기호는 한 번 확인한 뒤 다시 훑지 않는다(선형).
 *
 * 지원: 제목(# ~ ######) · 문단 · 줄바꿈(줄 끝 공백 둘 또는 `\`) · 목록(- * + · 1.) 중첩 · 체크리스트(- [ ] / - [x]) · 표(정렬 `:--:`) · 코드 블록(``` 언어) ·
 * 인용(>) · 구분선(---) · 콜아웃(:::info|warn|danger|tip [제목]) · 접기(:::fold 제목) · 목차([[toc]]) · 각주([^1] · [^1]: 설명) ·
 * 인라인: **굵게** · *기울임* · ~~취소~~ · `코드` · [글](주소) · ![그림](주소) · 맨 주소 · ISS-n · [[W12]] · [[W12|글]] · [[문서 제목]] · @사람.
 */

import { parseMacroLine, MACRO_LIMITS } from './macro.js';
export const MAX_DEPTH = 6;               // 블록 중첩(인용 · 목록 · 콜아웃) 상한 — 깊은 중첩으로 재귀가 폭주하지 않게
export const LINK_WINDOW = 300;           // [글](주소) 의 글 · 주소를 찾는 거리 상한
export const CALLOUTS = Object.freeze(['info', 'warn', 'danger', 'tip']);
const MAX_INPUT = 200_000;
/** 줄 하나 바꿈을 줄바꿈으로(이슈 본문 · 댓글 — 사람이 평문으로 쓴 글이 한 줄로 붙지 않게). parseMarkdown 이 호출 동안만 켠다(동기). */
let BREAKS = false;

/* ───── 주소 판정 ───── */
const SAFE_HREF_RE = /^(https?:\/\/[^\s<>"'`]{1,2000}|#\/[^\s<>"'`]{0,2000}|mailto:[^\s<>"'`:/]{1,200})$/i;
const SAFE_IMG_RE = /^(\/(?!\/)[^\s<>"'`]{0,2000}|data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]{1,200000})$/i;
/** 링크로 쓸 수 있는 주소인가 — 아니면 null. */
export function safeHref(u) {
  const s = String(u ?? '').trim();
  return SAFE_HREF_RE.test(s) ? s : null;
}
/** v2.887 첨부 주소 — 'attach:<32자 hex>'. 화면이 인증 붙여 받아 그린다(주소창 · <img src> 로 직접 열면 인증이 없다). 아니면 null. */
const ATTACH_RE = /^attach:([a-f0-9]{32})$/;
export function attachId(u) { const m = ATTACH_RE.exec(String(u ?? '').trim()); return m ? m[1] : null; }
export function safeImg(u) {
  const s = String(u ?? '').trim();
  return SAFE_IMG_RE.test(s) ? s : null;
}
export const isExternal = (href) => /^https?:\/\//i.test(String(href || ''));

/* ───── 인라인 ───── */
const ISS_RE = /^ISS-\d{1,9}/;
const URL_HEAD_RE = /^https?:\/\/[^\s<>"'`]{1,2000}/i;
const MENTION_RE = /^@([^\s@,()[\]*`~]{1,64})/;
const FN_REF_RE = /^\[\^([A-Za-z0-9_-]{1,30})\]/;
const isWordChar = (ch) => !!ch && /[\p{L}\p{N}_]/u.test(ch);

/** 같은 기호로 여닫는 짝(**, ~~, `, *, _) 을 찾는다 — 없으면 -1. miss 는 '이 기호의 닫는 짝은 이 뒤에 없다' 기억(선형 보장). */
function findClose(s, tok, from, miss) {
  if (miss[tok] != null && from >= miss[tok]) return -1;
  const j = s.indexOf(tok, from);
  if (j < 0) miss[tok] = from;
  return j;
}
/** 묶인 거리 안에서 ch 를 찾는다(줄바꿈은 넘지 않는다) — 없으면 -1. */
function findWithin(s, ch, from, max = LINK_WINDOW) {
  const end = Math.min(s.length, from + max);
  for (let i = from; i < end; i += 1) { if (s[i] === ch) return i; if (s[i] === '\n') return -1; }
  return -1;
}

/** ']]' 같은 두 글자 짝을 묶인 거리 안에서(줄바꿈 전까지) 찾는다. */
function findPair(s, ch, from, max) {
  const end = Math.min(s.length - 1, from + max);
  for (let i = from; i < end; i += 1) { if (s[i] === '\n') return -1; if (s[i] === ch && s[i + 1] === ch) return i; }
  return -1;
}

/**
 * 인라인 글 → 마디 배열. 마디: text · b · i · s · code · a · img · iss · page · mention · fn · br.
 * depth 는 강조 중첩 상한(같은 글을 다시 훑는 횟수를 묶는다).
 */
export function parseInline(src, depth = 0) {
  const s = String(src ?? '');
  const out = [];
  const miss = {};
  let buf = '';
  const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } };
  const push = (node) => { flush(); out.push(node); };
  const inner = (txt) => (depth >= 4 ? [{ t: 'text', v: txt }] : parseInline(txt, depth + 1));
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    const prev = i > 0 ? s[i - 1] : '';
    // 역슬래시 — 다음 기호를 글자로(줄 끝이면 줄바꿈)
    if (ch === '\\') {
      if (s[i + 1] === '\n') { push({ t: 'br' }); i += 2; continue; }
      if (i + 1 < s.length && /[\\`*_~[\]()#!@>|:{}+.-]/.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
    }
    if (ch === '\n') {
      // 줄 끝 공백 둘 = 줄바꿈, 아니면 공백 하나
      if (BREAKS || buf.endsWith('  ')) { buf = buf.trimEnd(); push({ t: 'br' }); } else buf += ' ';
      i += 1; continue;
    }
    if (ch === '`') {
      let n = 1; while (s[i + n] === '`' && n < 3) n += 1;
      const tok = '`'.repeat(n);
      const j = findClose(s, tok, i + n, miss);
      if (j > i + n) { push({ t: 'code', v: s.slice(i + n, j).replace(/^ (.+) $/, '$1') }); i = j + n; continue; }
      buf += tok; i += n; continue;
    }
    if (ch === '*' && s[i + 1] === '*') {
      const j = findClose(s, '**', i + 2, miss);
      if (j > i + 2 && s[i + 2] !== ' ') { push({ t: 'b', c: inner(s.slice(i + 2, j)) }); i = j + 2; continue; }
      buf += '**'; i += 2; continue;
    }
    if (ch === '~' && s[i + 1] === '~') {
      const j = findClose(s, '~~', i + 2, miss);
      if (j > i + 2) { push({ t: 's', c: inner(s.slice(i + 2, j)) }); i = j + 2; continue; }
      buf += '~~'; i += 2; continue;
    }
    if ((ch === '*' || ch === '_') && s[i + 1] !== ' ' && s[i + 1] !== ch && !(ch === '_' && isWordChar(prev))) {
      const j = findClose(s, ch, i + 1, miss);
      if (j > i + 1 && s[j - 1] !== ' ' && !(ch === '_' && isWordChar(s[j + 1])) && s.slice(i + 1, j).indexOf('\n') < 0) {
        push({ t: 'i', c: inner(s.slice(i + 1, j)) }); i = j + 1; continue;
      }
      buf += ch; i += 1; continue;
    }
    if (ch === '!' && s[i + 1] === '[') {
      const close = findWithin(s, ']', i + 2);
      if (close > 0 && s[close + 1] === '(') {
        const end = findWithin(s, ')', close + 2);
        if (end > 0) {
          const alt = s.slice(i + 2, close); const url = s.slice(close + 2, end).trim();
          const img = safeImg(url);
          const att = attachId(url);
          if (att) push({ t: 'img', attach: att, src: '', alt }); // v2.887 첨부 그림
          else if (img) push({ t: 'img', src: img, alt });
          else { const href = safeHref(url); push(href ? { t: 'a', href, ext: isExternal(href), c: [{ t: 'text', v: `그림: ${alt || url}` }] } : { t: 'text', v: s.slice(i, end + 1) }); }
          i = end + 1; continue;
        }
      }
    }
    if (ch === '[') {
      if (s[i + 1] === '[') {
        const end = findPair(s, ']', i + 2, 200);
        if (end > i + 2) {
          const raw = s.slice(i + 2, end);
          const bar = raw.indexOf('|');
          const ref = (bar >= 0 ? raw.slice(0, bar) : raw).trim();
          const label = bar >= 0 ? raw.slice(bar + 1).trim() : '';
          if (ref && ref.toLowerCase() !== 'toc') { push({ t: 'page', ref, label }); i = end + 2; continue; }
        }
      }
      const fn = FN_REF_RE.exec(s.slice(i, i + 34));
      if (fn) { push({ t: 'fn', id: fn[1] }); i += fn[0].length; continue; }
      const close = findWithin(s, ']', i + 1);
      if (close > i + 1 && s[close + 1] === '(') {
        const end = findWithin(s, ')', close + 2);
        if (end > 0) {
          const href = safeHref(s.slice(close + 2, end));
          const label = s.slice(i + 1, close);
          const att = attachId(s.slice(close + 2, end));
          if (att) { push({ t: 'a', attach: att, href: '', ext: false, c: inner(label) }); i = end + 1; continue; } // v2.887 첨부 링크
          if (href) { push({ t: 'a', href, ext: isExternal(href), c: inner(label) }); i = end + 1; continue; }
          // 안전하지 않은 주소 — 글만 남기고 주소는 버린다(무엇을 버렸는지는 보이게 글자로)
          buf += `${label} (${s.slice(close + 2, end)})`; i = end + 1; continue;
        }
      }
      buf += ch; i += 1; continue;
    }
    if ((ch === 'h' || ch === 'H') && !isWordChar(prev)) {
      const m = URL_HEAD_RE.exec(s.slice(i, i + 2010));
      if (m) {
        let url = m[0];
        while (url.length > 8 && '.,;:!?)]'.includes(url[url.length - 1])) url = url.slice(0, -1); // 문장 끝 기호는 주소가 아니다
        push({ t: 'a', href: url, ext: true, c: [{ t: 'text', v: url }] }); i += url.length; continue;
      }
    }
    if (ch === 'I' && !isWordChar(prev)) {
      const m = ISS_RE.exec(s.slice(i, i + 13));
      if (m && !isWordChar(s[i + m[0].length])) { push({ t: 'iss', key: m[0] }); i += m[0].length; continue; }
    }
    if (ch === '@' && (!prev || /[\s(]/.test(prev))) {
      const m = MENTION_RE.exec(s.slice(i, i + 66));
      if (m) { push({ t: 'mention', user: m[1] }); i += m[0].length; continue; }
    }
    buf += ch; i += 1;
  }
  flush();
  return out;
}

/** 인라인 마디 → 순수 글(목차 · 제목 비교용). */
export function inlineText(nodes) {
  let out = '';
  for (const n of nodes || []) {
    if (n.t === 'text' || n.t === 'code') out += n.v;
    else if (n.t === 'iss') out += n.key;
    else if (n.t === 'mention') out += `@${n.user}`;
    else if (n.t === 'page') out += n.label || n.ref;
    else if (n.t === 'img') out += n.alt || '';
    else if (n.t === 'br') out += ' ';
    else if (n.c) out += inlineText(n.c);
  }
  return out;
}

/* ───── 블록 ───── */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})([^`]*)$/;
const HR_RE = /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/;
const LIST_RE = /^( {0,12})([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const TASK_RE = /^\[([ xX])\][ \t]+(.*)$/;
const QUOTE_RE = /^ {0,3}>[ ]?(.*)$/;
const CONTAINER_RE = /^ {0,3}:::[ \t]*(info|warn|danger|tip|fold)\b[ \t]*(.*)$/i;
const CONTAINER_END_RE = /^ {0,3}:::[ \t]*$/;
const TOC_RE = /^ {0,3}\[\[toc\]\][ \t]*$/i;
const FN_DEF_RE = /^ {0,3}\[\^([A-Za-z0-9_-]{1,30})\]:[ \t]*(.*)$/;

/** 제목 줄 — { level, text } 또는 null. 정규식 대신 손으로(뒤쪽 공백 · # 을 겹쳐 훑는 역추적이 생기지 않게). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line[n] === '#' && n < 7) n += 1;
  if (n < 1 || n > 6) return null;
  if (n < line.length && line[n] !== ' ') return null;
  let t = line.slice(n).trim();
  let e = t.length;
  while (e > 0 && t[e - 1] === '#') e -= 1;
  if (e < t.length && (e === 0 || t[e - 1] === ' ')) t = t.slice(0, e).trim(); // 닫는 # 들(앞에 공백이 있을 때만)
  return { level: n, text: t };
}
/** 울타리 줄 — { mark, lang } 또는 null. 언어는 첫 낱말만(30자 · 안전한 글자). */
function fenceOf(line) {
  const m = FENCE_RE.exec(line);
  if (!m) return null;
  const word = m[2].trim().split(' ')[0].slice(0, 30);
  return { mark: m[1], lang: /^[\w+#.-]+$/.test(word) ? word : '' };
}
/** 닫는 울타리 — 같은 기호 · 같거나 긴 길이 · 뒤에 공백만. */
function closesFence(line, mark) {
  const t = line.trim();
  if (t.length < mark.length) return false;
  for (let k = 0; k < t.length; k += 1) if (t[k] !== mark[0]) return false;
  return true;
}
/** 표 구분 줄 — 칸마다 :?-+:? (손으로 — 공백 수량자가 겹치지 않게). */
function isTableSep(line) {
  if (!line.includes('-') || line.length > 4000) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

const isBlank = (l) => l.trim() === '';
function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < t.length; i += 1) {
    if (t[i] === '\\' && t[i + 1] === '|') { cur += '|'; i += 1; continue; }
    if (t[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += t[i];
  }
  cells.push(cur.trim());
  return cells;
}
const startsBlock = (l) => !!headingOf(l) || FENCE_RE.test(l) || HR_RE.test(l) || LIST_RE.test(l) || QUOTE_RE.test(l) || CONTAINER_RE.test(l) || TOC_RE.test(l) || FN_DEF_RE.test(l);

/**
 * 블록 줄 배열 → 블록 마디. ctx = { footnotes: Map, headings: [] } — 문서 전체가 공유한다.
 */
function parseBlocks(lines, ctx, depth, nos = null) {
  const no = (k) => (nos ? nos[k] : k); // 원문 줄 번호(0부터) — 체크리스트 체크가 그 줄을 고친다
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i += 1; continue; }
    // 코드 블록
    const fence = fenceOf(line);
    if (fence) {
      const body = [];
      i += 1;
      while (i < lines.length && !closesFence(lines[i], fence.mark)) { body.push(lines[i]); i += 1; }
      i += 1; // 닫는 울타리(없으면 끝까지)
      out.push({ t: 'code', lang: fence.lang, text: body.join('\n') });
      continue;
    }
    if (TOC_RE.test(line)) { out.push({ t: 'toc' }); i += 1; continue; }
    // v2.887 포탈 매크로 — 줄 하나가 통째로 {{이름 …}} 이고 아는 이름일 때만(macro.js)
    if (line.length <= MACRO_LIMITS.line && line.includes('{{')) { const mc = parseMacroLine(line); if (mc) { out.push({ t: 'macro', name: mc.name, args: mc.args }); i += 1; continue; } }
    const h = headingOf(line);
    if (h) {
      const inl = parseInline(h.text);
      const node = { t: 'h', level: h.level, id: `wh-${ctx.headings.length + 1}`, inl };
      ctx.headings.push({ level: node.level, id: node.id, text: inlineText(inl) });
      out.push(node); i += 1; continue;
    }
    if (HR_RE.test(line) && !LIST_RE.test(line)) { out.push({ t: 'hr' }); i += 1; continue; }
    // 콜아웃 · 접기
    const ct = CONTAINER_RE.exec(line);
    if (ct) {
      const kind = ct[1].toLowerCase();
      const inner = []; const innerNo = [];
      let nest = 0;
      i += 1;
      while (i < lines.length) {
        if (CONTAINER_RE.test(lines[i])) nest += 1;
        else if (CONTAINER_END_RE.test(lines[i])) { if (nest === 0) break; nest -= 1; }
        inner.push(lines[i]); innerNo.push(no(i)); i += 1;
      }
      i += 1;
      const blocks = depth >= MAX_DEPTH ? [{ t: 'p', inl: [{ t: 'text', v: inner.join('\n') }] }] : parseBlocks(inner, ctx, depth + 1, innerNo);
      out.push(kind === 'fold' ? { t: 'fold', title: parseInline(ct[2] || '펼치기'), blocks } : { t: 'callout', kind, title: ct[2] ? parseInline(ct[2]) : null, blocks });
      continue;
    }
    // 각주 정의
    const fd = FN_DEF_RE.exec(line);
    if (fd) {
      const text = [fd[2]];
      i += 1;
      while (i < lines.length && /^( {2,}|\t)\S/.test(lines[i])) { text.push(lines[i].trim()); i += 1; }
      if (!ctx.footnotes.has(fd[1])) ctx.footnotes.set(fd[1], parseInline(text.join(' ')));
      continue;
    }
    // 인용
    if (QUOTE_RE.test(line)) {
      const inner = []; const innerNo = [];
      while (i < lines.length && !isBlank(lines[i]) && (QUOTE_RE.test(lines[i]) || !startsBlock(lines[i]))) {
        const m = QUOTE_RE.exec(lines[i]);
        inner.push(m ? m[1] : lines[i]); innerNo.push(no(i)); i += 1;
      }
      out.push({ t: 'quote', blocks: depth >= MAX_DEPTH ? [{ t: 'p', inl: [{ t: 'text', v: inner.join('\n') }] }] : parseBlocks(inner, ctx, depth + 1, innerNo) });
      continue;
    }
    // 목록
    const lm = LIST_RE.exec(line);
    if (lm) {
      const base = lm[1].length;
      const ordered = /\d/.test(lm[2]);
      const items = [];
      let start = ordered ? parseInt(lm[2], 10) : null;
      if (!Number.isFinite(start)) start = null;
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]);
        if (!m || m[1].length !== base || /\d/.test(m[2]) !== ordered) break;
        const first = m[3];
        const headNo = no(i);
        const indent = base + m[2].length + 1;
        const sub = []; const subNo = [];
        i += 1;
        while (i < lines.length) {
          const l = lines[i];
          if (isBlank(l)) {
            // 빈 줄 뒤에 들여쓴 줄이 이어지면 같은 항목
            if (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && (lines[i + 1].length - lines[i + 1].trimStart().length) > base) { sub.push(''); subNo.push(no(i)); i += 1; continue; }
            break;
          }
          const lead = l.length - l.trimStart().length;
          const lm2 = LIST_RE.exec(l);
          if (lm2 && lm2[1].length <= base) break;
          if (lead > base) { sub.push(l.slice(Math.min(lead, indent))); subNo.push(no(i)); i += 1; continue; }
          if (startsBlock(l)) break;
          sub.push(l.trimStart()); subNo.push(no(i)); i += 1; // 게으른 이어 쓰기
        }
        const task = TASK_RE.exec(first);
        const head = task ? task[2] : first;
        // 첫 줄 + 바로 이어지는 들여쓰지 않은 글은 항목 글, 나머지는 하위 블록
        const textLines = [head];
        let k = 0;
        while (k < sub.length && sub[k] !== '' && !startsBlock(sub[k])) { textLines.push(sub[k]); k += 1; }
        const rest = sub.slice(k); const restNo = subNo.slice(k);
        items.push({
          task: task ? task[1].toLowerCase() === 'x' : null,
          ...(task ? { line: headNo } : {}),
          inl: parseInline(textLines.join('\n')),
          children: rest.some((x) => !isBlank(x)) ? (depth >= MAX_DEPTH ? [{ t: 'p', inl: [{ t: 'text', v: rest.join('\n') }] }] : parseBlocks(rest, ctx, depth + 1, restNo)) : [],
        });
        if (i < lines.length && isBlank(lines[i])) {
          // 빈 줄 하나 뒤에 같은 종류 항목이 오면 목록이 이어진다
          const nx = LIST_RE.exec(lines[i + 1] || '');
          if (nx && nx[1].length === base && /\d/.test(nx[2]) === ordered) { i += 1; continue; }
          break;
        }
      }
      out.push(ordered ? { t: 'ol', start, items } : { t: 'ul', items });
      continue;
    }
    // 표 — 머리 줄 + 구분 줄
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
      const cols = head.length;
      i += 2;
      const rows = [];
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|') && rows.length < 1000) {
        const cells = splitRow(lines[i]);
        rows.push(Array.from({ length: cols }, (_, c) => parseInline(cells[c] ?? '')));
        i += 1;
      }
      out.push({ t: 'table', align: Array.from({ length: cols }, (_, c) => align[c] || ''), head: head.map((c) => parseInline(c)), rows });
      continue;
    }
    // 문단
    const para = [];
    while (i < lines.length && !isBlank(lines[i]) && (para.length === 0 || !startsBlock(lines[i]))) {
      // 다음 줄이 표 구분 줄이면 이 줄부터 표다
      if (para.length && lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) break;
      para.push(lines[i]); i += 1;
    }
    out.push({ t: 'p', inl: parseInline(para.join('\n')) });
  }
  return out;
}

/**
 * 마크다운 → { blocks, headings, footnotes:[{id,n,inl}] }.
 * 각주는 본문에서 처음 쓴 순서로 번호를 붙인다(정의만 있고 쓰지 않은 것도 끝에 싣는다).
 */
export function parseMarkdown(md, { breaks = false } = {}) {
  const src = String(md ?? '').slice(0, MAX_INPUT).replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  const ctx = { footnotes: new Map(), headings: [] };
  BREAKS = !!breaks;
  let blocks;
  try { blocks = parseBlocks(src.split('\n'), ctx, 0); } finally { BREAKS = false; }
  const order = [];
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n.t === 'fn' && !order.includes(n.id)) order.push(n.id);
      if (n.c) walk(n.c);
    }
  };
  const walkBlocks = (bs) => {
    for (const b of bs) {
      if (b.inl) walk(b.inl);
      if (b.title) walk(b.title);
      if (b.head) b.head.forEach(walk);
      if (b.rows) b.rows.forEach((r) => r.forEach(walk));
      if (b.items) b.items.forEach((it) => { walk(it.inl); walkBlocks(it.children); });
      if (b.blocks) walkBlocks(b.blocks);
    }
  };
  walkBlocks(blocks);
  for (const id of ctx.footnotes.keys()) if (!order.includes(id)) order.push(id);
  const footnotes = order.map((id, k) => ({ id, n: k + 1, inl: ctx.footnotes.get(id) || null }));
  return { blocks, headings: ctx.headings, footnotes };
}

/** 문서의 이슈 키(본문에 적힌 순서 · 중복 제거) — 화면의 '관련 이슈' 는 서버 색인(issueKeys)을 쓰고, 이건 미리보기용. */
export function issueKeysIn(md) {
  const out = [];
  const re = /\bISS-\d{1,9}\b/g;
  const s = String(md ?? '').slice(0, MAX_INPUT);
  let m;
  while ((m = re.exec(s)) && out.length < 50) if (!out.includes(m[0])) out.push(m[0]);
  return out;
}

/**
 * 체크리스트 줄의 '[ ]' 안 글자 위치 — 아니면 -1. 앞의 공백 · 인용(>) 을 건너뛰고 목록 표시(- * + · 1. 1)) 뒤 '[ ]' / '[x]' 다음 공백.
 * 서버(server/src/wiki/store.js taskMarkAt)와 같은 규칙이다 — 대조는 test/wikiIssues2883.test.js(같은 입력).
 */
export function taskMarkAt(line) {
  const s = String(line ?? '');
  if (s.length > 4000) return -1;
  let i = 0;
  for (;;) {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
    if (s[i] === '>') { i += 1; continue; }
    break;
  }
  if (s[i] === '-' || s[i] === '*' || s[i] === '+') i += 1;
  else {
    const st = i;
    while (i < s.length && i - st < 9 && s[i] >= '0' && s[i] <= '9') i += 1;
    if (i === st || (s[i] !== '.' && s[i] !== ')')) return -1;
    i += 1;
  }
  if (s[i] !== ' ' && s[i] !== '\t') return -1;
  while (s[i] === ' ' || s[i] === '\t') i += 1;
  if (s[i] !== '[' || s[i + 2] !== ']' || !(s[i + 1] === ' ' || s[i + 1] === 'x' || s[i + 1] === 'X')) return -1;
  if (s[i + 3] !== ' ' && s[i + 3] !== '\t') return -1;
  return i + 1;
}
