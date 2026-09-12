// DVC 콘솔 공용 조각(v2.487) — 패널·KPI·막대·배지·빈 상태. 스타일은 console.css 의 dvc-* 클래스.
import React from 'react';
import { ErrorBox } from '../components/ui.jsx';
import { LEVEL_COLOR, LEVEL_LABEL, colorOf, fmtPct } from './consoleData.js';

export function Panel({ title, sub, right, children, bodyPad = true, style }) {
  return (
    <div className="dvc-panel" style={style}>
      {(title || right) && (
        <div className="dvc-panel-h">
          {title && <b>{title}</b>}
          {sub && <span className="dvc-sub">{sub}</span>}
          {right && <div className="dvc-right">{right}</div>}
        </div>
      )}
      {bodyPad ? <div className="dvc-panel-b">{children}</div> : children}
    </div>
  );
}

export function KpiCard({ label, value, meta, accent, onClick }) {
  return (
    <div className={`dvc-kpi${onClick ? ' click' : ''}`} style={accent ? { '--kpi': accent } : undefined}
      onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}>
      <div className="dvc-kpi-label">{label}</div>
      <div className="dvc-kpi-value">{value}</div>
      {meta && <div className="dvc-kpi-meta">{meta}</div>}
    </div>
  );
}

/** 사용률 막대. pct 가 null 이면 빈 막대 + '—'. marks 로 임계 눈금(%) 표시. */
export function Bar({ pct, color, large = false, marks = null }) {
  const w = pct == null ? 0 : Math.max(0, Math.min(100, Number(pct)));
  return (
    <span className={`dvc-bar${large ? ' lg' : ''}`}>
      <i style={{ width: `${w}%`, background: color || colorOf(pct) }} />
      {(marks || []).map((m) => <span key={m} className="dvc-mark" style={{ left: `${m}%` }} />)}
    </span>
  );
}

export function PctCell({ pct, color }) {
  return <span className="dvc-pct"><Bar pct={pct} color={color} /><span className="dvc-num">{fmtPct(pct)}</span></span>;
}

/** 레벨 배지(0 정상 / 1 주의 / 2 위험 / null 판정 불가). label 로 문구 대체 가능. */
export function LevelBadge({ level, label }) {
  const cls = level == null ? 'lvn' : `lv${level}`;
  return <span className={`dvc-badge ${cls}`}>{label ?? (level == null ? '—' : LEVEL_LABEL[level])}</span>;
}
export const levelColor = (level) => (level == null ? '#5d6b85' : LEVEL_COLOR[level]);

export function Empty({ children }) { return <div className="dvc-empty">{children}</div>; }

/**
 * 폴링 결과 래퍼 — 데이터가 없을 때만 오류/로딩을 보여준다(데이터 보유 중 일시 오류 1건으로 화면을
 * 갈아치우지 않는다 — CLAUDE.md 웹 폴링 규칙). 403 은 ErrorBox 가 AccessDenied 로 바꿔 보여준다.
 * `path` 가 null(권한상 호출 자체를 하지 않음)이면 skipped 문구를 보여준다.
 */
export function PollState({ poll, skipped, children }) {
  if (skipped) return <Empty>{skipped}</Empty>;
  if (!poll) return null;
  if (poll.error && !poll.data) return <div style={{ padding: 12 }}><ErrorBox message={poll.error} info={poll.errorInfo} /></div>;
  if (!poll.data) return <Empty>불러오는 중…</Empty>;
  return children;
}
