/**
 * 추이 탭의 5단계 절(v2.929 · 설계 PROFILES §13 · §14 ②③④ · 아트보드 Alerts · Compare):
 *   ‘베이스라인 · 변경 이벤트 · 집중 1분 점’ 겹침 카드(BaselineOverlay)와 ‘구간 비교’(CompareView).
 * ⚠ 띠 · 이벤트 · 비교 계산은 서버(baseline.js · changes.js · compare.js) — 여기는 그리기만(좌표 · 문구 bmPerfOpsText.js).
 * ⚠ 조회는 창이 바뀔 때 1회 + ‘다시 읽기’(폴링 없음) · 늦게 온 이전 창 응답은 세대로 버린다.
 */
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, canCsv } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { unitText } from '../unitText.js';
import Select from '../../components/Select.jsx';
import BoldText from '../../components/boldText.jsx';
import { toneVar } from './toneVar.js';
import { TrendSvg, TimeAxis } from './BmTrendChart.jsx';
import { shortStamp } from './bmOpsText.js';
import { splitByMaint, inMaint } from './bmMaintText.js'; // 8a단계 변경 이벤트 ‘정비 창 안’ 묶음
import { fmtHm } from '../../components/vmperf/vmPerfText.js';
import {
  bandPolys, bandSummaryText, changeKindText, changeMarks, CHANGES_HONEST, FOCUS_METRIC_TEXT, vText,
  COMPARE_METRIC_TEXT, COMPARE_PRESETS, comparePair, diffText, compareCsv, COMPARE_HONEST,
} from './bmPerfOpsText.js';
import './bmOps.css';
import './bmPerfOps.css';

const BAND_METRICS = Object.freeze(['cpu_pct', 'disk_await_ms', 'disk_busy_pct', 'net_pct', 'mem_pct']);
const enc = encodeURIComponent;

/** 세대로 늦은 응답을 버리는 1회 조회(path 가 바뀌면 다시). */
function useGenJson(path) {
  const [st, setSt] = useState({ loading: !!path, data: null, err: null });
  const gen = useRef(0);
  const load = () => {
    if (!path) { setSt({ loading: false, data: null, err: null }); return; }
    const g = ++gen.current;
    setSt((p) => ({ ...p, loading: true, err: null }));
    fetchJson(path, {}, undefined, { timeoutMs: 60_000 })
      .then((d) => { if (g === gen.current) setSt({ loading: false, data: d, err: null }); })
      .catch((e) => { if (g === gen.current) setSt({ loading: false, data: null, err: e }); });
  };
  useEffect(load, [path]);
  return { ...st, reload: load };
}
function download(text, name) {
  try {
    const blob = new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1_000);
  } catch { /* */ }
}

/** 변경 이벤트 표(그리기만). */
export function ChangeTable({ events = [], maintBands = [] }) {
  if (!events.length) return <p className="bmo-note">이 창에 변경 이벤트가 없습니다(바뀐 것이 없거나 아직 기준만 잡았습니다 — 첫 관찰은 적지 않습니다).</p>;
  // 8a단계: 정비 창 안 전이(패키지 · 재부팅)는 ‘정비 창 안’ 으로 묶어 표시(구간은 서버 판정 — 그리기만).
  const sp = splitByMaint(events, maintBands);
  return (
    <>
    {!!sp.inside.length && <p className="bmo-note">정비 창 안 변경 {sp.inside.length}건 · 창 밖 {sp.outside.length}건 — 창 안 행은 ‘정비 창 안’ 으로 묶어 위에 둡니다.</p>}
    <STable minWidth={600} className="bmo-t" style={{ fontSize: 12 }}>
      <thead><tr><th>시각</th><th>종류</th><th>항목</th><th>이전 → 이후</th></tr></thead>
      <tbody>
        {[...[...sp.inside].reverse(), ...[...sp.outside].reverse()].map((e, i) => (
          <tr key={`${e.id ?? i}|${e.ts}`}>
            <td data-sort={e.ts}>{shortStamp(e.ts)}{inMaint(e.ts, maintBands) && <div><span className="bmp-chip">정비 창 안</span></div>}</td>
            <td data-sort={e.kind}><span className="bmp-chip">{changeKindText(e.kind)}</span></td>
            <td data-sort={e.item} className="bmo-wrap">{e.item}</td>
            <td data-sort={e.after ?? ''} className="bmo-wrap">{e.before == null && e.after == null ? '—' : `${e.before ?? '—'} → ${e.after ?? '—'}`}</td>
          </tr>
        ))}
      </tbody>
    </STable>
    </>
  );
}

/** 베이스라인 · 변경 이벤트 · 집중 1분 점 겹침 카드. changes = 부모가 부른 변경 응답(같은 창). */
export function BaselineOverlay({ itemKey, win, changes = null, narrow = false, annotMarks: pins = [], maintBands = [] }) {
  const [metric, setMetric] = useState('disk_await_ms');
  const q = `from=${Math.floor(win.from)}&to=${Math.floor(win.to)}`;
  const band = useGenJson(itemKey ? `/tools/bm-usage/perf/${enc(itemKey)}/baseline?metric=${metric}&${q}` : '');
  const hist = useGenJson(itemKey ? `/tools/bm-usage/perf/${enc(itemKey)}/history?metric=${metric}&${q}` : '');
  const info = FOCUS_METRIC_TEXT[metric] || { label: metric, unit: '' };
  const pts = hist.data?.points || [];
  const bs = band.data?.series || [];
  const focusVals = (changes?.focus || []).map((f) => f.vals?.[metric]?.avg).filter((v) => v != null);
  const vals = [...pts.map((p) => p.avg), ...bs.map((b) => b.hi), ...focusVals].filter((v) => v != null);
  const yMax = info.unit === '%' ? 100 : Math.max(1, ...vals) * 1.1;
  const noLine = !hist.loading && !pts.some((p) => p.avg != null);
  const polys = band.data?.ok ? bandPolys(bs, { ...win, yMax }) : [];
  const outs = band.data?.ok && Array.isArray(band.data.outside) ? band.data.outside : [];   // 띠 밖 판정은 서버(반증 L3 — baseline.outsideOf)
  const ev = changes?.events || [];
  const marks = [...changeMarks(ev, win), ...pins];   // 6단계: 운영 주석 ◆ 핀도 같은 줄에
  const focusDots = (changes?.focus || []).filter((f) => f.vals?.[metric]?.avg != null).map((f) => ({ t: f.t, v: f.vals[metric].avg, color: 'var(--amber)', title: `집중 ${fmtHm(f.t)} ${vText(f.vals[metric].avg, info.unit)}` }));
  const dots = [...outs.map((p) => ({ t: p.t, v: p.avg, color: 'var(--red)', title: `띠 밖 ${fmtHm(p.t)} ${vText(p.avg, info.unit)}` })), ...focusDots];
  return (
    <section className="bmt-card" aria-label="베이스라인 · 변경 이벤트 · 집중 1분 점">
      <div className="bmt-panel-head">
        <h5>베이스라인 띠 · 변경 이벤트 · 집중 1분 점</h5>
        <span style={{ flex: '1 1 auto' }} />
        <div className="bmp-seg" role="tablist" aria-label="띠 지표">
          {BAND_METRICS.map((m) => <button key={m} role="tab" aria-selected={metric === m} className={metric === m ? 'active' : ''} onClick={() => setMetric(m)}>{FOCUS_METRIC_TEXT[m]?.label || m}</button>)}
        </div>
      </div>
      <div className="bmx-legend">
        <span><i className="bmx-sw" style={{ background: 'var(--accent-2)', opacity: 0.35 }} />띠(평소 범위)</span>
        <span><i className="bmx-sw" style={{ background: 'var(--text-dim)' }} />5분 값</span>
        <span><i className="bmx-sw" style={{ background: 'var(--red)' }} />띠 밖</span>
        <span><i className="bmx-sw" style={{ background: 'var(--amber)' }} />집중 1분 점</span>
        <span><i className="bmx-sw" style={{ background: 'var(--accent-2)' }} />변경 이벤트(위 점 — 가리키면 내용)</span>
      </div>
      <div className="bmx-plot" style={{ marginTop: 8 }}>
        <TrendSvg series={[{ points: pts, gaps: hist.data?.gaps || [], pick: 'avg', color: 'var(--text-dim)', width: 1.4 }]} win={win} yMax={yMax} gaps={hist.data?.gaps || []}
          label={`${info.label} 베이스라인`} height={narrow ? 90 : 120} bandPolys={polys} dots={dots} marks={marks} />
        {(hist.loading || band.loading) ? <div className="bmt-row-msg">불러오는 중…</div>
          : noLine && <div className="bmt-row-msg">이 창에 {info.label} 5분 값이 없습니다 — 0 으로 그리지 않습니다{focusDots.length ? '(집중 1분 점만 있습니다)' : ''}</div>}
      </div>
      <TimeAxis from={win.from} to={win.to} narrow={narrow} />
      {band.err && (band.err.status === 403 ? <ErrorBox error={band.err} /> : <p className="bmo-note" style={{ color: toneVar('warn') }}>베이스라인을 읽지 못했습니다({band.err.status || band.err.message}).</p>)}
      {band.data && <p className="bmo-note">{bandSummaryText(band.data)}{band.data.capped ? ' · 띠는 최근 14일까지만 그립니다' : ''}{outs.length ? ` · 띠 밖 ${outs.length}점(빨강)` : ''}</p>}
      {!!focusDots.length && <p className="bmo-note">집중 모니터링 1분 점 {focusDots.length}개를 5분 값 사이에 겹쳤습니다(해상도가 달라 같은 표에 섞지 않고 점으로만).</p>}
      <h6 style={{ margin: '8px 0 4px' }}>변경 이벤트 — 이 창 {ev.length}건{changes?.truncated ? '(상한으로 일부만)' : ''}</h6>
      <ChangeTable events={ev} maintBands={maintBands} />
      <p className="bmo-note"><BoldText text={CHANGES_HONEST} /></p>
    </section>
  );
}

/** 구간 비교(아트보드 Compare ⑩). sel = 추이 탭의 끌어 고른 구간(있으면 B). */
export function CompareView({ itemKey, sel = null, name = '' }) {
  const [preset, setPreset] = useState('yesterday');
  const [custom, setCustom] = useState('');
  const [sessId, setSessId] = useState('');
  const [st, setSt] = useState({ loading: false, data: null, err: null });
  const gen = useRef(0);
  const sessions = useGenJson(preset === 'focus' && itemKey ? `/tools/bm-usage/perf/${enc(itemKey)}/focus` : '');
  const sessList = (sessions.data?.sessions || []).filter((x) => x.start);
  const session = sessList.find((x) => x.id === sessId) || sessList[0] || null;
  const customA = custom ? Date.parse(custom) : null;
  const pair = comparePair({ preset, sel, now: Date.now(), session, customA });
  const run = async () => {
    const g = ++gen.current;
    setSt({ loading: true, data: null, err: null });
    try {
      const d = await fetchJson(`/tools/bm-usage/perf/${enc(itemKey)}/compare?aFrom=${Math.floor(pair.a.from)}&aTo=${Math.floor(pair.a.to)}&bFrom=${Math.floor(pair.b.from)}&bTo=${Math.floor(pair.b.to)}`, {}, undefined, { timeoutMs: 60_000 });
      if (g === gen.current) setSt({ loading: false, data: d, err: null });
    } catch (e) { if (g === gen.current) setSt({ loading: false, data: null, err: e }); }
  };
  const d = st.data;
  return (
    <section className="bmt-card" aria-label="구간 비교">
      <div className="bmt-panel-head">
        <h5>구간 비교 — A(기준) · B(비교)</h5>
        <span style={{ flex: '1 1 auto' }} />
        {d?.ok && canCsv() && <button type="button" className="btn btn-sm bmp-touch" onClick={() => download(compareCsv(d), `bm-compare_${String(name || itemKey).replace(/[^\w.-]+/g, '_').slice(0, 60)}.csv`)}>CSV</button>}
      </div>
      <div className="bmo-tagrow">
        <div className="bmp-seg" role="tablist" aria-label="A 고르기">
          {COMPARE_PRESETS.map((p) => <button key={p.k} role="tab" aria-selected={preset === p.k} className={preset === p.k ? 'active' : ''} onClick={() => setPreset(p.k)}>{p.label}</button>)}
        </div>
        {preset === 'custom' && <label className="bmo-sub">A 시작 <input className="input" type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} /></label>}
        {preset === 'focus' && (sessList.length ? (
          <Select sort={false} className="select select-sm" value={session?.id || ''} onChange={(e) => setSessId(e.target.value)} aria-label="집중 세션">
            {sessList.map((x) => <option key={x.id} value={x.id}>{shortStamp(x.start)} · {x.trigger === 'auto' ? '자동' : '수동'}</option>)}
          </Select>
        ) : <span className="bmo-sub">{sessions.loading ? '세션 읽는 중…' : '집중 세션이 없습니다'}</span>)}
        <button type="button" className="btn bmp-touch" onClick={run} disabled={st.loading || (preset === 'custom' && !customA) || (preset === 'focus' && !session)}>{st.loading ? '비교하는 중…' : '비교'}</button>
      </div>
      <div className="bmc-ab">
        <div className="bmo-band"><b>A 기준</b><span>{shortStamp(pair.a.from)} ~ {shortStamp(pair.a.to)}</span></div>
        <div className="bmo-band"><b>B 비교</b><span>{shortStamp(pair.b.from)} ~ {shortStamp(pair.b.to)}{sel ? ' (추이에서 고른 구간)' : ' (최근 1시간 — 추이에서 끌어 고르면 그 구간)'}</span></div>
      </div>
      {st.err && (st.err.status === 403 ? <ErrorBox error={st.err} /> : <p className="bmo-note" style={{ color: toneVar('bad') }}>비교하지 못했습니다({st.err.status || ''} {st.err.body?.reason || st.err.message}).</p>)}
      {d?.ok && (
        <>
          <p className="bmo-note">롤업 {d.res} · 둘 다 같은 길이({Math.round((d.a.to - d.a.from) / 60_000)}분){d.lengthAdjusted ? ' — 길이가 달라 짧은 쪽에 맞췄습니다' : ''}{d.resReason === 'coarser-of-two' ? ' · 두 구간 중 거친 해상도로 둘 다 읽었습니다' : ''} · ±{d.diffPct}% 밖만 색</p>
          <STable minWidth={640} className="bmo-t" style={{ fontSize: 12 }}>
            <thead><tr><th>지표</th><th className="right">A 평균 / 피크</th><th className="right">B 평균 / 피크</th><th className="right">차이(평균)</th><th className="right">차이(피크)</th><th className="right">뺀 칸</th></tr></thead>
            <tbody>
              {(d.metrics || []).map((m) => {
                const mi = COMPARE_METRIC_TEXT[m.metric] || { label: m.metric, unit: '' };
                // 기준(±diffPct) 밖이면 방향과 상관없이 같은 강조색 — 늘어남 · 줄어듦 어느 쪽이 좋은지는 지표마다 달라 색으로 판정하지 않는다.
                const tone = (o) => (o ? toneVar('warn') : undefined);
                return (
                  <tr key={m.metric}>
                    <td data-sort={mi.label}>{mi.label}</td>
                    <td className="right" data-sort={m.a?.avg ?? ''}>{vText(m.a?.avg, mi.unit)} / {vText(m.a?.peak, mi.unit)}</td>
                    <td className="right" data-sort={m.b?.avg ?? ''}>{vText(m.b?.avg, mi.unit)} / {vText(m.b?.peak, mi.unit)}</td>
                    <td className={`right${m.out?.avg ? ' bmc-out' : ''}`} data-sort={m.diffAvgPct ?? ''} style={{ color: tone(m.out?.avg, m.diffAvgPct) }}>{diffText(m.diffAvgPct)}</td>
                    <td className={`right${m.out?.peak ? ' bmc-out' : ''}`} data-sort={m.diffPeakPct ?? ''} style={{ color: tone(m.out?.peak, m.diffPeakPct) }}>{diffText(m.diffPeakPct)}</td>
                    <td className="right" data-sort={m.excluded ?? ''}>{m.excluded ?? '—'}<span className="bmo-sub"> / {d.slots}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
          <h6 style={{ margin: '8px 0 4px' }}>프로세스 상위 차이 — 스냅샷이 있는 구간만</h6>
          {!d.procs?.available ? <p className="bmo-note">A {unitText(d.procs?.a, '개')} · B {unitText(d.procs?.b, '개')} 스냅샷 — 두 구간 모두에 진단 스냅샷이나 집중 모니터링 경량 스냅샷이 있어야 비교합니다.</p> : (
            <STable minWidth={560} className="bmo-t" style={{ fontSize: 12 }}>
              <thead><tr><th>프로세스</th><th className="right">A I/O</th><th className="right">B I/O</th><th className="right">A CPU</th><th className="right">B CPU</th><th>비고</th></tr></thead>
              <tbody>
                {d.procs.rows.map((r) => (
                  <tr key={r.name}>
                    <td data-sort={r.name}>{r.name}</td>
                    <td className="right" data-sort={r.aIoBps ?? ''}>{r.aIoBps == null ? '없음' : vText(r.aIoBps / 1e6, 'MB/s')}</td>
                    <td className="right" data-sort={r.bIoBps ?? ''}>{r.bIoBps == null ? '없음' : vText(r.bIoBps / 1e6, 'MB/s')}</td>
                    <td className="right" data-sort={r.aCpuPct ?? ''}>{vText(r.aCpuPct, '%')}</td>
                    <td className="right" data-sort={r.bCpuPct ?? ''}>{vText(r.bCpuPct, '%')}</td>
                    <td data-sort={r.only || ''}>{r.only === 'b' ? 'B 에만' : r.only === 'a' ? 'A 에만' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
          )}
          <h6 style={{ margin: '8px 0 4px' }}>튜닝 · 설정 값 차이 — A 끝 ~ B 끝 사이에 바뀐 것만(변경 이벤트)</h6>
          <ChangeTable events={d.tuning || []} />
          <details style={{ marginTop: 8 }}>
            <summary className="bmo-sub" style={{ cursor: 'pointer' }}>두 구간을 덮는 변경 이벤트 전부 {(d.changes || []).length}건{d.changesTruncated ? '(상한으로 일부만)' : ''}</summary>
            <ChangeTable events={d.changes || []} />
          </details>
        </>
      )}
      {d && d.ok === false && <p className="bmo-note" style={{ color: toneVar('bad') }}>{d.reason || '비교하지 못했습니다.'}</p>}
      <p className="bmo-note">{COMPARE_HONEST}</p>
    </section>
  );
}
