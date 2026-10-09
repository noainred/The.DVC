/**
 * VM 목록(`GET /api/vms`) 페이지 순회 — v2.730(검토 I-02).
 *
 * 문제: `/vms` 는 limit 을 5,000 으로 자르고 `items: vms.slice(0, limit)` 만 돌려줬다. 운영 규모(약 5,850 VM)에서
 * total·totals 는 전체 기준인데 나머지 VM 을 같은 검색·정렬 조건으로 가져올 방법이 없었다.
 *
 * 계약(요청에 `paged=1` 또는 `cursor=` 가 있을 때만 — 없으면 예전 응답 그대로, 새 필드만 붙는다):
 *  - 순서: `sortBy` 값(없으면 생략) → 고유 행 키(VM id) 오름차순. 값의 종류는 숫자 < 문자열 < 빈 값(null·''·NaN·객체)
 *    순으로 고정이고(방향과 무관 — 빈 값은 언제나 뒤), 같은 종류 안에서만 `order` 방향을 따른다. 행 키가 고유하므로
 *    전순서(total order)다 — 같은 이름·같은 CPU 값이 수천 개여도 경계에서 누락·중복이 없다.
 *  - ⚠⚠ **스냅샷 변경 규칙(순서 고정 = pin)**: 첫 페이지를 계산할 때 그 스냅샷의 전체 일치 집합을 위 순서로 정렬한
 *    '행 키 목록' 을 기억한다(`orderAsOf` = 그 스냅샷 시각). 다음 페이지는 **그 목록의 위치(p)** 로 이어 간다 —
 *    값은 지금 스냅샷의 값이지만 순서와 대상 집합은 첫 페이지 시점의 것이다. 그래서 정렬 키가 CPU 사용률처럼 30초마다
 *    바뀌어도 **같은 VM 이 두 페이지에 나오지 않고**, 순회 도중 사라진 VM 은 건너뛰고(`vanished`) 새로 생긴 VM 은
 *    이 순회에 넣지 않고 개수만 밝힌다(`added` — '처음부터' 다시 보면 포함된다). 키셋(값 + id) 커서는 값이 바뀌는 정렬에서
 *    중복·누락을 막을 수 없어 쓰지 않았다.
 *  - 기억은 인메모리 LRU 다(상한 `PIN_MAX` 개 · 키 합계 `PIN_KEYS_MAX` · 유휴 `PIN_IDLE_MS`). 커서의 순서 목록이 없고
 *    스냅샷도 바뀌었으면 **409 `cursor-stale`**(처음부터 다시 — 서버 재시작·축출·유휴 만료). 스냅샷이 같으면 목록을
 *    결정적으로 다시 만든다(같은 입력 → 같은 순서).
 *  - 커서는 서명하지 않은 base64url JSON 이다 — 권한을 담지 않는다. 범위(scope)는 매 요청 `applyFilters(req.user)` 가
 *    먼저 강제하므로 커서로 범위 밖 VM 을 볼 수 없다. 기억 키에 범위 문자열 전체가 들어가고, 커서의 범위 지문이 지금
 *    범위와 다르면 409(`cursor-stale`) 다. 정렬이 다르면 400 `cursor-sort-mismatch`, 검색 조건이 다르면 400
 *    `cursor-query-mismatch`, 형식이 틀리면 400 `cursor-invalid`, 정렬 키 이름이 틀리면 400 `bad-sort`.
 *
 * 순수 함수 + 기억 저장소 하나. 라우트(`routes/api/inventory.js`)가 범위·필터를 먼저 적용한 배열을 넘긴다.
 */

export const VM_PAGE_MAX = 5000;
export const VM_PAGE_DEFAULT = 500;
export const VM_CURSOR_MAX_LEN = 512;
const PIN_MAX = 32;
const PIN_KEYS_MAX = 300000;
const PIN_IDLE_MS = 900000; // 15분

/** 페이지 순회 요청인가 — `paged=1|true` 또는 비어 있지 않은 `cursor`. */
export function isPagedRequest(q) {
  if (!q) return false;
  if (typeof q.cursor === 'string' && q.cursor !== '') return true;
  return q.paged === '1' || q.paged === 'true';
}

/** 페이지 크기 — 예전 limit 가드와 같은 범위(1~5,000, 기본 500), 소수는 내린다. */
export function pageLimitOf(q) {
  const n = Math.floor(Number(q?.limit));
  return Math.max(1, Math.min(n || VM_PAGE_DEFAULT, VM_PAGE_MAX));
}

const SORT_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** 정렬 조건 — sortBy 이름은 영문자로 시작하는 짧은 식별자만(프로토타입 이름 차단). 없으면 id 순. */
export function vmSortSpec(q) {
  const raw = q?.sortBy;
  if (raw == null || raw === '') return { ok: true, by: '', order: 'asc' };
  if (typeof raw !== 'string' || !SORT_KEY_RE.test(raw)) return { ok: false, code: 'bad-sort' };
  return { ok: true, by: raw, order: q.order === 'asc' ? 'asc' : 'desc' };
}

/** 일치 집합을 정하는 쿼리 키 — 이 값이 다르면 다른 목록이다(limit·cursor·paged·정렬은 제외). */
export const VM_FILTER_KEYS = [
  'vcenterId', 'region', 'q', 'notes', 'nameOnly', 'powerState', 'host',
  'vcpuMin', 'vcpuMax', 'ramMinGB', 'ramMaxGB', 'diskMinGB', 'diskMaxGB',
  'cpuUsageMin', 'cpuUsageMax', 'memUsageMin', 'memUsageMax', 'os', 'toolsStatus', 'gpu', 'gpuType',
];
export function vmFilterString(q) {
  const parts = [];
  for (const k of VM_FILTER_KEYS) {
    const v = q?.[k];
    if (v === undefined || v === null || v === '') continue;
    parts.push([k, typeof v === 'string' ? v : JSON.stringify(v)]);
  }
  return JSON.stringify(parts);
}

/** FNV-1a 32비트 → 8자리 16진수(커서의 조건 지문 — 비밀이 아니다). */
export function fnv8(s) {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * 행마다 고유 키 — VM id(없으면 vCenter + 이름). 같은 id 가 두 번 나오면(손상된 수집) 두 번째부터 순번을 붙여
 * 한쪽이 다른 쪽을 덮지 않게 한다(Map 하나로 묶으면 한 VM 이 조용히 사라진다).
 */
export function rowKeysOf(vms) {
  const seen = new Map();
  const out = new Array(vms.length);
  for (let i = 0; i < vms.length; i++) {
    const v = vms[i];
    const base = typeof v?.id === 'string' && v.id !== '' ? v.id : `\u0001${String(v?.vcenterId ?? '')}\u0001${String(v?.name ?? '')}`;
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    out[i] = n ? `${base}\u0000${n}` : base;
  }
  return out;
}

const COLL = new Intl.Collator(undefined, { numeric: true });
/** 값의 종류 — 0 숫자 · 1 문자열 · 2 빈 값. */
function classOf(x) {
  if (typeof x === 'number') return Number.isFinite(x) ? 0 : 2;
  if (typeof x === 'string') return x === '' ? 2 : 1;
  if (typeof x === 'boolean') return 1;
  return 2;
}
function sortValueOf(vm, by) {
  if (!by || !vm || typeof vm !== 'object' || !Object.hasOwn(vm, by)) return undefined;
  return vm[by];
}

/** 정렬된 행 키 목록(전순서 — 정렬 값 → 행 키). */
export function sortedRowKeys(vms, keys, sort) {
  const dir = sort.order === 'desc' ? -1 : 1;
  const rows = new Array(vms.length);
  for (let i = 0; i < vms.length; i++) {
    const raw = sortValueOf(vms[i], sort.by);
    const c = classOf(raw);
    rows[i] = { k: keys[i], c, v: c === 1 ? String(raw) : raw };
  }
  rows.sort((a, b) => {
    if (sort.by) {
      if (a.c !== b.c) return a.c - b.c;
      if (a.c === 0 && a.v !== b.v) return (a.v - b.v) * dir;
      if (a.c === 1) { const r = COLL.compare(a.v, b.v); if (r) return r * dir; }
    }
    return a.k < b.k ? -1 : a.k > b.k ? 1 : 0;
  });
  return rows.map((r) => r.k);
}

/* ── 커서 ───────────────────────────────────────────────────────────── */
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const HEX8_RE = /^[0-9a-f]{8}$/;
const AT_RE = /^[0-9A-Za-z:.+-]{0,64}$/;
const CURSOR_KEYS = ['at', 'f', 'o', 'p', 's', 'sc', 'v'];

export function encodeVmCursor({ at, s, o, f, sc, p }) {
  return Buffer.from(JSON.stringify({ v: 1, at, s, o, f, sc, p }), 'utf8').toString('base64url');
}

/** 커서 문자열 → { ok:true, cursor } | { ok:false, code:'cursor-invalid' }. 모양을 하나라도 벗어나면 거부한다. */
export function decodeVmCursor(str) {
  const bad = { ok: false, code: 'cursor-invalid' };
  if (typeof str !== 'string' || !str || str.length > VM_CURSOR_MAX_LEN || !B64URL_RE.test(str)) return bad;
  let o;
  try { o = JSON.parse(Buffer.from(str, 'base64url').toString('utf8')); } catch { return bad; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return bad;
  const keys = Object.keys(o).sort();
  if (keys.length !== CURSOR_KEYS.length || keys.some((k, i) => k !== CURSOR_KEYS[i])) return bad;
  if (o.v !== 1) return bad;
  if (typeof o.at !== 'string' || !AT_RE.test(o.at)) return bad;
  if (typeof o.s !== 'string' || (o.s !== '' && !SORT_KEY_RE.test(o.s))) return bad;
  if (o.o !== 'asc' && o.o !== 'desc') return bad;
  if (typeof o.f !== 'string' || !HEX8_RE.test(o.f)) return bad;
  if (typeof o.sc !== 'string' || !HEX8_RE.test(o.sc)) return bad;
  if (!Number.isSafeInteger(o.p) || o.p < 0 || o.p > 10_000_000) return bad;
  return { ok: true, cursor: { at: o.at, s: o.s, o: o.o, f: o.f, sc: o.sc, p: o.p } };
}

/* ── 순서 기억(LRU) ────────────────────────────────────────────────── */
export function createVmPinCache({ maxPins = PIN_MAX, maxKeys = PIN_KEYS_MAX, idleMs = PIN_IDLE_MS, now = () => Date.now() } = {}) {
  const m = new Map(); // key -> { keys, at }
  let keyTotal = 0;
  const drop = (k) => { const e = m.get(k); if (e) { keyTotal -= e.keys.length; m.delete(k); } };
  const sweep = (t) => { for (const [k, e] of m) if (t - e.at > idleMs) drop(k); };
  return {
    get(k) {
      const t = now();
      sweep(t);
      const e = m.get(k);
      if (!e) return null;
      m.delete(k); e.at = t; m.set(k, e); // 최근 사용을 뒤로
      return e.keys;
    },
    set(k, keys) {
      const t = now();
      drop(k);
      m.set(k, { keys, at: t });
      keyTotal += keys.length;
      // 가장 오래 안 쓴 것부터 — 방금 넣은 것은 남긴다(상한보다 큰 목록 하나는 그 하나만 남는다).
      for (const old of m.keys()) {
        if (m.size <= maxPins && keyTotal <= maxKeys) break;
        if (old === k) continue;
        drop(old);
      }
    },
    has(k) { const e = m.get(k); return !!e && now() - e.at <= idleMs; },
    stats() { return { pins: m.size, keys: keyTotal }; },
    clear() { m.clear(); keyTotal = 0; },
  };
}

/** 라우트가 쓰는 기억 저장소 하나(프로세스 수명). */
export const VM_PINS = createVmPinCache();

/**
 * 요청 판정 — 형식·정렬·조건·범위·순서 기억 존재를 본다. 실패면 { ok:false, status, code }.
 * 라우트는 이것을 memoJson 앞에서 불러 400·409 를 캐시 없이 돌려준다.
 */
export function checkVmPageRequest({ q, snapAt, scopeKeyStr, pins = VM_PINS }) {
  const sort = vmSortSpec(q);
  if (!sort.ok) return { ok: false, status: 400, code: sort.code };
  const fstr = vmFilterString(q);
  const f = fnv8(fstr);
  const sc = fnv8(scopeKeyStr);
  const at = String(snapAt ?? '');
  let pos = 0;
  let pinAt = at;
  const raw = typeof q?.cursor === 'string' ? q.cursor : '';
  if (raw) {
    const d = decodeVmCursor(raw);
    if (!d.ok) return { ok: false, status: 400, code: d.code };
    const c = d.cursor;
    if (c.s !== sort.by || c.o !== sort.order) return { ok: false, status: 400, code: 'cursor-sort-mismatch' };
    if (c.f !== f) return { ok: false, status: 400, code: 'cursor-query-mismatch' };
    if (c.sc !== sc) return { ok: false, status: 409, code: 'cursor-stale', why: 'scope-changed' };
    pos = c.p;
    pinAt = c.at;
  }
  const pinKey = `${pinAt}|${sort.by}|${sort.order}|${scopeKeyStr}|${fstr}`;
  if (raw && pinAt !== at && !pins.has(pinKey)) return { ok: false, status: 409, code: 'cursor-stale', why: 'order-expired' };
  return { ok: true, sort, f, sc, at, pinAt, pinKey, pos };
}

/**
 * 캐시 앞 판정 — checkVmPageRequest + (커서가 있을 때) 순서 기억을 확보하고 위치가 목록 안인지 본다.
 * 기억이 없고 스냅샷이 같으면 `matched()`(지금 일치 집합 — 라우트의 판정 한 벌)로 다시 만든다. 그래서 위치 위조·
 * 기억 만료가 본 계산(memoJson) 안에서 오류가 되지 않는다(본 계산 안의 오류는 캐시 규약상 500 이 된다).
 */
export function prepareVmPage({ q, snapAt, scopeKeyStr, matched, pins = VM_PINS }) {
  const chk = checkVmPageRequest({ q, snapAt, scopeKeyStr, pins });
  if (!chk.ok) return chk;
  const raw = typeof q?.cursor === 'string' ? q.cursor : '';
  if (!raw) return chk;
  let order = pins.get(chk.pinKey);
  if (!order) {
    if (chk.pinAt !== chk.at) return { ok: false, status: 409, code: 'cursor-stale', why: 'order-expired' };
    const vms = matched();
    order = sortedRowKeys(vms, rowKeysOf(vms), chk.sort);
    pins.set(chk.pinKey, order);
  }
  if (chk.pos > order.length) return { ok: false, status: 400, code: 'cursor-invalid' };
  return chk;
}

/**
 * 한 페이지를 만든다. `vms` 는 범위·필터를 적용한 지금 스냅샷의 일치 집합(정렬 전).
 * 반환 { ok:true, items, hasMore, nextCursor, page } | { ok:false, status, code }.
 */
export function buildVmPage({ vms, q, snapAt, scopeKeyStr, pins = VM_PINS }) {
  const chk = checkVmPageRequest({ q, snapAt, scopeKeyStr, pins });
  if (!chk.ok) return chk;
  const limit = pageLimitOf(q);
  const keys = rowKeysOf(vms);
  let order = pins.get(chk.pinKey);
  if (!order) {
    if (chk.pinAt !== chk.at) return { ok: false, status: 409, code: 'cursor-stale', why: 'order-expired' };
    order = sortedRowKeys(vms, keys, chk.sort);
  }
  if (chk.pos > order.length) return { ok: false, status: 400, code: 'cursor-invalid' };
  const byKey = new Map();
  for (let i = 0; i < vms.length; i++) byKey.set(keys[i], vms[i]);
  const items = [];
  let i = chk.pos;
  let vanished = 0;
  while (i < order.length && items.length < limit) {
    const v = byKey.get(order[i]);
    i += 1;
    if (v) items.push(v); else vanished += 1;
  }
  let remaining = 0;
  for (let j = i; j < order.length; j++) if (byKey.has(order[j])) remaining += 1;
  const hasMore = remaining > 0;
  if (hasMore) pins.set(chk.pinKey, order); // 다음 페이지가 있을 때만 기억한다(작은 목록은 기억하지 않는다)
  let added = 0;
  if (chk.pinAt !== chk.at) {
    const inOrder = new Set(order);
    for (const k of keys) if (!inOrder.has(k)) added += 1;
  }
  const nextCursor = hasMore
    ? encodeVmCursor({ at: chk.pinAt, s: chk.sort.by, o: chk.sort.order, f: chk.f, sc: chk.sc, p: i })
    : null;
  return {
    ok: true,
    items,
    hasMore,
    nextCursor,
    page: {
      mode: 'paged',
      start: chk.pos,          // 순서 목록에서 이 페이지가 시작한 위치(0부터)
      next: i,                 // 다음 페이지가 시작할 위치
      size: limit,
      sortBy: chk.sort.by || null,
      order: chk.sort.order,
      orderAsOf: chk.pinAt,    // 순서·대상 집합을 정한 스냅샷 시각
      orderTotal: order.length,
      remaining,               // 이 순회에서 아직 남은 VM(지금도 있는 것만)
      vanished,                // 이 페이지 범위에서 건너뛴 VM(순서를 정한 뒤 사라졌거나 조건에서 벗어남)
      added,                   // 순서를 정한 뒤 새로 조건에 맞게 된 VM — 이 순회에는 없다
    },
  };
}
