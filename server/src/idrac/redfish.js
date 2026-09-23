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
import { classifyBmcVendor } from './vendorMatch.js'; // v2.495: 비-Dell BMC 판별(추가 HTTP 0회)
import { constants as cryptoConstants } from 'node:crypto';
import { config } from '../config.js';
import { ssrfLookup } from '../util/ssrfLookup.js';
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
    lookup: ssrfLookup, // v2.537: DNS 리바인딩(TOCTOU) 차단 — util/ssrfLookup.js 머리말. v2.506 배선(11곳)에서 빠져 있던 dispatcher.
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
  await drain(res); // Basic 401 본문 소진(undici 소켓 반환) — 챌린지 유무 관계없이.
  if (challenge) {
    const r = await doFetch({ Authorization: buildDigestHeader({ username, password, method: 'GET', uri: pathname, challenge }) });
    if (r.ok) { touchAuthCache(key, { mode: 'digest', challenge }); return r; }
    // Digest가 401이어도 여기서 반환하면 3단계(세션)에 못 감 → 3단 폴백이 사실상 2단이 된다.
    // Digest 광고하지만 실패하는 펌웨어(SHA-256 챌린지·digest 로그인 비활성 등)를 위해 세션으로 진행.
    await drain(r);
  }

  // 3) 세션 토큰 폴백(Basic/Digest 비활성 iDRAC)
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
  // 오류 응답은 본문을 소진(cancel)한 뒤 throw — undici는 미소진 본문이 소켓을 붙잡아
  // 다수 iDRAC 폴링/스캔에서 연결·FD 누수가 누적된다.
  // v2.590(감사 F1): 자격증명 거부를 **출처에서 못 박는다** — `authFailed`·`status` 를 싣는다. 폴러가 문구를
  // 추측하지 않고 주기 수집을 멈출 수 있게. ⚠ 문구에 `401` 을 넣은 이유: 예전 문구
  // 'iDRAC 인증 실패 (사용자/비밀번호 확인)' 에는 숫자가 없어 `fetchUsage` 의 `/\b40[13]\b/` 판정이
  // 401 을 **'unreachable'** 로 분류했다(베어메탈 사용률의 iDRAC 경로가 인증 실패에도 정지하지 않던 원인).
  if (res.status === 401) {
    try { await res.body?.cancel?.(); } catch { /* */ }
    const err = new Error('iDRAC 인증 실패(401) — 사용자/비밀번호 확인');
    err.authFailed = true; err.status = 401;
    throw err;
  }
  if (!res.ok) {
    try { await res.body?.cancel?.(); } catch { /* */ }
    const err = new Error(`Redfish ${pathname} -> ${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Redfish NIC 포트의 '설치된 카드 속도'(Mbps)를 추출한다. 정격/최고(SupportedLinkCapabilities·
 * MaxSpeedGbps)를 현재 링크속도보다 우선해, 포트가 다운(current=0)이어도 10G/25G 카드를 식별한다.
 * ⚠️ 과거 버그: `num(current) ?? caps` 는 current=0에서 0으로 단락돼 정격 폴백이 무시됐다.
 */
export function nicPortSpeedMbps(p = {}) {
  const toMb = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
  const caps = Math.max(0, ...((p.SupportedLinkCapabilities || []).map((c) => toMb(c.LinkSpeedMbps))));
  return caps || (toMb(p.MaxSpeedGbps) * 1000) || (toMb(p.CurrentSpeedGbps) * 1000) || toMb(p.CurrentLinkSpeedMbps) || null;
}

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
  // v2.495: 벤더 판별(순수 vendorMatch) — 이미 받은 루트 문서만 쓴다. 기존 dell 식은 회귀 방지를 위해
  // 그대로 두고 OR 로만 확장한다. 두 반환 지점(인증 실패·성공) 모두 이 필드를 실어야 한다 — HPE 는
  // Dell 계정이 거부돼 **인증 실패 분기**로 빠지는 것이 기본 경로이기 때문.
  const vend = classifyBmcVendor({ root });
  if (vend.vendor === 'dell') dell = true;
  const vendorFields = () => ({ redfish: vend.redfish, vendor: vend.vendor, vendorLabel: vend.label, vendorEvidence: vend.evidence, product: vend.product });

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
      return { ok: true, isIdrac: dell, dell, authFailed: true, authHint, ...vendorFields() };
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
  // 인증이 통했으면 Manufacturer/Model 로 벤더 판별을 보강한다(Oem 키가 없는 범용 BMC 등).
  const vend2 = (vend.vendor === 'unknown' && (manufacturer || model)) ? classifyBmcVendor({ root, manufacturer, model }) : vend;
  if (vend2.vendor === 'dell') dell = true;
  return {
    ok: true, isIdrac: dell, dell, authFailed: false, model, manufacturer, serviceTag, hostName,
    redfish: vend2.redfish, vendor: dell ? 'dell' : vend2.vendor, vendorLabel: dell ? 'Dell' : vend2.label, vendorEvidence: vend2.evidence, product: vend2.product,
  };
}

/**
 * Collect a rich hardware/firmware inventory from one iDRAC via Redfish:
 * hostname, service tag, BIOS version + key CMOS settings, iDRAC firmware,
 * IPMI version, CPU/memory summary, health, and iDRAC network identity.
 * Best-effort: missing sub-resources are tolerated.
 *
 * v2.548 F1 — `inv.collections`(컬렉션별 'ok'|'failed') + `inv.reachable` 메타를 싣는다. 이 함수는
 * 모든 블록이 `catch {}` 라 **어떤 경우에도 던지지 않고**, 연결 거부 호스트에도 29ms 만에 `collectedAt`
 * 이 신선한 **빈 인벤토리**를 돌려준다. 그래서 파트 장애 판정(`partfault/`)이 '부품 0개 = 정상' 으로
 * 읽어 열린 장애를 거짓으로 닫았다. 소비처는 실패한 컬렉션의 열린 장애를 **닫지 않고 보류**한다
 * (`HOLD_REASON.collectionFailed`). 키 이름은 `partfault/types.js COLLECTION_KINDS` 와 글자 그대로 같다.
 */
export async function fetchInventory(entry) {
  const base = entry.host.replace(/\/+$/, '');
  const G = (p) => get(base, p, entry.username, entry.password);

  const inv = { collectedAt: Date.now(), system: {}, idrac: {}, cpu: {}, memory: {}, network: [], bios: {} };
  // 컬렉션별 성공/실패 메타(v2.548 F1). 기본값이 **'failed'** 인 이유: 아래 블록 다수가 `if (sysId)` 로
  // 감싸여 있어 Systems GET 이 실패하면 **try 본문이 실행되지 않고 catch 도 타지 않는다** — `{}` 로
  // 시작하면 그 컬렉션은 undefined 로 남아 '읽었는지' 를 말할 수 없다. 성공 지점에 닿은 것만 'ok' 로
  // 뒤집는다(GET 이 성공했으면 멤버가 0개여도 '읽었다'). 닿지 못한 모든 경로는 '읽지 못함' 이라야
  // 열린 장애를 거짓으로 닫지 않는다. ⚠ `fans` 는 fetchSensors(Thermal) 경로라 여기 없다.
  // `system` 은 Systems 멤버(sysId)를 얻었는가 — 파트 장애의 장비 키(서비스태그·UUID)가 여기서 나온다(v2.548 C3).
  inv.collections = { system: 'failed', psus: 'failed', disks: 'failed', storageControllers: 'failed', memoryDimms: 'failed', cpus: 'failed', gpus: 'failed', pcie: 'failed' };
  // Systems GET 이 (인증 포함) 응답했거나 어느 컬렉션이든 하나라도 'ok' 면 true. 전부 실패면 false.
  inv.reachable = false;

  // --- System (identity, CPU/mem summary, BIOS version, hostname, health) ---
  let sysId = null;
  try {
    const sysRoot = await G('/redfish/v1/Systems');
    inv.reachable = true; // 인증까지 통과한 응답을 받았다(get() 은 401·비-2xx 에 던진다)
    sysId = firstMember(sysRoot);
    if (sysId) {
      const s = await G(sysId);
      inv.collections.system = 'ok';   // 여기까지 왔으면 서비스태그·UUID 를 읽을 수 있는 응답을 받았다
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
          // 파트 인벤토리용 식별 필드 — 같은 응답에 이미 있어 추가 HTTP 0회.
          manufacturer: p.Manufacturer || '',
          serial: p.SerialNumber || '',
          partNumber: p.PartNumber || '',
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
    inv.collections.psus = 'ok'; // Chassis GET 성공 — 개별 Chassis/Power 실패(continue)는 컬렉션을 뒤집지 않는다
  } catch { inv.collections.psus = 'failed'; /* psu optional */ }

  // --- 물리 디스크 상태(스토리지): 모델·용량·미디어·SMART 예측 실패·상태 ---
  // + 스토리지 컨트롤러(PERC/HBA) — 이미 GET 하는 컨트롤러 응답의 StorageControllers[] 를
  //   버리고 있었다(파트 인벤토리용, 추가 HTTP 0회).
  inv.disks = [];
  inv.storageControllers = [];
  try {
    if (sysId) {
      const stRoot = await G(`${sysId}/Storage`);
      for (const c of (stRoot.Members || []).slice(0, 8)) {
        let ctrl; try { ctrl = await G(c['@odata.id']); } catch { continue; }
        for (const sc of (ctrl.StorageControllers || []).slice(0, 4)) {
          inv.storageControllers.push({
            name: sc.Name || ctrl.Name || ctrl.Id || '',
            model: (sc.Model || '').trim(),
            manufacturer: sc.Manufacturer || '',
            firmware: sc.FirmwareVersion || '',
            speedGbps: num(sc.SpeedGbps),
            protocols: (sc.SupportedDeviceProtocols || []).join('/'),
            health: sc.Status?.Health || '',
          });
        }
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
              // ⚠ v2.547 — 예전에는 `!!(drive.FailurePredicted)` 라 **필드 부재(undefined)를
              //   false 로 굳혔다**. '예측 실패 없음' 과 '읽지 못함' 이 구분되지 않았고,
              //   그 둘 중 **위험한 쪽(조용히 정상)** 으로 떨어졌다(v2.525 `Number(null)===0` 계열).
              predictiveFailure: drive.FailurePredicted == null ? null : !!drive.FailurePredicted,
              rpm: num(drive.RotationSpeedRPM),
            });
          } catch { /* skip drive */ }
        }
      }
      if (inv.disks.length) inv.health.storage = inv.disks.some((d) => d.predictiveFailure || (d.health && d.health !== 'OK')) ? 'Warning' : 'OK';
      // 한 GET(Storage)에서 두 컬렉션을 읽으므로 둘을 같이 찍는다.
      inv.collections.disks = 'ok';
      inv.collections.storageControllers = 'ok';
    }
  } catch { inv.collections.disks = 'failed'; inv.collections.storageControllers = 'failed'; /* storage optional */ }

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
            // 파트 인벤토리용 — 같은 응답에 이미 있음(추가 HTTP 0회).
            partNumber: (d.PartNumber || '').trim(),
            serial: d.SerialNumber || '',
            rank: num(d.RankCount),
            health: d.Status?.Health || '',
            state: d.Status?.State || '',
          });
        } catch { /* skip dimm */ }
      }
      inv.collections.memoryDimms = 'ok';
    }
  } catch { inv.collections.memoryDimms = 'failed'; /* memory optional */ }

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

  // --- GPU(Accelerator) + 개별 CPU 소켓 목록 (Processors 멤버를 이미 전부 GET — 추가 HTTP 0회) ---
  // 과거에는 GPU 가 아니면 응답을 버렸다. 파트 인벤토리용으로 CPU 소켓별 모델/코어/클럭도 보관.
  inv.gpus = [];
  inv.cpus = [];
  try {
    if (sysId) {
      const procRoot = await G(`${sysId}/Processors`);
      for (const m of (procRoot.Members || []).slice(0, 24)) {
        let p; try { p = await G(m['@odata.id']); } catch { continue; }
        const isGpu = /gpu|accelerator/i.test(p.ProcessorType || '') || /gpu|nvidia|tesla|a100|h100|h200|l40|l4\b/i.test(`${p.Model || ''} ${p.Name || ''}`);
        if (!isGpu) {
          if (/cpu/i.test(p.ProcessorType || '') || num(p.TotalCores) != null) {
            inv.cpus.push({
              socket: p.Socket || p.Id || '', model: (p.Model || '').trim(), manufacturer: p.Manufacturer || '',
              cores: num(p.TotalCores), threads: num(p.TotalThreads), maxSpeedMHz: num(p.MaxSpeedMHz),
              health: p.Status?.Health || '', state: p.Status?.State || '',
            });
          }
          continue;
        }
        inv.gpus.push({ name: p.Name || p.Id || '', model: (p.Model || '').trim(), manufacturer: p.Manufacturer || '', health: p.Status?.Health || '', state: p.Status?.State || '' });
      }
      if (inv.gpus.length) inv.health.gpu = inv.gpus.some((g) => g.health && g.health !== 'OK') ? 'Warning' : 'OK';
      // Processors 한 GET 에서 GPU 와 CPU 소켓을 함께 읽으므로 둘을 같이 찍는다.
      inv.collections.gpus = 'ok';
      inv.collections.cpus = 'ok';
    }
  } catch { inv.collections.gpus = 'failed'; inv.collections.cpus = 'failed'; /* gpu optional */ }

  // --- NIC 어댑터/포트: 모델·링크 상태·속도 ---
  // iDRAC9(R750 등)는 포트가 어댑터의 NetworkPorts/Ports 또는 Controllers[].Links 로 흩어져 있고,
  // 속도 필드도 SupportedLinkCapabilities.LinkSpeedMbps(정격)·CurrentLinkSpeedMbps·(신형)
  // MaxSpeedGbps/CurrentSpeedGbps 로 제각각이다. '설치된 카드 속도'가 중요하므로 정격/최고를
  // 우선 추출한다(다운 포트여도 10G 카드 식별). ⚠️ 과거 버그: `num(current) ?? caps` 는 다운 포트
  // (current=0)에서 0으로 단락돼 정격 폴백이 무시됐다 → 대부분 서버가 '정보없음'으로 나왔다.
  const toMb = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
  const portSpeedMbps = nicPortSpeedMbps;
  inv.nics = [];
  try {
    const chassisRoot = await G('/redfish/v1/Chassis');
    for (const cm of (chassisRoot.Members || []).map((x) => x['@odata.id']).filter(Boolean).slice(0, 6)) {
      let na; try { na = await G(`${cm}/NetworkAdapters`); } catch { continue; }
      for (const am of (na.Members || []).slice(0, 12)) {
        let a; try { a = await G(am['@odata.id']); } catch { continue; }
        // 포트 링크 후보: 어댑터의 NetworkPorts/Ports + 각 컨트롤러의 Links.(NetworkPorts|Ports).
        const collLinks = new Set();
        for (const l of [a.NetworkPorts?.['@odata.id'], a.Ports?.['@odata.id']]) if (l) collLinks.add(l);
        for (const ctl of (a.Controllers || [])) {
          for (const arr of [ctl.Links?.NetworkPorts, ctl.Links?.Ports]) for (const ref of (arr || [])) if (ref?.['@odata.id']) collLinks.add(ref['@odata.id']);
        }
        // 컬렉션 링크(.../NetworkPorts)면 Members 순회, 개별 포트 링크면 그대로 조회.
        const portRefs = [];
        for (const link of collLinks) {
          try { const r = await G(link); if (Array.isArray(r.Members)) portRefs.push(...r.Members.map((m) => m['@odata.id']).filter(Boolean)); else portRefs.push(link); }
          catch { /* skip link */ }
        }
        const ports = [];
        for (const pref of [...new Set(portRefs)].slice(0, 16)) {
          try {
            const p = await G(pref);
            ports.push({
              id: p.Id || p.Name || '', link: p.LinkStatus || p.Status?.State || '', speedMbps: portSpeedMbps(p),
              // MAC — 파트/자산 추적용(같은 응답, 추가 HTTP 0회). 표기가 세대별로 갈린다.
              mac: (p.AssociatedNetworkAddresses || [])[0] || (p.Ethernet?.AssociatedMACAddresses || [])[0] || '',
            });
          } catch { /* skip port */ }
        }
        inv.nics.push({
          name: a.Id || a.Model || '', model: a.Model || a.Manufacturer || '', ports,
          // 파트 인벤토리용 식별 필드(어댑터 응답에 이미 있음).
          partNumber: a.PartNumber || '', serial: a.SerialNumber || '',
          firmware: (a.Controllers || [])[0]?.FirmwarePackageVersion || '',
        });
      }
    }
  } catch { /* nics optional */ }
  // 폴백: NetworkAdapters에서 속도를 못 얻으면 Systems/EthernetInterfaces의 SpeedMbps 사용
  // (Dell은 물리 포트가 EthernetInterfaces로도 노출되며 SpeedMbps에 링크 속도가 담긴다).
  if (!inv.nics.some((n) => (n.ports || []).some((p) => p.speedMbps)) && sysId) {
    try {
      const ei = await G(`${sysId}/EthernetInterfaces`);
      const eports = [];
      for (const em of (ei.Members || []).slice(0, 32)) {
        try { const e = await G(em['@odata.id']); const mb = toMb(e.SpeedMbps); if (mb) eports.push({ id: e.Id || e.Name || '', link: e.LinkStatus || '', speedMbps: mb }); }
        catch { /* skip */ }
      }
      if (eports.length) inv.nics.push({ name: 'EthernetInterfaces', model: '(EthernetInterfaces)', ports: eports });
    } catch { /* optional */ }
  }

  // --- PCIe 디바이스 목록(파트 인벤토리) — 이 인벤토리에서 유일한 '신규' 컬렉션 호출(+1+N GET,
  //     N≤16). RAID/NIC/GPU 외의 애드인 카드(HBA·DPU·가속기 등)까지 슬롯 단위로 확보한다.
  //     구세대 iDRAC 은 미지원(404) — 조용히 빈 배열 유지. ---
  inv.pcie = [];
  try {
    if (sysId) {
      const pcRoot = await G(`${sysId}/PCIeDevices`);
      for (const m of (pcRoot.Members || []).slice(0, 16)) {
        try {
          const d = await G(m['@odata.id']);
          inv.pcie.push({
            name: d.Name || d.Id || '',
            model: (d.Model || '').trim(),
            manufacturer: d.Manufacturer || '',
            deviceType: d.DeviceType || '',
            firmware: d.FirmwareVersion || '',
            health: d.Status?.Health || '',
          });
        } catch { /* skip device */ }
      }
      inv.collections.pcie = 'ok';
    }
  } catch { inv.collections.pcie = 'failed'; /* pcie optional(구세대 미지원) — 404 도 '읽지 못함' 이다 */ }

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

  // Systems 는 실패했어도 Chassis(psus) 처럼 sysId 없이 도는 컬렉션이 응답했으면 장비는 닿은 것이다.
  if (Object.values(inv.collections).includes('ok')) inv.reachable = true;

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
 * 반환 { temps: [{name, celsius}], inletCelsius, maxCelsius, cpuUsagePct, thermalOk, error }.
 * cpuUsagePct는 Dell 텔레메트리(SystemUsage) 가용 시에만(미지원이면 null).
 *
 * ⚠⚠ v2.590(감사 F7) — **읽지 못한 것을 '읽었고 0개' 로 돌려주지 않는다.** 예전에는 Thermal 블록 전체가
 *   `catch { /* thermal optional *\/ }` 라 이 함수는 **어떤 경우에도 던지지 않았다**(전부 401 이어도) —
 *   그래서 ① 폴러의 `sensorError`(v2.493 '센서만 실패하는 상황을 진단') 가 한 번도 채워지지 않았고
 *   ② 빈 센서 표본이 매 분 쌓였으며 ③ 파트 장애의 `collections.fans` 가 항상 'ok'(v2.548 F1 의 '수집 실패 ≠
 *   부품 0개' 가 팬에서만 무력)였다. 이제:
 *   · **Chassis 루트 GET 이 실패하면 던진다** — 인증 실패(`authFailed`)·연결 실패를 호출자가 구분한다.
 *   · 멤버의 Thermal 이 **하나도** 안 읽히면 `thermalOk:false` + `error`(멤버 0개도 '읽은 것이 없다' 다).
 *     하나라도 읽혔으면 `thermalOk:true`(일부 섀시 실패는 부분 결과로 남긴다 — 예전 동작과 같다).
 */
export async function fetchSensors(entry) {
  const base = entry.host.replace(/\/+$/, '');
  const G = (p) => get(base, p, entry.username, entry.password);

  const temps = [];
  const fans = [];
  let thermalRead = 0;
  let thermalFailed = 0;
  let thermalErr = '';
  // 1) 모든 Chassis의 Thermal → Temperatures[] + Fans[]
  // Chassis 루트는 try 밖이다(v2.590) — 못 읽으면 던진다(인증 실패·연결 실패를 삼키지 않는다).
  const chassisRoot = await G('/redfish/v1/Chassis');
  {
    for (const m of (chassisRoot.Members || []).map((x) => x['@odata.id']).filter(Boolean)) {
      let thermal;
      try { thermal = await G(`${m}/Thermal`); thermalRead += 1; }
      catch (e) {
        thermalFailed += 1;
        if (!thermalErr) thermalErr = String(e?.message || e).slice(0, 200);
        // 인증 거부는 다른 섀시도 같은 결과다 — 더 시도하지 않고 올린다(계정 잠금 방지).
        if (e?.authFailed) throw e;
        continue;
      }
      for (const t of thermal.Temperatures || []) {
        const c = num(t.ReadingCelsius);
        if (c == null) continue;
        const name = t.Name || t.MemberId || `Sensor ${t.SensorNumber ?? ''}`.trim();
        temps.push({ name, celsius: c });
      }
      for (const f of thermal.Fans || []) {
        const rpm = num(f.Reading ?? f.ReadingRPM);
        /*
         * ⚠ v2.547 — 예전에는 `if (rpm == null) continue;` 였다. **멈춘 팬이 Reading 을 주지
         *   않으면 그 팬이 배열에서 통째로 사라져** 장애를 영원히 볼 수 없었다('팬 0개' 와
         *   '팬을 읽지 못했다' 가 구분되지 않는다 — CLAUDE.md v2.493 규약 위반).
         *   이제 rpm 은 `null` 로 남기고 **레코드는 남긴다**. 상태 판정은 health 가 한다.
         *   ⚠ 이름도 rpm 도 없는 항목만 버린다(그건 팬이라고 볼 근거가 없다).
         */
        const fname = f.Name || f.FanName || f.MemberId || '';
        if (rpm == null && !fname && !f.Status?.Health) continue;
        fans.push({
          name: fname || 'Fan', rpm,
          // 파트 인벤토리용 식별 필드(같은 응답, 추가 HTTP 0회). 시계열(sensorStore)에는
          // 싣지 않고 폴러가 인벤토리 갱신 시에만 invCache 로 옮긴다(시계열 비대화 방지).
          model: f.Model || '', partNumber: f.PartNumber || '', manufacturer: f.Manufacturer || '',
          health: f.Status?.Health || '', redundant: Array.isArray(f.Redundancy) && f.Redundancy.length > 0,
        });
      }
    }
  }
  const thermalOk = thermalRead > 0;
  const thermalError = thermalOk ? null
    : (thermalFailed ? `Thermal 조회 실패(섀시 ${thermalFailed}개 전부): ${thermalErr}` : 'Chassis 멤버가 없어 Thermal 을 읽을 대상이 없습니다');

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

  return { temps, fans, inletCelsius, maxCelsius, cpuUsagePct, thermalOk, error: thermalError };
}

/*
 * ══ iDRAC 텔레메트리 **전수 활용**(v2.551) ══════════════════════════════════
 * 사용자 요청: 방금 만든 '베어메탈 사용률' 개선 → 「iDRAC 텔레메트리 리포트 전수 활용」.
 *
 * v2.550 은 `SystemUsage` 리포트 **하나만** 읽어 CPU·메모리·I/O(집계)뿐이었다. 그래서 디스크·
 * 네트워크·HBA 는 **OS 계정이 있는 서버만** 값이 나왔고, 이 현장은 OS 계정 등록이 소수라 화면
 * 대부분이 `—` 로 남는다. iDRAC9 텔레메트리에는 NIC·FC 통계 리포트가 따로 있으므로 그것을 읽는다.
 *
 * ⚠⚠ **왕복 예산을 먼저 계산했다**(v2.528 Unity 전량 실패와 같은 함정을 피하려고):
 *   장비당 `목록 1회 + 리포트 6개(동시 3) = 3배치 × 2초 ≈ 6초` 이고 200대 · 동시 4면 **300초**로
 *   **주기(300초)와 같아진다**. 그래서 두 가지를 둔다 —
 *    ① **리포트 목록 캐시**(6시간. 목록은 라이선스·펌웨어가 바뀔 때만 변한다) → 정상 상태 200초
 *    ② **주기당 목록 조회 예산**(`allowList`) → 첫 주기에 200대가 동시에 목록을 받지 않는다.
 *       목록이 없는 장비는 그 주기에 `SystemUsage` 만 읽고(v2.550 과 같은 비용) 점진적으로 채운다.
 *   이 두 개를 지우면 첫 주기가 주기를 넘겨 재진입 가드가 다음 틱을 계속 건너뛴다.
 *
 * ⚠ **정직 기록 — 이 현장 iDRAC 의 실제 리포트 목록을 본 적이 없다.** 그래서 id 를 굳히지 않고
 *   목록을 열거해 **이름 패턴이 맞는 것만** 읽으며, 장비가 가진 전체 목록(`seenReports`)과 실제로
 *   읽은 것(`usedReports`)을 응답에 실어 화면이 장비별로 밝힌다(사용자 선택).
 */
const REPORT_TTL_MS = Math.max(60_000, Number(process.env.BMUSAGE_REPORT_TTL_MS) || 6 * 3_600_000);
const MAX_REPORTS_PER_DEVICE = Math.max(1, Number(process.env.BMUSAGE_MAX_REPORTS) || 6);
const REPORT_FETCH_CONCURRENCY = 3;   // 한 장비에 동시 GET — iDRAC(BMC)은 약하므로 보수적으로
/** hostKey → { ids: string[], at: number } */
const _reportList = new Map();
export function _resetReportListForTest() { _reportList.clear(); }
/** 화면·테스트가 캐시 상태를 볼 수 있게(비밀 없음). */
export function reportListCacheInfo() {
  return { entries: _reportList.size, ttlMs: REPORT_TTL_MS, maxReports: MAX_REPORTS_PER_DEVICE };
}

/** 리포트 URL 을 동시성 제한으로 읽는다(한 장비 안에서). */
async function getReports(G, ids) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(REPORT_FETCH_CONCURRENCY, ids.length) }, async () => {
    for (;;) {
      const idx = i; i += 1;
      if (idx >= ids.length) return;
      try { out.push(await G(ids[idx])); } catch { /* 그 리포트만 건너뛴다 */ }
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 텔레메트리 리포트 전수 조회. `fetchUsage` 가 `full` 일 때 쓴다.
 * @param {object} entry  iDRAC 등록 항목
 * @param {{allowList?:boolean}} opt  `allowList:false` 면 **캐시된 목록만** 쓴다(주기 예산 보호)
 * @returns {Promise<object|null>} `null` = 이번 주기에 전수 조회를 하지 않았다(목록 미보유)
 */
async function fetchTelemetryReports(entry, { allowList = true } = {}) {
  const base = entry.host.replace(/\/+$/, '');
  const G = (p) => get(base, p, entry.username, entry.password);
  const key = `${base}|${entry.username || ''}`.toLowerCase();
  const cached = _reportList.get(key);
  let ids = (cached && Date.now() - cached.at < REPORT_TTL_MS) ? cached.ids : null;
  let listedNow = false;
  if (!ids) {
    if (!allowList) return null;                       // 예산 없음 — 다음 주기에
    const reps = await G('/redfish/v1/TelemetryService/MetricReports');
    ids = (reps.Members || []).map((m) => String(m['@odata.id'] || '')).filter(Boolean);
    _reportList.set(key, { ids, at: Date.now() });
    listedNow = true;
  }
  const { isWantedReport, buildIdracUsage } = await import('../bmusage/parse/idracTelemetry.js');
  const idOf = (u) => u.split('/').filter(Boolean).pop() || '';
  const wanted = ids.filter((u) => isWantedReport(idOf(u))).slice(0, MAX_REPORTS_PER_DEVICE);
  const reports = wanted.length ? await getReports(G, wanted) : [];
  const built = buildIdracUsage(reports, ids.map(idOf));
  built.listedNow = listedNow;
  built.reportsRequested = wanted.length;
  return built;
}

/**
 * Dell 텔레메트리 `SystemUsage` 리포트 → CPU·메모리·I/O 사용률(%). (v2.550)
 *
 * 사용자 요청(2026-09-17): 베어메탈 서버의 CPU·메모리·디스크·네트워크·HBA 사용률 수집.
 * **이 경로가 주는 것은 CPU·MEM·IO(집계)뿐**이다 — 디스크·네트워크·HBA 개별 사용률은 여기에 없고
 * OS 경로(`bmusage/collectors/osSsh.js`)만 준다. 그 한계를 화면이 말해야 한다.
 *
 * ⚠⚠ **메트릭 id 를 하나로 굳히지 말 것**(v2.545 '후보 체인' 규약): 이 저장소에서 실제로 확인된
 *   것은 `fetchSensors` 가 쓰는 `SystemBoardCPUUsage`/`CPUUsage` 뿐이고, MEM·IO id 는 Dell 문서
 *   기반 **추정**이다(이 현장 응답을 본 적이 없다). 그래서 후보 목록으로 찾고 **실제로 쓴 id** 를
 *   `usedIds` 로, 응답에 있던 전체 id 를 `seenIds` 로 돌려준다 — 실장비 응답을 받으면 좁힐 것.
 * ⚠ 텔레메트리는 **iDRAC Datacenter 라이선스**가 필요하다(없으면 404/빈 리포트). 그 경우
 *   `ok:false, kind:'no-telemetry'` 이고 '미지원' 이라 단정하지 않는다(v2.493 규약) —
 *   404·403·빈 리포트를 각각 구분해 돌려준다.
 */
const USAGE_IDS = Object.freeze({
  cpuPct: ['SystemBoardCPUUsage', 'CPUUsage', 'SystemBoardCPUUsagePercent'],
  memPct: ['SystemBoardMEMUsage', 'MemoryUsage', 'SystemBoardMemoryUsage'],
  ioPct: ['SystemBoardIOUsage', 'IOUsage', 'SystemBoardIOUsagePercent'],
  sysPct: ['SystemBoardSYSUsage', 'SYSUsage', 'SystemUsage'],
});

export async function fetchUsage(entry, { full = false, allowList = true } = {}) {
  const base = String(entry.host || '').replace(/\/+$/, '');
  /*
   * ── 전수 모드(v2.551) ──────────────────────────────────────────────────────
   * 리포트 목록을 열거해 NIC·FC·스토리지 통계까지 읽는다. **실패하면 `SystemUsage` 단독 경로로
   * 떨어진다**(아래) — 전수 조회가 안 되는 장비에서 CPU·메모리마저 잃으면 개선이 퇴행이 된다.
   * ⚠ `null` 은 '이번 주기에 전수 조회를 하지 않았다'(목록 미보유 + 예산 없음)는 뜻이고 실패가 아니다.
   */
  if (full) {
    try {
      const r = await fetchTelemetryReports(entry, { allowList });
      // 보드 지표를 하나라도 읽었으면 전수 결과를 쓴다. 아무것도 못 읽었으면 단독 경로가 더 낫다.
      if (r && (r.cpuPct != null || r.memPct != null || r.nics.length || r.fcs.length || r.disks.length)) {
        return { ...r, ok: true, full: true, at: r.at || Date.now() };
      }
      if (r) {
        // 리포트는 열거했는데 아는 것이 없었다 — 그 사실을 실어 단독 경로로 내려간다.
        const fb = await fetchUsage(entry, { full: false });
        return fb.ok
          ? { ...fb, seenReports: r.seenReports, usedReports: r.usedReports, absent: r.absent, fullTried: true }
          : { ...fb, seenReports: r.seenReports, usedReports: r.usedReports, fullTried: true };
      }
    } catch (e) {
      const msg = String(e?.message || e);
      // 401/403 은 자격증명이라 단독 경로도 같은 결과다 — 바로 알린다(반복 시도 금지 — 계정 잠금).
      if (/\b40[13]\b/.test(msg)) return { ok: false, kind: 'auth', error: msg.slice(0, 300) };
      /* 그 밖(404·타임아웃)은 단독 경로로 내려간다 */
    }
    const fb = await fetchUsage(entry, { full: false });
    return { ...fb, fullTried: true };
  }
  let rep;
  try {
    rep = await get(base, '/redfish/v1/TelemetryService/MetricReports/SystemUsage', entry.username, entry.password);
  } catch (e) {
    const msg = String(e?.message || e);
    // 404 는 '이 iDRAC 에 그 리포트가 없다'(라이선스·버전), 401/403 은 자격증명이다 — 조치가 다르다.
    const kind = /\b404\b/.test(msg) ? 'no-telemetry' : (/\b40[13]\b/.test(msg) ? 'auth' : 'unreachable');
    return { ok: false, kind, error: msg.slice(0, 300) };
  }
  const vals = Array.isArray(rep?.MetricValues) ? rep.MetricValues : [];
  const seenIds = vals.map((v) => String(v.MetricId || '')).filter(Boolean);
  if (!vals.length) return { ok: false, kind: 'empty-report', error: 'SystemUsage 리포트가 비어 있습니다(텔레메트리가 켜져 있지 않을 수 있습니다).', seenIds };

  const byId = new Map();
  for (const v of vals) {
    const id = String(v.MetricId || '').trim();
    if (!id || byId.has(id.toLowerCase())) continue;
    byId.set(id.toLowerCase(), v.MetricValue);
  }
  const out = { ok: true, seenIds, usedIds: {}, at: Date.now() };
  for (const [field, cands] of Object.entries(USAGE_IDS)) {
    for (const c of cands) {
      if (!byId.has(c.toLowerCase())) continue;
      // `37` · `37 %` · `37.5` 형태가 섞여 온다 — 숫자만 뽑는다. 못 뽑으면 **그 필드를 만들지 않는다**.
      const n = Number(String(byId.get(c.toLowerCase())).replace(/[^\d.]/g, ''));
      if (!Number.isFinite(n)) continue;
      out[field] = Math.round(n * 10) / 10;
      out.usedIds[field] = c;
      break;
    }
  }
  // 하나도 못 읽었으면 성공이 아니다 — '오류가 없다' 를 '읽었다' 로 쓰지 않는다(v2.545 규약).
  if (!Object.keys(out.usedIds).length) {
    return { ok: false, kind: 'ids-unmatched', error: `SystemUsage 에서 아는 메트릭 id 를 찾지 못했습니다(응답 id ${seenIds.length}개).`, seenIds };
  }
  return out;
}

export { USAGE_IDS };

/*
 * ══ Enterprise 라이선스 대체 경로 — 표준 Redfish `Sensors` (v2.554) ═══════════
 *
 * 사용자 신고(2026-09-17): "idarc 텔레메트리는 data center 라이선스가 필요한데, 내가 가진건
 * enterprise 라이선스라서, 엔터프라이즈 라이선스 대상 서버도 수집하는 기능 추가로 만들어줘".
 *
 * `TelemetryService/MetricReports` 는 Datacenter 전용이다(사용자 확인). 그래서 **텔레메트리가 아닌**
 * 경로로 보드 사용률을 찾는다 — 표준 Redfish 의 `Chassis/<id>/Sensors` 컬렉션이다.
 *
 * ⚠⚠ **정직 기록 — 이 현장 iDRAC 에서 이 컬렉션의 응답을 받아 본 적이 없다.** Redfish 스키마상
 *   `Sensors` 는 `Reading` 을 주는 표준 자원이고 iDRAC9 펌웨어 4.40 이후 존재한다고 알려져 있으나
 *   **확인하지 못했다**. 그래서 ① id 를 굳히지 않고 컬렉션을 **열거해 이름 패턴으로** 찾고
 *   ② 찾지 못하면 `absent` 로 밝히며 ③ 찾은 URL 과 못 찾은 사실을 **캐시**해 매 주기 다시 찔러
 *   장비를 괴롭히지 않는다. 첫 실수집에서 `usedPaths`·`seenSensors` 를 보고 좁힐 것.
 *
 * ⚠⚠ **왕복 예산**(v2.551 과 같은 산수): 탐색은 `Chassis 1회 + Sensors 컬렉션 최대 2회` 이고
 *   정상 상태는 **캐시된 URL 4개 이하의 GET** 뿐이다(동시 3). 탐색 결과를 캐시하지 않으면
 *   200대 × 3회가 매 주기에 더해져 주기를 넘긴다.
 */
const SENSOR_TTL_MS = Math.max(60_000, Number(process.env.BMUSAGE_SENSOR_TTL_MS) || 6 * 3_600_000);
/** 이름 패턴 → 우리 필드. `USAGE_IDS` 와 **같은 후보 문자열**을 쓴다(두 벌을 만들지 않는다). */
const SENSOR_PATTERNS = Object.freeze([
  ['cpuPct', /cpu.*usage|usage.*cpu/i],
  ['memPct', /(?:mem|memory).*usage|usage.*(?:mem|memory)/i],
  ['ioPct', /(?:^|[^a-z])io.*usage|usage.*io(?:[^a-z]|$)/i],
  ['sysPct', /sys(?:tem)?.*usage|usage.*sys(?:tem)?/i],
]);
/** base|user → { urls:{field:url}, seen:string[], at:number } | { absent:true, reason, at } */
const _sensorPaths = new Map();
export function _resetSensorPathsForTest() { _sensorPaths.clear(); }
export function sensorPathCacheInfo() { return { entries: _sensorPaths.size, ttlMs: SENSOR_TTL_MS }; }

/** 이름 꼬리만(URL 마지막 조각) — 센서 id 가 곧 이름인 경우가 많다. */
const tailOf = (u) => String(u || '').split('/').filter(Boolean).pop() || '';

/**
 * 표준 Redfish `Sensors` 로 보드 사용률을 읽는다(Enterprise 대체 경로).
 * @param {object} entry iDRAC 등록 항목(host·username·password)
 * @param {{allowProbe?:boolean}} opt `allowProbe:false` 면 **캐시가 있을 때만** 읽는다(주기 예산 보호)
 * @returns {Promise<object>} `{ ok, cpuPct?, memPct?, ioPct?, sysPct?, usedPaths, seenSensors,
 *   absent, kind?, error? }` — `kind:'not-probed'` 는 실패가 아니라 '이번 주기엔 탐색 안 함' 이다.
 */
export async function fetchUsageSensors(entry, { allowProbe = true } = {}) {
  const base = String(entry.host || '').replace(/\/+$/, '');
  const G = (p) => get(base, p, entry.username, entry.password);
  const key = `${base}|${entry.username || ''}`.toLowerCase();
  const cached = _sensorPaths.get(key);
  const fresh = cached && Date.now() - cached.at < SENSOR_TTL_MS;
  if (fresh && cached.absent) {
    return { ok: false, kind: 'absent', error: cached.reason, usedPaths: {}, seenSensors: cached.seen || [], absent: ['sensors'] };
  }
  let urls = fresh ? cached.urls : null;
  let seen = fresh ? (cached.seen || []) : [];

  if (!urls) {
    if (!allowProbe) return { ok: false, kind: 'not-probed', usedPaths: {}, seenSensors: [], absent: [] };
    try {
      const chassisRoot = await G('/redfish/v1/Chassis');
      const members = (chassisRoot.Members || []).map((x) => x['@odata.id']).filter(Boolean).slice(0, 2);
      const found = {};
      const names = [];
      for (const c of members) {
        let coll;
        try { coll = await G(`${c}/Sensors`); } catch { continue; }
        for (const m of (coll.Members || [])) {
          const u = String(m['@odata.id'] || '');
          if (!u) continue;
          const name = tailOf(u);
          names.push(name);
          for (const [field, re] of SENSOR_PATTERNS) {
            if (found[field] || !re.test(name)) continue;
            found[field] = u;
            break;
          }
        }
        if (Object.keys(found).length) break;   // 한 섀시에서 찾으면 더 열거하지 않는다
      }
      seen = [...new Set(names)].slice(0, 40);
      if (!Object.keys(found).length) {
        const reason = names.length
          ? `이 iDRAC 의 Sensors 컬렉션에 사용률 센서가 없습니다(센서 ${names.length}개 중 이름이 맞는 것 0개).`
          : '이 iDRAC 에 표준 Redfish Sensors 컬렉션이 없습니다(펌웨어가 오래되었을 수 있습니다).';
        _sensorPaths.set(key, { absent: true, reason, seen, at: Date.now() });
        return { ok: false, kind: 'absent', error: reason, usedPaths: {}, seenSensors: seen, absent: ['sensors'] };
      }
      urls = found;
      _sensorPaths.set(key, { urls, seen, at: Date.now() });
    } catch (e) {
      const msg = String(e?.message || e);
      // ⚠ 401/403 은 캐시하지 않는다 — 비밀번호를 고치면 바로 되어야 한다.
      const kind = /\b40[13]\b/.test(msg) ? 'auth' : (/\b404\b/.test(msg) ? 'absent' : 'unreachable');
      if (kind === 'absent') {
        _sensorPaths.set(key, { absent: true, reason: 'Sensors 경로가 없습니다(404).', seen: [], at: Date.now() });
      }
      return { ok: false, kind, error: msg.slice(0, 300), usedPaths: {}, seenSensors: [], absent: kind === 'absent' ? ['sensors'] : [] };
    }
  }

  // ── 값 읽기 — 캐시된 URL 만 GET 한다(동시 3, `getReports` 와 같은 보수적 상한) ──
  const fields = Object.entries(urls);
  const out = { ok: false, usedPaths: {}, seenSensors: seen, absent: [], at: Date.now() };
  let i = 0;
  const workers = Array.from({ length: Math.min(3, fields.length) }, async () => {
    for (;;) {
      const idx = i; i += 1;
      if (idx >= fields.length) return;
      const [field, u] = fields[idx];
      try {
        const s = await G(u);
        // ⚠ `Reading` 이 없으면 **그 필드를 만들지 않는다**(0 을 지어내지 않는다).
        const v = num(s?.Reading ?? s?.ReadingValue);
        if (v == null || v < 0 || v > 100) continue;
        out[field] = Math.round(v * 10) / 10;
        out.usedPaths[field] = u;
      } catch { /* 그 센서만 건너뛴다 */ }
    }
  });
  await Promise.all(workers);
  out.ok = Object.keys(out.usedPaths).length > 0;
  // 오류가 없다를 읽었다로 쓰지 않는다(v2.545 규약).
  if (!out.ok) out.error = '사용률 센서를 찾았지만 값(Reading)을 읽지 못했습니다.';
  return out;
}
