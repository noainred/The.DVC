/**
 * 로컬 iDRAC 스캔(+옵션 현지 등록) 실행 — 위임 폴링 워커(idracScanWorker)와
 * 중앙→엣지 직접(PUSH) 엔드포인트(routes/collector.js)가 공유하는 코어.
 *
 * 엣지에서 실행되며, 대역을 Redfish 스캔해 Dell iDRAC만 골라내고, noRegister가 아니고
 * autoRegister가 켜져 있으면 현지 레지스트리에 등록(즉시 전력 수집 시작)한 뒤 요약을 반환한다.
 */

import { config } from '../config.js';
import { scanForIdracs } from './scan.js';
import { registerScanned } from './registry.js';
import { pollNow } from './poller.js';

/**
 * @param {object} p { ips, username, password, noRegister?, vcenterId?, datacenterId?, mode?, onProgress? }
 * @returns {Promise<object>} { scanned, found, foundCount, unreachable, notIdrac, authFailed, ..., registered, durationMs }
 */
export async function runLocalIdracScan({ ips, username, password, noRegister = false, vcenterId = '', datacenterId = '', mode = 'merge', onProgress = null } = {}) {
  const started = Date.now();
  const scan = await scanForIdracs({ ips, username, password, onProgress });
  let registered = 0;
  // noRegister면 스캔만(중앙 UI에서 확인 후 별도 '등록'). 그 외엔 자동등록(autoRegister 켜진 경우).
  if (!noRegister && config.agent.autoRegister && scan.found.length) {
    const rr = registerScanned(scan.found, username, password, mode || 'merge', vcenterId || '', datacenterId || '');
    if (rr.ok) { registered = (rr.added || 0) + (rr.updated || 0); pollNow().catch(() => {}); }
  }
  return { ...scan, registered, durationMs: Date.now() - started };
}
