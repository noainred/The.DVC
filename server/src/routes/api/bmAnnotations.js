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
import { resolvePerfTarget, perfTargetFail, perfPairsOf, bmAddressHosts, perfAddressMatcher } from './bmUsage.js';

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

/**
 * 주석이 그 서버 것인가(순수) — 서버 = (법인, 키) 쌍(다음 점검 ①): 키가 대상 키에 있고 **법인이 주석의 법인에 있을 때만**.
 *   예전에는 키만 봐 법인 A 서버의 주석이 같은 키의 법인 B 서버 추이에도 핀으로 떴다. ⚠ 여러 법인 · 여러 서버 주석은 키 ↔ 법인 짝을 저장하지 않아
 *   (target.vcenterIds 는 집합) ‘키 ∧ 법인 ∈ 집합’ 으로 본다 — 법인 A 의 K · 법인 B 의 J 를 함께 단 주석은 법인 B 의 K 에도 맞는다(정직 기록 · 드물다).
 */
export const annotForPair = (a, realKey, vc) => (a?.target?.keys || []).includes(realKey) && (a?.target?.vcenterIds || []).includes(vc);

/** GET /tools/bm-usage/annotations?keys=&vcenterIds=&corp=&from=&to= (vcenterIds 는 keys 와 같은 순서 — 다음 점검 ①) */
export async function bmAnnotationsRead(req, snap, deps = {}) {
  const D = memo(deps0(deps));
  const allowed = scopedVcenterIds(req.user, snap);
  const isAdmin = isAdminReq(req);
  const q = req.query || {};
  const { pairs } = perfPairsOf(typeof q.keys === 'string' ? q.keys : '', typeof q.vcenterIds === 'string' ? q.vcenterIds : '', 8);
  const corp = t(q.corp);
  if (corp && allowed && !allowed.has(corp)) return { __status: 404, ok: false, reason: '대상 법인을 찾지 못했습니다.' };
  const asked = [];
  for (const { key, vcenterId } of pairs) {
    const f = await resolvePerfTarget(req, D, { allowed, isAdmin, key, vcenterId });
    // 범위 밖 · 없는 키는 조용히 빠진다(존재를 흘리지 않는다) · 같은 키가 범위 안 여러 법인이면 400(법인을 고르게 — 엉뚱한 법인 주석을 보이지 않는다).
    if (f?.ambiguous) return perfTargetFail(f);
    if (!perfTargetFail(f)) asked.push({ token: key, realKey: f.realKey, vc: t(f.target.vcenterId) });
  }
  const from = Number(q.from); const to = Number(q.to);
  const A = await D.store();
  let all;
  try { all = A.listAnnotations(); } catch (e) { return { __status: e?.status || 500, ok: false, code: e?.code || 'error', reason: String(e?.message || e).slice(0, 300) }; }
  const vcs = new Set(asked.map((x) => x.vc).filter(Boolean));
  const hitsOf = (a) => asked.filter((x) => annotForPair(a, x.realKey, x.vc));
  let list = all.filter((a) => annotVisible(a, allowed));
  if (pairs.length || corp) {
    list = list.filter((a) => hitsOf(a).length > 0 || (a.target?.type === 'corp' && (vcs.has(a.target.vcenterIds?.[0]) || a.target.vcenterIds?.[0] === corp)));
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
  // v2.954(점검 A-2): 비관리자 판본 — 작성 · 수정 · 삭제한 사람은 가림 토큰(형제 저활용 화면 maskBy 와 같은 maskedIdToken · 'system' 은 그대로) ·
  //   본문의 주소(등록부 주소 · IPv4)는 대상 이름과 같은 판정기(maskName)로 단어마다 가린다(집중 화면 scrubFocus 의 사유 가림과 같은 결).
  //   ⚠ 본인이 쓴 주석의 본문은 가리지 않는다 — 비관리자가 고칠 수 있는 것은 자기 주석뿐이라, 가린 본문을 고쳐 저장하면 원문이 토큰으로 덮인다.
  const maskBy = (v) => (isAdmin || !v || v === 'system' ? v : maskedIdToken(String(v)));
  const maskText = (v) => (isAdmin || typeof v !== 'string' ? v : v.replace(/[^\s,;()[\]<>'"]+/g, (w) => maskName(w)));
  const out = list.map((a) => {
    const own = a.by === user && a.by !== 'system';
    return {
      id: a.id, at: a.at, end: a.end ?? null, kind: a.kind, text: a.deleted ? '' : (own ? a.text : maskText(a.text)), by: maskBy(a.by), created: a.created, auto: a.auto || null,
      target: { type: a.target?.type, count: (a.target?.keys || []).length, names: (a.target?.names || []).map(maskName), vcenterIds: a.target?.vcenterIds || [],
        includes: [...new Set(hitsOf(a).map((x) => x.token))], includesPairs: hitsOf(a).map((x) => ({ key: x.token, vcenterId: x.vc })) },
      links: a.deleted ? {} : (a.links || {}),
      edits: (a.edits || []).map((e) => ({ at: e.at, by: maskBy(e.by), fields: e.fields })),
      ...(a.deleted ? { deleted: { ...a.deleted, by: maskBy(a.deleted.by) } } : {}),
      canEdit: !a.deleted && (isAdmin || own) && annotWritable(a, req.user, snap),
    };
  });
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
  // 다음 점검 ①: 서버 = (법인, 키) 쌍 — 화면이 keys 와 같은 순서로 vcenterIds 를 보낸다(없고 같은 키가 범위 안 여러 법인이면 400 ambiguous-key).
  const { pairs, over } = perfPairsOf(Array.isArray(b.keys) ? b.keys : [], Array.isArray(b.vcenterIds) ? b.vcenterIds : [], 8);
  if (!pairs.length || over) return { err: { status: 400, code: 'bad-target', reason: '대상 서버는 1~8대입니다.' } };
  const found = [];
  for (const { key, vcenterId } of pairs) {
    const f = await resolvePerfTarget(req, D, { allowed, isAdmin, key, vcenterId });
    const bad = perfTargetFail(f);
    if (bad) return { err: { status: bad.__status, code: bad.code, reason: bad.reason, ...(bad.candidates ? { candidates: bad.candidates } : {}) } };
    found.push(f);
  }
  // 같은 서버(쌍)를 두 번 고른 요청은 한 번만(가림 토큰과 원문을 섞어 보낸 경우 — 쌍이 같다)
  const seen = new Set();
  for (let i = found.length - 1; i >= 0; i -= 1) { const id = `${t(found[i].target.vcenterId)}|${found[i].realKey}`; if (seen.has(id)) found.splice(i, 1); else seen.add(id); }
  if (found.some((f) => !inUserWriteScope(req.user, snap, t(f.target.vcenterId)))) return { err: { status: 403, code: 'forbidden', reason: '대상 중 쓰기 권한이 없는 법인의 서버가 있습니다(조회 전용).' } };
  return { target: { type: found.length === 1 ? 'server' : 'servers', keys: found.map((f) => f.realKey), names: found.map((f) => String(f.target.name || f.realKey)), vcenterIds: [...new Set(found.map((f) => t(f.target.vcenterId)))] } };
}
async function annotCreate(req, res) {
  try {
    const D = memo(deps0());
    const snap = store.get();
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const w = await writeTarget(req, snap, D, b);
    if (w.err) return res.status(w.err.status).json({ ok: false, code: w.err.code, reason: w.err.reason, ...(w.err.candidates ? { candidates: w.err.candidates } : {}) });
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
