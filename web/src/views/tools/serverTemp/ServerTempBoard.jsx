/**
 * ServerTempBoard.jsx — 특수 기능 › **서버 온도**(시안 B: 히트맵 보드, v2.556).
 *
 * 핸드오프: `docs/design/server-temp/README.md`(+ `server-temp.dc.html` 은 대조용 프로토타입).
 * 표 나열 → 상태 보드로 바꾼다. 위→아래: 툴바 · 경고 · KPI/분포 · 법인 비교/이상 서버 ·
 * 히트맵 · 표(+푸터). **기존 기능은 모두 유지**한다 — 하위 탭 4개(URL 해시), 물리/가상화 필터,
 * 경고 카드 3종, 5년 추이 모달(기간·집계 단위 버튼).
 *
 * 지킬 것(이 화면이 만들 수 있는 거짓을 막는 것들):
 *  · 계산은 `board.js`(순수·vitest 29건)가 소유한다. 여기서 수식을 다시 쓰지 말 것 —
 *    KPI 개수와 히스토그램 임계선이 다른 기준을 쓰게 된다.
 *  · **훅은 전부 조기 return 위**에 선언한다(React #310 — v2.202 에 이 저장소가 화면 전체
 *    크래시를 겪었다).
 *  · 주기·상한 **숫자를 문구에 박지 않는다** — `avgWindowLabel`·`maxItems` 등 API 값을 쓴다.
 *  · 값이 없는 것을 0 이나 합성값으로 채우지 않는다. mock 합성은 응답의 `synthesized` 로 밝힌다.
 *  · 스파크라인은 **계열 이름을 정직하게** 붙인다 — 표의 '현재온도'(흡기)와 24시간 추이(기본
 *    설정에서는 최고 센서)가 다른 계열일 수 있다(`tools/serverTemp.js sparkMetricFor` 주석).
 *  · 범위(vCenter) select 를 여기서 그리지 않는다 — 도구 패널 헤더가 이미 `scope` 를 소유한다.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useHashTab } from '../../../hooks/useHashTab.js';
import { fetchJson } from '../../../api.js';
import { DataTable, Loading, ErrorBox, Modal } from '../../../components/ui.jsx';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Brush } from 'recharts';
import { fmtTrendTick, tempColor, useTool } from '../shared.jsx';
import { sparkProgressText, sparkCapText, SPARK_ROW_CAP } from '../sparkBatch.js';
import {
  TEMP_WARN_C, TEMP_HOT_C, tempNum, tempCounts, hotList, compareRows, rowTint, dcKeyOf,
  loadDensity, saveDensity, densityMetrics,
} from './board.js';
import {
  MonoLabel, Segment, DensityToggle, Section, TempHistogram, DcCompare, HotList, TempHeatmap,
  HeatLegend, HeatCell, PeakCell, TempSpark,
} from './parts.jsx';
import { useTempSparklines } from './useTempSparklines.js';

const KIND_KO = { physical: '물리', virtual: '가상화' };
const VIEWS = [['server', '서버별'], ['host', 'ESXi 호스트별'], ['cluster', '클러스터별'], ['vc', '법인별']];
const VIEW_TITLE = { server: '서버별', host: 'ESXi 호스트별', cluster: '클러스터별', vc: '법인별' };
const HEAT_TITLE = { server: '서버 히트맵', host: 'ESXi 호스트 히트맵', cluster: '클러스터 히트맵', vc: '법인 히트맵' };
const n1 = (v) => { const n = tempNum(v); return n == null ? '—' : n.toFixed(1); };
const nRaw = (v) => { const n = tempNum(v); return n == null ? '—' : String(n); };
const int = (v) => Number(v || 0).toLocaleString();

export default function ServerTempBoard({ scope }) {
  /* ── 훅(전부 조기 return 위) ─────────────────────────────────────────────── */
  const { loading, data, error } = useTool('/tools/esxi-temp', scope ? { vcenterId: scope } : {});
  const [view, setView] = useHashTab({ base: ['tools', 'esxitemp'], valid: ['server', 'host', 'cluster', 'vc'], fallback: 'server' });
  const [kindF, setKindF] = useState('all');
  const [sel, setSel] = useState(null);               // 선택 법인 key
  const [dense, setDense] = useState(loadDensity);
  const [limit, setLimit] = useState(25);
  const [visible, setVisible] = useState([]);         // 표에 실제로 그려진 행(스파크 조회 대상)
  const [hist, setHist] = useState(null);
  const [days, setDays] = useState(7);
  const [bucket, setBucket] = useState('auto');
  const histGen = useRef(0);
  const [at, setAt] = useState(null);                 // 응답 수신 시각(서버가 안 주면 이것을 쓴다)

  useEffect(() => { if (!loading && !error) setAt(Date.now()); }, [loading, error, data]);
  // 뷰가 바뀌면 정렬·상한·구분 필터를 초기화한다(README §Interactions).
  useEffect(() => { setLimit(25); setVisible([]); }, [view, kindF, sel]);

  /*
   * ⚠ `data?.idrac || {…}` 를 렌더마다 새로 만들면 아래 useMemo 들의 의존이 **매 렌더 바뀌어**
   *   1,157행 집계(버킷·비교·히트맵)가 전부 다시 돈다 — 메모가 무의미해진다. 한 번에 memo 해
   *   참조를 고정한다(빈 배열도 같은 참조를 쓴다).
   */
  const EMPTY = useMemo(() => [], []);
  const idrac = useMemo(
    () => data?.idrac || { rows: EMPTY, summary: null, byDatacenter: EMPTY, counts: null, reason: '' },
    [data, EMPTY],
  );
  const S = idrac.summary || {};
  const srvAll = idrac.rows || EMPTY;
  const hosts = data?.hosts || EMPTY;
  const clusters = data?.clusters || EMPTY;
  const vcenters = data?.vcenters || EMPTY;
  const avgLabel = `${data?.avgWindowLabel || '5분'} 평균 ℃`;

  const selName = useMemo(
    () => (sel ? ((idrac.byDatacenter || []).find((d) => d.key === sel)?.name || sel) : ''),
    [sel, idrac.byDatacenter],
  );
  // 구분 필터만 적용(KPI·분포·비교는 **전체 기준을 유지**한다 — 기존 코드와 같은 규약).
  const srvKind = useMemo(() => (kindF === 'all' ? srvAll : srvAll.filter((r) => r.kind === kindF)), [srvAll, kindF]);
  // 법인 선택까지 적용(히트맵·표만).
  const srvRows = useMemo(() => (sel ? srvKind.filter((r) => dcKeyOf(r) === sel) : srvKind), [srvKind, sel]);
  const counts = useMemo(() => tempCounts(srvAll), [srvAll]);
  const hot = useMemo(() => hotList(srvAll), [srvAll]);
  const cmp = useMemo(() => compareRows(idrac.byDatacenter || [], srvAll), [idrac.byDatacenter, srvAll]);
  const regionById = useMemo(() => new Map(vcenters.map((v) => [v.key, v.region || ''])), [vcenters]);

  /* 표 행 — 뷰별. 법인 선택은 여기서도 적용한다. */
  const tableRows = useMemo(() => {
    if (view === 'server') {
      return srvRows.map((r) => ({
        key: r.id, name: r.name, kind: r.kind, source: r.source, stale: r.stale,
        dc: r.datacenterId || r.vcenterId || '', cluster: r.cluster || '',
        curC: r.curC, inletC: r.inletC, exhaustC: r.exhaustC, cpuC: r.cpuC, maxC: r.maxC,
        // 추이 모달(5년)은 ESXi 계열(temp_host)에만 있다 — iDRAC 행은 이름이 링크가 아니다.
        level: r.source === 'esxi' ? 'host' : null,
        sparkSource: r.source,
      }));
    }
    if (view === 'host') {
      return hosts
        .filter((h) => !sel || h.vcenterId === sel)
        .map((h) => ({
          key: h.id, name: h.name, dc: h.vcenterId || '', cluster: h.cluster || '',
          curC: h.curC, avg5C: h.avg5C, maxC: h.tempMaxC, level: 'host', sparkSource: 'host',
        }));
    }
    const list = view === 'cluster' ? clusters : vcenters;
    return list
      .filter((g) => !sel || (view === 'cluster' ? String(g.key).split('|')[0] === sel : g.key === sel))
      .map((g) => ({
        key: g.key, name: String(g.key).replace('|', ' / '), hosts: g.hosts,
        curC: g.curC, avg5C: g.avg5C, maxC: g.maxC,
        level: view === 'cluster' ? 'cluster' : 'vc', sparkSource: view,
      }));
  }, [view, srvRows, hosts, clusters, vcenters, sel]);

  /* 24시간 추이 — **표에 보이는 행 + 이상 서버 목록**만 묻는다(순차 배치). */
  const sparkItems = useMemo(() => {
    const seen = new Set();
    const out = [];
    const push = (key, source) => { const k = `${source}:${key}`; if (key && !seen.has(k)) { seen.add(k); out.push({ key, source }); } };
    for (const r of visible) push(r.key, r.sparkSource || view);
    if (view === 'server') for (const r of hot.slice(0, 40)) push(r.id, r.source);
    return out;
  }, [visible, hot, view]);
  const spark = useTempSparklines(sparkItems, !loading && !error);

  const openHist = async (level, key) => {
    const gen = ++histGen.current;
    setHist({ level, key, loading: true });
    const bq = bucket && bucket !== 'auto' ? `&bucket=${bucket}` : '';
    const r = await fetchJson(`/tools/esxi-temp/history?level=${level}&key=${encodeURIComponent(key)}&days=${days}${bq}`).catch(() => null);
    if (gen !== histGen.current) return;
    setHist(r ? { ...r } : { error: true });
  };
  const closeHist = () => { histGen.current++; setHist(null); };
  // 기간·집계 단위를 바꾸면 열려 있는 모달을 다시 조회한다(기존 동작). hist/openHist 를 의존에
  // 넣으면 조회 → setHist → 조회 무한 루프가 된다 — 그래서 의존은 [days, bucket] 뿐이다.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (hist && hist.key) openHist(hist.level, hist.key); }, [days, bucket]);

  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;

  /* ── 파생(렌더 시점) ───────────────────────────────────────────────────── */
  const M = densityMetrics(dense);
  const pickDc = (key) => { setSel((s) => (s === key ? null : key)); setLimit(25); };
  const onDense = (v) => { setDense(v); saveDensity(v); };
  const sampledAt = new Date(data.generatedAt || at || Date.now()).toLocaleTimeString('ko-KR');

  const heatGroups = (() => {
    const order = cmp.map((d) => d.key).filter((k) => !sel || k === sel);
    const nameOf = (k) => (idrac.byDatacenter || []).find((d) => d.key === k)?.name || k;
    if (view === 'server') {
      return order.map((k) => ({
        key: k, name: nameOf(k), items: srvKind.filter((r) => dcKeyOf(r) === k),
        valOf: (r) => r.curC, idOf: (r) => r.id,
        titleOf: (r) => `${r.name} · ${KIND_KO[r.kind] || '?'} · ${nRaw(r.curC)}℃`,
      })).filter((g) => g.items.length);
    }
    if (view === 'host') {
      return order.map((k) => ({
        key: k, name: nameOf(k), items: hosts.filter((h) => h.vcenterId === k),
        valOf: (h) => h.curC, idOf: (h) => h.id,
        titleOf: (h) => `${h.name} · ${h.cluster || '클러스터 없음'} · ${nRaw(h.curC)}℃`,
      })).filter((g) => g.items.length);
    }
    if (view === 'cluster') {
      return order.map((k) => ({
        key: k, name: nameOf(k), items: clusters.filter((c) => String(c.key).split('|')[0] === k),
        valOf: (c) => c.curC, idOf: (c) => c.key,
        titleOf: (c) => `${String(c.key).replace('|', ' / ')} · 호스트 ${c.hosts} · ${nRaw(c.curC)}℃`,
      })).filter((g) => g.items.length);
    }
    return [{
      key: null, name: '전체 법인', items: vcenters.filter((v) => !sel || v.key === sel),
      valOf: (v) => v.curC, idOf: (v) => v.key,
      titleOf: (v) => `${v.key} · 호스트 ${v.hosts} · ${nRaw(v.curC)}℃`,
    }].filter((g) => g.items.length);
  })();

  const heatSub = view === 'server'
    ? `타일 1개 = 서버 1대 · 법인별 · 더운 순 · ${int(srvRows.length)}대`
    : view === 'host' ? `타일 1개 = 호스트 1대 · 법인별 · ${int(tableRows.length)}대`
      : view === 'cluster' ? `타일 1개 = 클러스터 · ${int(tableRows.length)}개`
        : `타일 1개 = 법인(vCenter) · ${int(tableRows.length)}개`;

  const sparkCell = (r) => (
    <TempSpark points={spark.map[r.key]} requested={spark.asked.has(r.key)} curC={r.curC} metric={spark.metric[r.key]} />
  );
  const nameCell = (r) => (r.level
    ? <button className="cell-link" onClick={() => openHist(r.level, r.key)} title="5년 추이 보기">{r.name}</button>
    : <span>{r.name}</span>);
  const dim = (t) => <span className="muted" style={{ fontSize: 12 }}>{t || '—'}</span>;

  const columns = view === 'server' ? [
    { key: 'name', label: '서버', render: nameCell },
    { key: 'kind', label: '구분', render: (r) => <span className={`badge ${r.kind === 'physical' ? 'amber' : 'green'}`}>{KIND_KO[r.kind]}</span> },
    { key: 'source', label: '출처', render: (r) => dim(`${r.source === 'idrac' ? 'iDRAC' : 'ESXi'}${r.stale ? ' · 오래됨' : ''}`) },
    { key: 'dc', label: '법인', render: (r) => dim(r.dc) },
    { key: 'cluster', label: '클러스터', render: (r) => dim(r.cluster) },
    { key: 'curC', label: '현재온도 ℃', align: 'right', render: (r) => <HeatCell v={r.curC} bold dense={dense} /> },
    { key: 'inletC', label: '흡기 ℃', align: 'right', render: (r) => <HeatCell v={r.inletC} dense={dense} /> },
    { key: 'exhaustC', label: '배기 ℃', align: 'right', render: (r) => <HeatCell v={r.exhaustC} dense={dense} /> },
    { key: 'cpuC', label: 'CPU ℃', align: 'right', render: (r) => <HeatCell v={r.cpuC} dense={dense} /> },
    { key: 'maxC', label: '최고 ℃', align: 'right', render: (r) => <PeakCell v={r.maxC} /> },
    { key: 'spark', label: '24시간 추이', align: 'right', sortValue: (r) => r.curC, render: sparkCell },
  ] : view === 'host' ? [
    { key: 'name', label: '호스트', render: nameCell },
    { key: 'dc', label: '법인', render: (r) => dim(r.dc) },
    { key: 'cluster', label: '클러스터', render: (r) => dim(r.cluster) },
    { key: 'curC', label: '현재온도 ℃', align: 'right', render: (r) => <HeatCell v={r.curC} bold dense={dense} /> },
    { key: 'avg5C', label: avgLabel, align: 'right', render: (r) => <HeatCell v={r.avg5C} dense={dense} /> },
    { key: 'maxC', label: '최대 온도 ℃', align: 'right', render: (r) => <PeakCell v={r.maxC} /> },
    { key: 'spark', label: '24시간 추이', align: 'right', sortValue: (r) => r.curC, render: sparkCell },
  ] : [
    { key: 'name', label: view === 'cluster' ? '클러스터' : '법인', render: nameCell },
    { key: 'hosts', label: '호스트 수', align: 'right' },
    { key: 'curC', label: '현재온도 ℃', align: 'right', render: (r) => <HeatCell v={r.curC} bold dense={dense} /> },
    { key: 'avg5C', label: avgLabel, align: 'right', render: (r) => <HeatCell v={r.avg5C} dense={dense} /> },
    { key: 'maxC', label: '최대 온도 ℃', align: 'right', render: (r) => <PeakCell v={r.maxC} /> },
    { key: 'spark', label: '24시간 추이', align: 'right', sortValue: (r) => r.curC, render: sparkCell },
  ];

  const progress = sparkProgressText(spark.progress);
  const capNote = sparkCapText(spark.totalRows, SPARK_ROW_CAP);
  const tableFooter = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '8px 16px', borderTop: '1px solid var(--border-soft)', fontSize: 11.5, color: 'var(--text-faint)' }}>
      <div>
        현재온도 = iDRAC 흡기 센서 · 최고 = 전체 센서 최댓값 · 열 제목을 누르면 정렬
        {progress && <div>※ {progress}</div>}
        {capNote && <div>※ {capNote}</div>}
        {spark.info?.synthesized && <div>※ 24시간 추이는 데모 합성값입니다(실제 수집 데이터가 아닙니다).</div>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span>{tableRows.length > limit ? `${int(tableRows.length)}행 중 ${int(limit)}행 표시` : `${int(tableRows.length)}행`}</span>
        {tableRows.length > limit && (
          <button onClick={() => setLimit((v) => v + 25)}
            style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--panel-deep)', color: '#bfdbfe', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>25행 더 보기</button>
        )}
      </div>
    </div>
  );

  return (
    // ⚠ minWidth:0 — 안쪽 표가 이 컨테이너를 밀어 늘리지 못하게(위 Section 주석과 같은 이유).
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
      {/* 1. 툴바 */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap',
        padding: '12px 16px', borderRadius: 12, border: '1px solid var(--border)', borderLeft: '2px solid var(--teal)',
        background: 'linear-gradient(180deg, rgba(20,27,45,.9), rgba(13,20,28,.85))',
      }}>
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 12 }}>
          <Segment items={VIEWS} value={view} onPick={setView} />
        </div>
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 12 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--text-faint)', display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--teal)', boxShadow: '0 0 8px var(--teal)', animation: 'pulse 2.4s infinite' }} />
            Sampling {data.avgWindowLabel || '5분'} · <b style={{ color: 'var(--text)', fontWeight: 700 }}>{sampledAt}</b>
          </div>
          <DensityToggle dense={dense} onChange={onDense} />
        </div>
      </div>

      {/* 경고 카드(기존 3종) — 툴바 아래, KPI 위 */}
      {idrac.reason && <div className="card" style={{ borderColor: 'var(--amber)' }}><span className="muted">{idrac.reason} ESXi 센서 값으로 대체 표시합니다.</span></div>}
      {data.avgError && <div className="card" style={{ borderColor: 'var(--amber)' }}><span className="muted">평균 온도 이력을 읽지 못했습니다: {data.avgError}</span></div>}
      {data.reportingHosts === 0 && (idrac.counts?.idrac ?? 0) === 0 && (
        <div className="card" style={{ borderColor: 'var(--amber)' }}><span className="muted">온도 센서를 보고하는 서버가 없습니다(iDRAC 미등록이거나 하드웨어/CIM 미지원·nested ESXi). 라이브 수집 시 표시됩니다.</span></div>
      )}
      {idrac.synthesized && <div className="card" style={{ borderColor: 'var(--amber)' }}><span className="muted">데모(mock) 환경입니다 — iDRAC 서버 온도는 합성값입니다.</span></div>}

      {/* 2. KPI + 분포 */}
      <div className="st-kpis">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div className="card" style={{ gridColumn: '1 / -1', padding: '14px 16px', display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <MonoLabel>온도 수집 서버</MonoLabel>
              <div style={{ fontSize: 34, fontWeight: 800, lineHeight: 1, letterSpacing: -1, marginTop: 8, fontVariantNumeric: 'tabular-nums' }}>{int(S.all?.reporting)}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-faint)', marginTop: 6 }}>
                iDRAC {int(idrac.counts?.idrac)} · ESXi {int(idrac.counts?.esxi)}
              </div>
            </div>
            <div style={{ minWidth: 96, fontSize: 11.5, display: 'flex', flexDirection: 'column', gap: 3 }}>
              {[['정상', counts.ok, 'var(--green)', 'var(--text)'],
                [`${TEMP_WARN_C}℃↑`, counts.warm, 'var(--amber)', '#fbbf24'],
                [`${TEMP_HOT_C}℃↑`, counts.hot, 'var(--red)', '#f87171']].map(([l, v, sq, col]) => (
                  <div key={l} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-dim)' }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: sq }} />{l}
                    </span>
                    <b style={{ color: col, fontVariantNumeric: 'tabular-nums' }}>{int(v)}</b>
                  </div>
                ))}
              {counts.unknown > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, color: 'var(--text-faint)' }}
                  title="온도를 읽지 못한 서버입니다. 정상이라는 뜻도, 이상이라는 뜻도 아닙니다.">
                  <span>미확인</span><b style={{ fontVariantNumeric: 'tabular-nums' }}>{int(counts.unknown)}</b>
                </div>
              )}
            </div>
          </div>
          {[['물리 평균', S.physical, 'var(--amber)', '#fbbf24'], ['가상화 평균', S.virtual, 'var(--green)', '#4ade80']].map(([label, g, line, col]) => (
            <div key={label} className="card" style={{ padding: '12px 14px', borderTop: `2px solid ${line}` }}>
              <MonoLabel>{label}</MonoLabel>
              <div style={{ marginTop: 6 }}>
                <span style={{ fontSize: 24, fontWeight: 800, color: col, fontVariantNumeric: 'tabular-nums' }}>{n1(g?.avgC)}</span>
                <span style={{ fontSize: 12, color: 'var(--text-dim)', fontWeight: 600, marginLeft: 3 }}>℃</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 4 }}>{int(g?.servers)}대 · 최고 {nRaw(g?.maxC)}℃</div>
            </div>
          ))}
        </div>
        <TempHistogram rows={srvAll} total={srvAll.length} maxC={S.all?.maxC} avgInletC={S.all?.avgInletC} />
      </div>

      {/* 3. 법인 비교 + 이상 서버 */}
      <div className="st-mid">
        <Section title="법인 비교"
          sub={`현재 평균 · 막대 15~30℃ · 법인을 누르면 아래 히트맵·표를 그 법인으로 좁힙니다`}
          /*
           * ⚠ 범례를 **색으로 설명하지 않는다**(v2.556 스크린샷 판독에서 잡은 시안의 내부 불일치):
           *   시안 §3 은 범례를 '물리=#fbbf24 / 가상화=#4ade80' 로 적었지만 막대 채움은
           *   `tempColor(평균)` 이다 — 30℃ 물리 막대도 초록이라 범례가 **거짓**이 된다.
           *   막대 색은 '온도' 를 말하므로 범례는 **자리(위/아래)** 로 설명한다.
           */
          right={(
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11, color: 'var(--text-dim)', flexWrap: 'wrap' }}>
              <span>막대 위 = 물리 · 아래 = 가상화</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--text)' }} />전체 평균</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 14, height: 6, borderRadius: 3, background: 'linear-gradient(90deg,#22c55e,#f59e0b,#ef4444)' }} />색 = 온도
              </span>
            </div>
          )}>
          <DcCompare rows={cmp} sel={sel} onPick={pickDc} allAvgC={S.all?.avgC} dense={dense} regionOf={(k) => regionById.get(k) || ''} />
        </Section>
        <Section title="이상 서버" sub={`현재 ${TEMP_WARN_C}℃ 이상 · 더운 순`}
          right={<span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: 'rgba(239,68,68,.14)', color: '#f87171' }}>{int(hot.length)}대</span>}>
          <HotList
            rows={hot.map((r) => ({
              key: r.id, name: r.name, kind: r.kind, curC: r.curC,
              level: r.source === 'esxi' ? 'host' : null,
              sub: [r.datacenterId || r.vcenterId, r.cluster, r.source === 'idrac' ? 'iDRAC' : 'ESXi'].filter(Boolean).join(' · '),
            }))}
            dense={dense} spark={spark} onOpen={openHist} />
        </Section>
      </div>

      {/* 4. 히트맵 */}
      <Section
        title={(
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {HEAT_TITLE[view]}
            {sel && (
              <button onClick={() => setSel(null)} title="법인 선택 해제"
                style={{ padding: '3px 9px', borderRadius: 12, border: '1px solid rgba(59,130,246,.45)', background: 'rgba(59,130,246,.16)', color: '#bfdbfe', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>
                법인 {selName} <span style={{ color: '#7dd3fc' }}>×</span>
              </button>
            )}
          </span>
        )}
        sub={heatSub} right={<HeatLegend />}>
        <TempHeatmap groups={heatGroups} view={view} dense={dense} sel={sel} onPick={pickDc} />
      </Section>

      {/* 5. 표 */}
      <Section
        title={VIEW_TITLE[view]}
        sub={`${int(tableRows.length)}${view === 'server' || view === 'host' ? '대' : '개'}${sel ? ` · 법인 ${selName}` : ''}`}
        right={view === 'server' ? (
          <Segment
            items={[['all', `전체 ${int(srvAll.length)}`], ['physical', `물리 ${int(S.physical?.servers)}`], ['virtual', `가상화 ${int(S.virtual?.servers)}`]]}
            value={kindF} onPick={(k) => { setKindF(k); setLimit(25); }} pad="4px 11px" size={12} />
        ) : null}>
        <DataTable
          key={view}
          rows={tableRows}
          columns={columns}
          initialSort={{ key: 'curC', dir: 'desc' }}
          rowStyle={(r) => rowTint(r.curC)}
          className={`st-table${dense ? ' dense' : ''}`}
          bare maxHeight="60vh" limit={limit} footer={tableFooter}
          onVisible={setVisible}
          emptyText="표시할 서버가 없습니다." />
      </Section>

      {view !== 'server' && data.sampleIntervalMs > 5 * 60_000 && (
        <div className="muted" style={{ fontSize: 11.5 }}>
          ※ 온도 샘플 주기가 {Math.round(data.sampleIntervalMs / 60000)}분이라 평균 창을 {data.avgWindowLabel} 로 넓혀 계산했습니다
          (설정 › 수집 주기에서 조정). 주기보다 짧은 창으로는 표본이 없어 값이 비어 보입니다.
        </div>
      )}

      {/* 5년 추이 모달(기존 — 변경 없음) */}
      {hist && (
        <Modal title={`온도 추이 — ${hist.key || ''}`} onClose={closeHist} width={760}>
          <div className="flex gap wrap" style={{ marginBottom: 8 }}>
            {[[1, '1일'], [7, '1주'], [30, '1달'], [365, '1년'], [1830, '5년']].map(([d, l]) => (
              <button key={d} className={days === d ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '6px 12px', fontSize: 12 }} onClick={() => setDays(d)}>{l}</button>
            ))}
            {hist.synthesized && <span className="badge amber" style={{ alignSelf: 'center' }}>데모 합성</span>}
          </div>
          <div className="flex gap wrap" style={{ marginBottom: 10, alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 12 }}>집계 단위(기준)</span>
            {[['auto', '자동'], ['minute', '분'], ['hour', '시간'], ['day', '일']].map(([b, l]) => (
              <button key={b} className={bucket === b ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '5px 11px', fontSize: 12 }} onClick={() => setBucket(b)}>{l}</button>
            ))}
            {hist.points?.length ? <span className="muted" style={{ fontSize: 11 }}>{hist.points.length}개 구간</span> : null}
          </div>
          {hist.loading ? <Loading /> : hist.error ? <ErrorBox message="이력을 불러오지 못했습니다." /> : (hist.points || []).length === 0
            ? <div className="muted">해당 기간 데이터가 없습니다(수집 누적 후 표시).</div>
            : (
              <>
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={(hist.points || []).map((p) => ({ t: fmtTrendTick(p.ts, days), avg: p.avg, max: p.max }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.08)" />
                    <XAxis dataKey="t" tick={{ fontSize: 11 }} minTickGap={40} />
                    <YAxis tick={{ fontSize: 11 }} unit="℃" domain={['auto', 'auto']} />
                    <Tooltip contentStyle={{ background: '#0b1220', border: '1px solid #243049', fontSize: 12 }} />
                    <Line type="monotone" dataKey="avg" stroke="#22d3ee" dot={false} name="평균" isAnimationActive={false} />
                    <Line type="monotone" dataKey="max" stroke="#f87171" dot={false} name="최고" isAnimationActive={false} />
                    <Brush dataKey="t" height={22} stroke="#6366f1" travellerWidth={8} tickFormatter={() => ''} />
                  </LineChart>
                </ResponsiveContainer>
                <div className="muted" style={{ fontSize: 11, marginTop: 4, textAlign: 'center' }}>아래 막대를 드래그하면 구간을 좁혀 스크롤·확대해 볼 수 있습니다.</div>
              </>
            )}
        </Modal>
      )}
    </div>
  );
}

/** 온도 색 참조(다른 모듈이 이 화면의 기준을 쓸 때) — tempColor 는 shared.jsx 가 소유한다. */
export { tempColor };
