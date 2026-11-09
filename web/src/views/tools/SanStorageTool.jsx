// v2.948 — 'SAN 스토리지 성능'(독립 도구 san-storage · 메뉴 '스토리지 › SAN 스토리지 성능' · 설계 docs/design/san-storage-perf ①②④⑤ · 사용자 컨펌 2026-11-08).
//   스위치 portperfshow 표본을 어레이 → 디렉터(PowerMax FA) · 컨트롤러(PowerStore Node · Unity SP) → 포트로 묶어 지금 · 회선 사용률 · 24시간 평균/피크 · 7일 대비 · 트렌드를 본다.
//   탭은 해시(useHashTab) — 현황(list) · 성능 점검(check) · 분류 · 매핑(mapping) · 어레이 상세(array/<키>/<법인>). 판정 · 조립은 서버(storageList · storagePerfCheck),
//   그리기 · 문구는 sanStorageText.js(순수). 차트는 SVG 직접(recharts 를 더 싣지 않는다) · 결측은 선을 끊는다 · 값이 없으면 '—'.
//   무거운 조회는 60초 폴링(현황 — 수집은 수 분 주기) · 상세는 열 때 1회 + 실시간 창만 60초 · 늦게 온 이전 응답은 버린다(요청 키 대조).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, usePolling, hasRole, canCsv } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { useHashTab } from '../../hooks/useHashTab.js';
import { hashSegments } from '../../hooks/hashTab.js';
import SanStorageCheck from './SanStorageCheck.jsx';
import SanStorageMapping from './SanStorageMapping.jsx';
import { TABS, RANGES, rangeOf, rangeQuery, windowLabel, GROUPINGS, MODES, rateText, pctText, deltaOf, deltaNote, dayTB, stateTag, imbalanceTag, liveText, intervalText,
  agoShort, clockText, dateClockText, kpisOf, filterRows, sortRowsBy, SORTS, sparkSegments, stackModel, tickLabels, seriesStats, foldHeatmap, foldSeries, csvText, csvFileName, gbps, vizColor, VENDOR_SHORT, feValueText, lineModel, feMetricsPresent, FE_UNIT_TEXT } from './sanStorageText.js';
import './sanStorage.css';

const BASE = ['tools', 'san-storage'];
const TAB_KEYS = ['list', 'check', 'mapping', 'array'];
const LIST_POLL_MS = 60_000;     // 수집은 수 분 주기 — 1분이면 충분(트래픽 카드와 같다)
const HEAVY_TIMEOUT_MS = 90_000; // 서버 감시 60초보다 길게 · 재시도 0(같은 무거운 집계를 다시 줄 세우지 않게)
const HEAVY_FETCH_OPTS = Object.freeze({ timeoutMs: HEAVY_TIMEOUT_MS, retries: 0 });
const NONE_DC = '__none__';
const DC_SEG_NONE = '-';

/** 해시 세그먼트(상세의 어레이 키 · 법인) — hashchange 때 다시 읽는다. */
function useHashSegs() {
  const [segs, setSegs] = useState(() => hashSegments(window.location.hash));
  useEffect(() => {
    const on = () => setSegs(hashSegments(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return segs;
}
const detailHash = (key, dcId) => `#/${[...BASE, 'array', encodeURIComponent(key), encodeURIComponent(dcId || DC_SEG_NONE)].join('/')}`;

export default function SanStorageTool() {
  // ⚠ 훅은 전부 조기 return 위(React #310).
  const [tab, setTab] = useHashTab({ base: BASE, valid: TAB_KEYS, fallback: 'list' });
  const segs = useHashSegs();
  const [dc, setDc] = useState('');          // 법인 필터(빈 값 = 전체)
  const isAdmin = hasRole('admin');
  const arrayKey = tab === 'array' && segs[3] ? safeDecode(segs[3]) : '';
  const arrayDc = tab === 'array' && segs[4] ? safeDecode(segs[4]) : '';
  const openDetail = (row) => { window.location.hash = detailHash(row.key, row.datacenterId || ''); };
  const backToList = () => setTab('list');
  return (
    <div className="sst">
      {tab === 'array'
        ? <ArrayDetail arrayKey={arrayKey} dcId={arrayDc === DC_SEG_NONE ? '' : arrayDc} onBack={backToList} />
        : (
          <>
            <Header tab={tab} setTab={setTab} isAdmin={isAdmin} />
            {tab === 'list' && <ListTab dc={dc} setDc={setDc} onOpen={openDetail} isAdmin={isAdmin} />}
            {tab === 'check' && <SanStorageCheck dc={dc} setDc={setDc} onOpen={openDetail} isAdmin={isAdmin} />}
            {tab === 'mapping' && <SanStorageMapping dc={dc} isAdmin={isAdmin} />}
          </>
        )}
    </div>
  );
}
function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }

function Header({ tab, setTab, isAdmin }) {
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  // '지금 수집' — 기존 SAN 포트 사용량 '지금 수집'(중앙 직접은 즉시 · 엣지 위임은 재수집 요청)을 그대로 쓴다(새 수집 경로를 만들지 않는다).
  const collectNow = async () => {
    setBusy(true); setMsg('');
    try { const r = await postJson('/tools/sanswitch/perf/collect', {}); setMsg(r?.message || r?.reason || '수집 요청을 보냈습니다 — 결과는 다음 갱신에 반영됩니다.'); }
    catch (e) { setMsg(e.message || '수집 요청 실패'); }
    finally { setBusy(false); }
  };
  return (
    <>
      <div className="sst-head">
        <div style={{ minWidth: 0 }}>
          <h1>SAN 스토리지 성능</h1>
          <div className="sst-status muted">스위치 portperfshow 표본을 어레이 · 디렉터 · 컨트롤러 · 포트로 묶어 봅니다 · 어레이 측 busy% · IOPS 는 다음 판</div>
        </div>
        <div className="sst-acts">
          <a className="sst-btn" href="#/tools/san-switch" title="스위치 · 포트 용량 · 조닝 · 월간 점검 · 스토리지 트래픽 카드는 기존 도구에서">SAN 스위치 모니터링 ↗</a>
          {isAdmin && <button type="button" className="sst-btn" disabled={busy} onClick={collectNow} title="중앙 직접 스위치는 지금 수집 · 엣지 위임 스위치는 재수집 요청(기존 포트 사용량 수집 규약)">지금 수집</button>}
        </div>
      </div>
      {msg ? <div className="sst-note">{msg}</div> : null}
      <nav className="sst-tabs" aria-label="SAN 스토리지 성능 탭">
        {TABS.map(([k, label]) => (
          <button key={k} type="button" className={tab === k ? 'on' : ''} aria-current={tab === k ? 'page' : undefined} onClick={() => setTab(k)}>
            {label}{k === 'mapping' ? <span className="sst-lock">관리자</span> : null}
          </button>
        ))}
      </nav>
    </>
  );
}

/* ── 현황 ─────────────────────────────────────────────────────────────────────── */
function ListTab({ dc, setDc, onOpen }) {
  const [vendor, setVendor] = useState('');
  const [sortK, setSortK] = useState('now');
  const [q, setQ] = useState('');
  const params = dc ? { datacenterId: dc } : {};
  const { data, error, errorInfo } = usePolling('/tools/san-storage', params, LIST_POLL_MS, { timeoutMs: HEAVY_TIMEOUT_MS, retries: 0 });
  const rows = useMemo(() => sortRowsBy(filterRows(data?.rows || [], { vendor, q }), sortK), [data, vendor, q, sortK]);
  const kpis = useMemo(() => kpisOf(data), [data]);
  const now = Date.now();
  if (error && !data) return <ErrorBox message={error} info={errorInfo} />;
  if (!data) return <Loading label="SAN 스토리지 사용량을 불러오는 중입니다 — 최소 1분 이상 걸릴 수 있습니다(1시간 · 7일 집계 두 번)." />;
  const vendors = countBy(data.rows || [], (r) => r.vendor || 'other');
  const imb = (data.rows || []).filter((r) => r.imbalance);
  return (
    <>
      <div className="sst-row">
        <span className="sst-pill"><span className={`sst-dot${data.enabled !== false && data.lastSampleAt ? ' live' : ''}`} /><b>실시간</b> {liveText({ lastSampleAt: data.lastSampleAt, intervalMs: data.intervalMs, pollMs: LIST_POLL_MS, now })}</span>
        <span className="sst-pill" title="집계 표(15분 · 1시간)와 원본 자투리 — 서버가 어디서 읽었는지"><b>읽은 곳</b> {data.source?.kind === 'rollup' ? `집계 표${data.source.headApprox ? ' + 원본 자투리(머리 어림)' : ' + 원본 자투리'}` : '원본'}{data.computedAt ? ` · 계산 ${clockText(data.computedAt)}` : ''} · 기억 {intervalText(data.cacheTtlMs) || '—'}</span>
        {data.demo ? <span className="sst-tag blue">데모 데이터 — 수식으로 만든 값</span> : null}
        {data.addressHidden ? <span className="sst-tag gray" title="관리자가 아니라 스위치 관리 주소는 가려져 옵니다">주소 가림</span> : null}
      </div>
      {data.enabled === false && (
        <div className="sst-info">포트 사용량 수집이 꺼져 있습니다 — 설정 › 수집 주기·임계 › SAN 스위치 포트 사용량에서 켜면 {intervalText(data.intervalMs) || '주기'}마다 쌓기 시작합니다(기본 꺼짐). 아래 값은 마지막으로 쌓인 표본입니다.</div>
      )}
      {data.unavailable && <div className="sst-info">이 서버는 시계열 DB(node:sqlite)를 쓸 수 없어 이력이 저장되지 않습니다 — 값 전부 '—'.</div>}
      <div className="sst-kpis">
        {kpis.map((k) => (
          <div key={k.k} className={`sst-kpi ${k.tone}`}><div className="lb">{k.label}{k.sub ? <small>{k.sub}</small> : null}</div><div className="v">{k.value}{k.unit ? <small>{k.unit}</small> : null}</div><div className="m">{k.meta}</div></div>
        ))}
      </div>
      <div className="sst-card" style={{ gap: 8 }}>
        <div className="sst-filters">
          <span className="muted" style={{ fontSize: 12, minWidth: 36 }}>법인</span>
          <button type="button" className={`sst-chip${!dc ? ' on' : ''}`} onClick={() => setDc('')}>전체 <span className="n">{(data.allDatacenters || []).reduce((a, d) => a + (d.switches || 0), 0)}대</span></button>
          {(data.allDatacenters || []).map((d) => (
            <button key={d.id} type="button" className={`sst-chip${dc === d.id ? ' on' : ''}`} onClick={() => setDc(dc === d.id ? '' : d.id)} title={`스위치 ${d.switches}대`}>{d.name} <span className="n">{d.switches}</span></button>
          ))}
        </div>
        <div className="sst-filters">
          <span className="muted" style={{ fontSize: 12, minWidth: 36 }}>벤더</span>
          <div className="sst-seg" role="group" aria-label="벤더">
            <button type="button" className={!vendor ? 'on' : ''} onClick={() => setVendor('')}>전체 {(data.rows || []).length}</button>
            {[['powermax', 'PowerMax · VMAX'], ['powerstore', 'PowerStore'], ['unity', 'Unity'], ['other', '그 밖']].map(([k, l]) => (
              <button key={k} type="button" className={vendor === k ? 'on' : ''} onClick={() => setVendor(vendor === k ? '' : k)}>{l} {vendors[k] || 0}</button>
            ))}
          </div>
          <span className="muted" style={{ fontSize: 12, marginLeft: 10 }}>정렬</span>
          <div className="sst-seg mint" role="group" aria-label="정렬">
            {SORTS.map(([k, l]) => <button key={k} type="button" className={sortK === k ? 'on' : ''} onClick={() => setSortK(k)}>{l}</button>)}
          </div>
          <label className="sst-search" style={{ marginLeft: 'auto' }}><span aria-hidden="true">⌕</span><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="스토리지 · 시리얼 · 스위치 검색" aria-label="검색" /></label>
        </div>
      </div>

      <div className="sst-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="sst-cardhead" style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-soft)' }}>
          <div className="sst-title"><h4>스토리지 어레이 {(data.rows || []).length}대</h4><span className="muted" style={{ fontSize: 12.5 }}>· 팹 A/B 스위치를 합친 값 · 행을 누르면 상세</span>
            {imb.length ? <span className="sst-tag warn">편중 {imb.length}</span> : null}
            {data.totals?.unmeasured ? <span className="sst-tag gray">측정 없음 {data.totals.unmeasured}</span> : null}
            {data.edgeMissing ? <span className="sst-tag crit">엣지 미보고 {data.edgeMissing}</span> : null}
          </div>
          <span className="muted" style={{ fontSize: 12 }}>호스트(HBA)로 분류된 연결 대상 {data.counts?.host ?? 0}개는 이 표에 없습니다 — 어레이인데 호스트로 잡혔으면 '분류 · 매핑' 탭에서 지정</span>
        </div>
        <div className="sst-table-wrap">
          <STable minWidth={1040}>
            <thead><tr>
              <th>법인</th><th>스토리지</th><th>디렉터 · 컨트롤러</th><th className="r">지금</th><th>회선 사용률</th><th data-nosort>최근 1시간</th><th className="r" title="아래 줄은 24시간 피크">24시간 평균</th><th className="r">7일 대비</th><th className="r">용량</th><th>상태</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => {
                const st = stateTag(r); const im = imbalanceTag(r); const d = deltaOf(r.delta7d);
                const parsedDirs = (r.directors || []).filter((x) => x.parsed);
                return (
                  <tr key={`${r.datacenterId}|${r.key}`} className={`click${im ? ' warn' : ''}${st.tone === 'crit' ? ' bad' : ''}${st.code !== 'ok' && st.code !== 'stale' ? ' dim' : ''}`} onClick={() => onOpen(r)} title="상세 보기">
                    <td><b>{r.datacenterName || '—'}</b></td>
                    <td data-sort={r.name}><div className="sst-name">{r.name}</div><div className="sst-sub mono" title={`${r.vendorLabel} · ${r.serial ? `S/N ${r.serial}` : r.key} · 포트 ${(r.switches || []).map((s) => `${s.name} ${s.ports}`).join(' / ') || r.portCount}${(r.ports || []).find((p) => p.speed)?.speed ? ` · ${(r.ports || []).find((p) => p.speed).speed}` : ''}${r.kindBasis === 'manual' ? ' · 수동 분류' : ''}`}><span className={`sst-vend ${r.vendor || 'other'}`}>{VENDOR_SHORT[r.vendor] || r.vendorLabel}</span> {r.serial || r.key} · 포트 {(r.switches || []).map((s) => s.ports).join('/') || r.portCount}{r.kindBasis === 'manual' ? ' · 수동' : ''}</div></td>
                    <td data-sort={parsedDirs.length} title={parsedDirs.map((x) => x.group).join(' · ')}>{parsedDirs.length ? <><b>{parsedDirs.length}</b><div className="sst-sub">{parsedDirs.map((x) => x.group).join(' · ')}</div></> : <span className="muted">구분 못 함</span>}</td>
                    <td className="r mono" data-sort={r.now?.bps ?? ''} style={{ color: r.now?.bps != null ? 'var(--mint)' : undefined, fontWeight: 700 }}>{rateText(r.now?.bps)}</td>
                    <td data-sort={r.utilPct ?? ''}><div className="sst-bar"><div className="tr">{r.utilPct != null ? <span style={{ width: `${Math.min(100, r.utilPct)}%` }} /> : null}</div><span className="pct">{pctText(r.utilPct)}</span></div></td>
                    <td><Spark values={r.spark?.sum || []} /></td>
                    <td className="r mono" data-sort={r.avg24 ?? ''}>{rateText(r.avg24)}<div className="sst-sub" style={{ textAlign: 'right' }}>피크 <b>{rateText(r.peak24)}</b></div></td>
                    <td className="r" data-sort={r.delta7d ?? ''} title={deltaNote(r, data.minPrevHours)}><span className={`sst-delta ${d.tone}`}>{d.text}</span></td>
                    <td className="r mono" data-sort={r.capacity?.pct ?? ''} title={r.capacity ? `${r.capacity.name} (${r.capacity.type})` : '등록 스토리지와 시리얼이 일치하지 않아 용량을 붙이지 않았습니다'}>{r.capacity?.pct != null ? `${Math.round(r.capacity.pct)}%` : '—'}</td>
                    <td data-sort={st.code}><div className="sst-tags"><span className={`sst-tag ${st.tone}`}>{st.text}</span>{im ? <span className={`sst-tag ${im.tone}`}>{im.text}</span> : null}{(r.switches || []).some((s) => s.agent) ? <span className="sst-tag gray" title="엣지가 중계한 표본">엣지</span> : null}</div></td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={10}><div className="sst-empty"><b>어레이가 없습니다</b><span>{(data.rows || []).length ? '필터 · 검색 조건에 맞는 어레이가 없습니다.' : emptyWhy(data)}</span></div></td></tr>}
            </tbody>
          </STable>
        </div>
        <div className="sst-foot" style={{ padding: '10px 18px', borderTop: '1px solid var(--border-soft)' }}>
          지금 = 수집 주기({intervalText(data.intervalMs) || '—'}) 안에서 팹 A/B 표본이 다 모인 마지막 칸 · 회선 사용률 = 송수신 합 ÷ 연결 포트 속도 합(포트 사용량 탭 '포화도' 와 같은 계산 · FC 는 전이중이라 이론상 200% 까지) · 모르는 값('—')은 정렬에서 항상 뒤
        </div>
      </div>

      <div className="sst-two">
        <div className="sst-card">
          <h4>편중 경고 {imb.length}건 · 디렉터 · 컨트롤러</h4>
          {imb.length ? imb.map((r) => (
            <div key={r.key} className="sst-alert"><div className="ic">!</div><div><b>{r.name}</b> — {r.imbalance.group} 가 어레이 디렉터 평균의 {r.imbalance.ratio}배(24시간 평균). 호스트 멀티패스 쏠림 · 볼륨 노드 친화도 · 한쪽 포트 다운이 흔한 원인이지만 여기서 단정하지 않습니다. <a href={detailHash(r.key, r.datacenterId)}>디렉터별 보기 →</a></div></div>
          )) : <div className="sst-note">편중으로 판정된 어레이가 없습니다.</div>}
          <div className="sst-note">판정: 디렉터 평균 {rateText(data.imbalanceRule?.minBps)} 이상 · 한 디렉터가 평균의 {data.imbalanceRule?.ratio}배 이상(포트 사용량 탭과 같은 상수 — API 값) · '지금' 이 아니라 <b>24시간 평균</b>으로 봅니다.</div>
        </div>
        <div className="sst-card">
          <h4>합계 · 상태</h4>
          <div className="sst-note">지금 합계 <b>{rateText(data.totals?.nowBps)}</b>{data.totals?.nowTs ? ` (${clockText(data.totals.nowTs)} 칸)` : ''} · 1시간 평균 <b>{rateText(data.totals?.avgBps)}</b> · 최고 <b>{rateText(data.totals?.peak?.bps)}</b>{data.totals?.peak?.ts ? ` (${clockText(data.totals.peak.ts)})` : ''}{dayTB(data.totals?.avgBps) != null ? ` · 하루 환산 약 ${dayTB(data.totals.avgBps).toFixed(1)} TB` : ''}</div>
          <div className="sst-note">SAN 스위치 모니터링의 '스토리지 트래픽' 카드와 같은 함수로 낸 값입니다 — 두 숫자가 다르면 결함입니다. 부분 합으로 비운 칸 {data.totals?.partialBuckets ?? 0} · 보고 멈춘 시리즈 {data.totals?.heldSeries ?? 0} · 없어진 시리즈 {data.totals?.retiredSeries ?? 0}.</div>
          {data.mapStatus?.kinds || data.mapStatus?.directors ? <div className="sst-note">관리자 재정의 — 분류 {data.mapStatus.kinds} · 디렉터 매핑 {data.mapStatus.directors}</div> : null}
        </div>
      </div>
      <div className="sst-foot">
        스위치가 portperfshow 로 보고한 포트 바이트/초(송수신 합)를 bps 로 환산해, 팹 A/B 스위치를 합쳐 스토리지 어레이가 물린 포트만 더한 값입니다. 서버 HBA 포트는 같은 트래픽의 반대편이라 더하지 않습니다.
        디렉터 · 컨트롤러는 어레이가 스위치 네임서버에 등록한 포트 이름(FA-1D · NodeA · SPA …)으로 묶습니다. 캡처 시각이 어긋난 칸은 직전 표본을 수집 주기의 2배 안에서만 이어 쓰고, 그보다 오래 빠진 구간은 부분 합을 그리지 않습니다. 값이 없으면 0 이 아니라 '—' 입니다.
      </div>
    </>
  );
}
function countBy(list, f) { const o = {}; for (const x of list) { const k = f(x); o[k] = (o[k] || 0) + 1; } return o; }
function emptyWhy(data) {
  if (data.enabled === false) return '포트 사용량 수집이 꺼져 있어 표본이 없습니다.';
  if (data.unavailable) return '시계열 DB 를 열 수 없습니다.';
  if ((data.counts?.host || 0) > 0) return `어레이로 분류된 연결 대상이 없습니다(호스트 ${data.counts.host}개는 있습니다) — 평평한 이름의 어레이는 '분류 · 매핑' 탭에서 어레이로 지정할 수 있습니다.`;
  return '이 범위에서 수집된 포트 사용량이 없습니다 — 첫 주기(수집 주기 + 엣지 설정 pull) 뒤에 채워지거나, 장비 상세의 사용량 분석 탭이 사유를 말합니다.';
}
function Spark({ values }) {
  const segs = sparkSegments(values, 88, 26);
  if (!segs.length) return <span className="faint" style={{ fontSize: 11.5 }}>표본 없음</span>;
  return <svg className="sst-spark" viewBox="0 0 88 26" role="img" aria-label="최근 1시간 처리량 추이">{segs.map((p, i) => <polyline key={i} fill="none" stroke="var(--accent)" strokeWidth="1.6" points={p} />)}</svg>;
}

/* ── 어레이 상세 ───────────────────────────────────────────────────────────────── */
function ArrayDetail({ arrayKey, dcId, onBack }) {
  const [rangeK, setRangeK] = useState('24h');
  const [back, setBack] = useState(0);
  const [mode, setMode] = useState('avg');
  const [grouping, setGrouping] = useState('director');
  const [week, setWeek] = useState(null);     // 요일 × 시간용 7일(1시간 칸)
  const [hover, setHover] = useState(null);
  const plotRef = useRef(null);
  const range = rangeOf(rangeK);
  // 조회 파라미터는 (어레이 · 법인 · 기간 · 창) 이 바뀔 때만 다시 만든다 — 과거 창의 from/to 는 그때의 시각으로 고정(매 렌더 바뀌면 폴러가 계속 다시 읽는다).
  const query = useMemo(() => ({ key: arrayKey, datacenterId: dcId || NONE_DC, ...rangeQuery(rangeK, { back }) }), [arrayKey, dcId, rangeK, back]);
  // 실시간 창(최신 1시간)만 주기 갱신 — 과거 창 · 긴 창은 열 때 1회(무거운 API 15초 폴링 금지 · usePolling 의 0 = 1회).
  const { data, error } = usePolling(arrayKey ? '/tools/san-storage/array' : null, query, range.live && back === 0 ? LIST_POLL_MS : 0, HEAVY_FETCH_OPTS);
  useEffect(() => {
    if (!arrayKey) return undefined;
    const ac = new AbortController();
    fetchJson('/tools/san-storage/array', { key: arrayKey, datacenterId: dcId || NONE_DC, hours: 168 }, ac.signal, { timeoutMs: HEAVY_TIMEOUT_MS, retries: 0 })
      .then((d) => { if (!ac.signal.aborted) setWeek(d); }).catch(() => { if (!ac.signal.aborted) setWeek({ error: true }); });
    return () => ac.abort();
  }, [arrayKey, dcId]);
  const peak = mode === 'peak';
  const series = useMemo(() => {
    if (!data) return [];
    const val = (g) => (peak ? g.peak : g.sum);
    if (grouping === 'total') return [{ key: 'total', label: '합계', color: vizColor(0), values: val(data) }];
    if (grouping === 'director') return foldSeries((data.directors || []).map((g) => ({ key: g.group, label: `${g.group}${g.confidence === 'manual' ? ' (수동)' : ''}`, values: val(g) })));
    if (grouping === 'fabric') return foldSeries((data.fabrics || []).map((g) => ({ key: g.deviceId, label: g.name, values: val(g) })));
    return foldSeries((data.ports || []).map((p) => ({ key: `${p.deviceId}:${p.port}`, label: `${p.deviceName}:${p.port} ${p.group}`, values: peak ? p.peak : p.avg })), 4);
  }, [data, grouping, peak]);
  const model = useMemo(() => (data ? stackModel(data.buckets || [], series, { w: 1140, h: 240 }) : null), [data, series]);
  const stats = useMemo(() => (data ? seriesStats(data.sum || [], data.peak || [], data.buckets || [], { until: data.until, carryMs: data.carryMs, bucketMs: data.bucketMs }) : null), [data]);
  const heat = useMemo(() => (week && !week.error && week.buckets ? foldHeatmap(week.buckets, week.sum, week.offsetMin ?? 540) : null), [week]);
  const weekStats = useMemo(() => (week && !week.error && week.buckets ? seriesStats(week.sum || [], week.peak || [], week.buckets || [], { until: week.until }) : null), [week]);
  if (!arrayKey) return <div className="sst-empty"><b>어레이 키가 없습니다</b><button type="button" className="sst-btn sm" onClick={onBack}>← 현황</button></div>;
  const onMove = (e) => {
    if (!model || !plotRef.current) return;
    const r = plotRef.current.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * model.w;
    const frac = (px - model.padL) / (model.w - model.padL - model.padR);
    const i = Math.max(0, Math.min(model.n - 1, Math.round(frac * (model.n - 1))));
    setHover(i);
  };
  const dirCards = (data?.directors || []).map((g) => ({ ...g, stats: seriesStats(peak ? g.peak : g.sum, g.peak, data.buckets, { until: data.until, carryMs: data.carryMs, bucketMs: data.bucketMs }) }));
  const dirMean = (() => { const v = dirCards.map((d) => d.stats.avg).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; })();
  const speedSum = (data?.ports || []).reduce((a, p) => a + (speedBps(p.speed) || 0), 0);
  const downloadCsv = () => {
    if (!data) return;
    const blob = new Blob([csvText(data.buckets, data.sum, series)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = csvFileName(data.key, rangeK, data.until || Date.now()); a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const ticks = model ? tickLabels(data.buckets, 6) : [];
  return (
    <>
      <div className="sst-crumb"><button type="button" className="sst-btn sm" onClick={onBack}>← 현황</button> <span className="faint">·</span> 스토리지 <span className="faint">›</span> SAN 스토리지 성능 <span className="faint">›</span> <b className="mono">{data?.name || arrayKey}</b></div>
      {error && <ErrorBox message={error} />}
      {!error && !data && <Loading label="어레이 시계열을 불러오는 중입니다." />}
      {data && (
        <>
          <div className="sst-head">
            <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <h1><span className={`sst-vend ${data.vendor}`} style={{ height: 22, fontSize: 12 }}>{data.vendorLabel}</span>{data.name}{data.demo ? <span className="sst-tag blue">데모</span> : null}</h1>
              <div className="sst-meta">
                <span>S/N <b className="mono">{data.serial || '—'}</b></span><span>법인 <b>{data.datacenterName}</b></span>
                <span>스위치 {(data.switches || []).map((s) => <b key={s.id} style={{ marginRight: 6 }}>{s.name}{s.agent ? <span className="faint"> (엣지)</span> : null}</b>)}</span>
                <span>포트 <b>{(data.ports || []).length}</b></span>
                <span>디렉터 · 컨트롤러 <b>{(data.directors || []).filter((g) => g.parsed).length}</b>{(data.directors || []).some((g) => !g.parsed) ? <span className="faint"> · 구분 못 함 {(data.directors || []).find((g) => !g.parsed)?.ports}포트</span> : null}</span>
                {data.capacity ? <span>용량 <b>{data.capacity.pct != null ? `${Math.round(data.capacity.pct)}%` : '—'}</b> <a href="#/tools/storage-mon">스토리지 현황 ↗</a></span> : <span className="faint">용량 — 등록 스토리지와 시리얼 불일치</span>}
              </div>
            </div>
            <div className="sst-acts">
              <a className="sst-btn" href="#/tools/san-switch" title="SAN 스위치 모니터링 › 장비 상세 › 포트 배치 · 조닝">포트 배치 · 조닝 ↗</a>
              <a className="sst-btn" href="#/tools/san-flow" title="SAN 플로우 모니터(Flow Vision) — 이 어레이 타깃으로 가는 호스트별 실측 플로우">호스트별 플로우 ↗</a>
              {canCsv() && <button type="button" className="sst-btn" onClick={downloadCsv}>CSV</button>}
            </div>
          </div>
          <div className="sst-row">
            <div className="sst-filters">
              <div className="sst-seg mint" role="group" aria-label="기간">{RANGES.map((r) => <button key={r.k} type="button" className={rangeK === r.k ? 'on' : ''} onClick={() => { setRangeK(r.k); setBack(0); }}>{r.label}</button>)}</div>
              <div className="sst-seg" role="group" aria-label="기준">{MODES.map(([k, l]) => <button key={k} type="button" className={mode === k ? 'on' : ''} onClick={() => setMode(k)}>{l}</button>)}</div>
              <div className="sst-seg" role="group" aria-label="묶음">{GROUPINGS.map(([k, l]) => <button key={k} type="button" className={grouping === k ? 'on' : ''} onClick={() => setGrouping(k)}>{l}</button>)}</div>
            </div>
            <div className="sst-filters">
              <span className="sst-pill"><span className={`sst-dot${range.live && back === 0 && stats && !stats.stale && stats.now != null ? ' live' : ''}`} /><b>{range.live && back === 0 ? '실시간' : '구간'}</b> {stats?.nowTs ? `마지막 표본 ${agoShort(Date.now() - stats.nowTs)}` : '표본 없음'} · 주기 {intervalText(data.intervalMs) || '—'}{range.live && back === 0 ? ` · ${intervalText(LIST_POLL_MS)}마다 다시 읽음` : ' · 자동 갱신 없음'}</span>
              <span className="sst-pill"><b>{intervalText(data.bucketMs) || '—'} 칸</b> · {(data.buckets || []).length}점 · {data.source?.kind === 'rollup' ? '집계 표' : '원본'}</span>
            </div>
          </div>
          {data.rangeIssue && <div className="sst-info">기간 지정 무시됨: {data.rangeIssue} — 최근 24시간으로 표시합니다.</div>}
          <div className="sst-stats">
            <Stat label="지금" sub={stats?.nowTs ? `${clockText(stats.nowTs)} 칸${stats.stale ? ' · 오래됨' : ''}` : '칸 없음'} value={rateText(stats?.now)} tone={stats?.now != null ? 'mint' : ''}
              mm={[speedSum ? ['회선', stats?.now != null ? pctText((stats.now / speedSum) * 100) : '—', `/ ${rateText(speedSum)}`] : ['회선', '—', '포트 속도 모름'], stats?.avg ? ['구간 평균 대비', stats?.now != null ? `${Math.round(((stats.now - stats.avg) / stats.avg) * 100)}%` : '—'] : null]} />
            <Stat label={`${range.label} 평균`} sub={`${stats?.measured ?? 0}/${stats?.total ?? 0}칸`} value={rateText(stats?.avg)} mm={[dayTB(stats?.avg) != null ? ['하루 환산', `약 ${dayTB(stats.avg).toFixed(1)} TB`] : null, data.partialBuckets ? ['부분 합 제외', `${data.partialBuckets}칸`] : null]} />
            <Stat label="최고" sub="평균 기준" value={rateText(stats?.max)} mm={[stats?.maxTs ? ['시각', dateClockText(stats.maxTs)] : null, ['피크 기준 최고', rateText(stats?.peakMax)]]} />
            <Stat label="7일 대비" sub="이번 24시간 ÷ 지난 7일 하루 평균" value={weekDelta(weekStats, week)?.text || '—'} tone={weekDelta(weekStats, week)?.tone === 'up' ? 'warn' : ''} mm={[['지난 7일 평균', rateText(weekStats?.avg)], ['7일 최고', rateText(weekStats?.max)]]} />
          </div>
          <div className="sst-card">
            <div className="sst-cardhead">
              <div className="sst-title"><h4>처리량 추이 — {GROUPINGS.find(([k]) => k === grouping)?.[1]}{grouping !== 'total' ? ' 쌓기' : ''}</h4><span className="sst-tag gray">{intervalText(data.bucketMs)} {peak ? '피크' : '평균'}</span><span className="muted" style={{ fontSize: 12 }}>세로축 Gb/s · 송수신 합</span></div>
              <div className="sst-legend">{series.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}{stats?.avg != null && grouping === 'total' ? <span><em />구간 평균 {rateText(stats.avg)}</span> : null}{model?.gaps?.length ? <span><i style={{ background: 'repeating-linear-gradient(135deg, var(--border) 0 3px, transparent 3px 6px)' }} />부분 합 · 결측 {model.gaps.length}칸 — 그리지 않음</span> : null}</div>
            </div>
            {model && model.n > 1 ? (
              <div className="sst-plot" ref={plotRef} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
                <svg viewBox={`0 0 ${model.w} ${model.h + 22}`} role="img" aria-label="처리량 추이 차트">
                  <defs><pattern id="sst-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2" height="6" fill="var(--border)" /></pattern></defs>
                  {[0, 0.25, 0.5, 0.75, 1].map((f) => <g key={f}><line x1={model.padL} x2={model.w - model.padR} y1={model.y(model.yMax * f)} y2={model.y(model.yMax * f)} stroke="var(--border-soft)" /><text x={model.padL - 8} y={model.y(model.yMax * f) + 4} textAnchor="end">{fmtAxis(model.yMax * f)}</text></g>)}
                  {model.gaps.map((i) => <rect key={i} x={model.x(i) - (model.w - model.padL - model.padR) / Math.max(1, model.n - 1) / 2} y={model.padT} width={(model.w - model.padL - model.padR) / Math.max(1, model.n - 1)} height={model.h - model.padT - model.padB} fill="url(#sst-hatch)" />)}
                  {model.areas.map((a) => <path key={a.key} d={a.d} fill={a.color} fillOpacity={grouping === 'total' ? 0.18 : 0.85} stroke={grouping === 'total' ? a.color : 'none'} strokeWidth={grouping === 'total' ? 1.6 : 0} />)}
                  {grouping === 'total' && stats?.avg != null ? <line x1={model.padL} x2={model.w - model.padR} y1={model.y(gbps(stats.avg))} y2={model.y(gbps(stats.avg))} stroke="var(--text-dim)" strokeDasharray="4 4" /> : null}
                  {hover != null ? <line x1={model.x(hover)} x2={model.x(hover)} y1={model.padT} y2={model.h - model.padB} stroke="var(--text)" strokeOpacity=".5" strokeDasharray="2 3" /> : null}
                  {ticks.map((t) => <text key={t.i} x={model.x(t.i)} y={model.h + 12} textAnchor="middle">{t.label}</text>)}
                </svg>
                {hover != null && (
                  <div className="sst-card" style={{ position: 'absolute', top: 8, left: model.x(hover) > model.w / 2 ? undefined : `${(model.x(hover) / model.w) * 100 + 1}%`, right: model.x(hover) > model.w / 2 ? `${100 - (model.x(hover) / model.w) * 100 + 1}%` : undefined, padding: '8px 10px', gap: 2, fontSize: 12, minWidth: 180, pointerEvents: 'none', background: 'var(--panel-2)' }}>
                    <div className="mono" style={{ fontWeight: 600 }}>{dateClockText(data.buckets[hover])} · 합계 {rateText((peak ? data.peak : data.sum)[hover])}</div>
                    {series.map((s) => <div key={s.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><span><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: s.color, marginRight: 6 }} />{s.label}</span><b className="mono">{rateText(s.values?.[hover])}</b></div>)}
                  </div>
                )}
              </div>
            ) : <div className="sst-empty"><b>그릴 값이 없습니다</b><span>{data.enabled === false ? '포트 사용량 수집이 꺼져 있습니다.' : '이 기간에 이 어레이 포트의 표본이 없습니다 — 0 이 아닙니다.'}</span></div>}
            <div className="sst-win">
              <button type="button" className="sst-btn sm" disabled={range.live} onClick={() => setBack((b) => b + 1)} title={range.live ? '실시간 창은 최근 1시간만 보관합니다' : ''}>◀ 이전 {range.label}</button>
              <button type="button" className="sst-btn sm" disabled={back <= 0} onClick={() => setBack((b) => Math.max(0, b - 1))}>다음 ▶</button>
              <button type="button" className="sst-btn sm" disabled={back <= 0} onClick={() => setBack(0)}>최신</button>
              <span>{windowLabel(rangeK, back)} · {data.since ? dateClockText(data.since) : '—'} ~ {data.until ? dateClockText(data.until) : '—'}{back > 0 ? ' · 과거 구간은 자동 갱신하지 않습니다' : ''} · 15분 집계 31일 · 1시간 집계는 설정 보관 기간까지</span>
            </div>
          </div>

          <div className="sst-card">
            <div className="sst-cardhead"><div className="sst-title"><h4>디렉터 · 컨트롤러별 — {dirCards.filter((d) => d.parsed).length}</h4><span className="muted" style={{ fontSize: 12 }}>{range.label} {peak ? '피크' : '평균'} 기준 · 배수 = 디렉터 평균 대비</span></div>
              {dirMean != null && dirCards.some((d) => d.stats.avg != null && d.stats.avg / dirMean >= 1.4) ? <span className="sst-tag warn">편중 후보 — 1.4배 이상</span> : <span className="sst-tag ok">편중 없음</span>}</div>
            <div className="sst-dirs">
              {dirCards.map((g, i) => (
                <div key={g.group} className="sst-dir">
                  <div className="h"><b><i style={{ background: vizColor(i) }} />{g.group}{g.confidence === 'manual' ? <span className="sst-tag blue">수동</span> : null}{!g.parsed ? <span className="sst-tag gray">구분 못 함</span> : null}</b><span className="sst-tag gray">{g.stats.avg != null && dirMean ? `${(g.stats.avg / dirMean).toFixed(2)}×` : '—'}</span></div>
                  <div className="v">{rateText(g.stats.now)}<small>지금</small></div>
                  <Spark values={peak ? g.peak : g.sum} />
                  <div className="kv"><span>포트</span><b>{g.ports}</b><span>평균 / 최고</span><b>{rateText(g.stats.avg)} / {rateText(g.stats.max)}</b></div>
                </div>
              ))}
              {!dirCards.length && <div className="sst-note">포트별 표본이 없어 디렉터를 묶지 못했습니다.</div>}
            </div>
            <div className="sst-note">디렉터 이름은 어레이가 네임서버에 등록한 포트 심볼릭 이름의 셋째 조각(예 SYMMETRIX::시리얼::<b>FA-1D</b> 4)입니다. 못 읽은 포트는 '(구분 못 함)' 한 그룹 — 추정하지 않으며 '분류 · 매핑' 탭에서 사람이 지정할 수 있습니다.</div>
          </div>

          <div className="sst-two">
            <div className="sst-card">
              <div className="sst-cardhead"><div className="sst-title"><h4>포트 {(data.ports || []).length}</h4></div><span className="muted" style={{ fontSize: 12 }}>피크 포화도 = 표본 최댓값 ÷ 포트 속도(포트 사용량 탭과 같은 계산)</span></div>
              <div className="sst-table-wrap">
                <STable minWidth={520}>
                  <thead><tr><th>디렉터 · 어레이 포트</th><th>스위치 : 포트</th><th>속도</th><th className="r">평균</th><th className="r">최고(피크)</th><th className="r">피크 포화도</th></tr></thead>
                  <tbody>
                    {(data.ports || []).map((p) => {
                      const cap = speedBps(p.speed);
                      const sat = cap && p.maxPeak != null ? (p.maxPeak / cap) * 100 : null;
                      return (
                        <tr key={`${p.deviceId}:${p.port}`}>
                          <td className="mono" data-sort={`${p.group}|${p.directorPort || ''}`}>{p.group}{p.confidence === 'manual' ? ' *' : ''}{p.directorPort ? <span className="faint"> {p.directorPort}</span> : null}</td><td className="mono" data-sort={`${p.deviceName}:${p.port}`}>{p.deviceName}<span className="faint">:{p.port}</span></td><td className="mono">{p.speed || '—'}</td>
                          <td className="r mono" data-sort={p.avgTotal ?? ''}>{rateText(p.avgTotal)}</td><td className="r mono" data-sort={p.maxPeak ?? ''}>{rateText(p.maxPeak)}</td>
                          <td className="r mono" data-sort={sat ?? ''} style={{ color: sat != null && sat >= 90 ? '#fca5a5' : sat != null && sat >= 70 ? '#fcd34d' : undefined }}>{pctText(sat)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </STable>
              </div>
            </div>
            <div className="sst-card">
              <div className="sst-cardhead"><div className="sst-title"><h4>요일 × 시간 — 지난 7일 평균</h4><span className="muted" style={{ fontSize: 12 }}>칸 = 1시간 평균 · 포탈 하루 기준 · 빈 칸은 평균에서 뺌</span></div>{heat?.max != null ? <span className="muted" style={{ fontSize: 11 }}>최대 {rateText(heat.max)}</span> : null}</div>
              {heat ? (
                <>
                  <div className="sst-hm" role="img" aria-label="요일별 시간대 평균 처리량 히트맵">
                    {heat.cells.map((row, d) => (
                      <React.Fragment key={d}>
                        <span className="d">{heat.days[d]}</span>
                        {row.map((c, h) => <i key={h} className={c.avg == null ? 'none' : ''} style={c.avg == null ? undefined : { opacity: Math.max(0.08, c.avg / (heat.max || 1)) }} title={`${heat.days[d]} ${h}시 · ${c.avg == null ? '값 없음' : `${rateText(c.avg)} (${c.n}칸)`}`} />)}
                      </React.Fragment>
                    ))}
                    <span />{Array.from({ length: 24 }, (_, h) => <span key={h} className="x">{h % 3 === 0 ? h : ''}</span>)}
                  </div>
                  <div className="sst-note">{heat.busiest ? <>가장 바쁜 칸 <b>{heat.days[heat.busiest.day]} {heat.busiest.hour}시</b> — {rateText(heat.busiest.avg)}</> : '값이 있는 칸이 없습니다.'}</div>
                </>
              ) : week?.error ? <div className="sst-note">7일 집계를 불러오지 못했습니다.</div> : <Loading label="7일 집계" />}
            </div>
          </div>

          <ArraySidePanel side={data.arraySide} />
          <div className="sst-foot">
            '지금' 은 수집 주기({intervalText(data.intervalMs) || '—'}) 안에서 팹 A/B 스위치 표본이 모두 들어온 마지막 칸의 값입니다. 캡처 시각이 어긋난 칸은 직전 표본을 수집 주기의 2배 안에서만 이어 쓰고, 그보다 오래 빠진 칸은 부분 합을 그리지 않습니다(빗금). 과거 구간(◀ 이전)은 자동 갱신하지 않습니다.
          </div>
        </>
      )}
    </>
  );
}
/* ── 어레이가 보고하는 디렉터 · 노드 · SP 성능(v2.952 ⓑ) ───────────────────────────
 * 서버 arraySide(sanswitch/arraySideLoad.js): 시리얼로 짝 지은 스토리지 장비의 5분 표본. 값이 없으면 사유 문구만(지어내지 않는다).
 * 단위 카드 = 부모 단위(디렉터 · 노드 · SP) · 선 차트 = 고른 지표 하나(단위가 달라 겹치지 않는다) · 포트 표 = Unity · PowerStore 포트 단위 · 보고 대조 = 어레이 호스트 처리량 합 대 스위치 지금. */
function ArraySidePanel({ side }) {
  const [feMetric, setFeMetric] = useState('');
  const [hover, setHover] = useState(null);
  if (!side) return null;
  const metrics = feMetricsPresent(side);
  const sel = metrics.find((m) => m.k === feMetric) || metrics[0] || null;
  const units = side.units || [];
  const parents = units.filter((u) => u.kind !== 'port');
  const ports = units.filter((u) => u.kind === 'port');
  const cols = side.series?.cols || [];
  const toDisp = (k, v) => (v == null ? null : k === 'hbps' ? gbps(v) : v);
  const seriesList = sel ? parents.map((u, i) => ({ key: String(u.id), label: u.name, color: vizColor(i), values: (side.series?.byUnit?.[u.id]?.[sel.k] || []).map((v) => toDisp(sel.k, v)) })) : [];
  const model = sel && cols.length ? lineModel(cols, seriesList, { w: 1140, h: 200 }) : null;
  const ticks = tickLabels(cols, 6);
  const ready = side.eligible && !side.reason;
  const lastAgo = side.lastSampleTs ? agoShort(Date.now() - side.lastSampleTs) : null;
  const unitOf = (k) => FE_UNIT_TEXT[k] || '';
  const hoverIdx = hover != null && cols[hover] != null ? hover : null;
  return (
    <div className="sst-card">
      <div className="sst-cardhead">
        <div className="sst-title">
          <h4>어레이가 보고하는 디렉터 · 컨트롤러 성능</h4>
          {ready ? <span className="sst-tag ok" title="스토리지 수집기의 5분 표본(장비 호출 없이 DB 에서 읽음)">5분 표본</span> : <span className="sst-tag gray">값 없음</span>}
          <span className="sst-tag gray" title={side.docBasis || ''}>문서 기준 · 실장비 확인 전</span>
          {side.alerts != null ? <a className={`sst-tag ${side.alerts > 0 ? 'warn' : 'ok'}`} href="#/tools/storage-mon" title="스토리지 모니터링 › 장비 상세(미해결 알람)">미해결 알람 {side.alerts}</a> : null}
        </div>
        <span className="muted" style={{ fontSize: 12 }}>
          {side.name ? <>{side.name}{side.type ? ` (${side.type})` : ''}</> : '짝 지은 스토리지 없음'}{lastAgo ? ` · 마지막 표본 ${lastAgo} 전` : ''}{side.sampleMs ? ` · 표본 주기 ${intervalText(side.sampleMs)}` : ''}
        </span>
      </div>
      {!ready ? <div className="sst-note">{side.text || '어레이 측 값이 없습니다.'}{side.reason === 'no-device' ? ' — 스토리지 모니터링에 이 어레이를 등록(REST)하면 시리얼로 짝을 짓습니다.' : ''}</div> : (
        <>
          <div className="sst-row">
            <div className="sst-seg" role="tablist" aria-label="어레이 측 지표">
              {metrics.map((m) => <button type="button" key={m.k} className={sel?.k === m.k ? 'on' : ''} onClick={() => setFeMetric(m.k)}>{m.label}</button>)}
            </div>
            <span className="muted" style={{ fontSize: 12 }}>단위 {parents.length}{ports.length ? ` · 포트 ${ports.length}` : ''}{side.matched != null ? ` · SAN 대조 ${side.matched}/${parents.length}` : ''}</span>
          </div>
          <div className="sst-dirs">
            {parents.map((u, i) => (
              <div key={u.id} className="sst-dir">
                <div className="h">
                  <b><i style={{ background: vizColor(i) }} />{u.name}</b>
                  <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                    {u.group ? <span className="sst-tag ok" title="SAN 쪽 디렉터 묶음과 같은 이름(대소문자 · 구분자 무시)">SAN {u.group}</span> : <span className="sst-tag gray" title="SAN 포트 심볼릭 이름에서 이 단위를 찾지 못했습니다 — 억지로 합치지 않습니다">SAN 대조 없음</span>}
                    {u.stale ? <span className="sst-tag warn" title={u.ts ? `마지막 표본 ${dateClockText(u.ts)}` : '표본 없음'}>오래됨</span> : null}
                  </span>
                </div>
                <div className="v">{sel ? feValueText(sel.k, u.latest?.[sel.k]) : '—'}<small>{sel?.label || ''}</small></div>
                <div className="kv">
                  {metrics.filter((m) => m.k !== sel?.k && u.latest?.[m.k] != null).slice(0, 4).map((m) => <React.Fragment key={m.k}><span>{m.label}</span><b>{feValueText(m.k, u.latest[m.k])}</b></React.Fragment>)}
                </div>
              </div>
            ))}
            {!parents.length && <div className="sst-note">이 어레이의 단위(디렉터 · 노드 · SP)가 아직 없습니다.</div>}
          </div>
          {model ? (
            <div className="sst-plot" onMouseLeave={() => setHover(null)}>
              <svg viewBox={`0 0 ${model.w} ${model.h + 22}`} role="img" aria-label={`어레이 측 ${sel.label} 추이`}
                onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * model.w; const i = Math.round(((px - model.padL) / Math.max(1, model.w - model.padL - model.padR)) * (model.n - 1)); setHover(Math.max(0, Math.min(model.n - 1, i))); }}>
                {[0, 0.25, 0.5, 0.75, 1].map((f) => <g key={f}><line x1={model.padL} x2={model.w - model.padR} y1={model.y(model.yMax * f)} y2={model.y(model.yMax * f)} stroke="var(--border-soft)" /><text x={model.padL - 8} y={model.y(model.yMax * f) + 4} textAnchor="end">{sel.k === 'iops' ? Math.round(model.yMax * f).toLocaleString('en-US') : (Math.round(model.yMax * f * 10) / 10)}</text></g>)}
                {model.lines.map((l) => <g key={l.key}><path d={l.d} fill="none" stroke={l.color} strokeWidth="1.8" strokeLinejoin="round" />{l.points.map((p, j) => <circle key={j} cx={p.cx} cy={p.cy} r="2" fill={l.color} />)}</g>)}
                {hoverIdx != null ? <line x1={model.x(hoverIdx)} x2={model.x(hoverIdx)} y1={model.padT} y2={model.h - model.padB} stroke="var(--text-faint)" strokeDasharray="3 3" /> : null}
                {ticks.map((tk) => <text key={tk.i} x={model.x(tk.i)} y={model.h + 12} textAnchor="middle">{tk.label}</text>)}
                <text x={model.padL - 8} y={model.padT - 2} textAnchor="end" style={{ fontSize: 10 }}>{unitOf(sel.k)}</text>
              </svg>
              {hoverIdx != null ? (
                <div className="sst-card" style={{ position: 'absolute', top: 8, left: model.x(hoverIdx) > model.w / 2 ? undefined : `${(model.x(hoverIdx) / model.w) * 100 + 1}%`, right: model.x(hoverIdx) > model.w / 2 ? `${100 - (model.x(hoverIdx) / model.w) * 100 + 1}%` : undefined, padding: '8px 10px', gap: 2, fontSize: 12, minWidth: 180, pointerEvents: 'none', background: 'var(--panel-2)' }}>
                  <div className="mono muted">{dateClockText(cols[hoverIdx])}</div>
                  {seriesList.map((s) => <div key={s.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><span><i className="sst-sw" style={{ background: s.color }} />{s.label}</span><b className="mono">{s.values[hoverIdx] == null ? '—' : sel.k === 'hbps' ? `${s.values[hoverIdx].toFixed(2)} Gb/s` : feValueText(sel.k, s.values[hoverIdx])}</b></div>)}
                </div>
              ) : null}
            </div>
          ) : <div className="sst-note">이 창에 어레이 측 표본이 없습니다 — 0 이 아닙니다.</div>}
          <div className="sst-legend">{seriesList.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}{side.seriesKind ? <span className="faint">{side.seriesKind === 'raw' ? '표본 그대로' : side.seriesKind === 'bucket' ? '1시간 칸 평균' : '하루 평균'}{side.truncated ? ' · 일부 잘림' : ''}</span> : null}</div>
          {ports.length ? (
            <div className="sst-table-wrap">
              <STable minWidth={560}>
                <thead><tr><th>어레이 포트</th><th>단위</th><th>SAN 포트 대조</th><th className="r">IOPS</th><th className="r">처리량</th><th className="r">응답</th><th>표본</th></tr></thead>
                <tbody>
                  {ports.map((p) => (
                    <tr key={p.id}>
                      <td className="mono">{p.name}</td><td className="mono">{parents.find((x) => x.id === p.parent)?.name || '—'}</td>
                      <td>{p.group ? <span className="sst-tag ok">{p.group}{p.port ? ` ${p.port}` : ''}</span> : <span className="muted">—</span>}</td>
                      <td className="r mono" data-sort={p.latest?.iops ?? ''}>{feValueText('iops', p.latest?.iops)}</td>
                      <td className="r mono" data-sort={p.latest?.hbps ?? ''}>{feValueText('hbps', p.latest?.hbps)}</td>
                      <td className="r mono" data-sort={p.latest?.lat ?? ''}>{feValueText('lat', p.latest?.lat)}</td>
                      <td className="muted" style={{ fontSize: 11.5 }} data-sort={p.ts ?? ''}>{p.ts ? agoShort(Date.now() - p.ts) + ' 전' : '—'}{p.stale ? ' · 오래됨' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </STable>
            </div>
          ) : null}
          <div className="sst-note">
            보고 대조: 어레이가 보고한 호스트 처리량 합 <b>{rateText(side.compare?.arrayBps)}</b>{side.compare?.partial ? '(일부 단위 미측정 — 합계 없음)' : ''} · 스위치 지금 <b>{rateText(side.compare?.switchBps)}</b> · 차이 <b>{side.compare?.diffPct != null ? `${side.compare.diffPct > 0 ? '+' : ''}${side.compare.diffPct}%` : '—'}</b>
            {side.compare?.diffPct == null ? ' (둘 중 하나가 없거나 스위치가 한가해 비율을 내지 않습니다)' : ' — 차이의 원인(FC 프레임 헤더 · 제어 트래픽 · 한쪽 계측 누락)은 여기서 단정하지 않습니다. 판정은 성능 점검 탭의 보고 대조 항목.'}
          </div>
          {side.unmatchedGroups?.length ? <div className="sst-note">SAN 쪽에만 있는 묶음: <b>{side.unmatchedGroups.join(' · ')}</b> — 어레이 API 의 단위 이름과 달라 짝을 짓지 못했습니다(분류 · 매핑 탭에서 SAN 쪽 이름을 어레이 이름으로 바꾸면 맞습니다).</div> : null}
        </>
      )}
    </div>
  );
}

function Stat({ label, sub, value, tone = '', mm = [] }) {
  return (
    <div className="sst-stat">
      <div className="lb">{label}{sub ? <small>{sub}</small> : null}</div>
      <div className="v" style={tone === 'mint' ? { color: 'var(--mint)' } : tone === 'warn' ? { color: '#fcd34d' } : undefined}>{value}</div>
      <div className="mm">{mm.filter(Boolean).map(([k, v, extra], i) => <span key={i}>{k} <b>{v}</b>{extra ? ` ${extra}` : ''}</span>)}</div>
    </div>
  );
}
/** '16G' → 바이트/초(portUsage.capBpsOf 와 같은 계산 — 서버가 ports 에 capBps 를 싣지 않는 상세 응답용). */
function speedBps(speed) { const m = String(speed || '').match(/^(\d+)G$/); return m && Number(m[1]) > 0 ? (Number(m[1]) * 1e9) / 8 : null; }
function fmtAxis(g) { return g >= 10 ? g.toFixed(0) : g >= 1 ? g.toFixed(1) : g.toFixed(2); }
/** 7일 대비(상세) — 7일 집계의 24시간 창 ÷ 앞 6일(값 6시간 이상일 때만). */
function weekDelta(ws, week) {
  if (!ws || !week?.buckets?.length) return null;
  const until = week.until || week.buckets[week.buckets.length - 1];
  const cur = []; const prev = [];
  for (let i = 0; i < week.buckets.length; i++) { const v = week.sum?.[i]; if (v == null) continue; (week.buckets[i] >= until - 86_400_000 ? cur : prev).push(v); }
  if (!cur.length || prev.length < 6) return { text: '—', tone: 'none' };
  const a = cur.reduce((x, y) => x + y, 0) / cur.length; const p = prev.reduce((x, y) => x + y, 0) / prev.length;
  return p > 0 ? deltaOf(Math.round(((a - p) / p) * 100)) : { text: '—', tone: 'none' };
}
