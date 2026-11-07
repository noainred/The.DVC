/**
 * views/tools/BmTrendTab.jsx — 서버 상세 **‘추이’ 탭**(리눅스 성능 3b · v2.923 · 설계 PROFILES §8~§12 · 아트보드 ②-추이 · 장치 토글 · 확대 팝업).
 *
 * 상단 컨트롤(기간 · 해상도(자동) · 표시 · 커서 동기 · CSV · 다시 읽기) → 장치 토글 줄(§12) → ① 평균 · ② 피크 두 패널(같은 시간축 ·
 * 커서 동기 · 선택 구간 공유) → 선택 구간 요약 표 → 추천 지표 12행(보일 때 부른다) → 장치별 보기(A 디스크 · B 마운트 · C 인터페이스) →
 * D 스위치 포트 연동(CVP). 모든 추이 셀 · 스파크 · ‘⤢ 확대’ 가 확대 팝업(BmTrendPopup)을 연다.
 *
 * ⚠ 서버가 창 · 해상도 · 결측 · 기준선 · 포트 상태 · 대조 판정을 정한다 — 이 파일은 조립만(문구 · 좌표는 bmTrendText.js).
 * ⚠ 조회: 탭을 열 때 1회 + 기간 · ‘다시 읽기’ 때만(폴링 없음) · 계열은 동시 4개(bmTrendLoad) · 늦게 온 이전 창 응답은 버린다.
 * ⚠ 훅은 전부 조기 return 위(React #310).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, canCsv } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { toneVar } from './toneVar.js';
import { numText } from './bmPerfText.js';
import { bpsText } from './bmUsageText.js';
import { bpsText as bitsText, pctText as portPctText } from './cvpText.js';
import { createTrendLoader, trendFetcher } from './bmTrendLoad.js';
import { TrendRow, TimeAxis, Spark } from './BmTrendChart.jsx';
// v2.929(5단계): 베이스라인 띠 · 변경 이벤트 · 집중 1분 점 겹침 · 구간 비교(BmTrendOps.jsx) — 패널 행에는 변경 이벤트 점만 얹는다.
import { BaselineOverlay, CompareView } from './BmTrendOps.jsx';
import { maintBands } from './bmMaintText.js'; // 8a단계 정비 창 음영
import { changeMarks } from './bmPerfOpsText.js';
// 6단계: 운영 주석 ◆ 핀(패널 행 · 겹침 카드) · 목록 · 입력.
import AnnotationsCard, { useAnnotations } from './BmAnnotations.jsx';
import { annotMarks } from './bmAnnotText.js';
import { violationBands } from './bmRunbookText.js'; // 6단계 목표선 위반 띠(서버 판정 그대로)
import BmTrendPopup from './BmTrendPopup.jsx';
import {
  TREND_RANGES, trendRangeOf, SHOW_MODES, showAvg, showPeak, metricInfo, PANEL_ROWS, SOCKET_NOTE, SOURCE_TAGS, SOURCE_ORDER, RECO_TILES,
  SECOND_COLORS, recoMetrics, resText, resHint, peakSrcText, trendNotes, trendErrorText, valText, yMaxFor, noPeakRuns, nearestPoint,
  windowSummary, peakRatioText, baselineText, whenText, deviceStyle, DISK_MODES, NET_MODES, LAYOUTS, DEFAULT_TOGGLE, toggleDevices, legendNext,
  panelPlan, restNote, DEVICE_EMPTY_TEXT, seriesKey, seriesLabel, trendCsv, trendCsvName, portStateView, PORT_STATE_ORDER, compareView,
  pairText, mapSourceRows, portStateCounts, portNotes,
} from './bmTrendText.js';
import './bmTrend.css';

const DEV_SEGS = Object.freeze([
  { k: 'none', label: '서버 전체' },
  { k: 'disk', label: '디스크별' },
  { k: 'mount', label: '파티션·마운트별' },
  { k: 'nic', label: '인터페이스별' },
]);
const MOUNT_SPAN = 30 * 86_400_000;
/** 장치 표가 추이를 부르는 장치 수 상한(서버 순서 앞에서부터 — 행은 다 그리고 STable 이 정렬한다). */
const DEV_TABLE_MAX = 16;
const two = (x) => String(x).padStart(2, '0');
const hm = (ms) => { const d = new Date(ms); return `${two(d.getHours())}:${two(d.getMinutes())}`; };

function downloadText(text, name) {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') return;
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 단순 조회(장치 목록 · 포트 대조) — 세대로 늦은 응답을 버린다. */
function useOnceJson(path, dep) {
  const [st, setSt] = useState({ loading: !!path, data: null, err: null });
  useEffect(() => {
    if (!path) return undefined;
    let alive = true;
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    setSt((p) => ({ ...p, loading: true }));
    fetchJson(path, {}, ac?.signal, { retries: 1, timeoutMs: 90_000 })
      .then((d) => { if (alive) setSt({ loading: false, data: d, err: null }); })
      .catch((e) => { if (alive && e?.name !== 'AbortError') setSt({ loading: false, data: null, err: e }); });
    return () => { alive = false; try { ac?.abort(); } catch { /* */ } };
  }, [path, dep]);
  return st;
}

/** 범례 칩(겹쳐 보기) — 누르면 그 장치만 · Shift = 더하기/빼기. 색은 장치 고정. */
function Legend({ all = [], sel = null, onPick }) {
  return (
    <div className="bmt-legend" aria-label="장치 범례(누르면 그 장치만 · Shift 는 추가)">
      {all.map((d) => {
        const st = deviceStyle(d.color);
        const on = !sel || sel.includes(d.dev);
        return (
          <button key={d.dev} type="button" className={`bmt-lg${on ? '' : ' off'}`} onClick={(e) => onPick(legendNext(sel, d.dev, { shift: e.shiftKey, all }))} title="누르면 이 장치만 · Shift+누름은 더하기/빼기">
            <i style={{ borderTopColor: st.stroke, borderTopStyle: st.dash ? 'dashed' : 'solid' }} />{d.dev}{d.info === 'part' ? '(파티션)' : ''}
          </button>
        );
      })}
    </div>
  );
}

function Seg({ items, value, onChange, label, className = '' }) {
  return (
    <div className={`bmp-seg bmt-seg ${className}`} role="tablist" aria-label={label}>
      {items.map((x) => <button key={x.k} type="button" role="tab" aria-selected={value === x.k} className={value === x.k ? 'active' : ''} onClick={() => onChange(x.k)}>{x.label}</button>)}
    </div>
  );
}

/**
 * @param {{itemKey:string, name?:string, th?:object, latest?:object|null, keepDays?:{server?:number,dev?:number}|null, narrowOverride?:boolean}} p
 *   latest — 성능 상세의 최근 5분 장치 값(entry.detail: disks · nics) · keepDays — 이 노드 대상의 보존(일). 엣지 위임 서버는 null(모름).
 */
export default function BmTrendTab({ itemKey, name = '', latest = null, keepDays = null, initialRange = '24h', narrowOverride = null, vcenterId = '', initial = null, onState = null }) {
  // ⚠ 훅은 전부 조기 return 위.
  // 6단계 공유 링크: initial(기간 · 창 끝 · 커서 · 구간 · 평균/피크 · 장치 토글)로 시작할 수 있다 — 형식은 bmShare.parseShareHash 가 이미 걸렀다.
  const [rangeK, setRangeK] = useState(() => trendRangeOf(initial?.range || initialRange).k);
  const [show, setShow] = useState(() => initial?.show || 'both');
  const [sync, setSync] = useState(true);
  const [clock, setClock] = useState(() => ({ at: Number.isFinite(initial?.to) && initial.to < Date.now() ? initial.to : Date.now(), n: 0 }));
  const [series, setSeries] = useState({});
  const [mountSeries, setMountSeries] = useState({});
  const [tg, setTg] = useState(() => { const t0 = { ...DEFAULT_TOGGLE, ...(initial?.disk ? { disk: initial.disk } : {}), ...(initial?.net ? { net: initial.net } : {}), ...(initial?.layout ? { layout: initial.layout } : {}) }; return { linked: true, editing: 'avg', avg: { ...t0 }, peak: { ...t0 } }; });
  const [legend, setLegend] = useState({});
  const [cur, setCur] = useState(() => (Number.isFinite(initial?.cursor) ? { ms: initial.cursor, panel: 'avg' } : null));       // { ms, panel }
  const [sel, setSel] = useState(() => initial?.sel || null);       // { from, to }
  const [pop, setPop] = useState(null);
  const [recoOn, setRecoOn] = useState(false);
  const [devSeg, setDevSeg] = useState('none');
  const [withParts, setWithParts] = useState(false);
  const [narrow, setNarrow] = useState(() => (narrowOverride != null ? narrowOverride : typeof window !== 'undefined' && window.innerWidth < 720));
  const [cmpOn, setCmpOn] = useState(false);   // v2.929: 구간 비교 절 펼치기
  const recoRef = useRef(null);
  const loader = useRef(null);
  const mLoader = useRef(null);
  if (!loader.current) loader.current = createTrendLoader(trendFetcher(itemKey));
  if (!mLoader.current) mLoader.current = createTrendLoader(trendFetcher(itemKey));

  const span = trendRangeOf(rangeK).ms;
  const win = useMemo(() => ({ from: clock.at - span, to: clock.at }), [clock.at, span]);
  const mWin = useMemo(() => ({ from: clock.at - MOUNT_SPAN, to: clock.at }), [clock.at]);
  const winKey = `${itemKey}|${win.from}|${win.to}|${clock.n}`;
  const devs = useOnceJson(itemKey ? `/tools/bm-usage/perf/${encodeURIComponent(itemKey)}/devices` : '', clock.n);
  const ports = useOnceJson(itemKey ? `/tools/bm-usage/perf/${encodeURIComponent(itemKey)}/ports` : '', clock.n);
  const devices = useMemo(() => (devs.data && devs.data.ok !== false && devs.data.devices) || { disk: [], nic: [], mount: [] }, [devs.data]);
  // v2.929: 같은 창의 변경 이벤트(+ 집중 1분 점) — 창이 바뀔 때 1회(폴링 없음). 패널 행 위 점과 겹침 카드가 같은 응답을 쓴다.
  const changes = useOnceJson(itemKey ? `/tools/bm-usage/perf/${encodeURIComponent(itemKey)}/changes?from=${Math.floor(win.from)}&to=${Math.floor(win.to)}&focus=1` : '', clock.n);
  // 6단계: 공유 링크 · 캡처가 쓸 지금 상태를 부모에 알린다(렌더마다가 아니라 값이 바뀔 때만).
  useEffect(() => { onState?.({ range: rangeK, show, to: clock.at, cursor: cur?.ms ?? null, sel, disk: tg.avg?.disk, net: tg.avg?.net, layout: tg.avg?.layout, from: clock.at - span }); }, [rangeK, show, clock.at, cur?.ms, sel, tg, span]); // eslint-disable-line react-hooks/exhaustive-deps
  const chMarks0 = useMemo(() => changeMarks(changes.data?.events || [], win), [changes.data, win]);
  // 6단계: 같은 창의 운영 주석 — 창이 바뀌거나 저장할 때 1회(annTick). 기계 이벤트(●)와 같은 줄에 ◆ 핀.
  const [annTick, setAnnTick] = useState(0);
  const ann = useAnnotations(itemKey ? [itemKey] : [], win, `${clock.n}|${annTick}`);
  const anMarks = useMemo(() => annotMarks(ann.list, win), [ann.list, win]);
  const chMarks = useMemo(() => [...chMarks0, ...anMarks], [chMarks0, anMarks]);
  // 6단계: 목표선 위반 띠 — 켤 때만 읽는다(목표 지표마다 추이를 다시 읽는다 — 엣지 위임 서버는 그만큼 WAN 요청이 는다).
  const [sloOn, setSloOn] = useState(false);
  const slo = useOnceJson(itemKey && sloOn ? `/tools/bm-usage/perf/${encodeURIComponent(itemKey)}/slo?from=${Math.floor(win.from)}&to=${Math.floor(win.to)}` : '', clock.n);
  const vb = useMemo(() => violationBands(slo.data), [slo.data]);
  // 8a단계: 정비 창 음영 — 그 서버를 덮는 창 구간(서버 판정 코어 · 창이 바뀔 때 1회 · 폴링 없음). 변경 이벤트 ‘정비 창 안’ 묶음도 같은 구간.
  const maint = useOnceJson(itemKey ? `/tools/bm-usage/maintenance/occurrences?key=${encodeURIComponent(itemKey)}&from=${Math.floor(win.from)}&to=${Math.floor(win.to)}` : '', clock.n);
  const mb = useMemo(() => maintBands(maint.data), [maint.data]);

  useEffect(() => {
    if (narrowOverride != null || typeof window === 'undefined') return undefined;
    const on = () => setNarrow(window.innerWidth < 720);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [narrowOverride]);
  useEffect(() => () => { loader.current?.cancel(); mLoader.current?.cancel(); }, []);
  // 추천 12행은 화면에 들어올 때 부른다(지표가 많다 — 탭을 열자마자 다 부르지 않는다).
  useEffect(() => {
    if (recoOn) return undefined;
    const el = recoRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((ents) => { if (ents.some((e) => e.isIntersecting)) setRecoOn(true); }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [recoOn]);

  const toggleAvg = tg.avg; const togglePeak = tg.linked ? tg.avg : tg.peak;
  const planAvg = useMemo(() => panelPlan(toggleAvg, devices, legend), [toggleAvg, devices, legend]);
  const planPeak = useMemo(() => panelPlan(togglePeak, devices, legend), [togglePeak, devices, legend]);
  const diskList = useMemo(() => [...toggleDevices(devices, 'disk'), ...(withParts ? toggleDevices(devices, 'part') : [])], [devices, withParts]);
  const nicList = useMemo(() => toggleDevices(devices, 'nic'), [devices]);
  const mountList = useMemo(() => (devices.mount || []).slice(0, 16), [devices]);

  const wanted = useMemo(() => {
    const m = new Map();
    const add = (s) => { const k = seriesKey(s); if (!m.has(k)) m.set(k, { kind: s.kind || 'server', metric: s.metric, ...(s.dev ? { dev: s.dev } : {}) }); };
    for (const p of [...(showAvg(show) ? planAvg : []), ...(showPeak(show) ? planPeak : [])]) for (const s of p.series) add(s);
    for (const r of PANEL_ROWS) add({ kind: 'server', metric: r.metric });
    if (recoOn) for (const metric of recoMetrics()) add({ kind: 'server', metric });
    if (devSeg === 'disk') for (const d of diskList.slice(0, DEV_TABLE_MAX)) { add({ kind: 'disk', metric: 'busy_pct', dev: d.dev }); add({ kind: 'disk', metric: 'await_ms', dev: d.dev }); }
    if (devSeg === 'nic') for (const d of nicList.slice(0, DEV_TABLE_MAX)) add({ kind: 'nic', metric: 'util_pct', dev: d.dev });
    return [...m.values()];
  }, [show, planAvg, planPeak, recoOn, devSeg, diskList, nicList]);
  const wantedKey = wanted.map(seriesKey).join(',');

  const onResult = useCallback((k, v) => setSeries((p) => ({ ...p, [k]: v })), []);
  const onMountResult = useCallback((k, v) => setMountSeries((p) => ({ ...p, [k]: v })), []);
  // ⚠ 창이 바뀔 때 비우기는 조회 효과보다 **먼저**(같은 커밋에서 뒤에 돌면 방금 넣은 ‘불러오는 중’ · 캐시 결과를 지운다).
  useEffect(() => { setSeries({}); setSel(null); setCur(null); }, [winKey]);
  useEffect(() => {
    if (!itemKey) return;
    loader.current.setWindow(winKey);
    loader.current.request(wanted, win, onResult);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- wanted 는 wantedKey 로 고정(배열 정체성으로 재요청하지 않는다)
  }, [itemKey, winKey, wantedKey, onResult]);
  const mWanted = useMemo(() => (devSeg === 'mount' ? mountList.flatMap((d) => [{ kind: 'mount', metric: 'used_pct', dev: d.dev }, { kind: 'mount', metric: 'inode_pct', dev: d.dev }]) : []), [devSeg, mountList]);
  const mWinKey = `${itemKey}|m|${mWin.from}|${clock.n}`;
  useEffect(() => { setMountSeries({}); }, [mWinKey]);
  useEffect(() => {
    if (!itemKey || !mWanted.length) return;
    mLoader.current.setWindow(mWinKey);
    mLoader.current.request(mWanted, mWin, onMountResult);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 창은 mWinKey 로 고정
  }, [itemKey, mWinKey, mWanted, onMountResult]);

  if (!itemKey) return null;

  const sd = (s) => series[seriesKey(s)] || null;
  const dataOf = (s) => { const v = sd(s); return v && v.status === 'ok' ? v.data : null; };
  const head = sd({ kind: 'server', metric: 'cpu_pct' });
  const headData = head?.data || null;
  const headErr = head && (head.status === 'error' || head.status === 'fail') ? head : null;
  const res = headData?.res || null;
  const notes = trendNotes(headData || {});
  const peakSrcs = [...new Set([...(headData?.peakSrc || []), ...wanted.flatMap((s) => dataOf(s)?.peakSrc || [])])];
  const pSrcText = peakSrcText(peakSrcs.length ? peakSrcs : (devs.data?.peakSrc ? [devs.data.peakSrc] : []), devs.data?.peakWindowS);
  const loadingN = Object.values(series).filter((v) => v.status === 'loading').length;
  const err403 = headErr?.error?.status === 403 ? headErr.error : null;
  const setRange = (k) => { setRangeK(k); setClock((c) => ({ at: Date.now(), n: c.n })); };
  const reload = () => setClock((c) => ({ at: Date.now(), n: c.n + 1 }));
  const open = (spec, extra = {}) => setPop({ kind: spec.kind || 'server', metric: spec.metric, dev: spec.dev || '', rangeK, show, sel, ...extra });
  const editTg = (patch) => setTg((p) => {
    if (p.linked) return { ...p, avg: { ...p.avg, ...patch } };
    const which = p.editing;
    return { ...p, [which]: { ...p[which], ...patch } };
  });
  const tgNow = tg.linked || tg.editing === 'avg' ? tg.avg : tg.peak;
  const selText = sel ? `${whenText(sel.from, span)} ~ ${whenText(sel.to, span)} (선택)` : '';

  /** 패널 한 장. */
  const renderPanel = (which) => {
    const plan = which === 'avg' ? planAvg : planPeak;
    const isPeak = which === 'peak';
    return (
      <section className={`bmt-panel${isPeak ? ' peak' : ''}`} aria-label={isPeak ? '피크 화면' : '평균 화면'}>
        <div className="bmt-panel-head">
          <h5>{isPeak ? '② 피크 — 같은 5분 안의 최대(1초 창) + 시각' : '① 평균 — 5분 주기 평균(롤업이면 그 평균)'}</h5>
          {isPeak ? <span className="bmp-chip bmt-src" title="피크를 어떻게 모았는지 — 피크 값 옆에 항상 적는다">출처 {pSrcText}</span>
            : <span className="bmp-chip bmt-src">출처 OS(SSH) · iDRAC — 결측은 선을 끊는다</span>}
          <span style={{ flex: '1 1 auto' }} />
          <span className="bmt-hint">{isPeak ? '흐린 선 = 그 계열의 평균 · 띠 = 피크 표본 없는 주기' : '행을 누르면 큰 팝업 · 끌면 구간 선택 · 두 번 누르면 해제'}</span>
          <button type="button" className="btn btn-sm bmp-touch" onClick={() => open(plan[0]?.series[0] || { kind: 'server', metric: 'cpu_pct' }, { show: isPeak ? 'peak' : 'avg' })}>⤢ 확대</button>
        </div>
        {plan.map((rp) => {
          const r = rp.row;
          const first = rp.series[0] || { kind: 'server', metric: r.metric };
          const info = metricInfo(first.kind || 'server', first.metric);
          const rowLabel = metricInfo('server', r.metric).label;   // 장치 행도 패널 행 이름(디스크 busy · 네트워크 사용률)으로 — ‘사용률’ 만으로는 모호하다
          const title = `${rowLabel}${rp.dev ? ` — ${rp.dev}` : rp.mode && rp.mode !== 'all' ? ` — ${(r.id === 'disk' ? DISK_MODES : NET_MODES).find((m) => m.k === rp.mode)?.label || ''}` : ''}${isPeak ? ' 피크' : ''}${info.unit === '%' ? ' %' : ''}`;
          if (rp.empty) {
            return <TrendRow key={rp.id} title={title} sub={r.sub} series={[]} win={win} yMax={100} message={DEVICE_EMPTY_TEXT[rp.mode] || '장치 이력이 없습니다.'} onOpen={null} />;
          }
          const lines = []; const allVals = []; let msg = ''; let noPeak = []; let baseline = null;
          let loading = false; let errText = '';
          for (const s of rp.series) {
            const v = sd(s);
            if (!v || v.status === 'loading') { loading = true; continue; }
            if (v.status !== 'ok') { errText = trendErrorText(v.error, v.data); continue; }
            const d = v.data || {};
            const pts = d.points || [];
            if (rp.series.length === 1) baseline = d.baseline || null;
            if (!isPeak) {
              lines.push({ points: pts, gaps: d.gaps, pick: 'avg', color: s.color || r.color, dash: s.dash });
              for (const p of pts) allVals.push(p.avg);
            } else if (info.peak) {
              lines.push({ points: pts, gaps: d.gaps, pick: 'avg', color: s.color || r.color, faint: true });
              lines.push({ points: pts, gaps: d.gaps, pick: 'peak', color: rp.series.length > 1 ? (s.color || r.color) : 'var(--red)', dash: s.dash });
              for (const p of pts) { allVals.push(p.peak); allVals.push(p.avg); }
              if (rp.series.length === 1) noPeak = noPeakRuns(pts, { stepMs: d.stepMs });
            } else if (d.res && d.res !== '5m') {
              lines.push({ points: pts, gaps: d.gaps, pick: 'avg', color: s.color || r.color, faint: true });
              lines.push({ points: pts, gaps: d.gaps, pick: 'max', color: s.color || r.color, dash: '4 3' });
              for (const p of pts) { allVals.push(p.max); allVals.push(p.avg); }
              msg = '피크 열이 없는 지표 — 점선은 5분 값 중 최대';
            } else {
              lines.push({ points: pts, gaps: d.gaps, pick: 'avg', color: s.color || r.color, faint: true });
              for (const p of pts) allVals.push(p.avg);
              msg = '이 지표는 1초 창이 재지 않습니다 — 5분 값만(흐린 선)';
            }
            if (!(pts || []).some((p) => p.avg != null || p.peak != null)) msg = '이 구간에 값이 없습니다 — 0 으로 그리지 않습니다';
          }
          if (errText && !lines.length) msg = errText;
          else if (loading && !lines.length) msg = '불러오는 중…';
          const yMax = yMaxFor(info.unit, [allVals]);
          const cursorMs = cur && (sync || cur.panel === which) ? cur.ms : null;
          let readout = null;
          if (cursorMs != null && rp.series.length) {
            const parts = rp.series.map((s) => {
              const d = dataOf(s); if (!d) return null;
              const p = nearestPoint(d.points, cursorMs); if (!p) return null;
              const v = isPeak ? (info.peak ? p.peak : p.max) : p.avg;
              return `${rp.series.length > 1 ? `${s.dev} ` : ''}${valText(v, info.unit)}`;
            }).filter(Boolean);
            if (parts.length) readout = `${hm(cursorMs)} · ${parts.join(' · ')}`;
          }
          // 범례 · 상한 안내는 겹쳐 보기 행, 또는 행 나눔 묶음의 **첫 행**에만(장치마다 되풀이하지 않는다).
          const groupFirst = !rp.dev || rp.firstOfGroup;
          const lg = rp.legend || (rp.dev && rp.firstOfGroup && (rp.rest > 0 || legend[r.id])) ? <Legend all={rp.all} sel={legend[r.id] || null} onPick={(next) => setLegend((p) => ({ ...p, [r.id]: next }))} /> : null;
          const baseSub = rp.dev ? (rp.series[0]?.info === 'part' ? '파티션 I/O(병합 · 캐시 주의)' : '') : rp.legend ? `장치별 겹침 · 범례 누름 = 그 장치만 · Shift+누름 = 더하기${rp.mode === 'part' ? ' · 파티션 I/O 는 병합 · 캐시 주의' : ''}` : r.sub;
          const sub = [baseSub, groupFirst ? restNote(rp.rest) : '', groupFirst && rp.autoRows ? '8개 초과 — 행 나눔으로 바꿨습니다' : ''].filter(Boolean).join(' · ');
          return (
            <TrendRow key={rp.id} title={title} sub={sub} readout={readout} series={lines} win={win} yMax={yMax} cursor={cursorMs} sel={sel} baseline={isPeak ? null : baseline}
              gaps={[]} noPeak={noPeak} message={lines.length ? '' : msg} note={lines.length ? msg : ''} legend={lg} unit={info.unit} marks={chMarks} vbands={!rp.dev ? (vb[r.metric] || []) : []} mbands={mb}
              onHover={(ms) => setCur(ms == null ? null : { ms, panel: which })} onSelect={setSel}
              onOpen={() => open(first, { show: isPeak ? 'peak' : 'avg' })} />
          );
        })}
        <TimeAxis from={win.from} to={win.to} narrow={narrow} selText={selText} />
      </section>
    );
  };

  /** 선택 구간 요약 표(큐 · 버퍼 포함). */
  const summaryRows = PANEL_ROWS.map((r) => {
    const spec = { kind: 'server', metric: r.metric };
    const info = metricInfo('server', r.metric);
    const d = dataOf(spec);
    const s = d ? windowSummary(d.points, { sel, baseline: d.baseline, peak: info.peak }) : null;
    return { r, spec, info, d, s };
  });

  return (
    <div className="bmt" style={{ minWidth: 0 }}>
      {/* ── 상단 컨트롤 ── */}
      <div className="bmt-ctl">
        <Seg items={TREND_RANGES} value={rangeK} onChange={setRange} label="기간" />
        <Seg items={SHOW_MODES} value={show} onChange={setShow} label="표시" />
        <label className="bmt-check"><input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} /> 커서 동기(두 패널)</label>
        <span style={{ flex: '1 1 auto' }} />
        {canCsv() && (
          <button type="button" className="btn btn-sm bmp-touch" disabled={!headData}
            onClick={() => downloadText(trendCsv(planAvg.flatMap((p) => p.series).map((s) => ({ label: seriesLabel(s), unit: metricInfo(s.kind, s.metric).unit, peak: metricInfo(s.kind, s.metric).peak, points: dataOf(s)?.points || [] }))), trendCsvName(name || itemKey, rangeK, win.to))}
            title="보고 있는 창 · 토글 상태대로(장치별이면 장치 열) 평균 · 피크">CSV</button>
        )}
        <button type="button" className="btn btn-sm bmp-touch" onClick={reload} disabled={loadingN > 0}>{loadingN > 0 ? `읽는 중… ${loadingN}` : '다시 읽기'}</button>
      </div>
      <div className="bmt-meta">
        <span className="bmp-chip">{headData ? resText(headData) : '해상도 —'}</span>
        <span>{`${whenText(win.from, span)} ~ ${whenText(win.to, span)} · 서버가 창 · 해상도 · 결측을 정합니다`}</span>
      </div>
      {res && <p className="bmt-note">{resHint(res)}</p>}
      {notes.map((x, i) => <p key={i} className="bmt-note"><BoldText text={x} /></p>)}
      {err403 && <div style={{ marginTop: 8 }}><ErrorBox error={err403} /></div>}
      {headErr && !err403 && <p className="bmt-note" style={{ color: toneVar('bad') }}>{trendErrorText(headErr.error, headErr.data)}</p>}

      {/* ── 장치 토글 줄(§12) ── */}
      <div className="bmt-toggle">
        <div className="bmt-toggle-row">
          <span className="bmt-k">디스크 행</span>
          <Seg items={DISK_MODES} value={tgNow.disk} onChange={(k) => editTg({ disk: k })} label="디스크 행" />
          <span className="bmt-k">네트워크 행</span>
          <Seg items={NET_MODES} value={tgNow.net} onChange={(k) => editTg({ net: k })} label="네트워크 행" />
          <span className="bmt-k">개별 표시</span>
          <Seg items={LAYOUTS} value={tgNow.layout} onChange={(k) => editTg({ layout: k })} label="개별 표시" />
        </div>
        <div className="bmt-toggle-row">
          <label className="bmt-check"><input type="checkbox" checked={tg.linked} onChange={(e) => setTg((p) => ({ ...p, linked: e.target.checked, peak: e.target.checked ? p.peak : { ...p.avg }, editing: 'avg' }))} /> 평균 · 피크 패널에 같이 적용</label>
          {!tg.linked && <Seg items={[{ k: 'avg', label: '① 평균 패널 고치기' }, { k: 'peak', label: '② 피크 패널 고치기' }]} value={tg.editing} onChange={(k) => setTg((p) => ({ ...p, editing: k }))} label="고칠 패널" />}
          <span className="bmt-hint">전체 = 대표값(가장 바쁜 장치 · 가장 높은 회선) · 개별 = 장치별 이력 · 색은 장치마다 고정 · 장치 {devs.loading ? '읽는 중…' : `디스크 ${(devices.disk || []).filter((d) => d.info !== 'part').length} · 파티션 ${(devices.disk || []).filter((d) => d.info === 'part').length} · 인터페이스 ${(devices.nic || []).length}`}{devs.data?.over ? ` · 상한으로 ${devs.data.over}개 뺌` : ''}</span>
        </div>
        {devs.err && <p className="bmt-note" style={{ color: toneVar('warn') }}>장치 목록을 읽지 못했습니다: {trendErrorText(devs.err)}</p>}
      </div>

      {/* ── ① 평균 · ② 피크 ── */}
      {showAvg(show) && renderPanel('avg')}
      {showPeak(show) && renderPanel('peak')}
      <div className="bmt-ctl">
        <label className="bmt-check"><input type="checkbox" checked={sloOn} onChange={(e) => setSloOn(e.target.checked)} /> 목표선 위반 띠(빨강) 겹치기</label>
        {sloOn && <span className="bmt-hint">{slo.loading ? '목표를 대 보는 중…' : slo.err ? `목표를 읽지 못했습니다: ${trendErrorText(slo.err)}` : `목표 ${(slo.data?.items || []).length}개 · 위반 띠 ${Object.values(vb).reduce((a, x) => a + x.length, 0)}곳 — 목표선 탭에 달성률`}</span>}
      </div>
      <p className="bmt-note">{SOCKET_NOTE}{chMarks0.length ? ` · 행 위 파란 점선 = 변경 이벤트(${chMarks0.length}곳 — 아래 목록)` : ''}{anMarks.length ? ` · 보라 ◆ = 운영 주석(${anMarks.length}곳 — 가리키면 내용)` : ''}{mb.length ? ` · 주황 음영 = 정비 창(${mb.length}곳 — 가리키면 이름)` : ''}</p>

      {/* ── v2.929(5단계): 베이스라인 띠 · 변경 이벤트 · 집중 1분 점 · 구간 비교 ── */}
      <BaselineOverlay itemKey={itemKey} win={win} changes={changes.data && changes.data.ok !== false ? changes.data : null} narrow={narrow} annotMarks={anMarks} maintBands={mb} />
      <AnnotationsCard itemKey={itemKey} name={name} vcenterId={vcenterId} sel={sel} list={ann.list} err={ann.err} onChanged={() => setAnnTick((v) => v + 1)} />
      {changes.err && <p className="bmt-note" style={{ color: toneVar('warn') }}>변경 이벤트를 읽지 못했습니다: {trendErrorText(changes.err)}</p>}
      <div className="bmt-ctl">
        <button type="button" className="btn btn-sm bmp-touch" aria-expanded={cmpOn} onClick={() => setCmpOn((v) => !v)}>{cmpOn ? '구간 비교 닫기' : '구간 비교(A/B) 열기'}</button>
        <span className="bmt-hint">위 패널에서 끌어 고른 구간이 B 가 됩니다(없으면 최근 1시간).</span>
      </div>
      {cmpOn && <CompareView itemKey={itemKey} sel={sel} name={name} />}

      {/* ── 선택 구간 요약 ── */}
      <section className="bmt-card" aria-label="선택 구간 요약">
        <h5>{sel ? `선택 구간 ${selText.replace(' (선택)', '')}` : '이 창 전체'} — 평균 · 최대 · 피크(시각) · 기준(설정값) <span className="bmt-hint">받은 점으로 계산(서버 호출 없음) · 머리글 클릭 정렬</span></h5>
        <STable className="bmt-t" minWidth={760} style={{ fontSize: 12 }}>
          <thead><tr><th>지표</th><th className="right">평균</th><th className="right">최대</th><th className="right">피크</th><th>피크 시각</th><th className="right">피크/평균</th><th>기준(설정값)</th><th className="right">주의 이상 비율</th><th className="right">결측</th></tr></thead>
          <tbody>
            {summaryRows.map(({ r, spec, info, d, s }) => (
              <tr key={r.id}>
                <td data-sort={info.label}><button type="button" className="bmt-link" onClick={() => open(spec)}>{info.label}</button>{r.queue && <span className="bmt-tag">큐</span>}</td>
                <td className="right" data-sort={s?.avg ?? ''}>{s ? valText(s.avg, info.unit) : '—'}</td>
                <td className="right" data-sort={s?.max ?? ''}>{s ? valText(s.max, info.unit) : '—'}</td>
                <td className="right" data-sort={s?.peak ?? ''}>{info.peak ? (s ? valText(s.peak, info.unit) : '—') : <span className="bmt-dim" title="피크 열이 없는 지표">—(피크 없음)</span>}</td>
                <td data-sort={s?.peakAt ?? ''}>{s?.peakAt ? whenText(s.peakAt, span) : '—'}</td>
                <td className="right" data-sort={s && s.peak != null && s.avg ? s.peak / s.avg : ''}>{s ? peakRatioText(s) : '—'}</td>
                <td data-sort={d?.baseline?.warn ?? ''}>{baselineText(d?.baseline, info.unit) || '—'}</td>
                <td className="right" data-sort={s?.overRatio ?? ''}>{s?.overRatio != null ? `${s.overRatio}%` : '—'}</td>
                <td className="right" data-sort={s?.missing ?? ''}>{s ? `${s.missing} / ${s.missing + s.measured}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </STable>
        <p className="bmt-note">피크는 피크 열이 있는 지표만(1초 창) · ‘주의 이상 비율’ 은 응답 기준선(설정값)의 주의 값 이상인 점의 비율이다 — 판정이 아니라 구간 요약이다. 피크 출처: {pSrcText}.</p>
      </section>

      {/* ── 추천 지표 12행 ── */}
      <section className="bmt-card" ref={recoRef} aria-label="추천 지표">
        <h5>추천 지표 12행 — 출처별(평균 회색 · 피크 빨강 · 보조 선 색) <span className="bmt-hint">근거 등급 ● 원문 확인 · ◐ 검색 발췌 · 미러 · ○ 블로그 합의 · 임계는 출처마다 달라 설정값만 선으로</span></h5>
        {!recoOn && <button type="button" className="btn btn-sm bmp-touch" onClick={() => setRecoOn(true)}>추천 지표 불러오기(지표 {recoMetrics().length}개)</button>}
        {recoOn && (
          <div className="bmt-tiles">
            {RECO_TILES.map((tile) => {
              const main = { kind: 'server', metric: tile.metrics[0] };
              const info = metricInfo('server', tile.metrics[0]);
              const d = dataOf(main);
              const v = sd(main);
              // 단위가 같으면 한 축 · 다르면 지표마다 자기 축(% 와 B/s 를 한 축에 두면 작은 쪽이 바닥에 붙는다)
              const allUnits = new Set(tile.metrics.map((m) => metricInfo('server', m).unit));
              const ownMax = (m) => yMaxFor(metricInfo('server', m).unit, [(dataOf({ kind: 'server', metric: m })?.points || []).flatMap((p) => [p.avg, p.peak])]);
              const vals = tile.metrics.flatMap((m) => (dataOf({ kind: 'server', metric: m })?.points || []).flatMap((p) => [p.avg, p.peak]));
              const yMax = allUnits.size === 1 ? yMaxFor(info.unit, [vals]) : ownMax(tile.metrics[0]);
              const extra = tile.metrics.slice(1).map((m, i) => ({ points: dataOf({ kind: 'server', metric: m })?.points || [], gaps: dataOf({ kind: 'server', metric: m })?.gaps || [], pick: 'avg', color: SECOND_COLORS[i], ...(allUnits.size === 1 ? {} : { yMax: ownMax(m) }) }));
              const lines = tile.metrics.map((m) => {
                const mi = metricInfo('server', m); const dd = dataOf({ kind: 'server', metric: m });
                const s = dd ? windowSummary(dd.points, { sel, peak: mi.peak }) : null;
                return `${mi.label} ${s ? valText(s.avg, mi.unit) : '—'}${mi.peak && s ? ` · 피크 ${valText(s.peak, mi.unit)}` : ''}`;
              });
              return (
                <div key={tile.id} className="bmt-tile">
                  <div className="bmt-tile-head">
                    <button type="button" className="bmt-link" onClick={() => open(main)}>{tile.title}</button>
                    <span className="bmt-tags">{tile.tags.map((tg2) => <span key={tg2} className="bmt-tag" title={`${SOURCE_TAGS[tg2].name} — ${SOURCE_TAGS[tg2].title} (${SOURCE_TAGS[tg2].grade} ${SOURCE_TAGS[tg2].gradeText})`}>{tg2}</span>)}</span>
                  </div>
                  {v?.status === 'loading' || !v ? <div className="bmt-tile-msg">불러오는 중…</div>
                    : v.status !== 'ok' ? <div className="bmt-tile-msg">{trendErrorText(v.error, v.data)}</div>
                      : <Spark points={d?.points || []} gaps={d?.gaps || []} win={win} yMax={yMax} peak={info.peak} extra={extra} onOpen={() => open(main)} label={tile.title} width="100%" height={44} />}
                  <div className="bmt-tile-sum">{lines.join(' · ')}</div>
                  {allUnits.size > 1 && <div className="bmt-tile-note">축은 지표마다 따로(단위가 다르다)</div>}
                  {d?.baseline && <div className="bmt-tile-bl">{baselineText(d.baseline, info.unit)}</div>}
                  <div className="bmt-tile-note">{tile.note}</div>
                </div>
              );
            })}
          </div>
        )}
        <details className="bmt-src-list">
          <summary>출처 6 — 이름 · 확인 등급</summary>
          <STable className="bmt-t" minWidth={560} style={{ fontSize: 12 }}>
            <thead><tr><th>태그</th><th>출처</th><th>확인</th></tr></thead>
            <tbody>
              {SOURCE_ORDER.map((k) => (
                <tr key={k}>
                  <td data-sort={k}><b>{k}</b></td>
                  <td data-sort={SOURCE_TAGS[k].name}>{SOURCE_TAGS[k].name} — {SOURCE_TAGS[k].url ? <a href={SOURCE_TAGS[k].url} target="_blank" rel="noopener noreferrer">{SOURCE_TAGS[k].title}</a> : SOURCE_TAGS[k].title}</td>
                  <td data-sort={SOURCE_TAGS[k].grade}>{SOURCE_TAGS[k].grade} {SOURCE_TAGS[k].gradeText}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        </details>
      </section>

      {/* ── 장치별 보기(§9) ── */}
      <section className="bmt-card" aria-label="장치별 보기">
        <div className="bmt-panel-head">
          <h5>장치별 보기 — 디스크 · 파티션/마운트 · 인터페이스</h5>
          <span style={{ flex: '1 1 auto' }} />
          <Seg items={DEV_SEGS} value={devSeg} onChange={setDevSeg} label="장치 축" />
        </div>
        <p className="bmt-note">서버 대표값(가장 바쁜 장치 · 가장 높은 회선)은 그대로이고, 이 절이 그 장치가 어느 것인지 보여 준다. 표를 고를 때 그 장치들의 추이를 부른다(평균 · 피크는 위 창 · 선택 구간 기준).</p>
        {devSeg === 'none' && (
          <p className="bmt-note">장치 {devs.loading ? '읽는 중…' : `디스크 ${(devices.disk || []).filter((d) => d.info !== 'part').length}개 · 파티션 ${(devices.disk || []).filter((d) => d.info === 'part').length}개 · 마운트 ${(devices.mount || []).length}개 · 인터페이스 ${(devices.nic || []).length}개`} — 위 세그먼트에서 표를 고르세요.</p>
        )}
        {devSeg !== 'none' && (
          <div className="bmt-chips">
            <span className="bmt-k">장치</span>
            {(devSeg === 'disk' ? diskList : devSeg === 'nic' ? nicList : mountList).map((d) => {
              const st = deviceStyle(d.color);
              const spec = devSeg === 'disk' ? { kind: 'disk', metric: 'busy_pct', dev: d.dev } : devSeg === 'nic' ? { kind: 'nic', metric: 'util_pct', dev: d.dev } : { kind: 'mount', metric: 'used_pct', dev: d.dev };
              return <button key={d.dev} type="button" className="bmt-lg" onClick={() => open(spec, devSeg === 'mount' ? { rangeK: '30d' } : {})} title="이 장치를 크게 보기"><i style={{ borderTopColor: st.stroke, borderTopStyle: st.dash ? 'dashed' : 'solid' }} />{d.dev}</button>;
            })}
          </div>
        )}
        {devSeg === 'disk' && (
          <>
            <label className="bmt-check"><input type="checkbox" checked={withParts} onChange={(e) => setWithParts(e.target.checked)} /> 파티션 행 포함(파티션 I/O 는 병합 · 캐시 때문에 디스크 합과 다를 수 있다)</label>
            {!diskList.length ? <p className="bmt-note">{DEVICE_EMPTY_TEXT.disk}</p> : (
              <STable className="bmt-t" minWidth={860} style={{ fontSize: 12 }}>
                <thead><tr><th>장치</th><th>종류</th><th className="right">busy 평균 / 피크</th><th className="right">await 평균 / 피크</th><th className="right">IOPS(최근 5분)</th><th className="right">대기열(최근)</th><th className="right">in-flight(최근)</th><th data-nosort>추이(busy)</th></tr></thead>
                <tbody>
                  {diskList.map((dv, di) => {
                    const b = dataOf({ kind: 'disk', metric: 'busy_pct', dev: dv.dev }); const a = dataOf({ kind: 'disk', metric: 'await_ms', dev: dv.dev });
                    const sb = b ? windowSummary(b.points, { sel, peak: true }) : null; const sa = a ? windowSummary(a.points, { sel, peak: true }) : null;
                    const lt = (latest?.disks || []).find((x) => x.name === dv.dev) || null;
                    const kindText = dv.info === 'part' ? '파티션' : /^dm-/.test(dv.dev) ? 'dm(LVM 등)' : /^md/.test(dv.dev) ? 'md(RAID)' : '물리';
                    return (
                      <tr key={dv.dev}>
                        <td data-sort={dv.dev}><span className="bmt-dot" style={{ background: deviceStyle(dv.color).stroke }} />{dv.dev}</td>
                        <td data-sort={kindText}>{kindText}</td>
                        <td className="right" data-sort={sb?.avg ?? ''}>{sb ? `${valText(sb.avg, '%')} / ${valText(sb.peak, '%')}` : '—'}</td>
                        <td className="right" data-sort={sa?.avg ?? ''}>{sa ? `${valText(sa.avg, 'ms')} / ${valText(sa.peak, 'ms')}` : '—'}{sa?.peakAt ? <span className="bmt-dim"> ({whenText(sa.peakAt, span)})</span> : null}</td>
                        <td className="right" data-sort={lt?.iops ?? ''}>{numText(lt?.iops)}</td>
                        <td className="right" data-sort={lt?.aqu ?? ''}>{numText(lt?.aqu)}</td>
                        <td className="right" data-sort={lt?.inFlight ?? ''}>{numText(lt?.inFlight)}</td>
                        <td data-nosort>{b ? <Spark points={b.points} gaps={b.gaps} win={win} yMax={100} peak onOpen={() => open({ kind: 'disk', metric: 'busy_pct', dev: dv.dev })} label={`${dv.dev} busy`} /> : <span className="bmt-dim">{di >= DEV_TABLE_MAX ? '부르지 않음(상한)' : sd({ kind: 'disk', metric: 'busy_pct', dev: dv.dev })?.status === 'loading' ? '읽는 중…' : '—'}</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </STable>
            )}
            {diskList.length > DEV_TABLE_MAX && <p className="bmt-note">장치 {diskList.length}개 중 앞 {DEV_TABLE_MAX}개(서버 순서)의 추이만 불렀습니다(요청 수 상한) — 나머지 행은 ‘부르지 않음’ 이고 정렬하면 뒤로 갑니다.</p>}
            <p className="bmt-note">피크 출처: {pSrcText}.</p>
            <p className="bmt-note">IOPS · 대기열 · in-flight 은 성능 상세의 최근 5분 값입니다(장치별 추이는 busy · await 만 불렀다). 디스크 오류 · SMART 는 OS 경로에 없어 하드웨어(iDRAC) 탭에서 봅니다. loop · ram · zram · sr 은 제외.</p>
          </>
        )}
        {devSeg === 'mount' && (
          <>
            {!mountList.length ? <p className="bmt-note">마운트 이력이 없습니다 — 마운트는 하루 한 번 롤업만 쌓습니다(첫 일 롤업 전이면 비어 있습니다).</p> : (
              <STable className="bmt-t" minWidth={640} style={{ fontSize: 12 }}>
                <thead><tr><th>마운트</th><th className="right">공간 사용률(최근 일 평균)</th><th className="right">30일 최대</th><th className="right">inode(최근)</th><th data-nosort>추이 30일</th></tr></thead>
                <tbody>
                  {mountList.map((dv) => {
                    const u = mountSeries[`mount|used_pct|${dv.dev}`]; const io = mountSeries[`mount|inode_pct|${dv.dev}`];
                    const ud = u?.status === 'ok' ? u.data : null; const id = io?.status === 'ok' ? io.data : null;
                    const lastU = ud ? [...(ud.points || [])].reverse().find((p) => p.avg != null) : null;
                    const lastI = id ? [...(id.points || [])].reverse().find((p) => p.avg != null) : null;
                    const su = ud ? windowSummary(ud.points) : null;
                    return (
                      <tr key={dv.dev}>
                        <td data-sort={dv.dev}><span className="mono">{dv.dev}</span></td>
                        <td className="right" data-sort={lastU?.avg ?? ''}>{valText(lastU?.avg, '%')}</td>
                        <td className="right" data-sort={su?.max ?? ''}>{su ? valText(su.max, '%') : '—'}</td>
                        <td className="right" data-sort={lastI?.avg ?? ''}>{valText(lastI?.avg, '%')}</td>
                        <td data-nosort>{ud ? <Spark points={ud.points} gaps={ud.gaps} win={mWin} yMax={100} onOpen={() => open({ kind: 'mount', metric: 'used_pct', dev: dv.dev }, { rangeK: '30d' })} label={`${dv.dev} 공간`} /> : <span className="bmt-dim">{u?.status === 'loading' ? '읽는 중…' : u ? trendErrorText(u.error, u.data) : '—'}</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </STable>
            )}
            <p className="bmt-note">마운트는 일 롤업(하루 1회)만 있어 기간과 상관없이 30일 창으로 부른다. 7일 증가 · 가득 예상(선형 추정)은 서버 API 가 아직 주지 않아 그리지 않았다. NFS 등 원격 마운트는 스토리지 화면 소관(여기서 제외).</p>
          </>
        )}
        {devSeg === 'nic' && (
          <>
            {!nicList.length ? <p className="bmt-note">{DEVICE_EMPTY_TEXT.nic}</p> : (
              <STable className="bmt-t" minWidth={860} style={{ fontSize: 12 }}>
                <thead><tr><th>인터페이스 · 상태</th><th className="right">사용률 평균 / 피크</th><th className="right">최근 rx / tx · 드롭 / 오류</th><th data-nosort>추이</th><th>스위치 포트(CVP) · 매핑</th><th className="right">포트 사용률 in / out</th><th className="right">포트 오류 · 드롭</th></tr></thead>
                <tbody>
                  {nicList.map((dv, ni) => {
                    const u = dataOf({ kind: 'nic', metric: 'util_pct', dev: dv.dev });
                    const su = u ? windowSummary(u.points, { sel, peak: true }) : null;
                    const pr = (ports.data?.nics || []).find((x) => x.nic === dv.dev) || null;
                    const lt = (latest?.nics || []).find((x) => x.iface === dv.dev) || null;
                    const psv = pr ? portStateView(pr.state) : null;
                    const pp = pr?.port || null;
                    return (
                      <tr key={dv.dev}>
                        <td data-sort={dv.dev}><span className="bmt-dot" style={{ background: deviceStyle(dv.color).stroke }} />{dv.dev}<div className="bmt-dim">{lt?.state || '상태 —'}</div></td>
                        <td className="right" data-sort={su?.avg ?? ''}>{su ? `${valText(su.avg, '%')} / ${valText(su.peak, '%')}` : '—'}</td>
                        <td className="right" data-sort={pr?.server?.rxBps ?? ''}>{pr?.server ? `${bpsText(pr.server.rxBps)} / ${bpsText(pr.server.txBps)}` : '—'}<div className="bmt-dim">{pr?.server ? `드롭 ${valText(pr.server.dropDelta, '건')} · 오류 ${valText(pr.server.errDelta, '건')}` : ''}</div></td>
                        <td data-nosort>{u ? <Spark points={u.points} gaps={u.gaps} win={win} yMax={100} peak width={96} onOpen={() => open({ kind: 'nic', metric: 'util_pct', dev: dv.dev })} label={`${dv.dev} 사용률`} /> : <span className="bmt-dim">{ni >= DEV_TABLE_MAX ? '부르지 않음(상한)' : sd({ kind: 'nic', metric: 'util_pct', dev: dv.dev })?.status === 'loading' ? '읽는 중…' : '—'}</span>}</td>
                        <td data-sort={pp ? `${pp.device} ${pp.port}` : (pr?.state || '')}>{pp ? <span className="mono">{pp.device} {pp.port}</span> : '—'}<div>{psv ? <span style={{ color: toneVar(psv.tone) }} title={psv.body}>{psv.label}</span> : <span className="bmt-dim">{ports.loading ? '읽는 중…' : '—'}</span>}</div></td>
                        <td className="right" data-sort={pp?.inUtil ?? ''}>{pp ? `${portPctText(pp.inUtil)} / ${portPctText(pp.outUtil)}` : '—'}</td>
                        <td className="right" data-sort={pp?.inErr ?? ''}>{pp ? <>오류 {valText(pp.inErr, '')} · {valText(pp.outErr, '')}<div className="bmt-dim">드롭 {pp.inDrop == null && pp.outDrop == null ? '미수집' : `${valText(pp.inDrop, '')} · ${valText(pp.outDrop, '')}`}</div></> : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </STable>
            )}
            <p className="bmt-note">피크 출처: {pSrcText}.</p>
            <p className="bmt-note">사용률(%)은 물리 회선과 bond(멤버 속도 합)만 낸다 — tun/tap · veth · bridge 는 속도가 거짓이라 제외(기존 규칙). 드롭(OS)과 CRC(iDRAC)는 다른 칸(교차 판정 ④). 포트 값은 CVP 단위(bit/s · 0~100 밖 버림)이다.</p>
          </>
        )}
      </section>

      {/* ── D 스위치 포트 연동(§10) ── */}
      <section className="bmt-card" aria-label="스위치 포트 연동">
        <h5>D · 스위치 포트 연동(CVP) — 서버 NIC 와 스위치 포트를 짝지어 양쪽 카운터를 나란히</h5>
        {ports.loading && <p className="bmt-note">포트 대조를 읽는 중…</p>}
        {ports.err && (ports.err.status === 403 ? <ErrorBox error={ports.err} /> : <p className="bmt-note" style={{ color: toneVar('warn') }}>{trendErrorText(ports.err)}</p>)}
        {ports.data && ports.data.ok === false && <p className="bmt-note" style={{ color: toneVar('warn') }}>{trendErrorText(null, ports.data)}</p>}
        {ports.data && ports.data.ok !== false && (
          <div className="bmt-stack">
            <div style={{ minWidth: 0 }}>
              <h6>매핑 출처 — 우선순위 순</h6>
              <STable className="bmt-t" minWidth={480} style={{ fontSize: 12 }}>
                <thead><tr><th>출처</th><th>지금 수집</th><th>신뢰</th></tr></thead>
                <tbody>
                  {mapSourceRows(ports.data).map((m) => (
                    <tr key={m.no}>
                      <td data-sort={m.no} className="bmt-wrap"><b>{m.no} {m.title}</b><div className="bmt-dim">{m.what}</div></td>
                      <td data-sort={m.state} className="bmt-wrap"><span style={{ color: toneVar(m.tone) }}>{m.state}</span></td>
                      <td data-sort={m.trust}>{m.trust}</td>
                    </tr>
                  ))}
                </tbody>
              </STable>
              <p className="bmt-note">매핑 근거가 바뀌면(케이블 이동 등) 이전 매핑을 승계하지 않고 사람이 다시 확정한다. 수동 매핑 편집은 관리자 API(포트 매핑 저장)만 있고 이 화면에는 아직 편집 칸이 없다.</p>
            </div>
            <div style={{ minWidth: 0 }}>
              <h6>양쪽 대조(교차 판정 ⑤) — 서버 tx ≈ 포트 in · 서버 rx ≈ 포트 out · 기준 {valText(ports.data.tolPct, '%')}(설정값)</h6>
              {(ports.data.nics || []).filter((x) => x.compare).length ? (
                <STable className="bmt-t" minWidth={640} style={{ fontSize: 12 }}>
                  <thead><tr><th>NIC ↔ 포트</th><th>서버 tx ↔ 포트 in</th><th>서버 rx ↔ 포트 out</th><th>판정(후보)</th></tr></thead>
                  <tbody>
                    {(ports.data.nics || []).filter((x) => x.compare).map((x) => {
                      const cv = compareView(x.compare);
                      return (
                        <tr key={x.nic}>
                          <td data-sort={x.nic}><span className="mono">{x.nic}</span> ↔ <span className="mono">{x.port?.device} {x.port?.port}</span></td>
                          <td data-sort={x.compare.tx?.diffPct ?? ''}>{pairText(x.compare.tx)}</td>
                          <td data-sort={x.compare.rx?.diffPct ?? ''}>{pairText(x.compare.rx)}</td>
                          <td data-sort={x.compare.verdict} className="bmt-wrap"><span style={{ color: toneVar(cv.tone) }}>{cv.label}</span><div className="bmt-dim"><BoldText text={cv.body} /></div></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </STable>
              ) : <p className="bmt-note">확정 매핑이 있고 카운터가 신선한 NIC 가 없어 대조할 쌍이 없습니다.</p>}
              <p className="bmt-note">서버 5분 창과 CVP 수집 창이 맞을 때만 비교하고 못 맞추면 비교하지 않는다. 포트 처리량은 bit/s 를 8 로 나눠 B/s 로 맞췄다.</p>
            </div>
          </div>
        )}
        {ports.data && ports.data.ok !== false && (
          <>
            <div className="bmt-chips" aria-label="상태">
              <span className="bmt-k">상태</span>
              {PORT_STATE_ORDER.map((s) => {
                const v = portStateView(s); const c = portStateCounts(ports.data)[s] || 0;
                return <span key={s} className="bmp-chip" style={{ color: c ? toneVar(v.tone) : 'var(--text-faint)' }} title={v.body}>{v.label} {c}</span>;
              })}
              {Object.keys(portStateCounts(ports.data)).filter((s) => !PORT_STATE_ORDER.includes(s)).map((s) => <span key={s} className="bmp-chip" title={portStateView(s).body}>{portStateView(s).label} {portStateCounts(ports.data)[s]}</span>)}
            </div>
            {(ports.data.nics || []).length > 0 && (
              <STable className="bmt-t" minWidth={640} style={{ fontSize: 12 }}>
                <thead><tr><th>NIC</th><th>상태</th><th>포트</th><th className="right">포트 처리량 in / out</th><th>설명</th></tr></thead>
                <tbody>
                  {(ports.data.nics || []).map((x) => {
                    const v = portStateView(x.state);
                    return (
                      <tr key={x.nic}>
                        <td data-sort={x.nic}><span className="mono">{x.nic}</span></td>
                        <td data-sort={x.state}><span style={{ color: toneVar(v.tone) }}>{v.label}</span></td>
                        <td data-sort={x.port ? `${x.port.device} ${x.port.port}` : ''}>{x.port ? <span className="mono">{x.port.device} {x.port.port}</span> : x.mapping ? <span className="mono">{x.mapping.deviceKey} {x.mapping.port}</span> : '—'}</td>
                        <td className="right" data-sort={x.port?.inBps ?? ''}>{x.port ? `${bitsText(x.port.inBps)} / ${bitsText(x.port.outBps)}` : '—'}</td>
                        <td data-sort={v.body} className="bmt-wrap"><span className="bmt-dim">{v.body}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </STable>
            )}
            {(ports.data.candidates || []).length > 0 && (
              <>
                <h6>설명 매칭 후보 — 확인 필요(사람이 확정)</h6>
                <STable className="bmt-t" minWidth={640} style={{ fontSize: 12 }}>
                  <thead><tr><th>스위치</th><th>포트</th><th>NIC</th><th>설명</th><th>근거</th></tr></thead>
                  <tbody>
                    {ports.data.candidates.map((c, i) => (
                      <tr key={`${c.cvpId}|${c.deviceKey}|${c.port}|${i}`}>
                        <td data-sort={c.deviceName || c.deviceKey}>{c.deviceName || c.deviceKey}</td>
                        <td data-sort={c.port}><span className="mono">{c.port}</span></td>
                        <td data-sort={c.nic || ''}>{c.nic || '—'}</td>
                        <td data-sort={c.descr} className="bmt-wrap">{c.descr || '—'}</td>
                        <td data-sort={c.basis || ''}>{c.basis || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </STable>
              </>
            )}
            {portNotes(ports.data).map((x, i) => <p key={i} className="bmt-note"><BoldText text={x} /></p>)}
          </>
        )}
      </section>

      {pop && (
        <BmTrendPopup itemKey={itemKey} name={name} init={pop} devices={devices} keepDays={keepDays} anchor={clock.at}
          initWin={pop.rangeK === rangeK ? win : null} peakWindowS={devs.data?.peakWindowS ?? null}
          onClose={() => setPop(null)} onSel={(s) => setSel(s)} />
      )}
    </div>
  );
}
