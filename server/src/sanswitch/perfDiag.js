/**
 * sanswitch/perfDiag.js — '사용량 데이터가 없습니다' 의 **원인 판정**(v2.517, 사용자 신고
 * "데이터 수집이 안되, edge 의 사용량도 분석하게 해줘").
 *
 * ── 왜 필요한가 ───────────────────────────────────────────────────────────────
 * v2.516 까지 포트 사용량 패널의 빈 상태는 **무조건** "설정 › 수집 서버 › SAN 스위치 포트 사용량
 * 에서 수집을 켜면 쌓기 시작합니다" 라고 말했다(`web/.../SanSwitchTool.jsx`). 그런데 그 한 문구가
 * **행동이 정반대인 상황들**을 덮고 있었다:
 *   · 수집 꺼짐               → 켜면 된다
 *   · 켜짐 · 첫 주기 전        → **기다리면** 채워진다
 *   · REST 수집 장비          → portperfshow 를 쓰지 않는다. **켜도·기다려도 영원히 안 쌓인다**
 *   · portperfshow 없음/제한   → **기다려도 안 된다**(계정·펌웨어 문제)
 *   · 엣지 위임 · 엣지가 미보고 → 엣지 버전/설정 pull 문제. 중앙에서 켜도 안 된다
 *   · 표본은 있는데 조회 기간 밖 → 기간을 넓히면 보인다
 * CLAUDE.md v2.493 '값이 없는 이유를 단정하지 말 것' 이 정확히 이 유형이다.
 *
 * ── 역할 분리 ─────────────────────────────────────────────────────────────────
 * 이 모듈은 **판정만** 한다(`kind` + 판정 근거 `facts`). 사람이 읽는 문구는 웹의 순수 모듈
 * `web/src/views/tools/sanPerfDiagText.js` 가 `kind` 로 만든다 — 판정 한 곳, 문구 한 곳
 * (`components/accessDeniedText.js`·`version_4/loadState.js` 와 같은 관례).
 *
 * ⚠ `waiting` 은 '기다리면 채워지는가' 다. pending 과 unreachable 을 합치지 말라는 v2.509 규칙과
 *   같은 이유로, 이 값을 대충 true 로 두면 화면이 "기다리세요" 라고 말해 놓고 영원히 안 채워진다.
 */

/** 판정 종류 — 웹 문구 모듈과 이 목록을 함께 유지할 것(테스트가 두 쪽을 고정한다). */
export const PERF_DIAG_KINDS = [
  'db-unavailable',     // 이 서버가 node:sqlite 를 쓸 수 없다 → 이력 자체가 저장되지 않는다
  'out-of-range',       // 표본은 있는데 조회 기간 밖 → 기간을 넓히면 보인다
  'stale',              // 표본이 있지만 **한참 오래됐다** — 수집이 멈춘 것이다(기간을 넓혀도 새 값은 없다)
  'rest-method',        // REST 수집 장비 → portperfshow 미사용(설계상 영구 없음)
  'edge-no-report',     // 엣지 위임인데 엣지가 상태를 한 번도 보고하지 않았다
  'edge-disabled',      // 엣지가 '수집 꺼짐' 으로 보고했다
  'edge-device-failed', // 엣지가 이 장비에서 실패했다고 보고했다
  'edge-first-cycle',   // 엣지가 켜졌고 아직 첫 수집 전 → 기다리면 된다
  'edge-push-failed',   // 엣지가 수집은 했는데 **중앙으로 올리지 못한다**(엣지가 사유를 보고했다)
  'edge-pending-push',  // 엣지는 수집했는데 중앙에 아직 반영 전 → 기다리면 된다
  'disabled',           // 중앙 직접 장비인데 수집이 꺼져 있다
  'device-failed',      // 중앙이 이 장비 수집에 실패했다
  'first-cycle',        // 켜졌고 아직 첫 폴 전 → 기다리면 된다
  'collected-empty',    // 폴은 돌았는데 이 장비 표본이 없다(원인 단정 금지)
];

/**
 * '멈춘 것' 으로 볼 나이. 수집 주기의 배수이되 **최소 1시간**이다(기본 5분 주기면 12주기 연속
 * 결손 — 일시적 실패가 아니라 정지다). 주기를 모르면 최소값만 쓴다.
 * ⚠ 숫자를 화면 문구에 박지 말 것 — 판정과 근거(`sampleAgeMs`·`staleLimitMs`)만 서버가 주고
 *   문장은 웹이 만든다(v2.517 규약).
 */
export const STALE_FACTOR = 6;
export const STALE_MIN_MS = 3600_000;
export const staleLimitMs = (intervalMs) => {
  const n = Number(intervalMs);
  return Number.isFinite(n) && n > 0 ? Math.max(STALE_MIN_MS, n * STALE_FACTOR) : STALE_MIN_MS;
};

// ⚠ `Number(null)` 은 0 이고 0 은 유한수다 — null 을 그대로 통과시키면 '표본 시각 0'(1970년)이
// 되어 기간 판정이 뒤집힌다(초판에서 실제로 `lastSampleAt: 0` 이 나왔다). null/''/undefined 는 null.
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 원인 판정.
 *
 * @param {object}  p
 * @param {object}  p.device        { id, name, agent, collectMethod }
 * @param {object}  p.settings      중앙의 perf 설정 { enabled, intervalMs }
 * @param {boolean} p.dbUnavailable perfDb 를 열 수 없었다
 * @param {number}  p.lastSampleAt  이 장비의 **중앙 DB** 최신 표본 시각(없으면 null)
 * @param {number}  p.since         조회 구간 시작(ms). 없으면 기간 판정을 건너뛴다
 * @param {object}  p.poller        중앙 perf 폴러 상태 { at }
 * @param {object}  p.lastEvent     이 장비의 최근 수집 이벤트 { ok, at, error, source } (작업 로그)
 * @param {object}  p.edge          엣지가 보고한 상태 { enabled, at, pushAt, device:{ok,at,error} }
 * @returns {{kind:string, waiting:boolean, facts:object}}
 */
export function perfEmptyDiag({
  device = null, settings = null, dbUnavailable = false,
  lastSampleAt = null, since = null, poller = null, lastEvent = null, edge = null,
  now = Date.now(),
} = {}) {
  const agent = String(device?.agent || '').trim();
  const facts = {
    agent: agent || null,
    collectMethod: String(device?.collectMethod || 'ssh'),
    enabled: settings?.enabled === true,
    intervalMs: num(settings?.intervalMs),
    lastSampleAt: num(lastSampleAt),
    since: num(since),
    pollerAt: num(poller?.at),
    error: null,
    errorAt: null,
    errorSource: null,
    edgeAt: num(edge?.at),
    edgePushAt: num(edge?.pushAt),
    edgeEnabled: edge ? edge.enabled === true : null,
    edgePushError: edge?.pushError ? String(edge.pushError).slice(0, 300) : null,
    now: num(now),
    sampleAgeMs: null,
    staleLimitMs: null,
  };
  const out = (kind, waiting) => ({ kind, waiting, facts });

  // ① DB 를 못 열면 다른 판정이 전부 무의미하다(무엇을 켜도 저장되지 않는다).
  if (dbUnavailable) return out('db-unavailable', false);

  // ② 표본이 **있는데** 화면이 비었다면 원인은 조회 기간이다 — '수집 안 됨' 이라 말하면 거짓이다.
  //    since 를 모르면(범위 미지정) 판정하지 않는다(있는 표본을 '기간 밖' 이라 단정하지 않기 위해).
  if (facts.lastSampleAt != null && facts.since != null && facts.lastSampleAt < facts.since) {
    /*
     * ⚠⚠ **'기간을 넓히세요' 만 말하면 거짓이 될 수 있다**(v2.566, 사용자 신고 "엣지 장비는
     * 차트가 안 보인다"). 그 현장은 마지막 표본이 **10일 전**이었는데 화면이
     * "이 기간에는 표본이 없습니다 — **수집은 되고 있습니다**" 라고 말했다. 실제로는 엣지 중계가
     * v2.427 의 TDZ 결함으로 죽어 있었고, 기간을 넓혀 봐야 **10일 전 값**만 보인다.
     * 그래서 마지막 표본의 나이가 정지 수준이면 별도 판정으로 가른다 — 둘은 **조치가 다르다**
     * (기간을 넓힌다 / 수집 경로를 고친다).
     * ⚠ 수집이 꺼져 있으면 오래된 것이 **정상**이다 — 그때는 아래 '꺼짐' 판정이 말하게 둔다.
     */
    facts.staleLimitMs = staleLimitMs(facts.intervalMs);
    if (facts.now != null) facts.sampleAgeMs = facts.now - facts.lastSampleAt;
    const running = agent ? edge?.enabled === true : facts.enabled;
    if (running && facts.sampleAgeMs != null && facts.sampleAgeMs > facts.staleLimitMs) {
      return out('stale', false);
    }
    return out('out-of-range', false);
  }

  // ③ REST 수집 장비는 portperfshow 를 **시도조차 하지 않는다**(perfPoller.collectOne 이 건너뛴다).
  //    '설정을 켜세요' 라고 말하면 사용자가 켜고 기다리지만 영원히 채워지지 않는다.
  if (facts.collectMethod === 'rest') return out('rest-method', false);

  // ④ 엣지 위임 장비 — 중앙의 폴러 상태는 이 장비와 무관하다(중앙은 엣지 몫을 수집하지 않는다).
  if (agent) {
    if (!edge) return out('edge-no-report', false);
    if (edge.enabled !== true) return out('edge-disabled', false);
    const dv = edge.device || null;
    if (dv && dv.ok === false) {
      facts.error = dv.error ? String(dv.error) : null;
      facts.errorAt = num(dv.at);
      facts.errorSource = agent;
      return out('edge-device-failed', false);
    }
    if (facts.edgeAt == null) return out('edge-first-cycle', true);
    /*
     * ⚠⚠ **'기다리면 온다' 와 '못 올리고 있다' 는 다르다**(v2.566). v2.427~v2.565 에서 엣지의
     * `pushPerfNow()` 가 TDZ 로 매번 죽었는데, 그 사실이 중앙에 전달될 길이 없어 화면은 계속
     * '곧 도착한다' 는 쪽으로만 말했다. 이제 엣지가 마지막 push 오류를 함께 보고하므로
     * 그것이 있으면 **기다리는 문제가 아니라고** 말한다(`waiting:false`).
     */
    if (facts.edgePushError) {
      facts.error = facts.edgePushError;
      facts.errorAt = num(edge?.pushAt);
      facts.errorSource = agent;
      return out('edge-push-failed', false);
    }
    return out('edge-pending-push', true);   // 엣지는 돌았다 → push 주기 안에 도착한다
  }

  // ⑤ 중앙 직접 장비.
  if (!facts.enabled) return out('disabled', false);
  if (lastEvent && lastEvent.ok === false) {
    facts.error = lastEvent.error ? String(lastEvent.error) : null;
    facts.errorAt = num(lastEvent.at);
    facts.errorSource = String(lastEvent.source || 'central');
    return out('device-failed', false);
  }
  if (facts.pollerAt == null) return out('first-cycle', true);
  // 폴은 돌았고 실패 기록도 없는데 표본이 없다 — 원인을 모른다. 지어내지 않는다.
  return out('collected-empty', false);
}
