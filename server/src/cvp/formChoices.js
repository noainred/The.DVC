/**
 * cvp/formChoices.js — CVP 등록의 '담당 엣지'·'DataCenter' 를 기존 목록의 값으로 맞춘다(v2.609).
 *
 * 사용자 요청: "엣지 이름과 데이터 센터를 콤보박스로 만들어서 기존에 있는 자료에서 선택해서 입력하게,
 * 오타/대소문자에 따른 오타 방지". 화면은 드롭다운으로 바꿨지만 API 는 여전히 문자열을 받는다 —
 * 서버도 같은 규칙을 집행해야 CSV·직접 호출로 들어온 오타가 막힌다.
 *
 * 규칙:
 *  - 빈 값은 그대로('' = 중앙 직접 / DataCenter 미지정).
 *  - 대소문자·앞뒤 공백만 다른 값은 **목록의 표기로 바꿔 저장**한다(‘Edge-seoul’ → ‘edge-Seoul’).
 *  - 목록에 없는 값은 거부한다. 단 **이미 저장돼 있던 값을 그대로 다시 보내는 경우**는 통과시킨다 —
 *    엣지가 아직 중앙과 통신한 적이 없거나 DataCenter 가 삭제됐다고 해서 다른 칸만 고치는 저장이
 *    막히면 안 된다(그 값을 바꾸는 것만 막는다).
 *  - DataCenter 는 id 또는 표시명으로 받고 **id 로 저장**한다.
 */

const norm = (v) => String(v ?? '').trim().toLowerCase();

/**
 * @param {unknown} input 요청 값
 * @param {string[]} known 알려진 엣지 이름(knownAgentNames)
 * @param {string} [prev] 수정 중인 항목에 저장돼 있던 값
 * @returns {{ value: string } | { error: string }}
 */
export function pickAgent(input, known, prev = '') {
  const v = String(input ?? '').trim();
  if (!v) return { value: '' };
  const hit = (Array.isArray(known) ? known : []).find((a) => norm(a) === norm(v));
  if (hit) return { value: String(hit).trim() };
  if (prev && norm(prev) === norm(v)) return { value: String(prev).trim() };
  return { error: `담당 엣지 ‘${v}’ 는 중앙이 아는 엣지 목록에 없습니다 — 목록에서 고르세요(오타·대소문자 차이 방지).` };
}

/**
 * @param {unknown} input 요청 값(id 또는 표시명)
 * @param {{id:string,name?:string}[]} dcs DataCenter 목록
 * @param {string} [prev] 저장돼 있던 id
 * @returns {{ value: string } | { error: string }}
 */
export function pickDatacenter(input, dcs, prev = '') {
  const v = String(input ?? '').trim();
  if (!v) return { value: '' };
  const list = Array.isArray(dcs) ? dcs : [];
  const hit = list.find((d) => d && norm(d.id) === norm(v)) || list.find((d) => d && d.name && norm(d.name) === norm(v));
  if (hit) return { value: String(hit.id) };
  if (prev && norm(prev) === norm(v)) return { value: String(prev).trim() };
  return { error: `DataCenter ‘${v}’ 는 등록된 DataCenter 목록에 없습니다 — 목록에서 고르세요(설정 › DataCenter(법인) 에서 먼저 등록).` };
}
