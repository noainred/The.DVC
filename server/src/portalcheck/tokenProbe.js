/**
 * portalcheck/tokenProbe.js — 요구 ②(통신)·③(동일성 증명)의 **네트워크 계층**(v2.560).
 *
 * 중앙이 **저장한 값으로 직접 찔러** 본다. 그래서 여기서만 알 수 있는 것이 있다:
 *   · 요구 ② '중앙 저장 토큰으로 통신이 되는가' — 200/403/404 가 그 답이다.
 *   · 요구 ③ '중앙 저장값 == 엣지 저장값인가' — 엣지의 게이트(`routes/collector.js checkToken`)가
 *     `tokenMatches` 로 **전체 문자열 상수시간 비교**를 하므로 **200 이면 두 값이 같다는 증명**이다.
 *     지문 8자 대조(`가능성이 높다`)와 달리 이것은 확정이다.
 *
 * ── 보안 불변조건(되돌리지 말 것) ────────────────────────────────────────────
 * ① **접속처는 등록부 저장값에서만** 읽는다(`col.url`). 요청 본문의 url 을 받는 API 를 만들지
 *    말 것 — 저장 토큰을 공격자 호스트로 실어 보내는 경로가 된다(v2.480 규약).
 * ② **토큰을 싣는 요청은 `resilientFetch`(retries 0)** 로만 보낸다. 전역 `fetch` 는 DNS 리바인딩
 *    차단 lookup 이 없어 검사 후 이름이 사내 주소로 재해석되면 그 토큰이 내부로 나간다(v2.506).
 *    재시도는 0 이다 — 이 점검은 '닿는가' 를 보는 것이고 재시도가 판정을 흐린다.
 * ③ **`/api/collector/export` 를 표적으로 쓰지 말 것** — 그 법인 인벤토리 전량이라 점검 자체가
 *    부하가 된다. `/ping` 은 경량이고 정체(`agent`·`hostname`)까지 준다(v2.552 규약).
 *    `puller.js pullOne` 은 **조회가 아니라 상태를 쓰는** 함수이므로 점검에서 부르지 않는다.
 * ④ **배포 대상 파일의 토큰으로는 찔러보지 않는다**(사용자 선택 v2.560 '저장소 대조만').
 *    틀린 토큰 시도는 그 엣지의 거부 링버퍼(20건, `routes/collector.js denyRecent`)를 채워
 *    **실제 침입 흔적을 밀어낸다**. 그 축은 `tokenScan.js` 가 저장값끼리 대조한다.
 * ⑤ 정체(`identity`) 판정은 `collector/registry.js identityIssue` **하나**를 쓴다 — 복제하면
 *    포워딩 되돌림 탐지 규칙이 갈라진다.
 */

import { resilientFetch } from '../util/resilientFetch.js';
import { identityIssue } from '../collector/registry.js';
import { PROBE_STATE, probeState, identityEvidence } from './tokenScan.js';

/** 장비가 아니라 포탈이라 가볍지만, 28곳 × 고RTT 를 감당해야 한다. */
export const PROBE_CONCURRENCY = Math.max(1, Number(process.env.PORTALCHECK_CONCURRENCY) || 4);
/** 한 요청 시한. 폴란드·미국 동부는 RTT 800ms 를 넘는다(CLAUDE.md 운영 환경). */
export const PROBE_TIMEOUT_MS = Math.max(2_000, Number(process.env.PORTALCHECK_TIMEOUT_MS) || 8_000);
/**
 * 점검 1회의 **총 예산**. 사람이 버튼을 누르고 기다리는 화면이라 무한히 늘릴 수 없다.
 * ⚠ 예산에 걸려 시도하지 못한 행은 **조용히 빼지 않고** `not-run` + 사유를 남긴다.
 */
export const PROBE_BUDGET_MS = Math.max(10_000, Number(process.env.PORTALCHECK_BUDGET_MS) || 90_000);

const t = (v) => String(v ?? '').trim();
const base = (u) => t(u).replace(/\/+$/, '');

/** 오류 메시지를 종류로 — 시한과 불통은 조치가 다르다(늘린다 / 경로를 본다). */
export function errorKindOf(msg) {
  const s = String(msg || '');
  return /timeout|timed out|abort|AbortError/i.test(s) ? 'timeout' : 'unreachable';
}

/**
 * 한 엣지에 `GET /api/collector/ping` — **중앙이 저장한 수집 토큰으로**.
 * 200 이면 요구 ③(수집 토큰 축)이 증명된다.
 */
export async function probeCollectorPing(row, { fetchImpl = resilientFetch, timeoutMs = PROBE_TIMEOUT_MS, otherIds = [], token = '' } = {}) {
  const t0 = Date.now();
  const hasToken = row?.collector?.set === true && t(token) !== '';
  const url = base(row?.url);
  if (!url) {
    return { at: t0, ms: 0, state: PROBE_STATE.NOT_RUN, httpStatus: null, reason: '등록부에 이 엣지의 URL 이 없습니다.', evidence: 'unknown' };
  }
  if (!hasToken) {
    // ⚠ '토큰 없음' 은 **인증 실패가 아니다**. 실패로 세면 화면이 "토큰이 거부됐습니다" 라 말해
    //   사용자가 멀쩡한 토큰을 의심한다(v2.553 규약).
    return { at: t0, ms: 0, state: PROBE_STATE.SKIP_NO_TOKEN, httpStatus: null, reason: '중앙 등록부에 이 엣지의 수집 토큰이 저장돼 있지 않습니다 — 보내 볼 값이 없습니다.', evidence: 'unknown' };
  }

  let res = null; let errorKind = ''; let reason = '';
  try {
    res = await fetchImpl(`${url}/api/collector/ping`, {
      headers: { Accept: 'application/json', 'X-Collector-Token': String(token) },
      timeoutMs, retries: 0,
    });
  } catch (e) {
    errorKind = errorKindOf(e?.message || e);
    reason = String(e?.message || e).slice(0, 300);
  }

  const ms = Date.now() - t0;
  let body = null; let identity = null; let identityMismatch = false;
  let version = ''; let datacenter = ''; let agentSaid = ''; let hostname = '';
  if (res) {
    try { body = await res.json(); } catch { body = null; }
    if (res.status === 200 && body) {
      version = t(body.version); datacenter = t(body.datacenter);
      agentSaid = t(body.agent); hostname = t(body.hostname);
      const iss = identityIssue({ id: row.id || row.agent, name: row.agent }, body, otherIds);
      if (iss) { identity = iss; identityMismatch = true; }
    }
  }

  const state = probeState({
    hasToken: true,
    status: res ? res.status : undefined,
    bodyReason: body && typeof body === 'object' ? t(body.reason || body.error) : '',
    identityMismatch,
    errorKind,
  });
  return {
    at: t0, ms, state,
    httpStatus: res ? res.status : null,
    reason: reason || (body && typeof body === 'object' ? t(body.reason || body.error) : ''),
    identity, version, datacenter, agentSaid, hostname,
    evidence: identityEvidence(state),
  };
}

/**
 * 그 엣지가 **또 다른 중앙이 되어 있는가**(요구 ① 의 구성 축).
 *
 * `config.js:29-31` 이 직접 밝힌다 — "EDGE_TOKEN 은 CENTRAL_TOKEN 과 달리 이 인스턴스의
 * /api/central 엔드포인트를 **열지 않는다**(엣지가 또 다른 중앙이 되는 부작용 없음) — 엣지에서는
 * EDGE_TOKEN 사용을 권장". 즉 엣지에 `CENTRAL_TOKEN` 을 넣어 두면 그 엣지의 `/api/central/*` 가
 * 열려, 그 토큰을 아는 누구든 **그 엣지를 중앙으로 삼아** 자격증명 배포 경로처럼 행세할 수 있다.
 *
 * ⚠⚠ **토큰을 싣지 않는다** — 무인증으로 두드려 상태코드만 본다. 그래서 유출 위험이 0 이고,
 *   403(`인증 필요`)은 '살아 있고 인증을 요구한다' 는 **양성 신호**다(v2.553 규약).
 */
export async function probeCentralRole(row, { fetchImpl = resilientFetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const url = base(row?.url);
  if (!url) return { probed: false, kind: 'unknown', reason: '등록부에 URL 이 없습니다.' };
  let res = null;
  try {
    res = await fetchImpl(`${url}/api/central/health-probe`, { headers: { Accept: 'application/json' }, timeoutMs, retries: 0 });
  } catch (e) {
    return { probed: true, kind: 'unknown', reason: `무인증 확인이 닿지 못했습니다(${String(e?.message || e).slice(0, 120)}).` };
  }
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (res.status === 403 || res.status === 401) {
    return {
      probed: true, kind: 'central-enabled', httpStatus: res.status,
      reason: '이 엣지의 /api/central 이 열려 있습니다 — CENTRAL_TOKEN 이 설정돼 그 엣지가 또 다른 중앙으로 동작합니다.',
    };
  }
  if (res.status === 404) {
    // 이 코드의 엣지는 `{ok:false,reason:'central 비활성화'}` 를 준다. 구버전·다른 서버는 HTML 404.
    return { probed: true, kind: 'not-central', httpStatus: 404, reason: body?.reason ? String(body.reason).slice(0, 120) : '' };
  }
  if (res.status === 200) {
    // 무인증으로 200 이 나오면 그 주소는 **중앙이고 게이트가 없다**(또는 중앙 자신에 닿았다).
    return { probed: true, kind: 'central-open', httpStatus: 200, reason: '무인증 요청에 200 을 돌려줍니다 — 이 주소는 중앙이며 토큰 게이트가 없습니다(자기 자신에 닿았을 수도 있습니다).' };
  }
  return { probed: true, kind: 'unknown', httpStatus: res.status, reason: `HTTP ${res.status}` };
}

/** 동시성 제한 실행 — 결과 순서는 입력 순서를 지킨다(표가 흔들리지 않게). */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    for (;;) {
      const k = i++;
      if (k >= items.length) return;
      try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: String(e?.message || e) }; }
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 전 행 프로브.
 *
 * ⚠⚠ **평문 토큰을 행 객체에 붙이지 않는다.** 행은 응답에 그대로 실리므로 거기에 평문을 두면
 *   한 번의 부주의로 전 엣지 토큰이 화면·로그·브라우저 히스토리로 나간다. 그래서 평문은
 *   `tokenOf(row)` **콜백으로만** 조회하고(라우트가 등록부에서 읽어 넘긴다) 이 모듈은
 *   어떤 반환값에도 담지 않는다(`util/tokenFingerprint.js` 규칙 2).
 *
 * @param {Array} rows scanTokens().rows
 * @param {(row:object)=>string} opts.tokenOf 그 행의 수집 토큰 평문(없으면 빈 문자열)
 * @returns {{ probes: Array, budgetExceeded: number, ms: number }}
 */
export async function probeAll(rows = [], {
  tokenOf = () => '',
  fetchImpl = resilientFetch,
  concurrency = PROBE_CONCURRENCY,
  timeoutMs = PROBE_TIMEOUT_MS,
  budgetMs = PROBE_BUDGET_MS,
  withCentralRole = true,
  now = Date.now(),
} = {}) {
  const deadline = now + budgetMs;
  const otherIds = rows.map((r) => r.id || r.agent).filter(Boolean);
  let budgetExceeded = 0;
  const t0 = Date.now();

  const probes = await pool(rows, concurrency, async (row) => {
    // ⚠ 남은 예산이 한 요청 시한보다 적으면 **시작하지 않는다** — 시작해 놓고 잘리면 결과가
    //   버려지고 화면에는 '시한 초과' 만 남는다(v2.550.3 osSsh 규약).
    if (Date.now() + timeoutMs > deadline) {
      budgetExceeded += 1;
      return {
        agent: row.agent,
        probe: { at: Date.now(), ms: 0, state: PROBE_STATE.NOT_RUN, httpStatus: null, evidence: 'unknown',
          reason: '점검 시간 예산을 넘겨 이번에는 시도하지 않았습니다 — 다시 누르면 이어서 점검합니다.' },
        centralRole: null,
      };
    }
    const probe = await probeCollectorPing(row, { fetchImpl, timeoutMs, otherIds, token: tokenOf(row) || '' });
    let centralRole = null;
    if (withCentralRole && base(row.url) && Date.now() + timeoutMs <= deadline) {
      centralRole = await probeCentralRole(row, { fetchImpl, timeoutMs });
    } else if (withCentralRole && base(row.url)) {
      centralRole = { probed: false, kind: 'unknown', reason: '점검 시간 예산을 넘겨 무인증 확인은 하지 않았습니다.' };
    }
    return { agent: row.agent, probe, centralRole };
  });

  return { probes, budgetExceeded, ms: Date.now() - t0 };
}

/* ── 최근 프로브 보관(인메모리) ─────────────────────────────────────────────── */

/**
 * 화면을 다시 열었을 때 '마지막으로 무엇을 봤는지' 를 보여주기 위한 보관소.
 *
 * ⚠ **인메모리다** — 진실의 원천은 지금 네트워크이고 이것은 '방금 본 값' 이다. 디스크에 쓰면
 *   재기동 뒤 낡은 결과를 '지금 상태' 인 척 보여준다(v2.548 `central/partFaultEdge.js` 와 같은 판단).
 * ⚠ **평문 토큰을 담지 않는다** — `probeAll` 의 반환에도 없다(위 `probeAll` 머리말).
 */
const _probes = new Map(); // agent(소문자) → { agent, probe, centralRole }

export function putProbeResults(results = []) {
  for (const r of results) {
    const k = t(r?.agent).toLowerCase();
    if (!k) continue;
    _probes.set(k, { agent: t(r.agent), probe: r.probe || null, centralRole: r.centralRole || null });
  }
  return _probes.size;
}
export function listProbeResults() { return [..._probes.values()]; }
export function _resetProbeStore() { _probes.clear(); }
