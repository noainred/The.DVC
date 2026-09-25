/**
 * partfault/transition.js — 관측된 파트 상태 → **열기/유지/닫기** 판정(순수, v2.548).
 *
 * 이 기능은 상태 **전이만** 기록한다. 매 주기 전량을 적재하면 파트 모수 5~6만 × 주기로
 * 연 10억 행이 된다(v2.504 '행 수를 먼저 계산할 것'). 전이만 남기면 장비당 연 수 건이다.
 *
 * ⚠⚠ **그래서 '닫는 판정' 이 이 파일에서 가장 위험하다.** 잘못 닫으면 진행 중인 장애가
 * 이력에서 '복구' 로 남고 아무도 모른다. 아래 여섯 규칙은 전부 그것을 막기 위한 것이다.
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
 *  ⑥ **(v2.548 F1) 컬렉션 단위로도 판정한다.** 장비에는 닿았는데 PSU GET 만 실패했으면 PSU 의
 *     열린 장애만 `collection-failed` 로 보류하고 나머지 종류는 정상 판정한다.
 *
 * ── 키(v2.548 F2) ────────────────────────────────────────────────────────────
 * 열린 장애와 관측의 동일성은 **`agent|partKey`** 로 본다. iDRAC deviceId 는 IP 라 법인 간에 겹칠 수
 * 있고, partKey 에 agent 를 넣지 않는 대신(호스트명 변경 내성) 여기서 agent 를 합쳐 본다.
 * `scan.deviceOk`·`scan.kindFailed` 의 키도 **`agent|deviceId`** 다(`scan.js devKeyOf`).
 */

import { PART_STATE, HOLD_REASON, isBad } from './types.js';

const t = (v) => String(v ?? '').trim();
const okey = (p) => `${t(p.agent)}|${t(p.partKey)}`;
const dkey = (p) => `${t(p.agent)}|${t(p.deviceId)}`;

/**
 * @param {object} p
 * @param {Array}  p.open      지금 열려 있는 장애(DB 에서 읽은 것) — 각 항목에 agent·partKey·deviceId·kind
 * @param {Array}  p.observed  이번 스캔이 판정한 파트 전량(`extract*` 결과) — agent 가 붙어 있어야 한다
 * @param {object} p.scan      `{ deviceOk: {'agent|deviceId': boolean}, kindFailed: {'agent|deviceId': string[]} }`
 *                             ⚠ `deviceOk[k] !== true` 인 장비의 열린 장애는 **건드리지 않는다**.
 * @param {number} [p.now]
 * @returns {{opened:Array, updated:Array, closed:Array, held:Array, stats:object}}
 */
export function transition({ open = [], observed = [], scan = {}, now = Date.now() } = {}) {
  const deviceOk = scan.deviceOk || {};
  const kindFailed = scan.kindFailed || {};
  // 이번 주기에 보고가 있었던 agent 집합(중앙 로컬은 ''). 없으면(구 호출부) 미관측 = 장비 실패로 접는다.
  const reported = scan.agentsReported instanceof Set ? scan.agentsReported : null;
  // deviceOk=false 의 이유(mergeEdgeReports.deviceReason) — 엣지 보고 오래됨/구버전은 '장비 실패' 와 조치가 다르다(H7).
  const deviceReason = scan.deviceReason || {};
  const REFINE = { 'edge-stale': HOLD_REASON.edgeStale, 'edge-legacy': HOLD_REASON.edgeLegacy };
  const failedHold = (dk) => REFINE[deviceReason[dk]] || HOLD_REASON.deviceFailed;
  const openBy = new Map();
  for (const o of open) if (o?.partKey) openBy.set(okey(o), o);

  const opened = [];
  const updated = [];
  const closed = [];
  const held = [];
  const seen = new Set();

  /*
   * ⚠ 같은 (agent|partKey) 가 한 주기에 **두 번 이상** 관측되면 가장 나쁜 상태 하나만 쓴다(v2.548 리뷰 C1).
   *   등록부에 같은 물리 서버가 두 id(스캔 IP + CSV 서비스태그)로 있으면 실제로 일어난다 — 예전에는
   *   `ok` 관측이 closed 를, `fault` 관측이 updated 를 만들고 DB 가 닫힘을 이겨 **매 주기 열림/닫힘이
   *   반복**됐다(알림도 반복). 순위: fault > warn > unknown > ok/absent — unknown 이 ok 를 이기는 것은
   *   규칙 ②(못 읽은 것은 닫지 않는다)와 같은 방향이다.
   */
  const RANK = { fault: 3, warn: 2, unknown: 1 };
  const byKey = new Map();
  let duplicateObserved = 0;
  for (const p of observed) {
    if (!p?.partKey) continue;
    const k = okey(p);
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, p); continue; }
    duplicateObserved += 1;
    if ((RANK[p.state] || 0) > (RANK[prev.state] || 0)) byKey.set(k, p);
  }

  /*
   * v2.612 LEFT2612-04: **장비 키가 바뀐 같은 부품**(v2.611 HPE 서비스태그 교정 — SKU → SerialNumber). 파트 키에 장비 키가
   *   들어 있어 교정 뒤 같은 부품이 새 키로 다시 열리고(알림 한 번 더) 옛 키 행은 `missing` 으로 영원히 남았다.
   *   같은 (agent, 장비 id, 장비군, 종류, 파트 id) 에 **이번에 관측되지 않은 옛 키**의 열린 장애가 있으면 그 장애를 새 키로
   *   옮긴다 — 옛 행은 `key-migrated` 로 닫고(복구가 아니다) 새 행은 처음 본 시각을 이어받으며 알림을 다시 보내지 않는다.
   *   장비 수집이 실패로 표시된 주기에는 하지 않는다(규칙 ①). 새 키가 ok 면 옛 장애는 그대로 '복구(ok)' 로 닫는다(사실이다).
   */
  const slotOf = (p) => `${t(p.agent)}|${t(p.deviceId)}|${t(p.scope)}|${t(p.kind)}|${t(p.partId)}`;
  const openBySlot = new Map();
  for (const o of open) {
    if (!o?.partKey || byKey.has(okey(o))) continue;   // 이번에 옛 키도 관측됐으면 이관이 아니다
    const sk = slotOf(o);
    if (!t(o.partId)) continue;                        // 파트 id 가 없으면 같은 부품이라 단정할 수 없다
    if (!openBySlot.has(sk)) openBySlot.set(sk, o);
  }
  const migrated = new Set();
  const migrateFrom = (p) => {
    if (deviceOk[dkey(p)] === false) return null;
    const o = openBySlot.get(slotOf(p));
    if (!o || migrated.has(okey(o)) || okey(o) === okey(p)) return null;
    migrated.add(okey(o));
    return o;
  };

  for (const p of byKey.values()) {
    const k = okey(p);
    seen.add(k);
    const prev = openBy.get(k);

    if (isBad(p.state)) {
      const old = !prev ? migrateFrom(p) : null;
      if (old) {
        closed.push({ ...old, closedAt: now, closeReason: 'key-migrated', migratedTo: p.partKey });
        opened.push({ ...p, firstSeenAt: old.firstSeenAt || now, lastSeenAt: now, migratedFrom: old.partKey, prevState: old.state });
        continue;
      }
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
      if (prev) held.push({ ...prev, lastSeenAt: now, holdReason: HOLD_REASON.unknown, rawState: p.rawState });
      continue;
    }

    // v2.612 LEFT2612-04: 새 키로 ok/absent 가 보이고 옛 키 장애가 열려 있으면 그 장애가 해소된 것이다(옛 키로 닫는다).
    const oldOk = !prev ? migrateFrom(p) : null;
    if (oldOk) {
      closed.push({ ...oldOk, closedAt: now, closeReason: p.state === PART_STATE.absent ? 'removed' : 'ok', closeRawState: p.rawState, migratedTo: p.partKey });
      continue;
    }
    // ok / absent — 열려 있던 것만 닫는다.
    if (prev) {
      // ① 의 방어선(v2.548 리뷰 C2): 그 장비의 이번 수집이 실패로 표시됐는데 ok 관측이 섞여 오면
      //   (오래된 엣지 보고의 states 꼬리 등) 닫지 않고 보류한다 — 관측 목록의 신뢰가 곧 장비 판정이다.
      if (deviceOk[dkey(p)] === false) { held.push({ ...prev, holdReason: failedHold(dkey(p)), lastHeldAt: now }); continue; }
      closed.push({
        ...prev,
        closedAt: now,
        closeReason: p.state === PART_STATE.absent ? 'removed' : 'ok',
        closeRawState: p.rawState,
      });
    }
  }

  // ④ 관측 목록에 없던 열린 장애 — 닫지 않는다. 사유를 나눠 적는다(조치가 다르다).
  for (const [k, o] of openBy) {
    if (seen.has(k) || migrated.has(k)) continue;
    const dk = dkey(o);
    const dOk = deviceOk[dk];
    const kf = Array.isArray(kindFailed[dk]) && kindFailed[dk].includes(o.kind);
    let holdReason;
    if (dOk === false) holdReason = failedHold(dk);
    else if (dOk === true) holdReason = kf ? HOLD_REASON.collectionFailed : HOLD_REASON.missing;
    // 장비가 이번 판정 대상에 아예 없다(C5): 그 agent 가 보고는 했는데 이 장비가 빠졌으면 재배정·등록 삭제
    // (unassigned), 보고 자체가 없으면 no-report. 구 호출부(agentsReported 없음)는 예전대로 장비 실패.
    else if (reported) holdReason = reported.has(String(o.agent || '')) ? HOLD_REASON.unassigned : HOLD_REASON.noReport;
    else holdReason = HOLD_REASON.deviceFailed;
    held.push({ ...o, holdReason, lastHeldAt: now });
  }

  return {
    opened, updated, closed, held,
    stats: {
      observed: observed.length,
      opened: opened.length,
      closed: closed.length,
      keyMigrated: closed.filter((c) => c.closeReason === 'key-migrated').length,
      changed: updated.filter((u) => !u.sameState).length,
      heldUnknown: held.filter((h) => h.holdReason === HOLD_REASON.unknown).length,
      heldMissing: held.filter((h) => h.holdReason === HOLD_REASON.missing).length,
      heldDeviceFailed: held.filter((h) => h.holdReason === HOLD_REASON.deviceFailed).length,
      heldCollectionFailed: held.filter((h) => h.holdReason === HOLD_REASON.collectionFailed).length,
      heldUnassigned: held.filter((h) => h.holdReason === HOLD_REASON.unassigned).length,
      heldNoReport: held.filter((h) => h.holdReason === HOLD_REASON.noReport).length,
      heldEdge: held.filter((h) => h.holdReason === HOLD_REASON.edgeStale || h.holdReason === HOLD_REASON.edgeLegacy).length,
      duplicateObserved,   // 같은 키의 중복 관측 수 — 0 이 아니면 등록부에 같은 장비가 두 id 로 있을 가능성(C1)
    },
  };
}
