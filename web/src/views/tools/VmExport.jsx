// VmExport.jsx — SpecialTools.jsx(구 5,070줄)에서 분리(v2.282 대형 파일 분할). 본문은 원본 그대로 이동.
import React, { useEffect, useState } from 'react';
import { fetchJson, getToken } from '../../api.js';
import { DataTable, Loading, ErrorBox, StateBadge } from '../../components/ui.jsx';
import { Card } from './shared.jsx';


/**
 * VM 전체 정보 CSV export (v2.275) — 선택 vCenter 의 모든 VM 을 서버가 '획득 가능한 최대
 * 필드'(스냅샷 + 내보내기 시점 라이브 SOAP 보강: NIC·MAC·디스크별 데이터스토어/용량·게스트
 * 파티션 사용량·UUID 등 55+ 컬럼)로 만들어 준다. 여기서는 미리보기(100행) + CSV 다운로드.
 */
export function VmExport({ scope }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setData(null); setErr(null);
    if (!scope) return undefined;
    let dead = false;
    setBusy(true);
    fetchJson(`/tools/vm-export?vcenterId=${encodeURIComponent(scope)}`)
      .then((r) => { if (!dead) { setData(r); setErr(null); } })
      .catch((e) => { if (!dead) setErr(e.message); })
      .finally(() => { if (!dead) setBusy(false); });
    return () => { dead = true; };
  }, [scope]);
  const download = async () => {
    const res = await fetch(`/api/tools/vm-export.csv?vcenterId=${encodeURIComponent(scope)}`, { headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {} });
    const blob = await res.blob(); const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `vm-export-${scope}-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(url);
  };

  if (!scope) return <div className="card"><span className="muted">위 <b>범위</b>에서 vCenter 를 선택하세요 — 그 vCenter 의 모든 VM 상세(호스트·클러스터·NIC·디스크·데이터스토어·게스트 파티션 등)를 미리보고 CSV 로 내려받습니다.</span></div>;
  if (busy && !data) return <Loading />;
  if (err && !data) return <ErrorBox message={err} />;
  if (!data) return <Loading />;

  const preview = [
    { key: 'name', label: 'VM', render: (r) => <b>{r.name}</b> },
    { key: 'powerState', label: '전원', render: (r) => <StateBadge state={r.powerState} /> },
    { key: 'cluster', label: '클러스터' },
    { key: 'host', label: '호스트' },
    { key: 'guestOS', label: 'Guest OS' },
    { key: 'cpuCount', label: 'vCPU', align: 'right' },
    { key: 'memGB', label: 'RAM(GB)', align: 'right' },
    { key: 'nicCount', label: 'NIC', align: 'right' },
    { key: 'ipAddress', label: '대표 IP' },
    { key: 'diskCount', label: '디스크', align: 'right' },
    { key: 'datastores', label: '데이터스토어' },
    { key: 'storageProvisionedGB', label: '프로비저닝(GB)', align: 'right' },
  ];
  return (
    <>
      <div className="flex gap wrap" style={{ marginBottom: 12, alignItems: 'center' }}>
        <Card label="VM 수" value={data.total} meta={data.vcenterName} accent="var(--accent)" />
        <Card label="컬럼 수" value={(data.columns || []).length} meta="CSV 로 전체 내보내기" />
        <button className="login-btn" style={{ flex: 'none', padding: '10px 20px' }} onClick={download}>⬇ CSV 다운로드 (전체 {data.total}대 · {(data.columns || []).length}컬럼)</button>
      </div>
      {!data.enriched && (
        <div className="card" style={{ borderColor: 'var(--amber,#f59e0b)', marginBottom: 12 }}>
          <span style={{ fontSize: 13 }}>⚠ 라이브 상세 보강 없이 스냅샷 필드만 포함됩니다 — {data.enrichError || '사유 미상'}. NIC/디스크별 상세·게스트 파티션 컬럼은 비어 있을 수 있습니다.</span>
        </div>
      )}
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>미리보기 {Math.min(100, data.total)}행(대표 컬럼만) — 전체 {data.total}행 × {(data.columns || []).length}컬럼은 CSV 로 내려받으세요. NIC·게스트 파티션 상세, MAC/IP 전체, UUID, 예약/제한, 스냅샷, CBT 에 더해 <b>디스크는 1~7번 슬롯 컬럼</b>(슬롯당 용량·타입·모드·데이터스토어·파일, 미할당은 빈칸)으로 펼쳐지고 8개 이상은 '디스크8+ 요약'에 담깁니다(v2.278).</div>
      <DataTable columns={preview} rows={data.rows || []} initialSort={{ key: 'name', dir: 'asc' }} />
    </>
  );
}
