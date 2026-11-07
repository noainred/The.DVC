/**
 * 함대 보기 ‘용량 예측’ + 서버 상세 요약 카드(리눅스 성능 8a단계 · 설계 PROFILES §20 ⑱ · 아트보드 Capacity).
 * ⚠ 예측은 서버(bmusage/capacity.js — 수집 노드의 하루 계산) — 여기는 그리기 · 거르기만(웹이 다시 판정하지 않는다).
 * ⚠ 데이터 부족 · 불안정 · 상한 없음 · 아직 계산 전 · 구버전 엣지는 0 이 아니라 그 표지로 그린다(‘예측 없음 = 안전’ 으로 보이지 않게).
 * ⚠ 조회는 보기를 고를 때 1회 + ‘다시 읽기’(폴링 없음) · 상세 카드는 그 서버를 열 때 1회.
 */
import React, { useMemo, useState } from 'react';
import { postJson, hasRole } from '../../api.js';
import Select from '../../components/Select.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { toneVar } from './toneVar.js';
import { unitText } from '../unitText.js';
import { OpsError, useOpsLoad } from './BmTuningTab.jsx';
import { KIND_TEXT, STATUS_TEXT, resText, pctText, slopeText, daysText, confText, noteText, summaryCards, sourceText, capChart, CAPACITY_HONEST } from './bmCapacityText.js';
import './bmOps.css';
import './bmMaint.css';

const KIND_ORDER = ['fs', 'inode', 'mem'];

export function CapacityFleetView({ resp, onOpen, onReload, loading = false, canRecompute = false }) {
  const [corp, setCorp] = useState('');
  const [kind, setKind] = useState('');
  const [st, setSt] = useState('');
  const [q, setQ] = useState('');
  const [re, setRe] = useState(null);
  const corps = useMemo(() => [...new Set((resp?.rows || []).map((r) => r.vcenterId).filter(Boolean))].sort(), [resp]);
  const rows = useMemo(() => (resp?.rows || []).filter((r) => (!corp || r.vcenterId === corp) && (!kind || r.kind === kind) && (!st || r.status === st)
    && (!q || String(r.name || '').toLowerCase().includes(q.toLowerCase()) || String(r.res || '').toLowerCase().includes(q.toLowerCase()))), [resp, corp, kind, st, q]);
  const cfg = resp?.cfg || {};
  const recompute = async () => {
    setRe({ busy: true });
    try { const r = await postJson('/tools/bm-usage/capacity/recompute', {}, { timeoutMs: 600_000 }); setRe({ ok: r?.ok !== false, text: r?.ok === false ? (r.reason || r.error || '실패') : `다시 계산했습니다(자원 ${r?.rows ?? '—'}행)` }); onReload?.(); }
    catch (e) { setRe({ ok: false, text: e?.message || '실패' }); }
  };
  return (
    <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      <div className="bmo-kpis">
        {summaryCards(resp?.summary || {}, cfg).map((c) => (
          <div key={c.k} className="bmo-kpi">
            <div className="bmo-k">{c.label}</div>
            <div className="bmo-kv" style={{ color: toneVar(c.value ? c.tone : 'idle') }}>{c.value == null ? '—' : `${c.value}대`}</div>
            <div className="bmo-sub">{c.sub}</div>
          </div>
        ))}
      </div>
      <div className="bmo-note">{(resp?.sources || []).map((s) => <div key={`${s.via}|${s.node}`} style={{ color: toneVar(s.old || s.unreadable ? 'warn' : 'idle') }}>{sourceText(s, resp?.minEdgeVersion, cfg)}</div>)}</div>
      {resp?.addressHidden && <p className="bmo-sub">관리자 판본이 아닙니다 — 주소인 서버 이름은 가림 토큰으로 보입니다.</p>}
      <section className="bmo-card">
        <h5 className="bmo-h">함대 표 — 목표선 {unitText(cfg.targetPct, '%')} 도달일 순(서버 · 자원 단위)</h5>
        <div className="bmo-bar">
          <Select sort={false} className="select select-sm" value={corp} onChange={(e) => setCorp(e.target.value)} aria-label="법인"><option value="">법인 전체</option>{corps.map((c) => <option key={c} value={c}>{c}</option>)}</Select>
          <Select sort={false} className="select select-sm" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="자원"><option value="">자원 전체</option>{KIND_ORDER.map((k) => <option key={k} value={k}>{KIND_TEXT[k]}</option>)}</Select>
          <Select sort={false} className="select select-sm" value={st} onChange={(e) => setSt(e.target.value)} aria-label="상태"><option value="">상태 전체</option>{Object.entries(STATUS_TEXT).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select>
          <input className="input bmc-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="서버 · 마운트" aria-label="서버 · 마운트 검색" />
          <button className="btn btn-sm" onClick={onReload} disabled={loading}>{loading ? '읽는 중…' : '다시 읽기'}</button>
          {canRecompute && <button className="btn btn-sm" onClick={recompute} disabled={re?.busy}>{re?.busy ? '계산 중…' : '이 노드 다시 계산'}</button>}
          <span className="bmo-sub">{rows.length} / {(resp?.rows || []).length}행</span>
          {re && !re.busy && <span className="bmo-sub" style={{ color: toneVar(re.ok ? 'ok' : 'bad') }}>{re.text}</span>}
        </div>
        <STable minWidth={1040} className="bmo-t" style={{ fontSize: 12 }} limit={500}>
          <thead><tr><th>서버</th><th>법인</th><th style={{ minWidth: 110 }}>자원</th><th className="right">현재</th><th className="right">하루 증가</th><th>{unitText(cfg.targetPct, '%')} 도달</th><th>100% 도달</th><th>신뢰</th><th>상태</th><th style={{ minWidth: 140 }}>메모</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.node}|${r.key}|${r.kind}|${r.res}|${i}`}>
                <td data-sort={r.name} style={{ whiteSpace: 'nowrap' }}><span className="bmp-link" role="button" tabIndex={0} onClick={() => onOpen?.(r.key)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen?.(r.key); }}>{r.name}</span></td>
                <td data-sort={r.vcenterId || ''}>{r.vcenterId || '—'}</td>
                <td data-sort={resText(r)} className="bmo-wrap">{resText(r)}<div className="bmo-sub">{KIND_TEXT[r.kind] || r.kind}</div></td>
                <td className="right" data-sort={r.current ?? ''}>{pctText(r.current)}</td>
                <td className="right" data-sort={slopeText(r) === '—' ? '' : r.slope}>{slopeText(r)}</td>
                <td className="bmo-wrap" data-sort={r.status === 'reached' ? 0 : (r.daysToTarget ?? '')} style={{ color: toneVar(r.status === 'reached' ? 'bad' : r.daysToTarget != null && r.daysToTarget <= (cfg.alertDays ?? 7) ? 'bad' : 'idle') }}>{daysText(r, 'target')}</td>
                <td className="bmo-wrap" data-sort={r.daysTo100 ?? ''}>{r.status === 'forecast' || r.status === 'reached' ? daysText(r, '100') : '—'}</td>
                <td data-sort={r.r2 ?? ''} style={{ whiteSpace: 'normal', wordBreak: 'keep-all', minWidth: 64 }}>{confText(r)}</td>
                <td data-sort={r.status} style={{ color: toneVar(STATUS_TEXT[r.status]?.tone || 'idle'), whiteSpace: 'normal', wordBreak: 'keep-all', minWidth: 72 }}>{STATUS_TEXT[r.status]?.label || r.status}</td>
                <td className="bmo-wrap" data-sort={noteText(r)}>{noteText(r) || '—'}</td>
              </tr>
            ))}
          </tbody>
        </STable>
        {!rows.length && <p className="bmo-note">표시할 행이 없습니다(OS 경로가 있는 서버만 · 하루 1회 계산 · 보는 범위 안 서버만).</p>}
        <p className="bmo-note"><BoldText text={'‘도달’ 은 이미 목표선 위 · **데이터 부족 · 불안정 · 상한 없음은 0일이 아니라 예측을 하지 않은 것**입니다 · 행을 누르면 서버 상세(요약 탭 카드에 추세 그림).'} /></p>
      </section>
      <p className="bmo-note"><BoldText text={CAPACITY_HONEST} /></p>
    </div>
  );
}

export default function BmCapacityFleet({ onOpen }) {
  const st = useOpsLoad(() => '/tools/bm-usage/capacity', 'fleet');
  return (
    <div className="card" style={{ minWidth: 0 }}>
      <OpsError err={st.err} />
      {!st.resp && !st.err && <p className="bmo-note">용량 소진 예측을 불러오는 중…</p>}
      {st.resp && <CapacityFleetView resp={st.resp} onOpen={onOpen} onReload={st.reload} loading={st.loading} canRecompute={hasRole('admin', 'operator')} />}
    </div>
  );
}

/** 상세 카드 그림 — 일 최대(실선) · 14일 맞춤선 연장(점선) · 목표선 · 오늘 · 정비 창 제외 날(회색 칸). */
export function CapacityChart({ series = [], fit = null, today = null, targetPct = 90, label = '' }) {
  const c = capChart(series, fit, { today, targetPct });
  if (!c.line) return <p className="bmo-note">그릴 일 값이 없습니다(0 으로 그리지 않습니다).</p>;
  return (
    <div className="bmc-chart">
      <svg viewBox="0 0 1000 100" preserveAspectRatio="none" role="img" aria-label={`${label} 추세`} style={{ width: '100%', height: 90 }}>
        <line x1="0" x2="1000" y1={c.target} y2={c.target} stroke="var(--amber)" strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
        {(c.exX || []).map((x, i) => <rect key={i} x={x - 4} y="0" width="8" height="100" fill="var(--text-faint)" opacity="0.18"><title>정비 창 날(추세에서 뺌)</title></rect>)}
        {c.xToday != null && <line x1={c.xToday} x2={c.xToday} y1="0" y2="100" stroke="var(--text-dim)" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />}
        <path d={c.line} fill="none" stroke="var(--accent-2)" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
        {c.fit && <path d={c.fit} fill="none" stroke="var(--red)" strokeWidth="1.2" strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="bmc-axis"><span>{c.days[0]}</span><span>목표 {targetPct}% · 실선 = 일 최대 · 점선 = 14일 추세 연장</span><span>{c.days[1]}</span></div>
    </div>
  );
}

/** 서버 상세 요약 탭 카드 — 자원별 예측 · 첫 예측 자원의 그림. */
export function BmCapacityCard({ itemKey }) {
  const st = useOpsLoad((k) => `/tools/bm-usage/capacity/${encodeURIComponent(k)}`, itemKey);
  const [sel, setSel] = useState(null);
  const d = st.resp;
  const rows = d?.rows || [];
  // 기본 그림 = 가장 급한 자원(도달 → 도달일 짧은 순) — 서버가 준 값으로 고르기만(다시 판정하지 않는다).
  const urgent = rows.filter((r) => r.status === 'reached' || r.status === 'forecast').sort((a, b) => (a.status === 'reached' ? -1 : 0) - (b.status === 'reached' ? -1 : 0) || (a.daysToTarget ?? 1e9) - (b.daysToTarget ?? 1e9))[0];
  const pick = sel || urgent || rows[0] || null;
  const sk = pick ? (pick.kind === 'mem' ? 'mem' : `${pick.kind}:${pick.res}`) : null;
  return (
    <section className="bmo-card">
      <h5 className="bmo-h">용량 소진 예측(참고)</h5>
      <OpsError err={st.err} />
      {!d && !st.err && <p className="bmo-note">용량 예측을 읽는 중…</p>}
      {d && d.ok === false && <p className="bmo-note" style={{ color: toneVar('warn') }}>{d.reason || '용량 예측을 읽지 못했습니다'}</p>}
      {d && d.ok !== false && !rows.length && <p className="bmo-note">자원 행이 없습니다(OS 경로 · 등록 마운트가 있어야 쌓입니다).</p>}
      {!!rows.length && (
        <>
          <STable minWidth={640} className="bmo-t" style={{ fontSize: 12 }}>
            <thead><tr><th>자원</th><th className="right">현재</th><th className="right">하루 증가</th><th>목표 도달</th><th>신뢰</th><th>상태</th></tr></thead>
            <tbody>{rows.map((r, i) => (
              <tr key={`${r.kind}|${r.res}|${i}`} className={pick === r ? 'bmc-sel' : ''} onClick={() => setSel(r)} style={{ cursor: 'pointer' }}>
                <td data-sort={resText(r)} className="bmo-wrap">{resText(r)}</td>
                <td className="right" data-sort={r.current ?? ''}>{pctText(r.current)}</td>
                <td className="right" data-sort={slopeText(r) === '—' ? '' : r.slope}>{slopeText(r)}</td>
                <td data-sort={r.daysToTarget ?? ''}>{daysText(r, 'target')}</td>
                <td data-sort={r.r2 ?? ''}>{confText(r)}</td>
                <td data-sort={r.status} style={{ color: toneVar(STATUS_TEXT[r.status]?.tone || 'idle') }}>{STATUS_TEXT[r.status]?.label || r.status}</td>
              </tr>))}</tbody>
          </STable>
          {pick && <>
            <p className="bmo-sub" style={{ margin: '6px 0 2px' }}>{resText(pick)} — {noteText(pick) || '최근 30일 일 최대'}</p>
            <CapacityChart series={d.series?.[sk] || []} fit={d.fits?.[sk] || null} today={d.today} targetPct={pick.targetPct ?? 90} label={resText(pick)} />
          </>}
        </>
      )}
    </section>
  );
}
