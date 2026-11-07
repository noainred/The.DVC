/**
 * 서버 상세 ‘집중 모니터링’ 탭(리눅스 성능 5단계 · 설계 PROFILES §13 · 아트보드 Focus.dc.html).
 * 시작(operator 이상 · 쓰기 범위 · 사유 필수 — 서버가 다시 검사) → 진행 띠(1분 칸 · 색 = 판정 · 점선 = 결측) → KPI → 지표 × 분 히트 표 → 앞 1시간 대비 →
 * 분별 프로세스 상위 → 같은 시간대 이벤트 → 결론 카드(원인 ‘후보’ 로만 · 조치 제안 · CSV) → 세션 목록(보관 기간).
 * ⚠ 판정 · 요약은 서버(focus/run.js summarizeFocus) — 이 파일은 그리기만(문구 bmPerfOpsText.js).
 * ⚠ 폴링: **진행 중 · 대기 세션을 보고 있을 때만** FOCUS_POLL_MS(30초)마다 그 세션 하나를 다시 읽는다 — 1분 표본이라 30초면 한 분을 놓치지 않고,
 *   세션당 focusPollMax 회로 묶이며 끝나면(완료 · 중지 · 중단) 멈춘다. 그 밖에는 탭을 열 때 1회 + ‘다시 읽기’(웹 규약의 예외 — web.md v2.929).
 */
import React, { useEffect, useRef, useState } from 'react';
import { postJson, fetchJson, hasRole, canCsv } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { toneVar } from './toneVar.js';
import { useOpsLoad, OpsError } from './BmTuningTab.jsx';
import { verdictView } from './bmPerfText.js';
import { shortStamp } from './bmOpsText.js';
import { fmtHm } from '../../components/vmperf/vmPerfText.js';
import { unitText } from '../unitText.js';
import {
  FOCUS_MISS_TEXT, ACTION_TEXT, FOCUS_HONEST, focusStatusView, focusCodeView, vText, progressCells, heatRows, heatAlpha, beforeRows, focusEvents, conclusionParts, missPathParts, osMissed,
  focusCsv, focusCsvName, FOCUS_POLL_MS, focusPollStep, FOCUS_METRIC_TEXT,
} from './bmPerfOpsText.js';
import './bmOps.css';
import './bmPerfOps.css';

function download(text, name) {
  try {
    const blob = new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1_000);
  } catch { /* 내려받기 실패는 화면을 바꾸지 않는다 */ }
}

/** 진행 띠 — 1분 칸(색 = 판정 · 점선 = 결측 · 흐림 = 아직). */
export function ProgressBand({ session, samples }) {
  const cells = progressCells(session, samples);
  return (
    <div className="bmf-band" role="list" aria-label="진행 띠">
      {cells.map((c) => (
        <span key={c.idx} role="listitem" className={`bmf-cell bmf-${c.state}`} title={c.title}
          style={c.state === 'done' || c.state === 'partial' ? { background: toneVar(c.tone), borderColor: toneVar(c.tone) } : undefined}>
          <span className="bmf-cell-t">{c.at ? fmtHm(c.at) : ''}</span>
        </span>
      ))}
    </div>
  );
}

/** 세션 상세(상태 없음 — 응답을 받아 그린다). */
export function FocusSessionView({ resp, name = '' }) {
  const s = resp?.session || null;
  const samples = resp?.samples || [];
  if (!s) return null;
  const sum = s.summary || {};
  const st = focusStatusView(s.status);
  const mp = missPathParts(s, sum);
  const rows = heatRows(samples);
  const before = beforeRows(sum, samples);
  const events = focusEvents(s, samples, resp?.changes || []);
  const c1 = (sum.candidates || [])[0];
  const maxAwait = sum.maxBy?.disk_await_ms; const maxCpu = sum.maxBy?.cpu_pct;
  const companion = [sum.maxBy?.cpu_iowait_pct ? `iowait ${vText(sum.maxBy.cpu_iowait_pct.value, '%')}` : '', sum.maxBy?.psi_io_full10 ? `PSI io ${vText(sum.maxBy.psi_io_full10.value, '%')}` : '', sum.maxBy?.swap_out_ps ? `스왑아웃 ${vText(sum.maxBy.swap_out_ps.value, '/s')}` : ''].filter(Boolean).join(' · ');
  return (
    <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      <section className="bmo-card">
        <div className="bmo-h">
          <span>{shortStamp(s.start || s.created)} 시작 · {s.trigger === 'auto' ? `자동 규칙${s.rule ? `(${s.rule})` : ''}` : '수동'}{s.by ? ` · ${s.by}` : ''}</span>
          <span className="bmp-chip" style={{ color: toneVar(st.tone) }}>{st.label}{s.status === 'running' ? ` ${s.done}/${s.count}` : ''}{s.status === 'queued' && s.queuePos ? ` — 대기 ${s.queuePos}번째` : ''}</span>
        </div>
        <div className="bmo-reads">간격 {s.intervalS}초 × {s.count}회 · 사유: {s.reason || '—'}</div>
        <ProgressBand session={s} samples={samples} />
        <div className="bmo-sub">칸 색 = 그 분의 판정 · 점선 = 결측(0 으로 채우지 않음) · 흐린 칸 = 아직. 결측은 {mp.os} · {mp.idrac}(따로 셉니다).</div>
      </section>

      <div className="bmo-kpis">
        <div className="bmo-kpi"><div className="bmo-k">판정 변화</div><div className="bmo-kv" style={{ fontSize: 16 }}>{sum.verdictFrom ? verdictView(sum.verdictFrom).label : '—'} → {sum.verdictTo ? verdictView(sum.verdictTo).label : '—'}</div><div className="bmo-sub">{(sum.verdicts || []).filter(Boolean).length}분 판정</div></div>
        <div className="bmo-kpi"><div className="bmo-k">{maxAwait ? 'await 최고(1분 창 피크)' : 'CPU 최고'}</div><div className="bmo-kv">{maxAwait ? vText(maxAwait.value, 'ms') : vText(maxCpu?.value, '%')}</div><div className="bmo-sub">{(maxAwait || maxCpu)?.at ? fmtHm((maxAwait || maxCpu).at) : '—'}{maxAwait && before.find((b) => b.metric === 'disk_await_ms')?.beforeAvg != null ? ` · 앞 1시간 평균 ${vText(before.find((b) => b.metric === 'disk_await_ms').beforeAvg, 'ms')}` : ''}</div></div>
        <div className="bmo-kpi"><div className="bmo-k">원인 후보 프로세스(상관)</div><div className="bmo-kv" style={{ fontSize: 16 }}>{c1 ? c1.name : '—'}</div><div className="bmo-sub">{c1 ? `${c1.of}분 중 I/O 1위 ${c1.io}회 · CPU 1위 ${c1.cpu}회` : '스냅샷이 없거나 겹치지 않음'}</div></div>
        <div className="bmo-kpi"><div className="bmo-k">동반 신호</div><div className="bmo-kv" style={{ fontSize: 14 }}>{companion || '—'}</div><div className="bmo-sub">전력 · 흡기는 iDRAC 쪽 값(이미 가진 값)</div></div>
        <div className="bmo-kpi"><div className="bmo-k">결측</div><div className="bmo-kv">{mp.total ?? '—'} / {s.done || samples.length}</div><div className="bmo-sub">{mp.os} · {mp.idrac}</div></div>
      </div>

      <section className="bmo-card">
        <h5 className="bmo-h">한눈에 — 지표 × 분(1분 창의 평균 / 피크)</h5>
        <div className="bmo-reads">칸 = 1분 창 · 농도 = 이 세션 안 최대 대비(판정이 아님) · ‘—’ 결측 · 머리글 클릭 정렬</div>
        {!rows.length ? <p className="bmo-note">아직 받은 분이 없습니다.</p> : (
          <STable minWidth={150 + samples.length * 88} className="bmo-t bmf-heat" style={{ fontSize: 12, width: 'auto' }}>
            <thead><tr><th>지표</th>{samples.map((x) => <th key={x.idx} className="right">{fmtHm(x.minuteTs)}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.metric}>
                  <td data-sort={r.label} className="bmo-name">{r.label}{r.unit ? <span className="bmo-sub"> {r.unit}</span> : null}</td>
                  {r.cells.map((c, i) => (
                    <td key={i} className="right" data-sort={c.miss ? '' : (c.peak ?? c.avg ?? '')} style={c.miss ? undefined : { background: `color-mix(in srgb, var(--accent-2) ${Math.round(heatAlpha(c.peak ?? c.avg, r.max) * 38)}%, transparent)` }}>
                      {c.miss ? <span className="bmo-sub">—</span> : c.peak != null ? `${vText(c.avg)} / ${vText(c.peak)}` : vText(c.avg)}
                    </td>
                  ))}
                </tr>
              ))}
              <tr>
                <td data-sort="판정" className="bmo-name">USE 판정</td>
                {samples.map((x) => <td key={x.idx} data-sort={x.verdict || ''} style={{ color: x.verdict ? toneVar(verdictView(x.verdict).tone) : 'var(--muted)' }}>{x.verdict ? verdictView(x.verdict).label : (osMissed(x) ? '결측' : '—')}</td>)}
              </tr>
            </tbody>
          </STable>
        )}
        {samples.some(osMissed) && <p className="bmo-note">결측 분: {samples.filter(osMissed).map((x) => `${fmtHm(x.minuteTs)} ${FOCUS_MISS_TEXT[x.missOs] || x.missOs}`).join(' · ')} — 그 분은 iDRAC 쪽(전력 · 흡기)만 있을 수 있습니다(두 경로는 따로 셉니다).</p>}
      </section>

      <section className="bmo-card">
        <h5 className="bmo-h">앞 1시간(5분 평균) 대비</h5>
        {!before.length ? <p className="bmo-note">앞 1시간 표본이 없습니다(첫 수집 전이거나 그 시간 결측).</p> : (
          <STable minWidth={520} className="bmo-t" style={{ fontSize: 12 }}>
            <thead><tr><th>지표</th><th className="right">앞 1시간 평균 / 최대</th><th className="right">집중 평균 / 최고</th><th className="right">배수(평균)</th></tr></thead>
            <tbody>
              {before.map((b) => (
                <tr key={b.metric}>
                  <td data-sort={b.label}>{b.label}</td>
                  <td className="right" data-sort={b.beforeAvg ?? ''}>{vText(b.beforeAvg, b.unit)} / {vText(b.beforeMax, b.unit)}{b.beforeN != null ? <span className="bmo-sub"> ({b.beforeN}점)</span> : null}</td>
                  <td className="right" data-sort={b.avg ?? ''}>{vText(b.avg, b.unit)} / {vText(b.max, b.unit)}</td>
                  <td className="right" data-sort={b.ratio ?? ''}>{b.ratio == null ? '—' : `${b.ratio}×`}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        )}
      </section>

      <section className="bmo-card">
        <h5 className="bmo-h">분마다 프로세스 상위 — 경량 스냅샷(ps 상위 5 · /proc/pid/io 2초 차이 · 권한 있을 때)</h5>
        <STable minWidth={620} className="bmo-t" style={{ fontSize: 12 }}>
          <thead><tr><th>분</th><th>I/O 1위</th><th>2위</th><th>3위</th><th>CPU 1위</th></tr></thead>
          <tbody>
            {samples.map((x) => {
              const io = x.snap?.ioTop || []; const cpu = x.snap?.cpuTop || [];
              const ioT = (p) => (p ? `${p.name} ${vText(((p.readBps || 0) + (p.writeBps || 0)) / 1e6, 'MB/s')}` : '—');
              if (!x.snap || x.snap.error) return <tr key={x.idx}><td data-sort={x.minuteTs}>{fmtHm(x.minuteTs)}</td><td colSpan={4} data-sort="">{osMissed(x) ? `결측 — ${FOCUS_MISS_TEXT[x.missOs] || x.missOs}` : (sum.missOs === null || x.missOs === 'no-path' ? 'OS 경로 없음' : '스냅샷 없음')}</td></tr>;
              return (
                <tr key={x.idx}>
                  <td data-sort={x.minuteTs}>{fmtHm(x.minuteTs)}</td>
                  <td data-sort={io[0]?.name || ''}>{x.snap.io === 'perm' ? '권한 부족 — 확인 불가' : ioT(io[0])}</td>
                  <td data-sort={io[1]?.name || ''}>{ioT(io[1])}</td>
                  <td data-sort={io[2]?.name || ''}>{ioT(io[2])}</td>
                  <td data-sort={cpu[0]?.name || ''}>{cpu[0] ? `${cpu[0].name} ${vText(cpu[0].cpuPct, '%')}` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </STable>
        <p className="bmo-note">CPU% 는 ps 의 수명 평균이고 순간값이 아닙니다. 프로세스 인자 · 환경은 읽지 않습니다(이름만).</p>
      </section>

      <section className="bmo-card">
        <h5 className="bmo-h">같은 시간대 이벤트 — 시작 · 판정 · 결측 · 커널 오류 수 · 변경</h5>
        {!events.length ? <p className="bmo-note">이벤트가 없습니다.</p> : (
          <div className="bmo-tl">
            {events.map((e, i) => (
              <div key={i} className="bmo-tl-row"><span className="bmo-tl-at">{fmtHm(e.at)}</span><span className="bmp-chip">{({ start: '시작', verdict: '판정', missing: '결측', dmesg: 'dmesg', change: '변경', end: '끝' })[e.kind] || e.kind}</span><span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{e.text}</span></div>
            ))}
          </div>
        )}
        <p className="bmo-note">부품 장애 전이 · SEL/LC 는 ‘장애 기록’ 탭에서 같은 시각을 보십시오(여기에 다시 모으지 않았습니다).</p>
      </section>

      <section className="bmo-card bmf-conclusion">
        <h5 className="bmo-h">결론 카드 {s.status === 'running' ? '(진행 중 — 임시)' : ''}</h5>
        {conclusionParts(sum, s).map((p, i) => <p key={i} className="bmo-note"><BoldText text={p} /></p>)}
        {!!(sum.actions || []).length && (
          <div className="bmo-note"><b>조치 제안(확인할 것)</b>
            <ol style={{ margin: '4px 0 0', paddingLeft: 20 }}>{sum.actions.map((a) => <li key={a}>{ACTION_TEXT[a] || a}</li>)}</ol>
          </div>
        )}
        <div className="bmo-tagrow" style={{ marginTop: 6 }}>
          {canCsv() && <button type="button" className="btn btn-sm bmp-touch" disabled={!samples.length} onClick={() => download(focusCsv(s, samples), focusCsvName(name, s))}>CSV(분 × 지표 전부)</button>}
          <span className="bmo-sub">이슈에 첨부하려면 CSV 를 내려받아 붙이십시오(자동 첨부는 하지 않습니다{canCsv() ? '' : ' · CSV 는 관리자 이상'}).</span>
        </div>
      </section>
    </div>
  );
}

/** 세션 목록(그리기만). */
export function FocusSessionList({ sessions = [], selId = '', onOpen = () => {} }) {
  const withBy = sessions.some((x) => x.by);
  return (
    <STable minWidth={720} className="bmo-t" style={{ fontSize: 12 }}>
      <thead><tr><th>시작</th><th>트리거</th>{withBy && <th>실행자</th>}<th>길이 · 간격</th><th>결측(OS · iDRAC)</th><th>판정 변화</th><th>원인 후보</th><th>상태</th><th data-nosort /></tr></thead>
      <tbody>
        {sessions.map((x) => {
          const st = focusStatusView(x.status); const sm = x.summary || {};
          // 진행 중 세션은 요약이 없다 — 세션이 실은 경로(hasOs · hasIdrac — 실행 노드의 세션 값)로 ‘경로 없음’ 을 가린다(반증 F14).
          const mpx = missPathParts(x, { ...sm, ...(x.hasOs === false ? { missOs: null } : {}), ...(x.hasIdrac === false ? { missIdrac: null } : {}) });
          return (
            <tr key={x.id} style={{ background: selId === x.id ? 'rgba(255,255,255,0.04)' : undefined }}>
              <td data-sort={x.start || x.created}>{shortStamp(x.start || x.created)}</td>
              <td data-sort={x.trigger}>{x.trigger === 'auto' ? `자동${x.rule ? ` · ${x.rule}` : ''}` : '수동'}</td>
              {withBy && <td data-sort={x.by || ''}>{x.by || '—'}</td>}
              <td data-sort={x.count * x.intervalS}>{Math.round((x.count * x.intervalS) / 60)}분 · {x.intervalS}초</td>
              <td data-sort={mpx.total ?? ''}>{mpx.os} · {mpx.idrac}</td>
              <td data-sort={sm.verdictTo || ''}>{sm.verdictFrom ? `${verdictView(sm.verdictFrom).label} → ${verdictView(sm.verdictTo).label}` : '—'}</td>
              <td data-sort={sm.candidates?.[0]?.name || ''}>{sm.candidates?.[0]?.name || '—'}</td>
              <td data-sort={x.status}><span style={{ color: toneVar(st.tone) }}>{st.label}{x.status === 'running' ? ` ${x.done}/${x.count}` : ''}{x.status === 'queued' && x.queuePos ? ` · 대기 ${x.queuePos}번째` : ''}</span></td>
              <td data-nosort><button className="btn btn-sm bmp-touch" onClick={() => onOpen(x.id)}>보기</button></td>
            </tr>
          );
        })}
      </tbody>
    </STable>
  );
}

export default function BmFocusTab({ itemKey, name = '' }) {
  const list = useOpsLoad((k) => `/tools/bm-usage/perf/${encodeURIComponent(k)}/focus`, itemKey);
  const [reason, setReason] = useState('');
  const [run, setRun] = useState({ busy: false, resp: null, err: null });
  const [sel, setSel] = useState({ id: '', resp: null, err: null });
  const gen = useRef(0);
  const polls = useRef(0);
  const sessions = list.resp?.sessions || [];
  const live = sessions.find((x) => x.status === 'running' || x.status === 'queued') || null;
  const roleOk = hasRole('admin', 'operator');
  const writable = list.resp?.writable;
  const canRun = roleOk && writable !== false;
  const plan = list.resp?.plan || null;

  // poll = 폴링 타이머가 부른 것 — 횟수 카운터를 되돌리지 않는다(반증 F8: 예전에는 open 이 늘 0 으로 돌려 상한이 동작하지 않고 목록도 매번 다시 읽었다).
  const open = async (id, { poll = false } = {}) => {
    const g = ++gen.current;
    if (!poll) polls.current = 0;
    setSel((p) => ({ id, resp: p.id === id ? p.resp : null, err: null }));
    try {
      const resp = await fetchJson(`/tools/bm-usage/perf/${encodeURIComponent(itemKey)}/focus/${encodeURIComponent(id)}`, {}, undefined, { timeoutMs: 60_000 });
      if (g === gen.current) setSel({ id, resp, err: null });
    } catch (e) { if (g === gen.current) setSel({ id, resp: null, err: e }); }
  };
  // 처음에는 진행 중인 세션, 없으면 가장 최근 세션을 연다(목록이 바뀔 때 한 번).
  const firstId = live?.id || sessions[0]?.id || '';
  useEffect(() => {
    if (firstId && !sel.id) open(firstId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 목록이 처음 올 때만(open · sel.id 로 다시 돌지 않게)
  }, [firstId]);
  // 진행 중 · 대기 세션만 30초마다(상한 있음) — 끝나면 멈춘다.
  const selStatus = sel.resp?.session?.status;
  useEffect(() => {
    if (!sel.id || !(selStatus === 'running' || selStatus === 'queued')) return undefined;
    const h = setTimeout(() => {
      const step = focusPollStep(polls.current, sel.resp?.session);
      if (!step.go) return;
      polls.current = step.polls;
      open(sel.id, { poll: true }).then(() => { if (step.reloadList) list.reload(); });
    }, FOCUS_POLL_MS);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 응답이 바뀔 때마다 다음 한 번을 예약한다
  }, [sel.id, sel.resp, selStatus]);

  const start = async () => {
    setRun({ busy: true, resp: null, err: null });
    try {
      const r = await postJson(`/tools/bm-usage/perf/${encodeURIComponent(itemKey)}/focus`, { reason }, { timeoutMs: 60_000 });
      setRun({ busy: false, resp: r, err: null }); setReason('');
      await list.reload();
      if (r?.id) open(r.id);
    } catch (e) {
      if (e?.body?.code) setRun({ busy: false, resp: { ...e.body, ok: false }, err: null });
      else setRun({ busy: false, resp: null, err: e });
    }
  };
  const stop = async (id) => {
    try { await postJson(`/tools/bm-usage/perf/${encodeURIComponent(itemKey)}/focus/${encodeURIComponent(id)}/stop`, {}, { timeoutMs: 60_000 }); } catch (e) { setRun({ busy: false, resp: null, err: e }); }
    await list.reload(); open(id);
  };
  const cv = run.resp ? focusCodeView(run.resp.code) : null;
  return (
    <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      <section className="bmo-card">
        <h5 className="bmo-h">집중 모니터링 — {plan ? `${plan.durationMin}분 × ${plan.intervalS >= 60 ? `${plan.intervalS / 60}분` : `${plan.intervalS}초`} 간격(설정)` : '설정 읽는 중'}</h5>
        <div className="bmo-reads">장애 · 이슈 상황에서 정해진 주기 수집과 별도로 짧은 간격으로 봅니다. 1회 = SSH 1회(주 수집 명령 + 경량 스냅샷) + Redfish 1회 · 법인당 동시 {unitText(plan?.corpMax, '대')} · 넘치면 대기열 · 인증 거부는 즉시 중단.</div>
        {canRun ? (
          <div className="bmo-tagrow">
            <input className="input bmo-input" type="text" maxLength={300} placeholder="사유(필수 — 감사 기록에 남습니다)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button className="btn bmp-touch" disabled={run.busy || reason.trim().length < 2 || !!live} onClick={start}>{run.busy ? '시작하는 중…' : live ? '진행 중 세션이 있습니다' : '집중 모니터링 시작'}</button>
            {live && live.status === 'running' && <button className="btn bmp-touch" onClick={() => stop(live.id)}>중지</button>}
          </div>
        ) : !roleOk ? <p className="bmo-note">시작은 운영자(operator) 이상만 할 수 있습니다 — 아래 세션은 볼 수 있습니다.</p>
          : <p className="bmo-note">{focusCodeView('forbidden').text} 아래 세션은 볼 수 있습니다.</p>}
        {cv && <p className="bmo-note" style={{ color: toneVar(cv.tone) }}>{cv.text}{run.resp?.queuePos ? ` — 대기 ${run.resp.queuePos}번째` : ''}{run.resp?.reason && !run.resp.ok ? ` (${run.resp.reason})` : ''}</p>}
        {run.err && <ErrorBox error={run.err} />}
      </section>

      {sel.err && <OpsError err={sel.err} />}
      {sel.resp?.ok === false && <p className="bmo-note" style={{ color: toneVar('bad') }}>{focusCodeView(sel.resp.code).text}{sel.resp.reason ? ` (${sel.resp.reason})` : ''}</p>}
      {sel.resp?.session && <FocusSessionView resp={sel.resp} name={name} />}

      <section className="bmo-card">
        <h5 className="bmo-h">세션 — 이 서버 · 최근 {list.resp?.keepDays ?? 30}일 <button type="button" className="btn btn-sm bmp-touch" onClick={() => list.reload()} disabled={list.loading}>{list.loading ? '읽는 중…' : '다시 읽기'}</button></h5>
        <OpsError err={list.err} />
        {list.resp && list.resp.ok === false && <p className="bmo-note">{focusCodeView(list.resp.code).text}{list.resp.reason ? ` (${list.resp.reason})` : ''}</p>}
        {sessions.length ? <FocusSessionList sessions={sessions} selId={sel.id} onOpen={open} />
          : (list.resp && list.resp.ok !== false && <p className="bmo-note">이 서버의 집중 모니터링 세션이 없습니다.</p>)}
      </section>
      <p className="bmo-note bmo-card bmo-honest">{FOCUS_HONEST} 지표 이름: {Object.values(FOCUS_METRIC_TEXT).slice(0, 4).map((x) => x.label).join(' · ')} 등.</p>
    </div>
  );
}
