/**
 * components/vmperf/VmPerfView.jsx — VM · ESXi 호스트 **성능** 화면(v2.911 · 시안 docs/design/vm-perf ②③④ · 사용자 컨펌 '개선' = 기본값).
 *   예전 성능 모달(VmMetrics.jsx MetricModal — 지표 4 + 기간 5 버튼 한 줄 · datetime-local 두 칸 · 한 번에 한 지표 · 지표마다 vCenter 로그인)을 대신해
 *   개체 보기 › 모니터 탭의 첫 섹션으로 들어간다(주소 …/monitor — 새로고침 · 공유 · 뒤로 가기).
 *   - 4지표를 `types=cpu,mem,disk,net` **한 번**에 받는다(서버 로그인 1회 · QueryPerf 1회). 실시간만 응답 `refreshSec` 마다 자동 갱신 · 그 밖은 열 때 1회 + '지금 다시 조회'.
 *   - 인증 정지(409 authStopped) · 직접 수집 대상 아님(409 skipReason) 판정 · 문구는 vmMetricsText.js 한 벌 그대로(자동 갱신을 멈춘다).
 *   - 과거 창: ◀ 이전 · 슬라이더(놓을 때만 조회) · 날짜로 이동 — 범위는 응답 `retention`(vCenter 보관 주기)에서 계산(vmPerfText.maxBackOf) · 롤업은 서버가 고르고 화면은 응답 값을 말한다.
 *   - 결측(null)은 선을 끊고 통계 분모에서 뺀다 · 값이 없으면 '—'(단위 없음) · 기준선(과부하)은 응답 `overloadPct`.
 *   - 차트는 SVG 직접 그리기(recharts 를 개체 보기 경로에 더 싣지 않는다 — 전송 속도 · Infra Observability 와 같은 방식).
 *   훅은 전부 조기 return 위(React #310).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, canCsv } from '../../api.js';
import BoldText from '../boldText.jsx';
import { STable } from '../STable.jsx';
import { metricErrorState, metricAuthStopText, metricSkipText, stopsAutoRefresh, edgePortalHref } from '../vmMetricsText.js';
import { vcHash } from '../../views/vcd/vcdRoute.js';
import { numOrNull } from '../../numOrNull.js';
import {
  RANGES, rangeOf, METRICS, METRIC_KEYS, metricOf, OVERLAYS, chartKeys, fmtVal, rollupLabel, fmtClock, durText, seriesStats,
  maxBackOf, windowOf, windowLabel, windowRangeText, dateJumpEnd, dateInputOf, backForEnd, yMaxOf, ticksOf, chartModel, hoverIndex, csvText, csvFileName,
} from './vmPerfText.js';
import './vmPerf.css';

const VB_W = 1360; const VB_H = 270; const X0 = 56; const X1 = 1330; const Y0 = 16; const Y1 = 236;
// 좁은 화면(720 미만)은 뷰박스 폭 400 — 1360 그대로면 340px 폭에서 높이가 68px 띠가 되고 글자가 6px 로 줄어든다(v2.911 Chromium 400 확인 · 시안 ③은 360 뷰박스).
const NB_W = 400; const NX0 = 52; const NX1 = 392;
const TYPES_ALL = METRIC_KEYS.join(',');
const two = (n) => String(n).padStart(2, '0');
const clockSec = (ms) => { const d = new Date(ms); return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`; };

/** 내려받기(브라우저) — 받은 계열로 만든다(서버 호출 없음). */
function downloadCsv(series, name, rangeK, endMs) {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') return;
  const blob = new Blob([csvText(series, METRIC_KEYS)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = csvFileName(name, rangeK, endMs);
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function VmPerfView({ entityType = 'vm', id, name, vcenterId = null, powered = true, initialRange = null }) {
  const [rangeK, setRangeK] = useState(() => (initialRange && RANGES.some((r) => r.k === initialRange) ? initialRange : 'day'));
  const [metric, setMetric] = useState('cpu');
  const [overlay, setOverlay] = useState('one');
  // 과거 창 — 개체·기간마다 따로(key) · anchor = 스크롤을 시작할 때의 창 끝(한 번만 잡는다) · dragBack = 슬라이더를 끄는 중.
  const key = `${entityType}|${id}|${rangeK}`;
  const [scroll, setScroll] = useState({ key, back: 0, anchor: null });
  const [dragBack, setDragBack] = useState(null);
  const [retry, setRetry] = useState(0);   // '지금 다시 조회'(manual=1) 횟수
  const [st, setSt] = useState({ loading: true, data: null, error: null, authStopped: null, skip: null, at: null });
  const [hover, setHover] = useState(null);
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 720);
  const seq = useRef(0);
  const svgRef = useRef(null);
  const range = rangeOf(rangeK);
  const back = scroll.key === key ? scroll.back : 0;
  const anchor = scroll.key === key ? scroll.anchor : null;
  const win = back > 0 && anchor != null ? windowOf(anchor, back, rangeK) : null;
  const effRange = !powered && rangeK === 'realtime' ? 'day' : rangeK;   // 꺼진 개체는 실시간이 없다(잠금)
  const vbW = narrow ? NB_W : VB_W; const x0 = narrow ? NX0 : X0; const x1 = narrow ? NX1 : X1;
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const on = () => setNarrow(window.innerWidth < 720);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  useEffect(() => {
    if (!id) return undefined;
    let alive = true;
    let timer = null;
    const my = ++seq.current;
    const ac = new AbortController();
    const path = `/${entityType === 'host' ? 'hosts' : 'vms'}/${encodeURIComponent(id)}/metrics`;
    const base = { types: TYPES_ALL, interval: effRange, ...(win ? { start: new Date(win.start).toISOString(), end: new Date(win.end).toISOString() } : {}) };
    const once = (manual) => {
      fetchJson(path, manual ? { ...base, manual: '1' } : base, ac.signal, { retries: 0, timeoutMs: 90_000 })
        .then((d) => { if (alive && my === seq.current) setSt({ loading: false, data: d, error: null, authStopped: null, skip: null, at: Date.now() }); })
        .catch((e) => {
          if (!alive || my !== seq.current || e?.name === 'AbortError') return;
          const es = metricErrorState(e);
          if (stopsAutoRefresh(es) && timer) { clearInterval(timer); timer = null; }   // v2.591 F6 · v2.744 FA-③: 같은 답을 20초마다 받지 않는다
          setSt((p) => ({ loading: false, data: p.data, error: es.message, authStopped: es.authStopped, skip: es.skip, at: p.at }));
        });
    };
    setSt((p) => ({ ...p, loading: true }));
    once(retry > 0);
    const live = effRange === 'realtime' && !win;
    if (live) timer = setInterval(() => once(false), Math.max(5, Number(st.data?.refreshSec) || 20) * 1000);
    return () => { alive = false; ac.abort(); if (timer) clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 창(start·end)은 win 객체가 아니라 back·anchor 로 고정 · refreshSec 은 응답값이라 deps 에 두면 매 응답마다 재조회
  }, [id, entityType, effRange, back, anchor, retry]);

  const data = st.data;
  const series = useMemo(() => data?.series || {}, [data]);
  const unit = metricOf(metric).unit;
  const overloadPct = numOrNull(data?.overloadPct);
  const sampleSec = numOrNull(data?.sampleSec);
  const retention = data?.retention || null;
  const maxB = maxBackOf(rangeK, retention);
  const cur = Math.min(maxB, dragBack ?? back);
  const stats = useMemo(() => Object.fromEntries(METRICS.map((m) => [m.k, seriesStats(series[m.k]?.points, { overloadPct: m.unit === '%' ? overloadPct : null, sampleSec })])), [series, overloadPct, sampleSec]);
  const keys = chartKeys(overlay, metric);
  const chartUnit = metricOf(keys[0]).unit;
  const yMax = yMaxOf(chartUnit, keys.map((k) => series[k]?.points));
  const startMs = win ? win.start : (data?.start ? Date.parse(data.start) : null);
  const endMs = win ? win.end : (data?.end ? Date.parse(data.end) : null);
  const models = useMemo(() => keys.map((k) => ({ k, m: chartModel(series[k]?.points, { x0, x1, y0: Y0, y1: Y1, max: yMax, startMs, endMs }) })), [keys.join(','), series, yMax, startMs, endMs, x0, x1]); // eslint-disable-line react-hooks/exhaustive-deps
  const tMin = models[0]?.m.tMin ?? startMs; const tMax = models[0]?.m.tMax ?? endMs;
  const ticks = ticksOf(tMin, tMax, narrow ? 3 : 5, { short: narrow });
  const hasPts = models.some((x) => x.m.pts.some((p) => p.v != null));
  const empty = !!data && !hasPts && !st.loading;
  const allEmpty = !!data && METRIC_KEYS.every((k) => !(series[k]?.points || []).some((p) => numOrNull(p?.v) != null));
  const past = !!win;
  const rollup = data?.sampleSec != null ? rollupLabel(data.sampleSec) : null;
  const coarser = data && data.requested && data.interval && data.requested !== data.interval;
  const liveNow = effRange === 'realtime' && !past;
  const yLabel = (v) => (chartUnit === '%' ? `${Math.round(v)}%` : fmtVal(v, chartUnit));
  const onMove = (e) => {
    const el = svgRef.current; if (!el || !models.length) return;
    const r = el.getBoundingClientRect(); if (!r.width) return;
    const x = ((e.clientX - r.left) / r.width) * vbW;
    const i = hoverIndex(models[0].m.pts, x);
    setHover(i >= 0 ? i : null);
  };
  const hp = hover != null ? models[0]?.m.pts[hover] : null;
  const go = (b) => {
    const nb = Math.max(0, Math.min(maxB, Math.floor(b)));
    setDragBack(null); setHover(null);
    setScroll(nb === 0 ? { key, back: 0, anchor: null } : { key, back: nb, anchor: anchor ?? (Number.isFinite(endMs) && !past ? endMs : Date.now()) });
  };
  const onJump = (dateStr) => {
    const e = dateJumpEnd(dateStr); if (e == null) return;
    const a = anchor ?? (Number.isFinite(endMs) && !past ? endMs : Date.now());
    const b = backForEnd(a, e, rangeK, maxB);
    setDragBack(null); setHover(null);
    setScroll(b === 0 ? { key, back: 0, anchor: null } : { key, back: b, anchor: a });
  };

  return (
    <section className={`vmp${st.loading && data ? ' vmp-dim' : ''}`} aria-label="성능">
      <div className="vmp-head">
        <div className="vmp-title">
          <h3>성능</h3>
          <span className="vmp-note">vCenter 성능 롤업 · 이 탭을 열 때 조회(포탈은 시계열을 저장하지 않습니다) · 4개 지표를 한 번에 묻습니다{!powered ? ' · 꺼진 개체는 실시간 값이 없습니다 — 켜져 있던 과거 구간은 24시간 이상 보기와 ◀ 이전 구간으로' : ''}</span>
        </div>
        <div className="vmp-acts">
          <div className="vmp-seg" role="tablist" aria-label="기간">
            {RANGES.map((r) => (
              <button key={r.k} type="button" role="tab" aria-selected={rangeK === r.k} className={rangeK === r.k ? 'on' : ''} disabled={!powered && r.k === 'realtime'}
                title={!powered && r.k === 'realtime' ? '꺼진 개체는 실시간 값이 없습니다' : undefined}
                onClick={() => { setRangeK(r.k); setDragBack(null); setHover(null); }}>{r.label}</button>
            ))}
          </div>
          {data && (
            <span className="vmp-pill" title={data.mock ? '데모 데이터' : undefined}>
              <span className={`vmp-dot${liveNow && !st.authStopped && !st.skip ? ' live' : ''}`} aria-hidden="true" />
              {rollup || '—'}{models[0] ? ` · ${(series[keys[0]]?.points || []).length}점` : ''}{liveNow ? ` · ${Number(data.refreshSec) > 0 ? `${data.refreshSec}초마다 갱신` : '자동 갱신'}` : ''}
              {st.at ? <> · 읽은 시각 <b className="mono">{clockSec(st.at)}</b></> : null}
            </span>
          )}
          {canCsv() && data && <button type="button" className="vmp-btn" onClick={() => downloadCsv(series, name, rangeK, endMs ?? Date.now())} title="보고 있는 구간의 4개 지표(받은 값 그대로)">CSV</button>}
          {!st.skip && <button type="button" className="vmp-btn primary" disabled={st.loading} onClick={() => setRetry((n) => n + 1)} title="vCenter 에 다시 묻습니다(1회)">{st.loading ? '조회 중…' : '지금 다시 조회'}</button>}
        </div>
      </div>

      {st.error && !st.authStopped && !st.skip && <div className="error-box" style={{ whiteSpace: 'normal' }}>조회 실패: {st.error}</div>}
      {st.authStopped && (
        <div className="error-box" style={{ whiteSpace: 'normal' }}><BoldText text={metricAuthStopText(st.authStopped)} /></div>
      )}
      {st.skip && (
        <div className="vmp-info">
          <BoldText text={metricSkipText(st.skip)} />
          {/* v2.926: 엣지 위임이면(관리자) 그 법인 엣지 포탈의 같은 화면으로 — 별도 로그인 · 같은 계정이 있어야 한다(지어내지 않는다). */}
          {(() => { const href = edgePortalHref(st.skip.edge, vcHash(vcenterId, { type: entityType === 'host' ? 'host' : 'vm', id, tab: 'monitor' })); return href ? (
            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <a className="vmp-btn" href={href} target="_blank" rel="noopener noreferrer" title={href}>엣지 포탈{st.skip.edge?.name ? `(${st.skip.edge.name})` : ''}에서 이 화면 열기 ↗</a>
              <span className="vmp-note">엣지 포탈은 따로 로그인합니다 — 거기 계정이 있어야 보입니다</span>
            </div>
          ) : null; })()}
        </div>
      )}

      <div className="vmp-stats" role="tablist" aria-label="지표">
        {METRICS.map((m) => {
          const s = stats[m.k];
          const sp = chartModel(series[m.k]?.points, { x0: 1, x1: 99, y0: 2, y1: 26, max: m.unit === '%' ? 100 : yMaxOf('KBps', [series[m.k]?.points]) });
          const err = series[m.k]?.error;
          return (
            <button key={m.k} type="button" role="tab" aria-selected={metric === m.k && overlay === 'one'} className={`vmp-stat${metric === m.k && overlay === 'one' ? ' on' : ''}`}
              onClick={() => { setMetric(m.k); setOverlay('one'); setHover(null); }} title={`${m.label} 을 차트에 그립니다`}>
              <span className="lb">{m.label}</span>
              <span className="v" style={{ color: m.unit === '%' && s.last != null && overloadPct != null && s.last >= overloadPct ? 'var(--vmp-crit)' : undefined }}>
                {err ? <span className="muted" style={{ fontSize: 12 }}>카운터 없음</span> : fmtVal(s.last, m.unit)}
              </span>
              <svg className="vmp-spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
                {sp.path ? <path d={sp.path} fill="none" stroke={m.color} strokeWidth="1.4" vectorEffect="non-scaling-stroke" /> : null}
              </svg>
              <span className="mm">
                <span>평균 <b>{fmtVal(s.avg, m.unit)}</b></span>
                <span>최대 <b>{fmtVal(s.max, m.unit)}</b>{s.maxAt ? ` ${fmtClock(Date.parse(s.maxAt))}` : ''}</span>
                <span>최저 <b>{fmtVal(s.min, m.unit)}</b></span>
                {s.missing > 0 && <span className="muted">결측 {s.missing}</span>}
              </span>
            </button>
          );
        })}
      </div>

      <div className="vmp-card">
        <div className="vmp-cardhead">
          <div className="vmp-cardtitle">
            <h4>{range.label} 추이 · {keys.length === 1 ? metricOf(keys[0]).label : OVERLAYS.find((o) => o.k === overlay)?.label}</h4>
            {past && <span className="vmp-badge past">과거 구간</span>}
            {data?.mock && <span className="vmp-badge gray">데모 데이터</span>}
            <div className="vmp-seg" role="tablist" aria-label="겹쳐 보기">
              {OVERLAYS.map((o) => (
                <button key={o.k} type="button" role="tab" aria-selected={overlay === o.k} className={overlay === o.k ? 'on' : ''} onClick={() => { setOverlay(o.k); setHover(null); }}>{o.label}</button>
              ))}
            </div>
          </div>
          <div className="vmp-legend">
            {keys.map((k) => <span key={k}><i style={{ borderTopColor: metricOf(k).color }} />{metricOf(k).label}{rollup ? `(${rollup})` : ''}</span>)}
            {keys.length === 1 && stats[keys[0]].avg != null && <span><i style={{ borderTop: '1px dashed var(--text-dim)' }} />기간 평균 {fmtVal(stats[keys[0]].avg, chartUnit)}</span>}
            {chartUnit === '%' && overloadPct != null && <span><i style={{ borderTop: '1px dashed var(--vmp-crit)' }} />과부하 기준 {overloadPct}% (신호 ‘과부하’ 와 같은 값)</span>}
            <span><i style={{ borderTop: '2px dotted var(--text-faint)' }} />결측 — 선을 끊음</span>
          </div>
        </div>
        <div className="vmp-note">
          {rollup ? `값은 vCenter 가 보관한 ${rollup}입니다` : 'vCenter 롤업'}{coarser ? ` — 이 구간은 요청한 ${rollupLabel(rangeOf(data.requested) ? (data.requested === 'realtime' ? 20 : null) : null) || '롤업'}보다 거친 ${rollup}(vCenter 보관 주기)으로만 남아 있습니다` : ''}
          {' · 못 읽은 표본은 0 이 아니라 결측으로 비워 둡니다'}
          {models[0] ? ` · 값 ${models[0].m.pts.filter((p) => p.v != null).length}점 · 결측 ${models[0].m.pts.filter((p) => p.v == null).length}점` : ''}
          {liveNow ? ' · 실시간(20초)은 vCenter 가 최근 1시간만 보관합니다 — 더 이전은 24시간 이상 보기에서' : ''}
        </div>

        <div className="vmp-plot">
          {!data && st.loading && <div className="vmp-empty"><b>vCenter 에서 불러오는 중…</b><span>RTT 가 큰 법인은 몇 초 걸립니다</span></div>}
          {!data && !st.loading && (st.authStopped || st.skip || st.error) && <div className="vmp-empty"><b>값을 받지 못했습니다</b><span>위 안내를 보세요 — 0 으로 그리지 않습니다</span></div>}
          {empty && (
            <div className="vmp-empty">
              <b>이 구간에 vCenter 가 돌려준 표본이 없습니다</b>
              <span>{allEmpty ? '보관 주기를 넘었거나 그때 이 개체가 없었습니다(꺼진 개체의 실시간 값도 없습니다) — 0 으로 그리지 않습니다. ‘최신’ 으로 돌아가거나 날짜를 바꿔 보세요.' : '이 지표만 비어 있습니다 — 다른 지표 카드를 눌러 보세요.'}</span>
            </div>
          )}
          {data && hasPts && (
            <>
              <svg ref={svgRef} viewBox={`0 0 ${vbW} ${VB_H}`} role="img" aria-label={`${range.label} 추이`} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
                {[0, 1, 2, 3, 4].map((i) => {
                  const y = Y1 - ((Y1 - Y0) * i) / 4;
                  return <g key={i}><line x1={x0} x2={x1} y1={y} y2={y} stroke="var(--border-soft)" /><text x={x0 - 8} y={y + 4} fill="var(--text-faint)" fontSize="11" textAnchor="end">{yLabel((yMax * i) / 4)}</text></g>;
                })}
                {ticks.map((t, i) => {
                  const x = tMax > tMin ? x0 + ((x1 - x0) * (t.ms - tMin)) / (tMax - tMin) : x0;
                  return <g key={i}><line x1={x} x2={x} y1={Y0} y2={Y1} stroke="var(--panel-2)" /><text x={x} y={Y1 + 20} fill="var(--text-faint)" fontSize="11" textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'}>{t.label}</text></g>;
                })}
                {chartUnit === '%' && overloadPct != null && overloadPct <= yMax && (
                  <line x1={x0} x2={x1} y1={Y1 - ((Y1 - Y0) * overloadPct) / yMax} y2={Y1 - ((Y1 - Y0) * overloadPct) / yMax} stroke="var(--vmp-crit)" strokeDasharray="4 4" opacity=".6" />
                )}
                {keys.length === 1 && stats[keys[0]].avg != null && (
                  <line x1={x0} x2={x1} y1={Y1 - ((Y1 - Y0) * Math.min(stats[keys[0]].avg, yMax)) / yMax} y2={Y1 - ((Y1 - Y0) * Math.min(stats[keys[0]].avg, yMax)) / yMax} stroke="var(--text-dim)" strokeDasharray="4 4" opacity=".6" />
                )}
                {models.map(({ k, m }) => (
                  <g key={k}>
                    {keys.length === 1 && m.path ? <path d={`${m.path} L${x1} ${Y1} L${x0} ${Y1} Z`} fill={metricOf(k).color} opacity=".12" /> : null}
                    {m.path ? <path d={m.path} fill="none" stroke={metricOf(k).color} strokeWidth="1.8" strokeLinejoin="round" /> : null}
                  </g>
                ))}
                {hp && (
                  <g aria-hidden="true">
                    <line x1={hp.x} x2={hp.x} y1={Y0} y2={Y1} stroke="var(--text-dim)" strokeDasharray="3 3" />
                    {models.map(({ k, m }) => (m.pts[hover]?.y != null ? <circle key={k} cx={m.pts[hover].x} cy={m.pts[hover].y} r="4.5" fill={metricOf(k).color} stroke="var(--bg)" strokeWidth="1.5" /> : null))}
                  </g>
                )}
              </svg>
              {hp && (
                <div className={`vmp-tip${hp.x > vbW * 0.6 ? ' left' : ''}`} style={{ left: `${(hp.x / vbW) * 100}%` }} role="status">
                  <div className="h">{fmtClock(Date.parse(hp.t))}{rollup ? ` · ${rollup}` : ''}</div>
                  {METRICS.map((m) => {
                    const p = series[m.k]?.points?.[hover];
                    const v = numOrNull(p?.v);
                    return <div key={m.k} className="l"><span style={{ color: m.color }}>■</span><span>{m.short} <b className="mono">{v == null ? '결측' : fmtVal(v, m.unit)}</b></span></div>;
                  })}
                  {chartUnit === '%' && overloadPct != null && hp.v != null && hp.v >= overloadPct && <div className="l" style={{ color: 'var(--vmp-crit)' }}><span>▲</span><span>과부하 기준 {overloadPct}% 이상</span></div>}
                </div>
              )}
            </>
          )}
        </div>

        {range.nav && (maxB > 0 || past) && (
          <div className="vmp-winscroll">
            <div className="vmp-winrow">
              <button type="button" className="vmp-btn sm" disabled={cur >= maxB} onClick={() => go(cur + 1)}>◀ 이전 {range.label}</button>
              <input type="range" min={0} max={maxB} step={1} value={maxB - cur} aria-label="조회 구간 스크롤(오른쪽 끝 = 최근)"
                onChange={(e) => setDragBack(maxB - Number(e.target.value))}
                onPointerUp={(e) => go(maxB - Number(e.currentTarget.value))}
                onKeyUp={(e) => go(maxB - Number(e.currentTarget.value))} />
              <button type="button" className="vmp-btn sm" disabled={cur <= 0} onClick={() => go(cur - 1)}>다음 {range.label} ▶</button>
              <button type="button" className={`vmp-btn sm${cur === 0 ? ' primary' : ''}`} disabled={cur === 0} onClick={() => go(0)}>최신</button>
              <label className="vmp-datejump"><span>날짜로 이동</span>
                <input type="date" value={dateInputOf(past ? win.end : (endMs ?? Date.now()))} max={dateInputOf(Date.now())} onChange={(e) => { if (e.target.value) onJump(e.target.value); }} />
              </label>
            </div>
            <div className="vmp-note center">
              {windowLabel(cur, rangeK)}{win ? ` · ${windowRangeText(win.start, win.end)}` : ''}
              {past && coarser ? ` · 이 구간은 ${rollup}(vCenter 보관 주기)` : ''}
              {past ? ' · 과거 구간은 자동 갱신하지 않습니다' : ''}{dragBack != null ? ' · 놓으면 조회합니다' : ''}
              {` · 뒤로 ${maxB}칸까지 — vCenter 보관 주기(${data?.retentionSource === 'vcenter' ? 'vCenter 에서 읽음' : '기본값'})`}
            </div>
          </div>
        )}
        {range.nav && maxB === 0 && data && !past && <div className="vmp-note center">이 기간은 뒤로 갈 수 있는 구간이 없습니다(vCenter 보관 주기 기준)</div>}
      </div>

      {data && hasPts && (
        <div className="vmp-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="vmp-cardhead" style={{ padding: '12px 14px', borderBottom: '1px solid var(--border-soft)' }}>
            <h4 style={{ margin: 0 }}>이 구간 요약 <span className="vmp-note" style={{ fontWeight: 500 }}>· {win ? windowRangeText(win.start, win.end) : (tMin != null && tMax != null ? windowRangeText(tMin, tMax) : '최근 구간')} · 지금 받은 점으로 계산(서버 호출 없음)</span></h4>
            <span className="vmp-note">머리글 클릭 정렬 · 시각은 브라우저 시각</span>
          </div>
          <STable className="v3-table" minWidth={720}>
            <thead><tr><th>지표</th><th>평균</th><th>최대</th><th>최대 시각</th><th>최저</th><th>최저 시각</th><th>{overloadPct != null ? `${overloadPct}% 이상 시간` : '기준 이상 시간'}</th><th>결측</th></tr></thead>
            <tbody>
              {METRICS.map((m) => {
                const s = stats[m.k];
                return (
                  <tr key={m.k}>
                    <td><b>{m.label}</b></td>
                    <td data-sort={s.avg ?? ''} className="mono">{fmtVal(s.avg, m.unit)}</td>
                    <td data-sort={s.max ?? ''} className="mono" style={{ color: m.unit === '%' && s.max != null && overloadPct != null && s.max >= overloadPct ? 'var(--vmp-crit)' : undefined }}>{fmtVal(s.max, m.unit)}</td>
                    <td data-sort={s.maxAt ? Date.parse(s.maxAt) : ''} className="mono">{s.maxAt ? fmtClock(Date.parse(s.maxAt)) : '—'}</td>
                    <td data-sort={s.min ?? ''} className="mono">{fmtVal(s.min, m.unit)}</td>
                    <td data-sort={s.minAt ? Date.parse(s.minAt) : ''} className="mono">{s.minAt ? fmtClock(Date.parse(s.minAt)) : '—'}</td>
                    <td data-sort={s.overSec ?? ''} className="mono">{s.overSec == null ? <span className="muted">—</span> : durText(s.overSec)}</td>
                    <td data-sort={s.missing} className="mono">{s.missing} / {s.measured + s.missing}</td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
        </div>
      )}
    </section>
  );
}
