/**
 * portalcheck/edgeReport.js — **엣지에서** 도는 토큰 자기보고(v2.560).
 *
 * 요구 ③('중앙에 등록된 엣지의 토큰과 엣지에 저장된 토큰이 동일한지')은 축이 둘이고,
 * 한쪽은 중앙이 **구조적으로 답할 수 없다**:
 *   · 수집 토큰(중앙→엣지): 중앙이 평문을 갖고 있어 `tokenProbe` 의 200 이 **동일성을 증명**한다.
 *   · 중앙 토큰(엣지→중앙): 중앙은 **SHA-256 해시만** 보관한다(`central/agentTokens.js:72`).
 *     ⇒ 이 파일이 없으면 그 축은 영원히 `확인 불가` 다.
 *
 * ── 이 파일이 답하는 것 ─────────────────────────────────────────────────────
 * ① 이 엣지가 자기 `/api/collector` 에 요구하는 토큰의 **지문**(중앙 등록값과 눈으로 대조)
 * ② 이 엣지가 중앙에 보내는 토큰의 **지문** + **실제 인증 결과**
 *    ★ `GET /api/central/health-probe` 를 자기 토큰으로 호출해 중앙이 돌려주는 `yourAgent` 를 본다.
 *      `yourAgent === 이 엣지 이름` 이면 **중앙이 발급한 개별 토큰과 정확히 같다는 증명**이다
 *      (해시를 보내지 않고 동일성을 확정하는 유일한 길). 403 이면 **확실히 다르다**.
 * ③ 이 엣지가 **한 값을 두 용도로** 쓰는가(`EDGE_MODE=all` 기본 구성 — 요구 ① 중복의 한 종류)
 * ④ 이 엣지가 **또 다른 중앙이 되어 있는가**(`CENTRAL_TOKEN` 설정 → 자기 `/api/central` 개방)
 *
 * ── 유출 방지(되돌리지 말 것) ────────────────────────────────────────────────
 * ⚠⚠ 올리는 것은 **8자 지문 + 길이 + 앞뒤공백 플래그**뿐이다. **전체 해시를 싣지 말 것** —
 *   그 값이 곧 `central-agent-tokens.json` 의 저장값이고(= 그것만으로 인증 위조 판정을 통과할
 *   자료), 사람이 정한 공유 토큰이라면 **오프라인 사전 공격**이 성립한다.
 *   `util/tokenFingerprint.js` 는 전체 해시 함수를 export 하지 않는다 — 그것이 집행부다.
 * ⚠ 이 응답은 `COLLECTOR_TOKEN` 게이트 뒤에 있고(`routes/collector.js`) 중앙 화면은
 *   adminOnly + fullScopeOnly 다(`routes/api/portalCheck.js`). 셋을 같이 지킬 것.
 */

import os from 'node:os';
import { config, currentVersion } from '../config.js';
import { tokenFingerprintParts, sameToken } from '../util/tokenFingerprint.js';
import { hygieneOf } from './tokenScan.js';
import { readJsonCapped } from '../util/readCapped.js'; // v2.604: 응답 크기 상한
import { strOf } from '../util/coercionTrap.js';

// v2.604: 응답 값이 객체면 String() 이 던진다 — 글자·수·불리언만(strOf).
const t = (v) => strOf(v, 4096).trim();

/** 자기보고에 담는 토큰 1건의 공개 형태 — **평문·전체 해시 없음**. */
export function tokenFacts(raw) {
  const p = tokenFingerprintParts(raw);
  return { set: p.set, short: p.short, len: p.len, space: p.space, hygiene: hygieneOf(raw) };
}

/**
 * 중앙에 자기 토큰으로 두드려 '중앙이 나를 누구로 보는가' 를 확인한다(요구 ③ 중앙 축).
 *
 * ⚠ 표적은 `/api/central/health-probe` 다 — v2.552 가 이 용도로 만든 **경량 무부하** 경로이고
 *   응답에 다른 엣지 정보가 없다. 인벤토리·설정 pull 같은 무거운 경로를 쓰지 말 것.
 * ⚠ **재시도 0** — '되는가' 를 보는 것이고 재시도는 판정을 흐린다. 실패해도 예외를 던지지 않고
 *   사유를 돌려준다(자기보고 전체가 실패하면 중앙이 아무것도 못 본다).
 */
export async function selfProbeCentral({ fetchImpl = null, timeoutMs = 10_000 } = {}) {
  const url = t(config.agent.centralUrl);
  /*
   * ⚠ **토큰을 trim 하지 않는다.** `config.js` 는 env 를 그대로 담고 중앙의 검사는 전체 문자열
   *   비교다 — 여기서 다듬으면 '앞뒤 공백 때문에 거부되는' 바로 그 사고를 이 점검이 **덮어 버린다**.
   *   (fetch 는 헤더 값의 앞뒤 공백을 정규화해 보내므로, 공백이 있으면 실제로 거부된다.)
   */
  const token = String(config.agent.centralToken ?? '');
  if (!url) return { ran: false, reason: 'CENTRAL_URL 이 설정되지 않았습니다 — 이 엣지는 중앙으로 보고하지 않습니다.' };
  if (token === '') return { ran: false, reason: 'CENTRAL_TOKEN(EDGE_TOKEN) 이 설정되지 않았습니다 — 중앙에 인증할 값이 없습니다.' };
  const doFetch = fetchImpl || (await import('../util/resilientFetch.js')).resilientFetch;
  const t0 = Date.now();
  let res = null;
  try {
    res = await doFetch(`${url.replace(/\/+$/, '')}/api/central/health-probe`, {
      headers: { Accept: 'application/json', 'X-Central-Token': token, 'X-Agent-Name': t(config.agent.name) },
      timeoutMs, retries: 0,
    });
  } catch (e) {
    const msg = String(e?.message || e);
    return { ran: true, ok: false, ms: Date.now() - t0, kind: /timeout|timed out|abort/i.test(msg) ? 'timeout' : 'unreachable', reason: msg.slice(0, 300) };
  }
  const ms = Date.now() - t0;
  let body = null;
  // v2.604(감사 CEN2604-01 형제): 중앙 응답도 상한까지만 읽는다(health-probe 본문은 수백 바이트).
  try { body = await readJsonCapped(res, 64 * 1024, '중앙 health-probe 응답'); } catch { body = null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) body = null;
  if (res.status === 403 || res.status === 401) {
    return { ran: true, ok: false, ms, status: res.status, kind: 'rejected', reason: t(body?.reason) || '중앙이 이 엣지의 토큰을 거부했습니다.' };
  }
  if (res.status === 404) {
    return { ran: true, ok: false, ms, status: 404, kind: 'central-disabled', reason: t(body?.reason) || '중앙의 central 엔드포인트가 비활성입니다.' };
  }
  if (!res.ok) return { ran: true, ok: false, ms, status: res.status, kind: 'http', reason: `HTTP ${res.status}` };
  return {
    ran: true, ok: true, ms, status: 200,
    /** 개별 토큰이면 중앙이 해석한 이름. 공유 토큰이면 **빈 값**이고 그것 자체가 진단이다. */
    yourAgent: t(body?.yourAgent),
    tokenMode: t(body?.tokenMode) || '',
    centralVersion: t(body?.version),
    centralInstance: t(body?.instance),
  };
}

/**
 * 이 엣지의 토큰 자기보고 한 통.
 *
 * @returns 평문·전체 해시가 **없는** 객체. 중앙(`central/tokenCheckPull.js`)이 그대로 보관한다.
 */
export async function buildTokenCheckEnvelope({ selfProbe = true, fetchImpl = null, timeoutMs = 10_000 } = {}) {
  /*
   * ⚠⚠ **여기서 trim 하지 말 것**(v2.560 자체 검증에서 잡은 결함): 초판은 `t()` 로 다듬어
   *   `' tok '`(12자·공백 있음)을 `len:10 · space:false` 로 보고했다 — **오류 없이 틀린 값**이고,
   *   하필 이 점검이 가장 잡고 싶은 사고(붙여넣기 공백 → 전체 문자열 비교 실패)를 **숨겼다**.
   *   `tokenMatches`(`util/secureCompare.js`)·중앙의 해시 비교는 모두 **원문 전체**를 본다.
   */
  const collectorTok = String(config.collector.token ?? '');
  const centralSendTok = String(config.agent.centralToken ?? '');
  // 이 엣지가 **자기** `/api/central` 에 요구하는 값(설정돼 있으면 이 엣지가 또 다른 중앙이다).
  const centralGateTok = String(config.central.token ?? '');

  let hasLocalAgentTokens = false;
  try {
    const m = await import('../central/agentTokens.js');
    hasLocalAgentTokens = m.hasAnyAgentToken();
  } catch { hasLocalAgentTokens = false; }

  const probe = selfProbe ? await selfProbeCentral({ fetchImpl, timeoutMs }) : { ran: false, reason: '요청에서 자기확인을 끄고 조회했습니다.' };

  return {
    at: Date.now(),
    node: {
      agent: t(config.agent.name),
      hostname: os.hostname(),
      version: currentVersion(),
      datacenter: t(config.collector.datacenter),
      centralUrl: t(config.agent.centralUrl),
    },
    tokens: {
      /** 이 엣지의 `/api/collector` 게이트 값 — 중앙 등록값과 대조한다. */
      collector: tokenFacts(collectorTok),
      /** 이 엣지가 중앙에 **보내는** 값. */
      centralSend: tokenFacts(centralSendTok),
      /** 이 엣지가 **자기** `/api/central` 에 요구하는 값(설정돼 있으면 안 되는 쪽). */
      centralGate: tokenFacts(centralGateTok),
      /**
       * 한 값이 두 용도인가(요구 ① 중복의 한 종류 — `EDGE_MODE=all` 기본 구성).
       * ⚠ 비교는 **이 엣지 안에서 전체 해시로** 한다(`sameToken`). 지문 8자 비교로 바꾸지 말 것.
       * ⚠ 한쪽이라도 미설정이면 `null`(모른다) — `false`(다르다)로 뭉개지 않는다.
       */
      collectorEqualsCentralSend: sameToken(collectorTok, centralSendTok),
      centralGateEqualsCentralSend: sameToken(centralGateTok, centralSendTok),
    },
    /**
     * 이 엣지가 또 다른 중앙으로 동작하는가. `config.js:29-31` 이 밝힌 대로 엣지에서는
     * `EDGE_TOKEN` 을 써야 이 값이 비어 `/api/central` 이 열리지 않는다.
     */
    centralRole: {
      enabled: centralGateTok !== '' || hasLocalAgentTokens,
      byEnv: centralGateTok !== '',
      byIssuedTokens: hasLocalAgentTokens,
    },
    selfProbe: probe,
  };
}
