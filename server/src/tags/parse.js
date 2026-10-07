/**
 * tags/parse.js — vSphere 태그(vAPI REST)와 사용자 지정 속성(SOAP CustomFieldsManager) 파싱·정제(v2.703 — A15, 순수).
 * 스냅샷에는 vcenter.tagInv 로 압축해 싣는다(VM 객체에 태그 문자열을 붙이지 않는다 — /vms 응답이 커진다).
 *   { at, tagsAt, customAt, tagsError, customError, tagsUnsupported,
 *     categories:[{id,name,cardinality,types}], tags:[{id,name,cat}](cat = categories 인덱스),
 *     vmTags:{ vmRef:[tagIdx] }, hostTags:{ hostRef:[tagIdx] },
 *     fields:[{key,name,type}], vmCustom:{ vmRef:{ fieldKey:value } }, truncated:{ tags, custom } }
 * 정직 규칙: 태그를 못 읽었으면 tags 는 null(빈 배열 아님 — '태그 0개' 와 다르다). 사용자 지정 속성도 같다.
 */
export const TAGS_MAX = 3000;
export const CATEGORIES_MAX = 500;
export const VM_TAGS_MAX = 40;
export const FIELDS_MAX = 300;
export const VALUE_MAX = 256;

const str = (v, n = 256) => (typeof v === 'string' ? (v.length > n ? v.slice(0, n) : v) : '');
const xmlUnesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** CustomFieldsManager.field 원문 → [{key,name,type,mo}] */
export function parseCustomFieldDefs(xml) {
  const out = [];
  if (typeof xml !== 'string') return out;
  let i = 0;
  for (;;) {
    const s = xml.indexOf('<CustomFieldDef', i); if (s < 0) break;
    const e = xml.indexOf('</CustomFieldDef>', s); if (e < 0) break;
    const blk = xml.slice(s, e); i = e + 17;
    const key = /<key>(\d{1,9})<\/key>/.exec(blk)?.[1];
    const name = /<name>([^<]{0,256})<\/name>/.exec(blk)?.[1];
    if (!key || name == null) continue;
    out.push({ key: Number(key), name: xmlUnesc(name), type: (/<type>([^<]{0,64})<\/type>/.exec(blk)?.[1] || '').replace(/^xsd:/, ''), mo: /<managedObjectType>([^<]{0,64})<\/managedObjectType>/.exec(blk)?.[1] || '' });
    if (out.length >= FIELDS_MAX) break;
  }
  return out;
}

/** VirtualMachine.customValue 원문 → { key: value } (값이 빈 문자열이면 '값 없음' 으로 싣지 않는다) */
export function parseCustomValues(xml) {
  const out = {};
  if (typeof xml !== 'string' || !xml) return out;
  for (const m of xml.matchAll(/<key>(\d{1,9})<\/key>\s{0,20}<value[^>]{0,80}>([^<]{0,2000})<\/value>/g)) {
    const v = xmlUnesc(m[2]).trim();
    if (v) out[m[1]] = v.length > VALUE_MAX ? v.slice(0, VALUE_MAX) : v;
  }
  return out;
}

/** vAPI 태그 응답들 → 압축 형태. idsOf: 카테고리 상세 배열·태그 상세 배열·연결 배열. */
export function buildTagIndex(categories, tags, associations) {
  const cats = []; const catIdx = new Map();
  for (const c of Array.isArray(categories) ? categories : []) {
    if (!c || typeof c.id !== 'string' || catIdx.has(c.id)) continue;
    if (cats.length >= CATEGORIES_MAX) break;
    catIdx.set(c.id, cats.length);
    cats.push({ id: str(c.id, 200), name: str(c.name, 128), cardinality: c.cardinality === 'SINGLE' ? 'SINGLE' : c.cardinality === 'MULTIPLE' ? 'MULTIPLE' : null, types: (Array.isArray(c.associable_types) ? c.associable_types : []).slice(0, 20).map((t) => str(t, 64)) });
  }
  const tg = []; const tagIdx = new Map();
  let dropped = 0;
  for (const t of Array.isArray(tags) ? tags : []) {
    if (!t || typeof t.id !== 'string' || tagIdx.has(t.id)) continue;
    if (tg.length >= TAGS_MAX) { dropped += 1; continue; }
    tagIdx.set(t.id, tg.length);
    tg.push({ id: str(t.id, 200), name: str(t.name, 128), cat: catIdx.has(t.category_id) ? catIdx.get(t.category_id) : null });
  }
  const vmTags = {}; const hostTags = {};
  for (const a of Array.isArray(associations) ? associations : []) {
    const ti = tagIdx.get(a?.tag_id);
    if (ti == null) continue;
    for (const o of Array.isArray(a.object_ids) ? a.object_ids : []) {
      const ref = typeof o?.id === 'string' ? o.id : null;
      if (!ref) continue;
      const bucket = o.type === 'VirtualMachine' ? vmTags : o.type === 'HostSystem' ? hostTags : null;
      if (!bucket) continue;
      const arr = bucket[ref] || (bucket[ref] = []);
      if (arr.length < VM_TAGS_MAX && !arr.includes(ti)) arr.push(ti);
    }
  }
  return { categories: cats, tags: tg, vmTags, hostTags, tagsDropped: dropped };
}

const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const refOk = (k) => typeof k === 'string' && k.length <= 64 && !RESERVED.has(k) && /^[\w.-]+$/.test(k);

/** 엣지 수신 정제 — 아는 필드만·상한·참조 형식. 반환 { value, dropped } */
export function sanitizeTagInv(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return { value: null, dropped: x == null ? 0 : 1 };
  let dropped = 0;
  const num = (v) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : null);
  const out = {
    at: num(x.at), tagsAt: num(x.tagsAt), customAt: num(x.customAt),
    tagsError: x.tagsError ? str(String(x.tagsError), 300) : null,
    customError: x.customError ? str(String(x.customError), 300) : null,
    tagsUnsupported: x.tagsUnsupported === true,
    categories: null, tags: null, vmTags: null, hostTags: null, fields: null, vmCustom: null,
    truncated: { tags: num(x.truncated?.tags) || 0, custom: num(x.truncated?.custom) || 0 },
    // v2.719(감사 B1-04): 엣지도 '태그 연결을 다 읽지 못했다' 를 싣는다 — 없으면(구버전 엣지) analyze 가 잘림 개수로 판정한다.
    ...(typeof x.partialTags === 'boolean' ? { partialTags: x.partialTags } : {}),
    retryAt: num(x.retryAt),
  };
  if (Array.isArray(x.categories)) out.categories = x.categories.slice(0, CATEGORIES_MAX).filter((c) => c && typeof c === 'object').map((c) => ({ id: str(c.id, 200), name: str(c.name, 128), cardinality: c.cardinality === 'SINGLE' || c.cardinality === 'MULTIPLE' ? c.cardinality : null, types: Array.isArray(c.types) ? c.types.slice(0, 20).map((t) => str(t, 64)) : [] }));
  if (Array.isArray(x.tags)) {
    const nc = out.categories ? out.categories.length : 0;
    out.tags = x.tags.slice(0, TAGS_MAX).filter((t) => t && typeof t === 'object').map((t) => ({ id: str(t.id, 200), name: str(t.name, 128), cat: Number.isInteger(t.cat) && t.cat >= 0 && t.cat < nc ? t.cat : null }));
  }
  const nt = out.tags ? out.tags.length : 0;
  const idxMap = (m, cap) => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    const o = {}; let n = 0;
    for (const [k, v] of Object.entries(m)) {
      if (!refOk(k) || !Array.isArray(v)) { dropped += 1; continue; }
      if (++n > cap) { dropped += 1; continue; }
      o[k] = v.filter((i) => Number.isInteger(i) && i >= 0 && i < nt).slice(0, VM_TAGS_MAX);
    }
    return o;
  };
  if (out.tags) { out.vmTags = idxMap(x.vmTags, 50_000); out.hostTags = idxMap(x.hostTags, 10_000); }
  if (Array.isArray(x.fields)) out.fields = x.fields.slice(0, FIELDS_MAX).filter((f) => f && typeof f === 'object' && Number.isFinite(Number(f.key))).map((f) => ({ key: Number(f.key), name: str(f.name, 256), type: str(f.type, 64), mo: str(f.mo, 64) }));
  if (out.fields && x.vmCustom && typeof x.vmCustom === 'object' && !Array.isArray(x.vmCustom)) {
    const o = {}; let n = 0;
    for (const [k, v] of Object.entries(x.vmCustom)) {
      if (!refOk(k) || !v || typeof v !== 'object' || Array.isArray(v)) { dropped += 1; continue; }
      if (++n > 50_000) { dropped += 1; continue; }
      const vv = {};
      for (const [fk, fv] of Object.entries(v).slice(0, FIELDS_MAX)) if (/^\d{1,9}$/.test(fk) && typeof fv === 'string' && fv) vv[fk] = str(fv, VALUE_MAX);
      o[k] = vv;
    }
    out.vmCustom = o;
  }
  return { value: out, dropped };
}
