// vCenter 알람 · 최근 작업 · 권한 목록(v2.897) — vCenter 상세의 모니터 › 문제 및 알람 · 작업, 사용 권한 탭(VM · 호스트 개체 보기 포함).
// 값은 vcinfo 캐시(수집 주기 안에서 종류별 주기로 읽은 것 — 이 라우트는 vCenter 에 묻지 않는다)이고, 데모 vCenter 는 mock/vcinfo.js.
// 규칙(server/CLAUDE.md): 조회 범위 밖 vCenter 는 404(존재 은닉) → 권한 목록은 관리자 판본(isAdminDetailUser)만, 아니면 403.
//   작업을 시작한 사용자 · 알람 확인자 이름도 관리자 판본에서만 싣는다(그 밖에는 null + userMasked).
import { requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { isAdminDetailUser } from '../../auth/demoGuest.js';
import { store } from '../../store.js';
import { config } from '../../config.js';
import { getVcInfo, VCINFO_REFRESH_MS } from '../../vcinfo/collect.js';
import { mockVcInfo } from '../../mock/vcinfo.js';

export const VCINFO_KINDS = Object.freeze(['alarms', 'tasks', 'perms']);
const NOT_YET_TEXT = '아직 읽지 않았습니다 — 다음 수집 주기에 읽습니다(엣지가 수집하는 vCenter 는 엣지가 v2.897 이상이어야 보냅니다).';

/** 응답 본문(순수 — 테스트 고정). entry 는 캐시의 그 종류 값(없으면 null), admin 은 관리자 판본 여부. */
export function vcInfoBody(kind, vcenterId, entry, { admin = false, source = null } = {}) {
  const base = { ok: true, kind, vcenterId, refreshMs: VCINFO_REFRESH_MS[kind], source };
  if (!entry) return { ...base, at: null, items: [], notCollected: NOT_YET_TEXT, error: null };
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
  api.get('/vcenter-info/:kind', requirePerm('inv.alarms'), (req, res) => {
    const kind = String(req.params.kind || '');
    if (!VCINFO_KINDS.includes(kind)) return res.status(404).json({ ok: false, reason: '모르는 종류입니다.' });
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
    res.json(vcInfoBody(kind, vcenterId, entry, { admin, source: cached?.[kind] ? cached.source : mock ? 'mock' : null }));
  });
}
