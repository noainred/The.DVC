import { Agent, setGlobalDispatcher } from 'undici';
import { constants as cryptoConstants } from 'node:crypto';
import { config } from '../config.js';

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

// Configure a global dispatcher tuned for older vCenter TLS stacks. Many
// appliances negotiate legacy TLS versions/ciphers (or legacy renegotiation)
// that OpenSSL 3 rejects by default, which surfaces as "Client network socket
// disconnected before secure TLS connection was established". We therefore
// allow older TLS and lower the security level when cert verification is off.
if (!config.rejectUnauthorized) {
  const connect = {
    rejectUnauthorized: false,
    minVersion: config.vcTlsMinVersion,           // default TLSv1
    ciphers: config.vcTlsCiphers,                 // default DEFAULT@SECLEVEL=0
    secureOptions:
      cryptoConstants.SSL_OP_LEGACY_SERVER_CONNECT |
      cryptoConstants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION,
    timeout: 15_000,
  };
  // vCenter를 HAProxy로 중계하는 환경에서는 reload/방화벽 idle로 keep-alive 연결이 끊겨
  // 죽은 소켓을 재사용하면 응답을 기다리다 타임아웃('operation was aborted due to timeout')한다.
  // 유휴 소켓을 짧게 회수해 매 폴링마다 새 연결로 재접속하도록 한다(폴링 간격 << keepAlive면 영향 없음).
  setGlobalDispatcher(new Agent({
    connect,
    connectTimeout: 15_000,
    keepAliveTimeout: Number(process.env.VC_KEEPALIVE_MS) || 4_000,
    keepAliveMaxTimeout: 10_000,
    pipelining: 1,
  }));
}

export class VCenterClient {
  constructor(vc) {
    this.vc = vc;
    this.baseUrl = vc.host.replace(/\/+$/, '');
    this.session = null;
  }

  async #request(pathname, { method = 'GET', headers = {}, body } = {}) {
    const url = `${this.baseUrl}${pathname}`;
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.session ? { 'vmware-api-session-id': this.session } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      // per-vCenter 타임아웃 존중(고RTT 사이트가 15초에 abort되지 않게) — SOAP 경로와 동일 규칙.
      signal: AbortSignal.timeout(this.vc?.timeoutMs > 0 ? this.vc.timeoutMs : 15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} ${pathname} -> ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }

  async login() {
    const auth = Buffer.from(`${this.vc.username}:${this.vc.password}`).toString('base64');
    const data = await this.#request('/api/session', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}` },
    });
    // The API returns the session id either as a bare string or wrapped.
    this.session = typeof data === 'string' ? data.replace(/"/g, '') : data?.value || data;
    return this.session;
  }

  async logout() {
    if (!this.session) return;
    try {
      await this.#request('/api/session', { method: 'DELETE' });
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
export async function collectFromVCenter(vc) {
  if (config.vcSoapMetrics) {
    try {
      const { collectFromVCenterSoap } = await import('./soapClient.js');
      return await collectFromVCenterSoap(vc);
    } catch (err) {
      console.warn(`[collect] SOAP metrics failed for ${vc.id} (${err.message}); falling back to REST list API`);
    }
  }
  return collectFromVCenterRest(vc);
}

async function collectFromVCenterRest(vc) {
  const client = new VCenterClient(vc);
  await client.login();
  try {
    const [hosts, vms, datastores, networks, clusters] = await Promise.all([
      client.listHosts().catch(() => []),
      client.listVms().catch(() => []),
      client.listDatastores().catch(() => []),
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
        const capacityGB = Math.round((d.capacity || 0) / 1024 ** 3);
        const freeGB = Math.round((d.free_space || 0) / 1024 ** 3);
        const usedGB = Math.max(0, capacityGB - freeGB);
        return {
          id: `${vc.id}:${d.datastore}`,
          vcenterId: vc.id,
          name: d.name,
          type: d.type,
          capacityGB,
          freeGB,
          usedGB,
          usagePct: capacityGB > 0 ? Math.round((usedGB / capacityGB) * 100) : 0,
          accessible: true,
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
