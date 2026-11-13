/**
 * 물리서버 폴더 화면 부품(v2.984) — 그리기만 한다(판정은 서버 · 계산은 bmFoldersText.js).
 */
import React from 'react';
import { SRC_LABEL, SRC_BADGE, pctText } from '../bmFoldersText.js';
import { SRC_COLOR, SRC_LABEL as USRC_LABEL, SRC_LONG, rowSrcClass, srcTitle } from './usageSrc.js'; // v2.993: 사용률 출처 색
import { whyOf, whyShort, WHY_DOT } from './whyText.js'; // v2.992: 값 없음 사유

/** 사용률 막대 + 숫자. 값이 없으면 막대 없이 '—'(0 으로 그리지 않는다). */
export function UsageBar({ v, w = 54, src = null }) {
  if (v == null) return <span className="muted">—</span>;
  const tone = v >= 90 ? 'var(--red)' : v >= 75 ? 'var(--amber)' : 'var(--accent)';
  // v2.993(출처 색): 출처를 알면 막대 = 출처 색(OS 파랑 · iDRAC 밝은 청록), 높음 · 주의는 숫자 색으로 남긴다(색 하나에 두 뜻을 싣지 않게)
  const bar = src && SRC_COLOR[src] ? SRC_COLOR[src] : tone;
  const numColor = src && v >= 75 ? tone : undefined;
  return (
    <span className="bmf-ub" data-sort={v}>
      <span className="bmf-ub-t" style={{ width: w }}><span style={{ width: `${Math.max(0, Math.min(100, v))}%`, background: bar }} /></span>
      <span className="bmf-ub-n" style={numColor ? { color: numColor, fontWeight: 600 } : undefined}>{pctText(v)}</span>
    </span>
  );
}

/** 출처 표지(글자) — 색만으로 가르지 않는다. */
export function SrcChip({ src }) {
  if (!src) return null;
  return <span className={`bmf-sc ${src}`}>{src !== 'mixed' && USRC_LABEL[src] ? USRC_LABEL[src] : SRC_LONG[src] || src}</span>;
}

/** CPU · 메모리 두 줄(열을 줄이려고 합쳤다 — 1440px 실측: 따로 두면 뒤쪽 열이 가로 스크롤 뒤로 숨었다). v2.993: 막대 색 · 오른쪽 표지 = 출처. */
export function UsagePair({ cpu, mem, usrc = null, why = null }) {
  // v2.992(설계 §12): 둘 다 없으면 '—' 아래 짧은 사유 + 누르면 자세한 사유(서버 판정)
  if (cpu == null && mem == null && why?.code) return <WhyTip why={why} what="CPU · 메모리 사용률" />;
  const r = { cpu, mem, usrc };
  const cls = rowSrcClass(r);
  const chips = usrc && !usrc.mixed ? [...new Set([cpu != null ? usrc.cpu : null, mem != null ? usrc.mem : null].filter(Boolean))] : [];
  return (
    <span className="bmf-up" title={cls === 'none' ? undefined : srcTitle(r)}>
      <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 12 }}>
        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><span className="muted" style={{ width: 28 }}>CPU</span><UsageBar v={cpu} w={44} src={usrc?.cpu || null} /></span>
        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><span className="muted" style={{ width: 28 }}>MEM</span><UsageBar v={mem} w={44} src={usrc?.mem || null} /></span>
      </span>
      {chips.length ? <span className="bmf-scs">{chips.map((c) => <SrcChip key={c} src={c} />)}</span> : cls === 'mixed' ? <span className="bmf-scs"><SrcChip src="mixed" /></span> : null}
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

/**
 * v2.992(값 없음 사유 — 설계 §12): '—' 아래 짧은 사유 + 색 점(글자 병기 — 색만으로 가르지 않는다). 실제 버튼 — 누르면(또는 Enter) 자세한 사유가 열리고 Esc · 바깥 누름으로 닫힌다.
 * 문구는 서버가 정한 사유 코드의 글자(whyText.js) — 화면이 원인을 추측하지 않는다.
 */
export function WhyTip({ why, what }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (!open) return undefined;
    const key = (e) => { if (e.key === 'Escape') setOpen(false); };
    const click = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('keydown', key); document.addEventListener('mousedown', click);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('mousedown', click); };
  }, [open]);
  const w = whyOf(why.code);
  const short = whyShort(why);
  return (
    // 클릭이 표 행까지 올라가면 그 행의 옆 패널이 같이 열린다(Chromium 판독 결함) — 이 칸 안의 클릭은 여기서 멈춘다
    <span className="bmf-why" ref={ref} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} role="presentation">
      <span className="muted">—</span>
      <button type="button" className="bmf-why-b" aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }} title={`${w.l} ${w.a}`.trim()}>
        <span className={`bmf-wd ${w.cls}`} style={{ background: WHY_DOT[w.cls] }} aria-hidden="true" />{short}
      </button>
      {open ? (
        <span className="bmf-why-pop" role="dialog" aria-label={`${what} — 값이 없는 이유`}>
          <b>{what} 값이 없습니다</b>
          <span>{w.l}</span>
          {why.at ? <span className="muted">마지막 값 {new Date(why.at).toLocaleString('ko-KR', { hour12: false })}</span> : null}
          {w.a ? <span className="bmf-why-a">{w.a}</span> : null}
        </span>
      ) : null}
    </span>
  );
}

