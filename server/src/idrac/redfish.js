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
