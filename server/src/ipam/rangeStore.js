/**
 * vCenter별 IP 스캔 대역 저장소 — 각 vCenter(법인/사이트)에 귀속된 스캔 대역을 저장하고,
 * 주기 스캔(scanPoller)이 이 대역들을 합쳐 함께 스캔하도록 한다. 대역 선택 → 네트워크 맵
 * 시각화(netmap)의 대상 IP 집합도 여기서 가져온다.
 *
 * 저장: CONFIG_DIR/ipam-vcenter-ranges.json
 *   { vcenters: { [vcenterId]: { ranges: string[], enabled: bool, updatedAt: ms } } }
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const FILE = path.join(config.configDir, 'ipam-vcenter-ranges.json');

let cache = null;
let cacheMtime = -1;

function read() {
  // 파일 mtime이 캐시 적재 이후 변했으면(외부 편집·백업 복원·다른 프로세스) 재파싱한다.
  let mtime = -1;
  try { mtime = fs.statSync(FILE).mtimeMs; } catch { mtime = 0; /* 파일 없음 */ }
  if (cache && mtime === cacheMtime) return cache;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = j && typeof j.vcenters === 'object' ? j : { vcenters: {} };
  } catch { cache = { vcenters: {} }; }
  cacheMtime = mtime;
  return cache;
}

function write(data) {
  cache = data;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
    try { fs.chmodSync(FILE, 0o600); } catch { /* */ }
    try { cacheMtime = fs.statSync(FILE).mtimeMs; } catch { cacheMtime = -1; }
  } catch (e) { console.error('[ipam-ranges] 저장 실패:', e.message); }
}

const normRanges = (r) => (Array.isArray(r) ? r : String(r || '').split(/[\n,]/))
  .map((s) => String(s).trim()).filter(Boolean);

/** 전체 per-vCenter 대역 맵 반환(원본 캐시는 노출하지 않게 복제). */
export function loadVcRanges() {
  return structuredClone(read().vcenters || {});
}

/** [{ vcenterId, ranges, enabled, updatedAt }] 목록. */
export function listVcRanges() {
  const vc = read().vcenters || {};
  return Object.entries(vc).map(([vcenterId, e]) => ({
    vcenterId, ranges: e.ranges || [], enabled: e.enabled !== false, updatedAt: e.updatedAt || null,
  }));
}

/** 특정 vCenter 대역(문자열 배열). */
export function rangesForVcenter(vcenterId) {
  const e = (read().vcenters || {})[vcenterId];
  return e ? (e.ranges || []) : [];
}

/** vCenter 대역 저장/수정. partial: { ranges?, enabled? }. */
export function saveVcRanges(vcenterId, partial = {}) {
  const id = String(vcenterId || '').trim();
  if (!id) return { ok: false, reason: 'vcenterId가 필요합니다.' };
  const data = read();
  const cur = data.vcenters[id] || { ranges: [], enabled: true };
  const next = {
    ranges: partial.ranges !== undefined ? normRanges(partial.ranges) : (cur.ranges || []),
    enabled: partial.enabled !== undefined ? partial.enabled !== false : (cur.enabled !== false),
    updatedAt: Date.now(),
  };
  data.vcenters = { ...data.vcenters, [id]: next };
  write(data);
  return { ok: true, vcenterId: id, ...next };
}

/** vCenter 대역 삭제. */
export function removeVcRanges(vcenterId) {
  const data = read();
  if (!data.vcenters[vcenterId]) return { ok: false, reason: '없는 항목' };
  delete data.vcenters[vcenterId];
  write({ vcenters: { ...data.vcenters } });
  return { ok: true };
}

/** enabled인 모든 vCenter 대역을 합친 유니크 spec 배열(폴러가 함께 스캔). */
export function enabledVcRanges() {
  const vc = read().vcenters || {};
  const set = new Set();
  for (const e of Object.values(vc)) {
    if (e.enabled === false) continue;
    for (const r of (e.ranges || [])) { const s = String(r).trim(); if (s) set.add(s); }
  }
  return [...set];
}
