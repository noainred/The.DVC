/**
 * auth/toolAccess.js — 특수 기능 '도구별 접근'(toolsDenied) 의 **서버 집행** (v2.447, 감사 S2).
 *
 * 문제: 관리자가 '설정 › 사용자 관리 › 특수 기능 도구별 접근' 에서 도구를 거부해도 그 목록은
 * 프론트(`web/src/api.js toolAllowed`)에서만 쓰였다. 서버에는 참조 코드가 한 줄도 없어
 * curl 로 `/api/tools/<도구>` 를 직접 부르면 그대로 200 이 나왔다 — 관리자는 화면에서
 * '차단됨' 을 보고 통제가 걸린 줄 오인한다(무음 실패). server/CLAUDE.md 의
 * "기능 권한은 서버가 진실의 원천, 프론트는 UX 게이팅일 뿐" 을 정면으로 위반한 상태였다.
 *
 * 설계(가용성 우선):
 *  · 경로 첫 세그먼트 → 도구 키 매핑에 **확실한 것만** 등재한다. 매핑에 없는 경로는 통과시킨다 —
 *    잘못된 매핑으로 정상 사용자를 막는 쪽이 더 큰 사고다(모르면 막지 않는다).
 *  · 확장자(.csv/.json/.xlsx)는 떼고 매칭한다(`/tools/ipam.csv` = ipam).
 *  · admin 은 항상 통과(roleToolsDenied 가 admin 에 빈 배열을 준다).
 *  · 거부 응답은 기존 403 형태를 유지한다 — 프론트 ErrorBox 가 AccessDenied 로 자동 전환하려면
 *    `{error:'forbidden', requiredPerm}` 계약이 필요하다(CLAUDE.md 프론트 규칙).
 */
import { roleToolsDenied } from './permissions.js';

/**
 * 라우트 경로 첫 세그먼트 → 프론트 도구 키(`web/src/views/specialToolsList.js` 의 k).
 * 이름이 다른 것만 주의: deep-search→deepsearch, duplicate-ips→dupip, esxi-temp→esxitemp,
 * guest-os→guestos, network-check→net-check, rightsize→rightsizing, sanswitch→san-switch,
 * storage→storage-mon, thin-vms→thinvms, vm-finder→vmfinder.
 * 의도적 제외(도구 화면 전용이 아니거나 키가 불분명): ip-ping(VM 상세에서 사용), vclogs.
 * v2.506 에서 제외 목록에서 빠진 것: `report/*` 는 리포트별로 **두 세그먼트**를 보는 별도 표
 * (TOOL_PATH2_KEYS)로 매핑했고, `service-check`·`vmware-config` 는 각각 한 화면 전용임을
 * 확인해 이 표에 넣었다.
 */
export const TOOL_PATH_KEYS = Object.freeze({
  'bm-storage': 'bm-storage',
  capacity: 'capacity',
  // ⚠ v2.506 수정: 예전에는 이 세그먼트를 `'capacity-forecast'` 키로 매핑했는데, `/tools/capacity-forecast`
  // 를 실제로 부르는 화면은 **`forecast`**(용량 추세/예측, CapacityTools.jsx:102)다. UI 키
  // `capacity-forecast`(용량 고갈 예측)는 `/tools/report/capacity` 를 쓴다(ToolsReports.jsx:302).
  // 즉 거부하면 **엉뚱한 화면이 막히고** 정작 `forecast` 는 안 막히는 상태였다.
  'capacity-forecast': 'forecast',
  credentials: 'credentials',
  'deep-search': 'deepsearch',
  'duplicate-ips': 'dupip',
  esxi: 'esxi',
  'esxi-temp': 'esxitemp',
  gpu: 'gpu',
  'guest-disk': 'guest-disk',
  'guest-os': 'guestos',
  hardware: 'hardware',
  hba: 'hba',
  insights: 'insights',
  ipam: 'ipam',
  'license-expiry': 'license-expiry',
  licenses: 'licenses',
  'network-check': 'net-check',
  // v2.506 추가 — 전용 엔드포인트를 가진(= 다른 도구와 공유하지 않는) 도구들. 공유 엔드포인트를
  // 한 도구에 묶으면 그 엔드포인트를 쓰는 **다른 화면이 같이 막힌다**(가장 위험한 실수).
  'orphan-vmdk': 'orphanvmdk',       // OrphanVmdk.jsx 전용(v2.505)
  'service-check': 'davinci-svc',    // DavinciChecks.jsx ServiceCheck 전용
  'vmware-config': 'vmware-backup',  // DavinciChecks.jsx VmwareConfigBackup 전용
  pdu: 'pdu',
  relaycheck: 'relaycheck',
  relaytopo: 'relaytopo',
  rightsize: 'rightsizing',
  rma: 'rma',
  sanswitch: 'san-switch',
  'secret-scan': 'secret-scan',
  'serial-lookup': 'serial-lookup',
  snapshots: 'snapshots',
  solutions: 'solutions',
  storage: 'storage-mon',
  'thin-vms': 'thinvms',
  threats: 'threats',
  'vm-clone': 'vm-clone',
  'vm-export': 'vm-export',
  'vm-finder': 'vmfinder',
  'vm-track': 'vm-track',
  vmtools: 'vmtools',
  waste: 'waste',
});

/**
 * **두 세그먼트** 매핑(v2.506) — 첫 세그먼트만으로는 구분할 수 없는 경로를 위한 표.
 *
 * 왜 필요한가: `/tools/report/*` 한 세그먼트가 리포트 도구 **10개**를 서비스한다. 첫 세그먼트만
 * 보는 매처로는 `/tools/report/health`(일일 헬스체크)와 `/tools/report/zombies`(좀비 리소스)를
 * 구분할 수 없어, 10개 도구 전부가 서버 집행 대상에서 빠져 있었다(관리자는 화면에서 '차단됨' 을
 * 보지만 curl 은 200 — 이 모듈이 v2.447 에 없애려 한 바로 그 '무음 실패' 가 남아 있었다).
 *
 * 한 세그먼트 표보다 **먼저** 조회한다(최장 접두 우선). 각 항목은 웹에서 그 경로를 부르는 화면이
 * 하나뿐임을 확인한 것만 넣는다(ToolsReports.jsx 의 컴포넌트 ↔ 경로가 1:1 임을 확인).
 */
export const TOOL_PATH2_KEYS = Object.freeze({
  'report/health': 'daily-health',
  'report/snapshot-age': 'snapshot-age',
  'report/zombies': 'zombie-vms',
  'report/certs': 'cert-expiry',
  'report/rightsizing': 'rightsizing',
  'report/capacity': 'capacity-forecast',
  'report/alerts': 'alert-channels',
  'report/compliance': 'compliance-report',
  'report/changes': 'change-history',
  'report/unprotected': 'unprotected-vms',
  // 전용 하위경로만 — 같은 도구가 공용 `/tools/vm-track` 도 쓰므로 '부분 집행' 으로 선언한다(아래).
  'vm-track/ds-change-log': 'storage-track',
});

/**
 * 세그먼트 정규화 — 확장자 제거 + **소문자화**(v2.506, 적대적 검증 지적).
 *
 * ⚠ 소문자화가 없으면 이 게이트 전체가 무력화된다: Express 는 `case sensitive routing` 기본 false 라
 * `/api/Tools/Ipam` 이 **라우트에는 그대로 도달**하는데, 표의 키는 전부 소문자여서 조회가 빗나가
 * `toolKeyForPath` 가 null 을 돌려준다(= 검사 안 함). 대문자 한 글자로 거부목록을 지나간다.
 * 라우팅이 대소문자를 무시하므로 소문자 정규화는 **과차단을 만들지 않는다** — 방향이 안전하다.
 * (v2.500 C-1 이 `req.path ===` 정확 비교로 뚫렸던 것과 같은 계열의 실수다.)
 */
/**
 * `/api/tools` **밖**에 있지만 **한 도구 화면만** 쓰는 전용 엔드포인트(v2.506 검증 반영).
 *
 * v2.506 초판은 이 둘을 `ENFORCE_OTHER_ROUTER`("각자 requirePerm/adminOnly 로 보호됨")로 적어
 * 뒀는데, 실제로 열어 보니 **둘 다 기능 권한 게이트가 없었다** — `routes/api/searchNotes.js:11`
 * `/search/nl` 과 `routes/api/inventory.js:332` `/top` 은 authMiddleware + requireEnrolled +
 * 데이터 scope(`applyFilters`/`scopedVcenterIds`)만 지난다. 사유가 거짓이면 관리자가 '차단됨' 을
 * 보고 막힌 줄 오인하는 v2.447 의 무음 실패가 그대로 재현된다.
 *
 * 그래서 문구만 고치지 않고 **실제로 막는다**: 두 경로는 각각 한 화면만 쓴다(확인:
 * `/search/nl` → `web/src/views/tools/AiSearch.jsx:55`, `/top` → `web/src/views/Explore.jsx:59`)
 * — 즉 오차단 위험이 없다. 여러 화면이 공유하는 경로(`/datastores` 등)는 여기에 넣지 말 것
 * (`dsusage` 가 그래서 ENFORCE_SHARED 다).
 */
export const TOOL_EXACT_PATHS = Object.freeze({
  '/search/nl': 'aisearch',
  '/top': 'explore',
});

/** 전체 경로 정규화(정확 일치용) — 소문자 + 확장자 제거 + 끝 슬래시 제거. */
const stripPath = (pathname) => {
  const raw = String(pathname || '').split(/[?#]/)[0].toLowerCase().replace(/\/+$/, '');
  return raw.replace(/\.(csv|json|xlsx|xls|txt)$/i, '') || '/';
};
const stripExt = (seg) => String(seg || '').replace(/\.(csv|json|xlsx|xls|txt)$/i, '').toLowerCase();

/**
 * `/ipam.csv?x=1` · `ipam/settings` → 'ipam' · `/report/health` → 'daily-health'.
 * 매핑에 없으면 null(= 검사 안 함 — 오차단 방지. 모듈 머리말 참조).
 * **두 세그먼트 표를 먼저** 본다(최장 접두 우선) — 안 그러면 `/report/*` 가 전부 'report' 로 뭉친다.
 */
export function toolKeyForPath(pathname) {
  const segs = String(pathname || '').replace(/^\/+/, '').split(/[?#]/)[0].split('/').filter(Boolean);
  if (!segs.length) return null;
  if (segs.length >= 2) {
    const two = `${stripExt(segs[0])}/${stripExt(segs[1])}`;
    if (TOOL_PATH2_KEYS[two]) return TOOL_PATH2_KEYS[two];
  }
  return TOOL_PATH_KEYS[stripExt(segs[0])] || null;
}

/**
 * 이 역할이 이 경로를 쓸 수 있는가. 거부면 사유 객체, 허용이면 null.
 * @param {string} role  req.user.role (인증 비활성 환경은 호출부가 대체 역할을 넘긴다)
 * @param {string} pathname  `/tools` 하위 경로(예: '/ipam.csv')
 */
export function toolAccessIssue(role, pathname) {
  if (role === 'admin') return null;
  const key = toolKeyForPath(pathname);
  if (!key) return null;                       // 매핑 없는 경로는 이 게이트의 대상이 아니다
  const denied = roleToolsDenied(role);
  if (!denied.includes(key)) return null;
  return { tool: key, reason: `이 기능(${key})에 대한 접근이 관리자 설정으로 차단되어 있습니다.` };
}

/**
 * `/api/tools` 밖의 전용 엔드포인트용 — 전체 경로(api 마운트 기준)를 정확 일치로 본다.
 * 접두 일치가 아니라 **정확 일치**다: `/top` 은 막되 `/top-something` 은 건드리지 않는다.
 */
export function exactToolAccessIssue(role, pathname) {
  if (role === 'admin') return null;
  const key = TOOL_EXACT_PATHS[stripPath(pathname)];
  if (!key) return null;
  const denied = roleToolsDenied(role);
  if (!denied.includes(key)) return null;
  return { tool: key, reason: `이 기능(${key})에 대한 접근이 관리자 설정으로 차단되어 있습니다.` };
}

/**
 * 도구 게이트 미들웨어 팩토리(v2.506 검증 반영).
 *
 * 예전에는 이 6줄이 `routes/api.js` 안에 **인라인**으로 두 번 들어가 있었다. 그래서 회귀
 * 테스트가 api.js 를 문자열로 grep 하는 수밖에 없었고, 미들웨어 순서가 바뀌거나 두 번째
 * 마운트가 빠져도 테스트는 그대로 통과했다. 팩토리로 빼면 **실제 미들웨어를 express 앱에
 * 마운트해 403 을 확인**할 수 있다(test/audit2506.test.js).
 *
 * @param {object} o
 * @param {(req:any)=>string} o.roleOf  req → 역할. 인증 비활성 환경의 대체 역할 결정은 호출부
 *   (routes/api.js)가 한다 — 이 모듈이 auth/auth.js 를 import 하면 순환이 생긴다.
 * @param {(role:string,pathname:string)=>({tool:string,reason:string}|null)} [o.issueOf]
 *   기본은 `/tools` 하위 경로용 `toolAccessIssue`. 전용 엔드포인트용은 `exactToolAccessIssue`.
 */
export function toolGate({ roleOf, issueOf = toolAccessIssue }) {
  return function toolGateMiddleware(req, res, next) {
    const issue = issueOf(roleOf(req), req.path);
    if (!issue) return next();
    // 403 본문 계약 — 프론트 ErrorBox 가 AccessDenied 로 자동 전환하는 근거(CLAUDE.md 프론트 규칙).
    return res.status(403).json({ error: 'forbidden', requiredPerm: [`tool:${issue.tool}`], reason: issue.reason });
  };
}

/* ──────────────────────────────────────────────────────────────────────────────
 * 집행 커버리지(v2.506) — "왜 이 도구는 서버가 못 막는가" 를 **선언으로 남긴다**
 *
 * 2026-09-13 감사 미해결 #5 는 "UI 도구 78개 vs 서버 매핑 37개 → 41개 미매핑" 이었다.
 * 실제로 확인해 보니 그 41개는 성격이 다르다 — 다수는 `/api/tools/*` 를 **아예 쓰지 않아서**
 * 이 게이트(`api.use('/tools', …)`, routes/api.js:43)의 범위 밖이다. 그 경로들은 각자
 * `requirePerm`/`adminOnly` 로 보호된다(도구 거부목록과는 다른 축).
 *
 * 그래서 이 표는 **가려운 곳을 정직하게 적는 장치**다:
 *  · 전용 엔드포인트가 있으면 매핑해서 실제로 막는다(위 두 표).
 *  · 못 막는 것은 **사유와 함께 선언**한다. 관리자가 '차단됨' 을 보고 막힌 줄 오인하는
 *    무음 실패를 없애는 것이 v2.447 이 이 모듈을 만든 이유이고, 아직 41개에 남아 있었다.
 *  · 선언에도 없고 매핑에도 없는 키가 생기면 **테스트가 깨진다**(test/audit2506.test.js) —
 *    새 도구를 추가하면서 이 구멍을 조용히 넓히지 못하게 한다.
 *
 * 각 사유는 실제 코드를 열어 확인한 것이다(추측 금지 — 틀리면 관리자가 잘못된 판단을 한다).
 */
export const ENFORCE_OTHER_ROUTER = 'other-router';   // /api/tools 밖 라우터 — 그 라우터의 requirePerm/adminOnly 가 보호한다
export const ENFORCE_SHARED = 'shared-endpoint';      // 전용 엔드포인트가 없다 — 분리하면 다른 도구가 같이 막힌다
export const ENFORCE_PARTIAL = 'partial';             // 전용 하위경로만 막힌다(공유 데이터는 계속 나온다)
export const ENFORCE_NO_API = 'no-api';               // 외부 링크이거나 미구현(막을 API 자체가 없다)

/** 도구 키 → [분류, 사유]. 분류는 위 상수. */
export const TOOL_ENFORCEMENT_NOTES = Object.freeze({
  // --- /api/tools 밖 라우터(각자 requirePerm/adminOnly 로 보호됨) ---
  // aisearch·explore 는 v2.506 검증에서 **게이트가 없는 것으로 확인**되어 TOOL_EXACT_PATHS 로
  // 실제 집행 대상이 됐다(위 표 주석) — 여기에 사유를 남기지 않는다(남기면 거짓 선언이 된다).
  'codex-check': [ENFORCE_OTHER_ROUTER, '/api/admin/codex-check(adminOnly)'],
  // ⚠ v2.506 검증 정정: 예전 사유는 '/api/datastores(inv.datastores)' 였는데 `inv:datastores` 는
  //   memoJson **캐시 이름**이고(routes/api/inventory.js:305) 그 라우트에는 requirePerm 이 없다.
  //   데이터 scope(applyFilters+scopeKey)만 걸린다. 게다가 대시보드·콘솔·V3 가 같이 쓰는 공용
  //   경로라 도구 하나 때문에 막을 수 없다 → SHARED 로 정직하게 분류한다.
  'real-os': [ENFORCE_OTHER_ROUTER, '/api/admin/os-scan(adminOnly)'],
  nsx: [ENFORCE_OTHER_ROUTER, '/api/admin/nsx/managers(adminOnly)'],
  powermap: [ENFORCE_OTHER_ROUTER, '/api/insights/power-breakdown(insights 권한)'],
  serveranalysis: [ENFORCE_OTHER_ROUTER, '/api/admin/idrac/* · /api/admin/datacenters(adminOnly)'],
  fleet: [ENFORCE_OTHER_ROUTER, '/api/insights/fleet(insights 권한)'],
  'nic-speed': [ENFORCE_OTHER_ROUTER, '/api/admin/idrac/nic-speed(adminOnly)'],
  'nic-models': [ENFORCE_OTHER_ROUTER, '/api/admin/idrac/nic-models(adminOnly)'],
  topo3d: [ENFORCE_OTHER_ROUTER, '/api/insights/graph(insights 권한)'],
  'capacity-advisor': [ENFORCE_OTHER_ROUTER, '/api/capacity/*(routes/capacity.js:22 capacityRouter.use(adminOnly))'],
  'svcmon-config': [ENFORCE_OTHER_ROUTER, "/api/svcmon/*(v2.506 부터 requirePerm('svcmon'))"],
  'net-traffic': [ENFORCE_OTHER_ROUTER, '/api/admin/net/*(adminOnly)'],
  roomtemp: [ENFORCE_OTHER_ROUTER, '/api/admin/room-temp(adminOnly)'],
  portaldb: [ENFORCE_OTHER_ROUTER, '/api/admin/portal-db(adminOnly)'],
  'mail-diag': [ENFORCE_OTHER_ROUTER, '/api/admin/mail(adminOnly)'],
  'dir-usage': [ENFORCE_OTHER_ROUTER, '/api/admin/dir-usage(adminOnly)'],
  shutdown: [ENFORCE_OTHER_ROUTER, '/api/admin/emergency-stop(adminOnly)'],
  // v2.506 검증 정정: 두 라우터로 갈린다 — 조회/미리보기는 /api/provision/*
  //   (routes/api/provision.js:14 requirePerm('vm.provision')), 잡 생성·저장본 변경은
  //   /api/admin/provision/*(routes/admin/opsSettings.js:158 adminOnly).
  vmprovision: [ENFORCE_OTHER_ROUTER, "/api/provision/*(requirePerm('vm.provision')) · /api/admin/provision/*(adminOnly)"],
  'agent-scans': [ENFORCE_OTHER_ROUTER, '/api/admin/assignments(adminOnly)'],
  'login-fails': [ENFORCE_OTHER_ROUTER, '/api/admin/security/login-fails(adminOnly)'],
  'net-issues': [ENFORCE_OTHER_ROUTER, '/api/admin/security/net-issues(adminOnly)'],

  // --- 전용 엔드포인트가 없다(공유) ---
  dsusage: [ENFORCE_SHARED, '/api/datastores 를 대시보드·콘솔·V3 가 함께 쓴다 — 이 도구 때문에 막으면 그 화면들이 같이 빈다. 하위 /api/admin/datacenters 는 adminOnly 로 보호됨'],
  vcversion: [ENFORCE_SHARED, "/api/tools/solutions 를 'solutions' 도구와 공유 — 분리하면 그 도구가 같이 막힌다"],

  // --- 부분 집행 ---
  'storage-track': [ENFORCE_PARTIAL, "전용 하위경로(/tools/vm-track/ds-*)만 막힌다. 공용 /tools/vm-track 은 'vm-track' 도구 것이라 계속 응답한다"],

  // --- 막을 API 가 없다 ---
  'service-hub': [ENFORCE_NO_API, '외부 포탈 링크(새 탭) — 이 포탈의 API 를 쓰지 않는다'],
  diskadd: [ENFORCE_NO_API, '미구현(준비 중)'],
  backup: [ENFORCE_NO_API, '미구현(준비 중) — 실제 백업은 설정 화면의 settings 권한으로 보호된다'],
  massdeploy: [ENFORCE_NO_API, '미구현(준비 중)'],
});

/** 서버가 실제로 막을 수 있는 도구 키 집합(두 표의 값). */
export function enforcedToolKeys() {
  return new Set([...Object.values(TOOL_PATH_KEYS), ...Object.values(TOOL_PATH2_KEYS), ...Object.values(TOOL_EXACT_PATHS)]);
}

/**
 * UI 도구 키 목록을 받아 집행 커버리지를 판정한다(순수).
 * `undeclared` 가 비어 있지 않으면 **그 도구는 거부해도 서버가 막지 않는데 아무도 그 사실을
 * 모르는 상태**다 — 테스트가 이것을 0 으로 고정한다.
 */
export function toolCoverage(uiKeys = []) {
  const enforced = enforcedToolKeys();
  const out = { enforced: [], partial: [], declared: [], undeclared: [] };
  for (const k of uiKeys) {
    const note = TOOL_ENFORCEMENT_NOTES[k];
    if (note && note[0] === ENFORCE_PARTIAL) { out.partial.push({ key: k, kind: note[0], why: note[1] }); continue; }
    if (enforced.has(k)) { out.enforced.push(k); continue; }
    if (note) { out.declared.push({ key: k, kind: note[0], why: note[1] }); continue; }
    out.undeclared.push(k);
  }
  return out;
}
