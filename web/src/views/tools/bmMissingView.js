/**
 * bmMissingView.js — 누락 점검 표의 필터 · 정렬 · 쪽 나누기(v2.945.1 · 사용자 요청: "IP/hostname/어떤 엣지에서 연결되어 있는지 등의 필터" ·
 * "한번에 표시할 수 있는 서버 리스트를 정해서 단위로 보는 기능, 기본값 30개, 수정가능"). 순수 — 화면은 결과만 그린다.
 *
 * · 판정(칸 · 사유)은 서버가 정한 값을 그대로 쓴다 — 여기서 다시 판정하지 않는다(판정 코어는 서버 missing.js 하나).
 * · 정렬은 **거른 전체**를 정렬한 뒤 쪽을 자른다(STable 의 `limit` 처럼 '정렬 뒤 자르기' — 쪽 안에서만 정렬하면 순서가 거짓이 된다).
 * · 빈 값(—)은 오름 · 내림 모두 뒤로(sortableText 규약).
 */
export const PAGE_SIZE_DEFAULT = 30;
export const PAGE_SIZE_MIN = 10;
export const PAGE_SIZE_MAX = 500;
const PAGE_SIZE_KEY = 'bmMissing.pageSize';

const t = (v) => String(v ?? '').trim();
const low = (v) => t(v).toLowerCase();

/** 쪽 크기 정규화 — 정수 · 하한/상한 · 못 읽으면 기본값. */
export function clampPageSize(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return PAGE_SIZE_DEFAULT;
  return Math.min(PAGE_SIZE_MAX, Math.max(PAGE_SIZE_MIN, n));
}
/** 사람별 편의 기억(실패해도 기본값으로 그린다). */
export function readPageSize() {
  try { const v = localStorage.getItem(PAGE_SIZE_KEY); return v == null ? PAGE_SIZE_DEFAULT : clampPageSize(v); } catch { return PAGE_SIZE_DEFAULT; }
}
export function writePageSize(v) { try { localStorage.setItem(PAGE_SIZE_KEY, String(clampPageSize(v))); } catch { /* 무시 */ } }

/** 행의 수집 노드 이름 — 필터 · 표가 같은 값을 쓴다. */
export const nodeOf = (r) => (r?.via === 'edge' ? `엣지 ${t(r.agent)}`.trim() : '이 노드');
/** 행의 법인 라벨 — 서버가 준 이름(corp) → id → 미귀속. */
export const corpOf = (r) => t(r?.corp) || t(r?.vcenterId) || '미귀속';

/** 검색어가 닿는 칸 — 서버 이름(호스트명 · IP) · 키 · 서비스 태그 · iDRAC 주소 · OS 주소. 가림 값('(가림)')은 검색하지 않는다. */
function haystack(r) {
  return [r?.name, r?.key, r?.serviceTag, r?.idracHost, r?.osHost]
    .map(low).filter((x) => x && x !== '(가림)').join(' ');
}

/** 고르기 목록(값 · 개수) — 거르기 전 전체 기준, 이름순. */
export function facetOptions(rows = []) {
  const count = (fn) => {
    const m = new Map();
    for (const r of rows) { const k = fn(r); m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ko', { numeric: true })).map(([value, n]) => ({ value, n }));
  };
  return { corps: count(corpOf), nodes: count(nodeOf), reasons: count((r) => t(r?.reason)) };
}

/**
 * @param {object[]} rows  서버 응답 rows
 * @param {object} f  { q, corp, node, reason, bucket, hideBoth, sortCol, sortDir, page, pageSize }
 *   · bucket 이 비면 hideBoth(기본 true — 예전 화면과 같이 '둘 다' 는 숨김)
 * @returns {{ total:number, matched:number, rows:object[], page:number, pages:number, pageSize:number, from:number, to:number }}
 */
export function missingView(rows = [], f = {}) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
  const q = low(f.q).slice(0, 200);
  const terms = q ? q.split(/\s+/).filter(Boolean).slice(0, 8) : [];
  const hideBoth = f.hideBoth !== false;
  const matched = list.filter((r) => {
    if (f.bucket) { if (r.bucket !== f.bucket) return false; } else if (hideBoth && r.bucket === 'both') return false;
    if (f.corp && corpOf(r) !== f.corp) return false;
    if (f.node && nodeOf(r) !== f.node) return false;
    if (f.reason !== undefined && f.reason !== null && f.reason !== '' && t(r.reason) !== f.reason) return false;
    if (terms.length) { const h = haystack(r); if (!terms.every((w) => h.includes(w))) return false; }
    return true;
  });
  const col = ['name', 'corp', 'node', 'bucket', 'reason'].includes(f.sortCol) ? f.sortCol : '';
  if (col) {
    const dir = f.sortDir === 'desc' ? -1 : 1;
    const val = (r) => (col === 'corp' ? corpOf(r) : col === 'node' ? nodeOf(r) : col === 'name' ? t(r.name) || t(r.key) : t(r[col]));
    matched.sort((a, b) => {
      const x = val(a); const y = val(b);
      if (!x && !y) return 0;
      if (!x) return 1;      // 빈 값은 방향과 무관하게 뒤로
      if (!y) return -1;
      return dir * x.localeCompare(y, 'ko', { numeric: true });
    });
  }
  const pageSize = clampPageSize(f.pageSize);
  const pages = Math.max(1, Math.ceil(matched.length / pageSize));
  const page = Math.min(pages, Math.max(1, Math.floor(Number(f.page)) || 1));
  const start = (page - 1) * pageSize;
  const slice = matched.slice(start, start + pageSize);
  return { total: list.length, matched: matched.length, rows: slice, page, pages, pageSize, from: slice.length ? start + 1 : 0, to: start + slice.length };
}
