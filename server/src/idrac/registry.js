/**
 * iDRAC registry — the managed list of Dell servers whose power draw we collect
 * over Redfish. Stored in CONFIG_DIR/idrac.json (gitignored, 0600, holds
 * credentials) so it survives upgrades and stays outside the app dir.
 *
 * Each entry maps an iDRAC endpoint to one or more ESXi host names so the portal
 * can show "this host's server power" when a host is clicked. Edited through the
 * admin API; supports CSV/JSON bulk import.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { describeError } from '../util/errors.js';
import { retryTransient } from '../util/resilientFetch.js';
import { fetchPower, fetchInventory } from './redfish.js';
import { testOme } from './ome.js';
import { expandIpList } from './iprange.js';
import { bumpFleetRev } from '../insights/fleetRev.js';

const FILE = path.join(config.configDir, 'idrac.json');

export function loadRegistry() {
  if (!fs.existsSync(FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(parsed?.servers) ? parsed.servers : [];
  } catch {
    return [];
  }
}

function saveRegistry(list) {
  atomicWriteFileSync(FILE, JSON.stringify({ servers: list }, null, 2), { mode: 0o600 });
  // 레지스트리(서버 vcenterId·멤버십) 변경은 통합 인벤토리/전력 집계에 영향 → 플릿 캐시 무효화.
  bumpFleetRev();
}

/** Strip the password before returning an entry to the client. */
export function redact(s) {
  const { password, ...rest } = s;
  return { ...rest, hasPassword: Boolean(password) };
}

export function listRegistry() {
  return loadRegistry().map(redact);
}

/**
 * The set of ESXi host names an entry should match against, lower-cased.
 * Includes explicit hostNames plus the server name and service tag as
 * convenience aliases.
 */
export function matchKeys(entry) {
  const keys = new Set();
  for (const n of entry.hostNames || []) if (n) keys.add(String(n).trim().toLowerCase());
  if (entry.name) keys.add(String(entry.name).trim().toLowerCase());
  if (entry.serviceTag) keys.add(String(entry.serviceTag).trim().toLowerCase());
  return [...keys];
}

/** Validate + normalize an incoming server payload. Returns [entry, error]. */
function normalize(body, existing = null) {
  const e = existing ? { ...existing } : {};
  const id = String(body.id ?? e.id ?? '').trim();
  const name = String(body.name ?? e.name ?? '').trim();
  let host = String(body.host ?? e.host ?? '').trim();
  const username = String(body.username ?? e.username ?? '').trim();
  const type = (body.type ?? e.type ?? 'idrac') === 'ome' ? 'ome' : 'idrac';

  if (!id) return [null, 'id는 필수입니다.'];
  if (id.length > 128 || [...id].some((c) => c.charCodeAt(0) < 32)) return [null, 'id에 사용할 수 없는 문자가 있습니다.'];
  if (!name) return [null, 'name(서버 표시 이름)은 필수입니다.'];
  if (!host) return [null, type === 'ome' ? 'OME 주소(host)는 필수입니다.' : 'iDRAC 주소(host)는 필수입니다.'];
  if (!username) return [null, 'username은 필수입니다.'];

  // Accept a bare IP/hostname and normalize to https://host.
  if (!/^https?:\/\//.test(host)) host = `https://${host}`;
  host = host.replace(/\/+$/, '');

  // hostNames: ESXi host name(s) this iDRAC maps to. Accept array or
  // comma/space/newline-separated string. (OME auto-discovers devices, so
  // hostNames is optional/ignored there.)
  let hostNames = body.hostNames ?? e.hostNames ?? [];
  if (typeof hostNames === 'string') hostNames = hostNames.split(/[,\n\r]+/);
  hostNames = [...new Set((hostNames || []).map((h) => String(h).trim()).filter(Boolean))];

  const entry = {
    id, name, host, username, type,
    password: body.password ? String(body.password) : e.password || '',
    serviceTag: String(body.serviceTag ?? e.serviceTag ?? '').trim(),
    vcenterId: String(body.vcenterId ?? e.vcenterId ?? '').trim(), // 명시 지정 시 전력이 이 vCenter로 귀속(이름·태그 매칭보다 우선)
    datacenterId: String(body.datacenterId ?? e.datacenterId ?? '').trim(), // 소속 법인(DataCenter) — iDRAC 스캔으로 수집한 물리 서버의 법인 귀속
    hostNames,
    enabled: body.enabled != null ? Boolean(body.enabled) : (e.enabled != null ? e.enabled : true),
  };
  return [entry, null];
}

export function addServer(body) {
  const list = loadRegistry();
  const [entry, err] = normalize(body);
  if (err) return { ok: false, reason: err };
  if (list.some((s) => s.id === entry.id)) return { ok: false, reason: `이미 존재하는 id: ${entry.id}` };
  list.push(entry);
  saveRegistry(list);
  return { ok: true, server: redact(entry) };
}

export function updateServer(id, body) {
  const list = loadRegistry();
  const idx = list.findIndex((s) => s.id === id);
  if (idx === -1) return { ok: false, reason: `없는 서버: ${id}` };
  const [entry, err] = normalize({ ...body, id }, list[idx]);
  if (err) return { ok: false, reason: err };
  list[idx] = entry;
  saveRegistry(list);
  return { ok: true, server: redact(entry) };
}

export function removeServer(id) {
  const list = loadRegistry();
  const next = list.filter((s) => s.id !== id);
  if (next.length === list.length) return { ok: false, reason: `없는 서버: ${id}` };
  saveRegistry(next);
  return { ok: true };
}

/**
 * Import a list of servers. `mode` 'merge' (default) upserts by id; 'replace'
 * swaps the whole registry. Returns { ok, mode, added, updated, skipped[], total }.
 */
export function importServers(incoming, mode = 'merge') {
  if (!Array.isArray(incoming)) return { ok: false, reason: 'servers 배열을 찾을 수 없습니다.' };
  const existing = loadRegistry();
  // mode:
  //  - 'replace'            : 레지스트리 전체 교체(기존 모두 삭제 후 incoming만)
  //  - 'replace-vcenter'    : incoming에 등장한 소속 vCenter의 기존 항목만 삭제 후 교체(다른 vCenter는 유지)
  //  - 'replace-datacenter' : incoming에 등장한 소속 법인(DataCenter)의 기존 항목만 삭제 후 교체(다른 법인은 유지)
  //  - 'merge'(기본)        : id 기준 upsert
  // 먼저 incoming을 검증해 '유효 항목'만 추린다(검증 실패 항목은 skip).
  const skipped = [];
  const valid = [];
  for (const raw of incoming) {
    const base = mode === 'replace' ? null : existing.find((s) => s.id === raw?.id);
    const [entry, err] = normalize(raw || {}, base);
    if (err) { skipped.push({ id: raw?.id || '(id 없음)', reason: err }); continue; }
    valid.push(entry);
  }
  let result;
  if (mode === 'replace') result = [];
  else if (mode === 'replace-vcenter') {
    // 삭제 대상 vCenter는 '유효한 incoming'이 실제 존재하는 vCenter로 한정한다.
    // (검증 실패로 0건이 된 vCenter의 기존 데이터를 통째로 지우는 사고 방지)
    const vcs = new Set(valid.map((e) => String(e.vcenterId || '').trim()).filter(Boolean));
    result = vcs.size ? existing.filter((s) => !vcs.has(String(s.vcenterId || '').trim())) : [...existing];
  } else if (mode === 'replace-datacenter') {
    // incoming에 등장한 법인(DataCenter)의 기존 항목만 삭제 후 교체(다른 법인은 유지).
    // 유효 incoming이 0건이면 기존을 지우지 않음(블립으로 인한 대량 삭제 방지).
    const dcs = new Set(valid.map((e) => String(e.datacenterId || '').trim()).filter(Boolean));
    result = dcs.size ? existing.filter((s) => !dcs.has(String(s.datacenterId || '').trim())) : [...existing];
  } else result = [...existing];
  // 안전장치: 'replace'인데 유효 incoming이 0건이면 전체 삭제하지 않는다(빈/전부무효 CSV로
  // 등록 서버·자격증명이 소실되는 사고 방지). replace-vcenter/datacenter는 위에서 이미 0건 가드됨.
  if (mode === 'replace' && valid.length === 0) {
    return { ok: false, mode, added: 0, updated: 0, skipped, total: existing.length, reason: '가져올 유효한 서버가 없어 전체 교체를 취소했습니다(기존 목록 유지).' };
  }
  let added = 0, updated = 0;
  for (const entry of valid) {
    const idx = result.findIndex((s) => s.id === entry.id);
    if (idx >= 0) { result[idx] = entry; updated++; } else { result.push(entry); added++; }
  }
  saveRegistry(result);
  return { ok: true, mode, added, updated, skipped, total: result.length };
}

/**
 * Bulk-register Dell servers from an IP list that all share the same iDRAC
 * credentials. `ips` is free-form text (one per line; ranges and CIDR allowed).
 * Each IP becomes a server whose id/name/host is the IP and whose hostNames
 * includes the IP (so a host registered by IP auto-matches). Returns a summary
 * including the import result and any IP-parse errors.
 */
export function bulkAddByIps(body) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username) return { ok: false, reason: 'username은 필수입니다.' };
  if (!password) return { ok: false, reason: 'password는 필수입니다.' };

  const { ips, errors, truncated } = expandIpList(body.ips || '');
  if (!ips.length) return { ok: false, reason: 'IP를 한 개 이상 입력하세요.', ipErrors: errors };

  const prefix = String(body.namePrefix || '').trim();
  const vcenterId = String(body.vcenterId || '').trim();
  const servers = ips.map((ip) => ({
    id: ip,
    name: prefix ? `${prefix}${ip}` : ip,
    host: ip,
    username,
    password,
    hostNames: [ip],
    vcenterId,
    enabled: true,
  }));
  const result = importServers(servers, body.mode === 'replace' ? 'replace' : 'merge');
  return { ...result, expanded: ips.length, ipErrors: errors, truncated };
}

/**
 * Register iDRACs discovered by a range scan. Each found item carries identity
 * (ip, serviceTag, hostName, model); the shared username/password are applied
 * to all. hostNames includes the discovered hostname + IP for auto-matching.
 */
export function registerScanned(found, username, password, mode = 'merge', vcenterId = '', datacenterId = '') {
  if (!Array.isArray(found) || !found.length) return { ok: false, reason: '등록할 iDRAC가 없습니다.' };
  if (!username || !password) return { ok: false, reason: 'username/password가 필요합니다.' };
  const vc = String(vcenterId || '').trim();
  const dc = String(datacenterId || '').trim();
  const servers = found.map((f) => ({
    id: f.ip,
    // 표시 이름은 hostname으로 통일한다: iDRAC이 보고한 HostName이 있으면 그걸 쓰고,
    // 없으면 IP(주소)로 대체한다. 서비스태그는 이름으로 쓰지 않는다(서비스태그 열에만 표시).
    // 과거엔 hostName 없으면 serviceTag를 이름으로 써서 '어떤 건 이름=태그'로 뒤섞였다.
    name: f.hostName || f.ip,
    host: f.ip,
    username,
    password,
    serviceTag: f.serviceTag || '',
    hostNames: [f.hostName, f.ip].filter(Boolean),
    vcenterId: vc,
    datacenterId: dc, // 법인(DataCenter) 스캔으로 발견 → 그 법인에 귀속(법인 DB)
    enabled: true,
  }));
  return importServers(servers, mode);
}

/**
 * 다수 서버의 소속 vCenter를 일괄 지정/해제. ids 미지정 시 전체 적용.
 * Returns { ok, updated }.
 */
export function assignVcenter({ ids = null, vcenterId = '' } = {}) {
  const vc = String(vcenterId || '').trim();
  const list = loadRegistry();
  const want = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null;
  let updated = 0;
  for (const s of list) {
    if (want && !want.has(String(s.id))) continue;
    if (s.vcenterId !== vc) { s.vcenterId = vc; updated++; }
  }
  if (updated) saveRegistry(list);
  return { ok: true, updated, total: list.length };
}

/**
 * 서버 일괄 삭제. { all:true } 전체 삭제, { vcenterId } 해당 소속 vCenter 서버만 삭제
 * (빈 vcenterId는 '미지정' 서버를 삭제). Returns { ok, removed, total }.
 */
export function deleteServers({ all = false, vcenterId = undefined } = {}) {
  const list = loadRegistry();
  let next;
  if (all) {
    next = [];
  } else if (vcenterId !== undefined) {
    const vc = String(vcenterId || '').trim();
    next = list.filter((s) => String(s.vcenterId || '').trim() !== vc);
  } else {
    return { ok: false, reason: '삭제 대상(all=true 또는 vcenterId)이 필요합니다.' };
  }
  const removed = list.length - next.length;
  saveRegistry(next);
  return { ok: true, removed, total: next.length };
}

/**
 * Parse a CSV with header columns: name, host, username, password, serviceTag,
 * hostNames (hostNames may be ';'-separated). Returns an array of server objects.
 */
export function parseCsv(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const out = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const row = {};
    header.forEach((h, i) => { row[h] = (cells[i] || '').trim(); });
    if (!row.name && !row.host) continue;
    out.push({
      id: row.id || row.servicetag || row.name || row.host,
      name: row.name || row.host,
      host: row.host,
      username: row.username,
      password: row.password,
      serviceTag: row.servicetag || row.service_tag || '',
      vcenterId: row.vcenterid || row.vcenter || row.vcenter_id || '',
      hostNames: (row.hostnames || row.host_names || row.esxi || '').split(/[;|]/).map((s) => s.trim()).filter(Boolean),
    });
  }
  return out;
}

/** Test connectivity + read current power for a server (uses stored pw if blank). */
export async function testServer(body) {
  let entry = body;
  if (!entry.password && entry.id) {
    const saved = loadRegistry().find((s) => s.id === entry.id);
    if (saved) entry = { ...saved, ...body, password: body.password || saved.password };
  }
  if (!entry.host || !entry.username || !entry.password) {
    return { ok: false, reason: 'host/username/password가 필요합니다.' };
  }
  // normalize host the same way as save
  let host = String(entry.host).trim();
  if (!/^https?:\/\//.test(host)) host = `https://${host}`;
  const normalized = { ...entry, host: host.replace(/\/+$/, '') };
  const started = Date.now();
  try {
    if (entry.type === 'ome') {
      const r = await testOme(normalized);
      return { ok: true, ms: r.ms, devices: r.devices, auth: r.auth, watts: r.sampleWatts, type: 'ome' };
    }
    // 고RTT 블립으로 '연결 실패' 오판되지 않도록 전력 확인은 1회 재시도.
    const r = await retryTransient(() => fetchPower(normalized));
    let info = null;
    try { info = await fetchInventory(normalized); } catch { /* power test still succeeds */ }
    return { ok: true, ms: Date.now() - started, watts: r.watts, model: r.model, serviceTag: r.serviceTag, powerState: r.powerState, info };
  } catch (err) {
    const d = describeError(err);
    return { ok: false, reason: d.message, hint: d.hint, code: d.code, ms: Date.now() - started };
  }
}
