/**
 * search/inventoryQuery.js — 헤더 ⌘K '통합 장비 검색' 의 질의 해석 · 일치 등급 · 묶음(순수, v2.908).
 *
 * 설계: docs/design/inventory-search/README.md(사용자 컨펌 2026-11-05 — 11종 · 2자 · sn: 은 장비만 · ‘모두 보기’ 는 전용 화면).
 * 색인(행 목록)은 search/inventoryIndex.js, 범위 · 권한 · 가림은 search/inventoryAccess.js 가 정한다. 여기는 **행을 받아 고르기만** 한다.
 *
 * ⚠ 접두 표(PREFIXES)는 웹 `web/src/components/invSearchQuery.js` 에 같은 값이 있다(팔레트가 칩을 그리려고) —
 *   두 벌이므로 `server/test/invSearch2908.test.js` 가 같은 입력으로 대조한다. 한쪽만 고치면 테스트가 깨진다.
 *
 * 성능(docs/rules/perf-db.md): 검색어 소문자화는 1회 · 정규식 없이 includes/startsWith 선형 · 길이 상한(넘으면 아무것도 맞지 않는다 —
 *   잘라서 넓게 맞추지 않는다, deepSearch.js lowerTerm 과 같은 규칙) · 정렬은 일치한 행만.
 */

/** 종류(화면 칩 · 묶음 순서와 같다). label 은 화면 문구, prefix 는 입력 접두. */
export const KINDS = Object.freeze([
  { key: 'vm', label: '가상머신', prefix: 'vm' },
  { key: 'host', label: 'VM호스트', prefix: 'host' },
  { key: 'server', label: '베어메탈 서버', prefix: 'bm' },
  { key: 'gpu', label: 'GPU 서버', prefix: 'gpu' },
  { key: 'storage', label: '스토리지', prefix: 'st' },
  { key: 'sanswitch', label: 'SAN 스위치', prefix: 'san' },
  { key: 'netswitch', label: '네트워크 스위치', prefix: 'net' },
  { key: 'pdu', label: 'PDU', prefix: 'pdu' },
  { key: 'datastore', label: '데이터스토어', prefix: 'ds' },
  { key: 'vcenter', label: 'vCenter', prefix: 'vc' },
  { key: 'ip', label: 'IP 대장', prefix: 'ip' },
]);
export const KIND_KEYS = Object.freeze(KINDS.map((k) => k.key));

/** 접두 → 뜻. `ip:` · `sn:` 은 종류가 아니라 **찾는 칸**을 바꾼다(모든 종류에서 주소 / 시리얼만 본다). */
export const PREFIXES = Object.freeze({
  ...Object.fromEntries(KINDS.filter((k) => k.key !== 'ip').map((k) => [k.prefix, { kind: k.key }])),
  ip: { mode: 'ip' },
  sn: { mode: 'sn' },
});

export const QUERY_MAX = 256;      // 검색어 상한 — 넘으면 아무것도 맞지 않는다
export const MIN_TEXT = 2;         // 장비 검색 최소 글자(컨펌 ⑥)
export const MIN_FIELD = 3;        // ip: · sn: 뒤 최소 글자
export const PER_KIND = 5;         // 묶음당 기본 행 수
export const PER_KIND_SINGLE = 30; // 종류 하나만 고른 경우
export const TOTAL_MAX = 60;       // 응답 전체 상한

/** 시리얼 정규화 — insights/serialLookup.js normKey 와 같은 규칙(대소문자 · 공백 · : _ . - 무시). */
export const normSerial = (v) => String(v ?? '').toLowerCase().replace(/[\s:_.-]/g, '');

const PREFIX_RE = /^([a-z]{2,4}):/i;

/**
 * 원문 → 해석. 접두는 알려진 것만(모르는 `xx:` 는 글자 그대로 — IPv6 `fe80:` 같은 입력을 깨지 않는다).
 * @returns {{ raw:string, mode:'all'|'ip'|'sn', kind:string|null, text:string, needle:string, tooShort:boolean, tooLong:boolean }}
 */
export function parseQuery(raw) {
  const s0 = typeof raw === 'string' ? raw : '';
  if (s0.length > QUERY_MAX) return { raw: '', mode: 'all', kind: null, text: '', needle: '', tooShort: false, tooLong: true };
  let s = s0.trim();
  let mode = 'all'; let kind = null;
  const m = PREFIX_RE.exec(s);
  const p = m ? PREFIXES[m[1].toLowerCase()] : null;
  if (p) {
    s = s.slice(m[0].length).trim();
    if (p.mode) mode = p.mode; else kind = p.kind;
  }
  const needle = s.toLowerCase();
  const min = mode === 'all' ? MIN_TEXT : MIN_FIELD;
  return { raw: s0, mode, kind, text: s, needle, tooShort: needle.length < min, tooLong: false };
}

/** 행 하나의 일치 등급 — 낮을수록 먼저. 맞지 않으면 null(0 은 쓰지 않는다 — '가장 좋음' 과 헷갈린다). */
export function matchTier(row, pq, { addrSearchable = true } = {}) {
  const n = pq.needle;
  if (!n || pq.tooShort || pq.tooLong) return null;
  if (pq.mode === 'ip') return ipTier(row, n, addrSearchable);
  if (pq.mode === 'sn') return snTier(row, normSerial(n));
  if (row._n.startsWith(n)) return 1;
  if (row._n.includes(n)) return 2;
  if (row._a && row._a.includes(n)) return 3;
  const it = ipTier(row, n, addrSearchable);
  if (it != null) return 4;
  const sn = normSerial(n);
  if (sn.length >= MIN_FIELD && snTier(row, sn) != null) return 5;
  if (row._m && row._m.includes(n)) return 6;
  return null;
}

function ipTier(row, n, addrSearchable) {
  for (const ip of row._ip) if (ip.startsWith(n)) return ip === n ? 1 : 2;
  if (addrSearchable && row._addr) {
    if (row._addr === n) return 1;
    if (row._addr.startsWith(n)) return 2;
    if (/[a-z]/.test(n) && row._addr.includes(n)) return 3; // 주소가 호스트명이면 글자로도 찾는다
  }
  return null;
}

function snTier(row, sn) {
  if (!sn) return null;
  let best = null;
  for (const k of row._sn) {
    const t = k === sn ? 1 : k.startsWith(sn) ? 2 : k.includes(sn) ? 3 : null;
    if (t != null && (best == null || t < best)) best = t;
  }
  return best;
}

/**
 * 고르기 — rows 는 **이미 범위 · 권한으로 거른** 행. 종류 순서대로 묶고, 묶음마다 total(전체 일치 수)을 싣는다.
 * @param {Array} rows
 * @param {object} pq parseQuery 결과
 * @param {{ kinds?:Set<string>|null, addrSearchable?:(row)=>boolean, perKind?:number, totalMax?:number }} [opts]
 */
export function searchRows(rows, pq, opts = {}) {
  const want = pq.kind ? new Set([pq.kind]) : (opts.kinds && opts.kinds.size ? opts.kinds : null);
  const single = want && want.size === 1;
  const perKind = Math.max(1, Number(opts.perKind) || (single ? PER_KIND_SINGLE : PER_KIND));
  const totalMax = Math.max(1, Number(opts.totalMax) || TOTAL_MAX);
  const addrOk = typeof opts.addrSearchable === 'function' ? opts.addrSearchable : () => true;
  const hits = new Map(KIND_KEYS.map((k) => [k, []]));
  const counts = Object.fromEntries(KIND_KEYS.map((k) => [k, 0]));
  if (!pq.tooShort && !pq.tooLong && pq.needle) {
    for (const r of rows) {
      const t = matchTier(r, pq, { addrSearchable: addrOk(r) });
      if (t == null) continue;
      counts[r.kind] = (counts[r.kind] || 0) + 1; // 칩 개수는 종류 필터와 무관하게 센다(다른 칩의 수도 보이게)
      if (want && !want.has(r.kind)) continue;
      hits.get(r.kind)?.push({ r, t });
    }
  }
  const groups = []; let shown = 0; let matched = 0;
  for (const k of KIND_KEYS) {
    const list = hits.get(k);
    if (!list.length) continue;
    matched += list.length;
    list.sort((a, b) => a.t - b.t || (a.r._n < b.r._n ? -1 : a.r._n > b.r._n ? 1 : 0));
    const room = Math.max(0, Math.min(perKind, totalMax - shown));
    const take = list.slice(0, room).map((x) => x.r);
    shown += take.length;
    groups.push({ kind: k, total: list.length, rows: take });
  }
  return { groups, counts, shown, matched, omitted: matched - shown };
}
