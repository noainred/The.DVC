/**
 * central/sanSwitchEdge.js — 엣지들이 push 한 SAN 스위치 스냅샷의 중앙 보관(v2.410).
 * agent → { at, devices:[스냅샷] }. 파일: central-agent-sanswitch.json
 * (central-agent-* 는 .gitignore 와일드카드로 이미 커밋 차단).
 * 저장 키는 라우트가 req.centralAuth.agent 로 강제한다(agent 바인딩 — server/CLAUDE.md).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';

const FILE = path.join(config.configDir, 'central-agent-sanswitch.json');
const MAX_DEVICES_PER_AGENT = 300;
let _map = null;

function load() {
  if (_map) return _map;
  try { _map = new Map(Object.entries(JSON.parse(fs.readFileSync(FILE, 'utf8')))); }
  catch { _map = new Map(); } // 캐시 성격 — 다음 push 가 재구축
  return _map;
}

export function saveEdgeSanSwitch(agent, devices) {
  const list = (Array.isArray(devices) ? devices : []).slice(0, MAX_DEVICES_PER_AGENT)
    .map((d) => ({ ...d, agent })); // 엣지가 뭐라 보냈든 인증된 agent 로 덮는다(출처 위조 차단)
  load().set(agent, { at: Date.now(), devices: list });
  atomicWriteFileSync(FILE, JSON.stringify(Object.fromEntries(load())), { mode: 0o600 });
  return list.length;
}

/** 전 엣지 스냅샷 평탄 목록(중앙 화면이 로컬 수집분과 합쳐 쓴다). */
export function edgeSanSwitchSnapshots() {
  const out = [];
  for (const [agent, v] of load()) for (const d of v.devices || []) out.push({ ...d, agent, pushedAt: v.at });
  return out;
}
export function _resetForTest() { _map = null; }
