/**
 * 전력 집계 표시 설정 — CONFIG_DIR/power-settings.json.
 * excludeUnmapped: vCenter에 귀속되지 않는(미매핑) 측정 전력을 총합/보고/목록에서 제외한다.
 *   원격 수집기가 보고하지만 중앙이 폴링하지 않는 데이터센터의 호스트처럼, 어느 vCenter에도
 *   매핑되지 않아 '(미매핑)'으로 잡히는 장비를 영구적으로 빼고 싶을 때 사용(수집기가 매 주기
 *   다시 보내도 표시에서 제외됨).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { buildHostIndex, resolveServerVcenter } from './attribution.js';

const FILE = path.join(config.configDir, 'power-settings.json');
// includeVcenterPower: vCenter PerformanceManager(power.power.average)로 수집한 ESXi 호스트
//   전력을 측정 소스로 합산할지(기본 on). iDRAC/OME/원격으로 이미 잡힌 서버와는 중복 제거.
const DEFAULTS = { excludeUnmapped: false, includeVcenterPower: true };

let cache = null;
export function loadPowerSettings() {
  if (cache) return cache;
  cache = { ...DEFAULTS };
  try {
    if (fs.existsSync(FILE)) cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch { /* defaults */ }
  return cache;
}

export function savePowerSettings(body = {}) {
  const cur = loadPowerSettings();
  const next = {
    excludeUnmapped: body.excludeUnmapped !== undefined ? Boolean(body.excludeUnmapped) : cur.excludeUnmapped,
    includeVcenterPower: body.includeVcenterPower !== undefined ? Boolean(body.includeVcenterPower) : (cur.includeVcenterPower !== false),
  };
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  cache = next;
  return next;
}

/**
 * 설정(excludeUnmapped)에 따라 측정 전력 목록에서 미매핑(귀속 vCenter 없음) 항목을 제거한다.
 * 설정이 꺼져 있으면 원본을 그대로 반환. snap.hosts/vcenters로 귀속을 판정한다.
 * @param measured allMeasuredPower() 결과
 * @param snap     store 스냅샷(hosts, vcenters)
 */
export function filterMeasuredByMapping(measured, snap) {
  const s = loadPowerSettings();
  if (!s.excludeUnmapped || !Array.isArray(measured)) return measured;
  const idx = buildHostIndex(snap?.hosts || []);
  const validVcIds = new Set((snap?.vcenters || []).map((v) => v.id));
  return measured.filter((m) => resolveServerVcenter(m, idx, validVcIds) != null);
}
