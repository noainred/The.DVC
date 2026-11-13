// IpamScanSchedule.jsx — IP 관리 › 스캔 › '주기 스캔 일정'(v3.7.0 재설계 묶음 라 — 시안 ⑭ ScanSchedule.dc.html).
// 에이전트마다 오늘(포탈 날짜) 24시간 시간표 — 끝남 · 실패 · 건너뜀 · 스캔 중, 다음 예정(어림) · 늦음 · 걸린 시간 > 주기 안내.
// 판정은 서버(GET /admin/ipam/scan/schedule — ipam/scanSchedule.js). 주기 · 시한 숫자는 응답 값으로만 그린다. 폴링하지 않는다(열 때 1회 + 새로고침).
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { agentLabel, fmtDt } from './ipamShared.jsx';
import { RUN_KIND, SCHED_STATE, durText, hhmm, intervalText } from './scanScheduleText.js';

function DayBar({ runs, nowMin }) {
  return (
    <div className="ipam-day" role="img" aria-label={`오늘 스캔 ${runs.length}건`}>
      {[6, 12, 18].map((h) => <span key={h} className="ipam-day-tick" style={{ left: `${(h / 24) * 100}%` }} />)}
      {runs.map((r, i) => (
        <span key={i} className={`ipam-day-run ${r.kind}`} title={`${RUN_KIND[r.kind] || r.kind} ${hhmm(r.fromMin)}${r.kind === 'done' && r.durationMs != null ? ` · ${durText(r.durationMs)}` : ''}${r.count > 1 ? ` · ${r.count}회` : ''}${r.message ? ` · ${r.message}` : ''}`}
          style={{ left: `${(r.fromMin / 1440) * 100}%`, width: `${Math.max(0.35, ((r.toMin - r.fromMin) / 1440) * 100)}%` }} />
      ))}
      <span className="ipam-day-now" style={{ left: `${(nowMin / 1440) * 100}%` }} title={`지금 ${hhmm(nowMin)}`} />
    </div>
  );
}

export function IpamScanSchedule({ onEdit }) {
  const [d, setD] = useState(undefined);
  const [err, setErr] = useState(null);
  const [nonce, setNonce] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current;
    setErr(null);
    fetchJson('/admin/ipam/scan/schedule').then((r) => { if (my === seq.current) setD(r); }).catch((e) => { if (my === seq.current) setErr(e); });
  }, [nonce]);
  const rows = d?.rows || [];
  return (
    <section className="card" style={{ padding: 14, minWidth: 0 }} aria-label="주기 스캔 일정">
      <div className="flex between" style={{ alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <div style={{ minWidth: 0 }}>
          <b style={{ fontSize: 15 }}>주기 스캔 일정</b>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>에이전트마다 오늘 스캔 기록(포탈 시각 0시 ~ 24시)과 다음 예정입니다. 쉬는 시간은 그 에이전트가 있는 곳의 현지 시각으로 판정하고, 그 시간에 걸린 주기 회차는 건너뜁니다(몰아서 다시 돌지 않습니다).</div>
        </div>
        <button className="logout-btn" style={{ padding: '6px 12px', fontSize: 12 }} onClick={() => setNonce((n) => n + 1)}>새로고침</button>
      </div>
      <div className="ipam-day-lg muted">
        {Object.entries(RUN_KIND).map(([k, l]) => <span key={k}><i className={`ipam-day-run ${k}`} />{l}</span>)}
        <span><i className="ipam-day-now" />지금</span>
      </div>
      {err ? <ErrorBox message={err} /> : d === undefined ? <Loading /> : (
        <STable className="v3-table" minWidth={900}>
          <thead><tr><th>에이전트</th><th>상태</th><th>주기</th><th>쉬는 시간</th><th data-nosort style={{ minWidth: 280 }}>오늘 0시 ─ 6 ─ 12 ─ 18 ─ 24시</th><th>마지막 완료</th><th>다음 예정(어림)</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const st = SCHED_STATE[r.state] || SCHED_STATE.none;
              return (
                <tr key={r.agent}>
                  <td data-sort={agentLabel(r.agent)} style={{ whiteSpace: 'normal', minWidth: 120 }}>
                    {onEdit ? <button type="button" className="ipam-link" style={{ marginLeft: 0, fontSize: 13, fontWeight: 600, textAlign: 'left' }} onClick={() => onEdit(r.agent)}>{agentLabel(r.agent)}</button> : agentLabel(r.agent)}
                    <div className="muted" style={{ fontSize: 11 }}>대역 {r.ranges ?? '—'}줄 · 오늘 끝남 {r.counts.done} · 실패 {r.counts.fail} · 건너뜀 {r.counts.skip}</div>
                  </td>
                  <td data-sort={r.state}><span className={`badge ${st.tone}`} title={st.title}>{st.label}</span></td>
                  <td data-sort={r.intervalMs ?? ''}>{intervalText(r.intervalMs)}</td>
                  <td style={{ whiteSpace: 'normal', fontSize: 12 }}>{r.quiet.length ? r.quiet.join(' · ') : <span className="muted">없음</span>}</td>
                  <td style={{ minWidth: 280 }}>
                    <DayBar runs={r.runs} nowMin={d.nowMin} />
                    {r.overrun && <div style={{ fontSize: 11, color: 'var(--amber)', marginTop: 3 }}>마지막 스캔이 {durText(r.lastDurationMs)} 걸려 주기({intervalText(r.intervalMs)})보다 깁니다 — 겹치는 회차는 건너뜁니다. 주기를 늘리거나 속도를 올리세요.</div>}
                  </td>
                  <td data-sort={r.lastDoneAt ?? ''} style={{ fontSize: 12 }}>{r.lastDoneAt ? fmtDt(r.lastDoneAt) : <span className="muted">—</span>}{r.lastDurationMs != null ? <div className="muted" style={{ fontSize: 11 }}>{durText(r.lastDurationMs)} 걸림</div> : null}</td>
                  <td data-sort={r.nextAt ?? ''} style={{ fontSize: 12 }}>{r.nextAt ? fmtDt(r.nextAt) : <span className="muted">—</span>}</td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={7} className="center muted" style={{ padding: 18 }}>등록된 스캔 에이전트가 없습니다.</td></tr>}
          </tbody>
        </STable>
      )}
    </section>
  );
}
