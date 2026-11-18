// views/insight/InsightParts.jsx — 분석 화면 공용 그림 부품(v3.21.0 · 시안 docs/design/vm-insight · host-insight). VM · Hypervisor 분석이 같이 쓴다.
//   숫자 타일 · 확인할 것 칸 · 조각 막대(+범례) · 순서 막대 줄 · 키-값 줄 · 히스토그램 · 묶음 접기. 값 계산은 하지 않는다(호출부가 순수 함수로 만든 값을 그린다).
//   못 읽은 값은 '—'(단위 없음) — 글자는 호출부가 fmtN · gbText 로 만든다. 문구에 백틱 금지.
import React from 'react';
import { numOrNull } from '../../numOrNull.js';
import { fmtN, shareText } from './insightCore.js';
import './insight.css';

/** 숫자 타일 — meter(0~100)가 있으면 아래 막대. tone: crit | warn | ''. */
export function NumTile({ label, value, sub = null, meter = null, tone = '', tip = undefined }) {
  const m = numOrNull(meter);
  return (
    <div className={`ins-tile${tone ? ` ${tone}` : ''}`} title={tip}>
      <span className="l">{label}</span>
      <span className="v">{value}</span>
      {m != null && <span className="ins-meter" aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, m))}%` }} /></span>}
      {sub && <span className="s">{sub}</span>}
    </div>
  );
}

/**
 * 확인할 것 한 줄 — items: [{ key, label, value, sub?, tone, href?, tip? }].
 * value 가 수면 천 단위 쉼표 · 0 이면 회색(tone 무시) · 못 읽으면 '—'. 글자(다른 부품이 이미 만든 표시 글자 — 예 '1,234' · '—')면 그대로 쓰고 tone 은 그 부품이 정한 대로.
 */
export function CheckLine({ title = '확인할 것', items = [] }) {
  return (
    <section className="ins-todo" aria-label={title}>
      <span className="tl">{title}</span>
      {items.map((x) => {
        const isText = typeof x.value === 'string';
        const n = isText ? null : numOrNull(x.value);
        const tone = isText ? (x.tone || '') : (n != null && n > 0 ? (x.tone || '') : '');
        const shown = isText ? (x.value.trim() || '—') : (n == null ? '—' : fmtN(n));
        const body = (
          <>
            <b>{shown}</b>
            <span className="tt">{x.label}</span>
            {x.sub && <span className="ts">{x.sub}</span>}
          </>
        );
        return x.href
          ? <a key={x.key} className={`ins-td ${tone}`} href={x.href} title={x.tip}>{body}</a>
          : <div key={x.key} className={`ins-td ${tone}`} title={x.tip}>{body}</div>;
      })}
    </section>
  );
}

/** 패널 머리 — 제목 · 안내 · 오른쪽 글. */
export function PanelHead({ title, hint = null, right = null }) {
  return (
    <div className="ins-ph">
      <h2>{title}</h2>
      {hint && <span className="hint">{hint}</span>}
      {right != null && right !== '' && <span className="rt">{right}</span>}
    </div>
  );
}

/**
 * 조각 막대 — segs: [{ key, label, n, bg, ink? }]. tall 이면 조각 위에 수. legend 면 아래 범례(수 · 몫).
 * 0 · 모름 조각은 막대에 그리지 않는다(범례에는 남긴다 — '모름 N' 을 숨기지 않는다). 전체가 0 이면 빈 막대.
 */
export function StackBar({ segs = [], tall = false, legend = true, total = null, label = undefined, extra = null }) {
  const shown = segs.filter((s) => (numOrNull(s.n) ?? 0) > 0);
  const whole = numOrNull(total) ?? segs.reduce((a, s) => a + (numOrNull(s.n) ?? 0), 0);
  return (
    <>
      <div className={`ins-stack${tall ? ' tall' : ''}${shown.length ? '' : ' empty'}`} role="img" aria-label={label || segs.map((s) => `${s.label} ${fmtN(s.n)}`).join(' · ')}>
        {shown.map((s) => (tall
          ? <span key={s.key} style={{ flex: `${s.n} 1 0`, background: s.bg, color: s.ink || '#fff' }} title={`${s.label} ${fmtN(s.n)} · ${shareText(s.n, whole)}`}>{fmtN(s.n)}</span>
          : <i key={s.key} style={{ flex: `${s.n} 1 0`, background: s.bg }} title={`${s.label} ${fmtN(s.n)} · ${shareText(s.n, whole)}`} />))}
      </div>
      {legend && (
        <div className="ins-lgd">
          {segs.map((s) => (
            <span key={s.key}><i style={{ background: s.bg }} />{s.label} <b>{fmtN(s.n)}</b>{s.note ? ` · ${s.note}` : (whole > 0 && numOrNull(s.n) != null ? ` · ${shareText(s.n, whole)}` : '')}</span>
          ))}
          {extra}
        </div>
      )}
    </>
  );
}

/** 순서 막대 줄 — rows: [{ key, name, n, valueText?, share?, bg?, tip?, small? }]. 막대 폭은 가장 큰 값 대비. */
export function RankBars({ rows = [], small = false, max = null }) {
  const top = numOrNull(max) ?? rows.reduce((m, r) => Math.max(m, numOrNull(r.n) ?? 0), 0);
  return rows.map((r) => {
    const n = numOrNull(r.n);
    const w = n == null || top <= 0 ? 0 : Math.max(0, Math.min(100, (n / top) * 100));
    return (
      <div key={r.key} className={`ins-rb${small ? ' sm' : ''}`} title={r.tip}>
        <span className="n">{r.name}</span>
        <span className="ins-track"><i style={{ width: `${w}%`, ...(r.bg ? { background: r.bg } : {}) }} /></span>
        <span className="v">{r.valueText ?? fmtN(n)}{r.share ? <small>{r.share}</small> : null}</span>
      </div>
    );
  });
}

/** 키-값 줄 — rows: [{ key, label, value(글자), warn?, tip? }]. */
export function KvRows({ rows = [] }) {
  return rows.map((r) => (
    <div key={r.key} className="ins-kv" title={r.tip}><span>{r.label}</span><b className={r.warn ? 'w' : undefined}>{r.value}</b></div>
  ));
}

/**
 * 히스토그램 — bins: 수 배열(칸 폭 binPct %) · critFrom 이상 칸은 빨강. 숫자는 가장 큰 칸과 경고 칸에만(나머지는 title).
 * 칸 높이는 가장 큰 칸 대비(0 칸도 2px — 칸이 있다는 표시).
 */
export function Histogram({ bins = [], binPct = 10, critFrom = null, what = '' }) {
  const vals = bins.map((v) => numOrNull(v) ?? 0);
  const max = vals.reduce((m, v) => Math.max(m, v), 0);
  const topI = vals.indexOf(max);
  const crit = numOrNull(critFrom);
  const last = vals.length * binPct;
  return (
    <>
      <div className="ins-hist" role="img" aria-label={`${what} 분포 — ${vals.map((v, i) => `${i * binPct}–${(i + 1) * binPct}% ${v}대`).join(' · ')}`}>
        {vals.map((v, i) => {
          const isCrit = crit != null && i * binPct >= crit;
          return (
            <span key={i} className={`ins-col${isCrit ? ' crit' : ''}`} title={`${what} ${i * binPct}–${(i + 1) * binPct}%${i === vals.length - 1 ? '(그 이상 포함)' : ''} · ${fmtN(v)}대`}>
              <b>{max > 0 && (i === topI || (isCrit && v > 0)) ? fmtN(v) : ''}</b>
              <i style={{ height: `${max ? Math.max(2, (v / max) * 82) : 2}%` }} />
            </span>
          );
        })}
      </div>
      <div className="ins-axis"><span>0</span><span>{Math.round(last / 2)}</span><span>{last}%</span></div>
    </>
  );
}

/** 큰 숫자 + 설명(패널 왼쪽 머리). */
export function Hero({ value, text, tone = null }) {
  return <div className="ins-hero"><b style={tone ? { color: tone } : undefined}>{value}</b><span>{text}</span></div>;
}
/** 작은 타일 3개 — stats: [{ key, value, text, color?, tip? }]. */
export function MiniStats({ stats = [] }) {
  return (
    <div className="ins-st">
      {stats.map((s) => <div key={s.key} title={s.tip}><b style={s.color ? { color: s.color } : undefined}>{s.value}</b><span>{s.text}</span></div>)}
    </div>
  );
}

/**
 * 묶음 접기 — 머리줄(제목 · 접었을 때의 한 줄 요약 · 접기 단추) + 본문. 접힘 상태는 호출부가 들고(기억은 insightPrefs) 여기서는 그리기만.
 * 접으면 본문을 그리지 않는다(안의 도구 패널이 요청을 보내지 않게).
 */
export function FoldGroup({ id, title, summary = null, folded = false, onToggle, children }) {
  const bodyId = `ins-fold-${id}`;
  return (
    <section className="ins-fold" aria-label={title}>
      <div className="ins-foldbar">
        <h2>{title}</h2>
        {summary && <span className="hint">{summary}</span>}
        <button type="button" className="fb" aria-expanded={!folded} aria-controls={bodyId} onClick={onToggle}>{folded ? '펼치기 ▾' : '접기 ▴'}</button>
      </div>
      {!folded && <div id={bodyId} className="ins-fold" style={{ gap: 14 }}>{children}</div>}
    </section>
  );
}
