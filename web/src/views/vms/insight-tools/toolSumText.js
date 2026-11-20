/**
 * insight-tools/toolSumText.js — VM 분석 화면의 특수 기능 요약 패널 공용 보조(v3.21.0 · 순수 · docs/design/vm-insight §4-1 · §4-2 · §8 · §10).
 *
 * 규약(서버 routes/api/toolSummary.js 와 짝):
 *  · 서버는 도구마다 `?summary=1` 로 **법인(vCenter)별 줄 + 법인별 상위 N** 을 준다. 화면은 고른 법인(vcIds)의 줄을 더하고,
 *    상위 N 은 고른 법인들의 목록을 합쳐 같은 비교 순서로 다시 N 개를 고른다(합집합의 상위 N 은 법인별 상위 N 의 합집합 안에 있다).
 *    선택을 바꿀 때 서버 왕복이 없다.
 *  · 판정을 다시 하지 않는다 — 수 · 목록은 도구가 판정한 그대로 더하기만 한다. 기준값은 응답 값으로 적는다(화면에 박지 않는다).
 *  · 못 읽은 값은 0 이 아니다(numOrNull) — 합에서 빼고 따로 센다 · 값이 없으면 '—'(단위 없음).
 *  · 고른 법인이 응답에 없으면(그 도구가 아직 그 법인을 모른다) 0 으로 채우지 않고 missing 으로 센다.
 */
import { numOrNull } from '../../../numOrNull.js';
import { TOOLS } from '../../specialToolsList.js';

export const TOP_N_DEFAULT = 5;

/** 천 단위 쉼표 정수 — 분석 화면 공용(insightCore) 그대로. 값이 없으면 '—'. */
export { fmtN, fmtU } from '../../insight/insightCore.js';

/** 소수 첫째 자리까지 · 천 단위 쉼표. 값이 없으면 '—'. */
export function fmt1(v) {
  const n = numOrNull(v);
  return n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

/**
 * GB → '1,234.5 GB' · 1,024 GB 이상은 '13.6 TB'. 값이 없으면 단위 없는 '—'.
 * 공용 insightCore.gbText 는 GB 를 정수로 반올림한다 — 파티션 남은 용량(0.5 GB 등)이 ‘1 GB’ 로 보이지 않게 여기서는 소수 첫째 자리까지 둔다.
 */
export function gbText(gb) {
  const n = numOrNull(gb);
  if (n == null) return '—';
  return Math.abs(n) >= 1024 ? `${fmt1(n / 1024)} TB` : `${fmt1(n)} GB`;
}

/** MB → GB 표기(gbText). */
export function mbText(mb) {
  const n = numOrNull(mb);
  return n == null ? '—' : gbText(n / 1024);
}

/** MHz → '1,234.5 GHz'. 값이 없으면 '—'. */
export function ghzText(mhz) {
  const n = numOrNull(mhz);
  return n == null ? '—' : `${fmt1(n / 1000)} GHz`;
}

/** a ÷ b 의 백분율(정수). 분모가 0 이하이거나 값이 없으면 null. */
export function pctOf(a, b) {
  const x = numOrNull(a); const y = numOrNull(b);
  if (x == null || y == null || y <= 0) return null;
  return Math.round((x / y) * 100);
}

/** 백분율 글자 — 값이 없으면 '—'(‘—%’ 로 쓰지 않는다). */
export function pctText(a, b) {
  const p = pctOf(a, b);
  return p == null ? '—' : `${p}%`;
}

/**
 * 고른 법인의 줄만. vcIds 가 비었으면 응답의 줄 전부(서버가 이미 사용자 범위로 거른 것).
 * @returns {{ rows: object[], missing: string[] }} missing = 골랐지만 응답에 줄이 없는 법인 id
 */
export function pickRows(rows, vcIds, keyOf = (r) => r?.vcenterId) {
  const all = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
  const ids = Array.isArray(vcIds) ? vcIds.map((x) => String(x)).filter(Boolean) : [];
  if (!ids.length) return { rows: all, missing: [] };
  const want = new Set(ids);
  const picked = all.filter((r) => want.has(String(keyOf(r) ?? '')));
  const have = new Set(picked.map((r) => String(keyOf(r) ?? '')));
  return { rows: picked, missing: ids.filter((id) => !have.has(id)) };
}

/**
 * dbg3221 5회차: 응답의 '못 읽은 · 수집하지 않는 법인' 목록(notReadVcenters · notCollected — 항목마다 vcenterId)을 **고른 법인으로** 거른다.
 *   서버는 이 목록을 사용자 범위 전체(scopeSlice)로 만든다 — 거르지 않으면 고르지 않은 법인 하나가 불통이어도 '일부만 센 수' 가 떴다.
 *   vcIds 가 비었으면 전부(행 합계 pickRows 와 같은 규칙).
 */
export function pickByVc(list, vcIds) {
  const all = Array.isArray(list) ? list.filter((x) => x && typeof x === 'object') : [];
  const ids = Array.isArray(vcIds) ? vcIds.map((x) => String(x)).filter(Boolean) : [];
  if (!ids.length) return all;
  const want = new Set(ids);
  return all.filter((x) => want.has(String(x.vcenterId ?? '')));
}
/** 못 읽은 법인 중 합계를 하한으로 만드는 것이 있는가 — 서버 corelicense/analyze.js notReadPartialOf 와 같은 뜻(비활성 'disabled' 만이면 false · 시험이 대조). */
export const notReadPartialIn = (list) => (Array.isArray(list) ? list : []).some((x) => x?.why !== 'disabled');
/**
 * 고른 법인 범위의 못 읽음 — { list, partial, nMissing(비활성 제외) · nDisabled(비활성), missing }. 못 읽은 법인은 행이 없어 pickRows 의 missing 에도 잡히므로
 * missing 에서는 뺀다(같은 법인을 '못 읽음' 과 '이 도구에 값 없음' 으로 두 번 세지 않는다). vcIds 가 비었으면 partial 은 응답 값 그대로.
 */
export function notReadPicked(resp, vcIds, missing = []) {
  const list = pickByVc(resp?.notReadVcenters, vcIds);
  const picked = Array.isArray(vcIds) && vcIds.some((x) => String(x));
  const partial = picked ? notReadPartialIn(list) : resp?.partial === true;
  const nr = new Set(list.map((x) => String(x.vcenterId)));
  // dbg3221 7회차: 개수도 판정 코어(notReadPartialIn · 서버 isNotReadMissing)와 같은 구분 — 읽지 못함(비활성 제외) · 비활성(수집하지 않음)을 따로 센다.
  const nDisabled = list.filter((x) => x?.why === 'disabled').length;
  return { list, partial, nMissing: list.length - nDisabled, nDisabled, missing: (Array.isArray(missing) ? missing : []).filter((id) => !nr.has(String(id))) };
}

/**
 * 줄의 값을 더한다 — 읽은 값만 더하고 못 읽은 줄 수를 센다.
 * @returns {{ sum: number|null, n: number, unknown: number }} 읽은 줄이 하나도 없으면 sum = null(0 을 지어내지 않는다)
 */
export function sumOf(rows, get) {
  let sum = 0; let n = 0; let unknown = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    const v = numOrNull(get(r));
    if (v == null) { unknown += 1; continue; }
    sum += v; n += 1;
  }
  return { sum: n ? sum : null, n, unknown };
}

/** sumOf 의 합만(읽은 줄이 없으면 null). */
export const total = (rows, get) => sumOf(rows, get).sum;

/** 같은 길이의 수 배열을 칸마다 더한다(못 읽은 칸은 그 칸에서만 빠진다). 배열이 하나도 없으면 null. */
export function sumArrays(rows, get, len) {
  const arrs = (Array.isArray(rows) ? rows : []).map(get).filter(Array.isArray);
  if (!arrs.length) return null;
  const L = Number.isInteger(len) && len > 0 ? len : Math.max(...arrs.map((a) => a.length));
  const out = Array.from({ length: L }, () => 0);
  for (const a of arrs) for (let i = 0; i < L; i++) { const v = numOrNull(a[i]); if (v != null) out[i] += v; }
  return out;
}

/** 객체 값(키 → 수)을 키마다 더한다. 없으면 빈 객체. */
export function sumObjects(rows, get) {
  const out = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    const o = get(r);
    if (!o || typeof o !== 'object') continue;
    for (const [k, v] of Object.entries(o)) { const n = numOrNull(v); if (n != null) out[k] = (out[k] || 0) + n; }
  }
  return out;
}

/** 이름 비교(같은 값의 마지막 비교 — 같은 입력이면 같은 순서). */
export const byName = (a, b) => String(a?.name ?? a?.vmName ?? '').localeCompare(String(b?.name ?? b?.vmName ?? ''));

/** 큰 순 비교(null 은 뒤로). */
export function descNull(a, b) {
  const x = numOrNull(a); const y = numOrNull(b);
  if (x == null && y == null) return 0;
  if (x == null) return 1;
  if (y == null) return -1;
  return y - x;
}
/** 작은 순 비교(null 은 뒤로). */
export function ascNull(a, b) {
  const x = numOrNull(a); const y = numOrNull(b);
  if (x == null && y == null) return 0;
  if (x == null) return 1;
  if (y == null) return -1;
  return x - y;
}

/**
 * 법인별 상위 N 을 합쳐 다시 상위 N — 각 항목에 그 줄의 vcenterId 를 붙인다(항목에 이미 있으면 그대로).
 * @param {object[]} rows  고른 법인의 줄
 * @param {(row:object)=>object[]} getList  줄의 상위 목록
 * @param {(a,b)=>number} cmp  도구의 비교 순서(null 이면 줄 순서 · 목록 순서 그대로 — '도구가 준 순서')
 * @param {number} n
 */
export function mergeTop(rows, getList, cmp, n = TOP_N_DEFAULT) {
  const all = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const list = getList(r);
    if (!Array.isArray(list)) continue;
    for (const x of list) if (x && typeof x === 'object') all.push({ ...x, vcenterId: x.vcenterId ?? r.vcenterId });
  }
  const sorted = typeof cmp === 'function' ? all.sort((a, b) => cmp(a, b) || byName(a, b)) : all;
  return sorted.slice(0, Math.max(0, Number(n) || TOP_N_DEFAULT));
}

/** VM 집계 줄(rows prop)에서 법인 id → 이름. 없으면 도구 줄의 name, 그것도 없으면 id. */
export function corpNameOf(insightRows, toolRows = []) {
  const m = new Map();
  for (const r of Array.isArray(toolRows) ? toolRows : []) if (r?.vcenterId && r?.name) m.set(String(r.vcenterId), String(r.name));
  for (const r of Array.isArray(insightRows) ? insightRows : []) if (r?.id && r?.name) m.set(String(r.id), String(r.name));
  return (id) => m.get(String(id ?? '')) || String(id ?? '—');
}

/**
 * 고른 범위 호스트 한 대의 평균 메모리(GB) — /hosts/corp 의 법인 줄(memTotalGB 는 용량을 읽은 호스트의 합 · capUnknown 은 못 읽은 호스트 수).
 * 못 읽은 호스트는 분모에서도 뺀다(0 GB 호스트로 세지 않는다) · 오래된(stale) 법인은 뺀다. 읽은 호스트가 없으면 null.
 * S2 환산 판정은 이것 하나 — 분석 보기의 회수 후보(vmInsightText.hostAvgMemGB)도 이 함수를 부른다(리뷰 정정: 두 벌이 오래됨 처리에서 갈렸다).
 */
export function hostAvgMemGB(corps, vcIds) {
  const { rows } = pickRows(corps, vcIds, (c) => c?.id);
  let mem = 0; let hosts = 0;
  for (const c of rows) {
    if (c.stale === true) continue;
    const m = numOrNull(c.memTotalGB); const h = numOrNull(c.hosts);
    if (m == null || h == null) continue;
    const known = h - (numOrNull(c.capUnknown) || 0);
    if (known <= 0) continue;
    mem += m; hosts += known;
  }
  return hosts > 0 ? { avgGB: mem / hosts, hosts } : null;
}

/**
 * S2 — 미사용 메모리를 '호스트 약 N대분' 으로. 메모리에만 쓴다(CPU 는 여러 VM 이 물리 코어를 나눠 써 대수로 바꾸면 부풀려지고,
 * 스토리지는 데이터스토어의 것이라 호스트로 바꿀 수 없다 — host-insight README §9 정정). 소수 첫째 자리. 모르면 null.
 */
export function hostsEq(idleGB, hostAvg) {
  const g = numOrNull(idleGB); const a = numOrNull(hostAvg?.avgGB ?? hostAvg);
  if (g == null || a == null || a <= 0) return null;
  return Math.round((g / a) * 10) / 10;
}

/**
 * 도구 권한 판정 — 본체가 준 canTool(웹의 도구 가시성 판정)에 allowed(api.js toolAllowed — 서버 집행과 같은 축: tools 권한 + 도구별 허용 · 거부)를
 * 바닥으로 더한다. 둘 다 참일 때만 패널 · 칸을 그리고 요청을 보낸다(요약이 새지 않게 — §6 ⑪). canTool 을 주지 않으면 allowed 만 본다.
 */
export function gateOf(canTool, allowed = () => true) {
  return (k) => !!allowed(k) && (typeof canTool === 'function' ? !!canTool(k) : true);
}

/** 도구 표시 이름(카탈로그) — 없으면 키. */
export function toolLabel(key) {
  return TOOLS.find((t) => t.k === key)?.label || key;
}

/** ‘모두 보기 →’ 주소. sub 는 도구의 하위 탭(Optimization 의 off · snap · tools · cpu · mem). */
export function toolHref(key, sub = '') {
  return `#/tools/${key}${sub ? `/${sub}` : ''}`;
}

/** 고른 법인이 정확히 1곳이면 그 id(도구로 범위를 들고 갈 때) — 아니면 ''. */
export function singleVc(vcIds) {
  const ids = Array.isArray(vcIds) ? vcIds.filter(Boolean) : [];
  return ids.length === 1 ? String(ids[0]) : '';
}

/** 응답이 목 서버의 합성 값인가(mock · synthesized 표시). */
export function synthNote(resp) {
  if (!resp || typeof resp !== 'object') return '';
  if (resp.synthesized === true || resp.mock === true) return '목(mock) 서버가 만들어 낸 값이 섞여 있습니다 — 실제 환경 값이 아닙니다.';
  return '';
}

/** 받은 시각 글자(‘받은 시각 오후 1:46’) — 없으면 ''. */
export function receivedText(at) {
  const t = numOrNull(at);
  if (t == null) return '';
  try { return `받은 시각 ${new Date(t).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })}`; } catch { return ''; }
}

/**
 * 도구 응답에 더할 법인 줄이 하나도 없을 때(view.empty) 패널 본문 대신 쓰는 글 — 수 칸을 ‘—대’ 로 그리지 않는다(dbg3221 2회차).
 *   고른 법인이 응답에 없으면(missing) 그 사실만, 아니면 범위에 값이 없다는 사실만 말한다(이유를 단정하지 않는다). view 가 비지 않았으면 ''.
 */
export function emptyViewText(view) {
  if (!view || view.empty !== true) return '';
  return Array.isArray(view.missing) && view.missing.length ? '고른 법인은 이 도구에 값이 없습니다.' : '이 범위에는 이 도구의 값이 없습니다.';
}

/** 고른 법인 중 응답에 없는 곳 안내 — 없으면 ''. */
export function missingText(missing, nameOf = (x) => x) {
  const m = Array.isArray(missing) ? missing : [];
  if (!m.length) return '';
  const names = m.slice(0, 3).map((id) => nameOf(id)).join(' · ');
  return `고른 법인 중 ${m.length}곳(${names}${m.length > 3 ? ' 외' : ''})은 이 도구에 값이 없어 합에서 뺐습니다.`;
}

/**
 * 조각 막대 — n 이 0 보다 큰 조각만(0 칸을 그리지 않는다). 몫은 flex 로 그린다.
 * @param {{key:string, n:any, label:string, bg:string, ink?:string, title?:string}[]} segs
 */
export function segsOf(segs) {
  return (Array.isArray(segs) ? segs : [])
    .map((s) => ({ ...s, n: numOrNull(s.n) }))
    .filter((s) => s.n != null && s.n > 0);
}

/** 막대 폭(%) — max 대비. 값이 있으면 최소 2%(눈에 보이게) · 없으면 0. */
export function barPct(v, max) {
  const x = numOrNull(v); const m = numOrNull(max);
  if (x == null || m == null || m <= 0 || x <= 0) return 0;
  return Math.max(2, Math.min(100, Math.round((x / m) * 1000) / 10));
}
