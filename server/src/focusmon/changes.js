/**
 * focusmon/changes.js — ‘무엇이 가장 변했나’(v3.13.0 ⑭ B5 — 시안 History · 컨펌 ⑤ '중앙값의 비 + 분포가 겹치는 정도 · 앞 구간은 4배 길이').
 *
 *  · 고른 구간 B = [from, to], 앞 구간 A = [from − 4×길이, from]. 서버 × 지표(`CHANGE_KEYS`)마다 두 구간의 값(칸)을 모아 견준다.
 *  · 값: 두 구간을 합쳐 1시간 이하면 원본 표본, 24시간 이하면 1분 요약 평균, 그 위는 1시간 요약 평균(store · longq 와 같은 출처) — 두 구간은 **같은 출처**.
 *  · 점수 = |log((중앙값B + ε) / (중앙값A + ε))| × (1 − 겹침). 겹침 = 두 분포(20칸 히스토그램)의 겹치는 넓이(0~1). ε = 두 중앙값 큰 쪽의 1%(0 근처 폭주 방지 · 최소 1e-6).
 *  · 칸이 모자라면(A < 5 · B < 3) 빼고 그 사실을 센다. 값이 없는 칸은 양쪽에서 뺀다(0 이 아니다). 순위는 '어디부터 볼지' 의 안내 — 원인을 단정하지 않는다.
 *  · 기계 학습이 아니라 통계 비교다. 잠깐 보기(15분)처럼 이력이 짧아도 쓸 수 있다.
 */
import { blocksFor } from './query.js';
import { sumRowsFor } from './longq.js';
import { sumCol } from './summary.js';
import { createYielder } from '../util/timeSlice.js';

export const CHANGE_KEYS = Object.freeze([
  ['s.cpu', 'CPU 사용률', '%'], ['s.mem', '메모리 사용률', '%'], ['s.net', '네트워크 사용률(대표)', '%'], ['s.disk', '디스크 사용률(가장 바쁜)', '%'],
  ['s.wa', '디스크 쓰기 지연', 'ms'], ['s.ra', '디스크 읽기 지연', 'ms'], ['s.fs', '파일시스템 최대', '%'], ['c.iow', 'CPU I/O 대기', '%'],
  ['l.1', '부하 평균(1분)', ''], ['l.run', '실행 대기', '개'], ['k.cs', '컨텍스트 스위치', '/s'], ['p.rt', 'TCP 재전송률', '%'],
  ['p.tw', 'TIME_WAIT', '개'], ['v.si', '스왑 들어옴', '페이지/s'], ['v.mf', 'major fault', '/s'], ['q.D', 'D 상태', '개'],
]);
export const MIN_A = 5; export const MIN_B = 3; export const BINS = 20; export const TOP = 20; export const TARGETS_MAX = 40;
const r2 = (v) => Math.round(v * 100) / 100;
/** 같은 요청(대상 · 구간 · 1분 단위 끝)은 60초 기억 — 단추로 다시 눌러도 요약을 다시 풀지 않는다. */
export const MEMO_MS = 60_000;
const memo = new Map();

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
/** 두 표본의 겹침(0~1) — 같은 범위 20칸 히스토그램의 칸마다 작은 쪽 비율의 합. 범위가 0(모두 같은 값)이면 1. */
export function overlapOf(a, b, bins = BINS) {
  if (!a.length || !b.length) return null;
  let lo = Infinity; let hi = -Infinity;
  for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v; }
  for (const v of b) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!(hi > lo)) return 1;
  const ha = new Float64Array(bins); const hb = new Float64Array(bins);
  const at = (v) => Math.min(bins - 1, Math.floor(((v - lo) / (hi - lo)) * bins));
  for (const v of a) ha[at(v)] += 1 / a.length;
  for (const v of b) hb[at(v)] += 1 / b.length;
  let o = 0; for (let i = 0; i < bins; i++) o += Math.min(ha[i], hb[i]);
  return Math.round(o * 1000) / 1000;
}
/** 한 지표의 변화 점수(판정 코어 — 시험이 고정). */
export function changeScore(a, b) {
  if (a.length < MIN_A || b.length < MIN_B) return null;
  const ma = median(a); const mb = median(b);
  const eps = Math.max(1e-6, 0.01 * Math.max(Math.abs(ma), Math.abs(mb)));
  const ratio = (mb + eps) / (ma + eps);
  if (!(ratio > 0)) return null; // 음수 값(없어야 한다)이 섞이면 견주지 않는다
  const ov = overlapOf(a, b);
  return { ma, mb, ratio, overlap: ov, score: Math.round(Math.abs(Math.log(ratio)) * (1 - ov) * 1000) / 1000 };
}

/**
 * 대상 하나의 지표별 값 — 두 구간(A · B)을 **한 번에 같은 출처로** 읽어 시각으로 나눈다(출처가 다르면 평균의 분포 폭이 달라 겹침이 틀어진다).
 * @returns {{A: Map<string, number[]>, B: Map<string, number[]>, src: 'raw'|'m'|'h', partial: boolean}}
 */
export async function valuesFor(id, A, B, y = createYielder(15)) {
  const span = B.to - A.from;
  const mk = () => new Map(CHANGE_KEYS.map(([k]) => [k, []]));
  const out = { A: mk(), B: mk(), src: 'raw', partial: false };
  const put = (t, k, v) => { if (t >= B.from && t <= B.to) out.B.get(k).push(v); else if (t >= A.from && t < A.to) out.A.get(k).push(v); };
  if (span <= 3_600_000) {
    const { blocks, partial } = await blocksFor(id, A.from, B.to);
    out.partial = !!partial;
    for (const b of blocks) {
      for (let i = 0; i < b.ts.length; i++) {
        const t = b.ts[i];
        for (const [k] of CHANGE_KEYS) { const arr = b.cols.get(k); const v = arr ? arr[i] : null; if (v != null && !Number.isNaN(v)) put(t, k, v); }
      }
      await y();
    }
    return out;
  }
  out.src = span <= 86_400_000 ? 'm' : 'h';
  const rows = await sumRowsFor(id, A.from, B.to, out.src);
  if (rows == null) { out.partial = true; return out; }
  for (let j = 0; j < rows.length; j++) {
    const r = rows[j]; const mid = r.t + r.span / 2;
    for (const [k] of CHANGE_KEYS) { const c = sumCol(r.s, k); if (c && c.n > 0 && c.a != null) put(mid, k, c.a); }
    if (j % 64 === 63) await y();
  }
  return out;
}

/**
 * 고른 구간 vs 앞 4배 구간 — 서버 × 지표 점수 순 상위 TOP.
 * @param {Array<{id, name}>} targets  보이는 대상(이름은 화면용 · 상한 TARGETS_MAX)
 */
export async function biggestChanges(targets, w, now = Date.now()) {
  const len = w.to - w.from;
  const A = { from: w.from - 4 * len, to: w.from }; const B = { from: w.from, to: w.to };
  const mk = `${targets.map((t) => t.id).join(',')}|${w.win}|${Math.floor(w.to / MEMO_MS)}`;
  const hit = memo.get(mk); if (hit && now - hit.at < MEMO_MS) return hit.v;
  const y = createYielder(15);
  const rows = []; let skipped = 0; let partial = false; let src = null;
  for (const t of targets.slice(0, TARGETS_MAX)) {
    const v = await valuesFor(t.id, A, B, y);
    src = v.src; if (v.partial) partial = true;
    for (const [k, label, unit] of CHANGE_KEYS) {
      const va = v.A.get(k); const vb = v.B.get(k);
      const s = changeScore(va, vb);
      if (!s) { if (va.length || vb.length) skipped += 1; continue; }
      if (!(s.score > 0)) continue;
      rows.push({ id: t.id, name: t.name, key: k, label, unit, a: r2(s.ma), b: r2(s.mb), ratio: r2(s.ratio), overlap: s.overlap, score: s.score, nA: va.length, nB: vb.length });
    }
    await y();
  }
  rows.sort((x, z) => z.score - x.score || String(x.name).localeCompare(String(z.name)) || x.key.localeCompare(z.key));
  const v = { a: A, b: B, src, rows: rows.slice(0, TOP), skipped, partial, keys: CHANGE_KEYS.length, targets: Math.min(targets.length, TARGETS_MAX) };
  memo.set(mk, { at: now, v }); if (memo.size > 50) memo.delete(memo.keys().next().value);
  return v;
}
/** 시험용. */
export function _resetForTest() { memo.clear(); }
