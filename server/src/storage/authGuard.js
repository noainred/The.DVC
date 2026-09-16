/**
 * storage/authGuard.js — 인증 실패(401) 장비의 주기 수집 정지(v2.528).
 *
 * 사용자 신고(2026-09-16): PowerStore `PS-HG-2`(엣지 HG 위임)가 `인증 실패(401)`.
 * 사용자 선택: "401 이면 수집 중단 + 화면에 표시".
 *
 * ── 왜 멈추는가 ────────────────────────────────────────────────────────────────
 * 인증 실패는 **재시도해도 결과가 같다**. 그런데 주기 수집은 기본 10분마다 같은 자격증명으로
 * 계속 로그인을 시도하므로, 잠금 정책이 있는 배열(PowerStore·Unity 등)에서는 **계정이 잠긴다** —
 * 그러면 콘솔로도 못 들어가 복구가 더 어려워진다. CLAUDE.md 의 '대량 등록 자동 재시도 금지'
 * (`util/bulkRun.js`)와 같은 이유이고, 여기는 그 규칙이 빠져 있던 자리다.
 *
 * ── 반드시 지킬 것 ─────────────────────────────────────────────────────────────
 * 1. **조용히 멈추지 않는다.** 정지 사실·시각·사유를 스냅샷(`extra.authStopped`)에 실어 화면이
 *    말한다. 말없이 멈추면 사용자는 '수집이 되는 줄' 안다 — 이 기능이 만들 수 있는 최악의 거짓이다.
 * 2. **자격증명이 바뀌면 자동으로 재개한다**(`credHash` 비교). 비밀번호를 고치는 것이 곧 조치이고,
 *    그 뒤에도 사람이 버튼을 한 번 더 눌러야 한다면 '고쳤는데 왜 안 되지' 가 된다.
 * 3. **수동 실행('지금 수집'·연결 테스트)은 막지 않는다.** 사람이 1회 누르는 것은 잠금 위험이
 *    없고, 고쳤는지 확인할 길을 없애면 안 된다. 막는 것은 **주기 수집뿐**이다.
 * 4. **401/403 만 대상**이다. 타임아웃·연결 실패·형식 오류는 재시도로 해결되는 일이 많으므로
 *    멈추지 않는다(멈추면 일시적 네트워크 장애가 수집을 영구 정지시킨다).
 *
 * ⚠ v2.535: 저장/판정 코어는 `util/authGuard.js` 로 올라갔다(Horizon 세션 수집에 같은 방어가
 *   없다는 것이 자격증명 감사에서 확인됐다 — 20줄을 복사하면 다음 도구에서 또 빠진다).
 *   이 파일은 **스토리지 고유분만** 갖는다 — 파일명과 '스냅샷 모양' 판정(`isAuthFailure(snap)`).
 *   외부 export 시그니처는 그대로이므로 `storage/poller.js` 와 기존 테스트는 바뀌지 않는다.
 */
import { createAuthGuard, credHashOf as sharedCredHashOf, isAuthFailureText } from '../util/authGuard.js';

const guard = createAuthGuard({ file: 'storage-auth-stops.json' });

/**
 * 스냅샷이 '인증 실패' 인가. 수집기들이 던지는 문구는
 * `인증 실패(401) — 계정/비밀번호 확인`(restCommon) 또는 SSH 계열의 인증 거부다.
 * ⚠ 넓게 잡지 말 것 — '연결 실패' 까지 포함하면 네트워크 장애가 수집을 영구 정지시킨다.
 */
export function isAuthFailure(snap) {
  if (!snap || snap.ok) return false;
  return isAuthFailureText(snap.error || '', ...Object.values(snap.sections || {}).map((v) => String(v || '')));
}

/** 이 장비 자격증명의 지문 해시 — 바뀌면 자동 재개의 신호다. */
export const credHashOf = sharedCredHashOf;

/** 정지 기록. 같은 자격증명으로 반복 실패해도 `since` 는 처음 시각을 유지한다. */
export const markAuthStopped = (deviceId, dev, reason) => guard.markAuthStopped(deviceId, dev, reason);
/** 성공했거나 사용자가 해제 — 기록 제거. */
export const clearAuthStop = (deviceId) => guard.clearAuthStop(deviceId);
/** 주기 수집에서 이 장비를 건너뛸 것인가. */
export const authStopFor = (dev) => guard.authStopFor(dev);

export function _resetForTest() { guard._resetForTest(); }
export function _fileForTest() { return guard._fileForTest(); }
