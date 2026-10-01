/**
 * agent/agentNameCarry.js — 엣지 → 중앙 요청에 **자기 이름** 을 싣는 한 벌(v2.629 감사 A6-01).
 *
 * v2.620 이 util/agentNameHeader.js 를 만들며 9개 워커만 옮겼고, 나머지 약 20곳은 `'X-Agent-Name': config.agent.name`
 * 원문을 그대로 실었다. HTTP 헤더 값은 ByteString 이라 AGENT_NAME(기본 COLLECTOR_DATACENTER·hostname)에 한글 등
 * U+00FF 초과 문자가 있으면 fetch 가 **요청 자체를 던져** 그 push·pull 이 전량 실패했다.
 *
 * 계약(util/agentNameHeader.js 머리말 그대로):
 *  - 헤더는 인쇄 가능한 ASCII 64자 이내일 때만 싣는다 — 값을 자르거나 바꾸지 않는다(개별 토큰 바인딩 대조).
 *  - 헤더를 못 싣는 이름이면 URL 에 `?agent=<encodeURIComponent>` 를 붙인다. 중앙 routes/central.js requestedAgent 는
 *    **query → 헤더 → 본문** 순서로 보므로 같은 값이 가장 먼저 읽힌다. 이미 `agent=` 쿼리를 싣는 URL 은 그대로 둔다.
 *    (POST 도 붙인다 — ping·capture·bmstor 결과처럼 본문에 agent 가 없는 요청이 있고, 큰 본문 게이트는 본문을
 *    읽기 전에 헤더·쿼리로 요청자를 가린다. 본문 agent 가 있는 요청에서도 같은 값이라 판정이 바뀌지 않는다.)
 */
import os from 'node:os';
import { agentNameHeader } from '../util/agentNameHeader.js';

/** `{ 'X-Agent-Name': name }` 또는 `{}`(헤더로 안전하지 않은 이름·빈 이름). */
export function agentHeaders(name) { return agentNameHeader(name); }

/** 헤더에 실리지 않는 비어 있지 않은 이름이면 URL 에 agent 쿼리를 붙인다. 이미 agent 쿼리가 있으면 그대로. */
export function withAgentQuery(url, name) {
  if (typeof name !== 'string' || !name.trim()) return url;
  if (agentNameHeader(name)['X-Agent-Name']) return url;
  if (/[?&]agent=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}agent=${encodeURIComponent(name)}`;
}

/**
 * v2.681(감사 R2F-01): `X-Agent-Hostname` 도 같은 ByteString 함정이다 — `os.hostname()` 에 U+00FF 초과 문자가 있으면
 * (한글 이름 Windows 엣지 등) undici 가 요청을 보내기 **전에** 던져 인벤토리·스파이크·게스트 디스크·현재 사용자 push 가
 * 매 주기 전량 실패했다. 중앙은 이 헤더를 **진단용으로만** 읽는다(이름 충돌 감지 · 큰 본문 게이트의 폴백 신원) —
 * 그래서 인쇄 가능한 ASCII 면 원문 그대로, 아니면 `encodeURIComponent` 값(ASCII — 같은 호스트는 같은 값이라 충돌 감지가
 * 계속 동작한다)을 싣고, 그래도 255자를 넘거나 비면 싣지 않는다(헤더가 없어도 중앙 수신 판정은 바뀌지 않는다).
 */
export function hostnameHeaderValue(raw) {
  const h = typeof raw === 'string' ? raw.trim() : '';
  if (!h) return '';
  if (/^[\x20-\x7e]{1,255}$/.test(h)) return h;
  let enc = '';
  try { enc = encodeURIComponent(h); } catch { return ''; } // 짝 없는 서로게이트
  return enc.length <= 255 ? enc : '';
}

/** `{ 'X-Agent-Hostname': … }` 또는 `{}`. 인자가 없으면 이 장비의 os.hostname(). */
export function agentHostnameHeader(raw = os.hostname()) {
  const v = hostnameHeaderValue(raw);
  return v ? { 'X-Agent-Hostname': v } : {};
}
