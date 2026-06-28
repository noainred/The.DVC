/**
 * 엣지 포탈(에이전트) 설정 push 워커 — CENTRAL_URL 설정 시 동작. 자기 CONFIG_DIR의 설정을
 * 중앙으로 보내 중앙의 통합 백업에 합쳐지게 한다. 시작 시 + 주기적 + 설정 변경 시 push.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { collectConfigDir } from '../backup/service.js';

let timer = null;
let changeTimer = null;
const PUSH_MS = Number(process.env.AGENT_CONFIG_PUSH_MS) || 1_800_000; // 30분

function headers() {
  return { 'Content-Type': 'application/json', ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
}

export async function pushConfigNow() {
  if (!config.agent.centralUrl) return null;
  try {
    const files = collectConfigDir(); // 자기 설정(*.json/*.env), 대용량 데이터 제외
    const res = await resilientFetch(`${config.agent.centralUrl}/api/central/agent-config`, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ agent: config.agent.name, files }), timeoutMs: 20_000, retries: 2,
    });
    if (res.ok) console.log(`[config-push] sent → ${config.agent.centralUrl} (${Object.keys(files).length}개 설정)`);
    return res.ok;
  } catch (e) { console.warn(`[config-push] 실패: ${e.message}`); return false; }
}

export function startConfigPush() {
  if (!config.agent.centralUrl) return; // 중앙 미설정 → 에이전트 아님
  setTimeout(() => pushConfigNow().catch(() => {}), 25_000).unref?.();
  timer = setInterval(() => pushConfigNow().catch(() => {}), PUSH_MS);
  timer.unref?.();
  // 설정 변경 감시 → 디바운스 후 push
  try {
    fs.watch(config.configDir, { persistent: false }, (_e, filename) => {
      if (!filename) return;
      const ext = path.extname(String(filename)).toLowerCase();
      if (ext !== '.json' && ext !== '.env') return;
      if (changeTimer) clearTimeout(changeTimer);
      changeTimer = setTimeout(() => pushConfigNow().catch(() => {}), 15_000);
      changeTimer.unref?.();
    });
  } catch { /* 감시 불가 환경 무시 */ }
  console.log(`[config-push] started (central=${config.agent.centralUrl})`);
}
