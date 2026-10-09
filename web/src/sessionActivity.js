/**
 * 서버측 세션 정리(2026-10-09 검토 S-05) — 로그아웃을 서버에 알리고, 서버측 유휴 만료의 기준인 '사용자 활동' 을 보낸다.
 *
 * 왜: 예전 로그아웃은 브라우저가 토큰을 지우는 것뿐이라 복사해 둔 토큰은 만료까지 계속 통과했다. 서버가 이제 로그아웃한 세션을
 *   폐기하고, 유휴 시간도 서버가 강제한다. 서버는 자동 폴링을 활동으로 세지 않으므로 화면이 키보드·마우스 활동을 따로 알린다.
 *
 * 규칙
 *  · 활동 신호는 웹 유휴 타이머와 **같은 사건**에서, 최대 1분에 한 번(서버의 유휴 여유 120초보다 짧게 — 서버가 웹보다 먼저 끊지 않게).
 *  · 로그아웃 신호는 실패해도 화면 로그아웃을 막지 않는다(기다리지 않는다 — keepalive 로 보낸다).
 *  · api.js 의 공용 헬퍼를 쓰지 않는다 — 그 헬퍼는 401 에서 전역 로그아웃 처리기를 부르고 진행 표시에 요청을 올린다. 이 신호는 조용해야 한다.
 */

export const ACTIVITY_MIN_INTERVAL_MS = 60_000;
/** App 의 유휴 타이머가 듣는 사건과 같다(바꾸면 둘 다). */
export const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click', 'visibilitychange'];

/**
 * 활동 신호 스로틀 — 마지막 전송 뒤 minIntervalMs 가 지나야 다시 보낸다. 전송 중에는 겹쳐 보내지 않는다.
 * @param {{ send: () => any, now?: () => number, minIntervalMs?: number }} opts
 */
export function createActivityPinger({ send, now = () => Date.now(), minIntervalMs = ACTIVITY_MIN_INTERVAL_MS } = {}) {
  let last = -Infinity;
  let inflight = false;
  return {
    /** 보냈으면 true. force 면 간격을 무시한다(화면을 연 직후). */
    ping(force = false) {
      const t = now();
      if (inflight) return false;
      if (!force && t - last < minIntervalMs) return false;
      last = t;
      inflight = true;
      Promise.resolve()
        .then(() => send())
        .catch(() => { /* 다음 활동에서 다시 보낸다 */ })
        .finally(() => { inflight = false; });
      return true;
    },
  };
}

function post(path, token, fetchImpl) {
  if (!token) return Promise.resolve(null);
  try {
    return Promise.resolve(fetchImpl(path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
      keepalive: true,
    })).then((r) => r?.status ?? null).catch(() => null);
  } catch { return Promise.resolve(null); }
}

/** 사용자 활동을 서버에 알린다. 응답 상태(숫자) 또는 null. */
export function sendActivity(token, fetchImpl = globalThis.fetch) {
  return post('/api/auth/activity', token, fetchImpl);
}

/** 이 세션을 서버에서 폐기한다(복사해 둔 토큰도 함께 무효). 실패해도 던지지 않는다. */
export function serverLogout(token, fetchImpl = globalThis.fetch) {
  return post('/api/auth/logout', token, fetchImpl);
}
