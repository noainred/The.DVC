/**
 * hooks/hashTab.js — 해시 라우팅의 하위 탭 계산(순수, v2.438).
 *
 * 이 앱은 해시 라우팅이고 **첫 세그먼트가 상단 탭, 그 뒤는 각 뷰가 처리**하는 규약이다
 * (App.jsx tabFromHash 주석). 그런데 그 규약을 지킨 화면이 SpecialTools 하나뿐이라,
 * 나머지 화면은 **새로고침하면 하위 탭이 첫 항목으로 되돌아갔다** — 사용자 요구
 * ('하위 메뉴 상태에서 새로고침해도 유지'). 여기 판정을 모아 두고 useHashTab 이 쓴다.
 *
 * 세그먼트 규약(깊이):
 *   #/settings/collectors              → base ['settings'],           depth 1
 *   #/settings/agent-deploy/bulk       → base ['settings','agent-deploy'], depth 2
 *   #/tools/gpu/cluster                → base ['tools','gpu'],        depth 2
 */

/** 해시 → 세그먼트 배열(빈 조각 제거). '#/a/b' → ['a','b'] */
export function hashSegments(hash) {
  return String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
}

/** 이 해시가 base 경로(상위 세그먼트) 아래인가. 하위 탭 갱신을 남의 화면에 적용하지 않기 위한 가드. */
export function isUnderBase(hash, base) {
  const segs = hashSegments(hash);
  return base.every((b, i) => segs[i] === b);
}

/**
 * 해시에서 이 화면의 하위 탭 키를 읽는다. base 아래가 아니거나 키가 없거나
 * 알 수 없는 키면 null — 호출자가 fallback 을 정한다(잘못된 딥링크로 화면이 깨지면 안 된다).
 */
export function tabFromHash(hash, base, valid) {
  if (!isUnderBase(hash, base)) return null;
  const k = hashSegments(hash)[base.length] || '';
  return valid.includes(k) ? k : null;
}

/** base + 탭 키 → 해시 문자열. */
export function buildHash(base, key) {
  return `#/${[...base, key].join('/')}`;
}
