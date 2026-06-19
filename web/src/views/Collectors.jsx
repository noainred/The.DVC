import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, delJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import EscClose from '../components/EscClose.jsx';

const EMPTY = { id: '', name: '', datacenter: '', url: 'http://', token: '', enabled: true };

export default function Collectors() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState(null);
  const [central, setCentral] = useState(null);

  const load = async () => {
    try { setData(await fetchJson('/admin/collectors')); setError(null); }
    catch (e) { setError(e.message); }
  };
  useEffect(() => {
    load();
    fetchJson('/health').then((h) => setCentral(h.version)).catch(() => {});
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  const upgrade = async (id) => {
    const who = id ? `'${id}' 에이전트` : '모든 수집 에이전트';
    if (!window.confirm(`${who}를 중앙 포탈 버전(v${central || '?'})으로 업그레이드하고 재시작할까요?`)) return;
    setBusy(true); setBanner(null);
    try {
      const r = await postJson('/admin/collectors/upgrade', id ? { id } : {});
      setBanner(r.ok
        ? { ok: true, text: `업그레이드 푸시 완료: ${r.succeeded}/${r.pushed} 성공 (v${r.version}, ${r.source})` }
        : { ok: false, text: r.reason });
      setTimeout(load, 5000);
    } catch (e) { setBanner({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  const openAdd = () => { setEditing(false); setForm({ ...EMPTY }); setMsg(null); };
  const openEdit = (c) => { setEditing(true); setForm({ ...EMPTY, ...c, token: '' }); setMsg(null); };
  const close = () => { setForm(null); setMsg(null); };
  const setF = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = editing ? await putJson(`/admin/collectors/${encodeURIComponent(form.id)}`, form) : await postJson('/admin/collectors', form);
      if (r.ok) { await load(); close(); } else setMsg({ ok: false, text: r.reason });
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  const test = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/admin/collectors/test', form);
      setMsg(r.ok
        ? { ok: true, text: `연결 성공 (${r.ms}ms) · 호스트 ${r.hosts ?? '—'}대 · v${r.version || '?'}${r.datacenter ? ` · ${r.datacenter}` : ''}` }
        : { ok: false, text: `연결 실패: ${r.reason}` });
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  const remove = async (c) => {
    if (!window.confirm(`'${c.name}' (${c.id}) 수집 서버를 삭제할까요?`)) return;
    try { await delJson(`/admin/collectors/${encodeURIComponent(c.id)}`); await load(); }
    catch (e) { setError(e.message); }
  };

  const pullNow = async () => {
    setBusy(true);
    try { await postJson('/admin/collectors/pull', {}); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const list = data.collectors || [];
  const status = data.status || {};
  const totalHosts = Object.values(status).reduce((a, s) => a + (s.ok ? (s.hosts || 0) : 0), 0);

  return (
    <>
      <div className="flex between wrap gap" style={{ marginBottom: 6 }}>
        <div className="section-title" style={{ margin: '6px 0' }}>수집 서버 — 분산 수집 (관리자)</div>
        <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          {central && <span className="muted" style={{ fontSize: 12 }}>중앙 버전 <b style={{ color: 'var(--text)' }}>v{central}</b></span>}
          <button className="logout-btn" style={{ padding: '9px 14px' }} disabled={busy} onClick={pullNow}>지금 동기화</button>
          <button className="logout-btn" style={{ padding: '9px 14px' }} disabled={busy} onClick={() => upgrade(null)}>모두 업그레이드</button>
          <button className="login-btn" style={{ flex: 'none', padding: '9px 16px' }} onClick={openAdd}>+ 수집 서버 추가</button>
        </div>
      </div>

      {banner && (
        <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 8, fontSize: 13,
          background: banner.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)',
          color: banner.ok ? '#4ade80' : '#f87171' }}>{banner.text}</div>
      )}

      <div className="card" style={{ marginBottom: 12, padding: '10px 14px' }}>
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.8 }}>
          각 데이터센터에 포탈을 <b>수집 에이전트</b>로 설치하면(<code>COLLECTOR_TOKEN</code>·<code>COLLECTOR_DATACENTER</code> 설정),
          그 서버가 로컬 iDRAC/OME 전력을 수집합니다. 중앙 포탈은 여기에 등록된 수집 서버들을 주기적으로
          당겨와(<code>/api/collector/export</code>) 호스트 전력에 병합합니다. 1천대+·13개 DC 같은 대규모 환경에 적합합니다.
          {' '}현재 병합된 호스트: <b style={{ color: 'var(--text)' }}>{totalHosts.toLocaleString()}</b>대.
          <br />🔄 <b>자동 업그레이드</b>: 중앙 포탈이 새 버전으로 업그레이드되면 등록된 모든 에이전트로 자동 푸시됩니다.
          수동으로는 “모두 업그레이드”(또는 행별 “업그레이드”)로 즉시 동일 버전으로 맞출 수 있습니다.
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead><tr>
            <th>ID</th><th>이름</th><th>데이터센터</th><th>URL</th><th>상태</th><th>호스트</th><th>버전</th><th>최근 동기화</th><th>수집</th><th className="right">작업</th>
          </tr></thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={10} className="center muted" style={{ padding: 28 }}>등록된 수집 서버가 없습니다. “+ 수집 서버 추가”로 등록하세요.</td></tr>}
            {list.map((c) => {
              const s = status[c.id];
              return (
                <tr key={c.id}>
                  <td><b>{c.id}</b></td>
                  <td>{c.name}</td>
                  <td>{c.datacenter ? <span className="badge blue">{c.datacenter}</span> : <span className="muted">—</span>}</td>
                  <td className="muted">{c.url}</td>
                  <td>{!s ? <span className="badge gray">대기</span> : s.ok ? <span className="badge green">정상</span> : <span className="badge red" title={s.error}>오류</span>}</td>
                  <td className="tabular">{s?.ok ? (s.hosts ?? 0).toLocaleString() : '—'}</td>
                  <td className="muted">
                    {s?.version ? <>v{s.version}{central && s.version !== central && <span className="badge amber" style={{ marginLeft: 6 }} title={`중앙 v${central}`}>구버전</span>}</> : '—'}
                    {s?.upgrade && <div className="muted" style={{ fontSize: 11, color: s.upgrade.ok ? 'var(--green)' : 'var(--red)' }}>{s.upgrade.ok ? `업그레이드 v${s.upgrade.version || ''} 적용` : `업그레이드 실패`}</div>}
                  </td>
                  <td className="muted">{s?.at ? new Date(s.at).toLocaleTimeString('ko-KR') : '—'}</td>
                  <td>{c.enabled === false ? <span className="badge gray">중지</span> : <span className="badge green">on</span>}</td>
                  <td className="right nowrap">
                    <button className="tab" disabled={busy} onClick={() => upgrade(c.id)}>업그레이드</button>
                    <button className="tab" onClick={() => openEdit(c)}>수정</button>
                    <button className="tab" style={{ color: 'var(--red)' }} onClick={() => remove(c)}>삭제</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {form && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
          <EscClose onClose={close} />
          <div className="modal card">
            <div className="flex between" style={{ marginBottom: 12 }}>
              <b style={{ fontSize: 15 }}>{editing ? `수집 서버 수정 — ${form.id}` : '새 수집 서버 등록'}</b>
              <button className="logout-btn" onClick={close}>닫기</button>
            </div>
            <div className="spec-grid">
              <label>ID *<input className="input" value={form.id} onChange={setF('id')} disabled={editing} placeholder="dc-seoul" /></label>
              <label>표시 이름 *<input className="input" value={form.name} onChange={setF('name')} placeholder="서울 수집서버" /></label>
              <label>데이터센터<input className="input" value={form.datacenter} onChange={setF('datacenter')} placeholder="Seoul-DC1" /></label>
              <label>수집 여부
                <select className="select" value={form.enabled ? '1' : '0'} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.value === '1' }))}>
                  <option value="1">수집</option>
                  <option value="0">중지</option>
                </select>
              </label>
              <label style={{ gridColumn: '1 / -1' }}>수집 서버 URL *<input className="input" value={form.url} onChange={setF('url')} placeholder="http://10.10.0.5:4000" /></label>
              <label style={{ gridColumn: '1 / -1' }}>토큰 (COLLECTOR_TOKEN) {editing && <span className="muted">(비우면 유지)</span>}
                <input className="input" type="password" value={form.token} onChange={setF('token')} placeholder={editing ? '••••••' : '에이전트의 COLLECTOR_TOKEN'} />
              </label>
            </div>

            {msg && (
              <div style={{ marginTop: 12, padding: '9px 12px', borderRadius: 8, fontSize: 13,
                background: msg.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)',
                color: msg.ok ? '#4ade80' : '#f87171' }}>{msg.text}</div>
            )}

            <div className="flex gap" style={{ marginTop: 16 }}>
              <button className="login-btn" style={{ flex: 'none', padding: '10px 18px' }} disabled={busy} onClick={save}>
                {busy ? '저장 중…' : (editing ? '저장' : '등록')}
              </button>
              <button className="logout-btn" style={{ padding: '10px 18px' }} disabled={busy} onClick={test}>연결 테스트</button>
            </div>
            <div className="muted" style={{ marginTop: 10, fontSize: 12, lineHeight: 1.7 }}>
              에이전트 서버는 다음으로 실행합니다: <code>COLLECTOR_TOKEN=&lt;토큰&gt; COLLECTOR_DATACENTER=Seoul-DC1</code>.
              그 서버의 ‘전력 수집’ 메뉴에서 로컬 iDRAC/OME를 등록하세요. 토큰은 <code>$CONFIG_DIR/collectors.json</code>(0600)에만 저장됩니다.
            </div>
          </div>
        </div>
      )}
    </>
  );
}
