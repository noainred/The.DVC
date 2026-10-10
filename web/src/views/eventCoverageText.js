/**
 * eventCoverageText.js — '이 포탈이 지금 vCenter 이벤트를 수집하지 않는 vCenter' 안내 문구 한 벌(v2.733 — 점검 3회차 C1-01, 순수 · vitest).
 *
 * 서버(logs/coverage.js)가 판정해 `notCollected:[{vcenterId, why, name?}]` 로 싣는다. v2.732(B4-01)부터 엣지 위임·비활성·점검중 vCenter 의
 * 이벤트는 이 포탈에 더 쌓이지 않는다 — 그 vCenter 의 '0건' 은 '아무 일도 없었다' 가 아니다. 이 모듈은 그 사실을 짧게 말한다.
 * 사유 키는 서버 EVENT_NOT_COLLECTED_REASONS(= vcenter/collectTarget.js DIRECT_SKIP_REASONS)와 1:1(테스트가 서버 소스와 대조한다).
 * 문구는 일반 글자로 그려지는 곳(배너·표 칸)에서도 쓰이므로 별표·백틱을 쓰지 않는다. 범위 계정 거르기는 서버가 한다.
 */

/** 사유 → 짧은 표기. */
export const NOT_COLLECTED_WHY_TEXT = Object.freeze({
  site: '엣지 위임',
  disabled: '비활성',
  maintenance: '점검중',
});

/** 사유 하나의 짧은 표기 — 모르는 값은 '수집 대상 아님'(지어내지 않는다). */
export function notCollectedWhyText(why) {
  return NOT_COLLECTED_WHY_TEXT[why] || '수집 대상 아님';
}

/** 서버 목록을 믿을 수 있는 모양으로 좁힌다(객체·vcenterId 문자열만). */
export function notCollectedItems(list) {
  return (Array.isArray(list) ? list : []).filter((x) => x && typeof x === 'object' && typeof x.vcenterId === 'string' && x.vcenterId);
}

/** 사유별 개수 문구 — '엣지 위임 2 · 비활성 1'. */
export function notCollectedReasonText(list) {
  const counts = new Map();
  for (const x of notCollectedItems(list)) { const k = notCollectedWhyText(x.why); counts.set(k, (counts.get(k) || 0) + 1); }
  return [...counts].map(([k, n]) => `${k} ${n}`).join(' · ');
}

/** 이름 목록(앞 max 개 + 외 N곳). */
export function notCollectedNames(list, max = 4) {
  const items = notCollectedItems(list);
  const names = items.slice(0, max).map((x) => x.name || x.vcenterId);
  return `${names.join(', ')}${items.length > max ? ` 외 ${items.length - max}곳` : ''}`;
}

/**
 * 결과 화면 머리의 한 줄 — 없으면 ''.
 * @param {Array} list 서버 notCollected
 * @param {{what?:string, tail?:string}} [opts] what — 그 화면이 말하는 것('이벤트'·'변경'·'로그인 실패' … 뒤에 조사를 붙이지 않는 자리에만 쓴다), tail — 끝 문장(바꿀 때만)
 */
export function notCollectedNote(list, { what = '이벤트', tail } = {}) {
  const items = notCollectedItems(list);
  if (!items.length) return '';
  const end = tail ?? `그 vCenter 의 ${what} 기록은 수집을 멈추기 전 것만 있고 그 뒤는 알 수 없습니다(‘${what} 없음’ 이 아닙니다)`;
  return `이 포탈이 지금 이벤트를 수집하지 않는 vCenter ${items.length}곳(${notCollectedReasonText(items)}): ${notCollectedNames(items)} — ${end}.`;
}

/** 고른 vCenter 하나가 목록에 있으면 그 항목(없으면 null). */
export function notCollectedOf(list, vcenterId) {
  if (!vcenterId) return null;
  return notCollectedItems(list).find((x) => x.vcenterId === String(vcenterId)) || null;
}

/** 고른 vCenter 가 수집 대상이 아닐 때의 한 문장 — '{what} 없음' 대신 쓴다. */
export function notCollectedOneText(item, { what = '이벤트' } = {}) {
  if (!item) return '';
  return `이 vCenter 는 이 포탈이 지금 이벤트를 수집하지 않습니다(${notCollectedWhyText(item.why)}) — ‘${what} 없음’ 이 아닙니다. 남은 기록은 수집을 멈추기 전 것입니다.`;
}
