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

export const hashPassword = (pw) => crypto.createHash('sha256').update(String(pw)).digest('hex');

export class Auth {
  /** required=false 면 모든 검사가 통과한다(로컬 클라이언트 모드). */
  constructor({ required, passwordHash }) {
    this.required = Boolean(required);
    this.passwordHash = String(passwordHash || '');
    this.sessions = new Map(); // token -> issuedAt
    this.fails = new Map();    // ip -> { count, lockedUntil }
  }

  login(ip, password) {
    if (!this.required) return { ok: true, token: '' };
    const f = this.fails.get(ip) || { count: 0, lockedUntil: 0 };
    if (f.lockedUntil > Date.now()) {
      return { ok: false, error: `실패가 반복되어 잠겼습니다. ${Math.ceil((f.lockedUntil - Date.now()) / 1000)}초 후 다시 시도하세요.` };
    }
    const given = hashPassword(password);
    const okPw = this.passwordHash.length === given.length
      && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(this.passwordHash));
    if (!okPw) {
      f.count += 1;
      if (f.count >= MAX_FAILS) { f.count = 0; f.lockedUntil = Date.now() + LOCK_MS; }
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
