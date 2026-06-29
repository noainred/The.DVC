/**
 * vCenter별 iDRAC 스캔 대역 저장소 — 각 vCenter(법인/사이트)에 귀속된 iDRAC IP 대역과
 * 그 대역 스캔에 쓸 iDRAC 계정/비밀번호를 저장한다. 주기 스캐너(scanPoller)가 이 대역을
 * 돌며 Dell iDRAC을 자동 발견·등록(해당 vCenter로 귀속)한다. IPMS의 'vCenter별 스캔 대역'과
 * 같은 사용 흐름이되, iDRAC은 인증이 필요하므로 대역별 계정/비밀번호를 함께 보관한다.
 *
 * 저장: CONFIG_DIR/idrac-scan-ranges.json (0600, 비밀번호 평문 — idrac.json과 동일 관례)
 *   { vcenters: { [vcenterId]: { ranges: string[], username, password, agent, enabled, mode,
 *                                updatedAt, lastRun } } }
 *   - agent: '' 또는 '__local__' = 중앙 포탈이 직접 스캔. 그 외 = 해당 에이전트에 위임.
 *   - mode : 등록 모드(merge 기본). replace 류는 주기 스캔에서 위험하므로 merge로 고정 권장.
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
    cache = j && typeof j.vcenters === 'object' && j.vcenters ? j : { vcenters: {} };
  } catch { cache = { vcenters: {} }; }
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
function redact(vcenterId, e) {
  const { password, ...rest } = e;
  return {
    vcenterId,
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
  const vc = read().vcenters || {};
  return Object.entries(vc).map(([id, e]) => redact(id, e));
}

/** 폴러용 — 비밀번호 포함 원본(클론). enabled+ranges+username 있는 것만. */
export function enabledScanRanges() {
  const vc = read().vcenters || {};
  const out = [];
  for (const [vcenterId, e] of Object.entries(vc)) {
    if (e.enabled === false) continue;
    const ranges = (e.ranges || []).filter(Boolean);
    if (!ranges.length) continue;
    if (!String(e.username || '').trim()) continue; // 계정 없으면 스캔 불가 → 건너뜀
    if (!String(e.password || '')) continue;        // 비밀번호 없으면 인증 불가 → 건너뜀(스캔 보류)
    out.push({
      vcenterId, ranges,
      username: String(e.username || '').trim(),
      password: e.password || '',
      agent: String(e.agent || '').trim(),
      mode: e.mode || 'merge',
    });
  }
  return out;
}

/** 단건 원본(비밀번호 포함) — 폴러/수동 스캔에서 사용. */
export function getScanRangeRaw(vcenterId) {
  const e = (read().vcenters || {})[String(vcenterId || '').trim()];
  return e ? structuredClone(e) : null;
}

/**
 * 저장/수정. partial: { ranges?, username?, password?, agent?, enabled?, mode? }.
 * 비밀번호는 빈 문자열이면 기존 값 유지(다른 필드만 수정 가능). null/명시 삭제는 지원 안 함.
 */
export function saveScanRanges(vcenterId, partial = {}) {
  const id = String(vcenterId || '').trim();
  if (!id) return { ok: false, reason: 'vcenterId가 필요합니다.' };
  if (id.length > 128 || [...id].some((c) => c.charCodeAt(0) < 32)) return { ok: false, reason: 'vcenterId에 사용할 수 없는 문자가 있습니다.' };
  const data = read();
  const cur = data.vcenters[id] || { ranges: [], username: '', password: '', agent: '', enabled: true, mode: 'merge' };
  const next = {
    ranges: partial.ranges !== undefined ? normRanges(partial.ranges) : (cur.ranges || []),
    username: partial.username !== undefined ? String(partial.username || '').trim() : (cur.username || ''),
    // 빈 비밀번호는 기존 유지(편집 시 비번 재입력 강요하지 않음).
    password: (partial.password != null && partial.password !== '') ? String(partial.password) : (cur.password || ''),
    agent: partial.agent !== undefined ? String(partial.agent || '').trim() : (cur.agent || ''),
    enabled: partial.enabled !== undefined ? partial.enabled !== false : (cur.enabled !== false),
    mode: partial.mode !== undefined ? (['merge', 'replace-vcenter'].includes(partial.mode) ? partial.mode : 'merge') : (cur.mode || 'merge'),
    updatedAt: Date.now(),
    lastRun: cur.lastRun || null, // 실행 이력은 보존
  };
  data.vcenters = { ...data.vcenters, [id]: next };
  write(data);
  return { ok: true, ...redact(id, next) };
}

/** 삭제. */
export function removeScanRanges(vcenterId) {
  const id = String(vcenterId || '').trim();
  const data = read();
  if (!data.vcenters[id]) return { ok: false, reason: '없는 항목' };
  const rest = { ...data.vcenters };
  delete rest[id];
  write({ vcenters: rest });
  return { ok: true };
}

/** 폴러가 실행 결과를 기록(per-vCenter lastRun). 저장 충돌 없이 lastRun만 갱신. */
export function recordScanRangeRun(vcenterId, run) {
  const id = String(vcenterId || '').trim();
  const data = read();
  const cur = data.vcenters[id];
  if (!cur) return; // 도중에 삭제됐으면 무시
  data.vcenters = { ...data.vcenters, [id]: { ...cur, lastRun: { at: Date.now(), ...run } } };
  write(data);
}
