/**
 * storage/push.js — 엣지 → 중앙 스토리지 스냅샷 push(v2.302, gpuGuestPush 패턴).
 * 이 노드가 수집한 정규화 스냅샷(자격증명 없음)을 중앙 POST /api/central/storage-data 로 밀어
 * 올린다. CENTRAL_URL/토큰 미설정(=중앙 자신)이면 스스로 기동하지 않는다.
 */
import { config } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { localSnapshots } from './store.js';

const INTERVAL_MS = Math.max(60_000, Number(process.env.STORAGE_PUSH_MS) || 5 * 60_000);
let _timer = null;
let _busy = false;
let _last = null;

export async function pushStorageNow() {
  if (!config.agent.centralUrl || !config.agent.centralToken) return { ok: false, reason: 'push 비활성화(CENTRAL_URL/TOKEN 미설정)' };
  if (_busy) return { ok: false, reason: '이전 push 진행 중' }; // 재진입 가드
  _busy = true;
  try {
    const devices = localSnapshots();
    if (!devices.length) { _last = { at: Date.now(), sent: 0 }; return { ok: true, sent: 0 }; }
    const res = await resilientFetch(`${config.agent.centralUrl}/api/central/storage-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) },
      body: JSON.stringify({ agent: config.agent.name, devices }),
      timeoutMs: 30_000, retries: 2,
    });
    if (!res.ok) throw new Error(`storage-data <- ${res.status}`);
    _last = { at: Date.now(), sent: devices.length };
    return { ok: true, sent: devices.length };
  } catch (e) { _last = { at: Date.now(), error: e.message }; return { ok: false, reason: e.message }; }
  finally { _busy = false; }
}

export function startStoragePush() {
  if (_timer || !config.agent.centralUrl || !config.agent.centralToken) return;
  setTimeout(() => pushStorageNow().catch(() => {}), 45_000); // 첫 수집(15s+α) 뒤에 첫 push
  _timer = setInterval(() => pushStorageNow().catch(() => {}), INTERVAL_MS);
  _timer.unref?.();
}
export function storagePushStatus() { return _last; }
