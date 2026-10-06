/**
 * VM 이전 준비도 — 특수 기능 `migration-readiness`(v2.707 — C7). 옮기기 전에 막는 요인(물리 RDM·공유 디스크·패스스루 GPU …)과
 * 확인할 요인(스냅샷·USB·오래된 하드웨어 …)을 VM·법인별로. 판정은 서버(`server/src/migration/analyze.js`), 문구는 `views/bizreport/migrationText.js`.
 * ⚠ 폴링하지 않는다 · 늦게 온 이전 응답은 버린다 · 훅은 전부 조기 return 위.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, downloadFile, canCsv } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { VmLink } from '../../components/EntityDetail.jsx';
import { MIG_TEXT, LEVEL_LABEL, LEVEL_BADGE, readyPctText, unknownNote, SCOPE_NOTE } from '../bizreport/migrationText.js';

function Chip({ active, onClick, children }) {
  return <button type="button" className={`tab${active ? ' active' : ''}`} onClick={onClick} style={{ padding: '4px 10px', fontSize: 12, whiteSpace: 'nowrap' }}>{children}</button>;
}

export default function MigrationReadinessTool({ scope }) {
  const [vcId, setVcId] = useState(scope || '');
  const [level, setLevel] = useState('blocked');
  const [code, setCode] = useState('');
  const [by, setBy] = useState('vcenter');
  const [q, setQ] = useState('');
  const [qApplied, setQApplied] = useState('');
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
    if (level) p.level = level;
    if (code) p.code = code;
    if (qApplied) p.q = qApplied;
    return p;
  }, [by, vcId, level, code, qApplied]);
  const load = useCallback(async () => {
    const my = ++gen.current;
    setLoading(true);
    try {
      const d = await fetchJson('/tools/migration-readiness', params());
      if (my === gen.current) { setData(d); setError(null); }
    } catch (e) { if (my === gen.current) setError(e); } finally { if (my === gen.current) setLoading(false); }
  }, [params]);
  useEffect(() => { load(); }, [load]);
  const csv = async () => {
    setCsvErr(null);
    try { await downloadFile(`/tools/migration-readiness.csv?${new URLSearchParams(params())}`); } catch (e) { setCsvErr(e); }
  };

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const c = data.counts || {};
  const vms = Array.isArray(data.vms) ? data.vms : [];
  const groups = Array.isArray(data.groups) ? data.groups : [];
  const un = unknownNote(data);
  const codes = Object.entries(data.byCode || {}).filter(([, n]) => n > 0).sort((a, b) => (data.codes[a[0]] === 'blocked' ? 0 : 1) - (data.codes[b[0]] === 'blocked' ? 0 : 1) || b[1] - a[1]);
  return (
    <div style={{ minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>{SCOPE_NOTE}</div>
      {un && <div className="banner" style={{ marginBottom: 8 }}>{un}</div>}
      {error && <div className="banner" style={{ marginBottom: 8 }}>다시 불러오지 못했습니다 — 이전 결과를 보여 줍니다.</div>}
      <div className="kpis" style={{ marginBottom: 10 }}>
        <div className="kpi"><div className="label">준비율</div><div className="value">{readyPctText(data.readyPct)}</div><div className="sub">판정한 VM 중 준비됨</div></div>
        <div className="kpi"><div className="label">막힘</div><div className="value">{(c.blocked ?? 0).toLocaleString()}</div><div className="sub">먼저 조치해야 옮길 수 있음</div></div>
        <div className="kpi"><div className="label">확인 필요</div><div className="value">{(c.caution ?? 0).toLocaleString()}</div><div className="sub">옮길 수 있지만 준비·확인</div></div>
        <div className="kpi"><div className="label">준비됨</div><div className="value">{(c.ready ?? 0).toLocaleString()}</div><div className="sub">판정 불가 {(c.unknown ?? 0).toLocaleString()}대 별도</div></div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, alignItems: 'center' }}>
        {['blocked', 'caution', 'unknown', 'ready'].map((k) => <Chip key={k} active={level === k} onClick={() => setLevel(level === k ? '' : k)}>{LEVEL_LABEL[k]} {(c[k] ?? 0).toLocaleString()}</Chip>)}
        <Chip active={!level} onClick={() => setLevel('')}>전체 {(data.total ?? 0).toLocaleString()}</Chip>
        <input className="input" style={{ minWidth: 0, flex: '1 1 160px', maxWidth: 280 }} placeholder="VM·클러스터 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn" onClick={load} disabled={loading}>{loading ? '불러오는 중…' : '새로고침'}</button>
        {canCsv() && <button type="button" className="btn" onClick={csv}>CSV</button>}
      </div>
      {codes.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8, alignItems: 'center' }}>
          <span className="muted" style={{ fontSize: 12 }}>요인</span>
          {codes.map(([k, n]) => (
            <button key={k} type="button" className={`badge ${data.codes[k] === 'blocked' ? 'red' : 'amber'}`} style={{ cursor: 'pointer', border: code === k ? '1px solid var(--text)' : 0, whiteSpace: 'nowrap' }}
              onClick={() => setCode(code === k ? '' : k)} title={MIG_TEXT[k]?.fix || ''}>{MIG_TEXT[k]?.title || k} {n}</button>
          ))}
        </div>
      )}
      {csvErr && <ErrorBox error={csvErr} />}
      <div className="card" style={{ padding: 0, minWidth: 0, marginBottom: 10 }}>
        <div style={{ display: 'flex', gap: 6, padding: '8px 10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="muted" style={{ fontSize: 12 }}>묶음</span>
          <Chip active={by === 'vcenter'} onClick={() => setBy('vcenter')}>법인(vCenter)</Chip>
          <Chip active={by === 'cluster'} onClick={() => setBy('cluster')}>클러스터</Chip>
        </div>
        <div className="table-wrap" style={{ maxHeight: '40vh' }}><STable minWidth={760} wrap={false}>
          <thead><tr><th>vCenter</th>{by === 'cluster' && <th>클러스터</th>}<th>VM</th><th>막힘</th><th>확인 필요</th><th>판정 불가</th><th>준비됨</th><th>준비율</th></tr></thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.key}>
                <td>{g.vcenterName}</td>{by === 'cluster' && <td>{g.cluster}</td>}<td data-sort={g.vms}>{g.vms.toLocaleString()}</td>
                <td data-sort={g.blocked}>{g.blocked ? <span className="badge red">{g.blocked}</span> : 0}</td><td data-sort={g.caution}>{g.caution}</td>
                <td data-sort={g.unknown}>{g.unknown}</td><td data-sort={g.ready}>{g.ready}</td><td data-sort={g.readyPct ?? ''}>{g.readyPct == null ? '—' : `${g.readyPct}%`}</td>
              </tr>
            ))}
          </tbody>
        </STable></div>
      </div>
      <div className="card" style={{ padding: 0, minWidth: 0 }}>
        {vms.length === 0 ? <div className="muted" style={{ padding: 16, fontSize: 13 }}>조건에 맞는 VM 이 없습니다.</div> : (
          <div className="table-wrap" style={{ maxHeight: '70vh' }}><STable minWidth={960} wrap={false}>
            <thead><tr><th>VM</th><th>vCenter</th><th>등급</th><th>요인</th><th>vCPU</th><th>스토리지</th><th>하드웨어</th></tr></thead>
            <tbody>
              {vms.map((v) => (
                <tr key={`${v.vcenterId}:${v.id}`}>
                  <td><VmLink name={v.name} vcenterId={v.vcenterId} /></td>
                  <td>{v.vcenterName}<div className="muted" style={{ fontSize: 11 }}>{v.cluster}</div></td>
                  <td><span className={`badge ${LEVEL_BADGE[v.level]}`}>{LEVEL_LABEL[v.level]}</span>{v.level === 'unknown' && <div className="muted" style={{ fontSize: 11 }}>{!v.collected.cfg && !v.collected.dev ? '구성·장치 미수집' : !v.collected.dev ? '장치 미수집' : '구성 미수집'}</div>}</td>
                  <td style={{ whiteSpace: 'normal' }}>{v.findings.length ? v.findings.map((f) => (
                    <span key={f.code} className={`badge ${f.level === 'blocked' ? 'red' : 'amber'}`} style={{ marginRight: 4, marginBottom: 2, display: 'inline-block' }} title={MIG_TEXT[f.code]?.fix || ''}>{MIG_TEXT[f.code]?.title || f.code}</span>
                  )) : '—'}</td>
                  <td data-sort={v.cpuCount ?? ''}>{v.cpuCount ?? '—'}</td><td data-sort={v.storageGB ?? ''}>{v.storageGB == null ? '—' : `${v.storageGB.toLocaleString()} GB`}</td><td>{v.hwVersion || '—'}</td>
                </tr>
              ))}
            </tbody>
          </STable></div>
        )}
      </div>
      {data.omitted > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>상한으로 {data.omitted.toLocaleString()}대를 더 보여 주지 않았습니다 — 검색·등급으로 좁혀 보세요.</div>}
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>요인 배지에 마우스를 올리면 조치가 나옵니다 · 템플릿 {(data.templates ?? 0).toLocaleString()}개는 넣지 않았습니다.</div>
    </div>
  );
}
