/**
 * Dell iDRAC power collector via the Redfish API (standard library + undici).
 *
 * Power draw is read from the Chassis Power resource:
 *   GET /redfish/v1/Chassis                      -> chassis members
 *   GET /redfish/v1/Chassis/<id>/Power           -> PowerControl[].PowerConsumedWatts
 * Server identity (model / service tag / power state) is read from:
 *   GET /redfish/v1/Systems                       -> system members
 *   GET /redfish/v1/Systems/<id>                  -> Model, SKU/ServiceTag, PowerState
 *
 * iDRAC uses self-signed certs and sometimes legacy TLS, so we use a dedicated
 * permissive undici dispatcher (independent of import order).
 */

import { Agent } from 'undici';
import { constants as cryptoConstants } from 'node:crypto';
import { config } from '../config.js';

// Dedicated dispatcher so iDRAC self-signed certs / legacy TLS always work,
// regardless of the global vCenter dispatcher.
const dispatcher = new Agent({
  connect: {
    rejectUnauthorized: config.rejectUnauthorized,
    minVersion: config.vcTlsMinVersion,
    ciphers: config.vcTlsCiphers,
    secureOptions:
      cryptoConstants.SSL_OP_LEGACY_SERVER_CONNECT |
      cryptoConstants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION,
    timeout: config.idrac.timeoutMs,
  },
  connectTimeout: config.idrac.timeoutMs,
});

async function get(base, pathname, auth) {
  const res = await fetch(`${base}${pathname}`, {
    headers: { Authorization: auth, Accept: 'application/json' },
    signal: AbortSignal.timeout(config.idrac.timeoutMs),
    dispatcher,
  });
  if (res.status === 401) throw new Error('iDRAC 인증 실패 (사용자/비밀번호 확인)');
  if (!res.ok) throw new Error(`Redfish ${pathname} -> ${res.status} ${res.statusText}`);
  return res.json();
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Fetch current power (Watts) and identity for one iDRAC.
 * Returns { watts, model, serviceTag, powerState, chassis }.
 * Throws on connection / auth failure.
 */
export async function fetchPower(entry) {
  const base = entry.host.replace(/\/+$/, '');
  const auth = 'Basic ' + Buffer.from(`${entry.username}:${entry.password}`).toString('base64');

  // 1) sum PowerConsumedWatts across all chassis
  const chassisRoot = await get(base, '/redfish/v1/Chassis', auth);
  const members = (chassisRoot.Members || []).map((m) => m['@odata.id']).filter(Boolean);
  let watts = null;
  for (const m of members) {
    let power;
    try { power = await get(base, `${m}/Power`, auth); } catch { continue; }
    for (const pc of power.PowerControl || []) {
      const w = num(pc.PowerConsumedWatts);
      if (w != null) watts = (watts || 0) + w;
    }
  }

  // 2) best-effort identity (model / service tag / power state)
  let model = '', serviceTag = entry.serviceTag || '', powerState = '';
  try {
    const sysRoot = await get(base, '/redfish/v1/Systems', auth);
    const first = (sysRoot.Members || [])[0]?.['@odata.id'];
    if (first) {
      const sys = await get(base, first, auth);
      model = [sys.Manufacturer, sys.Model].filter(Boolean).join(' ').trim();
      serviceTag = sys.SKU || sys.SerialNumber || serviceTag;
      powerState = sys.PowerState || '';
    }
  } catch { /* identity is optional */ }

  if (watts == null) throw new Error('전력 정보를 찾을 수 없습니다 (Redfish Power 미지원 모델일 수 있음).');
  return { watts: Math.round(watts), model, serviceTag, powerState, chassis: members.length };
}

// BIOS/CMOS attributes worth surfacing prominently (others are kept as a count).
const BIOS_KEYS = [
  'BootMode', 'SysProfile', 'SystemProfile', 'ProcVirtualization', 'LogicalProc',
  'ProcCores', 'SriovGlobalEnable', 'MemFrequency', 'MemOpMode', 'NodeInterleave',
  'IntegratedRaid', 'SecureBoot', 'TpmSecurity', 'ProcTurboMode', 'EmbSata',
  'InternalUsb', 'PowerManagement', 'SerialComm', 'OsWatchdogTimer',
];

const firstMember = (root) => (root?.Members || [])[0]?.['@odata.id'];

/**
 * Probe one IP to decide whether it is a Dell iDRAC: checks the Redfish service
 * root (reachability + Dell signature) and, with credentials, reads the system
 * identity (service tag / model / hostname). Short-timeout and quiet — used for
 * scanning an IP range. Returns:
 *   { ok:false, reason }                         // not reachable / not Redfish
 *   { ok:true, isIdrac, dell, authFailed,        // reachable Redfish
 *     model, manufacturer, serviceTag, hostName }
 */
export async function probeIdrac(host, username, password, timeoutMs = 3000) {
  let base = String(host).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) base = `https://${base}`;
  const auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  const opt = (extra) => ({ headers: { Accept: 'application/json', ...extra }, signal: AbortSignal.timeout(timeoutMs), dispatcher });

  // 1) Redfish service root (no auth). Identifies Redfish + Dell signature.
  let root;
  try {
    const res = await fetch(`${base}/redfish/v1`, opt());
    if (!res.ok && res.status !== 401) return { ok: false, reason: `HTTP ${res.status}` };
    root = await res.json().catch(() => ({}));
  } catch (err) {
    return { ok: false, reason: err.name === 'TimeoutError' ? 'timeout' : err.message };
  }
  const sig = JSON.stringify(root || {}).toLowerCase();
  let dell = root?.Vendor === 'Dell' || Boolean(root?.Oem?.Dell) || sig.includes('idrac') || sig.includes('dell');

  // 2) System identity (with auth). Confirms credentials + enriches result.
  let model = '', manufacturer = '', serviceTag = '', hostName = '';
  try {
    const sres = await fetch(`${base}/redfish/v1/Systems`, opt({ Authorization: auth }));
    if (sres.status === 401) return { ok: true, isIdrac: dell, dell, authFailed: true };
    if (sres.ok) {
      const sroot = await sres.json();
      const first = firstMember(sroot);
      if (first) {
        const s2 = await fetch(`${base}${first}`, opt({ Authorization: auth }));
        if (s2.ok) {
          const s = await s2.json();
          model = s.Model || ''; manufacturer = s.Manufacturer || '';
          serviceTag = s.SKU || s.SerialNumber || ''; hostName = s.HostName || '';
        }
      }
    }
  } catch { /* identity optional; service root already classified it */ }

  if ((manufacturer + model).toLowerCase().includes('dell')) dell = true;
  return { ok: true, isIdrac: dell, dell, authFailed: false, model, manufacturer, serviceTag, hostName };
}

/**
 * Collect a rich hardware/firmware inventory from one iDRAC via Redfish:
 * hostname, service tag, BIOS version + key CMOS settings, iDRAC firmware,
 * IPMI version, CPU/memory summary, health, and iDRAC network identity.
 * Best-effort: missing sub-resources are tolerated.
 */
export async function fetchInventory(entry) {
  const base = entry.host.replace(/\/+$/, '');
  const auth = 'Basic ' + Buffer.from(`${entry.username}:${entry.password}`).toString('base64');
  const G = (p) => get(base, p, auth);

  const inv = { collectedAt: Date.now(), system: {}, idrac: {}, cpu: {}, memory: {}, network: [], bios: {} };

  // --- System (identity, CPU/mem summary, BIOS version, hostname, health) ---
  let sysId = null;
  try {
    const sysRoot = await G('/redfish/v1/Systems');
    sysId = firstMember(sysRoot);
    if (sysId) {
      const s = await G(sysId);
      inv.system = {
        hostName: s.HostName || '',
        model: s.Model || '',
        manufacturer: s.Manufacturer || '',
        serviceTag: s.SKU || s.SerialNumber || '',
        serialNumber: s.SerialNumber || '',
        assetTag: s.AssetTag || '',
        uuid: s.UUID || '',
        biosVersion: s.BiosVersion || '',
        powerState: s.PowerState || '',
        health: s.Status?.Health || '',
        indicatorLED: s.IndicatorLED || '',
      };
      inv.cpu = {
        count: s.ProcessorSummary?.Count ?? null,
        model: (s.ProcessorSummary?.Model || '').trim(),
        cores: s.ProcessorSummary?.CoreCount ?? null,
        threads: s.ProcessorSummary?.LogicalProcessorCount ?? null,
        health: s.ProcessorSummary?.Status?.Health || '',
      };
      inv.memory = {
        totalGiB: s.MemorySummary?.TotalSystemMemoryGiB ?? null,
        health: s.MemorySummary?.Status?.Health || '',
      };
    }
  } catch { /* identity optional */ }

  // --- Manager (iDRAC firmware, model, time) + IPMI ---
  let mgrId = null;
  try {
    const mgrRoot = await G('/redfish/v1/Managers');
    mgrId = firstMember(mgrRoot);
    if (mgrId) {
      const m = await G(mgrId);
      inv.idrac = {
        firmwareVersion: m.FirmwareVersion || '',
        model: m.Model || '',
        type: m.ManagerType || '',
        dateTime: m.DateTime || '',
        // Dell iDRAC implements IPMI v2.0 over LAN; Redfish exposes no version
        // field, so report the implemented spec level.
        ipmiVersion: '2.0',
      };
    }
  } catch { /* manager optional */ }

  // --- iDRAC network identity (hostname/FQDN/MAC/IP) ---
  try {
    if (mgrId) {
      const eths = await G(`${mgrId}/EthernetInterfaces`);
      for (const mem of (eths.Members || []).slice(0, 4)) {
        try {
          const e = await G(mem['@odata.id']);
          inv.network.push({
            name: e.Id || e.Name || '',
            mac: e.MACAddress || e.PermanentMACAddress || '',
            hostName: e.HostName || '',
            fqdn: e.FQDN || '',
            ipv4: (e.IPv4Addresses || []).map((a) => a.Address).filter(Boolean).join(', '),
          });
        } catch { /* skip iface */ }
      }
    }
  } catch { /* network optional */ }

  // --- BIOS / CMOS settings ---
  try {
    if (sysId) {
      const bios = await G(`${sysId}/Bios`);
      const attrs = bios.Attributes || {};
      const keys = Object.keys(attrs);
      const curated = {};
      for (const k of BIOS_KEYS) if (attrs[k] !== undefined) curated[k] = attrs[k];
      inv.bios = { version: inv.system.biosVersion || '', attributes: curated, attributeCount: keys.length };
    }
  } catch { /* bios optional */ }

  return inv;
}
