// views/insight/Treemap.jsx — 묶음 지도(v3.21.0 · 시안 docs/design/vm-insight ‘VM 현황’ · host-insight ‘가상화 호스트 현황’). VM · Hypervisor 분석이 같이 쓴다.
//   배치는 treemap.js treemapLayout(순수) — 여기서는 그리기만. 칸 = 단추(누르면 onToggle — 바로가기 선택에 켜고 끈다 · aria-pressed).
//   칸 안 글은 칸의 실제 높이(px = 높이 % × 지도 높이)로 한 줄 / 두 줄(tileLineMode).
import React from 'react';
import { tileLineMode } from './treemap.js';
import { useNarrowScreen } from '../../components/useNarrowScreen.js';
import './insight.css';

/** 좁은 화면(≤720px)에서는 지역 묶음을 세로로 쌓는다(설계 vm-insight §5 · v3.21.0 Chromium 400px 판독 — 열 4개를 352px 에 나누면 칸 폭이 40~80px 라 이름이 ‘vcent…’ 로 잘렸다).
 *  배치는 같은 treemapLayout 을 돌려 쓴다 — 열(지역)의 폭 몫 → 띠의 높이 몫, 열 안 칸의 높이 몫 → 띠 안 칸의 폭 몫. */
export const MAP_NARROW_QUERY = '(max-width: 720px)';
export const BAND_MIN_PX = 56;
export function bandHeightPx(colWidthPct, mapPx) {
  const w = Number(colWidthPct); const m = Number(mapPx);
  if (!Number.isFinite(w) || !Number.isFinite(m)) return BAND_MIN_PX;
  return Math.max(BAND_MIN_PX, Math.round((w / 100) * m));
}

/**
 * @param {object} p
 * @param {{cols:Array}} p.layout       treemapLayout 결과
 * @param {number} p.heightPx           지도 높이(px)
 * @param {(tile:object)=>{title:string,line:string,tip:string,bg:string,ink:string,stale?:boolean}} p.tileView  칸 하나의 글 · 색
 * @param {Set<string>} [p.selected]    고른 칸 id(있으면 나머지는 흐리게)
 * @param {(id:string)=>void} [p.onToggle]
 * @param {(col:object)=>string} [p.colText]  열 머리 글자
 * @param {string} p.label              접근성 이름
 * @param {(tile:object)=>string} [p.pickOf]  v3.22.0: 칸을 고르는 id(눌림 · onToggle) — 기본은 칸 id. Hypervisor 분석은 칸 = 클러스터 · 고르는 것 = 그 법인이라 다르다.
 *   tileView 가 mark(글자)를 주면 칸 안에 작은 표로 그린다(Hypervisor ‘못 버팀’ — 색이 아니라 표로 · S6).
 */
export default function Treemap({ layout, heightPx, tileView, selected = null, onToggle = null, colText = null, label, pickOf = null }) {
  const cols = layout?.cols || [];
  const hasSel = !!(selected && selected.size);
  const narrow = useNarrowScreen(MAP_NARROW_QUERY);
  const tileBtn = (t, pos, mode) => {
    const v = tileView(t);
    const pid = String(pickOf ? pickOf(t) : t.id);
    const on = hasSel && selected.has(pid);
    const cls = `ins-tl ${mode}${on ? ' on' : (hasSel ? ' dim' : '')}${v.stale ? ' stale' : ''}`;
    return (
      <button key={t.id} type="button" className={cls} aria-pressed={on} title={v.tip}
        onClick={onToggle ? () => onToggle(pid) : undefined}
        style={{ ...pos, background: v.bg, color: v.ink }}>
        <b>{v.title}</b><span>{v.line}</span>{v.mark ? <em className="ins-mk">{v.mark}</em> : null}
      </button>
    );
  };
  if (narrow) {
    return (
      <div className="ins-mapv" role="group" aria-label={label}>
        {cols.map((c) => {
          const h = bandHeightPx(c.width, heightPx);
          return (
            <div key={c.key} className="ins-band">
              <div className="ins-bandh" title={colText ? colText(c) : c.label}>{colText ? colText(c) : c.label}</div>
              <div className="ins-bandt" style={{ height: h }}>
                {c.tiles.map((t) => tileBtn(t, { left: `${t.top}%`, top: 0, width: `${t.height}%`, height: '100%' }, tileLineMode(100, h)))}
              </div>
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <>
      <div className="ins-mapcols" aria-hidden="true">
        {cols.map((c) => <span key={c.key} style={{ left: `${c.left}%`, width: `${c.width}%` }} title={colText ? colText(c) : c.label}>{colText ? colText(c) : c.label}</span>)}
      </div>
      <div className="ins-map" style={{ height: heightPx }} role="group" aria-label={label}>
        {cols.flatMap((c) => c.tiles.map((t) => tileBtn(t, { left: `${t.left}%`, top: `${t.top}%`, width: `${t.width}%`, height: `${t.height}%` }, tileLineMode(t.height, heightPx))))}
      </div>
    </>
  );
}
