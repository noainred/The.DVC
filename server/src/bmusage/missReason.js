/**
 * bmusage/missReason.js — 수집 결과(OS · iDRAC) → **못 읽은 사유 code**(순수 · 코어 하나).
 *   5단계 집중 모니터링(분 결측 사유)과 6단계 수집 건강(주기 실패 사유)이 같은 함수를 쓴다(두 벌 금지 — focus/run.js 에서 옮겼다).
 *   code 는 FOCUS_MISS 와 같은 열거(웹 문구 표 1:1) — 경로가 없으면 'no-path'(결측이 아니다 · 호출부가 그렇게 다룬다) · 읽었으면 ''.
 */
import { isAuthFailureText, isPeerRejectText } from '../util/authGuard.js';

/** OS 결과 → 사유(없으면 ''). authStopped(주기 수집이 인증 정지로 시도하지 않음)는 'auth-stopped'. */
export function osMissOf(os) {
  if (!os) return 'no-path';
  if (os.ok) return '';
  if (os.authStopped) return 'auth-stopped';
  const e = String(os.error || '');
  if (os.busy) return 'pool-busy';
  if (isPeerRejectText(e)) return 'host-key';
  if (isAuthFailureText(e)) return 'auth';
  if (/시한 초과|timeout|타임아웃/i.test(e)) return 'timeout';
  if (/어느 형식으로도|Linux/i.test(e)) return 'not-linux';
  return 'ssh-error';
}
/** iDRAC 텔레메트리 결과 → 사유(없으면 ''). */
export function idracMissOf(idr) {
  if (!idr) return 'no-path';
  if (idr.ok) return '';
  if (idr.busy) return 'pool-busy';
  if (idr.kind === 'auth') return 'auth';
  if (idr.kind === 'auth-stopped') return 'auth-stopped';
  if (idr.kind === 'timeout') return 'timeout';
  if (idr.kind === 'no-telemetry' || idr.kind === 'empty-report') return 'no-telemetry';
  return 'unreachable';
}
