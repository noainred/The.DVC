/**
 * idrac/invView.js — 상세 화면용 인벤토리 '보기'(순수, v2.728).
 *
 * 저장된 인벤토리(로컬 invCache · 엣지가 보낸 축약 인벤토리)를 **고치지 않고** 화면이 쓸 판정을 덧붙인 사본을 만든다:
 *   · NIC 포트 중복 제거 + 포트마다 `linkState`('up'|'down'|'unknown' — idrac/nicPorts.js 하나가 판정)
 *   · 부품(PSU·디스크·DIMM·CPU·GPU·컨트롤러·PCIe·팬)마다 `partState`(ok|warn|fault|unknown|absent — partfault/classify.js
 *     redfishPartState 를 **그대로** 쓴다. 파트 장애 기능과 같은 판정이어야 화면 두 곳이 다른 말을 하지 않는다).
 * 판정은 서버가 하고 웹은 색만 고른다(CLAUDE.md '판정 복제 금지').
 */
import { redfishPartState } from '../partfault/classify.js';
import { dedupNics, nicLinkState } from './nicPorts.js';

// 컨트롤러·PCIe 는 state 를 수집하지 않는다(redfish.js) — 파트 장애 추출기(extract/idrac.js)와 같은 입력만 넘긴다.
const STATE_INPUT = {
  psus: (x) => x, disks: (x) => x, memoryDimms: (x) => x, cpus: (x) => x, gpus: (x) => x,
  fans: (x) => ({ health: x.health, state: x.state }),
  storageControllers: (x) => ({ health: x.health }),
  pcie: (x) => ({ health: x.health }),
};
export const PART_ARRAY_KEYS = Object.freeze(Object.keys(STATE_INPUT));

/**
 * 하위 시스템 롤업(`inv.health.psu` 등)이 어느 부품 배열에서 나오는가. 스토리지는 **디스크만**이다(redfish.js 의 예전 정의 그대로 —
 * 컨트롤러는 따로 표에 나온다). 화면 배지가 쓰는 것은 psu·storage, gpu 는 엣지 export 만 싣는다.
 */
export const HEALTH_ROLLUP_SOURCE = Object.freeze({ psu: 'psus', storage: 'disks', gpu: 'gpus' });

/** 롤업 상태 → 저장 글자(Redfish 어휘). ⚠ unknown 은 글자를 만들지 않는다('') — 'OK' 로 접지도, 빨간 글자로 칠하지도 않는다. */
const ROLLUP_WORD = Object.freeze({ fault: 'Critical', warn: 'Warning', ok: 'OK' });

/**
 * 부품 원소 배열 → 롤업(v2.731 A2-02). 판정은 원소마다 partfault/classify.js redfishPartState **그대로**(복제 금지).
 *
 * 예전 롤업(`some(p => p.health && p.health !== 'OK') ? 'Warning' : 'OK'`)은 ① 상태를 못 읽은 원소를 판정에서 빼서 **전부 못 읽어도
 * 'OK'(초록)** 였고 ② Critical 이 있어도 **'Warning'** 이었다 — 같은 탭의 부품 표(partState)와 반대를 말했다.
 * 순서가 계약이다: fault > warn > unknown > ok. 'OK' 는 **읽은 원소가 하나 이상이고 못 읽은 원소가 없을 때만**이다.
 * 확인한 장애·주의는 못 읽은 원소가 섞여 있어도 그대로 말한다(아는 것 중 가장 나쁜 것 — 못 읽은 개수는 counts 가 밝힌다).
 * 빈 슬롯(absent)만 있거나 원소가 없으면 state '' — 표시할 것이 없다.
 *
 * @param {Array<object>} items
 * @param {(x:object)=>object} [pick]  원소 → redfishPartState 입력
 * @returns {{state:''|'ok'|'warn'|'fault'|'unknown', word:string, counts:{ok:number,warn:number,fault:number,unknown:number,absent:number}}}
 */
export function partHealthRollup(items, pick = (x) => x) {
  const counts = { ok: 0, warn: 0, fault: 0, unknown: 0, absent: 0 };
  for (const x of Array.isArray(items) ? items : []) {
    if (!x || typeof x !== 'object') continue;
    const st = redfishPartState(pick(x)).state;
    if (Object.hasOwn(counts, st)) counts[st] += 1;
    else counts.unknown += 1;
  }
  const state = counts.fault ? 'fault' : counts.warn ? 'warn' : counts.unknown ? 'unknown' : counts.ok ? 'ok' : '';
  return { state, word: ROLLUP_WORD[state] || '', counts };
}

/**
 * @param {object|null} inv
 * @returns {object|null}  사본(원본 불변). nics 는 중복 제거 + linkState, 부품 원소에는 partState.
 *   + `healthParts`({psu, storage, gpu} → {state, counts}) — 부품 배열이 있는 하위 시스템만.
 *   + `health` 의 psu·storage·gpu 를 원소 판정으로 **다시 만든다**(저장값을 믿지 않는다 — 30분 캐시·구버전 엣지가 보낸 옛 롤업도 고쳐진다).
 *     저장된 인벤토리에 `health` 가 없으면 만들지 않는다(구버전 엣지 판정 statusFieldsMissing 의 근거를 바꾸지 않게 — 화면은 healthParts 를 본다).
 */
export function inventoryView(inv) {
  if (!inv || typeof inv !== 'object') return inv ?? null;
  const out = { ...inv };
  for (const [k, pick] of Object.entries(STATE_INPUT)) {
    if (!Array.isArray(inv[k])) continue;
    out[k] = inv[k].map((x) => (x && typeof x === 'object' ? { ...x, partState: redfishPartState(pick(x)).state } : x));
  }
  const parts = {};
  const health = inv.health && typeof inv.health === 'object' ? { ...inv.health } : null;
  for (const [hk, ak] of Object.entries(HEALTH_ROLLUP_SOURCE)) {
    if (!Array.isArray(inv[ak])) continue;
    const r = partHealthRollup(inv[ak], STATE_INPUT[ak]);
    parts[hk] = { state: r.state, counts: r.counts };
    if (health) health[hk] = r.word;
  }
  if (health) out.health = health;
  if (Object.keys(parts).length) out.healthParts = parts;
  if (Array.isArray(inv.nics)) {
    out.nics = dedupNics(inv.nics).map((n) => (n && Array.isArray(n.ports)
      ? { ...n, ports: n.ports.map((p) => (p && typeof p === 'object' ? { ...p, linkState: nicLinkState(p.link) } : p)) }
      : n));
  }
  return out;
}

/**
 * 엣지가 보낸 축약 인벤토리에 **상태 필드 자체가 없는가**(2.728 이전 엣지 — collector/agent.js compactInv 가 health·state 를
 * 빼고 보냈다). '키가 없음' 과 '빈 값(못 읽음)' 은 다르다: 새 엣지는 못 읽은 상태도 `health: ''` 로 **키를 싣는다**.
 *   true  = 부품 원소가 하나 이상 있는데 어느 원소에도 `health` 키가 없고, 롤업(`health`)·컬렉션 메타(`collections`)도 없다.
 *   false = 그 밖(부품이 0개면 판단할 근거가 없으므로 false — '구버전' 이라 단정하지 않는다).
 */
export function statusFieldsMissing(inv) {
  if (!inv || typeof inv !== 'object') return false;
  if (Object.hasOwn(inv, 'collections') || Object.hasOwn(inv, 'health')) return false;
  let elems = 0;
  for (const k of ['psus', 'disks', 'memoryDimms', 'cpus', 'gpus', 'fans']) {
    for (const x of Array.isArray(inv[k]) ? inv[k] : []) {
      if (!x || typeof x !== 'object') continue;
      elems += 1;
      if (Object.hasOwn(x, 'health')) return false;
    }
  }
  return elems > 0;
}
