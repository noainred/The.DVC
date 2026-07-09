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
import { ensureNsxDial } from './proxy.js';

const norm = (s) => String(s || '').replace(/\/+$/, '');

// 보안(H1): NSX는 자체서명이 흔해 기본은 전역(미검증) 디스패처를 따른다(현행 유지 — 무회귀).
// 검증이 필요한 환경은 NSX_TLS_REJECT_UNAUTHORIZED=true로 검증 디스패처를 켜 MITM(관리자 Basic 자격증명 탈취)을 막는다.
const nsxVerifyDispatcher = process.env.NSX_TLS_REJECT_UNAUTHORIZED === 'true'
  ? new Agent({ connect: { rejectUnauthorized: true } })
  : null;

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
    this.timeoutMs = mgr.timeoutMs > 0 ? mgr.timeoutMs : 20_000;
  }

  async #get(pathname) {
    const res = await fetch(`${this.baseUrl}${pathname}`, {
      headers: { Authorization: this.auth, Accept: 'application/json' },
      ...(nsxVerifyDispatcher ? { dispatcher: nsxVerifyDispatcher } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GET ${pathname} -> ${res.status} ${res.statusText} ${text.slice(0, 160)}`);
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }

  node() { return this.#get('/api/v1/node'); }
  clusterStatus() { return this.#get('/api/v1/cluster/status'); }
  transportNodes() { return this.#get('/api/v1/transport-nodes'); }
  tier0s() { return this.#get('/policy/api/v1/infra/tier-0s'); }
  tier1s() { return this.#get('/policy/api/v1/infra/tier-1s'); }
  segments() { return this.#get('/policy/api/v1/infra/segments'); }
  segmentPorts(segmentId) { return this.#get(`/policy/api/v1/infra/segments/${encodeURIComponent(segmentId)}/ports`); }
  securityPolicies() { return this.#get('/policy/api/v1/infra/domains/default/security-policies'); }
  policyRules(policyId) { return this.#get(`/policy/api/v1/infra/domains/default/security-policies/${encodeURIComponent(policyId)}/rules`); }
  groups() { return this.#get('/policy/api/v1/infra/domains/default/groups'); }
  // 그룹의 실제(effective) 멤버 — 온디맨드 라이브 조회.
  groupVmMembers(groupId) { return this.#get(`/policy/api/v1/infra/domains/default/groups/${encodeURIComponent(groupId)}/members/virtual-machines`); }
  groupIpMembers(groupId) { return this.#get(`/policy/api/v1/infra/domains/default/groups/${encodeURIComponent(groupId)}/members/ip-addresses`); }
  // 분산 IDS/IPS — 활성 설정 + 최근 침입 이벤트(베스트에포트; 버전/NAPP에 따라 미지원일 수 있음).
  idsConfig() { return this.#get('/policy/api/v1/infra/settings/firewall/security/intrusion-services'); }
  idsProfiles() { return this.#get('/policy/api/v1/infra/intrusion-service-profiles'); }
  idsEvents() { return this.#get('/api/v1/intrusion-detection-system-events?page_size=200'); }

  /** Login check — cheapest authenticated call. */
  async ping() { await this.node(); }
}

/** Map an NSX cluster-status payload to a simple connected/degraded label. */
function clusterHealth(status) {
  const m = status?.mgmt_cluster_status?.status || status?.detailed_cluster_status?.overall_status;
  const c = status?.control_cluster_status?.status;
  const up = (v) => String(v || '').toUpperCase() === 'STABLE' || String(v || '').toUpperCase() === 'CONNECTED';
  if (m == null && c == null) return 'connected';
  return up(m) && (c == null || up(c)) ? 'connected' : 'degraded';
}

/**
 * Collect a normalized NSX snapshot from one real NSX Manager. Each sub-call is
 * best-effort: a missing/forbidden endpoint degrades that section instead of
 * failing the whole manager. The identity call (node) must succeed.
 */
// 동시성 제한 실행기(인덱스 전달). 고RTT·다수 매니저에서 NSX API 과부하 방지.
async function eachLimited(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (i < items.length) { const idx = i++; try { await fn(items[idx], idx); } catch { /* isolated */ } }
  });
  await Promise.all(workers);
}

export async function collectFromNsx(mgr) {
  const dial = await ensureNsxDial(mgr); // proxyId가 있으면 HAProxy 경유 다이얼 주소
  const client = new NsxClient(mgr, dial);
  const node = await client.node(); // throws if auth/host is wrong → manager unreachable
  const [cluster, tnodes, t0, t1, segs, pols, grps] = await Promise.all([
    client.clusterStatus().catch(() => null),
    client.transportNodes().catch(() => ({ results: [] })),
    client.tier0s().catch(() => ({ results: [] })),
    client.tier1s().catch(() => ({ results: [] })),
    client.segments().catch(() => ({ results: [] })),
    client.securityPolicies().catch(() => ({ results: [] })),
    client.groups().catch(() => ({ results: [] })),
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
  await eachLimited((segs.results || []), 8, async (s, idx) => {
    try {
      const r = await client.segmentPorts(s.id);
      const ports = (r.results || []).filter((p) => p.attachment && p.attachment.id);
      segments[idx].ports = ports.map((p) => (p.display_name || p.id).replace(/\.vmx.*$/, '')).slice(0, 50);
      segments[idx].vmCount = ports.length;
    } catch { /* 권한/미지원 시 null 유지(=미조회) */ }
  });

  // Pull the actual DFW rules for each policy so the UI can browse them. 세그먼트 포트 조회와
  // 동일하게 동시성 8로 제한 — 무제한 Promise.all(최대 60 동시)은 고RTT 매니저를 과부하시킨다.
  const policies = (pols.results || []).slice(0, 60);
  const ruleSets = new Array(policies.length).fill(null);
  await eachLimited(policies, 8, async (p, i) => {
    try { ruleSets[i] = (await client.policyRules(p.id)).results || []; } catch { ruleSets[i] = null; }
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
    return {
      id: `${mgr.id}:${p.id}`, managerId: mgr.id, name: p.display_name || p.id,
      category: p.category || '', ruleCount: p.rule_count ?? rules.length, rules,
    };
  });
  const dfwRules = dfw.reduce((a, p) => a + (p.ruleCount || 0), 0);

  const securityGroups = (grps.results || []).map((g) => ({
    id: `${mgr.id}:${g.id}`, managerId: mgr.id, name: g.display_name || g.id,
    memberType: (g.expression || []).map((e) => e.member_type || e.resource_type).filter(Boolean)[0] || 'Mixed',
    memberCount: null, members: [], memberIps: [],
    criteria: (g.expression || []).map(exprText).filter(Boolean).join(' ') || '—',
  }));

  // 분산 IDS/IPS(베스트에포트) — 활성 여부 + 프로파일 수 + 최근 침입 이벤트.
  const [idsCfg, idsProf, idsEv] = await Promise.all([
    client.idsConfig().catch(() => null),
    client.idsProfiles().catch(() => ({ results: [] })),
    client.idsEvents().catch(() => ({ results: [] })),
  ]);
  const ids = {
    enabled: idsCfg ? (idsCfg.ids_enabled ?? idsCfg.enabled ?? null) : null,
    profiles: (idsProf?.results || []).length,
    events: (idsEv?.results || []).slice(0, 200).map((e) => ({
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
      nodeCount: (cluster?.mgmt_cluster_status?.online_nodes?.length) || (cluster?.detailed_cluster_status?.groups?.length) || 1,
      idsEnabled: ids.enabled, idsProfiles: ids.profiles, idsEventCount: ids.events.length,
    },
    gateways: [...mkGw(t0, 'T0'), ...mkGw(t1, 'T1')],
    segments,
    transportNodes: tn,
    firewall: { policies: dfw.length, rules: dfwRules },
    groups: (grps.results || []).length,
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
