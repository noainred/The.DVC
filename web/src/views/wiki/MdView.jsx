/**
 * MdView — 위키 마크다운 구문 나무를 React 요소로 그린다(v2.881). **innerHTML 을 쓰지 않는다** — 모든 글은 React 가 글자로 넣는다.
 * 링크 · 그림 주소는 markdown.js 가 이미 거른 것만 온다(safeHref · safeImg). 목차 · 각주 이동은 해시를 건드리지 않고 scrollIntoView 로 한다
 * (해시는 화면 주소라 '#wh-3' 로 바꾸면 위키 화면을 떠난다).
 */
import React, { useMemo, useState } from 'react';
import { STable } from '../../components/STable.jsx';
import { parseMarkdown, inlineText } from './markdown.js';
import { resolvePageRef, wikiHash } from './wikiText.js';
import { AttachImg, AttachLink } from '../attach/AttachBox.jsx';

const CALLOUT_TEXT = Object.freeze({ info: '정보', warn: '주의', danger: '위험', tip: '팁' });

function scrollToId(id) {
  const el = typeof document !== 'undefined' ? document.getElementById(id) : null;
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function CopyButton({ text }) {
  const [done, setDone] = useState('');
  const copy = () => {
    const ok = () => { setDone('복사함'); setTimeout(() => setDone(''), 1500); };
    const no = () => { setDone('복사 못 함'); setTimeout(() => setDone(''), 2000); };
    try { if (navigator?.clipboard?.writeText) navigator.clipboard.writeText(text).then(ok, no); else no(); } catch { no(); }
  };
  return <button type="button" className="md-copy" onClick={copy} aria-label="코드 복사">{done || '복사'}</button>;
}

/**
 * 본문 첫 블록이 문서 제목과 같은 '# 제목' 이면 뺀다(문서 보기는 제목을 따로 그리므로 두 번 보이지 않게 — 템플릿이 '# 제목' 으로 시작한다).
 * 목차에서도 함께 뺀다. 글은 바꾸지 않는다(그리기만).
 */
export function withoutTitle(doc, title) {
  const t = String(title || '').trim();
  const first = doc.blocks[0];
  if (!t || !first || first.t !== 'h' || first.level !== 1 || inlineText(first.inl).trim() !== t) return doc;
  return { ...doc, blocks: doc.blocks.slice(1), headings: doc.headings.filter((h) => h.id !== first.id) };
}

/**
 * breaks: 줄 하나 바꿈을 줄바꿈으로(이슈 본문 · 댓글 — v2.883). onToggleTask(line, checked): 주면 체크리스트를 누를 수 있다(위키 보기 — 판을 만들지 않는다).
 */
/**
 * v2.889: renderMacro(block, key) — 포탈 매크로({{issues}} · {{include}} · {{vcenters}} · {{partfaults}})를 그린다(위키 문서 보기만 넘긴다).
 *   없으면 매크로 자리를 안내 상자로만 둔다(이슈 본문 · 미리보기 · 포함된 문서 안 — 포함 안의 매크로를 그리지 않아 재귀를 막는다).
 */
export function MdView({ md = '', ast = null, pages = [], spaceId = '', idPrefix = 'md', className = '', compact = false, dropTitle = '', breaks = false, onToggleTask = null, busy = false, unresolvedAsSearch = false, renderMacro = null }) {
  const doc = useMemo(() => withoutTitle(ast || parseMarkdown(md, { breaks }), dropTitle), [ast, md, dropTitle, breaks]);
  const fnNum = useMemo(() => new Map(doc.footnotes.map((f) => [f.id, f.n])), [doc]);
  const hid = (id) => `${idPrefix}-${id}`;

  const inl = (nodes, keyBase = 'i') => (nodes || []).map((n, k) => {
    const key = `${keyBase}${k}`;
    switch (n.t) {
      case 'text': return <React.Fragment key={key}>{n.v}</React.Fragment>;
      case 'br': return <br key={key} />;
      case 'b': return <strong key={key}>{inl(n.c, key)}</strong>;
      case 'i': return <em key={key}>{inl(n.c, key)}</em>;
      case 's': return <del key={key}>{inl(n.c, key)}</del>;
      case 'code': return <code key={key} className="md-code-inline">{n.v}</code>;
      case 'a': if (n.attach) return <AttachLink key={key} id={n.attach}>{inl(n.c, key)}</AttachLink>;
        return n.ext
        ? <a key={key} href={n.href} target="_blank" rel="noopener noreferrer" className="md-link ext">{inl(n.c, key)}</a>
        : <a key={key} href={n.href} className="md-link">{inl(n.c, key)}</a>;
      case 'img': return n.attach ? <AttachImg key={key} id={n.attach} alt={n.alt} /> : <img key={key} src={n.src} alt={n.alt} loading="lazy" className="md-img" />;
      case 'iss': return <a key={key} href={`#/issues/list/${n.key}`} className="md-iss" title="이슈 열기">{n.key}</a>;
      case 'mention': { // v2.905 '@계정/이름' 은 계정(모노) + 이름으로 나눠 그린다(글자는 그대로 — 알림 · .md · 메일이 같은 글자를 쓴다)
        const sl = n.user.indexOf('/');
        if (sl <= 0) return <span key={key} className="md-mention">@{n.user}</span>;
        return <span key={key} className="md-mention" title={`${n.user.slice(0, sl)} · ${n.user.slice(sl + 1)}`}><span className="md-mention-u">@{n.user.slice(0, sl)}</span><span className="md-mention-s">/</span><span className="md-mention-n">{n.user.slice(sl + 1)}</span></span>;
      }
      case 'fn': {
        const num = fnNum.get(n.id);
        return <sup key={key} className="md-fnref"><button type="button" className="md-linkbtn" onClick={() => scrollToId(hid(`fn-${n.id}`))}>[{num ?? n.id}]</button></sup>;
      }
      case 'page': {
        const p = resolvePageRef(n.ref, pages, spaceId);
        if (p) return <a key={key} href={wikiHash({ space: p.spaceId || spaceId, id: p.id })} className="md-page">{n.label || p.title}</a>;
        if (/^W\d{1,9}$/.test(n.ref)) return <a key={key} href={wikiHash({ space: spaceId, id: n.ref })} className="md-page">{n.label || n.ref}</a>;
        // 문서 목록을 모르는 화면(이슈 본문 · 댓글)은 '없는 문서' 로 단정하지 않고 위키 찾기로 잇는다(v2.883 — Chromium 판독)
        if (unresolvedAsSearch) return <a key={key} href={wikiHash({ space: spaceId || 'pub', view: 'search', params: { q: n.ref } })} className="md-page" title="위키에서 이 제목을 찾습니다">{n.label || n.ref}</a>;
        return <span key={key} className="md-page missing" title="이 스페이스에서 이 제목의 문서를 찾지 못했습니다">{n.label || n.ref}</span>;
      }
      default: return null;
    }
  });

  const toc = () => {
    const hs = doc.headings.filter((h) => h.level <= 3);
    if (!hs.length) return <div className="md-toc muted">목차 — 제목(#)이 없습니다</div>;
    const min = Math.min(...hs.map((h) => h.level));
    return (
      <nav className="md-toc" aria-label="목차">
        <div className="md-toc-title">목차</div>
        {hs.map((h) => (
          <button key={h.id} type="button" className="md-linkbtn md-toc-item" style={{ paddingLeft: (h.level - min) * 14 }} onClick={() => scrollToId(hid(h.id))}>{h.text || '(제목 없음)'}</button>
        ))}
      </nav>
    );
  };

  const blocks = (bs, keyBase = 'b') => (bs || []).map((b, k) => {
    const key = `${keyBase}${k}`;
    switch (b.t) {
      case 'h': { const H = `h${Math.min(6, b.level + (compact ? 2 : 0))}`; return <H key={key} id={hid(b.id)} className={`md-h md-h${b.level}`}>{inl(b.inl, key)}</H>; }
      case 'p': return <p key={key}>{inl(b.inl, key)}</p>;
      case 'hr': return <hr key={key} />;
      case 'toc': return <React.Fragment key={key}>{toc()}</React.Fragment>;
      case 'macro': return renderMacro
        ? <React.Fragment key={key}>{renderMacro(b, key)}</React.Fragment>
        : <div key={key} className="md-macro off muted">{`{{${b.name}}}`} — 포탈 매크로는 위키 문서 보기에서 그 시각의 값을 읽어 보입니다.</div>;
      case 'code': return (
        <div key={key} className="md-code">
          <div className="md-code-head"><span className="muted">{b.lang || '코드'}</span><CopyButton text={b.text} /></div>
          <pre><code>{b.text}</code></pre>
        </div>
      );
      case 'quote': return <blockquote key={key} className="md-quote">{blocks(b.blocks, key)}</blockquote>;
      case 'callout': return (
        <div key={key} className={`md-callout k-${b.kind}`} role="note">
          <div className="md-callout-title">{CALLOUT_TEXT[b.kind] || b.kind}{b.title && inlineText(b.title).trim() !== CALLOUT_TEXT[b.kind] ? <> — {inl(b.title, key)}</> : null}</div>
          {blocks(b.blocks, key)}
        </div>
      );
      case 'fold': return (
        <details key={key} className="md-fold"><summary>{inl(b.title, key)}</summary><div className="md-fold-body">{blocks(b.blocks, key)}</div></details>
      );
      case 'ul':
      case 'ol': {
        const L = b.t;
        const task = b.items.some((it) => it.task != null);
        return (
          <L key={key} className={task ? 'md-tasks' : undefined} start={b.t === 'ol' && b.start && b.start !== 1 ? b.start : undefined}>
            {b.items.map((it, j) => (
              <li key={`${key}-${j}`} className={it.task != null ? `md-task${it.task ? ' done' : ''}` : undefined}>
                {it.task != null && (onToggleTask && it.line != null
                  ? <input type="checkbox" checked={it.task} disabled={busy} onChange={() => onToggleTask(it.line, !it.task)} aria-label={it.task ? '끝남 — 누르면 남음으로' : '남음 — 누르면 끝남으로'} />
                  : <input type="checkbox" checked={it.task} readOnly disabled aria-label={it.task ? '끝남' : '남음'} />)}
                <span>{inl(it.inl, `${key}-${j}`)}</span>
                {it.children.length > 0 && blocks(it.children, `${key}-${j}c`)}
              </li>
            ))}
          </L>
        );
      }
      case 'table': {
        const cols = b.head.length;
        return (
          <div key={key} className="md-table">
            <STable className="tbl" minWidth={Math.min(1100, Math.max(260, cols * 120))}>
              <thead><tr>{b.head.map((c, j) => <th key={j} style={b.align[j] ? { textAlign: b.align[j] } : undefined}>{inl(c, `${key}h${j}`)}</th>)}</tr></thead>
              <tbody>
                {b.rows.map((r, ri) => (
                  <tr key={ri}>{r.map((c, j) => <td key={j} data-sort={inlineText(c)} style={b.align[j] ? { textAlign: b.align[j] } : undefined}>{inl(c, `${key}r${ri}c${j}`)}</td>)}</tr>
                ))}
              </tbody>
            </STable>
          </div>
        );
      }
      default: return null;
    }
  });

  return (
    <div className={`md-body${compact ? ' compact' : ''}${className ? ` ${className}` : ''}`}>
      {blocks(doc.blocks)}
      {doc.footnotes.length > 0 && (
        <ol className="md-footnotes" aria-label="각주">
          {doc.footnotes.map((f) => (
            <li key={f.id} id={hid(`fn-${f.id}`)}>{f.inl ? inl(f.inl, `fn${f.id}`) : <span className="muted">[^{f.id}] 설명이 없습니다</span>}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** 목차만(문서 옆 칸) — 제목이 3개 이상일 때만 그린다. */
export function MdToc({ md = '', ast = null, idPrefix = 'md', dropTitle = '' }) {
  const doc = useMemo(() => withoutTitle(ast || parseMarkdown(md), dropTitle), [ast, md, dropTitle]);
  const hs = doc.headings.filter((h) => h.level <= 3);
  if (hs.length < 3) return null;
  const min = Math.min(...hs.map((h) => h.level));
  return (
    <nav className="md-toc side" aria-label="이 문서의 목차">
      <div className="md-toc-title">이 문서</div>
      {hs.map((h) => (
        <button key={h.id} type="button" className="md-linkbtn md-toc-item" style={{ paddingLeft: (h.level - min) * 12 }} onClick={() => scrollToId(`${idPrefix}-${h.id}`)}>{h.text || '(제목 없음)'}</button>
      ))}
    </nav>
  );
}
