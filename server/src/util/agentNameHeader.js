/**
 * util/agentNameHeader.js — 엣지 → 중앙 push 에 `X-Agent-Name` 헤더를 싣는다(v2.620 RECENT2620-02).
 *
 * 왜: 중앙의 큰 본문 게이트(util/bigJsonGate.js)는 **본문을 읽기 전에** 요청자를 가려야 하는데, 인벤토리·게스트 디스크·fleet·
 *   GPU 게스트·스토리지·PDU·스캔 결과·로그 결과 push 는 이름을 본문에만 실었다. 그래서 공유 토큰 엣지 여럿이 같은 출발 IP
 *   (NAT·HAProxy 중계)로 오면 요청자 상한 한 칸을 나눠 동시 2건만 들어왔다(재현). 형제 워커(ping·capture·bmstor·svcmon·
 *   curuser·vmseries·SAN)는 v2.591 PR-2 부터 이 헤더를 싣는다.
 *
 * ⚠ HTTP 헤더 값은 ByteString 이라 한글 등 U+00FF 초과 문자가 들어가면 fetch 가 **요청 자체를 던진다**(push 전량 실패).
 *   그래서 인쇄 가능한 ASCII 64자 이내일 때만 싣고, 아니면 싣지 않는다(본문 agent 는 그대로 — 중앙 판정은 예전과 같다).
 *   중앙 바인딩(routes/central.js requestedAgent)은 헤더를 본문보다 먼저 보므로 **본문 agent 와 같은 값**만 실어야 한다 —
 *   자르거나 바꾼 값을 싣지 말 것(개별 토큰 엣지가 '남의 이름' 으로 403 이 된다).
 */
const SAFE = /^[\x21-\x7e](?:[\x20-\x7e]{0,62}[\x21-\x7e])?$/;

/** 이름이 헤더로 안전하면 `{ 'X-Agent-Name': name }`, 아니면 `{}`. */
export function agentNameHeader(name) {
  return typeof name === 'string' && SAFE.test(name) ? { 'X-Agent-Name': name } : {};
}
