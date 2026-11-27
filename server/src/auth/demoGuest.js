/**
 * auth/demoGuest.js — 데모(mock) 모드의 내장 데모 계정 접근 규칙(v2.716).
 *
 * 사용자 요청: "Mock 모드에서 guest/demo 계정은 설정 제외한 모든 기능 가능하게 해줘" · 선택:
 *   ① 조회 전부 + 안전한 실행만(데모 데이터만 바꾸는 '지금 수집·점검' 류) ② 내장 데모 계정만(u.demo).
 *
 * 규칙
 *  · 대상은 **저장 레코드에 demo 표지가 있는 로컬 계정**이고 **DATA_SOURCE=mock 일 때만**이다 — live 로 바꾸면 예전처럼 viewer 다.
 *  · 요청 문맥의 역할은 'admin' + `demoGuest:true` 다(admin 게이트를 통과해 관리자 화면·도구를 볼 수 있게). 저장 역할은 viewer 그대로이고
 *    superAdmin·설정 소유자가 아니다.
 *  · 그 대신 **이 모듈이 authMiddleware 안에서 모든 요청을 먼저 거른다**(라우트 게이트보다 앞) —
 *    - 조회(GET·HEAD): 허용. 단 설정·계정·비밀·호스트 접근 등 `READ_DENY` 접두는 거부(설정 탭 전체와 실데이터가 섞일 수 있는 경로).
 *    - 그 밖의 메서드: 읽기성 POST(`auditSkipped`)와 `SAFE_ACTIONS`(데모 데이터만 바꾸는 수집·점검)만 허용, 나머지는 전부 거부.
 *      실제 호스트·네트워크에 닿을 수 있는 것(연결 테스트·SSH 배포·스캔·업그레이드·종료·방화벽·원격 명령·통신 점검)은 목록에 넣지 않는다.
 *  · 거부는 403 + `demoGuest:true` + 사유(화면의 공용 오류 표시가 권한 안내로 그린다).
 *  · WS SSH/RDP 게이트웨이는 미들웨어를 타지 않으므로 그쪽에서 `demoGuest` 를 따로 거부한다.
 */
import { auditSkipped } from '../audit.js';

/**
 * 경로 정규화 — 쿼리 제거·소문자·겹친 빗금 합치기·끝 슬래시 제거(express 는 대소문자·끝 슬래시를 구분하지 않고 겹친 빗금도 같은 라우트로 보낸다).
 * 보안 잔여 11-27 L7(반증 M-1 — 재현)도 같은 두 우회(절대형 요청 대상 · 겹친 빗금)를 찾았다 — main 의 디버깅 2 · 3회차 수정과 겹쳐 그 구현을 쓴다
 *   (L7 시험 secResidual1127DemoLogs 의 원시 소켓 6종이 이 판정을 지난다). 점 세그먼트('.' · '..')는 풀지 않는다 — express 도 풀지 않으며, 풀면 '/users/..' 가
 *   '/api/admin' 으로 보여 :id 라우트에 닿는 요청을 열어 준다.
 */
export function normApiPath(url) {
  // 겹친 빗금은 하나로 — express 는 ‘/api/admin//bm-power’ 를 ‘/bm-power’ 라우트로 보낸다(디버깅 2회차 보안 #1: 데모 차단 목록 우회). 선형 치환
  // 절대 꼴 요청 대상(GET http://h/api/admin/users — express 는 pathname 으로 라우팅한다)도 경로만 본다(디버깅 3회차 보안 #1). 앵커가 있는 선형 치환
  let p = String(url || '').slice(0, 4096).split('?')[0].split('#')[0].toLowerCase().replace(/^[a-z][a-z0-9+.-]{0,15}:\/\/[^/]*/, '').replace(/\/{2,}/g, '/');
  if (!p.startsWith('/')) p = `/${p}`;
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/** 조회도 막는 경로 접두(/api 기준). 설정 화면 전용·계정·비밀·감사·호스트 정보. */
export const READ_DENY = [
  '/api/admin/users', '/api/admin/permissions', '/api/admin/audit', '/api/admin/api-keys', '/api/admin/backup',
  '/api/admin/host-access', '/api/admin/security', '/api/admin/secrets', '/api/admin/central-token',
  '/api/admin/central/agent-tokens', '/api/admin/agent-deploy', '/api/admin/collectors', '/api/admin/vcenters',
  '/api/admin/nsx', '/api/admin/horizon', '/api/admin/mail', '/api/admin/alerts', '/api/admin/llm-config',
  '/api/admin/packages', '/api/admin/data-source', '/api/admin/log-analysis', '/api/admin/perf', '/api/admin/memtrack',
  '/api/admin/codex-check', '/api/admin/login-history', '/api/admin/usage', '/api/admin/nfs-mounts', '/api/admin/edge-users', '/api/admin/gpu-guest', '/api/admin/gpu-physical',
  '/api/admin/portal-db', '/api/admin/status', '/api/admin/emergency-stop', '/api/admin/net', '/api/admin/dir-usage',
  '/api/admin/os-scan', '/api/admin/idrac/scan-ranges', '/api/admin/veeam', '/api/admin/report', '/api/admin/logs',
  '/api/auth/ad-config', '/api/upgrade', '/api/tools/credentials', '/api/remote',
  // v3.45: 물리서버 자산 원장(서비스 태그 · 계약 번호 · 올린 사람) · 펌웨어 기준(지정한 사람) — 전체 범위 관리자의 관리 화면이다
  '/api/admin/bm-assets', '/api/admin/bm-assets.csv', '/api/admin/bm-fw-baseline',
  '/api/admin/bm-advisories', '/api/admin/bm-advisories.csv',   // v3.50 보안 권고 표
  '/api/tools/part-faults/escalation',   // v3.51 알림 단계 · 당직 설정(당직 이름 · 메일 주소 — 반증 A10)
  '/api/admin/bm-power', '/api/admin/bm-events',   // v3.52 원격 전원 스위치 · 이벤트 구독(받은 이벤트 원문 · 구독 결과 · 받는 주소 — 디버깅 1회차 보안 #1)
  // v2.719(감사 R1-08): /api/tools 아래 보안 화면 — 설정 파일 평문 비밀 개수·탐지 위치(secret-scan)와
  //   전 엣지 주소·토큰 지문·길이(portal-check/tokens). 접두가 /api/admin/security 뿐이라 빠져 있었다.
  '/api/tools/secret-scan', '/api/tools/portal-check/tokens',
  // v2.720(감사 B2-03): 같은 이유(전 법인 엣지 주소·내부 IP)로 — 저장된 엣지 콘솔 로그·노드 상태(edge-log), 엣지 주소·인증서 주체·
  //   응답 조각(link-check), RMA 에이전트 허용 IP·명령 이력(rma), 전 사이트 내부 IP 가 든 HAProxy 관리 블록(relaytopo/render).
  //   데모 계정 화면에서 이 도구들은 403(demoGuest 표지 → 데모 안내)으로 보인다 — 의도다.
  '/api/tools/edge-log', '/api/tools/link-check', '/api/tools/svc-status/settings', '/api/tools/rma', '/api/tools/relaytopo/render',
  // v2.743(감사 AUTHZ-01): 데모 계정이 관리자 판본을 받던 설정·등록부 조회 — 가림 헬퍼를 거치지 않는 admin 전용 응답이라 막는다.
  //   CVP 서버 등록부(관리 IP·계정명 — CVP 도구의 '설정' 탭) · SAN 포트 사용량 설정(DB 절대 경로) · vCenter 로그 보관 설정(설정 탭 —
  //   DB 절대 경로) · IP 원장 공유 DB 위치(절대 경로 — operator 도 adminOnly 라 403 이다) · 중앙 자신의 콘솔 로그·상태(edge-log 와 같은
  //   이유 — 등록 장비 주소·계정명이 상태에 실린다. 접두 비교라 위 '/api/tools/edge-log' 가 '-local' 을 덮지 않는다).
  '/api/tools/cvp/servers', '/api/tools/sanswitch/perf/settings', '/api/admin/vclogs', '/api/admin/ipam/db-info',
  '/api/tools/edge-log-local',
  // v2.820: Bareos Director 설정(주소·콘솔 이름)과 Director 카탈로그(실제 Director 에 접속) — 설정 탭.
  '/api/tools/bareos-backup/settings',   // v2.823: 카탈로그·매핑 제안·자동 설정도 /settings/directors/… 아래(옛 /catalog 경로는 없앴다 — 검토 I5)
  // v2.932(점검 D1-02): Monitoring 설정 연동 — 통신 점검(/api/tools/link-check)과 같은 카탈로그(전 시스템 이름·호스트·포트·담당 엣지)를 싣는다.
  '/api/svcmon/settings-sync',
  // 보안 잔여 11-27 L7: 관리자 전용(adminOnly — operator 는 403) 등록부 · 설정 · 실제 출력 조회. operator 판본이 없는 응답이라 데모 계정에
  //   관리자 판본이 그대로 나갔다(카나리 실측 — 사람이 등록한 장비의 주소 · 계정명 · 서비스태그 · 메일 주소). 데모 데이터가 있는 화면
  //   (iDRAC 서버 분석 계열 · 에이전트 작업 · 베어메탈 스토리지)은 막지 않고 데모(mock-) 항목만 싣는다(demoRegistryView · 각 라우트).
  '/api/admin/central/token-apply',      // 엣지 토큰 맞추기 작업 — 단계 문구에 수집 서버 URL · 엣지 보고 호스트 · SSH 대상
  '/api/admin/central/inventory', '/api/admin/central/ingest-stats',   // 설정 › 수집 서버 전용 — 위임 인벤토리 vCenter 주소 · 실제 엣지 이름
  '/api/admin/ipam/scan',                // IP 능동 스캔 설정 · 대역 · 결과 · 로그 · 일정 · 서버 OS 제안(BMC 주소 · 서비스태그) — 데모 시드 없음
  '/api/admin/ipam/settings', '/api/admin/ipam/changes', '/api/admin/ipam/report',   // IP 분류 대역 설정 · 스캔 변화 · 스캔 보고서(실제 스캔 IP)
  // iDRAC 스캔 결과 · 로그 · 작업(설정 › 스캔 로그 · 스캔 작업 — 실제 스캔 IP · 서비스태그 · 엣지 이름). 접두 비교라 'scan-' 하나로 묶을 수 없다.
  '/api/admin/idrac/scan-result', '/api/admin/idrac/scan-agents', '/api/admin/idrac/scan-log', '/api/admin/idrac/scan-jobs', '/api/admin/idrac/scan-job-log',
  '/api/tools/server-info', '/api/tools/server-cmd',   // 운영 작업 — 사람이 등록한 서버 주소와 **실제 명령 출력**(데모 시드 없음)
  // 서버 접속 온보딩 관리(키 지문 · 공개키 · 공통 계정 이름 · 배포 행의 키 · 자격 참조) — 데모 시드 없음
  '/api/tools/bm-usage/ssh-keys', '/api/tools/bm-usage/accounts', '/api/tools/bm-usage/onboard/edge-rows',
  '/api/settings/ssh-access',            // 설정 › 보안 › 서버 접속 — 소유자 게이트로 이미 403 이지만 '설정 화면 API 접두는 READ_DENY 에도'(demo.md)
  '/api/tools/storage-usage/mail',       // 스토리지 사용량 보고서 메일 설정 — 받는 사람 원문 · 통합 관리자 주소(반증 M-2 — /api/admin/mail 의 형제 우회로)
  // 반증 1회차 M-1(재현): 백업 실행 '설정' 탭 — B&R 서버 주소 · 담당 엣지 · vCenter 접속 주소(/api/admin/veeam 의 형제 우회로 · v2.743 CVP 선례).
  //   같은 도구의 VM 목록 · 실행 기록은 막지 않고 데모(mock-) 서버만 싣는다(routes/api/backupRun.js serversFor · runShownTo).
  '/api/tools/backup-run/settings',
];

/** v2.720(감사 R1-03·R1-06): 데모 계정이 사람이 등록한(비-mock) 장비를 수집하려 할 때 라우트·폴러가 함께 쓰는 문구. */
export const DEMO_ONLY_REASON = '데모 계정은 데모(mock) 장비만 수집합니다 — 사람이 등록한 장비에는 접속하지 않습니다.';

/**
 * v2.719(감사 R1-02): 조회(GET·HEAD)인데 **실제 호스트·네트워크에 접속하는** 경로. 데모 계정은 요청 문맥이 admin·전체 범위라
 * 라우트 게이트를 통과하므로 여기서 막는다(머리말 규칙 '실제 호스트에 닿는 실행은 막는다' 의 GET 판).
 *   · relay-test: 임의 host:port 로 TCP·TLS·HTTP(내부망 포트 탐색) · gpu-probe: 저장 iDRAC 계정으로 Redfish 로그인
 *   · inventory?refresh=1 · sensors?live=1: 같은 화면의 캐시 조회는 열어 두고 즉시 수집 질의만 막는다
 *   · network-check: 등록된 vCenter·NSX 주소로 TCP 프로브
 * 질의값은 하나라도 걸리면 거부한다(같은 키 반복·인코딩 '%31' 도 디코드해 본다 — 라우트보다 넓게).
 * 새 '실접속 GET' 을 만들면 여기에 더할 것 — server/test/audit2719b.test.js 가 라우터 스택에서 이 목록을 대조한다.
 */
export const LIVE_GET_DENY = [
  { path: '/api/admin/vcenter/relay-test' },
  { path: '/api/admin/idrac/:id/gpu-probe' },
  { path: '/api/admin/idrac/:id/inventory', query: ['refresh', '1'] },
  { path: '/api/admin/idrac/:id/sensors', query: ['live', '1'] },
  { path: '/api/tools/network-check' },
];

const LIVE_RE = LIVE_GET_DENY.map((d) => ({
  re: new RegExp(`^${d.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:id/g, '[^/]+')}$`),
  query: d.query || null,
}));

function liveGetDenied(p, originalUrl) {
  const hit = LIVE_RE.filter((x) => x.re.test(p));
  if (!hit.length) return false;
  let qs = null;
  for (const h of hit) {
    if (!h.query) return true;
    if (!qs) {
      const raw = String(originalUrl || '').split('#')[0];
      const i = raw.indexOf('?');
      try { qs = new URLSearchParams(i >= 0 ? raw.slice(i + 1) : ''); } catch { return true; }
    }
    if (qs.getAll(h.query[0]).some((v) => String(v).trim() === h.query[1])) return true;
  }
  return false;
}

/** 데모 계정에 허용하는 실행(상태 변경) — 전부 데모(mock) 데이터만 다시 만들거나 판정한다. `:id` 는 한 세그먼트. */
export const SAFE_ACTIONS = [
  'POST /api/auth/logout', 'POST /api/auth/extend',
  'POST /api/tools/storage/collect-all', 'POST /api/tools/storage/devices/:id/collect',
  'POST /api/tools/sanswitch/collect-all', 'POST /api/tools/sanswitch/devices/:id/collect', 'POST /api/tools/sanswitch/perf/collect',
  'POST /api/tools/pdu/collect-all', 'POST /api/tools/pdu/devices/:id/collect',
  'POST /api/tools/cvp/collect', 'POST /api/tools/cvp/faults/scan',
  'POST /api/tools/part-faults/scan', 'POST /api/tools/portal-check/arch/run',
  'POST /api/tools/bm-usage/collect', 'POST /api/tools/bm-storage/collect', 'POST /api/tools/curuser/collect',
  'POST /api/tools/horizon-sessions/collect', 'POST /api/tools/guest-disk/run', 'POST /api/tools/vmseries/run',
  'POST /api/tools/waste/off-check/run',
];

const SAFE_RE = SAFE_ACTIONS.map((s) => {
  const [m, p] = s.split(' ');
  const re = new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:id/g, '[^/]+')}$`);
  return { m, re };
});

/** 데모 계정 요청인가 — 요청 문맥(resolveTokenUser 반환)의 표지. */
export function isDemoGuest(user) {
  return !!user?.demoGuest;
}

/**
 * v2.743(감사 AUTHZ-01): **관리자 판본**(관리 주소·장비 계정명·서버 절대 경로를 가리지 않은 응답)을 받을 사용자인가.
 * 데모 계정은 요청 문맥이 role 'admin' 이라(admin 게이트를 통과해 화면을 보게 하려는 것) `role === 'admin'` 만 보던
 * 가림 판정(addressMask.isAdminReq · scopeStatus.scopeDbStatus·scopeFilePaths·redactPushStatus)을 그대로 통과해
 * operator·viewer 보다 넓게 봤다(사람이 등록한 장비의 관리 IP·계정명, DB 절대 경로). 데모 계정은 **operator 와 같은 가림
 * 판본**을 받는다 — 조회 자체(v2.716 '조회 전부')는 그대로이고 가린 칸은 각 헬퍼가 표식·빈 칸으로 둔다.
 * 판정은 이 함수 하나다(가림 헬퍼가 각자 demoGuest 를 보지 않게).
 */
export function isAdminDetailUser(user) {
  return user?.role === 'admin' && !isDemoGuest(user);
}

/**
 * 보안 잔여 11-27 L7(반증 1회차 S-2): 데모 계정에는 **포탈 계정 이름**(저장한 · 요청한 · 만든 사람)을 싣지 않는다 — v2.901 savedBy 가림과 같은 규칙을
 *   관리자 전용 도구의 실행 · 작업 기록(by · user · createdBy …)에도. 사람 관리자가 데모 장비로 돌린 작업의 기록에 그 계정 이름이 남는다.
 *   빈 글자로 바꾼다(키는 남긴다 — 화면은 '—'). 판정은 isDemoGuest 하나 — operator 등 다른 역할의 응답은 바꾸지 않는다.
 *   'by' · 'user' 는 다른 뜻(묶는 기준 · 질의 반향)으로도 쓰이는 이름이라 **그 응답에서 계정 이름임을 확인한 라우트에만** 건다(전역 응답 필터로 쓰지 않는다).
 *   일반 객체 · 배열만 따라 내려간다(Date 등은 그대로 — JSON 직렬화 모양을 바꾸지 않는다). 원본은 바꾸지 않는다(캐시 · 메모리 기록 공유).
 */
export const ACCOUNT_KEYS = Object.freeze(['by', 'user', 'savedBy', 'createdBy', 'updatedBy', 'deletedBy']);
export function demoAccountView(user, value, keys = ACCOUNT_KEYS) {
  if (!isDemoGuest(user)) return value;
  const ks = new Set(keys);
  const plain = (v) => { const p = Object.getPrototypeOf(v); return p === Object.prototype || p === null; };
  const walk = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    if (!plain(v)) return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = ks.has(k) && typeof x === 'string' ? '' : walk(x);
    return out;
  };
  return walk(value);
}

/**
 * 보안 잔여 11-27 L7(반증 4회차 must — 재현): 메일 발송 상태 · 기록의 **자유 글자**(사유 · 비고 · 오류 메시지)는 메일 서버 응답 원문이다 —
 *   SMTP 서버 주소(util/smtp.js 'SMTP 접속 실패(host:port)') · 배너 · 받는 사람이 실리고, 그 원본 설정(/api/admin/mail)은 데모에게 READ_DENY 다.
 *   주소 꼴만 지우는 정규식 가림(edgelog/redact.js)은 IP · 호스트 이름 · 배너를 놓쳤다. 데모 판본은 그 칸의 글자를 고정 문구로 바꾸고
 *   구조(상태 · 개수 · 시각 · code)는 남긴다. 판정은 isDemoGuest 하나. 일반 객체 · 배열만 따라 내려가고 원본은 바꾸지 않는다(캐시 · 메모리 상태 공유).
 */
export const DEMO_MAIL_TEXT = '(데모 계정에는 메일 서버 응답 원문을 보이지 않습니다)';
export const MAIL_TEXT_KEYS = Object.freeze(['reason', 'note', 'message', 'error', 'lastError', 'lastReason', 'detail']);
export function demoMailText(value, keys = MAIL_TEXT_KEYS) {
  const ks = new Set(keys);
  const plain = (v) => { const pr = Object.getPrototypeOf(v); return pr === Object.prototype || pr === null; };
  const walk = (v, d) => {
    if (v === null || typeof v !== 'object' || d > 12) return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, d + 1));
    if (!plain(v)) return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = ks.has(k) && typeof x === 'string' && x ? DEMO_MAIL_TEXT : walk(x, d + 1);
    return out;
  };
  return walk(value, 0);
}
/** demoMailText 를 데모 계정에만 — 메일 발송 상태를 싣는 adminOnly 조회가 응답 직전에 부른다(관리자 · operator 판본은 그대로). */
export function demoMailTextView(user, value, keys = MAIL_TEXT_KEYS) {
  return isDemoGuest(user) ? demoMailText(value, keys) : value;
}

/** 보안 잔여 11-27 L7: 관리자 API(/api/admin 아래) 요청인가 — normApiPath(READ_DENY 와 같은 정규화 — 절대형 · 겹친 슬래시 포함) 기준. */
export function isAdminApiPath(originalUrl) {
  const p = normApiPath(originalUrl);
  return p === '/api/admin' || p.startsWith('/api/admin/');
}

/**
 * 보안 잔여 11-27 L7: 관리자 API 에서 **데모 판본(데모 mock- 항목만)** 을 줄 요청인가 — 판정 연결은 이 함수 하나.
 *  · 데모 판정은 isDemoGuest(반증 S-1 — '관리자 판본인가'(isAdminDetailUser)와 '데모 판본인가' 는 다른 질문이다. /api/admin 아래에도
 *    adminOnly 가 없는 GET 이 있어 '관리자 판본이 아닌 사용자 = 데모' 가 아니다 — operator 에게 조용히 빈 목록을 주지 않게).
 *  · 경로 조건(/api/admin): iDRAC 범위 판정(idracScopeOf)을 non-admin 라우트(Overview 카드 · 랙 · 디스크 배드 · VM 지표)도 쓴다 — 그쪽은
 *    v2.743 규약대로 데모 = operator 판본이고, 캐시 열쇠에 데모 축도 없다. 그래서 adminOnly 인 /api/admin 아래에서만 데모 판본을 건다.
 *  · 사용자 없는 요청 · originalUrl 없는 직접 호출은 아니다(역할 게이트가 먼저 거르고, 인증 꺼짐 익명은 데모가 아니다).
 */
export function demoRegistryView(req) {
  return !!req?.user && isDemoGuest(req.user) && isAdminApiPath(req?.originalUrl || '');
}

/**
 * 이 요청을 데모 계정에 허용하지 않는 사유(문자열) 또는 null(허용).
 * @param {string} method HTTP 메서드
 * @param {string} originalUrl req.originalUrl
 */
export function demoGuestDenial(method, originalUrl) {
  const m = String(method || 'GET').toUpperCase();
  // 데모 계정은 평범한 꼴(‘/’ 로 시작 · 백슬래시 없음 · ‘//’ 로 시작하지 않음 · 4KB 이하)의 요청 주소만 — express 의 경로 해석(옛 url.parse: 절대 꼴 · \ → /)을
  //   흉내 내지 않고 이상한 꼴은 통째로 거절한다(긴 scheme · 4KB 넘는 authority · 백슬래시로 차단 목록을 비켜 갔다 — 디버깅 4회차 보안 #1)
  const raw = String(originalUrl ?? '');
  if (raw.length > 4096 || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '데모 계정은 이 꼴의 요청 주소를 쓸 수 없습니다.';
  const p = normApiPath(originalUrl);
  const denied = READ_DENY.some((d) => p === d || p.startsWith(`${d}/`));
  if (m === 'GET' || m === 'HEAD') {
    if (denied) return '데모 계정은 설정·계정·보안 화면을 볼 수 없습니다.';
    return liveGetDenied(p, originalUrl) ? '데모 계정은 실제 장비·네트워크에 접속하는 조회(연결 확인·즉시 수집·프로브)를 할 수 없습니다.' : null;
  }
  if (denied) return '데모 계정은 설정을 바꿀 수 없습니다.';
  if (auditSkipped(m, p)) return null;
  if (SAFE_RE.some((s) => s.m === m && s.re.test(p))) return null;
  return '데모 계정은 조회와 데모 데이터 수집·점검만 할 수 있습니다(설정 변경·연결 테스트·배포·스캔·원격 명령은 막혀 있습니다).';
}

/** authMiddleware 안에서 부른다 — 거부면 응답을 보내고 true. */
export function denyDemoGuest(req, res) {
  if (!isDemoGuest(req.user)) return false;
  const reason = demoGuestDenial(req.method, req.originalUrl || req.url);
  if (!reason) return false;
  res.status(403).json({ error: 'forbidden', demoGuest: true, reason });
  return true;
}
