/**
 * agent/linkCheckWorker.js — **엣지가 재는 링크**를 측정해 중앙에 올린다(v2.552).
 *
 * 중앙은 자기가 나가는 방향만 잴 수 있다. 엣지→중앙 push·엣지→중앙 설정 pull·엣지→vCenter(site)·
 * 엣지↔엣지는 **엣지만** 잴 수 있고, 그 중 엣지→중앙이 죽으면 중앙 화면이 **조용히 낡는다**
 * (엣지 쪽은 정상으로 보인다) — 이 워커가 없으면 그 상황을 영원히 볼 수 없다.
 *
 * ⚠⚠ **무음 실패를 만들지 말 것**(v2.549 규약): `_last`(`linkCheckWorkerStatus`)를 남기고 실패는
 *   콘솔에도 적는다. 이 저장소의 위임 워커 4개가 `catch { return null; }` 로 조용히 실패하던 사고를
 *   반복하지 않는다.
 * ⚠ **중앙이 껐으면 아무것도 재지 않는다** — 그러나 '껐다' 와 '링크가 없다' 를 구분해 기록한다
 *   (조치가 다르다).
 * ⚠ 주기는 **중앙 설정값**을 따른다(`startAdaptiveTimer` + 매 틱 조회) — 모듈 로드 시 env 로
 *   굳히면 중앙에서 바꿔도 엣지를 재시작해야 먹는다(v2.409 실제 사고).
 * ⚠ 재진입 가드 — 고RTT 구간에서 한 주기가 간격을 넘기면 중첩 실행된다.
 */
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { config, currentVersion } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { classifyCentral404 } from './central404.js';
import { runLink } from '../linkcheck/run.js';
import { poolSettled } from '../util/pool.js'; // v2.579: 동시성 풀 단일 소스

const gzipAsync = promisify(gzip);
const FALLBACK_MS = 5 * 60_000;
let _timer = null;
let _running = false;
let _last = null;
let _intervalMs = FALLBACK_MS;      // 중앙이 알려준 주기(없으면 폴백)

export function linkCheckWorkerStatus() {
  return { running: _running, intervalMs: _intervalMs, last: _last };
}

const headers = () => ({ Accept: 'application/json', ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) });

// v2.579(ARCH-01): 풀 스캐폴드는 util/pool.js 하나다 — 항목별 결과 모양(예전 그대로)만 여기서 입힌다.
async function pool(items, limit, fn) {
  return (await poolSettled(items, limit, fn)).map((r, k) => (r.status === 'fulfilled' ? r.value : { link: items[k], skipped: `점검 중 예외: ${String(r.reason?.message || r.reason).slice(0, 200)}` }));
}

/**
 * 중앙으로 보고를 올린다(gzip). **결과가 0건이어도 부른다** — 위 주석 참조.
 * ⚠ 던지지 않는다(0건 보고 실패가 점검 자체를 실패로 만들지 않게) — 사유는 `_last` 에 남는다.
 */
async function pushReport(base, agent, { results = [], note = '', disabled = false } = {}) {
  const json = JSON.stringify({ at: Date.now(), version: currentVersion(), results, note, disabled });
  const hdrs = { ...headers(), 'Content-Type': 'application/json', 'X-Agent-Name': agent };
  let payload = json;
  try { payload = await gzipAsync(json); hdrs['Content-Encoding'] = 'gzip'; } catch { payload = json; }
  const post = await resilientFetch(`${base}/api/central/link-check`, { method: 'POST', headers: hdrs, body: payload, timeoutMs: 30_000, retries: 2 });
  if (post.status === 413) console.warn(`[linkcheck-worker] 중앙이 본문 크기를 거부(413) — 링크 ${results.length}개. 중앙의 BIG_JSON 등록을 확인하세요.`);
  if (!post.ok) {
    // ⚠ 무음 실패 금지 — 403 은 '개별 토큰이 아니다' 라는 가장 흔한 원인이다.
    console.warn(`[linkcheck-worker] 보고 실패: HTTP ${post.status}${post.status === 403 ? ' — 이 엣지의 개별 토큰(설정 > 엣지 토큰)이 필요합니다.' : ''}`);
    return { ok: false, httpStatus: post.status };
  }
  return await post.json().catch(() => ({}));
}

/** 중앙 응답에서 화면이 쓰는 값만(v2.548 H6 — 중앙이 버린 것을 엣지도 안다). */
const ackFields = (ack) => ({
  stored: ack?.stored ?? null, rejected: ack?.rejected ?? null, omitted: ack?.omitted ?? null,
  reportPosted: ack?.ok === true, reportHttpStatus: ack?.httpStatus ?? null,
});

export async function runLinkCheckWorkerOnce() {
  const base = config.agent.centralUrl;
  if (!base) return { ok: false, reason: 'CENTRAL_URL 없음(엣지 아님)' };
  if (_running) return { ok: false, reason: '이전 틱 진행 중' };
  _running = true;
  const t0 = Date.now();
  try {
    const agent = String(config.agent.name || '');
    const r = await resilientFetch(`${base}/api/central/link-check-config?agent=${encodeURIComponent(agent)}`, { headers: headers(), timeoutMs: 15_000, retries: 1 });
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error('중앙이 이 엣지를 거부했습니다(개별 토큰·AGENT_NAME 확인)'), { status: r.status });
    if (r.status === 404) {
      // ⚠ 404 는 두 뜻이다(v2.602 감사 EDGE2602-02) — 'central 비활성화' 는 실패로 적는다(중앙을 켜야 한다). 엔드포인트가 없는
      //   구버전 중앙만 '구버전' 이다 — '설정 오류' 라 말하지 않는다(조치가 다르다).
      const c = await classifyCentral404(r);
      if (c.kind !== 'no-endpoint') throw Object.assign(new Error(c.reason), { status: 404, kind: c.kind });
      _last = { at: Date.now(), ms: Date.now() - t0, ok: true, kind: c.kind, note: '중앙이 구버전입니다(통신 점검 수신 경로 없음)', links: 0 };
      return { ok: true, links: 0 };
    }
    if (!r.ok) throw Object.assign(new Error(`link-check-config <- HTTP ${r.status}`), { status: r.status });
    const cfg = await r.json().catch(() => ({}));
    if (Number.isFinite(Number(cfg?.intervalMs)) && Number(cfg.intervalMs) > 0) _intervalMs = Number(cfg.intervalMs);

    /*
     * ⚠⚠ **0건·꺼짐이어도 중앙에 상태를 올린다**(v2.554 에 고친 v2.552 결함 — 사용자 실화면으로 확정).
     *
     *   v2.552~2.553 은 여기서 **조기 return** 했다. 그래서 '잴 링크가 0개' 인 엣지는 중앙에
     *   **아무것도 보내지 않았고**, 중앙 화면은 그 상태를 '첫 보고 대기'(= 기다리면 된다)라고
     *   말했다 — 기다려도 영원히 채워지지 않는다. 이것은 CLAUDE.md v2.517 `sendStatusOnly` 규약
     *   ("엣지는 표본이 0건이어도 상태를 올린다 … 0건이면 push 가 조용히 조기 반환해 중앙으로
     *   아무것도 가지 않았고 — 그게 바로 신고된 상태다")을 그대로 어긴 것이다.
     *   **이 push 를 다시 조기 return 으로 되돌리지 말 것.**
     *
     *   ⚠ 남는 한계(정직 기록): 중앙이 **403**(개별 토큰 아님)으로 거부하면 이 보고조차 올릴 수
     *     없다 — 그 경우는 엣지 콘솔 로그와 `linkCheckWorkerStatus`(엣지 로그 화면)가 말한다.
     */
    if (cfg?.enabled !== true) {
      const note = '중앙에서 통신 점검이 꺼져 있습니다.';
      const ack = await pushReport(base, agent, { results: [], note, disabled: true });
      _last = { at: Date.now(), ms: Date.now() - t0, ok: true, disabled: true, note, links: 0, ...ackFields(ack) };
      return { ok: true, disabled: true };
    }
    const links = Array.isArray(cfg.links) ? cfg.links : [];
    if (!links.length) {
      const note = '이 엣지가 잴 링크가 없습니다(종류를 껐거나 담당 vCenter·짝이 없습니다).';
      const ack = await pushReport(base, agent, { results: [], note });
      _last = { at: Date.now(), ms: Date.now() - t0, ok: true, links: 0, note, ...ackFields(ack) };
      return { ok: true, links: 0 };
    }

    const ctx = { centralUrl: base, centralToken: config.agent.centralToken, agentName: agent };
    const results = await pool(links, Number(cfg.concurrency) || 4, (l) => runLink(l, { timeouts: cfg.timeouts || {}, ctx, byNode: agent }));
    const measured = results.filter((x) => x && x.verdict);
    const skipped = results.filter((x) => x && x.skipped);

    const ack = await pushReport(base, agent, { results });

    const failed = measured.filter((x) => !x.verdict.ok).length;
    _last = {
      at: Date.now(), ms: Date.now() - t0, ok: true,
      links: links.length, checked: measured.length, failed, okCount: measured.length - failed,
      skipped: skipped.length,
      skippedReasons: skipped.slice(0, 10).map((x) => ({ id: x.link?.id || '', reason: x.skipped })),
      // ⚠ 중앙이 **버린 것**을 화면이 말할 수 있게 그대로 들고 있는다(v2.548 H6).
      ...ackFields(ack),
    };
    console.log(`[linkcheck-worker] 링크 ${links.length}개 점검 — 정상 ${measured.length - failed} · 실패 ${failed} · 건너뜀 ${skipped.length} · ${Date.now() - t0}ms`);
    return { ok: true, checked: measured.length, failed };
  } catch (e) {
    _last = { at: Date.now(), ms: Date.now() - t0, ok: false, httpStatus: e?.status || null, ...(e?.kind ? { kind: e.kind } : {}), error: String(e?.message || e).slice(0, 300) };
    console.warn(`[linkcheck-worker] 실패: ${_last.error}`);       // 무음 실패 금지
    return { ok: false, reason: _last.error };
  } finally { _running = false; }
}

export function startLinkCheckWorker() {
  if (!config.agent.centralUrl) return;          // 중앙 자신이면 이 워커는 없다
  if (String(process.env.AGENT_LINKCHECK || '').toLowerCase() === 'false') {
    console.log('[linkcheck-worker] 꺼짐(AGENT_LINKCHECK=false).');
    return;
  }
  if (_timer) return;
  _timer = startAdaptiveTimer(() => _intervalMs, () => runLinkCheckWorkerOnce(), { firstDelayMs: 60_000, name: 'linkcheck-worker' });
  return _timer;
}
export function stopLinkCheckWorker() { _timer?.stop?.(); _timer = null; }
