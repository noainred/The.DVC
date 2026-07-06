import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, putJson, delJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

/**
 * DataCenter(법인) 관리 — vCenter의 상위 개념.
 *  1) DataCenter 종류를 사전 정의(추가/수정/삭제)
 *  2) 각 vCenter를 어느 DataCenter에 둘지 할당
 * 법인 안의 물리 서버는 'iDRAC 서버 등록 › 법인별 iDRAC 장비 스캔'에서 수집한다.
 */
export default function DatacenterAdmin() {
  const [dcs, setDcs] = useState(null);      // [{id,name,region,note}]
  const [assign, setAssign] = useState({});  // { vcenterId: datacenterId }
  const [vcs, setVcs] = useState([]);        // [{id,name}]
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(null);    // { id, name, region, note, isNew } | null
  const [dirty, setDirty] = useState({});    // 변경된 vcenterId -> datacenterId (저장 전)
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' }); // 기본: 이름 오름차순(자동정렬)

  const loadDcs = () => fetchJson('/admin/datacenters').then((d) => { setDcs(d.datacenters || []); setAssign(d.assign || {}); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => {
    loadDcs();
    fetchJson('/admin/vcenters').then((d) => setVcs(d.vcenters || d || [])).catch(() => fetchJson('/vcenters').then((d) => setVcs(d || [])).catch(() => {}));
  }, []);

  const flash = (ok, text) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 4000); };

  const saveDc = async () => {
    if (!form) return;
    setBusy(true);
    const body = { name: form.name, region: form.region, note: form.note };
    const r = form.isNew
      ? await postJson('/admin/datacenters', { id: form.id, ...body }).catch((e) => ({ ok: false, reason: e.message }))
      : await putJson(`/admin/datacenters/${encodeURIComponent(form.id)}`, body).catch((e) => ({ ok: false, reason: e.message }));
    setBusy(false);
    if (r.ok) { setForm(null); await loadDcs(); flash(true, form.isNew ? `DataCenter '${form.id}' 추가됨` : `'${form.id}' 수정됨`); }
    else flash(false, r.reason || '저장 실패');
  };

  const delDc = async (id) => {
    if (!window.confirm(`DataCenter '${id}'를 삭제할까요? 이 DataCenter에 할당된 vCenter는 '미지정'으로 돌아갑니다.`)) return;
    setBusy(true);
    const r = await delJson(`/admin/datacenters/${encodeURIComponent(id)}`).catch((e) => ({ ok: false, reason: e.message }));
    setBusy(false);
    if (r.ok) { await loadDcs(); flash(true, `'${id}' 삭제됨`); } else flash(false, r.reason || '삭제 실패');
  };

  const setVcDc = (vcId, dcId) => setDirty((d) => ({ ...d, [vcId]: dcId }));
  const curDc = (vcId) => (vcId in dirty ? dirty[vcId] : (assign[vcId] || ''));
  const dirtyCount = Object.keys(dirty).filter((vc) => (dirty[vc] || '') !== (assign[vc] || '')).length;

  const saveAssign = async () => {
    const entries = Object.keys(dirty).filter((vc) => (dirty[vc] || '') !== (assign[vc] || '')).map((vc) => [vc, dirty[vc] || '']);
    if (!entries.length) return;
    setBusy(true);
    const r = await putJson('/admin/datacenters/assign', { entries }).catch((e) => ({ ok: false, reason: e.message }));
    setBusy(false);
    if (r.ok) { setDirty({}); await loadDcs(); flash(true, `vCenter 할당 ${r.changed}건 저장됨`); }
    else flash(false, r.reason || '저장 실패');
  };

  if (err) return <ErrorBox message={err} />;
  if (!dcs) return <Loading />;

  const dcName = new Map(dcs.map((d) => [d.id, d.name || d.id]));
  const countByDc = {};
  for (const vc of vcs) { const dc = curDc(vc.id); if (dc) countByDc[dc] = (countByDc[dc] || 0) + 1; }

  // 정렬(자동: 기본 이름순 / 수동: 헤더 클릭). 한글·숫자 자연 정렬.
  const toggleSort = (key) => setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }));
  const arrow = (key) => (sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');
  const sortVal = (d, key) => (key === 'count' ? (countByDc[d.id] || 0) : String(d[key] || '').toLowerCase());
  const sortedDcs = [...dcs].sort((a, a2) => {
    const va = sortVal(a, sort.key); const vb = sortVal(a2, sort.key);
    let c;
    if (sort.key === 'count') c = va - vb;
    else c = String(va).localeCompare(String(vb), 'ko', { numeric: true });
    return sort.dir === 'asc' ? c : -c;
  });
  const Th = ({ k, label, cls }) => (
    <th className={cls} onClick={() => toggleSort(k)} style={{ cursor: 'pointer', userSelect: 'none' }} title="클릭하여 정렬">{label}{arrow(k)}</th>
  );

  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>🏢 DataCenter(법인) 관리</div>
      <div className="muted" style={{ fontSize: 13, marginBottom: 14, lineHeight: 1.7 }}>
        <b>DataCenter = 법인</b>이고 <b>vCenter는 DataCenter에 속합니다</b>. 여기서 DataCenter 종류를 사전 정의하고, 각 vCenter를 DataCenter에 할당하세요.
        법인 안의 물리 서버 정보는 <b>iDRAC 서버 등록 › 법인별 iDRAC 장비 스캔</b>에서 수집합니다.
      </div>
      {msg && <div className="card" style={{ padding: '8px 12px', marginBottom: 12, borderLeft: `3px solid var(--${msg.ok ? 'green' : 'red'})`, fontSize: 13 }}>{msg.ok ? '✓' : '⚠'} {msg.text}</div>}

      {/* 1) DataCenter 종류 정의 */}
      <div className="flex between wrap gap" style={{ alignItems: 'center', margin: '6px 0' }}>
        <b style={{ fontSize: 14 }}>DataCenter 종류 <span className="muted" style={{ fontWeight: 400 }}>· {dcs.length}개</span></b>
        <button className="login-btn" style={{ flex: 'none', padding: '8px 14px' }} onClick={() => setForm({ id: '', name: '', region: '', note: '', isNew: true })}>+ DataCenter 추가</button>
      </div>
      {form && (
        <div className="card" style={{ padding: 14, marginBottom: 12 }}>
          <b style={{ fontSize: 13 }}>{form.isNew ? 'DataCenter 추가' : `DataCenter 수정 — ${form.id}`}</b>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginTop: 10 }}>
            <label style={{ fontSize: 12 }}>ID(영문/숫자) *<input className="input" value={form.id} disabled={!form.isNew} onChange={(e) => setForm((f) => ({ ...f, id: e.target.value }))} placeholder="예: seoul-dc1" /></label>
            <label style={{ fontSize: 12 }}>표시 이름 *<input className="input" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="예: 서울 IDC" /></label>
            <label style={{ fontSize: 12 }}>리전<input className="input" value={form.region} onChange={(e) => setForm((f) => ({ ...f, region: e.target.value }))} placeholder="예: KR" /></label>
            <label style={{ fontSize: 12 }}>메모<input className="input" value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="비고(선택)" /></label>
          </div>
          <div className="flex gap" style={{ marginTop: 10 }}>
            <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={busy} onClick={saveDc}>저장</button>
            <button className="logout-btn" style={{ padding: '8px 14px' }} onClick={() => setForm(null)}>닫기</button>
          </div>
        </div>
      )}
      <div className="table-wrap" style={{ marginBottom: 22 }}>
        <table>
          <thead><tr>
            <Th k="id" label="ID" /><Th k="name" label="이름" /><Th k="region" label="리전" />
            <Th k="count" label="vCenter 수" /><Th k="note" label="메모" /><th className="right">작업</th>
          </tr></thead>
          <tbody>
            {dcs.length === 0 && <tr><td colSpan={6} className="center muted" style={{ padding: 24 }}>정의된 DataCenter가 없습니다. “+ DataCenter 추가”로 등록하세요.</td></tr>}
            {sortedDcs.map((d) => (
              <tr key={d.id}>
                <td><b>{d.id}</b></td>
                <td>{d.name}</td>
                <td className="muted">{d.region || '—'}</td>
                <td className="tabular">{countByDc[d.id] || 0}</td>
                <td className="muted" style={{ fontSize: 12 }}>{d.note || ''}</td>
                <td className="right nowrap">
                  <button className="tab" onClick={() => setForm({ ...d, isNew: false })}>수정</button>
                  <button className="tab" style={{ color: 'var(--red)' }} onClick={() => delDc(d.id)}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 2) vCenter → DataCenter 할당 */}
      <div className="flex between wrap gap" style={{ alignItems: 'center', margin: '6px 0' }}>
        <b style={{ fontSize: 14 }}>vCenter → DataCenter 할당 <span className="muted" style={{ fontWeight: 400 }}>· vCenter {vcs.length}개</span></b>
        <button className="login-btn" style={{ flex: 'none', padding: '8px 14px', opacity: dirtyCount ? 1 : 0.5 }} disabled={busy || !dirtyCount} onClick={saveAssign}>변경 저장{dirtyCount ? ` (${dirtyCount})` : ''}</button>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>vCenter</th><th>현재 소속 DataCenter</th></tr></thead>
          <tbody>
            {vcs.length === 0 && <tr><td colSpan={2} className="center muted" style={{ padding: 24 }}>등록된 vCenter가 없습니다.</td></tr>}
            {vcs.map((v) => {
              const cur = curDc(v.id);
              const changed = (cur || '') !== (assign[v.id] || '');
              return (
                <tr key={v.id} style={changed ? { background: 'rgba(56,189,248,.08)' } : undefined}>
                  <td><b>{v.name || v.id}</b> <span className="muted" style={{ fontSize: 12 }}>{v.id}</span></td>
                  <td>
                    <select className="select" value={cur} onChange={(e) => setVcDc(v.id, e.target.value)} style={{ minWidth: 220 }} disabled={dcs.length === 0}>
                      <option value="">(미지정)</option>
                      {dcs.map((d) => <option key={d.id} value={d.id}>{d.name || d.id}{d.region ? ` · ${d.region}` : ''}</option>)}
                    </select>
                    {changed && <span className="badge blue" style={{ marginLeft: 8, fontSize: 11 }}>변경됨</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {dcs.length === 0 && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>먼저 위에서 DataCenter를 1개 이상 정의해야 vCenter를 할당할 수 있습니다.</div>}
    </>
  );
}
