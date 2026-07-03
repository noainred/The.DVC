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
import { parseDigestChallenge, buildDigestHeader } from './digestAuth.js';

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

const basicHeader = (username, password) => 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

// 호스트별 '성공한 인증 방식' 캐시 — 한 iDRAC에 여러 번 GET(probe 2회, fetchPower 다수)할 때
// 매번 Basic-401 왕복/세션 재생성을 피한다. 세션 토큰은 iDRAC idle 타임아웃(기본 30분)보다 짧게
// 재사용(20분). basic/digest/session 중 무엇이 통했는지 기억.
const AUTH_CACHE = new Map(); // `${base}\0${username}\0${pwFp}` -> { mode, challenge?, token?, at }
const AUTH_TTL_MS = 20 * 60_000;
function touchAuthCache(key, val) {
  AUTH_CACHE.set(key, { ...val, at: Date.now() });
  if (AUTH_CACHE.size > 512) { const k = AUTH_CACHE.keys().next().value; AUTH_CACHE.delete(k); }
}
// 비밀번호 지문(비-암호 djb2) — 캐시 키에 포함해, 같은 호스트/계정을 '다른 비밀번호'로 시도할 때
// 이전(정확한 비번)의 세션 토큰이 잘못 재사용되지 않게 한다(평문은 키에 담지 않음).
function pwFingerprint(pw) {
  let h = 5381;
  const s = String(pw);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Redfish GET — Basic 인증 → 401이면 (1) Digest 챌린지 시 Digest, (2) 아니면 세션 토큰
 * (POST SessionService/Sessions → X-Auth-Token)으로 자동 재시도한다. 일부 iDRAC은 보안 강화로
 * Redfish의 Basic 인증을 비활성화하고 세션 토큰만 허용한다(웹 UI 로그인은 되는데 Basic만 막힘 —
 * '계정 맞는데 인증실패'의 실제 원인). 응답 객체를 그대로 반환(401이면 세 방식 모두 실패).
 */
async function rawGet(base, pathname, username, password, timeoutMs = config.idrac.timeoutMs) {
  const doFetch = (headers, method = 'GET', path = pathname, body) => fetch(`${base}${path}`, {
    method,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body,
    signal: AbortSignal.timeout(timeoutMs),
    dispatcher,
  });
  const drain = async (r) => { try { await r.body?.cancel?.(); } catch { /* */ } };
  const key = `${base}\0${username}\0${pwFingerprint(password)}`;
  const cached = AUTH_CACHE.get(key);

  // 캐시된 성공 방식이 있으면 그것부터(만료 전) — Basic-401 왕복 생략.
  if (cached && Date.now() - cached.at < AUTH_TTL_MS) {
    if (cached.mode === 'session' && cached.token) {
      const r = await doFetch({ 'X-Auth-Token': cached.token });
      if (r.status !== 401) return r;
      AUTH_CACHE.delete(key); await drain(r); // 토큰 만료 → 아래에서 재수립
    } else if (cached.mode === 'digest' && cached.challenge) {
      const r = await doFetch({ Authorization: buildDigestHeader({ username, password, method: 'GET', uri: pathname, challenge: cached.challenge }) });
      if (r.status !== 401) return r;
      AUTH_CACHE.delete(key); await drain(r);
    }
  }

  // 1) Basic
  const res = await doFetch({ Authorization: basicHeader(username, password) });
  if (res.status !== 401) { if (res.ok) touchAuthCache(key, { mode: 'basic' }); return res; }

  // 2) Digest 챌린지면 Digest
  const challenge = parseDigestChallenge(res.headers.get('www-authenticate'));
  if (challenge) {
    await drain(res);
    const r = await doFetch({ Authorization: buildDigestHeader({ username, password, method: 'GET', uri: pathname, challenge }) });
    if (r.ok) touchAuthCache(key, { mode: 'digest', challenge });
    return r;
  }

  // 3) 세션 토큰 폴백(Basic 비활성 iDRAC)
  await drain(res);
  try {
    const sres = await doFetch({}, 'POST', '/redfish/v1/SessionService/Sessions', JSON.stringify({ UserName: username, Password: password }));
    const token = sres.headers.get('x-auth-token');
    await drain(sres);
    if ((sres.status === 201 || sres.ok) && token) {
      touchAuthCache(key, { mode: 'session', token });
      return await doFetch({ 'X-Auth-Token': token });
    }
  } catch { /* 세션 생성 실패 → 아래에서 원래 401 반환 */ }
  return res; // 세 방식 모두 실패 — 401(자격증명/권한/잠금)
}

async function get(base, pathname, username, password) {
  const res = await rawGet(base, pathname, username, password);
  if (res.status === 401) throw new Error('iDRAC 인증 실패 (사용자/비밀번호 확인)');
  if (!res.ok) throw new Error(`Redfish ${pathname} -> ${res.status} ${res.statusText}`);
  return res.json();
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * iDRAC이 401과 함께 돌려주는 실제 오류 메시지를 캡처한다(잘못된 자격증명 vs 계정 잠금 vs
 * 로그인 권한 없음 구분용). Redfish 오류는 error['@Message.ExtendedInfo'][].Message에 담긴다.
 * 진단 전용이라 실패 IP에만 1회 추가 호출(스캔 대다수인 무응답 IP는 여기 오지 않음).
 */
async function readIdracAuthMessage(base, pathname, username, password, timeoutMs) {
  try {
    const res = await fetch(`${base}${pathname}`, {
      headers: { Authorization: basicHeader(username, password), Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs), dispatcher,
    });
    const body = await res.json().catch(() => null);
    const err = body?.error;
    const info = err?.['@Message.ExtendedInfo'];
    let msg = (Array.isArray(info) && info[0]?.Message) || err?.message || '';
    msg = String(msg).replace(/\s+/g, ' ').trim();
    return msg ? msg.slice(0, 160) : '';
  } catch { return ''; }
}

/**
 * Fetch current power (Watts) and identity for one iDRAC.
 * Returns { watts, model, serviceTag, powerState, chassis }.
 * Throws on connection / auth failure.
 */
export async function fetchPower(entry) {
  const base = entry.host.replace(/\/+$/, '');
  const { username, password } = entry;

  // 1) sum PowerConsumedWatts across all chassis
  const chassisRoot = await get(base, '/redfish/v1/Chassis', username, password);
  const members = (chassisRoot.Members || []).map((m) => m['@odata.id']).filter(Boolean);
  let watts = null;
  for (const m of members) {
    let power;
    try { power = await get(base, `${m}/Power`, username, password); } catch { continue; }
    for (const pc of power.PowerControl || []) {
      const w = num(pc.PowerConsumedWatts);
      if (w != null) watts = (watts || 0) + w;
    }
  }

  // 2) best-effort identity (model / service tag / power state)
  let model = '', serviceTag = entry.serviceTag || '', powerState = '';
  try {
    const sysRoot = await get(base, '/redfish/v1/Systems', username, password);
    const first = (sysRoot.Members || [])[0]?.['@odata.id'];
    if (first) {
      const sys = await get(base, first, username, password);
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

  // 2) System identity (with auth). rawGet이 Basic → Digest → 세션 토큰 순으로 자동 시도한다.
  let model = '', manufacturer = '', serviceTag = '', hostName = '', authHint = '';
  try {
    const sres = await rawGet(base, '/redfish/v1/Systems', username, password, timeoutMs);
    if (sres.status === 401) {
      // Basic·Digest·세션 토큰 모두 거부됨 → iDRAC이 준 실제 오류 메시지를 캡처해 원인을 구분한다
      // (잘못된 자격증명 vs 계정 잠금 vs 로그인 권한 없음). iDRAC 메시지가 있으면 그대로 노출.
      const idracMsg = await readIdracAuthMessage(base, '/redfish/v1/Systems', username, password, timeoutMs);
      const lockish = /lock|attempt|exceed|잠금|blocked|denied/i.test(idracMsg);
      const privish = /privile|permission|not allow|권한|access/i.test(idracMsg);
      authHint = idracMsg
        ? (lockish ? `계정 잠금 추정 — iDRAC: "${idracMsg}"`
          : privish ? `로그인 권한 없음 추정 — iDRAC: "${idracMsg}"`
            : `자격증명 거부 — iDRAC: "${idracMsg}"`)
        : '자격증명 거부 — Basic·Digest·세션 인증 모두 실패(사용자/비밀번호/로그인 권한/계정 잠금 확인)';
      return { ok: true, isIdrac: dell, dell, authFailed: true, authHint };
    }
    if (sres.ok) {
      const sroot = await sres.json();
      const first = firstMember(sroot);
      if (first) {
        const s2 = await rawGet(base, first, username, password, timeoutMs);
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
  const G = (p) => get(base, p, entry.username, entry.password);

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
      inv.boot = {
        mode: s.Boot?.BootSourceOverrideMode || s.BiosVersion ? (s.Boot?.BootSourceOverrideMode || '') : '',
        overrideTarget: s.Boot?.BootSourceOverrideTarget || '',
        overrideEnabled: s.Boot?.BootSourceOverrideEnabled || '',
        secureBoot: s.SecureBoot?.['@odata.id'] ? 'present' : '',
        bootOrderCount: Array.isArray(s.Boot?.BootOrder) ? s.Boot.BootOrder.length : null,
      };
      inv.powerState = s.PowerState || '';
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

  // --- GPU(Accelerator) 목록: 모델·상태 (iDRAC가 OOB로 인식한 GPU) ---
  inv.gpus = [];
  try {
    if (sysId) {
      const procRoot = await G(`${sysId}/Processors`);
      for (const m of (procRoot.Members || []).slice(0, 24)) {
        let p; try { p = await G(m['@odata.id']); } catch { continue; }
        const isGpu = /gpu|accelerator/i.test(p.ProcessorType || '') || /gpu|nvidia|tesla|a100|h100|h200|l40|l4\b/i.test(`${p.Model || ''} ${p.Name || ''}`);
        if (!isGpu) continue;
        inv.gpus.push({ name: p.Name || p.Id || '', model: (p.Model || '').trim(), manufacturer: p.Manufacturer || '', health: p.Status?.Health || '', state: p.Status?.State || '' });
      }
      if (inv.gpus.length) inv.health.gpu = inv.gpus.some((g) => g.health && g.health !== 'OK') ? 'Warning' : 'OK';
    }
  } catch { /* gpu optional */ }

  // --- NIC 어댑터/포트: 모델·링크 상태·속도 ---
  inv.nics = [];
  try {
    const chassisRoot = await G('/redfish/v1/Chassis');
    for (const cm of (chassisRoot.Members || []).map((x) => x['@odata.id']).filter(Boolean).slice(0, 4)) {
      let na; try { na = await G(`${cm}/NetworkAdapters`); } catch { continue; }
      for (const am of (na.Members || []).slice(0, 8)) {
        let a; try { a = await G(am['@odata.id']); } catch { continue; }
        const ports = [];
        const portsLink = a.NetworkPorts?.['@odata.id'] || a.Ports?.['@odata.id'];
        if (portsLink) {
          try {
            const pr = await G(portsLink);
            for (const pm of (pr.Members || []).slice(0, 8)) {
              try {
                const p = await G(pm['@odata.id']);
                ports.push({
                  id: p.Id || p.Name || '',
                  link: p.LinkStatus || p.Status?.State || '',
                  speedMbps: num(p.CurrentLinkSpeedMbps) ?? (p.SupportedLinkCapabilities?.[0]?.LinkSpeedMbps ?? null),
                });
              } catch { /* skip port */ }
            }
          } catch { /* ports optional */ }
        }
        inv.nics.push({ name: a.Id || a.Model || '', model: a.Model || a.Manufacturer || '', ports });
      }
    }
  } catch { /* nics optional */ }

  // --- iDRAC 라이선스(Enterprise/DataCenter — GPU 텔레메트리 가용성과 직결) ---
  inv.licenses = [];
  try {
    let lic = null;
    for (const p of ['/redfish/v1/LicenseService/Licenses', `${mgrId || '/redfish/v1/Managers/iDRAC.Embedded.1'}/Oem/Dell/DellLicenses`]) {
      try { lic = await G(p); if (lic?.Members?.length) break; } catch { /* try next */ }
    }
    for (const m of (lic?.Members || []).slice(0, 12)) {
      try {
        const l = await G(m['@odata.id']);
        inv.licenses.push({
          name: l.Name || l.LicenseDescription || l.Id || '',
          type: l.LicenseType || l.LicensePrimaryStatus || '',
          entitlement: l.EntitlementId || l.EntitlementID || '',
          expiry: l.ExpirationDate || '',
        });
      } catch { /* skip */ }
    }
  } catch { /* license optional */ }

  // --- iDRAC 사용자 계정(감사용 — 활성 계정·권한, 비밀번호 제외) ---
  inv.idracUsers = [];
  try {
    let acc = null;
    for (const p of ['/redfish/v1/AccountService/Accounts', `${mgrId || '/redfish/v1/Managers/iDRAC.Embedded.1'}/Accounts`]) {
      try { acc = await G(p); if (acc?.Members?.length) break; } catch { /* try next */ }
    }
    for (const m of (acc?.Members || []).slice(0, 32)) {
      try {
        const u = await G(m['@odata.id']);
        if (!u.UserName) continue; // 빈 슬롯 제외
        inv.idracUsers.push({ id: u.Id || '', userName: u.UserName, role: u.RoleId || u.Role || '', enabled: u.Enabled !== false });
      } catch { /* skip */ }
    }
  } catch { /* users optional */ }

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
  const G = (p) => get(base, p, entry.username, entry.password);
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
  out.sort((a, b) => (a.type === b.type
    ? String(a.name || '').localeCompare(String(b.name || ''))
    : String(a.type || '').localeCompare(String(b.type || ''))));
  return out;
}

function classifyFw(name) {
  const n = String(name).toLowerCase();
  if (n.includes('bios')) return 'BIOS';
  if (n.includes('idrac') || n.includes('lifecycle') || n.includes('ism')) return 'iDRAC';
  if (n.includes('hba') || n.includes('fibre') || /\bfc\b/.test(n) || n.includes('host bus')) return 'HBA';
  if (n.includes('nic') || n.includes('network') || n.includes('ethernet') || n.includes('mellanox') || n.includes('broadcom') || n.includes('intel(r) ethernet') || n.includes('qlogic') || n.includes('connectx')) return 'NIC';
  if (n.includes('raid') || n.includes('perc') || n.includes('storage') || n.includes('bp') || n.includes('backplane')) return 'Storage';
  if (n.includes('power') || n.includes('psu') || n.includes('supply')) return 'PSU';
  if (n.includes('cpld') || n.includes('complex')) return 'CPLD';
  if (n.includes('disk') || n.includes('ssd') || n.includes('drive') || n.includes('nvme')) return 'Disk';
  if (n.includes('gpu') || n.includes('nvidia')) return 'GPU';
  if (n.includes('driver') || n.includes('os ')) return 'Driver';
  return '기타';
}

/**
 * iDRAC(Redfish)에서 GPU 사용률 수집이 가능한지 실측으로 확인한다.
 * 1) Systems/Processors 중 GPU/Accelerator → 모델·상태·ProcessorMetrics(대역폭/사용률/온도/전력)
 * 2) TelemetryService MetricReports 중 GPU 관련 → 사용률 메트릭 포함 여부
 * 반환 { gpus:[...], telemetry:{available, gpuReports}, utilizationAvailable, notes }.
 * (대부분 모델은 온도/전력은 OOB로 보이나, GPU '사용률(%)'은 iDRAC9+DataCenter 라이선스 +
 *  SMBPBI 지원 데이터센터 GPU에서만 텔레메트리로 노출됨. 미지원이면 게스트 nvidia-smi 권장.)
 */
export async function probeGpuTelemetry(entry) {
  const base = entry.host.replace(/\/+$/, '');
  const G = (p) => get(base, p, entry.username, entry.password);
  const out = { gpus: [], telemetry: { available: false, gpuReports: [] }, utilizationAvailable: false, notes: [] };

  // 1) Processors → GPU/Accelerator
  try {
    const sysRoot = await G('/redfish/v1/Systems');
    const sysId = firstMember(sysRoot);
    if (sysId) {
      const procRoot = await G(`${sysId}/Processors`);
      for (const m of (procRoot.Members || []).slice(0, 24)) {
        let p; try { p = await G(m['@odata.id']); } catch { continue; }
        const isGpu = /gpu|accelerator/i.test(p.ProcessorType || '') || /gpu|nvidia|tesla|a100|h100|h200|l40|l4\b/i.test(`${p.Model || ''} ${p.Name || ''}`);
        if (!isGpu) continue;
        const g = { name: p.Name || p.Id || '', model: (p.Model || '').trim(), manufacturer: p.Manufacturer || '', health: p.Status?.Health || '', state: p.Status?.State || '' };
        // ProcessorMetrics(있으면 대역폭/사용률/온도/전력 — Dell Oem 포함)
        try {
          const pm = await G(`${m['@odata.id']}/ProcessorMetrics`);
          if (num(pm.BandwidthPercent) != null) g.bandwidthPct = num(pm.BandwidthPercent);
          if (num(pm.OperatingSpeedMHz) != null) g.clockMHz = num(pm.OperatingSpeedMHz);
          const dell = pm.Oem?.Dell || {};
          for (const [k, v] of Object.entries(dell)) {
            if (typeof v !== 'number') continue;
            if (/util/i.test(k)) g.utilPct = v;
            else if (/temp/i.test(k)) g.tempC = v;
            else if (/power/i.test(k)) g.powerW = v;
          }
        } catch { /* metrics optional */ }
        out.gpus.push(g);
        if (g.utilPct != null || g.bandwidthPct != null) out.utilizationAvailable = true;
      }
    }
  } catch { out.notes.push('Processors(시스템) 조회 실패 — 권한/모델 확인'); }

  // 2) TelemetryService MetricReports — GPU 관련 리포트 + 사용률 메트릭 유무
  try {
    await G('/redfish/v1/TelemetryService');
    out.telemetry.available = true;
    const reps = await G('/redfish/v1/TelemetryService/MetricReports').catch(() => ({}));
    for (const m of (reps.Members || [])) {
      const id = m['@odata.id'] || '';
      if (!/gpu|accelerator/i.test(id)) continue;
      try {
        const rep = await G(id);
        const vals = rep.MetricValues || [];
        const hasUtil = vals.some((v) => /util|usage|activity/i.test(String(v.MetricId || '')));
        out.telemetry.gpuReports.push({ id: rep.Id || id.split('/').pop(), metrics: vals.length, hasUtilization: hasUtil });
        if (hasUtil) out.utilizationAvailable = true;
      } catch { /* skip report */ }
    }
    if (!out.telemetry.gpuReports.length) out.notes.push('텔레메트리에 GPU 사용률 리포트가 없음(GPU 미지원/리포트 비활성).');
  } catch { out.notes.push('TelemetryService 없음/비활성 — GPU 사용률 OOB 수집 불가(iDRAC9+DataCenter 라이선스 필요).'); }

  if (!out.gpus.length) out.notes.push('iDRAC가 인식한 GPU(Processor/Accelerator)가 없음 — 패스쓰루로 게스트에 직접 할당된 경우 iDRAC에 안 보일 수 있습니다.');
  return out;
}

/**
 * 현재 온도센서 전체 + CPU 사용량(%)을 읽는다(1분 시계열용, 가벼움).
 * 반환 { temps: [{name, celsius}], inletCelsius, maxCelsius, cpuUsagePct }.
 * cpuUsagePct는 Dell 텔레메트리(SystemUsage) 가용 시에만(미지원이면 null).
 */
export async function fetchSensors(entry) {
  const base = entry.host.replace(/\/+$/, '');
  const G = (p) => get(base, p, entry.username, entry.password);

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
