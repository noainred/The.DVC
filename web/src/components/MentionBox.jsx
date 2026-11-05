/**
 * MentionBox — '@' 자동완성이 붙은 글상자(v2.907 · 시안 docs/design/wiki-mention ①⑥⑦). 위키 댓글 · 이슈 댓글이 같이 쓴다.
 *  · 후보는 서버가 거른다(path 의 mentionables — 범위 · A3-02). 1자부터 · 150ms 뒤 1회 · 늦게 온 이전 응답은 버린다 · 폴링 없음.
 *  · 목록은 글상자 **아래 줄을 통째로** 쓴다(떠 있는 상자 금지 — docs/rules/web.md) · ↑↓ 고르기 · Enter/Tab 넣기 · Esc 닫기 · 한글 조합 중 Enter 는 먹지 않는다.
 *  · 고르면 글에 '@계정/이름 ' 이 들어간다(mentionText). onPick(후보) 로 부르는 쪽이 메일 · 범위 표시를 모은다.
 */
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson } from '../api.js';
import { mentionQueryAt, applyMention } from './mentionText.js';

const ROLE_TEXT = Object.freeze({ admin: '관리자', super_admin: '관리자', operator: '운영자', viewer: '뷰어', ad: 'AD' });

export default function MentionBox({ value, onChange, path, rows = 3, placeholder = '', maxLength, ariaLabel = '댓글', onPick = null, onMeta = null, id, disabled = false }) {
  const ta = useRef(null);
  const seq = useRef(0);
  const [menu, setMenu] = useState(null); // { q, items, i, err, loading, truncated }
  const [query, setQuery] = useState(null); // 지금 커서의 '@검색어'
  const sync = (text, caret) => { const m = mentionQueryAt(text, caret); setQuery(m ? m.q : null); };
  useEffect(() => {
    if (query == null || !path) { setMenu(null); return undefined; }
    const k = ++seq.current;
    setMenu((m) => ({ ...(m || { items: [], i: 0 }), q: query, loading: true, err: '' }));
    const t = setTimeout(() => {
      fetchJson(path, { q: query }, undefined, { retries: 0 })
        .then((r) => { if (k !== seq.current) return; onMeta?.(r); setMenu({ q: query, items: r.items || [], i: 0, truncated: !!r.truncated, loading: false, err: '', full: !!r.full }); })
        .catch((e) => { if (k === seq.current) setMenu({ q: query, items: [], i: 0, loading: false, err: e?.status === 403 ? '권한이 없어 후보를 볼 수 없습니다' : '후보를 읽지 못했습니다 — 계정을 직접 치세요' }); });
    }, 150);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, path]);
  const pick = (cand) => {
    const el = ta.current;
    const caret = el?.selectionStart ?? String(value || '').length;
    const r = applyMention(value, caret, cand);
    setQuery(null); setMenu(null);
    if (!r) return;
    onChange(r.text);
    onPick?.(cand);
    requestAnimationFrame(() => { try { el.focus(); el.setSelectionRange(r.caret, r.caret); } catch { /* 선택 범위를 못 옮기는 브라우저 */ } });
  };
  const open = menu && query != null;
  // 목록이 화면 아래(하단 고정 줄 밑)로 숨지 않게 — 열릴 때 한 번 보이는 자리로(Chromium 400px 판독: 글상자가 화면 끝이면 목록이 가려졌다)
  const listRef = useRef(null);
  useEffect(() => { if (open && listRef.current?.scrollIntoView) { try { listRef.current.scrollIntoView({ block: 'nearest' }); } catch { /* 옛 브라우저 */ } } }, [open]);
  const onKey = (e) => {
    if (!open) return;
    if (e.nativeEvent?.isComposing || e.keyCode === 229) return; // 한글 조합 확정 Enter 는 글자 입력이다
    const n = menu.items.length;
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) { e.preventDefault(); const d = e.key === 'ArrowDown' ? 1 : -1; setMenu((m) => ({ ...m, i: (m.i + d + n) % n })); }
    else if ((e.key === 'Enter' || e.key === 'Tab') && n && !menu.loading) { e.preventDefault(); pick(menu.items[menu.i]); }
    else if (e.key === 'Escape') { e.preventDefault(); setQuery(null); setMenu(null); }
  };
  return (
    <div className="mention-box">
      <textarea ref={ta} id={id} className="input" rows={rows} value={value} maxLength={maxLength} placeholder={placeholder} aria-label={ariaLabel} disabled={disabled}
        aria-expanded={open ? 'true' : 'false'} aria-autocomplete="list"
        onChange={(e) => { onChange(e.target.value); sync(e.target.value, e.target.selectionStart); }}
        onKeyDown={onKey}
        onKeyUp={(e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) sync(e.currentTarget.value, e.currentTarget.selectionStart); }}
        onClick={(e) => sync(e.currentTarget.value, e.currentTarget.selectionStart)}
        onBlur={() => setTimeout(() => { setQuery(null); setMenu(null); }, 150)} />
      {open && (
        <div ref={listRef} className="mention-list" role="listbox" aria-label="사람 후보">
          <div className="mention-list-head"><span>사람 찾기 — ‘{menu.q || '…'}’ · 계정 · 이름</span><span>{menu.loading ? '찾는 중…' : `${menu.items.length}명${menu.truncated ? ' · 더 치면 좁힙니다' : ''}`}</span></div>
          {menu.err ? <div className="mention-list-empty">{menu.err}</div>
            : !menu.loading && !menu.items.length ? <div className="mention-list-empty">맞는 사람이 없습니다 — 그대로 두면 글자로 남고 알림 · 이슈 대상이 되지 않습니다.</div>
            : menu.items.map((c, k) => (
              <button key={c.username} type="button" role="option" aria-selected={k === menu.i ? 'true' : 'false'} className={`mention-opt${k === menu.i ? ' on' : ''}`}
                onMouseDown={(e) => e.preventDefault()} onClick={() => pick(c)}>
                <span className="mention-u">{c.username}</span>
                {c.name && <span className="mention-n">{c.name}</span>}
                <span className="mention-r">
                  {c.role && <span className="mention-tag">{ROLE_TEXT[c.role] || c.role}{c.scoped ? ' · 범위' : ''}</span>}
                  {c.canSee === false && <span className="mention-tag warn" title="이 문서 · 이슈의 법인을 볼 수 없어 담당자로 지정할 수 없습니다">이 법인 이슈를 볼 수 없음</span>}
                  {c.email === true && <span className="mention-mail">메일</span>}
                  {c.email === false && <span className="mention-mail no">메일 없음</span>}
                </span>
              </button>
            ))}
          <div className="mention-list-foot muted">↑↓ 고르기 · Enter/Tab 넣기 → ‘@계정/이름’ · Esc 닫기</div>
        </div>
      )}
    </div>
  );
}
