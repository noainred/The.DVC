/**
 * storage/resources.js — 스토리지 **하위 항목**(LUN·파일시스템) 계약(순수, v2.747).
 *
 * 사용자 요청(2026-10-26): "스토리지 사용량을 일간/주간 별로 이렇게 정리해서 보는 기능" + 엑셀 캡처 —
 *   Unity480 열 아래에 `SAN Davinci_01 122880.0 GB / 44897.1 GB / 37%` · `NAS sandbox 1024.0 GB / 185.6 GB / 18%` 처럼
 *   **LUN·파일시스템별** 크기·사용량이 있다. 사용자 선택 "LUN·파일시스템까지".
 *
 * 이 모듈 하나가 갖는 것(수집기 2종·엣지 정제·일 롤업·화면이 같은 규칙을 쓴다 — '코어는 하나다'):
 *  · 종류(`kind`) 표 — `lun`(SAN) · `fs`(NAS). 화면·CSV·메일의 '구분' 열이 이 라벨을 쓴다.
 *  · 원소 정규화(`normalizeResource`) — 아는 필드만 · 수치는 `numOrNull`(못 읽은 값을 0 으로 만들지 않는다) ·
 *    글자 길이 상한 · 사용률은 **크기와 사용량을 둘 다 읽었을 때만**.
 *  · 목록 상한(`RESOURCE_MAX`) — 넘친 개수는 `extra.resourcesDropped` 로 밝힌다(조용한 상한 금지).
 *  · 수집 결과 표지(`resourceProbe`) — **'항목이 0개다' 와 '못 읽었다' 를 구분한다**. 화면이 하위 항목이 비어 있는
 *    이유(명령이 예산 때문에 건너뛰어졌다 / 실패했다 / 출력을 인식하지 못했다)를 말할 수 있게.
 *
 * ⚠ **스냅샷 공용 계약(`types.js`)을 넓히지 않는다** — 타입 고유 필드는 `extra` 에 둔다(types.js 머리말 3번).
 *   그래서 `extra.resources`·`extra.resourcesProbe` 다.
 * ⚠ LUN 의 '사용량' 은 **풀에서 실제로 할당된 양**(uemcli `Current allocation` · REST `sizeAllocated`)이다 — 호스트가 본
 *   파일시스템 사용량이 아니다. 씬 LUN 에서는 쓴 만큼에 가깝고 씩(thick) LUN 은 크기와 같다. `usedSource` 로 밝힌다.
 */
import { numOrNull } from '../util/numOrNull.js';
import { capStr } from '../util/capStr.js';

/** 하위 항목 종류. `group` 은 엑셀의 'SAN'·'NAS' 구분 열과 같은 뜻이다. */
export const RESOURCE_KINDS = Object.freeze({
  lun: Object.freeze({ group: 'SAN', label: 'LUN' }),
  fs: Object.freeze({ group: 'NAS', label: '파일시스템' }),
});

/** 장비 하나가 싣는 하위 항목 상한(push 크기·화면 폭). 넘친 개수는 반드시 밝힌다. */
export const RESOURCE_MAX = 256;

const STR_MAX = 128;
const STR_KEYS = ['id', 'name', 'pool', 'health', 'protocol', 'usedSource'];

const str = (v) => {
  if (v == null || typeof v === 'object' || typeof v === 'function') return null;
  const s = String(v).trim();
  return s ? capStr(s, STR_MAX) : null;
};

/**
 * 원소 하나 → 정규형 또는 null(종류를 모르거나 이름·id 가 둘 다 없으면 버린다 — 지어내지 않는다).
 * @param {object} r
 * @returns {null|{kind:string,id:string|null,name:string,pool:string|null,totalBytes:number|null,usedBytes:number|null,
 *   pct:number|null,usedSource:string|null,health:string|null,protocol:string|null}}
 */
export function normalizeResource(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const kind = typeof r.kind === 'string' && Object.hasOwn(RESOURCE_KINDS, r.kind) ? r.kind : null;
  if (!kind) return null;
  const o = { kind };
  for (const k of STR_KEYS) o[k] = str(r[k]);
  if (!o.name && !o.id) return null;
  if (!o.name) o.name = o.id;
  const t = numOrNull(r.totalBytes);
  const u = numOrNull(r.usedBytes);
  // 음수 크기는 장비 보고 오류다 — 0 으로 깎지 않고 '못 읽음' 으로 둔다.
  o.totalBytes = t != null && t >= 0 ? t : null;
  o.usedBytes = u != null && u >= 0 ? u : null;
  o.pct = o.totalBytes > 0 && o.usedBytes != null ? Math.round((o.usedBytes / o.totalBytes) * 1000) / 10 : null;
  return o;
}

/**
 * 목록 정규화 — 상한·중복(같은 kind+키)·이상 원소를 걸러낸다. 순서는 받은 순서다(장비 출력 순서).
 * @returns {{list:object[], dropped:number}} dropped = 상한·이상 원소로 뺀 개수(0 이 아니면 호출부가 밝힌다)
 */
export function normalizeResourceList(list, max = RESOURCE_MAX) {
  const out = [];
  const seen = new Set();
  let dropped = 0;
  for (const r of Array.isArray(list) ? list : []) {
    const o = normalizeResource(r);
    if (!o) { dropped += 1; continue; }
    const k = resourceKey(o);
    if (seen.has(k)) continue;           // 같은 항목이 두 번 오면 앞의 것(장비 출력 순서)
    if (out.length >= max) { dropped += 1; continue; }
    seen.add(k);
    out.push(o);
  }
  return { list: out, dropped };
}

/**
 * 이력의 식별 키 — **장비가 준 id 가 있으면 id**(이름을 바꿔도 이력이 이어진다), 없으면 이름.
 * 종류 접두를 붙인다(LUN 과 파일시스템이 같은 이름을 가질 수 있다).
 */
export function resourceKey(r) {
  return `${r.kind}:${r.id || r.name}`;
}

/**
 * 하위 항목 수집 결과 표지(종류별). state:
 *  · 'ok'          — 명령이 성공했고 목록을 읽었다(0개면 정말 0개다 — count:0)
 *  · 'unparsed'    — 명령은 성공했는데 출력에서 항목을 하나도 인식하지 못했다(형식 문제 — 원문을 볼 것)
 *  · 'failed'      — 명령이 실패했다(권한·명령 없음·시한) — detail 에 사유
 *  · 'skipped'     — 수집 시간 예산이 모자라 이번 주기에는 시작하지 않았다
 * 화면은 state 를 그대로 문구로 바꾼다(웹 storageUsageText 의 PROBE_TEXT 와 1:1).
 */
export const PROBE_STATES = Object.freeze(['ok', 'unparsed', 'failed', 'skipped']);

export function resourceProbe(state, { source = '', detail = '', count = null } = {}) {
  const st = PROBE_STATES.includes(state) ? state : 'failed';
  const o = { state: st, source: str(source) || '' };
  const d = str(detail);
  if (d) o.detail = d;
  if (count != null && Number.isFinite(Number(count))) o.count = Number(count);
  return o;
}

/**
 * 엣지가 보낸 `extra.resources`·`extra.resourcesProbe` 를 좁힌다(중앙 수신 정제 — `central/edgeRecord.js` 가 부른다).
 * 아는 필드만 · 객체만 · 상한. 뺀 원소 수는 `extra.resourcesDropped` 에 더한다. `o` 를 제자리에서 고치고 바꾼 수를 돌려준다.
 */
export function sanitizeEdgeResources(o) {
  const ex = o?.extra;
  if (!ex || typeof ex !== 'object' || Array.isArray(ex)) return 0;
  let n = 0;
  if (Object.hasOwn(ex, 'resources')) {
    if (!Array.isArray(ex.resources)) { ex.resources = []; n += 1; }
    const before = ex.resources.length;
    const { list, dropped } = normalizeResourceList(ex.resources);
    ex.resources = list;
    if (dropped) ex.resourcesDropped = (numOrNull(ex.resourcesDropped) || 0) + dropped;
    else if (Object.hasOwn(ex, 'resourcesDropped')) ex.resourcesDropped = numOrNull(ex.resourcesDropped);
    n += before - list.length;
  }
  if (Object.hasOwn(ex, 'resourcesProbe')) {
    const p = ex.resourcesProbe;
    const out = {};
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      for (const kind of Object.keys(RESOURCE_KINDS)) {
        const v = p[kind];
        if (v && typeof v === 'object' && !Array.isArray(v)) out[kind] = resourceProbe(v.state, v);
      }
    } else n += 1;
    ex.resourcesProbe = out;
  }
  return n;
}
