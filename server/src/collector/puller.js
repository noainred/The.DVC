/**
 * Central-portal puller: periodically fetch each registered collector agent's
 * /api/collector/export and merge its host→power into shared state. Per-host
 * samples are also written to the local DB (key rmt:<host>) so the host detail
 * popup can show merged history. Failures are isolated per collector.
 */

import { config } from '../config.js';
import { loadCollectors } from './registry.js';
import { setRemoteHost, clearCollectorHosts, setCollectorStatus } from './state.js';
import { getDb } from '../idrac/db.js';
import { describeError } from '../util/errors.js';
import { resilientFetch } from '../util/resilientFetch.js';

let timer = null;
const fails = new Map(); // collectorId -> 연속 실패 사이클 수(상태 깜빡임 방지용)

async function pullOne(c) {
  // 고RTT·일시적 네트워크 오류는 재시도로 흡수(단발 실패로 '연결 안 됨' 되는 문제 해결).
  const res = await resilientFetch(`${c.url}/api/collector/export`, {
    headers: { Accept: 'application/json', ...(c.token ? { 'X-Collector-Token': c.token } : {}) },
    timeoutMs: config.collector.timeoutMs, retries: 2,
    onRetry: (i) => console.warn(`[collector] ${c.id} 재시도 ${i.attempt} (${i.error || 'HTTP ' + i.status})`),
  });
  if (res.status === 401 || res.status === 403) throw new Error('수집 서버 토큰 불일치(인증 실패)');
  if (!res.ok) throw new Error(`export -> ${res.status} ${res.statusText}`);
  const data = await res.json();
  const db = await getDb();
  const ts = Date.now();
  clearCollectorHosts(c.id);
  let hosts = 0;
  // 출처 서버 단위로 한 번만 집계하기 위한 set(구버전 수집기가 별칭별 중복 행을 보내도 중앙이 흡수).
  const seenServers = new Set();
  for (const h of data?.power?.byHost || []) {
    const host = String(h.host || '').trim().toLowerCase();
    if (!host || h.watts == null) continue;
    // 전력값 범위 검증 — 음수/비현실값은 거른다(수집서버가 KPI를 오염시키지 못하게).
    const watts = Number(h.watts);
    if (!Number.isFinite(watts) || watts < 0 || watts > 1_000_000) continue;
    // 같은 수집기에서 온 동일 서버(serverId)가 여러 별칭으로 중복 보고되면 첫 행만 반영한다.
    if (h.serverId != null) { if (seenServers.has(h.serverId)) continue; seenServers.add(h.serverId); }
    // 위조/오류 미래 타임스탬프는 거부('최신 ts 승리' 로직을 가리지 못하게) — 5분 skew 초과면 수신 시각 사용.
    const sTs = (Number.isFinite(h.ts) && h.ts > 0 && h.ts <= ts + 5 * 60_000) ? h.ts : ts;
    const sample = { watts, ts: sTs, datacenter: data.datacenter || c.datacenter, collectorId: c.id, serverName: h.serverName, serverId: h.serverId, serviceTag: h.serviceTag || '', model: h.model || '', vcenterId: c.vcenterId || '', source: 'remote' };
    setRemoteHost(host, sample);
    db.insert(`rmt:${host}`, watts, sTs);
    hosts++;
  }
  return { hosts, version: data.version, datacenter: data.datacenter || c.datacenter };
}

export async function pullNow() {
  const collectors = loadCollectors().filter((c) => c.enabled !== false && c.url);
  await Promise.all(collectors.map(async (c) => {
    try {
      const r = await pullOne(c);
      fails.set(c.id, 0);
      setCollectorStatus(c.id, { ok: true, hosts: r.hosts, version: r.version, datacenter: r.datacenter, error: null });
    } catch (err) {
      const d = describeError(err);
      const isAuth = /인증 실패|토큰/.test(d.message);
      const n = (fails.get(c.id) || 0) + 1;
      fails.set(c.id, n);
      // 깜빡임 방지: 한 사이클(이미 내부 재시도 포함)만 실패하면 '저하(degraded)'로 두고 직전 데이터·온라인을
      // 유지한다. 두 사이클 연속(또는 명백한 인증 실패) 실패해야 '연결 안 됨'으로 내린다.
      if (n >= 2 || isAuth) {
        setCollectorStatus(c.id, { ok: false, error: d.message, fails: n });
      } else {
        setCollectorStatus(c.id, { ok: true, degraded: true, error: d.message, fails: n });
      }
      console.warn(`[collector] ${c.id} pull 실패(${n}): ${d.message}`);
    }
  }));
}

export function startCollectorPuller() {
  if (config.collector.pullIntervalMs <= 0) { console.log('[collector] puller disabled'); return; }
  setTimeout(() => pullNow(), 5_000).unref?.();
  timer = setInterval(() => pullNow(), config.collector.pullIntervalMs);
  timer.unref?.();
  console.log(`[collector] puller started (every ${Math.round(config.collector.pullIntervalMs / 1000)}s)`);
}
