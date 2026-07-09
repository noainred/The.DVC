/**
 * 법인(DataCenter)별 iDRAC 스캔 대역 저장소 — 각 법인에 귀속된 iDRAC IP 대역과 그 대역 스캔에
 * 쓸 iDRAC 계정/비밀번호를 저장한다. 주기 스캐너(scanPoller)가 이 대역을 돌며 Dell iDRAC을
 * 자동 발견·등록(해당 법인으로 귀속 = '법인 DB')한다. iDRAC은 인증이 필요하므로 대역별
 * 계정/비밀번호를 함께 보관한다.
 *
 * ★ 한 법인에 서비스가 여러 개 존재하고 서비스별로 에이전트가 다를 수 있다. 따라서 저장 단위는
 *   '법인'이 아니라 '엔트리(id)'이며, 한 법인(datacenterId) 아래 여러 엔트리(서비스별 대역·계정·
 *   에이전트)를 둘 수 있다.
 *
 * 저장: CONFIG_DIR/idrac-scan-ranges.json (0600, 비밀번호 평문 — idrac.json과 동일 관례)
 *   { entries: { [id]: { datacenterId, service, ranges:string[], username, password, agent, enabled, mode, updatedAt, lastRun } } }
 *   - id     : 엔트리 고유키(UUID). 구버전 마이그레이션 시에는 datacenterId를 그대로 id로 승계.
 *   - service: 서비스명(라벨). 한 법인 내 여러 엔트리를 구분(빈 값 허용).
 *   - agent  : '' 또는 '__local__' = 중앙 포탈이 직접 스캔. 그 외 = 해당 에이전트에 위임.
 *   - mode   : 등록 모드(merge 기본).
 *   - (구버전 호환) 과거 법인별 저장(`{ datacenters: {[dcId]: e} }`)·vCenter별 저장(`{ vcenters: {...} }`)도 읽어들인다.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';

const FILE = path.join(config.configDir, 'idrac-scan-ranges.json');

let cache = null;
let cacheMtime = -1;

// 구버전(법인/‌vCenter 키) 저장을 엔트리(id) 저장으로 승계. id는 기존 키(datacenterId)를 그대로 써
// 안정적으로 유지한다(기존 lastRun/설정 보존).
function migrateLegacyMap(map) {
  const entries = {};
  for (const [dcId, e] of Object.entries(map || {})) {
    if (!e || typeof e !== 'object') continue;
    entries[dcId] = {
      datacenterId: dcId,
      service: String(e.service || '').trim(),
      ranges: Array.isArray(e.ranges) ? e.ranges : [],
      username: e.username || '',
      password: e.password || '',
      agent: e.agent || '',
      enabled: e.enabled !== false,
      mode: e.mode || 'merge',
      updatedAt: e.updatedAt || null,
      lastRun: e.lastRun || null,
    };
  }
  return entries;
}

function read() {
  let mtime = -1;
  try { mtime = fs.statSync(FILE).mtimeMs; } catch { mtime = 0; }
  if (cache && mtime === cacheMtime) return cache;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    let entries;
    if (j && typeof j.entries === 'object' && j.entries) entries = j.entries; // 현행 포맷
    else if (j && typeof j.datacenters === 'object' && j.datacenters) entries = migrateLegacyMap(j.datacenters); // 구: 법인 키
    else if (j && typeof j.vcenters === 'object' && j.vcenters) entries = migrateLegacyMap(j.vcenters); // 구: vCenter 키
    else entries = {};
    cache = { entries };
  } catch { cache = { entries: {} }; }
  cacheMtime = mtime;
  return cache;
}

function write(data) {
  cache = data;
  try {
    atomicWriteFileSync(FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
    try { cacheMtime = fs.statSync(FILE).mtimeMs; } catch { cacheMtime = -1; }
  } catch (e) { console.error('[idrac-scan-ranges] 저장 실패:', e.message); }
}

const normRanges = (r) => (Array.isArray(r) ? r : String(r || '').split(/[\n,]/))
  .map((s) => String(s).trim()).filter(Boolean);

/** 비밀번호 제거 + hasPassword 노출(UI용). */
function redact(id, e) {
  const { password, ...rest } = e;
  return {
    id,
    datacenterId: rest.datacenterId || '',
    service: rest.service || '',
    ranges: rest.ranges || [],
    username: rest.username || '',
    agent: rest.agent || '',
    dispatch: rest.dispatch === 'push' ? 'push' : 'poll', // 위임 전달 방식: poll(에이전트 폴링) | push(중앙→엣지 직접)
    enabled: rest.enabled !== false,
    mode: rest.mode || 'merge',
    updatedAt: rest.updatedAt || null,
    lastRun: rest.lastRun || null,
    hasPassword: Boolean(password),
  };
}

/** UI용 목록(비밀번호 마스킹). 법인→서비스 순 정렬. */
export function listScanRanges() {
  const map = read().entries || {};
  return Object.entries(map)
    .map(([id, e]) => redact(id, e))
    .sort((a, b) => (a.datacenterId || '').localeCompare(b.datacenterId || '') || (a.service || '').localeCompare(b.service || ''));
}

/** 폴러용 — 비밀번호 포함 원본(클론). enabled+ranges+username+password 있는 것만. */
export function enabledScanRanges() {
  const map = read().entries || {};
  const out = [];
  for (const [id, e] of Object.entries(map)) {
    if (e.enabled === false) continue;
    const ranges = (e.ranges || []).filter(Boolean);
    if (!ranges.length) continue;
    if (!String(e.username || '').trim()) continue; // 계정 없으면 스캔 불가 → 건너뜀
    if (!String(e.password || '')) continue;        // 비밀번호 없으면 인증 불가 → 건너뜀(스캔 보류)
    out.push({
      id,
      datacenterId: e.datacenterId || '',
      service: e.service || '',
      ranges,
      username: String(e.username || '').trim(),
      password: e.password || '',
      agent: String(e.agent || '').trim(),
      dispatch: e.dispatch === 'push' ? 'push' : 'poll',
      mode: e.mode || 'merge',
    });
  }
  return out;
}

/** 단건 원본(비밀번호 포함) — 폴러/수동 스캔에서 사용. id로 조회. */
export function getScanRangeRaw(id) {
  const e = (read().entries || {})[String(id || '').trim()];
  return e ? structuredClone({ id: String(id).trim(), ...e }) : null;
}

/** 한 법인(datacenterId)에 속한 모든 엔트리 원본(비밀번호 포함). '법인 전체 스캔'용. */
export function scanRangesForDatacenter(datacenterId) {
  const id = String(datacenterId || '').trim();
  const map = read().entries || {};
  return Object.entries(map)
    .filter(([, e]) => String(e.datacenterId || '').trim() === id)
    .map(([eid, e]) => structuredClone({ id: eid, ...e }));
}

/**
 * 저장/수정. body: { id?, datacenterId, service?, ranges?, username?, password?, agent?, enabled?, mode? }.
 * id가 있고 기존에 존재하면 수정, 없으면 새 엔트리 생성(UUID 발급). 비밀번호는 빈 문자열이면 기존 유지.
 */
export function saveScanRanges(body = {}) {
  const dcId = String(body.datacenterId || '').trim();
  if (!dcId) return { ok: false, reason: 'datacenterId(법인)가 필요합니다.' };
  if (dcId.length > 128 || [...dcId].some((c) => c.charCodeAt(0) < 32)) return { ok: false, reason: 'datacenterId에 사용할 수 없는 문자가 있습니다.' };
  const service = String(body.service || '').trim();
  if (service.length > 128 || [...service].some((c) => c.charCodeAt(0) < 32)) return { ok: false, reason: '서비스명에 사용할 수 없는 문자가 있습니다.' };
  const data = read();
  const id = String(body.id || '').trim() && data.entries[String(body.id).trim()] ? String(body.id).trim() : crypto.randomUUID();
  const cur = data.entries[id] || { datacenterId: dcId, service: '', ranges: [], username: '', password: '', agent: '', dispatch: 'poll', enabled: true, mode: 'merge' };
  const next = {
    datacenterId: dcId,
    service: body.service !== undefined ? service : (cur.service || ''),
    ranges: body.ranges !== undefined ? normRanges(body.ranges) : (cur.ranges || []),
    username: body.username !== undefined ? String(body.username || '').trim() : (cur.username || ''),
    // 빈 비밀번호는 기존 유지(편집 시 비번 재입력 강요하지 않음).
    password: (body.password != null && body.password !== '') ? String(body.password) : (cur.password || ''),
    agent: body.agent !== undefined ? String(body.agent || '').trim() : (cur.agent || ''),
    dispatch: body.dispatch !== undefined ? (body.dispatch === 'push' ? 'push' : 'poll') : (cur.dispatch === 'push' ? 'push' : 'poll'),
    enabled: body.enabled !== undefined ? body.enabled !== false : (cur.enabled !== false),
    mode: body.mode !== undefined ? (['merge', 'replace-datacenter'].includes(body.mode) ? body.mode : 'merge') : (cur.mode || 'merge'),
    updatedAt: Date.now(),
    lastRun: cur.lastRun || null, // 실행 이력은 보존
  };
  data.entries = { ...data.entries, [id]: next };
  write(data);
  return { ok: true, ...redact(id, next) };
}

/** 삭제. id로 삭제. */
export function removeScanRanges(id) {
  const key = String(id || '').trim();
  const data = read();
  if (!data.entries[key]) return { ok: false, reason: '없는 항목' };
  const rest = { ...data.entries };
  delete rest[key];
  write({ entries: rest });
  return { ok: true };
}

/**
 * 마지막으로 '어느 엔트리든' 스캔이 실행된 시각(ms). 없으면 0.
 * 재시작(업그레이드) 후 '아직 주기가 안 됐으면 스캔을 앞당기지 않기' 위한 기준값.
 */
export function lastScanCycleAt() {
  const map = read().entries || {};
  let max = 0;
  for (const e of Object.values(map)) {
    const at = e?.lastRun?.at;
    if (typeof at === 'number' && at > max) max = at;
  }
  return max;
}

/** 폴러가 실행 결과를 기록(per-엔트리 lastRun). 저장 충돌 없이 lastRun만 갱신. */
export function recordScanRangeRun(id, run) {
  const key = String(id || '').trim();
  const data = read();
  const cur = data.entries[key];
  if (!cur) return; // 도중에 삭제됐으면 무시
  data.entries = { ...data.entries, [key]: { ...cur, lastRun: { at: Date.now(), ...run } } };
  write(data);
}
