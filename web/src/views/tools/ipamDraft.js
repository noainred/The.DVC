/**
 * ipamDraft.js — IP관리 설정 페이지의 **편집 초안** 보관소(v2.636).
 *
 * 사용자 요청: "편집하다가 없어지는 일이 없도록". 입력은 저장 전까지 이 보관소에 남는다 —
 * 다른 서브메뉴로 옮기거나, 대장이 다시 로딩되거나, 범위를 바꿔도(컴포넌트가 언마운트돼도) 돌아오면 그대로다.
 *  · 메모리(Map) + sessionStorage(같은 탭의 새로고침에도 남는다). sessionStorage 는 **try/catch** 다 — 프라이빗 창·차단된
 *    저장소·테스트 환경에서 던진다(CLAUDE.md 규약). 못 쓰면 메모리에만 두고 `volatile` 로 밝힌다.
 *  · 한 초안이 너무 크면(MAX_PERSIST) sessionStorage 에 쓰지 않는다(할당량 초과로 다른 초안까지 못 쓰게 되지 않게) — 역시 volatile.
 *  · 초안에는 **편집을 시작한 시점의 서버 값(base)** 을 함께 둔다. 돌아왔을 때 서버 값이 그 사이 바뀌었으면 그 사실을 말한다
 *    (조용히 덮어쓰면 다른 관리자의 변경을 모르고 지운다).
 *  · 값이 서버 값과 같아지면 초안을 지운다(되돌린 것은 '미저장' 이 아니다).
 * 키 형식: `<페이지>:<세부>` — 앞 조각이 서브메뉴 키라 메뉴가 '미저장' 점을 찍을 수 있다.
 */
const PREFIX = 'ipam.draft.';
export const MAX_PERSIST = 512 * 1024;
const mem = new Map();
const listeners = new Set();
let loaded = false;

function storage() { try { return window.sessionStorage || null; } catch { return null; } }

function loadAll() {
  if (loaded) return;
  loaded = true;
  const s = storage();
  if (!s) return;
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (!k || !k.startsWith(PREFIX)) continue;
      try {
        const rec = JSON.parse(s.getItem(k));
        if (rec && typeof rec === 'object' && 'value' in rec) mem.set(k.slice(PREFIX.length), rec);
      } catch { /* 손상 항목은 무시(다음 저장이 덮는다) */ }
    }
  } catch { /* 저장소 접근 불가 — 메모리만 */ }
}

function emit() { for (const fn of [...listeners]) { try { fn(); } catch { /* 구독자 오류가 다른 구독자를 막지 않게 */ } } }

/** 키 순서와 무관한 JSON — 같은 값인지 비교할 때 쓴다(객체 키 순서가 서버·폼에서 달라도 같은 값). */
export function stableJson(v) {
  const seen = new WeakSet();
  const walk = (x) => {
    if (x === undefined) return null;
    if (x === null || typeof x !== 'object') return x;
    if (seen.has(x)) return null;
    seen.add(x);
    if (Array.isArray(x)) return x.map(walk);
    const out = {};
    for (const k of Object.keys(x).sort()) { if (x[k] !== undefined) out[k] = walk(x[k]); }
    return out;
  };
  try { return JSON.stringify(walk(v)); } catch { return String(v); }
}
export function sameValue(a, b) { return stableJson(a) === stableJson(b); }

export function readDraft(key) { loadAll(); return mem.get(key) || null; }

export function writeDraft(key, value, base) {
  loadAll();
  const rec = { value, base, at: Date.now(), volatile: false };
  let json = null;
  try { json = JSON.stringify(rec); } catch { json = null; }
  const s = storage();
  if (!s || json == null || json.length > MAX_PERSIST) rec.volatile = true;
  else {
    try { s.setItem(PREFIX + key, json); } catch { rec.volatile = true; }
  }
  if (rec.volatile && s) { try { s.removeItem(PREFIX + key); } catch { /* */ } }
  mem.set(key, rec);
  emit();
  return rec;
}

export function clearDraft(key) {
  loadAll();
  const had = mem.delete(key);
  const s = storage();
  if (s) { try { s.removeItem(PREFIX + key); } catch { /* */ } }
  if (had) emit();
}

export function dirtyKeys() { loadAll(); return [...mem.keys()]; }
/** 초안 키의 페이지(서브메뉴 키). */
export function pageOfKey(key) { return String(key).split(':')[0]; }
/** 미저장 초안이 있는 페이지 집합. */
export function dirtyPages() { return new Set(dirtyKeys().map(pageOfKey)); }
export function onDraftChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/**
 * 서버 값을 읽었을 때 폼에 쓸 값(순수). 초안이 있으면 초안이 이기고(사용자가 입력하던 것), 그 사이 서버 값이 바뀌었는지 알린다.
 * @returns {{ value, restored:boolean, serverChanged:boolean, volatile:boolean }}
 */
export function resolveDraft(server, draft) {
  if (!draft) return { value: server, restored: false, serverChanged: false, volatile: false };
  if (sameValue(draft.value, server)) return { value: server, restored: false, serverChanged: false, volatile: false };
  const serverChanged = draft.base !== undefined && draft.base !== null && !sameValue(draft.base, server);
  return { value: draft.value, restored: true, serverChanged, volatile: !!draft.volatile };
}

/**
 * 폼 위에 띄울 문구(순수). null 이면 띄우지 않는다.
 * @param {{restored?:boolean, serverChanged?:boolean, dirty?:boolean, volatile?:boolean}} st
 */
export function draftNote(st = {}) {
  if (!st.dirty && !st.restored) return null;
  const parts = [];
  if (st.restored) parts.push('저장하지 않은 편집을 복원했습니다 — 다른 페이지로 옮기거나 대장이 다시 로딩돼도 입력은 저장 전까지 남습니다.');
  else parts.push('저장하지 않은 변경이 있습니다 — 다른 페이지로 옮겨도 입력은 남습니다. 서버에는 저장을 눌러야 반영됩니다.');
  if (st.serverChanged) parts.push('편집을 시작한 뒤 서버에 저장된 값이 바뀌었습니다(다른 관리자 또는 다른 화면) — 저장하면 지금 입력으로 덮어씁니다. 서버 값을 보려면 ‘서버 값으로 되돌리기’.');
  if (st.volatile) parts.push('입력이 커서 이 탭의 메모리에만 보관합니다 — 새로고침하면 사라집니다.');
  return parts.join(' ');
}

export function _resetDraftsForTest() { mem.clear(); listeners.clear(); loaded = false; }
