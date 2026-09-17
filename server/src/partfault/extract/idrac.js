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
 */

import { makePart, PART_STATE, KEY_KIND } from '../types.js';
import { redfishPartState } from '../classify.js';

const t = (v) => String(v ?? '').trim();

/** 상한값 — redfish.js 의 slice 와 **같은 숫자**여야 한다(달라지면 capped 판정이 거짓이 된다). */
const CAPS = Object.freeze({ psus: 8, disks: 32, memoryDimms: 64, cpus: 24, gpus: 24, pcie: 16, storageControllers: 4 });

/**
 * @param {{id:string, name?:string, host?:string, agent?:string}} server
 * @param {object} inv  `idrac/redfish.js fetchInventory` 결과(또는 원격 스냅샷의 inv)
 * @returns {{parts:Array, capped:boolean, kinds:string[]}}
 *   `kinds` — **실제로 배열이 존재한 종류**. 빈 배열과 '이 iDRAC 이 그 컬렉션을 지원하지 않음'을
 *   구분하기 위해 필요하다(v2.493 '값이 없는 이유를 단정하지 말 것').
 */
export function extractIdracParts(server = {}, inv = {}) {
  const base = {
    scope: 'idrac',
    deviceId: t(server.id),
    deviceName: t(server.name) || t(server.host) || t(server.id),
    agent: t(server.agent),
  };
  const parts = [];
  const kinds = [];
  let capped = false;
  const seen = new Map(); // partKey -> 횟수. 같은 키가 두 번 나오면 뒤에 #2 를 붙인다.

  const push = (kind, partId, keyKind, raw, label, detail) => {
    if (!partId) return;                     // 식별자가 없으면 파트 단위로 기록하지 않는다
    let id = partId;
    const probe = `${kind}:${partId}`;
    const n = (seen.get(probe) || 0) + 1;
    seen.set(probe, n);
    // ⚠ 같은 식별자가 둘 이상이면(예: 시리얼 미보고로 name 이 겹침) **조용히 덮어쓰지 않는다** —
    //   순번을 덧붙여 둘 다 남기고, 키 등급을 index 로 낮춰 화면이 신뢰도를 밝히게 한다.
    let kk = keyKind;
    if (n > 1) { id = `${partId}#${n}`; kk = KEY_KIND.index; }
    parts.push(makePart({ ...base, kind, partId: id, keyKind: kk, state: raw.state, rawState: raw.raw, label, detail }));
  };

  const arr = (k) => (Array.isArray(inv?.[k]) ? inv[k] : null);
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
    // ⚠ 팬은 `state` 를 수집하지 않는다(redfish.js:808 은 health 만) — health 만 넘긴다.
    const r = redfishPartState({ health: f.health });
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

  return { parts, capped, kinds };
}

export const _caps = CAPS;
export const _unusedStates = PART_STATE; // 계약 참조 고정(리팩터 시 import 유실 방지)
