/**
 * views/insight/tilePack.js — 지도 칸 글자가 작은 칸에서도 읽히게(v3.23.0 · 설계 docs/design/insight-tiles · 컨펌 2026-11-19 ‘진행해’ — 기본값 추천 B + C + D).
 *
 *  treemapLayout(treemap.js)의 결과(묶음 = 세로 한 열 · 칸 = 가로 띠)를 지도의 실제 px 크기에 맞춰 다시 놓는다 — 순수 · vitest 고정.
 *   D · 여러 열: 칸이 많은 묶음(지역)은 그 열을 1 ~ 4개의 작은 열로 나눈다 — 작은 열 폭 MIN_SUBCOL_W 아래로는 나누지 않고,
 *      그 안에서 **이름이 보이는 칸이 가장 많은** 열 수(같으면 적은 수)를 고른다. 칸의 **넓이**는 여전히 크기 값에 정확히 비례한다.
 *      (v3.23.0 Chromium 판독 — 처음의 ‘가장 낮은 칸 30px’ 기준은 실제 지도 폭(지역 하나 ≈ 200 ~ 320px)에서 한 번도 나누지 않았다.)
 *   C · 작은 칸 묶기: 그래도 이름(12.5px)이 들어가지 않는 칸이 한 묶음에 GROUP_MIN 개 이상이면 ‘그 밖 N개’ 한 칸으로 합치고 다시 놓는다.
 *   B · 글자 단계: 칸마다 tier — xl(이름 16 · 값 13) · l(13.5 · 12) · m(12.5 · 12) · one(한 줄) · none(글 없음 — 색과 표만).
 *  반환 좌표는 treemapLayout 과 같은 % 단위(left · top · width · height — 지도 전체 기준)라 그리는 쪽이 그대로 쓴다.
 *  글자 폭은 textW(글, px 크기) 로 잰다 — 화면은 canvas measureText, 시험 · 측정 불가 환경은 어림식(estTextW).
 */
import { numOrNull } from '../../numOrNull.js';
import { autoMapHeight } from './insightPrefs.js';

export const MIN_SUBCOL_W = 120;     // 작은 열 하나의 가장 좁은 폭(px) — 실제로 나눌지는 ‘이름이 보이는 칸 수’ 로 정한다(packLayout)
export const MAX_SUBCOLS = 4;
export const TARGET_MIN_H = 30;      // 이 높이(px) 이상이면 열을 더 나누지 않는다
export const NAME_MIN_H = 22.5;      // 이름 한 줄(12.5px)이 들어가는 가장 낮은 칸
export const GROUP_MIN = 2;          // 이만큼 이상 작은 칸이 모이면 묶는다
export const PAD_X = 18;             // 칸 안쪽 좌우 여백 + 테두리 합(px — padding 8 × 2 + border 1 × 2)
export const MARK_ROW_H = 17;        // 두 줄 칸에서 ‘못 버팀’ 표가 셋째 줄로 붙을 때 더 필요한 높이(px)
export const TIER = Object.freeze({
  xl: { name: 16, line: 13, minW: 220, minH: 96 },
  l: { name: 13.5, line: 12, minH: 52 },
  m: { name: 12.5, line: 12, minH: 46 },
  one: { name: 12.5, line: 12, minH: NAME_MIN_H },
});

/** 글자 폭 어림 — 한글 · 전각 = 크기 × 0.95 · 공백 × 0.3 · 그 밖(굵은 라틴) × 0.62. */
export function estTextW(text, px) {
  let w = 0;
  for (const ch of String(text ?? '')) w += /[ᄀ-ᇿ　-鿿가-힣＀-￯]/.test(ch) ? px * 0.95 : ch === ' ' ? px * 0.3 : px * 0.62;
  return w;
}

/** 칸 하나의 글자 단계 — 칸 px 크기와 이름 폭으로. */
export const MARK_W = 58;            // 칸 안 ‘못 버팀’ 표의 폭(px) — 한 줄 칸에서는 이름과 나란히 놓인다
export function tierOf(wPx, hPx, name, textW = estTextW, { mark = false } = {}) {
  const room = wPx - PAD_X;
  const fits = (px) => textW(name, px) <= room;
  const ex = mark ? MARK_ROW_H : 0;   // v3.23.0 Chromium 판독 — 표가 붙는 두 줄 칸은 세 줄이라 이름이 위로 잘렸다
  if (wPx >= TIER.xl.minW && hPx >= TIER.xl.minH + ex && fits(TIER.xl.name)) return 'xl';
  if (hPx >= TIER.l.minH + ex && fits(TIER.l.name)) return 'l';
  if (hPx >= TIER.m.minH + ex && fits(TIER.m.name)) return 'm';
  if (hPx >= TIER.one.minH && textW(name, TIER.one.name) + (mark ? MARK_W + 8 : 0) <= room) return 'one';
  return 'none';
}

/** 열 하나(크기 큰 순 칸들)를 k 개의 작은 열로 — 앞에서부터 차례로 채우고 몫이 고르게. */
export function splitInto(items, k) {
  const tot = items.reduce((a, t) => a + t.size, 0);
  if (k <= 1 || items.length <= 1) return [items.slice()];
  const out = []; let cur = []; let acc = 0; let done = 0;
  items.forEach((t, i) => {
    cur.push(t); acc += t.size;
    const left = items.length - i - 1;
    const remainCols = k - out.length;
    const target = (tot - done) / remainCols;
    if (out.length < k - 1 && acc >= target - t.size / 2 && left >= remainCols - 1) { out.push(cur); done += acc; cur = []; acc = 0; }
  });
  if (cur.length) out.push(cur);
  return out;
}

const minTileH = (parts, hPx) => Math.min(...parts.map((p) => { const ct = p.reduce((a, t) => a + t.size, 0); return Math.min(...p.map((t) => (t.size / ct) * hPx)); }));

/** 작은 열 수 고르기 — 폭이 허락하는 안에서, 가장 낮은 칸이 TARGET_MIN_H 이상이 되는 가장 적은 수(못 닿으면 가장 높게 만드는 수). */
export function chooseSplit(items, colWPx, hPx) {
  let best = null;
  for (let k = 1; k <= MAX_SUBCOLS; k++) {
    if (k > 1 && (colWPx / k < MIN_SUBCOL_W || k > items.length)) break;
    const parts = splitInto(items, k);
    const mh = minTileH(parts, hPx);
    if (!best || mh > best.minH) best = { k, parts, minH: mh };
    if (mh >= TARGET_MIN_H) return { k, parts, minH: mh };
  }
  return best;
}

/** 배치 결과에서 가장 긴 작은 열의 칸 수 — 같은 left 의 칸이 한 작은 열이다(묶음 칸도 한 칸). */
export function longestPackedCol(packed) {
  let m = 0;
  for (const c of packed?.cols || []) {
    const byX = new Map();
    for (const t of c.tiles) { const k = Math.round(t.left * 1000); byX.set(k, (byX.get(k) || 0) + 1); }
    for (const n of byX.values()) m = Math.max(m, n);
  }
  return m;
}

const _maxMemo = new Map();   // 같은 배치 · 폭이면 다시 놓지 않는다(화면이 다시 그릴 때마다 부른다) — 최근 8개
/**
 * 자동 지도 높이용 칸 수(dbg3231 — 설계 §6⑤ ‘가장 긴 **열**의 칸 수 × 64’). 실제 packLayout(묶기 없이 — 여러 열만)을 돌려
 * 가장 긴 작은 열의 칸 수를 센다. 높이가 열 수 고르기에 들어가므로, 자동 높이 후보(낮은 것부터)마다 놓아 보고
 * ‘그 높이에서 가장 긴 열 × 64 ≤ 그 높이’ 가 되는 가장 낮은 높이의 칸 수를 고른다(가장 높은 후보 = 나누지 않은 수라 반드시 끝난다).
 * 예전 ceil(n / 폭이 허락하는 최대 열 수) 어림은 실제 배치(읽히는 칸이 가장 많은 열 수 · 크기 몫으로 나눔)보다 작게 나왔다.
 * widthPx 를 모르면 나누지 않은 수. opt = { textW, nameOf, markOf } — packLayout 과 같은 뜻(없으면 어림 글자 폭).
 */
export function maxTilesPacked(layout, widthPx, opt = {}) {
  const W = numOrNull(widthPx);
  const cols = layout?.cols || [];
  const unsplit = cols.reduce((m, c) => Math.max(m, c.tiles.length), 0);
  if (W == null || W <= 0 || !unsplit) return unsplit;
  const nameOf = opt.nameOf || ((t) => String(t.label ?? t.id ?? ''));
  const markOf = opt.markOf || (() => false);
  const sig = `${Math.round(W)}|${opt.textW ? 'm' : 'e'}|${cols.map((c) => `${c.key}:${c.left}:${c.width}[${c.tiles.map((t) => `${t.id}:${t.size}:${nameOf(t)}:${markOf(t) ? 1 : 0}`).join(',')}]`).join(';')}`;
  if (_maxMemo.has(sig)) return _maxMemo.get(sig);
  const hs = [...new Set(Array.from({ length: unsplit }, (_, i) => autoMapHeight(i + 1)))].sort((a, b) => a - b);
  let out = unsplit;
  for (const h of hs) {
    const n = longestPackedCol(packLayout(layout, { widthPx: W, heightPx: h, textW: opt.textW, nameOf, markOf, group: false }));
    if (autoMapHeight(n) <= h) { out = n; break; }
  }
  if (_maxMemo.size >= 8) _maxMemo.delete(_maxMemo.keys().next().value);
  _maxMemo.set(sig, out);
  return out;
}

/** 묶음 목록 순서 — 값 높은 순(같으면 크기 큰 순) · 값 모름은 뒤(크기 큰 순). 설계 §3 ‘목록은 값이 높은 순’. 원본은 바꾸지 않는다. */
export function orderMembers(members, valOf) {
  const list = Array.isArray(members) ? members.slice() : [];
  const v = new Map(list.map((m) => [m, numOrNull(valOf(m))]));
  return list.sort((a, b) => {
    const va = v.get(a); const vb = v.get(b);
    if (va == null && vb != null) return 1;
    if (vb == null && va != null) return -1;
    if (va != null && vb != null && va !== vb) return vb - va;
    return (b.size || 0) - (a.size || 0);
  });
}

const groupKey = (colKey) => `grp:${colKey}`;

/**
 * @param {{cols:Array}} layout   treemapLayout 결과
 * @param {{ widthPx:number, heightPx:number, textW?:(s:string,px:number)=>number, nameOf?:(tile)=>string, markOf?:(tile)=>boolean, group?:boolean }} opt  markOf = 칸 안에 표(못 버팀)가 붙는가 ·
 *   group:false = 작은 칸을 묶지 않는다(여러 열만 — 자동 높이 계산용)
 * @returns {{ cols: Array<{key,label,total,left,width,tiles:Array}>, groups: Array<{id,colKey,label,members:Array,size:number}> }}
 *   tiles 의 각 칸에 tier · wPx · hPx 가 붙는다. 묶음 칸은 { group: true, id: 'grp:<열 key>', members, size } 다.
 *   widthPx · heightPx 를 모르면(첫 그림 · 시험 환경) 입력 배치를 그대로 돌려준다 — tier 는 비운다(undefined): 그리는 쪽이 높이만으로(tileLineMode) 한 줄 / 두 줄을 정한다
 *   (dbg3231 — 예전에는 전부 'm'(두 줄)이라 낮은 칸 글이 잘렸다).
 */
export function packLayout(layout, { widthPx, heightPx, textW = estTextW, nameOf = (t) => String(t.label ?? t.id ?? ''), markOf = () => false, group = true } = {}) {
  const W = numOrNull(widthPx); const H = numOrNull(heightPx);
  const cols = layout?.cols || [];
  if (W == null || W <= 0 || H == null || H <= 0) {
    return { cols: cols.map((c) => ({ ...c, tiles: c.tiles.map((t) => ({ ...t, tier: undefined, wPx: null, hPx: null })) })), groups: [] };
  }
  const groups = [];
  const outCols = cols.map((c) => {
    const x0 = (c.left / 100) * W; const cw = (c.width / 100) * W;
    const placeK = (items, k) => {
      const parts = splitInto(items, k);
      const tot = items.reduce((a, t) => a + t.size, 0);
      const rects = []; let x = x0; let minW = Infinity;
      parts.forEach((p, pi) => {
        const pt = p.reduce((a, t) => a + t.size, 0);
        const pw = pi === parts.length - 1 ? x0 + cw - x : (pt / tot) * cw;
        minW = Math.min(minW, pw);
        let y = 0;
        p.forEach((t, ti) => { const th = ti === p.length - 1 ? H - y : (t.size / pt) * H; rects.push({ t, x, y, w: pw, h: th }); y += th; });
        x += pw;
      });
      return { rects, minW, n: parts.length };
    };
    const readable = (rects) => rects.filter((r) => (r.t.group ? r.h >= NAME_MIN_H : tierOf(r.w, r.h, nameOf(r.t), textW, { mark: !!markOf(r.t) }) !== 'none')).length;
    const place = (items) => {
      let best = null;
      for (let k = 1; k <= MAX_SUBCOLS; k++) {
        if (k > 1 && (cw / k < MIN_SUBCOL_W || k > items.length)) break;
        // dbg3231: 하한은 평균(cw / k)이 아니라 **실제 작은 열 폭**(크기 몫)에 건다 — 크기가 고르지 않은 지역에서 75px 열이 뽑혔다.
        const { rects, minW, n } = placeK(items, k);
        if (n > 1 && minW < MIN_SUBCOL_W) continue;
        const sc = readable(rects);
        if (!best || sc > best.sc) best = { rects, sc };
      }
      return best.rects;
    };
    const items = c.tiles.map((t) => ({ ...t }));
    let rects = place(items);
    const small = rects.filter((r) => tierOf(r.w, r.h, nameOf(r.t), textW, { mark: !!markOf(r.t) }) === 'none').map((r) => r.t);
    if (group && small.length >= GROUP_MIN) {
      const members = small.slice();
      const g = { id: groupKey(c.key), key: groupKey(c.key), group: true, colKey: c.key, label: `그 밖 ${members.length}개`, size: members.reduce((a, t) => a + t.size, 0), members };
      groups.push({ id: g.id, colKey: c.key, label: c.label, members, size: g.size });
      const keep = items.filter((t) => !small.includes(t)).concat([g]).sort((a, b) => (b.size - a.size) || (a.group ? 1 : 0) - (b.group ? 1 : 0));
      rects = place(keep);
    }
    const tiles = rects.map((r) => ({
      ...r.t, left: (r.x / W) * 100, top: (r.y / H) * 100, width: (r.w / W) * 100, height: (r.h / H) * 100,
      wPx: r.w, hPx: r.h, tier: r.t.group ? (r.h >= TIER.one.minH && r.w - PAD_X >= textW(r.t.label, TIER.one.name) ? (r.h >= TIER.m.minH ? 'm' : 'one') : 'none') : tierOf(r.w, r.h, nameOf(r.t), textW, { mark: !!markOf(r.t) }),
    }));
    return { ...c, tiles };
  });
  return { cols: outCols, groups };
}

/** 묶음 칸의 대표 — 값이 가장 높은 구성원(같으면 크기 큰 순). 색을 이 구성원의 것으로 칠해 나쁜 값이 묶음에 가려지지 않게 한다.
 *  dbg3231: staleOf 를 주면 **오래되지 않은 구성원의 값**을 먼저 쓴다(오래된 값이 묶음 칸을 지금 값처럼 칠하지 않게) — 오래된 값은 지금 값이 하나도 없을 때만, 모름은 맨 뒤.
 *  대표가 오래된 구성원인지는 호출부가 staleOf(member) 로 다시 본다(그때 묶음 칸에 빗금 · ‘오래됨’). */
export function worstMember(members, valOf, staleOf = null) {
  const list = Array.isArray(members) ? members : [];
  const rank = (m, v) => (v == null ? 0 : (staleOf && staleOf(m) ? 1 : 2));
  let best = null; let bv = null; let br = -1;
  for (const m of list) {
    const v = numOrNull(valOf(m));
    const r = rank(m, v);
    if (best == null || r > br || (r === br && v != null && (v > bv || (v === bv && m.size > best.size)))) { best = m; bv = v; br = r; }
  }
  return { member: best, value: bv };
}
