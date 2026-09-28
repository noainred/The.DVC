/**
 * ipam/vcResolve.js — vCenter 이름·ID → ID 해석기(순수, v2.639 감사 S4).
 *
 * 왜 하나로 모으는가: 같은 일을 두 벌이 **다른 규칙**으로 하고 있었다.
 *   · routes/admin/centralIpam.js resolveVc — 이름이 두 vCenter 에 걸리면 **첫 항목**을 골랐다(등록부 loadVcenterConfig).
 *     오타 없이도(표시 이름이 같은 두 법인) CSV 가져오기가 다른 vCenter 의 스캔 대역을 덮어쓸 수 있다.
 *   · routes/api/ipamExport.js vcResolver — 모호하면 null(스냅샷 snap.vcenters).
 * 규칙은 뒤쪽(지어내지 않는다)이다: 정확한 id → 대소문자만 다른 id → 이름(대소문자·앞뒤 공백 무시). 이름이 둘 이상에 걸리면
 * **null + ambiguous:true + 후보 id 목록** — 호출부가 '어느 vCenter 인지 알 수 없다' 고 말한다(조용히 하나를 고르지 않는다).
 * 목록(vcenters)은 호출부가 넘긴다 — 등록부든 스냅샷이든, 범위 계정이면 **범위로 거른 뒤** 넘긴다(범위 밖은 '모르는 vCenter'
 * 와 같은 결과여야 한다 — v2.611 LEFT2611-04).
 */

const t = (v) => (v == null ? '' : String(v).trim());
const low = (v) => t(v).toLowerCase();

/**
 * @param {Array<{id:string, name?:string}>} vcenters
 * @returns {(nameOrId:any) => { id: string|null, ambiguous: boolean, candidates?: string[] }}
 *   { id, ambiguous:false }                         — 찾았다
 *   { id:null, ambiguous:true, candidates:[ids] }   — 이름이 둘 이상에 걸린다(어느 것인지 알 수 없다)
 *   { id:null, ambiguous:false }                    — 없다(빈 입력 포함)
 */
export function makeVcResolver(vcenters) {
  const list = (Array.isArray(vcenters) ? vcenters : []).filter((v) => v && t(v.id));
  const byId = new Set(list.map((v) => t(v.id)));
  const byIdLow = new Map(); // 소문자 id → id 목록(대소문자만 다른 id 가 둘이면 모호)
  const byName = new Map();  // 소문자 이름 → id 목록
  for (const v of list) {
    const id = t(v.id);
    const li = low(id);
    if (!byIdLow.has(li)) byIdLow.set(li, []);
    if (!byIdLow.get(li).includes(id)) byIdLow.get(li).push(id);
    const n = low(v.name);
    if (!n) continue;
    if (!byName.has(n)) byName.set(n, []);
    if (!byName.get(n).includes(id)) byName.get(n).push(id);
  }
  const pick = (ids) => (ids.length === 1 ? { id: ids[0], ambiguous: false } : { id: null, ambiguous: true, candidates: [...ids] });
  return (nameOrId) => {
    const s = t(nameOrId);
    if (!s) return { id: null, ambiguous: false };
    if (byId.has(s)) return { id: s, ambiguous: false };
    const li = byIdLow.get(low(s));
    if (li) return pick(li);
    const byN = byName.get(low(s));
    if (byN) return pick(byN);
    return { id: null, ambiguous: false };
  };
}
