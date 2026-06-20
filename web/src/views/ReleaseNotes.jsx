import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, delJson } from '../api.js';
import { Modal, Loading } from '../components/ui.jsx';

/** 버전 배지 클릭 시 열리는 릴리즈 노트(변경 이력) 모달. 관리자는 기록 추가 가능. */
export default function ReleaseNotes({ isAdmin, onClose }) {
  const [data, setData] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ version: '', date: '', title: '', notes: '' });
  const [msg, setMsg] = useState(null);

  const load = () => fetchJson('/release-notes').then(setData).catch(() => setData({ notes: [], current: '' }));
  useEffect(() => { load(); }, []);

  const save = async () => {
    const r = await postJson('/admin/release-notes', form).catch((e) => ({ ok: false, reason: e.message }));
    if (r.ok) { setAdding(false); setForm({ version: '', date: '', title: '', notes: '' }); await load(); setMsg(null); }
    else setMsg(r.reason);
  };
  const remove = async (v) => {
    if (!window.confirm(`${v} 기록을 삭제할까요? (관리자 기록만 삭제 가능)`)) return;
    const r = await delJson(`/admin/release-notes/${v}`).catch((e) => ({ ok: false, reason: e.message }));
    if (r?.ok) await load(); else setMsg(r?.reason || '삭제 실패');
  };

  return (
    <Modal title="릴리즈 노트 (변경 이력)" onClose={onClose} width={640}>
      {!data ? <Loading /> : (
        <>
          <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 10 }}>
            <span className="muted" style={{ fontSize: 13 }}>현재 버전 <b style={{ color: 'var(--text)' }}>v{data.current}</b></span>
            {isAdmin && <button className="login-btn" style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setAdding((v) => !v)}>+ 기록 추가</button>}
          </div>

          {msg && <div className="login-error" style={{ marginBottom: 10 }}>{msg}</div>}

          {adding && (
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="flex gap wrap">
                <label style={{ flex: '0 0 110px' }}>버전<input className="input" value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} placeholder="1.17.1" /></label>
                <label style={{ flex: '0 0 130px' }}>날짜<input className="input" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} placeholder="2026-06-20" /></label>
                <label style={{ flex: 1, minWidth: 160 }}>제목<input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="요약 제목" /></label>
              </div>
              <label style={{ display: 'block', marginTop: 8 }}>변경 내용 (한 줄에 하나)
                <textarea className="input" rows={4} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder={'추가한 기능 1\n수정한 내용 2'} style={{ resize: 'vertical' }} />
              </label>
              <div className="flex gap" style={{ marginTop: 8 }}>
                <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={!form.version} onClick={save}>저장</button>
                <button className="logout-btn" style={{ padding: '8px 14px' }} onClick={() => setAdding(false)}>취소</button>
              </div>
            </div>
          )}

          <div style={{ maxHeight: '56vh', overflow: 'auto' }}>
            {data.notes.map((n) => (
              <div key={n.version} style={{ padding: '10px 0', borderBottom: '1px solid var(--border, rgba(255,255,255,.08))' }}>
                <div className="flex between" style={{ alignItems: 'baseline' }}>
                  <div>
                    <span className="badge blue" style={{ marginRight: 8 }}>v{n.version}</span>
                    <b>{n.title}</b>
                    {n.source === 'user' && <span className="badge amber" style={{ marginLeft: 6, fontSize: 10 }}>기록</span>}
                  </div>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {n.date}
                    {isAdmin && n.source === 'user' && <button className="logout-btn" style={{ padding: '2px 8px', marginLeft: 8 }} onClick={() => remove(n.version)}>삭제</button>}
                  </span>
                </div>
                <ul style={{ margin: '6px 0 0', paddingLeft: 20, fontSize: 13, lineHeight: 1.7 }}>
                  {(n.notes || []).map((line, i) => <li key={i}>{line}</li>)}
                </ul>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
