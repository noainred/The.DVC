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
  for (const [vcId, t] of _byVc) out.push({ vcenterId: vcId, at: t.at, tagsAt: t.tagsAt, customAt: t.customAt, tagsError: t.tagsError, customError: t.customError, tags: t.tags ? t.tags.length : null, retryAt: t.retryAt ?? null, tagsKeptPrev: !!t.tagsKeptPrev });
  return { vcenters: out.slice(0, 64), omitted: Math.max(0, out.length - 64) };
}
/** v2.720(감사 S1-01): 그 vCenter 의 캐시를 통째로 버린다 — 삭제됐거나 접속처가 바뀌었다(hostcfg/cache.js syncVcConfigCaches). */
export function dropVcCache(vcId) { _byVc.delete(vcId); }
export function _resetTagInv() { _byVc.clear(); }

const msg = (e) => String(e?.message || e).slice(0, 300);
// v2.719(감사 S1-02): 중단·시한 실패는 '이번에 못 읽었다' 다 — 6시간(tagRefreshMs) 동안 다시 읽지 않는 '갱신 완료' 로 기록하지 않는다.
export const TAG_RETRY_MS = 10 * 60_000;
const isTransient = (err, signal) => !!signal?.aborted || err?.name === 'AbortError' || err?.name === 'TimeoutError'
  || /abort|timed? ?out|timeout|데드라인|시한|중단/i.test(String(err?.message || err || ''));

async function readTags(vc, signal, deadline, prev) {
  const rc = new VCenterClient(vc, { signal });
  await rc.login();
  try {
    const catIds = (await rc.listTagCategories()).slice(0, 500);
    const tagIds = await rc.listTags();
    const keepTags = tagIds.slice(0, TAGS_MAX);
    const prevTag = new Map((prev?.tags || []).map((t) => [t.id, t]));
    const prevCat = new Map((prev?.categories || []).map((c) => [c.id, c]));
    // v2.720(감사 R1-04): 예산(데드라인) 때문에 못 읽은 것이 있는지 따로 기록한다 — 예외가 아니라서 retryAt 이 붙지 않았다.
    let budgetCut = false;
    const cats = await poolSettled(catIds, 6, async (id) => { if (Date.now() < deadline) return rc.getTagCategory(id); budgetCut = true; return null; });
    const tags = await poolSettled(keepTags, 6, async (id) => { if (Date.now() < deadline) return rc.getTag(id); budgetCut = true; return null; });
    let cut = 0;
    // v2.719(감사 B1-04): 'VM 의 태그를 다 알지 못한다' 를 따로 센다 — 연결을 못 읽은 태그, 상세를 못 읽고 직전 값도 없어
    //   빠진 태그·카테고리, 상한(TAGS_MAX)으로 잘린 태그. 하나라도 있으면 그 vCenter 의 '필수 카테고리 누락' 은 단정할 수 없다.
    let lost = 0;
    const catObjs = cats.map((r, i) => {
      if (r.status === 'fulfilled' && r.value) return r.value;
      cut += 1; const p = prevCat.get(catIds[i]); if (!p) lost += 1; return p ? { id: p.id, name: p.name, cardinality: p.cardinality, associable_types: p.types } : null;
    }).filter(Boolean);
    const tagObjs = tags.map((r, i) => {
      if (r.status === 'fulfilled' && r.value) return r.value;
      cut += 1;
      const p = prevTag.get(keepTags[i]);
      if (!p) { lost += 1; return null; }
      return { id: p.id, name: p.name, category_id: p.cat != null ? prev.categories[p.cat]?.id : null };
    }).filter(Boolean);
    const assoc = [];
    for (let i = 0; i < keepTags.length; i += ASSOC_CHUNK) {
      if (Date.now() >= deadline) { cut += keepTags.length - i; lost += keepTags.length - i; budgetCut = true; break; }
      const part = await rc.listAttachedObjectsOnTags(keepTags.slice(i, i + ASSOC_CHUNK));
      if (Array.isArray(part)) for (const a of part) assoc.push(a);
    }
    const idx = buildTagIndex(catObjs, tagObjs, assoc);
    const dropped = Math.max(0, tagIds.length - keepTags.length) + idx.tagsDropped;
    return { ...idx, cut, dropped, partial: lost + dropped > 0, budgetCut };
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
  // v2.719(S1-02): 직전 갱신이 중단·시한으로 일부를 못 읽었으면 retryAt 이 지나면 tagRefreshMs 를 기다리지 않고 다시 읽는다.
  if (prev && now - prev.at < settings.tagRefreshMs && !(prev.retryAt != null && now >= prev.retryAt)) return prev;
  const deadline = Date.now() + budgetMs;
  const next = {
    ...(prev || { categories: null, tags: null, vmTags: null, hostTags: null, fields: null, vmCustom: null, tagsAt: null, customAt: null }),
    at: now, tagsError: null, customError: null, tagsUnsupported: false, truncated: { tags: 0, custom: 0 }, partialTags: false, retryAt: null, tagsKeptPrev: false,
  };
  let transient = false;
  let budgetCut = false; // v2.720(R1-04): 예산으로 일부를 못 읽었다 — 예외는 아니지만 '갱신 완료(6시간)' 로 기록하지 않는다
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
      if (cutVms) budgetCut = true;
    } else next.customError = 'CustomFieldsManager 없음';
  } catch (err) {
    next.customError = msg(err);
    if (isTransient(err, signal)) transient = true;
    console.warn(`[tags] ${vc.id} 사용자 지정 속성 읽기 실패: ${next.customError}`);
  }
  // ② 태그(vAPI REST — 세션을 따로 연다).
  try {
    const t = await readTags(vc, signal, deadline, prev);
    if (t.budgetCut) budgetCut = true;
    // v2.720(감사 R1-04): 예산으로 잘린 일부 결과가 직전의 온전한 연결을 덮지 않게 한다 — 직전 값을 그대로 두고(tagsAt 도 그대로)
    //   retryAt 으로 곧 다시 읽는다. auxBudgetMs(v2.719)가 태그 예산을 3초까지 줄일 수 있어 고RTT vCenter 에서 자주 생긴다.
    if (t.budgetCut && t.partial && prev?.vmTags && !prev.partialTags) {
      next.truncated.tags = prev.truncated?.tags ?? 0; next.partialTags = false; next.tagsKeptPrev = true;
    } else {
      next.categories = t.categories; next.tags = t.tags; next.vmTags = t.vmTags; next.hostTags = t.hostTags;
      next.tagsAt = now; next.truncated.tags = t.cut + t.dropped; next.partialTags = !!t.partial;
    }
  } catch (err) {
    if (err?.status === 404) { next.tagsUnsupported = true; next.tagsError = 'vAPI 태그 경로가 없습니다(vSphere 7.0 U2 미만으로 추정)'; }
    else next.tagsError = msg(err);
    if (isTransient(err, signal)) transient = true;
    console.warn(`[tags] ${vc.id} 태그 읽기 실패: ${next.tagsError}`);
  }
  // v2.719(S1-02): 수집 자체가 중단(데드라인)됐으면 이번 결과를 기록하지 않는다 — 직전 값을 그대로 두고 다음 주기에 다시 읽는다.
  if (signal?.aborted) return prev;
  // 시한 같은 일시 실패는 읽은 부분은 남기되 '갱신 완료(6시간)' 가 아니라 짧은 재시도 시각을 단다.
  if (transient || budgetCut) next.retryAt = now + Math.min(TAG_RETRY_MS, settings.tagRefreshMs);
  _byVc.set(vc.id, next);
  return next;
}
