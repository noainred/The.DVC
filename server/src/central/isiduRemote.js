/**
 * central/isiduRemote.js — 메인이 엣지에 아이실론 du 를 **바로** 시키는 길(v2.736, iDRAC PUSH 스캔과 같은 모양).
 *
 * 사용자 요청(2026-10-14): "명령어를 특정 엣지 서버에서 실행하는 기능 추가 필요, idrac 조사하는 것처럼 원격에서 실행할 수 있게 해줘".
 *
 * 엣지는 원래 설정 pull(`/api/central/isidu-config`, 기본 5분)로 '지금 수집' 요청을 가져간다 — 누르고 최대 5분을 기다려야 했다.
 * 그래서 iDRAC 스캔처럼 메인이 그 엣지의 수집 서버 URL(같은 url·같은 COLLECTOR_TOKEN — 새 네트워크 허용 불필요)로 직접 부른다:
 *  · run  → POST {엣지}/api/collector/isidu-run : 엣지가 **설정을 지금 다시 받고** 큐의 요청을 꺼내 시작한다. 본문에 대상·명령을
 *           싣지 않는다 — 무엇을 돌릴지는 여전히 중앙 pull(claim→ack 큐)이 정한다. 전달이 실패해도 요청은 큐에 남아 다음 pull 이 가져간다.
 *  · test → POST {엣지}/api/collector/isidu-test : 비밀 없는 대상 사본(edgeTargetView)을 보내 그 엣지에서 `ls -d` 만 한다(du 는 돌리지 않는다).
 *
 * 규약: 대상·토큰은 수집 서버 등록부에서만(v2.480) · 판정 사다리는 `central/edgePull.js pullFromEdge` 하나(kind 열거 EDGE_PULL_KINDS) ·
 * **재시도 0**(엣지 동작 요청 재전송 금지 — v2.612 EDGE2612-01) · 401 은 구버전(경로 없음)으로 읽는다(v2.440 실측).
 */
import { pullFromEdge } from './edgePull.js';
import { reqTimeoutMs } from '../util/envTimeout.js';

export const MIN_ISIDU_EDGE_VERSION = '2.736.0';
const NUDGE_TIMEOUT_MS = reqTimeoutMs(process.env.ISIDU_EDGE_NUDGE_TIMEOUT_MS, 30_000, { max: 120_000 });
const TEST_TIMEOUT_MS = 75_000;   // 엣지 시험 세션 시한(60초) + 왕복 여유

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * 엣지에 '지금 설정을 다시 받아 요청을 시작하라' 를 전한다. 반환 `{ ok, kind?, reason?, ms, runRequested?, note? }`.
 * ok 는 '엣지가 받았다' 이고 수집 성공이 아니다 — 결과는 엣지가 push 로 올린다.
 */
export async function nudgeIsiduEdge(agent, { fetchImpl } = {}) {
  const r = await pullFromEdge(agent, '/api/collector/isidu-run', {
    method: 'POST', jsonBody: {}, retries: 0, timeoutMs: NUDGE_TIMEOUT_MS, missing401: true,
    minVersion: MIN_ISIDU_EDGE_VERSION, what: '바로 실행할', label: '엣지 isidu-run 응답',
    bodyOk: (b) => isObj(b) && typeof b.ok === 'boolean',
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  if (!r.ok) return { ok: false, kind: r.kind, reason: r.reason || '', ms: r.ms };
  const b = r.body;
  if (b.ok === false) return { ok: false, kind: 'edge-pull', reason: String(b.reason || '엣지가 중앙 설정을 받지 못했습니다').slice(0, 300), ms: r.ms };
  return { ok: true, ms: r.ms, runRequested: Number.isFinite(b.runRequested) ? b.runRequested : null, started: Array.isArray(b.started) ? b.started.length : null };
}

/**
 * 엣지에서 연결 시험. `target` 은 edgeTargetView 모양(비밀 없음). 반환은 화면이 그대로 쓰는 `{ ok, ms, out, err, code, reason, node, kind? }`.
 */
export async function testIsiduOnEdge(agent, target, { fetchImpl } = {}) {
  const r = await pullFromEdge(agent, '/api/collector/isidu-test', {
    method: 'POST', jsonBody: { target }, retries: 0, timeoutMs: TEST_TIMEOUT_MS, missing401: true,
    minVersion: MIN_ISIDU_EDGE_VERSION, what: '엣지에서 연결 시험을 할', label: '엣지 isidu-test 응답',
    bodyOk: (b) => isObj(b) && typeof b.ok === 'boolean',
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  if (!r.ok) return { ok: false, via: 'edge', node: agent, kind: r.kind, reason: r.reason || '', ms: r.ms };
  const b = r.body;
  const s = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  return {
    ok: b.ok === true, via: 'edge', node: s(b.node, 64) || agent, ms: Number.isFinite(b.ms) ? b.ms : r.ms,
    out: s(b.out, 300), err: s(b.err, 300), code: Number.isFinite(b.code) ? b.code : null, command: s(b.command, 1200),
    ...(b.ok === true ? {} : { reason: s(b.reason, 600) || '엣지에서 시험하지 못했습니다', ...(typeof b.kind === 'string' ? { failKind: b.kind.slice(0, 32) } : {}) }),
    ...(b.demo === true ? { demo: true } : {}),
    ...(isObj(b.key) ? { key: { fingerprint: s(b.key.fingerprint, 128), created: b.key.created === true } } : {}),
  };
}
