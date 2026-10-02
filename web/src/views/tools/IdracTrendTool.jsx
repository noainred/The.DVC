// IdracTrendTool.jsx — 특수 기능 › iDRAC 통합 추이(v2.660). CPU 사용률 · CPU 온도 · GPU 온도 · 소비 전력을 한 차트로.
// 디자인: 사용자 제공 핸드오프 design_handoff_idrac_trend(README · iDRAC 통합 추이 (기존 포탈).dc.html).
// 셸(← 특수 기능 · 제목)은 SpecialTools.jsx 가 그린다 — 여기서는 본문만.
// 판정은 서버(routes/admin/idracTrend.js)가 하고 문구·요약은 idracTrendText.js 가 한다(읽기만).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ResponsiveContainer, ComposedChart, Line, Area, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine, ReferenceArea } from 'recharts';
import { fetchJson, canCsv, CSV_DENIED_NOTE, downloadFile, usePolling } from '../../api.js';
import { Loading, ErrorBox } from '../../components/primitives.jsx';
import { Modal } from '../../components/Modal.jsx';
import { IdracTypeBar } from './IdracTypeBar.jsx';
import { EntityDetail } from '../../components/EntityDetail.jsx';
import { IdracDetailModal } from '../idrac/IdracDetailModal.jsx';
import { WARN_PCT, CRIT_PCT } from '../../console/consoleData.js';
import { IdracTrendTable } from './IdracTrendTable.jsx';
import BoldText from '../../components/boldText.jsx';
import { takeSearch, onSearchHandoff } from '../../hooks/searchHandoff.js';
import {
  PRESETS, SERIES, DAY, bucketLabel, fmtTick, periodText, statsOf, staleCurText, gapAreas, customRangeError, toLocalInput, pMaxOf, ymd, hm,
  corpsOf, sitesOf, serversOf, serverLabel, EMPTY_TYPE, filterByType, matchType, typeQuery, typeText, gpuStateOf, valueText, retentionNote, emptyNote, kindBasisText, DC_SOURCE_TEXT,
  loadOrder, saveOrder, moveVisibleKey, dropKey, DEFAULT_ORDER, cpuSourceNote, powerNote,
  cpuDiagText, idracStateBanner, loadStyles, saveStyles, setStyle, isDefaultStyles, normalizeStyles, dashArrayOf, DASHES, WIDTHS, stylesQuery,
  gpuCardsText, TREND_HANDOFF, parseTrendHandoff, linkBasisText,
  CHART_SERIES, hostCpuNote, shownSeriesOf, hostGpuEmptyText, hostGpuNote, loadCpuRef, saveCpuRef, showCpuRef, presetSpanOf, maxBackOf, scrollWindow, scrollLabel,
} from './idracTrendText.js';

const tipStyle = { background: '#0c1322', border: '1px solid #243049', borderRadius: 8, color: '#e6edf6', fontSize: 12 };
const ALL_ON = Object.fromEntries(CHART_SERIES.map((s) => [s.k, true]));
const store = () => { try { return window.localStorage; } catch { return null; } };
const errText = (e) => e?.message || String(e);
/** 선 모양 견본(카드·설정 공용) — 차트와 같은 dasharray·굵기로 그린다. */
function LineSwatch({ color, st, w = 22 }) {
  return (
    <svg width={w} height={10} style={{ display: 'block', flexShrink: 0 }} aria-hidden="true">
      <line x1={1} y1={5} x2={w - 1} y2={5} stroke={color} strokeWidth={st?.width || 2} strokeDasharray={dashArrayOf(st?.dash)} strokeLinecap="butt" />
      {st?.dot && <circle cx={w / 2} cy={5} r={2.5} fill={color} />}
    </svg>
  );
}
const pill = { fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', padding: '3px 10px', borderRadius: 999, color: '#7dd3fc', background: 'rgba(56,189,248,.12)', border: '1px solid rgba(56,189,248,.45)', lineHeight: 1.4 };

export default function IdracTrendTool() {
  const [list, setList] = useState(null);         // /admin/idrac/trend/servers
  const [listErr, setListErr] = useState(null);
  const [corp, setCorp] = useState(null);
  const [site, setSite] = useState(null);
  const [serverId, setServerId] = useState('');
  const [range, setRange] = useState('24h');
  const [custom, setCustom] = useState(null);      // { start, end } ms
  const [customOpen, setCustomOpen] = useState(false);
  const [draft, setDraft] = useState(() => ({ start: toLocalInput(Date.now() - 7 * DAY), end: toLocalInput(Date.now()) }));
  const [rangeErr, setRangeErr] = useState(null);
  const [on, setOn] = useState(ALL_ON);
  const [modal, setModal] = useState(null);        // 'host' | 'idrac' | 'csv' | 'xlsx'
  const [view, setView] = useState('chart');       // v2.663: 'chart'(서버 추이) | 'table'(서버 표 · 조건 검색)
  const [order, setOrder] = useState(() => loadOrder(store()));   // v2.661: 카드 순서(브라우저 저장)
  const [arrange, setArrange] = useState(false);                   // 순서 편집 모드(◀ ▶ 버튼)
  const [dragK, setDragK] = useState(null);
  const applyOrder = (next) => { setOrder(next); saveOrder(store(), next); };
  const [styles, setStyles] = useState(() => loadStyles(store()));  // v2.662: 계열별 선 모양(브라우저 저장)
  const [styling, setStyling] = useState(false);
  const applyStyles = (next) => { setStyles(next); saveStyles(store(), next); };
  const [refOn, setRefOn] = useState(() => loadCpuRef(store()));   // v2.666: CPU 75/90 기준선 표시(브라우저 저장)
  const applyRefOn = (v) => { setRefOn(v); saveCpuRef(store(), v); };
  const [back, setBack] = useState(0);             // v2.666: 과거로 몇 칸(0 = 최근 구간 · 폴링)
  const [dragBack, setDragBack] = useState(null);  // 슬라이더를 끄는 중인 값(놓을 때만 조회)
  const [anchor, setAnchor] = useState(null);      // 스크롤을 시작한 순간의 끝 시각(칸 경계가 폴링 사이에 밀리지 않게)

  useEffect(() => {
    let alive = true;
    fetchJson('/admin/idrac/trend/servers').then((d) => { if (alive) { setList(d); setListErr(null); } })
      .catch((e) => { if (alive) setListErr(e); });
    return () => { alive = false; };
  }, []);

  const [tf, setTf] = useState(EMPTY_TYPE); // v2.687: 서버 종류(구성 GPU·CPU × 형태 가상화·베어메탈) — v2.661 'GPU 온도 있는 서버만' 을 넓혔다
  // v2.676: 호스트 상세 '통합 성능 모니터링' 에서 넘어온 서버(메모리 인계 — URL 에 싣지 않는다). 목록이 오면 그 서버를 고른다.
  const [handoff, setHandoff] = useState(() => parseTrendHandoff(takeSearch(TREND_HANDOFF)));
  const [linked, setLinked] = useState(null);       // 적용된 인계(안내 줄) · 목록에 없으면 { missing:true }
  useEffect(() => onSearchHandoff((t) => { if (t === TREND_HANDOFF) setHandoff(parseTrendHandoff(takeSearch(TREND_HANDOFF))); }), []);
  const allServers = useMemo(() => list?.servers || [], [list]);
  const servers = useMemo(() => filterByType(allServers, tf), [allServers, tf]);
  const typeOn = !!(tf.gpu || tf.kind);
  const corps = useMemo(() => corpsOf(servers), [servers]);
  const sites = useMemo(() => (corp == null ? [] : sitesOf(servers, corp)), [servers, corp]);
  const sitesFor = useCallback((c) => sitesOf(servers, c), [servers]);
  const inSite = useMemo(() => (corp == null || site == null ? [] : serversOf(servers, corp, site)), [servers, corp, site]);
  // 법인 → 첫 서비스 → 첫 서버(상위를 바꾸면 하위를 첫 항목으로).
  useEffect(() => { if (corps.length && !corps.some((c) => c.value === corp)) setCorp(corps[0].value); }, [corps, corp]);
  useEffect(() => { if (sites.length && !sites.some((s) => s.value === site)) setSite(sites[0].value); }, [sites, site]);
  useEffect(() => { if (!inSite.some((s) => s.id === serverId)) setServerId(inSite[0]?.id || ''); }, [inSite, serverId]);

  useEffect(() => {
    if (!handoff || !list) return;
    const row = (list.servers || []).find((x) => x.id === handoff.id);
    if (row) {
      if (!matchType(row, tf)) setTf(EMPTY_TYPE);
      setCorp(row.corp); setSite(row.site); setServerId(row.id); setView('chart');
      setLinked({ ...handoff, missing: false });
    } else setLinked({ ...handoff, missing: true });
    setHandoff(null);
  }, [handoff, list, tf]);

  // v2.666: 서버·기간을 바꾸면 스크롤을 최근으로 되돌린다.
  useEffect(() => { setBack(0); setDragBack(null); setAnchor(null); }, [range, serverId]);
  const presetSpan = range === 'custom' ? null : presetSpanOf(range);
  const scrolled = !!presetSpan && back > 0 && anchor != null;
  const q = range === 'custom' && custom ? { start: custom.start, end: custom.end }
    : scrolled ? (({ start, end }) => ({ start, end }))(scrollWindow(presetSpan, back, anchor)) : { range };
  // 폴링은 공용 usePolling(v2.613 WEB2613-09) — 1시간 범위만 30초 자동 갱신, 그 밖은 사실상 수동(6시간).
  //   파라미터(서버·기간)가 바뀌면 직전 데이터를 비운다(다른 서버의 추이를 새 선택처럼 보이지 않게 — 포탈 규약).
  const { data, error: err } = usePolling(serverId ? `/admin/idrac/${encodeURIComponent(serverId)}/trend` : null, q, range === '1h' && !scrolled ? 30_000 : 6 * 3_600_000);

  if (listErr && !list) return <ErrorBox error={listErr} />;
  if (!list) return <Loading label="iDRAC 서버" />;
  if (!allServers.length) {
    return <div className="card muted">{list.scoped ? `범위 안에 보이는 iDRAC 서버가 없습니다(범위 밖 ${list.omittedOutOfScope || 0}대 제외).` : '등록된 iDRAC 서버가 없습니다 — 서버 분석에서 iDRAC 을 등록하거나 스캔하세요.'}</div>;
  }

  const pts = data?.points || [];
  const span = data ? data.end - data.start : DAY;
  const st = Object.fromEntries(CHART_SERIES.map((s) => [s.k, statsOf(pts, s.k)]));
  const shownSeries = shownSeriesOf(data); // ESXi CPU·GPU 는 매칭된 가상화 서버에만(GPU 는 GPU 가 없다고 확인되면 숨김)
  // v2.680(D-08): 보이는 카드 목록 — ◀ ▶ 의 끝 판정과 이동은 이 목록 기준이다(숨은 계열과 자리를 바꾸지 않는다).
  const visibleCards = order.map((k) => shownSeries.find((x) => x.k === k)).filter(Boolean);
  const srv = servers.find((s) => s.id === serverId);
  const esxi = data?.kind === 'esxi';
  const toggle = (k) => { if (st[k]) setOn((o) => ({ ...o, [k]: !o[k] })); };
  const keep = data?.retentionDays || list.retentionDays || 365;
  const applyCustom = () => {
    const a = new Date(draft.start).getTime(), b = new Date(draft.end).getTime();
    const e = customRangeError(a, b, { retentionDays: keep });
    setRangeErr(e); if (!e) { setCustom({ start: a, end: b }); setRange('custom'); }
  };
  const sel = (label, value, onChange, opts, minWidth) => (
    <label className="flex" style={{ alignItems: 'center', gap: 6, fontSize: 13 }}>
      <span className="muted" style={{ whiteSpace: 'nowrap' }}>{label}</span>
      <select className="select" style={{ minWidth: minWidth || 0, maxWidth: '100%' }} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
  const empty = emptyNote(data);
  const gaps = data ? gapAreas(pts, data.firstTs) : [];
  const viewBtn = (k, label) => <button type="button" className={view === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '5px 14px', marginTop: 0 }} aria-pressed={view === k} onClick={() => setView(k)}>{label}</button>;
  const gpuBox = <IdracTypeBar servers={allServers} value={tf} onChange={setTf} />;
  const viewBar = <div className="flex wrap" style={{ gap: 6, marginBottom: 12 }} role="group" aria-label="보기">{viewBtn('chart', '📈 서버 추이')}{viewBtn('table', '📋 서버 표 · 조건 검색')}</div>;
  if (view === 'table') {
    return (
      <>
        {viewBar}
        <div className="flex wrap" style={{ gap: 12, marginBottom: 12, justifyContent: 'flex-end' }}>{gpuBox}</div>
        <IdracTrendTable corps={corps} sitesFor={sitesFor} initCorp={corp} initSite={site} typeFilter={tf}
          onOpen={(r) => { setCorp(r.corp); setSite(r.site); setServerId(r.id); setView('chart'); }} />
      </>
    );
  }

  return (
    <>
      {viewBar}
      <div className="flex wrap" style={{ gap: 12, marginBottom: 14, justifyContent: 'flex-end' }}>
        {sel('법인', corp, setCorp, corps)}
        {sel('서비스', site, setSite, sites.map((s) => ({ value: s.value, label: `${s.value} · ${s.n}대` })))}
        {sel('서버', serverId, setServerId, inSite.map((s) => ({ value: s.id, label: `${serverLabel(s)}${gpuStateOf(s) === 'gpu' ? ' · GPU' : ''}` })), 180)}
        {gpuBox}
      </div>
      {typeOn && !servers.length && <div className="banner" style={{ marginBottom: 10 }}>고른 종류({typeText(tf)})의 서버가 없습니다 — '전체' 를 누르면 전체 서버가 보입니다.</div>}
      {list.scoped && list.omittedOutOfScope > 0 && <div className="banner" style={{ marginBottom: 10 }}>범위 밖 서버 {list.omittedOutOfScope}대는 목록에서 뺐습니다.</div>}

      {/* KPI — 클릭 = 계열 켜기/끄기(별도 토글 행 없음). 값이 없는 계열은 클릭을 무시한다. */}
      <div className="idrac-trend-kpis">
        {visibleCards.map((s, idx) => {
          const x = st[s.k];
          const arrowBtn = (dir, label) => (
            <button type="button" className="tab" aria-label={`${s.label} ${dir < 0 ? '앞으로' : '뒤로'}`} disabled={dir < 0 ? idx === 0 : idx === visibleCards.length - 1}
              style={{ flex: 'none', padding: '1px 8px', marginTop: 0, fontSize: 12 }}
              onClick={(e) => { e.stopPropagation(); applyOrder(moveVisibleKey(order, visibleCards.map((c) => c.k), s.k, dir)); }}>{label}</button>
          );
          return (
            <div key={s.k} className="card" role="button" tabIndex={x ? 0 : -1} aria-pressed={!!on[s.k]}
              draggable onDragStart={(e) => { setDragK(s.k); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', s.k); } catch { /* */ } }}
              onDragOver={(e) => { if (dragK) e.preventDefault(); }} onDragEnd={() => setDragK(null)}
              onDrop={(e) => { e.preventDefault(); if (dragK) applyOrder(dropKey(order, dragK, s.k)); setDragK(null); }}
              title="누르면 계열을 켜고 끕니다 · 끌어서 위치를 바꿉니다"
              onClick={() => { if (!arrange) toggle(s.k); }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(s.k); } }}
              style={{ padding: '10px 14px', minWidth: 0, cursor: arrange ? 'grab' : x ? 'pointer' : 'default', opacity: dragK === s.k ? 0.4 : !x ? 0.55 : on[s.k] ? 1 : 0.5, userSelect: 'none', outline: arrange ? '1px dashed var(--border)' : undefined }}>
              <div className="flex" style={{ alignItems: 'center', gap: 8, minWidth: 0 }}>
                <LineSwatch color={s.color} st={styles[s.k]} />
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-dim)', letterSpacing: 0.5, minWidth: 0, wordBreak: 'keep-all', overflowWrap: 'anywhere' }}>{s.label}</span>
                {arrange
                  ? <span className="flex" style={{ marginLeft: 'auto', gap: 4 }}>{arrowBtn(-1, '◀')}{arrowBtn(1, '▶')}</span>
                  : <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>{x ? (on[s.k] ? '표시' : '숨김') : ''}</span>}
              </div>
              <div style={{ fontSize: 22, fontWeight: 800, marginTop: 5, color: s.color, fontVariantNumeric: 'tabular-nums', textAlign: 'center' }}>{x ? valueText(x.cur, s.unit) : '—'}</div>
              {x && staleCurText(x, data?.end, data?.bucketMs) && (
                <div style={{ fontSize: 11, marginTop: 2, color: 'var(--amber)', textAlign: 'center' }}
                  title="이 계열은 조회 기간 끝까지 값이 이어지지 않았습니다 — 큰 숫자는 지금 값이 아니라 기간 안 마지막 값입니다">{staleCurText(x, data?.end, data?.bucketMs)}</div>
              )}
              <div style={{ fontSize: 11, marginTop: 5, color: 'var(--text-faint)', textAlign: 'center', overflowWrap: 'anywhere' }}>
                {x ? `평균 ${valueText(x.avg, s.unit)} · 최대 ${valueText(x.max, s.unit)}` : s.k === 'gpuTemp' ? 'GPU 없음 — 센서 미보고' : s.k === 'cpuPct' ? '보고 없음 — 어느 경로로도 못 읽음' : s.k === 'powerW' && data?.power && !data.power.found ? '전력 보고 대기' : s.k === 'hostCpuPct' ? 'vCenter 값 없음 — v2.666 부터 쌓임' : s.gpu ? hostGpuEmptyText(data) : '보고 없음'}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex wrap" style={{ gap: 8, alignItems: 'center', margin: '-6px 0 12px', fontSize: 12 }}>
        <button type="button" className={arrange ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '4px 12px', marginTop: 0 }} onClick={() => setArrange((v) => !v)}>{arrange ? '✓ 순서 편집 끝' : '↔ 카드 순서 바꾸기'}</button>
        {arrange && <button type="button" className="tab" style={{ flex: 'none', padding: '4px 12px', marginTop: 0 }} disabled={order.join() === DEFAULT_ORDER.join()} onClick={() => applyOrder([...DEFAULT_ORDER])}>기본 순서</button>}
        <button type="button" className={styling ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '4px 12px', marginTop: 0 }} onClick={() => setStyling((v) => !v)}>{styling ? '✓ 선 모양 닫기' : '〰 선 모양'}</button>
        <button type="button" className={refOn ? 'login-btn' : 'tab'} aria-pressed={refOn} style={{ flex: 'none', padding: '4px 12px', marginTop: 0 }}
          title={`CPU 사용률 ${WARN_PCT}% 주의 · ${CRIT_PCT}% 위험 기준선을 차트에 그릴지 — 이 브라우저에 저장됩니다`}
          onClick={() => applyRefOn(!refOn)}>{refOn ? `📏 CPU 기준선(${WARN_PCT}·${CRIT_PCT}%) 켜짐` : `📏 CPU 기준선(${WARN_PCT}·${CRIT_PCT}%) 꺼짐`}</button>
        <span style={{ color: 'var(--text-faint)' }}>{arrange ? '◀ ▶ 로 옮기거나 카드를 끌어다 놓으세요 — 이 브라우저에 저장됩니다.' : '카드를 끌어다 놓아도 순서가 바뀝니다.'}</span>
      </div>
      {styling && (
        <div className="card idrac-trend-styles" style={{ padding: '12px 14px', marginBottom: 12, minWidth: 0 }}>
          <div className="flex wrap" style={{ alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <b style={{ fontSize: 13 }}>선 모양</b>
            <span className="muted" style={{ fontSize: 11 }}>계열마다 모양·굵기·점 표시를 고릅니다 — 이 브라우저에 저장되고 엑셀(차트) 내보내기에도 같이 들어갑니다.</span>
            <button type="button" className="tab" style={{ flex: 'none', padding: '3px 10px', marginTop: 0, marginLeft: 'auto' }} disabled={isDefaultStyles(styles)} onClick={() => applyStyles(normalizeStyles(null))}>기본 모양</button>
          </div>
          {shownSeries.map((s) => {
            const x = styles[s.k];
            return (
              <div key={s.k} className="flex wrap" style={{ alignItems: 'center', gap: 8, padding: '5px 0', borderTop: '1px solid var(--border)', minWidth: 0 }}>
                <span className="flex" style={{ alignItems: 'center', gap: 8, width: 150, minWidth: 0 }}>
                  <LineSwatch color={s.color} st={x} w={34} /><span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{s.label}</span>
                </span>
                <span className="flex wrap" style={{ gap: 4 }} role="group" aria-label={`${s.label} 선 모양`}>
                  {DASHES.map((d) => (
                    <button key={d.k} type="button" className={x.dash === d.k ? 'login-btn' : 'tab'} aria-pressed={x.dash === d.k}
                      style={{ flex: 'none', padding: '2px 9px', marginTop: 0, fontSize: 12 }} onClick={() => applyStyles(setStyle(styles, s.k, { dash: d.k }))}>{d.label}</button>
                  ))}
                </span>
                <label className="flex" style={{ alignItems: 'center', gap: 4, fontSize: 12 }}>
                  굵기
                  <select className="input" style={{ minWidth: 0, width: 64, padding: '2px 6px' }} value={x.width} onChange={(e) => applyStyles(setStyle(styles, s.k, { width: Number(e.target.value) }))}>
                    {WIDTHS.map((w) => <option key={w} value={w}>{w}px</option>)}
                  </select>
                </label>
                <label className="flex" style={{ alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
                  <input type="checkbox" checked={x.dot} onChange={(e) => applyStyles(setStyle(styles, s.k, { dot: e.target.checked }))} /> 점 표시
                </label>
              </div>
            );
          })}
        </div>
      )}

      {linked && ( // v2.676: 호스트 상세에서 연결한 근거(또는 목록에 없음)를 먼저 말한다.
        <div className="flex" role="status" style={{ alignItems: 'flex-start', gap: 8, padding: '8px 12px', marginBottom: 10, borderRadius: 8, fontSize: 12.5,
          border: `1px solid ${linked.missing ? 'var(--amber)' : 'rgba(56,189,248,.45)'}`, background: linked.missing ? 'rgba(245,158,11,.08)' : 'rgba(56,189,248,.08)' }}>
          <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
            {linked.missing ? `ESXi 호스트 ${linked.host} 에서 연결한 iDRAC 서버(${linked.id})가 이 화면 목록에 없습니다 — 범위 밖이거나 목록을 다시 받는 사이 등록이 바뀌었습니다.` : linkBasisText(linked)}
          </span>
          <button type="button" className="tab" style={{ flex: 'none', marginTop: 0, padding: '2px 8px' }} onClick={() => setLinked(null)} aria-label="안내 닫기">✕</button>
        </div>
      )}
      <div className="card" style={{ padding: '16px 18px', minWidth: 0 }}>
        <div className="flex wrap" style={{ alignItems: 'baseline', gap: 10, marginBottom: 10, minWidth: 0 }}>
          <b style={{ fontSize: 15, whiteSpace: 'nowrap' }}>🖥️ {srv?.name || serverId}</b>
          <span className="muted" style={{ fontSize: 12 }}>
            {[srv?.corpName, srv?.site].filter(Boolean).join(' › ')}{srv?.model ? ` · ${srv.model}` : ''}{data?.serviceTag ? ` · ${data.serviceTag}` : ''}
          </span>
          {data && <span className={`badge ${esxi ? 'blue' : 'teal'}`}>{esxi ? 'VM호스트 (ESXi)' : '베어메탈'}</span>}
          {(() => { // v2.676: GPU 카드 모델 · 장수(vCenter 먼저, 없으면 iDRAC 인벤토리). 두 출처가 다르면 ⚠ 와 툴팁.
            const g = gpuCardsText(data?.gpuCards);
            return g ? <span className="badge" title={g.title} style={{ whiteSpace: 'nowrap', background: 'rgba(168,85,247,.14)', color: '#d8b4fe', border: '1px solid rgba(168,85,247,.45)' }}>🎮 {g.text}{g.differ ? ' ⚠' : ''}<span style={{ opacity: 0.7, fontWeight: 400 }}> · {g.src}</span></span> : null;
          })()}
          {data?.remote && <span className="badge gray" title="엣지가 수집해 보낸 서버입니다">위임(엣지)</span>}
          {/* v2.661: 가상화 서버는 둘 다 본다 — ESXi 호스트(vCenter 관점) + iDRAC(하드웨어 관점). 베어메탈은 iDRAC 만. */}
          {data && esxi && data.host && <button type="button" style={pill} onClick={() => setModal('host')}>🖧 ESXi 호스트 상세 ›</button>}
          {data && <button type="button" style={pill} onClick={() => setModal('idrac')}>🖥 iDRAC 상세 / 센서 ›</button>}
          {data && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{kindBasisText(data)}</span>}
          {srv?.dcSource && DC_SOURCE_TEXT[srv.dcSource] && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{DC_SOURCE_TEXT[srv.dcSource]}</span>}
        </div>

        {(() => { // v2.665: iDRAC 표본이 멈췄으면 어디서 멈췄는지 먼저 말한다(차트만 보면 '그냥 끊겼다' 로 보인다).
          const b = idracStateBanner(data?.idracState);
          if (!b) return null;
          const c = b.tone === 'red' ? 'var(--red)' : 'var(--amber)';
          return (
            <div role="status" style={{ border: `1px solid ${c}`, borderLeft: `4px solid ${c}`, borderRadius: 8, padding: '8px 12px', marginBottom: 10, fontSize: 12.5, lineHeight: 1.6, minWidth: 0, overflowWrap: 'anywhere' }}>
              <b style={{ color: c }}>⚠ {b.title}</b>
              {b.lines.map((l, i) => <div key={i}><BoldText text={l} /></div>)}
            </div>
          );
        })()}

        <div className="flex wrap" style={{ gap: 6, alignItems: 'center', marginBottom: 10 }}>
          {PRESETS.map(([k, label]) => (
            <button key={k} type="button" className={range === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 13px', marginTop: 0 }} onClick={() => { setRange(k); setRangeErr(null); }}>{label}</button>
          ))}
          <button type="button" className={range === 'custom' ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 13px', marginTop: 0, borderColor: 'var(--border)' }} onClick={() => setCustomOpen((v) => !v)}>📅 기간 지정</button>
          {data && (
            <span className="muted" style={{ fontSize: 12, padding: '0 6px' }}>
              조회 기간 <b style={{ color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{periodText(data.start, data.end)}</b>
              <span style={{ color: 'var(--text-faint)', marginLeft: 8 }}>집계 {bucketLabel(data.bucketMs)} 평균 · 표본 {pts.length.toLocaleString()}개</span>
            </span>
          )}
          {canCsv() ? (
            <span className="flex" style={{ gap: 6, marginLeft: 'auto' }}>
              <button type="button" className="logout-btn" style={{ flex: 'none', padding: '7px 14px' }} disabled={!data} onClick={() => setModal('xlsx')}>📊 엑셀(차트) 내보내기</button>
              <button type="button" className="logout-btn" style={{ flex: 'none', padding: '7px 14px' }} disabled={!data} onClick={() => setModal('csv')}>⬇ CSV</button>
            </span>
          ) : <span className="muted" style={{ fontSize: 11, marginLeft: 'auto' }} title={CSV_DENIED_NOTE}>내보내기 권한 없음 — {CSV_DENIED_NOTE}</span>}
        </div>

        {(customOpen || range === 'custom') && (
          <div className="flex wrap" style={{ gap: 8, marginBottom: 10, alignItems: 'center', fontSize: 12 }}>
            <span className="muted">기간 지정</span>
            <input className="input" type="datetime-local" style={{ padding: '5px 8px', width: 'auto', minWidth: 0 }} value={draft.start}
              min={toLocalInput(Date.now() - keep * DAY)} max={toLocalInput(Date.now())} onChange={(e) => setDraft((d) => ({ ...d, start: e.target.value }))} />
            <span className="muted">~</span>
            <input className="input" type="datetime-local" style={{ padding: '5px 8px', width: 'auto', minWidth: 0 }} value={draft.end}
              min={toLocalInput(Date.now() - keep * DAY)} max={toLocalInput(Date.now())} onChange={(e) => setDraft((d) => ({ ...d, end: e.target.value }))} />
            <button type="button" className="tab" onClick={applyCustom}>적용</button>
            {range === 'custom' && <button type="button" className="tab" onClick={() => { setRange('24h'); setCustom(null); setCustomOpen(false); setRangeErr(null); }}>최근으로</button>}
            {range === 'custom' ? <span className="badge blue">기간 조회</span> : <span className="muted">최근 구간</span>}
            <span style={{ color: 'var(--text-faint)' }}>보관 {keep}일 · {ymd(Date.now() - keep * DAY)} 이후 조회 가능</span>
          </div>
        )}
        {rangeErr && <div className="banner warn" style={{ marginBottom: 10 }}>{rangeErr}</div>}
        {err && data && <div className="banner warn" style={{ marginBottom: 10 }}>다시 불러오지 못했습니다({errText(err)}) — 아래는 마지막으로 불러온 추이입니다.</div>}
        {data?.errors && <div className="banner warn" style={{ marginBottom: 10 }}>일부 계열을 읽지 못했습니다: {Object.keys(data.errors).join(', ')} — 그 계열은 비어 보입니다(0 이 아닙니다).</div>}
        {empty && <div className="banner" style={{ marginBottom: 10 }}>{empty}</div>}
        {data && powerNote(data) && <div className="banner" style={{ marginBottom: 10 }}>{powerNote(data)}</div>}

        <div style={{ height: 340, minWidth: 0 }}>
          {!data && !err && <Loading label="iDRAC 추이" />}
          {!data && err && <ErrorBox error={err} />}
          {data && (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={pts} margin={{ top: 16, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="idracPwrFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.35} /><stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#243049" />
                <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} scale="time" stroke="#8b9bb4" fontSize={11} minTickGap={40} tickFormatter={(t) => fmtTick(t, span)} />
                <YAxis yAxisId="pct" domain={[0, 100]} stroke="#8b9bb4" fontSize={11} width={40} />
                <YAxis yAxisId="w" orientation="right" domain={[0, pMaxOf(pts)]} stroke="#f59e0b" fontSize={11} width={56} unit=" W" />
                {gaps.map((g) => <ReferenceArea key={g.x1} yAxisId="pct" x1={g.x1} x2={g.x2} fill="rgba(139,155,180,.10)" strokeOpacity={0} label={{ value: 'iDRAC 무응답 — 값 없음', fill: '#8b9bb4', fontSize: 11, position: 'insideTop' }} />)}
                {showCpuRef(refOn, on, st) && <ReferenceLine yAxisId="pct" y={WARN_PCT} stroke="#f59e0b" strokeDasharray="5 4" label={{ value: `CPU ${WARN_PCT}% 주의`, fill: '#fbbf24', fontSize: 11, position: 'insideTopLeft' }} />}
                {showCpuRef(refOn, on, st) && <ReferenceLine yAxisId="pct" y={CRIT_PCT} stroke="#ef4444" strokeDasharray="5 4" label={{ value: `CPU ${CRIT_PCT}% 위험`, fill: '#f87171', fontSize: 11, position: 'insideTopLeft' }} />}
                <Tooltip contentStyle={tipStyle} labelStyle={{ color: '#8b9bb4' }}
                  labelFormatter={(t) => `${span >= DAY ? `${ymd(t)} ` : ''}${hm(t)}${data.bucketMs > 60_000 ? ` · ${bucketLabel(data.bucketMs)} 평균` : ''}`}
                  formatter={(v, name) => { const s = CHART_SERIES.find((x) => x.label === name); return [valueText(v, s?.unit || ''), name]; }} />
                {on.powerW && st.powerW && <Area yAxisId="w" type="monotone" dataKey="powerW" name="소비 전력" stroke="#f59e0b" strokeWidth={styles.powerW.width} strokeDasharray={dashArrayOf(styles.powerW.dash)} fill="url(#idracPwrFill)" dot={styles.powerW.dot ? { r: 2.5, fill: '#f59e0b', strokeWidth: 0 } : false} isAnimationActive={false} />}
                {shownSeries.filter((s) => s.axis === 'pct' && on[s.k] && st[s.k]).map((s) => (
                  <Line key={s.k} yAxisId="pct" type="monotone" dataKey={s.k} name={s.label} stroke={s.color} strokeWidth={styles[s.k].width} strokeDasharray={dashArrayOf(styles[s.k].dash)} dot={styles[s.k].dot ? { r: 2.5, fill: s.color, strokeWidth: 0 } : false} isAnimationActive={false} />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
        {presetSpan && (() => { // v2.666: 과거 구간 스크롤 — 같은 길이의 창을 한 칸씩 과거로(오른쪽 끝 = 최근).
          const maxB = maxBackOf(presetSpan, keep);
          if (!maxB) return null;
          const cur = dragBack ?? back;
          const go = (b) => {
            const nb = Math.max(0, Math.min(maxB, b));
            setDragBack(null);
            if (nb === 0) { setBack(0); setAnchor(null); return; }
            setAnchor((a) => (a == null ? (Number.isFinite(data?.end) && !data?.custom ? data.end : Date.now()) : a)); setBack(nb); // 지금 보이는 창의 끝에 이어 붙인다
          };
          const w = scrollWindow(presetSpan, cur, anchor ?? (Number.isFinite(data?.end) ? data.end : Date.now()), maxB);
          const lbl = (PRESETS.find(([k]) => k === range) || [])[1];
          return (
            <div className="idrac-trend-scroll" style={{ marginTop: 10, minWidth: 0 }}>
              <div className="flex" style={{ alignItems: 'center', gap: 8, minWidth: 0 }}>
                <button type="button" className="tab" style={{ flex: 'none', padding: '3px 10px', marginTop: 0 }} disabled={cur >= maxB} onClick={() => go(cur + 1)} aria-label={`${lbl} 이전`}>◀ 이전 {lbl}</button>
                <input type="range" min={0} max={maxB} step={1} value={maxB - cur} aria-label="조회 구간 스크롤(오른쪽 끝 = 최근)"
                  style={{ flex: '1 1 auto', minWidth: 0, accentColor: '#3b82f6' }}
                  onChange={(e) => setDragBack(maxB - Number(e.target.value))}
                  onPointerUp={(e) => go(maxB - Number(e.currentTarget.value))}
                  onKeyUp={(e) => go(maxB - Number(e.currentTarget.value))} />
                <button type="button" className="tab" style={{ flex: 'none', padding: '3px 10px', marginTop: 0 }} disabled={cur <= 0} onClick={() => go(cur - 1)} aria-label={`${lbl} 다음`}>다음 {lbl} ▶</button>
                <button type="button" className={cur === 0 ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '3px 10px', marginTop: 0 }} disabled={cur === 0} onClick={() => go(0)}>최신</button>
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 4, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
                {scrollLabel(cur, range)} · {periodText(w.start, w.end)}{cur > 0 ? ' · 과거 구간은 자동 갱신하지 않습니다' : ''}{dragBack != null ? ' · 놓으면 조회합니다' : ''}
              </div>
            </div>
          );
        })()}
        <div className="muted" style={{ fontSize: 11, marginTop: 12, lineHeight: 1.6 }}>
          왼쪽 축은 CPU 사용률(%) · CPU/GPU 온도(℃) 공통 0~100, 오른쪽 축은 소비 전력(W)입니다. 위 카드를 누르면 계열을 켜고 끕니다.<br />
          CPU 사용률은 iDRAC 에서 온 값만 씁니다 — 텔레메트리(Datacenter 라이선스) → Sensors 컬렉션의 CPU 센서 → 베어메탈 사용률의 iDRAC 대체 경로 순이고, vCenter·OS(SSH) 값은 쓰지 않습니다. {cpuSourceNote(data)} {cpuDiagText(data?.cpuDiag)}{' '}
          GPU 온도는 사용률이 아니라 GPU 가 동작하는지 가늠하는 근거입니다. 흡기는 서버가 빨아들이는 공기(전산실) 온도, 배기는 내보내는 공기 온도입니다.
          iDRAC 무응답 구간은 선을 끊고 0 으로 채우지 않습니다. {retentionNote(data)} 기간이 길면 집계 단위(5분 ~ 1일) 평균으로 표시합니다.
          {hostCpuNote(data) ? ` ${hostCpuNote(data)}` : ''}
          {hostGpuNote(data) ? ` ${hostGpuNote(data)}` : ''}
          {data?.firstTs ? ` 이 서버의 첫 적재는 ${ymd(data.firstTs)} ${hm(data.firstTs)} 입니다(그 이전은 비어 있습니다).` : ''}
        </div>
      </div>

      {modal === 'host' && data?.host && <HostDetailLoader host={data.host} onClose={() => setModal(null)} />}
      {modal === 'idrac' && srv && <IdracDetailModal server={{ id: srv.id, name: srv.name, remote: srv.remote, serviceTag: srv.serviceTag, datacenterId: srv.corp }} onClose={() => setModal(null)} />}
      {(modal === 'csv' || modal === 'xlsx') && (
        <CsvModal hasHost={!!data?.hostCpu} noGpu={data?.hostGpu?.hasGpu === false} fmt={modal} typeFilter={tf} styles={styles} serverId={serverId} serverName={srv?.name || serverId} corp={corp} site={site} siteCount={inSite.length}
          range={range} custom={custom} on={on} onClose={() => setModal(null)} />
      )}
    </>
  );
}

/** 서비스태그로 찾은 ESXi 호스트 → 기존 EntityDetail(host). 인벤토리 목록에서 같은 id 를 찾는다(없으면 이유를 말한다). */
function HostDetailLoader({ host, onClose }) {
  const [item, setItem] = useState(null); const [e, setE] = useState(null);
  useEffect(() => {
    let alive = true;
    fetchJson('/hosts', { vcenterId: host.vcenterId, q: host.name })
      .then((d) => {
        const rows = Array.isArray(d) ? d : (d?.items || d?.hosts || []);
        const hit = rows.find((h) => h.id === host.id) || rows.find((h) => h.name === host.name);
        if (!alive) return;
        if (hit) setItem(hit); else setE(new Error('인벤토리에서 이 호스트를 찾지 못했습니다(권한 범위 밖이거나 방금 사라졌습니다).'));
      })
      .catch((x) => { if (alive) setE(x); });
    return () => { alive = false; };
  }, [host.id, host.name, host.vcenterId]);
  if (e) return <Modal title="호스트 상세" onClose={onClose}><ErrorBox error={e} /></Modal>;
  if (!item) return <Modal title="호스트 상세" onClose={onClose}><Loading /></Modal>;
  return <EntityDetail type="host" item={item} onClose={onClose} />;
}

function CsvModal({ hasHost = false, noGpu = false, fmt = 'csv', typeFilter = EMPTY_TYPE, styles = null, serverId, serverName, corp, site, siteCount, range, custom, on, onClose }) {
  const [scope, setScope] = useState('server');
  const [r, setR] = useState(range === 'custom' && !custom ? '24h' : range);
  const [cols, setCols] = useState('all');
  const [busy, setBusy] = useState(false); const [e, setE] = useState(null);
  const keys = CHART_SERIES.filter((s) => scope === 'dc' || (!s.vc || (hasHost && !(s.gpu && noGpu)))).map((s) => s.k).filter((k) => cols === 'all' || on[k]);
  const opt = (cur, k) => (cur === k ? 'login-btn' : 'tab');
  const xlsx = fmt === 'xlsx';
  const go = async () => {
    setBusy(true); setE(null);
    const q = { scope, cols: keys.join(','), ...(scope === 'dc' ? { corp, site, ...typeQuery(typeFilter) } : { id: serverId }), ...(r === 'custom' && custom ? { start: custom.start, end: custom.end } : { range: r }), ...(xlsx && styles ? { styles: stylesQuery(styles, keys) } : {}) };
    const qs = new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)])).toString();
    try { await downloadFile(`/admin/idrac/trend/export.${xlsx ? 'xlsx' : 'csv'}?${qs}`); onClose(); } catch (x) { setE(x); } finally { setBusy(false); }
  };
  return (
    <Modal title={xlsx ? '📊 iDRAC 통합 추이 엑셀(차트) 내보내기' : '⬇ iDRAC 통합 추이 CSV 내보내기'} onClose={onClose} width={560}>
      <div className="muted" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>범위</div>
      <div className="flex" style={{ flexDirection: 'column', gap: 8, marginBottom: 14 }}>
        <button type="button" className={opt(scope, 'server')} style={{ textAlign: 'left', marginTop: 0 }} onClick={() => setScope('server')}>단일 서버 — {serverName}</button>
        <button type="button" className={opt(scope, 'dc')} style={{ textAlign: 'left', marginTop: 0 }} onClick={() => setScope('dc')}>서비스 전체 — {site} ({siteCount}대{typeText(typeFilter) ? ` · ${typeText(typeFilter)}` : ''})</button>
      </div>
      <div className="muted" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>기간</div>
      <div className="flex wrap" style={{ gap: 8, marginBottom: 14 }}>
        {PRESETS.map(([k, label]) => <button key={k} type="button" className={opt(r, k)} style={{ flex: 'none', padding: '7px 13px', marginTop: 0 }} onClick={() => setR(k)}>{label}</button>)}
        {custom && <button type="button" className={opt(r, 'custom')} style={{ flex: 'none', padding: '7px 13px', marginTop: 0 }} onClick={() => setR('custom')}>지정 기간 ({ymd(custom.start)} ~ {ymd(custom.end)})</button>}
      </div>
      <div className="muted" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>항목</div>
      <div className="flex wrap" style={{ gap: 8, marginBottom: 14 }}>
        <button type="button" className={opt(cols, 'all')} style={{ flex: 'none', padding: '7px 13px', marginTop: 0 }} onClick={() => setCols('all')}>전체 {CHART_SERIES.filter((s) => scope === 'dc' || (!s.vc || (hasHost && !(s.gpu && noGpu)))).length}개</button>
        <button type="button" className={opt(cols, 'shown')} style={{ flex: 'none', padding: '7px 13px', marginTop: 0 }} onClick={() => setCols('shown')}>표시 중인 항목만 ({Object.values(on).filter(Boolean).length}개)</button>
      </div>
      <div className="banner">
        {xlsx
          ? <>요약 시트 1장 + 서버마다 시트 1장(시각 + 측정 {keys.length}개 · 꺾은선 차트). 차트는 시트의 셀을 참조하므로 엑셀에서 값을 고치면 차트도 바뀝니다. 소비 전력은 오른쪽 보조 축입니다. 빈 칸은 선을 끊습니다(0 으로 채우지 않음).
            {scope === 'dc' && ' 서비스 전체는 서버 40대까지 담습니다 — 넘으면 요약 시트에 뺀 대수를 적습니다(더 많으면 CSV 를 쓰세요).'}</>
          : <>열: 법인 · 서비스 · 서버 · 서비스태그 · 유형 · 시각 + 측정 {keys.length}개. iDRAC 무응답 구간과 GPU 없는 서버의 GPU 온도는 빈 칸입니다(0 으로 채우지 않음). UTF-8 BOM 포함.
            {scope === 'dc' && ' 서비스 전체는 한 번에 300대까지 담고, 넘으면 뺀 대수를 응답 헤더에 밝힙니다.'}</>}
      </div>
      {!keys.length && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--amber)' }}>표시 중인 항목이 없습니다 — ‘전체’ 를 고르세요.</div>}
      {e && <div style={{ marginTop: 8 }}><ErrorBox error={e} /></div>}
      <div className="flex" style={{ gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
        <button type="button" className="tab" onClick={onClose}>취소</button>
        <button type="button" className="login-btn" style={{ flex: 'none', padding: '8px 16px', marginTop: 0 }} disabled={!keys.length || busy} onClick={go}>{busy ? '내보내는 중…' : xlsx ? '📊 엑셀 다운로드' : '⬇ CSV 다운로드'}</button>
      </div>
    </Modal>
  );
}
