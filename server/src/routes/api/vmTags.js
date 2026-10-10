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
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { fileStamp } from '../../util/dayKey.js';
import { analyzeTags, vmTagsOf, vmRefOf, tagStateOf } from '../../tags/analyze.js';
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
function isFullAdmin(req, snap) { return req.user?.role === 'admin' && !scopedVcenterIds(req.user, snap); }
export const ERROR_HIDDEN_TEXT = '(오류 — 관리자 화면에서 확인)';
/** v2.720(감사 B2-02): vCenter 행의 tagsError·customError 를 고정 문구로 바꾼다(없으면 null 그대로). */
export function maskVcErrors(rows) {
  return (Array.isArray(rows) ? rows : []).map((v) => (v && (v.tagsError || v.customError)
    ? { ...v, tagsError: v.tagsError ? ERROR_HIDDEN_TEXT : null, customError: v.customError ? ERROR_HIDDEN_TEXT : null }
    : v));
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
      return { ...r, vcenters: vcRows, ...(full ? {} : { errorsHidden: true }), policyRev: pol.rev, policyDemo: pol.demo === true, policyUpdatedAt: pol.updatedAt, scan: { enabled: config.tagScan, refreshMs: config.tagRefreshMs }, initial: snap.initial === true,
        status: full ? tagInvStatus() : null };
      // v2.720(감사 B2-02): 캐시 키에 역할 — scopeKey 는 범위만이라 전체 범위 admin 의 판본(오류 원문·status)이 operator 에게 나갔다.
    }, { ttlMs: 12_000, extraKey: `${scopeKey(req.user, store.get())}|${pol.rev}|${req.user?.role === 'admin' ? 'a' : 'u'}` });
  });

  api.get('/tools/vm-tags/of', toolsPerm, (req, res) => {
    const snap = store.get();
    const vmId = qStr(req.query.vmId, 256);
    const vm = (snap.vms || []).find((v) => v.id === vmId);
    if (!vm || !inUserScope(req.user, snap, vm.vcenterId)) return res.status(404).json({ ok: false, reason: 'not-found' });
    const vc = (snap.vcenters || []).find((v) => v.id === vm.vcenterId);
    const inv = vc?.tagInv || null;
    const ref = vmRefOf(vm.vcenterId, vm.id);
    const { tags, custom } = vmTagsOf(inv, ref);
    const pol = loadTagPolicy();
    const present = new Set((tags || []).map((t) => t.category.toLowerCase()));
    res.json({ ok: true, state: tagStateOf(inv), tagsAt: inv?.tagsAt ?? null, customAt: inv?.customAt ?? null, tags, custom,
      fields: Array.isArray(inv?.fields) ? inv.fields.length : null,
      missing: tags ? pol.requiredCategories.filter((c) => !present.has(c.toLowerCase())) : null, template: !!vm.template });
  });

  // v2.732(점검 2회차 B3-07): updatedBy 는 계정명이다 — 범위 계정에는 null(형제 vm-hygiene v2.721 B2-02 와 같은 규칙). 전체 범위는 그대로.
  api.get('/tools/vm-tags/policy', toolsPerm, (req, res) => {
    const pol = loadTagPolicy();
    res.json({ ok: true, policy: scopedVcenterIds(req.user, store.get()) ? { ...pol, updatedBy: null } : pol });
  });
  api.put('/tools/vm-tags/policy', adminOnly, fleetOnly, (req, res) => {
    const r = saveTagPolicy(req.body || {}, req.user?.username || '');
    if (!r.ok) return res.status(r.code === 'stale' ? 409 : 400).json(r);
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
    logAudit({ user: req.user?.username, action: 'vm-tags.csv', target: 'missing', detail: `${r.rows.length} rows`, ip: req.ip });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="vm-tags-missing-${fileStamp()}.csv"`);
    res.send(lines.join('\r\n'));
  });
}
