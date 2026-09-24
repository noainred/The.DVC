/**
 * Push an upgrade bundle from the central portal to registered collector agents.
 * Each agent applies it via its token-gated POST /api/collector/upgrade and
 * restarts. Best-effort and isolated per agent.
 */

import { createHash } from 'node:crypto';
import { readJsonCapped } from '../util/readCapped.js'; // v2.604: 엣지 응답 크기 상한
import { strOf } from '../util/coercionTrap.js';
/** 업그레이드 응답 상한 — 본문은 {ok, version, reason} 수백 바이트다. */
const UPGRADE_RESPONSE_MAX_BYTES = 64 * 1024;
import { loadCollectors } from './registry.js';
import { setCollectorStatus, getCollectorStatus } from './state.js';
import { _internals as _rf } from '../util/resilientFetch.js';
import { recordOutbound } from '../util/outboundStats.js'; // v2.587 — 전역 fetch 경로라 직접 기록(데이터 흐름 지도) // wanAgent — WAN 전용 로컬 디스패처(전역 오염 없음)

// 실패 HTTP 상태를 사람이 이해할 원인으로 분류(엣지별로 '무엇을 점검할지' 바로 알려주기 위함).
export function httpFailHint(status) {
  if (status === 403 || status === 401) return '토큰(COLLECTOR_TOKEN) 불일치 — 엣지의 COLLECTOR_TOKEN과 동일하게 저장하세요';
  if (status === 404) return '구버전이라 업그레이드 엔드포인트가 없거나 collector 비활성(COLLECTOR_TOKEN 미설정)';
  if (status === 413) return '업그레이드 번들이 너무 큽니다(413)';
  if (status >= 300 && status < 400) return '리다이렉트 응답 — 포트포워딩·프록시가 다른 주소로 보냅니다(토큰을 싣고 따라가지 않습니다)';
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

const _shaCache = new WeakMap(); // 같은 번들 버퍼는 1회만 해시(수집기 수만큼 반복 해시 방지)
function bundleSha(bytes) { let v = _shaCache.get(bytes); if (!v) { v = createHash('sha256').update(bytes).digest('hex'); _shaCache.set(bytes, v); } return v; }
export async function pushBundleToCollector(c, bytes, { restart = true, force = false, timeout = Number(process.env.EDGE_PUSH_TIMEOUT_MS) || 600_000 } = {}) {
  const url = `${String(c.url).replace(/\/+$/, '')}/api/collector/upgrade?restart=${restart}${force ? '&force=true' : ''}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip', 'X-Bundle-Sha256': bundleSha(bytes), ...(c.token ? { 'X-Collector-Token': c.token } : {}) }, // v2.480: 수신측 무결성 검증
      body: bytes,
      dispatcher: _rf.wanAgent, // 전역 디스패처가 검증 ON으로 복원돼(감사 C1/C3) 자체서명 https 엣지 호환용 WAN 디스패처 명시
      // v2.583(감사 확정): 기본 redirect:'follow' 는 교차 출처에서 X-Collector-Token 을 떼지 않는다(undici 는
      //   authorization·cookie 만 뗀다) — 번들 push 는 리다이렉트될 이유가 없으므로 따라가지 않는다(3xx = 실패).
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout),
    });
    // v2.604(감사 CEN2604-01 형제): 엣지 응답은 상한까지만 읽는다(해제 후 크기 — gzip 폭탄이 중앙 RSS 를 올리지 않게).
    //   객체가 아니거나 못 읽으면 {} — 사유·버전은 글자만(strOf).
    let body = {};
    try { const j = await readJsonCapped(res, UPGRADE_RESPONSE_MAX_BYTES, '엣지 업그레이드 응답'); if (j && typeof j === 'object' && !Array.isArray(j)) body = j; } catch { body = {}; }
    const ok = res.ok && body.ok !== false;
    const serverMsg = strOf(body.reason, 500) || strOf(body.error, 500);
    recordOutbound(url, { status: ok ? res.status : (res.status < 400 ? 500 : res.status), bytes: bytes?.length || 0, method: 'POST', error: ok ? '' : serverMsg, tag: c.id || c.name || '' }); // v2.601: 수집 서버 태그
    if (ok) return { id: c.id, name: c.name, ok: true, status: res.status, version: strOf(body.version, 32) || undefined };
    // 실패: 상태코드 + 서버 사유 + 점검 힌트를 하나의 reason으로 합쳐 UI/로그에서 바로 원인 파악.
    const hint = httpFailHint(res.status);
    const reason = `HTTP ${res.status}${serverMsg ? ` — ${serverMsg}` : ''}${hint ? ` · ${hint}` : ''}`;
    return { id: c.id, name: c.name, ok: false, status: res.status, reason };
  } catch (err) {
    recordOutbound(url, { error: String(err?.message || err), method: 'POST', tag: c.id || c.name || '' });
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
