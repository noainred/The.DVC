import React, { useState } from 'react';
import { usePolling } from '../api.js';
import { DataTable, UsageCell, StateBadge, Loading, ErrorBox, EntityDetail } from '../components/ui.jsx';
import IpmsMatches from '../components/IpmsMatches.jsx';
import { hostUsagePct } from './vcdOverview.js'; // v2.606 WEB2606-02: 끊긴·무응답 호스트의 0% 는 '못 읽음'(—)
import { serverRatio, ratioLabel } from './virtRatioText.js'; // v2.631(감사 WEB2631-11): 물리 코어 0 이면 '0 : 1' 이 아니라 '—'
// v2.764: 시안 B '이상 우선' 배치 — 확인 대상·CPU 구간·클러스터 타일 판정은 hostTriage.js 하나(카드 숫자와 표 필터가 같은 판정).
import { CPU_ATTENTION_PCT, CPU_BUCKETS, hostReasons, triageCounts, cpuDistribution, clusterTiles, filterHosts, focusLabel } from './hostTriage.js';

const TILE_LIMIT = 12; // 처음엔 '먼저 볼' 클러스터만 — 나머지는 '모두 보기'
const TILE_LIMIT_NARROW = 4; // 720px 이하는 4개(styles.css .ht-tiles) — 12개가 세로로 쌓이면 표까지 스크롤이 너무 길다(Chromium 400px 판독)
const REASON_BADGE = { maint: 'amber', down: 'red', cpu: 'red' };

export default function Hosts({ filters }) {
  const { data, error, loading } = usePolling('/hosts', filters, 15_000);
  const [detail, setDetail] = useState(null);
  const [tab, setTab] = useState(null); // null = 확인 대상이 있으면 그 탭, 없으면 전체
  const [focus, setFocus] = useState(null);
  const [allTiles, setAllTiles] = useState(false);
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox message={error} />; // 데이터 보유 중 일시 폴링 오류는 화면 유지
  const rows = data?.items || [];

  const counts = triageCounts(rows);
  const dist = cpuDistribution(rows);
  const tiles = clusterTiles(rows);
  const curTab = tab || (counts.attention > 0 ? 'attention' : 'all');
  const shown = filterHosts(rows, { tab: curTab, focus });
  // 카드·구간·타일을 누르면 그 조건으로 걸러 표를 본다. 같은 것을 다시 누르면 해제.
  const pick = (f, nextTab) => {
    const same = focus && f && focus.kind === f.kind && focus.value === f.value;
    setFocus(same ? null : f);
    if (nextTab) setTab(nextTab);
  };
  const isFocus = (kind, value) => !!focus && focus.kind === kind && focus.value === value;

  const columns = [
    ...(curTab === 'attention' ? [{
      key: 'reason', label: '사유', sortValue: (h) => hostReasons(h).map((r) => r.label).join(','),
      render: (h) => (
        <span className="ht-reasons">
          {hostReasons(h).map((r) => <span key={r.kind} className={`badge ${REASON_BADGE[r.kind]}`}>{r.label}</span>)}
        </span>
      ),
    }] : []),
    { key: 'name', label: '호스트', render: (h) => <button className="cell-link" onClick={() => setDetail(h)}>{h.name}</button> },
    { key: 'vcenterId', label: 'vCenter', render: (h) => <span className="muted">{h.vcenterId}</span> },
    { key: 'cluster', label: '클러스터' },
    { key: 'connectionState', label: '상태', render: (h) => <StateBadge state={h.connectionState} /> },
    { key: 'cpuCores', label: 'Cores', align: 'right', render: (h) => h.cpuCores },
    { key: 'cpuUsagePct', label: 'CPU', sortValue: (h) => hostUsagePct(h, 'cpuUsagePct'), render: (h) => <UsageCell pct={hostUsagePct(h, 'cpuUsagePct')} /> },
    { key: 'memUsagePct', label: '메모리', sortValue: (h) => hostUsagePct(h, 'memUsagePct'), render: (h) => <UsageCell pct={hostUsagePct(h, 'memUsagePct')} /> },
    { key: 'memTotalMB', label: 'RAM', align: 'right', render: (h) => (Number.isFinite(h.memTotalMB) ? `${Math.round(h.memTotalMB / 1024)} GB` : '—') }, // REST 폴백 수집엔 메모리 정보 없음 — 'NaN GB' 방지
    { key: 'powerWatts', label: '전력', align: 'right', render: (h) => (h.powerWatts > 0 ? `${(h.powerWatts / 1000).toFixed(2)} kW` : '—') },
    { key: 'vmCount', label: 'VM', align: 'right' },
  ];

  const s = data.summary;
  const fmt = (n) => (n ?? 0).toLocaleString('en-US');
  const pctText = (v) => (v == null ? '—' : `${v}%`);
  const visibleTiles = allTiles ? tiles : tiles.slice(0, TILE_LIMIT);
  const filtered = Object.keys(filters || {}).length > 0;

  const cards = [
    { kind: 'maint', n: counts.maint, title: '점검(Maintenance) 모드', sub: '유지보수 상태 호스트', tone: 'amber' },
    // v2.766(점검 R1-A3-02): 서버 경보(high-cpu)는 점검 호스트에 경보를 만들지 않지만 이 카드는 점검 호스트도 센다(판정은 그대로 — 사실만 말한다).
    { kind: 'cpu', n: counts.cpu, title: `CPU ${CPU_ATTENTION_PCT}% 초과`, sub: `서버 경보와 같은 임계값(${CPU_ATTENTION_PCT}% 초과) · 점검 중 호스트 포함`, tone: 'red' },
    { kind: 'down', n: counts.down, title: '끊김 · 무응답', sub: '사용률을 읽지 못한 호스트', tone: 'red' },
  ];

  return (
    <>
      {/* 폴링 지속 실패 시 낡은 데이터를 무경고로 표시하지 않고 배너로 알린다(v2.287, #20). */}
      {error && <div className="badge red" style={{ display: 'block', marginBottom: 10, padding: '6px 10px' }}>⚠ 갱신 실패 — 직전 데이터를 표시 중입니다({error}).</div>}

      {s && (
        <div className="ht-sum" aria-label="글로벌 호스트 요약">
          <span className="ht-sum-item"><span className="ht-sum-k">호스트(ESXi)</span><b>{fmt(s.total)}</b><span className="muted">전원 On {fmt(s.poweredOn)} · Off {fmt(s.poweredOff)}</span></span>
          <span className="ht-sum-item"><span className="ht-sum-k">물리 코어</span><b>{fmt(s.physicalCores)}</b><span className="muted">논리 {fmt(s.logicalCores)}</span></span>
          <span className="ht-sum-item"><span className="ht-sum-k">할당 vCore</span><b style={{ color: 'var(--accent)' }}>{fmt(s.vcoreAllocated)}</b><span className="muted">vCore:물리 {ratioLabel(serverRatio(s.vcorePerCore, s.physicalCores))}</span></span>
          <span className="ht-sum-item"><span className="ht-sum-k">전체 메모리</span><b>{fmt(s.memTotalGB)} GB</b><span className="muted">≈ {(s.memTotalGB / 1024).toFixed(1)} TB</span></span>
          {s.powerKw > 0 && <span className="ht-sum-item"><span className="ht-sum-k">전력</span><b>{s.powerKw} kW</b></span>}
          <span className="ht-sum-item">
            <span className="ht-sum-k">ESXi 버전</span>
            {s.esxiVersions.slice(0, 6).map((v) => (
              <span key={v.version} className="badge blue" title={`${v.count} 호스트`}>{v.version} · {v.count}</span>
            ))}
            {s.esxiVersions.length === 0 && <span className="muted">정보 없음</span>}
          </span>
        </div>
      )}

      <div className="ht-cards" aria-label="지금 확인할 것">
        {cards.map((c) => (
          <button
            key={c.kind}
            type="button"
            className={`ht-card${c.n > 0 ? ` ht-card-${c.tone}` : ''}${isFocus(c.kind, undefined) ? ' ht-on' : ''}`}
            onClick={() => pick({ kind: c.kind }, 'attention')}
            disabled={c.n === 0}
            aria-pressed={isFocus(c.kind, undefined)}
            title={c.n > 0 ? '눌러서 이 호스트만 보기(다시 누르면 해제)' : '해당 호스트 없음'}
          >
            <span className="ht-card-n">{fmt(c.n)}</span>
            <span className="ht-card-t"><b>{c.title}</b><span className="muted">{c.sub}</span></span>
          </button>
        ))}
      </div>

      <div className="ht-panels">
        <section className="card ht-heat" aria-label="클러스터별 호스트 CPU">
          <div className="ht-head">
            <b>클러스터별 호스트 CPU</b>
            <span className="ht-legend">
              {CPU_BUCKETS.map((b) => <span key={b.key}><i className={`ht-cell ht-b-${b.key}`} />{b.label}</span>)}
            </span>
          </div>
          {tiles.length === 0 && <div className="muted">호스트가 없습니다.</div>}
          <div className={`ht-tiles${allTiles ? ' ht-all' : ''}`}>
            {visibleTiles.map((t) => (
              <button
                key={t.key}
                type="button"
                className={`ht-tile${t.attention > 0 ? ' ht-tile-hot' : ''}${isFocus('cluster', t.key) ? ' ht-on' : ''}`}
                onClick={() => pick({ kind: 'cluster', value: t.key }, 'all')}
                aria-pressed={isFocus('cluster', t.key)}
              >
                <span className="ht-tile-h">
                  <span className="ht-tile-name" title={`${t.vcenterId} · ${t.cluster}`}><span className="muted">{t.vcenterId} · </span>{t.cluster}</span>
                  <span className="muted tabular">{fmt(t.count)}</span>
                </span>
                <span className="ht-cells" aria-hidden="true">
                  {t.cells.map((c, i) => <i key={`${c.name}-${i}`} className={`ht-cell ht-b-${c.bucket}`} title={`${c.name} — CPU ${pctText(c.pct)}`} />)}
                </span>
                <span className="muted tabular ht-tile-f">
                  평균 {pctText(t.avg)} · 최대 {pctText(t.max)}
                  {t.attention > 0 && <span className="badge red">확인 {t.attention}</span>}
                </span>
              </button>
            ))}
          </div>
          {tiles.length > TILE_LIMIT_NARROW && (
            <button type="button" className={`btn ht-more${tiles.length <= TILE_LIMIT ? ' ht-more-narrow' : ''}`} onClick={() => setAllTiles((v) => !v)}>
              {allTiles ? '먼저 볼 클러스터만' : `모두 보기 (${fmt(tiles.length)}개 클러스터)`}
            </button>
          )}
        </section>

        <section className="card ht-dist" aria-label="CPU 사용률 분포">
          <div className="ht-head"><b>CPU 사용률 분포</b><span className="muted">호스트 수</span></div>
          {dist.map((b) => (
            <button
              key={b.key}
              type="button"
              className={`ht-bar-row${isFocus('bucket', b.key) ? ' ht-on' : ''}`}
              onClick={() => pick({ kind: 'bucket', value: b.key }, 'all')}
              disabled={b.count === 0}
              aria-pressed={isFocus('bucket', b.key)}
            >
              <span className="muted">{b.label}</span>
              <span className="ht-bar"><i className={`ht-b-${b.key}`} style={{ width: `${Math.round(b.share * 100)}%` }} /></span>
              <span className="tabular">{fmt(b.count)}</span>
            </button>
          ))}
          <div className="muted ht-note">막대를 누르면 아래 목록이 그 구간으로 걸러집니다. 사용률을 못 읽은 호스트는 0% 가 아니라 '미수집' 으로 따로 셉니다. CPU % 는 정격 용량 대비라 100% 를 넘을 수 있습니다.</div>
        </section>
      </div>

      <div className="ht-tablebar">
        <div className="ht-tabs" role="group" aria-label="목록 범위">
          <button type="button" className={`btn${curTab === 'attention' ? ' ht-tab-on' : ''}`} aria-pressed={curTab === 'attention'} onClick={() => setTab('attention')}>확인 대상 <span className="tabular">{fmt(counts.attention)}</span></button>
          <button type="button" className={`btn${curTab === 'all' ? ' ht-tab-on' : ''}`} aria-pressed={curTab === 'all'} onClick={() => setTab('all')}>전체 <span className="tabular">{fmt(rows.length)}</span></button>
        </div>
        {focus && (
          <span className="badge blue ht-chip">
            {focusLabel(focus)}
            <button type="button" className="ht-chip-x" onClick={() => setFocus(null)} aria-label="조건 해제">✕</button>
          </span>
        )}
        <span className="muted result-count">
          표시 <b style={{ color: 'var(--text)' }}>{fmt(shown.length)}</b> / 총 {fmt(rows.length)}개 호스트
          {filtered && <span className="badge blue" style={{ marginLeft: 8 }}>필터 적용 중</span>}
        </span>
      </div>
      <DataTable
        columns={columns}
        rows={shown}
        initialSort={{ key: 'cpuUsagePct', dir: 'desc' }}
        emptyText={curTab === 'attention' && !focus ? '확인할 호스트가 없습니다.' : '조건에 맞는 호스트가 없습니다.'}
      />
      <IpmsMatches filters={filters} />
      {detail && <EntityDetail type="host" item={detail} onClose={() => setDetail(null)} />}
    </>
  );
}
