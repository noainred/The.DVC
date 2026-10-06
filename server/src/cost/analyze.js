/**
 * cost/analyze.js — 특수 기능 '비용 배분(쇼백)'(도구 키 `cost-showback`, v2.707 — C11) 계산(순수).
 * 입력은 스냅샷 VM(할당 vCPU·메모리·스토리지)과 단가 설정(cost/settings.js). vCenter 왕복 0.
 *
 * 정직 규칙
 *  · 단가가 비어 있으면 그 항목 비용은 null 이다(0 원이 아니다) — 화면은 할당량만 보여 준다.
 *    세 단가 중 일부만 있으면 합계는 '있는 항목만의 합' 이고 `partialRates` 로 밝힌다.
 *  · 비용은 **할당 기준**이다(실사용 기준이 아니다) — 쇼백은 '차지한 자원' 을 나누는 것이고 화면이 그렇게 말한다.
 *  · 스토리지 용량을 모르는 VM 은 그 항목을 null 로 두고 합계에서 빼며 개수를 밝힌다(0 GB 로 채우지 않는다).
 *  · 태그 기준으로 나눌 때 태그를 못 읽은 vCenter 의 VM 은 '(태그 확인 안 됨)', 그 카테고리 태그가 없는 VM 은 '(태그 없음)' 이다.
 *    한 VM 에 그 카테고리 태그가 둘 이상이면 **첫 태그 하나**에만 넣고 개수를 밝힌다(두 번 세면 합계가 실제보다 커진다).
 *  · 템플릿은 넣지 않는다.
 */
import { vmRefOf, vmTagsOf, tagStateOf } from '../tags/analyze.js';

export const GROUP_KINDS = Object.freeze(['vcenter', 'cluster', 'folder', 'tag']);
export const ROWS_MAX = 500;
export const VM_ROWS_MAX = 2000;
export const NO_TAG = '(태그 없음)';
export const TAG_UNKNOWN = '(태그 확인 안 됨)';
const r2 = (x) => Math.round(x * 100) / 100;
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/** VM 하나의 할당량 — 꺼짐 정책 적용. 스토리지 용량을 모르면 null. */
export function vmAllocation(v, s) {
  const on = v.powerState === 'POWERED_ON';
  if (!on && s.offPolicy === 'none') return null;
  const cpuOk = on || s.offPolicy === 'full';
  const used = fin(v.storageGB) ? v.storageGB : null;
  const storage = used == null ? null : s.storageBasis === 'provisioned' ? used + (fin(v.uncommittedGB) ? v.uncommittedGB : 0) : used;
  return {
    vcpu: cpuOk && fin(v.cpuCount) ? v.cpuCount : (cpuOk ? null : 0),
    ramGB: cpuOk && fin(v.memMB) ? r2(v.memMB / 1024) : (cpuOk ? null : 0),
    storageGB: storage == null ? null : r2(storage),
  };
}

/** 할당량 × 단가 — 단가가 없으면 그 항목 null. 할당을 모르면(null) 그 항목 null. */
export function costOf(a, s) {
  const part = (qty, rate) => (rate == null || qty == null ? null : r2(qty * rate));
  const cpu = part(a.vcpu, s.vcpu); const ram = part(a.ramGB, s.ramGB); const sto = part(a.storageGB, s.storageGB);
  const parts = [cpu, ram, sto].filter((x) => x != null);
  return { cpu, ram, storage: sto, total: parts.length ? r2(parts.reduce((x, y) => x + y, 0)) : null };
}

/**
 * @param snap   { vcenters, vms }(범위로 이미 거른 것)
 * @param s      단가 설정
 * @param opts   { by: 'vcenter'|'cluster'|'folder'|'tag', category, q, vcName:Map }
 */
export function analyzeCost(snap, s, { by = 'vcenter', category = '', q = '', vcName = new Map() } = {}) {
  const kind = GROUP_KINDS.includes(by) ? by : 'vcenter';
  const rates = { vcpu: s.vcpu ?? null, ramGB: s.ramGB ?? null, storageGB: s.storageGB ?? null };
  const rateCount = Object.values(rates).filter((x) => x != null).length;
  const invByVc = new Map((snap.vcenters || []).map((vc) => [vc.id, vc.tagInv || null]));
  const catKey = String(category || '').toLowerCase();
  const groups = new Map();
  const notes = { excludedOff: 0, storageUnknown: 0, cpuUnknown: 0, multiTag: 0, tagUnknown: 0, templates: 0 };
  const vmRows = [];
  const total = { vms: 0, vcpu: 0, ramGB: 0, storageGB: 0, cpu: 0, ram: 0, storage: 0, total: 0 };
  for (const v of snap.vms || []) {
    if (v.template) { notes.templates += 1; continue; }
    const a = vmAllocation(v, s);
    if (!a) { notes.excludedOff += 1; continue; }
    if (a.storageGB == null) notes.storageUnknown += 1;
    if (a.vcpu == null || a.ramGB == null) notes.cpuUnknown += 1;
    const c = costOf(a, s);
    let key; let label;
    if (kind === 'vcenter') { key = v.vcenterId; label = vcName.get(v.vcenterId) || v.vcenterId; }
    else if (kind === 'cluster') { key = `${v.vcenterId}\u0000${v.cluster || ''}`; label = v.cluster || '(클러스터 없음)'; }
    else if (kind === 'folder') { key = `${v.vcenterId}\u0000${v.folder || ''}`; label = v.folder || '(폴더 없음)'; }
    else {
      const inv = invByVc.get(v.vcenterId);
      const st = tagStateOf(inv);
      if (!catKey) { key = TAG_UNKNOWN; label = '(카테고리를 고르세요)'; }
      else if (st !== 'ok' && st !== 'stale') { key = TAG_UNKNOWN; label = TAG_UNKNOWN; notes.tagUnknown += 1; }
      else {
        const tags = (vmTagsOf(inv, vmRefOf(v.vcenterId, v.id)).tags || []).filter((t) => String(t.category).toLowerCase() === catKey);
        if (tags.length > 1) notes.multiTag += 1;
        label = tags[0]?.tag || NO_TAG; key = label;
      }
    }
    const g = groups.get(key) || { key, label, vcenterId: kind === 'cluster' || kind === 'folder' || kind === 'vcenter' ? v.vcenterId : null,
      vcenterName: kind === 'tag' ? null : vcName.get(v.vcenterId) || v.vcenterId,
      vms: 0, on: 0, vcpu: 0, ramGB: 0, storageGB: 0, storageUnknown: 0, cpu: 0, ram: 0, storage: 0, total: 0 };
    g.vms += 1; if (v.powerState === 'POWERED_ON') g.on += 1;
    if (a.vcpu != null) g.vcpu += a.vcpu; if (a.ramGB != null) g.ramGB += a.ramGB;
    if (a.storageGB != null) g.storageGB += a.storageGB; else g.storageUnknown += 1;
    if (c.cpu != null) g.cpu += c.cpu; if (c.ram != null) g.ram += c.ram; if (c.storage != null) g.storage += c.storage; if (c.total != null) g.total += c.total;
    groups.set(key, g);
    total.vms += 1;
    if (a.vcpu != null) total.vcpu += a.vcpu; if (a.ramGB != null) total.ramGB += a.ramGB; if (a.storageGB != null) total.storageGB += a.storageGB;
    if (c.cpu != null) total.cpu += c.cpu; if (c.ram != null) total.ram += c.ram; if (c.storage != null) total.storage += c.storage; if (c.total != null) total.total += c.total;
    vmRows.push({ id: v.id, name: v.name, vcenterName: vcName.get(v.vcenterId) || v.vcenterId, group: label, powerState: v.powerState, ...a, cost: c.total });
  }
  const fix = (o) => ({ ...o, ramGB: r2(o.ramGB), storageGB: r2(o.storageGB), cpu: rates.vcpu == null ? null : r2(o.cpu), ram: rates.ramGB == null ? null : r2(o.ram), storage: rates.storageGB == null ? null : r2(o.storage), total: rateCount ? r2(o.total) : null });
  const sum = fix(total);
  const qq = String(q || '').toLowerCase();
  let rows = [...groups.values()].map((g) => ({ ...fix(g), share: sum.total ? r2((g.total / sum.total) * 100) : null }));
  if (qq) rows = rows.filter((r) => [r.label, r.vcenterName].some((x) => String(x || '').toLowerCase().includes(qq)));
  rows.sort((a, b) => (rateCount ? (b.total ?? 0) - (a.total ?? 0) : 0) || b.vcpu - a.vcpu || b.storageGB - a.storageGB || String(a.label).localeCompare(String(b.label)));
  vmRows.sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || (b.vcpu ?? 0) - (a.vcpu ?? 0) || String(a.name).localeCompare(String(b.name)));
  return {
    by: kind, category: kind === 'tag' ? category || null : null, rates, currency: s.currency, storageBasis: s.storageBasis, offPolicy: s.offPolicy,
    ratesSet: rateCount, partialRates: rateCount > 0 && rateCount < 3, totals: sum, notes,
    groups: rows.slice(0, ROWS_MAX), groupsOmitted: Math.max(0, rows.length - ROWS_MAX),
    vms: vmRows.slice(0, VM_ROWS_MAX), vmsOmitted: Math.max(0, vmRows.length - VM_ROWS_MAX),
  };
}

/** 태그 기준 화면의 카테고리 목록(태그를 읽은 vCenter 들의 합집합). */
export function tagCategories(vcenters) {
  const m = new Map();
  for (const vc of vcenters || []) {
    const inv = vc.tagInv;
    for (const c of inv?.categories || []) if (c?.name) { const k = c.name.toLowerCase(); if (!m.has(k)) m.set(k, c.name); }
  }
  return [...m.values()].sort((a, b) => a.localeCompare(b));
}
