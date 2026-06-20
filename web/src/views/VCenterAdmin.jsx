import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, delJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import EscClose from '../components/EscClose.jsx';

const REGIONS = ['아시아', '중국', '유럽', '북미'];
const EMPTY = {
  id: '', name: '', host: 'https://', username: '', password: '',
  enabled: true, pollIntervalSec: '', timeoutMs: '',
  location: { city: '', country: '', region: '아시아', lat: '', lon: '' },
};

export default function VCenterAdmin() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);     // null = closed; object = add/edit
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [importMsg, setImportMsg] = useState(null);
  const [replaceMode, setReplaceMode] = useState(false);
  const [serverPath, setServerPath] = useState('');
  const fileRef = useRef(null);

  const load = async () => {
    try { setData(await fetchJson('/admin/vcenters')); setError(null); }
    catch (e) { setError(e.message); }
  };
  useEffect(() => {
    load();
    fetchJson('/admin/vcenters/import-suggestions').then((s) => setServerPath((p) => p || s.default || '')).catch(() => {});
  }, []);

  const showImportResult = (r, extra = '') => setImportMsg(r.ok
    ? { ok: true, text: `불러오기 완료${extra} — 추가 ${r.added}, 갱신 ${r.updated}, 건너뜀 ${r.skipped.length} (총 ${r.total})`, skipped: r.skipped }
    : { ok: false, text: r.reason });

  const importFromServer = async () => {
    setImportMsg(null);
    if (!serverPath.trim()) return setImportMsg({ ok: false, text: '서버 파일 경로를 입력하세요.' });
    if (replaceMode && !window.confirm('기존 목록을 모두 비우고 서버 파일로 교체할까요?')) return;
    try {
      const r = await postJson('/admin/vcenters/import-file', { path: serverPath.trim(), mode: replaceMode ? 'replace' : 'merge' });
      showImportResult(r, ` (${serverPath.trim()})`);
      await load();
    } catch (e) { setImportMsg({ ok: false, text: e.message }); }
  };

  const onImportFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImportMsg(null);
    try {
      const json = JSON.parse(await file.text());
      const vcenters = Array.isArray(json) ? json : json.vcenters;
      if (!Array.isArray(vcenters)) throw new Error('vcenters 배열이 없습니다.');
      if (replaceMode && !window.confirm(`기존 목록을 모두 비우고 ${vcenters.length}개로 교체할까요?`)) return;
      const r = await postJson('/admin/vcenters/import', { vcenters, mode: replaceMode ? 'replace' : 'merge' });
      showImportResult(r, ` (업로드: ${file.name})`);
      await load();
    } catch (err) {
      setImportMsg({ ok: false, text: `불러오기 실패: ${err.message}` });
    }
  };

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
      const r = editing ? await putJson(`/admin/vcenters/${encodeURIComponent(form.id)}`, form) : await postJson('/admin/vcenters', form);
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
    try { await delJson(`/admin/vcenters/${encodeURIComponent(vc.id)}`); await load(); }
    catch (e) { setError(e.message); }
  };

  // Auto-fill map coordinates from the city/country name (offline geocoder).
  const autoGeocode = async () => {
    if (!form) return;
    const { city, country, lat, lon } = form.location;
    if (!city && !country) return;
    if ((lat !== '' && lat != null) || (lon !== '' && lon != null)) return; // keep manual coords
    try {
      const g = await fetchJson('/admin/geocode', { city, country });
      if (g.ok) setForm((f) => ({ ...f, location: { ...f.location, lat: g.lat, lon: g.lon } }));
    } catch { /* ignore */ }
  };

  const list = data.vcenters || [];

  const changeSource = async (e) => {
    const ds = e.target.value;
    if (!window.confirm(`데이터 소스를 '${ds.toUpperCase()}' 로 전환할까요? 즉시 다시 수집합니다.`)) return;
    try { await putJson('/admin/data-source', { dataSource: ds }); await load(); }
    catch (err) { setError(err.message); }
  };

  return (
    <>
      <div className="flex between wrap gap" style={{ marginBottom: 6 }}>
        <div className="section-title" style={{ margin: '6px 0' }}>vCenter 등록 · 관리 (관리자)</div>
        <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="muted flex gap" style={{ alignItems: 'center', fontSize: 12 }} title="체크 시 기존 목록을 모두 교체">
            <input type="checkbox" checked={replaceMode} onChange={(e) => setReplaceMode(e.target.checked)} /> 전체 교체
          </label>
          <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={onImportFile} />
          <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={() => fileRef.current?.click()}>파일 업로드</button>
          <button className="login-btn" style={{ flex: 'none', padding: '9px 16px' }} onClick={openAdd}>+ vCenter 추가</button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12, padding: '12px 14px' }}>
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>데이터 소스</span>
          <select className="select" value={data.dataSource} onChange={changeSource} style={{ maxWidth: 160 }}>
            <option value="mock">MOCK (데모)</option>
            <option value="live">LIVE (실제 vCenter)</option>
            <option value="auto">AUTO (live+실패 시 mock)</option>
          </select>
          <span className="muted" style={{ fontSize: 11 }}>전환 시 즉시 재수집합니다. (환경변수 없이 포탈에서 변경)</span>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12, padding: '12px 14px' }}>
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>서버 파일에서 불러오기</span>
          <input className="input" style={{ flex: 1, minWidth: 280 }} value={serverPath}
            onChange={(e) => setServerPath(e.target.value)} placeholder="/etc/vmware-portal/vcenters.json" />
          <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={importFromServer}>서버 파일 불러오기</button>
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          서버에 이미 있는 vcenters.json 경로를 지정하거나, 위 “파일 업로드”로 PC의 파일을 올릴 수 있습니다. “전체 교체” 체크 시 기존 목록을 덮어씁니다.
        </div>
      </div>

      {importMsg && (
        <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 8, fontSize: 13,
          background: importMsg.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)',
          color: importMsg.ok ? '#4ade80' : '#f87171' }}>
          {importMsg.text}
          {importMsg.skipped?.length > 0 && (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: 'var(--amber)' }}>
              {importMsg.skipped.slice(0, 8).map((s, i) => <li key={i}>{s.id}: {s.reason}</li>)}
            </ul>
          )}
        </div>
      )}

      {data.dataSource === 'mock' && (
        <div className="card" style={{ marginBottom: 14, borderColor: 'var(--amber)' }}>
          <b style={{ color: 'var(--amber)' }}>ℹ 현재 데이터 소스: mock(데모)</b>
          <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>
            여기서 등록한 vCenter는 <code>$CONFIG_DIR/vcenters.json</code>(기본 <code>/etc/vmware-portal/</code>)
            에 저장되어 업그레이드해도 보존됩니다. 실제 수집은 서버를 <code>DATA_SOURCE=live</code>
            (또는 <code>auto</code>)로 실행할 때 반영됩니다. 대시보드의 현재 숫자는 데모 데이터입니다.
          </div>
        </div>
      )}

      <VcenterOrderCard />

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
          <EscClose onClose={close} />
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
              <label>도시<input className="input" value={form.location.city} onChange={setLoc('city')} onBlur={autoGeocode} placeholder="Seoul" /></label>
              <label>국가<input className="input" value={form.location.country} onChange={setLoc('country')} onBlur={autoGeocode} placeholder="South Korea" /></label>
              <label>위도(lat)<input className="input" value={form.location.lat} onChange={setLoc('lat')} placeholder="37.57" /></label>
              <label>경도(lon)<input className="input" value={form.location.lon} onChange={setLoc('lon')} placeholder="126.98" /></label>
              <label>수집 주기(초, 0/빈칸=기본)<input className="input" type="number" value={form.pollIntervalSec} onChange={setF('pollIntervalSec')} placeholder="예: 300 (고RTT)" /></label>
              <label>수집 타임아웃(ms, 0/빈칸=30000)<input className="input" type="number" value={form.timeoutMs} onChange={setF('timeoutMs')} placeholder="예: 60000 (고RTT)" /></label>
              <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
                <input type="checkbox" checked={form.enabled !== false} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} /> 수집 사용
              </label>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              고지연(RTT 높은) vCenter는 <b>수집 주기를 길게</b>(예 300초) + <b>타임아웃을 크게</b>(예 60000ms) 설정하면, 느린 1곳이 전체 폴링을 막지 않습니다.
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

/** 웹에 표시되는 모든 'vCenter 선택' 목록의 순서를 지정한다(↑/↓로 정렬 후 저장). */
function VcenterOrderCard() {
  const [list, setList] = useState(null);
  const [msg, setMsg] = useState(null);
  const [open, setOpen] = useState(false);
  const load = () => fetchJson('/admin/vcenter-order').then((r) => setList(r.vcenters)).catch(() => setList([]));
  useEffect(() => { load(); }, []);
  if (!list) return null;

  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    setList(next);
  };
  const save = async () => {
    const r = await putJson('/admin/vcenter-order', { order: list.map((v) => v.id) }).catch((e) => ({ ok: false, reason: e.message }));
    setMsg(r.ok ? { ok: true, text: '순서를 저장했습니다. 모든 vCenter 선택 목록에 적용됩니다.' } : { ok: false, text: r.reason || '저장 실패' });
    if (r.ok) setTimeout(() => setMsg(null), 4000);
  };
  const sortName = () => setList([...list].sort((a, b) => a.name.localeCompare(b.name)));

  return (
    <div className="card" style={{ marginBottom: 12, padding: '12px 14px' }}>
      <div className="flex between wrap" style={{ alignItems: 'center' }}>
        <b style={{ fontSize: 14 }}>vCenter 표시 순서 ({list.length})</b>
        <button className="logout-btn" style={{ padding: '7px 12px' }} onClick={() => setOpen((o) => !o)}>{open ? '접기' : '순서 지정'}</button>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>여기서 정한 순서가 웹의 모든 “vCenter 선택” 콤보박스·목록에 동일하게 적용됩니다.</div>
      {open && (
        <>
          {msg && <div style={{ margin: '8px 0', padding: '8px 12px', borderRadius: 8, fontSize: 13, background: msg.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)', color: msg.ok ? '#4ade80' : '#f87171' }}>{msg.text}</div>}
          <div className="table-wrap" style={{ marginTop: 8, maxHeight: '44vh' }}>
            <table>
              <thead><tr><th style={{ width: 50 }}>순서</th><th>이름</th><th>ID</th><th>리전</th><th className="right">이동</th></tr></thead>
              <tbody>
                {list.length === 0 && <tr><td colSpan={5} className="center muted" style={{ padding: 18 }}>등록된 vCenter가 없습니다.</td></tr>}
                {list.map((v, i) => (
                  <tr key={v.id}>
                    <td className="muted">{i + 1}</td>
                    <td><b>{v.name}</b></td>
                    <td className="muted">{v.id}</td>
                    <td><span className="badge blue">{v.region || '-'}</span></td>
                    <td className="right nowrap">
                      <button className="tab" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                      <button className="tab" disabled={i === list.length - 1} onClick={() => move(i, 1)}>↓</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex gap" style={{ marginTop: 10 }}>
            <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} onClick={save}>순서 저장</button>
            <button className="logout-btn" style={{ padding: '8px 14px' }} onClick={sortName}>이름순 정렬</button>
            <button className="logout-btn" style={{ padding: '8px 14px' }} onClick={load}>되돌리기</button>
          </div>
        </>
      )}
    </div>
  );
}
