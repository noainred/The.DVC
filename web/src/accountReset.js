/**
 * accountReset.js — 로그아웃 · 계정 전환 때 '이전 계정이 이 창에 남긴 것' 을 비운다(전체 점검 129회차 A2 · A4).
 *
 * 왜: 로그아웃은 Portal 을 언마운트하지만 **모듈 변수는 페이지를 새로 읽기 전까지 남는다**. 원격 콘솔 세션 저장소
 *   (remote/sessions.js)는 접속에 쓴 대상 서버 계정 · 비밀번호(Dup 용 creds · 자동 접속용 initialCreds)를 들고 있어,
 *   같은 창에서 다른 계정으로 로그인하면 이전 사람의 콘솔 탭이 그대로 뜨고(자동 접속 탭은 그 비밀번호로 곧바로 붙는다)
 *   탭 메뉴의 Dup 으로 그 비밀번호를 다시 쓸 수 있었다 — 유휴 자동 로그아웃 뒤 다른 사람이 로그인하는 공용 단말이 그 경로다.
 *
 * 규칙
 *  · 판정 열쇠는 계정 이름 하나(accountKeyOf). 부팅 중('loading')에는 부르지 않는다(로그아웃 = null 과 다르다).
 *  · 처음 한 번(이 창이 처음 계정을 안 때)은 비울 것이 없다. 그 뒤 열쇠가 바뀌면(로그아웃 = null 포함) 비운다.
 *  · 비우는 것은 여기 한 곳에 모은다 — 새 모듈 변수에 계정의 비밀 · 자료를 두면 여기에 넣는다.
 */
import { closeAllSessions } from './remote/sessions.js';
import { clearToolSummaryCells } from './views/vms/insight-tools/useToolSummary.js';   // v3.21.0 VM 분석 — 도구 요약 칸(이전 계정의 범위 · 권한으로 받은 값)

/** 계정 열쇠 — 로그인 계정 이름(인증을 끈 포탈은 표시 이름 'Anonymous'). 로그아웃이면 null. */
export function accountKeyOf(user) {
  if (!user || typeof user !== 'object') return null;
  const k = String(user.username || user.name || '').trim();
  return k || null;
}

let _last;   // undefined = 아직 모름(이 창의 첫 판정 전)

/**
 * 지금 계정을 알린다. 이전에 알린 계정과 다르면 이전 계정의 창 상태를 비운다.
 * @param {string|null} key accountKeyOf(user)
 * @returns {boolean} 비웠으면 true
 */
export function noteAccount(key) {
  const k = key == null ? null : String(key);
  const prev = _last;
  _last = k;
  if (prev === undefined || prev === k) return false;
  closeAllSessions();
  clearToolSummaryCells();
  return true;
}

/**
 * 다른 탭이 토큰을 바꿨을 때(로그인 · 연장) 이 탭이 할 일 — 순수(A4).
 *   이 탭은 저장소의 토큰을 그때그때 읽으므로(getToken) 다른 탭이 **다른 계정으로** 로그인하면 요청은 새 계정으로 나가는데
 *   화면(이름 · 역할 · 메뉴 · 버튼 게이팅)은 이전 계정 그대로였다. 새 토큰의 주인(/auth/me)이 지금 화면의 계정과 다르면 화면을 바꾼다.
 * @param {object|null} current 지금 화면의 사용자
 * @param {object|null} me      새 토큰으로 읽은 /auth/me (못 읽었으면 null)
 * @returns {'keep'|'switch'} 못 읽었거나 같은 계정이면 'keep'(단정하지 않는다 — 무효 토큰이면 다음 요청의 401 이 로그아웃시킨다)
 */
export function tokenChangeAction(current, me) {
  const cur = accountKeyOf(current);
  const next = accountKeyOf(me);
  if (!cur || !next) return 'keep';
  return cur === next ? 'keep' : 'switch';
}

/** 테스트 전용. */
export function _resetAccountForTest() { _last = undefined; }
