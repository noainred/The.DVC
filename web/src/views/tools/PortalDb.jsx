// PortalDb.jsx — SpecialTools.jsx(구 5,070줄)에서 분리(v2.282 대형 파일 분할). 본문은 원본 그대로 이동.
import React from 'react';
import { usePolling } from '../../api.js';
import { DataTable, Loading, ErrorBox } from '../../components/ui.jsx';
import { Card } from './shared.jsx';


// 바이트를 사람이 읽는 단위로.
function fmtBytes(b) {
  if (b == null || !Number.isFinite(Number(b))) return '—';
  const n = Number(b);
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

const DB_TYPE_BADGE = { sqlite: 'blue', json: 'green', ndjson: 'amber', file: 'gray' };
const DB_TYPE_LABEL = { sqlite: 'SQLite', json: 'JSON', ndjson: 'ndjson', file: '파일' };

// 증가 추이 미니 스파크라인(크기 샘플). 값이 1개 이하면 '—'.
function Sparkline({ samples, w = 110, h = 26 }) {
  const pts = (samples || []).map((s) => s.bytes);
  if (pts.length < 2) return <span className="muted" style={{ fontSize: 12 }}>표본 부족</span>;
  const min = Math.min(...pts); const max = Math.max(...pts);
  const span = max - min || 1;
  const step = w / (pts.length - 1);
  const path = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`).join(' ');
  const up = pts[pts.length - 1] >= pts[0];
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <path d={path} fill="none" stroke={up ? 'var(--green)' : 'var(--red)'} strokeWidth="1.5" />
    </svg>
  );
}

/** 포탈 DB — 포탈이 사용하는 모든 데이터 파일(SQLite·JSON·ndjson)의 경로·용도·크기·증가 추이. */
export function PortalDb() {
  const { data, error } = usePolling('/admin/portal-db', {}, 30_000);
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;
  const files = data.files || [];
  const existing = files.filter((f) => f.exists);
  const sqliteN = existing.filter((f) => f.type === 'sqlite').length;
  const cols = [
    { key: 'file', label: '파일명', render: (f) => <b style={{ opacity: f.exists ? 1 : 0.5 }}>{f.file}</b> },
    { key: 'type', label: '종류', sortValue: (f) => f.type, render: (f) => <span className={`badge ${DB_TYPE_BADGE[f.type] || 'gray'}`}>{DB_TYPE_LABEL[f.type] || f.type}</span> },
    { key: 'purpose', label: '용도', render: (f) => <span style={{ fontSize: 13 }}>{f.purpose}</span> },
    { key: 'sizeBytes', label: '크기', align: 'right', sortValue: (f) => f.sizeBytes || -1, render: (f) => (f.exists ? <span>{fmtBytes(f.sizeBytes)}</span> : <span className="badge gray">미생성</span>) },
    { key: 'growth', label: '증가/일(추정)', align: 'right', sortValue: (f) => f.trend?.perDayBytes || 0, render: (f) => {
      const g = f.trend?.perDayBytes || 0;
      if (!f.exists || (f.trend?.samples?.length || 0) < 2) return <span className="muted">—</span>;
      if (g === 0) return <span className="muted">변화 없음</span>;
      return <span style={{ color: g > 0 ? 'var(--green)' : 'var(--red)' }}>{g > 0 ? '+' : ''}{fmtBytes(g)}/일</span>;
    } },
    { key: 'trend', label: '추이', render: (f) => <Sparkline samples={f.trend?.samples} /> },
    { key: 'path', label: '경로', render: (f) => <code style={{ fontSize: 11, color: 'var(--muted)' }}>{f.path}</code> },
  ];
  return (
    <>
      <div className="flex gap wrap" style={{ marginBottom: 14 }}>
        <Card label="데이터 파일" value={existing.length} meta={`정의 ${files.length}개`} />
        <Card label="SQLite DB" value={sqliteN} accent="var(--blue,#2563eb)" />
        <Card label="총 용량" value={fmtBytes(data.totalBytes)} accent="var(--green)" />
        <Card label="설정 디렉터리" value={<code style={{ fontSize: 12 }}>{data.configDir}</code>} meta={`추이 샘플 ${Math.round((data.sampleIntervalMs || 0) / 60000)}분 간격`} />
      </div>
      <DataTable columns={cols} rows={files} initialSort={{ key: 'sizeBytes', dir: 'desc' }} />
      <div className="muted" style={{ marginTop: 10, fontSize: 12, lineHeight: 1.7 }}>
        · <b>증가 추이</b>는 서버 기동 후 {Math.round((data.sampleIntervalMs || 0) / 60000)}분 간격으로 측정한 크기 표본으로 추정합니다(재시작 시 표본 초기화).
        · SQLite는 <code>-wal</code>/<code>-shm</code> 사이드카 크기를 합산해 표시합니다.
        · <code>미생성</code>은 해당 기능을 아직 쓰지 않아 파일이 만들어지지 않은 상태입니다.
      </div>
    </>
  );
}
