// IdracTrendTable.jsx — iDRAC 통합 추이 › 서버 표 · 조건 검색(v2.663).
// 사용자 요청: "데이터 센터 선택하면 전체 서버 리스트를 표 형식으로" + "최근 몇 시간 동안 CPU/GPU 온도 몇 도 이상/이하,
// 소비 전력 몇 W 이상/이하 검색하는 조건식" + "제목별로 소팅". 판정·문구는 idracTrendText.js(순수 — vitest)가 한다.
// 서버(`GET /admin/idrac/trend/table`)는 데이터센터(또는 전체)의 전 서버 요약을 한 번에 주고, 조건은 화면이 거른다 —
// 조건을 바꿔도 다시 조회하지 않는다. 폴링하지 않는다(마운트·기간·범위 변경 + 새로고침 버튼).
import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson, canCsv } from '../../api.js';
import { Loading, ErrorBox } from '../../components/primitives.jsx';
import { STable } from '../../components/STable.jsx';
import {
  SERIES, TABLE_HOUR_PRESETS, TABLE_HOURS_MAX, hoursLabel, COND_OPS, newCond, filterTable, condText, cellHit, valueText, tableCsv, ymd, hm,
} from './idracTrendText.js';

const ALL = '*';
const SORT_BY = [['max', '최대'], ['avg', '평균'], ['min', '최소'], ['cur', '현재']];

export function IdracTrendTable({ corps, sitesFor, initCorp, initSite, gpuOnly, onOpen }) {
  const [corp, setCorp] = useState(initCorp ?? ALL);
  const [site, setSite] = useState(initSite ?? ALL);
  const [hours, setHours] = useState(24);
  const [hoursDraft, setHoursDraft] = useState('24');
  const [conds, setConds] = useState(() => [newCond('cpuTemp', 'ge', ''), newCond('powerW', 'ge', '')]);
  const [mode, setMode] = useState('all');
  const [sortBy, setSortBy] = useState('max');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [tick, setTick] = useState(0);

  const sites = useMemo(() => (corp === ALL ? [] : sitesFor(corp)), [corp, sitesFor]);
  useEffect(() => { if (corp !== ALL && site !== ALL && !sites.some((s) => s.value === site)) setSite(ALL); }, [corp, site, sites]);

  useEffect(() => {
    let alive = true;
    setErr(null); setData(null);
    fetchJson('/admin/idrac/trend/table', { hours, corp, site: corp === ALL ? ALL : site, ...(gpuOnly ? { gpuOnly: 1 } : {}) })
      .then((d) => { if (alive) setData(d); }).catch((e) => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, [hours, corp, site, gpuOnly, tick]);

  const res = useMemo(() => filterTable(data?.rows || [], conds, mode), [data, conds, mode]);
  const ctext = condText(conds, mode);
  const setCond = (id, patch) => setConds((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const applyHours = (v) => { const n = Number(v); if (Number.isInteger(n) && n >= 1 && n <= TABLE_HOURS_MAX) { setHours(n); setHoursDraft(String(n)); } };
  const hoursBad = !(Number.isInteger(Number(hoursDraft)) && Number(hoursDraft) >= 1 && Number(hoursDraft) <= TABLE_HOURS_MAX);
  const saveCsv = () => {
    const blob = new Blob([tableCsv(res.rows, hours)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `idrac-servers_${hours}h.csv`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const cell = (r, s) => {
    const x = r[s.k];
    const hit = cellHit(r, s.k, conds);
    const sortV = x ? x[sortBy] : null;
    return (
      <td key={s.k} className="right" data-sort={sortV ?? ''} style={hit ? { background: 'rgba(245,158,11,.14)' } : undefined}>
        {x ? (
          <>
            <div style={{ fontWeight: 700, color: s.color, whiteSpace: 'nowrap' }} title="기간 최대">{valueText(x.max, s.unit)}</div>
            <div style={{ fontSize: 11, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>평균 {valueText(x.avg, s.unit)} · 최소 {valueText(x.min, s.unit)}</div>
          </>
        ) : <span className="muted">—</span>}
      </td>
    );
  };

  return (
    <div className="card" style={{ padding: '14px 16px', minWidth: 0 }}>
      <div className="flex wrap" style={{ gap: 10, alignItems: 'center', marginBottom: 10 }}>
        <label className="flex" style={{ alignItems: 'center', gap: 6, fontSize: 13 }}>
          <span className="muted">법인</span>
          <select className="select" value={corp} onChange={(e) => { setCorp(e.target.value); setSite(ALL); }}>
            <option value={ALL}>(전체 법인)</option>
            {corps.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        <label className="flex" style={{ alignItems: 'center', gap: 6, fontSize: 13 }}>
          <span className="muted">데이터센터</span>
          <select className="select" value={corp === ALL ? ALL : site} disabled={corp === ALL} onChange={(e) => setSite(e.target.value)}>
            <option value={ALL}>(전체 데이터센터)</option>
            {sites.map((s) => <option key={s.value} value={s.value}>{s.value} · {s.n}대</option>)}
          </select>
        </label>
        <span className="flex wrap" style={{ gap: 4, alignItems: 'center' }} role="group" aria-label="최근 기간">
          <span className="muted" style={{ fontSize: 13 }}>최근</span>
          {TABLE_HOUR_PRESETS.map((h) => (
            <button key={h} type="button" className={hours === h ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '3px 10px', marginTop: 0, fontSize: 12 }} onClick={() => applyHours(h)}>{hoursLabel(h)}</button>
          ))}
          <input className="input" style={{ width: 70, minWidth: 0, padding: '3px 6px' }} value={hoursDraft} inputMode="numeric" aria-label="시간 직접 입력"
            onChange={(e) => setHoursDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') applyHours(hoursDraft); }} />
          <button type="button" className="tab" style={{ flex: 'none', padding: '3px 10px', marginTop: 0, fontSize: 12 }} disabled={hoursBad} onClick={() => applyHours(hoursDraft)}>시간 적용</button>
        </span>
        <button type="button" className="tab" style={{ flex: 'none', padding: '3px 10px', marginTop: 0, marginLeft: 'auto' }} onClick={() => setTick((t) => t + 1)}>↻ 새로고침</button>
      </div>
      {hoursBad && <div style={{ fontSize: 12, color: 'var(--amber)', marginBottom: 8 }}>시간은 1~{TABLE_HOURS_MAX} 정수로 입력하세요.</div>}

      {/* 조건식 — '이상' 은 그 기간 최대, '이하' 는 최소로 판정(한 번이라도). 빈 값 조건은 무시한다. */}
      <div className="idrac-trend-conds" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', marginBottom: 10 }}>
        <div className="flex wrap" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <b style={{ fontSize: 13 }}>조건 검색</b>
          <span className="flex" style={{ gap: 4 }} role="group" aria-label="조건 결합">
            <button type="button" className={mode === 'all' ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '2px 9px', marginTop: 0, fontSize: 12 }} onClick={() => setMode('all')}>모두 만족</button>
            <button type="button" className={mode === 'any' ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '2px 9px', marginTop: 0, fontSize: 12 }} onClick={() => setMode('any')}>하나라도</button>
          </span>
          <span className="muted" style={{ fontSize: 11 }}>최근 {hoursLabel(hours)} 안에 한 번이라도 — 이상은 기간 최대, 이하는 기간 최소로 봅니다. 값을 비운 줄은 쓰지 않습니다.</span>
        </div>
        {conds.map((c) => {
          const s = SERIES.find((x) => x.k === c.k);
          return (
            <div key={c.id} className="flex wrap" style={{ gap: 6, alignItems: 'center', padding: '3px 0' }}>
              <select className="select" aria-label="지표" value={c.k} onChange={(e) => setCond(c.id, { k: e.target.value })}>
                {SERIES.map((x) => <option key={x.k} value={x.k}>{x.label}</option>)}
              </select>
              <input className="input" aria-label="기준값" style={{ width: 90, minWidth: 0, padding: '3px 6px' }} inputMode="decimal" placeholder="값" value={c.v} onChange={(e) => setCond(c.id, { v: e.target.value })} />
              <span className="muted" style={{ fontSize: 12, width: 18 }}>{s?.unit.trim()}</span>
              <select className="select" aria-label="비교" value={c.op} onChange={(e) => setCond(c.id, { op: e.target.value })}>
                {COND_OPS.map((o) => <option key={o.k} value={o.k}>{o.label}</option>)}
              </select>
              <button type="button" className="tab" aria-label="조건 삭제" style={{ flex: 'none', padding: '2px 8px', marginTop: 0, fontSize: 12 }} onClick={() => setConds((cs) => cs.filter((x) => x.id !== c.id))}>✕</button>
            </div>
          );
        })}
        <div className="flex wrap" style={{ gap: 6, marginTop: 6 }}>
          <button type="button" className="tab" style={{ flex: 'none', padding: '2px 10px', marginTop: 0, fontSize: 12 }} disabled={conds.length >= 8} onClick={() => setConds((cs) => [...cs, newCond('gpuTemp', 'ge', '')])}>+ 조건 추가</button>
          <button type="button" className="tab" style={{ flex: 'none', padding: '2px 10px', marginTop: 0, fontSize: 12 }} disabled={!ctext} onClick={() => setConds((cs) => cs.map((c) => ({ ...c, v: '' })))}>조건 비우기</button>
        </div>
      </div>

      {err && <ErrorBox error={err} />}
      {!data && !err && <Loading label="서버 요약" />}
      {data && (
        <>
          <div className="flex wrap" style={{ gap: 10, alignItems: 'center', margin: '4px 0 8px', fontSize: 12 }}>
            <b>{ctext ? `조건에 맞는 서버 ${res.rows.length}대` : `서버 ${res.rows.length}대`}</b>
            <span className="muted">/ 조회 {data.total}대{ctext ? ` · ${ctext}` : ''}</span>
            {ctext && res.unknown > 0 && <span style={{ color: 'var(--amber)' }}>값이 없어 판정하지 못한 서버 {res.unknown}대는 빠졌습니다(0 으로 보지 않습니다).</span>}
            <span className="flex" style={{ gap: 4, alignItems: 'center', marginLeft: 'auto' }} role="group" aria-label="정렬 기준">
              <span className="muted">정렬 기준</span>
              {SORT_BY.map(([k, l]) => (
                <button key={k} type="button" className={sortBy === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '2px 9px', marginTop: 0, fontSize: 12 }} onClick={() => setSortBy(k)}>{l}</button>
              ))}
            </span>
            {canCsv() && <button type="button" className="logout-btn" style={{ flex: 'none', padding: '4px 12px' }} disabled={!res.rows.length} onClick={saveCsv}>⬇ 표 CSV</button>}
          </div>
          {data.scoped && data.omittedOutOfScope > 0 && <div className="banner" style={{ marginBottom: 8 }}>범위 밖 서버 {data.omittedOutOfScope}대는 뺐습니다.</div>}
          {Object.keys(data.errors || {}).length > 0 && <div className="banner" style={{ marginBottom: 8 }}>일부 지표를 읽지 못했습니다: {Object.keys(data.errors).join(', ')}</div>}
          <STable minWidth={1180} limit={2000}>
            <thead>
              <tr>
                <th>서버</th><th>법인</th><th>데이터센터</th><th>유형</th>
                {SERIES.map((s) => <th key={s.k} className="right">{s.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {res.rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <button type="button" onClick={() => onOpen(r)} title="이 서버의 추이 차트로 이동"
                      style={{ background: 'none', border: 0, padding: 0, color: 'inherit', cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: 3, fontWeight: 600, textAlign: 'left' }}>{r.name}</button>
                    {r.gpu && <span className="badge gray" style={{ marginLeft: 6 }}>GPU</span>}
                  </td>
                  <td>{r.corpName}</td>
                  <td>{r.site}</td>
                  <td>{r.kind === 'esxi' ? 'ESXi' : '베어메탈'}</td>
                  {SERIES.map((s) => cell(r, s))}
                </tr>
              ))}
            </tbody>
          </STable>
          {!res.rows.length && <div className="muted" style={{ padding: 12 }}>{ctext ? '조건에 맞는 서버가 없습니다.' : '이 범위에 서버가 없습니다.'}</div>}
          <div className="muted" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.6 }}>
            각 칸은 최근 {hoursLabel(hours)}의 최대(굵게) · 평균 · 최소입니다. 열 제목을 누르면 정렬되고, 기준(최대·평균·최소·현재)은 오른쪽 위에서 고릅니다.
            조건을 만족한 칸은 호박색으로 칠합니다. 값은 시간당 집계에서 읽어 기간이 앞쪽으로 최대 1시간 넓습니다(실제 시작 {ymd(data.since)} {hm(data.since)}).
            CPU 사용률은 iDRAC 텔레메트리·베어메탈 사용률·vCenter 호스트 값을 합쳐 봅니다(추이 차트의 베어메탈 이력 대체는 표에 쓰지 않습니다). 서버 이름을 누르면 그 서버의 추이 차트로 갑니다.
          </div>
        </>
      )}
    </div>
  );
}
