/**
 * Cache of the latest hardware/firmware inventory collected per iDRAC server.
 * Inventory is mostly static, so it is refreshed on a slow cadence and
 * persisted to CONFIG_DIR/idrac-inventory.json so it survives restarts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js'; // v2.582 ARCH-3: 상태 파일도 원자 쓰기(절단본 → 로드 실패 → 다음 저장이 빈 값으로 덮어쓰는 왕복 손상 차단)
import { registerExitFlush } from '../util/exitFlush.js'; // v2.582 ARCH-4: 디바운스 저장은 종료 시 동기 flush 를 등록한다

const FILE = path.join(config.configDir, 'idrac-inventory.json');

let cache = new Map(); // serverId -> inventory
let persistTimer = null;

// Load persisted inventory on first import.
try {
  if (fs.existsSync(FILE)) {
    const obj = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const [k, v] of Object.entries(obj || {})) cache.set(k, v);
  }
} catch { /* ignore */ }

function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      atomicWriteFileSync(FILE, JSON.stringify(Object.fromEntries(cache)), { mode: 0o600 });
    } catch { /* best effort */ }
  }, 10_000);
  persistTimer.unref?.();
}
registerExitFlush('idrac/invCache', () => { if (!persistTimer) return; clearTimeout(persistTimer); persistTimer = null; atomicWriteFileSync(FILE, JSON.stringify(Object.fromEntries(cache)), { mode: 0o600 }); });

const _forceStale = new Set();   // v3.52 ⑬ — 이벤트를 받은 서버는 다음 폴링에서 인벤토리를 다시 읽는다(메모리만 · 상한)
export function setInventory(serverId, inv) {
  cache.set(serverId, inv);
  _forceStale.delete(String(serverId));
  persistSoon();
}
/** 다음 폴링에서 이 서버의 인벤토리를 다시 읽게 한다(장비 이벤트 — idrac/eventSub.js). 상한 2,000. */
export function markInventoryStale(serverId) { if (_forceStale.size < 2000) _forceStale.add(String(serverId)); }

export function getInventory(serverId) {
  return cache.get(serverId) || null;
}

/** True if inventory for this server is missing or older than maxAgeMs. */
export function inventoryStale(serverId, maxAgeMs) {
  if (_forceStale.has(String(serverId))) return true;
  const inv = cache.get(serverId);
  return !inv || (Date.now() - (inv.collectedAt || 0)) > maxAgeMs;
}

export function removeInventory(serverId) {
  _forceStale.delete(String(serverId));   // 지운 서버의 강제 표지가 상한을 먹지 않게(v3.52 디버깅 1회차 성능 P7)
  if (cache.delete(serverId)) persistSoon();
}
