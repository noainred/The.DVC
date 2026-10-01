/**
 * logs/loginFailPattern.js — '로그인 실패 이벤트' 판정의 단일 소스(v2.673, 순수).
 *
 * 분류는 정규식(TYPE_RE · MSG_RE)이 한다. SQL 조건(LOGIN_FAIL_SQL)은 그 정규식과 **같은 뜻의 상위집합**이라
 * DB 에서 후보를 좁히는 데만 쓰고, 최종 판정은 언제나 정규식으로 다시 한다(isLoginFailRow).
 *
 * 왜 따로 두나(2026-10-01 운영 장애): 예전 분석은 'login'·'auth'·'fail'·'로그인' 네 단어로 이벤트 7일치를 **네 번**
 * LIKE 검색했다(검색어마다 5,000행 상한). 드문 단어는 7일치 전체를 훑어 운영에서 이벤트 루프를 14초 넘게 멈췄고,
 * 흔한 'login'(UserLoginSessionEvent 형식)은 상한 5,000행을 정상 로그인으로 채워 **실제 실패를 덜 셌다**
 * (재현: 실패 1,000건 중 30건). 한 번의 좁은 조건으로 바꾸면 훑기는 1회, 상한은 '실패 후보' 에만 걸린다.
 *
 * ⚠ 정규식에 갈래를 더하면 LOGIN_FAIL_SQL 에도 같은 뜻의 LIKE 를 더할 것 — test/loginFails2673.test.js 가
 *   갈래마다 표본 문장으로 'SQL 이 놓치는 실패' 가 0 인지 실제 SQLite 로 확인한다.
 */

export const TYPE_RE = /BadUsername|InvalidLogin|NoAccess|AccountLock|LoginFailure|AuthenticationFailed|NoPermission/i;
export const MSG_RE = /cannot login|failed to (log\s?in|authenticate)|login failure|authentication failed|invalid (login|credential|user)|bad username|account.*lock|로그인.*실패|인증.*실패/i;

/** 정규식 판정(최종). */
export const isLoginFailRow = (e) => TYPE_RE.test(e?.type || '') || MSG_RE.test(e?.message || '');

/*
 * SQL 후보 조건 — 위 정규식의 갈래를 LIKE 로 옮긴 것(SQLite LIKE 는 ASCII 대소문자를 구분하지 않는다 — 정규식의 /i 와 같다).
 * 'failed to log' 는 'log in'·'login' 을 둘 다 받는 상위집합이고, 'account.*lock' 은 '%account%lock%' 이다.
 */
const TYPE_LIKES = ['BadUsername', 'InvalidLogin', 'NoAccess', 'AccountLock', 'LoginFailure', 'AuthenticationFailed', 'NoPermission'];
const MSG_LIKES = ['cannot login', 'failed to log', 'failed to authenticate', 'login failure', 'authentication failed',
  'invalid login', 'invalid credential', 'invalid user', 'bad username', 'account%lock', '로그인%실패', '인증%실패'];
export const LOGIN_FAIL_SQL = `(${[
  ...TYPE_LIKES.map((t) => `type LIKE '%${t}%'`),
  ...MSG_LIKES.map((m) => `message LIKE '%${m}%'`),
].join(' OR ')})`;
