/**
 * 법인별 서버 사용량 — 한 페이지에 법인별(전체/다빈치/IRS) **서버 전체 · 물리 · 가상화** 의 CPU·메모리 사용량(v2.625).
 *
 * 사용자 요청(2026-09-27): "iDRAC 사용량을 ESXi 호스트까지 넓혀서 진행 · 법인별 전체/다빈치/IRS ·
 *   서버의 전체 CPU/메모리 사용량 · 물리서버 CPU/메모리 사용량 · 가상화 서버 CPU/메모리 사용량을 1페이지에".
 *
 * ⚠ 합계·가중 사용률은 서버(`corpusage/build.js`)가 계산한다. 이 파일은 조립만 하고, 문구·판정은 `corpUsageText.js`(순수) 가 갖는다.
 * ⚠ **폴링하지 않는다** — 분류가 전 서버를 훑는다(마운트 1회 + 새로고침, v2.508 규약).
 * ⚠ 서버 목록은 여기 없다 — 서버별 값은 '베어메탈 사용률' 화면이 소유한다(두 화면이 서버 판정을 복제하지 않게).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { dayStamp } from '../../dayStamp.js';
import {
  GROUP_LABEL, ROLE_LABEL, pctText, coresText, memText, coverageText, srcText, isPartial,
  filterCorps, groupCounts, noticesOf, footnotes, csvOf, usageTone, toneVar,
} from './corpUsageText.js';

const NOTICE_COLOR = { bad: 'var(--red)', warn: 'var(--amber)', info: 'var(--text-dim)' };

function Pct({ m }) {
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      <b style={{ color: toneVar(usageTone(m?.pct)) }}>{pctText(m?.pct)}</b>
    </span>
  );
}

/** KPI 카드 — 역할 하나(전체/물리/가상화)의 CPU·메모리. */
function RoleCard({ role, agg }) {
  return (
    <div className="card" style={{ padding: 14, minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{ROLE_LABEL[role]}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 10 }}>
        {[['CPU', agg?.cpu, coresText(agg?.cpu)], ['메모리', agg?.mem, memText(agg?.mem)]].map(([label, m, abs]) => (
          <div key={label} style={{ minWidth: 0 }}>
            <div className="muted" style={{ fontSize: 11 }}>{label}</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: toneVar(usageTone(m?.pct)) }}>{pctText(m?.pct)}</div>
            <div className="muted" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>{abs}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, marginTop: 8, color: isPartial(agg) ? 'var(--amber)' : 'var(--text-dim)' }}>{coverageText(agg)}</div>
      {srcText(agg) && <div className="muted" style={{ fontSize: 11 }}>출처 {srcText(agg)}</div>}
    </div>
  );
}

export default function CorpUsage({ scope = '' } = {}) {
  // ⚠ 훅은 전부 조기 return 위에(React #310).
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [group, setGroup] = useState('all');
  const [onlyScope, setOnlyScope] = useState(true);
  const [msg, setMsg] = useState('');
  const gen = useRef(0);

  async function load() {
    const my = ++gen.current;
    setLoading(true);
    try {
      const d = await fetchJson('/tools/corp-usage');
      if (my !== gen.current) return;             // 늦게 온 이전 응답은 버린다
      setData(d); setError(null);
    } catch (e) {
      if (my !== gen.current) return;
      setError(e);
    } finally {
      if (my === gen.current) setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  const counts = useMemo(() => groupCounts(data?.corps || []), [data]);
  const effScope = scope && onlyScope ? scope : '';
  const rows = useMemo(() => filterCorps(data?.corps || [], group, effScope), [data, group, effScope]);
  const tot = data?.totals?.[group] || null;
  const notices = useMemo(() => noticesOf(data), [data]);

  function exportCsv() {
    try {
      const name = `corp-usage-${dayStamp()}${group !== 'all' || effScope ? '-filtered' : ''}.csv`;
      const blob = new Blob([`﻿${csvOf(rows)}`], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      setMsg(`법인 ${rows.length}곳을 CSV 로 내보냈습니다(${name}).`);
    } catch (e) { setMsg(`내보내기 실패: ${e?.message || e}`); }
  }

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: 12, minWidth: 0 }}>
      <div className="flex wrap" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {['all', 'davinci', 'irs'].map((g) => (
          <button key={g} className={`tab${group === g ? ' active' : ''}`} onClick={() => setGroup(g)} aria-pressed={group === g}>
            {GROUP_LABEL[g]} <span className="muted">{counts[g]}</span>
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {scope && (
          <label style={{ fontSize: 12 }}>
            <input type="checkbox" checked={onlyScope} onChange={(e) => setOnlyScope(e.target.checked)} /> 선택한 법인만
          </label>
        )}
        <button className="tab" onClick={exportCsv} disabled={!rows.length}>CSV</button>
        <button className="tab" onClick={load} disabled={loading}>{loading ? '불러오는 중…' : '새로고침'}</button>
      </div>
      {error && <div style={{ fontSize: 12, color: 'var(--amber)' }}>새로고침 실패 — 아래는 직전 값입니다: {String(error?.message || error)}</div>}
      {msg && <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{msg}</div>}

      {notices.length > 0 && (
        <div className="card" style={{ padding: '10px 14px' }}>
          {notices.map((n, i) => (
            <div key={i} style={{ fontSize: 12, lineHeight: 1.7, color: NOTICE_COLOR[n.tone] || 'var(--text-dim)' }}><BoldText text={n.text} /></div>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: 12 }}>
        {['all', 'bm', 'virt'].map((r) => <RoleCard key={r} role={r} agg={tot?.[r]} />)}
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        {GROUP_LABEL[group]} 법인 {tot?.corps ?? 0}곳 · 서버 {tot?.all?.servers ?? 0}대(물리 {tot?.bm?.servers ?? 0} · 가상화 {tot?.virt?.servers ?? 0})
        {effScope ? ' · 표는 선택한 법인만 보입니다(위 합계는 구분 전체)' : ''}
      </div>

      <div className="card" style={{ padding: 0, minWidth: 0 }}>
        {rows.length === 0 ? (
          <div className="muted" style={{ padding: 16, fontSize: 13 }}>
            {(data.corps || []).length === 0 ? '서버가 있는 법인이 없습니다 — 서버 분석 › 구분이 비어 있거나 첫 수집 중입니다.' : `${GROUP_LABEL[group]} 구분에 해당하는 법인이 없습니다.`}
          </div>
        ) : (
          <STable className="table" minWidth={980}>
            <thead>
              <tr>
                <th>법인</th>
                <th>구분</th>
                <th className="right">서버</th>
                <th className="right">전체 CPU</th>
                <th className="right">전체 메모리</th>
                <th className="right">물리 CPU</th>
                <th className="right">물리 메모리</th>
                <th className="right">가상화 CPU</th>
                <th className="right">가상화 메모리</th>
                <th>반영</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.vcenterId}>
                  <td data-sort={c.name}>{c.name}</td>
                  <td>{GROUP_LABEL[c.group] || c.group}</td>
                  <td className="right" data-sort={c.all?.servers ?? ''} title={`물리 ${c.bm?.servers ?? '—'} · 가상화 ${c.virt?.servers ?? '—'}`}>
                    {c.all?.servers ?? '—'}<div className="muted" style={{ fontSize: 11 }}>{c.bm?.servers ?? '—'} / {c.virt?.servers ?? '—'}</div>
                  </td>
                  {[['all', 'cpu'], ['all', 'mem'], ['bm', 'cpu'], ['bm', 'mem'], ['virt', 'cpu'], ['virt', 'mem']].map(([role, k]) => {
                    const m = c[role]?.[k];
                    return (
                      <td key={role + k} className="right" data-sort={m?.pct ?? ''} title={k === 'cpu' ? coresText(m) : memText(m)}>
                        <Pct m={m} />
                        <div className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{k === 'cpu' ? coresText(m) : memText(m)}</div>
                      </td>
                    );
                  })}
                  <td style={{ fontSize: 11 }}>
                    <div style={{ color: isPartial(c.all) ? 'var(--amber)' : 'var(--text-dim)' }}>{coverageText(c.all)}</div>
                    {srcText(c.all) && <div className="muted">출처 {srcText(c.all)}</div>}
                    {!c.collectOn && c.bm?.servers > 0 && <div className="muted">물리 수집 꺼짐</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </STable>
        )}
      </div>

      <div className="muted" style={{ fontSize: 12, lineHeight: 1.7 }}>
        {footnotes(data).map((f, i) => <div key={i}>· <BoldText text={f} /></div>)}
      </div>
    </div>
  );
}
