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
import { runLink } from '../linkcheck/run.js';

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

/** 동시성 제한(중앙이 준 값). 결과 순서는 입력 순서를 지킨다. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    for (;;) {
      const k = i++;
      if (k >= items.length) return;
      try { out[k] = await fn(items[k]); } catch (e) { out[k] = { link: items[k], skipped: `점검 중 예외: ${String(e?.message || e).slice(0, 200)}` }; }
    }
  }));
  return out;
}

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
      // ⚠ 404 는 '중앙이 구버전' 이다 — 실패로 적지만 '설정 오류' 라 말하지 않는다(조치가 다르다).
      _last = { at: Date.now(), ms: Date.now() - t0, ok: true, note: '중앙이 구버전입니다(통신 점검 수신 경로 없음)', links: 0 };
      return { ok: true, links: 0 };
    }
    if (!r.ok) throw Object.assign(new Error(`link-check-config <- HTTP ${r.status}`), { status: r.status });
    const cfg = await r.json().catch(() => ({}));
    if (Number.isFinite(Number(cfg?.intervalMs)) && Number(cfg.intervalMs) > 0) _intervalMs = Number(cfg.intervalMs);

    if (cfg?.enabled !== true) {
      _last = { at: Date.now(), ms: Date.now() - t0, ok: true, disabled: true, note: '중앙에서 통신 점검이 꺼져 있습니다.', links: 0 };
      return { ok: true, disabled: true };
    }
    const links = Array.isArray(cfg.links) ? cfg.links : [];
    if (!links.length) {
      _last = { at: Date.now(), ms: Date.now() - t0, ok: true, links: 0, note: '이 엣지가 잴 링크가 없습니다(종류를 껐거나 담당 vCenter·짝이 없습니다).' };
      return { ok: true, links: 0 };
    }

    const ctx = { centralUrl: base, centralToken: config.agent.centralToken, agentName: agent };
    const results = await pool(links, Number(cfg.concurrency) || 4, (l) => runLink(l, { timeouts: cfg.timeouts || {}, ctx, byNode: agent }));
    const measured = results.filter((x) => x && x.verdict);
    const skipped = results.filter((x) => x && x.skipped);

    const json = JSON.stringify({ at: Date.now(), version: currentVersion(), results });
    const hdrs = { ...headers(), 'Content-Type': 'application/json', 'X-Agent-Name': agent };
    let payload = json;
    try { payload = await gzipAsync(json); hdrs['Content-Encoding'] = 'gzip'; } catch { payload = json; }
    const post = await resilientFetch(`${base}/api/central/link-check`, { method: 'POST', headers: hdrs, body: payload, timeoutMs: 30_000, retries: 2 });
    if (post.status === 413) console.warn(`[linkcheck-worker] 중앙이 본문 크기를 거부(413) — 링크 ${results.length}개. 중앙의 BIG_JSON 등록을 확인하세요.`);
    if (!post.ok) throw Object.assign(new Error(`link-check <- HTTP ${post.status}`), { status: post.status });
    const ack = await post.json().catch(() => ({}));

    const failed = measured.filter((x) => !x.verdict.ok).length;
    _last = {
      at: Date.now(), ms: Date.now() - t0, ok: true,
      links: links.length, checked: measured.length, failed, okCount: measured.length - failed,
      skipped: skipped.length,
      skippedReasons: skipped.slice(0, 10).map((x) => ({ id: x.link?.id || '', reason: x.skipped })),
      // ⚠ 중앙이 **버린 것**을 화면이 말할 수 있게 그대로 들고 있는다(v2.548 H6).
      stored: ack?.stored ?? null, rejected: ack?.rejected ?? null, omitted: ack?.omitted ?? null,
    };
    console.log(`[linkcheck-worker] 링크 ${links.length}개 점검 — 정상 ${measured.length - failed} · 실패 ${failed} · 건너뜀 ${skipped.length} · ${Date.now() - t0}ms`);
    return { ok: true, checked: measured.length, failed };
  } catch (e) {
    _last = { at: Date.now(), ms: Date.now() - t0, ok: false, httpStatus: e?.status || null, error: String(e?.message || e).slice(0, 300) };
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
