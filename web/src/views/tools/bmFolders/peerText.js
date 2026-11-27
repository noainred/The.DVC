/**
 * 물리서버 상세 드로어 ‘같은 묶음 대비’ 구역의 글자 · 그림 좌표(v3.48 · 시안 docs/design/bm-feature-proposals ⑨). 순수.
 *
 *  · 판정은 서버(bmcheck/peer.js)가 한다 — 여기는 응답(`/tools/bm-folders/peer`)을 읽어 글자와 좌표로 옮길 뿐이다(판정 복제 없음).
 *  · 기준(지난 N시간 평균 · 지금 값)과 시간 수는 **응답의 값으로** 쓴다(지표마다 `basis` · 응답 `hours`) — 여기서 정하지 않는다(반증 B2).
 *  · 응답에 없는 기준 수(묶음 최소 대수 · 표본 수 · 구간 비율)는 지어내지 않는다 — 없으면 그 구절을 빼고 쓴다(반증 B14).
 *  · ‘묶음 밖’ 은 그 묶음과 다르다는 뜻이고 **문제라는 판정이 아니다** — ‘묶음 안’ 도 정상이라는 판정이 아니다(색: 밖 = 주황 · 그 밖 = 회색).
 *  · ‘묶음의 폭’ 은 값의 범위가 아니다 — 화면은 실제 값 범위(min ~ max)를 함께 쓰고 폭이 무엇인지 밝힌다(반증 B4).
 *  · 값이 없으면 단위를 붙이지 않는다(unitText) · 판정하지 않은 지표는 이유를 쓰고 띠를 그리지 않는다.
 */
import { numOrNull } from '../../../numOrNull.js';
import { unitText } from '../../unitText.js';

export const PEER_ORDER = Object.freeze(['cpu', 'mem', 'power', 'inlet']);
export const PEER_LABEL = Object.freeze({ cpu: 'CPU', mem: '메모리', power: '전력', inlet: '흡기 온도' });
const UNIT = { cpu: '%', mem: '%', power: ' W', inlet: '℃' };
const DIGITS = { cpu: 0, mem: 0, power: 0, inlet: 1 };
const NB = ' ';
/** 구분 글자는 뒤 낱말과 한 덩어리로(줄 끝에 ‘·’ · ‘›’ 만 남지 않게 — 반증 B9 · B13). */
export const SEP_DOT = ` ·${NB}`;
export const SEP_PATH = ` ›${NB}`;
export const PEER_FOOT = '묶음의 폭은 값들의 가운데 절반(사분위 범위)에 여유(그 범위의 1.5배 · 지표별 최소 폭)를 더한 구간이고, 이 폭 밖이면 ‘묶음 밖’ 입니다. 묶음 밖은 같은 폴더 · 같은 모델 서버들과 값이 다르다는 뜻이고, 문제라는 판정이 아닙니다. 값이 없는 서버는 묶음에서 빼고 셉니다.';
export const PEER_STATE = Object.freeze({
  high: { label: '묶음보다 높음', color: 'amber' },
  low: { label: '묶음보다 낮음', color: 'amber' },
  in: { label: '묶음 안', color: 'gray' },
  few: { label: '판정 안 함', color: 'gray' },
  none: { label: '값 없음', color: 'gray' },
});
export const PEER_WHY = Object.freeze({
  esxi: 'ESXi 호스트 행은 견주지 않습니다 — 호스트의 사용률은 호스트 화면에서 봅니다.',
  unplaced: '폴더에 넣지 않은 서버는 견주지 않습니다 — 같은 폴더의 같은 모델 서버가 한 묶음입니다.',
  'no-model': '이 서버의 모델을 몰라 묶음을 정하지 못했습니다.',
});
/** 사유는 몇 건 · 몇 글자까지(서버도 5건 · 200자로 자른다 — 여기서 다시 자른다). */
export const PEER_REASONS_MAX = 5;
export const PEER_REASON_LEN = 200;

const fmtOf = (id) => (x) => Number(x).toLocaleString('en-US', { minimumFractionDigits: DIGITS[id] ?? 0, maximumFractionDigits: DIGITS[id] ?? 0 });
/** 지표 값 글자 — 값이 없으면 ‘—’(단위 없음) · 천 단위 구분(드로어 한눈에 타일과 같은 표기 — 반증 B6). */
export const peerVal = (id, v) => unitText(numOrNull(v), UNIT[id] ?? '', { fmt: fmtOf(id) });

/** 기준 글자 — 응답의 basis · hours 로. 모르는 기준은 ‘기준 모름’(지어내지 않는다). */
export function basisText(basis, hours) {
  if (basis === 'now') return '지금 값';
  if (basis === 'avg24') { const h = numOrNull(hours) ?? 24; return `지난 ${h}시간 평균`; }
  return '기준 모름';
}
/** 기준의 기간 글자(평균 기준만 — ‘지난 24시간’). 지금 값 · 모르는 기준은 ''. */
const spanOf = (basis, hours) => (basis === 'avg24' ? `지난 ${numOrNull(hours) ?? 24}시간` : '');
/** 은/는 — 마지막 글자에 받침이 있으면 ‘은’(한글이 아니면 ‘는’ — CPU 는 ‘씨피유’). */
export function eunNeun(word) {
  const s = String(word || ''); const c = s.charCodeAt(s.length - 1);
  return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 ? '은' : '는';
}

/** 판정한 상태인가(띠를 그릴 수 있는가). */
const judged = (m) => !!m && (m.state === 'high' || m.state === 'low' || m.state === 'in') && Array.isArray(m.points);
const r1 = (v) => Math.round(v * 10) / 10;

/** 띠 그림의 세로 배치(px) — 그림 높이 · 가운데 줄(점 줄 · 대수 글자 · 축 글자가 겹치지 않게 — 반증 B11). */
export const STRIP_H = 66;
export const STRIP_MID = 30;
/** 대수 글자의 기준선(가운데 줄에서 아래로) — 가장 낮은 점 아래 · 축 글자 위. */
export const STRIP_COUNT_DY = 24;
const LANES = [0, -7, 7];          // 보통 칸: 가운데 · 위 · 아래
const LANES_SELF = [-11, 11];      // 이 서버 표식이 있는 칸: 표식(가운데)을 비켜 위 · 아래
const COL_GAP = 9;                 // 이보다 가까운 점은 한 칸으로 묶는다(px)
const COUNT_GAP = 26;              // 대수 글자끼리 이보다 가까우면 한 글자로 합친다(‘14대’ ‘10대’ 가 겹쳐 ‘140대’ 로 읽혔다 — Chromium 판독)

/**
 * 한 지표의 띠 그림 좌표(순수). 판정하지 않은 지표는 null.
 *  · 축: % 지표는 0 ~ 100 고정 · 그 밖은 (값 · 폭 · 점)을 모두 담는 구간에 여유를 둔다.
 *  · 점 = 같은 묶음 서버의 값(이 서버의 값 하나는 뺀다 — 큰 표식으로 따로 그린다). 가까운 점은 한 칸으로 묶어 위아래로 쌓고,
 *    칸에 다 그리지 못하면 그 칸의 대수를 글자로 쓴다(같은 값 서버가 그림에서 사라지지 않게 — 반증 B1). 이 서버 표식이 있는 칸은 표식을 비켜 쌓는다.
 * @param {string} id 지표
 * @param {object} m  서버 판정({ state, value, lo, hi, min, max, median, points })
 * @param {number} W  그림 폭(px)
 * @returns {null | { w, h, mid, padL, padR, band:{x,w}, dots:[{x,dy}], counts:[{x,n,anchor}], self:{x,label,anchor,out}, axis:[string,string] }}
 */
export function peerStrip(id, m, W = 420) {
  if (!judged(m)) return null;
  const value = numOrNull(m.value); const lo = numOrNull(m.lo); const hi = numOrNull(m.hi);
  if (value == null || lo == null || hi == null) return null;
  const pts = m.points.map(numOrNull).filter((x) => x != null);
  const w = Math.max(160, Math.floor(numOrNull(W) ?? 420));
  const padL = 8; const padR = 8; const inner = w - padL - padR;
  let d0; let d1;
  if (UNIT[id] === '%') { d0 = 0; d1 = 100; }
  else {
    let a = Math.min(value, lo); let b = Math.max(value, hi);
    for (const p of pts) { if (p < a) a = p; if (p > b) b = p; }   // 펼침 인자(...pts)는 점이 아주 많으면 던진다
    const span = Math.max(b - a, 1); const step = id === 'power' ? 10 : 1;
    d0 = Math.floor((a - span * 0.08) / step) * step; d1 = Math.ceil((b + span * 0.08) / step) * step;
    if (id === 'power') d0 = Math.max(0, d0);
    if (!(d1 > d0)) d1 = d0 + step;
  }
  const x = (v) => padL + (Math.min(d1, Math.max(d0, v)) - d0) / (d1 - d0) * inner;
  const bx0 = x(lo); const bx1 = x(hi);
  const sx = x(value);
  // 이 서버의 값 하나는 점에서 뺀다
  const rest = [...pts]; const at = rest.indexOf(value);
  if (at >= 0) rest.splice(at, 1);
  // 가까운 점을 칸으로 묶는다(왼쪽부터 — 칸의 첫 점에서 COL_GAP 안)
  const cols = [];
  for (const px of rest.map(x).sort((p, q) => p - q)) {
    const c = cols[cols.length - 1];
    if (c && px - c.x0 < COL_GAP) { c.n += 1; c.sum += px; } else cols.push({ x0: px, n: 1, sum: px });
  }
  const dots = []; const counts = [];
  for (const c of cols) {
    const cx = r1(c.sum / c.n);
    const lanes = Math.abs(cx - sx) < COL_GAP ? LANES_SELF : LANES;
    const shown = Math.min(c.n, lanes.length);
    for (let i = 0; i < shown; i += 1) dots.push({ x: cx, dy: lanes[i] });
    if (c.n > shown) {
      const prev = counts[counts.length - 1];
      if (prev && cx - prev.x < COUNT_GAP) { const n = prev.n + c.n; prev.x = r1((prev.x * prev.n + cx * c.n) / n); prev.n = n; } else counts.push({ x: cx, n: c.n });
    }
  }
  // 끝에 붙은 대수 글자는 안쪽으로 정렬(그림 밖으로 나가지 않게)
  for (const c of counts) c.anchor = c.x < padL + 12 ? 'start' : c.x > w - padR - 12 ? 'end' : 'middle';
  const label = `이 서버 ${peerVal(id, value)}`;
  const anchor = sx < 64 ? 'start' : sx > w - 64 ? 'end' : 'middle';
  return {
    w, h: STRIP_H, mid: STRIP_MID, padL, padR,
    band: { x: r1(Math.min(bx0, bx1)), w: r1(Math.max(2, Math.abs(bx1 - bx0))) },
    dots, counts, self: { x: r1(sx), label, anchor, out: m.state !== 'in' },
    axis: [peerVal(id, d0), peerVal(id, d1)],
  };
}

/** 응답이 판정 응답인가(200 이지만 ok 가 아닌 본문 · 빈 객체는 판정이 아니다 — 반증 B7). */
const okBody = (d) => !!d && typeof d === 'object' && d.ok === true;

/**
 * 응답 → 구역 모델. null 이면 그릴 것이 없다(읽는 중은 호출부가 따로 말한다).
 * @returns {{ head:string, sub:string, badge:{label,color}|null, why:string, error:boolean, rows:Array, notes:string[], reasons:string[], anyStrip:boolean } | null}
 */
export function peerView(d) {
  if (d == null || typeof d !== 'object') return null;
  const empty = { head: '', sub: '', badge: null, why: '', error: false, rows: [], notes: [], reasons: [], anyStrip: false };
  if (!okBody(d)) {
    const r = typeof d.reason === 'string' && d.reason.trim() ? d.reason.trim().slice(0, PEER_REASON_LEN) : '응답 형식이 달라 판정을 보여 주지 못했습니다.';
    return { ...empty, why: r, error: true };
  }
  const min = numOrNull(d.min); const minSamples = numOrNull(d.minSamples); const minCoverage = numOrNull(d.minCoverage);
  const hours = numOrNull(d.hours);
  const g = d.group && typeof d.group === 'object' ? d.group : null;
  const size = numOrNull(g?.size);
  const pathSegs = g && typeof g.path === 'string' ? g.path.split('\\').filter(Boolean) : [];
  const head = g ? [pathSegs.join(SEP_PATH), g.model ? String(g.model) : '', size != null ? `${size}대` : ''].filter(Boolean).join(SEP_DOT) : '';
  if (d.why) {
    const why = d.why === 'few'
      ? `같은 폴더 · 같은 모델 서버가 ${size != null ? `${size}대입니다` : '모자랍니다'}${min != null ? ` — ${min}대 이상일 때 견줍니다.` : ' — 견주지 않았습니다.'}`
      : PEER_WHY[d.why] || '이 서버는 견주지 않았습니다.';
    return { ...empty, head, why };
  }
  const metrics = d.metrics && typeof d.metrics === 'object' ? d.metrics : {};
  const self = d.self && typeof d.self === 'object' ? d.self : {};
  const pct = (v) => Math.round(v * 100);
  const rows = [];
  for (const id of PEER_ORDER) {
    const m = metrics[id];
    if (!m || typeof m !== 'object') continue;
    const st = PEER_STATE[m.state] || PEER_STATE.none;
    const n = numOrNull(m.n) ?? 0; const missing = numOrNull(m.missing) ?? 0;
    const ok = judged(m);
    let note = '';
    if (m.state === 'few') note = `값이 있는 서버가 ${n}대입니다${min != null ? ` — ${min}대 이상일 때 견줍니다.` : ' — 견주지 않았습니다.'}`;
    else if (m.state === 'none') {
      // 이유는 서버가 준 이 서버의 표본 수 · 구간 비율과 기준으로만 쓴다(모르면 지어내지 않는다)
      const span = spanOf(m.basis, hours);
      const sN = span ? numOrNull(self[id]?.n) : null; const sCov = span ? numOrNull(self[id]?.cov) : null;
      note = sN === 0 ? `${span} 동안 쌓인 값이 없어 견주지 않았습니다.`
        : sN != null && sCov != null && minCoverage != null && sCov < minCoverage ? `${span} 중 값이 있는 구간이 ${pct(sCov)}%입니다 — ${pct(minCoverage)}% 이상일 때 평균으로 봅니다.`
          : sN != null && minSamples != null && sN < minSamples ? `${span} 표본이 ${sN}개입니다 — ${minSamples}개 이상일 때 평균으로 봅니다.`
            : '이 서버의 값이 없어 견주지 않았습니다.';
    }
    const vMin = numOrNull(m.min); const vMax = numOrNull(m.max);
    rows.push({
      id, label: PEER_LABEL[id], basis: basisText(m.basis, hours), state: m.state, badge: { label: st.label, color: st.color },
      valueText: peerVal(id, m.value), judged: ok,
      medianText: ok ? `가운데값 ${peerVal(id, m.median)}` : '',
      spanText: ok && vMin != null && vMax != null ? `값 범위 ${peerVal(id, vMin)} ~ ${peerVal(id, vMax)}` : '',
      rangeText: ok ? `묶음의 폭 ${peerVal(id, m.lo)} ~ ${peerVal(id, m.hi)}` : '',
      countText: `값 있는 서버 ${n}대${missing > 0 ? ` · 값 없는 ${missing}대 제외` : ''}`,
      note,
      aria: ok ? `${PEER_LABEL[id]} — 묶음 가운데값 ${peerVal(id, m.median)} · 이 서버 ${peerVal(id, m.value)} · ${st.label}` : `${PEER_LABEL[id]} — ${st.label}`,
    });
  }
  // 머리 기준 글 — 지표들을 기준별로 묶어 응답 그대로(예: ‘CPU · 메모리 · 전력은 지난 24시간 평균 · 흡기 온도는 지금 값’)
  const byBasis = [];
  for (const r of rows) { const b = byBasis.find((x) => x.basis === r.basis); if (b) b.labels.push(r.label); else byBasis.push({ basis: r.basis, labels: [r.label] }); }
  const sub = byBasis.map((b) => `${b.labels.map((l) => l.replace(' ', NB)).join(SEP_DOT)}${eunNeun(b.labels[b.labels.length - 1])} ${b.basis}`).join(SEP_DOT);
  const out = numOrNull(d.out) ?? 0; const nJudged = numOrNull(d.judged) ?? 0;
  // 머리 배지 — 단위를 붙인다(바로 아래 ‘N대’ 와 섞여 ‘N대 중 M대’ 로 읽히지 않게 — 반증 B5). 견주지 못한 지표가 있으면 ‘묶음 안’ 이라고만 쓰지 않는다.
  const badge = out > 0 ? { label: `지표 ${out}개 묶음 밖`, color: 'amber' }
    : nJudged <= 0 ? { label: '판정 안 함', color: 'gray' }
      : { label: nJudged >= rows.length ? '묶음 안' : `견준 ${nJudged}개는 묶음 안`, color: 'gray' };
  const notes = [];
  const nt = d.notes && typeof d.notes === 'object' ? d.notes : {};
  const cnt = (k) => { const v = numOrNull(nt[k]); return v != null && v > 0 ? v : 0; };
  const trunc = numOrNull(g?.truncated); const used = numOrNull(g?.used);
  if (trunc != null && trunc > 0) notes.push(size != null && used != null ? `묶음이 ${size}대라 ${used}대만 견줬습니다(${trunc}대 제외).` : `묶음이 커서 ${trunc}대는 견주지 않았습니다.`);
  if (cnt('noTarget')) notes.push(`사용률 수집 대상이 아닌 서버 ${cnt('noTarget')}대는 CPU · 메모리 값이 없습니다.`);
  if (cnt('unknown')) notes.push(`수집하는 쪽(이 포탈 · 엣지)이 자기 목록에 없다고 답한 서버 ${cnt('unknown')}대는 값이 없습니다.`);
  if (cnt('oldEdge')) notes.push(`엣지 ${cnt('oldEdge')}곳이 구버전이라 그 엣지가 수집하는 서버의 값을 받지 못했습니다(엣지 업그레이드 뒤 들어옵니다).`);
  if (cnt('edgeFail')) notes.push(`엣지 ${cnt('edgeFail')}곳에서 값을 받지 못했습니다(잠시 뒤 다시 열어 보십시오).`);
  if (cnt('localFail')) notes.push('이 포탈이 수집하는 서버의 값을 읽지 못했습니다.');
  const reasons = [];
  for (const r of Array.isArray(d.reasons) ? d.reasons.slice(0, PEER_REASONS_MAX) : []) if (typeof r === 'string' && r.trim()) reasons.push(r.trim().slice(0, PEER_REASON_LEN));
  return { head, sub, badge, why: '', error: false, rows, notes, reasons, anyStrip: rows.some((r) => r.judged) };
}
