/**
 * 엣지 포탈(에이전트) 설정 저장소 — 에이전트가 push한 자기 CONFIG_DIR 설정을 보관한다.
 * 중앙의 통합 백업이 이 값을 합쳐 저장한다. 디스크에도 지속(재시작 후 마지막 설정 유지).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { redactEnvSecrets } from '../util/envRedact.js'; // v2.538

const FILE = path.join(config.configDir, 'central-agent-config.json');

// null-proto: 에이전트 이름을 키로 쓰므로 '__proto__' 등에 의한 프로토타입 오염 방지.
let byAgent = Object.create(null); // agent -> { at, files:{ name: content } }
// ⚠ v2.500(감사 M3): 이 파일은 각 엣지가 push 한 CONFIG_DIR 사본이다(portal.env 의 AUTH_SECRET·
// CENTRAL_TOKEN, users.json TOTP, vcenters.json 비밀번호). 손상 시 조용히 {} 로 넘어가면 3초 뒤
// persistSoon 이 **온전했던 원본을 빈 객체로 덮어쓴다** — 전 법인 설정 사본이 영구 유실된다.
// 다른 비밀 스토어와 같은 규약(preserveCorrupt)으로 원본을 보존한다.
try { if (fs.existsSync(FILE)) byAgent = Object.assign(Object.create(null), JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}); } catch (e) { preserveCorrupt(FILE, e.message); byAgent = Object.create(null); }

let writeTimer = null;
function persistSoon() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try { atomicWriteFileSync(FILE, JSON.stringify(byAgent), { mode: 0o600 }); } catch { /* */ }
  }, 3_000);
  writeTimer.unref?.();
}

/** 에이전트가 자기 설정을 push. files: { name: content(utf8) }. */
export function setAgentConfig(agent, files) {
  if (!agent || !files || typeof files !== 'object') return;
  // v2.538: 엣지가 보낸 .env 의 키·토큰은 중앙에 저장하지 않는다 — 새 엣지는 push 전에 가리지만
  // 구버전 엣지는 그대로 보내므로 수신 쪽에서도 가린다(둘 중 하나만 있으면 업그레이드 순서에 구멍이 생긴다).
  const cleaned = {};
  for (const [k, v] of Object.entries(files)) {
    cleaned[k] = (typeof v === 'string' && /\.env$/i.test(String(k))) ? redactEnvSecrets(v).text : v;
  }
  byAgent[agent] = { at: Date.now(), files: cleaned };
  persistSoon();
}

export function getAllAgentConfigs() { return byAgent; }

export function listAgentConfigs() {
  return Object.entries(byAgent).map(([agent, e]) => ({ agent, at: e.at, files: Object.keys(e.files || {}).length }))
    .sort((a, b) => (b.at || 0) - (a.at || 0));
}
