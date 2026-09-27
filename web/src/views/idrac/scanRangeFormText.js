/**
 * 스캔 대역 편집 폼의 선택 목록 판정(v2.629 WEB2629-02 — 순수, vitest 로 고정).
 *
 * 제어 select 는 value 와 같은 option 이 없으면 **첫 옵션을 보여 준다**. 저장된 담당 엣지(예: 'oc2')가 지금 목록에 없으면
 * 화면은 '이 포탈에서 직접' 으로 보이는데 저장 본문은 'oc2' 를 보내 — 화면과 저장값이 반대가 된다(v2.609 CVP 폼과 같은 결함).
 * 그래서 목록에 없는 저장값은 '(목록에 없음)' 옵션으로 따로 보인다. 비교는 **글자 그대로**다 — select 가 글자 그대로 맞추므로
 * 대소문자만 다른 항목이 목록에 있어도 따로 보여야 한다(그때는 표기가 다르다는 사실을 라벨이 말한다).
 */

/**
 * 목록(values: 문자열 배열)에 없는 현재 값 → { value, label } 또는 null.
 * sentinels 는 목록 밖이어도 정상인 값(예: '__local__')이다.
 */
export function missingChoice(values, current, sentinels = []) {
  const cur = current == null ? '' : String(current);
  if (!cur || sentinels.includes(cur)) return null;
  const list = (Array.isArray(values) ? values : []).map((v) => String(v ?? ''));
  if (list.includes(cur)) return null;
  const caseTwin = list.find((v) => v.toLowerCase() === cur.toLowerCase());
  return { value: cur, label: caseTwin ? `${cur} (목록 표기 '${caseTwin}' 와 대소문자가 다름)` : `${cur} (목록에 없음)` };
}

/**
 * 목록 조회 실패 안내 — errs = { agents, datacenters } (각 문자열 또는 null). 실패가 없으면 ''.
 * 목록을 못 읽었는데 빈 목록처럼 보이면 사용자는 '엣지가 없다'·'법인이 없다' 로 읽는다(무음 실패 금지).
 */
export function choiceLoadNote(errs) {
  const e = errs || {};
  const parts = [];
  if (e.agents) parts.push(`스캔 수행 Agent 목록을 불러오지 못했습니다(${e.agents})`);
  if (e.datacenters) parts.push(`법인(DataCenter) 목록을 불러오지 못했습니다(${e.datacenters})`);
  if (!parts.length) return '';
  return `${parts.join(' · ')} — 저장된 값은 '(목록에 없음)' 으로 그대로 보이며 저장 시 바뀌지 않습니다.`;
}
