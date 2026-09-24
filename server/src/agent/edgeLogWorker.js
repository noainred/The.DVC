/**
 * agent/edgeLogWorker.js — 엣지가 중앙의 **로그 요청**을 인출해 회신한다(v2.549 폴백 경로).
 *
 * 기본 경로는 중앙이 당기는 pull 이다(`central/edgeLogPull.js`). 이 워커는 **중앙이 이 엣지에
 * 닿지 못할 때만** 쓰인다 — 엣지는 항상 자기가 먼저 나가므로 inbound 가 막힌 법인에서도 동작한다.
 *
 * ⚠⚠ **무음 실패를 만들지 말 것.** v2.549 조사에서 이 저장소의 위임 워커 4개
 *   (`pingWorker`·`logQueryWorker`·`captureWorker`·`bmstorWorker`)가 전부 `catch { return null; }`
 *   에 상태 객체도 로그도 없어 **4~10초마다 조용히 실패**하고 있었다. 이 워커는 그 실수를 반복하지
 *   않는다 — `_last` 를 남기고(`edgeLogWorkerStatus`), 실패는 콘솔에도 적는다.
 *
 * ── 폴 주기의 비용(추정이 아니라 산수) ────────────────────────────────────────
 * 기본 60초 × 엣지 28곳 = 중앙에 **하루 40,320 요청**이고 대기 작업이 없으면 응답은 `{job:null}`
 * (수십 바이트)다. 조사에서 잰 엣지 상시 아웃바운드 바닥값(하루 10만 요청대)에 비해 작지만 공짜는
 * 아니다 — 이 폴백이 필요 없는 법인은 `AGENT_EDGELOG_POLL_MS=0` 으로 끌 수 있다.
 * ⚠ **주기 숫자를 화면 문구에 박지 말 것** — 상태가 주는 `intervalMs` 만 쓴다.
 */
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { config, clampIntervalMs } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { classifyCentral404 } from './central404.js';

const gzipAsync = promisify(gzip);
const DEFAULT_POLL_MS = 60_000;
const pollMs = () => {
  const v = Number(process.env.AGENT_EDGELOG_POLL_MS);
  if (Number.isFinite(v) && v === 0) return 0;                 // 0 = 이 엣지에서 폴백 끔
  return clampIntervalMs(v, DEFAULT_POLL_MS, 10_000);          // v2.599 T2599-02: 상한(2^31 초과 → 1ms 루프 방지)
};

let _timer = null;
let _running = false;
let _last = null;

const headers = () => ({ 'Content-Type': 'application/json', ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) });

/** 한 틱 — 대기 작업이 있으면 로그를 모아 회신한다. 재진입 가드(CLAUDE.md 폴러 규약). */
export async function runEdgeLogWorkerOnce() {
  if (!config.agent.centralUrl) return { ok: false, reason: 'CENTRAL_URL 없음(엣지 아님)' };
  if (_running) return { ok: false, reason: '이전 틱 진행 중' };
  _running = true;
  const t0 = Date.now();
  try {
    const base = config.agent.centralUrl;
    const agent = encodeURIComponent(config.agent.name || '');
    const r = await resilientFetch(`${base}/api/central/edge-log-jobs?agent=${agent}`, { headers: headers(), timeoutMs: 15_000, retries: 1 });
    if (r.status === 403 || r.status === 401) throw Object.assign(new Error('중앙이 이 엣지를 거부했습니다(토큰·AGENT_NAME 확인)'), { status: r.status });
    if (r.status === 404) {
      // v2.602(감사 EDGE2602-02): 404 는 두 뜻이다 — 'central 비활성화' 는 실패(중앙을 켜야 한다)이고, 엔드포인트가 없는 구버전
      //   중앙만 '폴백 경로 없음' 이다. 예전에는 둘 다 ok:true·'구버전' 으로 적어 꺼진 중앙을 '업그레이드하면 된다' 로 말했다.
      const c = await classifyCentral404(r);
      if (c.kind !== 'no-endpoint') throw Object.assign(new Error(c.reason), { status: 404, kind: c.kind });
      _last = { at: Date.now(), ms: Date.now() - t0, ok: true, job: false, kind: c.kind, note: '중앙이 구버전입니다(폴백 경로 없음)' };
      return { ok: true, job: false };
    }
    if (!r.ok) throw Object.assign(new Error(`edge-log-jobs <- HTTP ${r.status}`), { status: r.status });
    const jobBody = await r.json().catch(() => ({}));
    const job = jobBody?.job || null;
    if (!job) { _last = { at: Date.now(), ms: Date.now() - t0, ok: true, job: false }; return { ok: true, job: false }; }

    const { collectEdgeLog } = await import('../edgelog/collect.js');
    const snap = await collectEdgeLog({ since: job.since, level: job.level, limit: job.limit, withStatus: job.withStatus !== false });
    // gzip — 로그 본문은 반복이 많아 압축비가 크다(CLAUDE.md '새 push 경로는 gzip + BIG_JSON 등록 + 413 로그').
    // v2.607(감사 EDGE2607-01): 공유 토큰 엣지는 중앙이 인증으로 이름을 알 수 없어 **본문 최상위 agent 또는 ?agent=** 를 요구한다
    //   (routes/central.js edge-log-result). 예전에는 collectEdgeLog 봉투(node.agent 만)를 그대로 보내 공유 토큰 현장에서 회신이
    //   **항상 400** 이었다 — 인출은 ?agent= 로 성공해 작업은 claimed 로 남고 회신만 실패했다. 둘 다 싣는다(개별 토큰은 인증 이름이 이긴다).
    const json = JSON.stringify({ ...snap, agent: config.agent.name || '' });
    const hdrs = headers();
    let payload = json;
    try { payload = await gzipAsync(json); hdrs['Content-Encoding'] = 'gzip'; } catch { payload = json; }
    const post = await resilientFetch(`${base}/api/central/edge-log-result?agent=${agent}`, {
      method: 'POST', headers: hdrs, body: payload, timeoutMs: 30_000, retries: 2,
    });
    if (post.status === 413) console.warn(`[edgelog-worker] 중앙이 본문 크기를 거부(413) — 로그 ${snap.logs?.count}줄. EDGELOG 한도를 확인하세요.`);
    if (!post.ok) throw Object.assign(new Error(`edge-log-result <- HTTP ${post.status}`), { status: post.status });
    _last = { at: Date.now(), ms: Date.now() - t0, ok: true, job: true, lines: snap.logs?.count ?? 0, statusFailed: snap.statusFailed ?? null };
    console.log(`[edgelog-worker] 중앙 요청 회신 — 로그 ${snap.logs?.count ?? 0}줄 · 상태 실패 ${snap.statusFailed ?? '?'}건 · ${Date.now() - t0}ms`);
    return { ok: true, job: true };
  } catch (e) {
    _last = { at: Date.now(), ms: Date.now() - t0, ok: false, httpStatus: e?.status || null, ...(e?.kind ? { kind: e.kind } : {}), error: String(e?.message || e).slice(0, 300) };
    console.warn(`[edgelog-worker] 실패: ${_last.error}`);   // 무음 실패 금지
    return { ok: false, reason: _last.error };
  } finally { _running = false; }
}

export function startEdgeLogWorker() {
  if (!config.agent.centralUrl) return;          // 중앙 자신이면 이 워커는 없다
  const ms = pollMs();
  if (!ms) { console.log('[edgelog-worker] 꺼짐(AGENT_EDGELOG_POLL_MS=0) — 중앙이 직접 당기는 경로만 씁니다.'); return; }
  if (_timer) return;
  // ⚠ 인자 순서는 `(getMs, fn, opts)` 다 — 매 틱 주기를 다시 읽어야 env 변경이 재시작 없이 먹는다.
  _timer = startAdaptiveTimer(pollMs, () => runEdgeLogWorkerOnce().catch(() => {}), { name: 'edgelog-worker', firstDelayMs: 35_000 });
  console.log(`[edgelog-worker] 시작 — 폴백 폴 ${Math.round(ms / 1000)}초`);
}

export function stopEdgeLogWorker() { _timer?.stop?.(); _timer = null; }

/** 화면·진단용 상태. ⚠ 이 값이 있어야 '폴백이 도는지' 를 사람이 알 수 있다. */
export function edgeLogWorkerStatus() {
  return { enabled: !!config.agent.centralUrl && pollMs() > 0, intervalMs: pollMs(), busy: _running, last: _last };
}
