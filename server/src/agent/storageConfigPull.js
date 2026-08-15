/**
 * agent/storageConfigPull.js — 중앙→엣지 스토리지 장비 배포 pull(v2.302, gpuGuestConfigPull 패턴).
 * 중앙이 이 엣지 앞으로 지정한 장비 목록(자격증명 포함 — 엣지가 장비에 로그인해야 하므로)을
 * 아웃바운드 GET 으로 주기 수집해 로컬 레지스트리에 반영한다(폐쇄망/NAT 엣지 동작).
 * 반영은 registry.applyPulledDevices — 내 몫을 통째 교체(중앙이 진실의 원천: 중앙에서 지운
 * 장비가 엣지에 유령으로 남지 않게). 저장 시 엣지 자신의 vault 정책으로 재봉인된다.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { applyPulledDevices } from '../storage/registry.js';

const INTERVAL_MS = Math.max(60_000, Number(process.env.STORAGE_CONFIG_PULL_MS) || 5 * 60_000);
let _timer = null;
let _lastSig = '';
let _last = null;

export async function pullStorageConfigNow() {
  if (!config.agent.centralUrl || !config.agent.centralToken) return { ok: false, reason: 'pull 비활성화(CENTRAL_URL/TOKEN 미설정)' };
  try {
    const url = `${config.agent.centralUrl}/api/central/storage-config?agent=${encodeURIComponent(config.agent.name || '')}`;
    const res = await resilientFetch(url, { method: 'GET', headers: { 'X-Central-Token': config.agent.centralToken }, timeoutMs: 20_000, retries: 2 });
    if (!res.ok) throw new Error(`storage-config <- ${res.status}`);
    const body = await res.json();
    const devices = body?.devices || [];
    const sig = crypto.createHash('sha1').update(JSON.stringify(devices)).digest('hex');
    if (sig === _lastSig) { _last = { at: Date.now(), applied: false, reason: '변경 없음' }; return { ok: true, unchanged: true }; }
    applyPulledDevices(devices);
    _lastSig = sig;
    _last = { at: Date.now(), applied: true, count: devices.length };
    console.log(`[storage-config] 중앙 배포 장비 적용: agent=${config.agent.name} 장비 ${devices.length}대`);
    return { ok: true, applied: true, count: devices.length };
  } catch (e) { _last = { at: Date.now(), error: e.message }; return { ok: false, reason: e.message }; }
}

export function startStorageConfigPull() {
  if (_timer || !config.agent.centralUrl || !config.agent.centralToken) return;
  setTimeout(() => pullStorageConfigNow().catch(() => {}), 10_000);
  _timer = setInterval(() => pullStorageConfigNow().catch(() => {}), INTERVAL_MS);
  _timer.unref?.();
}
export function storageConfigPullStatus() { return _last; }
