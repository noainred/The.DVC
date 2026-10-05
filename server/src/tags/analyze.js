/**
 * tags/analyze.js — 특수 기능 '태그·사용자 지정 속성 점검'(도구 키 `vm-tags`, v2.703 — A15) 판정(순수).
 * 입력은 스냅샷 vcenters(vc.tagInv)·vms 와 정책(requiredCategories·corpCategory). vCenter 왕복 0.
 * 정직 규칙
 *  · 태그를 못 읽은 vCenter 의 VM 은 '누락' 이 아니라 '확인 안 됨' 으로 센다(빈 결과를 '모두 붙어 있다' 라 말하지 않는다).
 *  · 필수 카테고리가 그 vCenter 에 아예 없으면 그 사실을 따로 밝힌다(모든 VM 이 누락으로 보이는 이유).
 *  · 템플릿은 점검하지 않는다(운영 VM 이 아니다).
 */
const lc = (s) => String(s || '').toLowerCase();
export const ROWS_MAX = 2000;

export function vmRefOf(vcenterId, vmId) {
  return typeof vmId === 'string' && vmId.startsWith(`${vcenterId}:`) ? vmId.slice(vcenterId.length + 1) : null;
}

/** 한 VM 의 태그·속성 — [{category, tag}] · [{name, value}] (못 읽었으면 null). */
export function vmTagsOf(inv, ref) {
  if (!inv) return { tags: null, custom: null };
  const tags = Array.isArray(inv.tags) ? (inv.vmTags?.[ref] || []).map((i) => inv.tags[i]).filter(Boolean)
    .map((t) => ({ category: t.cat != null ? inv.categories?.[t.cat]?.name || '' : '', tag: t.name })) : null;
  const fieldName = new Map((inv.fields || []).map((f) => [String(f.key), f.name]));
  const custom = Array.isArray(inv.fields) ? Object.entries(inv.vmCustom?.[ref] || {}).map(([k, v]) => ({ name: fieldName.get(k) || `#${k}`, value: v })) : null;
  return { tags, custom };
}

export const TAG_STATES = Object.freeze(['ok', 'stale', 'error', 'unsupported', 'not-collected']);
export function tagStateOf(inv) {
  if (!inv) return 'not-collected';
  if (Array.isArray(inv.tags)) return inv.tagsError ? 'stale' : 'ok';
  if (inv.tagsUnsupported) return 'unsupported';
  return inv.tagsError ? 'error' : 'not-collected';
}

export function analyzeTags(vcenters, vms, policy = {}, { q = '' } = {}) {
  const req = (policy.requiredCategories || []).map((n) => ({ name: n, key: lc(n) }));
  const corpKey = lc(policy.corpCategory);
  const qq = lc(q);
  const vcList = [];
  const cats = new Map();   // key -> {name, cardinality, tags:Set, vms, vcenters:Set}
  const fields = new Map(); // key(name lc) -> {name, filled, checked}
  const missingByCat = Object.fromEntries(req.map((r) => [r.name, 0]));
  const rows = [];
  const corp = new Map();   // tag -> {tag, vms, vcenters:Set}
  let checked = 0; let unchecked = 0; let corpUnassigned = 0; let corpChecked = 0;
  const vmsBy = new Map();
  for (const v of vms || []) { if (v.template) continue; const a = vmsBy.get(v.vcenterId) || []; a.push(v); vmsBy.set(v.vcenterId, a); }
  for (const vc of vcenters || []) {
    const inv = vc.tagInv || null;
    const state = tagStateOf(inv);
    const list = vmsBy.get(vc.id) || [];
    const catIdxByKey = new Map();
    (inv?.categories || []).forEach((c, i) => { if (c) catIdxByKey.set(lc(c.name), i); });
    const reqAbsent = req.filter((r) => !catIdxByKey.has(r.key)).map((r) => r.name);
    const tagsOk = state === 'ok' || state === 'stale';
    const vs = { vcenterId: vc.id, name: vc.name || vc.id, state, tagsAt: inv?.tagsAt ?? null, customAt: inv?.customAt ?? null,
      tagsError: inv?.tagsError || null, customError: inv?.customError || null, vms: list.length,
      categories: tagsOk ? (inv.categories || []).length : null, tags: tagsOk ? (inv.tags || []).length : null,
      requiredAbsent: tagsOk ? reqAbsent : null, withMissing: tagsOk ? 0 : null, truncated: inv?.truncated || null };
    if (tagsOk) {
      inv.categories.forEach((c, i) => {
        const k = lc(c.name);
        const e = cats.get(k) || { name: c.name, cardinality: c.cardinality, tags: new Set(), vms: 0, vcenters: new Set() };
        e.vcenters.add(vc.id);
        for (const t of inv.tags) if (t.cat === i) e.tags.add(t.name);
        cats.set(k, e);
      });
    }
    const fieldByKey = new Map((inv?.fields || []).map((f) => [String(f.key), f.name]));
    for (const vm of list) {
      const ref = vmRefOf(vc.id, vm.id);
      if (Array.isArray(inv?.fields)) {
        const cv = (ref && inv.vmCustom?.[ref]) || {};
        for (const f of inv.fields) {
          const k = lc(f.name);
          const e = fields.get(k) || { name: f.name, filled: 0, checked: 0, vcenters: new Set() };
          e.checked += 1; e.vcenters.add(vc.id);
          if (cv[String(f.key)]) e.filled += 1;
          fields.set(k, e);
        }
      }
      if (!tagsOk) { unchecked += 1; continue; }
      checked += 1;
      const idxs = (ref && inv.vmTags?.[ref]) || [];
      const present = new Set();
      const corpTags = [];
      for (const i of idxs) {
        const t = inv.tags[i]; if (!t) continue;
        const cname = t.cat != null ? inv.categories[t.cat]?.name : null;
        if (!cname) continue;
        const ck = lc(cname); present.add(ck);
        const e = cats.get(ck); if (e) e.vms += 1;
        if (corpKey && ck === corpKey) corpTags.push(t.name);
      }
      const missing = req.filter((r) => !present.has(r.key)).map((r) => r.name);
      for (const m of missing) missingByCat[m] += 1;
      if (corpKey) {
        corpChecked += 1;
        if (!corpTags.length) corpUnassigned += 1;
        for (const ct of corpTags) { const e = corp.get(ct) || { tag: ct, vms: 0, vcenters: new Set() }; e.vms += 1; e.vcenters.add(vc.id); corp.set(ct, e); }
      }
      if (missing.length) {
        vs.withMissing += 1;
        if (!qq || [vm.name, vs.name, ...missing].some((x) => lc(x).includes(qq))) {
          rows.push({ vcenterId: vc.id, vcenterName: vs.name, vmId: vm.id, vm: vm.name, powerState: vm.powerState, missing, corpTag: corpKey ? (corpTags[0] || null) : undefined, fieldsFilled: fieldByKey.size ? Object.keys((ref && inv.vmCustom?.[ref]) || {}).length : null });
        }
      }
    }
    vcList.push(vs);
  }
  rows.sort((a, b) => b.missing.length - a.missing.length || String(a.vcenterName).localeCompare(String(b.vcenterName)) || String(a.vm).localeCompare(String(b.vm)));
  return {
    policy: { requiredCategories: req.map((r) => r.name), corpCategory: policy.corpCategory || '' },
    coverage: { vcenters: vcList.length, tagsOk: vcList.filter((v) => v.state === 'ok' || v.state === 'stale').length, checkedVms: checked, uncheckedVms: unchecked },
    vcenters: vcList.sort((a, b) => String(a.name).localeCompare(String(b.name))),
    categories: [...cats.values()].map((e) => ({ name: e.name, cardinality: e.cardinality, tags: [...e.tags].sort().slice(0, 50), tagCount: e.tags.size, vms: e.vms, vcenters: e.vcenters.size })).sort((a, b) => b.vms - a.vms || a.name.localeCompare(b.name)),
    missingByCategory: missingByCat,
    corp: corpKey ? { category: policy.corpCategory, checked: corpChecked, unassigned: corpUnassigned, values: [...corp.values()].map((e) => ({ tag: e.tag, vms: e.vms, vcenters: e.vcenters.size })).sort((a, b) => b.vms - a.vms) } : null,
    fields: [...fields.values()].map((e) => ({ name: e.name, filled: e.filled, checked: e.checked, vcenters: e.vcenters.size })).sort((a, b) => a.name.localeCompare(b.name)),
    matched: rows.length, rows: rows.slice(0, ROWS_MAX), omitted: Math.max(0, rows.length - ROWS_MAX),
  };
}
