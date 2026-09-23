/**
 * 중앙이 **거부한** 엣지 push 의 기록(v2.570).
 *
 * ⚠⚠ 왜 필요한가 — 실제 결함: `routes/central.js` 의 수신 집계 미들웨어는
 *   `if (res.statusCode >= 400) return;` 으로 **거부된 요청을 통째로 빼고** 있었다. 그래서
 *   '에이전트 수신 트래픽 진단' 표의 `최근 페이로드 —` 가 두 가지를 **구분하지 못했다**:
 *     ① 그 엣지가 인벤토리를 **안 보냈다**(엣지 쪽 문제 — 수집 실패·등록 0개·mock)
 *     ② 보냈는데 **중앙이 막았다**(mock 차단 400 · vCenter 소유권 403 · 토큰 불일치 403)
 *   **조치가 정반대인데 화면이 똑같이 보였다.** 이 모듈이 ②를 기록해 화면이 말하게 한다.
 *
 * ⚠ 이 기록의 `agent` 는 **검증되지 않은 값**이다 — 거부된 요청이므로 토큰 바인딩을 통과하지
 *   못했을 수 있고, 그때 이름은 공격자가 고른 `body.agent`/`X-Agent-Name` 이다. 그래서
 *   ① 이름 수를 상한으로 막고(위조 이름 폭주 방지) ② 응답에 `unverified` 를 실어 화면이
 *   "이 이름은 요청이 주장한 값" 이라고 말하게 한다. **이름을 신뢰해 조치하지 말 것.**
 *
 * 인메모리다(재시작 시 초기화) — `central/ingestStats.js` 와 같은 성격의 계측기이고, 진실의
 * 원천은 각 엣지의 로그다. 거부가 지속되면 다시 쌓이므로 유실이 위험하지 않다.
 */

/** 거부 종류 — **조치가 다른 것만** 나눈다(한 문구로 덮으면 이 모듈의 존재 이유가 사라진다). */
export const REJECT_KIND = Object.freeze({
  AUTH: 'auth',          // 403 토큰 불일치 / 개별 토큰 아님 / 남의 이름
  MOCK: 'mock',          // 400 mock(가짜) 데이터라 저장하지 않음
  OWNER: 'owner',        // 403 그 vCenter 는 다른 엣지 소유
  BAD: 'bad-request',    // 400 그 밖(형식·필수값)
  DISABLED: 'disabled',  // 404 중앙 수신 비활성
  SERVER: 'server',      // 5xx 중앙 오류
  OTHER: 'other',
});

const MAX_AGENTS = Number(process.env.INGEST_REJECT_MAX_AGENTS) || 500;
const MAX_ENDPOINTS = 32; // v2.583: 에이전트당 경로 종류 상한(인증 전 기록 — 위조 경로 폭주 방지)
const KEEP = Math.max(10, Number(process.env.INGEST_REJECT_KEEP) || 50); // 최근 원문 보관 수
const REASON_MAX = 300; // SSH 추적·스택이 통째로 들어오는 것을 막는다(activityLog 와 같은 상한)

const byAgent = new Map(); // agent -> { agent, total, firstAt, lastAt, byKind: Map, byEndpoint: Map, lastReason, lastVcenterId }
const recent = [];         // 최신이 앞 — [{ at, agent, endpoint, status, kind, reason, vcenterId, wireBytes }]

const t = (v) => String(v ?? '').trim();
const cut = (v) => t(v).slice(0, REASON_MAX);

/** HTTP 상태 + 핸들러가 남긴 힌트로 종류를 정한다. 힌트가 있으면 그것이 우선이다. */
export function rejectKindOf(status, hint) {
  const h = t(hint);
  if (h && Object.values(REJECT_KIND).includes(h)) return h;
  const s = Number(status) || 0;
  if (s === 403) return REJECT_KIND.AUTH;
  if (s === 404) return REJECT_KIND.DISABLED;
  if (s >= 500) return REJECT_KIND.SERVER;
  if (s === 400) return REJECT_KIND.BAD;
  return REJECT_KIND.OTHER;
}

/**
 * 거부 1건 기록.
 * @param agent    요청이 주장한 에이전트 이름(**검증되지 않음** — 위 주석 참조)
 * @param endpoint 중앙 경로(예: /inventory)
 */
export function recordReject(agent, endpoint, { status = 0, kind = '', reason = '', vcenterId = '', wireBytes = 0 } = {}) {
  // ⚠⚠ v2.583(감사 확정 — 반증 에이전트 실측 heap +23MB): 이 기록은 **인증 전**에 불린다. 이름·경로 길이에 상한이
  //   없어 무토큰 요청이 900KB 짜리 agent 키 500개·8KB 경로 수천 개를 상주시킬 수 있었다. 이름 64자·경로 128자로
  //   자르고, 에이전트당 경로 종류는 MAX_ENDPOINTS 개까지(넘치면 '(기타)' 로 합친다).
  const key = (t(agent) || '(unknown)').slice(0, 64);
  const now = Date.now();
  const k = rejectKindOf(status, kind);
  const ep0 = t(endpoint).slice(0, 128);
  let a = byAgent.get(key);
  if (!a) {
    if (byAgent.size >= MAX_AGENTS) { // 백스톱: 위조 이름 폭주 대비 — 가장 오래된 항목 정리
      let oldest = null;
      for (const [kk, vv] of byAgent) if (!oldest || vv.lastAt < oldest[1].lastAt) oldest = [kk, vv];
      if (oldest) byAgent.delete(oldest[0]);
    }
    a = { agent: key, total: 0, firstAt: now, lastAt: now, byKind: new Map(), byEndpoint: new Map(), lastReason: '', lastVcenterId: '', lastKind: '' };
    byAgent.set(key, a);
  }
  a.total++; a.lastAt = now; a.lastKind = k;
  a.lastReason = cut(reason);
  if (vcenterId) a.lastVcenterId = t(vcenterId).slice(0, 128);
  a.byKind.set(k, (a.byKind.get(k) || 0) + 1);
  const ep = ep0 && (a.byEndpoint.has(ep0) || a.byEndpoint.size < MAX_ENDPOINTS) ? ep0 : (ep0 ? '(기타)' : '');
  if (ep) a.byEndpoint.set(ep, (a.byEndpoint.get(ep) || 0) + 1);

  recent.unshift({ at: now, agent: key, endpoint: ep, status: Number(status) || 0, kind: k, reason: cut(reason), vcenterId: t(vcenterId).slice(0, 128), wireBytes: Number(wireBytes) || 0 });
  if (recent.length > KEEP) recent.length = KEEP;
}

/** 진단용 전체 스냅샷. ⚠ `unverified: true` 를 떼지 말 것 — 이름은 요청이 주장한 값이다. */
export function rejectStats() {
  const rows = [...byAgent.values()].map((a) => ({
    agent: a.agent,
    total: a.total,
    firstAt: a.firstAt,
    lastAt: a.lastAt,
    lastKind: a.lastKind,
    lastReason: a.lastReason,
    lastVcenterId: a.lastVcenterId,
    byKind: Object.fromEntries(a.byKind),
    byEndpoint: Object.fromEntries(a.byEndpoint),
  })).sort((x, z) => z.lastAt - x.lastAt);
  return { rows, total: rows.reduce((s, r) => s + r.total, 0), recent: recent.slice(0, KEEP), keep: KEEP, unverified: true };
}

/** 한 에이전트의 거부 요약(없으면 null). 이름 비교는 대소문자를 무시한다. */
export function rejectsForAgent(agent) {
  const want = t(agent).toLowerCase();
  if (!want) return null;
  for (const a of byAgent.values()) if (a.agent.toLowerCase() === want) {
    return { agent: a.agent, total: a.total, lastAt: a.lastAt, lastKind: a.lastKind, lastReason: a.lastReason, lastVcenterId: a.lastVcenterId, byKind: Object.fromEntries(a.byKind) };
  }
  return null;
}

/** 한 vCenter 를 대상으로 한 거부 중 가장 최근 것(없으면 null). */
export function rejectForVcenter(vcenterId) {
  const want = t(vcenterId).toLowerCase();
  if (!want) return null;
  for (const r of recent) if (r.vcenterId && r.vcenterId.toLowerCase() === want) return { ...r };
  return null;
}

export function resetRejects() { byAgent.clear(); recent.length = 0; }
