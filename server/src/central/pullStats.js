/**
 * central/pullStats.js — 엣지가 중앙에서 **가져가는**(GET) 요청의 기록(v2.587, 데이터 흐름 지도).
 *
 * ⚠ 왜 필요한가: `ingestStats.js` 는 POST(엣지 → 중앙 push)만 센다(`routes/central.js` 집계
 *   미들웨어가 `req.method === 'POST'` 일 때만 기록). 그래서 설정 pull 9종(`*-config`)과 작업 인출
 *   (`*-jobs`·`assignment`·`log-queries`)은 **언제·누가 가져갔는지 중앙 어디에도 남지 않았다** —
 *   '설정을 바꿨는데 엣지가 안 가져간다' 를 중앙에서 볼 수 없었다.
 *
 * 규칙:
 *  · 경로 키는 **매칭된 라우트의 선언 경로**(`req.route.path`)다 — 요청 문자열을 쓰면 없는 경로로
 *    키를 무한히 만들 수 있다(v2.583 ingestReject 상한 사고와 같은 유형). 매칭되지 않은 요청은 세지 않는다.
 *  · 이름은 **인증된 값이 먼저**다(`req.centralAuth.agent`, 개별 토큰). 공유 토큰이면 요청이 주장한
 *    이름이고 `verified:false` 로 남긴다 — 화면이 그 사실을 말한다(v2.570 규약).
 *  · 실패(4xx/5xx)도 기록한다 — 성공만 세면 '안 가져갔다' 와 '가져가려다 막혔다' 가 구분되지 않는다.
 *  · 인메모리(재시작 시 초기화). 진실의 원천이 아니라 계측기다 — 화면이 기록 시작 시각을 밝힌다.
 */

const MAX_AGENTS = 500;
/** 인증에 실패한 GET 은 주장한 이름 대신 이 한 칸에 센다(v2.589 — 이름 위조·LRU 밀어내기 차단). */
export const PULL_UNAUTH_KEY = '(인증 실패)';
const MAX_ENDPOINTS = 64;
const t = (v) => String(v ?? '').trim();
const ewma = (prev, sample, a = 0.3) => (prev == null ? sample : prev * (1 - a) + sample * a);

const byAgent = new Map();
const startedAt = Date.now();

/**
 * @param agent    에이전트 이름
 * @param endpoint 라우트 선언 경로(예: /storage-config)
 * @param opts     { status, bytes, verified }
 */
export function recordPull(agent, endpoint, { status = 0, bytes = 0, verified = false, now = Date.now() } = {}) {
  const key = (t(agent) || '(unknown)').slice(0, 64);
  const ep = t(endpoint).slice(0, 128);
  if (!ep) return;
  let a = byAgent.get(key);
  if (!a) {
    if (byAgent.size >= MAX_AGENTS) {
      // 검증된 행은 밀어내지 않는다 — 공유 토큰 보유자가 이름을 바꿔 가며 불려도 개별 토큰 엣지의 기록은 남는다.
      let oldest = null;
      for (const [k, v] of byAgent) if (!v.verified && (!oldest || v.lastAt < oldest[1].lastAt)) oldest = [k, v];
      if (!oldest) return;
      if (oldest) byAgent.delete(oldest[0]);
    }
    a = { agent: key, verified: false, firstAt: now, lastAt: now, byEndpoint: new Map() };
    byAgent.set(key, a);
  }
  if (verified) a.verified = true;
  a.lastAt = now;
  let e = a.byEndpoint.get(ep);
  if (!e) {
    if (a.byEndpoint.size >= MAX_ENDPOINTS) return;
    e = { endpoint: ep, count: 0, okCount: 0, failCount: 0, firstAt: now, lastAt: 0, lastOkAt: 0, lastFailAt: 0, lastStatus: 0, lastBytes: 0, intervalMsEwma: null };
    a.byEndpoint.set(ep, e);
  }
  if (e.lastAt && now > e.lastAt) e.intervalMsEwma = ewma(e.intervalMsEwma, now - e.lastAt);
  e.count++; e.lastAt = now; e.lastStatus = Number(status) || 0; e.lastBytes = Number(bytes) || 0;
  if (e.lastStatus && e.lastStatus < 400) { e.okCount++; e.lastOkAt = now; } else { e.failCount++; e.lastFailAt = now; }
}

export function pullStats() {
  const rows = [...byAgent.values()].map((a) => ({
    agent: a.agent, verified: a.verified, firstAt: a.firstAt, lastAt: a.lastAt,
    byEndpoint: [...a.byEndpoint.values()].map((e) => ({ ...e, intervalMs: e.intervalMsEwma == null ? null : Math.round(e.intervalMsEwma) })),
  })).sort((x, z) => z.lastAt - x.lastAt);
  return { rows, since: startedAt };
}

export function resetPullStats() { byAgent.clear(); }
