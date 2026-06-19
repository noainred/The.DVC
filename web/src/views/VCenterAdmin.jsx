import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, putJson, delJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

const REGIONS = ['Americas', 'EMEA', 'APAC'];
const EMPTY = {
  id: '', name: '', host: 'https://', username: '', password: '',
  location: { city: '', country: '', region: 'APAC', lat: '', lon: '' },
};

export default function VCenterAdmin() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);     // null = closed; object = add/edit
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try { setData(await fetchJson('/admin/vcenters')); setError(null); }
    catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  const openAdd = () => { setEditing(false); setForm(structuredClone(EMPTY)); setMsg(null); };
  const openEdit = (vc) => {
    setEditing(true);
    setForm({ ...structuredClone(EMPTY), ...vc, password: '', location: { ...EMPTY.location, ...vc.location } });
    setMsg(null);
  };
  const close = () => { setForm(null); setMsg(null); };

  const setF = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setLoc = (k) => (e) => setForm((f) => ({ ...f, location: { ...f.location, [k]: e.target.value } }));

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = editing ? await putJson(`/admin/vcenters/${form.id}`, form) : await postJson('/admin/vcenters', form);
      if (r.ok) { await load(); close(); }
      else setMsg({ ok: false, text: r.reason });
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  const test = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/admin/vcenters/test', form);
      setMsg(r.ok ? { ok: true, text: `연결 성공 (${r.ms}ms)` } : { ok: false, text: `연결 실패: ${r.reason}` });
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  const remove = async (vc) => {
    if (!window.confirm(`'${vc.name}' (${vc.id}) 을(를) 삭제할까요?`)) return;
    try { await delJson(`/admin/vcenters/${vc.id}`); await load(); }
    catch (e) { setError(e.message); }
  };

  const list = data.vcenters || [];

  return (
    <>
      <div className="flex between wrap" style={{ marginBottom: 6 }}>
        <div className="section-title" style={{ margin: '6px 0' }}>vCenter 등록 · 관리 (관리자)</div>
        <button className="login-btn" style={{ flex: 'none', padding: '9px 16px' }} onClick={openAdd}>+ vCenter 추가</button>
      </div>

      {data.dataSource === 'mock' && (
        <div className="card" style={{ marginBottom: 14, borderColor: 'var(--amber)' }}>
          <b style={{ color: 'var(--amber)' }}>ℹ 현재 데이터 소스: mock(데모)</b>
          <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>
            여기서 등록한 vCenter는 <code>config/vcenters.json</code> 에 저장되며, 실제 수집은
            서버를 <code>DATA_SOURCE=live</code> (또는 <code>auto</code>) 로 실행할 때 반영됩니다.
            대시보드의 현재 숫자는 데모 데이터입니다.
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead><tr>
            <th>ID</th><th>이름</th><th>호스트</th><th>계정</th><th>리전</th><th>위치</th><th>자격증명</th><th className="right">작업</th>
          </tr></thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={8} className="center muted" style={{ padding: 28 }}>등록된 vCenter가 없습니다. “+ vCenter 추가”로 등록하세요.</td></tr>}
            {list.map((vc) => (
              <tr key={vc.id}>
                <td><b>{vc.id}</b></td>
                <td>{vc.name}</td>
                <td className="muted">{vc.host}</td>
                <td className="muted">{vc.username}</td>
                <td><span className="badge blue">{vc.location?.region || '-'}</span></td>
                <td className="muted">{[vc.location?.city, vc.location?.country].filter(Boolean).join(', ') || '-'}</td>
                <td>{vc.hasPassword ? <span className="badge green">설정됨</span> : <span className="badge gray">없음</span>}</td>
                <td className="right nowrap">
                  <button className="tab" onClick={() => openEdit(vc)}>수정</button>
                  <button className="tab" style={{ color: 'var(--red)' }} onClick={() => remove(vc)}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {form && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
          <div className="modal card">
            <div className="flex between" style={{ marginBottom: 12 }}>
              <b style={{ fontSize: 15 }}>{editing ? `vCenter 수정 — ${form.id}` : '새 vCenter 등록'}</b>
              <button className="logout-btn" onClick={close}>닫기</button>
            </div>
            <div className="spec-grid">
              <label>ID *<input className="input" value={form.id} onChange={setF('id')} disabled={editing} placeholder="vc-seoul" /></label>
              <label>표시 이름 *<input className="input" value={form.name} onChange={setF('name')} placeholder="vcenter-seoul-01" /></label>
              <label style={{ gridColumn: '1 / -1' }}>호스트 URL *<input className="input" value={form.host} onChange={setF('host')} placeholder="https://vcenter.corp.local" /></label>
              <label>계정 *<input className="input" value={form.username} onChange={setF('username')} placeholder="monitor@vsphere.local" /></label>
              <label>비밀번호 {editing && <span className="muted">(비우면 유지)</span>}<input className="input" type="password" value={form.password} onChange={setF('password')} placeholder={editing ? '••••••' : ''} /></label>
              <label>리전
                <select className="select" value={form.location.region} onChange={setLoc('region')}>
                  {REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>
              <label>도시<input className="input" value={form.location.city} onChange={setLoc('city')} placeholder="Seoul" /></label>
              <label>국가<input className="input" value={form.location.country} onChange={setLoc('country')} placeholder="South Korea" /></label>
              <label>위도(lat)<input className="input" value={form.location.lat} onChange={setLoc('lat')} placeholder="37.57" /></label>
              <label>경도(lon)<input className="input" value={form.location.lon} onChange={setLoc('lon')} placeholder="126.98" /></label>
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
            <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
              저장 시 즉시 재수집이 트리거됩니다. 자격증명은 서버 <code>config/vcenters.json</code>(0600, gitignore)에만 저장됩니다.
            </div>
          </div>
        </div>
      )}
    </>
  );
}
