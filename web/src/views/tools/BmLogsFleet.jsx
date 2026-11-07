/**
 * 함대 보기 ‘로그 분석’(리눅스 성능 7a단계 · 설계 §17 ‘보드 KPI + 함대 표’) — KPI 4 → 공통 원인 후보 → 서버 표(법인 · 분류 · 규칙 필터).
 * ⚠ 판정(공통 원인 후보 · 분류)은 서버 — 그리기 · 거르기만. 조회는 보기를 고를 때 1회 + ‘다시 읽기’(폴링 없음).
 */
import React, { useMemo, useState } from 'react';
import Select from '../../components/Select.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { toneVar } from './toneVar.js';
import { OpsError, useOpsLoad } from './BmTuningTab.jsx';
import { CLASS_ORDER, CLASS_TEXT, SEV_TEXT, fleetKpiCards, nodeNotes, fleetFilter, topRuleText, fleetClsCell, commonHonest, numText, stamp, STATUS_TEXT, SRC_LABEL } from './bmLogsText.js';
import './bmOps.css';
import './bmLogs.css';

export function LogsFleetView({ resp, onOpen, onReload, loading = false }) {
  const [corp, setCorp] = useState('');
  const [cls, setCls] = useState('');
  const [rule, setRule] = useState('');
  const [q, setQ] = useState('');
  const rows = useMemo(() => fleetFilter(resp?.servers || [], { corp, cls, rule, q }), [resp, corp, cls, rule, q]);
  const corps = useMemo(() => [...new Set((resp?.servers || []).map((r) => r.vcenterId).filter(Boolean))].sort(), [resp]);
  const rules = useMemo(() => [...new Set((resp?.servers || []).flatMap((r) => (r.top || []).map((p) => p.ruleId)).filter(Boolean))].sort(), [resp]);
  const notes = nodeNotes(resp?.nodes, resp?.nodesOmitted);
  return (
    <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      <div className="bml-kpis">
        {fleetKpiCards(resp).map((c) => (
          <div key={c.key} className="bmo-kpi">
            <div className="bmo-k">{c.label}</div>
            <div className="bmo-kv" style={{ color: toneVar(c.tone) }}>{c.value}</div>
            <div className="bmo-sub">{c.sub}</div>
          </div>
        ))}
      </div>
      {notes.map((x, i) => <p key={i} className="bmo-note" style={{ color: toneVar('warn') }}>{x}</p>)}
      {resp?.addressHidden && <p className="bmo-sub">관리자 판본이 아닙니다 — 주소인 서버 이름은 가림 토큰, 보안 분류 표본은 비웁니다.</p>}
      <section className="bmo-card">
        <h5 className="bmo-h">공통 원인 후보 — 같은 규칙이 여러 서버에서 같은 시간대</h5>
        {(resp?.common || []).length ? (
          <STable minWidth={640} className="bmo-t" style={{ fontSize: 12 }}>
            <thead><tr><th>규칙</th><th>분류 · 심각</th><th className="right">서버 수</th><th>시간대</th><th>서버</th></tr></thead>
            <tbody>
              {resp.common.map((c) => (
                <tr key={c.ruleId}>
                  <td data-sort={c.ruleId} className="bmo-mono">{c.ruleId}</td>
                  <td data-sort={SEV_TEXT[c.severity]?.rank ?? 0}><span style={{ color: CLASS_TEXT[c.cls]?.color }}>{CLASS_TEXT[c.cls]?.label || c.cls}</span> · <span style={{ color: toneVar(SEV_TEXT[c.severity]?.tone) }}>{c.severity}</span></td>
                  <td className="right" data-sort={c.count}>{numText(c.count)}</td>
                  <td data-sort={c.to}>{stamp(c.from)} ~ {stamp(c.to, { date: false })}</td>
                  <td className="bmo-wrap" data-sort={c.servers?.[0]?.name || ''}>
                    {(c.servers || []).slice(0, 12).map((s) => <button key={`${s.agent}|${s.key}`} type="button" className="bml-corr" onClick={() => onOpen?.(s.key)}>{s.name}</button>)}
                    {(c.servers || []).length > 12 && <span className="bmo-sub"> 외 {c.servers.length - 12}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </STable>
        ) : <p className="bmo-note">지금은 후보가 없습니다.</p>}
        <p className="bmo-note">{commonHonest(resp?.commonWindowMs)}</p>
      </section>
      <section className="bmo-card">
        <h5 className="bmo-h">서버별 — 24시간 · 분류별 패턴/줄 · 상위 규칙</h5>
        <div className="bmo-bar">
          <Select sort={false} className="select select-sm" value={corp} onChange={(e) => setCorp(e.target.value)} aria-label="법인"><option value="">법인 전체</option>{corps.map((c) => <option key={c} value={c}>{c}</option>)}</Select>
          <Select sort={false} className="select select-sm" value={cls} onChange={(e) => setCls(e.target.value)} aria-label="분류"><option value="">분류 전체</option>{CLASS_ORDER.map((c) => <option key={c} value={c}>{CLASS_TEXT[c].label}</option>)}</Select>
          <Select sort={false} className="select select-sm" value={rule} onChange={(e) => setRule(e.target.value)} aria-label="규칙"><option value="">규칙 전체</option>{rules.map((r) => <option key={r} value={r}>{r}</option>)}</Select>
          <input className="input bml-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="서버 이름" aria-label="서버 이름 검색" />
          <button className="btn btn-sm bmp-touch" onClick={onReload} disabled={loading}>{loading ? '읽는 중…' : '다시 읽기'}</button>
          <span className="bmo-sub">{numText(rows.length)} / {numText(resp?.servers?.length)}대</span>
        </div>
        <STable minWidth={980} className="bmo-t" style={{ fontSize: 12 }} limit={500}>
          <thead><tr><th>서버</th><th>법인</th>{CLASS_ORDER.map((c) => <th key={c} className="right">{CLASS_TEXT[c].label}</th>)}<th className="right">분류 안 됨</th><th>상위 규칙</th><th>출처 상태</th><th>수집 노드</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.agent}|${r.key}`}>
                <td data-sort={r.name}><span className="bmp-link" role="button" tabIndex={0} onClick={() => onOpen?.(r.key)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen?.(r.key); }}>{r.name}</span></td>
                <td data-sort={r.vcenterId || ''}>{r.vcenterId || '—'}</td>
                {CLASS_ORDER.map((c) => {
                  const cell = fleetClsCell(r, c);
                  return (
                    <td key={c} className="right" data-sort={cell.text === '—' ? '' : r.cls?.[c]?.lines ?? ''} title={cell.title || undefined}>
                      {cell.text === '—' ? '—' : <><span style={{ color: (r.cls?.[c]?.lines || 0) > 0 ? CLASS_TEXT[c].color : 'var(--muted)' }}>{cell.text}</span><div className="bmo-sub">{cell.sub}</div></>}
                    </td>
                  );
                })}
                <td className="right" data-sort={r.none ?? ''}>{r.wasRead ? numText(r.none) : '—'}</td>
                <td className="bmo-wrap bmo-mono" data-sort={r.top?.[0]?.ruleId || ''}>{topRuleText(r.top)}</td>
                <td className="bmo-wrap" data-sort={Object.values(r.status?.sources || {}).filter((x) => x === 'perm').length}>
                  {Object.entries(r.status?.sources || {}).filter(([, v]) => v && v !== 'ok' && v !== 'absent').map(([s, v]) => `${SRC_LABEL[s] || s} ${STATUS_TEXT[v]?.label || v}`).join(' · ') || (r.status ? '읽음' : '—')}
                </td>
                <td data-sort={r.agent || ''}>{r.via === 'edge' ? `엣지 ${r.agent}` : '이 노드'}{r.at && <div className="bmo-sub">{stamp(r.at)}</div>}</td>
              </tr>
            ))}
          </tbody>
        </STable>
        {!rows.length && <p className="bmo-note">표시할 서버가 없습니다(로그를 읽은 서버 · 보는 범위 안 서버만).</p>}
        <p className="bmo-note"><BoldText text="칸 = **패턴 수**(아래 작은 글씨는 줄 수) · ‘—’ 는 그 서버의 로그를 24시간 안에 읽지 못한 것이고 0 이 아닙니다. 서버를 누르면 상세 ‘로그’ 탭이 열립니다." /></p>
      </section>
    </div>
  );
}

export default function BmLogsFleet({ onOpen }) {
  const st = useOpsLoad(() => '/tools/bm-usage/logs', 'fleet');
  return (
    <div className="card" style={{ minWidth: 0 }}>
      <OpsError err={st.err} />
      {!st.resp && !st.err && <p className="bmo-note">로그 분석 함대 요약을 불러오는 중…</p>}
      {st.resp && <LogsFleetView resp={st.resp} onOpen={onOpen} onReload={st.reload} loading={st.loading} />}
    </div>
  );
}
