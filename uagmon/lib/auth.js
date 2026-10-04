/**
 * 단일 비밀번호 인증(서버/웹 모드 전용) — 로컬 클라이언트 모드(127.0.0.1 바인딩)에선 꺼진다.
 *
 * - 비밀번호는 해시(sha256)로만 저장한다.
 * - 로그인 성공 시 임의 토큰을 발급하고, 이후 모든 API 는 `Authorization: Bearer` 헤더로
 *   전달한다. 쿠키를 쓰지 않으므로 교차출처 CSRF 표면이 없다(pyportal 감사 교훈).
 * - 실패 잠금은 출발지(IP)별 — 전역 카운터 하나면 아무나 몇 번 틀리는 것으로 정상
 *   관리자까지 밀어낼 수 있다(가용성 공격, pyportal 불변조건과 동일).
 */

import crypto from 'node:crypto';

const TOKEN_TTL_MS = 12 * 3600 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;
// 실패 기록 유지 시간 — 마지막 실패 뒤 이만큼 지나고 잠금도 풀렸으면 지운다(v2.689).
// 예전에는 성공해야만 지워져 IP 마다 영구 누적됐다(무인증 요청으로 Map 이 자란다).
export const FAIL_TTL_MS = 15 * 60 * 1000;
const FAILS_MAX = 10_000; // 만료 정리 뒤에도 넘치면 잠기지 않은 오래된 기록부터 버린다

export const hashPassword = (pw) => crypto.createHash('sha256').update(String(pw)).digest('hex');

export class Auth {
  /** required=false 면 모든 검사가 통과한다(로컬 클라이언트 모드). */
  constructor({ required, passwordHash, now = Date.now }) {
    this.required = Boolean(required);
    this.passwordHash = String(passwordHash || '');
    this.sessions = new Map(); // token -> issuedAt
    this.fails = new Map();    // ip -> { count, lockedUntil, lastAt }
    this.now = now;
  }

  /** 만료된 실패 기록 정리 — 잠금 중인 것은 남긴다(정리로 잠금이 풀리면 안 된다). */
  pruneFails(t = this.now()) {
    for (const [ip, f] of this.fails) {
      if (f.lockedUntil <= t && t - (f.lastAt || 0) > FAIL_TTL_MS) this.fails.delete(ip);
    }
    if (this.fails.size > FAILS_MAX) {
      for (const [ip, f] of this.fails) {
        if (this.fails.size <= FAILS_MAX) break;
        if (f.lockedUntil <= t) this.fails.delete(ip);
      }
    }
  }

  login(ip, password) {
    if (!this.required) return { ok: true, token: '' };
    const t = this.now();
    this.pruneFails(t);
    const f = this.fails.get(ip) || { count: 0, lockedUntil: 0, lastAt: 0 };
    if (f.lockedUntil > t) {
      return { ok: false, error: `실패가 반복되어 잠겼습니다. ${Math.ceil((f.lockedUntil - t) / 1000)}초 후 다시 시도하세요.` };
    }
    const given = hashPassword(password);
    const okPw = this.passwordHash.length === given.length
      && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(this.passwordHash));
    if (!okPw) {
      f.count += 1;
      f.lastAt = t;
      if (f.count >= MAX_FAILS) { f.count = 0; f.lockedUntil = t + LOCK_MS; }
      this.fails.delete(ip); // 다시 넣어 Map 순서를 '최근 실패' 뒤로(초과분 정리가 오래된 것부터)
      this.fails.set(ip, f);
      return { ok: false, error: '비밀번호가 올바르지 않습니다.' };
    }
    this.fails.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions.set(token, Date.now());
    // 만료 세션 정리(무한 누적 방지)
    for (const [t, at] of this.sessions) if (Date.now() - at > TOKEN_TTL_MS) this.sessions.delete(t);
    return { ok: true, token };
  }

  /** Authorization: Bearer <token> 헤더 검사. */
  check(headerValue) {
    if (!this.required) return true;
    const m = /^Bearer\s+([0-9a-f]{64})$/.exec(String(headerValue || ''));
    if (!m) return false;
    const at = this.sessions.get(m[1]);
    if (at == null || Date.now() - at > TOKEN_TTL_MS) { this.sessions.delete(m[1]); return false; }
    return true;
  }
}
