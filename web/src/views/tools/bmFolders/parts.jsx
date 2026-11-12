/**
 * 물리서버 폴더 화면 부품(v2.984) — 그리기만 한다(판정은 서버 · 계산은 bmFoldersText.js).
 */
import React from 'react';
import { SRC_LABEL, SRC_BADGE, pctText } from '../bmFoldersText.js';

/** 사용률 막대 + 숫자. 값이 없으면 막대 없이 '—'(0 으로 그리지 않는다). */
export function UsageBar({ v, w = 54 }) {
  if (v == null) return <span className="muted">—</span>;
  const tone = v >= 90 ? 'var(--red)' : v >= 75 ? 'var(--amber)' : 'var(--accent)';
  return (
    <span className="bmf-ub" data-sort={v}>
      <span className="bmf-ub-t" style={{ width: w }}><span style={{ width: `${Math.max(0, Math.min(100, v))}%`, background: tone }} /></span>
      <span className="bmf-ub-n">{pctText(v)}</span>
    </span>
  );
}

/** CPU · 메모리 두 줄(열을 줄이려고 합쳤다 — 1440px 실측: 따로 두면 뒤쪽 열이 가로 스크롤 뒤로 숨었다). */
export function UsagePair({ cpu, mem }) {
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 12 }}>
      <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><span className="muted" style={{ width: 28 }}>CPU</span><UsageBar v={cpu} w={44} /></span>
      <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><span className="muted" style={{ width: 28 }}>MEM</span><UsageBar v={mem} w={44} /></span>
    </span>
  );
}

const DOT = { green: 'var(--green)', red: 'var(--red)', amber: 'var(--amber)', gray: 'var(--text-faint)' };
/** 상태 점 — tone 'none' 은 테두리만(못 읽음). 색만으로 뜻을 전하지 않게 title 을 단다. */
export function StatusDot({ tone = 'green', title }) {
  const t = title || { green: '켜짐 · 장애 없음', red: '부품 장애', amber: '주의', gray: '꺼짐', none: '사용률 못 읽음' }[tone];
  return <span className={`bmf-dot${tone === 'none' ? ' none' : ''}`} style={tone === 'none' ? undefined : { background: DOT[tone] }} title={t} aria-label={t} role="img" />;
}

/** 서버 목록을 받는 길 — 중앙 · 엣지 · 수집 서버. */
export function SrcBadge({ src, small = false }) {
  return <span className={`badge ${SRC_BADGE[src] || 'gray'}`} style={small ? { fontSize: 10, padding: '0 5px' } : undefined}>{SRC_LABEL[src] || src}</span>;
}

/** 쌓은 막대 — parts [{ n, c }]. 합이 0 이면 빈 막대. */
export function StackBar({ parts = [], w, h = 8, label }) {
  const total = parts.reduce((s, p) => s + (p.n || 0), 0);
  return (
    <span className="bmf-stk" style={{ width: w, height: h, flex: w ? 'none' : '1 1 auto' }} role="img" aria-label={label}>
      {total ? parts.filter((p) => p.n > 0).map((p, i) => <i key={i} style={{ width: `${(p.n / total) * 100}%`, background: p.c }} />) : null}
    </span>
  );
}
