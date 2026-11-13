/**
 * 지금의 IP 충돌 의심 목록(vNEXT) — 알림 엔진의 평가(alerts.js evaluate)가 매 틱 판정(ipam/conflict.js)해 여기에 둔다. 규칙을 꺼도 판정은 한다(화면 표시용).
 *   대장(ledger.js — '충돌 의심' 배지 · 칩) · 추천 카드가 읽는다. 의존이 없는 작은 모듈로 둔다(ledger → alerts 순환 import 를 만들지 않게).
 *   rev 는 목록(IP · MAC)이 바뀔 때만 오른다 — 대장 캐시 키(ipamRevKey)에 들어간다.
 */
let _map = new Map();   // ip → { mac, vendor, vm:{id,name,vcenterId}, seen, otherVm? }
let _sig = '';
let _rev = 0;
let _at = 0;

export function setConflictSuspects(list, at = Date.now()) {
  const next = new Map();
  for (const c of Array.isArray(list) ? list : []) if (c && typeof c.ip === 'string') next.set(c.ip, { mac: c.mac, vendor: c.vendor || null, vm: c.vm, seen: c.seen, ...(c.otherVm ? { otherVm: c.otherVm } : {}) });
  const sig = [...next].map(([ip, v]) => `${ip}=${v.mac}`).sort().join(',');
  _at = at;
  if (sig === _sig) return false;
  _sig = sig; _map = next; _rev++;
  return true;
}
export function conflictSuspectOf(ip) { return _map.get(ip) || null; }
export function conflictSuspects() { return [..._map].map(([ip, v]) => ({ ip, ...v })); }
export function conflictRev() { return _rev; }
/** 마지막 판정 시각(0 = 아직 판정 전 — 엔진이 첫 틱을 돌기 전). */
export function conflictJudgedAt() { return _at; }
export function _resetConflictStateForTest() { _map = new Map(); _sig = ''; _rev = 0; _at = 0; }
