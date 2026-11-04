/**
 * views/issues/issueParts.jsx — 이슈 화면 공용 작은 조각(v2.882 에 Issues.jsx 에서 옮겼다 — 스프린트 · 에픽 · 필터 화면이 같이 쓴다).
 */
import React from 'react';
import { typeText, priorityText, statusText, dueInfo, initialOf, colorIndexOf, progressOf, staleInfo } from './issueText.js';

export function Avatar({ name, size = 26 }) {
  const none = !name;
  return (
    <span className={`iss-av${none ? ' none' : ` c${colorIndexOf(name)}`}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      title={none ? '미할당' : name} aria-label={none ? '미할당' : name}>{initialOf(name)}</span>
  );
}

export const TypeTag = ({ t }) => <span className={`iss-type t-${t}`}>{typeText(t)}</span>;
export const PrioTag = ({ p }) => <span className={`iss-prio ${p}`}>{priorityText(p)}</span>;
export const StatusChip = ({ s }) => <span className={`iss-chip s-${s}`}>{statusText(s)}</span>;
export function Due({ r }) {
  const d = dueInfo(r.dueAt, { done: r.status === 'done' });
  if (!d) return <span className="iss-due muted">기한 없음</span>;
  return <span className={`iss-due ${d.tone}`}>{d.text}</span>;
}

export function ProgressLine({ r, compact = false }) {
  const pct = progressOf(r);
  const st = r.status === 'done' ? null : staleInfo(r);
  if (pct == null && !st) return compact ? <span className="muted">—</span> : null;
  return (
    <span className={`iss-prog${compact ? ' compact' : ''}`}>
      {pct != null && (
        <>
          <span className="iss-prog-bar" role="img" aria-label={`진행률 ${pct}%`}><span style={{ width: `${pct}%` }} /></span>
          <span className="iss-prog-n">{pct}%</span>
        </>
      )}
      {st && <span className="iss-stale" title={`진행 중·검토 중인데 ${st.days}일 동안 상태·진행률·댓글 갱신이 없습니다`}>{st.text}</span>}
    </span>
  );
}
