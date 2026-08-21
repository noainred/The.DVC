// routes/api 공용 헬퍼 — api.js(구 2,445줄) 분할(v2.283.0)로 이동. 본문은 원본 그대로.
// 여러 도메인 모듈이 함께 쓰는 선언만 여기 둔다(단일 도메인 헬퍼는 각 모듈에).
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { snapMemo, sendCached } from '../../util/snapCache.js';


// 동시 다발 폴링/클릭 최적화 — 여러 사용자가 같은 스냅샷에 대해 같은 무거운 계산을 각자 재실행하던
// 것을 single-flight로 1회에 합류시키고(같은 key 동시요청은 하나의 계산 결과를 공유), 짧은 TTL
// 캐시 + ETag/304로 재직렬화·재전송까지 줄인다. key는 스냅샷 리비전 + 요청 URL(경로+쿼리).
// 스냅샷은 poller가 ~30초마다 1회 갱신하므로 그 창 안의 동일 요청은 계산 0회.
// 주의: 관리자가 즉시 반영을 기대하는 변경(뮤트/오버라이드 등)에 걸리는 엔드포인트에는 쓰지 않는다
// (순수 스냅샷 파생 분석에만). 콜백은 async가 아니어도 되며 예외는 그대로 전파된다.
export async function memoJson(req, res, name, compute, { ttlMs = 12_000, extraKey = '' } = {}) {
  try {
    const snap = store.get();
    const key = `${snap.generatedAt}|${req.originalUrl}|${extraKey}`;
    const payload = await snapMemo(name, key, ttlMs, async () => compute(snap));
    sendCached(req, res, key, payload);
  } catch (e) {
    // async 경로라 Express가 sync throw처럼 자동 처리하지 못한다 — 직접 500으로 응답(클라 hang 방지).
    if (!res.headersSent) res.status(500).json({ ok: false, reason: e?.message || 'internal error' });
  }
}

/** Apply common query filters (?vcenterId=, ?region=, ?q=) to a collection. */
// Small deterministic hash for synthesized demo series (stable per key).
export function hash(s) { let h = 2166136261; const str = String(s); for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0); }
// Least-squares slope of y over x.
export function linregSlope(xs, ys) {
  const n = xs.length; if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n; const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0; let den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den === 0 ? null : num / den;
}

// Run `fn` over items with at most `limit` concurrent (for bounded on-demand vCenter queries).
export async function eachLimited(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  }));
}

export function applyFilters(items, query, snap, searchFields = ['name'], user = null) {
  let out = items;
  // 사용자 scope 를 먼저 강제 — 요청 필터로 우회할 수 없게(서버측 데이터 경계).
  const allowed = scopedVcenterIds(user, snap);
  if (allowed) out = out.filter((x) => allowed.has(x.vcenterId));
  if (query.vcenterId) out = out.filter((x) => x.vcenterId === query.vcenterId);
  if (query.region) {
    // Set 조회(v2.343 #8) — 배열 includes 는 항목마다 vCenter 목록 재스캔(O(N×vC), 28개면 항목당 28회).
    const ids = new Set(snap.vcenters.filter((v) => v.location?.region === query.region).map((v) => v.id));
    out = out.filter((x) => ids.has(x.vcenterId));
  }
  if (query.q) {
    const q = String(query.q).toLowerCase();
    // Optional: include the user/vCenter notes in the search (?notes=1).
    const fields = (query.notes === '1' || query.notes === 'true') ? [...searchFields, 'notes'] : searchFields;
    out = out.filter((x) => fields.some((f) => String(x[f] ?? '').toLowerCase().includes(q)));
  }
  return out;
}

/** Sort a collection by a numeric/string field. order: 'asc' | 'desc' (default). */
export function sortBy(items, key, order = 'desc') {
  const dir = order === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    const x = a[key], y = b[key];
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
    return String(x ?? '').localeCompare(String(y ?? '')) * dir;
  });
}

// ── 특수기능 리포트 10종 (v2.217) ──────────────────────────────────────────────
// 공통: 사용자 scope를 먼저 강제(범위 제한 계정이 전 사이트 리포트를 못 보게)하고, memoJson
// 캐시 키에 scope 서명을 섞는다 — 스코프가 다른 사용자가 같은 URL 캐시를 공유하면 데이터 경계가
// 무너진다(기존 /tools/* 집계에는 없던 보강).
export function scopeSlice(snap, user, vcenterId) {
  const allowed = scopedVcenterIds(user, snap);
  const pick = (arr) => {
    let out = arr || [];
    if (allowed) out = out.filter((x) => allowed.has(x.vcenterId));
    if (vcenterId) out = out.filter((x) => x.vcenterId === vcenterId);
    return out;
  };
  return {
    ...snap,
    vcenters: (snap.vcenters || []).filter((v) => (!allowed || allowed.has(v.id)) && (!vcenterId || v.id === vcenterId)),
    hosts: pick(snap.hosts), vms: pick(snap.vms), datastores: pick(snap.datastores), alarms: pick(snap.alarms),
  };
}
export const scopeKey = (user, snap) => { const a = scopedVcenterIds(user, snap); return a ? [...a].sort().join(',') : 'all'; };

/** Map a guest OS string to a coarse family for distribution charts. */
export function osFamily(os = '') {
  const s = os.toLowerCase();
  if (s.includes('windows')) return 'Windows';
  if (s.includes('red hat') || s.includes('rhel')) return 'RHEL';
  if (s.includes('ubuntu')) return 'Ubuntu';
  if (s.includes('centos')) return 'CentOS';
  if (s.includes('suse')) return 'SUSE';
  if (s.includes('debian')) return 'Debian';
  return 'Other';
}
