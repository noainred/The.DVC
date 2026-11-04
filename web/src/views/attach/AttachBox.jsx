/**
 * AttachBox — 위키 문서 · 이슈 첨부(v2.886 · C-4). 서버는 routes/api/attach.js.
 *  · 보기는 그 문서 · 이슈를 볼 수 있는 사람 전부, 올리기 · 지우기는 쓰기 범위(서버 canUpload · 지우기는 올린 사람/전체 범위 관리자).
 *  · 파일은 인증을 붙여 받는다(fetchBlob) — <img src> · 주소창은 인증 머리말을 싣지 못한다. 그림은 서버가 '그림' 으로 판정한 것만 미리 본다.
 *  · 본문에 넣기: 위키 편집기에서 ![이름](attach:<id>) · [이름](attach:<id>) 를 넣는다(마크다운 해석기가 attach: 만 첨부로 읽는다).
 *  · 첨부는 포탈 백업에 들어가지 않는다(사용자 결정 — 관리자가 '첨부 전체 내려받기' 로 따로 받는다). 화면이 그 사실을 적는다.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, delJson, postBinary, fetchBlob } from '../../api.js';
import { attachSizeText, attachFailText, attachMarkdown } from './attachText.js';

/** 인증 붙여 받은 그림(object URL — 언마운트 때 해제). 못 받으면 대체 글. */
export function AttachImg({ id, alt = '', className = 'md-img' }) {
  const [url, setUrl] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true; let u = '';
    fetchBlob(`/attach/file/${id}?inline=1`)
      .then((b) => { if (!alive) return; if (!/^image\//.test(b.type)) { setErr('그림이 아닌 첨부입니다'); return; } u = URL.createObjectURL(b); setUrl(u); })
      .catch((e) => { if (alive) setErr(e?.status === 404 ? '볼 수 없거나 지워진 첨부' : e?.status === 410 ? '파일 본체가 없는 첨부' : '그림을 받지 못했습니다'); });
    return () => { alive = false; if (u) URL.revokeObjectURL(u); };
  }, [id]);
  if (err) return <span className="md-attach-miss" title={err}>[그림: {alt || id.slice(0, 8)} — {err}]</span>;
  if (!url) return <span className="md-attach-miss muted">[그림 읽는 중…]</span>;
  return <img src={url} alt={alt} className={className} loading="lazy" />;
}

/** 인증 붙여 받아 내려받기. */
export async function downloadAttach(id, name) {
  const b = await fetchBlob(`/attach/file/${id}`);
  const u = URL.createObjectURL(b);
  const a = document.createElement('a');
  a.href = u; a.download = name || 'download';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}
export function AttachLink({ id, children }) {
  const [msg, setMsg] = useState('');
  return (
    <button type="button" className="md-linkbtn md-attach-link" title={msg || '첨부 내려받기'} onClick={() => { setMsg(''); downloadAttach(id, '').catch((e) => setMsg(e?.status === 404 ? '볼 수 없거나 지워진 첨부' : e?.status === 410 ? '파일 본체가 없는 첨부' : String(e?.message || e))); }}>
      📎 {children}{msg ? <span className="muted"> — {msg}</span> : null}
    </button>
  );
}

/**
 * @param {{ kind:'wiki'|'issue', owner:string, onInsert?:(md:string)=>void, compact?:boolean }} props
 */
export default function AttachBox({ kind, owner, onInsert = null, compact = false }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const input = useRef(null);
  const seq = useRef(0);
  const load = useCallback(() => {
    const k = ++seq.current;
    fetchJson(`/attach/${kind}/${owner}`).then((r) => { if (k === seq.current) { setData(r); setErr(null); } }).catch((e) => { if (k === seq.current) setErr(e); });
  }, [kind, owner]);
  useEffect(() => { load(); }, [load]);
  const upload = async (files) => {
    const list = [...(files || [])];
    if (!list.length) return;
    setBusy(true); setMsg('');
    const fails = [];
    for (const f of list) {
      try {
        const r = await postBinary(`/attach/${kind}/${owner}?name=${encodeURIComponent(f.name)}`, f);
        if (r?.ok === false) fails.push(`${f.name}: ${attachFailText(r, data?.limits)}`);
      } catch (e) { fails.push(`${f.name}: ${e?.message || e}`); }
    }
    setBusy(false);
    if (input.current) input.current.value = '';
    setMsg(fails.length ? `올리지 못한 파일 ${fails.length}개 — ${fails.join(' · ')}` : `${list.length}개를 올렸습니다.`);
    load();
  };
  const remove = async (x) => {
    if (!window.confirm(`첨부 ‘${x.name}’ 를 지울까요? 본문에 넣은 링크는 ‘지워진 첨부’ 로 보입니다.`)) return;
    setBusy(true); setMsg('');
    try { const r = await delJson(`/attach/file/${x.id}`); setMsg(r?.ok === false ? attachFailText(r) : '지웠습니다.'); } catch (e) { setMsg(String(e?.message || e)); } finally { setBusy(false); load(); }
  };
  if (err && !data) return <div className="muted iss-small">첨부를 읽지 못했습니다 — {err.message || String(err)}</div>;
  if (!data) return <div className="muted iss-small">첨부 읽는 중…</div>;
  const items = data.items || [];
  const lim = data.limits || {};
  return (
    <section className={`attach-box${compact ? ' compact' : ''}`} aria-label="첨부">
      <div className="attach-head">
        <b>첨부 {items.length}</b>
        {data.canUpload && (
          <>
            <input ref={input} type="file" multiple hidden onChange={(e) => upload(e.target.files)} accept={(data.exts || []).map((x) => `.${x}`).join(',')} />
            <button type="button" className="btn btn-sm" disabled={busy || items.length >= (lim.perOwner || 20)} onClick={() => input.current?.click()}>{busy ? '올리는 중…' : '+ 파일'}</button>
          </>
        )}
        <span className="muted attach-note">파일당 {attachSizeText(lim.fileBytes)} · {lim.perOwner || 20}개까지 · 포탈 백업에는 들어가지 않습니다</span>
      </div>
      {msg && <div className="banner" style={{ whiteSpace: 'normal' }}>{msg}</div>}
      {items.length > 0 && (
        <ul className="attach-list">
          {items.map((x) => (
            <li key={x.id} className={x.missing ? 'missing' : undefined}>
              {x.image && !x.missing ? <span className="attach-thumb"><AttachImg id={x.id} alt={x.name} className="attach-thumb-img" /></span> : <span className="attach-ext">{x.ext}</span>}
              <span className="attach-main">
                {x.missing
                  ? <span className="attach-name" title="첨부 목록에는 있지만 파일 본체가 없습니다(백업에서 되살린 포탈이면 첨부를 따로 옮겨야 합니다)">{x.name} <span className="muted">(파일 없음)</span></span>
                  : <button type="button" className="md-linkbtn attach-name" onClick={() => downloadAttach(x.id, x.name).catch((e) => setMsg(String(e?.message || e)))}>{x.name}</button>}
                <span className="muted attach-meta">{attachSizeText(x.size)} · {x.by} · {new Date(x.at).toLocaleDateString()}</span>
              </span>
              <span className="attach-acts">
                {onInsert && !x.missing && <button type="button" className="btn btn-sm" onClick={() => onInsert(attachMarkdown(x))} title="본문 커서 자리에 넣습니다">본문에 넣기</button>}
                {data.canUpload && (x.by === data.me || data.isMod) && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => remove(x)}>지우기</button>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
