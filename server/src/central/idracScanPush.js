/**
 * 중앙→엣지 직접(PUSH) iDRAC 스캔 — 엣지가 중앙으로 폴링하지 않아도, 중앙이 등록된
 * 수집 서버(원격) URL로 엣지에 직접 스캔을 시키고 결과를 받는다(엣지 CENTRAL_URL 미설정에도 동작).
 *
 *   중앙 UI → pushIdracScan(agent, {...})            → createPushScanJob → reqId (즉시 running)
 *   중앙    → POST {edge.url}/api/collector/idrac-scan (X-Collector-Token)  → 엣지가 현지 스캔·등록
 *   중앙    ← 응답(found/요약)                         → setIdracScanResult(reqId)
 *   UI      ← GET /admin/idrac/scan-result?reqId=...   → 폴링(기존 UI 그대로)
 */

import { resilientFetch } from '../util/resilientFetch.js';
import { loadCollectors } from '../collector/registry.js';
import { pullCollectorByAgent } from '../collector/puller.js';
import { createPushScanJob, setIdracScanResult } from './idracScanJobs.js';

/**
 * 에이전트 이름/‌id에 매칭되는 수집 서버(원격)를 찾는다(대소문자 무관). URL이 있어야 PUSH 가능.
 * ⚠ 반드시 loadCollectors(원본, 토큰 포함)를 쓴다 — listCollectors()는 UI용으로 token을 마스킹
 * 하므로, 그걸 쓰면 X-Collector-Token 없이 엣지에 요청해 403이 난다(엣지는 정상).
 */
export function findCollectorForAgent(agent) {
  const key = String(agent || '').trim().toLowerCase();
  if (!key) return null;
  return loadCollectors().find((c) => String(c.id || '').toLowerCase() === key || String(c.name || '').toLowerCase() === key) || null;
}

// 대역이 크면 엣지 스캔이 수십 초~수 분 걸린다 — 넉넉한 타임아웃(15분).
const PUSH_TIMEOUT_MS = Number(process.env.IDRAC_PUSH_TIMEOUT_MS) || 15 * 60_000;

/**
 * PUSH 스캔 시작. 성공 시 { ok, reqId }를 즉시 반환하고, 실제 전송/결과 반영은 백그라운드에서 진행한다.
 * 매칭되는 수집 서버 URL이 없으면 { ok:false, reason }.
 */
export function pushIdracScan(agent, { ips, username, password, vcenterId = '', datacenterId = '', noRegister = false, mode = 'merge' } = {}) {
  const col = findCollectorForAgent(agent);
  if (!col || !col.url) {
    return { ok: false, reason: `에이전트 '${agent}'에 매칭되는 '수집 서버(원격)' URL이 없습니다. 설정 → 수집 서버(원격)에 이 에이전트를 URL과 함께 등록하면 중앙이 직접 스캔을 전송할 수 있습니다.` };
  }
  // URL 끝 슬래시 제거(연결 테스트와 파리티) — '.../:4000/' 저장 시 PUSH가 '//api/...' 이중
  // 슬래시로 깨지던 것을 방지. 저장 값을 바꾸지 않고 요청 시점에만 정규화한다.
  const edgeUrl = String(col.url).replace(/\/+$/, '');
  const reqId = createPushScanJob(agent, { ips, username, password, vcenterId, datacenterId, noRegister, mode, edgeUrl });
  if (!reqId) return { ok: false, reason: '진행 중 잡이 너무 많습니다. 잠시 후 다시 시도하세요.' };

  // 백그라운드 전송(요청 즉시 반환 — UI는 reqId로 폴링).
  (async () => {
    try {
      const r = await resilientFetch(`${edgeUrl}/api/collector/idrac-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(col.token ? { 'X-Collector-Token': col.token } : {}) },
        body: JSON.stringify({ ips, username, password, noRegister, vcenterId, datacenterId, mode }),
        timeoutMs: PUSH_TIMEOUT_MS, retries: 1,
      });
      if (!r.ok) {
        const hint = r.status === 403 ? ' — 수집 서버 토큰(X-Collector-Token) 불일치'
          : r.status === 404 ? ' — 엣지가 구버전이라 PUSH 스캔 엔드포인트가 없거나 collector 비활성'
            : '';
        setIdracScanResult(reqId, { error: `엣지 응답 HTTP ${r.status}${hint}. 수집 서버 URL/토큰/버전을 확인하세요.` });
        return;
      }
      const data = await r.json().catch(() => ({}));
      if (!data || data.ok === false) { setIdracScanResult(reqId, { error: data?.reason || '엣지 스캔 실패(형식 오류)' }); return; }
      setIdracScanResult(reqId, data); // { scanned, found, foundCount, registered, ... }
      // 엣지가 현지 등록한 서버를 다음 주기(기본 60초)까지 기다리지 않고 즉시 중앙 인벤토리에 반영.
      // 전력값은 엣지 로컬 폴러가 수집한 뒤라야 나오므로 30초 후 한 번 더 당겨 전력까지 앞당긴다.
      if ((data.registered || 0) > 0) {
        pullCollectorByAgent(agent).catch(() => {});
        setTimeout(() => pullCollectorByAgent(agent).catch(() => {}), 30_000).unref?.();
      }
    } catch (e) {
      setIdracScanResult(reqId, { error: `엣지 접속 실패: ${e.message} — 중앙에서 ${col.url} 에 접근 가능한지(방화벽/네트워크) 확인하세요.` });
    }
  })();

  return { ok: true, reqId };
}
