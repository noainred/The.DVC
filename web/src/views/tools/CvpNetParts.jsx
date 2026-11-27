import React from 'react';
import Select from '../../components/Select.jsx';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { sparkPath } from './cvpNetText.js';

/**
 * CVP 네트워크 기능(v3.38) 화면 공용 부품 — 분절 버튼 · 숫자 타일 · 작은 추이선 · CVP 선택.
 * (포트 구성도 v3.37 의 Seg 를 여기로 옮겼다 — 화면마다 사본을 두지 않는다.)
 */
export const NOTE = { fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 };
export const MONO = { fontFamily: 'var(--mono)' };
export const ROW = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' };
export const GRID1 = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 14, minWidth: 0 };

/** v3.42(버그 점검 1회차 D14): 응답 전 · 오류 — 새로고침 줄은 남긴다(오류 상자가 조작 줄까지 대신하면 다시 시도하려고 보기를 오가야 했다). */
export function Pending({ err, onRetry }) {
  return (
    <div style={GRID1}>
      <div style={ROW}><button type="button" className="btn" onClick={onRetry}>새로고침</button></div>
      {err ? <ErrorBox error={err} /> : <Loading />}
    </div>
  );
}
export const LINKBTN = { background: 'none', border: 0, padding: 0, color: 'var(--accent-2)', cursor: 'pointer', fontFamily: 'var(--mono)', fontWeight: 600, textAlign: 'left' };

export function Seg({ items, value, onChange, label }) {
  return (
    <div role="group" aria-label={label} style={{ display: 'inline-flex', flexWrap: 'wrap', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
      {items.map(([k, l]) => (
        <button key={k} type="button" aria-pressed={value === k} onClick={() => onChange(k)}
          style={{ height: 32, padding: '0 12px', border: 0, borderRight: '1px solid var(--border)', font: 'inherit', fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap',
            background: value === k ? 'var(--accent)' : 'transparent', color: value === k ? '#fff' : 'var(--text-dim)', fontWeight: value === k ? 600 : 400 }}>{l}</button>
      ))}
    </div>
  );
}

/** 숫자 타일 줄 — tiles: [[라벨, 값, 설명, 색]]. */
export function Tiles({ tiles }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
      {tiles.map(([l, n, meta, col]) => (
        <div key={l} className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{l}</div>
          <div style={{ ...MONO, fontSize: 24, fontWeight: 600, color: col || 'var(--text)' }}>{n}</div>
          {meta ? <div style={{ fontSize: 12, color: 'var(--text-dim)', overflowWrap: 'anywhere' }}>{meta}</div> : null}
        </div>
      ))}
    </div>
  );
}

/**
 * 작은 추이선 — 값이 2개 미만이면 '—'. refLine = 기준선 값(임계 등).
 * ⚠ prop 이름을 `ref` 로 하지 말 것 — React 가 ref 를 가로채 숫자 ref 로 #284 를 던진다(v3.38 Chromium 측정에서 화면 둘이 통째로 깨졌다).
 */
export function Spark({ points, w = 120, h = 28, color = '#60a5fa', min = null, max = null, refLine = null, title = '' }) {
  const d = sparkPath(points, { w, h, min, max });
  if (!d) return <span style={NOTE}>—</span>;
  const vals = points.map((p) => p[1]).filter((v) => v != null);
  const lo = min ?? Math.min(...vals); const hi = max ?? Math.max(...vals); const span = hi - lo || 1;
  const ry = refLine != null && refLine >= lo && refLine <= hi ? h - ((refLine - lo) / span) * h : null;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={title || '추이'} style={{ display: 'block', overflow: 'visible' }}>
      {ry != null && <line x1="0" x2={w} y1={ry} y2={ry} stroke="#f59e0b" strokeDasharray="3 3" strokeWidth="1" />}
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

/** CVP 서버 선택(2대 이상일 때만). */
export function CvpSelect({ servers = [], value, onChange }) {
  if (!Array.isArray(servers) || servers.length < 2) return null;
  return (
    <Select className="input" value={value} onChange={(e) => onChange(e.target.value)} aria-label="CVP 서버" style={{ maxWidth: 220 }}>
      <option value="">모든 CVP</option>
      {servers.map((s) => <option key={s.id} value={String(s.id)}>{s.name || s.id}</option>)}
    </Select>
  );
}

/** 상태 알약. */
export const Pill = ({ color, children, title }) => (
  <span title={title} style={{ display: 'inline-block', padding: '1px 8px', borderRadius: 999, border: `1px solid ${color}`, color, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>{children}</span>
);
