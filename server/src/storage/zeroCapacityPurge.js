/**
 * storage/zeroCapacityPurge.js — 0 바이트 용량 이력 1회 정리(v2.541).
 *
 * 배경(사용자 신고 2026-09-17, Unity `OC2-unity-03` · 호스트 10.94.41.237): SSH 인증 실패로
 * **모든 섹션이 '건너뜀'** 인 장비인데 장비 상세의 용량 추이가 `0.0 TB` 짜리 선으로 그려지고
 * 있었다. 실패 스냅샷의 `capacity` 초기값(`types.js emptySnapshot` → `{totalBytes:0}`)이
 * 그대로 적재되면 그렇게 된다.
 *
 * ⚠ **현재 코드에는 그 경로가 없다**(확인함): 용량 1점을 쓰는 곳은 `storage/poller.js:98`
 * 과 `central/storageEdge.js:46` 둘뿐이고 **둘 다** `db.saveCapacityPoint` 를 거치며,
 * 그 함수는 v2.531 의 `capacityPointEligible()`(전체 용량이 유한한 양수일 때만 적재)에서
 * 막힌다. 즉 남아 있는 0 행은 **그 가드가 배포되기 전에** 쌓인 것이다 — 다만 '언제 쌓였나'
 * 는 화면만으로 확정하지 못했으므로(정직 기록) 원인을 지어내지 않고 **정리만** 한다.
 *
 * ⚠ 지키는 것:
 *  - **행 단위**로 지운다(`total_bytes` 가 없거나 0 이하). 장비 이력을 통째로 지우는
 *    `capacityBasisMigration`(v2.534, 측정 기준이 바뀌어 옛 값이 뜻을 잃은 경우)과 다르다.
 *    유효한 값이 섞여 있는 장비는 그 값을 잃지 않는다.
 *  - `storage_meta` 마커로 **1회만** 실행한다(재기동마다 돌 필요가 없다).
 *  - 지운 사실을 장비별로 남겨 증가량 화면이 **'이력 정리'** 배지를 띄운다(조용한 삭제 금지).
 *  - 실패해도 기동을 막지 않는다(경고만).
 */
import { purgeZeroCapacityRows } from './db.js';

/** 이 정리의 식별자. 바꾸면 **다시 돈다** — 같은 종류의 오염이 또 생겼을 때만 올릴 것. */
export const PURGE_ID = 'zero-capacity-rows-2541';

export async function runZeroCapacityPurge() {
  return purgeZeroCapacityRows({
    once: PURGE_ID,
    reason: '수집 실패 스냅샷에서 들어온 0 바이트 용량 행 제거(v2.541)',
  });
}
