/**
 * servicemap/resolve.js — 서비스 소속 판정 코어(순수, v2.886). **판정은 여기 하나다** — 웹·다른 모듈에 복제하지 않는다.
 *
 * 순서(위가 이긴다):
 *   1. 고정(수동, pins)      — 자동 판정과 다르면 drift(검토 큐). 고정의 법인이 구성원의 법인과 다르면 무시하고 pinMismatch(4차 반증 16).
 *   2. vCenter 폴더 규칙(VM)  — vmPlacement.folderPath('/ERP/prod') 의 '/' 경계 접두, 가장 긴 접두. folderPath null(vApp 등)은 'placement-unknown'.
 *   3. 스캔 엔트리 라벨(베어메탈) — 등록부 scanRangeId → idrac-scan-ranges.json 엔트리 service 라벨. 라벨 = 서비스명 또는 별칭.
 *   4. vSphere 태그(선택, VM) — 전역 카테고리가 정해지고 그 법인이 켰을 때만. 태그를 못 읽었으면 'unchecked'(미지정과 다르다).
 *   5. 이름 규칙(선택)        — 접두/접미/포함 3종(정규식 아님 — 4차 반증 14 ReDoS).
 *   6. 없음 → (미지정). reason 으로 왜인지 밝히고, 사람이 묶어 연결할 값은 unmapped 로 싣는다.
 * 서비스를 **자동으로 만드는 경로는 없다** — 규칙·별칭은 기존 서비스에만 붙는다.
 * 비교는 전부 소문자(4차 반증 20).
 *
 * 구성원 입력 모양:
 *   { key, kind:'vm'|'bm', corp, name, folderPath?:string|null, tags?:string[]|null, scan?:{entryId,label}|null }
 *   tags: undefined = 태그 규칙 꺼짐 · null = 그 vCenter 태그를 못 읽음(unchecked) · [] = 읽었고 카테고리 태그 없음.
 */
const lc = (s) => String(s ?? '').trim().toLowerCase();
const NAME_INPUT_MAX = 128;   // 이름 규칙 입력 상한(선형 비교라 길이만 자른다)
const FOLDER_INPUT_MAX = 256;

/** 저장소(map) → 법인별 판정 색인. 요청(세대)당 한 번 만든다(4차 반증 9 — 구성원마다 전 법인 규칙을 훑지 않는다). */
export function buildIndex(map) {
  const idx = new Map();
  for (const [vc, c] of Object.entries(map?.corps || {})) {
    const svcById = new Map(); const svcByName = new Map();
    for (const s of c.services || []) { svcById.set(s.id, s); if (!svcByName.has(lc(s.name))) svcByName.set(lc(s.name), s); }
    const rules = (c.folderRules || []).filter((r) => svcById.has(r.serviceId)).slice().sort((a, b) => b.prefix.length - a.prefix.length);
    const aliasScan = new Map(); const aliasTag = new Map();
    for (const a of c.aliases || []) { if (!svcById.has(a.serviceId)) continue; (a.kind === 'scan' ? aliasScan : aliasTag).set(lc(a.value), a.serviceId); }
    const nameRules = (c.nameRules || []).filter((r) => svcById.has(r.serviceId)).map((r) => ({ ...r, v: lc(r.value) }));
    idx.set(vc, { svcById, svcByName, rules, aliasScan, aliasTag, nameRules, tagEnabled: c.tagEnabled === true });
  }
  return idx;
}

/** 폴더 접두 일치 — '/' 경계. 루트 규칙('/')은 루트 VM('/')만(모든 VM 을 삼키지 않게). */
export function folderMatches(prefix, folderPath) {
  if (typeof folderPath !== 'string' || !prefix) return false;
  if (prefix === '/') return folderPath === '/';
  return folderPath === prefix || folderPath.startsWith(`${prefix}/`);
}
function nameRuleOf(c, name) {
  const n = lc(String(name ?? '').slice(0, NAME_INPUT_MAX));
  if (!n) return null;
  for (const r of c.nameRules) {
    if ((r.match === 'prefix' && n.startsWith(r.v)) || (r.match === 'suffix' && n.endsWith(r.v)) || (r.match === 'contains' && n.includes(r.v))) return r;
  }
  return null;
}
const hit = (serviceId, src, via) => ({ serviceId, src, via: String(via ?? '') });

/** 자동 판정(고정 제외). 순수. */
export function autoResolve(m, idx, { tagCategory = '' } = {}) {
  if (!m || !m.corp) return { serviceId: null, src: 'none', reason: 'no-corp' };
  const c = idx.get(m.corp);
  if (m.kind === 'vm') {
    const f = typeof m.folderPath === 'string' ? m.folderPath.slice(0, FOLDER_INPUT_MAX) : null;
    if (c && f != null) for (const r of c.rules) if (folderMatches(r.prefix, f)) return hit(r.serviceId, 'folder', r.prefix);
    let unchecked = false; let tagUnmapped = null;
    if (c && tagCategory && c.tagEnabled) {
      if (m.tags === null) unchecked = true;
      else if (Array.isArray(m.tags) && m.tags.length) {
        const t0 = String(m.tags[0]);
        const s = c.svcByName.get(lc(t0)) || null;
        const viaAlias = s ? null : c.aliasTag.get(lc(t0));
        if (s) return { ...hit(s.id, 'tag', t0), ...(m.tags.length > 1 ? { multi: true } : {}) };
        if (viaAlias) return { ...hit(viaAlias, 'tag', t0), ...(m.tags.length > 1 ? { multi: true } : {}) };
        tagUnmapped = t0;
      }
    }
    const nr = c ? nameRuleOf(c, m.name) : null;
    if (nr) return hit(nr.serviceId, 'rule', `${nr.match}:${nr.value}`);
    if (tagUnmapped != null) return { serviceId: null, src: 'none', reason: 'tag-unmapped', unmapped: { kind: 'tag', value: tagUnmapped }, ...(unchecked ? { unchecked } : {}) };
    if (f == null) return { serviceId: null, src: 'none', reason: 'placement-unknown', ...(unchecked ? { unchecked } : {}) };
    return { serviceId: null, src: 'none', reason: unchecked ? 'tags-unchecked' : 'no-folder-rule', unmapped: { kind: 'folder', value: f }, ...(unchecked ? { unchecked } : {}) };
  }
  // 베어메탈
  const scan = m.scan || null;
  if (scan && scan.label && c) {
    const s = c.svcByName.get(lc(scan.label)) || null;
    if (s) return hit(s.id, 'scan', scan.label);
    const a = c.aliasScan.get(lc(scan.label));
    if (a) return hit(a, 'scan', scan.label);
  }
  const nr = c ? nameRuleOf(c, m.name) : null;
  if (nr) return hit(nr.serviceId, 'rule', `${nr.match}:${nr.value}`);
  if (!scan) return { serviceId: null, src: 'none', reason: 'no-scan-entry' };
  if (!scan.label) return { serviceId: null, src: 'none', reason: 'scan-label-empty', unmapped: { kind: 'entry', value: String(scan.entryId || '') } };
  return { serviceId: null, src: 'none', reason: 'scan-label-unmapped', unmapped: { kind: 'scan', value: scan.label } };
}

/**
 * 고정까지 포함한 최종 판정. 순수.
 * @returns {{serviceId, src, via?, reason?, unmapped?, unchecked?, auto, drift?, redundant?, pinMismatch?, pinDangling?}}
 */
export function resolveMember(m, idx, ctx = {}, pins = {}) {
  const auto = autoResolve(m, idx, ctx);
  const pin = pins && m ? pins[m.key] : null;
  if (!pin) return { ...auto, auto };
  if (pin.corp !== m.corp) return { ...auto, auto, pinMismatch: { serviceId: pin.serviceId, corp: pin.corp } };
  const c = idx.get(m.corp);
  if (!c || !c.svcById.has(pin.serviceId)) return { ...auto, auto, pinDangling: true };
  const differs = !!auto.serviceId && auto.serviceId !== pin.serviceId;
  return { serviceId: pin.serviceId, src: 'pin', via: pin.by || '', auto, drift: differs && !pin.reviewed, redundant: auto.serviceId === pin.serviceId };
}
