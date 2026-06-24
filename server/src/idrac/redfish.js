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

  // --- 헬스 롤업(전체 + 하위 시스템) ---
  inv.health = {
    overall: inv.system.health || '',
    processor: inv.cpu.health || '',
    memory: inv.memory.health || '',
    storage: '', psu: '', fan: '', battery: '',
  };

  // --- 전원공급장치(PSU): 모델·출력 W·입력 전압·이중화·상태 (Chassis/Power) ---
  inv.psus = [];
  try {
    const chassisRoot = await G('/redfish/v1/Chassis');
    for (const m of (chassisRoot.Members || []).map((x) => x['@odata.id']).filter(Boolean)) {
      let power; try { power = await G(`${m}/Power`); } catch { continue; }
      for (const p of (power.PowerSupplies || []).slice(0, 8)) {
        inv.psus.push({
          name: p.Name || p.MemberId || 'PSU',
          model: p.Model || '',
          capacityWatts: num(p.PowerCapacityWatts),
          inputWatts: num(p.PowerInputWatts),
          outputWatts: num(p.PowerOutputWatts ?? p.LastPowerOutputWatts),
          lineInputVoltage: num(p.LineInputVoltage),
          health: p.Status?.Health || '',
          state: p.Status?.State || '',
          firmware: p.FirmwareVersion || '',
        });
      }
      // 전력 한도(Power Cap)도 함께
      const pc = (power.PowerControl || [])[0];
      if (pc?.PowerLimit && inv.powerCap == null) {
        inv.powerCap = { limitWatts: num(pc.PowerLimit.LimitInWatts), allocatedWatts: num(pc.PowerAllocatedWatts), metricWatts: num(pc.PowerConsumedWatts) };
      }
    }
    if (inv.psus.length) inv.health.psu = inv.psus.some((p) => p.health && p.health !== 'OK') ? 'Warning' : 'OK';
  } catch { /* psu optional */ }

  // --- 물리 디스크 상태(스토리지): 모델·용량·미디어·SMART 예측 실패·상태 ---
  inv.disks = [];
  try {
    if (sysId) {
      const stRoot = await G(`${sysId}/Storage`);
      for (const c of (stRoot.Members || []).slice(0, 8)) {
        let ctrl; try { ctrl = await G(c['@odata.id']); } catch { continue; }
        for (const d of (ctrl.Drives || []).slice(0, 32)) {
          try {
            const drive = await G(d['@odata.id']);
            inv.disks.push({
              name: drive.Name || drive.Id || '',
              model: drive.Model || '',
              serial: drive.SerialNumber || '',
              capacityGB: drive.CapacityBytes ? Math.round(drive.CapacityBytes / 1e9) : null,
              media: drive.MediaType || '',
              protocol: drive.Protocol || '',
              health: drive.Status?.Health || '',
              state: drive.Status?.State || '',
              predictiveFailure: !!(drive.FailurePredicted),
              rpm: num(drive.RotationSpeedRPM),
            });
          } catch { /* skip drive */ }
        }
      }
      if (inv.disks.length) inv.health.storage = inv.disks.some((d) => d.predictiveFailure || (d.health && d.health !== 'OK')) ? 'Warning' : 'OK';
    }
  } catch { /* storage optional */ }

  // --- 메모리 DIMM: 슬롯·용량·속도·상태 (정정가능 오류/불량 조기 발견) ---
  inv.memoryDimms = [];
  try {
    if (sysId) {
      const memRoot = await G(`${sysId}/Memory`);
      for (const mm of (memRoot.Members || []).slice(0, 64)) {
        try {
          const d = await G(mm['@odata.id']);
          if (!(d.CapacityMiB || d.Status)) continue;
          inv.memoryDimms.push({
            locator: d.DeviceLocator || d.Name || d.Id || '',
            sizeGB: d.CapacityMiB ? Math.round(d.CapacityMiB / 1024) : null,
            speedMHz: num(d.OperatingSpeedMhz),
            type: d.MemoryDeviceType || '',
            manufacturer: d.Manufacturer || '',
            health: d.Status?.Health || '',
            state: d.Status?.State || '',
          });
        } catch { /* skip dimm */ }
      }
    }
  } catch { /* memory optional */ }

  // --- 최근 하드웨어 이벤트(Critical/Warning) — SEL 또는 Dell LC 로그 ---
  inv.events = [];
  try {
    if (mgrId) {
      let log = null;
      for (const p of [`${mgrId}/LogServices/Sel/Entries`, `${mgrId}/LogServices/Lclog/Entries`]) {
        try { log = await G(p); if (log?.Members?.length) break; } catch { /* try next */ }
      }
      for (const e of (log?.Members || []).slice(-40).reverse()) {
        const sev = e.Severity || '';
        if (sev && /critical|warning/i.test(sev)) {
          inv.events.push({ severity: sev, created: e.Created || '', message: (e.Message || e.MessageId || '').slice(0, 200) });
          if (inv.events.length >= 15) break;
        }
      }
    }
  } catch { /* events optional */ }

  // --- Firmware/driver inventory (각종 카드: NIC·RAID·PSU·BIOS·iDRAC 등 + 버전) ---
  try { inv.firmware = await fetchFirmwareInventory(entry); } catch { inv.firmware = []; }

  return inv;
}

/**
 * 설치된 펌웨어/드라이버 버전 목록(Redfish UpdateService/FirmwareInventory).
 * 'Installed-*' 항목만(이전/가용 버전 제외). [{ name, version, updateable, type }]
 */
export async function fetchFirmwareInventory(entry) {
  const base = entry.host.replace(/\/+$/, '');
  const auth = 'Basic ' + Buffer.from(`${entry.username}:${entry.password}`).toString('base64');
  const G = (p) => get(base, p, auth);
  const root = await G('/redfish/v1/UpdateService/FirmwareInventory');
  const members = (root.Members || []).map((m) => m['@odata.id']).filter(Boolean)
    .filter((id) => /\/Installed-/i.test(id)) // 현재 설치된 버전만
    .slice(0, 120);
  const out = [];
  for (const id of members) {
    try {
      const f = await G(id);
      if (!f.Version) continue;
      out.push({
        name: f.Name || f.Id || '',
        version: f.Version || '',
        updateable: !!f.Updateable,
        type: classifyFw(f.Name || f.Id || ''),
      });
    } catch { /* skip one component */ }
  }
  // 종류 → 이름순 정렬(같은 종류끼리 묶임)
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type.localeCompare(b.type)));
  return out;
}

function classifyFw(name) {
  const n = String(name).toLowerCase();
  if (n.includes('bios')) return 'BIOS';
  if (n.includes('idrac') || n.includes('lifecycle') || n.includes('ism')) return 'iDRAC';
  if (n.includes('nic') || n.includes('network') || n.includes('ethernet') || n.includes('mellanox') || n.includes('broadcom') || n.includes('intel(r) ethernet') || n.includes('qlogic')) return 'NIC';
  if (n.includes('raid') || n.includes('perc') || n.includes('hba') || n.includes('storage') || n.includes('bp') || n.includes('backplane')) return 'Storage';
  if (n.includes('power') || n.includes('psu') || n.includes('supply')) return 'PSU';
  if (n.includes('cpld') || n.includes('complex')) return 'CPLD';
  if (n.includes('disk') || n.includes('ssd') || n.includes('drive') || n.includes('nvme')) return 'Disk';
  if (n.includes('gpu') || n.includes('nvidia')) return 'GPU';
  if (n.includes('driver') || n.includes('os ')) return 'Driver';
  return '기타';
}

/**
 * 현재 온도센서 전체 + CPU 사용량(%)을 읽는다(1분 시계열용, 가벼움).
 * 반환 { temps: [{name, celsius}], inletCelsius, maxCelsius, cpuUsagePct }.
 * cpuUsagePct는 Dell 텔레메트리(SystemUsage) 가용 시에만(미지원이면 null).
 */
export async function fetchSensors(entry) {
  const base = entry.host.replace(/\/+$/, '');
  const auth = 'Basic ' + Buffer.from(`${entry.username}:${entry.password}`).toString('base64');
  const G = (p) => get(base, p, auth);

  const temps = [];
  const fans = [];
  // 1) 모든 Chassis의 Thermal → Temperatures[] + Fans[]
  try {
    const chassisRoot = await G('/redfish/v1/Chassis');
    for (const m of (chassisRoot.Members || []).map((x) => x['@odata.id']).filter(Boolean)) {
      let thermal;
      try { thermal = await G(`${m}/Thermal`); } catch { continue; }
      for (const t of thermal.Temperatures || []) {
        const c = num(t.ReadingCelsius);
        if (c == null) continue;
        const name = t.Name || t.MemberId || `Sensor ${t.SensorNumber ?? ''}`.trim();
        temps.push({ name, celsius: c });
      }
      for (const f of thermal.Fans || []) {
        const rpm = num(f.Reading ?? f.ReadingRPM);
        if (rpm == null) continue;
        fans.push({ name: f.Name || f.FanName || f.MemberId || 'Fan', rpm });
      }
    }
  } catch { /* thermal optional */ }

  let inletCelsius = null, maxCelsius = null;
  for (const t of temps) {
    if (/inlet|intake|ambient/i.test(t.name)) inletCelsius = t.celsius;
    if (maxCelsius == null || t.celsius > maxCelsius) maxCelsius = t.celsius;
  }

  // 2) CPU 사용량 — Dell 텔레메트리 SystemUsage 메트릭 리포트(있으면).
  let cpuUsagePct = null;
  try {
    const rep = await G('/redfish/v1/TelemetryService/MetricReports/SystemUsage');
    for (const v of rep.MetricValues || []) {
      const id = String(v.MetricId || '');
      if (/^(SystemBoardCPUUsage|CPUUsage)$/i.test(id)) {
        const n = Number(String(v.MetricValue).replace(/[^\d.]/g, ''));
        if (Number.isFinite(n)) { cpuUsagePct = Math.round(n); break; }
      }
    }
  } catch { /* telemetry optional/unlicensed */ }

  return { temps, fans, inletCelsius, maxCelsius, cpuUsagePct };
}
