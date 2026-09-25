/**
 * central/edgeLogPull.js — 중앙이 엣지에서 로그·진행상태를 **당긴다**(v2.549).
 *
 * 사용자 선택: "중앙이 당긴다(pull) + 폴백". 이 파일이 pull 쪽이다.
 *  · 대상은 **수집 서버 등록부**(`collector/registry.js`)다 — `puller.js:23` 이 이미 같은 `url`·`token`
 *    으로 `/api/collector/export` 를 60초마다 당기고 있으므로 **새 네트워크 허용이 필요 없다**.
 *  · 상시 폴링하지 않는다 — 사람이 화면에서 누를 때만 간다(로그는 대부분 볼 일이 없다).
 *
 * ── 실패를 '모름' 으로 뭉개지 않는다 ─────────────────────────────────────────
 * `kind` 로 원인을 나눈다. 조치가 전부 다르기 때문이다:
 *   `auth`(403/401 — 토큰 불일치) / `disabled`(404 — 그 엣지에 COLLECTOR_TOKEN 미설정) /
 *   `old-version`(엔드포인트 없음 = 구버전 엣지 → 업그레이드) / `unreachable`(연결 실패·시한) /
 *   `http`(그 밖 상태코드) / `bad-body`(응답이 형식과 다름)
 * ⚠ 404 는 **두 뜻**이다(엣지의 collector 가 꺼짐 / 구버전이라 이 경로가 없음) — 본문으로 가른다.
 *
 * v2.613(CONTRACT2613-01 · EDGE2613-02): 사다리(등록부 → fetch → 상태코드 → 본문)는 `central/edgePull.js pullFromEdge`
 *   **하나**다 — bm-usage·token-check 와 세 벌이던 것을 합쳤다. 이 파일은 쿼리 조립과 **저장(putEdgeLog)** 만 갖는다.
 */
import { pullFromEdge, findCollector } from './edgePull.js';
import { putEdgeLog } from './edgeLogStore.js';

/** 엣지 로그를 내주기 시작한 최소 버전 — 그 아래는 엔드포인트가 없다. */
export const MIN_EDGE_VERSION = '2.549.0';
const TIMEOUT_MS = Math.max(5_000, Number(process.env.EDGELOG_PULL_TIMEOUT_MS) || 20_000);

/** 등록부 조회 — 호출부 호환용 재수출(본체는 edgePull.js → collector/registry.js findCollectorByName). */
export { findCollector };

/**
 * 한 엣지에서 당긴다. **저장까지** 하고 결과를 돌려준다.
 * @returns {{ok:boolean, kind?:string, reason?:string, ms:number, snap?:object}}
 */
export async function pullEdgeLog(agent, { since = 0, level = '', limit = 0, withStatus = true } = {}) {
  const qs = new URLSearchParams();
  if (Number(since) > 0) qs.set('since', String(Number(since)));
  if (level && level !== 'all') qs.set('level', String(level));
  if (Number(limit) > 0) qs.set('limit', String(Number(limit)));
  if (!withStatus) qs.set('status', '0');

  const r = await pullFromEdge(agent, `/api/collector/edge-log${qs.toString() ? `?${qs}` : ''}`, {
    timeoutMs: TIMEOUT_MS, retries: 1, minVersion: MIN_EDGE_VERSION, what: '로그를 읽을', label: '엣지 로그 응답',
    authReason: '수집 서버 토큰 불일치 — 중앙 등록값과 그 엣지의 COLLECTOR_TOKEN 을 대조하세요.',
  });
  if (!r.ok) {
    // 등록부 단계 실패(fetched=false)는 보관소에 남기지 않는다 — 그 엣지의 '마지막 시도' 가 아니다.
    if (r.fetched) putEdgeLog(r.col.name || agent, { via: 'pull', ok: false, error: (r.kind === 'timeout' || r.kind === 'unreachable' || r.kind === 'disabled' || r.kind === 'old-version') ? `${r.kind}: ${r.reason}` : r.reason, ms: r.ms });
    return { ok: false, kind: r.kind, reason: r.reason, ms: r.ms };
  }
  // ⚠ 저장 키는 **중앙이 아는 이름**(등록부 name)이다 — 엣지 본문의 `node.agent` 를 믿지 않는다.
  //   둘이 다르면 그 사실 자체가 진단이므로 화면이 나란히 보여 준다(v2.424 `identityIssue` 와 같은 목적).
  const snap = putEdgeLog(r.col.name || agent, { ...r.body, via: 'pull', ok: true, ms: r.ms });
  return { ok: true, ms: r.ms, snap };
}
