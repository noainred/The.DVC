/**
 * Thin client for the VMware NSX (NSX-T / NSX 4.x) Manager REST API.
 *
 * NSX is managed by its own NSX Manager appliance (NOT by vCenter), so this is
 * a separate collector from the vCenter one. We use HTTP Basic auth against the
 * Policy API (/policy/api/v1) and the Manager API (/api/v1).
 *
 * Endpoints used:
 *   GET /api/v1/node                     -> appliance version
 *   GET /api/v1/cluster/status           -> management/control cluster health
 *   GET /api/v1/transport-nodes          -> host + edge transport nodes
 *   GET /policy/api/v1/infra/tier-0s     -> T0 gateways
 *   GET /policy/api/v1/infra/tier-1s     -> T1 gateways
 *   GET /policy/api/v1/infra/segments    -> overlay/VLAN segments
 *   GET /policy/api/v1/infra/domains/default/security-policies -> DFW policies
 *   GET /policy/api/v1/infra/domains/default/groups            -> security groups
 *
 * TLS verification reuses the global undici dispatcher configured for vCenter
 * (self-signed certs are common on private NSX appliances).
 */

import { Agent } from 'undici';
import { constants as cryptoConstants } from 'node:crypto';
import { config } from '../config.js';
import { withSsrfLookup } from '../util/ssrfLookup.js';
import { ensureNsxDial } from './proxy.js';
import { poolSettled } from '../util/pool.js'; // v2.579: 동시성 풀 단일 소스(util/pool.js) — 손으로 쓴 사본 제거
import { createAuthGuard } from '../util/authGuard.js';
import { effectiveRequestTimeoutMs } from '../vcenter/soapParse.js'; // v2.598 T2598-03 — 옛 저장값의 시한 상한
import { numOrNull } from '../util/numOrNull.js';
import { pushAll } from '../util/pushAll.js';

/**
 * NSX 주기 수집의 **인증 실패 정지**(v2.590 — 감사 F1, 계정 잠금 경로). 예전에는 `client.node()` 가 401/403 으로
 * 던져도 다음 30초 틱에 같은 계정으로 다시 로그인했다(NSX 의 API 잠금 정책에 걸리면 UI 로그인까지 막힌다).
 * 코어는 `util/authGuard.js` 하나다. 멈추는 것은 **신원 확인 호출(node)의 401/403** 뿐 — 하위 호출의 403 은
 * 로그인은 된 것(권한 부족)이라 잠금 경로가 아니고 각 절이 이미 빈 값으로 관용한다.
 * 여기(client.js)에 두는 이유: store.js(주기 수집)와 registry.js(연결 테스트 — 성공 시 해제)가 둘 다 쓰는데
 * 둘 중 하나에 두면 store ↔ registry 순환이 생긴다.
 */
export const nsxAuthGuard = createAuthGuard({ file: 'nsx-auth-stops.json' });
/** 오류가 NSX **자격증명 거부**인가(출처 `#get` 이 붙인 플래그만 본다). */
export const isNsxAuthError = (err) => !!(err && err.authFailed === true);

const norm = (s) => String(s || '').replace(/\/+$/, '');

/**
 * 목록 조회의 페이지 상한(v2.599 감사 C2599-05). NSX 목록 API 는 한 페이지(기본 1,000개)만 주고 다음 페이지는
 * 응답의 `cursor` 로 받는다. 예전에는 cursor 를 무시해 그룹·세그먼트·포트·전송 노드 개수가 **첫 페이지로 조용히**
 * 잘렸다. 상한까지 따라가고, 상한에 걸려 남은 페이지가 있으면 `truncated` 로 밝힌다(조용한 상한 금지).
 */
export const NSX_LIST_MAX_PAGES = Math.max(1, Number(process.env.NSX_LIST_MAX_PAGES) || 20);
/** 규칙을 조회하는 DFW 정책 수 상한(정책마다 GET 1회 — 고RTT 매니저 부하). 넘으면 개수를 밝힌다. */
export const NSX_DFW_POLICY_MAX = 60;
/** IDS 이벤트는 한 페이지(이 개수)만 받는다 — 닿으면 idsEventsTruncated 로 밝힌다(v2.603 COL-2603-05). */
export const IDS_EVENT_MAX = 200;

/**
 * cursor 페이징을 따라 목록 전체를 모은다(순수 — 페이지 조회 함수를 주입받는다).
 * @param {(path:string)=>Promise<any>} getPage
 * @returns {Promise<{results:any[], result_count:number|null, truncated:boolean, pages:number}>}
 *   result_count 는 장비가 보고한 전체 개수(없으면 null). 첫 페이지 실패는 그대로 던진다(호출부의 관용 규칙 유지).
 */
export async function listAllPages(getPage, pathname, { maxPages = NSX_LIST_MAX_PAGES } = {}) {
  const results = [];
  let cursor = null, pages = 0, count = null;
  do {
    const sep = pathname.includes('?') ? '&' : '?';
    const page = await getPage(cursor ? `${pathname}${sep}cursor=${encodeURIComponent(cursor)}` : pathname);
    pages += 1;
    if (Array.isArray(page?.results)) pushAll(results, page.results);
    const rc = Number(page?.result_count);
    if (count == null && page?.result_count != null && Number.isFinite(rc) && rc >= 0) count = rc;
    cursor = page?.cursor ? String(page.cursor) : null;
  } while (cursor && pages < maxPages);
  return { results, result_count: count, truncated: !!cursor, pages };
}

/** 목록의 개수 — 장비가 보고한 전체 개수(result_count)가 받은 것보다 크면 그것을 쓴다(v2.599). */
export const listCount = (l) => Math.max((l?.results || []).length, Number.isFinite(l?.result_count) ? l.result_count : 0);

// 보안: 과거엔 기본 분기가 '전역(미검증)' 디스패처에 기댔으나, 전역 디스패처가 검증 ON 기본으로
// 복원되면서(감사 C1/C3) NSX 전용 '로컬' 디스패처로 명시한다 — 자체서명 NSX 기본 동작은 그대로.
// 검증 여부: NSX_TLS_REJECT_UNAUTHORIZED=true 명시 또는 vCenter 전역 검증(VC_TLS_REJECT_
// UNAUTHORIZED=true)을 승계 — 검증 ON 배포에서 NSX만 조용히 무검증이 되지 않게 한다.
// 미검증일 때는 종전 전역 디스패처가 갖던 구형 TLS 호환(legacy 재협상·SECLEVEL)도 유지한다.
const nsxVerify = process.env.NSX_TLS_REJECT_UNAUTHORIZED === 'true' || config.rejectUnauthorized;
// v2.537: DNS 리바인딩(TOCTOU) 차단 — util/ssrfLookup.js 머리말. v2.506 배선(11곳)에서 빠져 있던 dispatcher.
// ⚠ 삼항 **양쪽**에 붙인다 — 검증 ON 배포에서만 훅이 빠지는 실수를 막기 위해 withSsrfLookup 으로 감싼다.
const nsxDispatcher = new Agent({
  connect: withSsrfLookup(nsxVerify ? { rejectUnauthorized: true } : {
    rejectUnauthorized: false,
    minVersion: config.vcTlsMinVersion,
    ciphers: config.vcTlsCiphers,
    secureOptions: cryptoConstants.SSL_OP_LEGACY_SERVER_CONNECT | cryptoConstants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION,
  }),
});

export class NsxClient {
  // dial(선택): { proxyHost, publicPort } — 주어지면 등록된 HAProxy frontend로 다이얼한다
  // (TCP 패스스루 → TLS는 NSX와 직접). 직접 연결이면 mgr.host 그대로 사용.
  constructor(mgr, dial = null) {
    this.mgr = mgr;
    this.baseUrl = dial?.proxyHost && dial?.publicPort
      ? `https://${dial.proxyHost}:${dial.publicPort}`
      : norm(mgr.host);
    this.viaProxy = !!(dial?.proxyHost && dial?.publicPort);
    this.auth = 'Basic ' + Buffer.from(`${mgr.username}:${mgr.password}`).toString('base64');
    this.timeoutMs = effectiveRequestTimeoutMs(mgr.timeoutMs, 20_000); // v2.598 T2598-03: 2^31ms 이상 저장값이 1ms abort 가 되지 않게
  }

  async #get(pathname) {
    const res = await fetch(`${this.baseUrl}${pathname}`, {
      headers: { Authorization: this.auth, Accept: 'application/json' },
      dispatcher: nsxDispatcher,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`GET ${pathname} -> ${res.status} ${res.statusText} ${text.slice(0, 160)}`);
      err.status = res.status; // v2.590: 자격증명 거부 판정은 신원 확인 호출(node)만 한다 — 아래 node()
      throw err;
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }

  /** cursor 페이징 목록(v2.599 C2599-05) — `listAllPages` 가 상한·truncated 를 소유한다. */
  #list(pathname) { return listAllPages((p) => this.#get(p), pathname); }

  /**
   * 신원 확인 호출 — 수집의 유일한 필수 호출이다. v2.590(감사 F1): 여기의 401·403 만 **자격증명 거부**로
   * 못 박는다(NSX Manager 는 틀린 Basic 자격증명에 403 "The credentials were incorrect or the account specified
   * has been locked" 도 준다). 하위 호출의 403 은 로그인은 된 것(권한 부족)이라 잠금 경로가 아니고 각 절이
   * 빈 값으로 관용한다 — 거기에 플래그를 붙이면 권한만 좁은 계정의 수집이 영구 정지된다.
   */
  async node() {
    try { return await this.#get('/api/v1/node'); }
    catch (err) {
      if (err?.status === 401 || err?.status === 403) err.authFailed = true;
      throw err;
    }
  }
  clusterStatus() { return this.#get('/api/v1/cluster/status'); }
  transportNodes() { return this.#list('/api/v1/transport-nodes'); }
  tier0s() { return this.#list('/policy/api/v1/infra/tier-0s'); }
  tier1s() { return this.#list('/policy/api/v1/infra/tier-1s'); }
  segments() { return this.#list('/policy/api/v1/infra/segments'); }
  segmentPorts(segmentId) { return this.#list(`/policy/api/v1/infra/segments/${encodeURIComponent(segmentId)}/ports`); }
  securityPolicies() { return this.#list('/policy/api/v1/infra/domains/default/security-policies'); }
  policyRules(policyId) { return this.#list(`/policy/api/v1/infra/domains/default/security-policies/${encodeURIComponent(policyId)}/rules`); }
  groups() { return this.#list('/policy/api/v1/infra/domains/default/groups'); }
  // 그룹의 실제(effective) 멤버 — 온디맨드 라이브 조회.
  groupVmMembers(groupId) { return this.#get(`/policy/api/v1/infra/domains/default/groups/${encodeURIComponent(groupId)}/members/virtual-machines`); }
  groupIpMembers(groupId) { return this.#get(`/policy/api/v1/infra/domains/default/groups/${encodeURIComponent(groupId)}/members/ip-addresses`); }
  // 분산 IDS/IPS — 활성 설정 + 최근 침입 이벤트(베스트에포트; 버전/NAPP에 따라 미지원일 수 있음).
  licenses() { return this.#get('/api/v1/licenses'); } // 라이선스 만료일 확인용(만료 epoch ms)
  idsConfig() { return this.#get('/policy/api/v1/infra/settings/firewall/security/intrusion-services'); }
  idsProfiles() { return this.#get('/policy/api/v1/infra/intrusion-service-profiles'); }
  idsEvents() { return this.#get(`/api/v1/intrusion-detection-system-events?page_size=${IDS_EVENT_MAX}`); }

  /** Login check — cheapest authenticated call. */
  async ping() { await this.node(); }
}

/**
 * Map an NSX cluster-status payload to a simple connected/degraded label.
 * v2.602(COL-2602-01): 조회가 **실패**했으면(failedList 표식 · null) 'connected' 가 아니라 'unknown'(판정 보류)이다 —
 *   예전에는 `.catch(() => null)` 뒤 여기서 'connected' 가 되어 모든 목록이 실패한 매니저를 '정상' 이라 말했다.
 *   응답은 왔는데 상태 필드가 없는 것(구버전 페이로드)은 예전대로 'connected' 다.
 */
export function clusterHealth(status) {
  if (status == null || status.failed) return 'unknown';
  const m = status?.mgmt_cluster_status?.status || status?.detailed_cluster_status?.overall_status;
  const c = status?.control_cluster_status?.status;
  const up = (v) => String(v || '').toUpperCase() === 'STABLE' || String(v || '').toUpperCase() === 'CONNECTED';
  if (m == null && c == null) return 'connected';
  return up(m) && (c == null || up(c)) ? 'connected' : 'degraded';
}

/**
 * 관리 클러스터 노드 수(v2.602 COL-2602-01). 조회 실패면 **모른다**(null) — 예전 `|| 1` 은 실패를 '노드 1대' 로 만들었다.
 * 응답은 왔지만 노드 목록 필드가 없으면(단일 노드 구버전 페이로드) 예전대로 1 이다.
 */
export function clusterNodeCount(cluster) {
  if (cluster == null || cluster.failed) return null;
  return (cluster?.mgmt_cluster_status?.online_nodes?.length) || (cluster?.detailed_cluster_status?.groups?.length) || 1;
}

/**
 * DFW 요약(순수, v2.599 감사 C2599-05). 정책 수는 **전체**(result_count 우선)이고 규칙 조회는 앞 NSX_DFW_POLICY_MAX 개뿐이다.
 * 규칙 수는 조회한 정책의 규칙 + 조회하지 않은 정책의 `rule_count` 합이다. 뺀 정책 중 rule_count 가 없는 것이 있거나
 * 규칙 페이지가 잘렸으면 `rulesPartial`(하한)로 밝힌다 — 부분 합을 전체라 말하지 않는다.
 */
export function firewallSummary({ pols, dfw, ruleSets = [] }) {
  // v2.600(감사 COL-2600-06): 정책 목록 조회 자체가 실패했으면 '정책 0개' 가 아니라 **모른다**(null)다.
  if (pols?.failed) return { policies: null, rules: null, failed: true };
  const all = pols?.results || [];
  const total = listCount(pols);
  const omitted = Math.max(0, total - dfw.length);
  let rules = dfw.reduce((a, p) => a + (p.ruleCount || 0), 0);
  let partial = !!ruleSets.truncated || !!pols?.truncated || total > all.length;
  // v2.603(감사 COL-2603-04): 규칙 조회에 실패한 정책(ruleSets[i] === null) — rule_count 가 없으면 그 정책의 규칙 수를 모른다
  //   (0 으로 더하면 부분 합을 전체라 말한다). 실패 개수는 rule_count 유무와 상관없이 밝힌다(규칙 표가 비어 있다).
  let rulesFailed = 0;
  for (let i = 0; i < dfw.length; i += 1) {
    if (ruleSets[i] !== null || !dfw[i]?.rulesFailed) continue;
    rulesFailed += 1;
    if (!dfw[i].ruleCountKnown) partial = true;
  }
  for (const p of all.slice(dfw.length)) {
    const rc = Number(p?.rule_count);
    if (p?.rule_count != null && Number.isFinite(rc)) rules += rc; else partial = true;
  }
  return {
    policies: total, rules,
    ...(omitted ? { policiesOmitted: omitted, policiesRuleLimit: NSX_DFW_POLICY_MAX } : {}),
    ...(partial ? { rulesPartial: true } : {}),
    ...(rulesFailed ? { rulesFailed } : {}),
    ...(pols?.truncated ? { truncated: true } : {}),
  };
}

/**
 * 목록 조회 실패의 표식(v2.600 감사 COL-2600-06). 예전에는 `.catch(() => ({ results: [] }))` 라 실패가(2페이지 이후 실패로
 * 1페이지까지 버려진 경우 포함) **'0개'** 가 됐고 스냅샷에 아무 표시도 없었다 — '실패는 0 이 아니다' 규약 위반.
 * 빈 결과는 유지하되(하위 map 이 그대로 돈다) `failed`·`error` 를 싣고, 매니저에 `listsFailed` 로 모은다.
 */
export function failedList(e) {
  return { results: [], failed: true, error: String(e?.message || e || '조회 실패').slice(0, 200) };
}

/** [[이름, 목록]...] 중 실패한 것 — { listsFailed:[이름], listFailReasons:{이름:사유} }. */
export function listFailures(pairs) {
  const failed = (pairs || []).filter(([, l]) => l?.failed);
  return {
    listsFailed: failed.map(([k]) => k),
    listFailReasons: Object.fromEntries(failed.map(([k, l]) => [k, l.error || ''])),
  };
}

/**
 * Collect a normalized NSX snapshot from one real NSX Manager. Each sub-call is
 * best-effort: a missing/forbidden endpoint degrades that section instead of
 * failing the whole manager. The identity call (node) must succeed.
 */
// 동시성 제한 실행기(인덱스 전달). 고RTT·다수 매니저에서 NSX API 과부하 방지.

export async function collectFromNsx(mgr) {
  const dial = await ensureNsxDial(mgr); // proxyId가 있으면 HAProxy 경유 다이얼 주소
  const client = new NsxClient(mgr, dial);
  const node = await client.node(); // throws if auth/host is wrong → manager unreachable
  const [cluster, tnodes, t0, t1, segs, pols, grps] = await Promise.all([
    client.clusterStatus().catch(failedList),   // v2.602(COL-2602-01): 실패는 null 이 아니라 표식 — '정상' 으로 둔갑하지 않게
    client.transportNodes().catch(failedList),
    client.tier0s().catch(failedList),
    client.tier1s().catch(failedList),
    client.segments().catch(failedList),
    client.securityPolicies().catch(failedList),
    client.groups().catch(failedList),
  ]);

  const tn = (tnodes.results || []).map((n) => ({
    id: `${mgr.id}:${n.id}`,
    managerId: mgr.id,
    name: n.display_name || n.id,
    type: /edge/i.test(n.resource_type || n.node_deployment_info?.resource_type || '') ? 'edge' : 'host',
    status: n.status || '',
  }));
  const mkGw = (arr, tier) => (arr.results || []).map((g) => ({
    id: `${mgr.id}:${g.id}`, managerId: mgr.id, name: g.display_name || g.id, tier,
    haMode: g.ha_mode || '', failoverMode: g.failover_mode || '',
  }));
  // Overlay vs VLAN is decided purely by the presence of vlan_ids (segment.type
  // in NSX is DISCONNECTED/ROUTED/EXTENDED, not Overlay/VLAN).
  const segments = (segs.results || []).map((s) => ({
    id: `${mgr.id}:${s.id}`, managerId: mgr.id, name: s.display_name || s.id,
    connectivity: (s.connectivity_path || '').split('/').pop() || '',
    vlanIds: s.vlan_ids || [],
    subnets: (s.subnets || []).map((x) => x.network || x.gateway_address).filter(Boolean),
    type: (s.vlan_ids?.length ? 'VLAN' : 'OVERLAY'),
    transportZone: (s.transport_zone_path || '').split('/').pop() || '',
    vmCount: null, ports: [], // 아래에서 세그먼트 포트(연결 vNIC)를 조회해 채움
  }));

  // 세그먼트별 연결 포트(=VM vNIC) 조회 → VM 수/포트 목록. NSX는 세그먼트에 VM 수를
  // 직접 주지 않으므로 포트를 세어야 한다. 매니저 부하를 위해 동시성 8로 제한.
  await poolSettled((segs.results || []), 8, async (s, idx) => {
    try {
      const r = await client.segmentPorts(s.id);
      const ports = (r.results || []).filter((p) => p.attachment && p.attachment.id);
      segments[idx].ports = ports.map((p) => (p.display_name || p.id).replace(/\.vmx.*$/, '')).slice(0, 50);
      segments[idx].vmCount = ports.length;
      if (r.truncated) segments[idx].portsTruncated = true; // v2.599: 페이지 상한에 걸려 vmCount 는 하한이다
    } catch { /* 권한/미지원 시 null 유지(=미조회) */ }
  });

  // Pull the actual DFW rules for each policy so the UI can browse them. 세그먼트 포트 조회와
  // 동일하게 동시성 8로 제한 — 무제한 Promise.all(최대 60 동시)은 고RTT 매니저를 과부하시킨다.
  // v2.599(감사 C2599-05): 예전에는 60개로 **조용히** 잘랐다 — 규칙 조회 상한은 유지하되 전체 정책 수와 뺀 개수를 밝힌다.
  const allPolicies = pols.results || [];
  const policies = allPolicies.slice(0, NSX_DFW_POLICY_MAX);
  const ruleSets = new Array(policies.length).fill(null);
  await poolSettled(policies, 8, async (p, i) => {
    try {
      const r = await client.policyRules(p.id);
      ruleSets[i] = r.results || [];
      if (r.truncated) ruleSets.truncated = (ruleSets.truncated || 0) + 1;
    } catch { ruleSets[i] = null; }
  });
  const dfw = policies.map((p, i) => {
    const rawRules = ruleSets[i] != null ? ruleSets[i] : [];
    const rules = rawRules.map((r) => ({
      id: `${mgr.id}:${r.id}`, managerId: mgr.id, policy: p.display_name || p.id,
      name: r.display_name || r.id,
      sources: (r.source_groups || []).map(shortGroup),
      destinations: (r.destination_groups || []).map(shortGroup),
      services: (r.services || []).map(shortGroup),
      action: r.action || '', direction: r.direction || 'IN_OUT',
      appliedTo: (r.scope || []).map(shortGroup).join(', ') || 'DFW',
      enabled: !r.disabled,
      logged: r.logged === true,                              // 로깅 on/off
      ipProtocol: r.ip_protocol || 'IPV4_IPV6',
      category: p.category || '',
      sequence: r.sequence_number ?? null,
      notes: r.notes || '',
    }));
    // v2.603(감사 COL-2603-04): 규칙 조회 실패는 '규칙 0개' 가 아니다 — rulesFailed 로 밝히고, rule_count 도 없으면 수는 null.
    const failed = ruleSets[i] === null;
    const known = p.rule_count != null && Number.isFinite(Number(p.rule_count));
    return {
      id: `${mgr.id}:${p.id}`, managerId: mgr.id, name: p.display_name || p.id,
      category: p.category || '', ruleCount: known ? Number(p.rule_count) : (failed ? null : rules.length), rules,
      ...(failed ? { rulesFailed: true, ruleCountKnown: known } : {}),
    };
  });
  const firewall = firewallSummary({ pols, dfw, ruleSets });

  const securityGroups = (grps.results || []).map((g) => ({
    id: `${mgr.id}:${g.id}`, managerId: mgr.id, name: g.display_name || g.id,
    memberType: (g.expression || []).map((e) => e.member_type || e.resource_type).filter(Boolean)[0] || 'Mixed',
    memberCount: null, members: [], memberIps: [],
    criteria: (g.expression || []).map(exprText).filter(Boolean).join(' ') || '—',
  }));

  // 분산 IDS/IPS(베스트에포트) — 활성 여부 + 프로파일 수 + 최근 침입 이벤트. 라이선스도 함께.
  const [idsCfg, idsProf, idsEv, licRes] = await Promise.all([
    client.idsConfig().catch(() => null),
    // v2.603(감사 COL-2603-05): 실패는 빈 목록이 아니라 표식이다(failedList — listsFailed 로 밝힌다).
    client.idsProfiles().catch(failedList),
    client.idsEvents().catch(failedList),
    client.licenses().catch(failedList),
  ]);
  // NSX 라이선스(만료일) — 특수기능 '라이선스 만료일 확인'용. 키는 마스킹해 저장.
  const licenses = (licRes?.results || []).map((l) => {
    const k = String(l.license_key || '');
    return {
      key: k ? `${k.slice(0, 5)}-…-${k.slice(-5)}` : '',
      description: l.description || '',
      expiry: Number(l.expiry) > 0 ? Number(l.expiry) : null, // epoch ms, 없으면 영구
      isExpired: l.is_expired === true,
      quantity: l.quantity ?? null,
      capacityType: l.capacity_type || '',
    };
  });
  // v2.603(감사 COL-2603-05): 이벤트는 page_size=200 한 페이지뿐이다 — 200건에 닿았거나 전체 수가 더 크면 하한이다.
  const evRaw = idsEv?.results || [];
  const evTotal = numOrNull(idsEv?.result_count);
  const idsEventsTruncated = !idsEv?.failed && (evRaw.length >= IDS_EVENT_MAX || (evTotal != null && evTotal > Math.min(evRaw.length, IDS_EVENT_MAX)));
  const ids = {
    enabled: idsCfg ? (idsCfg.ids_enabled ?? idsCfg.enabled ?? null) : null,
    profiles: idsProf?.failed ? null : (idsProf?.results || []).length,
    ...(idsEv?.failed ? { eventsFailed: true } : {}),
    ...(idsEventsTruncated ? { eventsTruncated: true, eventsLimit: IDS_EVENT_MAX, ...(evTotal != null ? { eventsTotal: evTotal } : {}) } : {}),
    events: evRaw.slice(0, IDS_EVENT_MAX).map((e) => ({
      id: `${mgr.id}:${e.id || e.event_id || Math.random().toString(36).slice(2)}`,
      managerId: mgr.id, managerName: mgr.name,
      signature: e.signature_name || e.signature_id || e.title || '(시그니처 미상)',
      severity: String(e.severity || e.impact || '').toLowerCase() || 'unknown',
      src: e.source_ip || e.src_ip || '', dst: e.destination_ip || e.dst_ip || '',
      action: e.ids_action || e.action || '', at: e.last_event_time || e.event_time || e.create_time || null,
      count: e.event_count || 1,
    })),
  };

  return {
    manager: {
      id: mgr.id, name: mgr.name, host: mgr.host, region: mgr.location?.region || '', vcenterId: mgr.vcenterId || '',
      status: clusterHealth(cluster), version: node?.node_version || node?.product_version || 'unknown',
      nodeCount: clusterNodeCount(cluster),
      idsEnabled: ids.enabled, idsProfiles: ids.profiles, idsEventCount: idsEv?.failed ? null : ids.events.length,
      ...(idsEventsTruncated ? { idsEventsTruncated: true } : {}),
      licenses, // 만료일 확인용 — store.merge가 manager 필드로 그대로 실어 나른다
      // v2.599(감사 C2599-05): 페이지 상한에 걸려 끝까지 받지 못한 목록 — 그 개수는 하한이다(조용한 상한 금지).
      listsTruncated: [['transportNodes', tnodes], ['tier0s', t0], ['tier1s', t1], ['segments', segs], ['securityPolicies', pols], ['groups', grps]]
        .filter(([, l]) => l?.truncated).map(([k]) => k),
      // v2.600(감사 COL-2600-06): 조회에 실패한 목록 — 그 개수는 0 이 아니라 확인 불가다.
      //   v2.602(COL-2602-01): 클러스터 상태 조회 실패도 같은 목록으로 밝힌다(화면이 사유를 말할 수 있게).
      ...listFailures([['clusterStatus', cluster], ['transportNodes', tnodes], ['tier0s', t0], ['tier1s', t1], ['segments', segs], ['securityPolicies', pols], ['groups', grps],
        ['idsProfiles', idsProf], ['idsEvents', idsEv], ['licenses', licRes]]),
    },
    gateways: [...mkGw(t0, 'T0'), ...mkGw(t1, 'T1')],
    segments,
    transportNodes: tn,
    firewall,
    groups: grps?.failed ? null : listCount(grps),   // v2.600(COL-2600-06): 조회 실패는 0 이 아니라 null

    dfw, securityGroups, ids,
  };
}

// NSX policy paths look like /infra/domains/default/groups/web → show the leaf.
const shortGroup = (s) => String(s || '').split('/').pop() || String(s || '');

/**
 * On-demand: 한 NSX 그룹의 실제(effective) 멤버를 라이브 조회한다.
 * VM 멤버 + IP 멤버를 모두 가져와 정규화. 둘 다 실패하면 throw.
 */
export async function fetchGroupMembers(mgr, groupId) {
  const dial = await ensureNsxDial(mgr);
  const client = new NsxClient(mgr, dial);
  const [vmRes, ipRes] = await Promise.all([
    client.groupVmMembers(groupId).catch((e) => ({ __err: e.message })),
    client.groupIpMembers(groupId).catch((e) => ({ __err: e.message })),
  ]);
  const vms = (vmRes && Array.isArray(vmRes.results) ? vmRes.results : []).map((v) => ({
    name: v.display_name || v.name || v.external_id || '(이름없음)',
    os: v.guest_info?.os_name || v.os_name || '',
    powerState: v.power_state || '',
    ips: (v.guest_info?.ip_addresses) || [],
  }));
  const ips = (ipRes && Array.isArray(ipRes.results)) ? ipRes.results : [];
  if (vmRes?.__err && ipRes?.__err) throw new Error(vmRes.__err);
  return { vmCount: vms.length, vms: vms.slice(0, 500), ipCount: ips.length, ips: ips.slice(0, 1000) };
}

function exprText(e) {
  if (!e) return '';
  if (e.resource_type === 'Condition') return `${e.key || ''} ${e.operator || ''} ${e.value || ''}`.trim();
  if (e.resource_type === 'IPAddressExpression') return `IP(${(e.ip_addresses || []).slice(0, 3).join(',')}…)`;
  if (e.resource_type === 'PathExpression') return `Members(${(e.paths || []).length})`;
  if (e.conjunction_operator) return e.conjunction_operator;
  return e.resource_type || '';
}
