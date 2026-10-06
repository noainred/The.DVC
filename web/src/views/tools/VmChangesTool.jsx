/**
 * VM 이동·구성 변경 이력 — 특수 기능 `vm-changes`(v2.702 — A7·A8). vMotion·DRS·Storage vMotion 이동 횟수와 과다 이동(churn),
 * 구성 변경(변경 전/후 원문·바뀐 항목)·권한/역할 변경·누가.
 * ⚠ 판정은 서버(`server/src/vmchanges/analyze.js`) — 이 화면은 조립만. 문구는 `views/vmchanges/vmChangesText.js`.
 * ⚠ 폴링하지 않는다(마운트 1회 + 새로고침) · 늦게 온 이전 응답은 버린다(세대 번호) · 훅은 전부 조기 return 위(React #310).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, downloadFile, canCsv } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { VmLink } from '../../components/EntityDetail.jsx';
import {
  MOVE_KIND_LABEL, CHANGE_KIND_LABEL, fmtTs, routeText, coverageNote, truncNote, noDetailNote, changeText,
} from '../vmchanges/vmChangesText.js';
import Select from '../../components/Select.jsx';

const DAYS = [1, 7, 30, 90];

function Chip({ active, onClick, children, title }) {
  return (
    <button type="button" className={`tab${active ? ' active' : ''}`} onClick={onClick} title={title}
      style={{ whiteSpace: 'normal', maxWidth: '100%', textAlign: 'left', padding: '4px 10px', fontSize: 12 }}>{children}</button>
  );
}

function MoveBars({ series }) {
  const max = Math.max(1, ...series.map((s) => s.moves));
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 48, minWidth: 0 }} aria-label="하루 이동 횟수">
      {series.map((s) => (
        <div key={s.day} title={`${new Date(s.day).toLocaleDateString('ko-KR')} · ${s.moves}회`}
          style={{ flex: '1 1 0', minWidth: 2, height: s.moves ? `${Math.max(4, (s.moves / max) * 100)}%` : 1,
            background: s.moves ? 'var(--accent)' : 'var(--border)' }} />
      ))}
    </div>
  );
}

export default function VmChangesTool({ scope }) {
  const [tab, setTab] = useState('moves');
  const [vcId, setVcId] = useState(scope || '');
  const [days, setDays] = useState(7);
  const [kind, setKind] = useState('');
  const [churnOnly, setChurnOnly] = useState(false);
  const [q, setQ] = useState('');
  const [qApplied, setQApplied] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvErr, setCsvErr] = useState(null);
  const gen = useRef(0);

  useEffect(() => { setVcId(scope || ''); }, [scope]);
  useEffect(() => { const t = setTimeout(() => setQApplied(q.trim()), 300); return () => clearTimeout(t); }, [q]);

  const load = useCallback(async () => {
    const my = ++gen.current;
    setLoading(true);
    try {
      const params = { days };
      if (vcId) params.vcenterId = vcId;
      if (kind) params.kind = kind;
      if (qApplied) params.q = qApplied;
      const d = await fetchJson('/tools/vm-changes', params);
      if (my !== gen.current) return;
      setData(d); setError(null);
    } catch (e) { if (my === gen.current) setError(e); } finally { if (my === gen.current) setLoading(false); }
  }, [vcId, days, kind, qApplied]);
  useEffect(() => { load(); }, [load]);

  const showCsv = canCsv();
  const csv = async () => {
    setCsvBusy(true); setCsvErr(null);
    try {
      const qs = new URLSearchParams({ kind: tab, days: String(days) });
      if (vcId) qs.set('vcenterId', vcId);
      await downloadFile(`/tools/vm-changes.csv?${qs}`);
    } catch (e) { setCsvErr(e); } finally { setCsvBusy(false); }
  };

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const mv = data.moves || {};
  const ch = data.changes || {};
  const vcs = Array.isArray(data.vcenters) ? data.vcenters : [];
  const cov = coverageNote(data);
  const trunc = truncNote(data);
  const vmRows = (Array.isArray(mv.vms) ? mv.vms : []).filter((v) => !churnOnly || v.churn);
  const events = Array.isArray(ch.events) ? ch.events : [];

  return (
    <div style={{ minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
        VM 이 어느 호스트·데이터스토어로 옮겨 다녔는지(vMotion·DRS·Storage vMotion)와, 누가 언제 VM 구성·권한을 바꿨는지를 봅니다.
        원천은 이 포탈이 받아 둔 vCenter 이벤트입니다(vCenter 왕복 없음).
      </div>
      {cov && <div className="banner" style={{ marginBottom: 8 }}>{cov}</div>}
      {trunc && <div className="banner" style={{ marginBottom: 8 }}>{trunc}</div>}
      {error && <div className="banner" style={{ marginBottom: 8 }}>다시 불러오지 못했습니다 — 이전 결과를 보여 줍니다.</div>}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, alignItems: 'center' }}>
        <Chip active={tab === 'moves'} onClick={() => setTab('moves')}>이동 이력 <b>{(mv.total ?? 0).toLocaleString()}</b></Chip>
        <Chip active={tab === 'changes'} onClick={() => setTab('changes')}>구성·권한 변경 <b>{(ch.total ?? 0).toLocaleString()}</b></Chip>
        <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>기간</span>
        {DAYS.map((d) => <Chip key={d} active={days === d} onClick={() => setDays(d)}>{d}일</Chip>)}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10, alignItems: 'center' }}>
        <span className="muted" style={{ fontSize: 12 }}>vCenter</span>
        <Select className="input" style={{ minWidth: 0, maxWidth: 260 }} value={vcId} onChange={(e) => setVcId(e.target.value)}>
          <option value="">전체</option>
          {vcs.map((v) => <option key={v.vcenterId} value={v.vcenterId}>{v.name}</option>)}
        </Select>
        <input className="input" style={{ minWidth: 0, flex: '1 1 180px', maxWidth: 320 }} placeholder={tab === 'moves' ? 'VM·vCenter 검색' : 'VM·사용자·대상 검색'} value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn" onClick={load} disabled={loading}>{loading ? '불러오는 중…' : '새로고침'}</button>
        {showCsv && <button type="button" className="btn" onClick={csv} disabled={csvBusy}>CSV</button>}
      </div>
      {csvErr && <ErrorBox error={csvErr} />}

      {tab === 'moves' ? (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {Object.entries(MOVE_KIND_LABEL).map(([k, label]) => (
              <span key={k} className="badge gray" style={{ whiteSpace: 'nowrap' }}>{label} {(mv.byKind?.[k] ?? 0).toLocaleString()}</span>
            ))}
            <span className={`badge ${mv.churnVms ? 'amber' : 'gray'}`} style={{ whiteSpace: 'nowrap' }}
              title={`기간 ${days}일에 ${mv.churnThreshold}회 이상 옮겨 다닌 VM`}>과다 이동 VM {(mv.churnVms ?? 0).toLocaleString()}</span>
          </div>
          {Array.isArray(mv.series) && mv.series.length > 1 && (
            <div className="card" style={{ padding: 10, marginBottom: 8, minWidth: 0 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>하루 이동 횟수(한국 날짜) — 막대에 마우스를 올리면 날짜·횟수</div>
              <MoveBars series={mv.series} />
            </div>
          )}
          {noDetailNote(mv.noDetail, mv.total ?? 0) && <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{noDetailNote(mv.noDetail, mv.total ?? 0)}</div>}
          <label style={{ fontSize: 12, display: 'inline-flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
            <input type="checkbox" checked={churnOnly} onChange={(e) => setChurnOnly(e.target.checked)} /> 과다 이동 VM 만({mv.churnThreshold}회 이상)
          </label>
          <div className="card" style={{ padding: 0, minWidth: 0 }}>
            {vmRows.length === 0 ? (
              <div className="muted" style={{ padding: 16, fontSize: 13 }}>
                {(mv.total ?? 0) === 0 ? '이 기간에 받은 이동 이벤트가 없습니다(수집 범위는 위 안내를 보세요).' : '조건에 맞는 VM 이 없습니다.'}
              </div>
            ) : (
              <STable minWidth={900}>
                <thead><tr><th>VM</th><th>vCenter</th><th>이동</th><th>DRS</th><th>수동</th><th>스토리지 이동</th><th>거친 호스트</th><th>마지막 이동</th><th>마지막 경로</th></tr></thead>
                <tbody>
                  {vmRows.map((v) => (
                    <tr key={`${v.vcenterId}|${v.vm}`}>
                      <td style={{ minWidth: 140 }}><VmLink name={v.vm} vcenterId={v.vcenterId} />{v.churn && <span className="badge amber" style={{ marginLeft: 6 }}>과다</span>}</td>
                      <td className="muted" style={{ fontSize: 12 }}>{v.vcenterName}</td>
                      <td data-sort={v.moves}><b>{v.moves}</b></td>
                      <td data-sort={v.drs}>{v.drs}</td>
                      <td data-sort={v.manual}>{v.manual}</td>
                      <td data-sort={v.storage}>{v.storage}</td>
                      <td data-sort={v.hosts}>{v.hosts || '—'}</td>
                      <td data-sort={v.last ?? ''} style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtTs(v.last)}</td>
                      <td style={{ whiteSpace: 'normal', fontSize: 12, overflowWrap: 'anywhere' }}>{routeText(v.lastFrom, v.lastTo)}</td>
                    </tr>
                  ))}
                </tbody>
              </STable>
            )}
          </div>
          {mv.omitted > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>이동이 많은 순 상위 {(mv.vms || []).length.toLocaleString()}대만 표시했습니다 — {mv.omitted.toLocaleString()}대는 검색으로 좁혀 보세요.</div>}
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>VM 은 이벤트의 VM 이름으로 묶습니다 — 같은 vCenter 의 동명 VM 은 구분하지 못합니다. '과다 이동' 은 기간에 비례한 기준(7일에 10회)이고 DRS 균형 설정·호스트 부하를 함께 보세요.</div>
        </>
      ) : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, alignItems: 'center' }}>
            <Chip active={!kind} onClick={() => setKind('')}>전체</Chip>
            {Object.entries(CHANGE_KIND_LABEL).map(([k, label]) => (
              <Chip key={k} active={kind === k} onClick={() => setKind(kind === k ? '' : k)}>{label} <b>{(ch.byKind?.[k] ?? 0).toLocaleString()}</b></Chip>
            ))}
          </div>
          {Array.isArray(ch.users) && ch.users.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8, alignItems: 'center' }}>
              <span className="muted" style={{ fontSize: 12 }}>바꾼 사람</span>
              {ch.users.slice(0, 12).map((u) => (
                <button key={u.user} type="button" className="badge gray" style={{ cursor: 'pointer', border: 0 }} onClick={() => setQ(u.user === '(사용자 미상)' ? '' : u.user)}
                  title="누르면 이 사용자로 검색합니다">{u.user} {u.n}</button>
              ))}
              {ch.users.length > 12 && <span className="muted" style={{ fontSize: 12 }}>외 {ch.users.length - 12}명</span>}
            </div>
          )}
          {noDetailNote(ch.noDetail, ch.total ?? 0) && <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{noDetailNote(ch.noDetail, ch.total ?? 0)}</div>}
          <div className="card" style={{ padding: 0, minWidth: 0 }}>
            {events.length === 0 ? (
              <div className="muted" style={{ padding: 16, fontSize: 13 }}>
                {(ch.total ?? 0) === 0 ? '이 기간에 받은 구성·권한 변경 이벤트가 없습니다(수집 범위는 위 안내를 보세요).' : '조건에 맞는 변경이 없습니다.'}
              </div>
            ) : (
              <STable minWidth={960}>
                <thead><tr><th>시각</th><th>vCenter</th><th>대상</th><th>종류</th><th>사용자</th><th>변경 내용</th></tr></thead>
                <tbody>
                  {events.map((e, i) => (
                    <tr key={`${e.ts}-${i}`}>
                      <td data-sort={e.ts} style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtTs(e.ts)}</td>
                      <td className="muted" style={{ fontSize: 12 }}>{e.vcenterName}</td>
                      <td style={{ minWidth: 120 }}>{e.kind === 'reconfig' && e.entity ? <VmLink name={e.entity} vcenterId={e.vcenterId} /> : (e.entity || '—')}</td>
                      <td style={{ whiteSpace: 'nowrap' }}><span className={`badge ${e.kind === 'reconfig' ? 'blue' : 'amber'}`}>{CHANGE_KIND_LABEL[e.kind] || e.type}</span></td>
                      <td style={{ fontSize: 12 }}>{e.user || <span className="muted">미상</span>}</td>
                      <td style={{ whiteSpace: 'normal', fontSize: 12, overflowWrap: 'anywhere', maxWidth: 520 }} title={e.message}>{changeText(e)}</td>
                    </tr>
                  ))}
                </tbody>
              </STable>
            )}
          </div>
          {ch.omitted > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>최신 {events.length.toLocaleString()}건만 표시했습니다 — {ch.omitted.toLocaleString()}건은 검색·종류로 좁혀 보세요.</div>}
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>변경 전/후 원문은 vCenter 6.7 이상이 이벤트에 싣는 값이고, 없으면 바뀐 항목 이름만 보입니다. 행에 마우스를 올리면 vCenter 이벤트 문구가 보입니다.</div>
        </>
      )}
    </div>
  );
}
