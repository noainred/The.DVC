/**
 * 성능 모달의 조회 실패 판정(순수 — vitest 고정, v2.591 감사 F6).
 *
 * 서버(`routes/api/vmMetrics.js`)는 그 vCenter 가 **인증 실패로 멈춰 있으면** 로그인하지 않고
 * 409 + `authStopped` 로 답한다. 화면은 그 응답을 받으면 **20초 자동 갱신을 멈추고** 사유를 말한다 —
 * 멈추지 않으면 모달을 연 채 두는 동안 같은 계정으로 분당 3회 로그인해 **계정이 잠긴다**.
 * 사람이 누르는 '다시 조회' 는 막지 않는다(`manual=1` — 고친 뒤 확인할 길).
 *
 * ⚠ 문구는 BoldText 로 그린다(강조는 별표 두 개). 백틱 금지.
 *
 * v2.744(감사 후속 FA-③): 서버는 그보다 먼저 **직접 수집 대상인지**(비활성·점검중·엣지 위임) 보고, 아니면 manual 이어도
 *   409 + `skipReason` 으로 답한다(authStopGate.js respondIfVcAuthStopped). 예전에는 그 본문을 몰라 '조회 실패: …' 로 그리고
 *   20초마다 같은 409 를 다시 받았다. 이제 `skip` 으로 따로 돌려주고 자동 갱신을 멈춘다(문구는 vcAuthStopText 한 벌).
 */
import { skipSingleText } from '../views/vcAuthStopText.js';

/**
 * @param {unknown} err fetchJson 이 던진 오류(HttpError 면 `status`·`body` 가 있다)
 * @returns {{authStopped: null | {attempts:number|null, since:number|null, reason:string}, skip: null | {skipReason:string, reason:string}, message: string}}
 */
export function metricErrorState(err) {
  const body = err && typeof err === 'object' ? err.body : null;
  if (body && typeof body === 'object' && body.authStopped === true) {
    // ⚠ `Number(null) === 0` — 모르면 횟수를 말하지 않는다(v2.525 규약).
    const a = body.attempts;
    const attempts = a == null || a === '' || !Number.isFinite(Number(a)) ? null : Number(a);
    const since = body.since == null || body.since === '' || !Number.isFinite(Number(body.since)) ? null : Number(body.since);
    return { authStopped: { attempts, since, reason: String(body.reason || '') }, skip: null, message: String(body.reason || err.message || '') };
  }
  if (body && typeof body === 'object' && typeof body.skipReason === 'string' && body.skipReason) {
    return { authStopped: null, skip: { skipReason: body.skipReason, reason: String(body.reason || '') }, message: String(body.reason || err.message || '') };
  }
  return { authStopped: null, skip: null, message: String(err?.message || err || '') };
}

/** 이 오류면 20초 자동 갱신을 멈춘다 — 다시 물어도 같은 답이다(인증 정지 · 직접 수집 대상 아님). */
export const stopsAutoRefresh = (st) => !!(st && (st.authStopped || st.skip));

/** v2.744(감사 후속 FA-③): 직접 수집 대상이 아니라 조회하지 않은 vCenter 안내(자동 갱신을 멈췄다는 사실 포함). 없으면 빈 문자열. */
export function metricSkipText(skip) {
  const t = skipSingleText(skip);
  return t ? `${t} 자동 갱신도 멈췄습니다 — 다시 물어도 같은 답이라 로그인하지 않습니다.` : '';
}

/** 인증 실패 정지 안내(자동 갱신을 멈췄다는 사실 + 조치). */
export function metricAuthStopText(stop) {
  if (!stop) return '';
  return `**인증 실패로 멈춘 vCenter 라 자동 갱신을 멈췄습니다**${stop.attempts != null ? `(실패 ${stop.attempts}회)` : ''}.`
    + ' 같은 계정으로 반복 로그인하면 **계정이 잠깁니다**. 비밀번호를 고치거나 설정 › vCenter 연결 테스트가 성공하면 다시 조회합니다.'
    + ' 아래 ‘다시 조회’ 는 1회만 시도합니다.';
}
