/**
 * sshaccess/loginMark.js — ‘로그인은 됐다’ 표시(점검 1회차 R2 · T4 · 2회차 상태 Q1(b)).
 *
 * 계정 탐침(accountGate)은 로그인 뒤에 실패한 결과(df 마운트 못 찾음 · 형식 못 읽음 · 명령 시한 등)를 ‘성공’ 으로 봐야 한다 —
 * 비밀번호는 받아들여졌다. 예전에는 ‘모름’ 으로 봐 같은 계정 서버를 하나씩 직렬로 풀었다.
 * 결과 객체의 모양을 바꾸지 않으려고(폴러 결과는 화면 · 엣지 · 시험이 모양을 본다) WeakSet 에 표시한다. 무의존 leaf.
 */
const LOGGED = new WeakSet();

/** 로그인 뒤에 만든 결과에 표시한다(그대로 돌려준다). */
export function markLoggedIn(o) {
  if (o && typeof o === 'object') LOGGED.add(o);
  return o;
}

/** 로그인은 됐던 결과인가(`loggedIn: true` 칸 — 코어 readServer · 또는 markLoggedIn 표시). */
export function wasLoggedIn(o) {
  return !!o && typeof o === 'object' && (o.loggedIn === true || LOGGED.has(o));
}

/*
 * 2회차 보안 B1: 비밀번호를 **보낸 뒤** 판정을 받지 못한 결과(로그인 시한 · 끊김) — 서버 쪽에서는 거부로 셌을 수 있다(AD 잠금 횟수).
 * 계정 탐침은 이것을 ‘연결 실패(비밀번호 안 감)’ 와 가른다: 남은 서버에 이어서 보내지 않고, 연달으면 계정을 멈춘다(accountGate).
 */
const SENT = new WeakSet();
/** 비밀번호를 보낸 결과에 표시한다(그대로 돌려준다). */
export function markPasswordSent(o) {
  if (o && typeof o === 'object') SENT.add(o);
  return o;
}
/** 비밀번호를 보냈던 결과인가(`passwordSent: true` 칸 또는 markPasswordSent 표시). */
export function wasPasswordSent(o) {
  return !!o && typeof o === 'object' && (o.passwordSent === true || SENT.has(o));
}
