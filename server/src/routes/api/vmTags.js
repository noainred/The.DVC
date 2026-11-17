/**
 * routes/api/vmTags.js — 특수 기능 '태그·사용자 지정 속성 점검'(도구 키 `vm-tags`, v2.703 — A15).
 * 스냅샷의 vcenter.tagInv 만 읽는다(vCenter 왕복 0) · tools + toolGate + vCenter 범위.
 * 정책(필수 카테고리·법인 카테고리)은 전 법인 공통 설정 — 저장은 admin + 전체 범위 + 감사 로그.
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { store } from '../../store.js';
import { scopedVcenterIds, inUserScope } from '../../auth/scope.js';
import { memoJson, scopeKey } from './shared.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { capStr } from '../../util/capStr.js';
import { isAdminDetailUser } from '../../auth/demoGuest.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { fileStamp } from '../../util/dayKey.js';
import { analyzeTags, vmTagsOf, vmRefOf, tagStateOf, tagsPartialOf } from '../../tags/analyze.js';
import { loadTagPolicy, saveTagPolicy } from '../../tags/policy.js';
import { tagInvStatus } from '../../tags/collect.js';
import { config } from '../../config.js';

const toolsPerm = requirePerm('tools');
const csvPerm = requirePerm('data.csv');
const adminOnly = requireRole('admin');
const fleetOnly = fullScopeOnlyWith('태그 점검 정책은 전 법인 공통이라 전체 범위(vCenter 제한 없는) 계정만 바꿀 수 있습니다.');
const qStr = (v, n) => (typeof v === 'string' ? capStr(v.trim(), n) : '');

function scopedVcs(req, snap) {
  const allowed = scopedVcenterIds(req.user, snap);
  let vcs = snap.vcenters || [];
  if (allowed) vcs = vcs.filter((v) => allowed.has(v.id));
  const want = qStr(req.query.vcenterId, 128);
  if (want) vcs = vcs.filter((v) => v.id === want);
  return vcs;
}

/** v2.720(감사 B2-02): 오류 원문을 볼 수 있는가 — admin + 전체 범위(vCenter 제한 없음). */
// v2.744(감사 AUTHZ-01): admin 판정은 isAdminDetailUser — 데모 계정은 vCenter 오류 원문·수집 상태를 받지 않는다(operator 와 같은 판본).
function isFullAdmin(req, snap) { return isAdminDetailUser(req.user) && !scopedVcenterIds(req.user, snap); }
export const ERROR_HIDDEN_TEXT = '(오류 — 관리자 화면에서 확인)';
/** v2.720(감사 B2-02): vCenter 행의 tagsError·customError 를 고정 문구로 바꾼다(없으면 null 그대로). */
export function maskVcErrors(rows) {
  return (Array.isArray(rows) ? rows : []).map((v) => (v && (v.tagsError || v.customError)
    ? { ...v, tagsError: v.tagsError ? ERROR_HIDDEN_TEXT : null, customError: v.customError ? ERROR_HIDDEN_TEXT : null }
    : v));
}

/**
 * VM 상세 '태그 · 사용자 지정 속성' 한 VM 의 응답 본문(순수 — 테스트 고정).
 * 69회차 F3(재현 — v2.719 B1-04 의 형제 경로): 목록(analyzeTags)은 태그 연결을 일부만 읽은 vCenter 의 '필수 카테고리 없음' 을 단정하지 않고
 *   '확인 안 됨(부분)' 으로 세는데, 이 경로는 같은 VM 에 '<카테고리> 없음' 을 그대로 냈다(목록과 상세가 반대로 말함). 템플릿도 목록은 점검 밖인데
 *   이 경로는 빠진 필수 태그를 냈다(화면이 '점검 대상이 아닙니다' 와 '없음' 배지를 함께 보였다). 둘 다 missing 을 null(판정 안 함)로 두고
 *   부분 읽기는 missingUnsure(읽은 연결에서 안 보인 카테고리)와 partial 로 밝힌다.
 */
export function vmTagsOfBody(vm, inv, pol) {
  const { tags, custom } = vmTagsOf(inv, vmRefOf(vm.vcenterId, vm.id));
  const present = new Set((tags || []).map((t) => String(t.category || '').toLowerCase()));
  const required = Array.isArray(pol?.requiredCategories) ? pol.requiredCategories : [];
  const notSeen = tags ? required.filter((c) => !present.has(String(c).toLowerCase())) : null;
  const template = !!vm.template;
  const partial = !!tags && tagsPartialOf(inv);
  // 71회차(69회차 F4 반증 — 재현): 태그 정책 파일을 읽지 못했으면(unreadable — 필수 카테고리 [] 기본값) 빠진 필수 태그를 판정하지 않는다.
  //   예전에는 notSeen 이 [] 라 missing:[](= '빠진 필수 태그 없음')을 단정했다 — 판정 안 함(null) + policyUnreadable 로 밝힌다.
  if (pol?.unreadable === true) {
    return { ok: true, state: tagStateOf(inv), tagsAt: inv?.tagsAt ?? null, customAt: inv?.customAt ?? null, tags, custom,
      fields: Array.isArray(inv?.fields) ? inv.fields.length : null, missing: null, policyUnreadable: true, ...(partial ? { partial: true } : {}), template };
  }
  return { ok: true, state: tagStateOf(inv), tagsAt: inv?.tagsAt ?? null, customAt: inv?.customAt ?? null, tags, custom,
    fields: Array.isArray(inv?.fields) ? inv.fields.length : null,
    missing: template || (partial && notSeen?.length) ? null : notSeen,
    ...(partial ? { partial: true, ...(!template && notSeen?.length ? { missingUnsure: notSeen } : {}) } : {}),
    template };
}

export function registerVmTags(api) {
  api.get('/tools/vm-tags', toolsPerm, (req, res) => {
    const pol = loadTagPolicy();
    return memoJson(req, res, 'vm-tags', (snap) => {
      const vcs = scopedVcs(req, snap);
      const ids = new Set(vcs.map((v) => v.id));
      const r = analyzeTags(vcs, (snap.vms || []).filter((v) => ids.has(v.vcenterId)), pol, { q: qStr(req.query.q, 128) });
      // v2.720(감사 B2-02): 오류 원문(vAPI 경로·상태·응답 앞부분·내부 IP)은 전체 범위 관리자에게만 — 같은 라우트의 status 와
      //   형제(contention·host-hygiene)와 같은 규칙. 나머지에게는 '오류가 있다' 는 사실만 고정 문구로 준다.
      const full = isFullAdmin(req, snap);
      const vcRows = full ? r.vcenters : maskVcErrors(r.vcenters);
      return { ...r, vcenters: vcRows, ...(full ? {} : { errorsHidden: true }), policyRev: pol.rev, policyDemo: pol.demo === true, policyUnreadable: pol.unreadable === true, policyUpdatedAt: pol.updatedAt, scan: { enabled: config.tagScan, refreshMs: config.tagRefreshMs }, initial: snap.initial === true,
        status: full ? tagInvStatus() : null };
      // v2.720(감사 B2-02): 캐시 키에 역할 — scopeKey 는 범위만이라 전체 범위 admin 의 판본(오류 원문·status)이 operator 에게 나갔다.
    }, { ttlMs: 12_000, extraKey: `${scopeKey(req.user, store.get())}|${pol.rev}|${isAdminDetailUser(req.user) ? 'a' : 'u'}` });   // v2.744(AUTHZ-01): 판정 결과로 — 데모와 관리자가 같은 칸을 쓰지 않게
  });

  api.get('/tools/vm-tags/of', toolsPerm, (req, res) => {
    const snap = store.get();
    const vmId = qStr(req.query.vmId, 256);
    const vm = (snap.vms || []).find((v) => v.id === vmId);
    if (!vm || !inUserScope(req.user, snap, vm.vcenterId)) return res.status(404).json({ ok: false, reason: 'not-found' });
    const vc = (snap.vcenters || []).find((v) => v.id === vm.vcenterId);
    res.json(vmTagsOfBody(vm, vc?.tagInv || null, loadTagPolicy()));
  });

  // v2.732(점검 2회차 B3-07): updatedBy 는 계정명이다 — 범위 계정에는 null(형제 vm-hygiene v2.721 B2-02 와 같은 규칙). 전체 범위는 그대로.
  api.get('/tools/vm-tags/policy', toolsPerm, (req, res) => {
    const pol = loadTagPolicy();
    res.json({ ok: true, policy: scopedVcenterIds(req.user, store.get()) ? { ...pol, updatedBy: null } : pol });
  });
  api.put('/tools/vm-tags/policy', adminOnly, fleetOnly, (req, res) => {
    const r = saveTagPolicy(req.body || {}, req.user?.username || '');
    if (!r.ok) return res.status(r.code === 'stale' ? 409 : r.code === 'unreadable' ? 503 : 400).json(r);   // 69회차 F4: 읽지 못한 정책 위에 저장하지 않는다
    logAudit({ user: req.user?.username, action: 'vm-tags.policy', target: 'tag-policy.json', detail: `필수 ${r.policy.requiredCategories.join(',') || '(없음)'} · 법인 ${r.policy.corpCategory || '(없음)'}`, ip: req.ip });
    res.json(r);
  });

  api.get('/tools/vm-tags.csv', csvPerm, toolsPerm, (req, res) => {
    const snap = store.get();
    const vcs = scopedVcs(req, snap);
    const ids = new Set(vcs.map((v) => v.id));
    const pol = loadTagPolicy();
    const r = analyzeTags(vcs, (snap.vms || []).filter((v) => ids.has(v.vcenterId)), pol, {});
    const lines = [CSV_BOM + csvLine(['vCenter', 'VM', '전원', '빠진 필수 카테고리', ...(pol.corpCategory ? [`법인 태그(${pol.corpCategory})`] : [])])];
    for (const row of r.rows) lines.push(csvLine([row.vcenterName, row.vm, row.powerState || '', row.missing.join(' / '), ...(pol.corpCategory ? [row.corpTag || ''] : [])]));
    if (r.omitted) lines.push(csvLine([`(상한으로 ${r.omitted}행 생략)`]));
    // 71회차(69회차 F4 반증): 정책 파일을 읽지 못했으면 빈 파일이 '빠진 VM 없음' 으로 읽히지 않게 밝힌다.
    if (pol.unreadable === true) lines.push(csvLine(['(태그 정책 파일을 읽지 못해 필수 태그 누락을 판정하지 않았습니다 — 빈 목록은 빠진 VM 이 없다는 뜻이 아닙니다)']));
    logAudit({ user: req.user?.username, action: 'vm-tags.csv', target: 'missing', detail: `${r.rows.length} rows`, ip: req.ip });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="vm-tags-missing-${fileStamp()}.csv"`);
    res.send(lines.join('\r\n'));
  });
}
