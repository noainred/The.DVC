/**
 * vim25 SOAP collector — gathers REAL host/VM/datastore metrics that the
 * vSphere REST list endpoints do not expose (CPU/memory capacity & live usage,
 * datastore used space, per-VM usage). This is the same API (PropertyCollector)
 * that pyVmomi/govmomi-based monitoring tools use.
 *
 * Built with the standard library only: HTTP(S) via global fetch, hand-built
 * SOAP envelopes, and defensive regex parsing of the responses. TLS verification
 * follows the global dispatcher configured in restClient.js (self-signed OK).
 */

import { config } from '../config.js';

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const ENVELOPE = (body) =>
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ` +
  `xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
  `<soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;

export class VimSoapClient {
  constructor(vc) {
    this.vc = vc;
    this.url = `${vc.host.replace(/\/+$/, '')}/sdk`;
    this.cookie = null;
    this.sc = null; // service content refs
  }

  async #call(body) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: '"urn:vim25/8.0.0.1"',
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      body: ENVELOPE(body),
      signal: AbortSignal.timeout(30_000),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const text = await res.text();
    if (!res.ok) {
      const fault = /<faultstring>([^<]*)<\/faultstring>/.exec(text);
      throw new Error(`SOAP ${res.status}: ${fault ? fault[1] : text.slice(0, 160)}`);
    }
    return text;
  }

  async retrieveServiceContent() {
    const xml = await this.#call(
      `<RetrieveServiceContent xmlns="urn:vim25"><_this type="ServiceInstance">ServiceInstance</_this></RetrieveServiceContent>`
    );
    const pick = (tag) => new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`).exec(xml)?.[1];
    this.sc = {
      propertyCollector: pick('propertyCollector'),
      rootFolder: pick('rootFolder'),
      viewManager: pick('viewManager'),
      sessionManager: pick('sessionManager'),
      version: pick('version'),
    };
    if (!this.sc.propertyCollector) throw new Error('RetrieveServiceContent failed');
    return this.sc;
  }

  async login() {
    if (!this.sc) await this.retrieveServiceContent();
    await this.#call(
      `<Login xmlns="urn:vim25"><_this type="SessionManager">${this.sc.sessionManager}</_this>` +
      `<userName>${esc(this.vc.username)}</userName><password>${esc(this.vc.password)}</password></Login>`
    );
  }

  async logout() {
    if (!this.sc?.sessionManager) return;
    try {
      await this.#call(`<Logout xmlns="urn:vim25"><_this type="SessionManager">${this.sc.sessionManager}</_this></Logout>`);
    } catch { /* best effort */ }
  }

  async createContainerView(types) {
    const typeXml = types.map((t) => `<type>${t}</type>`).join('');
    const xml = await this.#call(
      `<CreateContainerView xmlns="urn:vim25"><_this type="ViewManager">${this.sc.viewManager}</_this>` +
      `<container type="Folder">${this.sc.rootFolder}</container>${typeXml}<recursive>true</recursive></CreateContainerView>`
    );
    const ref = /<returnval type="ContainerView">([^<]+)<\/returnval>/.exec(xml)?.[1];
    if (!ref) throw new Error('CreateContainerView failed');
    return ref;
  }

  /** RetrieveProperties for several types through a container view. */
  async retrieveProperties(viewRef, specs) {
    const propSets = specs.map((s) =>
      `<propSet><type>${s.type}</type>${s.paths.map((p) => `<pathSet>${p}</pathSet>`).join('')}</propSet>`
    ).join('');
    const body =
      `<RetrieveProperties xmlns="urn:vim25"><_this type="PropertyCollector">${this.sc.propertyCollector}</_this>` +
      `<specSet>${propSets}` +
      `<objectSet><obj type="ContainerView">${viewRef}</obj><skip>true</skip>` +
      `<selectSet xsi:type="TraversalSpec"><name>view</name><type>ContainerView</type><path>view</path><skip>false</skip></selectSet>` +
      `</objectSet></specSet></RetrieveProperties>`;
    const xml = await this.#call(body);
    return parseObjectContent(xml);
  }
}

/** Parse RetrieveProperties response into [{type, ref, props:{path:value}}]. */
export function parseObjectContent(xml) {
  const out = [];
  const objRe = /<returnval>([\s\S]*?)<\/returnval>/g;
  let m;
  while ((m = objRe.exec(xml))) {
    const block = m[1];
    const objM = /<obj type="([^"]+)">([^<]+)<\/obj>/.exec(block);
    if (!objM) continue;
    const props = {};
    const psRe = /<propSet>\s*<name>([^<]+)<\/name>\s*<val[^>]*>([\s\S]*?)<\/val>\s*<\/propSet>/g;
    let p;
    while ((p = psRe.exec(block))) {
      props[p[1]] = p[2];
    }
    out.push({ type: objM[1], ref: objM[2], props });
  }
  return out;
}

const num = (v) => (v == null || v === '' ? 0 : Number(v) || 0);
const pct = (used, total) => (total > 0 ? Math.round((used / total) * 100) : 0);

/**
 * Collect a normalized snapshot (same shape as the mock generator) from one
 * vCenter via SOAP. Throws on connection/login failure so the caller can fall
 * back to the REST collector.
 */
export async function collectFromVCenterSoap(vc) {
  const c = new VimSoapClient(vc);
  await c.login();
  try {
    const view = await c.createContainerView([
      'HostSystem', 'VirtualMachine', 'Datastore', 'ClusterComputeResource',
      'Network', 'DistributedVirtualPortgroup',
    ]);
    const objs = await c.retrieveProperties(view, [
      { type: 'ClusterComputeResource', paths: ['name'] },
      { type: 'HostSystem', paths: [
        'name', 'parent', 'runtime.connectionState', 'runtime.powerState', 'runtime.inMaintenanceMode',
        'summary.hardware.numCpuCores', 'summary.hardware.cpuMhz', 'summary.hardware.memorySize',
        'summary.quickStats.overallCpuUsage', 'summary.quickStats.overallMemoryUsage'] },
      { type: 'VirtualMachine', paths: [
        'name', 'runtime.host', 'runtime.powerState', 'summary.config.numCpu', 'summary.config.memorySizeMB',
        'summary.config.guestFullName', 'summary.quickStats.overallCpuUsage', 'summary.quickStats.guestMemoryUsage',
        'summary.storage.committed', 'guest.ipAddress', 'guest.toolsRunningStatus'] },
      { type: 'Datastore', paths: ['name', 'summary.type', 'summary.capacity', 'summary.freeSpace', 'summary.accessible'] },
      { type: 'Network', paths: ['name'] },
      { type: 'DistributedVirtualPortgroup', paths: ['name'] },
    ]);

    const clusterName = new Map();
    for (const o of objs) if (o.type === 'ClusterComputeResource') clusterName.set(o.ref, o.props.name);

    const hostMeta = new Map(); // ref -> { name, cpuMhzPerCore }
    const hostByRef = new Map(); // ref -> host object
    const hosts = [];
    for (const o of objs.filter((x) => x.type === 'HostSystem')) {
      const p = o.props;
      const cores = num(p['summary.hardware.numCpuCores']);
      const mhz = num(p['summary.hardware.cpuMhz']);
      const cpuTotalMhz = cores * mhz;
      const cpuUsageMhz = num(p['summary.quickStats.overallCpuUsage']);
      const memTotalMB = Math.round(num(p['summary.hardware.memorySize']) / 1048576);
      const memUsageMB = num(p['summary.quickStats.overallMemoryUsage']);
      const maint = p['runtime.inMaintenanceMode'] === 'true';
      const conn = p['runtime.connectionState'];
      hostMeta.set(o.ref, { name: p.name, cpuMhzPerCore: mhz });
      const host = {
        id: `${vc.id}:${o.ref}`,
        vcenterId: vc.id,
        name: p.name,
        cluster: clusterName.get(p.parent) || 'standalone',
        connectionState: conn === 'connected' ? (maint ? 'MAINTENANCE' : 'CONNECTED') : 'DISCONNECTED',
        powerState: (p['runtime.powerState'] || '').toUpperCase().includes('ON') ? 'POWERED_ON' : 'POWERED_OFF',
        cpuCores: cores,
        cpuTotalMhz,
        cpuUsageMhz,
        cpuUsagePct: pct(cpuUsageMhz, cpuTotalMhz),
        memTotalMB,
        memUsageMB,
        memUsagePct: pct(memUsageMB, memTotalMB),
        vmCount: 0,
      };
      hosts.push(host);
      hostByRef.set(o.ref, host);
    }
    const vms = [];
    for (const o of objs.filter((x) => x.type === 'VirtualMachine')) {
      const p = o.props;
      const host = hostByRef.get(p['runtime.host']);
      if (host) host.vmCount++;
      const numCpu = num(p['summary.config.numCpu']);
      const memMB = num(p['summary.config.memorySizeMB']);
      const cpuUsageMhz = num(p['summary.quickStats.overallCpuUsage']);
      const hostMhz = hostMeta.get(p['runtime.host'])?.cpuMhzPerCore || 0;
      const vmCpuCapacity = numCpu * hostMhz;
      const guestMemMB = num(p['summary.quickStats.guestMemoryUsage']);
      const powered = (p['runtime.powerState'] || '').toUpperCase().includes('ON');
      vms.push({
        id: `${vc.id}:${o.ref}`,
        vcenterId: vc.id,
        host: host?.name || '',
        cluster: host?.cluster || '',
        name: p.name,
        powerState: powered ? 'POWERED_ON' : 'POWERED_OFF',
        guestOS: p['summary.config.guestFullName'] || 'unknown',
        cpuCount: numCpu,
        memMB,
        storageGB: Math.round(num(p['summary.storage.committed']) / 1024 ** 3),
        cpuUsagePct: powered ? pct(cpuUsageMhz, vmCpuCapacity) : 0,
        memUsagePct: powered ? pct(guestMemMB, memMB) : 0,
        ipAddress: p['guest.ipAddress'] || null,
        toolsStatus: p['guest.toolsRunningStatus'] === 'guestToolsRunning' ? 'RUNNING'
          : powered ? 'NOT_RUNNING' : 'NOT_RUNNING',
      });
    }

    const datastores = objs.filter((x) => x.type === 'Datastore').map((o) => {
      const p = o.props;
      const capacityGB = Math.round(num(p['summary.capacity']) / 1024 ** 3);
      const freeGB = Math.round(num(p['summary.freeSpace']) / 1024 ** 3);
      const usedGB = Math.max(0, capacityGB - freeGB);
      return {
        id: `${vc.id}:${o.ref}`,
        vcenterId: vc.id,
        name: p.name,
        type: p['summary.type'],
        capacityGB,
        freeGB,
        usedGB,
        usagePct: pct(usedGB, capacityGB),
        accessible: p['summary.accessible'] !== 'false',
      };
    });

    const networks = objs.filter((x) => x.type === 'Network' || x.type === 'DistributedVirtualPortgroup').map((o) => ({
      id: `${vc.id}:${o.ref}`,
      vcenterId: vc.id,
      name: o.props.name,
      type: o.type === 'DistributedVirtualPortgroup' ? 'DISTRIBUTED_PORTGROUP' : 'STANDARD_PORTGROUP',
      hostCount: hosts.length,
      vmCount: 0,
    }));

    // Build host/datastore-derived alarms (high usage / connection issues).
    const alarms = [];
    const mkAlarm = (entity, entityType, severity, message) => alarms.push({
      id: `${vc.id}:${entity}:${alarms.length}`, vcenterId: vc.id, entity, entityType,
      severity, message, time: new Date().toISOString(), acknowledged: false,
    });
    for (const h of hosts) {
      if (h.connectionState === 'DISCONNECTED') mkAlarm(h.name, 'host', 'critical', 'Host disconnected from vCenter');
      else if (h.connectionState === 'MAINTENANCE') mkAlarm(h.name, 'host', 'info', 'Host in maintenance mode');
      else if (h.cpuUsagePct > 90) mkAlarm(h.name, 'host', 'warning', `High CPU usage (${h.cpuUsagePct}%)`);
      else if (h.memUsagePct > 92) mkAlarm(h.name, 'host', 'warning', `High memory usage (${h.memUsagePct}%)`);
    }
    for (const d of datastores) {
      if (d.usagePct > 90) mkAlarm(d.name, 'datastore', d.usagePct > 95 ? 'critical' : 'warning', `Datastore usage at ${d.usagePct}%`);
    }

    return {
      vcenter: {
        id: vc.id, name: vc.name, location: vc.location,
        status: 'connected', version: c.sc.version || vc.version || 'unknown',
      },
      hosts, vms, datastores, networks, alarms,
    };
  } finally {
    await c.logout();
  }
}
