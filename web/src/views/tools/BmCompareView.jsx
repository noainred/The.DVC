/**
 * 리눅스 성능 6단계 — **서버 비교(2~5대 한 화면)**(설계 PROFILES §15 · 아트보드 Multi).
 *
 * 머리(기간 · 세트 저장 · CSV · 공유) → 범위(같은 법인만 · 법인 간 허용 — 전체 범위 계정만 보인다) → 고른 서버 칩(열 상태 · ✕) → 저장된 세트 · 동시 집중 →
 * 보기(나란히 · 겹쳐서 · 표) · 지표 묶음 · 값 모드 → 본문.
 * ⚠ 이 파일은 조립만 — 편차 · 최고 · 스큐 · 눈금 · 잘림 · 열 상태는 서버(multiCompare.js)가, 문구 · 좌표는 bmCompareText.js 가 소유한다.
 * ⚠ 조회는 고른 서버 · 기간 · 묶음이 바뀔 때 1회(폴링 없음) · 늦게 온 이전 응답은 버린다(세대) · 403 은 ErrorBox.
 * ⚠ 쓰기(세트 저장 · 동시 집중)는 operator 이상(서버가 다시 검사) · 저장 결과는 r?.ok === false 로 검사(sendJson 은 400 · 409 를 던지지 않는다).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, delJson, hasRole, canCsv } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import Select from '../../components/Select.jsx';
import { toneVar } from './toneVar.js';
import { VerdictBadge } from './BmPerfBoard.jsx';
import { fmtHm } from '../../components/vmperf/vmPerfText.js';
import { shortStamp } from './bmOpsText.js';
import {
  COMPARE_GROUP_TEXT, COMPARE_VIEW_TEXT, COMPARE_VIEWS, COMPARE_VALUE_TEXT, COMPARE_RANGES, columnStateView, metricLabel, metricUnit, cellPairText, cmpValText, rowBasisNote,
  colorPlan, sparkPath, corpsReadText, devText, COMPARE_TABLE_NOTE, COMPARE_HONEST, skewText, baselineCellText, focusStartSummary, compareCsv, compareCsvName,
} from './bmCompareText.js';
import { useAnnotations } from './BmAnnotations.jsx';
import { parseRef, refOf, normCompareResp, corpLabel } from './bmPerfUrl.js'; // 다음 점검 ①: 비교 열 = (법인, 키) 쌍
import BmShareButtons from './BmShareButtons.jsx'; // 6단계 공유 링크 · 캡처
import './bmStage6.css';

/** 조회기 — 세대로 늦게 온 이전 응답을 버린다(테스트가 가짜 fetcher 로 고정). */
export function createCompareLoader(fetcher = (q) => fetchJson('/tools/bm-usage/compare', q, undefined, { timeoutMs: 120_000, retries: 0 })) {
  let gen = 0;
  return {
    async load(q, set) {
      const g = ++gen;
      set({ loading: true, err: null });
      try { const d = await fetcher(q); if (g !== gen) return 'stale'; set({ resp: d, loading: false }); return 'ok'; }
      catch (e) { if (g !== gen) return 'stale'; set({ resp: null, err: e, loading: false }); return 'err'; }
    },
  };
}

function Spark({ spark, scale, from, to, stroke, valueMode = 'avgpeak', w = 120, h = 26 }) {
  const avg = valueMode !== 'peak' ? sparkPath(spark, { pick: 1, scale, w, h, from, to }) : '';
  const pk = valueMode !== 'avg' ? sparkPath(spark, { pick: 2, scale, w, h, from, to }) : '';
  if (!avg && !pk) return <span className="bmcmp-nospark">추이 없음</span>;
  return (
    <svg className="bmcmp-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      {avg && <path d={avg} fill="none" stroke="var(--text-faint)" strokeWidth="1.6" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
      {pk && <path d={pk} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

/** 칸 하나(나란히 보기) — 지금 평균/피크 + 스파크(같은 행은 같은 눈금 · 넘으면 ‘잘림’). */
function SideCell({ row, col, resp, color, valueMode }) {
  const cell = (row.cells || []).find((x) => x.key === col.key) || null;
  const unit = metricUnit(row.col, resp.metricMeta);
  const s = col.series?.[row.col] || null;
  return (
    <div className="bmcmp-cell">
      <div className="bmcmp-cv">{cellPairText(cell?.now || cell?.win, unit, valueMode, row.peakCapable !== false)}</div>
      {row.src === 'series' ? <Spark spark={s?.spark} scale={row.scale} from={resp.from} to={resp.to} stroke={color.stroke} valueMode={valueMode} /> : <span className="bmcmp-nospark">지금 값(iDRAC)</span>}
      {cell?.clipped && <span className="bmcmp-clip" title="피크가 이 행의 눈금 밖입니다 — 표 보기에서 값을 보십시오">잘림</span>}
      {s?.missing ? <span className="bmcmp-miss">결측 {s.missing}</span> : null}
    </div>
  );
}

export function CompareSide({ resp, nameOf, colors, valueMode, devHigh }) {
  const cols = (resp.columns || []).filter((c) => c.state === 'ok' || c.state === 'stale');
  const rows = resp.table?.rows || [];
  if (!cols.length) return <p className="bmo-note">값을 그릴 서버가 없습니다 — 위 칩의 상태를 보십시오.</p>;
  return (
    <>
      {/* 넓은 화면: 열 = 서버 · 행 = 지표 */}
      <div className="bmcmp-side" style={{ gridTemplateColumns: `minmax(120px, 160px) repeat(${cols.length}, minmax(0, 1fr))` }}>
        <div className="bmcmp-h" />
        {cols.map((c) => (
          <div key={c.key} className="bmcmp-h" style={{ borderTopColor: colors[c.key]?.stroke }}>
            <div className="bmcmp-hn">{nameOf(c.key)}</div>
            <div className="bmcmp-hs">{c.verdict ? <VerdictBadge verdict={c.verdict} /> : '—'} {c.vcenterId || '귀속 없음'}</div>
          </div>
        ))}
        {rows.map((r) => (
          <React.Fragment key={r.col}>
            <div className={`bmcmp-rl${devHigh && r.devHigh ? ' bmcmp-hi' : ''}`}>
              <div>{metricLabel(r.col)}</div>
              <div className="bmcmp-rs">{r.scale != null ? `눈금 0–${cmpValText(r.scale, metricUnit(r.col, resp.metricMeta))}` : '눈금 없음'}{r.dev != null ? ` · 편차 ${devText(r.dev)}` : ''}{rowBasisNote(r, valueMode) ? ` · ${rowBasisNote(r, valueMode)}` : ''}</div>
            </div>
            {cols.map((c) => <SideCell key={c.key} row={r} col={c} resp={resp} color={colors[c.key] || {}} valueMode={valueMode} />)}
          </React.Fragment>
        ))}
      </div>
      {/* 400 폭: 서버 블록이 아래로 쌓이고 행 머리가 블록 위에 */}
      <div className="bmcmp-stack">
        {cols.map((c) => (
          <div key={c.key} className="bmcmp-block" style={{ borderLeftColor: colors[c.key]?.stroke }}>
            <div className="bmcmp-hn">{nameOf(c.key)} {c.verdict && <VerdictBadge verdict={c.verdict} />}</div>
            {rows.map((r) => (
              <div key={r.col} className="bmcmp-brow">
                <div className="bmcmp-rl2">{metricLabel(r.col)}</div>
                <SideCell row={r} col={c} resp={resp} color={colors[c.key] || {}} valueMode={valueMode} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

export function CompareOverlay({ resp, nameOf, colors, valueMode, metric, onMetric, annotations = [] }) {
  const [solo, setSolo] = useState('');
  const rows = (resp.table?.rows || []).filter((r) => r.src === 'series');
  const row = rows.find((r) => r.col === metric) || rows[0] || null;
  const cols = (resp.columns || []).filter((c) => c.state === 'ok' || c.state === 'stale');
  if (!row) return <p className="bmo-note">겹쳐 그릴 추이 지표가 없습니다(하드웨어 지표는 지금 값만 있습니다).</p>;
  const W = 1000; const H = 220;
  const unit = metricUnit(row.col, resp.metricMeta);
  const scale = row.scale ?? 1;
  const shown = cols.filter((c) => !solo || c.key === solo);
  const span = resp.to - resp.from;
  return (
    <div className="bmcmp-ov">
      <div className="bmcmp-ctl">
        <span className="bmo-k">지표</span>
        <Select className="input" sort={false} value={row.col} onChange={(e) => onMetric(e.target.value)} aria-label="겹쳐 볼 지표">
          {rows.map((r) => <option key={r.col} value={r.col}>{metricLabel(r.col)}</option>)}
        </Select>
        <span className="bmo-note" style={{ margin: 0 }}>눈금 0–{cmpValText(scale, unit)} · {COMPARE_VALUE_TEXT[valueMode]}{valueMode === 'avgpeak' ? '(평균 실선 · 피크 점선)' : ''}</span>
      </div>
      <svg className="bmcmp-ovsvg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${metricLabel(row.col)} 서버별 겹쳐 보기`}>
        {[0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke="var(--border-soft)" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
        {annotations.filter((a) => a.at >= resp.from && a.at <= resp.to).map((a) => {
          const x = ((a.at - resp.from) / span) * W;
          return <g key={a.id}><line x1={x} x2={x} y1="0" y2={H} stroke="var(--purple)" strokeDasharray="3 3" strokeWidth="1" vectorEffect="non-scaling-stroke" /><title>{`◆ ${fmtHm(a.at)} ${a.text || ''}`}</title></g>;
        })}
        {shown.map((c) => {
          const s = c.series?.[row.col];
          const st = colors[c.key] || {};
          const avg = valueMode !== 'peak' ? sparkPath(s?.spark, { pick: 1, scale, w: W, h: H, from: resp.from, to: resp.to }) : '';
          const pk = valueMode !== 'avg' ? sparkPath(s?.spark, { pick: 2, scale, w: W, h: H, from: resp.from, to: resp.to }) : '';
          return (
            <g key={c.key}>
              {avg && <path d={avg} fill="none" stroke={st.stroke} strokeWidth="2" strokeLinecap="round" strokeDasharray={st.dash || undefined} vectorEffect="non-scaling-stroke" />}
              {pk && <path d={pk} fill="none" stroke={st.stroke} strokeWidth="1.2" strokeLinecap="round" strokeDasharray="4 3" opacity="0.85" vectorEffect="non-scaling-stroke" />}
            </g>
          );
        })}
      </svg>
      <div className="bmcmp-axis"><span>{span > 20 * 3_600_000 ? shortStamp(resp.from) : fmtHm(resp.from)}</span><span>{span > 20 * 3_600_000 ? shortStamp(resp.to) : fmtHm(resp.to)}</span></div>
      <div className="bmcmp-legend">
        {cols.map((c) => {
          const cell = (row.cells || []).find((x) => x.key === c.key);
          return (
            <button key={c.key} type="button" className="bmb-chip" aria-pressed={solo === c.key} onClick={() => setSolo((v) => (v === c.key ? '' : c.key))} title="누르면 그 서버만 · 다시 누르면 전부">
              <span className="bmx-sw" style={{ background: colors[c.key]?.stroke }} />{nameOf(c.key)} {cellPairText(cell?.win, unit, valueMode, row.peakCapable !== false)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function CompareTable({ resp, nameOf, valueMode, devHigh }) {
  const cols = (resp.columns || []).filter((c) => c.state === 'ok' || c.state === 'stale');
  const rows = resp.table?.rows || [];
  if (!cols.length) return <p className="bmo-note">값을 표에 올릴 서버가 없습니다.</p>;
  const verdictOf = (k) => (resp.table?.verdicts || []).find((x) => x.key === k)?.verdict ?? null;
  const baseOf = (k) => (resp.table?.baseline || []).find((x) => x.key === k)?.worst ?? null;
  return (
    <>
      <STable className="bmcmp-t" minWidth={Math.max(520, 220 + cols.length * 120)}>
        <thead>
          <tr><th>지표</th>{cols.map((c) => <th key={c.key} className="right">{nameOf(c.key)}</th>)}<th className="right">편차</th><th>최고</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const unit = metricUnit(r.col, resp.metricMeta);
            return (
              <tr key={r.col} className={devHigh && r.devHigh ? 'bmcmp-hi' : undefined}>
                <td data-sort={metricLabel(r.col)}>{metricLabel(r.col)}{r.skew && <div className="bmcmp-skew">{skewText(r.skew, nameOf)}</div>}</td>
                {cols.map((c) => { const cell = (r.cells || []).find((x) => x.key === c.key); return <td key={c.key} className="right" data-sort={cell?.win?.avg ?? ''}>{cellPairText(cell?.win, unit, valueMode, r.peakCapable !== false)}</td>; })}
                <td className="right" data-sort={r.dev ?? ''} style={{ color: devHigh && r.devHigh ? toneVar('warn') : undefined }}>{devText(r.dev)}{rowBasisNote(r, valueMode) ? <div className="bmo-sub">{rowBasisNote(r, valueMode)}</div> : null}</td>
                <td data-sort={r.top ? nameOf(r.top) : ''}>{r.top ? nameOf(r.top) : '—'}</td>
              </tr>
            );
          })}
          <tr>
            <td data-sort="USE 판정">USE 판정</td>
            {cols.map((c) => <td key={c.key} data-nosort>{verdictOf(c.key) ? <VerdictBadge verdict={verdictOf(c.key)} /> : '—'}</td>)}
            <td data-nosort>—</td><td data-nosort>—</td>
          </tr>
          <tr>
            <td data-sort="베이스라인 이탈">베이스라인 이탈</td>
            {cols.map((c) => <td key={c.key} className="right" data-nosort>{baselineCellText(baseOf(c.key))}</td>)}
            <td data-nosort>—</td><td data-nosort>—</td>
          </tr>
        </tbody>
      </STable>
      <p className="bmo-note"><BoldText text={COMPARE_TABLE_NOTE} /></p>
    </>
  );
}

/**
 * @param {{keys:string[], onKeys:(k:string[])=>void, names?:Record<string,string>, onOpen?:(k:string)=>void, initial?:object, onState?:(s:object)=>void, annotations?:Array, onCapture?:Function, onShare?:Function}} p
 */
export default function BmCompareView({ keys = [], onKeys, names = {}, onOpen, initial = {}, onState, renderExtra = null }) {
  const [view, setView] = useState(COMPARE_VIEWS.includes(initial.view) ? initial.view : 'side');
  const [group, setGroup] = useState(COMPARE_GROUP_TEXT[initial.group] ? initial.group : 'util6');
  const [value, setValue] = useState(COMPARE_VALUE_TEXT[initial.value] ? initial.value : 'avgpeak');
  const [range, setRange] = useState(COMPARE_RANGES.some((r) => r.k === initial.range) ? initial.range : '24h');
  const [cross, setCross] = useState(initial.cross === true);
  const [metric, setMetric] = useState(initial.metric || 'cpu_pct');
  const [devHigh, setDevHigh] = useState(true);
  const [st, setSt] = useState({ resp: null, err: null, loading: false });
  const [sets, setSets] = useState({ list: null, err: '' });
  const [setName, setSetName] = useState('');
  const [msg, setMsg] = useState(null);
  const [reason, setReason] = useState('');
  const [focusBusy, setFocusBusy] = useState(false);
  const loader = useRef(null);
  const rootRef = useRef(null);
  if (!loader.current) loader.current = createCompareLoader();
  // keys = ‘법인|키’ 쌍 글자(bmPerfUrl.refOf — 예전 판 목록은 키만 · 법인 모름). 요청은 키 · 법인을 같은 순서 두 목록으로.
  const keysSig = keys.join(',');
  const pairs = keys.map(parseRef);
  const canWrite = hasRole('admin', 'operator');
  useEffect(() => {
    if (!keys.length) { setSt({ resp: null, err: null, loading: false }); return; }
    const vcs = pairs.map((p) => p.vc);
    loader.current.load({ keys: pairs.map((p) => p.key).join(','), ...(vcs.some(Boolean) ? { vcenterIds: vcs.join(',') } : {}), range, group, value, ...(cross ? { cross: '1' } : {}) }, (p) => setSt((x) => ({ ...x, ...p })));
  }, [keysSig, range, group, value, cross]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onState?.({ view, group, value, range, cross, metric, keys }); }, [view, group, value, range, cross, metric, keysSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadSets = () => fetchJson('/tools/bm-usage/compare/sets').then((r) => setSets({ list: r.sets || [], err: '', max: r.max })).catch((e) => setSets({ list: null, err: e?.message || String(e) }));
  useEffect(() => { loadSets(); }, []);
  const resp = useMemo(() => normCompareResp(st.resp), [st.resp]);
  const max = resp?.maxServers ?? sets.max ?? 5;
  const cols = useMemo(() => resp?.columns || [], [resp]);
  const colors = useMemo(() => colorPlan(cols.map((c) => c.key)), [cols]);
  const nameOf = (k) => cols.find((c) => c.key === k)?.name || names[k] || parseRef(k).key;
  const live = cols.filter((c) => c.state === 'ok' || c.state === 'stale');
  // 6단계: 고른 서버들의 운영 주석(◆) — 겹쳐서 보기의 줄에 같이(비교 창이 바뀔 때 1회).
  const annWin = useMemo(() => (resp?.from != null ? { from: resp.from, to: resp.to } : null), [resp]);
  const ann = useAnnotations(live.map((c) => c.realKey), annWin, 0, live.map((c) => c.vcenterId || ''));
  const crossCorps = new Set(live.map((c) => c.vcenterId)).size > 1;

  async function saveSet() {
    setMsg(null);
    try {
      const r = await putJson('/tools/bm-usage/compare/sets', { name: setName, keys: pairs.map((p) => p.key), vcenterIds: pairs.map((p) => p.vc), cross });
      if (r?.ok === false) { setMsg({ tone: 'bad', text: r.reason || '저장하지 못했습니다.' }); return; }
      setMsg({ tone: 'ok', text: `세트 ‘${r.set?.name}’ 를 저장했습니다(${r.set?.keys?.length}대).` }); setSetName(''); loadSets();
    } catch (e) { setMsg({ tone: 'bad', text: e?.message || String(e) }); }
  }
  async function deleteSet(id) {
    try { const r = await delJson(`/tools/bm-usage/compare/sets/${encodeURIComponent(id)}`); if (r?.ok === false) setMsg({ tone: 'bad', text: r.reason || '지우지 못했습니다.' }); loadSets(); }
    catch (e) { setMsg({ tone: 'bad', text: e?.message || String(e) }); }
  }
  async function focusAll() {
    setFocusBusy(true); setMsg(null);
    try {
      const r = await postJson('/tools/bm-usage/compare/focus', { keys: live.map((c) => c.realKey), vcenterIds: live.map((c) => c.vcenterId || ''), reason }, { timeoutMs: 120_000 });
      setMsg({ tone: r?.ok === false ? 'bad' : 'ok', text: focusStartSummary(r) });
      if (r?.ok !== false) setReason('');
    } catch (e) { setMsg({ tone: 'bad', text: e?.message || String(e) }); }
    finally { setFocusBusy(false); }
  }
  function exportCsv() {
    try {
      const csv = compareCsv(resp, { view: view === 'table' ? 'table' : 'side', nameOf });
      const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = compareCsvName(view, resp?.to); a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) { setMsg({ tone: 'bad', text: `내보내기 실패: ${e?.message || e}` }); }
  }

  return (
    <div className="card bmcmp" style={{ minWidth: 0 }} data-capture="bm-compare" ref={rootRef}>
      <div className="bmcmp-top">
        <h4 style={{ margin: 0 }}>서버 비교</h4>
        <span className="bmo-note" style={{ margin: 0 }}>내가 고른 2~{max}대를 한 화면에서 — 사용률 · 평균 · 피크 · 편차</span>
        <span style={{ flex: '1 1 auto' }} />
        <div className="bmcmp-btns">
          {COMPARE_RANGES.map((r) => <button key={r.k} type="button" className={`btn btn-sm bmp-touch${range === r.k ? ' btn-primary' : ''}`} aria-pressed={range === r.k} onClick={() => setRange(r.k)}>{r.label}</button>)}
          {canCsv() && <button type="button" className="btn btn-sm bmp-touch" disabled={!resp || !live.length} onClick={exportCsv}>CSV</button>}
          {keys.length > 0 && <BmShareButtons kind="compare"
            state={() => ({ view: 'compare', keys, cross, range, cv: view, group, value, metric })}
            node={() => rootRef.current}
            context={() => ({ title: `서버 비교 — ${COMPARE_VIEW_TEXT[view]}`, servers: live.map((c) => nameOf(c.key)), corps: live.map((c) => c.vcenterId || '귀속 없음'), from: resp?.from, to: resp?.to, source: corpsReadText(resp?.corps || []) || '—', note: '수치는 5분(또는 1시간) 평균 · 피크' })} />}
          {renderExtra && renderExtra({ resp, view, nameOf })}
        </div>
      </div>
      {/* 범위 — 기본 같은 법인만 · 법인 간 허용은 전체 범위 계정에만 보인다(서버 crossAllowed) */}
      <div className="bmcmp-scope">
        <span className="bmo-k">범위</span>
        <button type="button" className={`btn btn-sm bmp-touch${!cross ? ' btn-primary' : ''}`} aria-pressed={!cross} onClick={() => setCross(false)}>같은 법인만(기본)</button>
        {resp?.crossAllowed && <button type="button" className={`btn btn-sm bmp-touch${cross ? ' btn-primary' : ''}`} aria-pressed={cross} onClick={() => setCross(true)}>법인 간 허용</button>}
        {cross && crossCorps && <span className="bmcmp-badge">법인 간</span>}
        <span className="bmo-note" style={{ margin: 0 }}>선택 {keys.length}/{max}</span>
      </div>
      {!!resp?.corps?.length && <p className="bmo-note">읽은 시각: {corpsReadText(resp.corps)}</p>}
      {/* 고른 서버 칩 — 열 상태는 서버가 정한다(없음 · 다른 법인 · 오래됨 · 엣지 버전) */}
      <div className="bmcmp-chips">
        {keys.map((k) => {
          const c = cols.find((x) => x.key === k);
          const sv = c ? columnStateView(c.state, { minEdgeVersion: resp?.minEdgeVersion }) : null;
          return (
            <span key={k} className={`bmcmp-chip${c && !['ok', 'stale'].includes(c.state) ? ' bmcmp-off' : ''}`} style={{ borderColor: colors[k]?.stroke }} title={sv?.note || ''}>
              <span role="button" tabIndex={0} className="bmp-link" onClick={() => onOpen?.(k)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen?.(k); }}>{nameOf(k)}</span>
              <span className="bmcmp-cs">{c?.vcenterId || ''}{sv?.label ? ` · ${sv.label}` : ''}</span>
              <button type="button" className="bmcmp-x" aria-label={`${nameOf(k)} 빼기`} onClick={() => onKeys?.(keys.filter((x) => x !== k))}>✕</button>
            </span>
          );
        })}
        {!keys.length && <span className="bmo-note" style={{ margin: 0 }}>보드 행의 비교 칸 · 상세 머리 ‘비교에 추가’ · 병목 Top 5 · 저장된 세트로 서버를 담습니다.</span>}
      </div>
      {cols.filter((c) => !['ok', 'stale'].includes(c.state)).map((c) => (
        <div key={c.key}>
          <p className="bmo-note">‘{nameOf(c.key)}’ — {columnStateView(c.state, { minEdgeVersion: resp?.minEdgeVersion }).note}{c.reason ? `(${c.reason})` : ''}</p>
          {c.state === 'ambiguous' && Array.isArray(c.candidates) && (
            <div className="bmcmp-btns" role="group" aria-label="법인 고르기">
              {c.candidates.map((x) => <button key={x.vcenterId} type="button" className="btn btn-sm bmp-touch" onClick={() => onKeys?.(keys.map((k) => (k === c.key ? refOf(c.realKey, x.vcenterId) : k)))}>{corpLabel(x)}</button>)}
            </div>
          )}
        </div>
      ))}
      {keys.length === 1 && <p className="bmo-note">한 대를 더 고르면 비교합니다.</p>}
      {/* 저장된 세트 · 동시 집중 */}
      <div className="bmcmp-ops">
        <div className="bmcmp-sets">
          <span className="bmo-k">저장된 세트</span>
          {sets.err && <span className="bmo-note" style={{ margin: 0, color: toneVar('bad') }}>세트를 읽지 못했습니다: {sets.err}</span>}
          {(sets.list || []).map((s) => (
            <span key={s.id} className="bmcmp-set">
              <button type="button" className="btn btn-sm bmp-touch" onClick={() => { setCross(s.cross === true && !!resp?.crossAllowed); onKeys?.(s.keys.map((k, i) => refOf(k, s.vcenterIds?.[i] || ''))); }}>{s.name}({s.keys.length}대{s.cross ? ' · 법인 간' : ''})</button>
              {canWrite && <button type="button" className="bmcmp-x" aria-label={`세트 ${s.name} 지우기`} onClick={() => deleteSet(s.id)}>✕</button>}
            </span>
          ))}
          {sets.list && !sets.list.length && <span className="bmo-note" style={{ margin: 0 }}>없음</span>}
          {canWrite && keys.length >= 2 && (
            <span className="bmcmp-save">
              <input className="input" type="text" maxLength={60} placeholder="세트 이름" value={setName} onChange={(e) => setSetName(e.target.value)} aria-label="세트 이름" />
              <button type="button" className="btn btn-sm bmp-touch" disabled={!setName.trim() || !!sets.err} onClick={saveSet}>비교 세트 저장</button>
            </span>
          )}
        </div>
        {canWrite && live.length >= 1 && (
          <div className="bmcmp-focus">
            <input className="input bmo-input" type="text" maxLength={300} placeholder="사유(필수 — 감사 기록에 남습니다)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="동시 집중 사유" />
            <button type="button" className="btn btn-sm bmp-touch" disabled={focusBusy || reason.trim().length < 2} onClick={focusAll}>{focusBusy ? '시작하는 중…' : `${live.length}대 동시 집중 모니터링`}</button>
          </div>
        )}
      </div>
      {msg && <p className="bmo-note" style={{ color: toneVar(msg.tone) }}><BoldText text={msg.text} /></p>}
      {/* 보기 · 지표 · 값 */}
      <div className="bmcmp-ctl">
        <span className="bmo-k">보기</span>
        {COMPARE_VIEWS.map((v) => <button key={v} type="button" className={`btn btn-sm bmp-touch${view === v ? ' btn-primary' : ''}`} aria-pressed={view === v} onClick={() => setView(v)}>{COMPARE_VIEW_TEXT[v]}</button>)}
      </div>
      <div className="bmcmp-ctl">
        <span className="bmo-k">지표</span>
        {Object.keys(COMPARE_GROUP_TEXT).map((g) => <button key={g} type="button" className={`btn btn-sm bmp-touch${group === g ? ' btn-primary' : ''}`} aria-pressed={group === g} onClick={() => setGroup(g)}>{COMPARE_GROUP_TEXT[g]}</button>)}
        <span className="bmo-k">값</span>
        {Object.keys(COMPARE_VALUE_TEXT).map((v) => <button key={v} type="button" className={`btn btn-sm bmp-touch${value === v ? ' btn-primary' : ''}`} aria-pressed={value === v} onClick={() => setValue(v)}>{COMPARE_VALUE_TEXT[v]}</button>)}
        <label className="bmo-check"><input type="checkbox" checked={devHigh} onChange={(e) => setDevHigh(e.target.checked)} /> 편차 큰 지표 강조{resp?.table?.devHighRatio ? `(max/min ≥ ${resp.table.devHighRatio})` : ''}</label>
      </div>
      {st.err && (st.err.status === 403 ? <ErrorBox error={st.err} /> : <p className="bmo-note" style={{ color: toneVar('bad') }}>비교를 읽지 못했습니다: {st.err.message || String(st.err)}</p>)}
      {st.loading && <p className="bmo-note">읽는 중… (엣지 위임 서버는 그 엣지에서 따로 읽습니다)</p>}
      {resp && !st.loading && (
        <div className="bmcmp-body" data-capture-body>
          {view === 'side' && <CompareSide resp={resp} nameOf={nameOf} colors={colors} valueMode={value} devHigh={devHigh} />}
          {view === 'overlay' && <CompareOverlay resp={resp} nameOf={nameOf} colors={colors} valueMode={value} metric={metric} onMetric={setMetric} annotations={ann.list.filter((a) => !a.deleted)} />}
          {view === 'table' && <CompareTable resp={resp} nameOf={nameOf} valueMode={value} devHigh={devHigh} />}
          <p className="bmo-note">{COMPARE_HONEST}{resp.addressHidden ? ' 주소로 등록된 서버의 이름은 가렸습니다.' : ''}</p>
        </div>
      )}
    </div>
  );
}
