/**
 * 태그·사용자 지정 속성 점검 — 특수 기능 `vm-tags`(v2.703 — A15). 태그 카테고리 인벤토리 · 필수 카테고리 누락 VM ·
 * 법인 카테고리로 본 귀속 · 사용자 지정 속성 채움률. ⚠ 판정은 서버(`server/src/tags/analyze.js`) — 이 화면은 조립만.
 * ⚠ 폴링하지 않는다(마운트 1회 + 새로고침) · 늦게 온 이전 응답은 버린다 · 훅은 전부 조기 return 위.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, putJson, downloadFile, canCsv, hasRole } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { VmLink } from '../../components/EntityDetail.jsx';
import { TAG_STATE_TEXT, pctText, coverageNote, policyNote } from '../tags/vmTagsText.js';
import Select from '../../components/Select.jsx';
import DataList from '../../components/DataList.jsx';

function Chip({ active, onClick, children }) {
  return <button type="button" className={`tab${active ? ' active' : ''}`} onClick={onClick} style={{ padding: '4px 10px', fontSize: 12 }}>{children}</button>;
}

function PolicyEditor({ policy, rev, categories, onSaved }) {
  const [req, setReq] = useState((policy?.requiredCategories || []).join(', '));
  const [corp, setCorp] = useState(policy?.corpCategory || '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  useEffect(() => { setReq((policy?.requiredCategories || []).join(', ')); setCorp(policy?.corpCategory || ''); }, [rev]);  // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await putJson('/tools/vm-tags/policy', { requiredCategories: req.split(',').map((s) => s.trim()).filter(Boolean), corpCategory: corp.trim(), rev });
      if (r?.ok === false) setMsg(r.reason || (r.invalid || []).map((x) => `${x.value}: ${x.reason}`).join(' · ') || '저장하지 못했습니다');
      else { setMsg('저장했습니다.'); onSaved(); }
    } catch (e) { setMsg(e.message || '저장하지 못했습니다'); } finally { setBusy(false); }
  };
  const names = (categories || []).map((c) => c.name);
  return (
    <div className="card" style={{ padding: 12, marginBottom: 10, minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>정책(관리자 · 전 법인 공통) — 카테고리는 이름으로 적고 대소문자는 구분하지 않습니다.</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: 8 }}>
        <label style={{ fontSize: 12, minWidth: 0 }}>필수 카테고리(쉼표로 구분)
          <input className="input" style={{ width: '100%', minWidth: 0 }} value={req} onChange={(e) => setReq(e.target.value)} placeholder="예: Environment, Owner-Team" list="vmtag-cats" />
        </label>
        <label style={{ fontSize: 12, minWidth: 0 }}>법인 카테고리(태그 값 = 법인)
          <input className="input" style={{ width: '100%', minWidth: 0 }} value={corp} onChange={(e) => setCorp(e.target.value)} placeholder="예: Corp" list="vmtag-cats" />
        </label>
      </div>
      <DataList id="vmtag-cats">{names.map((n) => <option key={n} value={n} />)}</DataList>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn" onClick={save} disabled={busy}>{busy ? '저장 중…' : '정책 저장'}</button>
        {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
      </div>
    </div>
  );
}

export default function VmTagsTool({ scope }) {
  const [tab, setTab] = useState('missing');
  const [vcId, setVcId] = useState(scope || '');
  const [q, setQ] = useState('');
  const [qApplied, setQApplied] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvErr, setCsvErr] = useState(null);
  const [nonce, setNonce] = useState(0);
  const gen = useRef(0);
  useEffect(() => { setVcId(scope || ''); }, [scope]);
  useEffect(() => { const t = setTimeout(() => setQApplied(q.trim()), 300); return () => clearTimeout(t); }, [q]);

  const load = useCallback(async () => {
    const my = ++gen.current;
    setLoading(true);
    try {
      const params = {};
      if (vcId) params.vcenterId = vcId;
      if (qApplied) params.q = qApplied;
      if (nonce) params._ = nonce;
      const d = await fetchJson('/tools/vm-tags', params);
      if (my !== gen.current) return;
      setData(d); setError(null);
    } catch (e) { if (my === gen.current) setError(e); } finally { if (my === gen.current) setLoading(false); }
  }, [vcId, qApplied, nonce]);
  useEffect(() => { load(); }, [load]);

  const showCsv = canCsv();
  const isAdmin = hasRole('admin');
  const csv = async () => {
    setCsvBusy(true); setCsvErr(null);
    try { await downloadFile(`/tools/vm-tags.csv${vcId ? `?vcenterId=${encodeURIComponent(vcId)}` : ''}`); } catch (e) { setCsvErr(e); } finally { setCsvBusy(false); }
  };

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const vcs = Array.isArray(data.vcenters) ? data.vcenters : [];
  const cov = coverageNote(data.coverage, vcs);
  const pol = policyNote(data.policy);
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const cats = Array.isArray(data.categories) ? data.categories : [];
  const fields = Array.isArray(data.fields) ? data.fields : [];
  const checked = data.coverage?.checkedVms || 0;

  return (
    <div style={{ minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
        vSphere 태그와 사용자 지정 속성을 법인(vCenter)별로 모아, 필수 태그가 빠진 VM 과 법인 태그 귀속, 속성 채움률을 봅니다. 수집 서버가 {Math.round((data.scan?.refreshMs || 0) / 3_600_000) || '몇'}시간마다 한 번 읽습니다(화면은 vCenter 에 묻지 않습니다).
      </div>
      {data.scan?.enabled === false && <div className="banner" style={{ marginBottom: 8 }}>태그 수집이 꺼져 있습니다(TAG_SCAN=false).</div>}
      {cov && <div className="banner" style={{ marginBottom: 8 }}>{cov}</div>}
      {error && <div className="banner" style={{ marginBottom: 8 }}>다시 불러오지 못했습니다 — 이전 결과를 보여 줍니다.</div>}

      {isAdmin && <PolicyEditor policy={data.policy} rev={data.policyRev} categories={cats} onSaved={() => setNonce((n) => n + 1)} />}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, alignItems: 'center' }}>
        <Chip active={tab === 'missing'} onClick={() => setTab('missing')}>필수 태그 누락 <b>{(data.matched ?? 0).toLocaleString()}</b></Chip>
        <Chip active={tab === 'cats'} onClick={() => setTab('cats')}>카테고리 <b>{cats.length}</b></Chip>
        <Chip active={tab === 'corp'} onClick={() => setTab('corp')}>법인 귀속</Chip>
        <Chip active={tab === 'fields'} onClick={() => setTab('fields')}>사용자 지정 속성 <b>{fields.length}</b></Chip>
        <Chip active={tab === 'vc'} onClick={() => setTab('vc')}>vCenter 상태</Chip>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10, alignItems: 'center' }}>
        <span className="muted" style={{ fontSize: 12 }}>vCenter</span>
        <Select className="input" style={{ minWidth: 0, maxWidth: 260 }} value={vcId} onChange={(e) => setVcId(e.target.value)}>
          <option value="">전체</option>
          {vcs.map((v) => <option key={v.vcenterId} value={v.vcenterId}>{v.name}</option>)}
        </Select>
        {tab === 'missing' && <input className="input" style={{ minWidth: 0, flex: '1 1 180px', maxWidth: 320 }} placeholder="VM·vCenter·카테고리 검색" value={q} onChange={(e) => setQ(e.target.value)} />}
        <button type="button" className="btn" onClick={load} disabled={loading}>{loading ? '불러오는 중…' : '새로고침'}</button>
        {showCsv && tab === 'missing' && <button type="button" className="btn" onClick={csv} disabled={csvBusy}>CSV</button>}
      </div>
      {csvErr && <ErrorBox error={csvErr} />}

      <div className="card" style={{ padding: 0, minWidth: 0 }}>
        {tab === 'missing' && (pol ? <div className="muted" style={{ padding: 16, fontSize: 13 }}>{pol}</div>
          : rows.length === 0 ? <div className="muted" style={{ padding: 16, fontSize: 13 }}>{checked ? `점검한 VM ${checked.toLocaleString()}대에 빠진 필수 태그가 없습니다.` : '점검한 VM 이 없습니다.'}</div> : (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '10px 12px 0' }}>
                {Object.entries(data.missingByCategory || {}).map(([c, n]) => <span key={c} className={`badge ${n ? 'amber' : 'gray'}`}>{c} 빠짐 {n.toLocaleString()} / {checked.toLocaleString()}</span>)}
              </div>
              <STable minWidth={760}>
                <thead><tr><th>VM</th><th>vCenter</th><th>전원</th><th>빠진 필수 카테고리</th>{data.corp ? <th>법인 태그</th> : null}</tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.vmId}>
                      <td style={{ minWidth: 140 }}><VmLink name={r.vm} vcenterId={r.vcenterId} /></td>
                      <td className="muted" style={{ fontSize: 12 }}>{r.vcenterName}</td>
                      <td style={{ fontSize: 12 }}>{r.powerState === 'POWERED_ON' ? '켜짐' : r.powerState === 'POWERED_OFF' ? '꺼짐' : '—'}</td>
                      <td data-sort={r.missing.length} style={{ whiteSpace: 'normal' }}>{r.missing.map((m) => <span key={m} className="badge amber" style={{ marginRight: 4 }}>{m}</span>)}</td>
                      {data.corp ? <td style={{ fontSize: 12 }}>{r.corpTag || <span className="muted">없음</span>}</td> : null}
                    </tr>
                  ))}
                </tbody>
              </STable>
            </>
          ))}
        {tab === 'cats' && (cats.length === 0 ? <div className="muted" style={{ padding: 16, fontSize: 13 }}>읽은 태그 카테고리가 없습니다.</div> : (
          <STable minWidth={760}>
            <thead><tr><th>카테고리</th><th>종류</th><th>태그</th><th>붙은 VM</th><th>vCenter</th></tr></thead>
            <tbody>{cats.map((c) => (
              <tr key={c.name}>
                <td><b>{c.name}</b></td>
                <td style={{ fontSize: 12 }}>{c.cardinality === 'SINGLE' ? '하나만' : c.cardinality === 'MULTIPLE' ? '여러 개' : '—'}</td>
                <td style={{ whiteSpace: 'normal', fontSize: 12 }} data-sort={c.tagCount}>{c.tags.join(', ')}{c.tagCount > c.tags.length ? ` 외 ${c.tagCount - c.tags.length}개` : ''}</td>
                <td data-sort={c.vms}>{c.vms.toLocaleString()} <span className="muted" style={{ fontSize: 11 }}>({pctText(c.vms, checked)})</span></td>
                <td data-sort={c.vcenters}>{c.vcenters}</td>
              </tr>))}</tbody>
          </STable>))}
        {tab === 'corp' && (!data.corp ? <div className="muted" style={{ padding: 16, fontSize: 13 }}>법인 카테고리를 정하지 않았습니다 — 위 정책에서 정하면 태그 값으로 VM 을 법인에 귀속해 봅니다(관리자).</div> : (
          <>
            <div className="muted" style={{ fontSize: 12, padding: '10px 12px 0' }}>카테고리 {data.corp.category} · 점검 {data.corp.checked.toLocaleString()}대 · 법인 태그 없음 {data.corp.unassigned.toLocaleString()}대({pctText(data.corp.unassigned, data.corp.checked)})</div>
            <STable minWidth={480}>
              <thead><tr><th>법인 태그 값</th><th>VM</th><th>걸친 vCenter</th></tr></thead>
              <tbody>{data.corp.values.map((v) => (
                <tr key={v.tag}><td><b>{v.tag}</b></td><td data-sort={v.vms}>{v.vms.toLocaleString()}</td><td data-sort={v.vcenters}>{v.vcenters}{v.vcenters > 1 ? <span className="muted" style={{ fontSize: 11 }}> (여러 vCenter)</span> : null}</td></tr>))}</tbody>
            </STable>
          </>))}
        {tab === 'fields' && (fields.length === 0 ? <div className="muted" style={{ padding: 16, fontSize: 13 }}>읽은 사용자 지정 속성 정의가 없습니다.</div> : (
          <STable minWidth={480}>
            <thead><tr><th>속성</th><th>값 있는 VM</th><th>채움률</th><th>vCenter</th></tr></thead>
            <tbody>{fields.map((f) => (
              <tr key={f.name}><td><b>{f.name}</b></td><td data-sort={f.filled}>{f.filled.toLocaleString()} / {f.checked.toLocaleString()}</td><td data-sort={f.checked ? f.filled / f.checked : ''}>{pctText(f.filled, f.checked)}</td><td>{f.vcenters}</td></tr>))}</tbody>
          </STable>))}
        {tab === 'vc' && (
          <STable minWidth={820}>
            <thead><tr><th>vCenter</th><th>태그 상태</th><th>마지막 읽기</th><th>카테고리</th><th>태그</th><th>VM</th><th>누락 VM</th><th>사유</th></tr></thead>
            <tbody>{vcs.map((v) => {
              const st = TAG_STATE_TEXT[v.state] || { label: v.state, tone: 'gray' };
              return (
                <tr key={v.vcenterId}>
                  <td><b>{v.name}</b></td>
                  <td><span className={`badge ${st.tone}`}>{st.label}</span></td>
                  <td data-sort={v.tagsAt ?? ''} style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{v.tagsAt ? new Date(v.tagsAt).toLocaleString('ko-KR') : '—'}</td>
                  <td>{v.categories ?? '—'}</td><td>{v.tags ?? '—'}</td><td>{v.vms}</td><td>{v.withMissing ?? '—'}</td>
                  <td style={{ whiteSpace: 'normal', fontSize: 12, overflowWrap: 'anywhere' }}>{[v.tagsError, v.customError && `속성: ${v.customError}`].filter(Boolean).join(' · ') || '—'}</td>
                </tr>);
            })}</tbody>
          </STable>)}
      </div>
      {tab === 'missing' && data.omitted > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>빠진 카테고리가 많은 순 상위 {rows.length.toLocaleString()}대만 표시했습니다 — {data.omitted.toLocaleString()}대는 CSV·검색으로 보세요.</div>}
      <div className="muted" style={{ fontSize: 12, marginTop: 6, whiteSpace: 'normal' }}>템플릿은 점검하지 않습니다. 태그는 vSphere 7.0 U2 이상의 vAPI 로 읽고, 그보다 오래된 vCenter 는 '태그 API 없음' 으로 표시합니다. VM 상세 창에도 그 VM 의 태그·속성이 보입니다.</div>
    </div>
  );
}
