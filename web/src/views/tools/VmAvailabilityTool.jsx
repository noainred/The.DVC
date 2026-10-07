/**
 * VM 가용성(SLA) — 특수 기능 `vm-availability`(v2.707 — C6). 이 포탈이 받아 둔 전원 이벤트로 VM 가동률·정지 시간·
 * 재부팅/재설정/HA 재시작 횟수를 보여 준다. 판정은 서버(`server/src/availability/analyze.js`), 문구는 `views/bizreport/availText.js`.
 * ⚠ 폴링하지 않는다(마운트 1회 + 새로고침) · 늦게 온 이전 응답은 버린다 · 훅은 전부 조기 return 위(React #310).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, downloadFile, canCsv } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { VmLink } from '../../components/EntityDetail.jsx';
import { pctText, downText, allowedDownMin, TARGETS, coverageNote, METHOD_NOTE } from '../bizreport/availText.js';
import Select from '../../components/Select.jsx';
import { mergeVcChoices } from './vcChoices.js';

const DAYS = [7, 30, 90];
function Chip({ active, onClick, children }) {
  return <button type="button" className={`tab${active ? ' active' : ''}`} onClick={onClick} style={{ padding: '4px 10px', fontSize: 12, whiteSpace: 'nowrap' }}>{children}</button>;
}

export default function VmAvailabilityTool({ scope }) {
  const [vcId, setVcId] = useState(scope || '');
  const [days, setDays] = useState(30);
  const [target, setTarget] = useState(99.9);
  const [below, setBelow] = useState(false);
  const [q, setQ] = useState('');
  const [qApplied, setQApplied] = useState('');
  const [data, setData] = useState(null);
  // v2.719(감사 W1-01): vCenter 를 고른 응답은 목록을 그 하나로 거른다 — 선택지는 '전체' 응답에서 본 목록을 기억해 쓴다.
  const [vcOpts, setVcOpts] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [csvErr, setCsvErr] = useState(null);
  const gen = useRef(0);
  useEffect(() => { setVcId(scope || ''); }, [scope]);
  useEffect(() => { const t = setTimeout(() => setQApplied(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const params = useCallback(() => {
    const p = { days, target };
    if (vcId) p.vcenterId = vcId;
    if (below) p.below = '1';
    if (qApplied) p.q = qApplied;
    return p;
  }, [days, target, vcId, below, qApplied]);
  const load = useCallback(async () => {
    const my = ++gen.current;
    setLoading(true);
    try {
      const p = params();
      const d = await fetchJson('/tools/vm-availability', p);
      if (my === gen.current) { setData(d); setError(null); setVcOpts((prev) => mergeVcChoices(prev, d?.vcenters, p.vcenterId)); }
    } catch (e) { if (my === gen.current) setError(e); } finally { if (my === gen.current) setLoading(false); }
  }, [params]);
  useEffect(() => { load(); }, [load]);
  const csv = async () => {
    setCsvErr(null);
    try { await downloadFile(`/tools/vm-availability.csv?${new URLSearchParams(Object.entries(params()).map(([k, v]) => [k, String(v)]))}`); } catch (e) { setCsvErr(e); }
  };

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const c = data.coverage || {};
  const t = data.totals || {};
  const cov = coverageNote(data);
  const vms = Array.isArray(data.vms) ? data.vms : [];
  const vcs = Array.isArray(data.vcenters) ? data.vcenters : [];
  const allow = allowedDownMin(data.target, data.days);
  return (
    <div style={{ minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
        VM 가동률(SLA)을 전원 이벤트로 잽니다 — 목표 {pctText(data.target)} 는 {data.days}일에 정지 {allow == null ? '—' : `${allow.toLocaleString()}분`}까지 허용합니다. 원천은 이 포탈이 받아 둔 vCenter 이벤트입니다.
      </div>
      {cov && <div className="banner" style={{ marginBottom: 8 }}>{cov}</div>}
      {error && <div className="banner" style={{ marginBottom: 8 }}>다시 불러오지 못했습니다 — 이전 결과를 보여 줍니다.</div>}
      <div className="kpis" style={{ marginBottom: 10 }}>
        <div className="kpi"><div className="label">전체 가동률</div><div className="value">{pctText(t.availability)}</div><div className="sub">측정 VM {(c.measured ?? 0).toLocaleString()} / {(c.vms ?? 0).toLocaleString()}대</div></div>
        <div className="kpi"><div className="label">목표 미달 VM</div><div className="value">{(c.belowTarget ?? 0).toLocaleString()}</div><div className="sub">목표 {pctText(data.target)}</div></div>
        <div className="kpi"><div className="label">HA 재시작</div><div className="value">{(t.ha ?? 0).toLocaleString()}</div><div className="sub">재설정 {(t.resets ?? 0).toLocaleString()} · 게스트 재부팅 {(t.reboots ?? 0).toLocaleString()}</div></div>
        <div className="kpi"><div className="label">전원 끔</div><div className="value">{(t.offs ?? 0).toLocaleString()}</div><div className="sub">사람이 끈 것 {(t.userOffs ?? 0).toLocaleString()} · 켜기 실패 {(t.failed ?? 0).toLocaleString()}</div></div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, alignItems: 'center' }}>
        <span className="muted" style={{ fontSize: 12 }}>기간</span>
        {DAYS.map((d) => <Chip key={d} active={days === d} onClick={() => setDays(d)}>{d}일</Chip>)}
        <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>목표</span>
        {TARGETS.map((x) => <Chip key={x} active={target === x} onClick={() => setTarget(x)}>{x}%</Chip>)}
        <Select className="input" style={{ minWidth: 0, maxWidth: 260 }} value={vcId} onChange={(e) => setVcId(e.target.value)}>
          <option value="">전체 vCenter</option>
          {vcOpts.map((v) => <option key={v.vcenterId} value={v.vcenterId}>{v.name}</option>)}
        </Select>
        <input className="input" style={{ minWidth: 0, flex: '1 1 160px', maxWidth: 300 }} placeholder="VM·클러스터 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn" onClick={load} disabled={loading}>{loading ? '불러오는 중…' : '새로고침'}</button>
        {canCsv() && <button type="button" className="btn" onClick={csv}>CSV</button>}
      </div>
      {csvErr && <ErrorBox error={csvErr} />}

      <div className="card" style={{ padding: 0, minWidth: 0, marginBottom: 10 }}>
        <div className="muted" style={{ fontSize: 12, padding: '8px 10px' }}>법인(vCenter)별 — 합산 가동률은 전체 정지 시간 ÷ 전체 측정 시간입니다(VM 평균이 아닙니다)</div>
        <div className="table-wrap" style={{ maxHeight: '40vh' }}><STable minWidth={720} wrap={false}>
          <thead><tr><th>vCenter</th><th>VM</th><th>측정</th><th>합산 가동률</th><th>최저 VM</th><th>목표 미달</th><th>판정 안 함</th></tr></thead>
          <tbody>
            {vcs.map((v) => (
              <tr key={v.vcenterId}>
                <td>{v.name}</td><td data-sort={v.vms}>{v.vms.toLocaleString()}</td><td data-sort={v.measured}>{v.measured.toLocaleString()}</td>
                <td data-sort={v.availability ?? ''}>{pctText(v.availability)}</td><td data-sort={v.min ?? ''}>{pctText(v.min)}</td>
                <td data-sort={v.below}>{v.below ? <span className="badge red">{v.below}</span> : 0}</td>
                <td data-sort={v.noEvents}>{v.noEvents ? <span className="badge gray" title="이벤트를 받은 적 없는 vCenter">{v.noEvents}</span> : 0}</td>
              </tr>
            ))}
          </tbody>
        </STable></div>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
        <Chip active={!below} onClick={() => setBelow(false)}>정지·재시작이 있었던 VM</Chip>
        <Chip active={below} onClick={() => setBelow(true)}>목표 미달만</Chip>
      </div>
      <div className="card" style={{ padding: 0, minWidth: 0 }}>
        {vms.length === 0 ? (
          <div className="muted" style={{ padding: 16, fontSize: 13 }}>{(c.measured ?? 0) === 0 ? '측정한 VM 이 없습니다(위 안내를 보세요).' : '이 기간에 정지·재시작이 기록된 VM 이 없습니다.'}</div>
        ) : (
          <div className="table-wrap" style={{ maxHeight: '70vh' }}><STable minWidth={1040} wrap={false}>
            <thead><tr><th>VM</th><th>vCenter</th><th>가동률</th><th>사람이 끈 정지 제외</th><th>정지 시간</th><th>전원 끔</th><th>재부팅</th><th>재설정</th><th>HA 재시작</th><th>켜기 실패</th></tr></thead>
            <tbody>
              {vms.map((v) => (
                <tr key={`${v.vcenterId}:${v.id}`}>
                  <td><VmLink name={v.name} vcenterId={v.vcenterId} />{v.partial && <div className="muted" style={{ fontSize: 11 }} title="이벤트 수집 시작부터만 쟀습니다">측정 구간 짧음</div>}{v.bornInWindow && <div className="muted" style={{ fontSize: 11 }}>기간 중 생성 — 생성 뒤부터 잼</div>}</td>
                  <td>{v.vcenterName}<div className="muted" style={{ fontSize: 11 }}>{v.cluster}</div></td>
                  <td data-sort={v.availability}>{v.below ? <span className="badge red">{pctText(v.availability)}</span> : pctText(v.availability)}</td>
                  <td data-sort={v.unplanned}>{pctText(v.unplanned)}</td>
                  <td data-sort={v.downMs}>{downText(v.downMs)}</td>
                  <td data-sort={v.offs}>{v.offs}{v.userOffs ? <span className="muted" style={{ fontSize: 11 }}> (사람 {v.userOffs})</span> : null}</td>
                  <td data-sort={v.reboots}>{v.reboots}</td><td data-sort={v.resets}>{v.resets}</td>
                  <td data-sort={v.ha}>{v.ha ? <span className="badge amber">{v.ha}</span> : 0}</td><td data-sort={v.failed}>{v.failed}</td>
                </tr>
              ))}
            </tbody>
          </STable></div>
        )}
      </div>
      {data.omitted > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>상한으로 {data.omitted.toLocaleString()}대를 더 보여 주지 않았습니다 — 검색이나 vCenter 로 좁혀 보세요.</div>}
      <div className="muted" style={{ fontSize: 12, marginTop: 8, whiteSpace: 'normal' }}>{METHOD_NOTE} VM 은 이벤트 이름으로 묶으므로 같은 vCenter 의 동명 VM 은 구분하지 못합니다.</div>
    </div>
  );
}
