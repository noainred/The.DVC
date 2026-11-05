/**
 * views/vcd/vcdRoute.js — vCenter 화면 주소(v2.895 — 개체 보기 · 승인 시안 ⑧~⑪ · 기본값 8: 같은 vCenter 화면의 탭 자리 + 해시 주소).
 *
 *   #/vcenters                                 vCenter 목록
 *   #/vcenters/<vcId>                          그 vCenter 상세(탭 12개)
 *   #/vcenters/<vcId>/vm/<vmId>[/<탭>]          VM 개체 보기
 *   #/vcenters/<vcId>/host/<hostId>[/<탭>]      ESXi 호스트 개체 보기
 *
 * id 에 ':' 이 들어 있어(vcId:moref) 각 조각을 encodeURIComponent 한다. 모르는 모양은 '목록' 으로 읽는다(지어내지 않는다).
 * 순수 모듈 — vitest 고정.
 */
import { hashSegments } from '../../hooks/hashTab.js';

export const OBJ_TYPES = Object.freeze(['vm', 'host']);

const dec = (s) => { try { return decodeURIComponent(s); } catch { return null; } };

/** 해시 → { vcId, obj: { type, id, tab } | null }. 'vcenters' 가 아니면 둘 다 null. */
export function parseVcRoute(hash) {
  const s = hashSegments(hash);
  if (s[0] !== 'vcenters') return { vcId: null, obj: null };
  const vcId = s[1] ? dec(s[1]) : null;
  if (!vcId) return { vcId: null, obj: null };
  const type = s[2];
  const id = s[3] ? dec(s[3]) : null;
  if (!OBJ_TYPES.includes(type) || !id) return { vcId, obj: null };
  const tab = s[4] ? dec(s[4]) : '';
  return { vcId, obj: { type, id, tab: tab || '' } };
}

/** { vcId, obj } → 해시. vcId 가 없으면 목록. */
export function vcHash(vcId, obj = null) {
  if (!vcId) return '#/vcenters';
  const base = `#/vcenters/${encodeURIComponent(vcId)}`;
  if (!obj || !OBJ_TYPES.includes(obj.type) || !obj.id) return base;
  return `${base}/${obj.type}/${encodeURIComponent(obj.id)}${obj.tab ? `/${encodeURIComponent(obj.tab)}` : ''}`;
}

/** 지금 해시 — 브라우저가 아닌 곳(시험)에서는 '' (window 가 없거나 location 이 없어도 던지지 않는다). */
export function currentHash() {
  try { return typeof window !== 'undefined' && window.location ? String(window.location.hash || '') : ''; } catch { return ''; }
}

/** 해시를 바꾼다(같으면 그대로). 브라우저가 아니면 아무것도 하지 않는다. */
export function goHash(h) {
  try { if (typeof window !== 'undefined' && window.location && window.location.hash !== h) window.location.hash = h; } catch { /* 시험 환경 */ }
}

/** hashchange 구독 — 브라우저가 아니면 빈 해제 함수. */
export function onHashChange(fn) {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {};
  window.addEventListener('hashchange', fn);
  return () => window.removeEventListener('hashchange', fn);
}

/** 해시를 기록 없이 바꾼다(개체의 탭 전환 — 뒤로 가기가 탭마다 쌓이지 않게). hashchange 는 나지 않는다. */
export function replaceHash(h) {
  try { if (typeof window !== 'undefined' && window.history?.replaceState && window.location?.hash !== h) window.history.replaceState(null, '', h); } catch { /* 시험 환경 */ }
}
