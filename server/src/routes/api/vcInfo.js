// vCenter 알람 · 최근 작업 · 권한 목록(v2.898) — vCenter 상세의 모니터 › 문제 및 알람 · 작업, 사용 권한 탭(VM · 호스트 개체 보기 포함).
// 값은 vcinfo 캐시(수집 주기 안에서 종류별 주기로 읽은 것 — 이 라우트는 vCenter 에 묻지 않는다)이고, 데모 vCenter 는 mock/vcinfo.js.
// 규칙(server/CLAUDE.md): 조회 범위 밖 vCenter 는 404(존재 은닉) → 권한 목록은 관리자 판본(isAdminDetailUser)만, 아니면 403.
//   작업을 시작한 사용자 · 알람 확인자 이름도 관리자 판본에서만 싣는다(그 밖에는 null + userMasked).
import { requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { isAdminDetailUser } from '../../auth/demoGuest.js';
import { store } from '../../store.js';
import { config, loadVcenterConfig } from '../../config.js';
import { getVcInfo, VCINFO_REFRESH_MS } from '../../vcinfo/collect.js';
import { VCINFO_LIMITS, VCREST_LIMITS, TASK_KEEP_MS, POOLS_MAX, DVPG_MAX } from '../../vcinfo/parse.js';
import { mockVcInfo } from '../../mock/vcinfo.js';

export const VCINFO_KINDS = Object.freeze(['alarms', 'tasks', 'perms', 'linked', 'updates', 'vlcm', 'pools', 'dvpg']);
/** 종류별 기능 권한 — 알람 · 작업 · 권한 목록은 알람 권한, Linked Mode · 업데이트 · vLCM 은 호스트 조회 권한(버전 · 구성 정보). */
export const VCINFO_PERM = Object.freeze({ alarms: 'inv.alarms', tasks: 'inv.alarms', perms: 'inv.alarms', linked: 'inv.hosts', updates: 'inv.hosts', vlcm: 'inv.hosts', pools: 'inv.hosts', dvpg: 'inv.hosts' });
/** 등록 주소 · 노드 이름의 호스트 부분 — 스킴 · 경로 · 포트를 뗀다. IPv6 는 '[…]' 안, 괄호 없는 IPv6(콜론 2개 이상)는 통째로(반증 하-7). */
export function hostKey(h) {
  let s = String(h || '').trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]{0,15}:\/\//, '');
  s = s.split('/')[0];
  if (s.startsWith('[')) { const e = s.indexOf(']'); return e > 0 ? s.slice(1, e) : ''; }
  if ((s.match(/:/g) || []).length >= 2) return s;
  return s.split(':')[0];
}
// 등록부(id · host)만 짧게 기억한다 — 요청마다 파일을 읽고 비밀을 풀지 않게(반증 하-8).
let _reg = { at: 0, list: [] };
function registryHosts(now = Date.now()) {
  if (now - _reg.at < 30_000) return _reg.list;
  let list = [];
  try { list = (loadVcenterConfig().vcenters || []).filter((r) => r && r.id != null).map((r) => ({ id: String(r.id), host: r.host })); } catch { list = []; }
  _reg = { at: now, list };
  return list;
}
/**
 * Linked Mode 구성원 → 포탈 등록 vCenter(조회 범위 안만). 노드 이름(FQDN/IP)과 등록 주소의 호스트 부분이 같을 때만 — 범위 밖 등록은 알려 주지 않는다
 * (등록 여부도 범위 밖 정보다). 접속하지 않는다(발견한 주소로 자동 접속하면 SSRF · TLS 신뢰 규약에 걸린다).
 */
/**
 * v2.901: 범위 계정에는 **포탈 등록 vCenter(조회 범위 안)로 짝지어진 노드만** 이름을 보인다 — 나머지(범위 밖 등록 · 미등록)는 이름을 가리고
 * 개수만 남긴다(복제 파트너 · 복제 상태의 이름도 같은 규칙). 전체 범위 계정은 그대로. 짝을 못 지은 자기 자신(등록 주소가 IP · 노드가 FQDN 등)도
 * 가려진다 — 이름을 지어내 짝짓지 않는다(화면이 '가려짐' 으로 말한다).
 */
export function maskLinkedForScope(body, allowed) {
  if (!allowed || !Array.isArray(body?.nodes)) return body;
  const visible = new Set(body.nodes.filter((n) => n.portal).map((n) => n.node));
  const nm = (x) => (visible.has(x) ? x : null);
  const nodes = body.nodes.map((n) => (n.portal ? { ...n, partners: (n.partners || []).map(nm) } : { node: null, type: n.type ?? null, partners: [], portal: null, masked: true }));
  const replication = Array.isArray(body.replication) ? body.replication.map((r) => ({ ...r, node: nm(r.node), partner: nm(r.partner) })) : body.replication;
  const masked = nodes.filter((n) => n.masked).length;
  return { ...body, nodes, replication, ...(masked ? { maskedNodes: masked } : {}) };
}
export function linkedPortalMap(nodes, registry, snapVcs, allowed, { mock = false } = {}) {
  const byHost = new Map();
  for (const r of Array.isArray(registry) ? registry : []) {
    if (!r || r.id == null || (allowed && !allowed.has(String(r.id)))) continue;
    const k = hostKey(r.host);
    if (k && !byHost.has(k)) byHost.set(k, String(r.id));
  }
  // 데모: 등록부에 주소가 없다 — mock 노드 이름('<vcenterId>.corp.example')의 앞머리로 맞춘다(범위 안만).
  if (mock) for (const v of snapVcs || []) if (!allowed || allowed.has(v.id)) byHost.set(`${String(v.id).toLowerCase()}.corp.example`, v.id);
  const snapBy = new Map((snapVcs || []).map((v) => [v.id, v]));
  return (Array.isArray(nodes) ? nodes : []).map((n) => {
    const id = byHost.get(hostKey(n.node));
    const v = id ? snapBy.get(id) : null;
    return { ...n, portal: id ? { id, name: v?.name || id, version: v?.version || null, build: v?.build || null, status: v?.status || null } : null };
  });
}
/** v2.901(점검 E7): 엣지 push 값의 낡음 · 만료(엣지는 수집 주기마다 보낸다 — 분 단위). */
export const EDGE_STALE_MS = 30 * 60_000;
export const EDGE_EXPIRE_MS = 24 * 3_600_000;
const NOT_YET_TEXT = '아직 읽지 않았습니다 — 다음 수집 주기에 읽습니다(엣지가 수집하는 vCenter 는 엣지 · 중앙이 v2.898 이상이어야 보냅니다).';
/** 화면이 말하는 상한 · 보관 기간(숫자를 화면에 박지 않는다 — 반증 하-8). */
const KIND_LIMITS = Object.freeze({
  alarms: { max: VCINFO_LIMITS.alarms }, tasks: { max: VCINFO_LIMITS.tasks, keepMs: TASK_KEEP_MS }, perms: { max: VCINFO_LIMITS.perms },
  vlcm: { clusters: VCREST_LIMITS.clusters, ncMax: VCREST_LIMITS.nc },
  pools: { max: POOLS_MAX },   // v2.901
  dvpg: { max: DVPG_MAX },     // v2.904
});

/** 응답 본문(순수 — 테스트 고정). entry 는 캐시의 그 종류 값(없으면 null), admin 은 관리자 판본 여부. */
export function vcInfoBody(kind, vcenterId, entry, { admin = false, source = null } = {}) {
  const base = { ok: true, kind, vcenterId, refreshMs: VCINFO_REFRESH_MS[kind], source, ...(KIND_LIMITS[kind] ? { limits: KIND_LIMITS[kind] } : {}) };
  // 한 번도 읽지 못했으면(at 없음 — 첫 시도 실패 · 시한으로 건너뜀 · REST 로그인 거부) '0건 · 없음' 이 아니라 '아직 읽지 않음' 이다(반증 중-2).
  if (!entry || entry.at == null) {
    const err = entry?.error ?? null;
    return { ...base, at: null, items: [], notCollected: err ? `아직 한 번도 읽지 못했습니다 — ${err}` : NOT_YET_TEXT, error: err };
  }
  // ④ REST 3종은 모양이 달라 값을 그대로 싣는다(정제된 캐시 · 사람 이름 없음). retryAt 은 내부 값이라 뺀다.
  if (kind === 'linked' || kind === 'updates' || kind === 'vlcm') {
    const { retryAt, ...rest } = entry; void retryAt;
    return { ...base, items: [], ...rest, at: entry.at ?? null, error: entry.error ?? null };
  }
  let items = Array.isArray(entry.items) ? entry.items : [];
  let userMasked = false;
  if (!admin && kind === 'tasks') { userMasked = items.some((t) => t.user); items = items.map((t) => ({ ...t, user: null })); }
  if (!admin && kind === 'alarms') { userMasked = items.some((a) => a.ackBy); items = items.map((a) => ({ ...a, ackBy: null })); }
  return {
    ...base, at: entry.at ?? null, items, error: entry.error ?? null,
    ...(entry.omitted ? { omitted: entry.omitted } : {}),
    ...(entry.unreadable ? { unreadable: entry.unreadable } : {}),   // v2.901(점검 E1): 못 읽은 알람 원소 수
    ...(kind === 'dvpg' ? { lagError: entry.lagError ?? null, dvsError: entry.dvsError ?? null } : {}),   // v2.904: LAG · vDS 이름을 못 읽은 사유
    ...(kind === 'perms' ? { roles: Array.isArray(entry.roles) ? entry.roles : [] } : {}),
    ...(userMasked ? { userMasked: true } : {}),
  };
}

export function registerVcInfo(api) {
  api.get('/vcenter-info/:kind', (req, res, next) => {
    const kind = String(req.params.kind || '');
    if (!VCINFO_KINDS.includes(kind)) return res.status(404).json({ ok: false, reason: '모르는 종류입니다.' });
    return requirePerm(VCINFO_PERM[kind])(req, res, next);
  }, (req, res) => {
    const kind = String(req.params.kind);
    const vcenterId = typeof req.query.vcenterId === 'string' ? req.query.vcenterId : '';
    const snap = store.get();
    const vc = (snap.vcenters || []).find((v) => v.id === vcenterId);
    // scope 가 먼저 — 범위 밖 · 없는 vCenter 는 같은 404(존재 여부를 흘리지 않는다).
    const allowed = scopedVcenterIds(req.user, snap);
    if (!vc || (allowed && !allowed.has(vcenterId))) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
    const admin = isAdminDetailUser(req.user);
    if (kind === 'perms' && !admin) return res.status(403).json({ ok: false, adminOnly: true, reason: '권한 목록(사용자 · 그룹 · 역할)은 관리자 판본에서만 볼 수 있습니다.' });
    let cached = getVcInfo(vcenterId);
    // v2.901(점검 E7): 엣지가 보낸 값은 받은 지 오래되면 낡았다고 말하고(30분), 하루가 넘으면 보이지 않는다(엣지가 멈춘 뒤 옛 권한 목록을 계속 보이지 않게).
    const edgeAge = cached?.source === 'edge' && Number.isFinite(cached.pushAt) ? Date.now() - cached.pushAt : null;
    if (edgeAge != null && edgeAge > EDGE_EXPIRE_MS) cached = null;
    const mock = vc.mock === true || config.dataSource === 'mock';
    const entry = cached?.[kind] || (mock ? mockVcInfo(kind, vcenterId, snap, Date.now(), allowed) : null);
    const body = vcInfoBody(kind, vcenterId, entry, { admin, source: cached?.[kind] ? cached.source : mock ? 'mock' : null });
    if (cached?.[kind] && edgeAge != null && edgeAge > EDGE_STALE_MS) { body.stale = true; body.staleMin = Math.round(edgeAge / 60_000); }
    if (kind === 'linked' && entry) {
      body.nodes = linkedPortalMap(entry.nodes, registryHosts(), snap.vcenters, allowed, { mock: body.source === 'mock' });
      return res.json(maskLinkedForScope(body, allowed));
    }
    res.json(body);
  });
}
