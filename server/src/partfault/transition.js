/**
 * partfault/transition.js — 관측된 파트 상태 → **열기/유지/닫기** 판정(순수, v2.547).
 *
 * 이 기능은 상태 **전이만** 기록한다. 매 주기 전량을 적재하면 파트 모수 5~6만 × 주기로
 * 연 10억 행이 된다(v2.504 '행 수를 먼저 계산할 것'). 전이만 남기면 장비당 연 수 건이다.
 *
 * ⚠⚠ **그래서 '닫는 판정' 이 이 파일에서 가장 위험하다.** 잘못 닫으면 진행 중인 장애가
 * 이력에서 '복구' 로 남고 아무도 모른다. 아래 다섯 규칙은 전부 그것을 막기 위한 것이다.
 *
 *  ① **이번 수집이 실패했으면 아무것도 닫지 않는다.** iDRAC 무응답·엣지 push 1회 실패로
 *     관측 목록이 비면, 그대로 닫을 경우 **전 파트가 한꺼번에 '복구'** 로 기록된다.
 *  ② **`unknown` 은 열지도 닫지도 않는다.** 상태를 못 읽은 것은 정상도 이상도 아니다
 *     (v2.526 Unity DIMM 실측 — 상대 SP 의 UNKNOWN 을 정상으로 세면 거짓이 된다).
 *     열려 있던 장애가 `unknown` 이 되면 **유지**하고 그 사실만 기록한다.
 *  ③ **`absent`(빈 슬롯)는 닫되 사유를 나눈다.** 부품을 뽑은 것과 고친 것은 다르다 —
 *     `closeReason:'removed'` vs `'ok'`. 한 배지로 덮으면 교체 이력이 사라진다.
 *  ④ **관측 목록에서 사라진 파트는 닫지 않는다.** 없어진 것은 '고쳤다' 가 아니라
 *     '이번엔 안 보인다' 다(상한 절단·컬렉션 미지원·장비 부분 응답). `missing` 으로 남긴다.
 *  ⑤ **장비 단위로 판정한다.** 장비 A 의 수집이 성공하고 B 가 실패했으면 A 만 닫는다.
 *     전체 스캔 성공/실패 하나로 뭉치면 한 장비의 실패가 다른 장비의 이력을 망친다.
 */

import { PART_STATE, isBad } from './types.js';

/**
 * @param {object} p
 * @param {Array}  p.open      지금 열려 있는 장애(DB 에서 읽은 것)
 *                             `[{partKey, deviceId, state, firstSeenAt, lastSeenAt, ...}]`
 * @param {Array}  p.observed  이번 스캔이 판정한 파트 전량(`extract*` 결과)
 * @param {object} p.scan      `{ deviceOk: {deviceId: boolean}, scannedDevices: string[] }`
 *                             ⚠ `deviceOk[id] !== true` 인 장비의 열린 장애는 **건드리지 않는다**.
 * @param {number} [p.now]
 * @returns {{opened:Array, updated:Array, closed:Array, held:Array, stats:object}}
 */
export function transition({ open = [], observed = [], scan = {}, now = Date.now() } = {}) {
  const deviceOk = scan.deviceOk || {};
  const openBy = new Map();
  for (const o of open) if (o?.partKey) openBy.set(o.partKey, o);

  const opened = [];
  const updated = [];
  const closed = [];
  const held = [];          // 유지(설명이 필요한 것만) — unknown 으로 바뀜 / 이번에 안 보임
  const seen = new Set();

  for (const p of observed) {
    if (!p?.partKey) continue;
    seen.add(p.partKey);
    const prev = openBy.get(p.partKey);

    if (isBad(p.state)) {
      if (!prev) {
        opened.push({ ...p, firstSeenAt: now, lastSeenAt: now });
      } else if (prev.state !== p.state) {
        // 악화·호전(warn↔fault)은 **즉시** 기록한다 — 나중에 아는 것이 더 위험하다.
        updated.push({ ...p, firstSeenAt: prev.firstSeenAt || now, lastSeenAt: now, prevState: prev.state });
      } else {
        updated.push({ ...p, firstSeenAt: prev.firstSeenAt || now, lastSeenAt: now, prevState: prev.state, sameState: true });
      }
      continue;
    }

    if (p.state === PART_STATE.unknown) {
      // ② 열지도 닫지도 않는다. 열려 있으면 유지하고 '이번엔 못 읽었다' 를 남긴다.
      if (prev) held.push({ ...prev, lastSeenAt: now, holdReason: 'unknown', rawState: p.rawState });
      continue;
    }

    // ok / absent — 열려 있던 것만 닫는다.
    if (prev) {
      closed.push({
        ...prev,
        closedAt: now,
        closeReason: p.state === PART_STATE.absent ? 'removed' : 'ok',
        closeRawState: p.rawState,
      });
    }
  }

  // ④ 관측 목록에 없던 열린 장애 — 닫지 않는다.
  for (const [key, o] of openBy) {
    if (seen.has(key)) continue;
    // ① 그 장비의 이번 수집이 성공했는가? 실패했으면 '안 보인다' 는 당연하므로 조용히 유지.
    const ok = deviceOk[o.deviceId] === true;
    held.push({ ...o, holdReason: ok ? 'missing' : 'device-failed', lastHeldAt: now });
  }

  return {
    opened, updated, closed, held,
    stats: {
      observed: observed.length,
      opened: opened.length,
      closed: closed.length,
      changed: updated.filter((u) => !u.sameState).length,
      heldUnknown: held.filter((h) => h.holdReason === 'unknown').length,
      heldMissing: held.filter((h) => h.holdReason === 'missing').length,
      heldDeviceFailed: held.filter((h) => h.holdReason === 'device-failed').length,
    },
  };
}
