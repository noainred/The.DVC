// vSphere 태그·사용자 지정 속성 갱신(v2.703 — A15). 인벤토리 수집 한 주기 안에서 vCenter 마다 tagRefreshMs(기본 6시간)에 한 번.
// 캐시는 인메모리다(재시작 뒤 첫 주기에 다시 읽는다). 실패는 격리한다(인벤토리 수집은 성공) — 실패하면 직전 값을 유지하고
// 오류를 싣는다(조용히 비우지 않는다). 태그는 REST 세션을 따로 연다 — 그 로그인 거부는 '태그 오류' 로만 남기고
// 주기 정지(authGuard)로 올리지 않는다(같은 계정의 SOAP 로그인이 방금 성공했다 — 401 이면 vAPI 권한·SSO 문제다).
import { config } from '../config.js';
import { VCenterClient } from '../vcenter/restClient.js';
import { poolSettled } from '../util/pool.js';
import { buildTagIndex, parseCustomFieldDefs, parseCustomValues, TAGS_MAX } from './parse.js';

const _byVc = new Map();
export const TAG_BUDGET_MS = 45_000;
const ASSOC_CHUNK = 100;

export function getTagInv(vcId) { return _byVc.get(vcId) || null; }
export function tagInvStatus() {
  const out = [];
  for (const [vcId, t] of _byVc) out.push({ vcenterId: vcId, at: t.at, tagsAt: t.tagsAt, customAt: t.customAt, tagsError: t.tagsError, customError: t.customError, tags: t.tags ? t.tags.length : null });
  return { vcenters: out.slice(0, 64), omitted: Math.max(0, out.length - 64) };
}
export function _resetTagInv() { _byVc.clear(); }

const msg = (e) => String(e?.message || e).slice(0, 300);

async function readTags(vc, signal, deadline, prev) {
  const rc = new VCenterClient(vc, { signal });
  await rc.login();
  try {
    const catIds = (await rc.listTagCategories()).slice(0, 500);
    const tagIds = await rc.listTags();
    const keepTags = tagIds.slice(0, TAGS_MAX);
    const prevTag = new Map((prev?.tags || []).map((t) => [t.id, t]));
    const prevCat = new Map((prev?.categories || []).map((c) => [c.id, c]));
    const cats = await poolSettled(catIds, 6, async (id) => (Date.now() < deadline ? rc.getTagCategory(id) : null));
    const tags = await poolSettled(keepTags, 6, async (id) => (Date.now() < deadline ? rc.getTag(id) : null));
    let cut = 0;
    const catObjs = cats.map((r, i) => {
      if (r.status === 'fulfilled' && r.value) return r.value;
      cut += 1; const p = prevCat.get(catIds[i]); return p ? { id: p.id, name: p.name, cardinality: p.cardinality, associable_types: p.types } : null;
    }).filter(Boolean);
    const tagObjs = tags.map((r, i) => {
      if (r.status === 'fulfilled' && r.value) return r.value;
      cut += 1;
      const p = prevTag.get(keepTags[i]);
      if (!p) return null;
      return { id: p.id, name: p.name, category_id: p.cat != null ? prev.categories[p.cat]?.id : null };
    }).filter(Boolean);
    const assoc = [];
    for (let i = 0; i < keepTags.length; i += ASSOC_CHUNK) {
      if (Date.now() >= deadline) { cut += keepTags.length - i; break; }
      const part = await rc.listAttachedObjectsOnTags(keepTags.slice(i, i + ASSOC_CHUNK));
      if (Array.isArray(part)) for (const a of part) assoc.push(a);
    }
    const idx = buildTagIndex(catObjs, tagObjs, assoc);
    return { ...idx, cut, dropped: Math.max(0, tagIds.length - keepTags.length) + idx.tagsDropped };
  } finally {
    await rc.logout();
  }
}

/**
 * @param c SOAP 클라이언트(로그인된 세션) · vmRefs 이 vCenter 의 VM moref
 * @returns 캐시된 tagInv(없으면 null)
 */
export async function refreshTagInv(c, vc, vmRefs, { now = Date.now(), signal = null, settings = config, budgetMs = TAG_BUDGET_MS } = {}) {
  if (!settings.tagScan) return getTagInv(vc.id);
  const prev = _byVc.get(vc.id) || null;
  if (prev && now - prev.at < settings.tagRefreshMs) return prev;
  const deadline = Date.now() + budgetMs;
  const next = {
    ...(prev || { categories: null, tags: null, vmTags: null, hostTags: null, fields: null, vmCustom: null, tagsAt: null, customAt: null }),
    at: now, tagsError: null, customError: null, tagsUnsupported: false, truncated: { tags: 0, custom: 0 },
  };
  // ① 사용자 지정 속성(SOAP — 이미 열린 세션). 정의 1회 + VM customValue 250개씩.
  try {
    if (c.sc?.customFieldsManager) {
      const def = await c.retrieveObjectProps('CustomFieldsManager', c.sc.customFieldsManager, ['field']);
      const fields = parseCustomFieldDefs(def[0]?.props?.field || '');
      const vmCustom = {};
      let cutVms = 0;
      if (fields.length) {
        for (let i = 0; i < vmRefs.length; i += 250) {
          if (Date.now() >= deadline) { cutVms = vmRefs.length - i; break; }
          for (const o of await c.retrieveManyObjectProps('VirtualMachine', vmRefs.slice(i, i + 250), ['customValue'], 250)) {
            const v = parseCustomValues(o.props?.customValue || '');
            if (Object.keys(v).length) vmCustom[o.ref] = v;
          }
        }
      }
      if (cutVms && prev?.vmCustom) { for (const r of vmRefs.slice(vmRefs.length - cutVms)) if (prev.vmCustom[r]) vmCustom[r] = prev.vmCustom[r]; }
      next.fields = fields; next.vmCustom = vmCustom; next.customAt = now; next.truncated.custom = cutVms;
    } else next.customError = 'CustomFieldsManager 없음';
  } catch (err) {
    next.customError = msg(err);
    console.warn(`[tags] ${vc.id} 사용자 지정 속성 읽기 실패: ${next.customError}`);
  }
  // ② 태그(vAPI REST — 세션을 따로 연다).
  try {
    const t = await readTags(vc, signal, deadline, prev);
    next.categories = t.categories; next.tags = t.tags; next.vmTags = t.vmTags; next.hostTags = t.hostTags;
    next.tagsAt = now; next.truncated.tags = t.cut + t.dropped;
  } catch (err) {
    if (err?.status === 404) { next.tagsUnsupported = true; next.tagsError = 'vAPI 태그 경로가 없습니다(vSphere 7.0 U2 미만으로 추정)'; }
    else next.tagsError = msg(err);
    console.warn(`[tags] ${vc.id} 태그 읽기 실패: ${next.tagsError}`);
  }
  _byVc.set(vc.id, next);
  return next;
}
