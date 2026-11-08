/**
 * routes/api/bmKeyOverlaps.js — 다음 점검 ①(2차 · 사용자 결정 2026-11-08 "겹치는 노드의 IP · hostname · service tag 등을 수집해서 사용자가 추가할지 여부를 결정")
 * **식별 키가 겹치는 서버** 목록 · 결정(수집에 추가 · 제외 유지 · 되돌리기) API.
 *
 * 경로는 `/tools/bm-usage/key-overlaps…`(도구 키 그대로 — auth/toolAccess.js 의 도구별 접근 집행을 그대로 탄다).
 * 권한 · 범위:
 *   · 읽기 = tools + 조회 범위 — 그 서버의 법인이 조회 범위 안일 때만(귀속 없음은 범위 계정에 숨김) · 겹친 상대도 범위 안일 때만 싣고
 *     범위 밖 상대는 **이름도 개수도 싣지 않는다**(존재 오라클 금지 — 반증 F3 와 같은 규칙) · 비관리자는 주소(iDRAC · OS)를 싣지 않고 주소 꼴 이름 · id 를 가린다
 *     (v2.600 규약 — 결정 근거는 이름 · 원문 서비스태그 · 출처 · 겹친 상대로 충분하다) · 결정한 사람은 관리자 판본만.
 *   · 쓰기 = operator 이상 + tools · **조회 밖 404 → 쓰기 범위 밖 403**(조건 없이 — server/CLAUDE.md v2.733) · 감사 `bm-usage.key-decision`.
 *   · ‘수집에 추가’ 키는 `<법인>:<serverId>`(keyDecisions.decidedKeyOf) — 지금 대상 키와 겹치면 409(새 키는 이 노드에서 처음 쓰는 이름이어야 한다).
 * ⚠ 이 노드가 맡는 서버만 다룬다 — 엣지가 맡는 법인의 겹침은 그 엣지의 같은 화면에서 정한다(결정 파일은 노드마다 · 중앙 → 엣지 배포는 다음 점검 후보).
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds, inUserWriteScope } from '../../auth/scope.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { addressMatcher, isAdminReq } from '../../auth/addressMask.js';
import { maskBmIdentity } from '../../bmusage/targets.js';
import { currentTargets } from '../../bmusage/poller.js';
import { strOf } from '../../util/coercionTrap.js';
import { bmAddressHosts } from './bmUsage.js';

const toolsPerm = requirePerm('tools');
const writeRole = requireRole('admin', 'operator');
const t = (v) => strOf(v, 512).trim();
const NOT_FOUND = Object.freeze({ ok: false, code: 'not-found', reason: '그 서버를 찾지 못했습니다.' });

function deps0(deps = {}) {
  return {
    currentTargets, bmAddressHosts,
    decisions: async () => import('../../bmusage/keyDecisions.js'),
    audit: logAudit,
    ...deps,
  };
}
const inRead = (allowed, vc) => !allowed || (!!vc && allowed.has(vc));

/** 한 행의 응답 판본(순수) — 범위 · 주소 가림 · 결정한 사람. */
export function overlapRowView(o, { allowed = null, isAdmin = false, match = null, writable = false } = {}) {
  const peer0 = o.dupOf && inRead(allowed, o.dupOf.vcenterId) ? o.dupOf : null;
  const dec = o.decision ? { decision: o.decision.decision, ...(o.decision.key ? { key: o.decision.key } : {}), at: o.decision.at || null, ...(isAdmin ? { by: o.decision.by || '' } : {}) } : null;
  const row = {
    oid: o.oid, role: o.role, stage: o.stage, vcenterId: o.vcenterId, vcName: o.vcName || '', name: o.name, serviceTag: o.serviceTag, serverId: o.serverId, fleetId: o.fleetId,
    key: o.key, keyKind: o.keyKind, source: o.source, model: o.model || '', decidedKey: o.decidedKey, decision: dec, collecting: !!o.collecting, writable,
    osIssue: o.osIssue || '',   // G3: OS 등록을 법인으로 못 정함(os-ambiguous · os-foreign) — 주소가 아니라 사유 코드라 비관리자에게도 싣는다
    ...(isAdmin ? { idracHost: o.idracHost || '', osHost: o.osHost || '' } : {}),
    dupOf: peer0 ? { key: peer0.key, name: peer0.name, vcenterId: peer0.vcenterId, source: peer0.source, edge: !!peer0.edge, ...(peer0.sameIdrac ? { sameIdrac: true } : {}) } : null,
  };
  if (isAdmin || !match) return row;
  const m = maskBmIdentity({ key: row.key, name: row.name, serverId: row.serverId, fleetId: row.fleetId }, match);
  const out = { ...row, key: m.key, name: m.name, serverId: m.serverId, fleetId: m.fleetId, decidedKey: maskBmIdentity({ key: row.decidedKey }, match).key };
  if (out.decision?.key) out.decision = { ...out.decision, key: maskBmIdentity({ key: out.decision.key }, match).key };
  if (out.dupOf) { const pm = maskBmIdentity({ key: out.dupOf.key, name: out.dupOf.name }, match); out.dupOf = { ...out.dupOf, key: pm.key, name: pm.name }; }
  return out;
}

/** GET /tools/bm-usage/key-overlaps */
export async function bmKeyOverlapsRead(req, snap, deps = {}) {
  const D = deps0(deps);
  const allowed = scopedVcenterIds(req.user, snap);
  const isAdmin = isAdminReq(req);
  const KD = await D.decisions();
  const le = KD.keyDecisionsLoadError();
  if (le) return { __status: 503, ok: false, code: 'settingsUnreadable', reason: le.reason };
  const tg = await D.currentTargets();
  const list = (tg.keyOverlaps || []).filter((o) => inRead(allowed, o.vcenterId));
  const match = isAdmin ? null : addressMatcher(await D.bmAddressHosts(tg).catch(() => []));
  const items = list.map((o) => overlapRowView(o, { allowed, isAdmin, match, writable: inUserWriteScope(req.user, snap, o.vcenterId) }));
  // 개수는 보이는 목록에서 센다(범위 계정에 전역 수를 주지 않는다 — 반증 F3).
  const counts = { total: items.length, pending: items.filter((x) => !x.decision).length, added: items.filter((x) => x.decision?.decision === 'add').length, excluded: items.filter((x) => x.decision?.decision === 'exclude').length };
  return { ok: true, at: Date.now(), items, counts, isEdge: !!tg.isEdge, ...(isAdmin ? {} : { addressHidden: true }) };
}

/** 쓰기 게이트 — 조회 밖 404 → 쓰기 밖 403(조건 없이). 지금 겹침 목록에 없으면(겹침이 풀렸다) 결정 기록의 법인으로 본다(되돌리기만). */
async function gate(req, snap, D, oid, { allowRecordOnly = false } = {}) {
  const allowed = scopedVcenterIds(req.user, snap);
  const tg = await D.currentTargets();
  let item = (tg.keyOverlaps || []).find((o) => o.oid === oid) || null;
  if (!item && allowRecordOnly) {
    const KD = await D.decisions();
    const r = KD.readKeyDecisions();
    if (!r.ok) return { err: { status: 503, body: { ok: false, code: 'settingsUnreadable', reason: r.error.reason } } };
    const rec = r.map.get(oid) || null;
    if (rec) item = { oid, vcenterId: rec.vcenterId, recordOnly: true };
  }
  if (!item || !inRead(allowed, item.vcenterId)) return { err: { status: 404, body: NOT_FOUND } };
  if (!inUserWriteScope(req.user, snap, item.vcenterId)) return { err: { status: 403, body: { ok: false, code: 'forbidden', error: 'forbidden', reason: '이 서버의 법인에 쓰기 권한이 없습니다(조회 전용).' } } };
  return { item, tg };
}

/** POST /tools/bm-usage/key-overlaps/decision { oid, decision:'add'|'exclude' } → { status, body } */
export async function bmKeyDecisionWrite(req, deps = {}) {
  const D = deps0(deps);
  const snap = store.get();
  const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const oid = t(b.oid).slice(0, 400);
  const decision = t(b.decision);
  if (!oid || !['add', 'exclude'].includes(decision)) return { status: 400, body: { ok: false, code: 'bad-request', reason: 'oid 와 결정(add · exclude)이 필요합니다.' } };
  const g = await gate(req, snap, D, oid);
  if (g.err) return g.err;
  const { item, tg } = g;
  const KD = await D.decisions();
  const key = item.decidedKey;
  if (decision === 'add') {
    // 새 키는 이 노드에서 처음 쓰는 이름이어야 한다 — 지금 대상 키와 겹치면 거부(그 키의 이력 · 주석 · 정비 창 · 포트 매핑을 물려받지 않게).
    const taken = (tg.targets || []).some((x) => x.key === key && !(item.decision?.decision === 'add' && item.decision.key === key));
    if (taken) return { status: 409, body: { ok: false, code: 'key-taken', reason: `별도 키 ‘${key}’ 를 이미 다른 대상이 씁니다 — 결정하지 않았습니다.` } };
  }
  try {
    const r = await KD.setKeyDecision({ oid, decision, ...(decision === 'add' ? { key } : {}), role: item.role, vcenterId: item.vcenterId, serverId: item.serverId, name: item.name, serviceTag: item.serviceTag }, { by: String(req.user?.username || '').slice(0, 64) });
    D.audit({ user: req.user?.username, action: 'bm-usage.key-decision', target: oid.slice(0, 200), ip: req.ip || '',
      detail: JSON.stringify({ op: 'set', decision, key: decision === 'add' ? key : '', vcenterId: item.vcenterId, prev: r.prev?.decision || null }).slice(0, 300) });
    return { status: 200, body: { ok: true, decision, ...(decision === 'add' ? { key } : {}), note: decision === 'add' ? '다음 수집 주기부터 이 키로 수집합니다.' : '수집하지 않습니다(확인 기록).' } };
  } catch (e) {
    const st = [400, 404, 409, 503].includes(e?.status) ? e.status : 500;
    return { status: st, body: { ok: false, code: e?.code || 'error', reason: String(e?.message || e).slice(0, 300) } };
  }
}

/** DELETE /tools/bm-usage/key-overlaps/decision?oid= (되돌리기 — 결정 없음 = 수집 안 함 · 별도 키의 이력은 지우지 않는다) */
export async function bmKeyDecisionClear(req, deps = {}) {
  const D = deps0(deps);
  const snap = store.get();
  const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const oid = t(b.oid || req.query?.oid).slice(0, 400);
  if (!oid) return { status: 400, body: { ok: false, code: 'bad-request', reason: 'oid 가 필요합니다.' } };
  const g = await gate(req, snap, D, oid, { allowRecordOnly: true });
  if (g.err) return g.err;
  const KD = await D.decisions();
  try {
    const r = await KD.clearKeyDecision(oid);
    D.audit({ user: req.user?.username, action: 'bm-usage.key-decision', target: oid.slice(0, 200), ip: req.ip || '',
      detail: JSON.stringify({ op: 'clear', prev: r.prev?.decision || null, key: r.prev?.key || '', vcenterId: g.item.vcenterId }).slice(0, 300) });
    return { status: 200, body: { ok: true, note: '결정을 지웠습니다 — 다음 주기부터 수집하지 않습니다(별도 키로 쌓인 값은 지우지 않았습니다).' } };
  } catch (e) {
    const st = [400, 404, 409, 503].includes(e?.status) ? e.status : 500;
    return { status: st, body: { ok: false, code: e?.code || 'error', reason: String(e?.message || e).slice(0, 300) } };
  }
}

export function registerBmKeyOverlaps(api, deps = {}) {
  const fail = (res, e) => res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
  api.get('/tools/bm-usage/key-overlaps', toolsPerm, async (req, res) => {
    try { const r = await bmKeyOverlapsRead(req, store.get(), deps); if (r.__status) { const { __status, ...rest } = r; return res.status(__status).json(rest); } res.json(r); } catch (e) { fail(res, e); }
  });
  api.post('/tools/bm-usage/key-overlaps/decision', writeRole, toolsPerm, async (req, res) => { try { const r = await bmKeyDecisionWrite(req, deps); res.status(r.status).json(r.body); } catch (e) { fail(res, e); } });
  api.delete('/tools/bm-usage/key-overlaps/decision', writeRole, toolsPerm, async (req, res) => { try { const r = await bmKeyDecisionClear(req, deps); res.status(r.status).json(r.body); } catch (e) { fail(res, e); } });
}
