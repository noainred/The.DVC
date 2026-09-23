/**
 * util/agentKey.js — 엣지(agent) 이름으로 저장된 맵을 조회할 때 쓰는 공용 규칙(v2.597, 감사 L2597-03 — 재현).
 *
 * 토큰 바인딩(`routes/central.js`)과 장비 배정(`storage/registry.js devicesForAgent`)은 이름을 **소문자로** 비교하는데
 * 주기(storage/intervals)·GPU 게스트 배포·엣지 사용자 설정은 **글자 그대로** 찾았다. 그래서 등록부에 'Edge-A', 설정에
 * 'edge-a' 로 적히면 같은 설정 응답이 장비는 내려주고 주기·사용자는 빠뜨렸다(오류 없이). 정확히 같은 키가 있으면 그것,
 * 없으면 대소문자만 다른 키를 쓴다(저장 형식은 바꾸지 않는다 — 기존 파일 호환).
 */
export function agentKeyOf(map, name) {
  const want = String(name ?? '').trim();
  if (!want || !map || typeof map !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(map, want)) return want;
  const lo = want.toLowerCase();
  for (const k of Object.keys(map)) if (k.toLowerCase() === lo) return k;
  return null;
}
export function agentValueOf(map, name) {
  const k = agentKeyOf(map, name);
  return k == null ? undefined : map[k];
}
