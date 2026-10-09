/**
 * Board — 상단 메뉴 '게시판'(v2.722). 서브탭 둘: 게시글 · 공지(접속 팝업).
 *  · 읽기는 로그인 사용자 전부, 글·댓글 쓰기는 admin·operator(서버가 집행). 수정·삭제는 작성자 본인 또는 관리자.
 *  · 공지 작성·수정·삭제는 전체 범위 관리자(서버가 집행). 공지는 로그인 뒤 팝업으로 보인다.
 * 폴링하지 않는다(마운트 1회 + 동작 뒤 다시 읽기 + 새로고침 버튼).
 * v2.723 — 답글(대댓글, 한 단계)과 공감(글·댓글, 한 사람 1회 · 다시 누르면 취소). 공감·답글도 쓰기 권한(admin·operator)이다.
 * v2.727(감사 E-02) — 목록·글·공지의 load() 는 세대 번호(`makeLatest`)로 늦게 온 이전 응답을 버린다. 예전 `alive` 가드는 useEffect 정리로만
 *   꺼져 새로고침 버튼·뒤로가기가 띄운 요청은 정리되지 않았다(검색어 B 인데 목록은 A). 언마운트는 세대를 올려 무효화한다.
 * 리뷰 I-05 — 쓰기는 '메모리에 반영(수용됨)' 과 '디스크에 저장(저장 완료)' 이 다른 시점이다. 쓰기 응답의 `persist.state` 가 실패·대기면
 *   그 자리에서 말하고, 화면 위 `PersistBanner` 가 `GET /board/persist` 로 저장소 상태를 읽어 **저장될 때까지** 경고를 유지한다
 *   (저장 안 된 것이 있는 동안만 10초마다 다시 읽는다 — 상시 폴링 아님). 관리자에게는 사유 코드·미저장 수와 ‘지금 다시 저장’.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, delJson } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import { Loading, ErrorBox } from '../../components/primitives.jsx';
import Select from '../../components/Select.jsx';
import { useHashTab } from '../../hooks/useHashTab.js';
import {
  LEVEL_TEXT, LEVEL_TONE, timeText, windowText, noticeState, toLocalInput, fromLocalInput, saveFailText,
  threadComments, likersText, applyLike, makeLatest,
  persistWarnings, needsPersistPoll, writeResultNote, retryResultText, PERSIST_POLL_MS,
} from './bulletinText.js';

/** 세대 가드 하나를 컴포넌트 수명 동안 들고, 언마운트 때 무효화한다(v2.727 E-02). */
function useLatest() {
  const ref = useRef(null);
  if (!ref.current) ref.current = makeLatest();
  useEffect(() => () => { ref.current.invalidate(); }, []);
  return ref.current;
}

const SUBS = [['posts', '게시글'], ['notices', '공지(접속 팝업)']];

export default function Board() {
  const [sub, setSub] = useHashTab({ base: ['board'], valid: SUBS.map(([k]) => k), fallback: 'posts' });
  // 리뷰 I-05: 저장되지 않은 쓰기 응답이 오면 저장 상태를 다시 읽게 한다(배너가 실패를 띄운다 — 저장되면 배너의 폴링이 지운다).
  const [persistTick, setPersistTick] = useState(0);
  const onPersist = useCallback((p) => { if (p?.state !== 'saved') setPersistTick((t) => t + 1); }, []);
  return (
    <div className="board-page">
      <div className="flex" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {SUBS.map(([k, label]) => (
          <button key={k} className={`btn${sub === k ? ' primary' : ''}`} onClick={() => setSub(k)}>{label}</button>
        ))}
      </div>
      <PersistBanner tick={persistTick} />
      {sub === 'notices' ? <NoticeAdmin onPersist={onPersist} /> : <Posts onPersist={onPersist} />}
    </div>
  );
}

/* ───────────── 저장 상태(리뷰 I-05) ───────────── */

/**
 * 게시판·공지 저장소의 '저장 대기/실패' 경고. 저장 안 된 변경이 있는 동안만 PERSIST_POLL_MS 마다 다시 읽고, 저장되면 멈추고 사라진다.
 * 상태를 못 읽으면 직전 상태를 그대로 둔다(경고를 조용히 지우지 않는다). 관리자 상세·‘지금 다시 저장’ 은 서버가 관리자에게만 싣는다.
 */
function PersistBanner({ tick }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { text, ok } — 마지막 '지금 다시 저장' 결과
  const latest = useLatest();
  const load = useCallback(() => {
    const k = latest.next();
    fetchJson('/board/persist')
      .then((r) => { if (latest.isLatest(k)) setData(r); })
      .catch(() => { /* 저장 상태를 못 읽으면 직전 경고를 그대로 둔다 — 게시판 자체 오류는 아래 화면이 말한다 */ });
  }, [latest]);
  useEffect(() => { load(); }, [load, tick]);
  const polling = needsPersistPoll(data?.stores);
  useEffect(() => {
    if (!polling) return undefined;
    const t = setTimeout(load, PERSIST_POLL_MS);
    return () => clearTimeout(t);
  }, [polling, data, load]);

  const retry = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/board/persist/retry', {});
      if (r?.stores) setData((d) => ({ ...(d || {}), stores: r.stores }));
      const tried = Array.isArray(r?.result) ? r.result.filter((x) => x && x.attempted) : [];
      setMsg({ text: retryResultText(r), ok: !!r?.ok && tried.every((x) => x.state === 'saved') });
    } catch (e) { setMsg({ text: retryResultText({ ok: false, reason: e.message }), ok: false }); } finally { setBusy(false); }
  };
  return <PersistBannerView data={data} busy={busy} msg={msg} onRetry={retry} />;
}

/** 표시만(상태 없음 — 렌더 테스트가 이것을 그린다). data = GET /board/persist 응답, msg = { text, ok } 마지막 다시 저장 결과. */
export function PersistBannerView({ data, busy = false, msg = null, onRetry, now }) {
  const warnings = persistWarnings(data?.stores, now != null ? { now } : undefined);
  // 다시 저장 결과 — 성공 문구만 경고가 사라진 뒤에도 남긴다(실패 문구가 초록으로 남으면 거짓이 된다).
  if (!warnings.length) return msg?.ok ? <div className="banner ok" style={{ marginBottom: 10 }}>{msg.text}</div> : null;
  const failed = warnings.some((w) => w.tone === 'bad');
  return (
    <div style={{ marginBottom: 10 }}>
      {warnings.map((w) => (
        <div key={w.kind} className={`banner ${w.tone === 'bad' ? 'bad' : 'warn'}`} style={{ marginBottom: 6, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
          <b>{w.title}</b>
          {w.lines.map((ln, i) => <div key={i} style={{ fontSize: 12.5, marginTop: 2 }}>{ln}</div>)}
        </div>
      ))}
      {failed && data?.admin && (
        <div className="flex" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn" disabled={busy || !data.canRetry} onClick={onRetry}
            title={data.canRetry ? '자동 재시도를 기다리지 않고 지금 다시 저장합니다' : '다시 저장은 전체 범위(vCenter 제한 없는) 관리자만 실행할 수 있습니다'}>
            {busy ? '저장 중…' : '지금 다시 저장'}
          </button>
          {!data.canRetry && <span className="muted" style={{ fontSize: 12 }}>다시 저장은 전체 범위 관리자만 실행할 수 있습니다.</span>}
          {msg && <span className="muted" style={{ fontSize: 12, minWidth: 0, overflowWrap: 'anywhere' }}>{msg.text}</span>}
        </div>
      )}
    </div>
  );
}

/* ───────────── 게시글 ───────────── */

function Posts({ onPersist }) {
  const [list, setList] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState('');
  const [writing, setWriting] = useState(false);

  const latest = useLatest();
  const load = useCallback(() => {
    const k = latest.next();
    fetchJson('/board/posts', { q: query, limit: 200 })
      .then((r) => { if (latest.isLatest(k)) { setList(r); setErr(null); } })
      .catch((e) => { if (latest.isLatest(k)) setErr(e); });
  }, [query, latest]);
  useEffect(() => { load(); }, [load]);

  if (openId) return <PostDetail id={openId} me={list?.me} isAdmin={!!list?.isAdmin} canWrite={!!list?.canWrite} limits={list?.limits} onPersist={onPersist} onBack={() => { setOpenId(''); load(); }} />;
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
      {writing && <PostEditor isAdmin={list.isAdmin} limits={list.limits} onPersist={onPersist} onCancel={() => setWriting(false)} onSaved={(p) => { setWriting(false); setOpenId(p.id); }} />}
      {list.rows.length === 0
        ? <div className="muted" style={{ padding: 16 }}>{query ? `‘${query}’ 에 맞는 글이 없습니다.` : '아직 글이 없습니다.'}</div>
        : (
          <STable className="v3-table" minWidth={600}>
            <thead><tr><th>제목</th><th>작성자</th><th>댓글</th><th>공감</th><th>작성</th><th>최근 활동</th></tr></thead>
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
                  <td className="right" data-sort={r.likes ?? 0}>{r.likes ? <span className="board-like-count">♥ {r.likes}</span> : <span className="muted">0</span>}</td>
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

function PostEditor({ initial, isAdmin, limits, onCancel, onSaved, onPersist }) {
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
      // 리뷰 I-05: 저장 상태는 위 배너가 저장될 때까지 말한다(이 편집기는 곧 닫힌다) — 실패·대기 문구는 onSaved 쪽에도 넘긴다.
      if (r?.ok) { onPersist?.(r.persist); onSaved(r.post, r.persist); } else setMsg(saveFailText(r));
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

/** 공감(하트) 버튼 — 눌렀으면 채운 하트. 쓰기 권한이 없으면 개수만 보이고 누를 수 없다(사유는 툴팁). */
function LikeButton({ item, canWrite, busy, onToggle, label = '공감' }) {
  const n = Number.isFinite(item?.likeCount) ? item.likeCount : 0;
  const liked = !!item?.liked;
  const title = canWrite
    ? `${liked ? '공감 취소' : '공감하기'} · ${likersText(item)}`
    : `공감은 운영자·관리자만 할 수 있습니다 · ${likersText(item)}`;
  return (
    <button type="button" className={`board-like${liked ? ' on' : ''}`} disabled={!canWrite || busy}
      aria-pressed={liked} title={title} onClick={onToggle}>
      <span aria-hidden="true">{liked ? '♥' : '♡'}</span> {label}{n ? <b className="board-like-n">{n}</b> : null}
    </button>
  );
}

function PostDetail({ id, me, isAdmin, canWrite, limits, onBack, onPersist }) {
  const [post, setPost] = useState(null);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState('');
  const [reply, setReply] = useState(null); // { rootId, toId, toAuthor } — 답글 입력 중
  const [replyText, setReplyText] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const latest = useLatest();
  const load = useCallback(() => {
    const k = latest.next();
    fetchJson(`/board/posts/${id}`).then((r) => { if (latest.isLatest(k)) { setPost(r.post); setErr(null); } }).catch((e) => { if (latest.isLatest(k)) setErr(e); });
  }, [id, latest]);
  useEffect(() => { load(); }, [load]);

  const mine = (x) => isAdmin || (!!me && x?.author === me);
  // 리뷰 I-05: 성공 응답의 persist 가 실패·대기면 그 자리에서 말한다(공감은 서버가 기다리지 않으므로 waited:false — pending 은 정상).
  const act = async (fn, after, { waited = true } = {}) => {
    setBusy(true); setMsg('');
    try {
      const r = await fn();
      if (r?.ok) { after?.(r); onPersist?.(r.persist); const note = writeResultNote(r.persist, { waited }); if (note) setMsg(note); } else setMsg(saveFailText(r));
    } catch (e) { setMsg(saveFailText({ reason: e.message })); } finally { setBusy(false); }
  };
  const toggleLike = (x, commentId = null) => act(
    () => postJson(commentId ? `/board/posts/${id}/comments/${commentId}/like` : `/board/posts/${id}/like`, { on: !x.liked }),
    (r) => setPost((p) => applyLike(p, commentId, r)),
    { waited: false },
  );
  const openReply = (root, target) => {
    setReply({ rootId: root.id, toId: target.id, toAuthor: target.author || '' });
    setReplyText('');
  };
  const sendReply = () => act(
    () => postJson(`/board/posts/${id}/comments`, { body: replyText, parentId: reply.toId }),
    () => { setReply(null); setReplyText(''); load(); },
  );
  const removeComment = (c, hasReplies) => {
    const q = hasReplies ? '이 댓글을 지울까요? 답글이 있어 ‘삭제된 댓글입니다’ 자리는 남습니다.' : '이 댓글을 지울까요?';
    if (window.confirm(q)) act(() => delJson(`/board/posts/${id}/comments/${c.id}`), load);
  };

  if (err && !post) return <div><button className="btn" onClick={onBack}>← 목록</button><div style={{ marginTop: 10 }}><ErrorBox error={err} /></div></div>;
  if (!post) return <Loading label="글" />;
  const threads = threadComments(post.comments);
  const count = Number.isFinite(post.commentCount) ? post.commentCount : post.comments.filter((c) => !c.deleted).length;

  // 렌더 함수로 부른다(컴포넌트로 두면 렌더마다 새 타입이 되어 행이 다시 마운트된다).
  const commentRow = ({ c, root, isReply, hasReplies }) => (
    <div key={c.id} className={`board-comment${isReply ? ' reply' : ''}`}>
      {c.deleted
        ? <div className="muted board-comment-body">삭제된 댓글입니다.</div>
        : (
          <>
            <div className="board-comment-head">
              <span className="board-comment-meta">
                <b>{c.author}</b><span className="muted"> · {timeText(c.createdAt)}</span>
              </span>
              <span className="board-comment-actions">
                {canWrite && <button type="button" className="board-act" disabled={busy} onClick={() => openReply(root, c)}>답글</button>}
                <LikeButton item={c} canWrite={canWrite} busy={busy} onToggle={() => toggleLike(c, c.id)} />
                {canWrite && mine(c) && <button type="button" className="board-act danger" disabled={busy} onClick={() => removeComment(c, hasReplies)}>삭제</button>}
              </span>
            </div>
            <div className="board-comment-body">{c.replyTo ? <span className="board-mention">@{c.replyTo} </span> : null}{c.body}</div>
          </>
        )}
    </div>
  );

  return (
    <div className="card">
      <button className="btn" onClick={onBack}>← 목록</button>
      {editing
        ? <div style={{ marginTop: 10 }}><PostEditor initial={post} isAdmin={isAdmin} limits={limits} onPersist={onPersist} onCancel={() => setEditing(false)} onSaved={(p, persist) => { setEditing(false); setPost((cur) => ({ ...p, comments: cur.comments, commentCount: cur.commentCount })); setMsg(writeResultNote(persist)); }} /></div>
        : (
          <>
            <h3 className="board-title">{post.pinned && <span className="board-pin">고정</span>}{post.title}</h3>
            <div className="muted" style={{ fontSize: 12 }}>
              {post.author} · 작성 {timeText(post.createdAt)}{post.updatedAt && post.updatedAt !== post.createdAt ? ` · 수정 ${timeText(post.updatedAt)}${post.editedBy && post.editedBy !== post.author ? `(${post.editedBy})` : ''}` : ''}
            </div>
            <div className="board-body">{post.body}</div>
            <div className="board-post-like">
              <LikeButton item={post} canWrite={canWrite} busy={busy} onToggle={() => toggleLike(post)} />
              {!canWrite && <span className="muted" style={{ fontSize: 12 }}>공감·댓글은 운영자·관리자만 할 수 있습니다</span>}
            </div>
            {canWrite && mine(post) && (
              <div className="flex" style={{ gap: 6, marginTop: 10 }}>
                <button className="btn" disabled={busy} onClick={() => setEditing(true)}>수정</button>
                <button className="btn" disabled={busy} onClick={() => { if (window.confirm('이 글을 지울까요? 댓글도 함께 지워집니다.')) act(() => delJson(`/board/posts/${id}`), onBack); }}>삭제</button>
              </div>
            )}
          </>
        )}
      <div className="board-comments">
        <b>댓글 {count}</b>
        {threads.map(({ c, orphan, replies }) => (
          <div key={c.id} className="board-thread">
            {orphan && <div className="muted" style={{ fontSize: 11 }}>원래 댓글을 찾지 못한 답글입니다.</div>}
            {commentRow({ c, root: c, hasReplies: replies.length > 0 })}
            {replies.map((r) => commentRow({ c: r, root: c, isReply: true }))}
            {reply?.rootId === c.id && (
              <div className="board-reply-box">
                <textarea className="input board-comment-input" rows={2} value={replyText} maxLength={2000} autoFocus
                  onChange={(e) => setReplyText(e.target.value)} placeholder={reply.toAuthor ? `@${reply.toAuthor} 에게 답글` : '답글'} />
                <span className="flex" style={{ gap: 6 }}>
                  <button className="btn" disabled={busy} onClick={() => setReply(null)}>취소</button>
                  <button className="btn primary" disabled={busy || !replyText.trim()} onClick={sendReply}>답글 등록</button>
                </span>
              </div>
            )}
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

function NoticeAdmin({ onPersist }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [form, setForm] = useState(null); // null = 닫힘, {id?: …} = 편집 중
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const latest = useLatest();
  const load = useCallback(() => {
    const k = latest.next();
    fetchJson('/notices').then((r) => { if (latest.isLatest(k)) { setData(r); setErr(null); } }).catch((e) => { if (latest.isLatest(k)) setErr(e); });
  }, [latest]);
  useEffect(() => { load(); }, [load]);

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
      if (r?.ok) { setForm(null); load(); onPersist?.(r.persist); setMsg(writeResultNote(r.persist)); } else setMsg(saveFailText(r));
    } catch (e) { setMsg(saveFailText({ reason: e.message })); } finally { setBusy(false); }
  };
  const remove = async (n) => {
    if (!window.confirm(`공지 ‘${n.title}’ 를 지울까요?`)) return;
    setBusy(true); setMsg('');
    try { const r = await delJson(`/notices/${n.id}`); if (r?.ok) { load(); onPersist?.(r.persist); setMsg(writeResultNote(r.persist)); } else setMsg(saveFailText(r)); } catch (e) { setMsg(saveFailText({ reason: e.message })); } finally { setBusy(false); }
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
                    {/* v2.727(B-04): 작성·수정자 계정명은 서버가 admin 에게만 싣는다 — 없으면 칸을 비운다(빈 줄을 만들지 않는다) */}
                    <td data-sort={n.updatedAt}>{timeText(n.updatedAt)}{(n.updatedBy || n.createdBy) ? <div className="muted" style={{ fontSize: 11 }}>{n.updatedBy || n.createdBy}</div> : null}</td>
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
