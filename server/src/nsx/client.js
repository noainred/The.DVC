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
  }));
  const mkGw = (arr, tier) => (arr.results || []).map((g) => ({
    id: `${mgr.id}:${g.id}`, managerId: mgr.id, name: g.display_name || g.id, tier,
    haMode: g.ha_mode || '', failoverMode: g.failover_mode || '',
  }));
  const segments = (segs.results || []).map((s) => ({
    id: `${mgr.id}:${s.id}`, managerId: mgr.id, name: s.display_name || s.id,
    connectivity: (s.connectivity_path || '').split('/').pop() || '',
    vlanIds: s.vlan_ids || [],
    subnets: (s.subnets || []).map((x) => x.network || x.gateway_address).filter(Boolean),
    type: s.type || (s.vlan_ids?.length ? 'VLAN' : 'OVERLAY'),
  }));
  const dfwRules = (pols.results || []).reduce((a, p) => a + (p.rule_count ?? (p.rules?.length || 0)), 0);

  return {
    manager: {
      id: mgr.id, name: mgr.name, host: mgr.host, region: mgr.location?.region || '', vcenterId: mgr.vcenterId || '',
      status: clusterHealth(cluster), version: node?.node_version || node?.product_version || 'unknown',
      nodeCount: (cluster?.mgmt_cluster_status?.online_nodes?.length) || (cluster?.detailed_cluster_status?.groups?.length) || 1,
    },
    gateways: [...mkGw(t0, 'T0'), ...mkGw(t1, 'T1')],
    segments,
    transportNodes: tn,
    firewall: { policies: (pols.results || []).length, rules: dfwRules },
    groups: (grps.results || []).length,
  };
}
