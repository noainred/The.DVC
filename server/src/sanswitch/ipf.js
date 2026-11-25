/**
 * sanswitch/ipf.js — IPF(반복 비례 맞춤) 보정(v2.935 C-① — 설계 docs/design/san-cvp-traffic/README.md §4.1 · §9). 순수.
 *
 * 무엇을 푸나: 스위치 하나에서 초기자 포트 i(호스트 HBA 등)의 기간 바이트 R_i 와 타깃 포트 t(스토리지)의 기간 바이트 C_t 를 안다(포트 카운터 — 확정값).
 *   조닝이 허용한 칸(i,t)에만 트래픽이 있을 수 있다. 행합 = R_i · 열합 = C_t 를 **동시에** 맞추는 표 x_it 를 찾아, 초기자 i 의 바이트를
 *   스토리지별로 나눈다(타깃 포트 비율만 쓰던 A 단계 방식은 다른 초기자가 같은 타깃을 얼마나 쓰는지를 보지 못했다).
 *
 * 규약(정직):
 *   · 결과는 **추정**이다(◐ — 화면 ≈). 행합은 정확히 맞추고 열합은 잔차로 밝힌다(converged = 열 잔차 ≤ tol).
 *   · 이 스위치에 없는 초기자(ISL 너머·수집 밖)가 타깃을 쓰면 열합이 행합보다 크다 → '기타 초기자' 여유 행이 그 몫을 받는다.
 *     거꾸로 초기자가 이 스위치에 없는 타깃을 쓰면 행합이 크다 → '다른 스위치 타깃' 여유 열이 받는다. 그 몫은 elsewhere 로 밝힌다.
 *   · 실측(ESXi 경로 비율)이나 후보가 하나인 행은 고정(fixed)하고 그 몫을 열합에서 뺀 뒤 나머지만 맞춘다 — 추정이 실측을 덮지 않는다.
 *   · 수렴하지 않으면(반복 상한) 그 스위치의 결과를 쓰지 않는다 — 귀속 엔진이 타깃 포트 비율(A)로 표기한다.
 *   · NPIV 처럼 한 포트에 WWN 이 여럿이면 포트 바이트를 WWN 별로 나눌 수 없어 행·열에서 뺀다.
 */
import { numOrNull } from '../util/numOrNull.js';

export const IPF_MAX_ITER = 50;
export const IPF_TOL = 0.005;
const OTHER = '\u0000other';
const ELSEWHERE = '\u0000elsewhere';

/**
 * @param {{ rows: Map<string,number>, cols: Map<string,number>, allowed: Map<string, Set<string>> }} input 행합 · 열합 · 허용 칸(열은 cols 에 있는 것만)
 * @returns {{ shares: Map<string, Map<string, number>>, elsewhere: Map<string, number>, iter: number, residual: number, converged: boolean, slackRow: number, slackCol: number }}
 *   shares = 행마다 타깃별 몫(합 + elsewhere = 1). residual = 열 상대 잔차의 최댓값(마지막 행 맞춤 뒤).
 */
export function ipfSplit({ rows, cols, allowed }, { maxIter = IPF_MAX_ITER, tol = IPF_TOL } = {}) {
  const R = new Map([...rows].filter(([, v]) => Number.isFinite(v) && v > 0));
  const C = new Map([...cols].filter(([, v]) => Number.isFinite(v) && v >= 0));
  const totR = [...R.values()].reduce((a, b) => a + b, 0);
  const totC = [...C.values()].reduce((a, b) => a + b, 0);
  const slackRow = totC > totR ? totC - totR : 0;
  const slackCol = totR > totC ? totR - totC : 0;
  // x: 행 → (열 → 값). 허용 칸만 1 로 시작.
  const x = new Map();
  for (const [i] of R) {
    const m = new Map();
    for (const t of allowed.get(i) || []) if (C.has(t)) m.set(t, 1);
    if (slackCol > 0) m.set(ELSEWHERE, 1);
    x.set(i, m);
  }
  if (slackRow > 0) { const m = new Map(); for (const [t] of C) m.set(t, 1); x.set(OTHER, m); R.set(OTHER, slackRow); }
  if (slackCol > 0) C.set(ELSEWHERE, slackCol);
  const rowStep = () => {
    for (const [i, m] of x) {
      const s = [...m.values()].reduce((a, b) => a + b, 0);
      const want = R.get(i);
      if (s > 0 && want > 0) for (const [t, v] of m) m.set(t, v * (want / s));
    }
  };
  const colSums = () => {
    const s = new Map();
    for (const m of x.values()) for (const [t, v] of m) s.set(t, (s.get(t) || 0) + v);
    return s;
  };
  const colStep = () => {
    const s = colSums();
    for (const m of x.values()) for (const [t, v] of m) { const cs = s.get(t) || 0; const want = C.get(t) ?? 0; m.set(t, cs > 0 ? v * (want / cs) : 0); }
  };
  const residualOf = () => {
    const s = colSums();
    let worst = 0;
    for (const [t, want] of C) {
      const got = s.get(t) || 0;
      const base = Math.max(want, 1);
      worst = Math.max(worst, Math.abs(got - want) / base);
    }
    return worst;
  };
  let iter = 0; let residual = Infinity;
  if (x.size) {
    for (iter = 1; iter <= maxIter; iter++) {
      rowStep(); colStep(); rowStep();
      residual = residualOf();
      if (residual <= tol) break;
    }
    if (iter > maxIter) iter = maxIter;
  } else residual = 0;
  const shares = new Map(); const elsewhere = new Map();
  for (const [i, m] of x) {
    if (i === OTHER) continue;
    const s = [...m.values()].reduce((a, b) => a + b, 0);
    const out = new Map();
    for (const [t, v] of m) if (t !== ELSEWHERE) out.set(t, s > 0 ? v / s : 0);
    shares.set(i, out);
    elsewhere.set(i, s > 0 ? (m.get(ELSEWHERE) || 0) / s : 0);
  }
  return { shares, elsewhere, iter, residual: Number.isFinite(residual) ? residual : 1, converged: residual <= tol, slackRow, slackCol };
}

/** 조닝 서명 — 같은 패브릭의 스위치는 같은 zone 설정을 보고한다(팹 A 의 스위치 A1·A2). zone 이 없으면 그 스위치 혼자. */
function zoneSigOf(f) {
  const names = new Set();
  for (const zs of f.zonesOf.values()) for (const z of zs) if (z?.name) names.add(z.name);
  if (!names.size) return `solo:${f.deviceId}`;
  let x = 2166136261 >>> 0;
  for (const ch of [...names].sort().join('|')) x = Math.imul(x ^ ch.charCodeAt(0), 16777619) >>> 0;
  return `z:${names.size}:${x.toString(16)}`;
}

/**
 * **패브릭**(조닝 서명이 같은 스위치 묶음)마다 IPF — 귀속 엔진이 쓰는 행별 몫.
 *   ⚠ 스위치 하나로 풀면 코어-엣지 패브릭(호스트는 엣지 · 어레이는 코어)에서 초기자와 타깃이 다른 스위치라 행·열이 만나지 않는다 —
 *   zone 은 패브릭 전체 설정이고 포트 바이트는 포트가 있는 스위치에서 읽으므로 패브릭 단위로 푼다(타깃 포트 비율(A)은 여전히 같은 스위치만).
 * @param {Array} fabrics buildFabrics 결과(스위치마다 하나)
 * @param {Map<string,{bytes:number|null}>} portBytes `${deviceId}|${portIndex}` → 기간 바이트
 * @param {{ fixedOf?: (initWwn:string) => Map<string,number>|null }} opt 실측 몫(타깃 WWN → 몫)이 있는 초기자 — 고정한다
 * @returns {{ byRow: Map<string, {shares:Map<string,number>, elsewhere:number, kind:'ipf'|'fixed'|'single', deviceId:string, group:string}>, fabrics: Array<object> }}
 *   byRow 키는 `${초기자가 로그인한 스위치 deviceId}|${초기자 WWN}`. fabrics 는 패브릭(묶음)마다 한 줄 + 묶인 스위치 deviceIds.
 */
export function ipfForFabrics(fabrics = [], portBytes = null, { fixedOf = null, maxIter = IPF_MAX_ITER, tol = IPF_TOL } = {}) {
  const byRow = new Map(); const summary = [];
  if (!(portBytes instanceof Map)) return { byRow, fabrics: summary };
  const groups = new Map();
  for (const f of Array.isArray(fabrics) ? fabrics : []) {
    const k = zoneSigOf(f);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  for (const [gk, list] of groups) {
    const at = new Map();   // wwn → { bytes, deviceId }
    const roleOf = (w) => { for (const f of list) { const r = f.roles.get(w); if (r) return r; } return null; };
    const zonesOf = (w) => { for (const f of list) { const z = f.zonesOf.get(w); if (z) return z; } return []; };
    for (const f of list) {
      for (const [w, p] of f.portByWwn) {
        if (at.has(w) || !p || (Array.isArray(p.attached) && p.attached.length !== 1)) continue;   // NPIV — 포트 바이트를 WWN 별로 나눌 수 없다
        const b = numOrNull(portBytes.get(`${f.deviceId}|${p.index}`)?.bytes);
        if (b != null) at.set(w, { bytes: b, deviceId: f.deviceId });
      }
    }
    const rows = new Map(); const allowed = new Map(); const cols = new Map();
    for (const [w, x] of at) {
      if (roleOf(w)?.side !== 'initiator' || x.bytes <= 0) continue;
      const set = new Set();
      for (const zn of zonesOf(w)) for (const p of zn.wwns || []) {
        if (p === w || roleOf(p)?.side === 'initiator' || !at.has(p)) continue;
        set.add(p);
      }
      if (!set.size) continue;
      rows.set(w, x.bytes); allowed.set(w, set);
      for (const t of set) cols.set(t, at.get(t).bytes);
    }
    if (!rows.size) continue;
    const names = list.map((f) => f.name);
    const name = names.length > 1 ? `${names[0]} 외 ${names.length - 1}대` : names[0];
    const deviceId = list[0].deviceId;
    // 고정 — 후보 하나인 행 · 실측 몫이 있는 행. 그 몫을 열합에서 뺀다.
    const colLeft = new Map(cols);
    const free = new Map(); const freeAllowed = new Map();
    let fixedRows = 0;
    for (const [w, R] of rows) {
      const set = allowed.get(w);
      let fixed = null; let kind = null;
      if (set.size === 1) { fixed = new Map([[[...set][0], 1]]); kind = 'single'; }
      else if (typeof fixedOf === 'function') {
        const m = fixedOf(w);
        if (m instanceof Map && m.size) {
          const loc = new Map([...m].filter(([t]) => set.has(t)));
          const s = [...loc.values()].reduce((a, b) => a + b, 0);
          if (s > 0) { fixed = new Map([...loc].map(([t, v]) => [t, v / s])); kind = 'fixed'; }
        }
      }
      if (fixed) {
        fixedRows += 1;
        for (const [t, sh] of fixed) colLeft.set(t, Math.max(0, (colLeft.get(t) || 0) - R * sh));
        byRow.set(`${at.get(w).deviceId}|${w}`, { shares: fixed, elsewhere: 0, kind, deviceId: at.get(w).deviceId, group: gk });
      } else { free.set(w, R); freeAllowed.set(w, set); }
    }
    let res = { iter: 0, residual: 0, converged: true, slackRow: 0, slackCol: 0 };
    if (free.size) {
      const usedCols = new Map();
      for (const set of freeAllowed.values()) for (const t of set) usedCols.set(t, colLeft.get(t) || 0);
      res = ipfSplit({ rows: free, cols: usedCols, allowed: freeAllowed }, { maxIter, tol });
      if (res.converged) for (const [w, sh] of res.shares) byRow.set(`${at.get(w).deviceId}|${w}`, { shares: sh, elsewhere: res.elsewhere.get(w) || 0, kind: 'ipf', deviceId: at.get(w).deviceId, group: gk });
    }
    summary.push({ group: gk, deviceId, deviceIds: list.map((f) => f.deviceId), name, switches: list.length, rows: rows.size, cols: cols.size, fixedRows, freeRows: free.size,
      iter: res.iter, residual: Math.round(res.residual * 10000) / 10000, converged: res.converged, slackRow: res.slackRow, slackCol: res.slackCol });
  }
  return { byRow, fabrics: summary };
}
