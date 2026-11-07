/**
 * routes/api/bmAnnotations.js — 리눅스 성능 6단계 **운영 주석** API(설계 PROFILES §16 A · 아트보드 Annot).
 *
 * 경로 `/tools/bm-usage/annotations…`(도구 키 그대로). 권한 · 범위(security-api.md 6단계):
 *   · 읽기 = tools + 조회 범위 — 주석의 법인이 **전부** 조회 범위 안일 때만 보인다(귀속 없음은 범위 계정에 숨김) · 요청 서버는 형제 라우트와 같은 해석(resolvePerfTarget —
 *     범위 밖 · 없는 키는 조용히 빠진다: 존재를 흘리지 않는다).
 *   · 쓰기(만들기 · 고치기 · 지우기) = operator 이상 + tools · **조회 밖 404 → 쓰기 범위 밖 403**(server/CLAUDE.md v2.733 — 조건 없이 쓰기 범위) ·
 *     고치기 · 지우기는 작성자 또는 관리자만(403 not-author) · 지우기는 흔적 · 감사 `bm-perf.annotation`(op · id · 종류 · 대상 수 — 내용 앞 120자).
 *   · 연결(이슈 · 위키 · 집중 세션)은 **권한을 주지 않는다** — 형식만 검사하고, 여는 사람은 자기 권한으로 본다.
 *   · 비관리자에게는 대상 이름 중 주소(등록부 주소 · IPv4)를 가린다.
 *   · 집중 세션 자동 주석: 중앙 화면에서 집중을 시작하면(5단계 시작 함수 · 6단계 5대 동시 집중) 작성자 ‘system’ 으로 남긴다(autoFocusAnnotation).
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds, inUserWriteScope } from '../../auth/scope.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { isAdminReq, maskedIdToken } from '../../auth/addressMask.js';
import { currentTargets } from '../../bmusage/poller.js';
import { strOf } from '../../util/coercionTrap.js';
import { resolvePerfTarget, bmAddressHosts, perfAddressMatcher } from './bmUsage.js';

const toolsPerm = requirePerm('tools');
const writeRole = requireRole('admin', 'operator');
const t = (v) => strOf(v, 4096).trim();
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const LIST_MAX = 500;

function deps0(deps = {}) {
  return {
    currentTargets, bmAddressHosts,
    listEdgeBmUsage: async () => (await import('../../central/bmUsageEdgePull.js')).listEdgeBmUsage(),
    store: async () => import('../../bmusage/annotations.js'),
    audit: logAudit,
    ...deps,
  };
}
const memo = (D) => { let p = null; return { ...D, currentTargets: () => (p ||= D.currentTargets()) }; };
function errOut(res, e) {
  const st = [400, 403, 404, 409, 503].includes(e?.status) ? e.status : 500;
  return res.status(st).json({ ok: false, code: e?.code || 'error', ...(e?.field ? { field: e.field } : {}), reason: String(e?.message || e).slice(0, 300) });
}
/** 주석이 이 계정에 보이나(순수) — 법인이 전부 조회 범위 안(귀속 없음은 범위 계정에 숨김). */
export function annotVisible(a, allowed) {
  if (!allowed) return true;
  const vcs = Array.isArray(a?.target?.vcenterIds) ? a.target.vcenterIds : [];
  return vcs.length > 0 && vcs.every((vc) => vc && allowed.has(vc));
}
const annotWritable = (a, user, snap) => (a?.target?.vcenterIds || []).every((vc) => inUserWriteScope(user, snap, vc));

/** GET /tools/bm-usage/annotations?keys=&corp=&from=&to= */
export async function bmAnnotationsRead(req, snap, deps = {}) {
  const D = memo(deps0(deps));
  const allowed = scopedVcenterIds(req.user, snap);
  const isAdmin = isAdminReq(req);
  const q = req.query || {};
  const keys = [...new Set(String(typeof q.keys === 'string' ? q.keys : '').split(',').map(t).filter(Boolean))].slice(0, 8);
  const corp = t(q.corp);
  if (corp && allowed && !allowed.has(corp)) return { __status: 404, ok: false, reason: '대상 법인을 찾지 못했습니다.' };
  const asked = [];
  for (const key of keys) {
    const f = await resolvePerfTarget(req, D, { allowed, isAdmin, key });
    if (f && !f.denied) asked.push({ token: key, realKey: f.realKey, vc: t(f.target.vcenterId) });
  }
  const from = Number(q.from); const to = Number(q.to);
  const A = await D.store();
  let all;
  try { all = A.listAnnotations(); } catch (e) { return { __status: e?.status || 500, ok: false, code: e?.code || 'error', reason: String(e?.message || e).slice(0, 300) }; }
  const realToToken = new Map(asked.map((x) => [x.realKey, x.token]));
  const vcs = new Set(asked.map((x) => x.vc).filter(Boolean));
  let list = all.filter((a) => annotVisible(a, allowed));
  if (keys.length || corp) {
    list = list.filter((a) => (a.target?.keys || []).some((k) => realToToken.has(k)) || (a.target?.type === 'corp' && (vcs.has(a.target.vcenterIds?.[0]) || a.target.vcenterIds?.[0] === corp)));
  }
  if (Number.isFinite(from) && Number.isFinite(to)) list = list.filter((a) => (a.end ?? a.at) >= from && a.at <= to);
  list.sort((a, b) => b.at - a.at);
  const truncated = list.length > LIST_MAX;
  list = list.slice(0, LIST_MAX);
  let match = null;
  // 가림 판정기 = 비교 화면과 같은 함수(이 노드 + 엣지 보관분 호스트 — 반증 F11: 엣지 위임 서버의 호스트명이 그대로 나갔다)
  if (!isAdmin) { const tg = await D.currentTargets().catch(() => ({ targets: [] })); ({ match } = await perfAddressMatcher(D, tg)); }
  const maskName = (nm) => (isAdmin ? nm : (match && match(nm) ? maskedIdToken(nm) : String(nm).replace(IPV4_RE, (ip) => maskedIdToken(ip))));
  const user = String(req.user?.username || '');
  const out = list.map((a) => ({
    id: a.id, at: a.at, end: a.end ?? null, kind: a.kind, text: a.deleted ? '' : a.text, by: a.by, created: a.created, auto: a.auto || null,
    target: { type: a.target?.type, count: (a.target?.keys || []).length, names: (a.target?.names || []).map(maskName), vcenterIds: a.target?.vcenterIds || [],
      includes: (a.target?.keys || []).filter((k) => realToToken.has(k)).map((k) => realToToken.get(k)) },
    links: a.deleted ? {} : (a.links || {}),
    edits: (a.edits || []).map((e) => ({ at: e.at, by: e.by, fields: e.fields })),
    ...(a.deleted ? { deleted: a.deleted } : {}),
    canEdit: !a.deleted && (isAdmin || (a.by === user && a.by !== 'system')) && annotWritable(a, req.user, snap),
  }));
  return { ok: true, annotations: out, ...(truncated ? { truncated: true } : {}), kinds: A.ANNOT_KINDS, textMax: A.TEXT_MAX, ...(isAdmin ? {} : { addressHidden: true }) };
}

/** 대상 해석(쓰기) — 서버 키들 또는 법인 하나. 조회 밖 404 → 쓰기 범위 밖 403(조건 없이). */
async function writeTarget(req, snap, D, b) {
  const allowed = scopedVcenterIds(req.user, snap);
  const isAdmin = isAdminReq(req);
  if (typeof b.corp === 'string' && b.corp.trim()) {
    const vc = t(b.corp).slice(0, 128);
    if (allowed && !allowed.has(vc)) return { err: { status: 404, code: 'not-found', reason: '대상 법인을 찾지 못했습니다.' } };
    // 아는 법인만(스냅샷 vCenter · 이 노드 대상 · 엣지 보관분 대상의 법인) — 없는 법인에 주석을 쌓지 않는다.
    const known = new Set((snap?.vcenters || []).map((v) => String(v.id)));
    for (const x of (await D.currentTargets().catch(() => ({ targets: [] }))).targets || []) if (x?.vcenterId) known.add(String(x.vcenterId));
    for (const rec of await D.listEdgeBmUsage().catch(() => [])) for (const x of rec?.snap?.targets || []) if (x?.vcenterId) known.add(String(x.vcenterId));
    if (!known.has(vc)) return { err: { status: 404, code: 'not-found', reason: '대상 법인을 찾지 못했습니다.' } };
    if (!inUserWriteScope(req.user, snap, vc)) return { err: { status: 403, code: 'forbidden', reason: '이 법인에 쓰기 권한이 없습니다(조회 전용).' } };
    return { target: { type: 'corp', keys: [], names: [], vcenterIds: [vc] } };
  }
  const keys = [...new Set((Array.isArray(b.keys) ? b.keys : []).map((k) => t(k)).filter(Boolean))];
  if (!keys.length || keys.length > 8) return { err: { status: 400, code: 'bad-target', reason: '대상 서버는 1~8대입니다.' } };
  const found = [];
  for (const key of keys) {
    const f = await resolvePerfTarget(req, D, { allowed, isAdmin, key });
    if (!f || f.denied) return { err: { status: 404, code: 'not-found', reason: '대상 서버를 찾지 못했습니다.' } };
    found.push(f);
  }
  if (found.some((f) => !inUserWriteScope(req.user, snap, t(f.target.vcenterId)))) return { err: { status: 403, code: 'forbidden', reason: '대상 중 쓰기 권한이 없는 법인의 서버가 있습니다(조회 전용).' } };
  return { target: { type: found.length === 1 ? 'server' : 'servers', keys: found.map((f) => f.realKey), names: found.map((f) => String(f.target.name || f.realKey)), vcenterIds: [...new Set(found.map((f) => t(f.target.vcenterId)))] } };
}
async function annotCreate(req, res) {
  try {
    const D = memo(deps0());
    const snap = store.get();
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const w = await writeTarget(req, snap, D, b);
    if (w.err) return res.status(w.err.status).json({ ok: false, code: w.err.code, reason: w.err.reason });
    const A = await D.store();
    const rec = A.addAnnotation({ by: req.user?.username || '', at: b.at, end: b.end ?? null, kind: b.kind, text: b.text, target: w.target, links: b.links ?? null });
    D.audit({ user: req.user?.username, action: 'bm-perf.annotation', target: rec.id, ip: req.ip || '', detail: JSON.stringify({ op: 'create', kind: rec.kind, type: rec.target.type, n: rec.target.keys.length || 1, text: rec.text.slice(0, 120) }).slice(0, 300) });
    res.json({ ok: true, id: rec.id });
  } catch (e) { errOut(res, e); }
}
async function annotChange(req, res, op) {
  try {
    const D = deps0();
    const snap = store.get();
    const A = await D.store();
    const id = t(req.params.id).slice(0, 40);
    const a = A.getAnnotation(id);
    const allowed = scopedVcenterIds(req.user, snap);
    if (!a || a.deleted || !annotVisible(a, allowed)) return res.status(404).json({ ok: false, code: 'not-found', reason: '그 주석을 찾지 못했습니다.' });
    if (!annotWritable(a, req.user, snap)) return res.status(403).json({ ok: false, code: 'forbidden', reason: '이 주석의 법인에 쓰기 권한이 없습니다(조회 전용).' });
    if (!isAdminReq(req) && (a.by !== String(req.user?.username || '') || a.by === 'system')) return res.status(403).json({ ok: false, code: 'not-author', reason: '작성자 또는 관리자만 고치거나 지울 수 있습니다.' });
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const by = req.user?.username || '';
    const rec = op === 'delete' ? A.deleteAnnotation(id, { by }) : A.editAnnotation(id, { ...(b.kind !== undefined ? { kind: b.kind } : {}), ...(b.text !== undefined ? { text: b.text } : {}), ...(b.at !== undefined ? { at: b.at } : {}), ...(b.end !== undefined ? { end: b.end } : {}), ...(b.links !== undefined ? { links: b.links } : {}) }, { by });
    D.audit({ user: by, action: 'bm-perf.annotation', target: id, ip: req.ip || '', detail: JSON.stringify({ op, ...(op === 'delete' ? { text: String(a.text || '').slice(0, 120) } : { fields: rec.edits?.at(-1)?.fields || [] }) }).slice(0, 300) });
    res.json({ ok: true, id });
  } catch (e) { errOut(res, e); }
}

/** 집중 세션 자동 주석(작성자 system) — 시작 함수가 부른다. 실패는 시작 결과를 바꾸지 않는다(호출부 catch). */
export async function autoFocusAnnotation({ found, id, reason = '', status = null }) {
  const A = await import('../../bmusage/annotations.js');
  return A.addAnnotation({ by: 'system', at: Date.now(), kind: 'work', auto: 'focus',
    text: `집중 모니터링 ${status === 'queued' ? '대기열 등록' : '시작'} — ${String(reason).slice(0, 200)}`,
    target: { type: 'server', keys: [found.realKey], names: [String(found.target?.name || found.realKey)], vcenterIds: [t(found.target?.vcenterId)] }, links: { focus: String(id).slice(0, 40) } });
}

export function registerBmAnnotations(api) {
  api.get('/tools/bm-usage/annotations', toolsPerm, async (req, res) => {
    try { const r = await bmAnnotationsRead(req, store.get()); if (r.__status) { const { __status, ...rest } = r; return res.status(__status).json(rest); } res.json(r); }
    catch (e) { errOut(res, e); }
  });
  api.post('/tools/bm-usage/annotations', writeRole, toolsPerm, (req, res) => annotCreate(req, res));
  api.put('/tools/bm-usage/annotations/:id', writeRole, toolsPerm, (req, res) => annotChange(req, res, 'edit'));
  api.delete('/tools/bm-usage/annotations/:id', writeRole, toolsPerm, (req, res) => annotChange(req, res, 'delete'));
}
