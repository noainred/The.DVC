/**
 * v2.732(점검 2회차 B5-07): 웹 SSH 콘솔의 '재시도·인증 실패' 판정 — 순수 모듈(RemoteConsole.jsx SshConsole 이 쓴다, vitest 가 고정한다).
 *
 * 재현된 결함 둘(기준 커밋 빌드 · 가짜 WebSocket):
 *  ① '재시도' 를 누를 때마다 새 xterm 을 같은 칸에 붙였다(이전 것을 dispose 하지 않았다) — 3회 재시도에 .xterm 1→4, ResizeObserver 도 누적.
 *     늦게 닫힌 옛 소켓의 onclose·onerror 가 새 시도의 상태·타이머(stopTimer)까지 건드렸다.
 *  ② 인증 실패 뒤 자격증명 폼이 뜨지 않았다 — 게이트웨이는 '연결 실패: All configured authentication methods failed …' status 를 보낸 뒤
 *     1011 로 닫는다. onmessage 가 폼으로 돌리고 비밀번호를 비우면, 곧이어 onclose 가 '폼이 아니면 오류' 가 아니라 '라이브가 아니면 오류' 로
 *     판정해 폼을 오류 막대로 덮었고, 그 '재시도' 는 **빈 비밀번호로** 대상 서버에 로그인을 시도했다(누를 때마다 대상 계정의 실패 로그인 1회 —
 *     계정 잠금 정책이 있으면 잠금에 가까워진다. util/bulkRun.js '자동 재시도 금지' 와 같은 계열).
 *
 * 규칙: 빈 비밀번호로는 접속하지 않는다(게이트웨이는 비밀번호 인증만 하고 빈 값을 거르지 않는다 — 대상 서버에 실패 로그인이 쌓인다).
 *   인증 실패로 폼에 돌아온 뒤 닫힘 이벤트는 폼을 유지한다. 새 시도는 이전 소켓·터미널·관찰자를 먼저 정리한다.
 */

/** 게이트웨이 status 문구가 '자격증명 거부' 인가(인증 '성공' 문구는 호출부가 먼저 거른다). */
export const SSH_AUTH_FAIL_RE = /(인증\s*실패|로그인\s*실패|authentication\s+(failed|methods failed)|permission denied|auth.*fail|invalid (password|credential)|incorrect password)/i;
export const isSshAuthFailText = (t) => SSH_AUTH_FAIL_RE.test(String(t || ''));

/** 접속해도 되는 자격증명인가 — 사용자명과 비밀번호가 둘 다 있어야 한다(빈 비밀번호 로그인 금지). */
export function canConnect(creds) {
  return !!(creds && typeof creds === 'object' && String(creds.username || '').trim() && typeof creds.password === 'string' && creds.password.length > 0);
}

/** 오류 막대의 '재시도' 가 할 일 — 'connect'(같은 자격증명으로 다시) | 'form'(비밀번호가 비었다 — 다시 입력받는다). */
export function retryAction(creds) {
  return canConnect(creds) ? 'connect' : 'form';
}

/** '재시도' 가 폼으로 보낼 때 폼 위에 보일 문구. */
export const RETRY_NEEDS_PASSWORD = '비밀번호가 비어 있어 다시 입력받습니다 — 빈 비밀번호로 대상 서버에 로그인을 시도하지 않습니다(실패 로그인이 쌓이면 대상 계정이 잠길 수 있습니다).';

/** 닫힘 이벤트가 지금 단계를 바꾸지 않아야 하는가 — 인증 실패로 자격증명 폼에 돌아온 뒤의 닫힘은 폼을 유지한다. */
export function holdsPhaseOnClose(phase) {
  return phase === 'form';
}

/**
 * 이전 시도의 자원을 정리한다 — 새 시도(재시도·자격증명 재입력 뒤 접속) 직전과 언마운트에 부른다.
 *  · 옛 소켓은 **핸들러를 먼저 떼고** 닫는다 — 떼지 않으면 늦게 도착한 onclose 가 새 시도의 단계·타이머를 바꾼다.
 *  · 터미널은 dispose(xterm 은 open() 마다 새 요소를 부모에 붙인다), 관찰자는 disconnect, 칸은 비운다.
 * 어느 것이든 없거나 이미 정리됐어도 던지지 않는다.
 */
export function releaseConsole({ ws, term, ro, el } = {}) {
  if (ws) {
    for (const k of ['onopen', 'onmessage', 'onerror', 'onclose']) { try { ws[k] = null; } catch { /* 읽기 전용 구현 */ } }
    try { ws.close(); } catch { /* 이미 닫힘 */ }
  }
  try { ro?.disconnect(); } catch { /* 이미 해제 */ }
  try { term?.dispose(); } catch { /* 이미 dispose */ }
  if (el) {
    try {
      if (typeof el.replaceChildren === 'function') el.replaceChildren();
      else while (el.firstChild) el.removeChild(el.firstChild);
    } catch { /* 칸이 이미 사라졌다 */ }
  }
}
