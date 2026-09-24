/**
 * central/agentIdentity.js — 엣지 이름(agent) ↔ 실제 장비(hostname) 대응 추적(v2.428, 구성도 미스매치 #6/#7).
 *
 * 공유 토큰 모드에서는 body.agent 를 신뢰하므로 A 와 IRS 가 같은 AGENT_NAME 이면 인벤토리·함대·스토리지·RMA 잡이 두 장비 사이에서
 * 번갈아 덮어써도 아무 경고가 없었다. 엣지가 push 에 `X-Agent-Hostname` 을 실으면(v2.428) 같은 이름이 다른 hostname 에서 오는지,
 * 같은 vcenterId 를 다른 agent 가 번갈아 push 하는지 기록해 관리 화면(수집 서버)에 충돌로 보여준다. 인메모리(재시작 시 초기화).
 *
 * v2.437: 화면이 '이름 충돌' 배지 하나로 두 가지 다른 사고를 뭉뚱그렸고(같은 AGENT_NAME vs 같은 vCenter id),
 * 근거가 툴팁 한 줄뿐이라 어느 장비·어느 IP 인지 알 수 없었다. 충돌 기록에 **양쪽의 hostname·peer(출처 IP)·시각**과
 * 관측 횟수를 남겨 화면에서 상세로 펼칠 수 있게 한다.
 */
const agents = new Map();   // agentLower → { agent, hostname, peer, mock, at, seen, verified, conflict:{...} | null }
const owners = new Map();   // vcenterId → { agent, peer, at, seen, conflict:{...} | null }
const CONFLICT_WINDOW_MS = 30 * 60_000;

/**
 * v2.603(감사 CEN2603-04): 상한. 예전에는 두 Map 에 상한도 퇴출도 없었고 X-Agent-Hostname 을 길이 제한 없이 저장했다 —
 * 공유 토큰은 본문 agent 이름을 고를 수 있으므로 이름을 바꿔 가며 항목을 무한히 만들 수 있었다(관리 화면 응답도 함께 커진다).
 *  · 글자 필드는 128자(이름·hostname·peer). 이름은 수신 라우트가 이미 64자로 자르지만 여기서도 묶는다.
 *  · 미검증 이름(공유 토큰 + 중앙이 모르는 이름)은 작은 링(UNVERIFIED_MAX)에 두고 넘치면 **가장 오래된 미검증 항목**을 밀어낸다.
 *  · 전체 상한(AGENTS_MAX)에 닿으면 미검증 항목부터 밀고, 검증된 항목만 남았으면 **새 항목을 받지 않고 개수를 센다**
 *    (검증된 행은 밀지 않는다 — v2.589 pullStats 규약). 뺀 개수는 요약(omitted)에 싣는다(조용한 상한 금지).
 *  · owners(vcenterId 키)는 상한을 넘으면 가장 오래 갱신되지 않은 것부터 밀어낸다(실제 vCenter 는 매 주기 갱신되어 뒤에 있다).
 */
const TXT_MAX = 128;
const envInt = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };
const AGENTS_MAX = envInt('CENTRAL_AGENT_IDENTITY_MAX', 2_000);
const UNVERIFIED_MAX = envInt('CENTRAL_AGENT_IDENTITY_UNVERIFIED_MAX', 64);
const OWNERS_MAX = envInt('CENTRAL_VCENTER_OWNER_NOTE_MAX', 4_096);
const txt = (v) => (typeof v === 'string' ? v : (typeof v === 'number' && Number.isFinite(v) ? String(v) : '')).slice(0, TXT_MAX);
let omitted = { agents: 0, unverifiedEvicted: 0, owners: 0 };

function evictOldestUnverified() {
  for (const [k, v] of agents) if (!v.verified) { agents.delete(k); omitted.unverifiedEvicted += 1; return true; }
  return false;
}

export function noteAgentIdentity(agent, { hostname = '', peer = '', mock = false, verified = true } = {}) {
  const name = txt(agent).trim();
  const key = name.toLowerCase();
  if (!key) return null;
  hostname = txt(hostname); peer = txt(peer);
  const now = Date.now();
  const cur = agents.get(key);
  if (!cur) {
    // 새 이름 — 상한을 먼저 본다.
    if (!verified) {
      let unv = 0; for (const v of agents.values()) if (!v.verified) unv += 1;
      if (unv >= UNVERIFIED_MAX) evictOldestUnverified();
    }
    if (agents.size >= AGENTS_MAX && !evictOldestUnverified()) { omitted.agents += 1; return null; }
  }
  let conflict = cur?.conflict && now - cur.conflict.at < CONFLICT_WINDOW_MS ? cur.conflict : null;
  if (cur && hostname && cur.hostname && cur.hostname !== hostname && now - cur.at < CONFLICT_WINDOW_MS) {
    // 직전 push 의 정체(hostname/peer/시각)를 함께 남긴다 — '지금 이 이름으로 보내는 쪽'과
    // '방금 전 같은 이름으로 보냈던 쪽'을 화면에서 나란히 보여주기 위함.
    conflict = {
      hostname: cur.hostname, peer: cur.peer || '', at: now, prevAt: cur.at,
      flips: (conflict?.flips || 0) + 1,
    };
  }
  const next = {
    agent: name, hostname: hostname || cur?.hostname || '', peer, mock: !!mock,
    at: now, seen: (cur?.seen || 0) + 1, verified: !!verified || !!cur?.verified, conflict,
  };
  agents.delete(key); // 지우고 다시 넣어 최근 보고가 뒤로 가게(퇴출 순서 = 가장 오래 보고되지 않은 것)
  agents.set(key, next);
  return next;
}

export function noteVcenterOwner(vcenterId, agent, { peer = '', hostname = '' } = {}) {
  const id = txt(vcenterId); const a = txt(agent).trim();
  if (!id || !a) return null;
  peer = txt(peer); hostname = txt(hostname);
  const now = Date.now();
  const cur = owners.get(id);
  let conflict = cur?.conflict && now - cur.conflict.at < CONFLICT_WINDOW_MS ? cur.conflict : null;
  if (cur && cur.agent.toLowerCase() !== a.toLowerCase() && now - cur.at < CONFLICT_WINDOW_MS) {
    conflict = {
      agent: cur.agent, peer: cur.peer || '', hostname: cur.hostname || '', at: now, prevAt: cur.at,
      flips: (conflict?.flips || 0) + 1,
    };
  }
  const next = { agent: a, peer, hostname, at: now, seen: (cur?.seen || 0) + 1, conflict };
  owners.delete(id);
  owners.set(id, next);
  while (owners.size > OWNERS_MAX) { owners.delete(owners.keys().next().value); omitted.owners += 1; }
  return next;
}

/** 관리 화면용 — agent 별 정체/충돌과 vcenterId 충돌 목록. */
export function agentIdentitySummary() {
  const now = Date.now();
  const byAgent = {};
  for (const [k, v] of agents) byAgent[k] = { ...v, conflict: v.conflict && now - v.conflict.at < CONFLICT_WINDOW_MS ? v.conflict : null };
  const vcenterConflicts = [];
  for (const [id, v] of owners) {
    if (!v.conflict || now - v.conflict.at >= CONFLICT_WINDOW_MS) continue;
    vcenterConflicts.push({
      vcenterId: id, agent: v.agent, peer: v.peer || '', hostname: v.hostname || '',
      other: v.conflict.agent, otherPeer: v.conflict.peer || '', otherHostname: v.conflict.hostname || '',
      at: v.conflict.at, prevAt: v.conflict.prevAt || 0, flips: v.conflict.flips || 1,
    });
  }
  return { byAgent, vcenterConflicts, windowMs: CONFLICT_WINDOW_MS,
    limits: { agents: AGENTS_MAX, unverified: UNVERIFIED_MAX, owners: OWNERS_MAX }, omitted: { ...omitted } };
}

export function _resetForTest() { agents.clear(); owners.clear(); omitted = { agents: 0, unverifiedEvicted: 0, owners: 0 }; }
