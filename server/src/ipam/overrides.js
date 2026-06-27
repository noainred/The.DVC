/**
 * Per-IP 수동 관리(override) 저장소 — vCenter/스캔으로 자동 발견되는 정보와 별개로,
 * 운영자가 IP 단위로 직접 부여하는 '관리 상태'를 보관한다. 스냅샷 새로고침과 무관하게
 * 영속되며(주석/메모와 동일 패턴), IP 대장(ledger)이 병합해 표시한다.
 *
 * 저장 위치: CONFIG_DIR/ipam-overrides.json, IP 주소를 키로 한다.
 * 레코드 필드:
 *   status        '' | 'active' | 'reserved' | 'deprecated' | 'dhcp' | 'static' | 'ignored'
 *                 (ignored = 대장에서 숨김. 그 외는 배지로 표시)
 *   owner         담당자/팀
 *   label         사용자 지정 이름(자동 hostname 대신 표시)
 *   deviceType    'vm'|'host'|'switch'|'router'|'firewall'|'storage'|'idrac'|'printer'|'server'|'other'
 *   hostnameOverride  자동 hostname을 덮어쓸 이름
 *   reservedUntil ISO 문자열 — 예약 만료 시각(없으면 무기한)
 *   note          한 줄 비고(메모/태그는 annotations.js가 담당, 여기는 상태성 비고)
 *   updatedAt/updatedBy
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';

const FILE = path.join(config.configDir, 'ipam-overrides.json');

export const STATUSES = ['active', 'reserved', 'deprecated', 'dhcp', 'static', 'ignored'];
export const DEVICE_TYPES = ['vm', 'host', 'switch', 'router', 'firewall', 'storage', 'idrac', 'printer', 'server', 'loadbalancer', 'appliance', 'other'];

let cache = null;
let rev = 0; // override 변경 리비전(대장 캐시 무효화 키)
export function overridesRev() { return rev; }

function load() {
  if (cache) return cache;
  cache = {};
  try { if (fs.existsSync(FILE)) cache = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { cache = {}; }
  return cache;
}

/** 전체 맵 { ip: {status, owner, label, deviceType, hostnameOverride, reservedUntil, note, updatedAt, updatedBy} }. */
export function getOverrides() { return load(); }

/** 한 IP의 override, 없으면 null. */
export function getOverride(ip) { return load()[String(ip)] || null; }

function clean(partial = {}) {
  const out = {};
  if (partial.status !== undefined) {
    const s = String(partial.status || '').trim().toLowerCase();
    out.status = STATUSES.includes(s) ? s : '';
  }
  if (partial.owner !== undefined) out.owner = String(partial.owner || '').trim().slice(0, 200);
  if (partial.label !== undefined) out.label = String(partial.label || '').trim().slice(0, 200);
  if (partial.deviceType !== undefined) {
    const d = String(partial.deviceType || '').trim().toLowerCase();
    out.deviceType = DEVICE_TYPES.includes(d) ? d : '';
  }
  if (partial.hostnameOverride !== undefined) out.hostnameOverride = String(partial.hostnameOverride || '').trim().slice(0, 253);
  if (partial.claimedVcenterId !== undefined) out.claimedVcenterId = String(partial.claimedVcenterId || '').trim().slice(0, 120);
  if (partial.note !== undefined) out.note = String(partial.note || '').trim().slice(0, 1000);
  if (partial.reservedUntil !== undefined) {
    const v = partial.reservedUntil;
    if (!v) out.reservedUntil = null;
    else { const t = new Date(v); out.reservedUntil = Number.isNaN(t.getTime()) ? null : t.toISOString(); }
  }
  return out;
}

// 의미 있는 값이 하나도 없으면 레코드를 제거(빈 껍데기 방지).
function isEmpty(rec) {
  return !rec || (!rec.status && !rec.owner && !rec.label && !rec.deviceType
    && !rec.hostnameOverride && !rec.note && !rec.reservedUntil && !rec.claimedVcenterId);
}

function persist(data) {
  atomicWriteFileSync(FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  cache = data; rev++;
}

/**
 * 한 IP의 override를 생성/수정/삭제. 부분 업데이트(주어진 필드만 갱신).
 * 모든 필드가 비면 레코드 삭제. { ok, override } 반환.
 */
export function setOverride(ip, partial = {}, user) {
  const key = String(ip || '').trim();
  if (!key) return { ok: false, reason: 'IP가 필요합니다.' };
  const data = load();
  const prev = data[key] || {};
  const next = { ...prev, ...clean(partial) };
  delete next.updatedAt; delete next.updatedBy;
  if (isEmpty(next)) {
    if (data[key]) { delete data[key]; persist(data); }
    return { ok: true, override: null };
  }
  next.updatedAt = new Date().toISOString();
  next.updatedBy = user?.username || 'unknown';
  data[key] = next;
  persist(data);
  return { ok: true, override: next };
}

/** 한 IP의 override 완전 삭제. */
export function clearOverride(ip) {
  const key = String(ip || '').trim();
  const data = load();
  if (data[key]) { delete data[key]; persist(data); }
  return { ok: true };
}

/**
 * 여러 IP에 같은 변경을 일괄 적용(예: 한 대역을 모두 'reserved'로). 단일 쓰기.
 * ips: string[] | "a,b\nc" — 반환 { ok, changed }.
 */
export function setOverrideBatch(ips, partial = {}, user) {
  const list = (Array.isArray(ips) ? ips : String(ips || '').split(/[\s,]+/)).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length) return { ok: false, reason: '대상 IP가 없습니다.' };
  const data = load();
  const patch = clean(partial);
  const now = new Date().toISOString();
  const by = user?.username || 'unknown';
  let changed = 0;
  for (const ip of list) {
    const prev = data[ip] || {};
    const next = { ...prev, ...patch };
    delete next.updatedAt; delete next.updatedBy;
    if (isEmpty(next)) { if (data[ip]) { delete data[ip]; changed++; } continue; }
    next.updatedAt = now; next.updatedBy = by;
    data[ip] = next; changed++;
  }
  if (changed) persist(data);
  return { ok: true, changed };
}

/** 관리 상태 요약(상태별·디바이스별 개수) — 대시보드용. */
export function overridesSummary() {
  const data = load();
  const byStatus = {}; const byDevice = {};
  let total = 0;
  for (const rec of Object.values(data)) {
    total++;
    if (rec.status) byStatus[rec.status] = (byStatus[rec.status] || 0) + 1;
    if (rec.deviceType) byDevice[rec.deviceType] = (byDevice[rec.deviceType] || 0) + 1;
  }
  return { total, byStatus, byDevice };
}
