/**
 * 엣지 베어메탈 집계 — 중앙(OC2) 측 캐시.
 *
 * 각 엣지(현장) 포탈은 자기 데이터센터의 베어메탈 서버(전력 미보고분 포함)를 중앙으로 push 한다.
 * 중앙은 vCenter 인벤토리(hosts/vms)나 원격 전력(remotePowerByHost)만으로는 보이지 않는
 * '전력 없는 베어메탈'까지 여기 모아 통합 인벤토리에 병합한다(DC별 검색).
 *
 * 메모리 + 디스크(CONFIG_DIR/central-fleet.json) 보관. 오래된 에이전트 보고는 TTL로 만료한다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { bumpFleetRev } from '../insights/fleetRev.js';

const FILE = path.join(config.configDir, 'central-fleet.json');
const TTL_MS = Number(process.env.CENTRAL_FLEET_TTL_MS) || 30 * 60_000; // 30분 무보고 시 만료
const MAX_AGENTS = Number(process.env.CENTRAL_FLEET_MAX_AGENTS) || 500; // 에이전트 수 상한(메모리 보호)
const MAX_WATTS = 1_000_000; // 비현실적 전력값 차단(KPI 오염 방지)
const norm = (s) => String(s || '').trim().toLowerCase();
const cleanWatts = (w) => (Number.isFinite(w) && w >= 0 && w <= MAX_WATTS ? w : null);

let cache = {}; // agent -> { at, generatedAt, baremetal: [ {fleetId,name,model,serviceTag,watts,vcenterId,source} ] }
try {
  if (fs.existsSync(FILE)) { const p = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (p && typeof p === 'object') cache = p.fleet || {}; }
} catch { cache = {}; }

let writeTimer = null;
function persistSoon() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.promises.writeFile(FILE, JSON.stringify({ fleet: cache }), { mode: 0o600 }).catch(() => {});
  }, 5_000);
  writeTimer.unref?.();
}

/** 엣지가 push한 베어메탈 목록 저장. */
export function setEdgeFleet(agent, baremetal, generatedAt) {
  const a = String(agent || '').trim();
  if (!a) return;
  const list = Array.isArray(baremetal) ? baremetal.slice(0, 50_000).map((b) => ({
    fleetId: String(b.fleetId || b.serviceTag || b.serverId || '').slice(0, 256),
    name: String(b.name || '').slice(0, 256),
    model: String(b.model || '').slice(0, 256),
    serviceTag: String(b.serviceTag || '').slice(0, 128),
    watts: cleanWatts(b.watts),
    vcenterId: String(b.vcenterId || '').slice(0, 128),
    source: String(b.source || '').slice(0, 32),
  })) : [];
  // 신규 에이전트인데 상한 초과 → 가장 오래된 보고를 밀어내고 받는다(메모리 무한 누적 방지).
  if (!cache[a] && Object.keys(cache).length >= MAX_AGENTS) {
    const oldest = Object.entries(cache).sort((x, y) => (x[1]?.at || 0) - (y[1]?.at || 0))[0];
    if (oldest) { delete cache[oldest[0]]; console.warn(`[central-fleet] 에이전트 상한(${MAX_AGENTS}) 초과 — 가장 오래된 '${oldest[0]}' 퇴출(신규 '${a}' 수용)`); }
  }
  // 내용 해시(전력 제외 — 미세 변동으로 무효화 폭증 방지). 분류에 영향 주는 필드만.
  const sig = hashList(list);
  const prev = cache[a];
  cache[a] = { at: Date.now(), generatedAt: generatedAt || null, baremetal: list, sig };
  if (!prev || prev.sig !== sig) bumpFleetRev(); // 내용이 바뀐 경우에만 캐시 무효화
  persistSoon();
}

// 분류 관련 필드만으로 안정 해시(djb2). 전력(watts)은 remote 경로/TTL로 반영하므로 제외.
function hashList(list) {
  let h = 5381;
  const s = list.map((b) => `${b.fleetId}|${b.serviceTag}|${b.vcenterId}|${b.name}`).sort().join('\n');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}

/** TTL 지난(무보고) 에이전트 제거 후 살아있는 캐시 반환. */
function liveCache() {
  const now = Date.now();
  let changed = false;
  for (const [a, e] of Object.entries(cache)) {
    if (!e || (now - (e.at || 0)) > TTL_MS) { delete cache[a]; changed = true; }
  }
  if (changed) persistSoon();
  return cache;
}

/**
 * 통합 인벤토리 병합용 — 엣지 보고 베어메탈을 classifyFleet의 servers 형식으로 변환.
 * serverId는 agent+fleetId로 유일화, source='edge', remoteAgent로 출처 표시.
 */
export function getEdgeFleetServers() {
  const out = [];
  for (const [agent, e] of Object.entries(liveCache())) {
    for (const b of (e.baremetal || [])) {
      const st = b.serviceTag || '';
      out.push({
        serverId: `edge:${agent}:${b.fleetId || st || b.name}`,
        serverName: b.name || st || b.fleetId,
        serviceTag: st,
        model: b.model || '',
        host: norm(st || b.name),
        hostNames: [norm(st), norm(b.name)].filter(Boolean),
        watts: Number.isFinite(b.watts) ? b.watts : null,
        vcenterId: b.vcenterId || '',
        source: 'edge',
        remoteAgent: agent,
      });
    }
  }
  return out;
}

/** 운영 화면용 요약. */
export function listEdgeFleet() {
  return Object.entries(liveCache()).map(([agent, e]) => ({
    agent, at: e.at, generatedAt: e.generatedAt, baremetal: (e.baremetal || []).length,
  })).sort((a, b) => (b.at || 0) - (a.at || 0));
}

/** 테스트/관리용 초기화. */
export function resetEdgeFleet() { cache = {}; }
