/**
 * partfault/extract/storage.js — 스토리지 스냅샷 → 파트 목록(순수, v2.547).
 *
 * ⚠⚠ **이 어댑터가 얻을 수 있는 것은 장비군마다 크게 다르다.** 전수 조사(v2.547) 결과:
 *  · Isilon   — 노드만. 디스크·PSU·팬 신호가 **없다**.
 *  · Unity    — REST 는 SP만. **SSH(이 현장 18대의 다수)는 0개**
 *               (`unitySsh.js` 가 nodes/accounts 를 '미수집' 으로 둔다. `svcDiag.js` 파서는
 *                완성·테스트돼 있으나 v2.542 이후 호출되지 않는다).
 *  · PowerStore — 노드 health 가 `'unknown'`, unhealthy 가 **0 으로 하드코딩**(조회가 상태 필드를
 *               요청조차 하지 않는다).
 *  · VMAX/PowerMax — 파트 신호 **전무**(수집기가 '범위 밖' 이라고 명시).
 * 그래서 **없는 것을 있는 척하지 않는다** — 읽은 것만 파트로 만들고, 나머지는 스캔 요약이
 * `covered` 로 '이 장비군은 어디까지 봤는지' 를 밝힌다.
 *
 * ⚠ **노드 `id` 가 합성 순번인 수집기가 7개다**(unity.js:43 · powerstore.js:92 ·
 * powerstoreSsh.js:94 · xtremio.js:63 · xtremioSsh.js:96 · vplex.js:57 · vplexSsh.js:91 —
 * 전부 `i+1`). 장비가 순서를 바꾸면 **같은 파트가 다른 파트로 기록**돼 없던 장애가 생기고
 * 있던 장애가 닫힌다. 그래서 **`name` 이 있으면 name 을 키로 쓰고**, 이름이 없어 순번을
 * 쓸 수밖에 없으면 `keyKind:'index'` 로 낮춰 화면이 그 사실을 밝힌다.
 */

import { makePart, KEY_KIND } from '../types.js';
import { healthStringState, fruPartState } from '../classify.js';

const t = (v) => String(v ?? '').trim();
/** 순번처럼 보이는 id(숫자만) — 합성 키일 가능성이 높다. */
const looksIndex = (v) => /^\d{1,3}$/.test(t(v));

/**
 * @param {{id:string, name?:string, type?:string, agent?:string}} device 레지스트리 항목
 * @param {object} snap 정규화 스냅샷(`storage/types.js` 계약)
 * @returns {{parts:Array, covered:string[], notCollected:string[]}}
 */
export function extractStorageParts(device = {}, snap = {}) {
  const base = {
    scope: 'storage',
    deviceId: t(device.id),
    deviceName: t(snap?.name) || t(device.name) || t(device.host) || t(device.id),
    agent: t(device.agent),
  };
  const parts = [];
  const covered = [];
  const notCollected = [];
  const push = (kind, partId, keyKind, r, label, detail) => {
    if (!partId) return;
    parts.push(makePart({ ...base, kind, partId, keyKind, state: r.state, rawState: r.raw, label, detail }));
  };

  // ── 노드 / SP ────────────────────────────────────────────────────────────────
  const nodes = Array.isArray(snap?.nodes?.list) ? snap.nodes.list : null;
  if (nodes && nodes.length) {
    covered.push('node');
    for (const n of nodes) {
      const name = t(n.name) || t(n.lnn) || '';
      const id = t(n.id);
      // name 우선(안정) → 없으면 id. id 가 순번꼴이면 등급을 index 로 낮춘다.
      const partId = name || id;
      const keyKind = name ? KEY_KIND.name : (looksIndex(id) ? KEY_KIND.index : KEY_KIND.name);
      push('node', partId, keyKind, healthStringState(n.health), name || `노드 ${id}`,
        [t(n.model), t(n.ip)].filter(Boolean).join(' '));
    }
  } else if (snap?.sections?.nodes && /미수집/.test(String(snap.sections.nodes))) {
    // ⚠ '노드 0대' 가 아니라 '이 수집 방식에서는 조회하지 않는다' 다(v2.542 Unity 규약).
    notCollected.push('node');
  }

  // ── FRU(Unity svc_diag 계열) ────────────────────────────────────────────────
  // `svcDiag.parseSpinfo` 가 채우는 모양: extra.fru = { dimm0:'OK', ps0:'OK', fan1:'REMOVED', ... }
  // ⚠ 지금은 이 경로가 호출되지 않아 대개 비어 있다 — 있으면 쓰고, 없으면 만들지 않는다.
  const fru = snap?.extra?.fru;
  if (fru && typeof fru === 'object' && !Array.isArray(fru)) {
    const keys = Object.keys(fru);
    if (keys.length) {
      covered.push('fru');
      for (const k of keys) {
        const v = fru[k];
        const raw = typeof v === 'string' ? v : t(v?.state ?? v?.status);
        push(fruKindOf(k), k, KEY_KIND.name, fruPartState(raw), k, typeof v === 'object' ? t(v?.detail) : '');
      }
    }
  }

  // ── 디스크(수집기가 목록을 주는 경우에만) ────────────────────────────────────
  const disks = Array.isArray(snap?.extra?.disks) ? snap.extra.disks : null;
  if (disks && disks.length) {
    covered.push('disk');
    for (const d of disks) {
      const id = t(d.serial) || t(d.name) || t(d.id) || t(d.slot);
      const keyKind = t(d.slot) ? KEY_KIND.slot : (t(d.serial) ? KEY_KIND.serial : KEY_KIND.name);
      push('disk', id, keyKind, healthStringState(d.health ?? d.state ?? d.status),
        t(d.name) || t(d.slot) || id, [t(d.model), d.capacityGB ? `${d.capacityGB}GB` : ''].filter(Boolean).join(' '));
    }
  }

  return { parts, covered, notCollected };
}

/** FRU 이름 → 파트 종류. `svcDiag.fruKind` 와 **같은 어휘**를 쓴다(두 화면이 갈라지지 않게). */
export function fruKindOf(name) {
  const n = String(name || '').toLowerCase();
  if (/^dimm\d*$/.test(n)) return 'dimm';
  if (/^fan\d*$/.test(n)) return 'fan';
  if (/^ps\d*$/.test(n)) return 'psu';
  if (/^bbu\d*$/.test(n)) return 'battery';
  if (/^sp[ab]$/.test(n)) return 'node';
  if (/^(dpe|dae\d*)$/.test(n)) return 'enclosure';
  if (/^(slic|mezz|iom)\d*$/.test(n)) return 'pcie';
  return 'other';
}
