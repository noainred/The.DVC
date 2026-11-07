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

/*
 * v2.927(A5): 새 탭(⌘/Ctrl+Enter)으로 열 때도 검색어 · 고른 장비를 넘긴다. 메모리 인계는 다른 문서에 닿지 않으므로
 *   ① 보내는 탭이 localStorage 에 **일회용 칸**(`ui.invSearch.newtab:<무작위 16진>` · 60초)을 남기고
 *   ② 새 탭의 **창 이름**(window.name — 주소가 아니다)에 그 번호만 실어 연다.
 *   ③ 새 탭은 화면을 그리기 전에(main.jsx) 그 칸을 꺼내 지우고 메모리 인계(handoffMany)로 옮긴다 · 창 이름도 지운다.
 * 검색어는 주소 · 기록에 남지 않는다(v2.616 규약 그대로). 60초가 지난 칸은 다음에 남길 때 함께 지운다.
 */
export const NEWTAB_PREFIX = 'invho-';
export const NEWTAB_KEY = 'ui.invSearch.newtab:';
export const NEWTAB_TTL_MS = 60_000;
const NONCE_RE = /^[0-9a-f]{16,32}$/;

function randomHex(bytes = 8) {
  try {
    const a = new Uint8Array(bytes);
    globalThis.crypto.getRandomValues(a);
    return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch { return ''; }
}

/** 새 탭에 넘길 묶음을 남기고 창 이름을 돌려준다. 저장이 막혔거나 넘길 것이 없으면 ''(그때는 주소만 연다). */
export function stashForNewTab(entries, { storage = globalThis.localStorage, now = Date.now(), nonce = randomHex() } = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => Array.isArray(e) && e[0] && e[1]).slice(0, 4)
    .map(([t, q]) => [String(t).slice(0, 40), String(q).slice(0, 200)]);
  if (!list.length || !NONCE_RE.test(nonce)) return '';
  try {
    for (let i = (storage?.length || 0) - 1; i >= 0; i--) {
      const k = storage.key(i);
      if (!k || !k.startsWith(NEWTAB_KEY)) continue;
      let old = null;
      try { old = JSON.parse(storage.getItem(k) || 'null'); } catch { old = null; }
      if (!old || !(now - Number(old.at) <= NEWTAB_TTL_MS)) storage.removeItem(k);
    }
    storage.setItem(NEWTAB_KEY + nonce, JSON.stringify({ e: list, at: now }));
    return NEWTAB_PREFIX + nonce;
  } catch { return ''; }
}

/** 새 탭 시작 때 한 번 — 창 이름의 번호로 칸을 꺼내 지우고 메모리 인계로 옮긴다. 옮겼으면 true. */
export function consumeNewTabHandoff({ win = globalThis.window, storage = globalThis.localStorage, now = Date.now() } = {}) {
  let name = '';
  try { name = String(win?.name || ''); } catch { return false; }
  if (!name.startsWith(NEWTAB_PREFIX)) return false;
  try { win.name = ''; } catch { /* 무시 */ }
  const nonce = name.slice(NEWTAB_PREFIX.length);
  if (!NONCE_RE.test(nonce)) return false;
  let rec = null;
  try {
    const k = NEWTAB_KEY + nonce;
    rec = JSON.parse(storage?.getItem(k) || 'null');
    storage?.removeItem(k);
  } catch { return false; }
  if (!rec || !Array.isArray(rec.e) || !(now - Number(rec.at) <= NEWTAB_TTL_MS && now >= Number(rec.at))) return false;
  // 저장소 값은 다시 자른다(남길 때와 같은 상한 — 손댄 값이 와도 길이 · 개수가 늘지 않게).
  handoffMany(rec.e.filter((e) => Array.isArray(e)).slice(0, 4).map(([t, q]) => [String(t ?? '').slice(0, 40), String(q ?? '').slice(0, 200)]), now);
  return true;
}

