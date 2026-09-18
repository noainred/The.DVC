/**
 * bmusage/edgePull.js — **엣지가 종합한 사용률 봉투**(v2.554).
 *
 * 사용자 지시(2026-09-17): "**엣지에서 종합하고 중앙으로 전달은 중앙에서 조회할때만 한다.**"
 *
 * ── 왜 push 가 아니라 pull 인가(사용자 선택) ────────────────────────────────
 * 베어메탈 사용률은 **대부분 볼 일이 없는 화면**이다. 28곳 × 5분 주기로 push 하면 회선을 상시
 * 점유하는데, 사람이 화면을 여는 순간에만 필요하다. 그래서 v2.549 엣지 로그와 **같은 방식**을
 * 쓴다 — 중앙이 `collector/puller.js:23` 과 **같은 url·같은 토큰**(`X-Collector-Token`)으로
 * `GET /api/collector/bm-usage` 를 당긴다. **새 포트·새 인증이 필요 없다** — 이 사실이 pull 을
 * 고른 근거이므로 새 인증 경로를 도입하려 하지 말 것.
 *
 * ── 정직성 규칙 ──────────────────────────────────────────────────────────────
 * ⚠ **자격증명을 싣지 않는다** — `publicTarget()` 을 통과한 것만(라우트가 아니라 여기서 한 번 더).
 * ⚠ **엣지의 판정을 그대로 전한다** — 중앙이 다시 판정하면 같은 서버를 두 곳에서 다르게 말한다
 *   (v2.548 '중앙이 위임 장비를 다시 판정하게 만들지 말 것' 과 같은 규칙).
 * ⚠ **상한으로 자른 것은 개수를 밝힌다**(`truncated`) — 조용한 상한 금지.
 * ⚠ **꺼져 있어도 응답한다** — `enabled:false` 를 그대로 실어야 중앙이 '안 켰다' 와 '못 읽었다' 를
 *   구분한다(빈 응답을 주면 중앙 화면이 '모른다' 밖에 말할 수 없다. v2.517 `sendStatusOnly` 규약).
 */
import { config, currentVersion } from '../config.js';
import { loadBmUsageSettings, bmUsageEnabled, enterpriseActive } from './settings.js';
import { publicTarget } from './targets.js';
import { currentTargets, bmUsageStatus, authStopsFor } from './poller.js';
import { latestUsage } from './db.js';

/** 서버 수 상한 — 한 법인이 200대라도 봉투가 수백 KB 를 넘지 않게. */
export const DEFAULT_LIMIT = 400;
export const MAX_LIMIT = 2_000;

const t = (v) => String(v ?? '').trim();

/**
 * 이 노드(엣지)의 사용률 종합.
 * @param {{limit?:number}} opt
 * @returns {Promise<object>}
 */
export async function buildBmUsageEnvelope({ limit = DEFAULT_LIMIT } = {}) {
  const cap = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
  const s = loadBmUsageSettings();
  const [tg, latest] = await Promise.all([
    currentTargets(),
    latestUsage().catch(() => []),
  ]);
  const all = (tg.targets || []).map(publicTarget);
  const targets = all.slice(0, cap);
  const keys = new Set(targets.map((x) => t(x.key)));
  // 최신값은 **대상 목록 안의 것만**(법인을 끄거나 등록이 사라진 서버의 옛 값이 새어 나가지 않게).
  const rows = (latest || []).filter((r) => keys.has(t(r.key)));
  return {
    node: {
      agent: config.agent?.name || '',
      version: currentVersion(),
      role: config.agent?.centralUrl ? 'edge' : 'central',
      datacenter: config.collector?.datacenter || '',
    },
    at: Date.now(),
    enabled: bmUsageEnabled(),
    // 설정 전체를 싣지 않는다 — 중앙 화면이 쓰는 값만(법인 목록은 그 법인의 것이라 그대로).
    settings: {
      intervalMs: s.intervalMs, osSsh: !!s.osSsh, idracTelemetry: !!s.idracTelemetry,
      idracFullTelemetry: !!s.idracFullTelemetry, includeUnassigned: !!s.includeUnassigned,
      corps: Object.keys(s.corps || {}),
      enterpriseEnabled: !!s.enterpriseEnabled, enterpriseAck: !!s.enterpriseAck,
      enterpriseMode: s.enterpriseMode, enterpriseActive: enterpriseActive(s),
    },
    targets,
    truncated: all.length > targets.length ? all.length - targets.length : 0,
    rows,
    counts: tg.counts || {},
    skippedCounts: (tg.counts || {}).byReason || {},
    // ⚠ 정지 대상은 **개수와 경로만**(이름은 targets 에 이미 있다 — 중복으로 싣지 않는다).
    authStops: authStopsFor(tg.targets || []).map(({ key, path, attempts, since, reason }) => ({ key, path, attempts, since, reason })),
    status: bmUsageStatus(),
  };
}
