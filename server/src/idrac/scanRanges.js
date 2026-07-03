/**
 * 법인(DataCenter)별 iDRAC 스캔 대역 저장소 — 각 법인에 귀속된 iDRAC IP 대역과 그 대역 스캔에
 * 쓸 iDRAC 계정/비밀번호를 저장한다. 주기 스캐너(scanPoller)가 이 대역을 돌며 Dell iDRAC을
 * 자동 발견·등록(해당 법인으로 귀속 = '법인 DB')한다. iDRAC은 인증이 필요하므로 대역별
 * 계정/비밀번호를 함께 보관한다.
 *
 * 저장: CONFIG_DIR/idrac-scan-ranges.json (0600, 비밀번호 평문 — idrac.json과 동일 관례)
 *   { datacenters: { [datacenterId]: { ranges:string[], username, password, agent, enabled, mode, updatedAt, lastRun } } }
 *   - agent: '' 또는 '__local__' = 중앙 포탈이 직접 스캔. 그 외 = 해당 에이전트에 위임.
 *   - mode : 등록 모드(merge 기본).
 *   - (구버전 호환) 과거 vCenter별 저장(`{ vcenters: {...} }`)도 읽어들인다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';

const FILE = path.join(config.configDir, 'idrac-scan-ranges.json');

let cache = null;
let cacheMtime = -1;

function read() {
  let mtime = -1;
  try { mtime = fs.statSync(FILE).mtimeMs; } catch { mtime = 0; }
  if (cache && mtime === cacheMtime) return cache;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const map = (j && typeof j.datacenters === 'object' && j.datacenters) ? j.datacenters
      : (j && typeof j.vcenters === 'object' && j.vcenters) ? j.vcenters // 구버전 호환
        : {};
    cache = { datacenters: map };
  } catch { cache = { datacenters: {} }; }
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
function redact(datacenterId, e) {
  const { password, ...rest } = e;
  return {
    datacenterId,
    ranges: rest.ranges || [],
    username: rest.username || '',
    agent: rest.agent || '',
    enabled: rest.enabled !== false,
    mode: rest.mode || 'merge',
    updatedAt: rest.updatedAt || null,
    lastRun: rest.lastRun || null,
    hasPassword: Boolean(password),
  };
}

/** UI용 목록(비밀번호 마스킹). */
export function listScanRanges() {
  const map = read().datacenters || {};
  return Object.entries(map).map(([id, e]) => redact(id, e));
}

/** 폴러용 — 비밀번호 포함 원본(클론). enabled+ranges+username 있는 것만. */
export function enabledScanRanges() {
  const map = read().datacenters || {};
  const out = [];
  for (const [datacenterId, e] of Object.entries(map)) {
    if (e.enabled === false) continue;
    const ranges = (e.ranges || []).filter(Boolean);
    if (!ranges.length) continue;
    if (!String(e.username || '').trim()) continue; // 계정 없으면 스캔 불가 → 건너뜀
    if (!String(e.password || '')) continue;        // 비밀번호 없으면 인증 불가 → 건너뜀(스캔 보류)
    out.push({
      datacenterId, ranges,
      username: String(e.username || '').trim(),
      password: e.password || '',
      agent: String(e.agent || '').trim(),
      mode: e.mode || 'merge',
    });
  }
  return out;
}

/** 단건 원본(비밀번호 포함) — 폴러/수동 스캔에서 사용. */
export function getScanRangeRaw(datacenterId) {
  const e = (read().datacenters || {})[String(datacenterId || '').trim()];
  return e ? structuredClone(e) : null;
}

/**
 * 저장/수정. partial: { ranges?, username?, password?, agent?, enabled?, mode? }.
 * 비밀번호는 빈 문자열이면 기존 값 유지(다른 필드만 수정 가능).
 */
export function saveScanRanges(datacenterId, partial = {}) {
  const id = String(datacenterId || '').trim();
  if (!id) return { ok: false, reason: 'datacenterId(법인)가 필요합니다.' };
  if (id.length > 128 || [...id].some((c) => c.charCodeAt(0) < 32)) return { ok: false, reason: 'datacenterId에 사용할 수 없는 문자가 있습니다.' };
  const data = read();
  const cur = data.datacenters[id] || { ranges: [], username: '', password: '', agent: '', enabled: true, mode: 'merge' };
  const next = {
    ranges: partial.ranges !== undefined ? normRanges(partial.ranges) : (cur.ranges || []),
    username: partial.username !== undefined ? String(partial.username || '').trim() : (cur.username || ''),
    // 빈 비밀번호는 기존 유지(편집 시 비번 재입력 강요하지 않음).
    password: (partial.password != null && partial.password !== '') ? String(partial.password) : (cur.password || ''),
    agent: partial.agent !== undefined ? String(partial.agent || '').trim() : (cur.agent || ''),
    enabled: partial.enabled !== undefined ? partial.enabled !== false : (cur.enabled !== false),
    mode: partial.mode !== undefined ? (['merge', 'replace-datacenter'].includes(partial.mode) ? partial.mode : 'merge') : (cur.mode || 'merge'),
    updatedAt: Date.now(),
    lastRun: cur.lastRun || null, // 실행 이력은 보존
  };
  data.datacenters = { ...data.datacenters, [id]: next };
  write(data);
  return { ok: true, ...redact(id, next) };
}

/** 삭제. */
export function removeScanRanges(datacenterId) {
  const id = String(datacenterId || '').trim();
  const data = read();
  if (!data.datacenters[id]) return { ok: false, reason: '없는 항목' };
  const rest = { ...data.datacenters };
  delete rest[id];
  write({ datacenters: rest });
  return { ok: true };
}

/**
 * 마지막으로 '어느 법인이든' 스캔이 실행된 시각(ms). 없으면 0.
 * 재시작(업그레이드) 후 '아직 주기가 안 됐으면 스캔을 앞당기지 않기' 위한 기준값.
 * 위임/직접/수동 스캔 모두 recordScanRangeRun으로 lastRun.at를 남기므로 그 최대값을 쓴다.
 */
export function lastScanCycleAt() {
  const map = read().datacenters || {};
  let max = 0;
  for (const e of Object.values(map)) {
    const at = e?.lastRun?.at;
    if (typeof at === 'number' && at > max) max = at;
  }
  return max;
}

/** 폴러가 실행 결과를 기록(per-법인 lastRun). 저장 충돌 없이 lastRun만 갱신. */
export function recordScanRangeRun(datacenterId, run) {
  const id = String(datacenterId || '').trim();
  const data = read();
  const cur = data.datacenters[id];
  if (!cur) return; // 도중에 삭제됐으면 무시
  data.datacenters = { ...data.datacenters, [id]: { ...cur, lastRun: { at: Date.now(), ...run } } };
  write(data);
}
