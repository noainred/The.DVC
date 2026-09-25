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
import { reqTimeoutMs } from '../agent/envTimeout.js';
import { readJsonCapped, EDGE_RESPONSE_MAX_BYTES } from '../util/readCapped.js'; // v2.604: 엣지 응답 크기 상한
import { strOf } from '../util/coercionTrap.js';
import { withOutboundTag } from '../util/outboundStats.js'; // v2.601 WEB2601-02: 같은 주소 엣지를 기록에서 나눈다
import { loadCollectors } from '../collector/registry.js';
import { pullCollectorByAgent } from '../collector/puller.js';
import { createPushScanJob, setIdracScanResult } from './idracScanJobs.js';
import { allCollectorStatus } from '../collector/state.js';
import { cmpVersion } from '../util/cmpVersion.js';

/**
 * v2.611(감사 EDGE2611-01·03 = RECENT2611-03): iLO 스캔을 이해하는 엣지 최소 버전.
 *   v2.609 이하 엣지는 잡의 `ilo` 를 모르고 username/password 만 쓴다. iLO 전용 대역(Dell 계정 없음)은 그 둘이 빈 문자열이라
 *   구버전 엣지가 **빈 계정(`Basic Og==`)과 세션 POST 로 대역의 Dell·HPE 전 호스트에 로그인**했다(재현). 계정 없는 벤더에는
 *   로그인하지 않는다(v2.610 규약)의 정반대다. 버전 근거는 `collector/state.js` 의 수집 서버 상태(엣지 export·자기등록이 채운다 —
 *   routes/api/partFaults.js classifyEdges 와 같은 원천).
 */
export const MIN_ILO_EDGE_VERSION = '2.610.0';

/** 담당 엣지의 버전(수집 서버 상태 기준). 모르면 ''. 인메모리라 중앙 재시작 직후(첫 pull 전)에는 모른다. */
export function edgeVersionOf(agent) {
  const col = findCollectorForAgent(agent);
  if (!col) return '';
  try { const v = allCollectorStatus()?.[col.id]?.version; return typeof v === 'string' ? v.trim() : ''; }
  catch { return ''; }
}

/**
 * 위임 전 판정(순수). iLO 계정이 없는 대역은 언제나 위임한다(예전 동작).
 *  - iLO 전용(Dell 계정 없음) + 엣지 버전이 2.610 미만이거나 **미상** → 위임하지 않는다(held). 보냈다가 빈 계정 로그인이 나는
 *    쪽이 보류보다 나쁘다. 미상은 중앙 재시작 직후 첫 pull 전·수집 서버 미등록 엣지에서 생긴다 — 사유가 그 사실을 말한다.
 *  - Dell+iLO + 구버전(버전을 **아는** 경우) → 위임하되 iLO 는 적용되지 않음을 note 로 남긴다(Dell 계정으로 예전 동작).
 *    미상이면 note 를 달지 않는다 — 실제 적용 여부는 회신의 iloEnabled 유무로 가린다(idracScanJobs iloIgnoredByEdge).
 * ⚠ 이 문구는 lastRun·이벤트·로그로 흐른다 — `**`·백틱 금지.
 */
export function iloEdgeGate({ hasDell = false, hasIlo = false, version = '' } = {}) {
  if (!hasIlo) return { delegate: true };
  const c = cmpVersion(version, MIN_ILO_EDGE_VERSION);
  if (c != null && c >= 0) return { delegate: true };
  const known = c != null;
  const verText = known ? `엣지 버전 ${version}` : '엣지 버전 미상(수집 서버 상태에 버전이 없음 — 중앙 재시작 직후이거나 수집 서버(원격)로 등록되지 않은 엣지)';
  if (!hasDell) {
    return {
      delegate: false, held: true, edgeVersion: version || '',
      reason: `위임 보류 — HPE iLO 계정만 있는 대역인데 담당 엣지가 iLO 스캔(2.610 이상)을 지원하는지 확인하지 못했습니다(${verText}). 구버전 엣지에 보내면 빈 계정으로 대역의 모든 서버에 로그인합니다. 엣지를 2.610 이상으로 업그레이드하면 다음 스캔부터 위임합니다.`,
    };
  }
  if (!known) return { delegate: true };
  return { delegate: true, iloIgnored: true, edgeVersion: version, note: `담당 엣지 ${version} 은 iLO 스캔을 지원하지 않습니다(2.610 이상 필요) — 이번 스캔은 Dell(iDRAC) 계정으로만 수행되고 HPE 는 미지원 서버로 남습니다.` };
}

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
// v2.605(감사 TIM2605-04): [1초, 2시간] — 음수·2^31 초과가 즉시 중단(1ms)이 되지 않게.
const PUSH_TIMEOUT_MS = reqTimeoutMs(process.env.IDRAC_PUSH_TIMEOUT_MS, 15 * 60_000, { max: 2 * 3_600_000 });

/**
 * PUSH 스캔 시작. 성공 시 { ok, reqId }를 즉시 반환하고, 실제 전송/결과 반영은 백그라운드에서 진행한다.
 * 매칭되는 수집 서버 URL이 없으면 { ok:false, reason }.
 */
export function pushIdracScan(agent, { ips, username, password, ilo = null, vcenterId = '', datacenterId = '', noRegister = false, mode = 'merge', service = '', trigger = 'manual', rangeId = '' } = {}) {
  const col = findCollectorForAgent(agent);
  if (!col || !col.url) {
    return { ok: false, reason: `에이전트 '${agent}'에 매칭되는 '수집 서버(원격)' URL이 없습니다. 설정 → 수집 서버(원격)에 이 에이전트를 URL과 함께 등록하면 중앙이 직접 스캔을 전송할 수 있습니다.` };
  }
  // URL 끝 슬래시 제거(연결 테스트와 파리티) — '.../:4000/' 저장 시 PUSH가 '//api/...' 이중
  // 슬래시로 깨지던 것을 방지. 저장 값을 바꾸지 않고 요청 시점에만 정규화한다.
  const edgeUrl = String(col.url).replace(/\/+$/, '');
  // v2.611(EDGE2611-03): push 경로도 같은 버전 게이트 — iLO 전용 대역을 구버전 엣지에 보내지 않는다.
  const hasIlo = Boolean(ilo && ilo.username && ilo.password);
  const hasDell = Boolean(String(username || '').trim() && password);
  const gate = iloEdgeGate({ hasDell, hasIlo, version: edgeVersionOf(agent) });
  if (!gate.delegate) return { ok: false, held: true, reason: gate.reason, edgeVersion: gate.edgeVersion };
  const reqId = createPushScanJob(agent, { ips, username, password, ilo, vcenterId, datacenterId, noRegister, mode, edgeUrl, service, trigger, rangeId });
  if (!reqId) return { ok: false, reason: '진행 중 잡이 너무 많습니다. 잠시 후 다시 시도하세요.' };

  // 백그라운드 전송(요청 즉시 반환 — UI는 reqId로 폴링).
  (async () => {
    try {
      const r = await withOutboundTag(col.id || col.name || agent, () => resilientFetch(`${edgeUrl}/api/collector/idrac-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(col.token ? { 'X-Collector-Token': col.token } : {}) },
        // v2.591(감사 F3): trigger·rangeId — 엣지가 주기 스캔이면 인증 정지 IP 를 건너뛴다(구버전 엣지는 무시 → 전부 시도).
        // v2.610: ilo — HPE iLO 계정(있을 때만). 구버전 엣지는 이 필드를 무시하고 Dell 만 찾는다(HPE 는 미지원 서버로 남는다).
        body: JSON.stringify({ ips, username, password, ...(ilo && ilo.username && ilo.password ? { ilo: { username: ilo.username, password: ilo.password } } : {}), noRegister, vcenterId, datacenterId, mode, trigger: trigger === 'periodic' ? 'periodic' : 'manual', rangeId: String(rangeId || '') }),
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
        // v2.611(EDGE2611-03): 비-2xx 도 본문의 사유(reason)를 읽는다(상한 64KB·글자만). 예전에는 'HTTP 400' 만 남아
        //   v2.609 엣지가 iLO 전용 대역을 'ips/username/password가 필요합니다' 로 거부한 사실이 보이지 않았다.
        let bodyReason = '';
        try { const b = await readJsonCapped(r, 65_536, '엣지 오류 응답'); bodyReason = strOf(b?.reason, 300) || strOf(b?.error, 300) || ''; } catch { /* 본문 없음·JSON 아님 */ }
        const oldEdge400 = r.status === 400 && hasIlo && !hasDell
          ? ' — iLO 전용 대역(Dell 계정 없음)을 이 엣지가 거부했습니다. 엣지가 2.610 미만이면 iLO 스캔을 모릅니다 — 엣지를 업그레이드하세요.' : '';
        setIdracScanResult(reqId, { error: `엣지 응답 HTTP ${r.status}${bodyReason ? ` (${bodyReason})` : ''}${hint}${oldEdge400}`, httpStatus: r.status });
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

  return { ok: true, reqId, ...(gate.iloIgnored ? { iloNote: gate.note, edgeVersion: gate.edgeVersion } : {}) };
}
