import React from 'react';
import { LEVELS, GAP_BG, levelColor, stateBadge, pctText, speedText, timeText } from './ifaceText.js';

/** 인터페이스 화면(전 장비 · 장비 한 대) 공용 조각(v3.35.0). */
export function Seg({ items, value, onPick, label }) {
  return (
    <div className="flex gap" role="group" aria-label={label} style={{ flexWrap: 'wrap' }}>
      {items.map(([k, t]) => (
        <button key={k} type="button" className={value === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '4px 12px' }} aria-pressed={value === k} onClick={() => onPick(k)}>{t}</button>
      ))}
    </div>
  );
}
export function Legend() {
  return (
    <div className="flex gap" style={{ flexWrap: 'wrap', fontSize: 11, alignItems: 'center' }}>
      {LEVELS.map((l) => (
        <span key={l.min} className="flex gap" style={{ alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 10, background: l.color, borderRadius: 2, display: 'inline-block' }} />{l.label}</span>
      ))}
      <span className="flex gap" style={{ alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 10, background: GAP_BG, display: 'inline-block' }} />값 없음</span>
    </div>
  );
}
export function Strip({ cells, label, width = 168 }) {
  if (!Array.isArray(cells)) return <span className="muted">—</span>;
  return (
    <div role="img" aria-label={label} style={{ display: 'grid', gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))`, gap: 1, width }}>
      {cells.map((c, i) => <span key={i} title={c == null ? '값 없음' : pctText(c)} style={{ height: 14, borderRadius: 2, background: c == null ? GAP_BG : levelColor(Math.min(100, c)) }} />)}
    </div>
  );
}
export function UtilBar({ pct, width = 90 }) {
  const c = levelColor(pct);
  return (
    <div className="flex gap" style={{ alignItems: 'center', gap: 6 }}>
      <div style={{ position: 'relative', width, height: 8, borderRadius: 4, background: 'var(--panel-deep, #0f1626)', overflow: 'hidden', flex: 'none' }}>
        <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: pct == null ? '100%' : `${Math.max(1.5, Math.min(100, pct))}%`, background: pct == null ? GAP_BG : c, borderRadius: 4 }} />
      </div>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 12, minWidth: 38, textAlign: 'right' }}>{pctText(pct)}</span>
    </div>
  );
}
export function StateCell({ r }) {
  const b = stateBadge(r.state);
  return (
    <span className="flex gap" style={{ gap: 4, flexWrap: 'nowrap', whiteSpace: 'nowrap' }}>
      <span className={`badge ${b.cls}`}>{b.text}</span>
      {r.state !== 'slow' && (r.flags || []).includes('slow') && <span className="badge amber">속도 저하</span>}
      {r.state !== 'busy' && (r.flags || []).includes('busy') && <span className="badge amber">포화 근접</span>}
      {r.linkUp === true && r.unread && <span className="badge gray" title="사용량을 읽지 못했습니다 — 정상에도 이상에도 넣지 않고 따로 셉니다">사용량 못 읽음</span>}
      {r.stale && <span className="badge gray" title={`마지막 표본 ${timeText(r.lastTs)}`}>오래된 표본</span>}
    </span>
  );
}
export function SpeedCell({ r }) {
  const slow = (r.flags || []).includes('slow');
  return (
    <span>
      <span style={{ fontFamily: 'var(--mono)', color: slow ? 'var(--amber)' : undefined, fontWeight: slow ? 600 : undefined }}>{r.linkUp === false ? '—' : speedText(r.speedGbps)}</span>
      <span className="muted" style={{ fontSize: 11, marginLeft: 4 }}>
        {r.linkUp === false ? '' : slow ? `최대 ${speedText(r.maxGbps)}` : typeof r.requested === 'number' ? `고정 ${speedText(r.requested)}` : ''}
      </span>
    </span>
  );
}
