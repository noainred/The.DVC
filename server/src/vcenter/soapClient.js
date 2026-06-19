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
      perfManager: pick('perfManager'),
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

  /** RetrieveProperties for a single managed object (no traversal). */
  async retrieveObjectProps(type, ref, paths) {
    const body =
      `<RetrieveProperties xmlns="urn:vim25"><_this type="PropertyCollector">${this.sc.propertyCollector}</_this>` +
      `<specSet><propSet><type>${type}</type>${paths.map((p) => `<pathSet>${p}</pathSet>`).join('')}</propSet>` +
      `<objectSet><obj type="${type}">${ref}</obj></objectSet></specSet></RetrieveProperties>`;
    return parseObjectContent(await this.#call(body));
  }

  /** Find the counterId for power.power.average from the perf counter catalog. */
  async powerCounterId() {
    if (!this.sc.perfManager) return null;
    const objs = await this.retrieveObjectProps('PerformanceManager', this.sc.perfManager, ['perfCounter']);
    const xml = objs[0]?.props?.perfCounter || '';
    for (const blk of xml.split('<PerfCounterInfo').slice(1)) {
      const key = /<key>(\d+)<\/key>/.exec(blk)?.[1];
      const name = /<nameInfo>[\s\S]*?<key>(\w+)<\/key>/.exec(blk)?.[1];
      const group = /<groupInfo>[\s\S]*?<key>(\w+)<\/key>/.exec(blk)?.[1];
      const rollup = /<rollupType>(\w+)<\/rollupType>/.exec(blk)?.[1];
      if (key && group === 'power' && name === 'power' && rollup === 'average') return key;
    }
    return null;
  }

  /** Query real-time host power (Watts) for the given host MoRefs -> Map<ref, watts>. */
  async queryHostPower(counterId, hostRefs) {
    const out = new Map();
    if (!counterId || !hostRefs.length) return out;
    const specs = hostRefs.map((ref) =>
      `<querySpec><entity type="HostSystem">${ref}</entity><maxSample>1</maxSample>` +
      `<metricId><counterId>${counterId}</counterId><instance></instance></metricId>` +
      `<intervalId>20</intervalId></querySpec>`
    ).join('');
    const xml = await this.#call(
      `<QueryPerf xmlns="urn:vim25"><_this type="PerformanceManager">${this.sc.perfManager}</_this>${specs}</QueryPerf>`
    );
    const re = /<returnval[^>]*>([\s\S]*?)<\/returnval>/g;
    let m;
    while ((m = re.exec(xml))) {
      const blk = m[1];
      const ent = /<entity type="HostSystem">([^<]+)<\/entity>/.exec(blk)?.[1];
      const val = /<value>[\s\S]*?<value>(\d+)<\/value>/.exec(blk)?.[1];
      if (ent && val != null) out.set(ent, Number(val));
    }
    return out;
  }

  /** Map 'group.name.rollup' -> counterId from the PerformanceManager catalog. */
  async perfCounterMap() {
    if (!this.sc.perfManager) return new Map();
    const objs = await this.retrieveObjectProps('PerformanceManager', this.sc.perfManager, ['perfCounter']);
    const xml = objs[0]?.props?.perfCounter || '';
    const map = new Map();
    for (const blk of xml.split('<PerfCounterInfo').slice(1)) {
      const key = /<key>(\d+)<\/key>/.exec(blk)?.[1];
      const name = /<nameInfo>[\s\S]*?<key>(\w+)<\/key>/.exec(blk)?.[1];
      const group = /<groupInfo>[\s\S]*?<key>(\w+)<\/key>/.exec(blk)?.[1];
      const rollup = /<rollupType>(\w+)<\/rollupType>/.exec(blk)?.[1];
      if (key && name && group && rollup) map.set(`${group}.${name}.${rollup}`, key);
    }
    return map;
  }

  /**
   * Query a perf counter time-series for one entity over the given interval.
   * intervalId: 20 (real-time), 300 (day), 1800 (week), 7200 (month), 86400 (year).
   * Returns [{ t: ISO timestamp, v: number }].
   */
  async queryEntityPerf(entityType, ref, counterId, intervalId, maxSample = 0) {
    const spec =
      `<querySpec><entity type="${entityType}">${ref}</entity>` +
      (maxSample ? `<maxSample>${maxSample}</maxSample>` : '') +
      `<metricId><counterId>${counterId}</counterId><instance></instance></metricId>` +
      `<intervalId>${intervalId}</intervalId></querySpec>`;
    const xml = await this.#call(
      `<QueryPerf xmlns="urn:vim25"><_this type="PerformanceManager">${this.sc.perfManager}</_this>${spec}</QueryPerf>`
    );
    const rv = /<returnval[^>]*>([\s\S]*?)<\/returnval>/.exec(xml)?.[1] || '';
    const times = [...rv.matchAll(/<timestamp>([^<]+)<\/timestamp>/g)].map((m) => m[1]);
    const vals = [...rv.matchAll(/<value>(-?\d+)<\/value>/g)].map((m) => Number(m[1]));
    const n = Math.min(times.length, vals.length);
    const out = [];
    for (let i = 0; i < n; i++) out.push({ t: times[i], v: vals[i] });
    return out;
  }
}

// IPv4 helpers — collect every IPv4 a guest reports, excluding IPv6/loopback.
const isIPv4 = (s) => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(String(s)) && String(s).split('.').every((o) => Number(o) <= 255);
function extractIPv4s(netXml, primary) {
  const out = [];
  const add = (ip) => {
    ip = String(ip || '').trim();
    if (isIPv4(ip) && !ip.startsWith('127.') && !ip.startsWith('169.254.') && ip !== '0.0.0.0' && !out.includes(ip)) out.push(ip);
  };
  if (netXml) { for (const m of netXml.matchAll(/<ipAddress>([^<]+)<\/ipAddress>/g)) add(m[1]); }
  add(primary);
  return out;
}
function vmIps(netXml, primary) {
  const ips = extractIPv4s(netXml, primary);
  return { ipAddress: ips[0] || (isIPv4(primary) ? String(primary) : null), ipAddresses: ips };
}

// vCenter PerformanceManager intervals and the counters we expose on demand.
export const PERF_INTERVALS = { realtime: 20, day: 300, week: 1800, month: 7200, year: 86400 };
const PERF_COUNTERS = {
  cpu: { key: 'cpu.usage.average', unit: '%', div: 100 },
  mem: { key: 'mem.usage.average', unit: '%', div: 100 },
  disk: { key: 'disk.usage.average', unit: 'KBps', div: 1 },
  net: { key: 'net.usage.average', unit: 'KBps', div: 1 },
};

/**
 * On-demand performance query for one VM (not part of the regular poll).
 * type: cpu|mem|disk|net, interval: realtime|day|week|month|year.
 * Returns { type, interval, unit, points:[{t,v}] }. Throws on failure.
 */
export async function fetchVmMetric(vc, moref, type, interval) {
  const cfg = PERF_COUNTERS[type];
  if (!cfg) throw new Error(`지원하지 않는 지표: ${type}`);
  const intervalId = PERF_INTERVALS[interval] || 20;
  const c = new VimSoapClient(vc);
  await c.login();
  try {
    const map = await c.perfCounterMap();
    const counterId = map.get(cfg.key);
    if (!counterId) throw new Error(`vCenter에 카운터가 없습니다: ${cfg.key}`);
    const maxSample = interval === 'realtime' ? 180 : 0;
    const raw = await c.queryEntityPerf('VirtualMachine', moref, counterId, intervalId, maxSample);
    const points = raw.map((p) => ({ t: p.t, v: cfg.div > 1 ? Math.round((Math.max(0, p.v) / cfg.div) * 10) / 10 : Math.max(0, p.v) }));
    return { ok: true, type, interval, unit: cfg.unit, points };
  } finally {
    await c.logout();
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
        'summary.storage.committed', 'guest.ipAddress', 'guest.net', 'guest.toolsRunningStatus'] },
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

    // Real-time host power draw (Watts) via PerformanceManager. Best-effort:
    // not all hardware/hosts report the power.power.average counter, and a
    // failure here must never break the rest of the collection.
    if (config.vcSoapMetrics && c.sc.perfManager && hostByRef.size) {
      try {
        const counterId = await c.powerCounterId();
        if (counterId) {
          const powerMap = await c.queryHostPower(counterId, [...hostByRef.keys()]);
          for (const [ref, host] of hostByRef) host.powerWatts = powerMap.get(ref) || 0;
        }
      } catch (err) {
        console.warn(`[collect] ${vc.id} 전력 수집 건너뜀: ${err.message}`);
      }
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
        ...vmIps(p['guest.net'], p['guest.ipAddress']),
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
