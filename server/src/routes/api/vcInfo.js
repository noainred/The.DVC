// vCenter 알람 · 최근 작업 · 권한 목록(v2.897) — vCenter 상세의 모니터 › 문제 및 알람 · 작업, 사용 권한 탭(VM · 호스트 개체 보기 포함).
// 값은 vcinfo 캐시(수집 주기 안에서 종류별 주기로 읽은 것 — 이 라우트는 vCenter 에 묻지 않는다)이고, 데모 vCenter 는 mock/vcinfo.js.
// 규칙(server/CLAUDE.md): 조회 범위 밖 vCenter 는 404(존재 은닉) → 권한 목록은 관리자 판본(isAdminDetailUser)만, 아니면 403.
//   작업을 시작한 사용자 · 알람 확인자 이름도 관리자 판본에서만 싣는다(그 밖에는 null + userMasked).
import { requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { isAdminDetailUser } from '../../auth/demoGuest.js';
import { store } from '../../store.js';
import { config, loadVcenterConfig } from '../../config.js';
import { getVcInfo, VCINFO_REFRESH_MS } from '../../vcinfo/collect.js';
import { mockVcInfo } from '../../mock/vcinfo.js';

export const VCINFO_KINDS = Object.freeze(['alarms', 'tasks', 'perms', 'linked', 'updates', 'vlcm']);
/** 종류별 기능 권한 — 알람 · 작업 · 권한 목록은 알람 권한, Linked Mode · 업데이트 · vLCM 은 호스트 조회 권한(버전 · 구성 정보). */
export const VCINFO_PERM = Object.freeze({ alarms: 'inv.alarms', tasks: 'inv.alarms', perms: 'inv.alarms', linked: 'inv.hosts', updates: 'inv.hosts', vlcm: 'inv.hosts' });
const hostKey = (h) => String(h || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/:].*$/, '');
/**
 * Linked Mode 구성원 → 포탈 등록 vCenter(조회 범위 안만). 노드 이름(FQDN/IP)과 등록 주소의 호스트 부분이 같을 때만 — 범위 밖 등록은 알려 주지 않는다
 * (등록 여부도 범위 밖 정보다). 접속하지 않는다(발견한 주소로 자동 접속하면 SSRF · TLS 신뢰 규약에 걸린다).
 */
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
const NOT_YET_TEXT = '아직 읽지 않았습니다 — 다음 수집 주기에 읽습니다(엣지가 수집하는 vCenter 는 엣지가 v2.897 이상이어야 보냅니다).';

/** 응답 본문(순수 — 테스트 고정). entry 는 캐시의 그 종류 값(없으면 null), admin 은 관리자 판본 여부. */
export function vcInfoBody(kind, vcenterId, entry, { admin = false, source = null } = {}) {
  const base = { ok: true, kind, vcenterId, refreshMs: VCINFO_REFRESH_MS[kind], source };
  if (!entry) return { ...base, at: null, items: [], notCollected: NOT_YET_TEXT, error: null };
  // ④ REST 3종은 모양이 달라 값을 그대로 싣는다(정제된 캐시 · 사람 이름 없음). retryAt · tried 는 내부 값이라 뺀다.
  if (kind === 'linked' || kind === 'updates' || kind === 'vlcm') {
    const { retryAt, tried, ...rest } = entry; void retryAt; void tried;
    return { ...base, items: [], ...rest, at: entry.at ?? null, error: entry.error ?? null };
  }
  let items = Array.isArray(entry.items) ? entry.items : [];
  let userMasked = false;
  if (!admin && kind === 'tasks') { userMasked = items.some((t) => t.user); items = items.map((t) => ({ ...t, user: null })); }
  if (!admin && kind === 'alarms') { userMasked = items.some((a) => a.ackBy); items = items.map((a) => ({ ...a, ackBy: null })); }
  return {
    ...base, at: entry.at ?? null, items, error: entry.error ?? null,
    ...(entry.omitted ? { omitted: entry.omitted } : {}),
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
    const cached = getVcInfo(vcenterId);
    const mock = vc.mock === true || config.dataSource === 'mock';
    const entry = cached?.[kind] || (mock ? mockVcInfo(kind, vcenterId, snap) : null);
    const body = vcInfoBody(kind, vcenterId, entry, { admin, source: cached?.[kind] ? cached.source : mock ? 'mock' : null });
    if (kind === 'linked' && entry) {
      let reg = [];
      try { reg = loadVcenterConfig().vcenters || []; } catch { reg = []; }
      body.nodes = linkedPortalMap(entry.nodes, reg, snap.vcenters, allowed, { mock: body.source === 'mock' });
    }
    res.json(body);
  });
}
