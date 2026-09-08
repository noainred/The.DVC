/**
 * pdu/push.js — 엣지 → 중앙 PDU 스냅샷 전송.
 *
 * storage/push.js 와 같은 축. 자격증명은 절대 싣지 않는다(스냅샷은 측정값만).
 * 페이로드가 커질 수 있어(PDU 4대 × 뱅크 12 × 센서 N) 장비 수 상한을 두고, 중앙의
 * express.json 한도 아래로 유지한다.
 */

import { config } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { localSnapshots } from './poller.js';
import { pushMs, startAdaptiveTimer } from './intervals.js';

let _timer = null;
let _last = { at: null, ok: false, count: 0, reason: '' };

export async function pushPduNow() {
  if (!config.agent.centralUrl || !config.agent.centralToken) {
    return { ok: false, reason: 'push 비활성화(CENTRAL_URL/CENTRAL_TOKEN 미설정)' };
  }
  const snapshots = localSnapshots().slice(0, 500);
  if (!snapshots.length) { _last = { at: Date.now(), ok: true, count: 0, reason: '보낼 스냅샷 없음' }; return { ok: true, count: 0 }; }
  try {
    const res = await resilientFetch(`${config.agent.centralUrl}/api/central/pdu-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Central-Token': config.agent.centralToken },
      body: JSON.stringify({ agent: config.agent.name, snapshots }),
      timeoutMs: 30_000, retries: 2,
    });
    const ok = res.ok;
    _last = { at: Date.now(), ok, count: snapshots.length, reason: ok ? '' : `HTTP ${res.status}` };
    return { ok, count: snapshots.length };
  } catch (e) {
    _last = { at: Date.now(), ok: false, count: 0, reason: e.message };
    return { ok: false, reason: e.message };
  }
}

export function startPduPush() {
  if (_timer || !config.agent.centralUrl || !config.agent.centralToken) return;
  _timer = startAdaptiveTimer(pushMs, () => pushPduNow(), { firstDelayMs: 75_000, name: 'pdu-push' });
  console.log(`[pdu-push] started (interval=${Math.round(pushMs() / 1000)}s)`);
}

export function pduPushStatus() { return { ..._last, intervalMs: pushMs() }; }
