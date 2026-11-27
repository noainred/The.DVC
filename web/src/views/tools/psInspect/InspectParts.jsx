/**
 * InspectParts — PowerScale 점검 화면의 작은 조각(상태 배지 · 칸 띠 · 용량 막대 · 근거 번호). 그리기만(판정 없음).
 */
import React from 'react';
import { statusText, stripOf, pctText } from './psInspectText.js';

export function StatusBadge({ s, title }) {
  return <span className={`psi-st ${s || 'na'}`} title={title || undefined}><i aria-hidden="true" />{statusText(s)}</span>;
}
/** 20칸 띠 — 구분마다 묶음 · 칸 title 에 항목 이름과 상태. */
export function Strip({ items }) {
  const groups = stripOf(items);
  const all = groups.flatMap((g) => g.cells);
  return (
    <span className="psi-strip" role="img" aria-label={`항목 ${all.length}개 — ${['bad', 'warn', 'unknown', 'ok', 'na'].map((s) => `${statusText(s)} ${all.filter((c) => c.status === s).length}`).join(' · ')}`}>
      {groups.map((g) => (
        <span key={g.group} title={g.label}>{g.cells.map((c) => <i key={c.id} className={`c-${c.status}`} title={`${c.no}. ${c.label} — ${statusText(c.status)}`} />)}</span>
      ))}
    </span>
  );
}
/** 용량 막대(80% · 90% 눈금 — 서버 기준값). 상태색은 서버 판정 항목(capacity)의 상태. */
export function CapBar({ pct, status, warn = 80, bad = 90 }) {
  const n = Number(pct);
  return (
    <span className="psi-cap" title={`용량 사용률 ${pctText(pct)} · 눈금 ${warn}% · ${bad}%`}>
      <span className="psi-mono" style={{ fontSize: 12, color: status === 'bad' ? '#ff9a9d' : status === 'warn' ? '#fcd34d' : undefined }}>{pctText(pct)}</span>
      <i aria-hidden="true">{Number.isFinite(n) && <b className={status === 'bad' || status === 'warn' ? status : ''} style={{ width: `${Math.max(0, Math.min(100, n))}%` }} />}<s style={{ left: `${warn}%` }} /><s style={{ left: `${bad}%` }} /></i>
    </span>
  );
}
export const Refs = ({ refs }) => (refs?.length ? <span className="psi-ref">{refs.map((n) => `[${n}]`).join('')}</span> : null);
export function Legend() {
  return (
    <div className="psi-legend">
      {['ok', 'warn', 'bad', 'unknown', 'na'].map((s) => <span key={s} className="psi-key"><i className={`c-${s}`} aria-hidden="true" />{statusText(s)}</span>)}
    </div>
  );
}
