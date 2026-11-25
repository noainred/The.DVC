/**
 * util/clampEdgeTs.js — 엣지가 보낸 시각을 **수신 시각으로 자른다**(루트 CLAUDE.md ‘엣지 시각은 수신 시각으로 자르고 원본은 따로’ · v2.682 R3S-01).
 *   본체는 원래 `routes/api/corpUsage.js` 에 있었다 — v2.919 에 중앙 정제(central/bmPerfSanitize.js)도 쓰게 되어 util 로 옮겼다
 *   (central → routes 의존을 만들지 않게). corpUsage 는 같은 이름을 다시 내보낸다.
 * 시계가 앞선 엣지의 미래 시각을 그대로 두면 ‘방금 읽음’ 으로 보이고 신선도 판정이 영원히 참이 된다. 못 읽으면 null.
 */
import { numOrNull } from './numOrNull.js';

export function clampEdgeTs(ts, receivedAt) {
  const v = numOrNull(ts);
  const at = numOrNull(receivedAt);
  if (v == null) return null;
  return at != null && v > at ? at : v;
}
