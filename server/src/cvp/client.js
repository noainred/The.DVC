/**
 * cvp/client.js — CloudVision(CVP) 한 대에 로그인해 장비 정보를 읽는다(v2.608).
 *
 * ⚠⚠ 정직 기록 — **실장비 CVP 로 확인한 경로가 하나도 없다**(이 환경에 CVP 가 없다). 아래 경로·필드는 전부 추정이고
 *   그래서 **후보 체인**이다: 항목마다 경로 후보를 차례로 시도해 "2xx + 파서가 원하는 것을 읽었다" 일 때만 성공으로 본다
 *   (v2.545 '성공 조건은 오류가 없다가 아니라 원하는 것을 읽었다'). 무엇을 썼는지(`usedPaths`)·무엇을 못 읽었는지(`missing`)·
 *   응답에 어떤 필드가 있었는지(`seenFields`)를 결과에 싣는다 — 첫 실수집에서 그 셋을 보고 후보를 좁힐 것(docs/CVP.md).
 *
 * 인증: token → `Authorization: Bearer <token>` · password → `POST /cvpservice/login/authenticate.do`
 *   `{userId,password}` → 응답 쿠키 `access_token`(Set-Cookie) 또는 본문 `sessionId`/`cookie` → 이후 `Cookie: access_token=…`.
 *   끝나면 logout(실패 무시). **로그인(또는 토큰 모드의 첫 조회) 401/403 만 자격증명 거부**로 본다(`err.authFailed`) —
 *   장비별 텔레메트리 경로의 403 은 RBAC 거부일 수 있어 'forbidden' 사유로만 남긴다(주기 수집을 멈추지 않는다).
 *
 * 보안: undici Agent 는 `withSsrfLookup`(DNS 리바인딩 차단 — v2.537 스윕), verifyTls=false 면 **로컬** dispatcher 로만
 *   rejectUnauthorized:false(전역 금지). 모든 요청에 signal(호출자 시한이 세션을 실제로 끊는다 — v2.417).
 *   응답 본문은 상한(기본 8MB) 스트림 읽기 — 넘으면 그 항목만 실패로 기록한다(v2.583 readCapped).
 *
 * 예산(v2.528 규약): 장비별 조회가 장비 수 × 경로 수라 느린 회선에서 시한을 넘기기 쉽다. ① 세션 예산(`budgetMs` —
 *   폴러의 CVP 시한보다 작게) 안에서만 새 장비를 시작하고, 남은 시간이 모자라면 **시작하지 않고** `notTried` 로 밝힌다
 *   ② 한 종류가 처음 3대에서 연속 실패하면 그 주기의 나머지 장비는 그 종류를 시도하지 않는다(`missing` 이 사유를 말한다)
 *   ③ 성공한 후보를 CVP 별로 기억해 다음 주기 첫 시도로 쓴다(`prefer`).
 */
import { Agent } from 'undici';
import { withSsrfLookup } from '../util/ssrfLookup.js';
import { readTextCapped } from '../util/readCapped.js';
import { readBodyPrefix } from '../util/readPrefix.js';
import { capStr } from '../util/capStr.js';
import { reqTimeoutMs } from '../agent/envTimeout.js';
import { poolSettled } from '../util/pool.js';
import { pushAll } from '../util/pushAll.js';
import { baseUrlOf } from './registry.js';
import * as P from './parse.js';

const dispVerify = new Agent({ connect: withSsrfLookup({}) });
const dispNoVerify = new Agent({ connect: withSsrfLookup({ rejectUnauthorized: false }) });
const REQ_TIMEOUT_MS = reqTimeoutMs(process.env.CVP_HTTP_TIMEOUT_MS, 30_000);
export const BODY_MAX_BYTES = Math.max(1_048_576, Number(process.env.CVP_BODY_MAX_BYTES) || 8 * 1_048_576);
const DEVICE_CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.CVP_DEVICE_CONCURRENCY) || 6));
const FAIL_STREAK_STOP = 3;
/**
 * v2.641 — 포인터 추종(텔레메트리 컬렉션 노드는 하위 개체를 포인터로 준다 — 실장비는 `{ptr:[조각…]}` 배열, v2.642 · parse.telemetryShape).
 *   장비당·종류당 요청 상한(FOLLOW_REQ_MAX)과 장비 안 동시성(FOLLOW_CONCURRENCY)을 둔다 — 포트 52개 장비 173대면 한 주기
 *   약 9천 GET 이라 CVP 부하가 실재한다. 상한에 걸리면 `followTruncated` 로 밝힌다(조용한 상한 금지).
 *   하위 목록(포인터)은 장비별로 CHILD_CACHE_MS 동안 기억해 컬렉션 GET 을 매 주기 반복하지 않는다(포트 구성은 드물게 바뀐다).
 */
export const FOLLOW_REQ_MAX = Math.max(16, Math.min(1024, Number(process.env.CVP_FOLLOW_MAX) || 160));
const FOLLOW_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.CVP_FOLLOW_CONCURRENCY) || 4));
const FOLLOW_DEPTH = 3;
/**
 * v2.643(실장비 캡처 — '포인터 추종 상한·시간 예산으로 32,406개 하위 개체를 읽지 못했습니다'): 종류마다 **필요한 깊이까지만** 따라간다.
 *   포트는 intfStatus/Ethernet1 **한 단계**에 필드가 있는데(v2.642 실장비 확인) 그 아래 포인터까지 세 단계를 내려가며 장비당
 *   요청 상한(FOLLOW_REQ_MAX)을 먹고, 뒤에 읽을 PSU·온도가 시간 예산을 잃었다. BGP 는 표 → VRF → 피어라 두 단계,
 *   부품은 컨테이너(powerSupply) → 부품(PowerSupply1) 두 단계다. 이 깊이를 넘는 포인터는 **읽을 대상이 아니므로 '못 읽음' 으로
 *   세지 않는다**(상한·예산 때문에 못 읽은 것만 센다 — 예전에는 마지막 깊이에서 남은 포인터를 전부 '못 읽음' 에 더했다).
 *   ⚠ 부품 깊이 2 는 추정이다 — 트랜시버(xcvr) 목록이 그보다 깊으면 안 나온다(정직 기록).
 */
// v2.644: counters 2(`…/current` 아래에 `statistics` 같은 포인터가 한 단계 더 있을 수 있다) · bgp 3(실장비: 표 → VRF(default·Private) →
//   피어 → 그 피어의 값 — 캡처에서 VRF 아래 피어가 또 포인터였다. 깊이 2 에서는 이름·VRF 만 남아 '형식을 읽지 못했습니다' 였다).
export const FOLLOW_DEPTH_BY_KIND = Object.freeze({ interfaces: 1, intfConfig: 1, counters: 2, memory: 1, cpu: 2, bgp: 3, power: 2, cooling: 2, temperature: 2, xcvr: 3 });
/*
 * v2.646(사용자 신고 'xcvr 이 여전히 나오지 않는다' — 캡처: `all › Ethernet1` 등 전부 '상태 미확인'): 트랜시버 노드는 **장착 여부만** 주고
 *   건강 상태 필드가 없다. `show interfaces transceiver` 가 보여 주는 DOM(온도·전압·바이어스·Tx/Rx 광량)은 그 노드 **한 단계 아래**
 *   (domInfo 로 추정 — ⚠ 실장비로 확인하지 못했다)에 있을 것으로 보고 xcvr 만 한 단계 더 따라간다. 단 그 단계에서는 **이름이 dom 을
 *   포함하는 포인터만** 따라간다(다른 하위 포인터까지 따라가면 포트 52개 장비에서 요청이 수배로 늘어난다).
 */
export const XCVR_DOM_KEY = /dom/i;
function followChild(kind, depth, key) {
  if (kind === 'xcvr' && depth >= 1) return XCVR_DOM_KEY.test(String(key || ''));
  return true;
}
/** 빈 응답(`{"notifications":[]}`) — 경로는 열려 있지만 그 노드에 값이 없다(v2.641 실장비 확인). */
export const EMPTY_REASON = '경로에 데이터 없음(빈 응답 — 이 장비에 그 값이 없거나 경로가 다릅니다)';
export const UNREAD_REASON = '응답은 왔지만 형식을 읽지 못했습니다';
const MIN_SLICE_MS = 5_000;
/**
 * v2.640 — 원문 표본(samples). 실장비 CVP 응답을 본 적이 없으므로(머리말) 첫 실수집에서 후보를 좁힐 **근거**를 남긴다:
 *   종류마다 처음 성공한 응답의 앞 SAMPLE_HEAD_CHARS 자, 성공이 없으면 마지막 실패 응답의 앞 SAMPLE_FAIL_BYTES 바이트.
 *   실패 본문도 읽는 이유 — 404/403 의 오류 JSON(`errorCode`·`errorMessage`)이 '경로가 없다' 와 'RBAC 거부' 를 가르는 근거다
 *   (예전에는 cancel 만 해서 상태 코드 하나만 남았다). 본문 앞부분만 읽고 스트림을 끊는다(readBodyPrefix — 상한을 넘어도 던지지 않는다).
 */
export const SAMPLE_HEAD_CHARS = 4096;
export const SAMPLE_FAIL_BYTES = 2048;
const RE_HEADER = /^[\t\x20-\x7e]*$/; // eslint-disable-line no-control-regex

/** 경로 후보(추정 — docs/CVP.md). `{serial}` 은 장비 키로 치환된다. */
export const CANDIDATES = Object.freeze({
  inventory: ['/api/resources/inventory/v1/Device/all', '/cvpservice/inventory/devices'],
  cvpVersion: ['/cvpservice/cvpInfo/getCvpInfo.do'],
  // v2.641: 실장비(CVP 2023.1.1)에서 `…/intfStatus/all`·`…/FastCounters/current` 는 **빈 응답**이었다(사용자 캡처). 컬렉션 노드
  //   (`…/intfStatus` · `…/current/counter`)를 먼저 읽고 포인터를 따라간다(followPtrs). 옛 후보는 뒤에 남긴다(다른 버전 대비).
  interfaces: ['/api/v1/rest/{serial}/Sysdb/interface/status/eth/phy/slice/1/intfStatus', '/api/v1/rest/{serial}/Sysdb/interface/status/eth/phy/slice/1/intfStatus/all'],
  // v2.649: 포트 설명(description)은 상태 노드가 아니라 설정 노드에 있다(EOS Sysdb 관용 — ⚠ 실장비 미확인 추정, 경로 탐색 표본이 확인한다).
  //   설명은 자주 바뀌지 않으므로 부품 주기(partsDue — 기본 30분)에만 읽는다(포트당 GET 1회 — followPtrs).
  intfConfig: ['/api/v1/rest/{serial}/Sysdb/interface/config/eth/phy/slice/1/intfConfig', '/api/v1/rest/{serial}/Sysdb/interface/config/eth/phy/slice/1/intfConfig/all'],
  /*
   * v2.641 실장비 확인(사용자 Telemetry Browser 캡처, L2 7010TX): `/Smash/counters/ethIntf` 는 **No data** 였다. 카운터는 Sysdb 쪽
   *   `…/intfCounterDir/<포트>/intfCounter/current` 로 추정한다(⚠ 이 경로 자체는 아직 확인하지 못했다 — 경로 탐색 표본이 확인한다).
   *   `@/intfCounter/current` 접미는 '컬렉션의 각 포인터 키 뒤에 이 접미를 붙여 바로 읽는다' 는 표시다(포트당 1회 — followPtrs).
   */
  counters: ['/api/v1/rest/{serial}/Sysdb/interface/counter/eth/phy/slice/1/intfCounterDir@/intfCounter/current',
    '/api/v1/rest/{serial}/Smash/counters/ethIntf/FastCounters/current/counter', '/api/v1/rest/{serial}/Smash/counters/ethIntf/FastCounters/current',
    // v2.644: 실장비(DCS-7010TX · EOS 4.28 · CVP 2023.1.1)에서 위 셋이 **전부 빈 응답**이었다(사용자 캡처 — 80대). 카운터 에이전트
    //   디렉터리 이름은 플랫폼마다 다르다(추정) — `/Smash/counters/ethIntf` 의 자식을 차례로 시도한다(와일드카드).
    '/api/v1/rest/{serial}/Smash/counters/ethIntf/*/current/counter',
    '/api/v1/rest/{serial}/Smash/counters/ethIntf/*/current'],
  // v2.641 실장비 확인: `/Sysdb/routing/bgp/export` 의 자식은 `config`·`vrfBgpPeerAfiSafiStateTable` 둘뿐이었다 — v2.608 의
  //   `vrfBgpPeerInfoStatusEntryTable` 은 **없는 이름**이었다. 새 표에 세션 상태가 있는지는 아직 확인하지 못했다(없으면 형식 미인식으로 남는다).
  bgp: ['/api/v1/rest/{serial}/Sysdb/routing/bgp/export/vrfBgpPeerAfiSafiStateTable', '/api/v1/rest/{serial}/Sysdb/routing/bgp/export/vrfBgpPeerInfoStatusEntryTable'],
  // v2.641 실장비 확인: `/Sysdb/environment` 의 자식은 archer·cooling·power·temperature·thermostat(전부 포인터). 그 아래 모양은 미확인 —
  //   노드 자체에서 포인터를 따라가고, 옛 `…/status` 와 `archer` 아래 후보를 뒤에 둔다.
  power: ['/api/v1/rest/{serial}/Sysdb/environment/power/status', '/api/v1/rest/{serial}/Sysdb/environment/archer/power/status', '/api/v1/rest/{serial}/Sysdb/environment/power'],
  cooling: ['/api/v1/rest/{serial}/Sysdb/environment/cooling/status', '/api/v1/rest/{serial}/Sysdb/environment/archer/cooling/status', '/api/v1/rest/{serial}/Sysdb/environment/cooling'],
  temperature: ['/api/v1/rest/{serial}/Sysdb/environment/temperature/status', '/api/v1/rest/{serial}/Sysdb/environment/archer/temperature/status', '/api/v1/rest/{serial}/Sysdb/environment/temperature'],
  xcvr: ['/api/v1/rest/{serial}/Sysdb/hardware/archer/xcvr/status'],
  /*
   * v2.641 — 추가 항목. ⚠ 텔레메트리 경로는 여전히 추정이다(실장비에서 확인한 것은 '빈 응답이 온다' 뿐 — 위 머리말).
   *   레거시 인벤토리(`/cvpservice/inventory/devices`)의 필드는 Arista 가 관리하는 cvprac(cvp_api.py get_inventory)이 쓰는 이름으로 확인했다
   *   (ipAddress·bootupTimestamp·status·mlagEnabled·parentContainerKey). Resource API(lifecycle·bugexposure·event)의 필드는
   *   aristanetworks/cloudvision-apis 의 proto(lifecycle.v1·bugexposure.v1·event.v1)에서 확인했다 — **CVP 2023.1.1 에 그 경로가 있는지는
   *   확인하지 못했다**(없으면 404 가 사유로 남는다).
   */
  enrich: ['/cvpservice/inventory/devices?provisioned=true', '/cvpservice/inventory/devices'],
  lifecycle: ['/api/resources/lifecycle/v1/DeviceLifecycleSummary/all'],
  bugs: ['/api/resources/bugexposure/v1/BugExposure/all'],
  events: ['/api/resources/event/v1/Event/all'],
  // v2.641 실장비 확인: `/Kernel/proc` 자식은 cpu·meminfo·stat(포인터). `/Kernel/proc/cpu` 에서 포인터를 따라간다(그 아래 모양은 미확인).
  // v2.642: `/Kernel/proc/stat` 는 이 장비에서 **프로세스(PID) 별** 표였다(키가 1·1022·1550… — 사용자 캡처). 시스템 CPU 가 아니므로
  //   후보에서 뺐다(따라가면 PID 수백 개를 조회한다).
  cpu: ['/api/v1/rest/{serial}/Kernel/proc/cpu/utilization/total', '/api/v1/rest/{serial}/Kernel/proc/cpu'],
  memory: ['/api/v1/rest/{serial}/Kernel/proc/meminfo'],
});
/** v2.641: CVP 단위(장비별이 아닌) 추가 항목 — 한 주기에 CVP 당 요청 1회씩. */
export const CVP_WIDE_KINDS = Object.freeze(['enrich', 'lifecycle', 'bugs', 'events']);
/**
 * v2.641 — 텔레메트리 경로 탐색 표본(probes). 실장비 CVP 2023.1.1 에서 v2.608 추정 경로가 전부 빈 응답이었다 — 어디에 값이 있는지
 *   알아야 후보를 고칠 수 있다. 부품 주기(30분)마다 **CVP 당 장비 1대**에 대해 아래 경로를 GET 해 응답 앞부분(PROBE_HEAD_CHARS)과
 *   모양(빈 응답·포인터 수·update 수)을 상태에 싣는다. 장비 접속이 아니라 CVP 조회이고, 1대 × 경로 수라 부하가 작다.
 *   관리자만 본다(원문 표본과 같은 취급 — 관리 IP 가 들어 있을 수 있다).
 */
export const PROBE_PATHS = Object.freeze([
  '', '/Sysdb', '/Smash', '/Kernel',
  '/Sysdb/interface/status/eth/phy/slice/1/intfStatus',
  '/Sysdb/interface/status/eth/phy/slice/1/intfStatus/Ethernet1',
  '/Sysdb/interface/config/eth/phy/slice/1/intfConfig/Ethernet1',
  '/Sysdb/interface/counter', '/Sysdb/interface/counter/eth/phy/slice/1/intfCounterDir/Ethernet1',
  '/Sysdb/interface/counter/eth/phy/slice/1/intfCounterDir/Ethernet1/intfCounter/current',
  '/Kernel/proc/cpu', '/Kernel/proc/meminfo',
  '/Sysdb/routing/bgp/export/vrfBgpPeerAfiSafiStateTable', '/Sysdb/environment/power', '/Sysdb/environment/archer',
  '/Smash/counters/ethIntf',
  '/Smash/counters/ethIntf/FastCounters/current/counter',
  '/Smash/counters/ethIntf/FastCounters/current/counter/Ethernet1',
  '/Sysdb/environment',
  '/Sysdb/environment/archer/power/status',
  '/Kernel/proc',
  // v2.644: 카운터·BGP 가 빈 응답·형식 미인식이던 장비에서 한 단계 아래 모양을 본다.
  '/Sysdb/interface/counter/eth/phy/slice/1/intfCounterDir',
  '/Sysdb/routing/bgp/export/vrfBgpPeerAfiSafiStateTable/default',
  // v2.648: 모듈형 섀시 — 카드 슬롯별 인터페이스 슬라이스 목록 · 카드 인벤토리 후보(entmib, 추정).
  '/Sysdb/interface/status/eth/phy/slice', '/Sysdb/hardware/entmib',
]);
export const PROBE_HEAD_CHARS = 1536;
export const PROBE_MAX = 34;
/** v2.648: 슬롯 전원 확인 루틴에서 링크 상태를 볼 표본 포트 수(슬롯당). */
export const SLOT_SAMPLE = 8;
/**
 * v2.646: 트랜시버 DOM 경로 탐색 — 그 장비에서 **장착된** 첫 트랜시버의 노드와 그 아래 후보(domInfo)를 본다. 경로를 확인하지 못했으므로
 *   (xcvr 머리말) 첫 실수집의 표본이 근거가 된다. 장착된 트랜시버를 모르면(부품을 못 읽음) 컨테이너 노드만 본다.
 */
export function xcvrProbePaths(parts) {
  const base = '/Sysdb/hardware/archer/xcvr/status/all';
  const out = [base];
  const x = (Array.isArray(parts) ? parts : []).find((p) => p && p.kind === 'xcvr' && p.state !== 'absent' && typeof p.name === 'string');
  if (x) {
    const intf = x.name.split(PART_PATH_SEP).find((seg) => /^[A-Za-z]+[\d/]+$/.test(seg));
    if (intf) out.push(`${base}/${encodeURIComponent(intf)}`, `${base}/${encodeURIComponent(intf)}/domInfo`);
  }
  return out;
}
/** v2.641: 이벤트 응답은 앞부분만 읽는다(전량이 수십 MB 일 수 있다 — 1,900건/일 실측 화면). */
export const EVENTS_BODY_MAX = Math.max(262_144, Number(process.env.CVP_EVENTS_BODY_MAX) || 4 * 1_048_576);
/** 부품 종류 → 표시 kind. */
export const PART_KINDS = Object.freeze({ power: 'psu', cooling: 'fan', temperature: 'temp', xcvr: 'xcvr' });
/** v2.643: 부품 이름의 포인터 경로 구분자(부품 이름에 '/' 가 있어 — Fan1/1 — 다른 기호를 쓴다). */
export const PART_PATH_SEP = ' › ';

export class CvpAuthError extends Error {
  constructor(msg) { super(msg); this.authFailed = true; }
}

/**
 * 요청 하나의 신호. v2.611(TIM2611-01): 건별 시한은 min(REQ_TIMEOUT, 남은 세션 예산) — 30초 요청이 10초 남은 예산을 넘어
 *   CVP 당 시한(withDeadline)에 먼저 걸리면 그 주기 결과가 통째로 조용히 잘렸다(v2.528 '시작해 놓고 잘림').
 */
export const reqMsFor = (leftMs) => {
  const l = typeof leftMs === 'function' ? Number(leftMs()) : NaN;
  return Number.isFinite(l) ? Math.max(1_000, Math.min(REQ_TIMEOUT_MS, l)) : REQ_TIMEOUT_MS;
};
const sig = (outer, leftMs) => {
  const t = AbortSignal.timeout(reqMsFor(leftMs));
  return outer ? AbortSignal.any([outer, t]) : t;
};

/*
 * v2.612 SEC2612-02: 리다이렉트를 따라가지 않는다. fetch 기본 'follow' 는 307/308 이면 **로그인 본문(계정·비밀번호)을 그대로
 *   다른 주소로 다시 POST** 하고, 세션 쿠키·Bearer 도 같은 출처면 따라간다. 게다가 IP 리터럴 대상은 SSRF lookup 을 거치지 않는다.
 *   CVP API 는 리다이렉트를 쓸 이유가 없으므로 3xx 는 실패로 보고, 사유에는 상태와 Location 의 **origin 만** 싣는다(경로·쿼리에
 *   토큰이 있을 수 있다).
 */
export const isRedirect = (status) => status >= 300 && status < 400;
export function redirectReason(res, base) {
  let origin = '';
  try { const loc = res.headers.get('location'); if (loc) origin = new URL(loc, base).origin; } catch { origin = ''; }
  return `CVP 가 리다이렉트로 응답했습니다(HTTP ${res.status}${origin ? ` → ${origin}` : ''}) — 따라가지 않았습니다. 등록 주소(스킴·호스트·포트)를 확인하세요`;
}

/** Set-Cookie 에서 access_token 값(없으면 ''). */
export function accessTokenFromSetCookie(values) {
  const list = Array.isArray(values) ? values : values ? [values] : [];
  for (const v of list) {
    const m = /(?:^|[;,\s])access_token=([^;,\s]+)/.exec(String(v));
    if (m) return m[1];
  }
  return '';
}

/**
 * 세션을 연다. 반환: { get(path) → {ok,status,text?,reason?}, logout(), base }.
 * @throws CvpAuthError 로그인 401/403
 */
export async function openSession(server, { signal, leftMs = null } = {}) {
  const b = baseUrlOf(server?.host);
  if (b.issue) throw new Error(b.issue);
  const base = b.base;
  const dispatcher = server.verifyTls === true ? dispVerify : dispNoVerify;
  let headers = { Accept: 'application/json' };
  let loggedIn = false;
  if (server.authMode === 'password') {
    const body = JSON.stringify({ userId: String(server.username || ''), password: String(server.password || '') });
    let res;
    try {
      res = await fetch(`${base}/cvpservice/login/authenticate.do`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body, dispatcher, signal: sig(signal, leftMs), redirect: 'manual',
      });
    } catch (e) { throw new Error(`로그인 요청 실패: ${e?.cause?.code || e?.message || e}`); }
    if (isRedirect(res.status)) { try { await res.body?.cancel?.(); } catch { /* */ } throw new Error(`로그인 ${redirectReason(res, base)}`); }
    if (res.status === 401 || res.status === 403) {
      try { await res.body?.cancel?.(); } catch { /* */ }
      throw new CvpAuthError(`인증 실패(${res.status}) — CVP 계정·비밀번호를 확인하세요`);
    }
    if (!res.ok) { try { await res.body?.cancel?.(); } catch { /* */ } throw new Error(`로그인 HTTP ${res.status}`); }
    let tok = accessTokenFromSetCookie(typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : res.headers.get('set-cookie'));
    let j = null;
    try { j = JSON.parse(await readTextCapped(res, 1_048_576, '로그인 응답')); } catch { j = null; }
    if (!tok && j && typeof j === 'object') tok = String(j.sessionId || j.cookie || j.access_token || '');
    if (!tok) throw new Error('로그인 응답에 세션 토큰(access_token)이 없습니다 — CVP 버전별 로그인 방식이 다를 수 있습니다');
    if (!RE_HEADER.test(tok)) throw new Error('세션 토큰에 사용 불가 문자가 있습니다');
    headers = { ...headers, Cookie: `access_token=${tok}` };
    loggedIn = true;
  } else {
    const t = String(server.token || '').trim();
    if (!t) throw new CvpAuthError('인증 실패 — 서비스 계정 토큰이 없습니다');
    if (!RE_HEADER.test(t)) throw new Error('토큰에 사용 불가 문자가 있습니다');
    headers = { ...headers, Authorization: `Bearer ${t}` };
  }
  return {
    base,
    async get(p) {
      let res;
      try { res = await fetch(`${base}${p}`, { headers, dispatcher, signal: sig(signal, leftMs), redirect: 'manual' }); }
      catch (e) {
        if (signal?.aborted) throw e;
        return { ok: false, status: 0, reason: `연결 실패: ${e?.cause?.code || e?.message || e}` };
      }
      if (isRedirect(res.status)) { try { await res.body?.cancel?.(); } catch { /* */ } return { ok: false, status: res.status, reason: redirectReason(res, base), redirect: true }; }
      if (!res.ok) {
        // v2.640: 오류 본문의 앞부분(SAMPLE_FAIL_BYTES)만 읽는다 — 진단 근거. 못 읽으면 ''(표본이 없을 뿐 판정은 상태 코드로 한다).
        let head = '';
        try { head = capStr((await readBodyPrefix(res, SAMPLE_FAIL_BYTES)).text, SAMPLE_HEAD_CHARS); } catch { head = ''; }
        return { ok: false, status: res.status, reason: `HTTP ${res.status}`, head };
      }
      try { return { ok: true, status: res.status, text: await readTextCapped(res, BODY_MAX_BYTES, '응답') }; }
      catch (e) { return { ok: false, status: res.status, reason: e?.message || String(e), tooLarge: true, head: '' }; }
    },
    /** v2.641: 본문 앞부분만 읽는다(이벤트처럼 전량이 클 수 있는 스트림) — 상한을 넘어도 실패하지 않고 `capped` 로 밝힌다. */
    async getPrefix(p, maxBytes) {
      let res;
      try { res = await fetch(`${base}${p}`, { headers, dispatcher, signal: sig(signal, leftMs), redirect: 'manual' }); }
      catch (e) {
        if (signal?.aborted) throw e;
        return { ok: false, status: 0, reason: `연결 실패: ${e?.cause?.code || e?.message || e}` };
      }
      if (isRedirect(res.status)) { try { await res.body?.cancel?.(); } catch { /* */ } return { ok: false, status: res.status, reason: redirectReason(res, base), redirect: true }; }
      if (!res.ok) {
        let head = '';
        try { head = capStr((await readBodyPrefix(res, SAMPLE_FAIL_BYTES)).text, SAMPLE_HEAD_CHARS); } catch { head = ''; }
        return { ok: false, status: res.status, reason: `HTTP ${res.status}`, head };
      }
      try { const r = await readBodyPrefix(res, maxBytes); return { ok: true, status: res.status, text: r.text, capped: !!r.capped }; }
      catch (e) { return { ok: false, status: res.status, reason: e?.message || String(e), head: '' }; }
    },
    async logout() {
      if (!loggedIn) return;
      try {
        const r = await fetch(`${base}/cvpservice/login/logout.do`, { method: 'POST', headers, dispatcher, signal: AbortSignal.timeout(10_000), redirect: 'manual' });
        try { await r.body?.cancel?.(); } catch { /* */ }
      } catch { /* 반납 실패는 무시 — 세션은 CVP 타임아웃으로도 회수된다 */ }
    },
  };
}

/** 경로 후보 순서 — 지난 주기에 성공한 후보를 앞으로. */
function ordered(kind, prefer) {
  const list = CANDIDATES[kind] || [];
  const p = prefer?.get?.(kind);
  // v2.644: 와일드카드 후보('/*/')를 펼쳐 이긴 구체 경로도 앞으로 둔다(목록에 그대로는 없다).
  if (p && !list.includes(p) && list.some((x) => wildcardMatches(x, p))) return [p, ...list];
  return p && list.includes(p) ? [p, ...list.filter((x) => x !== p)] : list;
}
/**
 * v2.644 — 와일드카드 후보. 경로 조각 `*` 은 '그 앞 경로의 포인터 키 각각' 이다(예: `/Smash/counters/ethIntf/*` + `/current/counter`).
 *   실장비(DCS-7010TX, EOS 4.28)에서 `FastCounters/current` 가 빈 응답이었다 — 카운터 에이전트 이름은 플랫폼마다 다르므로
 *   이름을 굳히지 않고 부모가 가진 자식을 차례로 시도한다(WILDCARD_MAX 개까지 · 이미 시도한 구체 경로는 건너뛴다).
 */
export const WILDCARD_MAX = 6;
export function wildcardMatches(tpl, concrete) {
  const i = String(tpl).indexOf('/*/');
  if (i < 0) return false;
  const pre = tpl.slice(0, i + 1); const post = tpl.slice(i + 2);
  const c = String(concrete);
  return c.startsWith(pre) && c.endsWith(post) && c.length > pre.length + post.length && !c.slice(pre.length, c.length - post.length).includes('/');
}
export function expandWildcard(tpl, keys, max = WILDCARD_MAX) {
  const i = String(tpl).indexOf('/*/');
  if (i < 0) return [tpl];
  const pre = tpl.slice(0, i + 1); const post = tpl.slice(i + 2);
  const out = [];
  for (const k of Array.isArray(keys) ? keys : []) {
    if (typeof k !== 'string' || !k || k === '.' || k === '..') continue;
    out.push(`${pre}${encodeURIComponent(k)}${post}`);
    if (out.length >= max) break;
  }
  return out;
}
const fill = (tpl, serial) => tpl.replaceAll('{serial}', encodeURIComponent(serial));
/** v2.641: 포인터를 따라갈 종류(부품·인터페이스·카운터·BGP·CPU·메모리). */
const FOLLOW_KINDS = new Set(['interfaces', 'intfConfig', 'counters', 'bgp', 'power', 'cooling', 'temperature', 'xcvr', 'cpu', 'memory']);
/**
 * v2.641: 하위 개체 URL. 포인터가 '부모 경로 + / + 키' 모양이면 부모 URL 뒤에 **키를 인코딩해** 붙인다('Ethernet3/1' 의 '/' 를 지키려고).
 *   그렇지 않으면 포인터 경로를 조각마다 인코딩해 장비 텔레메트리 루트에 붙인다. 포인터 원문은 장비가 준 값이라 `..` 조각은 버린다.
 */
export function childPath(serial, parentUrl, key, ptr, segsIn = null) {
  const root = `/api/v1/rest/${encodeURIComponent(serial)}`;
  // v2.642: 포인터가 조각 배열이면(실장비 `{"ptr":[…]}`) 조각마다 인코딩해 그대로 쓴다 — '/' 로 이었다 다시 자르면
  //   'Ethernet3/1' 같은 조각이 둘로 갈라진다. `..` 조각은 버린다(장비가 준 값).
  if (Array.isArray(segsIn) && segsIn.length) return `${root}/${segsIn.filter((x) => x && x !== '.' && x !== '..').map((x) => encodeURIComponent(x)).join('/')}`;
  const parentRel = String(parentUrl || '').startsWith(root) ? decodeSafe(String(parentUrl).slice(root.length)) : '';
  const p = String(ptr || '');
  if (parentRel && key && p === `${parentRel}/${key}`) return `${parentUrl}/${encodeURIComponent(key)}`;
  const segs = p.split('/').filter((x) => x && x !== '.' && x !== '..');
  return `${root}/${segs.map((x) => encodeURIComponent(x)).join('/')}`;
}
function decodeSafe(x) { try { return x.split('/').map((y) => decodeURIComponent(y)).join('/'); } catch { return x; } }

/**
 * 한 CVP 를 수집한다(순수에 가깝다 — 상태는 인자로 받는다).
 * @param {object} server 비밀 포함 등록 항목
 * @param {{ signal?:AbortSignal, budgetMs?:number, partsDue?:boolean, prefer?:Map, now?:()=>number }} opts
 * @returns {Promise<object>} 결과(아래 머리말) — 자격증명 거부는 CvpAuthError 로 던진다.
 */
export async function collectCvp(server, { signal, budgetMs = 110_000, partsDue = true, prefer = new Map(), now = Date.now, optics = {} } = {}) {
  const t0 = now();
  const left = () => budgetMs - (now() - t0);
  const usedPaths = {}; const missing = {}; const seenFields = {};
  const truncated = { devices: 0, ports: 0, peers: 0, notTried: 0, aborted: 0 };
  const samples = {};
  /*
   * v2.640: 종류마다 표본 1건 — **처음 성공한** 응답이 이기고, 성공이 없는 동안은 **마지막 실패**로 덮는다. 장비별 종류는 어느
   *   장비의 것이든 처음 성공한 1건이다(전 장비를 담으면 크기가 장비 수 × 4KB — 상태 push 에 실리는 값이다). `device` 로 어느
   *   장비의 응답인지 밝힌다. 실패 표본의 bytes 는 '읽은 앞부분' 길이다(전체 길이는 읽지 않았으므로 모른다).
   */
  /*
   * v2.641: 표본 우선순위(아래 rankOf). v2.640 은 빈 응답(`{"notifications":[]}`)을
   *   '성공' 으로 먼저 잡아 두어, 형식을 못 읽은 9대의 **정작 필요한 본문**이 표본에 남지 않았다(실장비 캡처로 확인). 같은 순위면
   *   먼저 잡은 것을 둔다(읽음) / 최신으로 덮는다(나머지).
   */
  //   순위: 읽음(5) > 못 읽은 본문(4) > 404 가 아닌 실패(3 — 403 RBAC 등 단서가 있다) > 빈 응답(2 — 경로는 있다) > 404(1).
  const rankOf = (r) => (r.ok && !r.unread && !r.empty ? 5 : r.unread ? 4 : r.empty ? 2 : r.status === 404 ? 1 : 3);
  const noteSample = (kind, p, r, device = '') => {
    const cur = samples[kind];
    const rank = rankOf(r);
    if (cur && (cur.rank > rank || (cur.rank === 5 && rank === 5))) return;
    if (r.ok) samples[kind] = { path: p, at: now(), status: r.status, ok: rank === 5, rank, ...(r.empty ? { empty: true, reason: EMPTY_REASON } : {}), ...(r.unread ? { unread: true, reason: UNREAD_REASON } : {}), bytes: Buffer.byteLength(r.text), head: capStr(r.text, SAMPLE_HEAD_CHARS), ...(device ? { device } : {}) };
    else samples[kind] = { path: p, at: now(), status: r.status, ok: false, rank, bytes: Buffer.byteLength(r.head || ''), head: capStr(r.head || '', SAMPLE_HEAD_CHARS), reason: capStr(r.reason, 300), ...(device ? { device } : {}) };
  };
  const sess = await openSession(server, { signal, leftMs: left });
  try {
    // ① 인벤토리 — 이것이 없으면 아무것도 없다.
    let inv = null; let invReason = '';
    for (const p of ordered('inventory', prefer)) {
      const r = await sess.get(p);
      noteSample('inventory', p, r);
      if (!r.ok) {
        if ((r.status === 401 || r.status === 403) && server.authMode !== 'password') throw new CvpAuthError(`인증 실패(${r.status}) — 서비스 계정 토큰을 확인하세요`);
        invReason = `${p}: ${r.reason}`;
        continue;
      }
      const parsed = P.parseInventory(r.text);
      seenFields.inventory = parsed.keys;
      if (!parsed.devices) { invReason = `${p}: 장비 목록 형식을 읽지 못했습니다`; continue; }
      inv = parsed; usedPaths.inventory = p; prefer.set('inventory', p);
      break;
    }
    if (!inv) {
      missing.inventory = invReason || '후보 경로가 없습니다';
      return { ok: false, error: `장비 인벤토리를 읽지 못했습니다 — ${missing.inventory}`, devices: [], usedPaths, missing, seenFields, truncated, samples, inventoryComplete: false, cvpVersion: '' };
    }
    truncated.devices = inv.truncated;

    // ② CVP 자체 버전(참고) — 실패해도 진행.
    let cvpVersion = '';
    for (const p of ordered('cvpVersion', prefer)) {
      const r = await sess.get(p);
      noteSample('cvpVersion', p, r);
      if (!r.ok) { missing.cvpVersion = `${p}: ${r.reason}`; continue; }
      const { values } = P.splitJsonStream(r.text);
      const v = values[0] && typeof values[0] === 'object' ? String(values[0].version || values[0].appVersion || '') : '';
      if (v) { cvpVersion = v.slice(0, 64); usedPaths.cvpVersion = p; delete missing.cvpVersion; break; }
      missing.cvpVersion = `${p}: 버전 필드가 없습니다`;
    }

    /*
     * ②-b v2.641: CVP 단위 항목(요청 각 1회) — 레거시 인벤토리(관리 IP·컴플라이언스·부팅 시각) · 수명주기(EOL) · 버그 노출 · 이벤트.
     *   전부 실패해도 진행한다(장비 목록은 이미 있다). 못 읽은 항목은 missing 에 사유가 남고 장비 값은 비어 있다('없음' 이 아니다).
     */
    const wide = {};
    const readWide = async (kind, parse, { prefixBytes = 0 } = {}) => {
      if (left() < MIN_SLICE_MS) { missing[kind] = '시간 예산이 모자라 이번 주기에 조회하지 않았습니다'; return null; }
      let last = '';
      for (const p of ordered(kind, prefer)) {
        const r = prefixBytes ? await sess.getPrefix(p, prefixBytes) : await sess.get(p);
        if (!r.ok) { noteSample(kind, p, r); last = `${p}: ${r.status === 404 ? '없음(404 — 이 CVP 버전에 그 API 가 없을 수 있습니다)' : r.status === 403 ? 'forbidden(403)' : r.reason}`; continue; }
        const out = parse(r.text);
        if (out && out.value != null) {
          noteSample(kind, p, r); usedPaths[kind] = p; prefer.set(kind, p); delete missing[kind];
          if (out.keys) seenFields[kind] = out.keys.slice(0, 40);
          return { ...out, capped: !!r.capped };
        }
        noteSample(kind, p, { ...r, unread: true });
        if (out?.keys && !seenFields[kind]) seenFields[kind] = out.keys.slice(0, 40);
        last = `${p}: ${UNREAD_REASON}`;
      }
      missing[kind] = last || '후보 경로가 없습니다';
      return null;
    };
    wide.enrich = await readWide('enrich', (t) => { const x = P.parseLegacyInventory(t); return { value: x.map && x.map.size ? x.map : null, keys: x.keys }; });
    wide.lifecycle = await readWide('lifecycle', (t) => { const x = P.parseLifecycle(t); return { value: x.map, keys: x.keys }; });
    wide.bugs = await readWide('bugs', (t) => { const x = P.parseBugExposure(t); return { value: x.map, keys: x.keys }; });
    const ev = await readWide('events', (t) => { const x = P.parseEvents(t); return { value: x.events, keys: x.keys, x }; }, { prefixBytes: EVENTS_BODY_MAX });
    const events = ev ? { list: ev.value, bySeverity: ev.x.bySeverity, total: ev.x.total, truncated: ev.x.truncated, capped: ev.capped, at: now() } : null;
    if (events?.capped) missing.eventsCapped = `이벤트 응답이 ${Math.round(EVENTS_BODY_MAX / 1_048_576)}MB 를 넘어 앞부분만 읽었습니다 — 개수는 '최소' 이고 최신 이벤트가 빠졌을 수 있습니다`;
    for (const d of inv.devices) {
      const info = {};
      const le = wide.enrich?.value?.get?.(d.serial || d.key);
      if (le) { Object.assign(info, { status: le.status, complianceCode: le.complianceCode, complianceIndication: le.complianceIndication, container: le.container, ztpMode: le.ztpMode, mlag: le.mlag, internalVersion: le.internalVersion });
        if (!d.mgmtIp && le.mgmtIp) d.mgmtIp = le.mgmtIp;
        if (d.bootAt == null && le.bootAt != null) d.bootAt = le.bootAt; }
      const lc = wide.lifecycle?.value?.get?.(d.serial || d.key);
      if (lc) info.lifecycle = lc;
      const bg = wide.bugs?.value?.get?.(d.serial || d.key);
      if (bg) info.bugs = bg;
      info.readKinds = ['enrich', 'lifecycle', 'bugs'].filter((k) => wide[k]);
      d.info = info;
    }

    // ③ 장비별 텔레메트리 — 종류마다 후보 체인 + 연속 실패 차단.
    const kinds = ['interfaces', 'counters', 'bgp', 'cpu', 'memory', ...(partsDue ? ['intfConfig', ...Object.keys(PART_KINDS)] : [])];
    const ks = Object.fromEntries(kinds.map((k) => [k, { ok: 0, fail: 0, streak: 0, stopped: false, last: '', empty: 0, followed: 0, followTruncated: 0 }]));
    /*
     * v2.641: 종류 하나를 읽는다. 응답이 ① 빈 응답(`{"notifications":[]}`)이면 **읽은 것이 아니다** — 다음 후보로 넘어가고 사유는
     *   EMPTY_REASON(v2.640 까지는 '읽음 0개' 로 세 초록 0/0·'피어 없음' 이 됐다) ② 포인터(`_ptr`)만 있으면 포인터를 따라가
     *   하위 개체를 모아 다시 파싱한다(followPtrs — 요청 상한·예산 안에서) ③ 그래도 못 읽으면 UNREAD_REASON.
     *   빈 응답만 받은 장비는 `emptyDevices` 로 따로 센다 — '경로가 틀렸다' 와 '그 장비에 값이 없다(BGP 미설정 등)' 를 가를 근거다.
     */
    const readKind = async (kind, serial, parse, keep = null) => {
      const st = ks[kind];
      if (st.stopped) return { skipped: true };
      let lastReason = ''; let allEmpty = true;
      const queue = [...ordered(kind, prefer)];
      const tried = new Set();
      while (queue.length) {
        const tpl = queue.shift();
        if (tried.has(tpl)) continue;
        tried.add(tpl);
        // v2.644: 와일드카드 — 부모 경로의 포인터 키로 펼쳐 큐 앞에 넣는다(부모 조회 1회). 부모가 비었거나 실패하면 그 사유를 남긴다.
        if (tpl.includes('/*/')) {
          const parent = fill(tpl.slice(0, tpl.indexOf('/*/')), serial);
          const pr = await sess.get(parent);
          if (!pr.ok) { allEmpty = false; if (!lastReason || lastReason === EMPTY_REASON) lastReason = pr.status === 404 ? '없음(404)' : pr.reason; continue; }
          const psh = P.telemetryShape(pr.text);
          if (psh.empty || !psh.ptrs.length) { if (!lastReason) lastReason = EMPTY_REASON; continue; }
          queue.unshift(...expandWildcard(tpl, psh.ptrs.map((x) => x.key)).filter((x) => !tried.has(x)));
          continue;
        }
        // v2.641: '경로@접미' — 컬렉션을 읽은 뒤 각 포인터 키 뒤에 접미를 붙여 바로 읽는다(중간 단계 조회를 건너뛴다).
        const at = tpl.indexOf('@');
        const suffix = at >= 0 ? tpl.slice(at + 1) : '';
        const p0 = fill(at >= 0 ? tpl.slice(0, at) : tpl, serial);
        const r = await sess.get(p0);
        if (!r.ok) {
          allEmpty = false; noteSample(kind, tpl, r, serial);
          // v2.641: 후보가 여럿이 되면서 뒤 후보의 404 가 앞 후보의 403(RBAC 거부 — 더 중요한 단서)을 덮었다. 404 는 사유가 비어 있을 때만 쓴다.
          const why = r.status === 403 ? 'forbidden(403)' : r.status === 404 ? '없음(404)' : r.reason;
          if (r.status !== 404 || !lastReason || lastReason === EMPTY_REASON) lastReason = why;
          continue;
        }
        let out = parse(r.text);
        if (out && out.value != null) return win(kind, st, tpl, r, serial, out, 0);
        const shape = P.telemetryShape(r.text);
        if (shape.empty) { noteSample(kind, tpl, { ...r, empty: true }, serial); lastReason = EMPTY_REASON; continue; }
        allEmpty = false;
        noteSample(kind, tpl, { ...r, unread: true }, serial);
        if (shape.ptrs.length && FOLLOW_KINDS.has(kind)) {
          // keep: 카운터는 링크가 올라온 포트만 따라간다(쓰지 않는 포트의 처리량은 0 이 정답이 아니라 볼 이유가 없다 — 요청 수 절감).
          const pl = typeof keep === 'function' ? shape.ptrs.filter((x) => keep(x.key)) : shape.ptrs;
          const fol = pl.length ? await followPtrs(serial, p0, pl, { suffix, kind }) : { text: '', requests: 0, truncated: 0 };
          if (fol.text) {
            out = parse(fol.text);
            if (out && out.value != null) return win(kind, st, tpl, { ...r, text: fol.text }, serial, out, fol.requests, fol.truncated);
          }
          lastReason = fol.requests ? `포인터 ${shape.ptrs.length}개를 따라갔지만(${fol.requests}회 조회) 형식을 읽지 못했습니다` : UNREAD_REASON;
        } else lastReason = UNREAD_REASON;
        if (!seenFields[kind] && out?.keys) seenFields[kind] = out.keys.slice(0, 40);
      }
      st.fail++; st.streak++; st.last = lastReason;
      if (allEmpty && lastReason === EMPTY_REASON) st.empty++;
      // 빈 응답은 '경로는 열려 있다' 는 뜻이라 연속 실패 차단에 넣지 않는다(BGP 를 쓰지 않는 장비가 앞에 몰리면 나머지를 못 본다).
      if (st.ok === 0 && st.streak >= FAIL_STREAK_STOP && !(allEmpty && lastReason === EMPTY_REASON)) st.stopped = true;
      return { failed: true, reason: lastReason, empty: allEmpty && lastReason === EMPTY_REASON };
    };
    function win(kind, st, tpl, r, serial, out, followed = 0, followTruncated = 0) {
      st.ok++; st.streak = 0;
      if (followed) { st.followed += followed; st.followTruncated += followTruncated; }
      if (!usedPaths[kind]) usedPaths[kind] = followed ? `${tpl.replace('@', ' → 각 항목 ')} (포인터 추종)` : tpl;
      prefer.set(kind, tpl);
      noteSample(kind, tpl, r, serial);
      if (!seenFields[kind] && out.keys) seenFields[kind] = out.keys.slice(0, 40);
      return { value: out.value, extra: out };
    }
    /**
     * 포인터를 따라가 하위 개체 응답을 모은다(깊이 FOLLOW_DEPTH · 요청 FOLLOW_REQ_MAX · 장비 안 동시 FOLLOW_CONCURRENCY).
     * 개체 이름은 **포인터의 키**다 — 응답 경로의 마지막 조각은 'Ethernet3/1' 처럼 이름에 '/' 가 있으면 잘리므로 믿지 않는다.
     * 하위 응답이 또 포인터면 그 키로 한 단계 더 내려간다(BGP: 테이블 → VRF → 피어).
     */
    async function followPtrs(serial, parentPath, ptrs, { suffix = '', kind = '' } = {}) {
      const leaves = []; let requests = 0; let truncated = 0;
      // keys: 따라온 키의 경로. 개체 이름은 첫 키(포트·부품 이름)다 — BGP 만 두 번째 키(피어)를 쓰고 첫 키(VRF)를 필드로 남긴다.
      let level = ptrs.map((x) => ({ ...x, parent: parentPath, keys: [x.key], direct: !!suffix }));
      const maxDepth = FOLLOW_DEPTH_BY_KIND[kind] || FOLLOW_DEPTH;
      for (let depth = 0; depth < maxDepth && level.length; depth++) {
        const next = [];
        const room = Math.max(0, FOLLOW_REQ_MAX - requests);
        if (level.length > room) { truncated += level.length - room; level = level.slice(0, room); }
        await poolSettled(level, FOLLOW_CONCURRENCY, async (x) => {
          if (left() < MIN_SLICE_MS || signal?.aborted) { truncated++; return; }
          const url = x.direct ? `${childPath(serial, x.parent, x.key, x.ptr, x.segs)}${suffix.split('/').map((y) => (y ? encodeURIComponent(y) : '')).join('/')}` : childPath(serial, x.parent, x.key, x.ptr, x.segs);
          requests++;
          const r = await sess.get(url);
          if (!r.ok) return;
          const sh = P.telemetryShape(r.text);
          if (sh.empty) return;
          const vals = P.splitJsonStream(r.text).values;
          const own = [];
          const bgpLike = kind === 'bgp' && x.keys.length >= 2;
          // v2.643(실장비 캡처): 부품은 **포인터 경로 전체**로 이름을 짓는다. 첫 키로 지으면 `/environment/power/status` 아래
          //   powerSupply → PowerSupply1·PowerSupply2 가 'powerSupply' 한 개체로 **합쳐져** 뒤 값이 앞 값을 덮었다(화면에 psu
          //   'powerSupply'·'currentSensor' 같은 컨테이너 이름만 보이고 실제 PSU 가 안 보였다 — 장애가 나도 잡을 수 없다).
          //   상태 필드가 없는 컨테이너는 parseParts 가 건너뛴다. 포트(첫 키)·BGP(둘째 키)는 그대로다.
          const name = bgpLike ? x.keys[1] : Object.hasOwn(PART_KINDS, kind) ? x.keys.join(PART_PATH_SEP) : x.keys[0];
          for (const v of vals) {
            if (!v || typeof v !== 'object' || !Array.isArray(v.notifications)) continue;
            for (const n of v.notifications) {
              if (!n || typeof n !== 'object') continue;
              const ups = bgpLike && n.updates && typeof n.updates === 'object' ? { ...n.updates, vrfName: { key: 'vrfName', value: x.keys[0] } } : n.updates;
              own.push({ ...n, updates: ups, path: `/leaf/${encodeURIComponent(name)}` });
            }
          }
          if (own.length) leaves.push({ notifications: own });
          if (sh.ptrs.length && depth + 1 < maxDepth) for (const c of sh.ptrs) if (followChild(kind, depth, c.key)) next.push({ ...c, parent: url, keys: [...x.keys, c.key], direct: false });
        });
        level = next;
      }
      if (level.length) truncated += level.length;
      return { text: leaves.map((l) => JSON.stringify(l)).join('\n'), requests, truncated };
    }

    /**
     * v2.648: 슬롯 근거 — ① 인터페이스 슬라이스 목록(1회) ② 대상 슬롯 슬라이스의 포트 목록(슬롯당 1회) ③ 그중 앞 SLOT_SAMPLE 개 포트의
     *   링크 상태(포인터 추종). 요청 수는 장비당 1 + 슬롯 수 × (1 + SLOT_SAMPLE) 이하이고 대상 장비만 한다.
     */
    async function slotEvidence(serial, slots) {
      const ev = { slicesRead: false, sliceKeys: [], slices: {} };
      const base = `/api/v1/rest/${encodeURIComponent(serial)}/Sysdb/interface/status/eth/phy/slice`;
      const r = await sess.get(base);
      if (!r.ok) return ev;
      const sh = P.telemetryShape(r.text);
      if (sh.empty && !sh.ptrs.length) return ev;
      ev.slicesRead = true;
      ev.sliceKeys = sh.ptrs.map((x) => String(x.key));
      for (const n of slots) {
        if (!ev.sliceKeys.includes(String(n)) || left() < MIN_SLICE_MS || signal?.aborted) continue;
        const u = `${base}/${encodeURIComponent(String(n))}/intfStatus`;
        const ir = await sess.get(u);
        if (!ir.ok) { ev.slices[n] = { intfs: null, sampled: 0, up: 0 }; continue; }
        const ish = P.telemetryShape(ir.text);
        const intfs = ish.ptrs.length;
        let sampled = 0; let up = 0;
        if (intfs && left() >= MIN_SLICE_MS) {
          const fol = await followPtrs(serial, u, ish.ptrs.slice(0, SLOT_SAMPLE), { kind: 'interfaces' });
          const ports = fol.text ? P.parseInterfaces(fol.text).ports : null;
          if (Array.isArray(ports)) { sampled = ports.length; up = ports.filter((x) => x.oper === 'up').length; }
        }
        ev.slices[n] = { intfs, sampled, up };
      }
      return ev;
    }
    const followNote = {};
    const devices = inv.devices.map((d) => ({ ...d, parts: undefined, partsAt: null, bgp: null, ports: null, counters: null, countersAt: null, telemetry: 'pending' }));
    await poolSettled(devices, DEVICE_CONCURRENCY, async (dev) => {
      if (signal?.aborted) { dev.telemetry = 'aborted'; truncated.notTried++; return; }
      if (left() < MIN_SLICE_MS) { dev.telemetry = 'budget'; truncated.notTried++; return; }
      if (dev.streaming === false) { dev.telemetry = 'not-streaming'; return; }
      const serial = dev.serial || dev.key;
      const intf = await readKind('interfaces', serial, (t) => { const x = P.parseInterfaces(t); return { value: x.ports, keys: x.keys, truncated: x.truncated }; });
      if (intf.value) { dev.ports = intf.value; truncated.ports += intf.extra.truncated || 0; }
      // v2.649: 설명 — 부품 주기에만(설정 노드). 못 읽으면 포트 desc 는 null 로 남고 저장소가 직전 값을 유지한다(COALESCE).
      if (partsDue && Array.isArray(dev.ports) && left() >= MIN_SLICE_MS) {
        const cfg = await readKind('intfConfig', serial, (t) => { const x = P.parseIntfConfig(t); return { value: x.descs, keys: x.keys }; });
        if (cfg.value) { dev.ports = P.mergeIntfConfig(dev.ports, cfg.value); dev.descsAt = now(); }
      }
      if (left() < MIN_SLICE_MS) { dev.telemetry = 'budget-partial'; return; }
      const upSet = Array.isArray(dev.ports) ? new Set(dev.ports.filter((p) => p.oper === 'up').map((p) => p.name)) : null;
      const cnt = await readKind('counters', serial, (t) => { const x = P.parseCounters(t); return { value: x.counters, keys: x.keys }; }, upSet ? (k) => upSet.has(k) : null);
      if (cnt.value) { dev.counters = cnt.value; dev.countersAt = now(); }
      // v2.611(TIM2611-01): counters·bgp 앞에도 예산을 본다 — 시작해 놓고 잘리면 결과가 버려진다.
      if (left() < MIN_SLICE_MS) { dev.telemetry = intf.value || cnt.value ? 'budget-partial' : 'budget'; return; }
      const bgp = await readKind('bgp', serial, (t) => { const x = P.parseBgp(t); return { value: x.peers, keys: x.keys, truncated: x.truncated }; });
      if (bgp.value) { dev.bgp = bgp.value; truncated.peers += bgp.extra.truncated || 0; }
      else if (bgp.empty) dev.bgpEmpty = true; // v2.641: 빈 응답 — '피어 없음' 도 '못 읽음' 도 아닌 '이 경로에 값 없음'(BGP 미설정일 수 있다)
      if (intf.empty) dev.portsEmpty = true;
      // v2.641 ③: CPU·메모리 — 장비당 요청 1~2회. 못 읽으면 null(0% 를 지어내지 않는다).
      if (left() >= MIN_SLICE_MS) {
        const cpu = await readKind('cpu', serial, (t) => { const x = P.parseCpu(t); return { value: x.pct != null || x.counters ? { pct: x.pct, counters: x.counters } : null, keys: x.keys }; });
        if (cpu.value) { dev.cpu = cpu.value; dev.sysAt = now(); }
      }
      if (left() >= MIN_SLICE_MS) {
        const mem = await readKind('memory', serial, (t) => { const x = P.parseMemory(t); return { value: x.pct != null ? { pct: x.pct, total: x.total } : null, keys: x.keys }; });
        if (mem.value) { dev.mem = mem.value; dev.sysAt = dev.sysAt ?? now(); }
      }
      if (partsDue) {
        const parts = []; let anyRead = false; let attempted = false; const failedKinds = [];
        for (const k of Object.keys(PART_KINDS)) {
          if (left() < MIN_SLICE_MS) { failedKinds.push(k); continue; }
          attempted = true;
          const r = await readKind(k, serial, (t) => { const x = P.parseParts(t, PART_KINDS[k]); return { value: x.parts, keys: x.keys }; });
          if (r.value) { anyRead = true; pushAll(parts, r.value); } else failedKinds.push(k);
        }
        // 한 종류도 시도하지 못했으면(예산) 이번에 안 읽은 것 — undefined 로 두어 DB 의 이전 파트 값을 지우지 않는다.
        // v2.646: GBIC 광신호 판정 — 링크가 올라온 포트만(judgeOptics 머리말).
        dev.parts = anyRead ? P.judgeOptics(parts.slice(0, P.PART_MAX), dev.ports, optics) : attempted ? null : undefined;
        // v2.648: 슬롯 전원(카드 전원) 확인 루틴 — 정상이 아닌 라인카드 슬롯 전원 항목이 있을 때만(대개 0대 — 추가 요청은 그 장비·그 슬롯만).
        if (Array.isArray(dev.parts)) {
          const slots = P.slotsToCheck(dev.parts);
          if (slots.length && left() >= MIN_SLICE_MS) dev.parts = P.judgeSlotPower(dev.parts, await slotEvidence(serial, slots));
          else dev.parts = P.judgeSlotPower(dev.parts, {});
        }
        dev.partsAt = attempted ? now() : null;
        // v2.612 RECENT2612-01: 파트 조회를 **시도했는가**(경로가 전부 404 여도 시도다). 폴러가 이것으로 조회 시각을 올린다 —
        //   '읽었을 때만' 올리면 파트 경로가 없는 CVP 에 매 주기 4종 × 장비 수만큼 헛조회가 나간다.
        dev.partsAttempted = attempted;
        if (failedKinds.length && anyRead) dev.partsMissingKinds = failedKinds;
      }
      // v2.641: 전부 빈 응답이면 'failed' 가 아니라 'empty'(경로는 열려 있고 값이 없다 — 조치가 다르다: 경로 후보를 봐야 한다).
      dev.telemetry = intf.value || cnt.value || bgp.value ? 'ok' : (intf.empty && bgp.empty) ? 'empty' : 'failed';
    });
    /*
     * v2.641: 경로 탐색 표본 — 부품 주기(partsDue)에만, 스트리밍 중인 장비 1대에 대해 PROBE_PATHS 를 차례로 GET 한다(예산 안에서).
     *   '어디에 값이 있는가' 를 실장비에서 보여 주는 근거다(추정 경로를 고칠 때 이것을 본다).
     */
    const probes = [];
    const probeDev = partsDue ? devices.find((d) => d.streaming !== false && (d.serial || d.key)) : null;
    if (probeDev) {
      const serial = probeDev.serial || probeDev.key;
      for (const rel of [...PROBE_PATHS, ...xcvrProbePaths(probeDev.parts)]) {
        if (probes.length >= PROBE_MAX || left() < MIN_SLICE_MS || signal?.aborted) break;
        const p = `/api/v1/rest/${encodeURIComponent(serial)}${rel}`;
        const r = await sess.get(p);
        const sh = r.ok ? P.telemetryShape(r.text) : null;
        probes.push({
          path: p.replace(encodeURIComponent(serial), '{serial}'), device: serial, status: r.status, at: now(), ok: !!r.ok,
          bytes: r.ok ? Buffer.byteLength(r.text) : null, head: capStr(r.ok ? r.text : (r.head || r.reason || ''), PROBE_HEAD_CHARS),
          ...(sh ? { empty: sh.empty, updates: sh.updates, ptrs: sh.ptrs.length, ptrKeys: sh.ptrs.slice(0, 12).map((x) => x.key) } : {}),
        });
      }
    }
    // v2.611(TIM2611-01): 시한(외부 신호)에 걸려 끝나지 못한 장비는 'pending' 으로 남는다 — '조회 중단' 으로 바꾸고 개수를 밝힌다.
    for (const dev of devices) if (dev.telemetry === 'pending') { dev.telemetry = 'aborted'; truncated.aborted++; }
    if (truncated.aborted) missing.deadline = `CVP 수집 시한에 걸려 ${truncated.aborted}대는 조회를 끝내지 못했습니다(값이 비어 있는 것은 '없음' 이 아니라 '못 읽음')`;
    for (const [k, st] of Object.entries(ks)) {
      if (st.followTruncated) followNote[k] = `포인터 추종 상한(장비당 ${FOLLOW_REQ_MAX}회)·시간 예산으로 ${st.followTruncated}개 하위 개체를 읽지 못했습니다`;
      if (st.fail === 0 && !st.stopped) continue;
      // v2.641: 빈 응답만 받은 장비 수를 따로 말한다 — '경로에 데이터 없음' 은 '형식을 못 읽음' 과 조치가 다르다(경로 후보를 바꾼다 vs 파서를 고친다).
      // v2.641: 전부 빈 응답이면 한 문장으로(예전엔 '실패(빈 응답…) · 그중 N대는 빈 응답' 으로 같은 말을 두 번 했다 — 스크린샷 판독).
      const allEmptyKind = st.empty > 0 && st.empty === st.fail;
      const emptyNote = st.empty && !allEmptyKind ? ` · 그중 ${st.empty}대는 빈 응답(경로에 데이터 없음)` : '';
      missing[k] = st.stopped
        ? `처음 ${FAIL_STREAK_STOP}대에서 모든 후보 경로가 실패해 이번 주기 나머지 장비는 시도하지 않았습니다(${st.last})`
        : allEmptyKind ? `${st.fail}대 ${EMPTY_REASON}`
          : `${st.fail}대 실패(${st.last === EMPTY_REASON ? '경로에 데이터 없음' : st.last})${emptyNote}`;
    }
    for (const [k, v] of Object.entries(followNote)) if (!missing[k]) missing[`${k}`] = v;
    if (truncated.notTried) missing.budget = `시간 예산이 모자라 ${truncated.notTried}대는 이번 주기에 조회하지 않았습니다`;
    return {
      ok: true, error: null, devices, usedPaths, missing, seenFields, truncated, samples, cvpVersion, events, ...(probes.length ? { probes } : {}),
      inventoryComplete: inv.truncated === 0,
    };
  } finally { await sess.logout(); }
}

/**
 * 연결 테스트 — 로그인 + 인벤토리만(장비별 조회 없음). 스냅샷·DB 에 저장하지 않는다.
 * v2.640: 성공이면 `sample`(읽은 인벤토리 원문 앞부분) + `cvpVersion`(getCvpInfo 후보 1회 — 실패는 무시), 실패면 마지막 응답의
 *   `sample`(상태·오류 본문 앞부분)을 함께 돌려준다 — 등록 화면에서 '어떤 응답이 왔는가' 를 바로 보게(경로 후보를 좁힐 근거).
 */
export async function testCvp(server, { signal } = {}) {
  const t0 = Date.now();
  let last = null; // 마지막 응답 표본(성공·실패 무관) — 실패 사유 옆에 붙인다
  const sampleOf = (p, r) => (r.ok
    ? { path: p, status: r.status, ok: true, bytes: Buffer.byteLength(r.text), head: capStr(r.text, SAMPLE_HEAD_CHARS) }
    : { path: p, status: r.status, ok: false, bytes: Buffer.byteLength(r.head || ''), head: capStr(r.head || '', SAMPLE_HEAD_CHARS), reason: capStr(r.reason, 300) });
  try {
    const sess = await openSession(server, { signal });
    try {
      let redirected = '';
      for (const p of CANDIDATES.inventory) {
        const r = await sess.get(p);
        last = sampleOf(p, r);
        if (!r.ok) {
          if ((r.status === 401 || r.status === 403) && server.authMode !== 'password') throw new CvpAuthError(`인증 실패(${r.status}) — 서비스 계정 토큰을 확인하세요`);
          if (r.redirect && !redirected) redirected = r.reason; // v2.612 SEC2612-02: 리다이렉트는 사유를 그대로 보인다
          continue;
        }
        const x = P.parseInventory(r.text);
        if (x.devices) {
          let cvpVersion = '';
          try {
            const vp = CANDIDATES.cvpVersion[0];
            const vr = vp ? await sess.get(vp) : null;
            if (vr?.ok) {
              const { values } = P.splitJsonStream(vr.text);
              cvpVersion = values[0] && typeof values[0] === 'object' ? capStr(values[0].version || values[0].appVersion || '', 64) : '';
            }
          } catch { cvpVersion = ''; } // 버전은 참고값 — 실패해도 테스트 결과를 바꾸지 않는다
          return { ok: true, ms: Date.now() - t0, deviceCount: x.devices.length, usedPath: p, seenFields: x.keys, sample: last, cvpVersion };
        }
      }
      return { ok: false, ms: Date.now() - t0, reason: redirected || '로그인은 됐지만 장비 인벤토리 경로를 읽지 못했습니다(후보 경로 전부 실패)', ...(last ? { sample: last } : {}) };
    } finally { await sess.logout(); }
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, reason: e?.message || String(e), authFailed: !!e?.authFailed, ...(last ? { sample: last } : {}) };
  }
}
