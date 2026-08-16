/**
 * central/storageEdge.js — 엣지들이 push 한 스토리지 스냅샷의 중앙 보관(v2.302).
 * agent → { at, devices:[NormalizedSnapshot] }. 파일 영속: central-agent-storage.json
 * (central-agent-* 는 .gitignore 와일드카드로 이미 커밋 차단 — 계정 목록 포함 데이터).
 * 저장 키는 라우트가 req.centralAuth.agent 로 강제한다(agent 바인딩 — server/CLAUDE.md).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { recordActivity } from '../storage/activityLog.js';

const FILE = path.join(config.configDir, 'central-agent-storage.json');
const MAX_DEVICES_PER_AGENT = 500;
let _map = null;
// 엣지 push 로그 중복 제거 — 엣지는 5분마다 전 장비를 다시 보내므로, 같은 collectedAt 을
// 매번 로그에 남기면 같은 수집이 중복 기록된다. deviceId → 마지막 기록한 collectedAt.
const _lastRec = new Map();

function load() {
  if (_map) return _map;
  try { _map = new Map(Object.entries(JSON.parse(fs.readFileSync(FILE, 'utf8')))); }
  catch { _map = new Map(); } // 캐시 성격 — 다음 push 가 재구축
  return _map;
}

export function saveEdgeStorage(agent, devices) {
  const list = (Array.isArray(devices) ? devices : []).slice(0, MAX_DEVICES_PER_AGENT)
    .map((d) => ({ ...d, agent })); // 표시용 출처 각인(엣지가 뭐라 보냈든 인증된 agent 로 덮음)
  load().set(agent, { at: Date.now(), devices: list });
  atomicWriteFileSync(FILE, JSON.stringify(Object.fromEntries(load())), { mode: 0o600 });
  // 작업 로그(v2.315) — 엣지가 보낸 각 장비의 '완료' 이벤트를 중앙 로그에 남긴다(화면 '완료' 구획).
  // 같은 collectedAt 재push 는 건너뛴다(엣지 5분 push × 10분 수집 = 같은 스냅샷이 두 번 옴).
  for (const dv of list) {
    const key = dv.deviceId || dv.id;
    if (!key) continue;
    const ca = Number(dv.collectedAt) || 0;
    if (_lastRec.get(key) === ca) continue;
    _lastRec.set(key, ca);
    try {
      recordActivity({
        deviceId: key, name: dv.name || key, host: dv.host || '', source: agent,
        ok: !!dv.ok, nodes: dv.nodes?.count ?? null,
        usedBytes: dv.capacity?.usedBytes ?? null, totalBytes: dv.capacity?.totalBytes ?? null,
        error: dv.ok ? null : (dv.error || null), at: ca || Date.now(),
      });
    } catch { /* 로그 실패가 push 수신을 막지 않게 */ }
  }
  return list.length;
}

/** 전 엣지 스냅샷 평탄화(+ 보고 시각). 오래된 보고도 노출하되 staleMs 로 표시(숨기지 않음 — 정직). */
export function edgeStorageSnapshots() {
  const out = [];
  for (const [agent, rec] of load()) {
    for (const d of rec.devices || []) out.push({ ...d, agent, reportedAt: rec.at, staleMs: Date.now() - rec.at });
  }
  return out;
}
export function _resetForTest() { _map = null; }
