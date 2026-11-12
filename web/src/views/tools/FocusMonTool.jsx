/**
 * 특수 기능 ‘집중 모니터링’(v2.976) — 리눅스 서버 최대 20대의 CPU · 메모리 · 네트워크(본딩 · 인터페이스별) · 디스크(디스크 · 파티션별 iostat 13칸) ·
 * CPU 상위 30 프로세스를 실시간으로 보고 비교한다. 수집 · 판정은 서버(`/tools/focus-mon/*`), 화면은 문구(focusMonText.js) · 좌표(focusMonChart.js)만.
 * 시안 docs/design/focus-mon(아트보드 9장 — 사용자 컨펌 2026-11-11).
 *
 *  · 주소: `#/tools/focus-mon[/compare|/procs|/targets]` · 서버 상세 `#/tools/focus-mon/server/<id>` — 새로고침해도 같은 화면.
 *  · 폴링: 최근 구간은 수집 주기(2초 등)마다 · 과거 구간은 한 번(갱신하지 않는다) · 탭이 가려지면 멈춘다 · 늦게 온 이전 응답은 버린다 ·
 *    403 · 404 는 다음 틱을 걸지 않는다. 메인(수집 · 대상)은 5초.
 *  · 시간 띠 하나가 그 화면의 모든 차트를 옮긴다(구간 1 · 5 · 10 · 30분 · ◀ 이전 · 슬라이더 · 다음 ▶ · 최신 · 날짜로 이동 — 사용자 요청).
 *  · 숫자(주기 · 대수 · 구간 · 임계)는 응답(limits · settings)에서 읽는다.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, delJson, downloadFile, canCsv, CSV_DENIED_NOTE } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { hashSegments } from '../../hooks/hashTab.js';
import {
  DASH, STATE_TEXT, TEST_TEXT, MODE_TEXT, ENDED_TEXT, sessionIndex, sessionLabel, startNote, joinResultText, TABS, IOSTAT_LABEL, SUMMARY_COLS, METRICS,
  pctText, msText, numText, bpsText, bytesText, sizeText, metricValueText, metricUnitText, iostatText, remainText, clockText, agoShort, etText,
  levelOf, awaitLevel, cardBadge, windowCaption, sessionPill, shouldStopPolling, PIN_COLORS, REST_COLOR, RX_COLOR, TX_COLOR, bulkLine, needsRetry, AUTH_HINT, nameTitle,
  atOptions, atCaption, normAt, editFormOf, editChanges, editNotes, editResultText,
  procDescOf, PROC_STATE_TEXT, procKey, procCoverText, procIoNote, procWaitNote, procThreadNote, PROC_NET_NOTE, PROC_ARGS_NOTE, mbsText, mbText,
  GROUP_NONE, groupLabel, groupSections, groupChips, filterByGroup, groupChipOn, groupSummary, groupStartPlan, groupStartText, groupSuggestions, suggestionText,
} from './focusMonText.js';
import { niceMax, yScale, yTicks, linePath, areaPath, stackedAreas, spreadLabels, heatColor, cellShade, seriesMax, indexAtFrac, valueAtFrac, timeAtIndex, xAtIndex, tipRows } from './focusMonChart.js';
import { Seg, Badge, copyText, CsvPanel, NodeCard, InstallCard } from './FocusMonBulk.jsx';
import './focusMon.css';

const BASE = ['tools', 'focus-mon'];
const ls = () => { try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; } };
const lsGet = (k, d) => { try { const v = ls()?.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { ls()?.setItem(k, JSON.stringify(v)); } catch { /* 사생활 모드 등 */ } };

/* ── 주소 ─────────────────────────────────────────────────────────────────── */
function readRoute() {
  const s = hashSegments(typeof window === 'undefined' ? '' : window.location.hash);
  if (s[0] !== BASE[0] || s[1] !== BASE[1]) return { tab: 'overview', server: '' };
  if (s[2] === 'server' && s[3]) return { tab: 'server', server: decodeURIComponent(s[3]) };
  return { tab: TABS.some((t) => t.key === s[2]) ? s[2] : 'overview', server: '' };
}
function useRoute() {
  const [r, setR] = useState(readRoute);
  useEffect(() => { const on = () => setR(readRoute()); window.addEventListener('hashchange', on); return () => window.removeEventListener('hashchange', on); }, []);
  const go = useCallback((tab, server = '') => {
    window.location.hash = tab === 'server' ? `#/${BASE.join('/')}/server/${encodeURIComponent(server)}` : tab === 'overview' ? `#/${BASE.join('/')}` : `#/${BASE.join('/')}/${tab}`;
  }, []);
  return [r, go];
}

/* ── 조회 훅 ──────────────────────────────────────────────────────────────── */
/** 주기 조회 — 세대 번호로 늦게 온 이전 응답을 버리고, 가려지면 멈추고, 403 · 404 면 다음 틱을 걸지 않는다. intervalMs 0 = 한 번. */
function usePoll(path, params, intervalMs, enabled = true) {
  const [state, setState] = useState({ data: null, error: null, key: '' });
  const key = useMemo(() => `${path}?${new URLSearchParams(Object.entries(params || {}).filter(([, v]) => v != null && v !== '')).toString()}`, [path, params]);
  const gen = useRef(0);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled || !path) return undefined;
    const my = ++gen.current; let timer = null; let alive = true;
    const loop = async () => {
      if (!alive || my !== gen.current) return;
      let stop = false;
      if (typeof document === 'undefined' || !document.hidden) {
        try {
          const d = await fetchJson(path, Object.fromEntries(Object.entries(params || {}).filter(([, v]) => v != null && v !== '')));
          if (alive && my === gen.current) setState({ data: d, error: null, key });
        } catch (e) {
          if (alive && my === gen.current) setState((s) => ({ ...s, error: e }));
          stop = shouldStopPolling(e);
        }
      }
      if (alive && my === gen.current && intervalMs > 0 && !stop) timer = setTimeout(loop, intervalMs);
    };
    loop();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [key, intervalMs, enabled, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, fresh: state.key === key, reload: () => setTick((x) => x + 1) };
}

/* ── 작은 부품 ────────────────────────────────────────────────────────────── */
/* ── 차트 툴팁(v2.977 사용자 요청) — 마우스 · 손가락을 올린 시각의 값을 세로선 · 점 · 값 상자로 보인다 ──
 *  좌표는 순수 함수(focusMonChart.js indexAtFrac · valueAtFrac · timeAtIndex · xAtIndex · tipRows — 테스트). 값이 없으면 ‘—’(0 아님). */
function fracFromEvent(e) {
  const r = e.currentTarget.getBoundingClientRect();
  const cx = e.touches && e.touches.length ? e.touches[0].clientX : e.clientX;
  return r.width > 0 ? Math.max(0, Math.min(1, (cx - r.left) / r.width)) : null;
}
/** SVG 안 맨 위에 두는 투명 판 — 그림 영역(plot)만 덮는다. */
function HoverRect({ plot, onFrac }) {
  const move = (e) => onFrac(fracFromEvent(e));
  return (
    <rect x={plot.x0} y={plot.y0} width={plot.x1 - plot.x0} height={plot.y1 - plot.y0} fill="transparent" style={{ cursor: 'crosshair' }}
      onMouseMove={move} onTouchStart={move} onTouchMove={move} onMouseLeave={() => onFrac(null)} onTouchEnd={() => onFrac(null)} />
  );
}
/** 세로선 + 시리즈마다 점(SVG 안). series: [{key, vals, color, y?}] — 가장 칸이 많은 시리즈에 선을 맞춘다. */
function HoverMarks({ f, plot, y, series, dots = true }) {
  if (f == null) return null;
  const L = Math.max(0, ...series.map((s) => (Array.isArray(s.vals) ? s.vals.length : 0)));
  const x = xAtIndex(indexAtFrac(f, L), L, plot.x0, plot.x1);
  if (x == null) return null;
  return (
    <g pointerEvents="none">
      <line x1={x} x2={x} y1={plot.y0} y2={plot.y1} stroke="var(--text-dim)" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      {dots ? series.map((s) => { const v = valueAtFrac(s.vals, f); return v == null ? null : <circle key={s.key} cx={x} cy={(s.y || y)(v)} r="4" fill={s.color} stroke="var(--panel)" strokeWidth="2" />; }) : null}
    </g>
  );
}
/** 값 상자(HTML — 차트 상자 안 절대 위치). vbw = viewBox 너비. 오른쪽 40% 에서는 선 왼쪽으로 뒤집는다. */
function HoverTip({ f, vbw, plot, time, rows, compact = false }) {
  if (f == null) return null;
  const xPct = ((plot.x0 + f * (plot.x1 - plot.x0)) / vbw) * 100;
  const flip = xPct > 60;
  return (
    <div className={`fm-tip ${compact ? 'sm' : ''}`} role="status" style={{ left: `${xPct}%`, transform: flip ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)' }}>
      <div className="fm-tip-t">{time == null ? DASH : clockText(time)}</div>
      {rows.map((r) => (
        <div key={r.key} className="fm-tip-r">{r.color ? <i style={{ background: r.color }} /> : null}<span className="fm-ell" title={String(r.label ?? '')}>{r.label}</span><b className="fm-num">{r.value}</b></div>
      ))}
    </div>
  );
}
/** 가장 칸이 많은 시리즈 기준으로 그 비율의 시각. */
function hoverTime(f, seriesVals, from, to) {
  const L = Math.max(0, ...seriesVals.map((v) => (Array.isArray(v) ? v.length : 0)));
  return timeAtIndex(indexAtFrac(f, L), L, from, to);
}

function Spark({ vals, color = RX_COLOR, max = 100, h = 24, area = true, hover = null }) {
  const [f, setF] = useState(null);
  const y = yScale({ max, top: 2, bottom: h - 1 });
  const d = linePath(vals, { x0: 0, x1: 100, y });
  const plot = { x0: 0, x1: 100, y0: 0, y1: h };
  return (
    <span className="fm-sparkbox">
      <svg className="fm-spark" viewBox={`0 0 100 ${h}`} preserveAspectRatio="none" aria-hidden="true" style={{ height: h }}>
        {area ? <path d={areaPath(vals, { x0: 0, x1: 100, y, base: h })} fill={color} opacity="0.14" /> : null}
        <path d={d} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        {hover ? <HoverMarks f={f} plot={plot} y={y} series={[{ key: 'v', vals, color }]} dots={false} /> : null}
        {hover ? <HoverRect plot={plot} onFrac={setF} /> : null}
      </svg>
      {hover ? <HoverTip f={f} vbw={100} plot={plot} compact time={hoverTime(f, [vals], hover.from, hover.to)} rows={[{ key: 'v', label: hover.label || '', value: hover.fmt(valueAtFrac(vals, f)) }]} /> : null}
    </span>
  );
}

/* ── 시간 띠 ──────────────────────────────────────────────────────────────── */
function useTimeBar(windows) {
  const [win, setWinRaw] = useState(() => { const w = lsGet('fm.win', 5); return [1, 5, 10, 30].includes(w) ? w : 5; });
  const [end, setEnd] = useState(null);
  const [day, setDay] = useState(''); // '' = 최근 24시간, 'YYYY-MM-DD' = 그 날
  const setWin = (w) => { setWinRaw(w); lsSet('fm.win', w); };
  const ws = Array.isArray(windows) && windows.length ? windows : [1, 5, 10, 30];
  return { win: ws.includes(win) ? win : ws[0], end, setEnd, setWin, day, setDay, windows: ws };
}
function dayRange(day, now) {
  if (!day) return { from: now - 86_400_000, to: now };
  const [y, m, d] = day.split('-').map(Number);
  const from = new Date(y, m - 1, d).getTime();
  return { from, to: Math.min(now, from + 86_400_000) };
}
const ymd = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function TimeBar({ tb, now, coverage, oldestMinute }) {
  const W = tb.win * 60_000;
  const { from: dFrom, to: dTo } = dayRange(tb.day, now);
  const steps = Math.max(1, Math.floor((dTo - dFrom) / W));
  const endNow = tb.end ?? dTo;
  const idx = Math.max(0, Math.min(steps, Math.round((endNow - dFrom) / W)));
  const oldest = oldestMinute != null ? oldestMinute * 60_000 : null;
  const canPrev = oldest == null ? true : endNow - W > oldest;
  const latest = tb.end == null && !tb.day;
  const move = (ms) => {
    const next = Math.min(now, endNow + ms);
    if (next >= now - 2_000) { tb.setEnd(null); tb.setDay(''); return; }
    tb.setEnd(next);
    if (tb.day && (next < dFrom || next > dTo)) tb.setDay(ymd(next));
  };
  const [drag, setDrag] = useState(null);
  const cov = (coverage?.ranges || []).map(([a, b]) => [a * 60_000, (b + 1) * 60_000]);
  const minDate = oldest ? ymd(oldest) : ymd(now - 30 * 86_400_000);
  const caption = windowCaption({ past: !latest, from: endNow - W, to: endNow, win: tb.win });
  return (
    <div className="fm-card fm-tbar">
      <span className="fm-dim">구간</span>
      <Seg label="차트 구간" value={tb.win} options={tb.windows.map((w) => [w, `${w}분`])} onChange={(w) => tb.setWin(w)} />
      <button type="button" className="fm-btn" disabled={!canPrev} onClick={() => move(-W)}>◀ 이전 {tb.win}분</button>
      <span className="fm-slider">
        <input type="range" min={0} max={steps} value={drag ?? idx} aria-label="구간 이동 — 오른쪽 끝이 최신"
          onChange={(e) => setDrag(Number(e.target.value))}
          onMouseUp={() => { if (drag != null) { const t = dFrom + drag * W; setDrag(null); if (t >= now - 2_000) { tb.setEnd(null); } else tb.setEnd(t); } }}
          onTouchEnd={() => { if (drag != null) { const t = dFrom + drag * W; setDrag(null); if (t >= now - 2_000) tb.setEnd(null); else tb.setEnd(t); } }}
          onKeyUp={() => { if (drag != null) { const t = dFrom + drag * W; setDrag(null); if (t >= now - 2_000) tb.setEnd(null); else tb.setEnd(t); } }} />
        <svg viewBox="0 0 1000 6" preserveAspectRatio="none" role="img" aria-label="이 날 기록이 있는 시간">
          <rect x="0" y="0" width="1000" height="6" fill="var(--fm-track)" />
          {cov.map(([a, b], i) => {
            const x = ((Math.max(a, dFrom) - dFrom) / (dTo - dFrom)) * 1000; const w = ((Math.min(b, dTo) - Math.max(a, dFrom)) / (dTo - dFrom)) * 1000;
            return w > 0 ? <rect key={i} x={x} y="0" width={Math.max(1, w)} height="6" fill={RX_COLOR} /> : null;
          })}
        </svg>
      </span>
      <button type="button" className="fm-btn" disabled={latest} onClick={() => move(W)}>다음 {tb.win}분 ▶</button>
      <button type="button" className={`fm-btn ${latest ? 'on' : ''}`} onClick={() => { tb.setEnd(null); tb.setDay(''); }}>최신</button>
      <label className="fm-dim" htmlFor="fm-day">날짜로 이동</label>
      <input id="fm-day" type="date" className="fm-date" value={tb.day || ymd(now)} min={minDate} max={ymd(now)}
        onChange={(e) => { const v = e.target.value; if (!v || v === ymd(now)) { tb.setDay(''); tb.setEnd(null); return; } tb.setDay(v); const r = dayRange(v, now); tb.setEnd(r.to - 1); }} />
      <span className="fm-cap">{caption}</span>
    </div>
  );
}

/* ── 개요 ─────────────────────────────────────────────────────────────────── */
function Overview({ main, ids, tb, now, onOpen }) {
  const [sort, setSort] = useState(() => lsGet('fm.sort', 'cpu'));
  const [node, setNode] = useState('all');
  const [split, setSplit] = useState(() => lsGet('fm.ov.split', 'flat'));
  const params = useMemo(() => ({ view: 'overview', targets: ids.join(','), win: tb.win, end: tb.end ?? '' }), [ids, tb.win, tb.end]);
  const ivMs = Math.max(1, Math.min(...(main.sessions.map((s) => s.interval)), 10) || 2) * 1000;
  const q = usePoll('/tools/focus-mon/data', params, tb.end == null ? ivMs : 0, ids.length > 0);
  const tById = useMemo(() => new Map(main.targets.map((t) => [t.id, t])), [main.targets]);
  const rows = (q.data?.targets || []).map((x) => ({ ...x, t: tById.get(x.id) })).filter((x) => x.t);
  const live = rows.filter((x) => x.sum && x.t.status?.state === 'ok');
  const settings = main.settings;
  // '수집 중' 은 지금 수집하는 수집이 있고 최근 구간을 볼 때만 — 끝난 뒤 · 과거 구간에서는 '값 있음'(v2.979 — 모두 종료 직후에도 '3/4대 수집 중' 이라고 했다)
  const liveNow = tb.end == null && (main.sessions || []).length > 0;
  const kpi = (() => {
    const best = (k) => live.reduce((a, x) => (x.sum?.[k] != null && (a == null || x.sum[k] > a.sum[k]) ? x : a), null);
    const cpuVals = live.map((x) => x.sum.cpu).filter((v) => v != null);
    const bad = rows.filter((x) => x.t.status && x.t.status.state !== 'ok').length;
    return { ok: live.length, bad, none: rows.length - live.length - bad, cpuAvg: cpuVals.length ? cpuVals.reduce((a, b) => a + b, 0) / cpuVals.length : null, cpuMax: best('cpu'), mem: best('mem'), net: best('net'), wa: best('wAwait') };
  })();
  const nodes = useMemo(() => {
    const m = new Map(); for (const x of rows) { const k = x.t.agent || '중앙'; m.set(k, (m.get(k) || 0) + 1); }
    return [['all', `전체 ${rows.length}`], ...[...m.entries()].map(([k, c]) => [k, `${k} ${c}`])];
  }, [rows]);
  const shown = rows.filter((x) => node === 'all' || (x.t.agent || '중앙') === node)
    .sort((a, b) => (sort === 'name' ? String(a.t.name).localeCompare(String(b.t.name)) : (b.sum?.[sort === 'disk' ? 'disk' : sort] ?? -1) - (a.sum?.[sort === 'disk' ? 'disk' : sort] ?? -1)));
  const hasGroups = rows.some((x) => x.t.group);
  const cardOf = (x) => {
    const b = cardBadge(x.t, x.sum, settings);
    const off = x.t.status && x.t.status.state !== 'ok';
    return (
      <div key={x.id} className={`fm-card fm-sv ${b?.tone === 'crit' ? 'crit' : ''} ${off ? 'off' : ''}`}>
        <div className="fm-sv-head">
          <a className="fm-name" title={nameTitle(x.t)} href={`#/${BASE.join('/')}/server/${encodeURIComponent(x.id)}`} onClick={(e) => { e.preventDefault(); onOpen(x.id); }}>{x.t.name}</a>
          <Badge b={b} />
        </div>
        <div className="fm-mono fm-dim fm-ell" title={`${x.t.host} · ${x.t.agent ? `엣지 ${x.t.agent}` : '중앙'}`}>{x.t.host} · {x.t.agent ? `엣지 ${x.t.agent}` : '중앙'}</div>
        {[['CPU', 'cpu', x.sum?.cpu, levelOf(x.sum?.cpu, settings)], ['메모리', 'mem', x.sum?.mem, levelOf(x.sum?.mem, settings)], ['네트워크', 'net', x.sum?.net, levelOf(x.sum?.net, settings)], ['디스크', 'disk', x.sum?.disk, levelOf(x.sum?.disk, settings)]].map(([lab, k, v, lv]) => (
          <div key={k} className="fm-mrow"><span className="fm-dim">{lab}</span><span className={`fm-mv ${lv}`}>{v == null ? DASH : `${Math.round(v)}%`}</span><Spark vals={x.series?.[k]} hover={{ from: q.data?.from, to: q.data?.to, label: lab, fmt: (u) => pctText(u) }} /></div>
        ))}
        <div className="fm-sub"><span>{x.sum ? `↓${bpsText(x.sum.netRx)} ↑${bpsText(x.sum.netTx)}` : DASH}</span><span>쓰기 지연 {msText(x.sum?.wAwait)}</span></div>
        {off ? <div className="fm-why">{x.t.status?.error || STATE_TEXT[x.t.status?.state]?.label}</div> : null}
      </div>
    );
  };
  if (!ids.length) return <div className="fm-card fm-empty">볼 서버가 없습니다 — ‘대상 · 키’ 탭에서 서버를 고르고 모니터링을 시작하세요.</div>;
  return (
    <>
      {q.error && !q.data ? <ErrorBox error={q.error} /> : null}
      <div className="fm-kpis">
        <div className="fm-card fm-kpi"><span className="l">수집 상태</span><span className="v">{kpi.ok}<small>/ {rows.length}대 {liveNow ? '수집 중' : '값 있음'}</small></span><span className="s">{kpi.ok === rows.length ? '모두 정상' : [kpi.bad ? `정상이 아닌 서버 ${kpi.bad}대` : '', kpi.none ? `이 구간에 값이 없는 서버 ${kpi.none}대` : ''].filter(Boolean).join(' · ')}</span></div>
        <div className="fm-card fm-kpi"><span className="l">CPU 사용률 — 평균</span><span className="v">{kpi.cpuAvg == null ? DASH : Math.round(kpi.cpuAvg)}{kpi.cpuAvg == null ? null : <small>%</small>}</span><span className="s">{kpi.cpuMax ? `${liveNow ? '수집 중' : '값이 있는'} ${kpi.ok}대 평균 · 최고 ${kpi.cpuMax.t.name} ${pctText(kpi.cpuMax.sum.cpu)}` : DASH}</span></div>
        <div className="fm-card fm-kpi"><span className="l">메모리 사용률 — 최고</span><span className="v">{kpi.mem ? Math.round(kpi.mem.sum.mem) : DASH}{kpi.mem ? <small>%</small> : null}</span><span className="s">{kpi.mem?.t.name || DASH}</span></div>
        <div className="fm-card fm-kpi"><span className="l">네트워크 사용률 — 최고</span><span className="v">{kpi.net ? Math.round(kpi.net.sum.net) : DASH}{kpi.net ? <small>%</small> : null}</span><span className="s">{kpi.net ? `${kpi.net.t.name} ${kpi.net.sum.netIf || ''} · 수신 ${bpsText(kpi.net.sum.netRx)}` : DASH}</span></div>
        <div className="fm-card fm-kpi"><span className="l">디스크 쓰기 지연 — 최고</span><span className="v">{kpi.wa ? numText(kpi.wa.sum.wAwait, 1) : DASH}{kpi.wa ? <small>ms</small> : null}</span><span className="s">{kpi.wa ? `${kpi.wa.t.name} · 가장 바쁜 디스크 ${kpi.wa.sum.diskDev || ''} ${pctText(kpi.wa.sum.disk)}` : DASH}</span></div>
      </div>
      <div className="fm-row fm-between">
        <div className="fm-row">
          <span className="fm-dim">정렬</span>
          <Seg label="정렬 기준" value={sort} onChange={(v) => { setSort(v); lsSet('fm.sort', v); }} options={[['cpu', 'CPU 높은 순'], ['mem', '메모리'], ['net', '네트워크'], ['disk', '디스크'], ['name', '이름']]} />
          <span className="fm-dim">담당 노드</span>
          <Seg label="담당 노드" value={node} onChange={setNode} options={nodes} />
          {hasGroups ? <><span className="fm-dim">나눠 보기</span><Seg label="나눠 보기" value={split} onChange={(v) => { setSplit(v); lsSet('fm.ov.split', v); }} options={[['flat', '한 판'], ['group', '그룹별로']]} /></> : null}
        </div>
        <span className="fm-dim">세로축 0~100% 공통 · 숫자는 구간 끝의 값</span>
      </div>
      <div className="fm-grid">
        {split === 'group' && hasGroups ? groupSections(shown.map((x) => ({ ...x.t, _row: x })), main.groups?.list).flatMap((sec) => {
          // v2.982 그룹별로 나눠 보기 — 그룹 머리(대수 · 평균 CPU · 가장 바쁜 서버) 뒤에 그 그룹 카드(정렬 · 노드 거르기는 그대로)
          const rs = sec.targets.map((t) => t._row);
          const g = groupSummary(rs);
          return [
            <div key={`gh-${sec.key}`} className="fm-gview"><h4>{sec.label}</h4><span className="fm-dim">{g.n}대 · 평균 CPU {g.avg == null ? DASH : pctText(g.avg)}{g.valued < g.n && g.avg != null ? `(값 있는 ${g.valued}대)` : ''} · 가장 바쁜 {g.top ? `${g.top.name} ${pctText(g.top.cpu)}` : DASH}</span></div>,
            ...rs.map(cardOf),
          ];
        }) : shown.map(cardOf)}
      </div>
      <div className="fm-note">네트워크 = 본딩 인터페이스(없으면 올라온 물리 인터페이스)의 수신 · 송신 중 큰 쪽 ÷ 링크 속도 · 디스크 = 물리 디스크 사용률(%util) 중 최고. 엣지에 연결된 서버는 엣지가 모아 보내므로 몇 초 늦게 보입니다.</div>
    </>
  );
}

/* ── 지표 비교 ─────────────────────────────────────────────────────────────── */
function Compare({ main, ids, tb, now, onOpen }) {
  const [metric, setMetric] = useState(() => lsGet('fm.cmp.metric', 'disk'));
  const mdef = METRICS.find((m) => m.key === metric) || METRICS[0];
  const [item, setItem] = useState(() => lsGet('fm.cmp.item', 'wAwait'));
  const it = mdef.items.some(([k]) => k === item) ? item : mdef.items[0][0];
  const [scope, setScope] = useState('all');
  const [scopeText, setScopeText] = useState('');
  const [pins, setPins] = useState([]);
  const [hf, setHf] = useState(null);
  const pinTouched = useRef(false);
  const [log, setLog] = useState(false);
  const scopeParam = metric === 'disk' ? (scope === 'all' ? 'all' : scope === 'mount' ? `mount:${scopeText}` : `dev:${scopeText}`) : metric === 'net' ? (scope === 'if' && scopeText ? `if:${scopeText}` : 'top') : 'all';
  const params = useMemo(() => ({ view: 'compare', targets: ids.join(','), win: tb.win, end: tb.end ?? '', metric, item: it, scope: scopeParam }), [ids, tb.win, tb.end, metric, it, scopeParam]);
  const q = usePoll('/tools/focus-mon/data', params, tb.end == null ? 2_000 : 0, ids.length > 0);
  const tById = useMemo(() => new Map(main.targets.map((t) => [t.id, t])), [main.targets]);
  const rows = (q.data?.targets || []).filter((x) => tById.has(x.id));
  const pinned = pins.filter((p) => rows.some((r) => r.id === p)).slice(0, 4);
  const pinColor = new Map(pinned.map((p, i) => [p, PIN_COLORS[i]]));
  const unit = metricUnitText(metric, it);
  const pct = unit === '%';
  const max = pct ? 100 : niceMax(seriesMax(rows.map((r) => r.max)) ?? 1);
  const X0 = 46; const X1 = 776; const Y0 = 14; const Y1 = 330;
  const cmpPlot = { x0: X0, x1: X1, y0: Y0, y1: Y1 };
  const y = yScale({ max, log: log && !pct, top: Y0, bottom: Y1 });
  const ticks = yTicks(max, log && !pct);
  const labels = spreadLabels(pinned.map((p) => { const r = rows.find((x) => x.id === p); return { key: p, y: r?.last != null ? y(r.last) : null }; }));
  const ranked = rows.slice().sort((a, b) => (b.last ?? -1) - (a.last ?? -1));
  const top = ranked.find((r) => r.last != null)?.last || 1;
  const togglePin = (id) => { pinTouched.current = true; setPins((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-4))); };
  useEffect(() => {
    if (pinTouched.current || pins.length || !q.data) return;
    const top3 = (q.data.targets || []).filter((r) => r.last != null).sort((a, b) => b.last - a.last).slice(0, 3).map((r) => r.id);
    if (top3.length) { pinTouched.current = true; setPins(top3); }
  }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const heatMax = seriesMax(rows.map((r) => r.avg)) || 1;
  const itemLabel = (k, t) => (metric === 'disk' ? `${IOSTAT_LABEL[k]} ` : t);
  const csvHref = `/tools/focus-mon/export.csv?${new URLSearchParams({ kind: 'series', targets: ids.join(','), win: String(tb.win), end: tb.end ? String(tb.end) : '', metric, item: it, scope: scopeParam }).toString()}`;
  return (
    <>
      <div className="fm-card fm-ctl">
        <div className="fm-row"><span className="fm-lbl">지표</span>
          <Seg label="지표" value={metric} onChange={(v) => { setMetric(v); lsSet('fm.cmp.metric', v); setScope('all'); setScopeText(''); }} options={METRICS.map((m) => [m.key, m.label])} />
          {metric === 'disk' ? <span className="fm-dim">디스크 항목은 iostat -x -m 의 13개 열 그대로입니다</span> : null}
        </div>
        <div className="fm-row fm-top"><span className="fm-lbl">항목</span>
          <div className="fm-seg wrap" role="group" aria-label="항목">
            {mdef.items.map(([k, t]) => <button key={k} type="button" className={it === k ? 'on' : ''} onClick={() => { setItem(k); lsSet('fm.cmp.item', k); }}>{itemLabel(k, t)}{metric === 'disk' ? <span className="fm-io">{({ rrqm: 'rrqm/s', wrqm: 'wrqm/s', r: 'r/s', w: 'w/s', rMB: 'rMB/s', wMB: 'wMB/s', rqsz: 'avgrq-sz', qu: 'avgqu-sz', await: 'await', rAwait: 'r_await', wAwait: 'w_await', svctm: 'svctm', util: '%util' })[k]}</span> : null}</button>)}
          </div>
        </div>
        {metric === 'disk' || metric === 'net' ? (
          <div className="fm-row"><span className="fm-lbl">범위</span>
            <Seg label="범위" value={scope} onChange={setScope} options={metric === 'disk' ? [['all', '전체 디스크'], ['mount', '같은 마운트 지점'], ['dev', '장치 지정']] : [['all', '대표(본딩 · 물리)'], ['if', '인터페이스 지정']]} />
            {scope !== 'all' ? <input className="fm-input" value={scopeText} onChange={(e) => setScopeText(e.target.value.slice(0, 200))} placeholder={scope === 'mount' ? '/oradata' : scope === 'dev' ? 'sdb' : 'bond0'} aria-label="범위 값" /> : null}
            <span className="fm-dim">{metric === 'disk' ? '전체 디스크 = 서버마다 물리 디스크의 요청 수로 가중한 평균(사용률은 최고값)' : '대표 = 본딩(없으면 본딩에 묶이지 않은 물리) 수신 · 송신 합'}</span>
          </div>
        ) : null}
        <div className="fm-row"><span className="fm-lbl">고정</span>
          {pinned.map((p) => <span key={p} className="fm-pin" title={nameTitle(tById.get(p))}><i style={{ background: pinColor.get(p) }} />{tById.get(p)?.name}<button type="button" aria-label="고정 해제" onClick={() => togglePin(p)}>×</button></span>)}
          <span className="fm-dim">색은 고정한 서버에만 줍니다(최대 4대 · 처음에는 높은 순 3대) · 나머지는 회색 선 · 순위의 서버 이름을 누르면 고정이 바뀝니다</span>
        </div>
      </div>
      {q.error && !q.data ? <ErrorBox error={q.error} /> : null}
      <div className="fm-split">
        <div className="fm-card fm-chart-card">
          <div className="fm-row fm-between">
            <h3 className="fm-h3">{mdef.label} {metric === 'disk' ? IOSTAT_LABEL[it] : (mdef.items.find(([k]) => k === it)?.[1] || '')} — 최근 {tb.win}분</h3>
            <div className="fm-row">
              <span className="fm-dim">{unit ? `단위 ${unit}` : ''}</span>
              {!pct ? <Seg label="눈금" value={log ? 'log' : 'lin'} onChange={(v) => setLog(v === 'log')} options={[['lin', '선형'], ['log', '로그']]} /> : null}
              {canCsv() ? <button type="button" className="fm-btn" onClick={() => downloadFile(csvHref).catch(() => {})}>CSV</button> : <span className="fm-dim" title={CSV_DENIED_NOTE}>CSV 권한 없음</span>}
            </div>
          </div>
          <div className="fm-chart-wrap fm-chart-box">
            <svg viewBox="0 0 900 360" role="img" aria-label={`서버 ${rows.length}대의 ${mdef.label} 추이 — 고정한 서버는 색 선, 나머지는 회색 선`} className="fm-chart">
              {ticks.map((v) => <g key={v}><line x1={X0} x2={X1} y1={y(v)} y2={y(v)} stroke="var(--fm-grid)" /><text x={X0 - 6} y={y(v) + 4} className="fm-axis" textAnchor="end">{v >= 1000 ? `${Math.round(v / 1000)}K` : Math.round(v * 100) / 100}</text></g>)}
              <text x={X0} y={352} className="fm-axis">{clockText(q.data?.from)}</text>
              <text x={X1} y={352} className="fm-axis" textAnchor="end">{tb.end == null ? '지금' : clockText(q.data?.to)}</text>
              {rows.filter((r) => !pinColor.has(r.id)).map((r) => <path key={r.id} d={linePath(r.avg, { x0: X0, x1: X1, y })} fill="none" stroke={REST_COLOR} strokeWidth="1" />)}
              {rows.filter((r) => pinColor.has(r.id)).map((r) => (
                <g key={r.id}>
                  <path d={linePath(r.avg, { x0: X0, x1: X1, y })} fill="none" stroke={pinColor.get(r.id)} strokeWidth="2" strokeLinejoin="round" />
                  {r.last != null ? <circle cx={X1} cy={y(r.last)} r="4.5" fill={pinColor.get(r.id)} stroke="var(--panel)" strokeWidth="2" /> : null}
                  {labels[r.id] != null ? <text x={X1 + 10} y={labels[r.id] + 4} className="fm-endl">{tById.get(r.id)?.name} {metricValueText(metric, it, r.last)}</text> : null}
                </g>
              ))}
              <HoverMarks f={hf} plot={cmpPlot} y={y} series={rows.map((r) => ({ key: r.id, vals: r.avg, color: pinColor.get(r.id) || REST_COLOR }))} />
              <HoverRect plot={cmpPlot} onFrac={setHf} />
            </svg>
            <HoverTip f={hf} vbw={900} plot={cmpPlot} time={hoverTime(hf, rows.map((r) => r.avg), q.data?.from, q.data?.to)}
              rows={tipRows(rows.map((r) => ({ key: r.id, label: tById.get(r.id)?.name || r.id, color: pinColor.get(r.id) || REST_COLOR, vals: r.avg, pinned: pinColor.has(r.id) })), hf).map((r) => ({ ...r, value: r.v == null ? DASH : metricValueText(metric, it, r.v) }))} />
          </div>
          {rows.some((r) => r.missing === 'no-series') ? <div className="fm-note">{rows.filter((r) => r.missing).length}대는 이 범위의 값이 없습니다(그 장치 · 마운트 · 인터페이스가 없거나 아직 표본이 없음).</div> : null}
        </div>
        <div className="fm-card fm-rank">
          <div className="fm-row fm-between"><h3 className="fm-h3">지금 — 높은 순</h3><span className="fm-dim">{unit}</span></div>
          {ranked.map((r, i) => (
            <div key={r.id} className="fm-rk">
              <span className="fm-dim">{i + 1}</span>
              <button type="button" className="fm-linkbtn fm-ell" onClick={() => togglePin(r.id)} title={nameTitle(tById.get(r.id), '눌러서 차트에 고정')}>{tById.get(r.id)?.name}</button>
              <span><span className="fm-bar" style={{ width: `${r.last == null ? 0 : Math.max(1.5, (r.last / top) * 100)}%`, background: pinColor.get(r.id) || '#4b5b7a' }} /></span>
              <span className="fm-num">{r.last == null ? DASH : metricValueText(metric, it, r.last)}</span>
            </div>
          ))}
          <div className="fm-note">‘—’ 은 그 구간에 값이 없다는 뜻입니다(디스크 지연은 요청이 없으면 값이 없습니다). 0 이 아닙니다.</div>
        </div>
      </div>
      <div className="fm-card">
        <div className="fm-row fm-between"><h3 className="fm-h3">{rows.length}대 × 시간</h3><span className="fm-dim">어두움 낮음 → 밝음 높음(로그 비율) · 검은 칸 = 값 없음 · 칸 폭은 모든 서버가 같습니다(고른 서버 가운데 표본이 가장 성긴 서버에 맞춤)</span></div>
        <div className="fm-heat">
          {ranked.map((r) => (
            <div key={r.id} className="fm-hm">
              <button type="button" className="fm-linkbtn fm-ell" onClick={() => onOpen(r.id)} title={nameTitle(tById.get(r.id), '눌러서 서버 상세')}>{tById.get(r.id)?.name}</button>
              <svg viewBox={`0 0 ${r.avg.length || 1} 10`} preserveAspectRatio="none" aria-hidden="true">{r.avg.map((v, k) => <rect key={k} x={k} y="0" width="0.94" height="10" fill={heatColor(v, heatMax)}><title>{`${tById.get(r.id)?.name || r.id} · ${clockText(timeAtIndex(k, r.avg.length, q.data?.from, q.data?.to))} · ${v == null ? '값 없음' : metricValueText(metric, it, v)}`}</title></rect>)}</svg>
              <span className="fm-num">{r.last == null ? DASH : metricValueText(metric, it, r.last)}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/* ── iostat 비교 ───────────────────────────────────────────────────────────── */
function IostatCompare({ main, ids, tb, onOpen }) {
  const [scope, setScope] = useState('phys');
  const [at, setAt] = useState('end');
  const [arrange, setArrange] = useState('group');
  const [hideQuiet, setHideQuiet] = useState(true);
  const [find, setFind] = useState('');
  const [col, setCol] = useState('wAwait');
  const [pins, setPins] = useState([]);
  const [hf, setHf] = useState(null);
  const cols = main.iostat?.cols || [];
  const params = useMemo(() => ({ view: 'iostat', targets: ids.join(','), win: tb.win, end: tb.end ?? '', at, scope, col, pins: pins.join(',') }), [ids, tb.win, tb.end, at, scope, col, pins]);
  const q = usePoll('/tools/focus-mon/data', params, tb.end == null ? 2_000 : 0, ids.length > 0);
  const tById = useMemo(() => new Map(main.targets.map((t) => [t.id, t])), [main.targets]);
  const rows = (q.data?.rows || []).filter((r) => tById.has(r.id));
  const quiet = (d) => (d.v[2] ?? 0) === 0 && (d.v[3] ?? 0) === 0 && !d.stuck;
  const f = find.trim().toLowerCase();
  const match = (d) => !f || d.n.toLowerCase().includes(f) || (d.mp || '').toLowerCase().includes(f) || (d.dn || '').toLowerCase().includes(f);
  const colMax = cols.map((_, i) => Math.max(0, ...rows.flatMap((r) => r.devices.map((d) => d.v[i] ?? 0))));
  const pinIdx = new Map(pins.map((p, i) => [p, i]));
  const togglePin = (key) => setPins((p) => (p.includes(key) ? p.filter((x) => x !== key) : [...p, key].slice(-4)));
  const devRow = (r, d, merged) => {
    const key = `${r.id}/${d.n}`;
    return (
      <tr key={key}>
        <td><button type="button" className="fm-pk" aria-label="차트에 올리기" style={pinIdx.has(key) ? { background: PIN_COLORS[pinIdx.get(key)], borderColor: PIN_COLORS[pinIdx.get(key)] } : undefined} onClick={() => togglePin(key)} /></td>
        <td className="fm-mono fm-ell" title={`${merged ? `${nameTitle(tById.get(r.id))} · ` : ''}${d.n}${d.dn ? ` (${d.dn})` : ''}${d.mp ? ` · ${d.mp}` : ''}`}>{merged ? `${tById.get(r.id)?.name} · ` : ''}{d.n}{d.dn ? ` (${d.dn})` : ''}{d.stuck ? <span className="fm-badge crit">응답 없음</span> : null}</td>
        {d.v.map((v, i) => <td key={cols[i]} className="fm-r fm-num" data-sort={v ?? null} style={{ background: cellShade(v, colMax[i]) || undefined }}>{iostatText(cols[i], v)}</td>)}
      </tr>
    );
  };
  const head = (
    <thead><tr><th data-nosort aria-label="차트" /><th>장치</th>{cols.map((c) => <th key={c} className="fm-r" onClick={() => setCol(c)} title="차트도 이 열로">{main.iostat.names[c]}<br /><small className="fm-dim">{IOSTAT_LABEL[c]}</small></th>)}</tr></thead>
  );
  const pinSeries = q.data?.series || [];
  const max = niceMax(seriesMax(pinSeries.map((s) => s.max)) ?? 1);
  const X0 = 46; const X1 = 1120;
  const y = yScale({ max, top: 14, bottom: 270 });
  const ioPlot = { x0: X0, x1: X1, y0: 14, y1: 270 };
  return (
    <>
      <div className="fm-card fm-ctl">
        <div className="fm-row"><span className="fm-lbl">장치</span>
          <Seg label="장치 범위" value={scope} onChange={setScope} options={[['phys', '물리 디스크'], ['all', '파티션 · 볼륨 포함']]} />
          <input className="fm-input" value={find} onChange={(e) => setFind(e.target.value.slice(0, 64))} placeholder="장치 · 마운트 (예: sdb, /oradata)" aria-label="장치 찾기" />
          <label className="fm-row fm-chk"><input type="checkbox" checked={hideQuiet} onChange={(e) => setHideQuiet(e.target.checked)} />조용한 장치 숨기기</label>
          <span className="fm-lbl">배치</span><Seg label="배치" value={arrange} onChange={setArrange} options={[['group', '서버별로 묶기'], ['mix', '한 표로 섞어 정렬']]} />
          <span className="fm-lbl">값</span><Seg label="값의 시점" value={at} onChange={setAt} options={[['end', '구간 끝 순간'], ['avg', '구간 평균']]} />
        </div>
      </div>
      {q.error && !q.data ? <ErrorBox error={q.error} /> : null}
      <div className="fm-card fm-flush">
        <div className="fm-row fm-between fm-pad"><h3 className="fm-h3">고른 서버 {rows.length}대의 iostat — {at === 'avg' ? '구간 평균' : '구간 끝 순간'}</h3>
          <div className="fm-row"><span className="fm-dim">칸이 짙을수록 그 열에서 큰 값 · 열 제목을 누르면 정렬 · 줄 앞 네모를 누르면 아래 차트에 올림(4줄까지)</span>
            {canCsv() ? <button type="button" className="fm-btn" onClick={() => downloadFile(`/tools/focus-mon/export.csv?${new URLSearchParams({ kind: 'iostat', targets: ids.join(','), win: String(tb.win), end: tb.end ? String(tb.end) : '', at, scope }).toString()}`).catch(() => {})}>CSV</button> : null}</div>
        </div>
        {arrange === 'mix' ? (
          <STable className="fm-table fm-io" minWidth={1060}>
            {head}
            <tbody>{rows.flatMap((r) => r.devices.filter((d) => (!hideQuiet || !quiet(d)) && match(d)).map((d) => devRow(r, d, true)))}</tbody>
          </STable>
        ) : rows.map((r) => {
          const devs = r.devices.filter((d) => (!hideQuiet || !quiet(d)) && match(d));
          const hidden = r.devices.length - devs.length;
          return (
            <div key={r.id} className="fm-group">
              <div className="fm-gh"><button type="button" className="fm-linkbtn" onClick={() => onOpen(r.id)}><b>{tById.get(r.id)?.name}</b></button><span className="fm-mono fm-dim">{tById.get(r.id)?.host} · {tById.get(r.id)?.agent ? `엣지 ${tById.get(r.id)?.agent}` : '중앙'}</span><span className="fm-dim">장치 {r.devices.length}개{hidden ? ` · ${hidden}개 숨김` : ''}</span></div>
              <STable className="fm-table fm-io" minWidth={1060}>
                {head}
                <tbody>
                  {r.total ? <tr className="fm-sum"><td /><td>전체 디스크</td>{r.total.map((v, i) => <td key={cols[i]} className="fm-r fm-num">{iostatText(cols[i], v)}</td>)}</tr> : null}
                  {devs.map((d) => devRow(r, d, false))}
                </tbody>
              </STable>
            </div>
          );
        })}
        <div className="fm-note fm-pad">모든 서버의 값은 같은 시각으로 맞춥니다(서버마다 가장 가까운 표본). ‘구간 평균’ 은 요청 수로 가중해 다시 계산합니다 — 끝난 요청이 없으면 ‘—’, 걸린 요청만 있으면 ‘응답 없음’ 입니다. 열 이름은 iostat -x -m 그대로입니다.</div>
      </div>
      <div className="fm-card">
        <div className="fm-row fm-between"><h3 className="fm-h3">차트에 올린 장치 {pinSeries.length}개 — {main.iostat.names[col]}({IOSTAT_LABEL[col]})</h3>
          <div className="fm-row">{pinSeries.map((s, i) => <span key={s.pin} className="fm-lg" title={`${nameTitle(tById.get(s.pin.split('/')[0]))} · ${s.pin.split('/')[1]}`}><i style={{ background: PIN_COLORS[i] }} />{tById.get(s.pin.split('/')[0])?.name} · {s.pin.split('/')[1]}</span>)}</div></div>
        {pinSeries.length ? (
          <div className="fm-chart-wrap fm-chart-box">
            <svg viewBox="0 0 1180 300" role="img" aria-label="차트에 올린 장치의 추이" className="fm-chart">
              {yTicks(max).map((v) => <g key={v}><line x1={X0} x2={X1} y1={y(v)} y2={y(v)} stroke="var(--fm-grid)" /><text x={X0 - 6} y={y(v) + 4} className="fm-axis" textAnchor="end">{Math.round(v * 100) / 100}</text></g>)}
              {pinSeries.map((s, i) => <path key={s.pin} d={linePath(s.avg, { x0: X0, x1: X1, y })} fill="none" stroke={PIN_COLORS[i]} strokeWidth="2" />)}
              <text x={X0} y={292} className="fm-axis">{clockText(q.data?.from)}</text><text x={X1} y={292} className="fm-axis" textAnchor="end">{tb.end == null ? '지금' : clockText(q.data?.to)}</text>
              <HoverMarks f={hf} plot={ioPlot} y={y} series={pinSeries.map((s, i) => ({ key: s.pin, vals: s.avg, color: PIN_COLORS[i] }))} />
              <HoverRect plot={ioPlot} onFrac={setHf} />
            </svg>
            <HoverTip f={hf} vbw={1180} plot={ioPlot} time={hoverTime(hf, pinSeries.map((s) => s.avg), q.data?.from, q.data?.to)}
              rows={pinSeries.map((s, i) => { const v = valueAtFrac(s.avg, hf); return { key: s.pin, color: PIN_COLORS[i], label: `${tById.get(s.pin.split('/')[0])?.name || ''} · ${s.pin.split('/')[1]}`, value: iostatText(col, v) }; })} />
          </div>
        ) : <div className="fm-note">줄 앞 네모를 누르면 그 장치가 여기 올라옵니다. 열 제목을 누르면 차트도 그 열로 바뀝니다(지금 {main.iostat.names[col]}).</div>}
      </div>
    </>
  );
}

/* ── 서버 상세 ────────────────────────────────────────────────────────────── */
function ServerDetail({ main, id, tb, now, onBack }) {
  // v2.979: 표의 값(구간 끝 순간 | 구간 평균)은 화면 맨 위 · 네트워크 카드 · 디스크 카드 세 곳의 단추가 같은 상태를 쓴다(하나를 바꾸면 셋이 같이 바뀐다) · 브라우저가 기억한다.
  const [at, setAtRaw] = useState(() => normAt(lsGet('fm.srv.at', 'end')));
  const setAt = (v) => { const x = normAt(v); setAtRaw(x); lsSet('fm.srv.at', x); };
  const [cols, setCols] = useState(() => lsGet('fm.dsk.cols', 'summary'));
  const [tree, setTree] = useState('tree');
  const [dev, setDev] = useState('');
  const [netAll, setNetAll] = useState(false);
  const [hCpu, setHCpu] = useState(null); const [hMem, setHMem] = useState(null); const [hT, setHT] = useState(null); const [hL, setHL] = useState(null);
  const [openProc, setOpenProc] = useState(null); // v2.981 펼친 프로세스 { k(procKey), p } — 표에서 빠져도 세부 정보는 계속 본다
  const t = main.targets.find((x) => x.id === id);
  const params = useMemo(() => ({ view: 'server', targets: id, win: tb.win, end: tb.end ?? '', at, dev }), [id, tb.win, tb.end, at, dev]);
  const q = usePoll('/tools/focus-mon/data', params, tb.end == null ? 2_000 : 0, !!t);
  // 프로세스 상위 5 도 같은 값(구간 끝 순간 | N분 평균)을 따른다 — 예전에는 늘 끝 순간이라 평균을 고른 화면 안에서 이 카드만 달랐다(v2.979 반증 6).
  const pq = usePoll('/tools/focus-mon/procs', useMemo(() => ({ targets: id, win: tb.win, end: tb.end ?? '', at }), [id, tb.win, tb.end, at]), tb.end == null ? 5_000 : 0, !!t);
  if (!t) return <div className="fm-card fm-empty">없는 서버입니다. <button type="button" className="fm-btn" onClick={onBack}>개요로</button></div>;
  const d = q.data;
  const tab = d?.table;
  // 지금 보는 값 — 응답이 실제로 덮는 시간으로 말한다(수집이 끝났거나 구간 일부만 있으면 그대로 밝힌다 · v2.979 반증 2).
  const ivSec = Number(t?.status?.interval) > 0 ? Number(t.status.interval) : (main.limits?.defaultInterval || 2);
  const atText = atCaption(at, { win: tb.win, past: tb.end != null, lastAt: d?.lastAt ?? null, coverMs: d?.coverMs ?? null, now, staleMs: ivSec * 3_000 + 2_000 });
  const settings = main.settings;
  const hello = d?.hello || t.status?.hello;
  const X0 = 34; const X1 = 632;
  const yc = yScale({ max: 100, top: 10, bottom: 190 });
  const layers = d ? stackedAreas([d.charts.cpu.usr, d.charts.cpu.sys, d.charts.cpu.iow, d.charts.cpu.stl], { x0: X0, x1: X1, y: yc }) : [];
  const LC = [RX_COLOR, TX_COLOR, '#199e70', '#c98500'];
  const ym = yScale({ max: 100, top: 10, bottom: 126 });
  const cpuPlot = { x0: X0, x1: X1, y0: 10, y1: 190 }; const memPlot = { x0: X0, x1: X1, y0: 10, y1: 126 }; const devPlot = { x0: X0, x1: X1, y0: 10, y1: 176 };
  const cpuParts = d ? [d.charts.cpu.usr, d.charts.cpu.sys, d.charts.cpu.iow, d.charts.cpu.stl] : [];
  const cpuTot = d ? (d.charts.cpu.usr || []).map((_, i) => { let sum = 0; for (const a of cpuParts) { const v = a?.[i]; if (v == null) return null; sum += v; } return Math.round(sum * 100) / 100; }) : [];
  const mem = tab?.mem;
  const nets = (tab?.net || []).filter((x) => netAll || x.k !== 'virt');
  const netTree = [];
  for (const x of nets.filter((x) => !x.m || !nets.some((b) => b.n === x.m))) { netTree.push([x, 0]); for (const c of nets.filter((c) => c.m === x.n)) netTree.push([c, 1]); }
  const netSpark = new Map((d?.charts?.net || []).map((x) => [x.n, x]));
  const dsks = tab?.dsk || [];
  const depth = (x, seen = new Set()) => { if (!x.p || seen.has(x.n)) return 0; seen.add(x.n); const p = dsks.find((y) => y.n === x.p); return p ? 1 + depth(p, seen) : 0; };
  const order = [];
  const visit = (x) => { order.push(x); for (const c of dsks.filter((c) => c.p === x.n)) visit(c); };
  for (const x of dsks.filter((x) => !x.p || !dsks.some((y) => y.n === x.p))) visit(x);
  const shownDsk = order.filter((x) => tree === 'tree' || (tree === 'phys' ? x.k === 'disk' : x.k !== 'disk'));
  const dspark = new Map((d?.charts?.dsk || []).map((x) => [x.n, x.wAwait]));
  const allCols = main.iostat?.cols || [];
  const showCols = cols === 'iostat' ? allCols : SUMMARY_COLS;
  const colIdx = (c) => allCols.indexOf(c);
  const devC = d?.dev;
  const yt = yScale({ max: niceMax(seriesMax([devC?.rMB, devC?.wMB]) ?? 1), top: 10, bottom: 176 });
  const ylMax = niceMax(seriesMax([devC?.rAwait, devC?.wAwait]) ?? 1);
  const yl = yScale({ max: ylMax, top: 10, bottom: 176 });
  const procs = pq.data?.per?.[0]?.top || [];
  // 카드 제목이 'CPU 상위 5' — CPU 순 5개를 먼저 고른 뒤 그 안에서 정렬한다(v2.976 부터 같은 동작). STable limit(정렬 뒤 자르기)이면
  // 메모리 · PID 로 정렬할 때 CPU 상위 5 가 아닌 프로세스가 보여 제목과 어긋난다. 30개 전부는 '상위 30개 전부 보기'(프로세스 탭 · 정렬 뒤 자르기 없음).
  const top5 = procs.slice(0, 5);
  return (
    <>
      <div className="fm-row fm-between">
        <div className="fm-col">
          <div className="fm-row"><h2 className="fm-h2">{t.name}</h2><Badge b={cardBadge(t, d?.summary, settings)} /></div>
          <div className="fm-mono fm-dim fm-brk">{t.host} · {t.agent ? `엣지 ${t.agent}` : '중앙'}{hello ? ` · ${hello.release || hello.kernel}${hello.ncpu ? ` · ${hello.ncpu}코어` : ''}` : ''}{hello && hello.rhelMajor && !hello.rhelMajor.startsWith('7.') ? ' · RHEL 7 이 아님(검증 안 된 OS)' : ''}{mem?.total ? ` · ${bytesText(mem.total)}` : ''}</div>
        </div>
        <div className="fm-row">
          <Seg label="표의 값" value={at} onChange={setAt} options={atOptions(tb.win)} />
          <button type="button" className="fm-btn" onClick={onBack}>개요로</button>
        </div>
      </div>
      {q.error && !d ? <ErrorBox error={q.error} /> : null}
      {!d ? <Loading /> : (
        <>
          {d.n === 0 ? <div className="fm-ban">이 구간에는 기록이 없습니다 — 수집하지 않은 시간입니다. 0 으로 그리지 않고 비워 둡니다.</div> : null}
          <div className="fm-two">
            <div className="fm-card">
              <div className="fm-row fm-between"><div className="fm-col"><h3 className="fm-h3">CPU{hello?.ncpu ? ` — ${hello.ncpu}코어` : ''} <span className="fm-dim fm-at">· {atText}</span></h3><span className="fm-big">{tab?.cpu ? Math.round(tab.cpu.pct) : DASH}{tab?.cpu ? <small>%</small> : null}</span></div>
                <div className="fm-row">{[['사용자', 'usr'], ['시스템', 'sys'], ['I/O 대기', 'iow'], ['steal', 'stl']].map(([l, k], i) => <span key={k} className="fm-lg"><i style={{ background: LC[i] }} />{l} <b>{pctText(tab?.cpu?.[k])}</b></span>)}</div></div>
              <div className="fm-chart-box">
              <svg viewBox="0 0 640 214" role="img" aria-label="CPU 사용률 구성 추이 — 사용자 · 시스템 · I/O 대기 · steal 을 쌓은 면" className="fm-chart">
                {[0, 25, 50, 75, 100].map((v) => <g key={v}><line x1={X0} x2={X1} y1={yc(v)} y2={yc(v)} stroke="var(--fm-grid)" /><text x={X0 - 6} y={yc(v) + 4} className="fm-axis" textAnchor="end">{v}</text></g>)}
                {layers.map((p, i) => <path key={i} d={p} fill={LC[i]} fillOpacity="0.32" stroke={LC[i]} strokeWidth="1" />)}
                <text x={X0} y={209} className="fm-axis">{clockText(d.from)}</text><text x={X1} y={209} className="fm-axis" textAnchor="end">{tb.end == null ? '지금' : clockText(d.to)}</text>
                <HoverMarks f={hCpu} plot={cpuPlot} y={yc} series={[{ key: 'tot', vals: cpuTot, color: RX_COLOR }]} />
                <HoverRect plot={cpuPlot} onFrac={setHCpu} />
              </svg>
              <HoverTip f={hCpu} vbw={640} plot={cpuPlot} time={hoverTime(hCpu, [cpuTot], d.from, d.to)}
                rows={[['사용자', d.charts.cpu.usr, LC[0]], ['시스템', d.charts.cpu.sys, LC[1]], ['I/O 대기', d.charts.cpu.iow, LC[2]], ['steal', d.charts.cpu.stl, LC[3]], ['합', cpuTot, null]].map(([l, v, c]) => ({ key: l, label: l, color: c, value: pctText(valueAtFrac(v, hCpu), 1) }))} />
              </div>
              <div className="fm-row fm-between"><span className="fm-lg">부하 평균 <b>{(tab?.load || []).map((v) => numText(v, 1)).join(' · ')}</b> <span className="fm-dim">(1 · 5 · 15분)</span></span></div>
              {tab?.cpu?.cores?.length ? (
                <div className="fm-col"><span className="fm-dim">코어별 사용률(cpu0 ~ cpu{tab.cpu.cores.length - 1}) · 어두움 0% → 밝음 100%</span>
                  <svg viewBox={`0 0 ${tab.cpu.cores.length * 10} 12`} preserveAspectRatio="none" className="fm-cores" role="img" aria-label={`코어 ${tab.cpu.cores.length}개의 사용률`}>{tab.cpu.cores.map((v, i) => <rect key={i} x={i * 10} y="0" width="9.4" height="12" fill={heatColor(v, 100, false)}><title>cpu{i} {pctText(v)}</title></rect>)}</svg></div>
              ) : null}
            </div>
            <div className="fm-card">
              <div className="fm-row fm-between"><div className="fm-col"><h3 className="fm-h3">메모리{mem?.total ? ` — ${bytesText(mem.total)}` : ''} <span className="fm-dim fm-at">· {atText}</span></h3><span className="fm-big">{mem ? Math.round(mem.pct) : DASH}{mem ? <small>%</small> : null}</span></div>
                <span className="fm-dim fm-rt">사용률 = (전체 − MemAvailable) ÷ 전체<br />캐시로 쓰는 메모리는 ‘사용’ 에 넣지 않습니다</span></div>
              {mem?.total ? (
                <div className="fm-membar" role="img" aria-label={`메모리 구성: 사용 ${bytesText(mem.used)}, 버퍼 · 캐시 ${bytesText(mem.bc)}, 여유 ${bytesText(mem.free)}`}>
                  <div style={{ flex: Math.max(0.001, mem.used || 0), background: RX_COLOR }}>{bytesText(mem.used)}</div>
                  <div style={{ flex: Math.max(0.001, mem.bc || 0), background: '#199e70' }}>{bytesText(mem.bc)}</div>
                  <div style={{ flex: Math.max(0.001, mem.free || 0), background: '#33415c' }} />
                </div>
              ) : null}
              <div className="fm-chart-box">
              <svg viewBox="0 0 640 150" role="img" aria-label="메모리 사용률 추이" className="fm-chart">
                {[0, 50, 100].map((v) => <g key={v}><line x1={X0} x2={X1} y1={ym(v)} y2={ym(v)} stroke="var(--fm-grid)" /><text x={X0 - 6} y={ym(v) + 4} className="fm-axis" textAnchor="end">{v}</text></g>)}
                <path d={areaPath(d.charts.mem, { x0: X0, x1: X1, y: ym, base: 126 })} fill={RX_COLOR} fillOpacity="0.12" />
                <path d={linePath(d.charts.mem, { x0: X0, x1: X1, y: ym })} fill="none" stroke={RX_COLOR} strokeWidth="2" />
                <HoverMarks f={hMem} plot={memPlot} y={ym} series={[{ key: 'mem', vals: d.charts.mem, color: RX_COLOR }]} />
                <HoverRect plot={memPlot} onFrac={setHMem} />
              </svg>
              <HoverTip f={hMem} vbw={640} plot={memPlot} time={hoverTime(hMem, [d.charts.mem], d.from, d.to)} rows={[{ key: 'm', label: '메모리 사용률', color: RX_COLOR, value: pctText(valueAtFrac(d.charts.mem, hMem), 1) }]} />
              </div>
              <div className="fm-row fm-between"><span className="fm-lg">스왑 <b>{bytesText(mem?.swU)}</b> / {bytesText(mem?.swT)}</span><span className="fm-lg">Dirty <b>{bytesText(mem?.dirty)}</b> · Slab <b>{bytesText(mem?.slab)}</b></span></div>
            </div>
          </div>
          <div className="fm-card fm-flush">
            <div className="fm-row fm-between fm-pad"><h3 className="fm-h3">네트워크 — 본딩 {nets.filter((x) => x.k === 'bond').length}개 · 물리 인터페이스 {nets.filter((x) => x.k === 'phys').length}개 <span className="fm-dim fm-at">· {atText}</span></h3>
              <div className="fm-row"><span className="fm-lg"><i style={{ background: RX_COLOR }} />수신</span><span className="fm-lg"><i style={{ background: TX_COLOR }} />송신</span>
                <Seg label="네트워크 표의 값" value={at} onChange={setAt} options={atOptions(tb.win)} />
                <Seg label="인터페이스 범위" value={netAll ? 'all' : 'bp'} onChange={(v) => setNetAll(v === 'all')} options={[['bp', '본딩 · 물리'], ['all', '전체(VLAN · 가상 포함)']]} /></div></div>
            <STable className="fm-table" minWidth={1040}>
              <thead><tr><th>인터페이스</th><th>구성</th><th className="fm-r">속도</th><th>사용률</th><th className="fm-r">수신</th><th className="fm-r">송신</th><th className="fm-r">오류 · 드롭</th><th data-nosort>최근 추이</th></tr></thead>
              <tbody>{netTree.map(([x, lv]) => (
                <tr key={x.n}>
                  <td className="fm-mono" style={{ paddingLeft: 12 + lv * 20, fontWeight: lv ? 400 : 600 }}>{x.n}</td>
                  <td className="fm-dim fm-ell" title={x.k === 'bond' ? `${x.md || '본딩'} · 구성원 ${x.mem?.length || 0}개${x.md === 'active-backup' && x.act ? ` · 지금 ${x.act} 사용` : ''}` : x.m ? `${x.m} 구성원${x.act === x.n ? ' · 사용 중' : ''} · 링크 ${x.st === 'up' ? '정상' : x.st || '?'}` : `${x.k === 'phys' ? '단독' : '가상'} · 링크 ${x.st === 'up' ? '정상' : x.st === 'down' ? '끊김(down)' : x.st || '?'}`}>{x.k === 'bond' ? `${x.md || '본딩'} · 구성원 ${x.mem?.length || 0}개${x.md === 'active-backup' && x.act ? ` · 지금 ${x.act} 사용` : ''}` : x.m ? `${x.m} 구성원${x.act === x.n ? ' · 사용 중' : ''} · 링크 ${x.st === 'up' ? '정상' : x.st || '?'}` : `${x.k === 'phys' ? '단독' : '가상'} · 링크 ${x.st === 'up' ? '정상' : x.st === 'down' ? '끊김(down)' : x.st || '?'}`}</td>
                  <td className="fm-r fm-num" data-sort={x.sp ?? null}>{x.sp == null ? DASH : x.sp >= 1000 ? `${x.sp / 1000} Gb` : `${x.sp} Mb`}</td>
                  <td data-sort={x.u ?? null}><span className="fm-meter"><span className="t"><span className={`f ${levelOf(x.u, settings)}`} style={{ width: `${Math.min(100, x.u ?? 0)}%` }} /></span><span className="fm-num">{pctText(x.u)}</span></span></td>
                  <td className="fm-r fm-num" data-sort={x.rx ?? null}>{bpsText(x.rx)}</td>
                  <td className="fm-r fm-num" data-sort={x.tx ?? null}>{bpsText(x.tx)}</td>
                  <td className="fm-r fm-num fm-dim">{x.er == null && x.dr == null ? DASH : `${numText(x.er, 0)} · ${numText(x.dr, 0)}`}</td>
                  <td><span className="fm-spark2"><Spark vals={netSpark.get(x.n)?.rx} color={RX_COLOR} max={niceMax(seriesMax([netSpark.get(x.n)?.rx, netSpark.get(x.n)?.tx]) ?? 1)} area={false} h={14} /><Spark vals={netSpark.get(x.n)?.tx} color={TX_COLOR} max={niceMax(seriesMax([netSpark.get(x.n)?.rx, netSpark.get(x.n)?.tx]) ?? 1)} area={false} h={14} /></span></td>
                </tr>
              ))}</tbody>
            </STable>
            <div className="fm-note fm-pad">사용률 = 수신 · 송신 중 큰 쪽 ÷ 링크 속도. 본딩 속도는 802.3ad · balance 계열은 올라온 구성원 합, active-backup 은 쓰는 구성원 하나입니다. 링크 속도를 못 읽은 인터페이스는 사용률을 ‘—’ 로 두고 수신 · 송신량만 보여 줍니다. ‘{tb.win}분 평균’ 은 시간 띠에서 고른 구간({tb.windows.join(' · ')}분 중 하나)의 시간 평균입니다(표본마다 덮는 시간으로 가중 — 수집 주기가 바뀐 구간도 치우치지 않습니다). 수신 · 송신은 평균, 사용률은 순간마다의 사용률(큰 쪽 ÷ 링크 속도)을 평균한 값이라 평균 수신 · 송신으로 다시 나눈 값과 다를 수 있고, 오류 · 드롭은 그 구간의 합입니다.</div>
          </div>
          <div className="fm-card fm-flush">
            <div className="fm-row fm-between fm-pad"><h3 className="fm-h3">디스크 — 물리 {dsks.filter((x) => x.k === 'disk').length}개 · 파티션 {dsks.filter((x) => x.k === 'part').length}개 · LVM 볼륨 {dsks.filter((x) => x.k === 'lvm').length}개 <span className="fm-dim fm-at">· {atText}</span></h3>
              <div className="fm-row"><span className="fm-dim">장치 이름을 누르면 아래 차트가 그 장치로 바뀝니다</span>
                <Seg label="디스크 표의 값" value={at} onChange={setAt} options={atOptions(tb.win)} />
                <Seg label="디스크 범위" value={tree} onChange={setTree} options={[['tree', '트리'], ['phys', '물리 디스크만'], ['parts', '파티션 · 볼륨만']]} />
                <Seg label="표의 열" value={cols} onChange={(v) => { setCols(v); lsSet('fm.dsk.cols', v); }} options={[['summary', '요약 열'], ['iostat', 'iostat 전체 열']]} /></div></div>
            <STable className="fm-table fm-io" minWidth={cols === 'iostat' ? 1100 : 1000}>
              <thead><tr><th>장치</th><th>마운트</th>{showCols.map((c) => <th key={c} className="fm-r">{main.iostat.names[c]}<br /><small className="fm-dim">{IOSTAT_LABEL[c]}</small></th>)}{cols === 'summary' ? <th data-nosort>쓰기 지연 추이</th> : null}</tr></thead>
              <tbody>
                {tab?.dtot ? <tr className="fm-sum"><td colSpan={2}>전체 디스크 <span className="fm-dim">물리 {dsks.filter((x) => x.k === 'disk').length}개 합</span></td>{showCols.map((c) => <td key={c} className={`fm-r fm-num ${c === 'wAwait' || c === 'rAwait' ? awaitLevel(tab.dtot[colIdx(c)], settings) : ''}`}>{iostatText(c, tab.dtot[colIdx(c)])}</td>)}{cols === 'summary' ? <td /> : null}</tr> : null}
                {shownDsk.map((x) => (
                  <React.Fragment key={x.n}>
                    <tr className={devC?.n === x.n ? 'fm-sel' : ''}>
                      <td className="fm-mono" style={{ paddingLeft: 14 + (tree === 'tree' ? depth(x) : 0) * 14, fontWeight: x.k === 'disk' ? 600 : 400 }}>
                        <span className="fm-st"><span><button type="button" className="fm-linkbtn" onClick={() => setDev(x.n)}>{x.n}</button>{x.stuck ? <span className="fm-badge crit">응답 없음</span> : null}</span>{x.dn || x.sz ? <small>{[x.dn, x.sz ? sizeText(x.sz) : ''].filter(Boolean).join(' · ')}</small> : null}</span>
                      </td>
                      <td className="fm-mono fm-dim">{x.mp || ''}</td>
                      {showCols.map((c) => <td key={c} className={`fm-r fm-num ${c === 'wAwait' || c === 'rAwait' || c === 'await' ? awaitLevel(x.v[colIdx(c)], settings) : ''}`} data-sort={x.v[colIdx(c)] ?? null}>{iostatText(c, x.v[colIdx(c)])}</td>)}
                      {cols === 'summary' ? <td><Spark vals={dspark.get(x.n)} color={TX_COLOR} max={niceMax(seriesMax([dspark.get(x.n)]) ?? 1)} area={false} h={22} /></td> : null}
                    </tr>
                    {x.stuck ? <tr className="fm-stuck"><td colSpan={showCols.length + 3}>이 구간에 끝난 요청이 0건인데 {x.fl}건이 걸려 있고 사용률이 100% 입니다. iostat 은 이때 await 를 0.00 으로 찍습니다 — 여기서는 ‘—’ 로 두고 ‘응답 없음’ 으로 알립니다.</td></tr> : null}
                  </React.Fragment>
                ))}
              </tbody>
            </STable>
            {devC ? (
              <div className="fm-two fm-pad">
                <div className="fm-sub-card"><div className="fm-row fm-between"><b>{devC.n} — 읽기 · 쓰기 처리량 <span className="fm-dim">MB/s</span></b><span className="fm-row"><span className="fm-lg"><i style={{ background: RX_COLOR }} />읽기</span><span className="fm-lg"><i style={{ background: TX_COLOR }} />쓰기</span></span></div>
                  <div className="fm-chart-box"><svg viewBox="0 0 640 200" role="img" aria-label={`${devC.n} 읽기 · 쓰기 처리량 추이`} className="fm-chart"><path d={linePath(devC.rMB, { x0: X0, x1: X1, y: yt })} fill="none" stroke={RX_COLOR} strokeWidth="2" /><path d={linePath(devC.wMB, { x0: X0, x1: X1, y: yt })} fill="none" stroke={TX_COLOR} strokeWidth="2" /><line x1={X0} x2={X1} y1={176} y2={176} stroke="var(--fm-grid)" />
                    <HoverMarks f={hT} plot={devPlot} y={yt} series={[{ key: 'r', vals: devC.rMB, color: RX_COLOR }, { key: 'w', vals: devC.wMB, color: TX_COLOR }]} /><HoverRect plot={devPlot} onFrac={setHT} /></svg>
                    <HoverTip f={hT} vbw={640} plot={devPlot} time={hoverTime(hT, [devC.rMB, devC.wMB], d.from, d.to)} rows={[{ key: 'r', label: '읽기 MB/s', color: RX_COLOR, value: iostatText('rMB', valueAtFrac(devC.rMB, hT)) }, { key: 'w', label: '쓰기 MB/s', color: TX_COLOR, value: iostatText('wMB', valueAtFrac(devC.wMB, hT)) }]} /></div></div>
                <div className="fm-sub-card"><div className="fm-row fm-between"><b>{devC.n} — 읽기 · 쓰기 지연 <span className="fm-dim">ms · 최고 눈금 {Math.round(ylMax)}</span></b><span className="fm-row"><span className="fm-lg"><i style={{ background: RX_COLOR }} />읽기</span><span className="fm-lg"><i style={{ background: TX_COLOR }} />쓰기</span></span></div>
                  <div className="fm-chart-box"><svg viewBox="0 0 640 200" role="img" aria-label={`${devC.n} 읽기 · 쓰기 지연 추이`} className="fm-chart"><path d={linePath(devC.rAwait, { x0: X0, x1: X1, y: yl })} fill="none" stroke={RX_COLOR} strokeWidth="2" /><path d={linePath(devC.wAwait, { x0: X0, x1: X1, y: yl })} fill="none" stroke={TX_COLOR} strokeWidth="2" /><line x1={X0} x2={X1} y1={176} y2={176} stroke="var(--fm-grid)" />
                    <HoverMarks f={hL} plot={devPlot} y={yl} series={[{ key: 'r', vals: devC.rAwait, color: RX_COLOR }, { key: 'w', vals: devC.wAwait, color: TX_COLOR }]} /><HoverRect plot={devPlot} onFrac={setHL} /></svg>
                    <HoverTip f={hL} vbw={640} plot={devPlot} time={hoverTime(hL, [devC.rAwait, devC.wAwait], d.from, d.to)} rows={[{ key: 'r', label: '읽기 지연', color: RX_COLOR, value: msText(valueAtFrac(devC.rAwait, hL)) }, { key: 'w', label: '쓰기 지연', color: TX_COLOR, value: msText(valueAtFrac(devC.wAwait, hL)) }]} /></div></div>
              </div>
            ) : null}
            <div className="fm-note fm-pad">열 이름과 계산식은 iostat -x -m 과 같습니다(같은 /proc/diskstats 누적값의 차이). 요약 열은 13개 가운데 8개이고 ‘iostat 전체 열’ 을 누르면 병합 · 요청 크기 · 합친 지연 · 서비스 시간이 나옵니다. ‘전체 디스크’ 는 물리 디스크만 더합니다(파티션 · LVM 은 같은 입출력을 다시 보는 것). ‘{tb.win}분 평균’ 은 시간 띠에서 고른 구간({tb.windows.join(' · ')}분 중 하나)을 다시 계산한 값입니다 — 표본마다 덮는 시간으로 가중해 횟수 · 처리량 · 대기열 · 사용률은 시간 평균, 지연은 요청 수(초당 횟수 × 시간)로 가중합니다(끝난 요청이 없으면 ‘—’).</div>
          </div>
          <div className="fm-card fm-flush">
            <div className="fm-row fm-between fm-pad"><h3 className="fm-h3">CPU 를 많이 쓰는 프로세스 — 상위 5 <span className="fm-dim fm-at">· {atText}</span></h3><a href={`#/${BASE.join('/')}/procs`}>상위 30개 전부 보기</a></div>
            <div className="fm-tblbox">
            <STable className="fm-table" minWidth={560}>
              <thead><tr><th>PID</th><th>사용자</th><th>CPU(1코어 = 100%)</th><th>명령</th></tr></thead>
              <tbody>{top5.map((p) => {
                // v2.981 줄을 누르면 그 줄 아래에 세부 정보(두 줄을 Fragment 로 묶어 정렬해도 함께 — 대상 표의 수정 칸과 같은 방식)
                const k = procKey(id, p); const on = openProc?.k === k;
                const toggle = () => setOpenProc(on ? null : { k, id, p });
                return (
                  <React.Fragment key={k}>
                    <tr className={`fm-click ${on ? 'fm-editing' : ''}`} onClick={toggle} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }} tabIndex={0} aria-expanded={on} title="누르면 이 프로세스의 세부 정보">
                      <td className="fm-mono fm-num">{p.pid}</td><td className="fm-mono">{p.u || DASH}</td><td data-sort={p.cpu ?? null}><span className="fm-meter"><span className="t"><span className="f" style={{ width: `${Math.min(100, p.cpu ?? 0)}%` }} /></span><span className="fm-num">{pctText(p.cpu, 1)}</span></span></td><td className="fm-mono">{p.c}<span className="fm-dim fm-more">{on ? ' ▴' : ' ▾'}</span></td>
                    </tr>
                    {on ? <tr className="fm-editrow"><td colSpan={4}><div className="fm-edbox"><ProcDetail id={id} p={p} tb={tb} onClose={() => setOpenProc(null)} /></div></td></tr> : null}
                  </React.Fragment>
                );
              })}</tbody>
            </STable>
            </div>
            {openProc && openProc.id === id && !top5.some((p) => procKey(id, p) === openProc.k) ? (
              <div className="fm-pad"><div className="fm-note">펼친 프로세스(PID {openProc.p.pid} · {openProc.p.c})는 지금 상위 5 에 없습니다 — 세부 정보는 계속 보여 줍니다.</div>
                <ProcDetail id={id} p={openProc.p} tb={tb} onClose={() => setOpenProc(null)} /></div>
            ) : null}
          </div>
        </>
      )}
    </>
  );
}

/* ── 프로세스 세부 정보(v2.981 — 사용자 '프로세스를 클릭하면 어떤 프로세스인지 · 네트워크 · 디스크 · CPU' · 시안 ⑩) ───────────── */
const PD_W = 360; // 카드 폭(약 330~380px)에 맞춘 viewBox — 640 이면 축 글자가 반으로 줄어 읽히지 않았다(Chromium 1440 판독)
/** 작은 추이 차트 — series [{key, label, vals, color}] · stacked 면 쌓은 면 · 칸이 null 이면 끊는다(상위 30 밖 = 모름). */
function PdChart({ label, series, from, to, fmt, axis, stacked = false, max = null, h = 132, nullText = '상위 30 밖 · 모름' }) {
  const [f, setF] = useState(null);
  const plot = { x0: 40, x1: PD_W - 6, y0: 8, y1: h - 20 };
  const L = Math.max(0, ...series.map((s) => (s.vals || []).length));
  let peak = 0;
  for (let i = 0; i < L; i++) {
    if (stacked) { let sum = 0; for (const s of series) sum += s.vals?.[i] ?? 0; peak = Math.max(peak, sum); }
    else for (const s of series) peak = Math.max(peak, s.vals?.[i] ?? 0);
  }
  const top = max ?? niceMax(peak);
  const y = yScale({ max: top, top: plot.y0, bottom: plot.y1 });
  const layers = stacked ? stackedAreas(series.map((s) => s.vals), { x0: plot.x0, x1: plot.x1, y }) : null;
  // 떨어진 칸(앞뒤가 비어 선이 그려지지 않는 값)은 점으로 — 상위 30 에 띄엄띄엄 든 프로세스는 선이 하나도 안 그려져 '값 없음' 처럼 보였다(Chromium 판독).
  const xAt = (k) => (L > 1 ? plot.x0 + (k * (plot.x1 - plot.x0)) / (L - 1) : plot.x0);
  const lone = (vals) => { const out = []; for (let k = 0; k < L; k++) if (vals?.[k] != null && vals?.[k - 1] == null && vals?.[k + 1] == null) out.push(k); return out; };
  const dots = stacked
    ? lone(Array.from({ length: L }, (_, k) => (series.every((s) => s.vals?.[k] != null) ? series.reduce((a, s) => a + s.vals[k], 0) : null))).map((k) => ({ key: `t${k}`, k, v: series.reduce((a, s) => a + s.vals[k], 0), color: series[series.length - 1].color }))
    : series.flatMap((s) => lone(s.vals).map((k) => ({ key: `${s.key}${k}`, k, v: s.vals[k], color: s.color })));
  return (
    <div className="fm-chart-box">
      <svg viewBox={`0 0 ${PD_W} ${h}`} role="img" aria-label={label} className="fm-chart">
        {dots.map((o) => <circle key={o.key} cx={xAt(o.k)} cy={y(o.v)} r="2.5" fill={o.color} />)}
        {yTicks(top).filter((_, i) => i % 2 === 0).map((v) => <g key={v}><line x1={plot.x0} x2={plot.x1} y1={y(v)} y2={y(v)} stroke="var(--fm-grid)" /><text x={plot.x0 - 6} y={y(v) + 4} className="fm-axis" textAnchor="end">{axis(v)}</text></g>)}
        {stacked ? layers.map((d, i) => <path key={series[i].key} d={d} fill={series[i].color} fillOpacity="0.32" stroke={series[i].color} strokeWidth="1" />)
          : series.map((s) => <path key={s.key} d={linePath(s.vals, { x0: plot.x0, x1: plot.x1, y })} fill="none" stroke={s.color} strokeWidth="2" />)}
        <text x={plot.x0} y={h - 4} className="fm-axis">{clockText(from)}</text><text x={plot.x1} y={h - 4} className="fm-axis" textAnchor="end">{clockText(to)}</text>
        <HoverMarks f={f} plot={plot} y={y} series={series.map((s) => ({ key: s.key, vals: s.vals, color: s.color }))} />
        <HoverRect plot={plot} onFrac={setF} />
      </svg>
      <HoverTip f={f} vbw={PD_W} plot={plot} time={hoverTime(f, series.map((s) => s.vals), from, to)}
        rows={series.map((s) => ({ key: s.key, label: s.label, color: s.color, value: valueAtFrac(s.vals, f) == null ? nullText : fmt(valueAtFrac(s.vals, f)) }))} />
    </div>
  );
}

/** 줄을 누르면 그 줄 아래에 펼치는 세부 정보(한 서버 · 한 프로세스). 시간 범위는 위쪽 시간 띠를 따른다. */
function ProcDetail({ id, p, tb, server, onClose }) {
  const live = tb.end == null;
  const params = useMemo(() => ({ target: id, pid: p.pid, sk: p.sk ?? '', win: tb.win, end: tb.end ?? '' }), [id, p.pid, p.sk, tb.win, tb.end]);
  const q = usePoll('/tools/focus-mon/proc', params, live ? 5_000 : 0, true);
  const d = q.fresh ? q.data : null;
  const head = (
    <div className="fm-row fm-between fm-pd-head">
      <div className="fm-row"><b className="fm-mono">{p.c}</b><span className="fm-dim fm-num">PID {p.pid}</span>{d?.info?.sv ? <span className="fm-badge ok" title="systemd 서비스(cgroup)">{d.info.sv}</span> : null}
        {d?.rank ? <span className="fm-dim">CPU {d.rank}위{d.total ? ` / 프로세스 ${d.total}개` : ''}</span> : null}{server ? <span className="fm-dim">· {server}</span> : null}</div>
      <div className="fm-row">{d?.lastAt ? <span className="fm-dim">마지막 표본 {agoShort(d.lastAt, Date.now())}</span> : null}<button type="button" className="fm-btn sm" onClick={onClose}>닫기</button></div>
    </div>
  );
  const nf = Number(q.error?.status) === 404;
  if (q.error && !d) {
    return <div className="fm-pd">{head}{nf ? <div className="fm-ban">{q.error?.body?.reason || '이 구간의 CPU 상위 30 에 이 프로세스가 없습니다.'} <button type="button" className="fm-btn sm" onClick={q.reload}>다시 묻기</button></div> : <ErrorBox error={q.error} />}</div>;
  }
  if (!d) return <div className="fm-pd">{head}<Loading /></div>;
  const i = d.info; const S = d.series;
  const desc = procDescOf(i.c);
  const cover = procCoverText(d.cover);
  const ioNote = procIoNote(i);
  const waitNote = procWaitNote(d.da);
  const hasIo = (S.rb || []).some((v) => v != null) || (S.wb || []).some((v) => v != null);
  // 반증 F11: 옛 엣지(사용자/커널 칸 없음)는 CPU 합 한 줄로 — 쌓은 면만 그리면 차트가 비었다
  const splitCpu = (S.us || []).some((v) => v != null) && (S.sy || []).some((v) => v != null);
  // 반증 F7: 404(상위 30 에서 빠짐)를 받으면 폴링이 멈춘다 — 앞서 받은 값이 남아 있으면 멈춘 값이라고 밝힌다
  const staleBan = q.error && d ? <div className="fm-ban w">{nf ? '이 프로세스가 지금 구간의 CPU 상위 30 에 없어 자동으로 다시 묻지 않습니다 — 아래는 마지막으로 받은 값입니다.' : '새 값을 받지 못했습니다 — 아래는 마지막으로 받은 값입니다.'} <button type="button" className="fm-btn sm" onClick={q.reload}>다시 묻기</button></div> : null;
  const thNote = procThreadNote(i.th);
  const kv = [
    ['이름', <><span className="fm-mono">{i.c}</span>{desc ? <small className="fm-dim"> — 이름으로 본 설명: {desc}</small> : <small className="fm-dim"> — 이름으로 아는 설명이 없습니다</small>}</>],
    ['서비스', i.sv ? <span className="fm-mono">{i.sv}</span> : <span className="fm-dim">{DASH} (서비스로 띄운 프로세스가 아니거나 커널 스레드)</span>],
    ['부모', i.pp ? <><span className="fm-num">PID {i.pp}</span>{i.pc ? <span className="fm-mono"> · {i.pc}</span> : null}</> : DASH],
    ['사용자', i.u ? <span className="fm-mono">{i.u}</span> : DASH],
    ['상태', i.st ? `${PROC_STATE_TEXT[i.st] || i.st} (${i.st})${thNote ? ' · 주 스레드' : ''}` : DASH],
    ['실행 시간', etText(i.et)],
    ['스레드', i.th ?? DASH],
    ['nice', i.ni ?? DASH],
    ['같은 이름', i.ns != null ? `${i.ns}개` : DASH],
  ];
  const same = d.same?.list || [];
  return (
    <div className="fm-pd">
      {head}
      {staleBan}
      {cover ? <div className="fm-note">{cover}</div> : null}
      <div className="fm-pd-grid">
        <div className="fm-card">
          <h3 className="fm-h3">어떤 프로세스인가</h3>
          <dl className="fm-kv">{kv.map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}</dl>
          <div className="fm-note">{PROC_ARGS_NOTE}</div>
        </div>
        <div className="fm-card">
          <div className="fm-row fm-between"><h3 className="fm-h3">CPU</h3><span className="fm-big fm-num">{pctText(i.cpu, 1)}</span></div>
          <div className="fm-row"><span className="fm-lg"><i style={{ background: RX_COLOR }} />사용자 <b>{pctText(i.us, 1)}</b></span><span className="fm-lg"><i style={{ background: TX_COLOR }} />커널 <b>{pctText(i.sy, 1)}</b></span>
            <span className="fm-dim">서버 전체 대비 {pctText(i.sh, 2)} · 1코어 = 100%</span></div>
          {splitCpu ? (
            <PdChart label="이 프로세스의 CPU 추이 — 사용자 · 커널을 쌓은 면" stacked from={d.from} to={d.to} fmt={(v) => pctText(v, 1)} axis={(v) => `${Math.round(v)}`}
              series={[{ key: 'us', label: '사용자', vals: S.us, color: RX_COLOR }, { key: 'sy', label: '커널', vals: S.sy, color: TX_COLOR }]} />
          ) : (
            <PdChart label="이 프로세스의 CPU 추이" from={d.from} to={d.to} fmt={(v) => pctText(v, 1)} axis={(v) => `${Math.round(v)}`}
              series={[{ key: 'cpu', label: 'CPU', vals: S.cpu, color: RX_COLOR }]} />
          )}
          <div className="fm-row"><span className="fm-lg">구간 평균 <b>{pctText(d.avg.cpu, 1)}</b></span><span className="fm-lg">최고 <b>{pctText(d.max.cpu, 1)}</b></span><span className="fm-dim">상위 30 에 든 시간만</span></div>
        </div>
        <div className="fm-card">
          <div className="fm-row fm-between"><h3 className="fm-h3">메모리</h3><span className="fm-big fm-num">{mbText(i.rss)}</span></div>
          <PdChart label="이 프로세스의 실제 메모리(RSS) 추이" from={d.from} to={d.to} fmt={mbText} axis={(v) => (v >= 1024 ? `${+(v / 1024).toFixed(1)}G` : `${Math.round(v)}M`)}
            series={[{ key: 'rss', label: 'RSS', vals: S.rss, color: RX_COLOR }]} />
          <div className="fm-row"><span className="fm-lg">가상 메모리 <b>{mbText(i.vsz)}</b></span><span className="fm-lg">major fault <b>{i.mf == null ? DASH : `${numText(i.mf, 1)}/초`}</b></span></div>
        </div>
        <div className="fm-card">
          <h3 className="fm-h3">디스크</h3>
          {hasIo ? (
            <>
              <div className="fm-row"><span className="fm-lg"><i style={{ background: RX_COLOR }} />읽기 <b>{mbsText(i.rb)}</b></span><span className="fm-lg"><i style={{ background: TX_COLOR }} />쓰기 <b>{mbsText(i.wb)}</b></span></div>
              <PdChart label="이 프로세스의 디스크 읽기 · 쓰기 추이" from={d.from} to={d.to} fmt={mbsText} axis={(v) => numText(v, v >= 10 ? 0 : 1)}
                series={[{ key: 'rb', label: '읽기', vals: S.rb, color: RX_COLOR }, { key: 'wb', label: '쓰기', vals: S.wb, color: TX_COLOR }]} />
            </>
          ) : <div className="fm-ban">{ioNote}</div>}
          {d.da === true ? (
            <>
              <div className="fm-row"><span className="fm-lg"><i style={{ background: '#c98500' }} />디스크를 기다린 시간 <b>{pctText(i.io, 1)}</b></span><span className="fm-dim">이 프로세스가 블록 입출력을 기다린 시간의 비율</span></div>
              {thNote ? <div className="fm-note">{thNote}</div> : null}
              <PdChart label="이 프로세스가 디스크를 기다린 시간 비율 추이" from={d.from} to={d.to} fmt={(v) => pctText(v, 1)} axis={(v) => `${Math.round(v)}`}
                series={[{ key: 'io', label: '디스크 대기', vals: S.io, color: '#c98500' }]} h={110} />
            </>
          ) : <div className="fm-note">{waitNote}</div>}
        </div>
        <div className="fm-card">
          <h3 className="fm-h3">네트워크</h3>
          <div className="fm-ban">{PROC_NET_NOTE}</div>
          <div className="fm-row"><span className="fm-lg"><i style={{ background: RX_COLOR }} />서버 수신</span><span className="fm-lg"><i style={{ background: TX_COLOR }} />서버 송신</span></div>
          <PdChart label="같은 시간의 서버 전체 네트워크(참고)" from={d.from} to={d.to} fmt={bpsText} axis={(v) => (v >= 1e9 ? `${+(v / 1e9).toFixed(1)}G` : v >= 1e6 ? `${Math.round(v / 1e6)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}K` : `${Math.round(v)}`)}
            series={[{ key: 'rx', label: '서버 수신', vals: d.net.rx, color: RX_COLOR }, { key: 'tx', label: '서버 송신', vals: d.net.tx, color: TX_COLOR }]} h={110} nullText="수집 없음" />
        </div>
        <div className="fm-card fm-flush">
          <div className="fm-row fm-between fm-pad"><h3 className="fm-h3">같은 이름의 프로세스</h3><span className="fm-dim">{i.ns != null ? `전체 ${i.ns}개 가운데 ` : ''}상위 30 안의 {same.length}개</span></div>
          <STable className="fm-table" minWidth={360}>
            <thead><tr><th className="fm-r">PID</th><th>사용자</th><th>CPU</th><th className="fm-r">메모리</th></tr></thead>
            <tbody>{same.map((x) => <tr key={x.pid} className={x.self ? 'fm-editing' : undefined}><td className="fm-r fm-mono fm-num">{x.pid}{x.self ? <span className="fm-badge off">이 프로세스</span> : null}</td><td className="fm-mono">{x.u || DASH}</td><td data-sort={x.cpu ?? null} className="fm-num">{pctText(x.cpu, 1)}</td><td className="fm-r fm-num" data-sort={x.rss ?? null}>{mbText(x.rss)}</td></tr>)}</tbody>
          </STable>
        </div>
      </div>
      {d.usersMasked ? <div className="fm-note">사용자 이름은 관리자에게만 보입니다.</div> : null}
    </div>
  );
}

/* ── 프로세스 ─────────────────────────────────────────────────────────────── */
function Procs({ main, ids, tb, onOpen }) {
  const [mode, setMode] = useState('all');
  const [at, setAt] = useState('end');
  const [basis, setBasis] = useState('core');
  const [find, setFind] = useState('');
  const [open, setOpen] = useState(null); // v2.981 펼친 프로세스 { k(procKey), id, p } — 목록에서 빠져도(찾기 · 상위 밖) 세부 정보는 계속 본다
  const params = useMemo(() => ({ targets: ids.join(','), win: tb.win, end: tb.end ?? '', at }), [ids, tb.win, tb.end, at]);
  const q = usePoll('/tools/focus-mon/procs', params, tb.end == null ? 5_000 : 0, ids.length > 0);
  const tById = useMemo(() => new Map(main.targets.map((t) => [t.id, t])), [main.targets]);
  const f = find.trim().toLowerCase();
  const ok = (p) => !f || String(p.c).toLowerCase().includes(f) || String(p.u || '').toLowerCase().includes(f) || String(p.pid).includes(f);
  const d = q.data;
  const cpuOf = (p) => (basis === 'core' ? p.cpu : p.sh);
  const topCpu = Math.max(1, ...((d?.top || []).map((p) => cpuOf(p) ?? 0)));
  const rowsAll = (d?.top || []).filter(ok);
  const head = <thead><tr><th>#</th><th>서버</th><th className="fm-r">PID</th><th>사용자</th><th>CPU{basis === 'core' ? '(1코어 = 100%)' : '(서버 전체 대비)'}</th><th className="fm-r">메모리</th><th className="fm-r">스레드</th><th className="fm-r">실행 시간</th><th>명령(comm)</th></tr></thead>;
  const prow = (p, i, id) => {
    // v2.981 줄을 누르면 그 줄 아래에 세부 정보(서버 이름 단추는 서버 상세로 — 줄 펼침과 겹치지 않게 전파를 막는다)
    const k = procKey(id, p); const on = open?.k === k;
    const toggle = () => setOpen(on ? null : { k, id, p });
    return (
    <React.Fragment key={`${k}-${i}`}>
    <tr className={`fm-click ${on ? 'fm-editing' : ''}`} onClick={toggle} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(); } }} tabIndex={0} aria-expanded={on} title="누르면 이 프로세스의 세부 정보">
      <td className="fm-dim fm-num">{i + 1}</td>
      <td><button type="button" className="fm-linkbtn" onClick={(e) => { e.stopPropagation(); onOpen(id); }} title={nameTitle(tById.get(id))}>{tById.get(id)?.name}</button></td>
      <td className="fm-r fm-mono fm-num">{p.pid}</td>
      <td className="fm-mono">{p.u || DASH}</td>
      <td data-sort={cpuOf(p) ?? null}><span className="fm-meter"><span className="t"><span className="f" style={{ width: `${Math.min(100, ((cpuOf(p) ?? 0) / topCpu) * 100)}%` }} /></span><span className="fm-num">{pctText(cpuOf(p), 1)}</span></span></td>
      <td className="fm-r fm-num" data-sort={p.rss ?? null}>{p.rss == null ? DASH : `${numText(p.rss >= 1024 ? p.rss / 1024 : p.rss, 1)} ${p.rss >= 1024 ? 'GB' : 'MB'}`}</td>
      <td className="fm-r fm-num">{p.th ?? DASH}</td>
      <td className="fm-r fm-num fm-dim" data-sort={p.et ?? null}>{etText(p.et)}</td>
      <td className="fm-mono">{p.c}<span className="fm-dim fm-more">{on ? ' ▴' : ' ▾'}</span></td>
    </tr>
    {on ? <tr className="fm-editrow"><td colSpan={9}><div className="fm-edbox"><ProcDetail id={id} p={p} tb={tb} server={tById.get(id)?.name} onClose={() => setOpen(null)} /></div></td></tr> : null}
    </React.Fragment>
    );
  };
  return (
    <>
      <div className="fm-row fm-between">
        <div className="fm-row">
          <span className="fm-lbl">보기</span><Seg label="보기" value={mode} onChange={setMode} options={[['all', `통합 상위 30`], ['per', '서버별 상위 30'], ['group', '이름별 묶음']]} />
          <span className="fm-lbl">CPU 기준</span><Seg label="CPU 기준" value={basis} onChange={setBasis} options={[['core', '1코어 = 100%'], ['server', '서버 전체 대비']]} />
          <span className="fm-lbl">시점</span><Seg label="시점" value={at} onChange={setAt} options={[['end', '구간 끝 순간'], ['avg', '구간 평균']]} />
        </div>
        <div className="fm-row"><label className="fm-lbl" htmlFor="fm-pq">찾기</label><input id="fm-pq" className="fm-input" value={find} onChange={(e) => setFind(e.target.value.slice(0, 64))} placeholder="명령 · 사용자 · PID" /></div>
      </div>
      {q.error && !d ? <ErrorBox error={q.error} /> : null}
      {!d ? <Loading /> : mode === 'group' ? (
        <div className="fm-card fm-flush">
          <div className="fm-pad fm-row fm-between"><h3 className="fm-h3">이름별 묶음 — {ids.length}대 합</h3><span className="fm-dim">이름 = comm · 숫자 덩어리는 * 로 묶음(ora_p001 · ora_p007 → ora_p*)</span></div>
          <STable className="fm-table" minWidth={620}>
            <thead><tr><th>이름</th><th>CPU 합(1코어 = 100%)</th><th className="fm-r">프로세스</th><th>서버</th></tr></thead>
            <tbody>{d.groups.filter((g) => !f || g.name.toLowerCase().includes(f)).map((g) => <tr key={g.name}><td className="fm-mono">{g.name}</td><td data-sort={g.cpu}><span className="fm-meter"><span className="t"><span className="f" style={{ width: `${Math.min(100, (g.cpu / (d.groups[0]?.cpu || 1)) * 100)}%` }} /></span><span className="fm-num">{pctText(g.cpu, 1)}</span></span></td><td className="fm-r fm-num">{g.procs}</td><td className="fm-ell" title={g.servers.map((s) => nameTitle(tById.get(s))).join(', ')}>{g.servers.map((s) => tById.get(s)?.name).join(', ')}</td></tr>)}</tbody>
          </STable>
          <div className="fm-note fm-pad">서버마다 상위 30개만 받으므로 그 밖의 프로세스는 합에 들어가지 않습니다.</div>
        </div>
      ) : mode === 'per' ? d.per.map((s) => (
        <div key={s.id} className="fm-card fm-flush">
          <div className="fm-pad fm-row fm-between"><h3 className="fm-h3">{tById.get(s.id)?.name}</h3><span className="fm-dim">프로세스 {s.total ?? DASH}개 · 표본 {agoShort(s.lastAt, Date.now())}</span></div>
          <div className="fm-tblbox"><STable className="fm-table" minWidth={900}>{head}<tbody>{s.top.filter(ok).map((p, i) => prow(p, i, s.id))}</tbody></STable></div>
        </div>
      )) : (
        <div className="fm-card fm-flush">
          <div className="fm-pad fm-row fm-between"><h3 className="fm-h3">CPU 를 많이 쓰는 프로세스 — {ids.length}대 통합 상위 30</h3><span className="fm-dim">서버마다 상위 30개를 받아 합친 뒤 다시 30개 · 제목을 누르면 정렬</span></div>
          <div className="fm-tblbox"><STable className="fm-table" minWidth={900}>{head}<tbody>{rowsAll.map((p, i) => prow(p, i, p.id))}</tbody></STable></div>
        </div>
      )}
      {open && d && mode !== 'group' && !(mode === 'per' ? d.per.some((x) => x.top.filter(ok).some((p) => procKey(x.id, p) === open.k)) : rowsAll.some((p) => procKey(p.id, p) === open.k)) ? (
        <div className="fm-card"><div className="fm-note">펼친 프로세스({tById.get(open.id)?.name} · PID {open.p.pid} · {open.p.c})는 지금 표에 없습니다(찾기 · 상위 30 밖) — 세부 정보는 계속 보여 줍니다.</div>
          <ProcDetail id={open.id} p={open.p} tb={tb} server={tById.get(open.id)?.name} onClose={() => setOpen(null)} /></div>
      ) : null}
      <div className="fm-note">줄을 누르면 그 프로세스의 세부 정보(어떤 프로세스인지 · CPU · 메모리 · 디스크 · 네트워크)가 그 줄 아래에 펼쳐집니다. CPU = /proc/&lt;pid&gt;/stat 의 누적 CPU 시간이 약 5초 동안 늘어난 양입니다(top 과 같은 원리 — 스레드가 여럿이면 100% 를 넘습니다). 표본 사이에 생겼다 사라진 프로세스는 보이지 않습니다. 명령은 프로세스 이름(comm)만 모읍니다 — 인자 · 환경은 읽지 않습니다(인자에 비밀번호가 흔합니다).{d?.usersMasked ? ' 사용자 이름은 관리자에게만 보입니다.' : ''} 이 화면은 보기만 합니다.</div>
    </>
  );
}

/* ── 대상 · 키 ─────────────────────────────────────────────────────────────── */
function Targets({ main, reload, picked, setPicked, onWatch, msg, setMsg }) {
  const L = main.limits;
  const [form, setForm] = useState({ name: '', host: '', port: '22', username: 'dvcmon', agent: '' });
  const [busy, setBusy] = useState('');
  const [interval, setIv] = useState(L.defaultInterval);
  const [mode, setMode] = useState('watch');
  const [node, setNode] = useState('all');
  const [csv, setCsv] = useState(false);
  const [installFor, setInstallFor] = useState('');
  const [joinTo, setJoinTo] = useState('');
  const [edit, setEdit] = useState(null); // v2.980 등록된 서버 수정 — { id, form } (한 번에 한 줄)
  const [setForm2, setSettingsForm] = useState(null);
  // v2.982 서버 그룹 — 그룹 단추 · 보기(그룹별로 묶기 | 목록)는 브라우저가 기억 · 접은 그룹 · 옮길 그룹 · 새 그룹 · 이름 바꾸기
  const [gsel, setGselRaw] = useState(() => lsGet('fm.tg.group', 'all'));
  const setGsel = (v) => { setGselRaw(v); lsSet('fm.tg.group', v); };
  const [gview, setGviewRaw] = useState(() => (lsGet('fm.tg.view', 'group') === 'list' ? 'list' : 'group'));
  const setGview = (v) => { setGviewRaw(v); lsSet('fm.tg.view', v); };
  const [closed, setClosed] = useState(() => new Set());
  const [moveTo, setMoveTo] = useState('');
  const [newGroup, setNewGroup] = useState('');
  const [rename, setRename] = useState(null); // { from, to }
  const run = async (label, fn) => {
    setBusy(label); setMsg(null);
    try { const r = await fn(); if (r?.reason) setMsg({ tone: r.ok === false ? 'bad' : 'ok', text: r.reason }); return r; }
    catch (e) { setMsg({ tone: 'bad', text: e?.body?.reason || e?.message || String(e) }); return null; }
    finally { setBusy(''); reload(); }
  };
  const byNode = main.targets.filter((t) => node === 'all' || (t.agent || '') === node);
  const groupList = main.groups?.list || [];
  const ownGroups = groupList.filter((g) => g.own);
  const targets = filterByGroup(byNode, gsel);
  const chips = groupChips(byNode, groupList);
  // v2.979 중복 방지: 서버는 수집 하나에만 — 표에 '수집 중' · 시작 전 안내 · 진행 중인 수집에 추가 · 서버별 수집 종료
  const sIdx = sessionIndex(main.sessions);
  const note = startNote({ picked, index: sIdx, mode });
  const joinSel = main.sessions.find((s) => s.id === joinTo) || main.sessions[0] || null;
  const stopOne = (t, s) => {
    if (s.mode === 'record' && !window.confirm(`${t.name} 의 계속 수집을 끝낼까요? 수집한 기록은 보관 기간 동안 남습니다.`)) return;
    run('stop1', async () => { const r = await delJson(`/tools/focus-mon/sessions/${encodeURIComponent(s.id)}/targets/${encodeURIComponent(t.id)}`); if (r?.ok === false) return r; return { ok: true, reason: `${t.name} 수집을 끝냈습니다${r?.ended ? ' — 그 수집의 마지막 서버라 수집도 끝났습니다' : ''}.` }; });
  };
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= L.maxPerSession ? p : [...p, id]));
  const full = picked.length >= L.maxPerSession;
  const nodeCount = new Map();
  for (const t of main.targets) nodeCount.set(t.agent || '', (nodeCount.get(t.agent || '') || 0) + 1);
  const nodes = [['all', `전체 ${main.targets.length}`], ...[...nodeCount.entries()].sort((a, b) => (a[0] === '' ? -1 : b[0] === '' ? 1 : a[0].localeCompare(b[0]))).map(([a, c]) => [a, `${a ? `엣지 ${a}` : '중앙'} ${c}`])];
  const nodeTargets = (x) => main.targets.filter((t) => !t.demo && String(t.agent || '').toLowerCase() === String(x.agent || '').toLowerCase()).length;
  const keyNodes = main.nodes.filter((x) => x.kind === 'central' || x.key?.publicKey || nodeTargets(x) > 0);
  const idleEdges = main.nodes.filter((x) => !keyNodes.includes(x));
  const stOf = (t) => (t.test ? (t.test.result ? { label: TEST_TEXT[t.test.result.kind] || t.test.result.kind, tone: t.test.result.ok ? 'ok' : 'warn', note: `${agoShort(t.test.at, Date.now())}${!t.test.result.ok && t.test.result.error && !['auth', 'auth-stopped'].includes(t.test.result.kind) ? ` · ${t.test.result.error}` : ''}` } : { label: '시험 중', tone: 'off' }) : t.status ? { label: STATE_TEXT[t.status.state]?.label || t.status.state, tone: STATE_TEXT[t.status.state]?.tone || 'off', note: t.status.error } : { label: '미확인', tone: 'off', note: '시험을 누르세요' });
  const installNode = main.nodes.find((x) => (x.agent || '') === installFor && x.key?.publicKey) || main.nodes.find((x) => x.kind === 'central' && x.key?.publicKey);
  const bulk = bulkLine(main.bulkTest, main.now || Date.now());
  const edgeNodes = main.nodes.filter((x) => x.kind === 'edge');
  const saveEdit = (t) => {
    const f = edit?.form; if (!f) return;
    // 포트는 글자 그대로 보낸다 — 화면에서 22 로 바꾸면 틀린 값이 조용히 22 가 된다(서버가 1~65535 를 검사해 알린다)
    run('edit', async () => {
      const r = await putJson(`/tools/focus-mon/targets/${encodeURIComponent(t.id)}`, { name: f.name.trim(), host: f.host.trim(), port: String(f.port).trim(), username: f.username.trim(), agent: f.agent, group: f.group || '' });
      if (r?.ok === false) return r;
      setEdit(null);
      return { ok: true, reason: editResultText(r, t.name) };
    });
  };
  const bulkTest = (ids, what) => run('bulk', async () => {
    const r = await postJson('/tools/focus-mon/targets/test-bulk', { ids });
    return { ok: true, reason: `${what} ${r.job.total}대의 연결 시험을 시작했습니다${r.job.skipped ? `(10초 안에 시험한 ${r.job.skipped}대는 건너뜀)` : ''} — 진행은 위 띠 · 결과는 키 로그인 칸에 나옵니다.` };
  });
  // v2.982 서버 그룹 — 옮기기 · 만들기 · 이름 바꾸기 · 지우기 · 자동 묶기 제안 적용(모두 응답의 ok 를 본다)
  const moveGroup = () => run('group', async () => {
    const r = await postJson('/tools/focus-mon/targets/group', { ids: picked, group: moveTo });
    if (r?.ok === false) return r;
    return { ok: true, reason: `고른 서버 ${r.moved}대를 ${groupLabel(r.group)}(으)로 옮겼습니다${r.same ? ` · 이미 그 그룹 ${r.same}대` : ''}${r.missing ? ` · 데모 · 없는 서버 ${r.missing}대는 옮기지 않음` : ''}.` };
  });
  const createGroup = () => run('group', async () => {
    const r = await postJson('/tools/focus-mon/groups', { name: newGroup.trim() });
    if (r?.ok === false) return r;
    setNewGroup(''); setMoveTo(r.group);
    return { ok: true, reason: `그룹 ${r.group} 을(를) 만들었습니다 — 서버를 고르고 ‘옮기기’ 로 넣으세요.` };
  });
  const renameGroup = () => run('group', async () => {
    const r = await putJson(`/tools/focus-mon/groups/${encodeURIComponent(rename.from)}`, { name: rename.to.trim() });
    if (r?.ok === false) return r;
    setRename(null);
    return { ok: true, reason: `그룹 이름을 ${r.group}(으)로 바꿨습니다(서버 ${r.moved}대).` };
  });
  const deleteGroup = (g) => {
    if (!window.confirm(`그룹 ${g.name} 을(를) 지울까요? 이 그룹의 서버 ${g.n}대는 ‘${GROUP_NONE}’ 으로 갑니다(서버 · 기록은 그대로).`)) return;
    run('group', async () => { const r = await delJson(`/tools/focus-mon/groups/${encodeURIComponent(g.name)}`); if (r?.ok === false) return r; return { ok: true, reason: `그룹 ${g.name} 을(를) 지웠습니다 — 서버 ${r.freed}대는 ${GROUP_NONE}.` }; });
  };
  const applySuggestion = (sg) => {
    if (!window.confirm(`${sg.title} 묶습니다 — ${suggestionText(sg, ownGroups)}. 그룹 없음 서버만 옮깁니다.`)) return;
    run('group', async () => {
      let moved = 0;
      for (const m of sg.moves) {
        if (!ownGroups.some((g) => g.name === m.group)) { const c = await postJson('/tools/focus-mon/groups', { name: m.group }); if (c?.ok === false && c.code !== 'duplicate') return c; }
        const r = await postJson('/tools/focus-mon/targets/group', { ids: m.ids, group: m.group });
        if (r?.ok === false) return r;
        moved += r.moved || 0;
      }
      return { ok: true, reason: `${sg.title} 서버 ${moved}대를 ${sg.moves.length}개 그룹으로 묶었습니다.` };
    });
  };
  const suggestions = groupSuggestions(main.targets, ownGroups);
  const ungrouped = main.targets.filter((t) => !t.group && !t.demo).length;
  // 대상 줄 하나(+ 수정 줄) — 목록 · 그룹별 묶기 둘 다 이것으로(v2.982)
  const rowOf = (t) => {
    const s = stOf(t);
    const on = picked.includes(t.id);
    const ed = edit?.id === t.id ? edit : null;
    // v2.980 등록된 서버 수정 — 그 줄 바로 아래에 수정 상자(한 줄짜리 colSpan). 두 줄을 Fragment 로 묶어 정렬해도 함께 움직인다
    // (sortableText 는 첫 tr 의 칸으로 정렬한다). 표 칸 안에 입력을 넣었더니 1440px 에서도 표가 카드보다 넓어져 저장 단추가 밖으로 나갔다.
    let edRow = null;
    if (ed) {
      const f = ed.form;
      const set = (k) => (e) => setEdit({ ...ed, form: { ...f, [k]: e.target.value.slice(0, 64) } });
      const ch = editChanges(t, f);
      const notes = editNotes(t, f, { inSession: sIdx.has(t.id) });
      const canSave = !busy && ch.changes.length > 0 && !!f.name.trim() && !!f.host.trim();
      const key = (e) => { if (e.key === 'Escape') setEdit(null); else if (e.key === 'Enter' && canSave) saveEdit(t); };
      const unknownNode = f.agent && !edgeNodes.some((x) => x.agent.toLowerCase() === f.agent.toLowerCase());
      edRow = (
        <tr className="fm-editrow">
          <td colSpan={6}><div className="fm-edbox">
            <div className="fm-form">
              <label className="fm-fld"><span>표시 이름</span><input className="fm-input" value={f.name} onChange={set('name')} onKeyDown={key} autoFocus /></label>
              <label className="fm-fld"><span>IP 주소</span><input className="fm-input fm-mono" value={f.host} onChange={set('host')} onKeyDown={key} /></label>
              <label className="fm-fld"><span>SSH 포트</span><input className="fm-input fm-mono" value={f.port} inputMode="numeric" onChange={set('port')} onKeyDown={key} /></label>
              <label className="fm-fld"><span>계정</span><input className="fm-input fm-mono" value={f.username} onChange={set('username')} onKeyDown={key} /></label>
              <label className="fm-fld"><span>담당 노드</span><Select sort={false} className="fm-input" value={f.agent} onChange={(e) => setEdit({ ...ed, form: { ...f, agent: e.target.value } })}>
                <option value="">중앙</option>
                {edgeNodes.map((x) => <option key={x.agent} value={x.agent}>엣지 {x.agent}</option>)}
                {unknownNode ? <option value={f.agent}>엣지 {f.agent}(등록부에 없음 — 다른 노드를 고르세요)</option> : null}
              </Select></label>
              <label className="fm-fld"><span>그룹</span><Select sort={false} className="fm-input" value={f.group || ''} onChange={(e) => setEdit({ ...ed, form: { ...f, group: e.target.value } })}>
                <option value="">{GROUP_NONE}</option>
                {ownGroups.map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}
                {f.group && !ownGroups.some((g) => g.name === f.group) ? <option value={f.group}>{f.group}</option> : null}
              </Select></label>
              <span className="fm-row fm-nowrap">
                <button type="button" className="fm-btn pri" disabled={!canSave} onClick={() => saveEdit(t)}>저장</button>
                <button type="button" className="fm-btn" disabled={busy === 'edit'} onClick={() => setEdit(null)}>취소</button>
              </span>
            </div>
            <div className="fm-ednotes">
              <span className="fm-dim">{ch.changes.length ? `바뀜: ${ch.changes.map((c) => `${c.label} ${c.from} → ${c.to}`).join(' · ')}` : '바꾼 칸이 없습니다 — 고칠 칸을 바꾸면 저장을 누를 수 있습니다.'}</span>
              {notes.map((n) => <span key={n} className="fm-why">{n}</span>)}
            </div>
          </div></td>
        </tr>
      );
    }
    return (
      <React.Fragment key={t.id}>
      <tr className={ed ? 'fm-editing' : undefined}>
        <td><input type="checkbox" checked={on} disabled={!on && full} aria-label={on ? '선택' : full ? '선택할 수 없음 — 상한' : '선택'} onChange={() => toggle(t.id)} /></td>
        <td data-sort={t.name} style={{ fontWeight: 600 }}>{t.name}{gview === 'list' && t.group ? <span className="fm-badge off" title="그룹">{t.group}</span> : null}{t.demo ? <span className="fm-badge off">데모</span> : null}{sIdx.has(t.id) ? <span className="fm-badge ok" title={sessionLabel(sIdx.get(t.id), Date.now())}>수집 중 · {MODE_TEXT[sIdx.get(t.id).mode]}</span> : null}</td>
        <td data-sort={t.host}><span className="fm-st"><span className="fm-mono fm-num">{t.host}:{t.port}</span><small className="fm-mono">{t.username}</small></span></td>
        <td data-sort={t.agent || ''}>{t.agent ? `엣지 ${t.agent}` : '중앙'}{t.agent && t.edgeOnline === false && !t.demo ? <span className="fm-badge warn">엣지 응답 없음</span> : null}</td>
        <td><span className="fm-st"><span className={`fm-badge ${s.tone}`}>{s.label}</span>{s.note ? <small>{s.note}</small> : null}{needsRetry(t) && !t.demo ? <small className="fm-why">{AUTH_HINT}</small> : null}{(t.test?.result?.hello || t.status?.hello)?.rhelMajor ? <small>RHEL {(t.test?.result?.hello || t.status?.hello).rhelMajor}</small> : null}</span></td>
        <td><span className="fm-row fm-acts">
          {sIdx.has(t.id) ? <button type="button" className="fm-btn sm danger" disabled={!!busy} onClick={() => stopOne(t, sIdx.get(t.id))}>수집 종료</button> : null}
          <button type="button" className="fm-btn sm" disabled={!!busy || t.demo} onClick={() => run('t1', () => postJson(`/tools/focus-mon/targets/${encodeURIComponent(t.id)}/test`, {}).then((r) => (r?.queued ? { ok: true, reason: `${t.name} 연결 시험을 엣지에 보냈습니다.` } : { ok: !!r?.result?.ok, reason: `${t.name}: ${TEST_TEXT[r?.result?.kind] || r?.result?.kind}${r?.result?.error ? ` — ${r.result.error}` : ''}` })))}>시험</button>
          {needsRetry(t) ? <button type="button" className="fm-btn sm" disabled={!!busy} onClick={() => run('retry', () => postJson(`/tools/focus-mon/targets/${encodeURIComponent(t.id)}/retry`, {}).then((r) => (r?.via === 'edge'
            ? { ok: true, reason: `${t.name}: 엣지 ${t.agent} 에 다시 연결을 보냈습니다 — 정지를 풀고 한 번 시험합니다(결과는 키 로그인 칸 · 몇 초 걸립니다).` }
            : r?.result ? { ok: !!r.result.ok, reason: `${t.name}: ${TEST_TEXT[r.result.kind] || r.result.kind}${r.result.error ? ` — ${r.result.error}` : ''}` }
              : r?.running ? { ok: true, reason: `${t.name} 을(를) 다시 연결합니다(수집기가 한 번 시도).` }
                : { ok: true, reason: `${t.name}: 정지를 풀었습니다 — 방금 시험해 10초 뒤에 ‘시험’ 을 누르면 한 번 접속합니다.` })))}>다시 연결</button> : null}
          {!t.demo ? <button type="button" className={`fm-btn sm ${ed ? 'pri' : ''}`} disabled={!!busy} aria-expanded={!!ed} title="이름 · IP · 포트 · 계정 · 담당 노드 · 그룹을 고칩니다(이 줄 아래에 수정 칸)" onClick={() => setEdit(ed ? null : { id: t.id, form: editFormOf(t) })}>{ed ? '수정 닫기' : '수정'}</button> : null}
          {!t.demo ? <button type="button" className="fm-btn sm" disabled={!!busy} onClick={() => { if (window.confirm(`${t.name} 을(를) 등록에서 지울까요? 기록은 보관 기간 동안 남습니다.`)) run('del', () => delJson(`/tools/focus-mon/targets/${encodeURIComponent(t.id)}`).then(() => ({ ok: true, reason: `${t.name} 을(를) 지웠습니다.` }))); }}>삭제</button> : null}
        </span></td>
      </tr>
      {edRow}
      </React.Fragment>
    );
  };
  return (
    <>
      <div className="fm-card fm-steps">
        <div><b>1</b><span>서버를 맡은 노드(중앙 또는 엣지)의 <strong>공개키</strong>를 대상 서버 계정의 authorized_keys 에 넣습니다.</span></div>
        <div><b>2</b><span>서버를 <strong>IP 로 등록</strong>합니다 — 포트 · 계정 · 담당 노드. 비밀번호는 받지 않습니다.</span></div>
        <div><b>3</b><span><strong>연결 시험</strong>으로 키 로그인과 OS 를 확인합니다(리눅스 · RHEL 7.8 기준).</span></div>
        <div><b>4</b><span>최대 <strong>{L.maxPerSession}대</strong>를 골라 시작합니다. 수집한 값은 DB 에 남아 시간 띠로 다시 볼 수 있습니다.</span></div>
      </div>
      {msg ? <div className={`fm-ban ${msg.tone === 'bad' ? 'w' : ''}`}>{msg.text}</div> : null}
      {bulk ? <div className={`fm-ban ${bulk.tone === 'warn' ? 'w' : ''}`} role="status">{bulk.text}</div> : null}
      <div className="fm-two wide">
        <div className="fm-card fm-flush">
          <div className="fm-row fm-between fm-pad"><h3 className="fm-h3">모니터링 대상 서버 — {main.targets.length}대 등록</h3>
            <div className="fm-row">
              <span className="fm-num" style={{ fontWeight: 600 }}>{picked.length} / {L.maxPerSession}대 선택</span>{full ? <span className="fm-dim">상한에 닿아 더 고를 수 없습니다</span> : null}
              <span className="fm-lbl">주기</span><Seg label="수집 주기" value={interval} onChange={setIv} options={L.intervals.map((v) => [v, `${v}초`])} />
              <span className="fm-lbl">방식</span><Seg label="수집 방식" value={mode} onChange={setMode} options={[['watch', `잠깐 보기 · ${L.watchMin}분`], ['record', '계속 수집']]} />
              <button type="button" className="fm-btn pri" disabled={!picked.length || !!busy} onClick={() => run('start', async () => { const r = await postJson('/tools/focus-mon/sessions', { targets: picked, interval, mode }); if (r?.ok) onWatch(picked); return r?.ok ? { ok: true, reason: joinResultText(r) } : r; })}>모니터링 시작</button>
              <button type="button" className="fm-btn" disabled={!picked.length} onClick={() => onWatch(picked)} title="수집하지 않고 고른 서버의 기록만 봅니다">기록 보기</button>
            </div></div>
          {main.sessions.length ? (
            <div className="fm-row fm-pad fm-join">
              <span className="fm-lbl">진행 중인 수집에 더하기</span>
              <Select sort={false} className="fm-input fm-sel-sm" value={joinSel?.id || ''} onChange={(e) => setJoinTo(e.target.value)} aria-label="더할 수집">
                {main.sessions.map((s) => <option key={s.id} value={s.id}>{sessionLabel(s, Date.now())}</option>)}
              </Select>
              <button type="button" className="fm-btn" disabled={!picked.length || !joinSel || !!busy} onClick={() => run('join', async () => { const r = await postJson(`/tools/focus-mon/sessions/${encodeURIComponent(joinSel.id)}/targets`, { targets: picked }); if (r?.ok) onWatch(r.session.targets); return r?.ok ? { ok: true, reason: joinResultText(r, { verb: '진행 중인 수집에 더했습니다' }) } : r; })}>고른 서버 더하기</button>
              <span className="fm-dim">새 수집을 만들지 않고 그 수집의 주기 · 방식으로 함께 수집합니다(동시 수집은 {L.maxSessions}건까지).</span>
            </div>
          ) : null}
          {note ? <div className="fm-ban fm-pad-x">{note}</div> : null}
          <div className="fm-pad fm-addbox">
            <div className="fm-row fm-between"><b>서버 추가</b><div className="fm-row"><span className="fm-dim">여러 대는 CSV(이름,IP,포트,계정,담당 노드)로</span><button type="button" className={`fm-btn ${csv ? 'pri' : ''}`} disabled={!canCsv()} title={canCsv() ? '' : CSV_DENIED_NOTE} onClick={() => setCsv(!csv)}>CSV 대량 등록</button></div></div>
            <div className="fm-form">
              {[['name', '표시 이름', 'pl-was-03'], ['host', 'IP 주소', '10.48.21.23'], ['port', 'SSH 포트', '22'], ['username', '계정', 'dvcmon']].map(([k, l, ph]) => (
                <label key={k} className="fm-fld"><span>{l}</span><input className="fm-input" value={form[k]} placeholder={ph} onChange={(e) => setForm({ ...form, [k]: e.target.value.slice(0, 64) })} /></label>
              ))}
              <label className="fm-fld"><span>담당 노드</span><Select sort={false} className="fm-input" value={form.agent} onChange={(e) => setForm({ ...form, agent: e.target.value })}><option value="">중앙</option>{main.nodes.filter((x) => x.kind === 'edge').map((x) => <option key={x.agent} value={x.agent}>엣지 {x.agent}</option>)}</Select></label>
              <label className="fm-fld fm-fld-g"><span>그룹</span><Select sort={false} className="fm-input" value={form.group || ''} onChange={(e) => setForm({ ...form, group: e.target.value })}><option value="">{GROUP_NONE}</option>{ownGroups.map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}</Select></label>
              <button type="button" className="fm-btn pri" disabled={!!busy || !form.host || !form.name} onClick={() => run('add', async () => { const r = await postJson('/tools/focus-mon/targets', { ...form, port: Number(form.port) || 22 }); if (r?.ok) setForm({ ...form, name: '', host: '' }); return r?.ok ? { ok: true, reason: `${r.target.name} 을(를) 등록했습니다.` } : r; })}>추가</button>
            </div>
            {csv ? <CsvPanel main={main} busy={busy} run={run} onClose={() => setCsv(false)} /> : null}
          </div>
          <div className="fm-row fm-pad">
            <span className="fm-lbl">그룹</span>
            {chips.map((c) => <button key={`c-${c.key}`} type="button" className={`fm-chip ${groupChipOn(chips, gsel, c.key) ? 'on' : ''}`} aria-pressed={groupChipOn(chips, gsel, c.key)} onClick={() => setGsel(c.key)}>{c.label}<b>{c.n}</b></button>)}
            <span className="fm-row fm-push"><span className="fm-lbl">보기</span><Seg label="대상 보기" value={gview} onChange={setGview} options={[['group', '그룹별로 묶기'], ['list', '목록']]} /></span>
          </div>
          <div className="fm-row fm-pad">
            <span className="fm-lbl">고른 서버 {picked.length}대 → 그룹</span>
            <Select sort={false} className="fm-input fm-sel-sm" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} aria-label="옮길 그룹"><option value="">{GROUP_NONE}</option>{ownGroups.map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}</Select>
            <button type="button" className="fm-btn" disabled={!picked.length || !!busy} onClick={moveGroup}>옮기기</button>
            <span className="fm-dim">새 그룹은 오른쪽 ‘그룹’ 카드에서 만듭니다</span>
          </div>
          <div className="fm-row fm-pad"><span className="fm-lbl">담당 노드</span><Seg label="담당 노드" value={node} onChange={setNode} options={nodes} />
            <button type="button" className="fm-btn" disabled={!picked.length || !!busy} onClick={() => bulkTest(picked, '고른 서버')}>고른 서버 연결 시험</button>
            <button type="button" className="fm-btn" disabled={!targets.length || !!busy} onClick={() => bulkTest(targets.map((t) => t.id), node === 'all' ? '목록의 서버' : `${node ? `엣지 ${node}` : '중앙'} 서버`)}>이 목록 모두 시험 · {targets.length}대</button>
            {main.ended?.[0] ? <button type="button" className="fm-btn" onClick={() => setPicked(main.ended[0].targets.slice(0, L.maxPerSession))}>지난번 {main.ended[0].targets.length}대 다시 고르기</button> : null}</div>
          {gview === 'group' ? groupSections(targets, groupList).map((sec) => {
            // v2.982 그룹별로 묶기 — 그룹마다 머리(접기 · 대수 · 수집 중 · 키 로그인 실패 · 노드 · 그룹 고르기 · 연결 시험 · 시작) + 표(그 안에서 정렬)
            const ids = sec.targets.map((t) => t.id);
            const open = !closed.has(sec.key);
            const allOn = ids.length > 0 && ids.every((id) => picked.includes(id));
            const live = sec.targets.filter((t) => sIdx.has(t.id)).length;
            const bad = sec.targets.filter((t) => needsRetry(t)).length;
            const nodeCnt = new Map(); for (const t of sec.targets) { const k = t.agent ? `엣지 ${t.agent}` : '중앙'; nodeCnt.set(k, (nodeCnt.get(k) || 0) + 1); }
            const plan = groupStartPlan(ids, L.maxPerSession);
            return (
              <div key={`g-${sec.key}`} className="fm-gsec">
                <div className="fm-ghead">
                  <button type="button" className="fm-gtog" aria-expanded={open} onClick={() => setClosed((c) => { const n = new Set(c); if (open) n.add(sec.key); else n.delete(sec.key); return n; })}>{open ? '▾' : '▸'} {sec.label}</button>
                  <span className="fm-badge off">{ids.length}대</span>
                  {live ? <span className="fm-badge ok">수집 중 {live}</span> : null}
                  {bad ? <span className="fm-badge warn">키 로그인 실패 {bad}</span> : null}
                  <span className="fm-dim fm-ell" title={[...nodeCnt.entries()].map(([k, v]) => `${k} ${v}`).join(' · ')}>{[...nodeCnt.entries()].map(([k, v]) => `${k} ${v}`).join(' · ')}</span>
                  <span className="fm-row fm-gacts">
                    <button type="button" className="fm-btn sm" disabled={!!busy} onClick={() => setPicked((p) => (allOn ? p.filter((x) => !ids.includes(x)) : [...new Set([...p, ...ids])].slice(0, L.maxPerSession)))}>{allOn ? '그룹 고르기 풀기' : '그룹 전체 고르기'}</button>
                    <button type="button" className="fm-btn sm" disabled={!!busy} onClick={() => bulkTest(ids, `${sec.label} 그룹`)}>이 그룹 연결 시험</button>
                    <button type="button" className="fm-btn sm pri" disabled={!!busy} title={plan.rest.length ? groupStartText(sec.key, plan, L.maxPerSession) : ''} onClick={() => run('start', async () => { const r = await postJson('/tools/focus-mon/sessions', { targets: plan.start, interval, mode }); if (r?.ok === false) return r; if (r?.ok) onWatch(plan.start); return r?.ok ? { ok: true, reason: `${joinResultText(r)}${plan.rest.length ? ` ${groupStartText(sec.key, plan, L.maxPerSession)}` : ''}` } : r; })}>이 그룹 모니터링 시작 · {plan.start.length}대</button>
                  </span>
                </div>
                {open ? (
                  <div className="fm-tblbox">
                  <STable className="fm-table fm-gtable" minWidth={640}>
            <thead><tr><th data-nosort /><th>이름</th><th>주소 · 계정</th><th>담당 노드</th><th>키 로그인 · OS</th><th data-nosort /></tr></thead>
            <tbody>{sec.targets.map(rowOf)}</tbody>
                  </STable>
                  </div>
                ) : null}
              </div>
            );
          }) : (
          <div className="fm-tblbox">
          <STable className="fm-table" minWidth={640}>
            <thead><tr><th data-nosort /><th>이름</th><th>주소 · 계정</th><th>담당 노드</th><th>키 로그인 · OS</th><th data-nosort /></tr></thead>
            <tbody>{targets.map(rowOf)}</tbody>
          </STable>
          </div>
          )}
          <div className="fm-note fm-pad">등록부에는 IP · 포트 · 계정 · 담당 노드만 저장합니다(비밀번호 · 개인키 없음). 키 로그인이 거부되면 자동으로 다시 시도하지 않습니다 — 공개키를 넣은 뒤 ‘다시 연결’ 을 누르세요(60초에 한 번).</div>
        </div>
        <div className="fm-col">
          <div className="fm-card">
            <div className="fm-row fm-between"><h3 className="fm-h3">그룹 — {ownGroups.length} / {main.groups?.max ?? DASH}</h3><span className="fm-dim">서버마다 그룹 하나</span></div>
            {ownGroups.length ? (
              <div className="fm-glist">{ownGroups.map((g) => (
                <div key={g.name} className="fm-gitem">
                  {rename?.from === g.name ? (
                    <span className="fm-row"><input className="fm-input fm-sel-sm" aria-label="새 그룹 이름" value={rename.to} onChange={(e) => setRename({ ...rename, to: e.target.value.slice(0, 32) })} onKeyDown={(e) => { if (e.key === 'Escape') setRename(null); else if (e.key === 'Enter' && rename.to.trim()) renameGroup(); }} />
                      <button type="button" className="fm-btn sm pri" disabled={!!busy || !rename.to.trim()} onClick={renameGroup}>저장</button><button type="button" className="fm-btn sm" onClick={() => setRename(null)}>취소</button></span>
                  ) : (
                    <>
                      <span className="fm-ell" title={g.name} style={{ fontWeight: 600 }}>{g.name}</span><span className="fm-dim fm-num">{g.n}대</span>
                      <span className="fm-row fm-acts"><button type="button" className="fm-btn sm" disabled={!!busy} onClick={() => setRename({ from: g.name, to: g.name })}>이름 바꾸기</button><button type="button" className="fm-btn sm danger" disabled={!!busy} onClick={() => deleteGroup(g)}>지우기</button></span>
                    </>
                  )}
                </div>
              ))}</div>
            ) : <span className="fm-dim">아직 그룹이 없습니다 — 만들거나 아래 자동 묶기 제안을 쓰세요.</span>}
            <div className="fm-row"><input className="fm-input" aria-label="새 그룹 이름" placeholder="새 그룹 이름(예 WAS · DB · 백업)" value={newGroup} onChange={(e) => setNewGroup(e.target.value.slice(0, 32))} onKeyDown={(e) => { if (e.key === 'Enter' && newGroup.trim()) createGroup(); }} />
              <button type="button" className="fm-btn" disabled={!!busy || !newGroup.trim()} onClick={createGroup}>새 그룹</button></div>
            <span className="fm-dim">이름은 글자 · 숫자 · 공백 · . _ - 로 1~32자. 지우면 그 그룹의 서버는 ‘{GROUP_NONE}’ 으로 갑니다(서버 · 기록은 그대로). CSV 에 ‘그룹’ 열을 넣으면 한 번에 정합니다.</span>
            {ungrouped && suggestions.length ? (
              <div className="fm-col">
                <b>자동 묶기 제안 — 그룹 없음 서버 {ungrouped}대</b>
                {suggestions.map((sg) => (
                  <div key={sg.kind} className="fm-sug"><div className="fm-row fm-between"><span style={{ fontWeight: 600 }}>{sg.title}</span><button type="button" className="fm-btn sm" disabled={!!busy} onClick={() => applySuggestion(sg)}>이대로 묶기</button></div>
                    <span className="fm-dim">{suggestionText(sg, ownGroups)}</span></div>
                ))}
                <span className="fm-dim">이미 그룹이 있는 서버는 건드리지 않습니다 · 둘 이상 묶이는 것만 제안합니다.</span>
              </div>
            ) : null}
          </div>
          <div className="fm-card">
            <div className="fm-row fm-between"><h3 className="fm-h3">기록 — DB 보관</h3><button type="button" className="fm-btn sm" onClick={() => setSettingsForm(setForm2 ? null : { ...main.settings })}>설정</button></div>
            <div className="fm-meter big"><span className="t"><span className="f" style={{ width: `${Math.min(100, ((main.recorder.dbBytes || 0) / (main.settings.capGb * 2 ** 30)) * 100)}%` }} /></span></div>
            <div className="fm-row fm-between"><span><b>{bytesText(main.recorder.dbBytes)}</b> <span className="fm-dim">/ 상한 {main.settings.capGb} GB</span></span><span className="fm-dim">보관 {main.settings.retentionDays}일{main.db.oldestMinute ? ` · 가장 오래된 기록 ${clockText(main.db.oldestMinute * 60_000, true)}` : ''}</span></div>
            {!main.db.available ? <div className="fm-ban w">기록 DB 를 열지 못했습니다 — 실시간 화면은 그대로지만 기록이 남지 않습니다{main.db.error ? `(${main.db.error})` : ''}.</div> : null}
            {main.recorder.paused ? <div className="fm-ban w">포탈 서버의 여유 공간이 부족해 기록을 멈췄습니다 — 수집과 화면은 계속됩니다(여유 {bytesText(main.recorder.freeBytes)}).</div> : null}
            <div className="fm-note">수집한 값과 프로세스 목록을 1분 단위로 묶어 DB 에 남깁니다. ‘잠깐 보기’ 는 켠 동안만, ‘계속 수집’ 은 끌 때까지 수집합니다(보는 화면이 없으면 {L.idleInterval}초 주기로 낮춰 기록). 상한에 닿으면 가장 오래된 기록부터 지웁니다.</div>
            {setForm2 ? (
              <div className="fm-form">
                {Object.entries({ retentionDays: '보관 일수', capGb: '용량 상한(GB)', warnPct: '주의(%)', critPct: '위험(%)', wAwaitWarnMs: '쓰기 지연 주의(ms)', edgeIdleSec: '엣지 쉬는 동안 조회(초)' }).filter(([k]) => main.settingRanges[k]).map(([k, l]) => (
                  <label key={k} className="fm-fld"><span>{l} <small className="fm-dim">{main.settingRanges[k][0]}~{main.settingRanges[k][1]}</small></span><input className="fm-input" value={setForm2[k]} onChange={(e) => setSettingsForm({ ...setForm2, [k]: e.target.value.replace(/[^0-9]/g, '').slice(0, 5) })} /></label>
                ))}
                <button type="button" className="fm-btn pri" disabled={!!busy} onClick={() => run('set', async () => { const r = await putJson('/tools/focus-mon/settings', Object.fromEntries(Object.entries(setForm2).map(([k, v]) => [k, Number(v)]))); if (r?.ok === false) return { ok: false, reason: r.reason || '설정을 저장하지 못했습니다.' }; setSettingsForm(null); return { ok: true, reason: r?.changed?.length ? '설정을 저장했습니다.' : '바뀐 값이 없습니다 — 저장하지 않았습니다.' }; })}>저장</button>
              </div>
            ) : null}
          </div>
          <div className="fm-card">
            <h3 className="fm-h3">노드별 SSH 공개키 · 엣지 연결</h3>
            <span className="fm-dim">개인키는 각 노드의 설정 폴더에만 있고 화면 · API · 백업에 실리지 않습니다. 서버에는 그 서버를 맡은 노드의 공개키 하나만 넣으면 됩니다.</span>
            {keyNodes.map((x) => (
              <NodeCard key={x.agent || 'central'} x={x} main={main} busy={busy} run={run} setMsg={setMsg} count={nodeTargets(x)}
                installOn={!!installNode && (installNode.agent || '') === (x.agent || '')} onInstall={() => setInstallFor(x.agent || '')} />
            ))}
            {idleEdges.length ? <span className="fm-dim">맡은 서버가 없는 엣지 {idleEdges.length}곳({idleEdges.slice(0, 6).map((x) => x.agent).join(', ')}{idleEdges.length > 6 ? ' …' : ''}) — 그 엣지에 서버를 등록하면 엣지가 키를 만들어 공개키를 올립니다.</span> : null}
          </div>
          <InstallCard node={installNode} main={main} setMsg={setMsg} defaultUser={form.username} />
        </div>
      </div>
    </>
  );
}

/* ── 메인 ─────────────────────────────────────────────────────────────────── */
export default function FocusMonTool() {
  const [route, go] = useRoute();
  const mainQ = usePoll('/tools/focus-mon', null, 5_000, true);
  const main = mainQ.data;
  const tb = useTimeBar(main?.limits?.windows);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const [viewIds, setViewIdsRaw] = useState(() => lsGet('fm.view', []));
  const [picked, setPicked] = useState([]);
  const [msg, setMsg] = useState(null);
  const [cmpMode, setCmpMode] = useState(() => lsGet('fm.cmp.mode', 'metric'));
  const setViewIds = useCallback((ids) => { setViewIdsRaw(ids); lsSet('fm.view', ids); }, []);
  const known = useMemo(() => new Set((main?.targets || []).map((t) => t.id)), [main?.targets]);
  const sessions = useMemo(() => main?.sessions || [], [main?.sessions]);
  const active = sessions.slice().sort((a, b) => b.startedAt - a.startedAt)[0] || null;
  // 따로 고른 서버가 없으면 **진행 중인 모든 수집의 서버**(v2.979 — 예전에는 가장 최근 수집만 보여 새 수집을 시작하면 먼저 돌던 서버가 화면에서 사라졌다:
  //   사용자 '기존 모니터링 돌고 있는데 추가하면 잘 안 돼'). 서버는 수집 하나에만 있으므로 합쳐도 겹치지 않는다 · 상한은 포탈 전체 동시 수집 대수.
  const ids = useMemo(() => {
    const v = viewIds.filter((x) => known.has(x));
    if (v.length) return v.slice(0, main?.limits?.maxPerSession || 20);
    const all = [...new Set(sessions.flatMap((s) => s.targets))].filter((x) => known.has(x));
    return all.slice(0, main?.limits?.maxTotal || 40);
  }, [viewIds, known, sessions, main?.limits?.maxPerSession, main?.limits?.maxTotal]);
  // v2.982 그룹 단추(개요 · 비교 · 프로세스) — 보고 있는 서버(ids)를 그룹으로 거른다. 고른 그룹은 브라우저가 기억한다(시안 ⑫ 컨펌 ⑤).
  const [vgroup, setVgroupRaw] = useState(() => lsGet('fm.view.group', 'all'));
  const setVgroup = useCallback((g) => { setVgroupRaw(g); lsSet('fm.view.group', g); }, []);
  const viewTargets = useMemo(() => { const m = new Map((main?.targets || []).map((t) => [t.id, t])); return ids.map((id) => m.get(id)).filter(Boolean); }, [ids, main?.targets]);
  const viewChips = useMemo(() => groupChips(viewTargets, main?.groups?.list), [viewTargets, main?.groups?.list]);
  const shownIds = useMemo(() => filterByGroup(viewTargets, vgroup).map((t) => t.id), [viewTargets, vgroup]);
  const covParams = useMemo(() => ({ targets: shownIds.join(','), to: tb.day ? dayRange(tb.day, Date.now()).to : '' }), [shownIds, tb.day]);
  const cov = usePoll('/tools/focus-mon/coverage', covParams, 60_000, shownIds.length > 0 && route.tab !== 'targets');
  useEffect(() => { if (!picked.length && main?.targets?.length) setPicked(ids.length ? ids.slice() : []); }, [main?.targets?.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (mainQ.error && !main) return <ErrorBox error={mainQ.error} />;
  if (!main) return <Loading />;
  const pill = sessions.length > 1
    ? { live: true, text: '수집 중', sub: `${sessions.length}건 · ${new Set(sessions.flatMap((s) => s.targets)).size}대` }
    : sessionPill(active, now);
  const mineSession = sessions.length === 1 ? active : null;
  const stopSession = (s, ask) => {
    if (ask && !window.confirm(`${sessionLabel(s, now)} 수집을 끝낼까요? 수집한 기록은 보관 기간 동안 남습니다.`)) return;
    delJson(`/tools/focus-mon/sessions/${encodeURIComponent(s.id)}`).then(() => { setMsg({ tone: 'ok', text: `${MODE_TEXT[s.mode]} ${s.targets.length}대 수집을 끝냈습니다.` }); mainQ.reload(); })
      .catch((e) => setMsg({ tone: 'bad', text: e?.body?.reason || e?.message }));
  };
  const stopAll = () => {
    if (!window.confirm(`진행 중인 수집 ${sessions.length}건(${new Set(sessions.flatMap((s) => s.targets)).size}대)을 모두 끝낼까요? 수집한 기록은 보관 기간 동안 남습니다.`)) return;
    Promise.allSettled(sessions.map((s) => delJson(`/tools/focus-mon/sessions/${encodeURIComponent(s.id)}`))).then((rs) => {
      const bad = rs.filter((x) => x.status === 'rejected').length;
      setMsg(bad ? { tone: 'bad', text: `${rs.length}건 가운데 ${bad}건을 끝내지 못했습니다 — 다시 누르세요.` } : { tone: 'ok', text: `수집 ${rs.length}건을 모두 끝냈습니다.` });
      mainQ.reload();
    });
  };
  const onOpen = (id) => go('server', id);
  const onWatch = (list) => { setViewIds(list); go('overview'); };
  const lastEnded = main.ended?.[0];
  return (
    <div className="fm-wrap">
      <div className="fm-row fm-between fm-head">
        <div className="fm-col"><span className="fm-dim">특수 기능 › 서버</span><h1 className="fm-h1">서버 집중 모니터링</h1></div>
        <div className="fm-row">
          <span className="fm-pill"><i className={pill.live ? 'on' : ''} /><b>{pill.text}</b><span className="fm-dim">· {pill.sub}{main.mock ? ' · 데모 모드' : ''}</span>{pill.remain ? <span className="fm-dim">남은 시간 <b className="fm-mono">{pill.remain}</b></span> : null}</span>
          {mineSession && mineSession.mode === 'watch' ? <button type="button" className="fm-btn" onClick={() => postJson(`/tools/focus-mon/sessions/${mineSession.id}/extend`, {}).then(() => mainQ.reload()).catch((e) => setMsg({ tone: 'bad', text: e?.body?.reason || e?.message }))}>{main.limits.watchMin}분 연장</button> : null}
          {mineSession ? <button type="button" className="fm-btn danger" onClick={() => stopSession(mineSession, mineSession.mode === 'record')}>수집 종료</button> : null}
          {sessions.length > 1 ? <button type="button" className="fm-btn danger" onClick={stopAll}>모두 종료 · {sessions.length}건</button> : null}
        </div>
      </div>
      <nav className="fm-tabs" aria-label="서버 집중 모니터링 보기">
        {TABS.map((t) => <a key={t.key} href={t.key === 'overview' ? `#/${BASE.join('/')}` : `#/${BASE.join('/')}/${t.key}`} className={route.tab === t.key || (route.tab === 'server' && t.key === 'overview') ? 'on' : ''}>{t.label}</a>)}
      </nav>
      {sessions.length > 1 ? (
        <div className="fm-row fm-sessions"><span className="fm-dim">진행 중인 수집 {sessions.length}건</span>
          {sessions.map((s) => (
            <span key={s.id} className={`fm-sess ${ids.join() === s.targets.join() ? 'on' : ''}`}>
              <button type="button" className="fm-linkbtn" onClick={() => setViewIds(s.targets)} title="이 수집의 서버만 봅니다">{sessionLabel(s, now)}</button>
              {s.mode === 'watch' ? <button type="button" className="fm-btn sm" onClick={() => postJson(`/tools/focus-mon/sessions/${encodeURIComponent(s.id)}/extend`, {}).then(() => mainQ.reload()).catch((e) => setMsg({ tone: 'bad', text: e?.body?.reason || e?.message }))}>{main.limits.watchMin}분 연장</button> : null}
              <button type="button" className="fm-btn sm danger" onClick={() => stopSession(s, s.mode === 'record')}>종료</button>
            </span>
          ))}
        </div>
      ) : null}
      {!active && lastEnded && route.tab !== 'targets' ? <div className="fm-ban">수집이 끝났습니다({ENDED_TEXT[lastEnded.why] || lastEnded.why}). 수집한 값은 DB 에 {main.settings.retentionDays}일 남아 시간 띠로 다시 볼 수 있습니다.</div> : null}
      {active?.mode === 'watch' && active.remainMs != null && active.remainMs < 2 * 60_000 ? <div className="fm-ban">남은 시간 {remainText(active.remainMs)} — 그 뒤 수집이 스스로 멈춥니다.</div> : null}
      {['overview', 'compare', 'procs'].includes(route.tab) && viewChips.length > 2 ? (
        <div className="fm-row" role="group" aria-label="그룹으로 거르기"><span className="fm-lbl">그룹</span>
          {viewChips.map((c) => { const on = groupChipOn(viewChips, vgroup, c.key); return <button key={`v-${c.key}`} type="button" className={`fm-chip ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => setVgroup(c.key)}>{c.label}<b>{c.n}</b></button>; })}
          <span className="fm-dim">보고 있는 서버 {ids.length}대 가운데 · 그룹은 ‘대상 · 키’ 탭에서 정합니다</span>
        </div>
      ) : null}
      {route.tab !== 'targets' && ids.length ? <TimeBar tb={tb} now={now} coverage={cov.data} oldestMinute={main.db.oldestMinute} /> : null}
      {route.tab === 'overview' ? <Overview main={main} ids={shownIds} tb={tb} now={now} onOpen={onOpen} /> : null}
      {route.tab === 'compare' ? (
        <>
          <div className="fm-row"><span className="fm-lbl">보기</span><Seg label="비교 보기" value={cmpMode} onChange={(v) => { setCmpMode(v); lsSet('fm.cmp.mode', v); }} options={[['metric', '지표 비교'], ['iostat', 'iostat 비교']]} /><span className="fm-dim">{cmpMode === 'metric' ? '지표 하나를 고른 서버 전부에서 봅니다' : '고른 서버의 iostat -x -m 을 같은 시각 · 같은 열로 맞춰 한 표에 놓습니다'}</span></div>
          {!shownIds.length ? <div className="fm-card fm-empty">볼 서버가 없습니다 — ‘대상 · 키’ 탭에서 고르세요.</div> : cmpMode === 'metric' ? <Compare main={main} ids={shownIds} tb={tb} now={now} onOpen={onOpen} /> : <IostatCompare main={main} ids={shownIds} tb={tb} onOpen={onOpen} />}
        </>
      ) : null}
      {route.tab === 'server' ? <ServerDetail main={main} id={route.server} tb={tb} now={now} onBack={() => go('overview')} /> : null}
      {route.tab === 'procs' ? (shownIds.length ? <Procs main={main} ids={shownIds} tb={tb} onOpen={onOpen} /> : <div className="fm-card fm-empty">볼 서버가 없습니다 — ‘대상 · 키’ 탭에서 고르세요.</div>) : null}
      {route.tab === 'targets' ? <Targets main={main} reload={mainQ.reload} picked={picked} setPicked={setPicked} onWatch={onWatch} msg={msg} setMsg={setMsg} /> : null}
      {msg && route.tab !== 'targets' ? <div className={`fm-ban ${msg.tone === 'bad' ? 'w' : ''}`}>{msg.text}</div> : null}
    </div>
  );
}
