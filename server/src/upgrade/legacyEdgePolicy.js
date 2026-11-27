/**
 * upgrade/legacyEdgePolicy.js — 옛 방식 엣지 목록(env UPGRADE_EDGES · upgrade.json `edges`)의 **전송 판정**(보안 잔여 11-27 L2).
 *
 * 왜: 이 목록의 엣지에는 중앙이 그 엣지의 **관리자 토큰**(Authorization: Bearer)과 업그레이드 번들을 보낸다(upgrade.js pushBundleToEdge —
 *   주기 동기화 edgeSync.js · 적용 직후 manager.pushToEdges). 수집 서버 등록부는 S-09(collector/transportPolicy.js)로 원격 평문 HTTP 를
 *   승인된 예외만 받는데, 이 목록은 형식·SSRF 만 보고 평문 http:// 로도 토큰을 실어 보냈다.
 *
 * 판정은 등록부와 **같은 함수**(evaluateCollectorUrl) 하나 — https · 루프백 http · 운영자 허용 목록(COLLECTOR_HTTP_ALLOW)만 통과.
 *   - `existing` 을 주지 않는다: S-09 ⓐ '저장값과 같은 URL' 승계는 이 목록에 쓰지 않는다 — 목록 전체가 운영자 설정(파일·env)이라
 *     승계하면 정책이 없는 것과 같고, 실리는 비밀이 수집 토큰이 아니라 엣지 관리자 토큰이다.
 *   - ctx.source 'internal' — 관리자 화면 예외(allowInsecureHttp)는 이 경로에 없다(edges 를 저장하는 API 가 없다).
 *   - 해석할 수 없는 URL · http(s) 가 아닌 스킴은 **거부**(fail-closed — urlTransport 는 파싱 실패를 '안전' 으로 돌려주므로 여기서 먼저 막는다).
 *
 * edgeSync.js 는 upgrade.js 를 import 한다 — 싱크(upgrade.js)도 이 판정을 쓰려면 별도 모듈이어야 순환이 없다.
 */
import { evaluateCollectorUrl, urlTransport, INSECURE_HTTP_CODE } from '../collector/transportPolicy.js';

export const LEGACY_EDGE_INVALID_CODE = 'invalid-url';

export const LEGACY_EDGE_INSECURE_REASON = '평문 HTTP 라 보내지 않습니다 — 이 엣지의 관리자 토큰과 업그레이드 번들이 암호화되지 않은 채 전송됩니다. '
  + '엣지에 TLS(TLS_CERT_FILE·TLS_KEY_FILE)를 켜고 엣지 목록(UPGRADE_EDGES 또는 upgrade.json 의 edges) 주소를 https:// 로 바꾸세요. '
  + 'VPN·IPsec 처럼 보호된 구간이라 HTTP 가 꼭 필요하면 중앙 portal.env 의 COLLECTOR_HTTP_ALLOW 에 이 주소를 넣으세요'
  + '(수집 서버 평문 예외와 같은 목록이라 그 주소의 평문 HTTP 수집 서버 등록도 함께 허용됩니다).';

export const LEGACY_EDGE_INVALID_REASON = 'http(s) URL 이 아니어서 보내지 않습니다';

/**
 * 이 URL 로 엣지 관리자 토큰·번들을 보내도 되는가(순수 — 던지지 않는다).
 * @returns {null | {code:string, reason:string}} null = 보내도 된다(https · 루프백 http · 허용 목록 http)
 */
export function legacyEdgeTransportIssue(url, env = process.env) {
  const t = urlTransport(url);
  if (!t.valid || (t.scheme !== 'http' && t.scheme !== 'https')) return { code: LEGACY_EDGE_INVALID_CODE, reason: LEGACY_EDGE_INVALID_REASON };
  // 보안 잔여 11-27 L2: 수집 서버 등록부(S-09)와 같은 판정 — 승계(existing) 없음 · 관리자 예외 없음 · 허용 목록만
  const v = evaluateCollectorUrl({ url, existing: null, body: {}, ctx: { source: 'internal' }, env });
  return v.ok ? null : { code: INSECURE_HTTP_CODE, reason: LEGACY_EDGE_INSECURE_REASON };
}

/** 동기화 결과에 싣는 한 줄 — 뺀 옛 방식 엣지가 있다는 사실(조용히 '할 일 없음' 으로 끝내지 않는다). 없으면 null. */
export function legacyDroppedNote(dropped) {
  const list = Array.isArray(dropped) ? dropped.filter((d) => d && typeof d === 'object') : [];
  if (!list.length) return null;
  const k = list.filter((d) => d.code === INSECURE_HTTP_CODE).length;
  return `설정의 옛 방식 엣지 ${list.length}곳은 보내지 않았습니다${k ? `(평문 HTTP ${k}곳)` : ''} — 사유는 ‘동기화에서 뺀 옛 방식 엣지’ 줄을 보세요`;
}
