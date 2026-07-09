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
  const reqId = createPushScanJob(agent, { ips, username, password, vcenterId, datacenterId, noRegister, mode, edgeUrl: col.url });
  if (!reqId) return { ok: false, reason: '진행 중 잡이 너무 많습니다. 잠시 후 다시 시도하세요.' };

  // 백그라운드 전송(요청 즉시 반환 — UI는 reqId로 폴링).
  (async () => {
    try {
      const r = await resilientFetch(`${col.url}/api/collector/idrac-scan`, {
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
    } catch (e) {
      setIdracScanResult(reqId, { error: `엣지 접속 실패: ${e.message} — 중앙에서 ${col.url} 에 접근 가능한지(방화벽/네트워크) 확인하세요.` });
    }
  })();

  return { ok: true, reqId };
}
