/**
 * tools/powerOffSettings.js — 전원 꺼짐 점검 설정(`power-off-check.json`, v2.484, 사용자 요청 "몇 시간마다 점검하는지 설정").
 * 점검기는 스냅샷(store)만 읽어 꺼진 VM 을 표(vm-track.db power_off_seen)에 기록한다 — vCenter 왕복이 없어
 * 가볍고, 기본 켜짐(6시간). 다른 설정 스토어와 같이 원자적 쓰기 + preserveCorrupt.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';

const FILE = path.join(config.configDir, 'power-off-check.json');
export const LIMITS = Object.freeze({ minHours: 1, maxHours: 168 });
export const DEFAULTS = Object.freeze({ enabled: true, intervalHours: 6 });

const clampHours = (v, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(LIMITS.maxHours, Math.max(LIMITS.minHours, Math.round(n))) : dflt; };
let cache = null;

export function loadPowerOffSettings() {
  if (cache) return cache;
  const out = { ...DEFAULTS };
  try {
    if (fs.existsSync(FILE)) {
      const p = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
      if (typeof p.enabled === 'boolean') out.enabled = p.enabled;
      if (p.intervalHours != null) out.intervalHours = clampHours(p.intervalHours, DEFAULTS.intervalHours);
    }
  } catch (e) {
    preserveCorrupt(FILE);
    console.warn(`[power-off] 설정 로드 실패 — 원본을 .corrupt 로 보존하고 기본값으로 시작합니다: ${e.message}`);
  }
  cache = out;
  return cache;
}

export function savePowerOffSettings(body = {}) {
  const next = { ...loadPowerOffSettings() };
  if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
  if (body.intervalHours != null) next.intervalHours = clampHours(body.intervalHours, next.intervalHours);
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  cache = next;
  return next;
}

export function _resetPowerOffSettingsCache() { cache = null; }
