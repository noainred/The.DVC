import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, putJson, delJson, usePolling } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import EscClose from '../components/EscClose.jsx';

const REGIONS = ['아시아', '중국', '유럽', '북미'];
const EMPTY = { id: '', name: '', host: 'https://', username: '', password: '', vcenterId: '', proxyId: '', enabled: true, pollIntervalSec: '', timeoutMs: '', location: { region: '아시아' } };

/** 설정 → NSX 관리: NSX Manager 등록/수정/연결테스트/삭제. (vCenter와 별개 수집기) */
export default function NsxAdmin() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const { data: vcenters } = usePolling('/vcenters', {}, 60_000);
  const [proxies, setProxies] = useState([]);
  useEffect(() => { fetchJson('/remote/proxies').then((r) => setProxies(r.proxies || [])).catch(() => setProxies([])); }, []);

  const load = async () => {
    try { setData(await fetchJson('/admin/nsx/managers')); setError(null); }
    catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  const openAdd = () => { setEditing(false); setForm(structuredClone(EMPTY)); setMsg(null); };
  const openEdit = (m) => { setEditing(true); setForm({ ...structuredClone(EMPTY), ...m, password: '', location: { ...EMPTY.location, ...m.location } }); setMsg(null); };
  const close = () => { setForm(null); setMsg(null); };
  const setF = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setLoc = (k) => (e) => setForm((f) => ({ ...f, location: { ...f.location, [k]: e.target.value } }));

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = editing ? await putJson(`/admin/nsx/managers/${encodeURIComponent(form.id)}`, form) : await postJson('/admin/nsx/managers', form);
      if (r.ok) { await load(); close(); } else setMsg({ ok: false, text: r.reason });
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/admin/nsx/managers/test', form);
      setMsg(r.ok ? { ok: true, text: `연결 성공 (${r.ms}ms)` } : { ok: false, text: `연결 실패: ${r.reason}${r.hint ? ` — ${r.hint}` : ''}` });
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  const remove = async (m) => {
    if (!window.confirm(`'${m.name}' (${m.id}) NSX Manager를 삭제할까요?`)) return;
    try { await delJson(`/admin/nsx/managers/${encodeURIComponent(m.id)}`); await load(); } catch (e) { setError(e.message); }
  };

  const list = data.managers || [];

  return (
    <>
      <div className="flex between wrap gap" style={{ marginBottom: 6 }}>
        <div className="section-title" style={{ margin: '6px 0' }}>NSX Manager 등록 · 관리 (관리자)</div>
        <button className="login-btn" style={{ flex: 'none', padding: '9px 16px' }} onClick={openAdd}>+ NSX Manager 추가</button>
      </div>

      <div className="card" style={{ marginBottom: 12, padding: '12px 14px' }}>
        <div className="muted" style={{ fontSize: 13, lineHeight: 1.7 }}>
          NSX는 vCenter가 아닌 <b>NSX Manager</b>가 관리합니다. 여기 등록한 자격증명으로 NSX Policy/Manager API(<code>/policy/api/v1</code>, <code>/api/v1</code>)를 폴링해
          T0/T1 게이트웨이·세그먼트·전송노드·분산방화벽(DFW)을 수집합니다. 자격증명은 <code>$CONFIG_DIR/nsx.json</code>(0600, gitignore)에 저장됩니다.
          데이터 소스가 <b>mock</b>이면 데모 데이터가 표시되고, <b>live/auto</b>일 때 실제 수집됩니다. (데이터 소스 전환은 설정 → vCenter 관리)
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>이름</th><th>호스트</th><th>계정</th><th>리전</th><th>연결 vCenter</th><th>자격증명</th><th>수집</th><th className="right">작업</th></tr></thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={9} className="center muted" style={{ padding: 28 }}>등록된 NSX Manager가 없습니다. “+ NSX Manager 추가”로 등록하세요.</td></tr>}
            {list.map((m) => (
              <tr key={m.id}>
                <td><b>{m.id}</b></td>
                <td>{m.name}</td>
                <td className="muted">{m.host}{m.proxyId && <span className="badge amber" style={{ marginLeft: 6, fontSize: 10 }} title={`중계 서버(HAProxy) 경유: ${proxies.find((p) => p.id === m.proxyId)?.name || m.proxyId}`}>프록시 경유</span>}</td>
                <td className="muted">{m.username}</td>
                <td><span className="badge blue">{m.location?.region || '-'}</span></td>
                <td className="muted">{m.vcenterId || '—'}</td>
                <td>{m.hasPassword ? <span className="badge green">설정됨</span> : <span className="badge gray">없음</span>}</td>
                <td>{m.enabled === false ? <span className="badge gray">중지</span> : <span className="badge green">사용</span>}</td>
                <td className="right nowrap">
                  <button className="tab" onClick={() => openEdit(m)}>수정</button>
                  <button className="tab" style={{ color: 'var(--red)' }} onClick={() => remove(m)}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {form && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
          <EscClose onClose={close} />
          <div className="modal card">
            <div className="flex between" style={{ marginBottom: 12 }}>
              <b style={{ fontSize: 15 }}>{editing ? `NSX Manager 수정 — ${form.id}` : '새 NSX Manager 등록'}</b>
              <button className="logout-btn" onClick={close}>닫기</button>
            </div>
            <div className="spec-grid">
              <label>ID *<input className="input" value={form.id} onChange={setF('id')} disabled={editing} placeholder="nsx-seoul" /></label>
              <label>표시 이름 *<input className="input" value={form.name} onChange={setF('name')} placeholder="nsx-mgr-seoul" /></label>
              <label style={{ gridColumn: '1 / -1' }}>호스트 URL *<input className="input" value={form.host} onChange={setF('host')} placeholder="https://nsx-mgr.corp.local" /></label>
              <label>계정 *<input className="input" value={form.username} onChange={setF('username')} placeholder="admin" /></label>
              <label>비밀번호 {editing && <span className="muted">(비우면 유지)</span>}<input className="input" type="password" value={form.password} onChange={setF('password')} placeholder={editing ? '••••••' : ''} /></label>
              <label>리전
                <select className="select" value={form.location.region} onChange={setLoc('region')}>{REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}</select>
              </label>
              <label>연결 vCenter(선택)
                <select className="select" value={form.vcenterId} onChange={setF('vcenterId')}>
                  <option value="">— 선택 —</option>
                  {(vcenters || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              </label>
              <label title="다른 법인/사이트에 있어 직접 닿지 않는 NSX는 이미 등록된 중계 서버(HAProxy)를 골라 경유 연결합니다. 선택 시 그 프록시에 NSX:443 TCP 패스스루 매핑을 자동 생성·적용하고, 수집/테스트가 프록시를 통해 이뤄집니다. '직접 연결'은 중앙에서 NSX로 바로 접속합니다. ※ 선택한 프록시에 frontend 주소(proxyHost)가 설정돼 있어야 합니다.">프록시 경유(선택)
                <select className="select" value={form.proxyId || ''} onChange={setF('proxyId')}>
                  <option value="">직접 연결(프록시 미사용)</option>
                  {proxies.filter((p) => p.proxyHost).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.proxyHost})</option>)}
                </select>
              </label>
              <label>수집 주기(초, 0/빈칸=기본)<input className="input" type="number" value={form.pollIntervalSec} onChange={setF('pollIntervalSec')} placeholder="예: 300 (고RTT)" /></label>
              <label>수집 타임아웃(ms, 0/빈칸=20000)<input className="input" type="number" value={form.timeoutMs} onChange={setF('timeoutMs')} placeholder="예: 60000 (고RTT)" /></label>
              <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
                <input type="checkbox" checked={form.enabled !== false} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} /> 수집 사용
              </label>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              고지연(RTT 높은) 사이트는 <b>수집 주기를 길게</b>(예 300초) + <b>타임아웃을 크게</b>(예 60000ms) 설정하면, 느린 1곳이 전체 폴링을 막지 않습니다.
            </div>
            {msg && (
              <div style={{ marginTop: 12, padding: '9px 12px', borderRadius: 8, fontSize: 13,
                background: msg.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)', color: msg.ok ? '#4ade80' : '#f87171' }}>{msg.text}</div>
            )}
            <div className="flex gap" style={{ marginTop: 16 }}>
              <button className="login-btn" style={{ flex: 'none', padding: '10px 18px' }} disabled={busy} onClick={save}>{busy ? '저장 중…' : (editing ? '저장' : '등록')}</button>
              <button className="logout-btn" style={{ padding: '10px 18px' }} disabled={busy} onClick={test}>연결 테스트</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
