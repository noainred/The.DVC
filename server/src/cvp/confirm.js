/**
 * cvp/confirm.js — CVP 장비 한 대의 값을 '지금 값' 으로 쓸 수 있는가(v2.740 감사 F-03 — routes/api/cvp.js 에서 올렸다).
 *
 * 같은 장비의 같은 숫자는 같은 기준으로 센다(루트 CLAUDE.md v2.632 '같은 숫자는 같은 기준'). 이 판정을 쓰는 곳:
 *   · CVP 장비 KPI(cvpTotals) · CVP 소비전력·GBIC 광신호 탭(routes/api/cvp.js)
 *   · Overview·특수 기능 '전체 소비 전력' 의 네트워크 합(power/total.js) — v2.739 까지는 PSU 값이 6시간 안이면 더해,
 *     부품 조회가 2~6시간 멈춘 스위치를 한 화면은 합산·CVP 전력 탭은 제외했다(같은 장비 전력이 두 화면에서 다른 숫자).
 * 판정 본체는 Overview 의 deviceHealth(cvp/overview.js) + 부품 신선도 partsFresh(cvp/faults.js) 하나다 — 복제 금지.
 *
 * 사유 코드는 never · stale · not-streaming · telemetry-failed(장비 확인 불가) · parts-stale(부품 목록만 낡음)이고,
 * 화면 문구 표(웹 cvpPowerText.js CVP_STALE_REASON_TEXT)와의 1:1 은 routes/api/cvp.js CVP_STALE_REASONS 가 계약이다
 * (웹 테스트가 그 소스를 읽어 대조한다 — 목록을 옮기면 그 테스트도 옮길 것).
 */
import { deviceHealth, freshnessBounds } from './overview.js';
import { partsFresh } from './faults.js';
import { loadSettings } from './settings.js';

/**
 * v2.720(감사 B1-02): 장비 한 대를 KPI 에 '지금 값' 으로 셀 수 있는가 — 판정은 Overview 의 `deviceHealth` 하나를 쓴다(복제 금지).
 *   마지막 수집이 낡았거나(stale·never) 스트리밍이 아니거나 텔레메트리를 못 읽은 장비는 `unconfirmed`(사유)이고, 그 장비에 남은
 *   부품·BGP·포트·CPU 값(며칠 전 장애·과부하일 수 있다)은 합산하지 않는다. 'unread'(아무것도 못 읽음)는 지금 수집은 된 것이라
 *   예전처럼 항목별 '못 읽음' 칸이 센다. 부품 목록만 낡은 장비는 `partsStale` — 부품만 빼고 나머지는 센다(Overview 와 같다).
 */
export function cvpDeviceConfirm(d, { now = Date.now(), intervalMs, partsEveryMs } = {}) {
  const dev = d && typeof d === 'object' ? d : {};
  const h = deviceHealth(dev, { now, staleMs: freshnessBounds(intervalMs).staleMs, intervalMs, partsEveryMs });
  const unconfirmed = h.state === 'unknown' && h.reasons[0] !== 'unread' ? h.reasons[0] : null;
  const partsStale = !unconfirmed && Array.isArray(dev.partsList) && !partsFresh(dev, { intervalMs, partsEveryMs, now });
  return { unconfirmed, partsStale };
}

/**
 * v2.732(감사 B2-03): 부품(PSU·트랜시버) 값을 '지금 값' 으로 쓸 수 없는 이유 — 없으면 null. 판정은 cvpDeviceConfirm 하나를 쓴다
 *   (장비 KPI·Overview·장애 판정과 같은 신선도 — partsFresh). 장비 수집 자체가 낡았거나 스트리밍이 아니거나 텔레메트리를 못 읽었으면
 *   그 사유(never·stale·not-streaming·telemetry-failed), 장비는 지금 값인데 부품 목록만 낡았으면 'parts-stale'.
 *   소비전력·GBIC 광신호 화면은 이 장비를 합계·판정 KPI 에서 빼고 사유별 개수로 밝힌다(행은 남기고 표지).
 */
export function cvpPartsStaleReason(d, opts = {}) {
  const c = cvpDeviceConfirm(d, opts);
  return c.unconfirmed || (c.partsStale ? 'parts-stale' : null);
}

/**
 * CVP 화면들이 판정에 쓰는 경계 입력 — 수집 주기는 CVP 설정(loadSettings().intervalMs, 캐시)이고 부품 주기는 faults 의 기본(env)이다.
 * routes/api/cvp.js 의 confOpts 와 같은 값이다(그쪽은 `{ now, intervalMs: loadSettings().intervalMs }` 를 직접 만든다).
 */
export function cvpConfirmOpts({ now = Date.now() } = {}) {
  return { now, intervalMs: loadSettings().intervalMs };
}
