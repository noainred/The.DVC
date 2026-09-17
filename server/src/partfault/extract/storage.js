/**
 * partfault/extract/storage.js — 스토리지 스냅샷 → 파트 목록(순수, v2.547 → v2.548 F2·F4).
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
 *
 * ── v2.548 F2 — 장비 축은 중앙 발급 id 다 ─────────────────────────────────────────
 * `deviceKey` 는 `device.id`(`storage/registry.js:100` 이 발급하는 전역 유일 `st-…`)이고 등급은
 * `DEVICE_KEY_KIND.centralId` 다 — 중앙이 진실의 원천이라 법인 간 충돌이 없다(iDRAC 의 IP 로컬 id 와
 * 다른 점). `push()` 가 `base` 를 그대로 펼치므로 노드·FRU·디스크 세 경로 전부에 실린다.
 *
 * ── v2.548 F4 — FRU 리더는 `svcDiag.parseSpinfo` 의 **집계 객체**를 읽는다 ────────────
 * v2.547 의 주석은 `extra.fru = { dimm0:'OK', ps0:'OK', … }` 평면 맵을 약속했지만 그 모양을 만든
 * 코드는 이 저장소에 **존재한 적이 없다**. 실제 생산자는 `storage/collectors/svcDiag.js parseSpinfo`
 * (:258) 하나이고 그 모양은
 *   fru = { items:[{ name, kind, sp:'spa'|'spb'|'', state:'ok'|'empty'|'unknown'|'fault', raw, detail, value }],
 *           total, ok, empty, unknown, fault, faults:[…], sps:[…] }
 * 다. 예전 리더에 이 객체가 들어오면 `Object.keys` 를 돌며 items/total/ok/empty/unknown/fault/faults/sps
 * 라는 **없는 부품 8개를 지어냈다**(v2.525 Unity CSV 배너가 없는 장비를 만든 것과 같은 유형).
 *  · **평면 맵 호환은 만들지 않는다** — 존재한 적 없는 형식을 위한 분기가 곧 그 결함의 원인이었다.
 *  · `fru.items` 가 배열이 아니거나(구버전·문자열·다른 모양) 비어 있으면 **아무것도 만들지 않고**
 *    `notCollected` 에 `fru` 를 넣는다 — 0 을 지어내지 않는다.
 *  · ⚠ 지금은 `unitySsh.js` 가 `svc_diag -s spinfo` 를 부르지 않아(v2.542 규약) 이 경로는 비어 있다 —
 *    연결되면 이 리더가 받는다. 그때 출력이 `--More--` 로 잘린 사실(`parseSpinfo().truncated`)도 함께
 *    실어야 한다(부품 목록이 일부일 수 있다 — 조용한 상한 금지).
 */

import { makePart, KEY_KIND, PART_STATE, DEVICE_KEY_KIND } from '../types.js';
import { healthStringState } from '../classify.js';

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
    // v2.548 F2 — 파트 키의 장비 축. 등급을 레코드에 실어 화면이 밝힌다(types.js DEVICE_KEY_KIND).
    deviceKey: t(device.id),
    deviceKeyKind: DEVICE_KEY_KIND.centralId,
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

  // ── FRU(Unity `svc_diag -s spinfo` — `svcDiag.parseSpinfo().fru`, 머리말 F4) ──────────
  // `extra.fru` 자체가 없으면 아무 말도 하지 않는다 — 이 경로는 아직 배선되지 않았고(v2.542),
  // Isilon·PowerStore 처럼 애초에 FRU 를 주지 않는 장비군에 '미수집' 을 찍으면 소음이 된다.
  const fru = snap?.extra?.fru;
  if (fru != null) {
    const items = Array.isArray(fru?.items) ? fru.items : null;
    if (items && items.length) {
      covered.push('fru');
      const seen = new Map(); // `kind:partId` -> 횟수. 같은 키가 두 번 나오면 뒤에 #2 를 붙인다.
      for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        const name = t(it.name);
        if (!name) continue;                   // 식별자가 없으면 파트 단위로 기록하지 않는다
        const sp = t(it.sp).toLowerCase();
        // ⚠ SPA 와 SPB 에 dimm0 이 **각각** 있다 — sp 없이 name 만 쓰면 두 부품이 한 키로 접혀
        //   한쪽의 장애가 다른 쪽 관측으로 닫힌다. SP 자신(name === sp)은 접두를 붙이지 않는다
        //   (`spa/spa` 는 같은 축을 두 번 쓰는 것이고 `spa` 만으로 유일하다).
        let partId = sp && sp !== name.toLowerCase() ? `${sp}/${name}` : name;
        let keyKind = KEY_KIND.name;
        const kind = fruKindOf(name);
        // ⚠ 같은 식별자가 둘 이상이면 **조용히 덮어쓰지 않는다** — 순번을 붙여 둘 다 남기고 키 등급을
        //   index 로 낮춰 화면이 신뢰도를 밝힌다(iDRAC 추출기와 같은 규약).
        const probe = `${kind}:${partId}`;
        const n = (seen.get(probe) || 0) + 1;
        seen.set(probe, n);
        if (n > 1) { partId = `${partId}#${n}`; keyKind = KEY_KIND.index; }
        push(kind, partId, keyKind, fruItemState(it.state, it.raw), name, t(it.detail));
      }
    } else {
      // 집계 객체 모양이 아니거나(문자열·숫자·평면 맵·`items` 가 배열이 아님) 읽은 항목이 0개 —
      // 부품을 지어내지 않고 '수집되지 않았다' 고만 밝힌다.
      notCollected.push('fru');
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

/**
 * svcDiag `FRU_STATE`(ok/empty/unknown/fault) → 이 계약의 5상태. 생산자가 **이미 판정한 값**이라
 * 번역만 한다(판정을 다시 하지 않는다 — v2.513 규약). `classify.fruPartState` 는 **원문 토큰**용이라
 * 여기서 원문을 다시 판정하면 두 판정이 갈라진다(예: 자유 문자열 `DEGRADED` 를 svcDiag 는 fault 로,
 * classify 는 warn 으로 본다 — 스토리지 화면의 `fru.fault` 수와 이 화면이 다른 말을 하게 된다).
 *  · `empty` 가 `absent` 다 — 이름만 다르고 뜻은 같다(빈 슬롯, 장애 아님).
 *  · 모르는 값은 `unknown` 이다 — 생산자가 준 적 없는 값은 우리가 잘못 읽은 것이지 장애가 아니다.
 * 원문(`raw`)은 그대로 실어 판정 근거를 숨기지 않는다.
 */
export function fruItemState(state, raw = '') {
  const s = t(state).toLowerCase();
  const r = t(raw);
  if (s === 'ok') return { state: PART_STATE.ok, raw: r };
  if (s === 'empty') return { state: PART_STATE.absent, raw: r };
  if (s === 'fault') return { state: PART_STATE.fault, raw: r };
  return { state: PART_STATE.unknown, raw: r };
}

/**
 * FRU 이름 → 파트 종류. **인식 어휘**(어떤 이름을 무엇으로 보는가)는 `svcDiag.fruKind` 와 같고
 * 출력만 이 계약의 `PART_KIND_LABEL` 키로 낸다 — svcDiag 의 `bbu`→`battery`, `sp`→`node`,
 * `slic`/`mezz`/`iom`→`pcie`. 두 어휘의 대응은 `partFaultStorageFru2548.test.js` 가 고정한다
 * (한쪽만 이름을 추가하면 그 테스트가 깨진다).
 */
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
