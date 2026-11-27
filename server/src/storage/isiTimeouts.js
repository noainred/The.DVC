/**
 * storage/isiTimeouts.js — PowerScale(Isilon) SSH 수집의 시한 산수(순수 · v3.39.0).
 *
 * 왜(사용자 보고 — "ssh 로 isi 명령어 실행하는데 처리에 오래 걸려서 timeout 이 발생하고 있어 · 설정에 timeout 메뉴 ·
 * 최대 5분 · 기본 3분"): 예전에는 isi 명령 하나를 SSH exec 기본 시한(60초)만 기다렸고, 그 값은 엣지 portal.env 상수라
 * 화면에서 바꿀 수 없었다. 응답이 느린 클러스터는 `isi status`(필수)가 60초를 넘겨 장비가 통째로 '실패' 였다.
 *
 * ⚠ 명령 대기 시간만 올리면 안 된다 — 시한 세 개가 묶여 있다(v2.528 Unity · v2.741 DEV-02 와 같은 산수):
 *     명령 대기  <  세션 예산  <  장비 시한(`storage/poller.js withDeadline`)
 *   장비 시한이 먼저 닿으면 `withDeadline` 이 세션을 끊고 **이미 받은 `isi status`(용량·노드)까지 버린다**. 그래서 설정값은
 *   명령 대기 하나이고, 나머지 둘은 여기서 **그 값에서 계산**한다(사람이 세 값을 맞추게 두지 않는다).
 *
 *   장비 시한 = max(기존 장비 시한(STORAGE_DEVICE_TIMEOUT_MS), 명령 대기 + ISI_SESSION_EXTRA_MS)
 *   세션 예산 = 장비 시한 − ISI_DEADLINE_MARGIN_MS  (STORAGE_CLI_SESSION_BUDGET_MS 를 명시했으면 그 값이 상한)
 *
 *   ISI_SESSION_EXTRA_MS = 접속 몫 + 부가 명령 최소 몫 + 여유. 필수 경로의 최악(접속 + isi status 가 설정값을 다 씀)이
 *   세션 예산 안에 들어오고, 그때도 부가 명령이 시작할 최소 시간이 남는다(테스트가 이 산수를 고정한다).
 *   접속 몫은 `proxy/sshExec.js SSH_READY_TIMEOUT_MS` 기본값(60초)과 같은 값이다 — 그 env 를 더 길게 잡은 현장은 접속이
 *   그만큼 걸릴 때 부가 명령 몫이 먼저 줄어든다(필수 `isi status` 는 예산을 무시하므로 장비 시한까지는 기다린다).
 *
 * 이 파일은 아무것도 import 하지 않는다 — `storage/intervals.js`(설정 사양) · `collectors/isilonSsh.js`(명령 · 예산) ·
 * `poller.js`(장비 시한) · `collectRequests.js`(중앙의 결과 대기)가 같은 산수를 쓴다.
 */

/** 명령 대기 시간 — 기본 3분 · 하한 1분 · 상한 5분(사용자 지정). */
export const ISI_CMD_TIMEOUT_DEF_MS = 180_000;
export const ISI_CMD_TIMEOUT_MIN_MS = 60_000;
export const ISI_CMD_TIMEOUT_MAX_MS = 300_000;
/** 설정 화면 선택지 — 화면이 숫자를 따로 갖지 않게 사양에 실어 보낸다. */
export const ISI_CMD_TIMEOUT_PRESETS = [60_000, 120_000, 180_000, 240_000, 300_000];

export const ISI_CONNECT_ALLOWANCE_MS = 60_000;
export const ISI_AUX_FLOOR_MS = 40_000;
export const ISI_DEADLINE_MARGIN_MS = 20_000;
export const ISI_SESSION_EXTRA_MS = ISI_CONNECT_ALLOWANCE_MS + ISI_AUX_FLOOR_MS + ISI_DEADLINE_MARGIN_MS;

/** 숫자가 아니거나 0 이하면 기본값, 그 밖은 [하한, 상한] 에 가둔다('못 읽은 값' 을 하한으로 승격하지 않는다). */
export function clampIsiCmdTimeoutMs(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  if (!Number.isFinite(n) || n <= 0) return ISI_CMD_TIMEOUT_DEF_MS;
  return Math.min(ISI_CMD_TIMEOUT_MAX_MS, Math.max(ISI_CMD_TIMEOUT_MIN_MS, Math.round(n)));
}

/**
 * Isilon SSH 장비 한 대의 수집 시한. `baseDeviceMs` 는 기존 장비 시한(env · 기본 180초) — 그보다 줄이지 않는다.
 * @param {number} cmdMs 명령 대기 시간(설정값)
 * @param {number} baseDeviceMs 기존 장비 시한
 */
export function isiDeviceTimeoutFor(cmdMs, baseDeviceMs) {
  const base = Number.isFinite(Number(baseDeviceMs)) && Number(baseDeviceMs) > 0 ? Number(baseDeviceMs) : 0;
  return Math.max(base, clampIsiCmdTimeoutMs(cmdMs) + ISI_SESSION_EXTRA_MS);
}

/**
 * 부가 명령이 쓸 세션 예산 — 장비 시한보다 **반드시 작다**.
 * @param {number} cmdMs
 * @param {number} baseDeviceMs
 * @param {{capMs?:number|null, minSliceMs?:number}} [o] capMs — 현장이 명시한 예산 상한(없으면 null) · minSliceMs — 명령 최소 조각
 */
export function isiSessionBudgetFor(cmdMs, baseDeviceMs, { capMs = null, minSliceMs = 5_000 } = {}) {
  const room = isiDeviceTimeoutFor(cmdMs, baseDeviceMs) - ISI_DEADLINE_MARGIN_MS;
  const cap = Number.isFinite(Number(capMs)) && Number(capMs) > 0 ? Number(capMs) : Infinity;
  return Math.max(minSliceMs * 2, Math.min(cap, room));
}
