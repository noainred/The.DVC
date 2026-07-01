/**
 * 엣지 포탈(에이전트) 설정 저장소 — 에이전트가 push한 자기 CONFIG_DIR 설정을 보관한다.
 * 중앙의 통합 백업이 이 값을 합쳐 저장한다. 디스크에도 지속(재시작 후 마지막 설정 유지).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const FILE = path.join(config.configDir, 'central-agent-config.json');

// null-proto: 에이전트 이름을 키로 쓰므로 '__proto__' 등에 의한 프로토타입 오염 방지.
let byAgent = Object.create(null); // agent -> { at, files:{ name: content } }
try { if (fs.existsSync(FILE)) byAgent = Object.assign(Object.create(null), JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}); } catch { byAgent = Object.create(null); }

let writeTimer = null;
function persistSoon() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try { fs.writeFileSync(FILE, JSON.stringify(byAgent), { mode: 0o600 }); } catch { /* */ }
  }, 3_000);
  writeTimer.unref?.();
}

/** 에이전트가 자기 설정을 push. files: { name: content(utf8) }. */
export function setAgentConfig(agent, files) {
  if (!agent || !files || typeof files !== 'object') return;
  byAgent[agent] = { at: Date.now(), files };
  persistSoon();
}

export function getAllAgentConfigs() { return byAgent; }

export function listAgentConfigs() {
  return Object.entries(byAgent).map(([agent, e]) => ({ agent, at: e.at, files: Object.keys(e.files || {}).length }))
    .sort((a, b) => (b.at || 0) - (a.at || 0));
}
