/**
 * Bareos 화면 공용 조각(v2.860 — 시안 docs/design/bareos-ui-v2 '공통 뼈대').
 *   Note      얇은 알림 한 줄(데모 · 범위 · 읽기 실패) — 박스 배너를 쌓지 않는다. 문구는 부르는 쪽 그대로.
 *   ReadGuide '읽는 법' 토글(기본 접힘) — 칸 설명 · 범례 · 값 출처 문단을 화면에서 치우되 지우지 않는다.
 *   Stat      상태 띠 카드(한 화면에 4장까지) · ResultBar 마지막 결과 막대(성공 · 경고 · 실패 · 진행).
 *   Segs      운영 탭 안의 묶음(백업 대상 · 백업 그룹 · 진행 · 이력).
 * 색은 styles.css 토큰과 배지 글자색만 쓴다(새 hex 를 늘리지 않는다). 값이 없으면 '—'(0 이 아니다 — 부르는 쪽이 numText 로).
 */
import React, { useId, useState } from 'react';

const NOTE_COLOR = { warn: '#fcd34d', bad: '#fca5a5', info: 'var(--text-dim)', ok: '#86efac' };

export function Note({ tone = 'warn', children, role }) {
  return (
    <div role={role || (tone === 'bad' ? 'alert' : undefined)} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, lineHeight: 1.55, color: NOTE_COLOR[tone] || NOTE_COLOR.info, minWidth: 0 }}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" style={{ flex: 'none', marginTop: 2 }}>
        <circle cx="8" cy="8" r="6.5" /><path d={tone === 'info' ? 'M8 7v4M8 5h.01' : 'M8 5v3.5M8 11h.01'} />
      </svg>
      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{children}</span>
    </div>
  );
}

/** '읽는 법' 토글 — note(한 문장 각주)는 늘 보이고, children(긴 설명)은 눌렀을 때만. */
export function ReadGuide({ note = null, children }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div data-bareos-guide="" style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-dim)' }}>
        {note && <span style={{ minWidth: 0, flex: '1 1 320px', overflowWrap: 'anywhere' }}>{note}</span>}
        {children && (
          <button type="button" className="tab" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)} style={{ padding: '3px 10px', fontSize: 11.5, marginLeft: 'auto' }}>
            읽는 법 {open ? '▴' : 'ⓘ'}
          </button>
        )}
      </div>
      {children && open && <div id={id} className="card" style={{ padding: '10px 14px', fontSize: 12, lineHeight: 1.7, minWidth: 0 }}>{children}</div>}
    </div>
  );
}

const STAT_TONE = { bad: 'rgba(239,68,68,.45)', warn: 'rgba(245,158,11,.45)', run: 'rgba(96,165,250,.45)' };
const STAT_TEXT = { bad: '#fca5a5', warn: '#fcd34d', run: '#93c5fd' };
export function Stat({ label, value, sub, tone, children }) {
  return (
    <div className="card" style={{ padding: '12px 14px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6, ...(tone && STAT_TONE[tone] ? { borderColor: STAT_TONE[tone] } : {}) }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
      {value !== undefined && <div style={{ fontSize: 24, fontWeight: 800, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere', ...(tone && STAT_TEXT[tone] ? { color: STAT_TEXT[tone] } : {}) }}>{value}</div>}
      {children}
      {sub && <div className="muted" style={{ fontSize: 12, display: 'flex', flexWrap: 'wrap', gap: '2px 10px', overflowWrap: 'anywhere' }}>{sub}</div>}
    </div>
  );
}
/** 상태 띠 — 카드 4장까지(시안 '큰 숫자는 4개까지'). 좁으면 2열. */
export const STAT_GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(230px, calc(50% - 6px)), 1fr))', gap: 12 };

/** 점 하나(상태 색) — 글자와 함께 쓴다(색만으로 구분하지 않는다). unknown 은 점선 테두리. */
export function Dot({ color, unknown = false }) {
  return <span aria-hidden="true" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', flex: 'none', ...(unknown ? { border: '1.5px dashed var(--text-dim)' } : { background: color }) }} />;
}

/**
 * 결과 막대 — b = resultBar() 값({ok,warn,fail,run} %). 없으면 null 을 그리지 않는다(부르는 쪽이 '모름' · '잡 없음' 글자).
 */
export function ResultBar({ b, label, width = '100%', height = 8 }) {
  if (!b) return null;
  return (
    <div role="img" aria-label={label} style={{ display: 'flex', height, width, borderRadius: height / 2, overflow: 'hidden', background: 'var(--panel-deep)' }}>
      <div style={{ width: `${b.ok}%`, background: '#4ade80' }} /><div style={{ width: `${b.warn}%`, background: '#fbbf24' }} />
      <div style={{ width: `${b.fail}%`, background: '#f87171' }} /><div style={{ width: `${b.cancel || 0}%`, background: '#94a3b8' }} /><div style={{ width: `${b.run}%`, background: '#60a5fa' }} />
    </div>
  );
}

/** 운영 묶음 버튼 줄 — items: [[key, label, count?]] · count 는 글자 그대로(숫자는 부르는 쪽이 numText). */
export function Segs({ items, active, onPick, label = '운영 보기' }) {
  return (
    <div role="tablist" aria-label={label} style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, minWidth: 0 }}>
      {items.map(([k, l, n]) => {
        const on = k === active;
        return (
          <button key={k} type="button" role="tab" aria-selected={on} onClick={() => onPick(k)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minHeight: 32, padding: '0 14px', borderRadius: 8, border: `1px solid ${on ? 'var(--text)' : 'var(--border)'}`, background: on ? 'var(--text)' : 'var(--panel-2)', color: on ? 'var(--bg)' : 'var(--text-dim)', font: 'inherit', fontSize: 13, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            {l}{n != null && n !== '' ? <span style={{ fontSize: 11.5, fontWeight: 700, padding: '1px 7px', borderRadius: 999, background: on ? 'rgba(10,14,23,.12)' : 'rgba(139,155,180,.14)' }}>{n}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** 칩(필터) — on 이면 파란 채움. */
export function FilterChip({ on, onClick, children, title }) {
  return (
    <button type="button" className={`tab${on ? ' active' : ''}`} aria-pressed={on} onClick={onClick} title={title}
      style={{ padding: '4px 12px', fontSize: 12, borderRadius: 999, display: 'inline-flex', alignItems: 'center', gap: 6 }}>{children}</button>
  );
}
