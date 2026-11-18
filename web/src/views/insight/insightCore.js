/**
 * views/insight/insightCore.js — 분석 화면 공용 계산(v3.21.0 · 설계 docs/design/vm-insight §7 · host-insight §9 — 순수 · vitest 고정).
 *
 * VM 분석(vms/VmInsight.jsx)과 다음 덩어리 Hypervisor 분석이 같이 쓴다 — VM 전용 이름을 넣지 않는다.
 *  · 서버는 **법인(vCenter)마다 한 줄**을 주고 화면이 바로가기에서 고른 법인의 줄을 더한다(선택을 바꿀 때 서버 왕복이 없다).
 *  · 못 읽은 값은 0 이 아니다(numOrNull): 둘 다 못 읽었으면 null 로 남기고, 한쪽만 읽었으면 읽은 값만 더한다.
 *    한 법인 줄이 통째로 모름(unknown)이거나 오래됨(stale)이면 **합에 섞지 않고 따로 센다**(pickRows).
 *  · 상위 N 은 서버가 법인마다 상위 N 을 주고 화면이 고른 법인의 목록을 합쳐 같은 비교 순서로 다시 N 개를 고른다
 *    (합집합의 상위 N 은 법인별 상위 N 의 합집합 안에 있다 — mergeTopN).
 */
import { numOrNull } from '../../numOrNull.js';

export const round1 = (v) => { const n = numOrNull(v); return n == null ? null : Math.round(n * 10) / 10; };

/** 고른 법인 줄 — ids 가 비면 전부(범위 안 전부). stale · unknown 줄은 used 에서 빼고 따로 돌려준다. */
export function pickRows(rows, ids) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === 'object');
  const want = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null;
  const picked = want ? list.filter((r) => want.has(String(r.id))) : list;
  const stale = [];
  const unknown = [];
  const used = [];
  for (const r of picked) {
    if (r.unknown === true) unknown.push(r);
    else if (r.stale === true) stale.push(r);
    else used.push(r);
  }
  return { picked, used, stale, unknown, all: list };
}

/**
 * 도구 칸 · 도구 패널이 더할 법인 id — 본체 합(pickRows used)과 **같은 법인 집합**(dbg3221 2회차: 오래됨 법인이 ‘확인할 것’ 의 도구 칸 · 패널 합에만 섞였다).
 *  · 응답이 아직 없으면 ids 그대로(이전 규칙).
 *  · 응답은 왔는데(loaded) 고른 법인 줄이 0개면 null(dbg3221 7회차: 법인 0곳 리전에서 ids=[] 가 도구 쪽 ‘전부’ 로 읽혀
 *    본체 합은 ‘—’ 인데 도구 칸 · 패널 · 과할당 보기만 사용자 범위 전 법인 합을 보였다).
 *  · 고른 법인(ids 가 비면 응답의 줄 전부) 중 오래됨 · 모름이 없으면 이전 규칙 그대로 — ids, 리전만 골랐으면 응답의 법인(그 리전) · 둘 다 없으면 [](= 도구 응답 전부).
 *  · 오래됨 · 모름이 있으면 used 의 id 만. used 가 비면 null(= 더할 법인이 없다 — 도구 쪽에서 [] 는 ‘전부’ 라는 뜻이라 쓰면 안 된다).
 * @returns {string[]|null}
 */
export function toolIdsOf({ ids = [], region = '', rows = [], picked = null, loaded = false } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const want = Array.isArray(ids) ? ids : [];
  if (loaded && (!list.length || (picked && !picked.picked.length))) return null;
  if (!list.length || !picked) return want;
  if (!picked.stale.length && !picked.unknown.length) return want.length || !region ? want : list.map((r) => String(r.id));
  return picked.used.length ? picked.used.map((r) => String(r.id)) : null;
}

/**
 * 값 하나를 더한다 — 수 · 수 배열(칸마다) · 객체(키마다) 를 재귀로. 못 읽은 값(null · 글자 아닌 것)은 더하지 않는다.
 * 둘 다 못 읽었으면 null(0 이 아니다). 객체 배열(목록)은 이 함수로 더하지 않는다 — 호출부가 키로 합친다.
 */
export function addVal(a, b) {
  if (Array.isArray(b)) {
    const out = Array.isArray(a) ? a.slice() : [];
    b.forEach((v, i) => { out[i] = addVal(out[i], v); });
    return out;
  }
  if (b && typeof b === 'object') {
    const out = a && typeof a === 'object' && !Array.isArray(a) ? { ...a } : {};
    for (const k of Object.keys(b)) out[k] = addVal(out[k], b[k]);
    return out;
  }
  const nb = typeof b === 'boolean' ? null : numOrNull(b);
  const na = typeof a === 'boolean' ? null : numOrNull(a);
  if (nb == null) return na;
  return na == null ? nb : na + nb;
}

/** 줄들의 keys 를 더한 객체. 줄이 없으면 각 키가 null(0 이 아니라 '값 없음'). */
export function sumKeys(rows, keys) {
  const out = Object.fromEntries(keys.map((k) => [k, null]));
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== 'object') continue;
    for (const k of keys) out[k] = addVal(out[k], r[k]);
  }
  return out;
}

/** 여러 법인의 평균 — 서버가 준 { sum, n } 을 Σsum ÷ Σn 으로(법인 평균의 평균이 아니다). n 이 0 이면 null. */
export function avgOf(x) {
  const s = numOrNull(x?.sum); const n = numOrNull(x?.n);
  return s == null || n == null || n <= 0 ? null : round1(s / n);
}

/** 상위 N 병합 — 고른 법인의 목록을 합쳐 cmp 순서로 n 개. 같은 id 가 두 번 나오면 하나만. */
export function mergeTopN(lists, cmp, n) {
  const seen = new Set();
  const all = [];
  for (const l of Array.isArray(lists) ? lists : []) {
    for (const it of Array.isArray(l) ? l : []) {
      if (!it || typeof it !== 'object') continue;
      const key = it.id != null ? String(it.id) : null;
      if (key != null) { if (seen.has(key)) continue; seen.add(key); }
      all.push(it);
    }
  }
  return all.sort(cmp).slice(0, Math.max(0, n | 0));
}

/** 이름 비교(같으면 id) — 서버 vmInsight.js byName 과 같은 마지막 비교. */
export const byName = (a, b) => String(a?.name).localeCompare(String(b?.name)) || String(a?.id).localeCompare(String(b?.id));

/** 몫(%) — 분모가 없거나 0 이면 null. */
export function shareOf(part, whole) {
  const p = numOrNull(part); const w = numOrNull(whole);
  return p == null || w == null || w <= 0 ? null : (p / w) * 100;
}
/** 몫 글자 — '12.3%' · 모르면 '—'. 1% 미만이 0 이 아니면 '<1%'. */
export function shareText(part, whole) {
  const s = shareOf(part, whole);
  if (s == null) return '—';
  if (s > 0 && s < 1) return '<1%';
  return `${s >= 10 ? Math.round(s) : Math.round(s * 10) / 10}%`;
}
/** 천 단위 쉼표 — 모르면 '—'. */
export const fmtN = (v) => { const n = numOrNull(v); return n == null ? '—' : Math.round(n).toLocaleString('en-US'); };
/** 수 + 단위 — 값이 없으면 단위 없이 '—'(BUG-20 · dbg3221 2회차: `${fmtN(x)}대` 는 null 이면 ‘—대’ 가 됐다). 분석 화면의 수 + 단위는 이것으로. */
export const fmtU = (v, unit) => { const t = fmtN(v); return t === '—' ? t : `${t}${unit}`; };
/** GB → 'x GB' · 1,024 GB 이상은 'x.x TB'. 모르면 '—'(단위 없음). */
export function gbText(gb) {
  const n = numOrNull(gb);
  if (n == null) return '—';
  if (Math.abs(n) >= 1024) return `${(n / 1024).toFixed(1)} TB`;
  return `${Math.round(n).toLocaleString('en-US')} GB`;
}
/** 막대 폭(0~100 %) — 최대값 대비. 모르면 0 폭(글자는 따로 '—'). */
export function barPct(v, max) {
  const n = numOrNull(v); const m = numOrNull(max);
  if (n == null || m == null || m <= 0) return 0;
  return Math.max(0, Math.min(100, (n / m) * 100));
}
