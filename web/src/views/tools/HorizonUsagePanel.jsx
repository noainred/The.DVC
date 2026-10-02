/**
 * views/tools/HorizonUsagePanel.jsx — Horizon **앱·데스크톱별 사용 현황**(v2.684).
 *
 * 사용자 요청(2026-10-02): "어떤 사용자가 어떤 서비스를 사용하는지 실시간·누적 집계" → 1단계(커넥션 서버 API).
 * '현재 사용자 › Horizon(VDI)' 탭 안의 한 구획이다(셸을 더 만들지 않는다).
 *
 *  · **폴링하지 않는다** — 마운트 1회 + 기간 칩 + 새로고침 버튼(누적 조회는 행 수에 비례하는 집계다).
 *  · 판정·문구는 `horizonUsageText.js`(순수, vitest 고정). 이 파일은 조립만 한다.
 *  · 계정명 가림은 상위 패널의 선택(`canShowNames`)을 그대로 따른다 — 두 곳이 다른 정책을 쓰지 않게.
 * ⚠ 훅은 전부 조기 return 위에(React #310).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { fetchJson, downloadFile, canCsv } from '../../api.js';
import { ErrorBox, Loading } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { Card } from './shared.jsx';
import {
  USAGE_DAYS, daysLabel, lowerBoundNote, basisSummary, catalogNotes, nowText, NOW_SUM_NOTE, dayCell,
  coverageNote, omittedNote, emptyNote, kindText, basisText, usageCsvPath,
} from './horizonUsageText.js';

const tsText = (ts) => (ts ? new Date(ts).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

export default function HorizonUsagePanel({ serverId = '', serverName = '', canShowNames = false }) {
  const [days, setDays] = useState(7);
  const [rep, setRep] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [dlErr, setDlErr] = useState('');
  const seq = useRef(0);

  const load = useCallback(async (d = days, sid = serverId) => {
    const my = ++seq.current;            // 늦게 온 이전 응답은 버린다(v2.596 WS 규약)
    setLoading(true); setErr('');
    try {
      const r = await fetchJson('/tools/horizon-sessions/usage', { days: String(d), ...(sid ? { serverId: sid } : {}) });
      if (my === seq.current) setRep(r);
    } catch (e) { if (my === seq.current) setErr(e); }
    finally { if (my === seq.current) setLoading(false); }
  }, [days, serverId]);

  useEffect(() => { load(days, serverId); }, [serverId]); // eslint-disable-line react-hooks/exhaustive-deps

  const basis = useMemo(() => basisSummary(rep?.serverMeta), [rep]);
  const catNotes = useMemo(() => catalogNotes(rep?.serverMeta), [rep]);
  const users = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = rep?.users || [];
    if (!needle) return list;
    // 계정명이 가려져 있으면 계정명으로 걸러 이름을 알아내지 못하게 서비스 이름만 본다.
    return list.filter((u) => (canShowNames && String(u.name).toLowerCase().includes(needle)) || u.services.some((s) => String(s.name).toLowerCase().includes(needle)));
  }, [rep, q, canShowNames]);
  const services = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = rep?.services || [];
    return needle ? list.filter((s) => String(s.name).toLowerCase().includes(needle)) : list;
  }, [rep, q]);
  const chart = useMemo(() => (rep?.daily || []).map((d) => ({ ...d, label: d.day.slice(5) })), [rep]);
  const anySum = useMemo(() => (rep?.services || []).some((s) => s.nowBySum), [rep]);
  const maxDays = Number(rep?.maxDays) || 92;

  const t = rep?.totals || {};
  const empty = emptyNote(rep);
  const cov = coverageNote(rep);
  const omitted = omittedNote(rep);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10, minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ fontWeight: 700 }}>앱·데스크톱별 사용 현황 {serverName ? `— ${serverName}` : '— 전체'}</div>
        {USAGE_DAYS.filter((d) => d <= maxDays).map((d) => (
          <button key={d} className="tab" style={{ padding: '2px 9px', fontSize: 11, opacity: d === days ? 1 : 0.6 }}
            onClick={() => { setDays(d); load(d, serverId); }}>{daysLabel(d)}</button>
        ))}
        <button className="tab" style={{ padding: '2px 9px', fontSize: 11 }} onClick={() => load(days, serverId)} disabled={loading}>{loading ? '불러오는 중…' : '새로고침'}</button>
        {canCsv() && (
          <button className="tab" style={{ padding: '2px 9px', fontSize: 11 }}
            onClick={() => { setDlErr(''); downloadFile(usageCsvPath(days, serverId)).catch((e) => setDlErr(e?.message || String(e))); }}>⬇ CSV(사용자×서비스)</button>
        )}
        {rep?.fromDay && <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{rep.fromDay === rep.toDay ? rep.fromDay : `${rep.fromDay} ~ ${rep.toDay}`}</span>}
      </div>
      {dlErr && <ErrorBox error={dlErr} inline />}
      {err && <ErrorBox error={err} inline />}
      {!rep && loading && <Loading />}

      {rep && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
            <Card label={`${daysLabel(days)} 고유 사용자`} value={`${t.users ?? '—'}${t.users == null ? '' : '명'}`} meta="한 번이라도 관측된 계정(하한)" accent="var(--accent)" />
            <Card label="사용된 서비스" value={`${t.services ?? '—'}${t.services == null ? '' : '개'}`} meta="앱·데스크톱·팜" />
            <Card label="일평균 사용자" value={t.avgDailyUsers == null ? '—' : `${t.avgDailyUsers}명`} meta="수집이 있던 지나간 날 기준" />
            <Card label="최대 하루 사용자" value={t.peakDailyUsers == null ? '—' : `${t.peakDailyUsers}명`} meta={t.daysNoData ? `수집 없음 ${t.daysNoData}일` : '기간 중 최대'} />
          </div>

          <div style={{ fontSize: 11.5, color: 'var(--text-faint)', whiteSpace: 'normal', lineHeight: 1.55 }}>
            <BoldText text={lowerBoundNote(rep.intervalMs)} />
            {cov && <><br /><BoldText text={cov} /></>}
            {basis?.text && <><br />{basis.text}</>}
            {basis?.farmNote && <><br /><BoldText text={basis.farmNote} /></>}
            {catNotes.map((n) => <React.Fragment key={n}><br />{n}</React.Fragment>)}
          </div>
          {empty && <div style={{ fontSize: 12, color: 'var(--text-dim)', whiteSpace: 'normal' }}>{empty}</div>}

          {chart.length > 1 && (
            <div style={{ height: 200 }}>
              <ResponsiveContainer>
                <BarChart data={chart}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                  <Tooltip formatter={(v, n, p) => [dayCell(p?.payload), '하루 고유 사용자']} labelFormatter={(l, p) => p?.[0]?.payload?.day || l} />
                  <Bar dataKey="users" name="하루 고유 사용자" fill="#0ea5e9" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <input className="input" style={{ maxWidth: 280 }} value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={canShowNames ? '서비스·계정 검색' : '서비스 검색'} />

          <div>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>서비스별 {services.length}개</div>
            <div className="table-wrap" style={{ maxHeight: '40vh' }}>
            <STable className="v3-table" minWidth={820} wrap={false} limit={500}>
              <thead>
                <tr><th>서비스</th><th>종류</th><th>지금 접속 중</th><th>{daysLabel(days)} 고유 사용자</th><th>사용자·일</th><th>마지막 관측</th><th>이름을 안 근거</th></tr>
              </thead>
              <tbody>
                {services.map((s) => (
                  <tr key={s.key}>
                    <td><b>{s.name}</b></td>
                    <td>{kindText(s.kind)}</td>
                    <td data-sort={s.connectedUsersNow ?? ''}>{nowText(s, rep.nowServers)}</td>
                    <td data-sort={s.users}>{s.users}</td>
                    <td data-sort={s.userDays}>{s.userDays}</td>
                    <td data-sort={s.lastTs ?? ''}>{tsText(s.lastTs)}</td>
                    <td style={{ fontSize: 11.5, color: s.kind === 'farm' ? 'var(--amber)' : 'var(--text-dim)', whiteSpace: 'normal' }}>{basisText(s.basis)}</td>
                  </tr>
                ))}
                {!services.length && <tr><td colSpan={7} style={{ color: 'var(--text-faint)' }}>표시할 서비스가 없습니다.</td></tr>}
              </tbody>
            </STable>
            </div>
            {anySum && <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 4, whiteSpace: 'normal' }}>{NOW_SUM_NOTE}</div>}
          </div>

          <div>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>사용자별 {users.length}명</div>
            <div className="table-wrap" style={{ maxHeight: '45vh' }}>
            <STable className="v3-table" minWidth={720} wrap={false} limit={1000}>
              <thead><tr><th>계정</th><th>사용 일수</th><th>서비스 수</th><th data-nosort>사용한 서비스(일수)</th><th>마지막 관측</th></tr></thead>
              <tbody>
                {users.map((u, i) => (
                  <tr key={u.key}>
                    <td>{canShowNames ? u.name : <span style={{ color: 'var(--text-faint)' }}>{`사용자 #${i + 1}`}</span>}</td>
                    <td data-sort={u.days ?? ''}>{u.days ?? '—'}</td>
                    <td data-sort={u.services.length}>{u.services.length}</td>
                    <td style={{ fontSize: 11.5, color: 'var(--text-dim)', whiteSpace: 'normal' }}>{u.services.slice(0, 12).map((s) => `${s.name}(${s.days})`).join(', ')}{u.services.length > 12 ? ` 외 ${u.services.length - 12}개` : ''}</td>
                    <td data-sort={u.lastTs ?? ''}>{tsText(u.lastTs)}</td>
                  </tr>
                ))}
                {!users.length && <tr><td colSpan={5} style={{ color: 'var(--text-faint)' }}>표시할 사용자가 없습니다.</td></tr>}
              </tbody>
            </STable>
            </div>
            {users.length > 1000 && <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>표에는 1000명까지만 표시했습니다(전체 {users.length}명).</div>}
            {omitted && <div style={{ fontSize: 11.5, color: 'var(--text-faint)', whiteSpace: 'normal' }}>{omitted}</div>}
          </div>
        </>
      )}
    </div>
  );
}
