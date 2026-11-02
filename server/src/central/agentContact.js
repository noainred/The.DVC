/**
 * central/agentContact.js — 엣지(agent)가 중앙에 마지막으로 **인증된 요청**을 보낸 시각(v2.849 · 인메모리).
 *
 * 배경(사용자 화면 — 완전 설치 대상 표가 모든 엣지를 '불가 — 엣지 응답 없음(마지막 수신 55153분 전)' 으로 막음):
 *   완전 설치는 엣지 응답을 '그 vCenter 인벤토리를 마지막으로 받은 시각' 하나로 봤다. vCenter 를 중앙이 직접 수집하면 엣지는 인벤토리를
 *   더 올리지 않으므로, 엣지가 살아서 설정을 받고 다른 데이터를 올려도 오래전 시각이 남았다. 중앙 라우터의 인증 미들웨어가 모든 인증된
 *   요청에서 이 표를 갱신한다(개별 토큰 = 그 토큰의 이름 · 공유 토큰 = 중앙이 이미 아는 이름만 — 이름을 지어내 표를 채우지 못하게).
 *
 * 재시작하면 비어 있다(다음 요청부터 다시 — 엣지는 설정 받기로 몇 분마다 온다). 비밀 · 경로 · 본문은 싣지 않는다(이름 · 시각만).
 */
const MAX = 2_000;
const _seen = new Map();   // 소문자 이름 → { agent, at }

/** 인증된 요청 하나 — 미들웨어가 부른다. */
export function noteAgentContact(agent, at = Date.now()) {
  const name = typeof agent === 'string' ? agent.trim().slice(0, 64) : '';
  if (!name) return;
  const k = name.toLowerCase();
  if (_seen.has(k)) _seen.delete(k);   // 최근 순서 유지(가장 오래된 것부터 밀어낸다)
  else if (_seen.size >= MAX) _seen.delete(_seen.keys().next().value);
  _seen.set(k, { agent: name, at });
}

/** 그 엣지의 마지막 인증된 요청 시각(ms) — 모르면 null. */
export function agentLastContact(agent) {
  const k = typeof agent === 'string' ? agent.trim().toLowerCase() : '';
  return (k && _seen.get(k)?.at) || null;
}

export function _resetAgentContactForTest() { _seen.clear(); }
