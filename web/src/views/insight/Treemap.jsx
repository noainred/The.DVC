// views/insight/Treemap.jsx — 묶음 지도(v3.21.0 · 시안 docs/design/vm-insight ‘VM 현황’ · host-insight ‘가상화 호스트 현황’). VM · Hypervisor 분석이 같이 쓴다.
//   배치는 treemap.js treemapLayout(순수) — 여기서는 그리기만. 칸 = 단추(누르면 onToggle — 바로가기 선택에 켜고 끈다 · aria-pressed).
//   칸 안 글은 칸의 실제 높이(px = 높이 % × 지도 높이)로 한 줄 / 두 줄(tileLineMode).
//   v3.23.0(설계 docs/design/insight-tiles · 컨펌 ‘진행해’ — 추천 B + C + D): 넓은 화면은 지도 폭을 재서(ResizeObserver) tilePack.packLayout 으로 다시 놓는다 —
//   칸이 많은 지역은 여러 열 · 칸마다 글자 단계(xl · l · m · one · none) · 이름이 안 들어가는 칸이 한 지역에 둘 이상이면 ‘그 밖 N개’ 한 칸(누르면 아래에 목록).
import React, { useEffect, useMemo, useState } from 'react';
import { tileLineMode } from './treemap.js';
import { packLayout, estTextW, orderMembers } from './tilePack.js';
import { numOrNull } from '../../numOrNull.js';
import { useNarrowScreen } from '../../components/useNarrowScreen.js';
import { STable } from '../../components/STable.jsx';
import './insight.css';

/** 글자 폭 재기 — canvas measureText(지도의 글꼴 · 굵기 800). 못 쓰면(시험 · 오래된 환경) 어림식. 같은 (글, 크기)는 한 번만 잰다. */
function makeTextW(fontFamily) {
  let ctx = null;
  try { ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null; } catch { ctx = null; }
  if (!ctx) return estTextW;
  const memo = new Map();
  return (text, px) => {
    const k = `${px}|${text}`;
    let w = memo.get(k);
    if (w == null) { ctx.font = `800 ${px}px ${fontFamily || 'sans-serif'}`; w = ctx.measureText(String(text ?? '')).width; memo.set(k, w); }
    return w;
  };
}

/** 지도 폭(px) — 처음 그림 뒤 재고, 창 크기가 바뀌면 다시 잰다. ResizeObserver 가 없으면 붙을 때 한 번만.
 *  dbg3231: **콜백 ref** — .ins-map 이 새로 붙을 때마다(좁은 화면 → 넓은 화면) 그 요소를 다시 관찰한다. 예전 useEffect(…, [ref]) 는 마운트 때 한 번만 돌아
 *  좁게 시작하면 끝내 재지 않았고(null), 넓게 → 좁게 → 넓게면 떼어진 옛 요소만 보다가 0 으로 굳었다(그 뒤 전부 두 줄 · 여러 열 · 묶음 없음).
 *  요소가 떨어지면 null(폭 모름) · 0 도 모름으로 본다. 반환 [ref 콜백, 폭, 요소]. */
function useWidth() {
  const [el, setEl] = useState(null);
  const [w, setW] = useState(null);
  useEffect(() => {
    if (!el) { setW(null); return undefined; }
    const read = () => { const v = Math.round(el.getBoundingClientRect().width); const n = v > 0 ? v : null; setW((p) => (p === n ? p : n)); };
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, w, el];
}

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
 * @param {(members:object[], group:object)=>{title,line,tip,bg,ink,mark?}} [p.groupView]  v3.23.0: ‘그 밖 N개’ 칸의 글 · 색 — 색은 구성원 중 가장 높은 값(나쁜 것이 묶음에 가려지지 않게).
 *   없으면 구성원 첫 칸의 색을 쓴다.
 * @param {(w:number)=>void} [p.onWidth]  v3.23.0: 잰 지도 폭(px) — 호출부가 자동 높이(maxTilesPacked)에 쓴다.
 * @param {(tile:object)=>string} [p.whereOf]  v3.23.0: 묶음 목록의 ‘법인’ 칸 — 칸 이름이 법인마다 겹칠 수 있는 지도(클러스터)만 준다.
 * @param {(tile:object)=>number|null} [p.valOf]  dbg3231: 칸의 채움 값(색 기준) — 묶음 목록을 값 높은 순(모름 뒤)으로 놓고 ‘값’ 열을 그 값으로 정렬한다(설계 §3).
 *   없으면 배치 순서 · 크기로.
 */
export default function Treemap({ layout, heightPx, tileView, selected = null, onToggle = null, colText = null, label, pickOf = null, groupView = null, onWidth = null, whereOf = null, valOf = null }) {
  const cols = layout?.cols || [];
  const hasSel = !!(selected && selected.size);
  const narrow = useNarrowScreen(MAP_NARROW_QUERY);
  const [boxRef, widthPx, boxEl] = useWidth();
  const [openGroup, setOpenGroup] = useState('');
  const textW = useMemo(() => {
    let fam = '';
    try { fam = boxEl && typeof getComputedStyle === 'function' ? getComputedStyle(boxEl).fontFamily : ''; } catch { fam = ''; }
    return makeTextW(fam);
  }, [widthPx]); // eslint-disable-line react-hooks/exhaustive-deps
  const packed = useMemo(() => (narrow ? null : packLayout(layout, { widthPx, heightPx, textW, markOf: (t) => !!tileView(t).mark })), [narrow, layout, widthPx, heightPx, textW]); // eslint-disable-line react-hooks/exhaustive-deps
  // dbg3231: 폭을 모르면(좁은 화면 · 떨어짐) null 을 알린다 — 호출부가 넓을 때의 옛 폭으로 자동 높이를 계산하지 않게.
  useEffect(() => { if (onWidth) onWidth(widthPx || null); }, [onWidth, widthPx]);
  const pidOf = (t) => String(pickOf ? pickOf(t) : t.id);
  // dbg3231: 칸 색은 backgroundColor 로 — 인라인 background(단축형)는 .ins-tl.stale 의 빗금(background-image)을 지웠다(오래됨이 보이지 않았다).
  const tileBtn = (t, pos, mode) => {
    const v = tileView(t);
    const pid = pidOf(t);
    const on = hasSel && selected.has(pid);
    const cls = `ins-tl ${mode}${on ? ' on' : (hasSel ? ' dim' : '')}${v.stale ? ' stale' : ''}`;
    return (
      <button key={t.id} type="button" className={cls} aria-pressed={on} title={v.tip}
        onClick={onToggle ? () => onToggle(pid) : undefined}
        style={{ ...pos, backgroundColor: v.bg, color: v.ink }}>
        <b>{v.title}</b><span>{v.line}</span>{v.mark ? <em className="ins-mk">{v.mark}</em> : null}
      </button>
    );
  };
  const groupBtn = (t, pos) => {
    const v = groupView ? groupView(t.members, t) : { ...tileView(t.members[0]), title: t.label, line: '', tip: `${t.label} — 누르면 아래에 목록이 열립니다`, mark: null };
    const open = openGroup === t.id;
    const anyOn = hasSel && t.members.some((m) => selected.has(pidOf(m)));
    const cls = `ins-tl grp t-${t.tier}${t.tier === 'one' ? ' one' : ''}${open || anyOn ? ' on' : (hasSel ? ' dim' : '')}${v.stale ? ' stale' : ''}`;
    return (
      <button key={t.id} type="button" className={cls} aria-expanded={open} title={v.tip}
        onClick={() => setOpenGroup(open ? '' : t.id)}
        style={{ ...pos, backgroundColor: v.bg, color: v.ink }}>
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
  const drawCols = packed ? packed.cols : cols;
  const og = packed ? packed.groups.find((g) => g.id === openGroup) || null : null;
  // dbg3231 2회차: 목록 순서도 묶음 칸 대표 값(worstMember)과 같은 순위 — 지금 값 → 오래된 값 → 모름(오래된 높은 값이 맨 위에 오지 않게).
  const ogMembers = og ? (valOf ? orderMembers(og.members, valOf, (m) => tileView(m).stale === true) : og.members) : [];
  const pos = (t) => ({ left: `${t.left}%`, top: `${t.top}%`, width: `${t.width}%`, height: `${t.height}%` });
  return (
    <>
      <div className="ins-mapcols" aria-hidden="true">
        {cols.map((c) => <span key={c.key} style={{ left: `${c.left}%`, width: `${c.width}%` }} title={colText ? colText(c) : c.label}>{colText ? colText(c) : c.label}</span>)}
      </div>
      <div className="ins-map" ref={boxRef} style={{ height: heightPx }} role="group" aria-label={label}>
        {drawCols.flatMap((c) => c.tiles.map((t) => (t.group
          ? groupBtn(t, pos(t))
          : tileBtn(t, pos(t), t.tier ? `t-${t.tier}${t.tier === 'one' ? ' one' : ''}` : tileLineMode(t.height, heightPx)))))}
      </div>
      {og && (
        <div className="ins-grp" role="region" aria-label={`${og.label} — 그 밖 ${og.members.length}개`}>
          <div className="ins-grph">
            <b>{`${og.label} — 그 밖 ${og.members.length}개`}</b>
            <span className="hint">지도에서 칸이 너무 작아 한 칸으로 묶은 것입니다 — 제목을 누르면 정렬 · 이름을 누르면 그 법인을 바로가기 선택에 켜고 끕니다</span>
            <button type="button" className="ins-btn" onClick={() => setOpenGroup('')}>닫기 ✕</button>
          </div>
          <STable className="vmh-corp-table" minWidth={520}>
            <thead><tr><th>이름</th>{whereOf && <th>법인</th>}<th>값</th><th>표</th></tr></thead>
            <tbody>
              {ogMembers.map((m) => {
                const v = tileView(m); const pid = pidOf(m); const on = hasSel && selected.has(pid);
                // dbg3231 2회차: 오래된 값은 목록에서도 보이게 — 견본 빗금 + 값 칸 ‘(오래됨)’(예전에는 툴팁에만 있어 지금 값과 똑같이 보였다).
                //   견본 색은 backgroundColor 로(단축형 background 는 빗금 background-image 를 지운다).
                const sw = <i className={v.stale ? 'stale' : undefined} style={{ backgroundColor: v.bg }} />;
                return (
                  <tr key={m.id}>
                    <td data-sort={v.title}>{onToggle
                      ? <button type="button" className={`ins-grpn${on ? ' on' : ''}`} aria-pressed={on} title={v.tip} onClick={() => onToggle(pid)}>{sw}{v.title}</button>
                      : <span className="ins-grpn">{sw}{v.title}</span>}</td>
                    {whereOf && <td>{whereOf(m)}</td>}
                    <td data-sort={valOf ? (numOrNull(valOf(m)) ?? '—') : m.size}>{v.line}{v.stale ? <span className="ins-grpst"> (오래됨)</span> : null}</td>
                    <td data-sort={v.mark ? 1 : 0}>{v.mark ? <em className="ins-mk">{v.mark}</em> : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
        </div>
      )}
    </>
  );
}
