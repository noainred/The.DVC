/**
 * views/tools/BmTrendPopup.jsx — 추이 **확대 팝업**(리눅스 성능 3b · v2.923 · 설계 PROFILES §11 · 아트보드 ②-추이 › 확대 팝업).
 *
 * 1240 × 800 모달(400 폭은 전체 화면) — 제목(장치 · 지표) · 지표/장치 고르기 · 기간 · 표시(평균+피크/평균/피크) · CSV · 전체 화면 · 닫기(Esc)
 * → 요약 4(평균 · 피크와 시각 · 피크/평균 · 주의 이상 비율) → 큰 차트(평균 회색 · 피크 빨강 · 기준선(설정값) · 선택 구간 · 커서 · 툴팁)
 * → 구간 이동 줄(◀ 이전 · 슬라이더 · 다음 ▶ · 최신 · 날짜로 이동 — 창 계산은 공용 vmPerfText) → 범례 · 조작 안내 · ‘추이 탭으로’.
 *
 * ⚠ 피크 점을 누르면 그 5분의 피크가 무엇으로 모였는지 적는다 — 1초 표본은 저장하지 않으므로 **펼치지 않는다**(B 샘플러 1초 표본 300개
 *   펼침은 샘플러 배포 뒤 기능 — 없는 기능을 그리지 않는다).
 * ⚠ 폴링 없음 · 늦게 온 이전 창 응답은 버린다(bmTrendLoad 세대) · 훅은 조기 return 위.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { canCsv } from '../../api.js';
import EscClose from '../../components/EscClose.jsx';
import Select from '../../components/Select.jsx';
import BoldText from '../../components/boldText.jsx';
import { windowSpan, backForSpan, dateJumpEnd, dateInputOf, windowRangeText } from '../../components/vmperf/vmPerfText.js';
import { createTrendLoader, trendFetcher } from './bmTrendLoad.js';
import { TrendSvg, TimeAxis, usePointer } from './BmTrendChart.jsx';
import BmTopProc from './BmTopProc.jsx'; // 8b단계 ⑳ — 이 시점 프로세스 · 시간 × 프로세스 띠
import {
  TREND_RANGES, trendRangeOf, SHOW_MODES, showAvg, showPeak, metricInfo, SERVER_METRIC_INFO, DEVICE_METRIC_INFO, resText, resHint,
  peakSrcText, peakPointText, trendNotes, trendErrorText, valText, axisText, yMaxFor, noPeakRuns, nearestPoint, windowSummary, peakRatioText,
  baselineText, whenText, trendMaxBack, trendCsv, trendCsvName, seriesKey, seriesLabel, toggleDevices,
} from './bmTrendText.js';
import './bmTrend.css';

function downloadText(text, name) {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') return;
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * @param {{itemKey:string, name?:string, init:{kind,metric,dev,rangeK,show,sel}, devices?:object, keepDays?:object|null, anchor?:number,
 *   initWin?:{from:number,to:number}|null, peakWindowS?:number|null, onClose:()=>void, onSel?:(sel)=>void, narrowOverride?:boolean}} p
 */
export default function BmTrendPopup({ itemKey, vc = '', name = '', init = {}, devices = {}, keepDays = null, anchor = null, initWin = null, peakWindowS = null, onClose, onSel, narrowOverride = null }) {
  // ⚠ 훅은 전부 조기 return 위.
  const [spec, setSpec] = useState(() => ({ kind: init.kind || 'server', metric: init.metric || 'cpu_pct', dev: init.dev || '' }));
  const [rangeK, setRangeK] = useState(() => trendRangeOf(init.rangeK).k);
  const [show, setShow] = useState(init.show || 'both');
  const [sel, setSel] = useState(init.sel || null);
  const [nav, setNav] = useState({ back: 0, anchor: null, drag: null });
  const [full, setFull] = useState(false);
  const [hover, setHover] = useState(null);
  const [picked, setPicked] = useState(null);
  const [reloadN, setReloadN] = useState(0);
  const [res, setRes] = useState(null);
  const [narrow, setNarrow] = useState(() => (narrowOverride != null ? narrowOverride : typeof window !== 'undefined' && window.innerWidth < 720));
  const loader = useRef(null);
  if (!loader.current) loader.current = createTrendLoader(trendFetcher(itemKey, vc));
  const span = trendRangeOf(rangeK).ms;
  const base = useMemo(() => (anchor != null ? anchor : Date.now()), [anchor]);
  const win = useMemo(() => {
    if (nav.back > 0 && nav.anchor != null) { const w = windowSpan(nav.anchor, nav.back, span); return { from: w.start, to: w.end }; }
    if (initWin && rangeK === trendRangeOf(init.rangeK).k) return initWin;
    return { from: base - span, to: base };
  }, [nav.back, nav.anchor, span, initWin, rangeK, init.rangeK, base]);
  const winKey = `${win.from}|${win.to}|${reloadN}`;
  const onResult = useCallback((k, v) => setRes((p) => (v.status === 'loading' && p && p.key === k && p.status !== 'loading' ? p : { key: k, ...v })), []);

  useEffect(() => {
    if (narrowOverride != null || typeof window === 'undefined') return undefined;
    const on = () => setNarrow(window.innerWidth < 720);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [narrowOverride]);
  useEffect(() => () => loader.current?.cancel(), []);
  useEffect(() => {
    loader.current.setWindow(winKey);
    setRes(null);
    loader.current.request([{ kind: spec.kind, metric: spec.metric, ...(spec.dev ? { dev: spec.dev } : {}) }], win, onResult);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 창은 winKey 로 고정
  }, [winKey, spec.kind, spec.metric, spec.dev, onResult]);
  const ptr = usePointer({ win, onHover: setHover, onSelect: (s) => { setSel(s); if (onSel) onSel(s); }, onOpen: (ms) => setPicked(ms) });

  if (!itemKey || !init) return null;

  const key = seriesKey(spec);
  const cur = res && res.key === key ? res : null;
  const d = cur && cur.status === 'ok' ? cur.data : null;
  const info = metricInfo(spec.kind, spec.metric);
  const pts = d?.points || [];
  const sum = windowSummary(pts, { sel, baseline: d?.baseline || null, peak: info.peak });
  const lines = [];
  const vals = [];
  if (showAvg(show)) { lines.push({ points: pts, gaps: d?.gaps, pick: 'avg', color: 'var(--text-dim)', width: 1.6 }); for (const p of pts) vals.push(p.avg); }
  if (showPeak(show)) {
    if (info.peak) { lines.push({ points: pts, gaps: d?.gaps, pick: 'peak', color: 'var(--red)', width: 1.8 }); for (const p of pts) vals.push(p.peak); }
    else if (d?.res && d.res !== '5m') { lines.push({ points: pts, gaps: d?.gaps, pick: 'max', color: 'var(--amber)', dash: '5 4', width: 1.4 }); for (const p of pts) vals.push(p.max); }
  }
  const baseline = d?.baseline || null;
  if (baseline?.warn != null) vals.push(baseline.warn);
  const yMax = yMaxFor(info.unit, [vals]);
  const noPeak = info.peak && showPeak(show) ? noPeakRuns(pts, { stepMs: d?.stepMs }) : [];
  const hp = hover != null ? nearestPoint(pts, hover) : null;
  const pp = picked != null ? nearestPoint(pts, picked) : null;
  const keep = spec.kind === 'server' || spec.kind === 'mount' ? keepDays?.server : keepDays?.dev;
  const maxBack = trendMaxBack(span, keep);
  const curBack = nav.drag ?? nav.back;
  const go = (b) => {
    const nb = Math.max(0, maxBack == null ? Math.floor(b) : Math.min(maxBack, Math.floor(b)));
    setPicked(null); setHover(null); setSel(null);
    setNav((p) => (nb === 0 ? { back: 0, anchor: null, drag: null } : { back: nb, anchor: p.anchor ?? win.to, drag: null }));
  };
  const onJump = (str) => {
    const e = dateJumpEnd(str); if (e == null) return;
    const a = nav.anchor ?? win.to;
    const b = backForSpan(a, e, span, maxBack == null ? Number.MAX_SAFE_INTEGER : maxBack);
    setPicked(null); setSel(null);
    setNav(b === 0 ? { back: 0, anchor: null, drag: null } : { back: b, anchor: a, drag: null });
  };
  const metricOpts = spec.kind === 'server' ? Object.keys(SERVER_METRIC_INFO) : Object.keys(DEVICE_METRIC_INFO[spec.kind] || {});
  const devOpts = spec.kind === 'disk' ? [...toggleDevices(devices, 'disk'), ...toggleDevices(devices, 'part')] : spec.kind === 'nic' ? toggleDevices(devices, 'nic') : spec.kind === 'mount' ? (devices.mount || []) : [];
  const isFull = full || narrow;
  const pctX = (ms) => ((ms - win.from) / (win.to - win.from)) * 100;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((r) => ({ r, v: yMax * r }));
  const title = `${spec.dev ? `${spec.dev} · ` : ''}${info.label} — ${show === 'avg' ? '평균' : show === 'peak' ? '피크' : '평균 · 피크'}`;
  const srcText = peakSrcText(d?.peakSrc || [], peakWindowS);

  return (
    <div className="bmt-pop-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <EscClose onClose={onClose} />
      <div className={`bmt-pop${isFull ? ' full' : ''}`} role="dialog" aria-modal="true" aria-label={`${title} 확대`}>
        {/* ── 머리 ── */}
        <div className="bmt-pop-head">
          <div style={{ minWidth: 0, flex: '1 1 320px' }}>
            <h4 style={{ margin: 0, overflowWrap: 'anywhere' }}>{title}</h4>
            <div className="bmt-hint">
              {[name || itemKey, spec.kind === 'server' ? '서버 대표값' : spec.kind === 'disk' ? '디스크별' : spec.kind === 'nic' ? '인터페이스별' : '마운트', d ? resText(d) : null,
                d ? `점 ${pts.length}개 · 결측 구간 ${(d.gaps || []).length}개(선을 끊음)` : null].filter(Boolean).join(' · ')}
            </div>
          </div>
          <div className="bmt-pop-sel">
            {spec.kind !== 'server' && (
              <Select className="bmt-select" aria-label="장치" value={spec.dev} onChange={(e) => { setSpec((p) => ({ ...p, dev: e.target.value })); setPicked(null); }}>
                {devOpts.map((x) => <option key={x.dev} value={x.dev}>{x.dev}{x.info === 'part' ? '(파티션)' : ''}</option>)}
                {!devOpts.some((x) => x.dev === spec.dev) && spec.dev && <option value={spec.dev}>{spec.dev}</option>}
              </Select>
            )}
            <Select className="bmt-select" aria-label="지표" value={spec.metric} onChange={(e) => { setSpec((p) => ({ ...p, metric: e.target.value })); setPicked(null); }}>
              {metricOpts.map((m) => <option key={m} value={m}>{metricInfo(spec.kind, m).label}</option>)}
            </Select>
            <div className="bmp-seg bmt-seg" role="tablist" aria-label="기간">
              {TREND_RANGES.map((r) => <button key={r.k} type="button" role="tab" aria-selected={rangeK === r.k} className={rangeK === r.k ? 'active' : ''} onClick={() => { setRangeK(r.k); setNav({ back: 0, anchor: null, drag: null }); setSel(null); setPicked(null); }}>{r.label}</button>)}
            </div>
          </div>
        </div>
        <div className="bmt-pop-acts">
          <div className="bmp-seg bmt-seg" role="tablist" aria-label="표시">
            {SHOW_MODES.map((m) => <button key={m.k} type="button" role="tab" aria-selected={show === m.k} className={show === m.k ? 'active' : ''} onClick={() => setShow(m.k)}>{m.label}</button>)}
          </div>
          {canCsv() && <button type="button" className="btn btn-sm bmp-touch" disabled={!d} onClick={() => downloadText(trendCsv([{ label: seriesLabel(spec), unit: info.unit, peak: info.peak, points: pts }]), trendCsvName(`${name || itemKey}_${spec.dev || 'server'}_${spec.metric}`, rangeK, win.to))}>CSV</button>}
          {!narrow && <button type="button" className="btn btn-sm bmp-touch" onClick={() => setFull((v) => !v)}>{full ? '⤡ 창 크기로' : '⤢ 전체 화면'}</button>}
          <button type="button" className="btn btn-sm bmp-touch" onClick={() => setReloadN((x) => x + 1)} disabled={cur?.status === 'loading'}>다시 읽기</button>
          <button type="button" className="btn btn-sm bmp-touch" onClick={onClose}>✕ 닫기(Esc)</button>
        </div>

        {/* ── 요약 4 ── */}
        <div className="bmt-sum4">
          <div><b>{valText(sum.avg, info.unit)}</b><span>평균</span></div>
          <div><b style={{ color: info.peak && sum.peak != null ? 'var(--red)' : undefined }}>{info.peak ? valText(sum.peak, info.unit) : valText(sum.max, info.unit)}</b><span>{info.peak ? `피크${sum.peakAt ? ` · ${whenText(sum.peakAt, span)}` : ''}` : `최대(피크 열 없음)${sum.maxAt ? ` · ${whenText(sum.maxAt, span)}` : ''}`}</span></div>
          <div><b>{info.peak ? peakRatioText(sum) : '—'}</b><span>피크/평균</span></div>
          <div><b>{sum.overRatio != null ? `${sum.overRatio}%` : '—'}</b><span>{baseline?.warn != null ? `구간 중 기준 주의(${valText(baseline.warn, info.unit)}) 이상 비율` : '기준선 없음(설정값이 없는 지표)'}</span></div>
          <span className="bmp-chip bmt-src">{sel ? `선택 ${windowRangeText(sel.from, sel.to)}` : '창 전체'} · 결측 {sum.missing}점</span>
        </div>
        {info.peak && <div className="bmt-hint">피크 출처: {srcText}</div>}
        {cur?.status === 'ok' && trendNotes(d).map((x, i) => <p key={i} className="bmt-note"><BoldText text={x} /></p>)}
        {cur && (cur.status === 'error' || cur.status === 'fail') && <p className="bmt-note" style={{ color: 'var(--red)' }}>{trendErrorText(cur.error, cur.data)}</p>}

        {/* ── 큰 차트 ── */}
        <div className="bmt-big">
          <div className="bmt-yaxis" aria-hidden="true">
            {yTicks.map((y) => <span key={y.r} style={{ bottom: `${y.r * 100}%` }}>{axisText(y.v, info.unit)}{y.r === 1 && info.unit && info.unit !== '건' ? (info.unit === 'B/s' ? '/s' : info.unit) : ''}</span>)}
          </div>
          <div className="bmt-big-plot">
            <TrendSvg series={lines} win={win} yMax={yMax} cursor={hover} sel={sel} baseline={baseline} gaps={d?.gaps || []} noPeak={noPeak} label={`${title} 큰 차트`} height={isFull ? 'calc(100% - 4px)' : (narrow ? 240 : 380)} ptr={ptr} />
            {baseline?.warn != null && baseline.warn <= yMax && <span className="bmt-bl" style={{ bottom: `${(baseline.warn / yMax) * 100}%`, color: 'var(--amber)' }}>주의 {valText(baseline.warn, info.unit)}(설정값)</span>}
            {baseline?.bad != null && baseline.bad <= yMax && <span className="bmt-bl" style={{ bottom: `${(baseline.bad / yMax) * 100}%`, color: 'var(--red)' }}>초과 {valText(baseline.bad, info.unit)}(설정값)</span>}
            {!d && cur?.status === 'loading' && <div className="bmt-row-msg">불러오는 중…</div>}
            {!d && !cur && <div className="bmt-row-msg">불러오는 중…</div>}
            {d && !pts.some((p) => p.avg != null || p.peak != null) && <div className="bmt-row-msg">이 구간에 값이 없습니다 — 0 으로 그리지 않습니다{d.resReason === 'beyond-retention' ? '(보존 기간 밖)' : ''}.</div>}
            {hp && (
              <div className={`bmt-tip${pctX(hp.t) > 60 ? ' left' : ''}`} style={{ left: `${pctX(hp.t)}%` }} role="status">
                <div className="h">{whenText(hp.t, Math.min(span, 86_400_000))}{d?.res ? ` · ${d.res === '5m' ? '5분 주기' : d.res === '1h' ? '1시간 롤업' : '1일 롤업'}` : ''}</div>
                <div>평균 <b>{valText(hp.avg, info.unit)}</b>{d?.res !== '5m' ? <> · 최대 <b>{valText(hp.max, info.unit)}</b></> : null}</div>
                {info.peak && <div style={{ color: 'var(--red)' }}>피크 <b>{valText(hp.peak, info.unit)}</b>{hp.peakAt ? ` · ${whenText(hp.peakAt, 86_400_000)}` : ''}</div>}
                {hp.n != null && d?.res !== '5m' && <div className="bmt-dim">표본 {hp.n}개</div>}
              </div>
            )}
          </div>
        </div>
        <TimeAxis from={win.from} to={win.to} narrow={narrow} selText={sel ? `${whenText(sel.from, span)} ~ ${whenText(sel.to, span)} (선택)` : ''} />

        {pp && (
          <div className="bmt-picked">
            <div><b>{whenText(pp.t, 86_400_000)}</b> — 평균 {valText(pp.avg, info.unit)}{info.peak ? <> · 피크 <b style={{ color: 'var(--red)' }}>{valText(pp.peak, info.unit)}</b>{pp.peakAt ? ` (${whenText(pp.peakAt, 86_400_000)})` : ''}</> : null}</div>
            {info.peak && pp.peak != null && <div className="bmt-hint">{peakPointText((d?.peakSrc || [])[0] || 'window10', peakWindowS)}</div>}
            {info.peak && pp.peak == null && pp.avg != null && <div className="bmt-hint">이 주기에는 피크 표본이 없습니다(—).</div>}
            <button type="button" className="btn btn-sm" onClick={() => setPicked(null)}>닫기</button>
          </div>
        )}

        {/* ── 8b단계 ⑳: 이 시점 프로세스(누른 점 → 없으면 창의 피크 시각 → 창 끝) · 시간 × 프로세스 띠(이 창) — 서버 대표값 지표에서만 ── */}
        {spec.kind === 'server' && <BmTopProc itemKey={itemKey} vc={vc} ts={pp?.t ?? sum.peakAt ?? sum.maxAt ?? win.to} win={win} narrow={narrow} />}

        {/* ── 구간 이동 줄(공용 창 계산) ── */}
        <div className="bmt-nav">
          <button type="button" className="btn btn-sm bmp-touch" disabled={maxBack != null && curBack >= maxBack} onClick={() => go(curBack + 1)}>◀ 이전 {trendRangeOf(rangeK).label}</button>
          {maxBack != null && maxBack > 0 && (
            <input type="range" min={0} max={maxBack} step={1} value={maxBack - curBack} aria-label="조회 구간 스크롤(오른쪽 끝 = 최근)"
              onChange={(e) => setNav((p) => ({ ...p, drag: maxBack - Number(e.target.value) }))}
              onPointerUp={(e) => go(maxBack - Number(e.currentTarget.value))} onKeyUp={(e) => go(maxBack - Number(e.currentTarget.value))} />
          )}
          <button type="button" className="btn btn-sm bmp-touch" disabled={curBack <= 0} onClick={() => go(curBack - 1)}>다음 {trendRangeOf(rangeK).label} ▶</button>
          <button type="button" className="btn btn-sm bmp-touch" disabled={curBack === 0} onClick={() => go(0)}>최신</button>
          <label className="bmt-date"><span>날짜로 이동</span>
            <input type="date" value={dateInputOf(win.to)} max={dateInputOf(Date.now())} onChange={(e) => { if (e.target.value) onJump(e.target.value); }} />
          </label>
          <span className="bmt-hint">{curBack === 0 ? '최근 구간' : `${curBack}칸 전`} · {windowRangeText(win.from, win.to)}{maxBack == null ? ' · 보존 기간은 이 노드 설정만 알 수 있어 슬라이더를 두지 않았습니다(보존 밖이면 서버가 말합니다)' : ` · 뒤로 ${maxBack}칸까지(보존 설정)`}</span>
        </div>

        {/* ── 범례 · 안내 ── */}
        <div className="bmt-pop-foot">
          <span className="bmt-key"><i style={{ borderTopColor: 'var(--text-dim)' }} />평균</span>
          {info.peak ? <span className="bmt-key"><i style={{ borderTopColor: 'var(--red)' }} />피크(1초 창 최대 · 점을 누르면 출처)</span>
            : <span className="bmt-key"><i style={{ borderTopColor: 'var(--amber)', borderTopStyle: 'dashed' }} />최대(롤업일 때 · 피크 열 없음)</span>}
          {baseline && <span className="bmt-key"><i style={{ borderTopColor: 'var(--amber)', borderTopStyle: 'dashed' }} />{baselineText(baseline, info.unit)}</span>}
          <span className="bmt-hint">{resHint(d?.res)} 끌기 = 구간 선택 · 두 번 누름 = 해제 · 누름 = 그 주기 값 · Esc = 닫기</span>
          <span style={{ flex: '1 1 auto' }} />
          <button type="button" className="bmt-link" onClick={onClose}>추이 탭으로(두 화면 동기화 보기)</button>
        </div>
      </div>
    </div>
  );
}
