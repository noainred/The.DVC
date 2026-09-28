/**
 * views/tools/BmStorHistoryPanel.jsx — 베어메탈 스토리지 디스크 사용량 추이(v2.635).
 *
 * 판정·좌표·문구는 `bmStorHistoryText.js`(순수, 테스트 고정)가 소유하고 이 파일은 **그리기만** 한다.
 * ⚠ **폴링하지 않는다** — 기간·보기를 바꿀 때만 1회 조회한다(12시간마다 쌓이는 이력이다. v2.508 규약).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import BoldText from '../../components/boldText.jsx';
import { errorBoxInput } from '../../components/accessDeniedText.js';
import { ErrorBox } from '../../components/ui.jsx';
import {
  MODES, FALLBACK_PERIODS, bytesText, changeText, summaryOf, yMaxOf, pathFor, dotsFor, gapMsFor,
  xTicksFor, pointsNote, partialNote, emptyNote, spanNote,
} from './bmStorHistoryText.js';

const H = 150; const PAD_L = 52; const PAD_B = 18; const PAD_T = 8;
/** 점이 이보다 많으면 온전한 점은 찍지 않는다(선만) — 반기 360점이 굵은 띠가 된다. 부분 합 점은 항상 찍는다. */
const DOTS_MAX = 90;

/*
 * ⚠ viewBox 폭을 **실제 폭**에 맞춘다 — 고정 폭(640)으로 두면 1440px 한 칸짜리 차트에서 글자·선이 2배로 커지고
 *   400px 에서는 절반으로 작아진다(v2.635 스크린샷 판독에서 발견). ResizeObserver 로 잰 폭을 그대로 쓴다.
 */
function useWidth(ref, fallback = 640) {
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((es) => { const cw = Math.floor(es[0]?.contentRect?.width || 0); if (cw > 0) setW(cw); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}
const USED = '#60a5fa'; const CAP = 'rgba(148,163,184,0.7)'; const PART = '#fbbf24';

function Chart({ series, from, to, days, intervalHours }) {
  const box = useRef(null);
  const W = Math.max(200, useWidth(box) - PAD_L - 8);
  const yMax = yMaxOf(series);
  const geo = { t0: from, t1: to, w: W, h: H, yMax };
  const used = pathFor(series.points, { ...geo, gapMs: gapMsFor(intervalHours) });
  const cap = pathFor(series.points, { ...geo, gapMs: gapMsFor(intervalHours), pick: 'totalBytes' });
  const allDots = dotsFor(series.points, geo);
  const dots = allDots.length > DOTS_MAX ? allDots.filter((d) => d.partial) : allDots;
  const sum = summaryOf(series);
  const ticksX = xTicksFor(from, to, days);
  return (
    <div ref={box} style={{ minWidth: 0 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={series.name}>
        {series.name}{series.deleted && <span className="badge gray" style={{ marginLeft: 6, fontSize: 10 }}>삭제된 서버</span>}
      </div>
      <div className="muted" style={{ fontSize: 11, lineHeight: 1.5, marginBottom: 2 }}>
        {sum.last
          ? <>최근 {bytesText(sum.last.usedBytes)} / {bytesText(sum.last.totalBytes)}{sum.lastPct != null ? ` (${sum.lastPct}%)` : ''} · 기간 변화 {sum.change == null ? '—' : changeText(sum.change)}</>
          : '온전한 기록 없음'}
        {` · 기록 ${sum.points}`}{sum.partial ? ` · 부분 합 ${sum.partial}` : ''}
      </div>
      <svg viewBox={`0 0 ${W + PAD_L + 8} ${H + PAD_B + PAD_T}`} style={{ width: '100%', height: 'auto', display: 'block', marginBottom: 10 }} role="img" aria-label={`${series.name} 디스크 사용량 추이`}>
        {[0, 0.5, 1].map((f) => {
          const y = PAD_T + H - f * H;
          return (
            <g key={f}>
              <line x1={PAD_L} y1={y} x2={PAD_L + W} y2={y} stroke="currentColor" strokeOpacity="0.12" />
              <text x={PAD_L - 5} y={y + 3} textAnchor="end" fontSize="9" fill="currentColor" fillOpacity="0.55">{f === 0 ? '0' : bytesText(yMax * f)}</text>
            </g>
          );
        })}
        {ticksX.map((tk, i) => (
          <text key={i} x={PAD_L + tk.at * W} y={H + PAD_T + 13} textAnchor={i === 0 ? 'start' : i === ticksX.length - 1 ? 'end' : 'middle'} fontSize="9" fill="currentColor" fillOpacity="0.55">{tk.label}</text>
        ))}
        <g transform={`translate(${PAD_L},${PAD_T})`}>
          {cap && <path d={cap.d} fill="none" stroke={CAP} strokeWidth="1.2" strokeDasharray="4 3" />}
          {used && <path d={used.d} fill="none" stroke={USED} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />}
          {dots.map((d, i) => (
            <circle key={i} cx={d.x} cy={d.y} r={d.partial ? 3 : 2.4} fill={d.partial ? 'none' : USED} stroke={d.partial ? PART : USED} strokeWidth="1.3">
              <title>{`${new Date(d.p.ts).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} · 사용 ${bytesText(d.p.usedBytes)} / ${bytesText(d.p.totalBytes)}${d.partial ? ` · 부분 합(서버 ${d.p.read}/${d.p.servers}대)` : ''}`}</title>
            </circle>
          ))}
        </g>
      </svg>
    </div>
  );
}

export default function BmStorHistoryPanel() {
  const [period, setPeriod] = useState('7d');
  const [mode, setMode] = useState('total');
  const [serverKey, setServerKey] = useState('');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const my = ++seq.current;              // 늦게 온 이전 응답은 버린다(기간·보기를 빠르게 바꿀 때)
    setLoading(true);
    fetchJson(`/tools/bm-storage/history?period=${encodeURIComponent(period)}&kind=${encodeURIComponent(mode)}`)
      .then((d) => { if (my === seq.current) { setData(d); setErr(null); } })
      .catch((e) => { if (my === seq.current) setErr(e || new Error('조회 실패')); })
      .finally(() => { if (my === seq.current) setLoading(false); });
  }, [period, mode]);

  const periods = data?.periods?.length ? data.periods : FALLBACK_PERIODS;
  const per = periods.find((p) => p.key === period) || periods[1];
  const all = useMemo(() => (Array.isArray(data?.series) ? data.series.filter((s) => s.kind === mode) : []), [data, mode]);
  const shown = mode === 'server' ? all.filter((s) => s.key === (serverKey || all[0]?.key)) : all;
  const partialCount = shown.reduce((a, s) => a + summaryOf(s).partial, 0);
  const iv = data?.status?.intervalHours || 12;
  const empty = data && data.kind === mode ? emptyNote({ available: data.available, dbError: data.dbError, status: data.status, seriesCount: all.length, mode }) : '';
  const btn = (on, color) => ({
    fontSize: 12, padding: '2px 9px', borderRadius: 4, color: 'inherit', cursor: loading ? 'wait' : 'pointer',
    background: on ? `${color}2e` : 'transparent', border: '1px solid', borderColor: on ? color : 'var(--border, rgba(255,255,255,0.14))',
  });

  return (
    <div className="card" style={{ marginBottom: 12, padding: 12, minWidth: 0 }}>
      <div className="flex between wrap" style={{ alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <b style={{ fontSize: 13 }}>📈 디스크 사용량 추이</b>
        <div className="flex gap" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          {periods.map((p) => <button key={p.key} style={btn(p.key === period, '#60a5fa')} disabled={loading} onClick={() => setPeriod(p.key)}>{p.label}</button>)}
          <span className="muted" style={{ fontSize: 11, margin: '0 2px' }}>|</span>
          {MODES.map((m) => <button key={m.key} style={btn(m.key === mode, '#a78bfa')} disabled={loading} onClick={() => setMode(m.key)}>{m.label}</button>)}
          {mode === 'server' && all.length > 0 && (
            <select className="input" style={{ padding: '3px 6px', fontSize: 12, maxWidth: 220 }} value={serverKey || all[0].key} onChange={(e) => setServerKey(e.target.value)}>
              {all.map((s) => <option key={s.key} value={s.key}>{s.name}{s.deleted ? ' (삭제됨)' : ''}</option>)}
            </select>
          )}
          {loading && <span className="muted" style={{ fontSize: 11 }}>불러오는 중…</span>}
        </div>
      </div>
      <p className="muted" style={{ margin: '0 0 6px', fontSize: 11.5, lineHeight: 1.6 }}>
        <BoldText text={pointsNote(per, iv)} /> 실선은 사용량, 점선은 총 용량입니다.
        {mode === 'group' && ' 서버가 여러 그룹에 속하면 각 그룹에 모두 더해집니다.'}
      </p>
      {partialCount > 0 && <p className="muted" style={{ margin: '0 0 6px', fontSize: 11.5, color: PART }}><BoldText text={partialNote(partialCount)} /></p>}
      {data && spanNote(data.span, data.from, data.status?.retentionDays) && (
        <p className="muted" style={{ margin: '0 0 6px', fontSize: 11.5 }}><BoldText text={spanNote(data.span, data.from, data.status?.retentionDays)} /></p>
      )}
      {err && !data && <ErrorBox error={errorBoxInput(err)} />}
      {err && data && <div className="muted" style={{ fontSize: 12, color: 'var(--amber)' }}>⚠ 조회 오류: {String(err?.message || err)}</div>}
      {empty && <p className="muted" style={{ fontSize: 12.5, margin: '8px 0' }}><BoldText text={empty} /></p>}
      {data && data.kind === mode && shown.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 440px), 1fr))', gap: 14, minWidth: 0 }}>
          {shown.map((s) => <Chart key={`${s.kind}|${s.key}`} series={s} from={data.from} to={data.to} days={per.days} intervalHours={iv} />)}
        </div>
      )}
    </div>
  );
}
