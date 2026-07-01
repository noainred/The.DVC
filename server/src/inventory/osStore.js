/**
 * 실제 OS 인벤토리 저장소(별도 DB) — VM별 1행, vmId 키로 upsert.
 * CONFIG_DIR/os-inventory.json(맵). 게스트에서 읽은 실제 OS와 ESXi 보고 guestOS의 불일치 여부 보관.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { classifyOs, majorOf } from './osDetect.js';

const FILE = path.join(config.configDir, 'os-inventory.json');

let map = null; // vmId -> record
let wt = null;

function load() {
  if (map) return map;
  map = new Map();
  try { const o = JSON.parse(fs.readFileSync(FILE, 'utf8')); for (const [k, v] of Object.entries(o || {})) map.set(k, v); } catch { /* */ }
  return map;
}
function persistSoon() {
  if (wt) return;
  wt = setTimeout(() => { wt = null; try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(load()), null, 0), { mode: 0o600 }); } catch { /* */ } }, 2000);
  wt.unref?.();
}

/** ESXi 보고 guestOS와 실제 탐지 OS의 불일치 판정(계열 또는 메이저 버전 차이). */
export function computeMismatch(esxiGuestOS, detected) {
  if (!detected || !detected.os) return false;
  const ef = classifyOs(esxiGuestOS || '');
  const df = detected.family || classifyOs(detected.os);
  if (ef !== 'Other' && df !== 'Other' && ef !== df) return true;
  const em = majorOf(esxiGuestOS || ''); const dm = majorOf(detected.osVersion || detected.os || '');
  if (em && dm && em !== dm) return true;
  return false;
}

/** 탐지 결과 upsert. vm: {id,name,vcenterId,host,cluster,guestOS}. detected: osDetect 결과 또는 null(+error). */
export function upsertOs(vm, detected, error = '') {
  load();
  const mismatch = detected ? computeMismatch(vm.guestOS, detected) : false;
  const rec = {
    vmId: vm.id, vmName: vm.name, vcenterId: vm.vcenterId, host: vm.host || '', cluster: vm.cluster || '',
    esxiGuestOS: vm.guestOS || '',
    os: detected?.os || '', osId: detected?.osId || '', osVersion: detected?.osVersion || '', family: detected?.family || '',
    kernel: detected?.kernel || '', mismatch, error: error || '', at: Date.now(),
  };
  map.set(vm.id, rec);
  persistSoon();
  return rec;
}

export function getOsResults({ vcenterId = '', mismatch = false } = {}) {
  load();
  let rows = [...map.values()];
  if (vcenterId) rows = rows.filter((r) => r.vcenterId === vcenterId);
  if (mismatch) rows = rows.filter((r) => r.mismatch);
  return rows.sort((a, b) => (a.vcenterId === b.vcenterId
    ? String(a.vmName || '').localeCompare(String(b.vmName || ''))
    : String(a.vcenterId || '').localeCompare(String(b.vcenterId || ''))));
}

export function getScannedIds() { load(); return new Set(map.keys()); }
export function getScanInfo(vmId) { load(); return map.get(vmId) || null; }

export function osSummary() {
  load();
  const rows = [...map.values()];
  const byFamily = {};
  for (const r of rows) { const f = r.family || '미상'; byFamily[f] = (byFamily[f] || 0) + 1; }
  return {
    scanned: rows.length,
    mismatches: rows.filter((r) => r.mismatch).length,
    errors: rows.filter((r) => r.error).length,
    byFamily: Object.entries(byFamily).map(([family, count]) => ({ family, count })).sort((a, b) => b.count - a.count),
    lastAt: rows.reduce((mx, r) => Math.max(mx, r.at || 0), 0) || null,
  };
}

/** 스냅샷에 없는(삭제된) VM 레코드 정리. validIds: 현재 존재하는 vmId Set. */
export function pruneMissing(validIds) {
  load();
  let removed = 0;
  for (const id of [...map.keys()]) if (!validIds.has(id)) { map.delete(id); removed++; }
  if (removed) persistSoon();
  return removed;
}
