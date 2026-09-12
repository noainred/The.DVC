// version_3 공용 조각(v2.490) — 패널·KPI·막대·배지·빈 상태·폴링 래퍼. 스타일은 v3.css 의 v3-* 클래스.
import React from 'react';
import { ErrorBox } from '../components/ui.jsx';
import { LEVEL_LABEL, fmtPct, barColor, levelText } from './data.js';

export function Panel({ title, sub, right, children, bodyPad = true, style }) {
  return (
    <div className="v3-panel" style={style}>
      {(title || right) && (
        <div className="v3-panel-h">
          {title && <b>{title}</b>}
          {sub && <span className="v3-sub">{sub}</span>}
          {right && <div className="v3-right">{right}</div>}
        </div>
      )}
      {bodyPad ? <div className="v3-panel-b">{children}</div> : children}
    </div>
  );
}

export function Kpi({ label, value, meta, accent }) {
  return (
    <div className="v3-kpi" style={accent ? { '--kpi': accent } : undefined}>
      <div className="v3-kpi-label">{label}</div>
      <div className="v3-kpi-value">{value}</div>
      {meta && <div className="v3-kpi-meta">{meta}</div>}
    </div>
  );
}

/** 사용률 막대. pct 가 null 이면 빈 막대. marks = 임계 눈금(%). */
export function Bar({ pct, color, large = false, marks = null }) {
  const w = pct == null ? 0 : Math.max(0, Math.min(100, Number(pct)));
  return (
    <span className={`v3-bar${large ? ' lg' : ''}`}>
      <i style={{ width: `${w}%`, background: color || barColor(pct) }} />
      {(marks || []).map((m) => <span key={m} className="v3-mark" style={{ left: `${m}%` }} />)}
    </span>
  );
}

export function PctCell({ pct, color }) {
  return <span className="v3-pct"><Bar pct={pct} color={color} /><span className="v3-num">{fmtPct(pct)}</span></span>;
}

/** 레벨 배지(0 정상 / 1 주의 / 2 위험 / null 판정 불가). */
export function Badge({ level, label }) {
  const cls = level == null ? 'lvn' : `lv${level}`;
  return <span className={`v3-badge ${cls}`}>{label ?? (level == null ? '—' : LEVEL_LABEL[level])}</span>;
}
export { levelText };

export function Empty({ children }) { return <div className="v3-empty">{children}</div>; }

/**
 * 폴링 결과 래퍼 — 데이터가 없을 때만 오류/로딩을 보여준다(데이터 보유 중 일시 오류 1건으로 화면을 갈아치우지 않는다).
 * 403 은 ErrorBox 가 AccessDenied 안내로 바꾼다. path 가 null(권한상 호출 안 함)이면 skipped 문구.
 */
export function PollState({ poll, skipped, children }) {
  if (skipped) return <Empty>{skipped}</Empty>;
  if (!poll) return null;
  if (poll.error && !poll.data) return <div style={{ padding: 12 }}><ErrorBox message={poll.error} info={poll.errorInfo} /></div>;
  if (!poll.data) return <Empty>불러오는 중…</Empty>;
  return children;
}
