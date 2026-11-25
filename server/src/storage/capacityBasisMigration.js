/**
 * storage/capacityBasisMigration.js — 측정 기준이 바뀐 장비의 용량 이력을 1회 재시작(v2.534).
 *
 * 배경: v2.533 까지 VMAX/PowerMax 는 `physicalCapacity` 로 사용량을 적재했는데, V3 플랫폼
 * (VMAX) 응답에서 그 필드는 `used_capacity_gb == total_capacity_gb` 다 — 즉 **모든 이력 행이
 * 100%** 로 쌓였다(사용자 화면 실측: 11대 전부 전체 == 사용). v2.534 는 Dell 이 "데이터 감축
 * 적용 후" 라고 명시한 `system_capacity.usable_used_tb` 로 바꾼다.
 *
 * 그대로 두면 증가량 화면(`storage/growth.js`)이 전환일에 **−수 PB 짜리 거짓 '감소'** 를
 * 보고한다. CLAUDE.md 의 "감소(−)를 0 으로 깎지 않는다" 규칙 때문에 그 값은 그대로 표시된다.
 * 사용자 결정(2026-09-16)은 **해당 장비의 이력만 삭제하고 새 기준으로 다시 쌓기** 다.
 *
 * ⚠ 지키는 것:
 *  - **대상은 vmax·powermax 타입뿐**이다. 다른 수집기의 이력을 건드리지 않는다.
 *  - `storage_meta` 마커로 **1회만** 실행한다(재기동마다 지우면 이력이 영원히 안 쌓인다).
 *  - 지운 사실을 장비별로 기록해 화면이 '관측 N일' 이 왜 짧은지 말하게 한다(조용한 삭제 금지).
 *  - 실패해도 기동을 막지 않는다(경고만) — 이력 정리가 포탈을 못 뜨게 하면 안 된다.
 */
import { listDevices, registryLoadError } from './registry.js';
import { resetCapacityHistory, migrationMarker } from './db.js';
import { PURGE_ID as ZERO_PURGE_ID } from './zeroCapacityPurge.js';
import { numOrNull } from '../util/numOrNull.js';

/** 이 마이그레이션의 식별자. 바꾸면 **다시 지운다** — 새 기준 변경이 있을 때만 올릴 것. */
export const MIGRATION_ID = 'powermax-written-usage-2534';

/** 기준이 바뀐 타입(순수 — 테스트가 고정한다). */
export const AFFECTED_TYPES = Object.freeze(['vmax', 'powermax']);

/** @param {Array<{id:string,type:string}>} devices @returns {string[]} */
export function affectedDeviceIds(devices) {
  return (devices || [])
    .filter((d) => AFFECTED_TYPES.includes(String(d?.type || '').toLowerCase()))
    .map((d) => String(d.id || ''))
    .filter(Boolean);
}

/**
 * 59회차(57회차 F1 업그레이드 경계): 이 장비의 이력은 **전부 새 기준**인가 — 등록 시각(`createdAt`)이 v2.541 0 바이트 정리 마커의 `at`
 *   (그 정리가 이 설치에서 처음 돈 기동 시각 — `once` 마커는 처음 한 번만 쓰인다)보다 늦으면, 그 장비는 이 설치가 이미 v2.541(> v2.534)을
 *   돌린 뒤에 등록됐다 — 옛 기준(v2.533 이하) 행이 있을 수 없다. 둘 중 하나라도 없거나 해석할 수 없으면 false(예전 동작 = 지움 대상) —
 *   **삭제를 줄이는 방향으로만** 쓴다. 마커가 매 기동 덮이는 판본이라면 at 이 '지금' 이 되어 false 로 떨어진다(예전 동작 — 잘못 남기지 않는다).
 */
export function newBasisOnly(device, sinceAt) {
  const c = numOrNull(device?.createdAt); const s = numOrNull(sinceAt);
  return c != null && s != null && c > 0 && s > 0 && c > s;
}

export async function runCapacityBasisMigration({ devices = null, zeroPurgeAt } = {}) {
  let list = devices;
  let readable = true;
  if (!list) {
    try { readable = !registryLoadError(); list = listDevices(); } catch { readable = false; list = []; }
  }
  let ids = affectedDeviceIds(list);
  let skipped = 0;
  if (ids.length) {
    // 59회차: 지금까지 매 기동 대상 0대였던 설치(57회차 F1 이전에는 마커가 남지 않았다)가 그 뒤 등록한 PowerMax 는 이 판본으로 올라오는 기동에서
    //   지울 대상이 아니다 — 등록 시각이 v2.541 정리 마커보다 늦은 장비는 뺀다(마커 · 등록 시각을 모르면 예전처럼 지운다).
    let since = zeroPurgeAt;
    if (since === undefined) { try { since = (await migrationMarker(ZERO_PURGE_ID))?.at ?? null; } catch { since = null; } }
    const keep = new Set((list || []).filter((d) => newBasisOnly(d, since)).map((d) => String(d.id || '')));
    skipped = ids.filter((id) => keep.has(id)).length;
    ids = ids.filter((id) => !keep.has(id));
  }
  if (!ids.length) {
    // 57회차 F1(재현): 대상 장비가 없을 때 마커를 남기지 않고 돌아가, v2.534 이후 새로 설치한 포탈(또는 등록부를 아직 pull 하지 않은 새 엣지)에
    //   나중에 PowerMax/VMAX 를 등록하면 **다음 재시작(자동 업그레이드)이 새 기준으로 쌓인 이력을 통째로 지웠다**(사유 'v2.534 기준 변경' 이라는 거짓 기록까지).
    //   옛 기준 행은 v2.534 전 판본만 쓴다 — 등록부를 읽었는데 대상이 0대면 지울 것이 없으므로 마커만 남긴다. 등록부를 못 읽었으면 판정을 미룬다(마커 없음).
    if (!readable) return { ran: false, devices: 0, rows: 0, deferred: 'registry-unreadable' };
    const r = await resetCapacityHistory([], { reason: skipped ? '대상 장비가 모두 새 기준 이후 등록 — 마커만' : '대상 장비 없음 — 마커만', once: MIGRATION_ID });
    return { ran: false, devices: 0, rows: 0, marked: !!r.ran, ...(skipped ? { skipped } : {}) };
  }
  return resetCapacityHistory(ids, {
    reason: 'VMAX/PowerMax 사용량 기준 변경(할당 → 데이터 감축 후 실제 기록량, v2.534)',
    once: MIGRATION_ID,
  });
}
