/**
 * 비용 배분(쇼백) — 특수 기능 `cost-showback`(v2.707 — C11). 할당 vCPU·메모리·스토리지 × 월 단가를 법인·클러스터·폴더·태그별로.
 * 단가가 비면 할당량만 보여 준다(사용자 선택). 계산은 서버(`server/src/cost/analyze.js`), 문구는 `views/bizreport/costText.js`.
 * ⚠ 폴링하지 않는다 · 단가 저장은 관리자(전체 범위)만 — 조회에 실패하면 단가 폼을 열지 않는다(v2.618 '조회 실패 → 저장' 금지).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, putJson, downloadFile, canCsv, hasRole } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { GROUP_LABEL, OFF_POLICY_LABEL, STORAGE_BASIS_LABEL, moneyText, numText, ratesNote, notesText, BASIS_NOTE } from '../bizreport/costText.js';
import Select from '../../components/Select.jsx';

function Chip({ active, onClick, children }) {
  return <button type="button" className={`tab${active ? ' active' : ''}`} onClick={onClick} style={{ padding: '4px 10px', fontSize: 12, whiteSpace: 'nowrap' }}>{children}</button>;
}

function RateForm({ onSaved }) {
  const [s, setS] = useState(null);
  const [form, setForm] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    fetchJson('/tools/cost-showback/settings').then((d) => {
      if (!active) return;
      setS(d.settings);
      const f = d.settings || {};
      setForm({ currency: f.currency || 'KRW', vcpu: f.vcpu ?? '', ramGB: f.ramGB ?? '', storageGB: f.storageGB ?? '', storageBasis: f.storageBasis, offPolicy: f.offPolicy });
    }).catch((e) => { if (active) setErr(e); });
    return () => { active = false; };
  }, []);
  if (err) return <ErrorBox error={err} />;
  if (!form) return <Loading />;
  const set = (k, v) => setForm((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setBusy(true); setMsg('');
    // 빈 칸은 null('단가 없음')로 보낸다 — 0 은 '무료' 라는 값이다.
    const body = { ...form };
    for (const k of ['vcpu', 'ramGB', 'storageGB']) body[k] = String(form[k]).trim() === '' ? null : form[k];
    const r = await putJson('/tools/cost-showback/settings', body).catch((e) => ({ ok: false, reason: e?.message }));
    setBusy(false);
    if (r?.ok) { setMsg('저장했습니다.'); setS(r.settings); onSaved?.(); } else setMsg(`저장하지 못했습니다: ${r?.reason || '알 수 없는 오류'}`);
  };
  const field = (k, label) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, fontSize: 12 }}>
      <span className="muted">{label}</span>
      <input className="input" style={{ minWidth: 0 }} inputMode="decimal" placeholder="비우면 계산 안 함" value={form[k]} onChange={(e) => set(k, e.target.value)} />
    </label>
  );
  return (
    <div className="card" style={{ padding: 12, marginBottom: 10, minWidth: 0 }}>
      <div style={{ fontSize: 13, marginBottom: 8 }}><b>월 단가</b> <span className="muted" style={{ fontSize: 12 }}>— 0 은 무료, 빈 칸은 그 항목을 계산하지 않습니다{s?.updatedBy ? ` · 마지막 저장 ${s.updatedBy}` : ''}</span></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(160px, 100%), 1fr))', gap: 8 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, fontSize: 12 }}><span className="muted">통화</span>
          <input className="input" style={{ minWidth: 0 }} value={form.currency} onChange={(e) => set('currency', e.target.value)} /></label>
        {field('vcpu', 'vCPU 1개 / 월')}
        {field('ramGB', '메모리 1GB / 월')}
        {field('storageGB', '스토리지 1GB / 월')}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, fontSize: 12 }}><span className="muted">스토리지 기준</span>
          <Select sort={false} className="input" style={{ minWidth: 0 }} value={form.storageBasis} onChange={(e) => set('storageBasis', e.target.value)}>
            {Object.entries(STORAGE_BASIS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select></label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, fontSize: 12 }}><span className="muted">꺼진 VM</span>
          <Select sort={false} className="input" style={{ minWidth: 0 }} value={form.offPolicy} onChange={(e) => set('offPolicy', e.target.value)}>
            {Object.entries(OFF_POLICY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select></label>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn" onClick={save} disabled={busy}>{busy ? '저장 중…' : '단가 저장'}</button>
        {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
      </div>
    </div>
  );
}

export default function CostShowbackTool({ scope }) {
  const [vcId, setVcId] = useState(scope || '');
  const [by, setBy] = useState('vcenter');
  const [category, setCategory] = useState('');
  const [q, setQ] = useState('');
  const [qApplied, setQApplied] = useState('');
  const [view, setView] = useState('groups');
  const [showRates, setShowRates] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [csvErr, setCsvErr] = useState(null);
  const gen = useRef(0);
  useEffect(() => { setVcId(scope || ''); }, [scope]);
  useEffect(() => { const t = setTimeout(() => setQApplied(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const params = useCallback(() => {
    const p = { by };
    if (vcId) p.vcenterId = vcId;
    if (by === 'tag' && category) p.category = category;
    if (qApplied) p.q = qApplied;
    return p;
  }, [by, vcId, category, qApplied]);
  const load = useCallback(async () => {
    const my = ++gen.current;
    setLoading(true);
    try {
      const d = await fetchJson('/tools/cost-showback', params());
      if (my === gen.current) { setData(d); setError(null); }
    } catch (e) { if (my === gen.current) setError(e); } finally { if (my === gen.current) setLoading(false); }
  }, [params]);
  useEffect(() => { load(); }, [load]);
  const csv = async () => {
    setCsvErr(null);
    try { await downloadFile(`/tools/cost-showback.csv?${new URLSearchParams(params())}`); } catch (e) { setCsvErr(e); }
  };

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const t = data.totals || {};
  const cur = data.currency;
  const groups = Array.isArray(data.groups) ? data.groups : [];
  const vms = Array.isArray(data.vms) ? data.vms : [];
  const rn = ratesNote(data);
  const nn = notesText(data);
  const isAdmin = hasRole('admin');
  const showVc = data.by === 'cluster' || data.by === 'folder';   // 법인·태그 기준이면 vCenter 열은 이름과 같거나 뜻이 없다
  return (
    <div style={{ minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>{BASIS_NOTE}</div>
      {rn && <div className="banner" style={{ marginBottom: 8 }}>{rn}</div>}
      {error && <div className="banner" style={{ marginBottom: 8 }}>다시 불러오지 못했습니다 — 이전 결과를 보여 줍니다.</div>}
      <div className="kpis" style={{ marginBottom: 10 }}>
        <div className="kpi"><div className="label">월 합계</div><div className="value">{moneyText(t.total, cur)}</div><div className="sub">VM {(t.vms ?? 0).toLocaleString()}대</div></div>
        <div className="kpi"><div className="label">vCPU</div><div className="value">{numText(t.vcpu)}</div><div className="sub">{moneyText(t.cpu, cur)}</div></div>
        <div className="kpi"><div className="label">메모리</div><div className="value">{numText(t.ramGB, ' GB')}</div><div className="sub">{moneyText(t.ram, cur)}</div></div>
        <div className="kpi"><div className="label">스토리지</div><div className="value">{numText(t.storageGB, ' GB')}</div><div className="sub">{t.storage == null ? '' : `${moneyText(t.storage, cur)} · `}{STORAGE_BASIS_LABEL[data.storageBasis] || ''}</div></div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, alignItems: 'center' }}>
        <span className="muted" style={{ fontSize: 12 }}>나누는 기준</span>
        {Object.entries(GROUP_LABEL).map(([k, l]) => <Chip key={k} active={by === k} onClick={() => setBy(k)}>{l}</Chip>)}
        {by === 'tag' && (
          <Select className="input" style={{ minWidth: 0, maxWidth: 220 }} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">카테고리 선택</option>
            {(data.categories || []).map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        )}
        <input className="input" style={{ minWidth: 0, flex: '1 1 160px', maxWidth: 280 }} placeholder="그룹 이름 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn" onClick={load} disabled={loading}>{loading ? '불러오는 중…' : '새로고침'}</button>
        {canCsv() && <button type="button" className="btn" onClick={csv}>CSV</button>}
        {isAdmin && <button type="button" className="btn" onClick={() => setShowRates((x) => !x)}>{showRates ? '단가 설정 닫기' : '단가 설정'}</button>}
      </div>
      {by === 'tag' && !(data.categories || []).length && <div className="banner" style={{ marginBottom: 8 }}>읽은 태그 카테고리가 없습니다 — 태그는 vCenter 7.0U2 이상에서 수집 서버가 주기마다 읽습니다(특수 기능 '태그·사용자 지정 속성 점검').</div>}
      {csvErr && <ErrorBox error={csvErr} />}
      {showRates && isAdmin && <RateForm onSaved={load} />}
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <Chip active={view === 'groups'} onClick={() => setView('groups')}>그룹별 {groups.length}</Chip>
        <Chip active={view === 'vms'} onClick={() => setView('vms')}>VM 별</Chip>
      </div>
      <div className="card" style={{ padding: 0, minWidth: 0 }}>
        {view === 'groups' ? (
          <div className="table-wrap" style={{ maxHeight: '70vh' }}><STable minWidth={980} wrap={false}>
            <thead><tr><th>{GROUP_LABEL[data.by]}</th>{showVc && <th>vCenter</th>}<th>VM</th><th>vCPU</th><th>메모리</th><th>스토리지</th><th>vCPU 비용</th><th>메모리 비용</th><th>스토리지 비용</th><th>합계</th><th>비중</th></tr></thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.key}>
                  <td>{g.label}</td>{showVc && <td>{g.vcenterName || '—'}</td>}
                  <td data-sort={g.vms}>{g.vms.toLocaleString()}<span className="muted" style={{ fontSize: 11 }}> (켜짐 {g.on})</span></td>
                  <td data-sort={g.vcpu}>{numText(g.vcpu)}</td><td data-sort={g.ramGB}>{numText(g.ramGB, ' GB')}</td>
                  <td data-sort={g.storageGB}>{numText(g.storageGB, ' GB')}{g.storageUnknown ? <span className="muted" style={{ fontSize: 11 }} title="용량을 모르는 VM 은 합계에서 빠졌습니다"> · 모름 {g.storageUnknown}</span> : null}</td>
                  <td data-sort={g.cpu ?? ''}>{moneyText(g.cpu)}</td><td data-sort={g.ram ?? ''}>{moneyText(g.ram)}</td><td data-sort={g.storage ?? ''}>{moneyText(g.storage)}</td>
                  <td data-sort={g.total ?? ''}><b>{moneyText(g.total, cur)}</b></td><td data-sort={g.share ?? ''}>{g.share == null ? '—' : `${g.share}%`}</td>
                </tr>
              ))}
            </tbody>
          </STable></div>
        ) : (
          <div className="table-wrap" style={{ maxHeight: '70vh' }}><STable minWidth={820} wrap={false}>
            <thead><tr><th>VM</th><th>vCenter</th><th>그룹</th><th>전원</th><th>vCPU</th><th>메모리</th><th>스토리지</th><th>월 비용</th></tr></thead>
            <tbody>
              {vms.map((v) => (
                <tr key={v.id}>
                  <td>{v.name}</td><td>{v.vcenterName}</td><td>{v.group}</td><td>{v.powerState === 'POWERED_ON' ? '켜짐' : '꺼짐'}</td>
                  <td data-sort={v.vcpu ?? ''}>{numText(v.vcpu)}</td><td data-sort={v.ramGB ?? ''}>{numText(v.ramGB, ' GB')}</td><td data-sort={v.storageGB ?? ''}>{numText(v.storageGB, ' GB')}</td>
                  <td data-sort={v.cost ?? ''}>{moneyText(v.cost, cur)}</td>
                </tr>
              ))}
            </tbody>
          </STable></div>
        )}
      </div>
      {(data.groupsOmitted > 0 || (view === 'vms' && data.vmsOmitted > 0)) && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>상한으로 {(view === 'vms' ? data.vmsOmitted : data.groupsOmitted).toLocaleString()}개를 더 보여 주지 않았습니다(합계에는 들어 있습니다).</div>}
      {nn && <div className="muted" style={{ fontSize: 12, marginTop: 6, whiteSpace: 'normal' }}>{nn}</div>}
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{OFF_POLICY_LABEL[data.offPolicy] || ''} · 템플릿은 넣지 않습니다.</div>
    </div>
  );
}
