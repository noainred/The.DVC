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

/** 경로 정규화 — 쿼리 제거·소문자·끝 슬래시 제거(express 는 대소문자·끝 슬래시를 구분하지 않는다). */
export function normApiPath(url) {
  let p = String(url || '').split('?')[0].split('#')[0].toLowerCase();
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
  '/api/admin/codex-check', '/api/admin/nfs-mounts', '/api/admin/edge-users', '/api/admin/gpu-guest', '/api/admin/gpu-physical',
  '/api/admin/portal-db', '/api/admin/status', '/api/admin/emergency-stop', '/api/admin/net', '/api/admin/dir-usage',
  '/api/admin/os-scan', '/api/admin/idrac/scan-ranges', '/api/admin/report', '/api/admin/logs',
  '/api/auth/ad-config', '/api/upgrade', '/api/tools/credentials', '/api/remote',
  // v2.719(감사 R1-08): /api/tools 아래 보안 화면 — 설정 파일 평문 비밀 개수·탐지 위치(secret-scan)와
  //   전 엣지 주소·토큰 지문·길이(portal-check/tokens). 접두가 /api/admin/security 뿐이라 빠져 있었다.
  '/api/tools/secret-scan', '/api/tools/portal-check/tokens',
  // v2.720(감사 B2-03): 같은 이유(전 법인 엣지 주소·내부 IP)로 — 저장된 엣지 콘솔 로그·노드 상태(edge-log), 엣지 주소·인증서 주체·
  //   응답 조각(link-check), RMA 에이전트 허용 IP·명령 이력(rma), 전 사이트 내부 IP 가 든 HAProxy 관리 블록(relaytopo/render).
  //   데모 계정 화면에서 이 도구들은 403(demoGuest 표지 → 데모 안내)으로 보인다 — 의도다.
  '/api/tools/edge-log', '/api/tools/link-check', '/api/tools/rma', '/api/tools/relaytopo/render',
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
 * 이 요청을 데모 계정에 허용하지 않는 사유(문자열) 또는 null(허용).
 * @param {string} method HTTP 메서드
 * @param {string} originalUrl req.originalUrl
 */
export function demoGuestDenial(method, originalUrl) {
  const m = String(method || 'GET').toUpperCase();
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
