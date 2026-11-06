/**
 * bmusage/perfView.js — 리눅스 성능 1단계(v2.919): 최신값 행 → **판정이 붙은 성능 항목**(엣지 봉투 · 화면 API 가 같은 함수를 쓴다).
 *
 * ⚠ 판정은 **데이터를 가진 노드**(엣지 또는 중앙의 직접 수집분)가 한다 — 중앙은 엣지 봉투의 `perf` 를 그대로 전하고 다시 판정하지 않는다
 *   (v2.548 · 설계 §4.2). 하드웨어 사실도 그 노드의 iDRAC 데이터다(hwFacts — 장비 왕복 0).
 * ⚠ 기준값(th)은 이 노드의 설정이고 응답에 함께 싣는다(화면에 숫자를 박지 않는다).
 */
import { numOrNull } from '../util/numOrNull.js';
import { PERF_COLS, PERF_COL_NAMES } from './perfCols.js';
import { judgeUse, crossJudge, coverageOf, freshMsFor } from './useJudge.js';

const n = numOrNull;
/** JSON 열 파싱 — 깨졌거나 상한 표지(`{truncated:true}`)면 그대로/ null. 예외를 던지지 않는다. */
export function parseJsonCol(v) {
  if (typeof v !== 'string' || !v) return null;
  try { const o = JSON.parse(v); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; }
}

/** 행에서 새 지표 열만(응답용 — 원본 행의 JSON 문자열은 싣지 않는다). */
export function perfColsOf(row = {}) {
  return Object.fromEntries(PERF_COL_NAMES.map((c) => [c, n(row[c])]));
}

/** 판정 칸을 code 만 남긴 표(목록용 — 근거 배열은 상세에만). */
export function codesOf(cells = {}) {
  const out = {};
  for (const [r, c] of Object.entries(cells)) out[r] = { U: c.U?.code || 'missing', S: c.S?.code || 'missing', E: c.E?.code || 'missing' };
  return out;
}

/**
 * 한 서버의 성능 항목.
 * @param {object} p
 * @param {object} p.row       usage_latest 행
 * @param {object|null} p.hw   hwFacts(없으면 null — iDRAC 등록 없음)
 * @param {object} p.th        기준값(settings.perf)
 * @param {number} p.intervalMs 수집 주기(신선도 한계)
 * @param {boolean} [p.full]   참이면 근거·장치별·튜닝까지(상세 API · 엣지 봉투), 거짓이면 code 표만(목록)
 */
export function buildPerfEntry({ row = {}, hw = null, th = {}, intervalMs = null, now = Date.now(), full = false } = {}) {
  const detail = parseJsonCol(row.detail_json);
  const tuning = parseJsonCol(row.tuning_json);
  const freshMs = freshMsFor(intervalMs);
  const coverage = coverageOf({ osAt: row.os_at, idracAt: row.idrac_at, hwRead: !!hw?.read, now, freshMs });
  const use = judgeUse({ row, detail, hw, coverage, th, now, freshMs });   // v2.919(D4): 행 나이가 한계를 넘으면 stale
  const cross = crossJudge({ use, hw, coverage, th });
  const base = {
    key: String(row.key ?? ''), ts: n(row.ts),
    coverage, osAt: n(row.os_at), idracAt: n(row.idrac_at),
    verdict: use.verdict, focus: use.focus, line: use.line, bottleneckCount: use.bottleneckCount, read: use.read, rowStale: use.rowStale,
    counts: use.counts, codes: codesOf(use.cells), perResource: use.perResource,
    cross: cross.map(({ id, state, code }) => ({ id, state, code })),
    mismatch: use.mismatch,
    // 첫 표본 — 누적 카운터 칸(분해·IOPS·await·스왑·드롭 …)은 다음 주기부터 나온다(그 칸은 missing 이고 ‘기다리면 된다’).
    firstSample: !!detail?.firstSample,
    // v2.920(2단계 화면): 그 커널에 PSI 가 없다(구획은 왔는데 0줄 = absent) — 보드 신뢰 띠의 ‘PSI 없음 n’ 은 목록 응답만으로 세야 한다(목록에는 detail 이 없다).
    //   판정이 아니라 수집 사실 한 비트다(판정은 useJudge 가 이미 그 칸을 none 으로 냈다).
    psiAbsent: detail?.sections?.psi === 'absent',
  };
  if (!full) return base;
  return {
    ...base,
    cells: use.cells,
    crossDetail: cross,
    values: perfColsOf(row),
    detail, tuning,
    hw,
  };
}

/** 판정 칸 이름표(화면·문서용 — 열 ↔ USE 칸 대응을 응답으로 내려준다). */
export const PERF_COL_META = Object.freeze(PERF_COLS.map(({ col, res, use, judged, unit, label }) => ({ col, res, use, judged, unit, label })));

/** 성능 항목에서 목록용 필드만(근거·장치별·튜닝·하드웨어 사실은 상세에서) — 주 조회·엣지 목록·봉투 크기 상한이 같은 함수를 쓴다. */
export function compactPerfEntry(p) {
  if (!p || typeof p !== 'object') return p;
  const { cells: _c, crossDetail: _x, values: _v, detail: _d, tuning: _t, hw: _h, ...rest } = p;
  return rest;
}
