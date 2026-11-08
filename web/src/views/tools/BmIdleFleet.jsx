/**
 * 함대 보기 ‘저활용 서버’(리눅스 성능 8b단계 ㉑ · 설계 PROFILES §20 · 아트보드 Idle).
 * ⚠ 점수 · 상태는 서버(bmusage/idle.js — 수집 노드의 하루 계산) — 여기는 그리기 · 거르기 · 검토 상태 쓰기만(웹이 다시 판정하지 않는다).
 * ⚠ 조회는 보기를 고를 때 1회 + ‘다시 읽기’(폴링 없음). 검토 상태 저장 뒤 다시 읽는다.
 */
import React, { useMemo, useState } from 'react';
import { postJson, hasRole } from '../../api.js';
import Select from '../../components/Select.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { toneVar } from './toneVar.js';
import { unitText } from '../unitText.js';
import { OpsError, useOpsLoad } from './BmTuningTab.jsx';
import { STATUS_TEXT, REVIEW_OPTIONS, REVIEW_TEXT, cpuPairText, powerText, actText, statusText, droppedText, reviewText, idleCards, candPowerText, monthText, sourceText, ruleRows, IDLE_HONEST } from './bmIdleText.js';
import './bmOps.css';
import './bmMaint.css';

function ReviewEditor({ row, onDone }) {
  const [st, setSt] = useState(row.review?.status && row.review.status !== 'clear' ? row.review.status : 'review');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(null);
  const save = async () => {
    setBusy({ busy: true });
    try {
      const r = await postJson('/tools/bm-usage/idle/review', { key: row.key, status: st, reason }, { timeoutMs: 60_000 });
      if (r?.ok === false) { setBusy({ err: r.reason || '저장하지 못했습니다' }); return; }
      setBusy(null); onDone?.(true);
    } catch (e) { setBusy({ err: e?.message || '저장하지 못했습니다' }); }
  };
  return (
    <div className="bmi-edit">
      <Select sort={false} className="select select-sm" value={st} onChange={(e) => setSt(e.target.value)} aria-label="검토 상태">
        {REVIEW_OPTIONS.map((k) => <option key={k} value={k}>{REVIEW_TEXT[k]}</option>)}
      </Select>
      <input className="input bmi-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder={st === 'keep' ? '유지 사유(필수)' : '사유(선택)'} aria-label="사유" />
      <button type="button" className="btn btn-sm" disabled={busy?.busy || (st === 'keep' && !reason.trim())} onClick={save}>{busy?.busy ? '저장 중…' : '저장(주석 · 감사)'}</button>
      <button type="button" className="btn btn-sm" onClick={() => onDone?.(false)}>취소</button>
      {busy?.err && <span className="bmo-sub" style={{ color: toneVar('bad') }}>{busy.err}</span>}
    </div>
  );
}

export function IdleFleetView({ resp, onOpen, onCompare, onReload, loading = false, canWrite = false, canRecompute = false }) {
  const [corp, setCorp] = useState('');
  const [st, setSt] = useState('');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(() => new Set());
  const [editing, setEditing] = useState('');
  const [re, setRe] = useState(null);
  const all = useMemo(() => resp?.rows || [], [resp]);
  const corps = useMemo(() => [...new Set(all.map((r) => r.vcenterId).filter(Boolean))].sort(), [all]);
  const rows = useMemo(() => all.filter((r) => (!corp || r.vcenterId === corp) && (!st || r.status === st) && (!q || String(r.name || '').toLowerCase().includes(q.toLowerCase()))), [all, corp, st, q]);
  const sum = resp?.summary || {};
  const cfg = resp?.cfg || {};
  const cp = candPowerText(sum); const mo = monthText(sum);
  const toggle = (k) => setSel((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else if (n.size < 5) n.add(k); return n; });
  const recompute = async () => {
    setRe({ busy: true });
    try { const r = await postJson('/tools/bm-usage/idle/recompute', {}, { timeoutMs: 600_000 }); setRe({ ok: r?.ok !== false, text: r?.ok === false ? (r.reason || r.error || '실패') : `다시 계산했습니다(서버 ${unitText(r?.rows, '대')})` }); onReload?.(); }
    catch (e) { setRe({ ok: false, text: e?.message || '실패' }); }
  };
  return (
    <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      <div className="bmo-kpis">
        {idleCards(sum).map((c) => (
          <div key={c.k} className="bmo-kpi">
            <div className="bmo-k">{c.label}</div>
            <div className="bmo-kv" style={{ color: toneVar(c.value ? c.tone : 'idle') }}>{c.value == null ? '—' : `${c.value}대`}</div>
            <div className="bmo-sub">{c.sub}</div>
          </div>
        ))}
        <div className="bmo-kpi"><div className="bmo-k">후보의 측정 전력 합</div><div className="bmo-kv">{cp.value}</div><div className="bmo-sub">{cp.sub}</div></div>
        <div className="bmo-kpi"><div className="bmo-k">검토 상태(후보 중)</div><div className="bmo-kv">{sum.candidate ? `${sum.reviewed ?? 0} / ${sum.candidate}` : '—'}</div><div className="bmo-sub">검토 중 {sum.review?.review ?? 0} · 반납 예정 {sum.review?.retire ?? 0} · 유지 {sum.review?.keep ?? 0} — 주석에 저장 · 감사</div></div>
        <div className="bmo-kpi"><div className="bmo-k">지난 30일</div><div className="bmo-kv">{mo.value}</div><div className="bmo-sub">{mo.sub}</div></div>
      </div>
      <div className="bmo-note">{(resp?.sources || []).map((s) => <div key={`${s.via}|${s.node}`} style={{ color: toneVar(s.old || s.unreadable ? 'warn' : 'idle') }}>{sourceText(s, resp?.minEdgeVersion)}</div>)}</div>
      {resp?.reviewUnreadable && <p className="bmo-note" style={{ color: toneVar('warn') }}>운영 주석 파일을 읽지 못해 검토 상태를 보이지 못했습니다(‘검토 없음’ 이 아닙니다).</p>}
      {resp?.addressHidden && <p className="bmo-sub">관리자 판본이 아닙니다 — 주소인 서버 이름 · 검토한 사람은 가림 토큰으로 보입니다.</p>}
      <section className="bmo-card">
        <h5 className="bmo-h">후보 표 — 점수 순(서버 단위 · 창 {unitText(cfg.windowDays, '일')})</h5>
        <div className="bmo-bar">
          <Select sort={false} className="select select-sm" value={corp} onChange={(e) => setCorp(e.target.value)} aria-label="법인"><option value="">법인 전체</option>{corps.map((c) => <option key={c} value={c}>{c}</option>)}</Select>
          <Select sort={false} className="select select-sm" value={st} onChange={(e) => setSt(e.target.value)} aria-label="상태"><option value="">상태 전체</option>{Object.entries(STATUS_TEXT).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select>
          <input className="input bmc-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="서버" aria-label="서버 검색" />
          <button className="btn btn-sm" onClick={onReload} disabled={loading}>{loading ? '읽는 중…' : '다시 읽기'}</button>
          <button className="btn btn-sm" disabled={sel.size < 2} onClick={() => onCompare?.([...sel])}>비교로 보내기({sel.size}/5)</button>
          {canRecompute && <button className="btn btn-sm" onClick={recompute} disabled={re?.busy}>{re?.busy ? '계산 중…' : '이 노드 다시 계산'}</button>}
          <span className="bmo-sub">{rows.length} / {all.length}대</span>
          {re && !re.busy && <span className="bmo-sub" style={{ color: toneVar(re.ok ? 'ok' : 'bad') }}>{re.text}</span>}
        </div>
        <STable minWidth={1040} className="bmo-t" style={{ fontSize: 12 }} limit={500}>
          <thead><tr><th data-nosort="1">선택</th><th>서버</th><th>법인</th><th className="right">점수</th><th>상태</th><th className="right">CPU 평균/최대</th><th className="right">메모리</th><th className="right">디스크</th><th className="right">네트</th><th className="right">전력 W</th><th style={{ minWidth: 90 }}>활동</th><th style={{ minWidth: 120 }}>검토</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <React.Fragment key={`${r.node}|${r.vcenterId}|${r.key}`}>
                <tr>
                  <td data-nosort="1"><input type="checkbox" checked={sel.has(r.key)} onChange={() => toggle(r.key)} aria-label={`${r.name} 선택`} /></td>
                  <td data-sort={r.name} style={{ whiteSpace: 'nowrap' }}><span className="bmp-link" role="button" tabIndex={0} onClick={() => onOpen?.(r.key)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen?.(r.key); }}>{r.name}</span>{droppedText(r) && <div className="bmo-sub">{droppedText(r)}</div>}</td>
                  <td data-sort={r.vcenterId || ''}>{r.vcenterId || '—'}</td>
                  <td className="right" data-sort={r.score ?? ''} style={{ fontWeight: 600 }}>{r.score ?? '—'}</td>
                  <td data-sort={r.status} className="bmo-wrap" style={{ color: toneVar(STATUS_TEXT[r.status]?.tone || 'idle'), wordBreak: 'keep-all', minWidth: 56 }}>{statusText(r)}</td>
                  <td className="right" data-sort={r.metrics?.cpuAvg ?? ''}>{cpuPairText(r.metrics)}</td>
                  <td className="right" data-sort={r.metrics?.memAvg ?? ''}>{unitText(r.metrics?.memAvg, '%')}</td>
                  <td className="right" data-sort={r.metrics?.diskMax ?? ''}>{unitText(r.metrics?.diskMax, '%')}</td>
                  <td className="right" data-sort={r.metrics?.netMax ?? ''}>{unitText(r.metrics?.netMax, '%')}</td>
                  <td className="right" data-sort={r.metrics?.powerAvgW ?? ''}>{powerText(r.metrics)}</td>
                  <td className="bmo-wrap" data-sort={actText(r.metrics)}>{actText(r.metrics)}</td>
                  <td className="bmo-wrap" data-sort={reviewText(r.review)}>
                    {reviewText(r.review)}{r.review?.reason && <div className="bmo-sub">{r.review.reason}</div>}
                    {canWrite && editing !== r.key && <div><button type="button" className="btn btn-sm" onClick={() => setEditing(r.key)}>검토 상태…</button></div>}
                  </td>
                </tr>
                {editing === r.key && <tr><td colSpan={12}><ReviewEditor row={r} onDone={(ok) => { setEditing(''); if (ok) onReload?.(); }} /></td></tr>}
              </React.Fragment>
            ))}
          </tbody>
        </STable>
        {!rows.length && <p className="bmo-note">표시할 서버가 없습니다(하루 1회 계산 · 보는 범위 안 서버만).</p>}
        <p className="bmo-note">행 선택 → ‘비교로 보내기’(2~5대) · 검토 상태는 운영 주석으로 저장됩니다(누가 · 언제 · 사유 · 감사) · 서버 이름을 누르면 상세.</p>
      </section>
      <section className="bmo-card">
        <h5 className="bmo-h">점수 규칙 — 0~100(설정값 · 노드마다)</h5>
        <STable minWidth={760} className="bmo-t" style={{ fontSize: 12 }}>
          <thead><tr><th>지표</th><th>창</th><th>‘낮다’ 기준</th><th className="right">가중</th><th>출처</th></tr></thead>
          <tbody>{ruleRows(cfg).map((x) => <tr key={x.m}><td data-sort={x.m}>{x.m}</td><td data-sort={x.win} className="bmo-wrap">{x.win}</td><td data-sort={x.th} className="bmo-wrap">{x.th}</td><td className="right" data-sort={x.w ?? ''}>{x.w ?? '—'}</td><td data-sort={x.src} className="bmo-wrap">{x.src}</td></tr>)}</tbody>
        </STable>
        <p className="bmo-note">기준마다 ‘낮다’ 면 가중치 전부 · 2배 안이면 절반 · 넘으면 0. ≥{cfg.candidate ?? '—'} 후보 · {cfg.watch ?? '—'}~{(cfg.candidate ?? 1) - 1} 관찰 · 그 아래 사용 중 · 데이터 {unitText(cfg.minDays, '일')} 미만 · 정비 창 중은 제외(수를 적습니다).</p>
      </section>
      {IDLE_HONEST.map((x, i) => <p key={i} className="bmo-note"><BoldText text={x} /></p>)}
    </div>
  );
}

export default function BmIdleFleet({ onOpen, onCompare }) {
  const st = useOpsLoad(() => '/tools/bm-usage/idle', 'fleet');
  return (
    <div className="card" style={{ minWidth: 0 }}>
      <OpsError err={st.err} />
      {!st.resp && !st.err && <p className="bmo-note">저활용 서버를 불러오는 중…</p>}
      {st.resp && <IdleFleetView resp={st.resp} onOpen={onOpen} onCompare={onCompare} onReload={st.reload} loading={st.loading} canWrite={hasRole('admin', 'operator')} canRecompute={hasRole('admin', 'operator')} />}
    </div>
  );
}
