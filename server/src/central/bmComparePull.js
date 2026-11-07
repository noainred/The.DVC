/**
 * central/bmComparePull.js — 리눅스 성능 6단계 **서버 비교의 엣지 대행**: 엣지 위임 서버 1대의 비교 계열(지표 여러 개 · 창 통계 · 스파크 · 베이스라인 이탈)을
 *   그 엣지에서 **요청 1개로** 당긴다(`GET /api/collector/bm-usage/compare-series` — 지표마다 WAN 왕복하지 않는다 · 루트 CLAUDE.md ‘작업 하나를 법인 쪽에’).
 *
 * 규약(5단계 bmPerfOpsPull 과 같다 — edge.md v2.929):
 *   · 같은 url · 같은 토큰(pullFromEdge — 수집 서버 등록부 · tokenFirst) — 새 포트 · 새 인증 없음 · GET 재시도 1 · 보관 없음(중앙은 받기만).
 *   · 엣지 응답은 **아는 지표만 · 수는 numOrNull · 상한(지표 24 · 스파크 120점) · 시각은 수신 시각으로 자른다**(clampEdgeTs).
 *   · 구버전 엣지(경로 없음 → 401/404)는 old-version — 최소 버전 문구는 릴리스 노트의 6단계 첫 게시 번호(featureMinEdgeVersion — 숫자를 박지 않는다).
 */
import { pullFromEdge } from './edgePull.js';
import { strOf } from '../util/coercionTrap.js';
import { numOrNull } from '../util/numOrNull.js';
import { capStr } from '../util/capStr.js';
import { clampEdgeTs } from '../util/clampEdgeTs.js';
import { stage6MinEdgeVersion } from './featureMinEdgeVersion.js';
import { reqTimeoutMs } from '../agent/envTimeout.js';
import { SERIES_COLS } from '../bmusage/multiCompare.js';
import { BASELINE_METRICS } from '../bmusage/perfRules.js';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
// 시한 env 는 [5초, 10분] 정규화(TIM2605-04 — agent/envTimeout.js). 같은 env 를 bmUsageEdgePull · bmPerfOpsPull 도 읽는다.
const TIMEOUT_MS = reqTimeoutMs(process.env.BMUSAGE_PULL_TIMEOUT_MS, 20_000, { min: 5_000 });
const SERIES = new Set(SERIES_COLS);
const DEV_REASONS = new Set(['no-history', 'few-weeks', 'missing']);

function cleanStats(s, now) {
  if (!isObj(s)) return null;
  if (s.error) return { error: strOf(s.error, 160) };
  const last = isObj(s.last) ? { t: clampEdgeTs(numOrNull(s.last.t), now), avg: numOrNull(s.last.avg), peak: numOrNull(s.last.peak) } : null;
  return {
    avg: numOrNull(s.avg), peak: numOrNull(s.peak), peakAt: clampEdgeTs(numOrNull(s.peakAt), now), last,
    n: numOrNull(s.n), expected: numOrNull(s.expected), missing: numOrNull(s.missing),
    spark: (Array.isArray(s.spark) ? s.spark : []).slice(0, 120).filter((p) => Array.isArray(p)).map((p) => [clampEdgeTs(numOrNull(p[0]), now), numOrNull(p[1]), numOrNull(p[2])]).filter((p) => p[0] != null),
    ...(numOrNull(s.truncated) != null ? { truncated: numOrNull(s.truncated) } : {}), ...(numOrNull(s.missingPeriods) != null ? { missingPeriods: numOrNull(s.missingPeriods) } : {}),
  };
}
/** 엣지 비교 계열 응답 정제(순수 — 테스트가 고정). */
export function sanitizeCompareSeries(b, now = Date.now()) {
  if (!isObj(b)) return null;
  const metrics = {};
  const m = isObj(b.metrics) ? b.metrics : {};
  for (const k of Object.keys(m).slice(0, 48)) { if (!SERIES.has(k)) continue; const c = cleanStats(m[k], now); if (c) metrics[k] = c; }
  let dev = null;
  if (isObj(b.dev)) {
    dev = {};
    for (const k of BASELINE_METRICS) {
      const d = b.dev[k];
      if (!isObj(d)) continue;
      dev[k] = d.reason ? { reason: DEV_REASONS.has(d.reason) ? d.reason : 'no-history', weeks: numOrNull(d.weeks) }
        : { value: numOrNull(d.value), ratio: numOrNull(d.ratio), out: ['above', 'below', 'in'].includes(d.out) ? d.out : 'in', mean: numOrNull(d.mean), lo: numOrNull(d.lo), hi: numOrNull(d.hi) };
    }
  }
  return {
    ok: b.ok === true, key: strOf(b.key, 256), from: clampEdgeTs(numOrNull(b.from), now), to: clampEdgeTs(numOrNull(b.to), now),
    res: ['5m', '1h', '1d'].includes(b.res) ? b.res : null, stepMs: numOrNull(b.stepMs), metrics, ...(dev ? { dev } : {}),
    ...(b.reason ? { reason: strOf(b.reason, 200) } : {}),
  };
}
/** 한 서버(엣지 위임)의 비교 계열 — 보관 없음. */
export async function pullEdgeCompareSeries(agent, { key, metrics = [], from, to } = {}) {
  const ms = []; for (const c of metrics) { if (SERIES.has(c) && ms.length < 24) ms.push(c); }   // 지표 이름 화이트리스트 · 상한 24
  const qs = new URLSearchParams({ key: capStr(String(key), 256), metrics: ms.join(','), from: String(Math.floor(Number(from) || 0)), to: String(Math.floor(Number(to) || 0)) });
  const r = await pullFromEdge(agent, `/api/collector/bm-usage/compare-series?${qs.toString()}`, {
    timeoutMs: TIMEOUT_MS, retries: 1, minVersion: stage6MinEdgeVersion(), what: '비교 계열을 읽을', label: '엣지 비교 계열 응답',
    missing401: true,   // 경로가 없는 구버전 엣지는 사용자 인증 미들웨어로 떨어져 401 — 토큰이 아니라 버전 문제다(5단계와 같은 판정)
  });
  if (!r.ok) return { ok: false, kind: r.kind, reason: r.reason, ms: r.ms };
  const body = sanitizeCompareSeries(r.body);
  return body && body.ok ? { ok: true, body, ms: r.ms } : { ok: false, kind: 'bad-body', reason: body?.reason || '엣지 응답 형식이 다릅니다.' };
}
