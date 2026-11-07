/**
 * views/tools/BmTrendChart.jsx — 추이 탭 · 확대 팝업의 **그리기 부품**(v2.923 · 3b). SVG 직접(차트 라이브러리 없음 — 결측을 끊는 규칙을
 * 직접 지키고 번들을 늘리지 않는다: BmUsageChart · VmPerfView 와 같은 판단).
 *
 *  · 좌표 · 경로 · 결측 띠 · 요약은 `bmTrendText.js`(순수) — 이 파일은 그리기와 포인터 처리만.
 *  · 뷰박스는 1000 × 100 고정 + preserveAspectRatio none(폭에 맞춰 늘린다) — 글자는 SVG 밖 HTML 로(늘어나 찌그러지지 않게) ·
 *    선 굵기는 vector-effect non-scaling-stroke · 홀로 남은 점은 길이 0 경로 + 둥근 끝(타원으로 찌그러지지 않는다).
 *  · 포인터: 움직임 = 커서(시각) · 끌기 = 구간 선택 · 짧게 누름 = onOpen(확대 팝업) · 두 번 누름 = 선택 해제. 터치 화면은 누름만.
 */
import React, { useRef } from 'react';
import { ticksOf } from '../../components/vmperf/vmPerfText.js';
import {
  seriesPath, gapBands, noPeakRuns, xOf, timeAtRatio, gapReasonText,
} from './bmTrendText.js';

const W = 1000; const H = 100;

/** 시각 축(HTML) — 창 기준 비율로 놓는다. */
export function TimeAxis({ from, to, narrow = false, selText = '' }) {
  const ticks = ticksOf(from, to, narrow ? 3 : 5, { short: narrow });
  return (
    <div className="bmt-axis" aria-hidden="true">
      {ticks.map((tk, i) => (
        <span key={i} style={{ left: `${((tk.ms - from) / (to - from)) * 100}%`, transform: i === 0 ? 'none' : i === ticks.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)' }}>{tk.label}</span>
      ))}
      {selText && <b className="bmt-axis-sel">{selText}</b>}
    </div>
  );
}

/** 포인터 → 시각 · 끌기 선택 · 누름. 반환 핸들러를 SVG 에 단다. */
function usePointer({ win, onHover, onSelect, onOpen }) {
  const drag = useRef(null);
  const ratioOf = (e) => {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect?.();
    if (!r || !r.width) return null;
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  return {
    onMouseMove: (e) => {
      const r = ratioOf(e); if (r == null) return;
      const ms = timeAtRatio(r, win);
      if (onHover) onHover(ms);
      if (drag.current) drag.current.cur = ms;
    },
    onMouseLeave: () => { if (onHover) onHover(null); },
    onMouseDown: (e) => { const r = ratioOf(e); if (r == null) return; drag.current = { start: timeAtRatio(r, win), cur: timeAtRatio(r, win), r0: r }; },
    onMouseUp: (e) => {
      const d = drag.current; drag.current = null;
      const r = ratioOf(e);
      if (!d || r == null) return;
      if (Math.abs(r - d.r0) > 0.01 && onSelect) {
        const a = timeAtRatio(Math.min(r, d.r0), win); const b = timeAtRatio(Math.max(r, d.r0), win);
        onSelect({ from: a, to: b });
      } else if (onOpen) onOpen(timeAtRatio(r, win));
    },
    onDoubleClick: () => { if (onSelect) onSelect(null); },
  };
}

/**
 * SVG 한 장 — 계열(선) 여러 개 · 결측 띠 · 피크 없는 띠 · 선택 구간 · 커서 · 기준선.
 * series: [{ points, gaps, pick:'avg'|'max'|'peak', color, dash, faint, width }]
 */
export function TrendSvg({ series = [], win, yMax = 100, cursor = null, sel = null, baseline = null, gaps = [], noPeak = [], label = '', height = 56, ptr = {}, marks = [], bandPolys = [], dots = [] }) {
  const bands = gapBands(gaps, { ...win, w: W });
  const np = noPeak.length ? gapBands(noPeak.map((r) => ({ ...r, reason: 'no-peak' })), { ...win, w: W }) : [];
  const cx = cursor == null ? null : xOf(cursor, { ...win, w: W });
  const selA = sel ? xOf(Math.max(sel.from, win.from), { ...win, w: W }) : null;
  const selB = sel ? xOf(Math.min(sel.to, win.to), { ...win, w: W }) : null;
  const yOf = (v) => H - (Math.max(0, Math.min(v, yMax)) / yMax) * H;
  return (
    <svg className="bmt-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height }} role="img" aria-label={label} {...ptr}>
      {[25, 50, 75].map((y) => <line key={y} x1="0" x2={W} y1={y} y2={y} stroke="var(--border-soft)" vectorEffect="non-scaling-stroke" />)}
      {bands.map((b, i) => <rect key={`g${i}`} x={b.x} y="0" width={Math.max(b.width, 0.5)} height={H} fill="var(--text-faint)" opacity={b.reason === 'migrating' ? 0.16 : 0.08}><title>{`결측 — ${gapReasonText(b.reason)}`}</title></rect>)}
      {np.map((b, i) => <rect key={`n${i}`} x={b.x} y={H - 6} width={Math.max(b.width, 0.5)} height="6" fill="var(--text-faint)" opacity="0.35"><title>피크 표본이 없는 주기(—)</title></rect>)}
      {selA != null && selB != null && selB > selA && <rect x={selA} y="0" width={selB - selA} height={H} fill="var(--accent-2)" opacity="0.08" stroke="var(--accent-2)" strokeOpacity="0.4" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
      {/* v2.929(5단계): 베이스라인 띠(지난 N주 같은 요일 · 시각 평균 ± — 다각형은 bmPerfOpsText.bandPolys) · 변경 이벤트 점(위 가장자리) · 집중 1분 점 */}
      {bandPolys.map((pts, i) => <polygon key={`b${i}`} points={pts} fill="var(--accent-2)" opacity="0.13" />)}
      {baseline && baseline.warn != null && baseline.warn <= yMax && <line x1="0" x2={W} y1={yOf(baseline.warn)} y2={yOf(baseline.warn)} stroke="var(--amber)" strokeDasharray="5 4" opacity="0.7" vectorEffect="non-scaling-stroke" />}
      {baseline && baseline.bad != null && baseline.bad <= yMax && <line x1="0" x2={W} y1={yOf(baseline.bad)} y2={yOf(baseline.bad)} stroke="var(--red)" strokeDasharray="5 4" opacity="0.7" vectorEffect="non-scaling-stroke" />}
      {series.map((s, i) => {
        const p = seriesPath(s.points, { pick: s.pick || 'avg', ...win, yMax, w: W, h: H, gaps: s.gaps || gaps });
        const sw = s.width || (s.faint ? 1 : 1.6);
        return (
          <g key={i} opacity={s.faint ? 0.45 : 1}>
            {p.d && <path d={p.d} fill="none" stroke={s.color} strokeWidth={sw} strokeDasharray={s.dash || undefined} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
            {p.dots.map((d, j) => <path key={j} d={`M${d.x.toFixed(1)} ${d.y.toFixed(1)} l0 0`} stroke={s.color} strokeWidth={s.faint ? 3 : 4} strokeLinecap="round" vectorEffect="non-scaling-stroke" />)}
          </g>
        );
      })}
      {dots.map((d, i) => { const x = xOf(d.t, { ...win, w: W }); const y = H - (Math.max(0, Math.min(d.v, yMax)) / yMax) * H; return <path key={`f${i}`} d={`M${x.toFixed(1)} ${y.toFixed(1)} l0 0`} stroke={d.color || 'var(--amber)'} strokeWidth="5" strokeLinecap="round" vectorEffect="non-scaling-stroke"><title>{d.title || ''}</title></path>; })}
      {marks.map((m, i) => { const x = xOf(m.t, { ...win, w: W }); return <g key={`m${i}`}><line x1={x} x2={x} y1="0" y2={H} stroke="var(--accent-2)" strokeOpacity="0.45" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" /><path d={`M${x.toFixed(1)} 0 l0 0`} stroke="var(--accent-2)" strokeWidth="7" strokeLinecap="round" vectorEffect="non-scaling-stroke"><title>{m.title || ''}</title></path></g>; })}
      {cx != null && <line x1={cx} x2={cx} y1="0" y2={H} stroke="var(--text-dim)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

/** 패널 한 행 — 이름(HTML) + SVG. 행을 누르면 확대 팝업. */
export function TrendRow({ title, sub = '', readout = null, series = [], win, yMax, cursor, sel, baseline = null, gaps = [], noPeak = [], message = '', note = '', onHover, onSelect, onOpen, legend = null, height = 56, unit = '', marks = [] }) {
  const ptr = usePointer({ win, onHover, onSelect, onOpen });
  return (
    <div className="bmt-row">
      <div className="bmt-row-head">
        <button type="button" className="bmt-row-title" onClick={() => onOpen && onOpen(null)} title="크게 보기(확대 팝업)">{title}</button>
        {sub && <div className="bmt-row-sub">{sub}</div>}
        {note && <div className="bmt-row-note">{note}</div>}
        {legend}
        {readout && <div className="bmt-row-read">{readout}</div>}
      </div>
      <div className="bmt-row-plot">
        <TrendSvg series={series} win={win} yMax={yMax} cursor={cursor} sel={sel} baseline={baseline} gaps={gaps} noPeak={noPeak} label={`${title} 추이`} height={height} ptr={ptr} marks={marks} />
        <span className="bmt-ymax" aria-hidden="true">{unit === '%' ? '100' : ''}</span>
        {message && <div className="bmt-row-msg">{message}</div>}
      </div>
    </div>
  );
}

/** 작은 추이(표 · 추천 행) — 평균 회색 + 피크 색. 누르면 onOpen. */
export function Spark({ points = [], gaps = [], win, yMax = 100, peak = false, extra = [], onOpen, label = '추이', width = 120, height = 28 }) {
  const series = [
    { points, gaps, pick: 'avg', color: 'var(--text-dim)', width: 1.2 },
    ...(peak ? [{ points, gaps, pick: 'peak', color: 'var(--red)', width: 1.3 }] : []),
    ...extra,
  ];
  const body = (
    <svg className="bmt-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width, height }} aria-hidden="true">
      {series.map((s, i) => {
        const p = seriesPath(s.points, { pick: s.pick, ...win, yMax: s.yMax || yMax, w: W, h: H, gaps: s.gaps || gaps });
        return (
          <g key={i}>
            {p.d && <path d={p.d} fill="none" stroke={s.color} strokeWidth={s.width || 1.2} vectorEffect="non-scaling-stroke" />}
            {p.dots.map((d, j) => <path key={j} d={`M${d.x.toFixed(1)} ${d.y.toFixed(1)} l0 0`} stroke={s.color} strokeWidth="3" strokeLinecap="round" vectorEffect="non-scaling-stroke" />)}
          </g>
        );
      })}
    </svg>
  );
  if (!onOpen) return body;
  return <button type="button" className="bmt-spark-btn" onClick={onOpen} title={`${label} — 크게 보기`} aria-label={`${label} 크게 보기`}>{body}</button>;
}

export { usePointer, noPeakRuns };
