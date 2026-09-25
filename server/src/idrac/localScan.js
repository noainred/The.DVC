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
import { makeScanAuthPolicy } from './scanAuth.js';

/**
 * @param {object} p { ips, username, password, noRegister?, vcenterId?, datacenterId?, mode?, onProgress?, trigger?, rangeId? }
 *   trigger — v2.591(감사 F3): 'periodic' 이면 직전 인증 실패 IP·주 폴러 정지 서버를 건너뛴다(`idrac/scanAuth.js`).
 *   그 밖(없음 포함)은 수동으로 보고 전부 시도한다 — 구버전 중앙이 trigger 를 보내지 않아도 예전 동작 그대로다.
 * @returns {Promise<object>} { scanned, found, foundCount, unreachable, notIdrac, authFailed, authSkipped, ..., registered, durationMs }
 */
export async function runLocalIdracScan({ ips, username, password, ilo = null, noRegister = false, vcenterId = '', datacenterId = '', mode = 'merge', onProgress = null, trigger = 'manual', rangeId = '' } = {}) {
  const started = Date.now();
  // v2.610: ilo — HPE iLO 계정(선택). 구버전 중앙은 보내지 않는다 → 예전 동작 그대로.
  const authPolicy = makeScanAuthPolicy({ rangeId: rangeId || datacenterId || vcenterId || '', username, password, ilo, periodic: trigger === 'periodic' });
  const scan = await scanForIdracs({ ips, username, password, ilo, onProgress, authPolicy });
  let registered = 0;
  // v2.591: 인증 정지로 건너뛴 IP 가 있으면 부분 결과다 — replace 로 두면 **건너뛴 등록 서버가 삭제**된다(중앙
  //   scanPoller 와 같은 규칙). 절단(truncated)도 같은 이유로 강등한다(중앙은 이미 그렇게 한다 — 형제 비대칭).
  const partial = !!scan.truncated || (scan.authSkipped || 0) > 0;
  const effectiveMode = partial ? 'merge' : (mode || 'merge');
  // noRegister면 스캔만(중앙 UI에서 확인 후 별도 '등록'). 그 외엔 자동등록(autoRegister 켜진 경우).
  if (!noRegister && config.agent.autoRegister && scan.found.length) {
    const rr = registerScanned(scan.found, username, password, effectiveMode, vcenterId || '', datacenterId || '', { ilo });
    if (rr.ok) { registered = (rr.added || 0) + (rr.updated || 0); pollNow().catch(() => {}); }
  }
  return { ...scan, registered, modeDowngraded: partial && effectiveMode !== (mode || 'merge'), durationMs: Date.now() - started };
}
