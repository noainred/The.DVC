// CapacityTools.jsx — SpecialTools.jsx(구 5,070줄)에서 분리(v2.282 대형 파일 분할). 본문은 원본 그대로 이동.
import React, { useEffect, useState, useRef } from 'react';
import { useHashTab } from '../../hooks/useHashTab.js';
import { fetchJson, postJson, downloadFile } from '../../api.js';
import { DataTable, Loading, ErrorBox, StateBadge, UsageCell, Modal, ResultCount, SearchBox, VmLink } from '../../components/ui.jsx';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Brush } from 'recharts';
import { Card, fmtTrendTick, tb, tempColor, useTool } from './shared.jsx';
import RightsizeReport from './RightsizeReport.jsx'; // v2.445: VM 자원 축소 근거 리포트
import DiskTrend from './DiskTrend.jsx'; // v2.446: 디스크 트렌드(할당·사용·회수 가능)
import ServerTempBoard from './serverTemp/ServerTempBoard.jsx'; // v2.556: 서버 온도 — 히트맵 보드(시안 B)
import { sparkCellState, sparkCellText, sparkProgressText, sparkCapText, SPARK_ROW_CAP } from './sparkBatch.js';
// v2.497: 엑셀(ZIP) 내보내기 버튼 문구·예상치 — 판정은 순수 모듈(node 테스트로 고정)
import { reportCount, exportLabel, exportTitle, progressNote, exportErrText } from './wasteExportText.js';


/** 서버 구분 라벨(v2.512) — iDRAC serviceTag 가 ESXi 호스트와 맞으면 가상화, 아니면 물리(베어메탈). */
const KIND_KO = { physical: '물리', virtual: '가상화' };

/**
 * '서버 온도'(v2.512 도입) — v2.556 에 시안 B(히트맵 보드)로 재구현하며 본문을
 * `views/tools/serverTemp/ServerTempBoard.jsx` 로 옮겼다.
 *
 * ⚠ **이 래퍼의 이름(`EsxiTemp`)은 바꾸지 말 것** — `SpecialTools.jsx` 가 도구 키 `esxitemp`
 *   에 이 컴포넌트를 물려 놓았고, 도구 키는 `permissions.json`(사용자별 허용/거부 목록)의 값이자
 *   `auth/toolAccess.js` 의 집행 매핑이다(루트 CLAUDE.md '도구 키는 어떤 이름 변경에도 바꾸지 않는다').
 */
export function EsxiTemp({ scope }) {
  return <ServerTempBoard scope={scope} />;
}

export function Forecast({ scope }) {
  const { loading, data, error } = useTool('/tools/capacity-forecast', scope ? { vcenterId: scope } : {});
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const tb2 = (g) => (g >= 1024 ? `${(g / 1024).toFixed(1)} TB` : `${g} GB`);
  const dlabel = (d) => d == null ? '—' : d > 3650 ? '>10년' : d > 365 ? `${(d / 365).toFixed(1)}년` : `${d}일`;
  const soon = data.items.filter((x) => x.daysToFull != null && x.daysToFull <= 180).length;
  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="데이터스토어" value={data.items.length} />
        <Card label="180일 내 포화 예상" value={soon} accent={soon ? 'var(--red)' : 'var(--green)'} />
      </div>
      {data.mock && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>※ 데모: 증가율/예상일은 합성값입니다. 라이브는 수집 이력(ds_usedgb)이 쌓이면 선형회귀로 산출됩니다.</div>}
      <DataTable rows={data.items} initialSort={{ key: 'daysToFull', dir: 'asc' }} columns={[
        { key: 'name', label: '데이터스토어', render: (d) => <b>{d.name}</b> },
        { key: 'vcenterId', label: 'vCenter', render: (d) => <span className="muted">{d.vcenterId}</span> },
        { key: 'usagePct', label: '현재 사용', render: (d) => <UsageCell pct={d.usagePct} /> },
        { key: 'freeGB', label: '여유', align: 'right', render: (d) => tb2(d.freeGB) },
        { key: 'growthGBperDay', label: '증가율/일', align: 'right', render: (d) => d.growthGBperDay == null ? '—' : `${d.growthGBperDay} GB` },
        { key: 'daysToFull', label: '가득 찰 예상', align: 'right', render: (d) => <b style={{ color: d.daysToFull != null && d.daysToFull <= 180 ? 'var(--red)' : undefined }}>{dlabel(d.daysToFull)}</b> },
      ]} />
    </>
  );
}

export function Capacity({ scope }) {
  // 하위 탭(클러스터/디스크 트렌드)을 URL 에 실어 새로고침·북마크에서 유지(v2.438 규약). 훅은 조기 return 위.
  const [tab, setTab] = useHashTab({ base: ['tools', 'capacity'], valid: ['cluster', 'disk'], fallback: 'cluster' });
  const { loading, data, error } = useTool('/tools/capacity', scope ? { vcenterId: scope } : {});
  const tabs = (
    <div className="flex gap wrap" style={{ marginBottom: 12 }}>
      {[['cluster', '클러스터 수용여력'], ['disk', '💽 디스크 트렌드 (할당·사용·회수 가능)']].map(([k, l]) => (
        <button key={k} className={tab === k ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '6px 12px' }} onClick={() => setTab(k)}>{l}</button>
      ))}
    </div>
  );
  if (tab === 'disk') return <>{tabs}<DiskTrend scope={scope} /></>;
  if (loading) return <>{tabs}<Loading /></>;
  if (error) return <>{tabs}<ErrorBox message={error} /></>;
  const t = data.totals;
  const cols = [
    { key: 'cluster', label: '클러스터', render: (c) => <b>{c.cluster}</b> },
    { key: 'vcenterId', label: 'vCenter', render: (c) => <span className="muted">{c.vcenterId}</span> },
    { key: 'hosts', label: '호스트', align: 'right' },
    { key: 'vmsOn', label: 'VM(On)', align: 'right', render: (c) => `${c.vmsOn}/${c.vms}` },
    { key: 'cores', label: '물리코어', align: 'right' },
    { key: 'vcpuAllocated', label: '할당 vCPU', align: 'right' },
    { key: 'vcpuPerCore', label: 'vCPU:코어', align: 'right', render: (c) => <span className={`badge ${c.vcpuPerCore >= 4 ? 'red' : c.vcpuPerCore >= 3 ? 'amber' : 'green'}`}>{c.vcpuPerCore}:1</span> },
    { key: 'ramOvercommitPct', label: 'RAM 오버커밋', align: 'right', render: (c) => <span className={`badge ${c.ramOvercommitPct >= 100 ? 'red' : c.ramOvercommitPct >= 85 ? 'amber' : 'green'}`}>{c.ramOvercommitPct}%</span> },
    { key: 'cpuUsedPct', label: 'CPU 사용', render: (c) => <UsageCell pct={c.cpuUsedPct} /> },
    { key: 'memUsedPct', label: '메모리 사용', render: (c) => <UsageCell pct={c.memUsedPct} /> },
    { key: 'ramHeadroomGB', label: 'RAM 여유', align: 'right', render: (c) => tb(c.ramHeadroomGB) },
  ];
  return (
    <>
      {tabs}
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="클러스터" value={t.clusters} meta={`호스트 ${t.hosts}`} />
        <Card label="물리코어 / 할당 vCPU" value={`${t.cores} / ${t.vcpuAllocated}`} meta={`${t.vcpuPerCore}:1 평균`} accent={t.vcpuPerCore >= 4 ? 'var(--red)' : undefined} />
        <Card label="메모리 / 할당" value={`${tb(t.memTotalGB)} / ${tb(t.ramAllocatedGB)}`} />
        <Card label="RAM 여유(헤드룸)" value={tb(t.ramHeadroomGB)} accent={t.ramHeadroomGB <= 0 ? 'var(--red)' : 'var(--green)'} />
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>오버커밋: vCPU:코어 ≥4 또는 RAM ≥100%면 과밀(빨강). RAM 여유 = 물리RAM − 할당(전원 On).</div>
      <DataTable columns={cols} rows={data.clusters} initialSort={{ key: 'ramOvercommitPct', dir: 'desc' }} />
    </>
  );
}

/** 스파크라인 정렬용 7일 평균(%) — DataTable 은 sortable:false 를 모르고 sortValue 를 쓴다.
 *  데이터가 없으면 null 을 돌려 DataTable 의 'null 은 뒤로' 규칙에 맡긴다. */
const sparkAvg = (pts) => (pts && pts.length ? Math.round((pts.reduce((a, p) => a + p.v, 0) / pts.length) * 10) / 10 : null);

/**
 * 인라인 스파크라인(SVG) — 의존성 없이 points([{t,v}])를 작은 꺾은선으로 그린다(v2.375).
 * recharts 를 행마다 마운트하면 수십 개 차트로 렌더가 무거워지므로 순수 SVG path 를 쓴다.
 * 값이 %(0~100) 라 y 축을 0~100 으로 고정해 행 간 높이를 비교 가능하게 한다.
 */
function Sparkline({ points, color = '#fbbf24', width = 132, height = 26, requested = false }) {
  // v2.502: '아직 순서가 안 온 것'(…)과 '조회했는데 없는 것'(—)을 구분한다. 예전에는 둘 다
  // undefined 여서 표 아래쪽 행이 영원히 '…' 로 남았고, 사용자는 고장인지 대기인지 알 수 없었다.
  const state = sparkCellState(points, requested);
  if (state !== 'ok') {
    const t = sparkCellText(state);
    return <span className="muted" style={{ fontSize: 11 }} title={t.title}>{t.text}</span>;
  }
  const pad = 2;
  const n = points.length;
  const xs = (i) => pad + (i * (width - pad * 2)) / (n - 1);
  const ys = (v) => height - pad - (Math.max(0, Math.min(100, v)) / 100) * (height - pad * 2);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xs(i).toFixed(1)},${ys(p.v).toFixed(1)}`).join(' ');
  const last = points[n - 1]?.v;
  const max = points.reduce((a, p) => (p.v > a ? p.v : a), 0);
  const avg = points.reduce((a, p) => a + p.v, 0) / n;
  return (
    <span className="flex gap" style={{ alignItems: 'center', gap: 6 }}
      title={`7일 추이 · 평균 ${avg.toFixed(1)}% · 최대 ${max.toFixed(1)}% · 최근 ${last?.toFixed(1)}% (${n}점, 30분 간격)`}>
      <svg width={width} height={height} style={{ display: 'block', flex: 'none' }} aria-hidden="true">
        {/* 기준선(50%) — 눈금이 없으면 낮은 사용률인지 가늠이 안 된다 */}
        <line x1={pad} y1={ys(50)} x2={width - pad} y2={ys(50)} stroke="rgba(148,163,184,.25)" strokeDasharray="2 3" strokeWidth="1" />
        <path d={d} fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <span className="muted" style={{ fontSize: 10.5, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        μ{avg.toFixed(0)} / ↑{max.toFixed(0)}%
      </span>
    </span>
  );
}

/**
 * 표에 보이는 VM 들의 7일 스파크라인을 **배치로** 불러온다(v2.375).
 * 행마다 개별 요청하면 수십 개 HTTP + vCenter SOAP 이 몰리므로, vmId 목록을 한 번에 POST 한다.
 * 서버가 요청당 VM 수를 제한(기본 24)하고 5분 캐시하므로 여기서도 상한을 맞춰 보낸다.
 */
/** 추이 조회의 진행·한계를 밝히는 각주 — 조용히 자르지 않는다(v2.502). */
function SparkNote({ spark }) {
  const progress = sparkProgressText(spark.progress || {});
  const cap = sparkCapText(spark.totalRows);
  if (!progress && !cap) return null;
  return (
    <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
      {progress && <div>※ {progress}</div>}
      {cap && <div>※ {cap}</div>}
    </div>
  );
}

function useSparklines(rows, type, enabled) {
  const [map, setMap] = useState({});        // vmId -> points | null
  const [info, setInfo] = useState(null);    // { synthesized, maxVms, capped, skipped }
  const [asked, setAsked] = useState(() => new Set()); // 서버에 이미 물어본 id(대기와 '없음' 구분용)
  const [done, setDone] = useState(0);       // 진행 표시
  const all = Array.isArray(rows) ? rows.map((r) => r.id).filter(Boolean) : [];
  const ids = all.slice(0, SPARK_ROW_CAP);
  const key = ids.join(',');
  useEffect(() => {
    if (!enabled || !key) { setMap({}); setInfo(null); setAsked(new Set()); setDone(0); return undefined; }
    let dead = false;
    setMap({}); setAsked(new Set()); setDone(0);
    (async () => {
      const list = key.split(',');
      // 첫 배치는 서버 상한을 모르므로 보수적으로 시작하고, 응답의 maxVms 로 이후 배치를 맞춘다
      // (화면에 24 를 하드코딩하지 않는다 — 서버가 WASTE_SPARK_MAX_VMS 로 조정한다).
      let size = 24;
      let i = 0;
      let skipped = 0;
      while (i < list.length && !dead) {
        const batch = list.slice(i, i + size);
        try {
          // 순차 배치가 의도다: 고RTT vCenter 에 QueryPerf 를 한꺼번에 몰지 않기 위해 배치를
          // 하나씩 보낸다(서버가 배치 안에서 6개 동시). 병렬로 바꾸면 28개 vCenter 환경에서
          // 한 화면 진입이 수십 개 SOAP 을 동시에 띄운다.
          const r = await postJson('/tools/waste/spark', { vmIds: batch, type });
          if (dead) return;
          if (Number(r.maxVms) > 0) size = Number(r.maxVms);
          const got = r.series || {};
          skipped += Number(r.skipped) || 0;
          setMap((m) => ({ ...m, ...got }));
          setAsked((prev) => { const n = new Set(prev); for (const id of batch) n.add(id); return n; });
          setInfo({ synthesized: r.synthesized, maxVms: r.maxVms, capped: !!r.capped, skipped });
        } catch {
          if (dead) return;
          // 이 배치만 실패 — 나머지는 계속 시도한다. 실패한 id 는 '물어봤다' 로 표시해
          // 영원히 '…' 로 남지 않게 한다(원인은 단정하지 않고 '—' 로 보인다).
          setAsked((prev) => { const n = new Set(prev); for (const id of batch) n.add(id); return n; });
        }
        i += batch.length;
        if (!dead) setDone(i);
      }
    })();
    return () => { dead = true; };
  }, [key, type, enabled]);
  return { map, info, asked, progress: { done, total: ids.length, skipped: info?.skipped || 0 }, totalRows: all.length };
}

/**
 * 할당 vs 실사용 추이(v2.374) — '주기적 실사용률 트렌드로 할당량을 조절' 하기 위한 차트.
 * 샘플러(기본 1분)가 적재한 집계를 시간/일/주 버킷으로 보여준다(시간당 이상은 롤업 사용).
 * 사용률(%) 축과 절대량(GHz/GB) 축을 탭으로 나눠 본다 — 한 차트에 섞으면 스케일이 무의미해진다.
 */
function WasteTrend({ scope }) {
  const [days, setDays] = useState(30);
  const [bucket, setBucket] = useState('auto');
  const [mode, setMode] = useState('pct');   // pct | abs
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let dead = false;
    setD(null); setErr(null);
    const p = { days: String(days), ...(scope ? { vcenterId: scope } : {}), ...(bucket !== 'auto' ? { bucket } : {}) };
    fetchJson('/tools/waste/history', p).then((r) => { if (!dead) setD(r); }).catch((e) => { if (!dead) setErr(e.message); });
    return () => { dead = true; };
  }, [scope, days, bucket]);
  const pts = d?.points || [];
  const fmtTs = (t) => new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit' });
  return (
    <>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 8 }}>
        <span className="muted" style={{ fontSize: 12 }}>기간</span>
        <select className="select" value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ minWidth: 110 }}>
          {[1, 7, 30, 90, 365].map((n) => <option key={n} value={n}>최근 {n}일</option>)}
        </select>
        <span className="muted" style={{ fontSize: 12 }}>집계</span>
        <select className="select" value={bucket} onChange={(e) => setBucket(e.target.value)} style={{ minWidth: 110 }}>
          <option value="auto">자동</option><option value="hour">1시간</option><option value="day">1일</option><option value="week">1주</option>
        </select>
        <div className="flex gap" style={{ marginLeft: 4 }}>
          <button className={mode === 'pct' ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '6px 12px' }} onClick={() => setMode('pct')}>사용률(%)</button>
          <button className={mode === 'abs' ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '6px 12px' }} onClick={() => setMode('abs')}>절대량</button>
        </div>
      </div>
      {err ? <ErrorBox message={err} />
        : !d ? <Loading />
          : pts.length < 2 ? (
            <div className="muted" style={{ fontSize: 13, padding: 20, textAlign: 'center' }}>
              표시할 추이 데이터가 아직 없습니다. 사용량은 <b>샘플러가 수집하는 시점부터</b> 쌓입니다
              {d.collectedSince ? <> (수집 시작: {new Date(d.collectedSince).toLocaleString('ko-KR')})</> : null}.
              업그레이드 직후에는 몇 시간 뒤부터 그래프가 보입니다.
            </div>
          ) : (
            <div style={{ width: '100%', height: 320 }}>
              <ResponsiveContainer>
                <LineChart data={pts} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid stroke="rgba(148,163,184,.15)" />
                  <XAxis dataKey="ts" tickFormatter={fmtTs} tick={{ fontSize: 11 }} minTickGap={28} />
                  <YAxis tick={{ fontSize: 11 }} domain={mode === 'pct' ? [0, 100] : ['auto', 'auto']}
                    label={{ value: mode === 'pct' ? '%' : 'GHz / GB', angle: -90, position: 'insideLeft', fontSize: 11 }} />
                  <Tooltip labelFormatter={(t) => new Date(t).toLocaleString('ko-KR')}
                    contentStyle={{ background: 'var(--panel)', border: '1px solid var(--border)', fontSize: 12 }} />
                  {mode === 'pct' ? <>
                    <Line type="monotone" dataKey="cpuUsedPct" name="CPU 사용률" stroke="#60a5fa" dot={false} connectNulls={false} />
                    <Line type="monotone" dataKey="memUsedPct" name="메모리 사용률" stroke="#4ade80" dot={false} connectNulls={false} />
                  </> : <>
                    <Line type="monotone" dataKey="cpuAllocGHz" name="CPU 할당(GHz)" stroke="#60a5fa" strokeDasharray="4 3" dot={false} connectNulls={false} />
                    <Line type="monotone" dataKey="cpuUsedGHz" name="CPU 사용(GHz)" stroke="#60a5fa" dot={false} connectNulls={false} />
                    <Line type="monotone" dataKey="memAllocGB" name="메모리 할당(GB)" stroke="#4ade80" strokeDasharray="4 3" dot={false} connectNulls={false} />
                    <Line type="monotone" dataKey="memUsedGB" name="메모리 사용(GB)" stroke="#4ade80" dot={false} connectNulls={false} />
                  </>}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
      {pts.length >= 2 && (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          점선 = 할당, 실선 = 실사용. 사용률이 장기간 낮게 유지되면 할당을 줄일 여지가 있습니다.
          {' '}집계 단위 {d.bucketMs >= 86_400_000 ? `${Math.round(d.bucketMs / 86_400_000)}일` : `${Math.round(d.bucketMs / 3_600_000)}시간`} 평균 ·
          {' '}표본 {pts.length}점{d.collectedSince ? ` · 수집 시작 ${new Date(d.collectedSince).toLocaleDateString('ko-KR')}` : ''}
        </div>
      )}
    </>
  );
}

/**
 * 낭비 리소스 표의 검색 결과 개수 표시(v2.491).
 *
 * 공용 `ResultCount` 는 shown<total 을 '상위 N개 표시'(서버측 상위 절단)로 문구화한다 — 이름 검색
 * 결과에 그 문구를 쓰면 절단으로 오해되므로 '이름 일치 M개' 로 정확히 적는다(추정·과장 금지 규칙).
 */
function MatchCount({ total = 0, shown = 0, term = '', label = 'VM' }) {
  return (
    <div className="muted result-count" style={{ marginBottom: 10 }}>
      총 <b style={{ color: 'var(--text)' }}>{total.toLocaleString()}</b>개 {label}
      {term ? <>
        {' · 이름 일치 '}<b style={{ color: 'var(--text)' }}>{shown.toLocaleString()}</b>개
        <span className="badge blue" style={{ marginLeft: 8 }}>검색: {term}</span>
      </> : null}
    </div>
  );
}

export function Waste({ scope, cluster = '', folder = '' }) {
  // v2.491: 클러스터·폴더는 **서버에서** 거른다 — KPI 카드·탭 개수·과할당 집계까지 선택 범위 기준이
  // 되어야 하기 때문이다(화면에서 표만 걸러내면 카드 수치와 표가 어긋난다). 상위 SpecialTools 헤더가
  // vCenter 를 고른 뒤에만 값을 넘긴다.
  const params = { ...(scope ? { vcenterId: scope } : {}), ...(cluster ? { cluster } : {}), ...(folder ? { folder } : {}) };
  const { loading, data, error } = useTool('/tools/waste', params);
  // 하위 탭을 URL 에 실어 새로고침·북마크·뒤로가기에서 유지한다(v2.438, hooks/useHashTab.js).
  const [tab, setTab] = useHashTab({ base: ['tools', 'waste'], valid: ['off', 'snap', 'tools', 'cpu', 'mem', 'trend'], fallback: 'off' });
  // ⚠ 훅은 **조기 return 위**에서 전부 선언한다(CLAUDE.md 프론트 회귀 방지). useSparklines 는
  // 내부에 useState/useEffect 를 가지므로 아래 `if (loading) return` 뒤에 두면 렌더 간 훅 개수가
  // 달라져 React #310 으로 화면 전체가 크래시한다(v2.375 에서 실제 발생 → v2.376 수정).
  // data 가 아직 없을 수 있으니 optional chaining 으로 접근하고, enabled 플래그로 조회를 막는다.
  const oa = data?.overAllocated || null; // 과할당(할당 vs 사용) — 구버전 서버 응답이면 없음
  const spark = useSparklines(tab === 'cpu' ? oa?.cpuTop : tab === 'mem' ? oa?.memTop : null,
    tab === 'mem' ? 'mem' : 'cpu', !!oa && (tab === 'cpu' || tab === 'mem'));
  // v2.445: '📊 근거' 로 여는 자원 축소 근거 리포트 대상 VM. 훅이므로 조기 return 위에 둔다.
  const [reportVm, setReportVm] = useState(null);
  // v2.491: VM 이름 검색 — 아래 하위 탭(전원 꺼짐·스냅샷·Tools 미실행·CPU/메모리 과할당)의 표를
  // 이름으로 거른다. 훅이므로 조기 return 위에 선언한다(CLAUDE.md 프론트 회귀 방지).
  const [q, setQ] = useState('');
  // v2.483: 전원 꺼진 VM 의 '꺼진 지 N일' — 목록(/tools/waste)과 별도로 조회해 뒤이어 채운다(출처: 이벤트/추적/first_seen).
  const [offSince, setOffSince] = useState(null); // { byId: {vmId: {offSince, offDays, source, exact}}, sources, error }
  // v2.497: 엑셀(ZIP) 내보내기 — 표 5개 + vCenter 별 현황 xlsx + VM 별 근거 리포트(HTML) 첨부.
  // 훅은 조기 return 위에 선언한다(CLAUDE.md 프론트 회귀 방지 — React #310).
  const [exportDays, setExportDays] = useState(30);   // 근거 리포트 관측 기간(리포트 모달 기본과 동일)
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState('');
  const [exportSec, setExportSec] = useState(0);      // 경과 초 — '멈춘 것' 으로 오해하지 않게 보여준다
  useEffect(() => {
    if (!exporting) return undefined;
    const t0 = Date.now();
    setExportSec(0);
    const id = setInterval(() => setExportSec((Date.now() - t0) / 1000), 1000);
    return () => clearInterval(id);
  }, [exporting]);
  const runExport = async () => {
    if (exporting) return;
    setExporting(true); setExportErr('');
    try {
      await downloadFile(`/tools/waste/export?${new URLSearchParams({ ...params, days: String(exportDays), ...(q.trim() ? { q: q.trim() } : {}) }).toString()}`);
    } catch (e) {
      setExportErr(exportErrText(e));
    } finally {
      setExporting(false);
    }
  };
  useEffect(() => {
    if (!data) return;
    let alive = true;
    setOffSince(null);
    fetchJson('/tools/waste/off-since', params)
      .then((r) => { if (!alive) return; const byId = {}; for (const x of r.rows || []) byId[x.id] = x; setOffSince({ byId, sources: r.sources || {}, error: '' }); })
      .catch((e) => { if (alive) setOffSince({ byId: {}, sources: {}, error: e?.message || String(e) }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, scope, cluster, folder]);
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const tb2 = (g) => (g >= 1024 ? `${(g / 1024).toFixed(1)} TB` : `${g} GB`);
  // 이름만 대조한다(대소문자 무시·부분일치). KPI 카드 수치는 전체 기준을 유지하고 표만 거른다.
  const term = q.trim();
  const lower = term.toLowerCase();
  const byName = (rows) => (lower ? (rows || []).filter((r) => (r.name || '').toLowerCase().includes(lower)) : (rows || []));
  const emptyText = term ? `이름에 '${term}' 이(가) 포함된 VM 이 없습니다.` : '데이터가 없습니다.';
  return (
    <>
      {(cluster || folder) && (
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          아래 모든 수치는 선택한 범위 기준입니다 —
          {cluster ? <> 클러스터 <b style={{ color: 'var(--text)' }}>{cluster}</b></> : null}
          {cluster && folder ? ' ·' : null}
          {folder ? <> 폴더 <b style={{ color: 'var(--text)' }}>{folder}</b></> : null}
        </div>
      )}
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="전원 꺼진 VM" value={data.poweredOff.count} meta={`스토리지 ${tb2(data.poweredOff.storageGB)} 점유`} accent={data.poweredOff.count ? 'var(--amber)' : undefined} />
        <Card label="스냅샷 보유 VM" value={data.snapshots.count} meta={`${tb2(data.snapshots.sizeGB)} 사용`} accent={data.snapshots.count ? 'var(--amber)' : undefined} />
        <Card label="Thin 회수가능(추정)" value={tb2(data.thinReclaim.reclaimableGB)} meta={`${data.thinReclaim.count} VM`} />
        <Card label="Tools 미실행(On)" value={data.noTools.count} accent={data.noTools.count ? 'var(--amber)' : undefined} />
        {oa && <Card label="미사용 CPU clock" value={`${oa.cpu.idleGHz} GHz`}
          meta={`할당 ${oa.cpu.allocGHz} · 사용 ${oa.cpu.usedGHz} GHz → 절감 가능 ${oa.cpu.savingPct}%`}
          accent={oa.cpu.savingPct >= 50 ? 'var(--amber)' : undefined} />}
        {oa && <Card label="미사용 메모리" value={tb2(oa.mem.idleGB)}
          meta={`할당 ${tb2(oa.mem.allocGB)} · 사용 ${tb2(oa.mem.usedGB)} → 절감 가능 ${oa.mem.savingPct}%`}
          accent={oa.mem.savingPct >= 50 ? 'var(--amber)' : undefined} />}
      </div>
      <div className="flex gap wrap" style={{ marginBottom: 8, alignItems: 'center' }}>
        {[['off', `전원 꺼짐 (${data.poweredOff.count})`], ['snap', `스냅샷 (${data.snapshots.count})`], ['tools', `Tools 미실행 (${data.noTools.count})`],
          ...(oa ? [['cpu', `CPU 과할당 (${oa.cpu.candidates})`], ['mem', `메모리 과할당 (${oa.mem.candidates})`], ['trend', '📈 사용 추이']] : [])].map(([k, l]) => (
          <button key={k} className={tab === k ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setTab(k)}>{l}</button>
        ))}
        {tab !== 'trend' && <SearchBox className="input" style={{ marginLeft: 'auto', maxWidth: 260, minWidth: 170 }}
          placeholder="🔍 VM 이름 검색" value={q} onChange={setQ} />}
        {tab !== 'trend' && (
          <span className="flex gap" style={{ alignItems: 'center', flex: 'none' }}>
            <select className="select" style={{ width: 116 }} value={exportDays} disabled={exporting}
              onChange={(e) => setExportDays(Number(e.target.value))} title="근거 리포트의 vCenter 성능 관측 기간">
              {[7, 30, 90, 180, 365].map((d) => <option key={d} value={d}>근거 {d}일</option>)}
            </select>
            <button className="logout-btn" style={{ flex: 'none', padding: '7px 12px' }} disabled={exporting} onClick={runExport}
              title={exportTitle({ reportVms: reportCount(data, { nameFilter: q }), vcenters: (data.byVcenter || []).length || 1, days: exportDays, nameFilter: q })}>
              {exportLabel({ busy: exporting, elapsedSec: exportSec })}
            </button>
          </span>
        )}
      </div>
      {exporting && <div className="muted" style={{ fontSize: 12, marginBottom: 8, overflowWrap: 'anywhere' }}>
        {progressNote({ reportVms: reportCount(data, { nameFilter: q }), vcenters: (data.byVcenter || []).length || 1, days: exportDays, elapsedSec: exportSec })}
      </div>}
      {exportErr && <div className="muted" style={{ fontSize: 12, marginBottom: 8, color: 'var(--amber)', overflowWrap: 'anywhere' }}>{exportErr}</div>}
      {tab === 'off' && (() => {
        const SRC = { event: 'vCenter 전원 이벤트(정확)', observed: `전원 꺼짐 점검(${offSince?.sources?.observedIntervalHours || 6}시간 주기)에서 관측된 현재 꺼짐 구간 시작 — 하한`, track: 'VM 추적 12시간 슬롯 전환(그 시각 이후 확실히 꺼짐 — 하한)', first_seen: 'VM 추적 시작 이후 계속 꺼짐(하한)' };
        const SRC_SHORT = { event: '이벤트', observed: '점검', track: '추적', first_seen: '관측 시작' };
        const all = data.poweredOff.vms.map((v) => ({ ...v, ...(offSince?.byId?.[v.id] || {}) }));
        const rows = byName(all);
        return (<>
          <MatchCount total={all.length} shown={rows.length} term={term} />
          <DataTable rows={rows} emptyText={emptyText} initialSort={{ key: 'storageGB', dir: 'desc' }} columns={[
            { key: 'name', label: 'VM', render: (v) => <VmLink name={v.name} vcenterId={v.vcenterId} label={v.name} /> }, { key: 'vcenterId', label: 'vCenter', render: (v) => <span className="muted">{v.vcenterId}</span> },
            { key: 'guestOS', label: 'OS' }, { key: 'storageGB', label: '스토리지', align: 'right', render: (v) => tb2(v.storageGB) },
            { key: 'offDays', label: '꺼진 지', align: 'right', render: (v) => (
              v.offDays == null
                ? <span className="muted">{offSince ? '—' : '…'}</span>
                : <span title={`${SRC[v.source] || v.source} · ${new Date(v.offSince).toLocaleString('ko-KR')}`}>
                    <b style={{ color: v.offDays >= 90 ? 'var(--amber)' : undefined }}>{v.exact ? '' : '≥ '}{v.offDays}일</b>
                    <div className="muted" style={{ fontSize: 11 }}>{new Date(v.offSince).toLocaleDateString('ko-KR')} · {SRC_SHORT[v.source] || v.source}</div>
                  </span>) },
          ]} />
          <div className="muted" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.6 }}>
            <b>꺼진 지</b> 출처 — <b>이벤트</b>: vCenter 전원 이벤트(정확, 로그 수집이 켜져 있고 보관 기간 안일 때; VM 이름 기준이라 동명 VM 은 구분 못 함) ·
            <b> 점검</b>: 전원 꺼짐 점검({offSince?.sources?.observedIntervalHours || 6}시간 주기, 설정 › 수집 서버 › 전원 꺼짐 점검)에서 처음 꺼진 것으로 관측된 시각('≥' 하한, 정밀도 = 주기) ·
            <b> 추적</b>: VM 추적의 12시간 슬롯에서 On→Off 전환이 관측된 시각(실제로는 그 직전 슬롯 사이 — '≥' 하한) ·
            <b> 관측 시작</b>: VM 추적 시작부터 계속 꺼짐('≥' 하한). '—' 는 세 출처 모두 없음(로그 수집·VM 추적이 꺼져 있거나 보관 기간 밖).
            {offSince && !offSince.error && !offSince.sources?.events && <> 이 조회에서 이벤트 출처는 사용되지 않았습니다(vCenter 로그 수집 확인).</>}
            {offSince && !offSince.error && offSince.sources?.observedEnabled === false && <> 전원 꺼짐 점검이 꺼져 있습니다(설정에서 켜면 점검 주기 정밀도로 추적).</>}
            {offSince?.error && <> 조회 실패: {offSince.error}</>}
          </div>
        </>);
      })()}
      {tab === 'snap' && <>
        <MatchCount total={(data.snapshots.vms || []).length} shown={byName(data.snapshots.vms).length} term={term} />
        <DataTable rows={byName(data.snapshots.vms)} emptyText={emptyText} initialSort={{ key: 'snapshotSizeGB', dir: 'desc' }} columns={[
        { key: 'name', label: 'VM', render: (v) => <VmLink name={v.name} vcenterId={v.vcenterId} label={v.name} /> }, { key: 'vcenterId', label: 'vCenter', render: (v) => <span className="muted">{v.vcenterId}</span> },
        { key: 'snapshotCount', label: '개수', align: 'right' }, { key: 'snapshotSizeGB', label: '크기', align: 'right', render: (v) => tb2(v.snapshotSizeGB) }]} />
      </>}
      {tab === 'tools' && <>
        <MatchCount total={(data.noTools.vms || []).length} shown={byName(data.noTools.vms).length} term={term} />
        <DataTable rows={byName(data.noTools.vms)} emptyText={emptyText} columns={[
        { key: 'name', label: 'VM', render: (v) => <VmLink name={v.name} vcenterId={v.vcenterId} label={v.name} /> }, { key: 'vcenterId', label: 'vCenter', render: (v) => <span className="muted">{v.vcenterId}</span> },
        { key: 'toolsStatus', label: 'Tools 상태', render: (v) => <span className="badge amber">{v.toolsStatus}</span> }]} />
      </>}
      {tab === 'cpu' && oa && <>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          할당 clock = vCPU × 호스트 코어당 MHz · 사용 clock = 할당 × 현재 사용률. 사용률 <b>{oa.thresholds.cpuIdlePct}% 이하</b>이고 vCPU 2개 이상인 VM만 후보로 봅니다(1 vCPU 는 줄일 수 없음).
        </div>
        <MatchCount total={(oa.cpuTop || []).length} shown={byName(oa.cpuTop).length} term={term} />
        <DataTable rows={byName(oa.cpuTop)} emptyText={emptyText} initialSort={{ key: 'cpuIdleMhz', dir: 'desc' }} columns={[
          { key: 'name', label: 'VM', render: (v) => <VmLink name={v.name} vcenterId={v.vcenterId} label={v.name} /> },
          { key: 'vcenterId', label: 'vCenter', render: (v) => <span className="muted">{v.vcenterId}</span> },
          { key: 'vcpu', label: 'vCPU', align: 'right' },
          { key: 'cpuAllocMhz', label: '할당 clock', align: 'right', render: (v) => (v.cpuAllocMhz == null ? '—' : `${(v.cpuAllocMhz / 1000).toFixed(1)} GHz`) },
          { key: 'cpuUsedMhz', label: '사용 clock', align: 'right', render: (v) => (v.cpuUsedMhz == null ? '—' : `${(v.cpuUsedMhz / 1000).toFixed(1)} GHz`) },
          { key: 'cpuIdleMhz', label: '미사용 clock', align: 'right', render: (v) => (v.cpuIdleMhz == null ? '—' : <b style={{ color: 'var(--amber)' }}>{(v.cpuIdleMhz / 1000).toFixed(1)} GHz</b>) },
          { key: 'cpuUsagePct', label: '사용률', align: 'right', render: (v) => `${v.cpuUsagePct}%` },
          { key: 'cpuSavingPct', label: '절감 가능', align: 'right', render: (v) => (v.cpuSavingPct == null ? '—' : <b>{v.cpuSavingPct}%</b>) },
          { key: 'host', label: 'ESXi 호스트', render: (v) => <span className="muted">{v.host}</span> },
          { key: 'spark', label: '7일 사용률 추이', sortValue: (v) => sparkAvg(spark.map[v.id]), render: (v) => <Sparkline points={spark.map[v.id]} requested={spark.asked.has(v.id)} /> },
          { key: 'report', label: '근거', sortable: false, render: (v) => <button className="tab" style={{ padding: '4px 9px', fontSize: 11.5 }} onClick={() => setReportVm(v)} title="기간별 추이·p95·CPU Ready·권장 vCPU 와 참고 문서">📊 리포트</button> },
        ]} />
        <SparkNote spark={spark} />
        {spark.info?.synthesized && <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>※ 데모(mock) 모드의 합성 데이터입니다.</div>}
      </>}
      {tab === 'mem' && oa && <>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          사용 메모리는 게스트가 실제로 쓰는 양(guest memory usage)입니다. 사용률 <b>{oa.thresholds.memIdlePct}% 이하</b>인 VM을 후보로 봅니다.
        </div>
        <MatchCount total={(oa.memTop || []).length} shown={byName(oa.memTop).length} term={term} />
        <DataTable rows={byName(oa.memTop)} emptyText={emptyText} initialSort={{ key: 'memIdleGB', dir: 'desc' }} columns={[
          { key: 'name', label: 'VM', render: (v) => <VmLink name={v.name} vcenterId={v.vcenterId} label={v.name} /> },
          { key: 'vcenterId', label: 'vCenter', render: (v) => <span className="muted">{v.vcenterId}</span> },
          { key: 'memAllocGB', label: '할당', align: 'right', render: (v) => tb2(v.memAllocGB) },
          { key: 'memUsedGB', label: '사용', align: 'right', render: (v) => tb2(v.memUsedGB) },
          { key: 'memIdleGB', label: '미사용', align: 'right', render: (v) => <b style={{ color: 'var(--amber)' }}>{tb2(v.memIdleGB)}</b> },
          { key: 'memUsagePct', label: '사용률', align: 'right', render: (v) => `${v.memUsagePct}%` },
          { key: 'memSavingPct', label: '절감 가능', align: 'right', render: (v) => (v.memSavingPct == null ? '—' : <b>{v.memSavingPct}%</b>) },
          { key: 'guestOS', label: 'Guest OS' },
          { key: 'host', label: 'ESXi 호스트', render: (v) => <span className="muted">{v.host}</span> },
          { key: 'spark', label: '7일 사용률 추이', sortValue: (v) => sparkAvg(spark.map[v.id]), render: (v) => <Sparkline points={spark.map[v.id]} color="#4ade80" requested={spark.asked.has(v.id)} /> },
          { key: 'report', label: '근거', sortable: false, render: (v) => <button className="tab" style={{ padding: '4px 9px', fontSize: 11.5 }} onClick={() => setReportVm(v)} title="Active·Consumed·벌룬·스왑 추이와 권장 메모리, 참고 문서">📊 리포트</button> },
        ]} />
        <SparkNote spark={spark} />
      </>}
      {tab === 'trend' && <WasteTrend scope={scope} />}
      {reportVm && <RightsizeReport vm={reportVm} onClose={() => setReportVm(null)} />}
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>※ 고아 디스크(orphaned VMDK)는 데이터스토어 파일 스캔이 필요해 현재 미포함입니다.</div>
      {oa && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        ※ 과할당 수치는 <b>스냅샷 시점(현재)의 순간 사용률</b> 기준 추정입니다 — 리사이징 결정에는 기간 평균·피크(예: 1주 P95)를 함께 확인하세요. 전원이 꺼진 VM은 제외했고(위 ‘전원 꺼짐’ 참조),
        {oa.excludedNoHostMhz > 0 ? <> 호스트 코어 clock을 알 수 없는 <b>{oa.excludedNoHostMhz}대</b>는 CPU clock 집계에서 제외했습니다(값을 추정하지 않음).</> : null}
      </div>}
    </>
  );
}

export function ThinVms({ scope }) {
  const { loading, data, error } = useTool('/tools/thin-vms', scope ? { vcenterId: scope } : {});
  const [q, setQ] = useState('');
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const term = q.trim().toLowerCase();
  const rows = data.items.filter((r) => !term || (r.name || '').toLowerCase().includes(term) || (r.guestOS || '').toLowerCase().includes(term) || (r.host || '').toLowerCase().includes(term));
  const cols = [
    { key: 'name', label: 'VM', render: (r) => <VmLink name={r.name} vcenterId={r.vcenterId} label={r.name} /> },
    { key: 'vcenterId', label: 'vCenter', render: (r) => <span className="muted">{r.vcenterId}</span> },
    { key: 'powerState', label: '전원', render: (r) => <StateBadge state={r.powerState} /> },
    { key: 'guestOS', label: 'Guest OS' },
    { key: 'committedGB', label: '사용(committed)', align: 'right', render: (r) => tb(r.committedGB) },
    { key: 'provisionedGB', label: '할당(provisioned)', align: 'right', render: (r) => tb(r.provisionedGB) },
    { key: 'uncommittedGB', label: '회수가능(추정)', align: 'right', render: (r) => <b style={{ color: 'var(--amber)' }}>{tb(r.uncommittedGB)}</b> },
    { key: 'host', label: 'ESXi 호스트', render: (r) => <span className="muted">{r.host}</span> },
  ];
  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="Thin VM" value={data.thinVms.toLocaleString()} meta={`전체 ${data.totalVms.toLocaleString()} 중 ${data.thinPct}%`} />
        <Card label="사용 합계" value={`${data.committedTB} TB`} meta="committed" />
        <Card label="할당 합계" value={`${data.provisionedTB} TB`} meta="provisioned" />
        <Card label="회수 가능(추정)" value={`${data.reclaimableTB} TB`} accent="var(--amber)" meta="uncommitted 합" />
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>※ Thin 판정은 vCenter의 uncommitted(여유) 기준 <b>추정</b>입니다. 회수 가능 용량은 정확한 값이 아니라 참고치입니다.</div>
      <div className="flex gap" style={{ marginBottom: 8 }}>
        <SearchBox className="input" style={{ maxWidth: 260 }} placeholder="VM / OS / 호스트 검색" value={q} onChange={setQ} />
      </div>
      <ResultCount total={data.items.length} shown={rows.length} label="Thin VM" filtered={!!term} />
      <DataTable columns={cols} rows={rows} initialSort={{ key: 'uncommittedGB', dir: 'desc' }} />
    </>
  );
}
