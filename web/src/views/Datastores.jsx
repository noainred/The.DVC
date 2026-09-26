import React, { useState, lazy, Suspense } from 'react';
import { usePolling } from '../api.js';
import { DataTable, UsageCell, Kpi, Loading, ErrorBox, ResultCount, EntityDetail } from '../components/ui.jsx';
import IpmsMatches from '../components/IpmsMatches.jsx';
import { numOrNull } from '../numOrNull.js';
// 개별 DS 사용량 추이 모달(v2.354). v2.596(감사 PERFWEB-03): recharts 를 끌고 오므로 모달을 열 때만 받는다.
const DsTrendModal = lazy(() => import('./tools/DsTrendModal.jsx'));

// v2.622(감사 WEB-02): 사용량을 못 읽은 DS(usedGB·freeGB null — v2.598 VC2598-07)는 'null GB' 가 아니라 '—'.
export const dsGbText = (gb) => {
  const n = numOrNull(gb);
  if (n == null) return '—';
  return n >= 1024 ? `${(n / 1024).toFixed(1)} TB` : `${n} GB`;
};

/**
 * v2.622(감사 WEB-02): KPI 합계는 사용량을 읽은 DS 만 더한다(용량·사용·여유 모두). 예전 sum 은 `d[k] || 0` 이라
 * 접근 불가 DS 가 총 용량에는 들어가고 사용·여유에는 0 으로 들어가 평균 사용률이 과소 표시됐다
 * (서버 롤업의 datastoresUsageUnknown 과 같은 기준). 뺀 개수는 unknown 으로 밝힌다.
 * 여유를 못 읽었는데 용량·사용을 읽었으면 용량 − 사용으로 채운다. 읽은 DS 가 0개면 사용률은 null('—').
 */
export function dsTotals(rows) {
  let capGB = 0, usedGB = 0, freeGB = 0, known = 0, unknown = 0;
  for (const d of rows || []) {
    const cap = numOrNull(d?.capacityGB), used = numOrNull(d?.usedGB);
    if (cap == null || used == null) { unknown += 1; continue; }
    const free = numOrNull(d?.freeGB);
    capGB += cap; usedGB += used; freeGB += free != null ? free : Math.max(0, cap - used); known += 1;
  }
  const usagePct = capGB > 0 ? Math.round((usedGB / capGB) * 100) : null;
  return { capGB, usedGB, freeGB, usagePct, known, unknown };
}

export default function Datastores({ filters }) {
  // 이름 클릭 → 상세 모달(할당 VM·파일 브라우즈 포함, v2.276). 훅은 조기 return 위에 선언.
  const [sel, setSel] = useState(null);
  const [trend, setTrend] = useState(null); // 📈 추이 모달(v2.354) — 훅은 조기 return 위에
  const { data, error, loading } = usePolling('/datastores', filters, 15_000);
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox message={error} />; // 데이터 보유 중 일시 폴링 오류는 화면 유지
  const rows = data?.items || [];

  const tb = dsGbText;
  const typeBadge = { vSAN: 'purple', NFS: 'blue', VMFS: 'green' };

  // Sum capacity/used/free across the currently shown (filtered) datastores — 사용량을 읽은 DS 만(WEB-02).
  const { capGB, usedGB, freeGB, usagePct, unknown } = dsTotals(rows);
  const unknownNote = unknown > 0 ? ` · 사용량 모름 ${unknown}개 제외` : '';
  const filtered = Object.keys(filters || {}).length > 0;

  const columns = [
    { key: 'name', label: '데이터스토어', render: (d) => <button className="cell-link" title="클릭 — 할당 VM·파일 목록 보기" onClick={() => setSel(d)}><b>💾 {d.name}</b></button> },
    { key: 'vcenterId', label: 'vCenter', render: (d) => <span className="muted">{d.vcenterId}</span> },
    { key: 'type', label: '유형', render: (d) => <span className={`badge ${typeBadge[d.type] || 'gray'}`}>{d.type}</span> },
    { key: 'capacityGB', label: '총 용량', align: 'right', render: (d) => tb(d.capacityGB) },
    { key: 'usedGB', label: '사용', align: 'right', render: (d) => tb(d.usedGB) },
    { key: 'freeGB', label: '여유', align: 'right', render: (d) => tb(d.freeGB) },
    { key: 'usagePct', label: '사용률', render: (d) => <UsageCell pct={d.usagePct} /> },
    // 사용량 추이(v2.354) — 이름 클릭(상세)과 별개 버튼. vm-track 의 00/12시 스냅샷 차트.
    { key: 'trend', label: '추이', render: (d) => (
      <button className="tab" style={{ padding: '2px 9px', fontSize: 12 }} title="00시·12시 스냅샷 기준 사용량 추이 차트" onClick={() => setTrend(d)}>📈</button>
    ) },
  ];

  return (
    <>
      <div className="kpis" style={{ marginBottom: 12 }}>
        <Kpi label={filtered ? '데이터스토어 (필터)' : '데이터스토어'} value={rows.length.toLocaleString()} meta={filtered ? '필터 적용 합계' : '전체 합계'} />
        <Kpi label="총 용량 합계" value={tb(capGB)} meta={`${rows.length - unknown}개 데이터스토어${unknownNote}`} />
        <Kpi label="사용 합계" value={tb(usedGB)} meta={usagePct == null ? '사용률 —' : `${usagePct}% 사용`} accent={usagePct == null ? undefined : usagePct >= 85 ? 'var(--red)' : usagePct >= 70 ? 'var(--amber)' : undefined} />
        <Kpi label="여유 합계" value={tb(freeGB)} meta={unknown > 0 ? `사용량 모름 ${unknown}개 제외` : undefined} />
        {usagePct == null
          ? <Kpi label="평균 사용률" value="—" meta={unknown > 0 ? `사용량 모름 ${unknown}개 제외` : undefined} />
          : <Kpi label="평균 사용률" value={usagePct} unit="%" pct={usagePct} meta={unknown > 0 ? `사용량 모름 ${unknown}개 제외` : undefined} />}
      </div>
      <ResultCount total={data.total} label="데이터스토어" filtered={filtered} />
      <DataTable columns={columns} rows={rows} initialSort={{ key: 'usagePct', dir: 'desc' }} />
      <IpmsMatches filters={filters} />
      {sel && <EntityDetail type="datastore" item={sel} onClose={() => setSel(null)} />}
      {trend && <Suspense fallback={<Loading />}><DsTrendModal dsId={trend.id || `${trend.vcenterId}:${trend.name}`} name={trend.name}
        vcenterId={trend.vcenterId} type={trend.type} onClose={() => setTrend(null)} /></Suspense>}
    </>
  );
}
