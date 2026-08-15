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

const FILE = path.join(config.configDir, 'central-agent-storage.json');
const MAX_DEVICES_PER_AGENT = 500;
let _map = null;

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
