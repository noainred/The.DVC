/**
 * util/bundleSha.js — 업그레이드 번들 바이트의 sha256(같은 Buffer 는 한 번만 계산).
 * v2.899(점검 P2): 엣지 자동 업그레이드 동기화가 돌 때마다 번들(수십 MB)을 동기로 읽고, 서명 판정과 push 헤더에서
 * sha256 을 **두 번** 계산했다(WeakMap 캐시가 수집 서버 push 모듈 안에만 있어 서명 판정 쪽 해시와 나눠 쓰지 못했다).
 * 키는 Buffer 객체 그 자체(WeakMap — 바이트를 붙잡지 않는다). 내용을 바꾼 Buffer 를 다시 넣지 말 것(번들 바이트는 읽은 뒤 바꾸지 않는다).
 */
import { createHash } from 'node:crypto';

const _cache = new WeakMap();
export function bundleSha(bytes) {
  if (!bytes || typeof bytes !== 'object') return createHash('sha256').update(bytes ?? '').digest('hex');
  let v = _cache.get(bytes);
  if (!v) { v = createHash('sha256').update(bytes).digest('hex'); _cache.set(bytes, v); }
  return v;
}
