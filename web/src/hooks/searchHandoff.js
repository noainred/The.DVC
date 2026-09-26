/**
 * hooks/searchHandoff.js — 화면 사이의 검색어 인계(v2.616, V5 통합 검색).
 *
 * V5 상단 검색에서 'IP 관리에서 ‘x’ 찾기' 를 누르면 그 화면으로 가면서 검색어를 넘긴다. IP관리·시리얼 조회는
 * 개발 포탈 필터바의 검색어를 받지 않고 자기 검색 칸을 가지므로, 받는 화면이 **마운트할 때 1회** 꺼내 쓴다.
 * 모듈 변수(메모리)다 — URL 에 싣지 않는다(검색어에 IP·시리얼이 들어가 주소창·기록에 남을 이유가 없다).
 * 꺼내면 지운다(다음 방문에 옛 검색어가 다시 들어가지 않게). 30초가 지나면 버린다(늦게 열린 화면에 새지 않게).
 */
const TTL_MS = 30_000;
let _pending = null; // { target, q, at }
const _subs = new Set();

/**
 * v2.617: 받는 화면이 **이미 열려 있으면** 주소가 같아 다시 마운트되지 않으므로 검색어가 버려지고 30초 동안 남아
 * 다음 방문에 뜻하지 않게 채워졌다. 열려 있는 화면은 구독해 즉시 받는다(받으면 지워진다). 해제 함수를 돌려준다.
 */
export function onSearchHandoff(fn) {
  _subs.add(fn);
  return () => { _subs.delete(fn); };
}

export function handoffSearch(target, q, now = Date.now()) {
  const s = String(q || '').trim();
  _pending = s ? { target: String(target || ''), q: s, at: now } : null;
  if (_pending) for (const fn of [..._subs]) { try { fn(_pending.target); } catch { /* 받는 쪽 오류가 보내는 쪽을 막지 않는다 */ } }
}

/** target 앞으로 남긴 검색어를 꺼낸다(없으면 ''). 꺼내면 지운다. */
export function takeSearch(target, now = Date.now()) {
  const p = _pending;
  if (!p || p.target !== target) return '';
  _pending = null;
  return now - p.at <= TTL_MS ? p.q : '';
}
