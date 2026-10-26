/**
 * Push an upgrade bundle from the central portal to registered collector agents.
 * Each agent applies it via its token-gated POST /api/collector/upgrade and
 * restarts. Best-effort and isolated per agent.
 */

import { createHash } from 'node:crypto';
import { readJsonCapped } from '../util/readCapped.js'; // v2.604: 엣지 응답 크기 상한
import { strOf } from '../util/coercionTrap.js';
import { reqTimeoutMs } from '../agent/envTimeout.js'; // v2.607 TIM2607-02: push 시한 정규화
/** 업그레이드 응답 상한 — 본문은 {ok, version, reason} 수백 바이트다. */
const UPGRADE_RESPONSE_MAX_BYTES = 64 * 1024;
import { loadCollectors } from './registry.js';
import { setCollectorStatus, getCollectorStatus } from './state.js';
import { dispatcherFor } from '../util/resilientFetch.js';
import { recordOutbound } from '../util/outboundStats.js'; // v2.587 — 전역 fetch 경로라 직접 기록(데이터 흐름 지도) // wanAgent — WAN 전용 로컬 디스패처(전역 오염 없음)
// v2.730(검토 S-10): 서명 manifest 를 헤더로 싣는다 — 수집기는 자기 신뢰 공개키로 설치 전에 검증한다.
import { encodeManifestHeader, MANIFEST_HEADER } from '../upgrade/signature.js';
import { poolSettled } from '../util/pool.js';
import { numOrNull } from '../util/numOrNull.js';
import { cmpVersion } from '../util/cmpVersion.js'; // v2.785(GE A-B3): 스스로 새 판이 된 수집 서버의 자동 실패를 지우는 데 쓴다

/**
 * v2.741(감사 TIMING-07 — docs/AUDIT-2026-09-11c B3·T1 이 '확인' 으로 남겨 둔 것): 업그레이드 번들 push 동시 개수.
 *   예전에는 Promise.all 로 모든 수집 서버·엣지에 수십 MB 번들을 한꺼번에 올렸다 — 업링크를 나눠 쓰다 개별 업로드가 시한
 *   (EDGE_PUSH_TIMEOUT_MS, 기본 600초)을 넘길 수 있고, 그러면 함대 버전이 섞인다. 빈 값·숫자 아님 = 기본 4, 1 미만 = 1(순서대로), 상한 32.
 */
export function pushConcurrencyOf(v = process.env.UPGRADE_PUSH_CONCURRENCY) {
  const n = numOrNull(v);
  if (n == null) return 4;
  if (n < 1) return 1;
  return Math.min(32, Math.floor(n));
}
export const UPGRADE_PUSH_CONCURRENCY = pushConcurrencyOf(numOrNull(process.env.UPGRADE_PUSH_CONCURRENCY) ?? 4);   // 같은 판정 — 기본값을 문서 생성기가 읽게 한 줄로(실행 시점에는 pushConcurrencyOf() 를 다시 읽는다)

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
export async function pushBundleToCollector(c, bytes, { restart = true, force = false, timeout = process.env.EDGE_PUSH_TIMEOUT_MS, manifest = null } = {}) {
  const url = `${String(c.url).replace(/\/+$/, '')}/api/collector/upgrade?restart=${restart}${force ? '&force=true' : ''}`;
  const manHeader = encodeManifestHeader(manifest); // 없거나 상한을 넘으면 null — 보내지 않는다(수신측이 '서명 없음' 으로 판정)
  // v2.632(감사 E 후속): 시한이 undici 기본 입출력 시한(300초)을 넘으면 긴 시한 디스패처(wanLongAgent) — 아니면 headersTimeout 이 먼저 끊는다.
  const pushTimeoutMs = reqTimeoutMs(timeout, 600_000, { max: 7_200_000 });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip', 'X-Bundle-Sha256': bundleSha(bytes), ...(manHeader ? { [MANIFEST_HEADER]: manHeader } : {}), ...(c.token ? { 'X-Collector-Token': c.token } : {}) }, // v2.480: 수신측 무결성 검증 · v2.730: 서명 manifest
      body: bytes,
      dispatcher: dispatcherFor(undefined, pushTimeoutMs), // 전역 디스패처가 검증 ON으로 복원돼(감사 C1/C3) 자체서명 https 엣지 호환용 WAN 디스패처 명시
      // v2.583(감사 확정): 기본 redirect:'follow' 는 교차 출처에서 X-Collector-Token 을 떼지 않는다(undici 는
      //   authorization·cookie 만 뗀다) — 번들 push 는 리다이렉트될 이유가 없으므로 따라가지 않는다(3xx = 실패).
      redirect: 'manual',
      // v2.607 TIM2607-02: 'Number(env) || 기본' 은 3e9 를 그대로(→ 1ms abort), 음수는 AbortSignal.timeout 이 ERR_OUT_OF_RANGE 로 던졌다.
      signal: AbortSignal.timeout(pushTimeoutMs),
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
 * v2.775(사용자 보고 '수집서버 자동 업그레이드가 안되'): 중앙 자동 적용이 남긴 수집 서버 push 결과(upgrade lastResult.collectorPush — 파일)를
 *   수집 서버 상태에 합친다(순수). 자동 적용 직후 중앙이 재시작해 메모리 상태의 upgrade 가 사라지므로, 화면은 이것으로 '마지막 자동 push' 를 본다.
 *   메모리에 더 새로운 결과(재시작 뒤 수동 업그레이드)가 있으면 그것을 둔다.
 * @param {Record<string,object>} status allCollectorStatus()
 * @param {object|null} lastResult upgradeManager.lastResult
 * @returns {Record<string,object>} 새 객체(입력은 바꾸지 않는다)
 */
export function mergeAutoPushStatus(status, lastResult) {
  const out = { ...(status || {}) };
  const cp = lastResult && typeof lastResult === 'object' ? lastResult.collectorPush : null;
  const at = Number(lastResult?.at);
  if (!cp || !Array.isArray(cp.items) || !Number.isFinite(at) || at <= 0) return out;
  for (const it of cp.items) {
    const id = it && typeof it.id === 'string' ? it.id : '';
    if (!id) continue;
    const cur = out[id] && typeof out[id] === 'object' ? out[id] : null;
    if (cur?.upgrade && Number(cur.upgrade.at) >= at) continue;
    /*
     * v2.785(GE A-B3): push 는 실패했지만 그 뒤 수집 서버가 **스스로** 그 판(또는 더 새 판)이 됐으면(pull 상태 version) 빨간
     *   '업그레이드 실패(자동)' 를 다음 릴리스까지 남기지 않는다. ⚠ cmpVersion 은 못 읽으면 null 이고 `null >= 0` 은 JS 에서 true 다 —
     *   null 을 먼저 거른다(버전을 모르면 실패를 그대로 둔다 — 못 읽음 ≠ 성공).
     */
    if (it.ok !== true) {
      const c = cmpVersion(cur?.version, it.version || lastResult.version);
      if (c != null && c >= 0) continue;
    }
    out[id] = { ...(cur || {}), upgrade: { at, ok: it.ok === true, version: it.version || lastResult.version || undefined, reason: it.reason || '', ...(Number.isFinite(it.status) ? { status: it.status } : {}), auto: true } };
  }
  return out;
}

/**
 * Push to all enabled collectors (or a subset of ids). Records the outcome in
 * each collector's status so the admin UI can show upgrade results.
 */
export async function pushUpgradeToCollectors(bytes, { ids = null, force = false, manifest = null, concurrency = pushConcurrencyOf(), auto = false } = {}) {
  const list = loadCollectors().filter((c) => c.enabled !== false && c.url && (!ids || ids.includes(c.id)));
  // v2.741(TIMING-07): 동시 개수 상한 안에서 차례로 — 결과 순서·모양은 예전(Promise.all)과 같다. 한 수집 서버의 예외가 나머지 결과를 버리지 않는다.
  const settled = await poolSettled(list, concurrency, async (c) => {
    const r = await pushBundleToCollector(c, bytes, { force, manifest });
    const prev = getCollectorStatus(c.id) || {};
    setCollectorStatus(c.id, { ...prev, upgrade: { at: Date.now(), ok: r.ok, version: r.version, reason: r.reason || r.error, ...(Number.isFinite(r.status) ? { status: r.status } : {}), ...(auto ? { auto: true } : {}) } }); // v2.775: 상태코드·자동 여부
    return r;
  });
  return settled.map((s, i) => (s.status === 'fulfilled' ? s.value
    : { id: list[i].id, name: list[i].name, ok: false, reason: String(s.reason?.message || s.reason || '푸시 실패').slice(0, 300) }));
}
