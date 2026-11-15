/**
 * routes/api/bmWriteGate.js — 베어메탈 사용률 화면의 **쓰기 버튼 표지**(점검 반복 2회차 E1 · E2).
 *
 * 왜: 화면이 버튼을 역할(hasRole)만 보고 열어, 범위 계정 · 조회 전용 법인 · 데모 계정이 누르면 서버가 403 이었다
 *   (‘지금 수집’ · 용량/저활용 ‘이 노드 다시 계산’ · 저활용 ‘검토 상태’ · ‘주석 추가’ · 비교 ‘N대 동시 집중’ · 엣지 ‘지금 가져오기’ · 수집 설정 카드).
 *   웹이 판정을 복제하지 않게 **서버가 같은 판정으로 GET 응답에 싣는다** — 화면은 그 표지로 버튼을 닫고 이유(why)를 한 줄로 말한다.
 *
 * 판정 순서 = 요청이 실제로 거치는 순서(그래서 이유도 같은 것이 먼저 나온다):
 *   ① 데모 계정 — authMiddleware 의 denyDemoGuest 와 **같은 함수**(demoGuestDenial(method, '/api' + path)). ‘지금 수집’ 처럼 SAFE_ACTIONS 에 있는 것은 열린다.
 *   ② 역할 — 라우트의 requireRole 인자와 같은 목록(BM_ACTIONS.roles — 시험이 라우터 스택의 게이트 인자와 대조한다).
 *   ③ 범위 — fullScope: **조회 ∧ 쓰기 전체 범위**(`isFullReadWriteScope` — 라우트 본문과 같은 함수 · 2회차 재확인 R1: 조회만 보던 판정은 쓰기만 좁힌 계정을
 *      전체 범위로 읽었다 — server/CLAUDE.md v2.733 · v2.904 함정) · 법인 하나: inUserWriteScope(조건 없이 — v2.733).
 * ⚠ 표시 게이팅이다 — 집행은 그대로 라우트가 한다(이 표지가 무엇도 열지 않는다).
 * ⚠ 이 표지를 싣는 응답을 memoJson 으로 캐시하면 열쇠에 역할 · 데모 · 쓰기 범위 서명을 넣는다(gateKey — 같은 조회 범위의 operator 와 viewer 가 캐시를 나누지 않게).
 */
import { inUserWriteScope, writeScopedVcenterIds, isFullReadWriteScope } from '../../auth/scope.js';
import { isDemoGuest, demoGuestDenial } from '../../auth/demoGuest.js';

const OP = Object.freeze(['admin', 'operator']);
const ADMIN = Object.freeze(['admin']);

/** 화면이 닫는 동작 — 라우트(메서드 · 경로 · 역할 게이트 · 전 법인 여부)와 1:1(시험 bmUsageLoop2 가 실제 라우터와 대조). */
export const BM_ACTIONS = Object.freeze({
  settings: Object.freeze({ method: 'PUT', path: '/tools/bm-usage/settings', roles: ADMIN, fullScope: false }),   // 법인 켜기/끄기(쓰기 범위 법인만 — 행 표지 vcenters[].writable)
  // 같은 PUT 의 전역 값(수집 켜기 · 주기 · 보존 · 경로 · Enterprise · 알림) — 전 법인 공용이라 조회 ∧ 쓰기 전체 범위만(라우트가 그 밖 계정의 전역 값을 버리고 밝힌다)
  settingsGlobal: Object.freeze({ method: 'PUT', path: '/tools/bm-usage/settings', roles: ADMIN, fullScope: true }),
  collect: Object.freeze({ method: 'POST', path: '/tools/bm-usage/collect', roles: OP, fullScope: true }),
  edgePull: Object.freeze({ method: 'POST', path: '/tools/bm-usage/edges/pull', roles: OP, fullScope: true }),
  capacityRecompute: Object.freeze({ method: 'POST', path: '/tools/bm-usage/capacity/recompute', roles: OP, fullScope: true }),
  idleRecompute: Object.freeze({ method: 'POST', path: '/tools/bm-usage/idle/recompute', roles: OP, fullScope: true }),
  idleReview: Object.freeze({ method: 'POST', path: '/tools/bm-usage/idle/review', roles: OP, fullScope: false }),
  annotCreate: Object.freeze({ method: 'POST', path: '/tools/bm-usage/annotations', roles: OP, fullScope: false }),
  compareFocus: Object.freeze({ method: 'POST', path: '/tools/bm-usage/compare/focus', roles: OP, fullScope: false }),
  compareSetSave: Object.freeze({ method: 'PUT', path: '/tools/bm-usage/compare/sets', roles: OP, fullScope: false }),
  compareSetDelete: Object.freeze({ method: 'DELETE', path: '/tools/bm-usage/compare/sets/x', roles: OP, fullScope: false }),
  // 재확인 R4: 정비 창(법인 · 소유자 등급은 행 표지가 따로 — bmMaint canEdit 등) · 키 겹침 결정 — 데모 · 역할
  maintCreate: Object.freeze({ method: 'POST', path: '/tools/bm-usage/maintenance', roles: OP, fullScope: false }),
  maintEdit: Object.freeze({ method: 'PUT', path: '/tools/bm-usage/maintenance/x', roles: OP, fullScope: false }),
  maintEnd: Object.freeze({ method: 'POST', path: '/tools/bm-usage/maintenance/x/end', roles: OP, fullScope: false }),
  maintConfirm: Object.freeze({ method: 'POST', path: '/tools/bm-usage/maintenance/x/confirm', roles: OP, fullScope: false }),
  maintDelete: Object.freeze({ method: 'DELETE', path: '/tools/bm-usage/maintenance/x', roles: OP, fullScope: false }),
  keyDecide: Object.freeze({ method: 'POST', path: '/tools/bm-usage/key-overlaps/decision', roles: OP, fullScope: false }),
  keyClear: Object.freeze({ method: 'DELETE', path: '/tools/bm-usage/key-overlaps/decision', roles: OP, fullScope: false }),
  // 점검 반복 8회차 F2: 서버 상세 실행 동작 — 데모 · 역할(쓰기 범위는 GET 의 writable 이 따로 — 조회 밖 404 → 쓰기 밖 403)
  snapshotRun: Object.freeze({ method: 'POST', path: '/tools/bm-usage/perf/x/snapshot', roles: OP, fullScope: false }),
  focusStart: Object.freeze({ method: 'POST', path: '/tools/bm-usage/perf/x/focus', roles: OP, fullScope: false }),
});

/** 이유 code(화면 문구는 web bmWriteText.js WRITE_WHY_TEXT — 1:1 시험). */
export const WRITE_WHY = Object.freeze(['demo', 'role-admin', 'role-operator', 'full-scope', 'read-only', 'no-os-path']);   // no-os-path: 10회차 L2 — 스냅샷 실행 표지(실행 라우트와 같은 판정)

/**
 * 이 계정이 그 동작을 보낼 수 있나 → { ok:true } | { ok:false, why }.
 * @param {object} req  요청(req.user — 인증이 꺼져 있으면 authMiddleware 가 익명 역할을 넣는다)
 * @param {string} name BM_ACTIONS 키
 * @param {{snap?:object, vcenterId?:string}} [o]  vcenterId 를 주면 그 법인 쓰기 범위까지(inUserWriteScope — 라우트와 같은 함수)
 */
export function bmGate(req, name, { snap = null, vcenterId } = {}) {
  const a = BM_ACTIONS[name];
  if (!a) return { ok: false, why: 'role-admin' };   // 모르는 동작은 닫는다(거부 기본값)
  const u = req?.user || null;
  if (isDemoGuest(u) && demoGuestDenial(a.method, `/api${a.path}`)) return { ok: false, why: 'demo' };
  if (!a.roles.includes(u?.role)) return { ok: false, why: a.roles.includes('operator') ? 'role-operator' : 'role-admin' };
  if (a.fullScope && !isFullReadWriteScope(u, snap)) return { ok: false, why: 'full-scope' };
  // 쓰기 라우트와 같은 inUserWriteScope(조건 없이) — 귀속 없음('')은 전체 범위 계정만 통과한다(주석 · 비교 집중 라우트와 같다).
  if (vcenterId !== undefined && !inUserWriteScope(u, snap, String(vcenterId ?? ''))) return { ok: false, why: 'read-only' };
  return { ok: true };
}

/** 여러 동작의 표지 묶음(응답 actions). */
export function bmGates(req, names, o = {}) {
  return Object.fromEntries(names.map((nm) => [nm, bmGate(req, nm, o)]));
}

/**
 * 행 · 열의 쓰기 범위(역할 · 데모는 응답 actions 가 따로 말한다). requireCorp: 그 쓰기 라우트가 귀속 없음을 404 로 거절하면(저활용 검토 — bmIdleReview) true.
 */
export const writableVc = (req, snap, vc, { requireCorp = false } = {}) => (requireCorp && !vc ? false : inUserWriteScope(req?.user, snap, String(vc ?? '')));

/** memoJson 열쇠 조각 — 역할 · 데모 · 쓰기 범위(표지가 응답에 실리면 이 셋이 다른 계정끼리 캐시를 나누지 않게). */
export function gateKey(req, snap) {
  let w = 'all';
  try { const ws = writeScopedVcenterIds(req?.user, snap); w = ws ? [...ws].sort().join(',') : 'all'; } catch { w = 'err'; }
  return `r${String(req?.user?.role || '')}${isDemoGuest(req?.user) ? 'd' : ''}|w${w}`;
}
