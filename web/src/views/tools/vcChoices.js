/**
 * v2.719(감사 W1-01): vCenter 선택지 기억 — 신규 점검 도구 10개 공용 순수 헬퍼.
 *
 * 서버(routes/api/shared.js scopeSlice)는 vCenter 를 고르면 응답의 vCenter 목록도 그 하나로 거른다.
 * 화면이 그 응답으로 선택지를 다시 그리면 드롭다운이 '전체 + 고른 하나' 로 접혀 다른 vCenter 로
 * 바로 갈 수 없었다(VmDnsTool 은 같은 문제를 '전체 응답의 목록 유지' 로 피하고 있었다 — 형제 비대칭).
 *
 * 규칙: '전체'(vcenterId 없음) 응답의 목록이 기준이다(사라진 vCenter 도 여기서 빠진다).
 * vCenter 를 고른 응답은 직전 목록을 지우지 않고, 같은 id 항목만 새 값(개수)으로 바꾼다.
 * 직전 목록이 비어 있으면(범위가 미리 골라진 채 처음 연 경우) 응답 목록을 그대로 쓴다.
 */
export function vcChoiceList(list, idKey = 'vcenterId') {
  return Array.isArray(list) ? list.filter((v) => v && typeof v === 'object' && v[idKey]) : [];
}

export function mergeVcChoices(prev, list, requestedVcId, idKey = 'vcenterId') {
  const cur = vcChoiceList(list, idKey);
  const before = vcChoiceList(prev, idKey);
  if (!requestedVcId || before.length === 0) return cur;
  const byId = new Map(cur.map((v) => [v[idKey], v]));
  const out = before.map((v) => byId.get(v[idKey]) || v);
  const seen = new Set(out.map((v) => v[idKey]));
  for (const v of cur) if (!seen.has(v[idKey])) out.push(v);
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
