/**
 * partfault/extract/sanswitch.js — SAN 스위치 스냅샷 → 파트 목록(순수, v2.548 F9).
 *
 * 조사(v2.548)로 확정된 것: SAN 스위치 스냅샷은 엣지→중앙으로 **온전히** 오는데(`push.js`
 * gzip+청크, 중앙 `central/sanSwitchEdge.js`) 파트 추출기가 없어 스위치의 팬·PSU·포트 장애가
 * 파트 장애 DB 에 **한 건도 들어가지 않았다**. 이 파일은 `sanswitch/types.js` 의
 * `NormalizedSwitchSnapshot`(health:{status,fans,psus,tempC,alerts} · ports:{list:[PortRow]})
 * 을 `partfault/types.js` 계약으로 접는다. **새 수집은 없다** — 이미 온 값을 읽을 뿐이다.
 *
 * ── 팬/PSU 는 '그룹 단위' 다 ─────────────────────────────────────────────────────
 * 두 수집기 모두 팬·PSU 를 **개수만** 준다 — `fosParse.parseFruShow`(fanshow/psshow 의 'Ok' 단어
 * 수를 센다: `{ok,total}`) · `fosRest.js:192-193`(`operational-state==='ok'` 개수). **어느 팬이
 * 고장인지 알 수 없다.** 그래서 파트 하나를 `partId:'all'`·`keyKind:'none'` 으로 만든다 —
 * `KEY_KIND_NOTE.none` 이 정확히 이 경우를 위해 있다("SAN 스위치 팬 3/4 정상 — 어느 팬인지는
 * 알 수 없습니다"). 없는 식별자를 순번으로 지어내지 않는다(순번 키는 장비가 순서를 바꾸면 다른
 * 부품이 된다 — types.js `KEY_KIND.index` 경고).
 * ⚠ 정직 기록: 개수만 오므로 **'빠진 팬' 과 '고장 팬' 을 구분할 수 없다**(`parseFruShow` 는 'Ok'
 *   가 아닌 줄을 전부 non-ok 로 센다). `ok < total` 을 `fault` 로 보되 원문 `ok/total` 을
 *   `rawState` 에 남겨 사람이 대조할 수 있게 한다. 팬 단위 상태를 얻게 되면 그때 파트로 나눈다.
 *
 * ── 링크 없는 포트는 판정 대상이 아니다 ──────────────────────────────────────────
 * v2.521 규약(`healthCheck.js isLinked` 머리말 — 사용자 신고 "사용하지 않는 포트는 제외 해야
 * 맞는거 같다"): 링크가 없으면 **상대가 빛을 보내지 않으므로** Rx 가 바닥인 것이 정상이다.
 * 현장 스크린샷에서 비어 있는 포트 8개가 -27 dBm 으로 '이상' 이 나간 것이 거짓 경보였다.
 * 그래서 `offline`·`disabled` 포트는 **파트를 만들지 않고** 개수만 `notJudged.ports` 로 센다
 * (조용히 빼면 '전 포트를 봤다' 는 거짓이 된다). 단 `faulty` 는 링크와 무관하게 `fault` 이고
 * (장애 포트의 광량은 원인 정보다 — v2.521), `noLicense` 는 POD 미구매 슬롯이라 **빈 자리
 * (`absent`)** 다 — 장애가 아니다.
 *
 * 광량 임계는 **`healthCheck.js` 의 `RX_WARN_DBM`·`RX_BAD_DBM` 을 그대로 import** 한다.
 * 숫자를 여기 다시 적으면 월간 점검 보고서·포트 화면(`web/.../sanSwitchPorts.js`)과 이 기능의
 * 판정이 갈라진다(v2.519 규약 — 보고서와 화면이 어긋나면 사용자가 어느 쪽을 믿을지 모른다).
 *
 * ── 축약 스냅샷(`portsScope:'problem'`) ────────────────────────────────────────────
 * 회선이 좁은 법인은 엣지가 문제 포트만 올린다(`push.js slimSnapshot`, `SANSW_PUSH_PORTS=problem`
 * 또는 장비당 크기 가드). 그때 **정상 포트는 목록에 없으므로** '확인했고 정상(ok)' 이라고 말할
 * 근거가 없다 — `covered` 에 `'port:partial'` 로 적고 **ok 파트를 만들지 않는다**(문제 포트만
 * 판정). 문제 포트가 0개면 list 가 비고 `portsOmitted>0` 인데, 그것은 '미수집' 이 아니라
 * '전부 정상이라 뺀 것' 이다 — `notCollected` 에 넣지 않는다.
 *
 * 장비 축(`deviceKey`)은 **중앙이 발급한 `sw-…` id** 그대로다(`DEVICE_KEY_KIND.centralId`,
 * v2.548 F2) — 전역 유일이라 법인 간 충돌이 없다.
 */

import { makePart, PART_STATE, KEY_KIND, DEVICE_KEY_KIND } from '../types.js';
import { isLinked, RX_WARN_DBM, RX_BAD_DBM } from '../../sanswitch/healthCheck.js';
import { numOrNull } from '../../util/numOrNull.js';

const t = (v) => String(v ?? '').trim();
/** ⚠ `Number(null) === 0` 함정(v2.525 규약) — null/빈 값은 먼저 걸러 null 로 돌린다. */
const num = numOrNull; // v2.561: 공용 판정

/**
 * @param {{id:string, name?:string, host?:string, agent?:string}} device 레지스트리 항목(`sanswitch/registry.js`)
 * @param {object} snap 정규화 스냅샷(`sanswitch/types.js NormalizedSwitchSnapshot`)
 * @returns {{parts:Array, covered:string[], notCollected:string[], notJudged:{ports:number, portsOmitted:number, unidentified:number}}}
 *   covered      — 실제로 본 영역('port' | 'port:partial' | 'fan' | 'psu')
 *   notCollected — 스냅샷에 값이 없어 **만들지 않은** 영역('port' | 'fan' | 'psu'). 0 을 지어내지 않는다.
 *   notJudged    — `ports`: 링크 없어 판정 대상이 아닌 포트 수 / `portsOmitted`: 엣지가 축약으로 뺀 포트 수 /
 *                  `unidentified`: 식별자(slotPort·index)가 없어 파트로 만들 수 없던 포트 수
 */
export function extractSanSwitchParts(device = {}, snap = {}) {
  const base = {
    scope: 'sanswitch',
    deviceId: t(device.id),
    deviceKey: t(device.id),
    deviceKeyKind: DEVICE_KEY_KIND.centralId,
    deviceName: t(snap?.name) || t(device.name) || t(device.host) || t(device.id),
    agent: t(device.agent),
  };
  const parts = [];
  const covered = [];
  const notCollected = [];
  const notJudged = { ports: 0, portsOmitted: 0, unidentified: 0 };
  const push = (kind, partId, keyKind, state, rawState, label, detail) => {
    parts.push(makePart({ ...base, kind, partId, keyKind, state, rawState, label, detail }));
  };

  // ── 포트 ─────────────────────────────────────────────────────────────────────
  const list = Array.isArray(snap?.ports?.list) ? snap.ports.list : null;
  const partial = t(snap?.ports?.portsScope) === 'problem';
  if (partial) {
    covered.push('port:partial');
    notJudged.portsOmitted = Math.max(0, num(snap?.ports?.portsOmitted) ?? 0);
  } else if (list && list.length) {
    covered.push('port');
  } else {
    notCollected.push('port');
  }
  for (const p of list || []) {
    const idx = num(p?.index);
    const partId = t(p?.slotPort) || (idx != null ? String(idx) : '');
    if (!partId) { notJudged.unidentified += 1; continue; }   // 식별자 없이는 키를 만들 수 없다 — 세기만 한다
    const state = t(p?.state).toLowerCase();
    const physical = t(p?.physical);
    const rawPort = physical && physical.toLowerCase() !== state ? `${state} (${physical})` : state;
    const detail = [t(p?.sfpVendor), t(p?.sfpPartNumber), t(p?.sfpSerial) ? `S/N ${t(p.sfpSerial)}` : '']
      .filter(Boolean).join(' ');

    // ① 장애 포트 — 링크 유무와 무관하게 이상(광량은 원인 정보이므로 detail 에 남긴다)
    if (state === 'faulty') {
      const rx = num(p?.rxPowerDbm);
      push('port', partId, KEY_KIND.slot, PART_STATE.fault, rawPort, partId,
        [detail, rx != null ? `Rx ${rx} dBm` : ''].filter(Boolean).join(' · '));
      continue;
    }
    // ② POD 미구매 슬롯 — 빈 자리다. 장애도 정상도 아니다.
    if (state === 'nolicense') {
      push('port', partId, KEY_KIND.slot, PART_STATE.absent, rawPort, partId, detail);
      continue;
    }
    // ③ 링크 없는 포트 — 판정 대상 아님(상대가 빛을 보내지 않는다). 파트를 만들지 않고 센다.
    if (!isLinked(p)) { notJudged.ports += 1; continue; }
    // ④ 링크 있는 포트 — 광량 판정. 임계는 healthCheck 의 상수(보고서·화면과 같은 축).
    const rx = num(p?.rxPowerDbm);
    let st; let raw;
    if (rx == null) { st = PART_STATE.unknown; raw = 'Rx 미확인'; }             // 읽지 못함 ≠ 정상
    else if (rx <= RX_BAD_DBM) { st = PART_STATE.fault; raw = `Rx ${rx} dBm ≤ ${RX_BAD_DBM}`; }
    else if (rx <= RX_WARN_DBM) { st = PART_STATE.warn; raw = `Rx ${rx} dBm ≤ ${RX_WARN_DBM}`; }
    else { st = PART_STATE.ok; raw = `Rx ${rx} dBm`; }
    // 축약분에서는 '정상' 을 주장할 근거가 없다 — 목록에 있는 것은 문제 포트뿐이고 정상 포트는 빠졌다.
    if (partial && st === PART_STATE.ok) continue;
    push('port', partId, KEY_KIND.slot, st, raw, partId, detail);
  }

  // ── 팬 / PSU(그룹 단위 — 머리말 참조) ─────────────────────────────────────────
  groupPart('fan', '팬', snap?.health?.fans);
  groupPart('psu', 'PSU', snap?.health?.psus);

  return { parts, covered, notCollected, notJudged };

  function groupPart(kind, label, g) {
    if (!g || typeof g !== 'object' || Array.isArray(g)) { notCollected.push(kind); return; }
    const ok = num(g.ok);
    const total = num(g.total);
    covered.push(kind);
    const raw = `${ok == null ? '?' : ok}/${total == null ? '?' : total}`;
    let st;
    if (ok == null || total == null) st = PART_STATE.unknown;   // 개수를 못 읽었다 — 정상으로 접지 않는다
    else if (ok < total) st = PART_STATE.fault;
    else st = PART_STATE.ok;
    // ⚠ unknown 에 '정상' 을 붙이지 않는다 — 라벨이 판정을 거짓말하면 안 된다.
    const text = st === PART_STATE.unknown ? `${label} ${raw}(상태 미확인)` : `${label} ${raw} 정상`;
    push(kind, 'all', KEY_KIND.none, st, raw, text, '');
  }
}
