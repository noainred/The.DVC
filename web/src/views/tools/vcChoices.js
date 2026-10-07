/**
 * v2.719(감사 W1-01): vCenter 선택지 기억 — 신규 점검 도구 10개 공용 순수 헬퍼.
 *
 * 서버(routes/api/shared.js scopeSlice)는 vCenter 를 고르면 응답의 vCenter 목록도 그 하나로 거른다.
 * 화면이 그 응답으로 선택지를 다시 그리면 드롭다운이 '전체 + 고른 하나' 로 접혀 다른 vCenter 로
 * 바로 갈 수 없었다(VmDnsTool 은 같은 문제를 '전체 응답의 목록 유지' 로 피하고 있었다 — 형제 비대칭).
 *
 * 규칙: '전체'(vcenterId 없음) 응답의 목록이 기준이다(사라진 vCenter 도 여기서 빠진다).
 * vCenter 를 고른 응답은 직전 목록을 지우지 않고, 같은 id 항목만 새 값(개수)으로 바꾼다.
 * 직전 목록이 '전체' 응답에서 온 것이 아니면(범위가 미리 골라진 채 처음 연 경우 등) 응답 목록을 그대로 쓴다(v2.720 R2-04).
 */
export function vcChoiceList(list, idKey = 'vcenterId') {
  return Array.isArray(list) ? list.filter((v) => v && typeof v === 'object' && v[idKey]) : [];
}

// v2.720(감사 R2-04): '전체' 응답에서 온 목록(또는 그것에서 병합한 목록)만 기준으로 표시한다. 범위가 미리 골라진 채
//   도구를 열면 '전체' 응답이 한 번도 오지 않는데, 그때 방문한 vCenter 를 모아 붙이면 일부가 전부처럼 보였다.
//   표지가 없는 직전 목록(고른 응답에서 온 것)은 병합하지 않고 응답 목록만 쓴다. 배열 상태(useState)에 그대로 담기므로
//   배열 자체에 속성을 붙이지 않고 WeakSet 으로 기억한다.
const FULL_LISTS = new WeakSet();

/** 이 목록이 '전체' 응답에서 온 기준 목록인가. */
export function isFullVcChoices(list) {
  return Array.isArray(list) && FULL_LISTS.has(list);
}

export function mergeVcChoices(prev, list, requestedVcId, idKey = 'vcenterId') {
  const cur = vcChoiceList(list, idKey);
  if (!requestedVcId) { FULL_LISTS.add(cur); return cur; }
  if (!isFullVcChoices(prev)) return cur;
  const before = vcChoiceList(prev, idKey);
  const byId = new Map(cur.map((v) => [v[idKey], v]));
  const out = before.map((v) => byId.get(v[idKey]) || v);
  const seen = new Set(out.map((v) => v[idKey]));
  for (const v of cur) if (!seen.has(v[idKey])) out.push(v);
  FULL_LISTS.add(out);
  return out;
}

/**
 * v2.719(감사 W1-03): 선택(vCenter·기간 등)이 바뀌는 패널의 응답을 '받은 선택' 과 함께 보관하고 그릴 것을 고른다.
 * 응답은 { key, r }, 실패는 { key, e } 로 보관한다. 지금 선택(want)과 키가 다른 응답은 그리지 않는다(옛 데이터를
 * 새 선택처럼 보이지 않게). 지금 선택의 실패는 옛 데이터가 있어도 오류로 말한다.
 */
export function selectionKey(...parts) {
  return JSON.stringify(parts.map((p) => (p == null ? '' : String(p))));
}

export function keyedResult(held, failed, want) {
  if (failed && failed.key === want) return { error: failed.e, data: null };
  if (held && held.key === want) return { error: null, data: held.r };
  return { error: null, data: null };
}
