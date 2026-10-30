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

/**
 * 상단 탭에서 특수 기능으로 옮긴 화면의 옛 해시 → 새 해시(v2.592).
 * 북마크·공유 링크·관제 콘솔 내비가 옛 주소를 들고 있으므로 지우지 말 것 — 옮긴 화면이 늘면 여기에 더한다.
 *   '#/insights'         → '#/tools/insights-hub'
 *   '#/insights/anomaly' → '#/tools/insights-hub/anomaly'
 *   '#/explore'          → '#/tools/explore'        (v2.274 에 옮긴 탭 — v2.613 CATALOG2613-09 에 소급)
 *   '#/nsx/segments'     → '#/tools/nsx/segments'   (〃. 예전에는 TABS 에 없어 랜딩 탭으로 조용히 떨어졌다)
 * ⚠ '#/tools/insights' 는 다른 화면(운영 인사이트)이다 — 그리로 보내지 말 것.
 * 해당 없으면 null.
 */
export const MOVED_TABS = Object.freeze({
  insights: ['tools', 'insights-hub'],
  explore: ['tools', 'explore'],
  nsx: ['tools', 'nsx'],
});
/**
 * v2.827: 하위 탭 주소(두 조각)가 통째로 옮겨 간 것 — 첫 조각은 그대로 살아 있는 화면이라 MOVED_TABS 에 넣을 수 없다.
 *   '#/settings/edge-tokens' → '#/tools/edge-tokens'  (설정 › 수집 서버 › 엣지 토큰 맞추기 → 독립 도구·공통 메뉴)
 */
export const MOVED_SUBS = Object.freeze({
  'settings/edge-tokens': ['tools', 'edge-tokens'],
});
export function movedTabHash(hash) {
  const segs = hashSegments(hash);
  if (segs.length >= 2) {
    const k2 = `${segs[0]}/${segs[1]}`;
    if (Object.hasOwn(MOVED_SUBS, k2)) return `#/${[...MOVED_SUBS[k2], ...segs.slice(2)].join('/')}`;
  }
  const to = segs.length ? MOVED_TABS[segs[0]] : null;
  if (!to || !Object.hasOwn(MOVED_TABS, segs[0])) return null;
  return `#/${[...to, ...segs.slice(1)].join('/')}`;
}

/**
 * 지운 셸(V3·V4·V5·V6)의 옛 주소 → 기본 화면 주소(v2.747). 셸 코드는 지웠지만 북마크·공유 링크는 남아 있으므로
 * 빈 화면이나 엉뚱한 랜딩 탭으로 떨어지지 않게 옮긴다. 해당 없으면 null.
 *   '#/v5' · '#/v6'                → '#/overview'
 *   '#/v5/vms' · '#/v6/tools/gpu'  → '#/vms' · '#/tools/gpu'  (V5·V6 는 기존 주소 위의 틀이었다 — 뒤 주소가 곧 기존 화면)
 *   '#/v6/m/…' · '#/m/…'          → '#/overview'              (V6 메뉴 페이지 — 기본 화면에 대응하는 주소가 없다)
 *   '#/v3/…' · '#/v4/…'           → '#/overview'              (V4 자체 화면 — 기본 화면과 1:1 대응이 없다)
 */
export function legacyShellHash(hash) {
  const segs = hashSegments(hash);
  const head = segs[0];
  if (head === 'v3' || head === 'v4' || head === 'm') return '#/overview';
  if (head !== 'v5' && head !== 'v6') return null;
  const rest = segs.slice(1);
  if (!rest.length || rest[0] === 'm' || /^v[3-6]$/.test(rest[0])) return '#/overview';
  return `#/${rest.join('/')}`;
}

/** 지운 V5·V6 셸이 브라우저에 남긴 셸 플래그 키(v2.616~v2.746). 기동 시 지운다 — 남겨 둘 이유가 없다. */
export const LEGACY_SHELL_KEY = 'ui.shell';
