/**
 * hooks/searchHandoff.js — 화면 사이의 검색어 인계(v2.616, V5 통합 검색).
 *
 * V5 상단 검색에서 'IP 관리에서 ‘x’ 찾기' 를 누르면 그 화면으로 가면서 검색어를 넘긴다. IP관리·시리얼 조회는
 * 개발 포탈 필터바의 검색어를 받지 않고 자기 검색 칸을 가지므로, 받는 화면이 **마운트할 때 1회** 꺼내 쓴다.
 * 모듈 변수(메모리)다 — URL 에 싣지 않는다(검색어에 IP·시리얼이 들어가 주소창·기록에 남을 이유가 없다).
 * 꺼내면 지운다(다음 방문에 옛 검색어가 다시 들어가지 않게). 30초가 지나면 버린다(늦게 열린 화면에 새지 않게).
 */
const TTL_MS = 30_000;
/*
 * v2.911(⌘K 통합 장비 검색 — 목적 화면에서 고른 장비의 상세 열기): 한 번의 이동이 **검색어와 고른 장비 id 를 함께** 넘겨야 한다
 *   (예: 스토리지 모니터링 ← 'storage-mon' 검색어 + 'storage-mon:focus' 장비 id). 그래서 남기는 칸을 target 별로 둔다.
 *   예전 규칙은 그대로다 — 새로 남기면 **이전에 남긴 것은 모두 버린다**(handoffSearch · handoffMany 둘 다). 한 이동에 쓰는 묶음만 남는다.
 */
let _pending = new Map(); // target → { q, at }
const _subs = new Set();

/**
 * v2.617: 받는 화면이 **이미 열려 있으면** 주소가 같아 다시 마운트되지 않으므로 검색어가 버려지고 30초 동안 남아
 * 다음 방문에 뜻하지 않게 채워졌다. 열려 있는 화면은 구독해 즉시 받는다(받으면 지워진다). 해제 함수를 돌려준다.
 */
export function onSearchHandoff(fn) {
  _subs.add(fn);
  return () => { _subs.delete(fn); };
}

function notify(target) {
  for (const fn of [..._subs]) { try { fn(target); } catch { /* 받는 쪽 오류가 보내는 쪽을 막지 않는다 */ } }
}

export function handoffSearch(target, q, now = Date.now()) {
  handoffMany([[target, q]], now);
}

/** 여러 target 을 한 번에 남긴다(앞의 것부터 알린다). 빈 값은 건너뛴다. 이전에 남긴 것은 모두 버린다. */
export function handoffMany(entries, now = Date.now()) {
  _pending = new Map();
  const added = [];
  for (const [target, q] of Array.isArray(entries) ? entries : []) {
    const s = String(q || '').trim();
    const t = String(target || '');
    if (!s || !t) continue;
    _pending.set(t, { q: s, at: now });
    added.push(t);
  }
  for (const t of added) if (_pending.has(t)) notify(t);
}

/** target 앞으로 남긴 검색어를 꺼낸다(없으면 ''). 꺼내면 지운다. */
export function takeSearch(target, now = Date.now()) {
  const p = _pending.get(target);
  if (!p) return '';
  _pending.delete(target);
  return now - p.at <= TTL_MS ? p.q : '';
}
