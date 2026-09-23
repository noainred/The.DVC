import { Agent } from 'undici';
import { constants as cryptoConstants } from 'node:crypto';
import { config } from '../config.js';
import { withSsrfLookup } from '../util/ssrfLookup.js';
import { createAuthGuard } from '../util/authGuard.js';
import { effectiveRequestTimeoutMs } from './soapParse.js'; // v2.598 T2598-03 — 옛 저장값의 시한 상한(2^31ms 이상이면 1ms 로 abort)

/**
 * vCenter 주기 수집의 **인증 실패 정지** 저장소(v2.590 — 감사 F1, 계정 잠금 경로).
 *
 * 왜 여기인가: 이 파일이 수집 진입점(`collectFromVCenter`)을 갖고 있고, 같은 계정으로 로그인하는
 * 다른 주기 수집기(vCenter 이벤트 로그·GPU 게스트 수집)가 **같은 정지 기록**을 봐야 한다 —
 * 수집기마다 따로 두면 store 가 멈춰도 로그 폴러가 같은 계정으로 계속 로그인해 **잠금은 그대로**다.
 * 코어는 `util/authGuard.js` 하나다(v2.535 — 20줄을 복사하지 않는다). 파일은 도구마다 다르다.
 *
 * ⚠ 멈추는 것은 **자격증명 거부뿐**이다 — SOAP `InvalidLogin` · REST `POST /api/session` 401.
 *   타임아웃·연결 실패·5xx 로 멈추면 일시 장애가 수집을 영구 정지시킨다(authGuard 규칙 4).
 * ⚠ 수동 실행(연결 테스트·'지금 수집')은 막지 않는다 — 막는 것은 **주기 수집뿐**이다(규칙 3).
 */
export const vcAuthGuard = createAuthGuard({ file: 'vcenter-auth-stops.json' });

/**
 * 오류가 vCenter **자격증명 거부**인가(출처에서 못 박은 플래그만 본다 — 문구 추측 금지).
 * `#call`(SOAP)과 `#request`(REST)가 `authFailed=true` 를 붙인다.
 */
export function isVcAuthError(err) {
  // v2.591: 게스트 계정 거부(InvalidGuestLogin — gpu/guestops.js 가 `authFailed`+`guestAuth` 로 표시)는
  //   **vCenter 계정 문제가 아니다**. 게스트 오류가 이 판정에 흘러들면 멀쩡한 vCenter 계정의 주기 수집이 멈춘다.
  return !!(err && err.authFailed === true && err.guestAuth !== true);
}

/** 수집 1회용 신호 — 건별 시한과 외부(데드라인) 신호를 함께 건다(v2.590 — 감사 F7, v2.417 규약). */
export function vcRequestSignal(timeoutMs, external) {
  const t = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([t, external]) : t;
}

/**
 * Thin client for the vSphere Automation REST API (vCenter 7.0+ / 8.0).
 *
 * Endpoints used (all under /api after authentication):
 *   POST /api/session                 -> session token
 *   GET  /api/vcenter/host            -> hosts
 *   GET  /api/vcenter/cluster         -> clusters
 *   GET  /api/vcenter/vm              -> virtual machines
 *   GET  /api/vcenter/datastore       -> datastores
 *   GET  /api/vcenter/network         -> networks
 *
 * Many private vCenters use self-signed certs, so TLS verification is
 * configurable via VC_TLS_REJECT_UNAUTHORIZED (default: off).
 */

// vCenter/게스트 파일전송 전용 로컬 디스패처(감사 C1/C3 수정) — 과거에는 setGlobalDispatcher로
// 프로세스 '전역' fetch의 TLS 검증을 껐고(legacy TLS/SECLEVEL=0 포함), 그 결과 업그레이드 번들·
// NSX·게스트 전송 등 관련 없는 모든 fetch가 MITM에 노출됐다. 이제 전역 디스패처는 Node 기본
// (인증서 검증 ON)을 유지하고, 자체서명/구형 TLS가 실제로 필요한 vCenter 계열 fetch에만
// dispatcher 옵션으로 이 permissive Agent를 명시 주입한다(soapClient/guestops/nsx도 동일 패턴).
// 구형 어플라이언스는 legacy TLS/재협상을 요구하므로 검증 off일 때 SECLEVEL을 낮춘다(기존 동작 유지).
// v2.537: DNS 리바인딩(TOCTOU) 차단 — util/ssrfLookup.js 머리말. v2.506 배선(11곳)에서 빠져 있던 dispatcher.
// soapClient.js 도 이 vcDispatcher 를 쓰므로 여기 한 곳이 vCenter SOAP·REST 접속 전부를 덮는다.
const vcConnect = withSsrfLookup(config.rejectUnauthorized
  ? { rejectUnauthorized: true, timeout: 15_000 }
  : {
    rejectUnauthorized: false,
    minVersion: config.vcTlsMinVersion,           // default TLSv1
    ciphers: config.vcTlsCiphers,                 // default DEFAULT@SECLEVEL=0
    secureOptions:
      cryptoConstants.SSL_OP_LEGACY_SERVER_CONNECT |
      cryptoConstants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION,
    timeout: 15_000,
  });
// vCenter를 HAProxy로 중계하는 환경에서는 reload/방화벽 idle로 keep-alive 연결이 끊겨
// 죽은 소켓을 재사용하면 응답을 기다리다 타임아웃('operation was aborted due to timeout')한다.
// 유휴 소켓을 짧게 회수해 매 폴링마다 새 연결로 재접속하도록 한다(폴링 간격 << keepAlive면 영향 없음).
export const vcDispatcher = new Agent({
  connect: vcConnect,
  connectTimeout: 15_000,
  keepAliveTimeout: Number(process.env.VC_KEEPALIVE_MS) || 4_000,
  keepAliveMaxTimeout: 10_000,
  pipelining: 1,
});

export class VCenterClient {
  /**
   * @param {object} vc
   * @param {{signal?: AbortSignal}} [opts] signal — 수집 데드라인(v2.590). 만료되면 진행 중인 요청을 실제로 끊는다.
   */
  constructor(vc, { signal = null } = {}) {
    this.vc = vc;
    this.baseUrl = vc.host.replace(/\/+$/, '');
    this.session = null;
    this.signal = signal || null;
  }

  async #request(pathname, { method = 'GET', headers = {}, body, ignoreExternal = false } = {}) {
    const url = `${this.baseUrl}${pathname}`;
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.session ? { 'vmware-api-session-id': this.session } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      dispatcher: vcDispatcher, // vCenter 전용 TLS 정책(전역 오염 금지 — 감사 C1/C3)
      // per-vCenter 타임아웃 존중(고RTT 사이트가 15초에 abort되지 않게) — SOAP 경로와 동일 규칙.
      // v2.590: 수집 데드라인 신호도 함께 건다(결과만 포기하지 않고 요청을 실제로 끊는다 — v2.417).
      signal: vcRequestSignal(effectiveRequestTimeoutMs(this.vc?.timeoutMs, 15_000), ignoreExternal ? null : this.signal),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`${method} ${pathname} -> ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
      err.status = res.status; // v2.590: 판정은 호출부가 한다(login 의 401 만 자격증명 거부 — 아래 login())
      throw err;
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }

  async login() {
    const auth = Buffer.from(`${this.vc.username}:${this.vc.password}`).toString('base64');
    let data;
    try {
      data = await this.#request('/api/session', {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}` },
      });
    } catch (err) {
      // v2.590(감사 F1): **세션 생성의 401 만** 자격증명 거부다. 로그인 뒤 목록 조회의 401(세션 만료 등)이나
      // 403(로그인은 됐고 권한이 없다)은 잠금 경로가 아니라서 주기 수집을 멈추지 않는다(authGuard 규칙 4).
      if (err?.status === 401) err.authFailed = true;
      throw err;
    }
    // The API returns the session id either as a bare string or wrapped.
    this.session = typeof data === 'string' ? data.replace(/"/g, '') : data?.value || data;
    return this.session;
  }

  async logout() {
    if (!this.session) return;
    try {
      // 데드라인이 지난 뒤에도 세션은 정리한다(외부 신호 무시 · 건별 시한만) — 남기면 vCenter 세션 수를 먹는다.
      await this.#request('/api/session', { method: 'DELETE', ignoreExternal: true });
    } catch {
      /* best effort */
    }
    this.session = null;
  }

  listHosts() {
    return this.#request('/api/vcenter/host');
  }
  listClusters() {
    return this.#request('/api/vcenter/cluster');
  }
  listVms() {
    return this.#request('/api/vcenter/vm');
  }
  listDatastores() {
    return this.#request('/api/vcenter/datastore');
  }
  listNetworks() {
    return this.#request('/api/vcenter/network');
  }

  /** Detailed per-VM metrics (CPU/mem) — best-effort, may not be enabled. */
  getVm(vmId) {
    return this.#request(`/api/vcenter/vm/${vmId}`);
  }
}

/**
 * Collect a normalized snapshot from one real vCenter.
 *
 * Prefers the vim25 SOAP API (real CPU/memory/usage metrics); falls back to the
 * REST list endpoints (limited: no host CPU/mem usage) if SOAP is unavailable.
 * Returns the same shape the mock generator produces.
 */
// SOAP 실패를 'REST 로 폴백할 능력 부재(SOAP 미지원 vCenter)'와 '일시 오류(타임아웃·연결 끊김·
// 서버 5xx)'로 구분한다(v2.287, 확정 버그 #10). 일시 오류인데도 REST 로 폴백하면, REST 스냅샷은
// 호스트 CPU/메모리/전력/온도·VM IP/Tools/스냅샷·파생 알람이 전부 비어 있어(그리고 status:
// 'connected') 그 저품질 스냅샷이 직전 정상 SOAP 스냅샷을 ok:true 로 교체 → IPAM 대량 재기록·
// 알람 해소→재발송·용량 총합 급감이 조용히 일어난다. 일시 오류는 던져서 store 가 lastGood 을
// 유지하게 하고(#2), 능력 부재로 보이는 오류일 때만 REST 로 폴백한다.
function isTransientSoapError(err) {
  const m = `${err?.name || ''} ${err?.cause?.code || ''} ${err?.code || ''} ${err?.message || ''}`;
  return /Abort|Timeout|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|socket hang up|network|fetch failed|EPIPE|502|503|504/i.test(m);
}

/**
 * @param {object} vc
 * @param {{signal?: AbortSignal}} [opts] signal — 데드라인(v2.590). 만료되면 SOAP·REST 요청을 **실제로 끊는다**.
 */
export async function collectFromVCenter(vc, { signal = null } = {}) {
  if (config.vcSoapMetrics) {
    try {
      const { collectFromVCenterSoap } = await import('./soapClient.js');
      return await collectFromVCenterSoap(vc, { signal });
    } catch (err) {
      // v2.590(감사 F1): **자격증명 거부는 REST 로 폴백하지 않는다.** 예전에는 SOAP `InvalidLogin` 이
      // '일시 오류' 가 아니라서 '능력 부재' 로 분류돼 REST 로 **한 번 더 로그인**했다(주기당 실패 2회 —
      // 30초 주기면 1분에 4회). 같은 계정이라 결과는 같고 잠금만 앞당긴다. 화면에 남는 오류도 REST 의
      // `POST /api/session -> 401` 이라 진짜 원인(SOAP InvalidLogin)을 가렸다.
      if (isVcAuthError(err)) throw err;
      // 데드라인으로 끊긴 것은 폴백하지 않는다(REST 가 같은 신호로 즉시 끊긴다 — 헛 로그인만 남는다).
      if (signal?.aborted) throw err;
      if (isTransientSoapError(err)) {
        // 일시 오류 → 폴백 금지. 던지면 store 가 실패로 처리하되 마지막 정상 스냅샷을 유지한다.
        throw err;
      }
      // 능력 부재로 추정(SOAP 응답 형식 오류·미지원 등) → REST 목록 API 로 폴백(저품질이지만
      // SOAP 자체가 안 되는 환경에서는 그거라도 있는 게 낫다).
      console.warn(`[collect] SOAP metrics failed for ${vc.id} (${err.message}); falling back to REST list API`);
    }
  }
  return collectFromVCenterRest(vc, { signal });
}

async function collectFromVCenterRest(vc, { signal = null } = {}) {
  const client = new VCenterClient(vc, { signal });
  await client.login();
  try {
    // 핵심 목록(호스트/VM/데이터스토어)의 실패를 빈 배열로 삼키면 vCenter가 'connected'인데
    // VM 0대인 스냅샷이 정상처럼 유통돼 인벤토리/IPAM/집계가 오염된다(REST 목록은 무필터
    // 4000 VM 상한 초과 시에도 오류를 던짐). 핵심 목록 실패는 이 vCenter의 수집 실패로 던져
    // 상위(store)가 마지막 정상 캐시를 유지하게 한다. 부가 목록(네트워크/클러스터)만 관용.
    const [hosts, vms, datastores, networks, clusters] = await Promise.all([
      client.listHosts(),
      client.listVms(),
      client.listDatastores(),
      client.listNetworks().catch(() => []),
      client.listClusters().catch(() => []),
    ]);

    const clusterName = (ref) =>
      clusters.find((c) => c.cluster === ref)?.name || ref || 'standalone';
    const vmCountByHost = vms.reduce((acc, m) => {
      if (m.host) acc[m.host] = (acc[m.host] || 0) + 1;
      return acc;
    }, {});

    return {
      vcenter: {
        id: vc.id,
        name: vc.name,
        location: vc.location,
        status: 'connected',
        version: vc.version || 'unknown',
      },
      hosts: hosts.map((h) => ({
        id: `${vc.id}:${h.host}`,
        vcenterId: vc.id,
        name: h.name,
        cluster: clusterName(h.cluster),
        connectionState: (h.connection_state || '').toUpperCase() || 'CONNECTED',
        powerState: h.power_state,
        vmCount: vmCountByHost[h.host] || 0,
      })),
      vms: vms.map((m) => ({
        id: `${vc.id}:${m.vm}`,
        vcenterId: vc.id,
        name: m.name,
        powerState: m.power_state,
        cpuCount: m.cpu_count,
        memMB: m.memory_size_MiB,
      })),
      datastores: datastores.map((d) => {
        // 사용량/사용률은 '바이트' 기준으로 먼저 계산한 뒤 GB로 반올림한다 — capacity·free를 각각
        // GB로 반올림한 뒤 빼면 반올림 오차가 usedGB/usagePct에 누적된다.
        // v2.597(감사 C2597-08): free_space 가 없으면 사용량을 계산하지 않는다 — 0 으로 두면 사용률 100% 라는 거짓이 된다.
        const capBytes = d.capacity || 0;
        const freeBytes = d.free_space == null ? null : Number(d.free_space);
        const usedBytes = freeBytes == null || !Number.isFinite(freeBytes) ? null : Math.max(0, capBytes - freeBytes);
        const capacityGB = Math.round(capBytes / 1024 ** 3);
        const freeGB = usedBytes == null ? null : Math.round(freeBytes / 1024 ** 3);
        const usedGB = usedBytes == null ? null : Math.round(usedBytes / 1024 ** 3);
        return {
          id: `${vc.id}:${d.datastore}`,
          vcenterId: vc.id,
          name: d.name,
          type: d.type,
          capacityGB,
          freeGB,
          usedGB,
          usagePct: capBytes > 0 && usedBytes != null ? Math.round((usedBytes / capBytes) * 100) : null,
          accessible: typeof d.accessible === 'boolean' ? d.accessible : true, // REST 목록에 있으면 그 값(없으면 예전대로)
        };
      }),
      networks: networks.map((n) => ({
        id: `${vc.id}:${n.network}`,
        vcenterId: vc.id,
        name: n.name,
        type: n.type,
      })),
      alarms: [],
    };
  } finally {
    await client.logout();
  }
}
