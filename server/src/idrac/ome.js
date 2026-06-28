/**
 * Dell OpenManage Enterprise (OME) collector.
 *
 * OME aggregates every server in the datacenter, so one OME registration
 * discovers all devices and their power — no per-iDRAC entry needed. Uses the
 * OME REST API (OData v4):
 *   POST /api/SessionService/Sessions           -> X-Auth-Token (Basic fallback)
 *   GET  /api/DeviceService/Devices             -> all devices (paginated)
 *   POST /api/MetricService/Metrics             -> Power Manager per-device power
 *
 * Power is read with auto-detection: try the Power Manager metric service first
 * (accurate, historical-capable); if unavailable, fall back to the device's
 * inventory/summary power. Device discovery still works without the plugin.
 */

import { Agent } from 'undici';
import { constants as cryptoConstants } from 'node:crypto';
import { config } from '../config.js';
import { retryTransient } from '../util/resilientFetch.js';

// 동시성 제한 실행기 — 고RTT OME에서 장치별 전력 조회를 직렬(N×RTT)이 아닌 병렬(캡)로.
async function eachLimited(items, limit, fn) {
  const q = [...items];
  const workers = Array.from({ length: Math.min(limit, q.length || 1) }, async () => {
    while (q.length) { const it = q.shift(); try { await fn(it); } catch { /* isolated */ } }
  });
  await Promise.all(workers);
}

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

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null));

export class OmeClient {
  constructor(entry) {
    this.base = entry.host.replace(/\/+$/, '');
    this.username = entry.username;
    this.password = entry.password;
    this.token = null;
    this.sessionHref = null;
    this.basic = 'Basic ' + Buffer.from(`${entry.username}:${entry.password}`).toString('base64');
  }

  #headers(extra = {}) {
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(this.token ? { 'X-Auth-Token': this.token } : { Authorization: this.basic }),
      ...extra,
    };
  }

  async #req(pathname, { method = 'GET', body } = {}) {
    const res = await fetch(`${this.base}${pathname}`, {
      method,
      headers: this.#headers(),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(config.idrac.timeoutMs),
      dispatcher,
    });
    if (res.status === 401) throw new Error('OME 인증 실패 (사용자/비밀번호 확인)');
    if (!res.ok) throw new Error(`OME ${pathname} -> ${res.status} ${res.statusText}`);
    return res.status === 204 ? null : res.json();
  }

  async login() {
    try {
      const res = await fetch(`${this.base}/api/SessionService/Sessions`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ UserName: this.username, Password: this.password, SessionType: 'API' }),
        signal: AbortSignal.timeout(config.idrac.timeoutMs),
        dispatcher,
      });
      if (res.ok) {
        this.token = res.headers.get('x-auth-token') || res.headers.get('X-Auth-Token');
        const j = await res.json().catch(() => ({}));
        this.sessionHref = j['@odata.id'] || (j.Id ? `/api/SessionService/Sessions('${j.Id}')` : null);
      }
      // If no token, fall through to Basic auth (this.token stays null).
    } catch {
      // Session endpoint unreachable/old — Basic auth fallback is used.
    }
  }

  async logout() {
    if (this.token && this.sessionHref) {
      try { await this.#req(this.sessionHref, { method: 'DELETE' }); } catch { /* best effort */ }
    }
  }

  /** All devices with identity + power state (paginated). */
  async listDevices() {
    const devices = [];
    let next = '/api/DeviceService/Devices?$top=200&$skip=0';
    let guard = 0;
    while (next && guard++ < 100) {
      const page = await this.#req(next);
      for (const d of page.value || []) {
        devices.push({
          id: d.Id,
          name: d.DeviceName || d.Identifier || String(d.Id),
          serviceTag: d.DeviceServiceTag || d.Identifier || '',
          model: d.Model || '',
          powerState: powerStateName(d.PowerState),
        });
      }
      next = page['@odata.nextLink'] || null;
    }
    return devices;
  }

  /**
   * Power Manager metrics for one device -> watts (or null). Tries the
   * configured metric types in order (instantaneous/avg/max system power) until
   * one returns a recent numeric value. All knobs are env-configurable so the
   * exact metric type can be tuned in the field without a code change.
   */
  async powerViaMetricService(deviceId) {
    for (const metricType of config.idrac.omePowerMetricTypes) {
      const body = {
        PluginId: config.idrac.omePluginId,
        EntityType: 0,           // device
        EntityId: Number(deviceId),
        MetricTypes: [metricType],
        Duration: config.idrac.omePowerDuration,
        SortOrder: 1,            // most recent first
      };
      try {
        const r = await this.#req('/api/MetricService/Metrics', { method: 'POST', body });
        const vals = r?.value || r?.Value || r?.Metrics || [];
        let best = null;
        for (const v of vals) {
          const w = num(v.Value ?? v.value ?? v.MetricValue);
          const t = Date.parse(v.Timestamp ?? v.timestamp ?? '') || 0;
          if (w != null && (!best || t >= best.t)) best = { w, t };
        }
        if (best) return Math.round(best.w);
      } catch { /* try next metric type */ }
    }
    return null;
  }

  /** Fallback: instantaneous power from the device's power-usage sub-resource. */
  async powerViaDevice(deviceId) {
    for (const p of [
      `/api/DeviceService/Devices(${deviceId})/PowerUsage`,
      `/api/DeviceService/Devices(${deviceId})/SystemPowerConsumption`,
    ]) {
      try {
        const r = await this.#req(p);
        const vals = r?.value || (Array.isArray(r) ? r : [r]);
        for (const v of vals) {
          const w = num(v?.PowerConsumedWatts ?? v?.Power ?? v?.Value ?? v?.power);
          if (w != null) return Math.round(w);
        }
      } catch { /* try next */ }
    }
    return null;
  }
}

/**
 * Collect all OME devices with their current power. Returns
 * { devices: [{ serviceTag, name, model, powerState, watts }], usedMetricService }.
 * Throws only on auth/connection failure; per-device power failures are tolerated.
 */
export async function fetchOmeDevices(entry) {
  const c = new OmeClient(entry);
  await c.login();
  try {
    const devices = await c.listDevices();
    let usedMetricService = false;
    // 장치별 전력 조회를 동시성 캡으로 병렬화 — 직렬 N×RTT(예: 500대×800ms)로 OME 폴이
    // 타임아웃되던 문제 방지. per-device 실패는 격리(eachLimited)되어 전체를 막지 않는다.
    const conc = Number(process.env.OME_POWER_CONCURRENCY) || 16;
    await eachLimited(devices, conc, async (d) => {
      let watts = await c.powerViaMetricService(d.id).catch(() => null);
      if (watts != null) usedMetricService = true;
      if (watts == null) watts = await c.powerViaDevice(d.id).catch(() => null);
      d.watts = watts;
    });
    return { devices, usedMetricService, count: devices.length };
  } finally {
    await c.logout();
  }
}

/** Quick connectivity test: login + device count + sample power. */
export async function testOme(entry) {
  const c = new OmeClient(entry);
  const started = Date.now();
  // 고RTT 블립으로 '연결 실패' 오판되지 않도록 로그인은 1회 재시도.
  await retryTransient(() => c.login());
  try {
    const devices = await c.listDevices();
    let sampleWatts = null;
    if (devices[0]) {
      sampleWatts = await c.powerViaMetricService(devices[0].id);
      if (sampleWatts == null) sampleWatts = await c.powerViaDevice(devices[0].id);
    }
    return { ok: true, ms: Date.now() - started, devices: devices.length, auth: c.token ? 'session' : 'basic', sampleWatts };
  } finally {
    await c.logout();
  }
}

function powerStateName(v) {
  // OME PowerState: 17=on, 18=off (commonly); accept strings too.
  if (v === 17 || v === '17' || String(v).toLowerCase() === 'on') return 'ON';
  if (v === 18 || v === '18' || String(v).toLowerCase() === 'off') return 'OFF';
  return v != null ? String(v) : '';
}
