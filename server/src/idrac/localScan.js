/**
 * 로컬 iDRAC 스캔(+옵션 현지 등록) 실행 — 위임 폴링 워커(idracScanWorker)와
 * 중앙→엣지 직접(PUSH) 엔드포인트(routes/collector.js)가 공유하는 코어.
 *
 * 엣지에서 실행되며, 대역을 Redfish 스캔해 Dell iDRAC만 골라내고, noRegister가 아니고
 * autoRegister가 켜져 있으면 현지 레지스트리에 등록(즉시 전력 수집 시작)한 뒤 요약을 반환한다.
 */

import { config } from '../config.js';
import { scanForIdracs, scanPartialReasons } from './scan.js';
import { registerScanned, hasHpeInScanReplaceScope } from './registry.js';
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
  let removed = 0, removedIps = []; // v2.770(점검 R5-E4-01): 교체로 지운 현지 등록(감사 로그는 registerScanned 가 남긴다)
  let registerError = null; // v2.744(감사 EDGE-03): 등록부를 읽지 못해 자동 등록을 거절했으면 그 사유(회신·상태가 말한다 — 조용한 0대 금지)
  // v2.591: 인증 정지로 건너뛴 IP 가 있으면 부분 결과다 — replace 로 두면 **건너뛴 등록 서버가 삭제**된다(중앙
  //   scanPoller 와 같은 규칙). 절단(truncated)도 같은 이유로 강등한다(중앙은 이미 그렇게 한다 — 형제 비대칭).
  // v2.611(감사 RECENT2611-01): 사유 판정은 scan.js scanPartialReasons 하나(중앙 scanPoller 와 같은 규칙) — noCreds·인증 실패·
  //   (iLO 없이) 등록된 HPE 도 부분 결과다. 지금 중앙 주기 위임은 merge 만 보내지만 수동 PUSH(routes/collector.js)는 mode 를 받는다.
  // v2.743(감사 LEFT-01): 'HPE 가 있다' 는 **이 스캔의 교체 범위 안**만 본다 — 아래 registerScanned 가 교체에 넘기는 것과 같은
  //   엔트리 id(rangeId)·대역(ips)이다(중앙 scanPoller 와 같은 헬퍼). 법인 전체를 보면 범위 밖 HPE 하나로 매번 merge 로 떨어진다.
  const reqMode = mode || 'merge';
  const partialReasons = reqMode === 'merge' ? [] : scanPartialReasons(scan, { registeredHpe: hasHpeInScanReplaceScope({ datacenterId, scanRangeId: rangeId, ranges: ips }) });
  const partial = partialReasons.length > 0;
  const effectiveMode = partial ? 'merge' : reqMode;
  // noRegister면 스캔만(중앙 UI에서 확인 후 별도 '등록'). 그 외엔 자동등록(autoRegister 켜진 경우).
  if (!noRegister && config.agent.autoRegister && scan.found.length) {
    // v2.742(감사 DEV-01): 엔트리 id(rangeId)·스캔한 대역(ips)을 넘긴다 — 교체는 그 엔트리 등록만 지운다(중앙 scanPoller 와 같은 규칙).
    // v2.744(감사 EDGE-03): 자동 경로(auto) — 이 노드의 iDRAC 등록부를 읽지 못했으면 저장하지 않는다(registry.js 주석).
    const rr = registerScanned(scan.found, username, password, effectiveMode, vcenterId || '', datacenterId || '', { ilo, scanRangeId: rangeId, scanRanges: ips, auto: true });
    if (rr.ok) { registered = (rr.added || 0) + (rr.updated || 0); removed = rr.removed || 0; removedIps = Array.isArray(rr.removedIds) ? rr.removedIds : []; pollNow().catch(() => {}); }
    else if (rr.code === 'registry-unreadable') { registerError = rr.reason; console.warn(`[idrac-scan] 발견한 iDRAC ${scan.found.length}대를 현지 등록하지 않았습니다 — ${rr.reason}`); }
  }
  return { ...scan, registered, ...(removed ? { removed, removedIps } : {}), ...(registerError ? { registerError } : {}), modeDowngraded: partial && effectiveMode !== reqMode, ...(partial ? { modeDowngradedReason: partialReasons.join(' · ') } : {}), durationMs: Date.now() - started };
}
