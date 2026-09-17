/**
 * views/tools/BmUsageChart.jsx — 베어메탈 사용률 추이 차트(v2.551).
 *
 * 판정·좌표는 `bmUsageChart.js`(순수, 테스트 고정)가 소유하고 이 파일은 **그리기만** 한다.
 * ⚠ 차트 라이브러리를 들이지 않았다 — 결측 구간을 끊는 규칙(`linePath`)을 직접 지켜야 하고
 *   번들을 늘리지 않기 위해서다(`roomTempView.sparkPath` 와 같은 판단).
 */
import React, { useMemo, useState } from 'react';
import BoldText from '../../components/boldText.jsx';
import {
  CHART_SERIES, RANGES, rangeOf, gapMsFor, seriesPoints, linePath,
  yMaxFor, yTicks, xTicks, chartEmptyNote, sourceNote,
} from './bmUsageChart.js';

const W = 640; const H = 150; const PAD_L = 44; const PAD_B = 18; const PAD_T = 6;

function fmtY(kind, v) {
  if (kind !== 'bps') return `${Math.round(v)}%`;
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)}G`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(0)}M`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)}K`;
  return String(Math.round(v));
}

/** 한 지표의 선 하나. */
function OneChart({ series, raw, daily, range, intervalMs, absent, hasRows, dailyStat }) {
  const pts = useMemo(() => seriesPoints({ raw, daily, series, source: range.source, dailyStat }), [raw, daily, series, range, dailyStat]);
  const yMax = yMaxFor(series.kind, pts);
  const path = useMemo(() => linePath(pts, { w: W, h: H, gapMs: gapMsFor(range, intervalMs), yMax }), [pts, range, intervalMs, yMax]);
  const note = chartEmptyNote({ series, points: pts, range, absent, hasRows });
  const ticksY = yTicks(series.kind, yMax);
  const ticksX = path ? xTicks(path.t0, path.t1, { source: range.source }) : [];
  return (
    <div style={{ minWidth: 0 }}>
      {/*
        * ⚠ 지표명과 통계를 **한 줄에 두지 않는다**(v2.551 스크린샷 판독에서 잡은 결함):
        *   `네트워크 처리량` 처럼 긴 라벨이 통계와 같은 줄에 있으면 좁은 열에서 **두 줄로 깨져**
        *   (`네트워크 처리 / 량`) 차트마다 높이가 달라진다. 라벨은 한 줄로 못 박고 통계는 아래 줄이다.
        */}
      <div style={{ fontSize: 12, color: series.color, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {series.label}
      </div>
      {path && (
        <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 2, lineHeight: 1.4 }}>
          최대 {fmtY(series.kind, path.hi)} · 최소 {fmtY(series.kind, path.lo)} · 표본 {path.n}
          {path.breaks > 0 && ` · 수집 공백 ${path.breaks}구간`}
        </div>
      )}
      {note
        ? <p style={{ margin: '2px 0 10px', fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}><BoldText text={note} /></p>
        : (
          <svg viewBox={`0 0 ${W + PAD_L + 6} ${H + PAD_B + PAD_T}`} style={{ width: '100%', height: 'auto', display: 'block', marginBottom: 10 }} role="img" aria-label={`${series.label} 추이`}>
            {ticksY.map((v, i) => {
              const y = PAD_T + H - ((v / (yMax || 1)) * H);
              return (
                <g key={i}>
                  <line x1={PAD_L} y1={y} x2={PAD_L + W} y2={y} stroke="currentColor" strokeOpacity="0.12" strokeWidth="1" />
                  <text x={PAD_L - 5} y={y + 3} textAnchor="end" fontSize="9" fill="currentColor" fillOpacity="0.55">{fmtY(series.kind, v)}</text>
                </g>
              );
            })}
            {ticksX.map((tk, i) => (
              <text key={i} x={PAD_L + tk.at * W} y={H + PAD_T + 12} textAnchor={i === 0 ? 'start' : i === ticksX.length - 1 ? 'end' : 'middle'} fontSize="9" fill="currentColor" fillOpacity="0.55">{tk.label}</text>
            ))}
            <g transform={`translate(${PAD_L},${PAD_T})`}>
              <path d={path.d} fill="none" stroke={series.color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
            </g>
          </svg>
        )}
    </div>
  );
}

/**
 * 상세 차트 묶음. `onRange` 로 부모가 기간에 맞는 데이터를 다시 받아온다.
 * ⚠ **폴링하지 않는다** — 기간을 바꿀 때만 1회 조회한다(v2.508 규약).
 */
export default function BmUsageChart({ raw = [], daily = [], rawTruncated = false, intervalMs, absent = [], rangeKey = '24h', onRange, loading = false }) {
  const [dailyStat, setDailyStat] = useState('max');
  const range = rangeOf(rangeKey);
  const hasRows = range.source === 'daily' ? daily.length > 0 : raw.length > 0;
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
        {RANGES.map((r) => (
          <button
            key={r.key} onClick={() => onRange?.(r.key)} disabled={loading}
            style={{
              fontSize: 12, padding: '2px 8px',
              background: r.key === rangeKey ? 'rgba(96,165,250,0.18)' : 'transparent',
              border: '1px solid', borderColor: r.key === rangeKey ? '#60a5fa' : 'var(--border, rgba(255,255,255,0.14))',
              borderRadius: 4, color: 'inherit', cursor: loading ? 'wait' : 'pointer',
            }}
          >{r.label}</button>
        ))}
        {range.source === 'daily' && (
          <>
            <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 4 }}>롤업</span>
            {[['max', '최대'], ['avg', '평균']].map(([k, lab]) => (
              <button
                key={k} onClick={() => setDailyStat(k)}
                style={{
                  fontSize: 12, padding: '2px 8px', background: dailyStat === k ? 'rgba(167,139,250,0.18)' : 'transparent',
                  border: '1px solid', borderColor: dailyStat === k ? '#a78bfa' : 'var(--border, rgba(255,255,255,0.14))',
                  borderRadius: 4, color: 'inherit', cursor: 'pointer',
                }}
              >{lab}</button>
            ))}
          </>
        )}
        {loading && <span style={{ fontSize: 11, color: 'var(--muted)' }}>불러오는 중…</span>}
      </div>
      <p style={{ margin: '0 0 8px', fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
        <BoldText text={sourceNote(range, { rawTruncated, dailyStat })} />
      </p>
      {/* ⚠ 400px 에서도 접히게 — 지표가 8개라 고정 2열이면 페이지를 밀어낸다. */}
      {/*
        * ⚠ 최소폭을 300px 로 두면 1440px 에서 **4열**이 되어 차트가 330px 로 좁아지고 y축 라벨
        *   (44px 고정)이 그래프를 잡아먹어 읽히지 않는다(같은 판독에서 발견). 440px 이면
        *   1440px → 3열, 900px → 2열, 400px → 1열로 접힌다.
        */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 440px), 1fr))', gap: 14, minWidth: 0 }}>
        {CHART_SERIES.map((s) => (
          <OneChart
            key={s.key} series={s} raw={raw} daily={daily} range={range}
            intervalMs={intervalMs} absent={absent} hasRows={hasRows} dailyStat={dailyStat}
          />
        ))}
      </div>
    </div>
  );
}
