/**
 * 중앙→엣지 배포 사용자 — 엣지(agent) 측 pull 워커.
 *
 * 중앙에서 이 엣지 앞으로 지정한 사용자 목록(설정 열람 등 접근 계정)을 아웃바운드 GET으로 주기적
 * 으로 가져와 로컬 users.json에 managed 태그로 반영한다(applyManagedUsers). 폐쇄망/NAT 엣지도
 * 중앙이 직접 push하지 않고 엣지가 pull하므로 동작한다.
 *
 * 로컬(비managed) 계정은 절대 건드리지 않으며, 배포 목록에서 빠진 managed 계정만 제거한다
 * (마지막 admin은 보호). 내용이 바뀌지 않으면(서명 동일) 재적용하지 않는다.
 */

import crypto from 'node:crypto';
import { config } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { applyManagedUsers } from '../auth/auth.js';

let timer = null;
let last = null;
let lastSig = '';

function headers() {
  return { ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
}

export async function pullUsersConfigNow() {
  if (!config.agent.centralUrl || !config.agent.centralToken) return { ok: false, reason: 'pull 비활성화(CENTRAL_URL/TOKEN 미설정)' };
  const url = `${config.agent.centralUrl}/api/central/users-config?agent=${encodeURIComponent(config.agent.name || '')}`;
  try {
    const res = await resilientFetch(url, { method: 'GET', headers: headers(), timeoutMs: 20_000, retries: 2 });
    if (!res.ok) throw new Error(`users-config <- ${res.status}`);
    const body = await res.json();
    const users = Array.isArray(body?.users) ? body.users : [];
    const sig = crypto.createHash('sha1').update(JSON.stringify(users)).digest('hex');
    if (sig === lastSig) { last = { at: Date.now(), applied: false, reason: '변경 없음' }; return { ok: true, applied: false, unchanged: true }; }
    const r = applyManagedUsers(users);
    lastSig = sig;
    last = { at: Date.now(), applied: true, ...r };
    if (r.created || r.updated || r.removed) console.log(`[users-config] 중앙 배포 사용자 적용: 생성 ${r.created}·갱신 ${r.updated}·삭제 ${r.removed}${r.skipped.length ? ` · 건너뜀 ${r.skipped.join(', ')}` : ''}`);
    return { ok: true, applied: true, ...r };
  } catch (e) {
    last = { at: Date.now(), applied: false, error: e.message };
    return { ok: false, error: e.message };
  }
}

export function usersConfigPullStatus() {
  return { enabled: !!(config.agent.centralUrl && config.agent.centralToken), centralUrl: config.agent.centralUrl, last };
}

export function startUsersConfigPull() {
  if (!config.agent.centralUrl || !config.agent.centralToken) return;
  const intervalMs = Math.max(30_000, config.agent.inventoryIntervalMs || 60_000);
  setTimeout(() => pullUsersConfigNow().catch((e) => console.error('[users-config] pull 실패:', e.message)), 10_000).unref?.();
  timer = setInterval(() => pullUsersConfigNow().catch(() => {}), intervalMs);
  timer.unref?.();
  console.log(`[users-config] pull started <- ${config.agent.centralUrl} every ${Math.round(intervalMs / 1000)}s`);
}
