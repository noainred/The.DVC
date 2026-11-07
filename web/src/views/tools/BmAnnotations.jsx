/**
 * 리눅스 성능 6단계 — **운영 주석** 카드(목록 · 추가 · 고치기 · 지우기) · 설계 PROFILES §16 A · 아트보드 Annot.
 *
 * 추이 탭이 창의 주석을 한 번 읽어(useAnnotations) 패널 행 · 겹침 카드에 ◆ 핀으로 그리고, 이 카드가 목록 · 입력을 맡는다.
 * ⚠ 쓰기는 operator 이상 · 고치기/지우기는 서버가 준 canEdit(작성자 · 관리자 · 쓰기 범위)일 때만 — 서버가 다시 막는다.
 * ⚠ 저장 결과는 r?.ok === false 로 검사(sendJson 은 400 · 409 를 던지지 않는다 — postJson 은 409 만). 조회는 창이 바뀔 때 1회(폴링 없음).
 */
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, delJson, hasRole } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { toneVar } from './toneVar.js';
import {
  ANNOT_KIND_TEXT, ANNOT_KIND_SHORT, TARGET_TYPE_TEXT, annotWhenText, annotTargetText, annotLinks, annotBody, annotEditPatch, localInputOf, msOfLocalInput, ANNOT_HONEST,
} from './bmAnnotText.js';
import './bmStage6.css';

/** 창의 주석 — keys(서버 키들) · from/to. 늦게 온 이전 창 응답은 버린다. */
export function useAnnotations(keys = [], win = null, tick = 0) {
  const [st, setSt] = useState({ list: [], err: null, loading: false });
  const gen = useRef(0);
  const sig = `${keys.join(',')}|${Math.floor(win?.from || 0)}|${Math.floor(win?.to || 0)}|${tick}`;
  useEffect(() => {
    if (!keys.length || !win) { setSt({ list: [], err: null, loading: false }); return; }
    const g = ++gen.current;
    setSt((p) => ({ ...p, loading: true, err: null }));
    fetchJson('/tools/bm-usage/annotations', { keys: keys.join(','), from: Math.floor(win.from), to: Math.floor(win.to) }, undefined, { timeoutMs: 30_000 })
      .then((r) => { if (g === gen.current) setSt({ list: r.annotations || [], err: null, loading: false }); })
      .catch((e) => { if (g === gen.current) setSt({ list: [], err: e, loading: false }); });
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  return st;
}

export function AnnotTable({ list = [], onEdit, onDelete }) {
  if (!list.length) return <p className="bmo-note">이 창에 운영 주석이 없습니다.</p>;
  return (
    <STable minWidth={760} className="bmo-t" style={{ fontSize: 12 }}>
      <thead><tr><th>시각(범위)</th><th>종류</th><th>내용</th><th>대상</th><th>연결</th><th>작성</th><th data-nosort /></tr></thead>
      <tbody>
        {list.map((a) => (
          <tr key={a.id} style={a.deleted ? { opacity: 0.6 } : undefined}>
            <td data-sort={a.at}>◆ {annotWhenText(a)}</td>
            <td data-sort={a.kind}>{ANNOT_KIND_SHORT[a.kind] || a.kind}</td>
            <td data-sort={a.text || ''} className="bmo-wrap">{a.deleted ? <i>삭제됨({a.deleted.by} · {annotWhenText({ at: a.deleted.at })})</i> : a.text}{!!a.edits?.length && !a.deleted && <div className="bmo-sub">수정 {a.edits.length}회 · 마지막 {a.edits.at(-1).by}</div>}</td>
            <td data-sort={annotTargetText(a)}>{TARGET_TYPE_TEXT[a.target?.type] || ''}<div className="bmo-sub">{annotTargetText(a)}</div></td>
            <td data-sort={Object.keys(a.links || {}).length}>{annotLinks(a.links).map((l, i) => (l.href ? <div key={i}><a href={l.href} style={{ color: 'var(--accent-2)' }}>{l.text}</a></div> : <div key={i} className="bmo-sub">{l.text}</div>))}{!annotLinks(a.links).length && '—'}</td>
            <td data-sort={a.by}>{a.by}{a.auto ? <div className="bmo-sub">자동</div> : null}</td>
            <td data-nosort>{a.canEdit && <span className="bmcmp-btns"><button type="button" className="btn btn-sm bmp-touch" onClick={() => onEdit?.(a)}>고치기</button><button type="button" className="btn btn-sm bmp-touch" onClick={() => onDelete?.(a)}>지우기</button></span>}</td>
          </tr>
        ))}
      </tbody>
    </STable>
  );
}

/**
 * @param {{itemKey:string, name?:string, vcenterId?:string, win:{from,to}, sel?:{from,to}|null, list:Array, err?:any, onChanged:()=>void, extraKeys?:string[]}} p
 */
export default function AnnotationsCard({ itemKey, name = '', vcenterId = '', sel = null, list = [], err = null, onChanged }) {
  const canWrite = hasRole('admin', 'operator');
  const [form, setForm] = useState(null);   // { id?, at, end, kind, text, target:'server'|'corp', issue, wikiSpace, wikiId }
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const openNew = () => { setMsg(null); setForm({ at: localInputOf(sel?.from ?? Date.now()), end: sel ? localInputOf(sel.to) : '', kind: 'work', text: '', target: 'server', issue: '', wikiSpace: '', wikiId: '' }); };
  const openEdit = (a) => { setMsg(null); setForm({ id: a.id, orig: a, at: localInputOf(a.at), end: a.end ? localInputOf(a.end) : '', kind: a.kind, text: a.text, target: a.target?.type === 'corp' ? 'corp' : 'server', issue: a.links?.issue || '', wikiSpace: a.links?.wiki?.space || '', wikiId: a.links?.wiki?.id || '' }); };
  async function save() {
    setBusy(true); setMsg(null);
    try {
      let r;
      if (form.id) {
        // 바뀐 칸만(원래 시각의 초 · 집중 세션 · 백업 연결을 보존 — 반증 F10)
        const patch = annotEditPatch(form.orig, form);
        if (!Object.keys(patch).length) { setForm(null); setMsg({ tone: 'ok', text: '바뀐 것이 없습니다.' }); return; }
        r = await putJson(`/tools/bm-usage/annotations/${encodeURIComponent(form.id)}`, patch);
      } else {
        const body = annotBody({ keys: [itemKey], corp: form.target === 'corp' ? vcenterId : '', at: msOfLocalInput(form.at), end: msOfLocalInput(form.end), kind: form.kind, text: form.text, issue: form.issue, wikiSpace: form.wikiSpace, wikiId: form.wikiId });
        r = await postJson('/tools/bm-usage/annotations', body);
      }
      if (r?.ok === false) { setMsg({ tone: 'bad', text: r.reason || '저장하지 못했습니다.' }); return; }
      setForm(null); setMsg({ tone: 'ok', text: '주석을 저장했습니다(감사 기록).' }); onChanged?.();
    } catch (e) { setMsg({ tone: 'bad', text: e?.message || String(e) }); }
    finally { setBusy(false); }
  }
  async function remove(a) {
    setMsg(null);
    try { const r = await delJson(`/tools/bm-usage/annotations/${encodeURIComponent(a.id)}`); if (r?.ok === false) setMsg({ tone: 'bad', text: r.reason || '지우지 못했습니다.' }); else { setMsg({ tone: 'ok', text: '지웠습니다(삭제됨 흔적은 남습니다).' }); onChanged?.(); } }
    catch (e) { setMsg({ tone: 'bad', text: e?.message || String(e) }); }
  }
  return (
    <section className="bmt-card" aria-label="운영 주석">
      <div className="bmt-panel-head">
        <h5>운영 주석 ◆ — 사람이 아는 맥락(기계 이벤트 ● 와 같은 줄)</h5>
        <span style={{ flex: '1 1 auto' }} />
        {canWrite && !form && <button type="button" className="btn btn-sm bmp-touch" onClick={openNew}>주석 추가{sel ? '(선택 구간)' : ''}</button>}
      </div>
      {err && (err.status === 403 ? <ErrorBox error={err} /> : <p className="bmo-note" style={{ color: toneVar('warn') }}>주석을 읽지 못했습니다: {err.message || String(err)}</p>)}
      {form && (
        <div className="bmr-grid" style={{ marginBottom: 8 }}>
          <label>시각<input className="input" type="datetime-local" value={form.at} onChange={(e) => setForm({ ...form, at: e.target.value })} /></label>
          <label>끝(선택 — 범위 주석)<input className="input" type="datetime-local" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} /></label>
          <label>종류
            <Select sort={false} className="select" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {Object.entries(ANNOT_KIND_TEXT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </label>
          {!form.id && (
            <label>대상
              <Select sort={false} className="select" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })}>
                <option value="server">이 서버({name || itemKey})</option>
                {vcenterId && <option value="corp">법인 전체({vcenterId})</option>}
              </Select>
            </label>
          )}
          <label style={{ gridColumn: '1 / -1' }}>내용(500자)<textarea className="input" rows={3} maxLength={500} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} /></label>
          <label>연결 — 이슈 키(예: ISS-12)<input className="input" type="text" maxLength={14} value={form.issue} onChange={(e) => setForm({ ...form, issue: e.target.value })} /></label>
          <label>연결 — 위키 문서(W번호 · 스페이스)<span className="bmcmp-save"><input className="input" type="text" placeholder="W123" maxLength={12} value={form.wikiId} onChange={(e) => setForm({ ...form, wikiId: e.target.value })} /><input className="input" type="text" placeholder="pub" maxLength={128} value={form.wikiSpace} onChange={(e) => setForm({ ...form, wikiSpace: e.target.value })} /></span></label>
          <div className="bmcmp-btns" style={{ gridColumn: '1 / -1' }}>
            <button type="button" className="btn btn-sm bmp-touch" disabled={busy || !form.text.trim() || !form.at} onClick={save}>{busy ? '저장하는 중…' : '저장'}</button>
            <button type="button" className="btn btn-sm bmp-touch" onClick={() => setForm(null)}>취소</button>
          </div>
        </div>
      )}
      {msg && <p className="bmo-note" style={{ color: toneVar(msg.tone) }}>{msg.text}</p>}
      <AnnotTable list={list} onEdit={openEdit} onDelete={remove} />
      <p className="bmo-note">{ANNOT_HONEST}</p>
    </section>
  );
}
