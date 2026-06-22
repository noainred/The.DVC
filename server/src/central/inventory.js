/**
 * 사이트 위임 수집 — 중앙(OC2) 측 인벤토리 캐시.
 *
 * 고RTT 원격 사이트의 vCenter는 그 사이트의 단독 서버(에이전트)가 로컬에서 수집해
 * /api/central/inventory 로 push 한다. 중앙은 그 vCenter를 직접 폴링하지 않고(=RTT 제거)
 * 여기 캐시된 스냅샷 조각을 글로벌 스냅샷에 병합한다.
 *
 * 캐시는 메모리 + 디스크(CONFIG_DIR/central-inventory.json)에 보관해 재시작 시에도
 * 다음 push 전까지 마지막 데이터를 서빙한다(콜드 스타트 공백 최소화).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const FILE = path.join(config.configDir, 'central-inventory.json');

let cache = {}; // vcenterId -> { at, agent, generatedAt, data:{ vcenter, hosts, vms, datastores, networks, alarms } }
try {
  if (fs.existsSync(FILE)) { const p = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (p && typeof p === 'object') cache = p.inventory || p || {}; }
} catch { cache = {}; }

let writeTimer = null;
function persistSoon() {
  // 인벤토리는 수MB가 될 수 있으므로 디스크 쓰기를 비동기 + 디바운스(이벤트 루프 비차단).
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.promises.writeFile(FILE, JSON.stringify({ inventory: cache }), { mode: 0o600 }).catch(() => {});
  }, 5_000);
  writeTimer.unref?.();
}

/** 사이트가 push한 한 vCenter의 스냅샷 조각을 저장. */
export function setInventory(vcenterId, slice, agent, generatedAt) {
  cache[vcenterId] = { at: Date.now(), agent: agent || '', generatedAt: generatedAt || null, data: slice };
  persistSoon();
}

export function getInventory(vcenterId) { return cache[vcenterId] || null; }

/** 운영 화면용 요약(데이터 본문 제외). */
export function listInventory() {
  return Object.entries(cache).map(([vcenterId, e]) => ({
    vcenterId, agent: e.agent, at: e.at, generatedAt: e.generatedAt,
    hosts: e.data?.hosts?.length || 0, vms: e.data?.vms?.length || 0,
    datastores: e.data?.datastores?.length || 0,
  })).sort((a, b) => (b.at || 0) - (a.at || 0));
}

/** 레지스트리에서 제거된 vCenter의 캐시 정리. */
export function pruneInventory(validIds) {
  let changed = false;
  for (const id of Object.keys(cache)) if (!validIds.has(id)) { delete cache[id]; changed = true; }
  if (changed) persistSoon();
}
