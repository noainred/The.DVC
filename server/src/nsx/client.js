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

const norm = (s) => String(s || '').replace(/\/+$/, '');

export class NsxClient {
  constructor(mgr) {
    this.mgr = mgr;
    this.baseUrl = norm(mgr.host);
    this.auth = 'Basic ' + Buffer.from(`${mgr.username}:${mgr.password}`).toString('base64');
    this.timeoutMs = mgr.timeoutMs > 0 ? mgr.timeoutMs : 20_000;
  }

  async #get(pathname) {
    const res = await fetch(`${this.baseUrl}${pathname}`, {
      headers: { Authorization: this.auth, Accept: 'application/json' },
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
  securityPolicies() { return this.#get('/policy/api/v1/infra/domains/default/security-policies'); }
  policyRules(policyId) { return this.#get(`/policy/api/v1/infra/domains/default/security-policies/${encodeURIComponent(policyId)}/rules`); }
  groups() { return this.#get('/policy/api/v1/infra/domains/default/groups'); }

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
export async function collectFromNsx(mgr) {
  const client = new NsxClient(mgr);
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
  }));

  // Pull the actual DFW rules for each policy (bounded) so the UI can browse them.
  const policies = (pols.results || []).slice(0, 60);
  const ruleSets = await Promise.all(policies.map((p) =>
    client.policyRules(p.id).then((r) => r.results || []).catch(() => null)));
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

  return {
    manager: {
      id: mgr.id, name: mgr.name, host: mgr.host, region: mgr.location?.region || '', vcenterId: mgr.vcenterId || '',
      status: clusterHealth(cluster), version: node?.node_version || node?.product_version || 'unknown',
      nodeCount: (cluster?.mgmt_cluster_status?.online_nodes?.length) || (cluster?.detailed_cluster_status?.groups?.length) || 1,
    },
    gateways: [...mkGw(t0, 'T0'), ...mkGw(t1, 'T1')],
    segments,
    transportNodes: tn,
    firewall: { policies: dfw.length, rules: dfwRules },
    groups: (grps.results || []).length,
    dfw, securityGroups,
  };
}

// NSX policy paths look like /infra/domains/default/groups/web → show the leaf.
const shortGroup = (s) => String(s || '').split('/').pop() || String(s || '');
function exprText(e) {
  if (!e) return '';
  if (e.resource_type === 'Condition') return `${e.key || ''} ${e.operator || ''} ${e.value || ''}`.trim();
  if (e.resource_type === 'IPAddressExpression') return `IP(${(e.ip_addresses || []).slice(0, 3).join(',')}…)`;
  if (e.resource_type === 'PathExpression') return `Members(${(e.paths || []).length})`;
  if (e.conjunction_operator) return e.conjunction_operator;
  return e.resource_type || '';
}
