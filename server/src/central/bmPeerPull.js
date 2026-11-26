/**
 * central/bmPeerPull.js — 물리서버 ‘같은 묶음 대비’(v3.48)의 **엣지 대행**: 엣지 위임 서버 여러 대의 구간 평균(CPU · 메모리 · 전력) · 지금 값(흡기 온도)을
 *   그 엣지에서 **요청 1개로** 당긴다(`POST /api/collector/bm-usage/peer-avg` — 서버마다 WAN 을 왕복하지 않는다 · 루트 CLAUDE.md ‘작업 하나를 법인 쪽에’).
 *
 * 규약(bmComparePull 과 같다 — edge.md):
 *   · 같은 url · 같은 토큰(pullFromEdge — 수집 서버 등록부) — 새 포트 · 새 인증 없음 · 보관 없음(중앙은 받기만). POST 지만 읽기 요청이다(엣지 상태를 바꾸지 않는다) — 재시도는 0.
 *   · 엣지 응답은 **청한 키만 · 수는 numOrNull · 지표가 가질 수 없는 값은 null(PEER_RANGE) · 구간 비율은 0 ~ 1 로 · 상한(청한 키 수) · 시각은 수신 시각으로 자른다**(clampEdgeTs). 모르는 필드는 버린다.
 *   · 구버전 엣지(경로 없음 → 401/404)는 old-version — 최소 버전 문구는 릴리스 노트의 첫 게시 번호(featureMinEdgeVersion — 숫자를 박지 않는다).
 */
import { pullFromEdge } from './edgePull.js';
import { numOrNull } from '../util/numOrNull.js';
import { clampEdgeTs } from '../util/clampEdgeTs.js';
import { reqTimeoutMs } from '../agent/envTimeout.js';
import { peerMinEdgeVersion } from './featureMinEdgeVersion.js';
import { cleanPeerKeys } from '../bmusage/peerAvg.js';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const TIMEOUT_MS = reqTimeoutMs(process.env.BMUSAGE_PULL_TIMEOUT_MS, 20_000, { min: 5_000 });
const cov01 = (v) => { const x = numOrNull(v); return x == null ? null : Math.min(1, Math.max(0, x)); };
/** 범위 안의 수만(밖이면 null — 엣지가 보낸 값을 끝으로 잘라 ‘있을 법한 값’ 으로 만들지 않는다. 반증 A3). */
const inRange = (v, lo, hi) => { const x = numOrNull(v); return x != null && x >= lo && x <= hi ? x : null; };
/** 지표별로 가질 수 있는 값 — 사용률 0~100 % · 전력 0~100,000 W(서버 한 대) · 흡기 온도 −60~120 ℃ · 표본 수 0~10,000,000. */
export const PEER_RANGE = Object.freeze({ pct: [0, 100], watts: [0, 100_000], inlet: [-60, 120], count: [0, 10_000_000] });
const stat = (s, [lo, hi]) => (isObj(s) ? { avg: inRange(s.avg, lo, hi), n: inRange(s.n, ...PEER_RANGE.count), expected: inRange(s.expected, ...PEER_RANGE.count), cov: cov01(s.cov) } : null);

/** 엣지 응답 정제(순수 — 테스트가 고정). 청하지 않은 키 · 같은 키의 둘째 줄은 버린다. */
export function sanitizePeerAvg(b, keys, now = Date.now()) {
  if (!isObj(b) || !Array.isArray(b.rows)) return null;
  const want = new Set(cleanPeerKeys(keys)); const seen = new Set(); const rows = [];
  for (const r of b.rows.slice(0, want.size * 2 + 8)) {
    if (!isObj(r) || typeof r.key !== 'string' || !want.has(r.key) || seen.has(r.key)) continue;
    seen.add(r.key);
    rows.push({ key: r.key, cpu: stat(r.cpu, PEER_RANGE.pct), mem: stat(r.mem, PEER_RANGE.pct), power: stat(r.power, PEER_RANGE.watts), inletC: inRange(r.inletC, ...PEER_RANGE.inlet), sensorAt: clampEdgeTs(numOrNull(r.sensorAt), now) });
  }
  return { ok: b.ok === true, rows, unknown: numOrNull(b.unknown) || 0 };
}
export const peerAvgBodyOk = (b) => isObj(b) && b.ok === true && Array.isArray(b.rows);

/** 한 엣지의 서버 여러 대 — 요청 1개. */
export async function pullEdgePeerAvg(agent, { keys = [], from, to } = {}) {
  const ks = cleanPeerKeys(keys);
  if (!ks.length) return { ok: true, body: { ok: true, rows: [], unknown: 0 }, ms: 0 };
  const r = await pullFromEdge(agent, '/api/collector/bm-usage/peer-avg', {
    method: 'POST', jsonBody: { keys: ks, from: Math.floor(Number(from) || 0), to: Math.floor(Number(to) || 0) }, retries: 0,
    timeoutMs: TIMEOUT_MS, minVersion: peerMinEdgeVersion(), what: '같은 묶음 서버의 평균을 읽을', label: '엣지 묶음 평균 응답', bodyOk: peerAvgBodyOk, missing401: true,
  });
  if (!r.ok) return { ok: false, kind: r.kind, reason: r.reason, ms: r.ms };
  const body = sanitizePeerAvg(r.body, ks);
  return body && body.ok ? { ok: true, body, ms: r.ms } : { ok: false, kind: 'bad-body', reason: '엣지 응답 형식이 다릅니다.' };
}
