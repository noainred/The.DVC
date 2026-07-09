/**
 * Push an upgrade bundle from the central portal to registered collector agents.
 * Each agent applies it via its token-gated POST /api/collector/upgrade and
 * restarts. Best-effort and isolated per agent.
 */

import { loadCollectors } from './registry.js';
import { setCollectorStatus, getCollectorStatus } from './state.js';

// 실패 HTTP 상태를 사람이 이해할 원인으로 분류(엣지별로 '무엇을 점검할지' 바로 알려주기 위함).
export function httpFailHint(status) {
  if (status === 403 || status === 401) return '토큰(COLLECTOR_TOKEN) 불일치 — 엣지의 COLLECTOR_TOKEN과 동일하게 저장하세요';
  if (status === 404) return '구버전이라 업그레이드 엔드포인트가 없거나 collector 비활성(COLLECTOR_TOKEN 미설정)';
  if (status === 413) return '업그레이드 번들이 너무 큽니다(413)';
  return '';
}

// 네트워크 예외 메시지를 원인으로 분류(중앙→엣지 인바운드 도달 실패 진단).
export function netFailReason(msg) {
  const m = String(msg || '');
  if (/timeout|aborted|timed out/i.test(m)) return '연결 시간초과 — 방화벽/포트포워딩 또는 엣지 포탈 미기동 확인';
  if (/ECONNREFUSED|refused/i.test(m)) return '연결 거부 — 해당 포트가 닫혀 있거나 엣지 포탈 미기동';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return '호스트 조회 실패 — 수집 서버 URL의 호스트명 확인';
  if (/certificate|self.signed|SSL|TLS/i.test(m)) return 'TLS 인증서 오류 — https URL/인증서 확인';
  if (/fetch failed|network|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(m)) return '네트워크 도달 불가 — 중앙에서 엣지로의 인바운드 경로(NAT/포트포워딩)를 확인하세요';
  return m;
}

export async function pushBundleToCollector(c, bytes, { restart = true, force = false, timeout = Number(process.env.EDGE_PUSH_TIMEOUT_MS) || 600_000 } = {}) {
  const url = `${String(c.url).replace(/\/+$/, '')}/api/collector/upgrade?restart=${restart}${force ? '&force=true' : ''}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip', ...(c.token ? { 'X-Collector-Token': c.token } : {}) },
      body: bytes,
      signal: AbortSignal.timeout(timeout),
    });
    const body = await res.json().catch(() => ({}));
    const ok = res.ok && body.ok !== false;
    if (ok) return { id: c.id, name: c.name, ok: true, status: res.status, version: body.version };
    // 실패: 상태코드 + 서버 사유 + 점검 힌트를 하나의 reason으로 합쳐 UI/로그에서 바로 원인 파악.
    const serverMsg = body.reason || body.error || '';
    const hint = httpFailHint(res.status);
    const reason = `HTTP ${res.status}${serverMsg ? ` — ${serverMsg}` : ''}${hint ? ` · ${hint}` : ''}`;
    return { id: c.id, name: c.name, ok: false, status: res.status, reason };
  } catch (err) {
    return { id: c.id, name: c.name, ok: false, reason: netFailReason(err.message), netError: true };
  }
}

/**
 * Push to all enabled collectors (or a subset of ids). Records the outcome in
 * each collector's status so the admin UI can show upgrade results.
 */
export async function pushUpgradeToCollectors(bytes, { ids = null, force = false } = {}) {
  const list = loadCollectors().filter((c) => c.enabled !== false && c.url && (!ids || ids.includes(c.id)));
  const results = await Promise.all(list.map(async (c) => {
    const r = await pushBundleToCollector(c, bytes, { force });
    const prev = getCollectorStatus(c.id) || {};
    setCollectorStatus(c.id, { ...prev, upgrade: { at: Date.now(), ok: r.ok, version: r.version, reason: r.reason || r.error } });
    return r;
  }));
  return results;
}
