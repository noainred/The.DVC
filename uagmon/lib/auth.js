/**
 * 단일 비밀번호 인증(서버/웹 모드 전용) — 로컬 클라이언트 모드(127.0.0.1 바인딩)에선 꺼진다.
 *
 * - 비밀번호는 scrypt(랜덤 salt) 해시로만 저장한다 — `scrypt$N$r$p$<salt hex>$<hash hex>`(v2.740 감사 F-11).
 *   예전 형식(무염 sha256 hex 64자)은 설정 파일이 새면 사전·레인보우 표로 곧바로 풀렸다. 옛 형식도 로그인에는 받고,
 *   성공하면 새 형식으로 다시 저장한다(onRehash — 업그레이드만으로 잠기지 않게). 검증은 비동기 scrypt(이벤트 루프를 막지 않는다).
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

// scrypt 매개변수 — N=2^14·r=8·p=1 은 메모리 16MB(Node 기본 maxmem 32MB 이내)·수십 ms. 저장값의 매개변수로 검증하므로 나중에 올려도
//   옛 저장값은 그대로 통한다. 손상·변조된 저장값이 과도한 매개변수로 메모리·CPU 를 쓰게 하지 않도록 범위를 묶는다.
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 32, saltBytes: 16 });
const N_MAX = 2 ** 20; const R_MAX = 16; const P_MAX = 4;
const LEGACY_RE = /^[0-9a-f]{64}$/;
const SCRYPT_RE = /^scrypt\$(\d{1,8})\$(\d{1,2})\$(\d{1,2})\$([0-9a-f]{32})\$([0-9a-f]{64})$/;
const maxmemOf = (N, r, p) => 128 * N * r * p + 1024 * 1024;

/** 옛 저장 형식(무염 sha256 소문자 hex 64자)인가. */
export const isLegacyHash = (h) => typeof h === 'string' && LEGACY_RE.test(h);

/** 새 저장값 — 동기(CLI --set-password·환경변수 비밀번호의 기동 1회용). 로그인 경로는 hashPasswordAsync. */
export function hashPassword(pw) {
  const salt = crypto.randomBytes(SCRYPT.saltBytes);
  const hash = crypto.scryptSync(String(pw), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: maxmemOf(SCRYPT.N, SCRYPT.r, SCRYPT.p) });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function scryptAsync(pw, salt, keylen, opts) {
  return new Promise((resolve, reject) => crypto.scrypt(pw, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

/** 새 저장값(비동기 — 로그인 성공 뒤 옛 형식을 바꿀 때). */
export async function hashPasswordAsync(pw) {
  const salt = crypto.randomBytes(SCRYPT.saltBytes);
  const hash = await scryptAsync(String(pw), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: maxmemOf(SCRYPT.N, SCRYPT.r, SCRYPT.p) });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/**
 * 저장값과 비밀번호 대조 → { ok, rehash }. rehash = 옛 형식이라 새 형식으로 다시 저장해야 한다.
 * 모르는 형식·손상값·범위를 벗어난 매개변수는 ok:false(만능키가 되지 않게 — 포탈 auth.js verifyPassword L-7 과 같은 규칙).
 */
export async function verifyPassword(stored, pw) {
  const given = String(pw ?? '');
  if (isLegacyHash(stored)) {
    const g = crypto.createHash('sha256').update(given).digest('hex');
    return { ok: crypto.timingSafeEqual(Buffer.from(g), Buffer.from(stored)), rehash: true };
  }
  const m = typeof stored === 'string' ? SCRYPT_RE.exec(stored) : null;
  if (!m) return { ok: false, rehash: false };
  const N = Number(m[1]); const r = Number(m[2]); const p = Number(m[3]);
  if (N < 1024 || N > N_MAX || (N & (N - 1)) !== 0 || r < 1 || r > R_MAX || p < 1 || p > P_MAX) return { ok: false, rehash: false };
  const salt = Buffer.from(m[4], 'hex'); const want = Buffer.from(m[5], 'hex');
  let key;
  try { key = await scryptAsync(given, salt, want.length, { N, r, p, maxmem: maxmemOf(N, r, p) }); }
  catch { return { ok: false, rehash: false }; }
  return { ok: crypto.timingSafeEqual(key, want), rehash: false };
}

export class Auth {
  /**
   * required=false 면 모든 검사가 통과한다(로컬 클라이언트 모드).
   * onRehash(newHash) — 옛 형식 저장값으로 로그인에 성공해 새 형식을 만들었을 때 부른다(설정 파일에 다시 저장하는 쪽이 넘긴다).
   */
  constructor({ required, passwordHash, now = Date.now, onRehash = null }) {
    this.required = Boolean(required);
    this.passwordHash = String(passwordHash || '');
    this.onRehash = typeof onRehash === 'function' ? onRehash : null;
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

  /**
   * 비동기(v2.740) — scrypt 대조가 스레드 풀에서 돈다. ⚠ 시도는 **대조 전에** 실패로 센다: 대조를 기다리는 동안 같은 출발지의
   * 동시 요청이 잠금 검사를 전부 통과하면 MAX_FAILS 가 무력해진다. 성공하면 그 출발지 기록을 지운다(예전과 같은 결과).
   */
  async login(ip, password) {
    if (!this.required) return { ok: true, token: '' };
    const t = this.now();
    this.pruneFails(t);
    const f = this.fails.get(ip) || { count: 0, lockedUntil: 0, lastAt: 0 };
    if (f.lockedUntil > t) {
      return { ok: false, error: `실패가 반복되어 잠겼습니다. ${Math.ceil((f.lockedUntil - t) / 1000)}초 후 다시 시도하세요.` };
    }
    f.count += 1;
    f.lastAt = t;
    if (f.count >= MAX_FAILS) { f.count = 0; f.lockedUntil = t + LOCK_MS; }
    this.fails.delete(ip); // 다시 넣어 Map 순서를 '최근 실패' 뒤로(초과분 정리가 오래된 것부터)
    this.fails.set(ip, f);
    const stored = this.passwordHash;
    const v = await verifyPassword(stored, password);
    if (!v.ok) return { ok: false, error: '비밀번호가 올바르지 않습니다.' };
    this.fails.delete(ip);
    if (v.rehash && this.passwordHash === stored) {
      // 옛 형식 → 새 형식. 저장 실패는 로그인을 막지 않는다(메모리의 새 값도 같은 비밀번호로 통한다 — 다음 저장 때 파일에 들어간다).
      try {
        const next = await hashPasswordAsync(password);
        if (this.passwordHash === stored) {
          this.passwordHash = next;
          if (this.onRehash) { try { this.onRehash(next); } catch (e) { console.warn(`[uagmon] 비밀번호 해시 새 형식 저장 실패: ${e?.message || e}`); } }
        }
      } catch (e) { console.warn(`[uagmon] 비밀번호 해시 새 형식 변환 실패: ${e?.message || e}`); }
    }
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
