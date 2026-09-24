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
import { readJsonCapped, EDGE_RESPONSE_MAX_BYTES } from '../util/readCapped.js'; // v2.604: 엣지 응답 크기 상한
import { strOf } from '../util/coercionTrap.js';
import { withOutboundTag } from '../util/outboundStats.js'; // v2.601 WEB2601-02: 같은 주소 엣지를 기록에서 나눈다
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
export function pushIdracScan(agent, { ips, username, password, vcenterId = '', datacenterId = '', noRegister = false, mode = 'merge', service = '', trigger = 'manual', rangeId = '' } = {}) {
  const col = findCollectorForAgent(agent);
  if (!col || !col.url) {
    return { ok: false, reason: `에이전트 '${agent}'에 매칭되는 '수집 서버(원격)' URL이 없습니다. 설정 → 수집 서버(원격)에 이 에이전트를 URL과 함께 등록하면 중앙이 직접 스캔을 전송할 수 있습니다.` };
  }
  // URL 끝 슬래시 제거(연결 테스트와 파리티) — '.../:4000/' 저장 시 PUSH가 '//api/...' 이중
  // 슬래시로 깨지던 것을 방지. 저장 값을 바꾸지 않고 요청 시점에만 정규화한다.
  const edgeUrl = String(col.url).replace(/\/+$/, '');
  const reqId = createPushScanJob(agent, { ips, username, password, vcenterId, datacenterId, noRegister, mode, edgeUrl, service, trigger, rangeId });
  if (!reqId) return { ok: false, reason: '진행 중 잡이 너무 많습니다. 잠시 후 다시 시도하세요.' };

  // 백그라운드 전송(요청 즉시 반환 — UI는 reqId로 폴링).
  (async () => {
    try {
      const r = await withOutboundTag(col.id || col.name || agent, () => resilientFetch(`${edgeUrl}/api/collector/idrac-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(col.token ? { 'X-Collector-Token': col.token } : {}) },
        // v2.591(감사 F3): trigger·rangeId — 엣지가 주기 스캔이면 인증 정지 IP 를 건너뛴다(구버전 엣지는 무시 → 전부 시도).
        body: JSON.stringify({ ips, username, password, noRegister, vcenterId, datacenterId, mode, trigger: trigger === 'periodic' ? 'periodic' : 'manual', rangeId: String(rangeId || '') }),
        timeoutMs: PUSH_TIMEOUT_MS, retries: 1,
      }));
      if (!r.ok) {
        // v2.440: 상태코드별로 원인이 갈린다 — 실측으로 확인한 규칙이다.
        //   403 = collector 라우터에 도달했고 **토큰이 틀림**
        //   401 = 그 경로가 **없어서** collector 라우터를 지나 일반 인증 미들웨어로 떨어짐
        //         → 엣지가 구버전(PUSH 스캔 엔드포인트 미탑재). 토큰 문제가 아니다.
        //   404 = collector 비활성(COLLECTOR_TOKEN 미설정) 또는 경로 없음
        // 예전에는 401 에 힌트가 없어 'URL/토큰/버전을 확인하세요' 로 셋을 나열했고, 실제 원인이
        // 버전인데 사용자가 토큰부터 뒤지게 만들었다.
        // ⚠ 이 오류 문자열에는 마크다운(**강조**)을 쓰지 말 것 — 이벤트 타임라인·로그·알림 등
        //   렌더러가 없는 경로로도 흐르므로 별표가 그대로 노출된다(v2.440 실제 발생).
        //   강조가 필요한 안내는 remedy 카드(scanRemedy.js)에만 둔다.
        const hint = r.status === 403 ? ' — 수집 서버 토큰(X-Collector-Token) 불일치입니다. 설정 › 엣지 노드 포탈 설치 › 수집 서버 연결 상태의 [진단]으로 어느 값이 통하는지 확인한 뒤 정렬하세요.'
          : r.status === 401 ? ' — 이 엣지에 PUSH 스캔 엔드포인트(/api/collector/idrac-scan)가 없습니다. 경로가 없어 인증 라우터가 401 을 낸 것으로, 토큰 문제가 아니라 엣지가 구버전입니다. 설정 › 수집 서버(원격)에서 이 엣지 버전을 확인하고 [업그레이드]하거나, 스캔 방식을 에이전트 폴링으로 바꾸세요.'
            : r.status === 404 ? ' — 엣지의 collector 기능이 꺼져 있거나(COLLECTOR_TOKEN 미설정) 경로가 없습니다.'
              : '';
        setIdracScanResult(reqId, { error: `엣지 응답 HTTP ${r.status}${hint}`, httpStatus: r.status });
        return;
      }
      // v2.604(감사 CEN2604-01 형제): 상한까지만 읽는다. 객체가 아니면 형식 오류, 사유는 글자만.
      let data = null;
      try { data = await readJsonCapped(r, EDGE_RESPONSE_MAX_BYTES, '엣지 스캔 응답'); } catch (e) { setIdracScanResult(reqId, { error: `엣지 스캔 응답을 읽지 못했습니다: ${String(e?.message || e).slice(0, 200)}` }); return; }
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.ok === false) { setIdracScanResult(reqId, { error: strOf(data?.reason, 500) || '엣지 스캔 실패(형식 오류)' }); return; }
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
