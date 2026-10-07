/**
 * Board — 상단 메뉴 '게시판'(v2.722). 서브탭 둘: 게시글 · 공지(접속 팝업).
 *  · 읽기는 로그인 사용자 전부, 글·댓글 쓰기는 admin·operator(서버가 집행). 수정·삭제는 작성자 본인 또는 관리자.
 *  · 공지 작성·수정·삭제는 전체 범위 관리자(서버가 집행). 공지는 로그인 뒤 팝업으로 보인다.
 * 폴링하지 않는다(마운트 1회 + 동작 뒤 다시 읽기 + 새로고침 버튼).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { fetchJson, postJson, putJson, delJson } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import { Loading, ErrorBox } from '../../components/primitives.jsx';
import Select from '../../components/Select.jsx';
import { useHashTab } from '../../hooks/useHashTab.js';
import {
  LEVEL_TEXT, LEVEL_TONE, timeText, windowText, noticeState, toLocalInput, fromLocalInput, saveFailText,
} from './bulletinText.js';

const SUBS = [['posts', '게시글'], ['notices', '공지(접속 팝업)']];

export default function Board() {
  const [sub, setSub] = useHashTab({ base: ['board'], valid: SUBS.map(([k]) => k), fallback: 'posts' });
  return (
    <div className="board-page">
      <div className="flex" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {SUBS.map(([k, label]) => (
          <button key={k} className={`btn${sub === k ? ' primary' : ''}`} onClick={() => setSub(k)}>{label}</button>
        ))}
      </div>
      {sub === 'notices' ? <NoticeAdmin /> : <Posts />}
    </div>
  );
}

/* ───────────── 게시글 ───────────── */

function Posts() {
  const [list, setList] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState('');
  const [writing, setWriting] = useState(false);

  const load = useCallback(() => {
    let alive = true;
    fetchJson('/board/posts', { q: query, limit: 200 })
      .then((r) => { if (alive) { setList(r); setErr(null); } })
      .catch((e) => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, [query]);
  useEffect(() => load(), [load]);

  if (openId) return <PostDetail id={openId} me={list?.me} isAdmin={!!list?.isAdmin} canWrite={!!list?.canWrite} onBack={() => { setOpenId(''); load(); }} />;
  if (err && !list) return <ErrorBox error={err} />;
  if (!list) return <Loading label="게시판" />;

  return (
    <div className="card">
      <div className="flex between" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <form className="flex" style={{ gap: 6, flexWrap: 'wrap', minWidth: 0 }} onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
          <input className="input board-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="제목·내용·작성자 검색" maxLength={100} />
          <button className="btn" type="submit">검색</button>
          {query && <button className="btn" type="button" onClick={() => { setQ(''); setQuery(''); }}>검색 해제</button>}
        </form>
        <div className="flex" style={{ gap: 6 }}>
          <button className="btn" onClick={load}>새로고침</button>
          {list.canWrite
            ? <button className="btn primary" onClick={() => setWriting(true)}>글쓰기</button>
            : <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>글쓰기는 운영자·관리자만 할 수 있습니다</span>}
        </div>
      </div>
      {err && <div className="banner">목록을 새로 읽지 못했습니다 — 아래는 직전에 읽은 목록입니다.</div>}
      {writing && <PostEditor isAdmin={list.isAdmin} limits={list.limits} onCancel={() => setWriting(false)} onSaved={(p) => { setWriting(false); setOpenId(p.id); }} />}
      {list.rows.length === 0
        ? <div className="muted" style={{ padding: 16 }}>{query ? `‘${query}’ 에 맞는 글이 없습니다.` : '아직 글이 없습니다.'}</div>
        : (
          <STable className="v3-table" minWidth={560}>
            <thead><tr><th>제목</th><th>작성자</th><th>댓글</th><th>작성</th><th>최근 활동</th></tr></thead>
            <tbody>
              {list.rows.map((r) => (
                <tr key={r.id} className={r.pinned ? 'board-pinned' : ''}>
                  <td data-sort={`${r.pinned ? 0 : 1}${r.title}`} style={{ whiteSpace: 'normal' }}>
                    <span role="button" tabIndex={0} className="board-link"
                      onClick={() => setOpenId(r.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(r.id); } }}>
                      {r.pinned && <span className="board-pin">고정</span>}{r.title}
                    </span>
                  </td>
                  <td>{r.author}</td>
                  <td className="right" data-sort={r.comments}>{r.comments}</td>
                  <td data-sort={r.createdAt}>{timeText(r.createdAt)}</td>
                  <td data-sort={r.lastActivityAt}>{timeText(r.lastActivityAt)}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        )}
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        {query ? `검색 결과 ${list.total}건 · 전체 ${list.all}건` : `전체 ${list.all}건`}
        {list.total > list.rows.length ? ` · 앞 ${list.rows.length}건만 표시(검색으로 좁히세요)` : ''}
        {list.limits ? ` · 글은 ${list.limits.postMax}개까지 보관합니다` : ''}
      </div>
    </div>
  );
}

function PostEditor({ initial, isAdmin, limits, onCancel, onSaved }) {
  const [title, setTitle] = useState(initial?.title || '');
  const [body, setBody] = useState(initial?.body || '');
  const [pinned, setPinned] = useState(!!initial?.pinned);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setMsg('');
    try {
      const payload = { title, body, ...(isAdmin ? { pinned } : {}) };
      const r = initial ? await putJson(`/board/posts/${initial.id}`, payload) : await postJson('/board/posts', payload);
      if (r?.ok) onSaved(r.post); else setMsg(saveFailText(r));
    } catch (e) { setMsg(saveFailText({ reason: e.message })); } finally { setBusy(false); }
  };
  return (
    <div className="board-editor">
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="제목" maxLength={limits?.postTitle || 200} />
      <textarea className="input" rows={8} value={body} onChange={(e) => setBody(e.target.value)} placeholder="내용" maxLength={limits?.postBody || 10000} />
      <div className="flex between" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span className="muted" style={{ fontSize: 12 }}>
          {body.length.toLocaleString()} / {(limits?.postBody || 10000).toLocaleString()}자
          {isAdmin && <label style={{ marginLeft: 12 }}><input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> 상단 고정</label>}
        </span>
        <span className="flex" style={{ gap: 6 }}>
          <button className="btn" onClick={onCancel} disabled={busy}>취소</button>
          <button className="btn primary" onClick={save} disabled={busy || !title.trim() || !body.trim()}>{busy ? '저장 중…' : '저장'}</button>
        </span>
      </div>
      {msg && <div className="banner">{msg}</div>}
    </div>
  );
}

function PostDetail({ id, me, isAdmin, canWrite, onBack }) {
  const [post, setPost] = useState(null);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    let alive = true;
    fetchJson(`/board/posts/${id}`).then((r) => { if (alive) { setPost(r.post); setErr(null); } }).catch((e) => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, [id]);
  useEffect(() => load(), [load]);

  const mine = (x) => isAdmin || (!!me && x?.author === me);
  const act = async (fn, after) => {
    setBusy(true); setMsg('');
    try { const r = await fn(); if (r?.ok) after?.(); else setMsg(saveFailText(r)); } catch (e) { setMsg(saveFailText({ reason: e.message })); } finally { setBusy(false); }
  };

  if (err && !post) return <div><button className="btn" onClick={onBack}>← 목록</button><div style={{ marginTop: 10 }}><ErrorBox error={err} /></div></div>;
  if (!post) return <Loading label="글" />;
  return (
    <div className="card">
      <button className="btn" onClick={onBack}>← 목록</button>
      {editing
        ? <div style={{ marginTop: 10 }}><PostEditor initial={post} isAdmin={isAdmin} onCancel={() => setEditing(false)} onSaved={(p) => { setEditing(false); setPost({ ...p, comments: post.comments }); }} /></div>
        : (
          <>
            <h3 className="board-title">{post.pinned && <span className="board-pin">고정</span>}{post.title}</h3>
            <div className="muted" style={{ fontSize: 12 }}>
              {post.author} · 작성 {timeText(post.createdAt)}{post.updatedAt && post.updatedAt !== post.createdAt ? ` · 수정 ${timeText(post.updatedAt)}${post.editedBy && post.editedBy !== post.author ? `(${post.editedBy})` : ''}` : ''}
            </div>
            <div className="board-body">{post.body}</div>
            {canWrite && mine(post) && (
              <div className="flex" style={{ gap: 6, marginTop: 10 }}>
                <button className="btn" disabled={busy} onClick={() => setEditing(true)}>수정</button>
                <button className="btn" disabled={busy} onClick={() => { if (window.confirm('이 글을 지울까요? 댓글도 함께 지워집니다.')) act(() => delJson(`/board/posts/${id}`), onBack); }}>삭제</button>
              </div>
            )}
          </>
        )}
      <div className="board-comments">
        <b>댓글 {post.comments.length}</b>
        {post.comments.map((c) => (
          <div key={c.id} className="board-comment">
            <div className="flex between" style={{ gap: 8 }}>
              <span className="muted" style={{ fontSize: 12 }}>{c.author} · {timeText(c.createdAt)}</span>
              {canWrite && mine(c) && <button className="btn btn-sm" disabled={busy} onClick={() => { if (window.confirm('이 댓글을 지울까요?')) act(() => delJson(`/board/posts/${id}/comments/${c.id}`), load); }}>삭제</button>}
            </div>
            <div className="board-comment-body">{c.body}</div>
          </div>
        ))}
        {canWrite
          ? (
            <div className="flex" style={{ gap: 6, marginTop: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <textarea className="input board-comment-input" rows={2} value={comment} maxLength={2000} onChange={(e) => setComment(e.target.value)} placeholder="댓글" />
              <button className="btn primary" disabled={busy || !comment.trim()} onClick={() => act(() => postJson(`/board/posts/${id}/comments`, { body: comment }), () => { setComment(''); load(); })}>등록</button>
            </div>
          )
          : <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>댓글은 운영자·관리자만 쓸 수 있습니다.</div>}
      </div>
      {msg && <div className="banner" style={{ marginTop: 8 }}>{msg}</div>}
    </div>
  );
}

/* ───────────── 공지(접속 팝업) ───────────── */

const EMPTY = { title: '', body: '', level: 'info', enabled: true, startAt: '', endAt: '' };

function NoticeAdmin() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [form, setForm] = useState(null); // null = 닫힘, {id?: …} = 편집 중
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    let alive = true;
    fetchJson('/notices').then((r) => { if (alive) { setData(r); setErr(null); } }).catch((e) => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, []);
  useEffect(() => load(), [load]);

  if (err && !data) return <ErrorBox error={err} />;
  if (!data) return <Loading label="공지" />;
  const canEdit = !!data.canEdit;
  const edit = (n) => setForm(n ? { id: n.id, title: n.title, body: n.body || '', level: n.level, enabled: n.enabled !== false, startAt: toLocalInput(n.startAt), endAt: toLocalInput(n.endAt) } : { ...EMPTY });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));
  const save = async () => {
    setBusy(true); setMsg('');
    const payload = { title: form.title, body: form.body, level: form.level, enabled: form.enabled, startAt: fromLocalInput(form.startAt), endAt: fromLocalInput(form.endAt) };
    try {
      const r = form.id ? await putJson(`/notices/${form.id}`, payload) : await postJson('/notices', payload);
      if (r?.ok) { setForm(null); load(); } else setMsg(saveFailText(r));
    } catch (e) { setMsg(saveFailText({ reason: e.message })); } finally { setBusy(false); }
  };
  const remove = async (n) => {
    if (!window.confirm(`공지 ‘${n.title}’ 를 지울까요?`)) return;
    setBusy(true); setMsg('');
    try { const r = await delJson(`/notices/${n.id}`); if (r?.ok) load(); else setMsg(saveFailText(r)); } catch (e) { setMsg(saveFailText({ reason: e.message })); } finally { setBusy(false); }
  };
  const now = Date.now();

  return (
    <div className="card">
      <div className="flex between" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <div className="muted" style={{ fontSize: 12.5, minWidth: 0, flex: '1 1 260px' }}>
          켜져 있고 노출 기간 안의 공지가 사용자가 로그인한 뒤 팝업으로 뜹니다. 사용자는 ‘오늘 하루 보지 않기’·‘다시 보지 않기’ 를 고를 수 있고(그 브라우저에만 저장), 공지를 고치면 다시 보입니다.
        </div>
        <div className="flex" style={{ gap: 6 }}>
          <button className="btn" onClick={load}>새로고침</button>
          {canEdit
            ? <button className="btn primary" onClick={() => edit(null)} disabled={!!form}>공지 추가</button>
            : <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>공지 작성은 전체 범위 관리자만 할 수 있습니다</span>}
        </div>
      </div>
      {form && (
        <div className="board-editor">
          <input className="input" value={form.title} onChange={set('title')} placeholder="공지 제목" maxLength={data.limits?.noticeTitle || 200} />
          <textarea className="input" rows={5} value={form.body} onChange={set('body')} placeholder="공지 내용" maxLength={data.limits?.noticeBody || 5000} />
          <div className="board-notice-grid">
            <label>등급<Select className="select" value={form.level} onChange={set('level')} sort={false}>
              {(data.levels || ['info', 'warn', 'crit']).map((l) => <option key={l} value={l}>{LEVEL_TEXT[l] || l}</option>)}
            </Select></label>
            <label>노출 시작(비우면 즉시)<input className="input" type="datetime-local" value={form.startAt} onChange={set('startAt')} /></label>
            <label>노출 종료(비우면 계속)<input className="input" type="datetime-local" value={form.endAt} onChange={set('endAt')} /></label>
            <label className="board-check"><input type="checkbox" checked={form.enabled} onChange={set('enabled')} /> 켜기</label>
          </div>
          <div className="flex" style={{ gap: 6, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => { setForm(null); setMsg(''); }} disabled={busy}>취소</button>
            <button className="btn primary" onClick={save} disabled={busy || !form.title.trim()}>{busy ? '저장 중…' : '저장'}</button>
          </div>
        </div>
      )}
      {msg && <div className="banner">{msg}</div>}
      {data.notices.length === 0
        ? <div className="muted" style={{ padding: 16 }}>등록된 공지가 없습니다.</div>
        : (
          <STable className="v3-table" minWidth={720}>
            <thead><tr><th>상태</th><th>등급</th><th>제목</th><th>노출 기간</th><th>수정</th>{canEdit && <th data-nosort>작업</th>}</tr></thead>
            <tbody>
              {data.notices.map((n) => {
                const st = noticeState(n, now);
                return (
                  <tr key={n.id}>
                    <td><span style={{ color: st.tone, fontWeight: 600 }}>{st.text}</span></td>
                    <td><span className="notice-level" style={{ color: LEVEL_TONE[n.level], borderColor: LEVEL_TONE[n.level] }}>{LEVEL_TEXT[n.level] || n.level}</span></td>
                    <td style={{ whiteSpace: 'normal' }}><b>{n.title}</b>{n.body ? <div className="muted board-notice-snippet">{n.body}</div> : null}</td>
                    <td style={{ whiteSpace: 'normal' }}>{windowText(n)}</td>
                    <td data-sort={n.updatedAt}>{timeText(n.updatedAt)}<div className="muted" style={{ fontSize: 11 }}>{n.updatedBy || n.createdBy}</div></td>
                    {canEdit && (
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn btn-sm" disabled={busy} onClick={() => edit(n)}>수정</button>{' '}
                        <button className="btn btn-sm" disabled={busy} onClick={() => remove(n)}>삭제</button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </STable>
        )}
    </div>
  );
}
