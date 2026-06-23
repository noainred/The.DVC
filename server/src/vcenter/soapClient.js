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

import tls from 'node:tls';
import { config } from '../config.js';
import { loadMetricsSettings } from '../metrics/settings.js';

// 호스트 GPU 사용률 캐시(주기 throttle용). key=`${vcId}:${ref}` → { pct, at }.
const _gpuUtilCache = new Map();
let _gpuForce = false; // 수동 '지금 수집' 시 다음 수집을 강제(주기 무시)
export function forceGpuUtilCollect() { _gpuForce = true; }
export function clearGpuUtilForce() { _gpuForce = false; }

/** SHA-1 thumbprint of a host's TLS cert (needed by the HTML5 web console). */
function getThumbprint(host, port = 443) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const socket = tls.connect({ host, port, rejectUnauthorized: false, servername: host, timeout: 8000 }, () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        finish(cert?.fingerprint || '');
      });
      socket.on('error', () => finish(''));
      socket.on('timeout', () => { socket.destroy(); finish(''); });
    } catch { finish(''); }
  });
}

/**
 * Build VM remote-console launch URLs the way the vSphere Client does:
 *   - VMRC (desktop app):  vmrc://clone:<ticket>@<host>/?moid=<moref>
 *   - HTML5 web console:   https://<host>/ui/webconsole.html?... (clone ticket + thumbprint)
 * Uses a one-time clone ticket so no re-login is needed.
 */
export async function getVmConsole(vc, moref, vmName) {
  const hostNoScheme = vc.host.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const hostOnly = hostNoScheme.split(':')[0];
  const port = Number(hostNoScheme.split(':')[1]) || 443;
  const c = new VimSoapClient(vc);
  await c.login();
  try {
    const ticket = await c.acquireCloneTicket();
    const serverGuid = c.sc.instanceUuid || '';
    const thumbprint = await getThumbprint(hostOnly, port);
    const vmrcUrl = `vmrc://clone:${ticket}@${hostNoScheme}/?moid=${encodeURIComponent(moref)}`;
    // webconsole.html requires ALL of: vmId, vmName, host, serverGuid,
    // sessionTicket, thumbprint, locale. A blank one triggers "Input is required".
    const webConsoleUrl = `https://${hostNoScheme}/ui/webconsole.html?vmId=${encodeURIComponent(moref)}` +
      `&vmName=${encodeURIComponent(vmName || moref)}&serverGuid=${encodeURIComponent(serverGuid)}` +
      `&locale=en_US&host=${encodeURIComponent(hostNoScheme)}&sessionTicket=${encodeURIComponent(ticket || '')}` +
      `&thumbprint=${encodeURIComponent(thumbprint)}`;
    const missing = [];
    if (!ticket) missing.push('sessionTicket');
    if (!serverGuid) missing.push('serverGuid');
    if (!thumbprint) missing.push('thumbprint');
    return {
      ok: true, vmrcUrl, webConsoleUrl,
      serverGuid, thumbprint, host: hostNoScheme,
      ticketIssued: Boolean(ticket), missing,
    };
  } finally {
    await c.logout();
  }
}

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
      signal: AbortSignal.timeout(this.vc?.timeoutMs > 0 ? this.vc.timeoutMs : 30_000),
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
    // Friendly vCenter version/build/name live in <about>.
    const about = /<about>([\s\S]*?)<\/about>/.exec(xml)?.[1] || '';
    const aboutPick = (tag) => new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`).exec(about)?.[1];
    this.sc = {
      propertyCollector: pick('propertyCollector'),
      rootFolder: pick('rootFolder'),
      viewManager: pick('viewManager'),
      sessionManager: pick('sessionManager'),
      perfManager: pick('perfManager'),
      extensionManager: pick('extensionManager'),
      licenseManager: pick('licenseManager'),
      guestOperationsManager: pick('guestOperationsManager'),
      version: aboutPick('version') || pick('version'),
      build: aboutPick('build') || '',
      fullName: aboutPick('fullName') || '',
      apiVersion: aboutPick('apiVersion') || '',
      instanceUuid: aboutPick('instanceUuid') || '',
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

  /** RetrieveProperties for an explicit list of objects of one type (chunked). */
  async retrieveManyObjectProps(type, refs, paths, chunk = 250) {
    const out = [];
    for (let i = 0; i < refs.length; i += chunk) {
      const slice = refs.slice(i, i + chunk);
      const objectSets = slice.map((r) => `<objectSet><obj type="${type}">${r}</obj></objectSet>`).join('');
      const body =
        `<RetrieveProperties xmlns="urn:vim25"><_this type="PropertyCollector">${this.sc.propertyCollector}</_this>` +
        `<specSet><propSet><type>${type}</type>${paths.map((p) => `<pathSet>${p}</pathSet>`).join('')}</propSet>` +
        `${objectSets}</specSet></RetrieveProperties>`;
      out.push(...parseObjectContent(await this.#call(body)));
    }
    return out;
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

  /** counterId for gpu.utilization.average (호스트 GPU 사용률 %). */
  async gpuUtilCounterId() {
    if (!this.sc.perfManager) return null;
    const objs = await this.retrieveObjectProps('PerformanceManager', this.sc.perfManager, ['perfCounter']);
    const xml = objs[0]?.props?.perfCounter || '';
    for (const blk of xml.split('<PerfCounterInfo').slice(1)) {
      const key = /<key>(\d+)<\/key>/.exec(blk)?.[1];
      const name = /<nameInfo>[\s\S]*?<key>(\w+)<\/key>/.exec(blk)?.[1];
      const group = /<groupInfo>[\s\S]*?<key>(\w+)<\/key>/.exec(blk)?.[1];
      const rollup = /<rollupType>(\w+)<\/rollupType>/.exec(blk)?.[1];
      if (key && group === 'gpu' && name === 'utilization' && rollup === 'average') return key;
    }
    return null;
  }

  /** 호스트별 GPU 사용률(%) — instance="*"(GPU별)을 호스트 단위 평균으로. Map<ref, pct>. */
  async queryHostGpuUtil(counterId, hostRefs) {
    const out = new Map();
    if (!counterId || !hostRefs.length) return out;
    const specs = hostRefs.map((ref) =>
      `<querySpec><entity type="HostSystem">${ref}</entity><maxSample>1</maxSample>` +
      `<metricId><counterId>${counterId}</counterId><instance>*</instance></metricId>` +
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
      if (!ent) continue;
      const vals = [...blk.matchAll(/<value>(\d+)<\/value>/g)].map((x) => Number(x[1]));
      // vSphere percent 카운터는 1/100 퍼센트 단위(예: 3800 = 38%). ÷100 후 0~100 클램프.
      if (vals.length) out.set(ent, Math.max(0, Math.min(100, Math.round(vals.reduce((a, b) => a + b, 0) / vals.length / 100))));
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
  async queryEntityPerf(entityType, ref, counterId, intervalId, maxSample = 0, { startTime, endTime } = {}) {
    const spec =
      `<querySpec><entity type="${entityType}">${ref}</entity>` +
      (startTime ? `<startTime>${startTime}</startTime>` : '') +
      (endTime ? `<endTime>${endTime}</endTime>` : '') +
      (!startTime && maxSample ? `<maxSample>${maxSample}</maxSample>` : '') +
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

  /** Installed solutions / plug-ins registered with vCenter (ExtensionManager). */
  async retrieveExtensions() {
    if (!this.sc.extensionManager) return [];
    const objs = await this.retrieveObjectProps('ExtensionManager', this.sc.extensionManager, ['extensionList']);
    const xml = objs[0]?.props?.extensionList || '';
    const out = [];
    // Array elements are named by TYPE (<Extension>), not the property name.
    for (const blk of xml.split(/<Extension(?=[ >])/).slice(1)) {
      const key = /<key>([^<]+)<\/key>/.exec(blk)?.[1];
      const version = /<version>([^<]+)<\/version>/.exec(blk)?.[1];
      const company = /<company>([^<]*)<\/company>/.exec(blk)?.[1];
      const label = /<label>([^<]*)<\/label>/.exec(blk)?.[1];
      if (key) out.push({ key, version: version || '', company: company || '', label: label || key });
    }
    return out;
  }

  /** Send a raw vim25 SOAP body (public wrapper around the internal caller). */
  async callRaw(body) { return this.#call(body); }

  /** Licenses assigned in this vCenter (LicenseManager.licenses). */
  async retrieveLicenses() {
    if (!this.sc.licenseManager) return [];
    const objs = await this.retrieveObjectProps('LicenseManager', this.sc.licenseManager, ['licenses']);
    const xml = objs[0]?.props?.licenses || '';
    const out = [];
    // Array elements are typed <LicenseManagerLicenseInfo>, not the property name.
    for (const blk of xml.split(/<LicenseManagerLicenseInfo(?=[ >])/).slice(1)) {
      const name = /<name>([^<]*)<\/name>/.exec(blk)?.[1] || '';
      const total = Number(/<total>(-?\d+)<\/total>/.exec(blk)?.[1] || 0);
      const used = Number(/<used>(-?\d+)<\/used>/.exec(blk)?.[1] || 0);
      const key = /<licenseKey>([^<]*)<\/licenseKey>/.exec(blk)?.[1] || '';
      const edition = /<editionKey>([^<]*)<\/editionKey>/.exec(blk)?.[1] || '';
      const props = {};
      for (const pm of blk.matchAll(/<properties>\s*<key>([^<]+)<\/key>\s*<value[^>]*>([^<]*)<\/value>/g)) props[pm[1]] = pm[2];
      out.push({
        name, total, used,
        key: key ? `${key.slice(0, 5)}-…-${key.slice(-5)}` : '',
        edition,
        product: props.ProductName || '',
        productVersion: props.ProductVersion || '',
        expires: props.expirationDate || props.ExpirationDate || '',
      });
    }
    return out;
  }

  /** One-time clone ticket to open a VM console (VMRC / WebMKS) without re-auth. */
  async acquireCloneTicket() {
    if (!this.sc?.sessionManager) await this.retrieveServiceContent();
    const xml = await this.#call(
      `<AcquireCloneTicket xmlns="urn:vim25"><_this type="SessionManager">${this.sc.sessionManager}</_this></AcquireCloneTicket>`
    );
    return /<returnval>([^<]+)<\/returnval>/.exec(xml)?.[1] || null;
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

// Parse host config.graphicsInfo (<HostGraphicsInfo> elements) into GPU list.
function parseGpus(xml) {
  if (!xml) return [];
  const out = [];
  for (const blk of xml.split(/<HostGraphicsInfo(?=[ >])/).slice(1)) {
    const deviceName = /<deviceName>([^<]*)<\/deviceName>/.exec(blk)?.[1] || '';
    const vendorName = /<vendorName>([^<]*)<\/vendorName>/.exec(blk)?.[1] || '';
    const gtype = /<graphicsType>([^<]*)<\/graphicsType>/.exec(blk)?.[1] || '';
    const memKB = Number(/<memorySizeInKB>(\d+)<\/memorySizeInKB>/.exec(blk)?.[1] || 0);
    const pciId = /<pciId>([^<]*)<\/pciId>/.exec(blk)?.[1] || '';
    // graphicsType: sharedDirect=vGPU(GRID), shared=vSGA 만 graphics로 '관리되는' GPU.
    // 그 외(basic/공란)는 vGPU로 단정하지 말 것 — 패스쓰루 GPU도 graphicsInfo에 빈
    // graphicsType으로 올라올 수 있어, 여기서 vGPU로 잡으면 패스쓰루가 0이 된다.
    // 비(非)shared GPU는 pciPassthruInfo(passthruEnabled) 검출에 맡긴다.
    const mode = /shareddirect/i.test(gtype) ? 'vgpu' : /shared/i.test(gtype) ? 'vsga' : null;
    if (mode && (deviceName || vendorName)) {
      out.push({
        model: deviceName || vendorName,
        vendor: vendorName,
        memGB: memKB ? Math.round(memKB / 1024 / 1024) : 0,
        mode,
        vgpuMode: mode === 'vgpu',
        pciId,
      });
    }
  }
  return out;
}

/**
 * 모델명에서 GPU VRAM(GB) 추론 — 패스쓰루 GPU는 PCI 정보에 메모리가 없어 표시가 0이 되므로
 * 모델 문자열의 명시값(예: "A100 PCIe 80GB")을 우선, 없으면 알려진 모델로 보정.
 */
function inferGpuMemGB(model) {
  const s = String(model || '');
  const explicit = /(\d{2,3})\s*GB/i.exec(s); // "80GB", "48 GB" 등 명시값 우선
  if (explicit) return Number(explicit[1]);
  const m = s.toUpperCase();
  if (/H200/.test(m)) return 141;
  if (/H100/.test(m)) return 80;
  if (/A100/.test(m)) return 80;          // 40/80 혼재 가능 — 명시 없으면 80 가정
  if (/A40|GA102/.test(m)) return 48;
  if (/L40S?/.test(m)) return 48;
  if (/A30/.test(m)) return 24;
  if (/A10(?!0)/.test(m)) return 24;
  if (/\bL4\b|AD104/.test(m)) return 24;
  if (/A16/.test(m)) return 16;
  if (/\bT4\b|TU104/.test(m)) return 16;
  if (/V100/.test(m)) return 32;
  return 0;
}

/**
 * Parse config.pciPassthruInfo + hardware.pciDevice for GPUs assigned in raw
 * PCI passthrough (DirectPath I/O). These do NOT appear in graphicsInfo. A GPU
 * is a PCI device with class id 0x03xx (VGA / 3D / display controller).
 * Returns [{ model, vendor, memGB:0, mode:'passthrough' }].
 *
 * `skipIds` excludes GPUs already presented via graphicsInfo (vGPU/vSGA). On
 * NVIDIA vGPU 호스트는 Shared Direct GPU가 graphicsInfo에도 나오고 동시에
 * pciPassthruInfo에 passthruEnabled=true로도 나오기 때문에, 같은 물리 GPU(동일
 * pciId)가 vGPU+패스쓰루로 이중 집계되는 문제를 막는다.
 */
function parsePassthruGpus(passthruXml, pciDeviceXml, skipIds) {
  if (!passthruXml || !pciDeviceXml) return [];
  const skip = skipIds || new Set();
  // Device ids that are passthrough-enabled (and active).
  const enabled = new Set();
  for (const blk of passthruXml.split(/<HostPciPassthruInfo(?=[ >])/).slice(1)) {
    const id = /<id>([^<]+)<\/id>/.exec(blk)?.[1];
    if (id && /<passthruEnabled>\s*true\s*<\/passthruEnabled>/i.test(blk)) enabled.add(id);
  }
  if (!enabled.size) return [];
  const out = [];
  for (const blk of pciDeviceXml.split(/<HostPciDevice(?=[ >])/).slice(1)) {
    const id = /<id>([^<]+)<\/id>/.exec(blk)?.[1];
    if (!id || !enabled.has(id) || skip.has(id)) continue; // graphicsInfo(vGPU/vSGA)와 중복 제거
    const classId = Number(/<classId>(-?\d+)<\/classId>/.exec(blk)?.[1] || 0);
    // PCI base class 0x03 = display controller (VGA 0x0300 / 3D 0x0302).
    if ((classId >> 8) !== 0x03) continue;
    const deviceName = /<deviceName>([^<]*)<\/deviceName>/.exec(blk)?.[1] || '';
    const vendorName = /<vendorName>([^<]*)<\/vendorName>/.exec(blk)?.[1] || '';
    const model = deviceName || vendorName || 'Passthrough GPU';
    // 패스쓰루 GPU는 PCI 정보에 VRAM이 없으므로 모델명에서 추론(없으면 0).
    out.push({ model, vendor: vendorName, memGB: inferGpuMemGB(model), mode: 'passthrough', vgpuMode: false });
  }
  return out;
}

/**
 * Parse config.storageDevice.hostBusAdapter (array) into [{ name,type,model,speedGbps,wwn,status }].
 * Array items are <HostHostBusAdapter xsi:type="HostFibreChannelHba|HostInternetScsiHba|...">.
 * FC link speed is reported in bits/sec; portWorldWideName is a decimal we render as hex.
 */
function parseHbas(xml) {
  if (!xml) return [];
  const out = [];
  const TYPE = {
    HostFibreChannelHba: 'FibreChannel', HostFibreChannelOverEthernetHba: 'FCoE',
    HostInternetScsiHba: 'iSCSI', HostBlockHba: 'Block',
    HostParallelScsiHba: 'SCSI', HostSerialAttachedHba: 'SAS', HostPcieHba: 'NVMe', HostRdmaDevice: 'RDMA',
  };
  // Split on each array element; tolerate both <HostHostBusAdapter and type-named tags.
  const blocks = xml.split(/<(?:HostHostBusAdapter|hostBusAdapter)(?=[ >])/).slice(1);
  for (const blk of blocks) {
    const xsi = /xsi:type="([^"]+)"/.exec(blk)?.[1] || '';
    const name = /<device>([^<]+)<\/device>/.exec(blk)?.[1] || /<key>[^<]*key-vim\.host\.[^.]*\.([^<]+)<\/key>/.exec(blk)?.[1] || '';
    const model = /<model>([^<]*)<\/model>/.exec(blk)?.[1] || '';
    const status = /<status>([^<]*)<\/status>/.exec(blk)?.[1] || '';
    const wwnDec = /<portWorldWideName>(\d+)<\/portWorldWideName>/.exec(blk)?.[1];
    const speedRaw = Number(/<speed>(\d+)<\/speed>/.exec(blk)?.[1] || 0); // FC: bits/sec
    let speedGbps = 0;
    if (speedRaw > 0) speedGbps = speedRaw >= 1e9 ? Math.round(speedRaw / 1e9) : (speedRaw <= 128 ? speedRaw : Math.round(speedRaw / 1000));
    let wwn = '';
    if (wwnDec) { try { wwn = BigInt(wwnDec).toString(16).padStart(16, '0').replace(/(..)(?=.)/g, '$1:'); } catch { /* ignore */ } }
    if (!name && !model) continue;
    out.push({ name, type: TYPE[xsi] || (xsi.replace(/^Host/, '').replace(/Hba$/, '') || 'HBA'), model, speedGbps, wwn, status });
  }
  return out;
}

/**
 * Parse runtime.healthSystemRuntime.systemHealthInfo.numericSensorInfo for
 * temperature sensors (sensorType=temperature). value = currentReading × 10^unitModifier.
 * Returns { tempC, tempMaxC, temps:[{name,c}] }. Prefers an ambient/inlet sensor
 * for tempC, else the max.
 */
function parseTemps(xml) {
  if (!xml) return { tempC: null, tempMaxC: null, temps: [] };
  const temps = [];
  for (const blk of xml.split(/<HostNumericSensorInfo(?=[ >])/).slice(1)) {
    if (!/<sensorType>\s*temperature\s*<\/sensorType>/i.test(blk)) continue;
    const name = /<name>([^<]*)<\/name>/.exec(blk)?.[1] || '';
    const reading = Number(/<currentReading>(-?\d+)<\/currentReading>/.exec(blk)?.[1]);
    const mod = Number(/<unitModifier>(-?\d+)<\/unitModifier>/.exec(blk)?.[1] || 0);
    if (!Number.isFinite(reading)) continue;
    const c = Math.round(reading * (10 ** mod) * 10) / 10;
    if (c > -50 && c < 200) temps.push({ name: name.trim(), c });
  }
  if (!temps.length) return { tempC: null, tempMaxC: null, temps: [] };
  const ambient = temps.find((t) => /ambient|inlet|intake|front/i.test(t.name));
  const max = temps.reduce((m, t) => (t.c > m.c ? t : m), temps[0]);
  return { tempC: (ambient || max).c, tempMaxC: max.c, temps: temps.slice(0, 12) };
}

/**
 * Classify a datastore's backing storage from its DatastoreInfo XML + summary.type.
 * Returns { storageType, remoteHost, ssd }.
 *   storageType: local | san | nas | vsan | vvol | other
 * VMFS volumes carry a HostVmfsVolume.local boolean that distinguishes a host's
 * internal disk (로컬) from a shared block LUN (SAN: FC/iSCSI/FCoE). NFS/CIFS are
 * NAS, and vSAN/vVol are their own categories.
 */
function parseDatastoreStorage(infoXml, summaryType) {
  const t = (summaryType || '').toUpperCase();
  if (t.startsWith('NFS') || t === 'CIFS') {
    const remoteHost = infoXml ? (/<remoteHost>([^<]*)<\/remoteHost>/.exec(infoXml)?.[1] || '') : '';
    return { storageType: 'nas', remoteHost, ssd: false };
  }
  if (t === 'VSAN') return { storageType: 'vsan', remoteHost: '', ssd: true };
  if (t === 'VVOL') return { storageType: 'vvol', remoteHost: '', ssd: false };
  if (t === 'PMEM') return { storageType: 'local', remoteHost: '', ssd: true };
  if (t === 'VMFS') {
    const local = infoXml ? /<local>\s*true\s*<\/local>/i.test(infoXml) : false;
    const ssd = infoXml ? /<ssd>\s*true\s*<\/ssd>/i.test(infoXml) : false;
    return { storageType: local ? 'local' : 'san', remoteHost: '', ssd };
  }
  return { storageType: 'other', remoteHost: '', ssd: false };
}

/**
 * Parse a VM's config.hardware.device for assigned GPUs (VirtualPCIPassthrough).
 *   - VmiopBackingInfo  → vGPU (mediated, has a <vgpu> profile)
 *   - Device/Dynamic/Plugin backing → raw PCI passthrough (DirectPath I/O)
 * Returns { type:'vgpu'|'passthrough'|'mixed', count, vgpu, passthrough, profile } or null.
 *
 * Count directly (don't split on '<device') because backing fields like
 * <deviceId> contain the substring "<device" and would break naive splitting,
 * which previously caused vGPU devices to be miscounted as raw passthrough.
 * `xsi:type="VirtualPCIPassthrough"` (with the closing quote) marks each device
 * and does NOT match the backing type `...VirtualPCIPassthroughVmiopBackingInfo`.
 */
function parseVmGpu(deviceXml) {
  if (!deviceXml) return null;
  const total = (deviceXml.match(/xsi:type="VirtualPCIPassthrough"/g) || []).length;
  if (!total) return null;
  const vgpu = (deviceXml.match(/VmiopBackingInfo/g) || []).length;
  const passthrough = Math.max(0, total - vgpu);
  const type = vgpu && passthrough ? 'mixed' : (vgpu ? 'vgpu' : 'passthrough');
  const profile = /<vgpu>([^<]+)<\/vgpu>/.exec(deviceXml)?.[1] || '';
  return { type, count: total, vgpu, passthrough, profile };
}

// Snapshot count (from the snapshot tree) + approximate size from layoutEx files.
function snapshotInfo(snapXml, layoutXml) {
  let snapshotCount = 0;
  if (snapXml) snapshotCount = (snapXml.match(/<snapshot type="VirtualMachineSnapshot">/g) || []).length
    || (snapXml.match(/<VirtualMachineSnapshotTree>/g) || []).length;
  let bytes = 0;
  if (snapshotCount > 0 && layoutXml) {
    // Sum sizes of snapshot data (.vmsn) files as a best-effort delta size.
    for (const blk of layoutXml.split('<file>').slice(1)) {
      const type = /<type>([^<]+)<\/type>/.exec(blk)?.[1];
      const size = Number(/<size>(\d+)<\/size>/.exec(blk)?.[1] || 0);
      if (type === 'snapshotData' || /-(\d{6})\.vmdk/.test(blk)) bytes += size;
    }
  }
  return { snapshotCount, snapshotSizeGB: Math.round(bytes / 1024 ** 3 * 10) / 10 };
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
 * On-demand performance query for a single entity (VM or Host) — not part of
 * the regular poll. type: cpu|mem|disk|net, interval: realtime|day|week|month|year.
 * Returns { type, interval, unit, points:[{t,v}] }. Throws on failure.
 */
export async function fetchEntityMetric(vc, entityType, moref, type, interval, { start, end } = {}) {
  const cfg = PERF_COUNTERS[type];
  if (!cfg) throw new Error(`지원하지 않는 지표: ${type}`);
  const intervalId = PERF_INTERVALS[interval] || 20;
  const c = new VimSoapClient(vc);
  await c.login();
  try {
    const map = await c.perfCounterMap();
    const counterId = map.get(cfg.key);
    if (!counterId) throw new Error(`vCenter에 카운터가 없습니다: ${cfg.key}`);
    // A specified date range uses startTime/endTime; otherwise the rolling window.
    const startTime = start ? new Date(start).toISOString() : null;
    const endTime = end ? new Date(end).toISOString() : null;
    const maxSample = (!startTime && interval === 'realtime') ? 180 : 0;
    const raw = await c.queryEntityPerf(entityType, moref, counterId, intervalId, maxSample, { startTime, endTime });
    const points = raw.map((p) => ({ t: p.t, v: cfg.div > 1 ? Math.round((Math.max(0, p.v) / cfg.div) * 10) / 10 : Math.max(0, p.v) }));
    return { ok: true, type, interval, unit: cfg.unit, points, start: startTime, end: endTime };
  } finally {
    await c.logout();
  }
}

export const fetchVmMetric = (vc, moref, type, interval, opts) => fetchEntityMetric(vc, 'VirtualMachine', moref, type, interval, opts);
export const fetchHostMetric = (vc, moref, type, interval, opts) => fetchEntityMetric(vc, 'HostSystem', moref, type, interval, opts);

/** Trigger VMware Tools upgrade on the given VM MoRefs. Returns per-VM result. */
export async function upgradeVmTools(vc, morefs) {
  const c = new VimSoapClient(vc);
  await c.login();
  const results = [];
  try {
    for (const ref of morefs) {
      try {
        // UpgradeTools_Task — installerOptions omitted (use defaults).
        await c.callRaw(`<UpgradeTools_Task xmlns="urn:vim25"><_this type="VirtualMachine">${ref}</_this></UpgradeTools_Task>`);
        results.push({ ref, ok: true });
      } catch (err) {
        results.push({ ref, ok: false, error: err.message });
      }
    }
  } finally {
    await c.logout();
  }
  return results;
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
      'Network', 'DistributedVirtualPortgroup', 'Folder', 'ResourcePool',
    ]);
    const objs = await c.retrieveProperties(view, [
      { type: 'Folder', paths: ['name', 'parent'] },
      { type: 'ClusterComputeResource', paths: ['name'] },
      { type: 'HostSystem', paths: [
        'name', 'parent', 'runtime.connectionState', 'runtime.powerState', 'runtime.inMaintenanceMode',
        'summary.hardware.numCpuCores', 'summary.hardware.numCpuThreads', 'summary.hardware.cpuMhz', 'summary.hardware.memorySize',
        'summary.config.product.version', 'summary.config.product.build', 'config.graphicsInfo',
        'config.pciPassthruInfo', 'hardware.pciDevice',
        'summary.hardware.vendor', 'summary.hardware.model', 'config.storageDevice.hostBusAdapter',
        'runtime.healthSystemRuntime.systemHealthInfo.numericSensorInfo',
        'summary.managementServerIp', 'config.network.vnic',
        'summary.quickStats.overallCpuUsage', 'summary.quickStats.overallMemoryUsage'] },
      { type: 'ResourcePool', paths: ['name'] },
      { type: 'VirtualMachine', paths: [
        'name', 'runtime.host', 'parent', 'resourcePool', 'runtime.powerState', 'summary.config.numCpu', 'summary.config.memorySizeMB',
        'summary.config.guestFullName', 'summary.config.template', 'summary.quickStats.overallCpuUsage', 'summary.quickStats.guestMemoryUsage',
        'summary.storage.committed', 'summary.storage.uncommitted', 'guest.ipAddress', 'guest.net', 'guest.toolsRunningStatus',
        'guest.toolsVersion', 'guest.toolsVersionStatus2', 'config.annotation', 'snapshot', 'layoutEx.file'] },
      { type: 'Datastore', paths: ['name', 'summary.type', 'summary.capacity', 'summary.freeSpace', 'summary.accessible', 'info'] },
      { type: 'Network', paths: ['name'] },
      { type: 'DistributedVirtualPortgroup', paths: ['name'] },
    ]);

    const clusterName = new Map();
    for (const o of objs) if (o.type === 'ClusterComputeResource') clusterName.set(o.ref, o.props.name);
    const poolName = new Map();
    for (const o of objs) if (o.type === 'ResourcePool') poolName.set(o.ref, o.props.name);

    // Folder hierarchy → resolve each VM's folder path (vSphere "VMs & Templates").
    const folderByRef = new Map(); // ref -> { name, parent }
    for (const o of objs) if (o.type === 'Folder') folderByRef.set(o.ref, { name: o.props.name, parent: o.props.parent });
    const folderPath = (ref) => {
      const parts = [];
      let cur = ref; let guard = 0;
      while (cur && folderByRef.has(cur) && guard++ < 32) {
        const f = folderByRef.get(cur);
        if (f.name && f.name !== 'vm' && f.name !== 'Datacenters') parts.unshift(f.name);
        cur = f.parent;
      }
      return parts.length ? parts.join('/') : 'vm';
    };

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
        cpuThreads: num(p['summary.hardware.numCpuThreads']) || cores,
        version: p['summary.config.product.version'] || '',
        build: p['summary.config.product.build'] || '',
        // 게스트 파일 회수용: vCenter 실제 IP(호스트가 보고) + ESXi 관리 IP(vmk).
        mgmtServerIp: p['summary.managementServerIp'] || '',
        mgmtIp: (/<ipAddress>([^<]+)<\/ipAddress>/.exec(p['config.network.vnic'] || '')?.[1]) || '',
        gpus: (() => {
          const gfx = parseGpus(p['config.graphicsInfo']);
          // vGPU/vSGA로 이미 잡힌 물리 GPU(pciId)는 패스쓰루에서 제외해 이중 집계 방지.
          const gfxIds = new Set(gfx.map((g) => g.pciId).filter(Boolean));
          return [...gfx, ...parsePassthruGpus(p['config.pciPassthruInfo'], p['hardware.pciDevice'], gfxIds)];
        })(),
        hbas: parseHbas(p['config.storageDevice.hostBusAdapter']),
        ...parseTemps(p['runtime.healthSystemRuntime.systemHealthInfo.numericSensorInfo']),
        vendor: p['summary.hardware.vendor'] || '',
        model: p['summary.hardware.model'] || '',
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

    // 호스트 GPU 사용률(gpu.utilization.average) — GPU 호스트만, 설정 주기로 throttle.
    // 패스쓰루는 ESXi가 못 보므로 게스트 수집이 보완(store overlay). 실패해도 수집 전체는 안 막음.
    if (config.vcSoapMetrics && c.sc.perfManager && hostByRef.size) {
      try {
        const ms = loadMetricsSettings();
        if (ms.gpuUtilEnabled !== false) {
          const intervalMs = Math.max(20, ms.gpuUtilIntervalSec || 60) * 1000;
          const now = Date.now();
          // ESXi가 사용률을 보고하는 vGPU/vSGA 호스트만 대상. 순수 패스쓰루 호스트는
          // ESXi가 사용률을 못 보므로 여기서 0을 찍지 말고(가짜 0% 방지) 게스트 수집
          // overlay에 맡긴다(없으면 '—'). 그래야 패스쓰루 수집 동작 여부가 구분된다.
          const gpuRefs = [...hostByRef]
            .filter(([, h]) => (h.gpus || []).some((g) => g.mode === 'vgpu' || g.mode === 'vsga' || g.vgpuMode))
            .map(([ref]) => ref);
          const stale = _gpuForce ? gpuRefs : gpuRefs.filter((ref) => now - (_gpuUtilCache.get(`${vc.id}:${ref}`)?.at || 0) >= intervalMs);
          if (stale.length) {
            const cid = await c.gpuUtilCounterId();
            if (cid) {
              const map = await c.queryHostGpuUtil(cid, stale);
              // 카운터가 존재(=수집 가능)하면 GPU 호스트는 값이 없어도(유휴) 0으로 기록 → '—' 대신 '0' 표시.
              for (const ref of stale) _gpuUtilCache.set(`${vc.id}:${ref}`, { pct: map.get(ref) ?? 0, at: now });
              console.log(`[collect] ${vc.id} vGPU 사용률 수집: 대상 ${stale.length} · 값 ${map.size} (gpu.utilization 카운터 OK)`);
            } else {
              console.warn(`[collect] ${vc.id} gpu.utilization 카운터 없음 — vGPU 사용률 미수집(NVIDIA vGPU Manager VIB/드라이버 또는 vCenter 카운터 확인)`);
            }
          }
          // 캐시된 사용률을 GPU 보유 호스트에 적용(throttle 주기 사이에도 마지막 값 유지).
          for (const [ref, host] of hostByRef) {
            const e = _gpuUtilCache.get(`${vc.id}:${ref}`);
            if (e && (host.gpus || []).length) host.gpuUtilPct = e.pct;
          }
        }
      } catch (err) {
        console.warn(`[collect] ${vc.id} GPU 사용률 수집 건너뜀: ${err.message}`);
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
        folder: folderPath(p.parent),
        resourcePool: poolName.get(p.resourcePool) || '',
        name: p.name,
        powerState: powered ? 'POWERED_ON' : 'POWERED_OFF',
        template: p['summary.config.template'] === 'true',
        guestOS: p['summary.config.guestFullName'] || 'unknown',
        cpuCount: numCpu,
        memMB,
        storageGB: Math.round(num(p['summary.storage.committed']) / 1024 ** 3),
        // Thin 추정: uncommitted(여유 가능 공간)이 의미있게 크면 thin 디스크 존재.
        uncommittedGB: Math.round(num(p['summary.storage.uncommitted']) / 1024 ** 3),
        thin: num(p['summary.storage.uncommitted']) > 1024 ** 3,
        cpuUsagePct: powered ? pct(cpuUsageMhz, vmCpuCapacity) : 0,
        memUsagePct: powered ? pct(guestMemMB, memMB) : 0,
        ...vmIps(p['guest.net'], p['guest.ipAddress']),
        toolsStatus: p['guest.toolsRunningStatus'] === 'guestToolsRunning' ? 'RUNNING'
          : powered ? 'NOT_RUNNING' : 'NOT_RUNNING',
        toolsVersion: p['guest.toolsVersion'] || '',
        toolsVersionStatus: p['guest.toolsVersionStatus2'] || '',
        notes: (p['config.annotation'] || '').slice(0, 2000),
        tags: [], // vSphere Tags require the tagging REST API; not collected via SOAP
        gpu: null, // 아래에서 GPU 호스트 위 VM만 대상으로 채움
        ...snapshotInfo(p['snapshot'], p['layoutEx.file']),
      });
    }

    // VM GPU 할당(vGPU/패스쓰루) — 비용을 줄이려 GPU가 있는 호스트 위 VM만 대상으로
    // config.hardware.device를 추가 조회한다(O(전체 VM) 아님). 실패는 격리.
    try {
      const gpuHostRefs = new Set([...hostByRef].filter(([, h]) => (h.gpus || []).length).map(([ref]) => ref));
      if (gpuHostRefs.size) {
        const vmByRef = new Map();
        for (const o of objs.filter((x) => x.type === 'VirtualMachine')) {
          if (gpuHostRefs.has(o.props['runtime.host'])) vmByRef.set(o.ref, o);
        }
        if (vmByRef.size) {
          const devObjs = await c.retrieveManyObjectProps('VirtualMachine', [...vmByRef.keys()], ['config.hardware.device']);
          const gpuByVmId = new Map();
          for (const d of devObjs) {
            const g = parseVmGpu(d.props['config.hardware.device']);
            if (g) gpuByVmId.set(`${vc.id}:${d.ref}`, g);
          }
          for (const vm of vms) { const g = gpuByVmId.get(vm.id); if (g) vm.gpu = g; }
        }
      }
    } catch (err) {
      console.warn(`[collect] ${vc.id} VM GPU 조회 건너뜀: ${err.message}`);
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
        ...parseDatastoreStorage(p['info'], p['summary.type']),
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

    // Installed solutions / plug-ins + licenses (best-effort).
    let solutions = [];
    try { solutions = (await c.retrieveExtensions()).slice(0, 300); } catch { /* optional */ }
    let licenses = [];
    try { licenses = (await c.retrieveLicenses()).slice(0, 200); } catch { /* optional */ }

    return {
      vcenter: {
        id: vc.id, name: vc.name, location: vc.location,
        status: 'connected', version: c.sc.version || vc.version || 'unknown',
        build: c.sc.build || '', fullName: c.sc.fullName || '', instanceUuid: c.sc.instanceUuid || '',
        solutions, licenses,
      },
      hosts, vms, datastores, networks, alarms,
    };
  } finally {
    await c.logout();
  }
}

/**
 * On-demand: read the real VM Folders and Resource Pools from one vCenter, for
 * the VM provisioning placement pickers. Best-effort; throws on login failure.
 * Returns { folders:[path...], resourcePools:[name...] }.
 */
export async function collectFoldersAndPools(vc) {
  const c = new VimSoapClient(vc);
  await c.login();
  try {
    const view = await c.createContainerView(['Folder', 'ResourcePool']);
    const objs = await c.retrieveProperties(view, [
      { type: 'Folder', paths: ['name', 'parent', 'childType'] },
      { type: 'ResourcePool', paths: ['name', 'parent'] },
    ]);
    const folderByRef = new Map();
    for (const o of objs) if (o.type === 'Folder') folderByRef.set(o.ref, { name: o.props.name, parent: o.props.parent, childType: o.props.childType || '' });
    const path = (ref) => {
      const parts = []; let cur = ref, guard = 0;
      while (cur && folderByRef.has(cur) && guard++ < 32) {
        const f = folderByRef.get(cur);
        if (f.name && f.name !== 'vm' && f.name !== 'Datacenters') parts.unshift(f.name);
        cur = f.parent;
      }
      return parts.length ? parts.join('/') : 'vm';
    };
    // Only folders that can hold VMs (childType includes VirtualMachine).
    const folders = [...new Set(
      [...folderByRef.entries()]
        .filter(([, f]) => /VirtualMachine/.test(f.childType))
        .map(([ref]) => path(ref)),
    )].filter(Boolean).sort();
    const resourcePools = [...new Set(
      objs.filter((o) => o.type === 'ResourcePool').map((o) => o.props.name).filter(Boolean),
    )].sort();
    return { folders: folders.length ? folders : ['vm'], resourcePools: resourcePools.length ? resourcePools : ['Resources'] };
  } finally {
    await c.logout();
  }
}
