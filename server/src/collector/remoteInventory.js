/**
 * Remote (edge-collected) iDRAC server inventory, pulled from collector agents'
 * /api/collector/export (the `servers` field). Keyed by collectorId so each
 * successful pull REPLACES that collector's set (a failed pull keeps the last
 * good snapshot — never wiped on error).
 *
 * Why: delegated (agent) datacenter scans register iDRACs into the EDGE agent's
 * local registry — the central never sees them. Only power flowed back before
 * (collector power pull). This store carries the edge's server list + compact
 * hardware inventory so the central "서버 분석" views (법인별 서버 정보 / 하드웨어
 * 집계 / GPU / BIOS·iDRAC 버전) can merge delegated-datacenter servers too.
 *
 * In-memory only (rebuilt on next pull, ≤ pull interval). O(N) per collector.
 */

import { edgeId, isPlainObj } from '../central/edgeRecord.js';
import { numOrNull } from '../util/numOrNull.js';

const byCollector = new Map(); // collectorId -> { at, datacenter, servers: [...] }

/*
 * ⚠⚠ v2.602(감사 CEN2602-01 high): 엣지 export(pull) 원소를 **아는 필드·타입으로 좁혀서** 보관한다.
 * 예전에는 `data.servers` 를 그대로 보관해 `serviceTag: { toString: 1 }` 원소 하나가 dedupRemoteServers 의
 * `String(v)` 에서 TypeError 를 냈고, 그 함수가 함대 전체 물리 서버 집계·3단 지도·전산실 온도의 공용 경로라
 * **중앙 로컬 iDRAC 까지 통째로** 사라졌다(v2.598 CENTRAL 규약 '엣지가 올리는 것은 아는 필드만' 의 pull 쪽 누락).
 * 규칙: 글자 필드는 글자(또는 유한 숫자)만 — 객체·배열·함수는 **null**(지어낸 글자를 넣지 않는다), 숫자 필드는
 * numOrNull(못 읽은 값을 0 으로 만들지 않는다), 인벤토리는 엣지 `compactInv` 와 같은 모양만 받는다.
 */
export const REMOTE_SERVERS_MAX = Math.max(100, Number(process.env.COLLECTOR_REMOTE_SERVERS_MAX) || 20_000);
const STR_MAX = 256;
const ARR_MAX = 256;

/** 글자(또는 유한 숫자) → 글자(상한), 그 밖 → null. */
export function remoteStr(v, max = STR_MAX) {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) : v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}
const scalar = (v) => (typeof v === 'boolean' ? v : (typeof v === 'number' ? (Number.isFinite(v) ? v : null) : remoteStr(v)));

// 엣지 collector/agent.js compactInv 의 모양 — 키마다 'o'(객체)/'a'(배열) + 잎 필드. 잎은 scalar.
const INV_SHAPE = {
  system: ['o', ['model', 'serviceTag', 'biosVersion', 'hostName']],
  cpu: ['o', ['model', 'count', 'cores']],
  memory: ['o', ['totalGiB']],
  gpus: ['a', ['model', 'name', 'memoryMiB']],
  idrac: ['o', ['firmwareVersion']],
  bios: ['o', ['version']],
  firmware: ['a', ['type', 'version', 'name']],
  nics: ['a', ['name', 'model'], { ports: ['id', 'link', 'speedMbps'] }],
  cpus: ['a', ['socket', 'model', 'cores']],
  disks: ['a', ['model', 'capacityGB', 'media', 'protocol']],
  psus: ['a', ['model', 'manufacturer', 'capacityWatts']],
  memoryDimms: ['a', ['sizeGB', 'type', 'speedMHz', 'manufacturer', 'partNumber']],
  storageControllers: ['a', ['model', 'firmware'], null, ['protocols']],
  pcie: ['a', ['model', 'manufacturer', 'deviceType']],
  fans: ['a', ['name', 'model', 'partNumber']],
};
function pickLeaves(src, keys, subArrays, scalarArrays) {
  const o = {};
  for (const k of keys) if (Object.hasOwn(src, k)) o[k] = scalar(src[k]);
  for (const [k, sub] of Object.entries(subArrays || {})) {
    if (!Object.hasOwn(src, k)) continue;
    o[k] = Array.isArray(src[k]) ? src[k].slice(0, ARR_MAX).filter(isPlainObj).map((x) => pickLeaves(x, sub)) : [];
  }
  for (const k of scalarArrays || []) {
    if (!Object.hasOwn(src, k)) continue;
    o[k] = Array.isArray(src[k]) ? src[k].slice(0, 32).map(scalar).filter((x) => x != null) : (remoteStr(src[k]) ?? null);
  }
  return o;
}
/** 엣지 콤팩트 인벤토리를 모양대로 좁힌다(모르는 키는 버린다). 객체가 아니면 null. */
export function sanitizeRemoteInv(inv) {
  if (!isPlainObj(inv)) return null;
  const out = {};
  for (const [k, [kind, keys, sub, scal]] of Object.entries(INV_SHAPE)) {
    if (!Object.hasOwn(inv, k) || inv[k] == null) continue;
    if (kind === 'o') out[k] = isPlainObj(inv[k]) ? pickLeaves(inv[k], keys, sub, scal) : null;
    else out[k] = Array.isArray(inv[k]) ? inv[k].slice(0, ARR_MAX).filter(isPlainObj).map((x) => pickLeaves(x, keys, sub, scal)) : [];
  }
  if (Object.hasOwn(inv, 'collectedAt')) out.collectedAt = scalar(inv.collectedAt);
  return out;
}
/** 최신 센서 {t, temps:{이름:℃}} — 온도는 숫자만(못 읽은 값은 0 이 아니라 뺀다), 이름은 식별자 규칙. */
export function sanitizeRemoteSensors(x) {
  if (!isPlainObj(x) || !isPlainObj(x.temps)) return null;
  const temps = {};
  let n = 0;
  for (const [k, v] of Object.entries(x.temps)) {
    if (n >= 64) break;
    const name = edgeId(k);
    const c = typeof v === 'number' || typeof v === 'string' ? numOrNull(v) : null;
    if (!name || c == null) continue;
    temps[name] = c; n += 1;
  }
  if (!n) return null;
  return { t: numOrNull(x.t), temps };
}
const SERVER_STR_KEYS = ['name', 'host', 'serviceTag', 'model', 'vcenterId', 'datacenterId', 'type', 'hostName'];
/**
 * v2.621(감사 WEB-04): BMC 벤더 — 엣지(2.621+)가 등록부 판정으로 'hpe' | 'dell' 을 싣는다. 이 둘만 값으로 받고
 *   그 밖(모르는 글자·객체)은 **버린다**(필드 없음 = 벤더 미상). 'dell' 도 받는 이유: 구버전 엣지(필드 없음)와
 *   '신버전 엣지가 Dell 이라고 말했다' 를 화면이 구분해야 한다 — 'hpe' 만 받으면 위임 Dell 서버가 영원히 미상이다.
 *   반대로 필드가 없는 행을 Dell 로 채우지 않는다(구버전 엣지의 HPE 를 iDRAC 이라 말하게 된다).
 */
export function remoteVendor(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  return t === 'hpe' || t === 'dell' ? t : null;
}
/**
 * 엣지가 보낸 서버 목록을 정리한다(순수). 평범한 객체 + 유효 id 만 받고, 개수 상한을 넘거나 id 가 나쁜 원소는
 * **버리고 사유별 개수를 돌려준다**(호출부가 상태에 밝힌다 — 조용한 상한 금지).
 * @returns {{ servers: object[], dropped: { notObject:number, badId:number, overCount:number }, coerced:number }}
 */
export function sanitizeRemoteServers(list, { max = REMOTE_SERVERS_MAX } = {}) {
  const dropped = { notObject: 0, badId: 0, overCount: 0 };
  let coerced = 0;
  const servers = [];
  for (const s of Array.isArray(list) ? list : []) {
    if (!isPlainObj(s)) { dropped.notObject += 1; continue; }
    const id = edgeId(s.id);
    if (!id) { dropped.badId += 1; continue; }
    if (servers.length >= max) { dropped.overCount += 1; continue; }
    const o = { id };
    for (const k of SERVER_STR_KEYS) {
      if (!Object.hasOwn(s, k) || s[k] == null) continue;
      o[k] = remoteStr(s[k]);
      if (o[k] == null) coerced += 1;
    }
    if (Object.hasOwn(s, 'vendor') && s.vendor != null) {
      const v = remoteVendor(s.vendor);
      if (v) o.vendor = v; else coerced += 1; // 모르는 값은 버리고 센다(조용히 빼지 않는다)
    }
    o.inv = sanitizeRemoteInv(s.inv);
    o.sensors = sanitizeRemoteSensors(s.sensors);
    servers.push(o);
  }
  return { servers, dropped, coerced };
}

/** 엣지 거부 통계(collector/denyLog.js getCollectorDenyStats 모양)만 받는다. */
export function sanitizeAuthDeny(d) {
  if (!isPlainObj(d)) return null;
  const rec = (x, keys) => pickLeaves(x, keys);
  return {
    count: numOrNull(d.count), lastAt: numOrNull(d.lastAt),
    lastWhy: remoteStr(d.lastWhy, 200) ?? '', lastEndpoint: remoteStr(d.lastEndpoint, 200) ?? '',
    recent: Array.isArray(d.recent) ? d.recent.slice(0, 20).filter(isPlainObj).map((x) => rec(x, ['at', 'endpoint', 'ip', 'why', 'tokenLen', 'fp', 'ua'])) : [],
    bySrc: Array.isArray(d.bySrc) ? d.bySrc.slice(0, 12).filter(isPlainObj).map((x) => rec(x, ['ip', 'count', 'firstAt', 'lastAt', 'lastWhy', 'lastEndpoint'])) : [],
  };
}

/**
 * export 응답 전체를 pull 이 쓰는 필드만으로 좁힌다(순수). version·agent·hostname 은 64자 글자,
 * power.byHost 원소는 평범한 객체만, servers 는 sanitizeRemoteServers.
 */
export function sanitizeEdgeExport(data) {
  const d = isPlainObj(data) ? data : {};
  const byHost = [];
  const power = isPlainObj(d.power) ? d.power : {};
  for (const h of Array.isArray(power.byHost) ? power.byHost : []) {
    if (!isPlainObj(h)) continue;
    const sid = (typeof h.serverId === 'number' && Number.isFinite(h.serverId)) ? h.serverId : (edgeId(h.serverId) || null);
    byHost.push({
      host: remoteStr(h.host) ?? '', watts: typeof h.watts === 'number' || typeof h.watts === 'string' ? numOrNull(h.watts) : null,
      ts: (typeof h.ts === 'number' && Number.isFinite(h.ts)) ? h.ts : null,
      serverName: remoteStr(h.serverName), serverId: sid,
      serviceTag: remoteStr(h.serviceTag) ?? '', model: remoteStr(h.model) ?? '',
    });
  }
  const sv = Array.isArray(d.servers) ? sanitizeRemoteServers(d.servers) : null;
  return {
    version: remoteStr(d.version, 64) ?? '', agent: remoteStr(d.agent, 64) ?? '', hostname: remoteStr(d.hostname, 64) ?? '',
    datacenter: remoteStr(d.datacenter, 128) ?? '', mock: d.mock === true,
    authDeny: sanitizeAuthDeny(d.authDeny),
    power: { byHost },
    servers: sv ? sv.servers : null, // null = 구버전 엣지(필드 없음) — 빈 배열로 교체한다
    serversDropped: sv ? sv.dropped : null, serversCoerced: sv ? sv.coerced : 0,
  };
}

/** Replace the whole server set reported by one collector. Call only on a
 *  successful pull (skip on failure to preserve the last good snapshot). */
export function setCollectorServers(collectorId, datacenter, servers) {
  const id = String(collectorId || '').trim();
  if (!id) return;
  // 정리는 이 함수 안에서 한다(v2.602 CEN2602-01) — 다른 호출부가 생겨도 원본을 그대로 보관하지 않게.
  const list = sanitizeRemoteServers(servers).servers;
  byCollector.set(id, { at: Date.now(), datacenter: String(datacenter || ''), servers: list });
}

/** Drop a collector's remote servers (e.g. collector removed/disabled). */
export function clearCollectorServers(collectorId) {
  byCollector.delete(String(collectorId || '').trim());
}

/** All remote servers across collectors, tagged remote:true + collectorId.
 *  Each carries the compact inventory as `.inv` (null if the edge had none). */
export function allRemoteServers() {
  const out = [];
  for (const [collectorId, e] of byCollector) {
    for (const s of e.servers || []) {
      out.push({ ...s, remote: true, collectorId, collectorDatacenter: e.datacenter });
    }
  }
  return out;
}

/**
 * 물리 식별키(서비스태그>id>주소)로 원격 서버 목록을 dedup한다. 같은 엣지를 둘 이상의
 * 수집서버(예: 대소문자만 다른 'nj'·'NJ')가 pull하면 동일 서버가 중복 유입돼 목록·집계가
 * 2배로 부풀던 것을 방지한다. 중복 시 datacenterId가 채워진 쪽을 우선 보존(귀속 손실 방지).
 * 서로 다른 엣지는 태그/id가 달라 합쳐지지 않는다.
 */
export function dedupRemoteServers(list = []) {
  const norm = (v) => String(v || '').trim().toLowerCase();
  const byKey = new Map();
  const out = [];
  for (const s of list) {
    const key = norm(s.serviceTag) || norm(s.id) || norm(String(s.host || '').replace(/^https?:\/\//, ''));
    if (!key) { out.push(s); continue; } // 키 없으면 합치지 않고 그대로
    const idx = byKey.get(key);
    if (idx === undefined) { byKey.set(key, out.length); out.push(s); continue; }
    if (!out[idx].datacenterId && s.datacenterId) out[idx] = s; // 중복: datacenterId 있는 쪽 우선
  }
  return out;
}

/** Find one remote server by id (for the detail-inventory popup). */
export function findRemoteServer(id) {
  const want = String(id || '');
  for (const [collectorId, e] of byCollector) {
    for (const s of e.servers || []) {
      if (String(s.id) === want) return { ...s, remote: true, collectorId, collectorDatacenter: e.datacenter };
    }
  }
  return null;
}
