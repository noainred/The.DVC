/**
 * partfault/extract/idrac.js — iDRAC 인벤토리 → 파트 목록(순수, v2.547).
 *
 * 이 현장 물리 서버 ~965대가 파트 모수의 대부분(서버당 37~66개 ≈ 3.5만~6.4만)이다.
 * `idrac/redfish.js` 가 **부품별 health/state 를 이미 채우고 있으므로** 새 수집은 필요 없다 —
 * 흩어진 배열을 한 계약으로 접기만 한다.
 *
 * ⚠ **`inv.health` 롤업을 쓰지 않는다.** `redfish.js:422`·`:464`·`:535` 가
 * `x.health && x.health !== 'OK'` 꼴이라 **빈 값(못 읽음)을 `OK` 로 접는다**. 파트 단위
 * 원소 배열에서 직접 판정해야 '확인 불가' 가 살아남는다(CLAUDE.md v2.526 규약).
 *
 * ── 일부러 **빼는 것** ────────────────────────────────────────────────────────
 * **NIC 링크(`inv.nics[].ports[].link`)는 파트 장애로 세지 않는다.** 링크 다운의 대다수는
 * 케이블 미결선·의도적 비활성이라 장애가 아니고, 965대 규모에서 대량 오탐이 된다.
 * 게다가 `redfish.js:571` 은 `LinkStatus` 와 `Status.State` 를 **한 필드에 섞어** 넣어
 * 값만으로는 어느 쪽인지 알 수 없다. 어댑터가 NIC **카드** health 를 얻게 되면 그때 넣는다
 * (지금은 수집되지 않는다 — 조사 v2.547 확인).
 *
 * ⚠ **상한으로 잘린 것을 '장애 0건' 이라 말하지 않는다.** redfish.js 는 PSU 8 · 컨트롤러 8 ×
 * 드라이브 32 · DIMM 64 · 프로세서 24 · PCIe 16 에서 자른다. 잘렸는지는 인벤토리만 보고는
 * 알 수 없으므로(원본 길이가 남지 않는다) **여기서 단정하지 않고**, 스캔 요약이
 * `capped:true` 로 '상한에 닿았을 수 있다' 만 밝힌다.
 *
 * ── v2.548 — 수집 실패를 '부품 0개 = 정상' 으로 읽던 결함(F1)과 장비 키(F2) ─────────────────
 * `fetchInventory` 는 어떤 경우에도 던지지 않는다(모든 블록이 `catch {}`) — 연결 거부에도 29ms 만에
 * **신선한 빈 인벤토리**가 온다. v2.547 은 그것을 '부품 0개' 로 읽고 화면이 초록으로 '모든 부품이
 * 정상' 이라 했다. 이제 `inv.collections[<컬렉션>]`('ok'|'failed', redfish.js 가 싣는다)과 `inv.reachable`
 * 을 읽어 **실패한 컬렉션의 종류는 파트를 만들지 않고 `failedKinds` 로 올린다** — 전이가 그 종류의
 * 열린 장애를 `collection-failed` 로 **보류**한다. 메타가 없는 구버전 캐시(`legacy`)는 '전부 비어
 * 있으면 불통' 으로만 본다(추측을 최소화 — 다음 인벤토리 갱신(≤30분)이면 메타가 생긴다).
 * 장비 키는 **서비스태그 → UUID → 로컬 id** 순이다(types.js DEVICE_KEY_KIND) — 로컬 id 는 IP 라
 * 법인 간 충돌 가능(F2).
 */

import { makePart, PART_STATE, KEY_KIND, DEVICE_KEY_KIND, COLLECTION_KINDS } from '../types.js';
import { redfishPartState } from '../classify.js';

const t = (v) => String(v ?? '').trim();

/** 상한값 — redfish.js 의 slice 와 **같은 숫자**여야 한다(달라지면 capped 판정이 거짓이 된다). */
const CAPS = Object.freeze({ psus: 8, disks: 32, memoryDimms: 64, cpus: 24, gpus: 24, pcie: 16, storageControllers: 4 });

/**
 * @param {{id:string, name?:string, host?:string, agent?:string}} server
 * @param {object} inv  `idrac/redfish.js fetchInventory` 결과(또는 원격 스냅샷의 inv)
 * @returns {{parts:Array, capped:boolean, kinds:string[], failedKinds:string[], reachable:boolean,
 *   legacy:boolean, deviceKey:string, deviceKeyKind:string}}
 *   `kinds` — **실제로 배열이 존재한 종류**. 빈 배열과 '이 iDRAC 이 그 컬렉션을 지원하지 않음'을
 *   구분하기 위해 필요하다(v2.493 '값이 없는 이유를 단정하지 말 것').
 *   `failedKinds` — 이번 인벤토리에서 **GET 이 실패한 컬렉션**의 파트 종류(v2.548 F1). 그 종류는 parts 에
 *   없고, 전이가 그 종류의 열린 장애를 보류한다.
 *   `reachable` — 장비에 닿았는가. false 면 parts 는 비어 있고 호출부는 deviceOk=false 로 다뤄야 한다.
 */
export function extractIdracParts(server = {}, inv = {}) {
  const dk = deviceKeyOf(server, inv);
  const base = {
    scope: 'idrac',
    deviceId: t(server.id),
    deviceKey: dk.key,
    deviceKeyKind: dk.kind,
    deviceName: t(server.name) || t(server.host) || t(server.id),
    agent: t(server.agent),
  };
  const parts = [];
  const kinds = [];
  const failedKinds = [];
  let capped = false;

  // ── 컬렉션 메타(v2.548 F1) ───────────────────────────────────────────────────
  const coll = inv?.collections && typeof inv.collections === 'object' ? inv.collections : null;
  const legacy = !coll;
  let reachable;
  if (inv?.reachable === false) reachable = false;
  else if (inv?.reachable === true) reachable = true;
  else if (legacy) {
    // 메타 없는 구버전 캐시 — **전부 비어 있으면** 불통으로 본다. 그 외는 추측하지 않는다.
    const anyModel = !!t(inv?.system?.model);
    const anyArr = Object.keys(COLLECTION_KINDS).some((k) => Array.isArray(inv?.[k]) && inv[k].length);
    reachable = anyModel || anyArr;
  } else reachable = true;
  if (!reachable) {
    return { parts, capped: false, kinds, failedKinds: Object.values(COLLECTION_KINDS), reachable: false, legacy, deviceKey: dk.key, deviceKeyKind: dk.kind };
  }
  const failed = (name) => coll && coll[name] === 'failed';
  /*
   * ⚠ 장비 키가 이번 주기에 **낮아지면 파트를 내지 않는다**(v2.548 리뷰 C3): Systems GET 만 실패하고
   *   Chassis 는 응답하면 `system.serviceTag` 가 비어 키가 서비스태그→IP 로 떨어진다. 그대로 두면 같은 PSU 가
   *   IP 키로 **두 번째 행**을 열고(알림 한 번 더), 복구 뒤 그 행은 `missing` 으로 영원히 남는다. 등록부에
   *   서비스태그가 있으면 키가 흔들리지 않으므로 그대로 진행한다. 구버전 캐시(legacy)는 이 메타가 없다.
   */
  // 구버전 캐시(메타 없음)는 system 이 통째로 비었으면 Systems 실패로 본다(반증 ② — v2.547 캐시의 마지막 수집이
  // Systems 실패+Chassis 성공이면 IP 키 파트가 나가고 ≤30분 뒤 메타 인벤토리가 오면 그 행이 missing 으로 남는다).
  const systemFailed = legacy
    ? !(t(inv?.system?.model) || t(inv?.system?.serviceTag) || t(inv?.system?.uuid))
    : coll.system === 'failed';
  if (systemFailed && !t(server.serviceTag)) {
    return { parts, capped: false, kinds, failedKinds: Object.values(COLLECTION_KINDS), reachable: true, keyUnstable: true, legacy, deviceKey: dk.key, deviceKeyKind: dk.kind };
  }
  const seen = new Map();   // kind:partId -> [횟수, 첫 항목의 parts 인덱스]

  const push = (kind, partId, keyKind, raw, label, detail) => {
    if (!partId) return;                     // 식별자가 없으면 파트 단위로 기록하지 않는다
    const probe = `${kind}:${partId}`;
    const ent = seen.get(probe) || [0, -1];
    const n = ent[0] + 1;
    /*
     * ⚠ 같은 식별자가 둘 이상이면(예: 시리얼 미보고로 name 이 겹침) **조용히 덮어쓰지 않는다** — 순번을
     *   덧붙여 둘 다 남기고 키 등급을 index 로 낮춘다. ⚠ **첫 항목도 함께 낮춘다**(v2.548 리뷰 C4): 첫 항목만
     *   원래 이름·name 등급으로 두면 그 키 역시 배열 순서에 묶여 있는데 화면은 경고하지 않고, Members 순서가
     *   뒤집히는 순간 고장 부품이 'ok' 로 닫히고 `#2` 가 새로 열린다(재현됨). 그룹 전체가 `#1·#2·…` 순번 키다.
     */
    if (n === 2 && ent[1] >= 0) {
      const f = parts[ent[1]];
      parts[ent[1]] = makePart({ ...f, partId: `${partId}#1`, keyKind: KEY_KIND.index });
    }
    const id = n > 1 ? `${partId}#${n}` : partId;
    const kk = n > 1 ? KEY_KIND.index : keyKind;
    seen.set(probe, [n, n === 1 ? parts.length : ent[1]]);
    parts.push(makePart({ ...base, kind, partId: id, keyKind: kk, state: raw.state, rawState: raw.raw, label, detail }));
  };

  // 컬렉션이 실패했으면 **그 배열을 읽지 않는다**(빈 배열이 '부품 0개' 로 둔갑하는 것을 막는다).
  const arr = (k) => {
    if (failed(k)) { failedKinds.push(COLLECTION_KINDS[k]); return null; }
    return Array.isArray(inv?.[k]) ? inv[k] : null;
  };
  const mark = (k, list) => { if (list) { kinds.push(k); if (CAPS[k] && list.length >= CAPS[k]) capped = true; } };

  // ── PSU ─────────────────────────────────────────────────────────────────────
  const psus = arr('psus'); mark('psus', psus);
  for (const p of psus || []) {
    const r = redfishPartState(p);
    const id = t(p.serial) || t(p.name);
    push('psu', id, t(p.serial) ? KEY_KIND.serial : KEY_KIND.name, r,
      t(p.name) || 'PSU', [t(p.model), p.capacityWatts ? `${p.capacityWatts}W` : ''].filter(Boolean).join(' '));
  }

  // ── 디스크 ───────────────────────────────────────────────────────────────────
  const disks = arr('disks'); mark('disks', disks);
  for (const d of disks || []) {
    const r = redfishPartState(d);
    const id = t(d.serial) || t(d.name);
    push('disk', id, t(d.serial) ? KEY_KIND.serial : KEY_KIND.name, r,
      t(d.name) || '디스크',
      [t(d.model), d.capacityGB ? `${d.capacityGB}GB` : '', t(d.media), t(d.protocol)].filter(Boolean).join(' '));
  }

  // ── DIMM ─────────────────────────────────────────────────────────────────────
  const dimms = arr('memoryDimms'); mark('memoryDimms', dimms);
  for (const d of dimms || []) {
    const r = redfishPartState(d);
    // locator 는 물리 슬롯(DIMM.Socket.A1) — 교체해도 같은 자리로 추적된다. 최선의 키다.
    const id = t(d.locator) || t(d.serial);
    push('dimm', id, t(d.locator) ? KEY_KIND.slot : KEY_KIND.serial, r,
      t(d.locator) || 'DIMM',
      [d.sizeGB ? `${d.sizeGB}GB` : '', t(d.type), d.speedMHz ? `${d.speedMHz}MHz` : ''].filter(Boolean).join(' '));
  }

  // ── 팬 ──────────────────────────────────────────────────────────────────────
  const fans = arr('fans'); mark('fans', fans);
  for (const f of fans || []) {
    // v2.612(COL2612-08): 팬은 빈 슬롯일 때만 `state:'absent'` 를 싣는다(redfish.js fetchSensors) — 그 밖엔 health 만.
    const r = redfishPartState({ health: f.health, state: f.state });
    push('fan', t(f.name), KEY_KIND.name, r, t(f.name) || '팬',
      [t(f.model), f.rpm != null ? `${f.rpm} RPM` : ''].filter(Boolean).join(' '));
  }

  // ── CPU ─────────────────────────────────────────────────────────────────────
  const cpus = arr('cpus'); mark('cpus', cpus);
  for (const c of cpus || []) {
    const r = redfishPartState(c);
    push('cpu', t(c.socket), KEY_KIND.slot, r, t(c.socket) || 'CPU',
      [t(c.model), c.cores ? `${c.cores}C` : ''].filter(Boolean).join(' '));
  }

  // ── GPU ─────────────────────────────────────────────────────────────────────
  const gpus = arr('gpus'); mark('gpus', gpus);
  for (const g of gpus || []) {
    const r = redfishPartState(g);
    push('gpu', t(g.name), KEY_KIND.name, r, t(g.name) || 'GPU', t(g.model));
  }

  // ── 스토리지 컨트롤러 ────────────────────────────────────────────────────────
  // ⚠ 시리얼·슬롯이 없다(redfish.js:435-444). 같은 모델 2장이면 name 이 같을 수 있어
  //   위의 중복 처리가 순번을 붙이고 키 등급을 index 로 낮춘다.
  const ctrls = arr('storageControllers'); mark('storageControllers', ctrls);
  for (const c of ctrls || []) {
    const r = redfishPartState({ health: c.health });   // state 미수집
    push('controller', t(c.name), KEY_KIND.name, r, t(c.name) || '컨트롤러',
      [t(c.model), t(c.firmware) && `FW ${t(c.firmware)}`].filter(Boolean).join(' '));
  }

  // ── PCIe ────────────────────────────────────────────────────────────────────
  const pcie = arr('pcie'); mark('pcie', pcie);
  for (const d of pcie || []) {
    const r = redfishPartState({ health: d.health });
    push('pcie', t(d.name), KEY_KIND.name, r, t(d.name) || 'PCIe', [t(d.model), t(d.deviceType)].filter(Boolean).join(' '));
  }

  return { parts, capped, kinds, failedKinds, reachable, legacy, deviceKey: dk.key, deviceKeyKind: dk.kind };
}

/**
 * 장비 키(v2.548 F2) — 서비스태그 → UUID → 로컬 id. `collector/remoteInventory.js:56` 이 위임 서버를
 * 서비스태그로 식별하는 것과 같은 판단이다. 어느 것을 썼는지 등급을 함께 돌려준다(화면이 밝힌다).
 */
export function deviceKeyOf(server = {}, inv = {}) {
  /*
   * ⚠ 등록부 서비스태그가 **먼저**다(v2.548 리뷰 C3 반증 ①): 키의 요건은 '진짜 태그' 가 아니라 **주기마다 같은 값**이다.
   *   인벤토리 태그를 먼저 쓰면 Systems GET 이 실패한 주기에만 등록부 값(CSV·수동 입력 — 대소문자·값이 다를 수 있다)
   *   으로 떨어져 같은 부품이 두 키로 갈라진다. 대소문자도 접는다(`normalize` 는 trim 만 한다).
   */
  const tag = (t(server.serviceTag) || t(inv?.system?.serviceTag)).toUpperCase();
  if (tag) return { key: tag, kind: DEVICE_KEY_KIND.serviceTag };
  const uuid = t(inv?.system?.uuid);
  if (uuid) return { key: uuid, kind: DEVICE_KEY_KIND.uuid };
  return { key: t(server.id), kind: DEVICE_KEY_KIND.localId };
}

export const _caps = CAPS;
export const _unusedStates = PART_STATE; // 계약 참조 고정(리팩터 시 import 유실 방지)
