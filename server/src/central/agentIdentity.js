/**
 * central/agentIdentity.js — 엣지 이름(agent) ↔ 실제 장비(hostname) 대응 추적(v2.428, 구성도 미스매치 #6/#7).
 *
 * 공유 토큰 모드에서는 body.agent 를 신뢰하므로 A 와 IRS 가 같은 AGENT_NAME 이면 인벤토리·함대·스토리지·RMA 잡이 두 장비 사이에서
 * 번갈아 덮어써도 아무 경고가 없었다. 엣지가 push 에 `X-Agent-Hostname` 을 실으면(v2.428) 같은 이름이 다른 hostname 에서 오는지,
 * 같은 vcenterId 를 다른 agent 가 번갈아 push 하는지 기록해 관리 화면(수집 서버)에 충돌로 보여준다. 인메모리(재시작 시 초기화).
 */
const agents = new Map();   // agentLower → { agent, hostname, peer, mock, at, conflict:{ hostname, at } | null }
const owners = new Map();   // vcenterId → { agent, at, conflict:{ agent, at } | null }
const CONFLICT_WINDOW_MS = 30 * 60_000;

export function noteAgentIdentity(agent, { hostname = '', peer = '', mock = false } = {}) {
  const key = String(agent || '').trim().toLowerCase();
  if (!key) return null;
  const now = Date.now();
  const cur = agents.get(key);
  let conflict = cur?.conflict && now - cur.conflict.at < CONFLICT_WINDOW_MS ? cur.conflict : null;
  if (cur && hostname && cur.hostname && cur.hostname !== hostname && now - cur.at < CONFLICT_WINDOW_MS) {
    conflict = { hostname: cur.hostname, at: now };
  }
  const next = { agent: String(agent).trim(), hostname: hostname || cur?.hostname || '', peer, mock: !!mock, at: now, conflict };
  agents.set(key, next);
  return next;
}

export function noteVcenterOwner(vcenterId, agent) {
  const id = String(vcenterId || ''); const a = String(agent || '').trim();
  if (!id || !a) return null;
  const now = Date.now();
  const cur = owners.get(id);
  let conflict = cur?.conflict && now - cur.conflict.at < CONFLICT_WINDOW_MS ? cur.conflict : null;
  if (cur && cur.agent.toLowerCase() !== a.toLowerCase() && now - cur.at < CONFLICT_WINDOW_MS) conflict = { agent: cur.agent, at: now };
  const next = { agent: a, at: now, conflict };
  owners.set(id, next);
  return next;
}

/** 관리 화면용 — agent 별 정체/충돌과 vcenterId 충돌 목록. */
export function agentIdentitySummary() {
  const now = Date.now();
  const byAgent = {};
  for (const [k, v] of agents) byAgent[k] = { ...v, conflict: v.conflict && now - v.conflict.at < CONFLICT_WINDOW_MS ? v.conflict : null };
  const vcenterConflicts = [];
  for (const [id, v] of owners) if (v.conflict && now - v.conflict.at < CONFLICT_WINDOW_MS) vcenterConflicts.push({ vcenterId: id, agent: v.agent, other: v.conflict.agent, at: v.conflict.at });
  return { byAgent, vcenterConflicts };
}

export function _resetForTest() { agents.clear(); owners.clear(); }
