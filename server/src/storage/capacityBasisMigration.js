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
import { listDevices } from './registry.js';
import { resetCapacityHistory } from './db.js';

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

export async function runCapacityBasisMigration({ devices = null } = {}) {
  let list = devices;
  if (!list) { try { list = listDevices(); } catch { list = []; } }
  const ids = affectedDeviceIds(list);
  if (!ids.length) return { ran: false, devices: 0, rows: 0 };
  return resetCapacityHistory(ids, {
    reason: 'VMAX/PowerMax 사용량 기준 변경(할당 → 데이터 감축 후 실제 기록량, v2.534)',
    once: MIGRATION_ID,
  });
}
