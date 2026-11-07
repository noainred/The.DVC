/**
 * NodeLoadPanel — 스토리지 장비 상세 › 노드 부하 추이(v2.926).
 *
 * 사용자 요청(2026-11-07): 노드별 네트워크 부하 저장 + 차트 · 기간별·시간별 이전 기록 · 디스크 I/O · 성능 관점 추천(CPU · 잡 엔진 · 지난주 비교).
 * 설계·시안: docs/design/isilon-node-load/README.md (Claude Design 시안 v2 — 장비 상세 모달 900px 안에 맞췄다).
 *  · 데이터는 서버 DB 만 읽는다(장비 호출 0). 마운트·조작 때 1회 + 최신 창이면 새 수집(collectedAt)이 올 때 1회 — 폴링하지 않는다.
 *  · 늦게 온 이전 응답은 버린다(seq). 훅은 조기 return 위에 둔다(React #310).
 *  · 판정·문구는 nodeLoadText.js(순수 — vitest).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { fetchJson } from '../../../api.js';
import { numOrNull } from '../../../numOrNull.js';
import {
  RANGES, rangeOf, SELECTS, selectOf, GROUP_TEXT, SERIES_TEXT, SERIES_COLOR, OVERLAY_COLORS, OVERLAY_MAX, BASELINE_COLOR, HEAT_RAMP,
  groupsAvailable, valueText, pickSeries, rankNodes, heatScaleMax, heatBin, colText, colKindText, tickEvery, drillEndOf, scrollToEnd,
  portalLocalToMs, msToPortalLocal, rangeLimitText, jobsByCol, tilesOf, notesOf, sparkPath, sampleText, sourceText, alignBaseline,
  maxBackOf, windowEndOf, windowLabel, windowRangeText,
} from './nodeLoadText.js';
import './nodeLoad.css';

function Seg({ label, items, value, onPick }) {
  return (
    <div className="nl-segwrap">
      <span className="nl-seglabel">{label}</span>
      <div className="nl-seg" role="group" aria-label={label}>
        {items.map((it) => (
          <button key={it.key} type="button" className={value === it.key ? 'on' : ''} aria-pressed={value === it.key} onClick={() => onPick(it.key)}>{it.label}</button>
        ))}
      </div>
    </div>
  );
}

function WindowRow({ d, back, dragBack, anchor, onDrag, onGo, onJumpEnd }) {
  const a = anchor ?? d.end;
  const maxB = maxBackOf(d, a);
  if (!maxB && !back) return <div className="nl-note">이전 구간 — 아직 이 기간보다 오래된 기록이 없습니다. {rangeLimitText(d, 0)}</div>;
  const cur = Math.min(maxB, dragBack ?? back);
  const lbl = rangeOf(d.range).label;
  const { end } = windowEndOf(a, cur, d.days, maxB);
  return (
    <div className="nl-winrow">
      <div className="nl-winbtns">
        <button type="button" className="nl-btn" disabled={cur >= maxB} onClick={() => onGo(cur + 1, maxB)}>◀ 이전 {lbl}</button>
        <input type="range" className="nl-slider" min={0} max={maxB} step={1} value={maxB - cur} aria-label="조회 구간 스크롤(오른쪽 끝 = 최근)"
          onChange={(e) => onDrag(maxB - Number(e.target.value))}
          onPointerUp={(e) => onGo(maxB - Number(e.currentTarget.value), maxB)}
          onKeyUp={(e) => onGo(maxB - Number(e.currentTarget.value), maxB)} />
        <button type="button" className="nl-btn" disabled={cur <= 0} onClick={() => onGo(cur - 1, maxB)}>다음 {lbl} ▶</button>
        <button type="button" className={`nl-btn${cur === 0 ? ' primary' : ''}`} disabled={cur === 0} onClick={() => onGo(0, maxB)}>최신</button>
        <label className="nl-jump">
          <span>날짜·시각으로 이동</span>
          <input type="datetime-local" step={3600} value={msToPortalLocal(end, d.offsetMin)} max={msToPortalLocal(d.now, d.offsetMin)}
            onChange={(e) => { const t = portalLocalToMs(e.target.value, d.offsetMin); if (t != null) onJumpEnd(t, maxB); }} />
        </label>
      </div>
      <div className="nl-note">
        {windowLabel(cur, d.days)} · {windowRangeText(end, d.days, d.offsetMin)}{cur > 0 ? ' · 과거 구간은 자동 갱신하지 않습니다' : ' · 새 수집이 오면 갱신합니다'}
        {dragBack != null ? ' · 놓으면 조회합니다' : ''} · {rangeLimitText(d, maxB)}
      </div>
    </div>
  );
}

function Heatmap({ d, sel, jobsCol, onDrill, onPickNode }) {
  const unit = selectOf(sel).unit;
  const max = heatScaleMax(d, sel);
  const n = d.cols.length;
  const every = tickEvery(n);
  const cellH = d.nodes.length > 32 ? 9 : d.nodes.length > 16 ? 14 : 20;
  const drill = d.kind !== 'raw';
  const grid = { gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` };
  // 칸이 4px(틈 포함) 아래로 줄 때만 상자 안 가로 스크롤 — 24칸은 400px 에서도 그대로 들어간다(Chromium 400 판독).
  const rowMin = { minWidth: 72 + n * 4 };
  return (
    <div className="nl-heat">
      <div className="nl-heatrow nl-heathead" style={rowMin}>
        <div className="nl-heatname" />
        <div className="nl-heatcells" style={grid}>
          {d.cols.map((t, i) => (drill
            ? <button key={t} type="button" className="nl-colbtn" title={`${colText(t, d.kind, d.bucketMs, d.offsetMin)} — 눌러서 그 날 24시간(시간별) 보기`} onClick={() => onDrill(t)}>{i % every === 0 && i + every < n ? colText(t, d.kind, d.bucketMs, d.offsetMin).slice(0, 5) : ''}</button>
            : <span key={t} className="nl-coltick">{i % every === 0 && i + every < n ? colText(t, d.kind, d.bucketMs, d.offsetMin).slice(6) : ''}</span>))}
        </div>
      </div>
      {d.nodes.map((nd) => {
        const vals = pickSeries(nd.v, sel); const peaks = nd.mx ? pickSeries(nd.mx, sel) : null;
        return (
          <div key={nd.id} className="nl-heatrow" style={rowMin}>
            <button type="button" className="nl-heatname" title="겹쳐 보기에 넣기" onClick={() => onPickNode(nd.id)}>노드 {nd.id}</button>
            <div className="nl-heatcells" style={grid}>
              {vals.map((v, i) => {
                const b = heatBin(v, max);
                const tip = `노드 ${nd.id} · ${colText(d.cols[i], d.kind, d.bucketMs, d.offsetMin)} · ${b == null ? '값 없음(읽지 못함 — 0 이 아닙니다)' : valueText(unit, v)}${peaks && peaks[i] != null ? ` · 최대 ${valueText(unit, peaks[i])}` : ''}`;
                return <i key={d.cols[i]} title={tip} className={b == null ? 'nl-cell miss' : 'nl-cell'} style={{ height: cellH, background: b == null ? undefined : HEAT_RAMP[b] }} />;
              })}
            </div>
          </div>
        );
      })}
      {jobsCol && (
        <div className="nl-heatrow nl-jobsrow" style={rowMin}>
          <div className="nl-heatname nl-muted">잡 엔진</div>
          <div className="nl-heatcells" style={grid}>
            {jobsCol.map((j, i) => <i key={d.cols[i]} className={j ? 'nl-job on' : 'nl-job'} title={j ? `${colText(d.cols[i], d.kind, d.bucketMs, d.offsetMin)} · 돌던 잡: ${j.join(', ')}` : `${colText(d.cols[i], d.kind, d.bucketMs, d.offsetMin)} · 돌던 잡 없음`} />)}
          </div>
        </div>
      )}
      <div className="nl-legend">
        <span>0</span>
        {HEAT_RAMP.map((c) => <i key={c} style={{ background: c }} aria-hidden="true" />)}
        <span>{valueText(unit, max)}</span>
        <span className="nl-legmiss"><i className="nl-cell miss" aria-hidden="true" />값 없음</span>
        {jobsCol && <span className="nl-legmiss"><i className="nl-job on" aria-hidden="true" />잡 실행 중</span>}
      </div>
    </div>
  );
}

function RankList({ d, sel }) {
  const unit = selectOf(sel).unit;
  const rows = rankNodes(d, sel);
  return (
    <div className="nl-rank">
      {rows.map((r) => (
        <div key={r.id} className="nl-rankrow" title={`노드 ${r.id} · 평균 ${valueText(unit, r.avg)} · 최대 ${valueText(unit, r.peak)} · 읽은 칸 ${r.n} / 빈 칸 ${r.missing}`}>
          <span>노드 {r.id}</span>
          <span className="nl-track"><i style={{ width: `${r.w}%` }} /></span>
          <span className="nl-num">{valueText(unit, r.avg)}</span>
        </div>
      ))}
    </div>
  );
}

function ChartTip({ active, payload, label, unit, offsetMin, kind, bucketMs, jobsAt }) {
  if (!active || !payload?.length) return null;
  const jobs = jobsAt ? jobsAt(label) : null;
  return (
    <div className="nl-tip">
      <div className="nl-muted">{colText(label, kind, bucketMs, offsetMin)}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="nl-tiprow"><i style={{ background: p.color }} aria-hidden="true" /><b>{valueText(unit, p.value)}</b><span className="nl-muted">{p.name}</span></div>
      ))}
      {jobs && jobs.length ? <div className="nl-muted">잡: {jobs.join(', ')}</div> : null}
    </div>
  );
}

function ClusterChart({ d, sel, jobsCol }) {
  const s = selectOf(sel);
  const parts = s.group === 'cpu' ? ['cpu'] : (s.group === 'net' ? ['in', 'out'] : ['din', 'dout']);
  // 비교 구간은 지금 칸에 맞춰 같은 배열에 싣는다(칸 간격의 절반 안 — 원시는 수집 주기, 버킷·일은 그 길이).
  const step = d.kind === 'raw' ? (numOrNull(d.sampleMs) || 3_600_000) : (numOrNull(d.bucketMs) || 86_400_000);
  const baseAligned = alignBaseline(d.cols, d.baseline?.cols, pickSeries(d.baseline?.cluster, sel), step / 2);
  const data = d.cols.map((ts, i) => {
    const row = { ts, base: baseAligned[i] };
    for (const k of parts) row[k] = numOrNull(d.cluster?.[k]?.[i]);
    return row;
  });
  const hasBase = baseAligned.some((v) => v != null);
  const jobsAt = jobsCol ? (ts) => { const i = d.cols.indexOf(ts); return i >= 0 ? jobsCol[i] : null; } : null;
  const fmt = (v) => valueText(s.unit, v);
  return (
    <div className="nl-chart">
      <ResponsiveContainer width="100%" height={210}>
        <LineChart data={data} margin={{ top: 6, right: 12, left: 4, bottom: 0 }}>
          <CartesianGrid stroke="rgba(255,255,255,.07)" vertical={false} />
          <XAxis dataKey="ts" type="number" domain={[d.start, d.end]} allowDataOverflow tick={{ fontSize: 11 }} minTickGap={48}
            tickFormatter={(t) => (d.kind === 'daily' ? colText(t, 'daily', 0, d.offsetMin) : colText(t, 'raw', 0, d.offsetMin).slice(d.days > 1 ? 0 : 6))} />
          <YAxis tick={{ fontSize: 11 }} width={76} tickFormatter={fmt} domain={s.unit === '%' ? [0, 100] : [0, 'auto']} />
          <Tooltip content={<ChartTip unit={s.unit} offsetMin={d.offsetMin} kind={d.kind} bucketMs={d.bucketMs} jobsAt={jobsAt} />} />
          {hasBase && <Line dataKey="base" name={`${d.baseline.label} (${s.label})`} stroke={BASELINE_COLOR} strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls={false} />}
          {parts.map((k) => <Line key={k} dataKey={k} name={SERIES_TEXT[k]} stroke={SERIES_COLOR[k]} strokeWidth={2} dot={data.length < 3} isAnimationActive={false} connectNulls={false} />)}
        </LineChart>
      </ResponsiveContainer>
      <div className="nl-legend">
        {parts.map((k) => <span key={k} className="nl-key"><i style={{ background: SERIES_COLOR[k] }} aria-hidden="true" />{SERIES_TEXT[k]}</span>)}
        {hasBase ? <span className="nl-key"><i style={{ background: BASELINE_COLOR }} aria-hidden="true" />{d.baseline.label}({s.label})</span>
          : <span className="nl-muted">{d.baseline?.label} 기록이 없어 비교 선을 그리지 않았습니다.</span>}
      </div>
    </div>
  );
}

function Multiples({ d, sel }) {
  const s = selectOf(sel);
  const parts = s.group === 'cpu' ? ['cpu'] : (s.group === 'net' ? ['in', 'out'] : ['din', 'dout']);
  let max = s.unit === '%' ? 100 : 0;
  if (!max) for (const nd of d.nodes) for (const k of parts) for (const v of nd.v[k] || []) if (v != null && v > max) max = v;
  return (
    <div className="nl-multi">
      {d.nodes.map((nd) => (
        <div key={nd.id} className="nl-mcard">
          <div className="nl-mhead"><b>노드 {nd.id}</b><span className="nl-muted">{parts.map((k) => `${SERIES_TEXT[k]} ${valueText(s.unit, rankNodes({ nodes: [nd] }, k)[0]?.avg)}`).join(' · ')}</span></div>
          <svg viewBox="0 0 200 48" preserveAspectRatio="none" className="nl-msvg" role="img" aria-label={`노드 ${nd.id} ${GROUP_TEXT[s.group]} 추이`}>
            {parts.map((k) => <path key={k} d={sparkPath(nd.v[k], { w: 200, h: 48, max, pad: 3 })} fill="none" stroke={SERIES_COLOR[k]} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />)}
          </svg>
        </div>
      ))}
      <div className="nl-note nl-full">Y 축 공통(0 ~ {valueText(s.unit, max)}) — 노드끼리 높이를 그대로 비교할 수 있습니다. 끊긴 곳은 값을 읽지 못한 칸입니다.</div>
    </div>
  );
}

function Overlay({ d, sel, picks, onToggle }) {
  const s = selectOf(sel);
  const shown = picks.filter((p) => d.nodes.some((n) => n.id === p.id));
  const data = d.cols.map((ts, i) => {
    const row = { ts };
    for (const p of shown) row[`n${p.id}`] = pickSeries(d.nodes.find((n) => n.id === p.id).v, sel)[i];
    return row;
  });
  return (
    <div className="nl-overlay">
      <fieldset className="nl-picks">
        <legend>겹쳐 볼 노드(최대 {OVERLAY_MAX}) · {SELECTS.find((x) => x.key === sel)?.label}</legend>
        {d.nodes.map((nd) => {
          const p = picks.find((x) => x.id === nd.id);
          const full = !p && picks.length >= OVERLAY_MAX;
          return (
            <label key={nd.id} className={full ? 'off' : ''}>
              <input type="checkbox" checked={!!p} disabled={full} onChange={() => onToggle(nd.id)} />
              {p ? <i style={{ background: OVERLAY_COLORS[p.slot] }} aria-hidden="true" /> : null}노드 {nd.id}
            </label>
          );
        })}
      </fieldset>
      {!shown.length ? <div className="nl-note">위에서 노드를 고르세요 — 히트맵의 노드 이름을 눌러도 들어옵니다. 색은 고른 순서의 칸에 붙고, 선택을 바꿔도 남은 노드 색은 그대로입니다.</div> : (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data} margin={{ top: 6, right: 12, left: 4, bottom: 0 }}>
            <CartesianGrid stroke="rgba(255,255,255,.07)" vertical={false} />
            <XAxis dataKey="ts" type="number" domain={[d.start, d.end]} allowDataOverflow tick={{ fontSize: 11 }} minTickGap={48}
              tickFormatter={(t) => (d.kind === 'daily' ? colText(t, 'daily', 0, d.offsetMin) : colText(t, 'raw', 0, d.offsetMin).slice(d.days > 1 ? 0 : 6))} />
            <YAxis tick={{ fontSize: 11 }} width={76} tickFormatter={(v) => valueText(s.unit, v)} domain={s.unit === '%' ? [0, 100] : [0, 'auto']} />
            <Tooltip content={<ChartTip unit={s.unit} offsetMin={d.offsetMin} kind={d.kind} bucketMs={d.bucketMs} />} />
            {shown.map((p) => <Line key={p.id} dataKey={`n${p.id}`} name={`노드 ${p.id}`} stroke={OVERLAY_COLORS[p.slot]} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />)}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

/**
 * @param {{deviceId:string, snap:object, isEdge:boolean}} props
 */
export default function NodeLoadPanel({ deviceId, snap, isEdge }) {
  const list = useMemo(() => (Array.isArray(snap?.nodes?.list) ? snap.nodes.list : []), [snap]);
  const avail = useMemo(() => groupsAvailable(list), [list]);
  const [range, setRange] = useState('24h');
  const [sel, setSel] = useState('in');
  const [view, setView] = useState('heat');
  const [picks, setPicks] = useState([]);   // [{id, slot}] — 색 칸은 고를 때 정해진다
  const scrollKey = `${deviceId}|${range}`;
  const [scroll, setScroll] = useState({ key: scrollKey, back: 0, anchor: null });
  const [dragBack, setDragBack] = useState(null);
  const back = scroll.key === scrollKey ? scroll.back : 0;
  const anchor = scroll.key === scrollKey ? scroll.anchor : null;
  const days = rangeOf(range).days;
  const end = back > 0 && anchor != null ? windowEndOf(anchor, back, days).end : null;
  const group = selectOf(sel).group;
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  // 최신 창은 새 수집(스냅샷 시각)이 오면 다시 부른다 — 과거 창은 그대로 둔다(자동 갱신하지 않는다).
  const refreshKey = end == null ? numOrNull(snap?.collectedAt) : null;

  // 고른 값이 이 장비에 없는 묶음이면 있는 묶음으로 옮긴다(디스크 키가 없는 장비 등).
  useEffect(() => {
    if (avail[group]) return;
    const first = ['net', 'disk', 'cpu'].find((g) => avail[g]);
    if (first) setSel(first === 'net' ? 'in' : first === 'disk' ? 'din' : 'cpu');
  }, [avail, group]);

  useEffect(() => {
    const my = ++seq.current;
    setBusy(true); setErr(null);
    const q = `range=${encodeURIComponent(range)}&group=${encodeURIComponent(group)}${end != null ? `&end=${end}` : ''}`;
    fetchJson(`/tools/storage/devices/${encodeURIComponent(deviceId)}/node-load?${q}`)
      .then((r) => { if (my === seq.current) { setD(r); setBusy(false); } })
      .catch((e) => { if (my === seq.current) { setErr(e); setBusy(false); } });
  }, [deviceId, range, group, end, refreshKey]);

  const jobsCol = useMemo(() => (d ? jobsByCol(d) : null), [d]);

  const goScroll = (next, maxB) => {
    const b = Math.max(0, Math.min(maxB, next));
    setDragBack(null);
    setScroll({ key: scrollKey, back: b, anchor: b === 0 ? null : (anchor ?? d?.end ?? Date.now()) });
  };
  const jumpEnd = (t, maxB) => {
    setDragBack(null);
    const r = scrollToEnd(t, { days, now: Date.now(), maxBack: maxB });
    setScroll({ key: scrollKey, back: r.back, anchor: r.anchor });
  };
  const drill = (colTs) => {
    const e = drillEndOf(colTs, d?.offsetMin ?? 540, Date.now());
    const r = scrollToEnd(e, { days: 1, now: Date.now() });
    setRange('24h');
    setScroll({ key: `${deviceId}|24h`, back: r.back, anchor: r.anchor });
  };
  const togglePick = (id) => setPicks((prev) => {
    if (prev.some((p) => p.id === id)) return prev.filter((p) => p.id !== id);
    if (prev.length >= OVERLAY_MAX) return prev;
    const used = new Set(prev.map((p) => p.slot));
    const slot = [...Array(OVERLAY_MAX).keys()].find((k) => !used.has(k));
    return [...prev, { id, slot }];
  });
  const pickFromHeat = (id) => { if (!picks.some((p) => p.id === id)) togglePick(id); setView('overlay'); };

  const groups = ['net', 'disk', 'cpu'].filter((g) => avail[g]);
  if (!groups.length) return null;
  const tiles = d && d.group === group && d.deviceId === deviceId && (d.cols || []).length ? tilesOf(d, sel) : null;
  const unit = selectOf(sel).unit;
  const notes = notesOf(d, { snapCount: snap?.nodes?.count, listed: list.length, isEdge, sel });
  // 다른 장비·묶음의 늦은 응답이나 이전 응답을 이 장비 값처럼 그리지 않는다.
  const ready = d && d.ok !== false && d.group === group && d.deviceId === deviceId;

  return (
    <section className="nl" aria-label="노드 부하 추이">
      <div className="nl-head">
        <div className="section-title" style={{ fontSize: 13, margin: 0 }}>노드 부하 추이 <span className="nl-muted">— {groups.map((g) => GROUP_TEXT[g]).join(' · ')}</span></div>
        <div className="nl-pills">
          <span className="nl-pill">출처 {sourceText(snap, group)}</span>
          <span className="nl-pill">표본 수집 주기마다 1회 · 순간값(주기 {sampleText(d?.sampleMs)} — 설정값)</span>
        </div>
      </div>
      <div className="nl-controls">
        <Seg label="기간" items={RANGES} value={range} onPick={(k) => { setRange(k); setDragBack(null); }} />
        {groups.map((g) => (
          <Seg key={g} label={GROUP_TEXT[g]} items={SELECTS.filter((x) => x.group === g)} value={group === g ? sel : null} onPick={setSel} />
        ))}
        <Seg label="보기" items={[{ key: 'heat', label: '히트맵' }, { key: 'multi', label: '소형 다중' }, { key: 'overlay', label: '겹쳐 보기' }]} value={view} onPick={setView} />
        {busy && <span className="nl-muted">불러오는 중…</span>}
      </div>
      {err && <div className="nl-banner amber">노드 부하 조회 오류: {String(err?.message || err)}</div>}
      {ready && <WindowRow d={d} back={back} dragBack={dragBack} anchor={anchor} onDrag={setDragBack} onGo={goScroll} onJumpEnd={jumpEnd} />}
      {notes.map((n) => <div key={n.text} className={`nl-banner ${n.tone}`}>{n.text}</div>)}
      {ready && tiles && (
        <>
          <div className="nl-tiles">
            <div className="nl-tile"><span className="nl-tlabel">클러스터 {tiles.clusterKind} · {back > 0 ? '창 끝 칸' : '마지막 칸'}</span>
              <b>{valueText(unit, tiles.clusterLast)}</b><span className="nl-muted">{tiles.clusterLastAt != null ? colText(tiles.clusterLastAt, d.kind, d.bucketMs, d.offsetMin) : '합계를 낸 칸이 없습니다'}</span></div>
            <div className="nl-tile"><span className="nl-tlabel">가장 바쁜 노드 · 기간 평균</span>
              <b>{tiles.busy ? `노드 ${tiles.busy.id}` : '—'}</b><span className="nl-muted">{tiles.busy ? `${valueText(unit, tiles.busy.avg)}${tiles.busyRatio != null ? ` · 노드 평균의 ${tiles.busyRatio}배` : ''}` : '—'}</span></div>
            <div className="nl-tile"><span className="nl-tlabel">가장 한가한 노드 · 기간 평균</span>
              <b>{tiles.idle ? `노드 ${tiles.idle.id}` : '—'}</b><span className="nl-muted">{tiles.idle ? `${valueText(unit, tiles.idle.avg)}${tiles.spread != null ? ` · 최대 노드와 ${tiles.spread}배 차이` : ''}` : '—'}</span></div>
            <div className="nl-tile"><span className="nl-tlabel">{tiles.compareLabel} 대비 · 클러스터 평균</span>
              <b>{tiles.compare == null ? '—' : `${tiles.compare > 0 ? '+' : ''}${tiles.compare}%`}</b>
              <span className="nl-muted">{tiles.compare == null ? '두 구간 모두 합계를 낸 칸이 절반 이상일 때만 비교합니다' : '같은 길이 · 같은 시간대 평균끼리'}</span></div>
          </div>
          <div className="nl-subhead">{view === 'heat' ? '노드 × 시간' : view === 'multi' ? '소형 다중' : '겹쳐 보기'} · {SELECTS.find((x) => x.key === sel)?.label} · 칸 = {colKindText(d.kind, d.bucketMs)}{view === 'heat' && d.kind !== 'raw' ? ' · 머리줄 날짜를 누르면 그 날 24시간(시간별)' : ''}</div>
          {view === 'heat' && (
            <div className="nl-body">
              <div className="nl-main"><Heatmap d={d} sel={sel} jobsCol={jobsCol} onDrill={drill} onPickNode={pickFromHeat} /></div>
              <div className="nl-side"><div className="nl-sidehead">노드 순위 · 기간 평균</div><RankList d={d} sel={sel} /></div>
            </div>
          )}
          {view === 'multi' && <Multiples d={d} sel={sel} />}
          {view === 'overlay' && <Overlay d={d} sel={sel} picks={picks} onToggle={togglePick} />}
          <div className="nl-subhead">클러스터 {tiles.clusterKind} 추이 · 칸의 노드를 전부 읽었을 때만 {unit === '%' ? '평균을' : '합계를'} 냅니다{d.jobsKnown ? ' · 툴팁에 그때 돌던 잡' : ''}</div>
          <ClusterChart d={d} sel={sel} jobsCol={jobsCol} />
          <div className="nl-note">읽는 법 — 값은 장비가 보고한 그 시점의 처리량·사용률이고 수집 주기마다 한 번 읽습니다(주기 사이는 모릅니다). 네트워크는 bps, 디스크는 B/s, CPU 는 %입니다. 디스크 쓰기(In)·읽기(Out) 방향과 CPU 키 단위는 실장비 확인 전 가정입니다. {d.jobsKnown ? '' : '잡 엔진은 SSH 수집 장비만 읽습니다.'}</div>
        </>
      )}
    </section>
  );
}
