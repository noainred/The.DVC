/**
 * bareos/base64.js — Bareos(Bacula 계열) 콘솔 인증에 쓰는 **Bareos 식 base64** 와 CRAM-MD5 응답 계산.
 *
 * 왜 표준 base64 가 아닌가: Director 의 `BinToBase64`(core/src/lib/base64.cc)는 패딩(`=`)이 없고, 비호환 모드에서는
 * 바이트를 **부호 있는 8비트로 늘려(int8_t)** 레지스터에 OR 한다. 그래서 0x80 이상 바이트가 섞이면 결과가 표준과 다르다.
 * 인증 응답은 이 문자열을 그대로 비교하므로(`bstrcmp`) 한 글자만 달라도 '1999 Authorization failed' 가 된다.
 * python-bareos `util/bareosbase64.py string_to_base64` 를 그대로 옮겼다(두 변형 — compatible=true 는 Bacula 호환).
 *
 * 비밀번호: Director 의 Console 비밀번호는 **MD5 16진 문자열**로 쓰인다(`[md5]…`). HMAC 키도, TLS-PSK 의 PSK 도
 * 평문이 아니라 그 16진 문자열(ASCII 32바이트)이다(python-bareos `util/password.py md5()`).
 */
import crypto from 'node:crypto';

const DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Bareos 식 base64(패딩 없음).
 * @param {Uint8Array|Buffer} bytes
 * @param {boolean} [compatible=false] true 면 Bacula 호환(부호 확장 없음 · 남은 비트를 왼쪽으로 채움)
 * @returns {string}
 */
export function bareosBase64(bytes, compatible = false) {
  const b = bytes || [];
  let out = '';
  let reg = 0; let rem = 0; let i = 0;
  // C 원본은 uint32 레지스터다 — JS 비트 연산은 int32 이지만 하위 32비트가 같고, 꺼내는 비트는 하위 13비트 안이라
  // `>>>`(논리 이동)로 꺼내면 C 와 같은 값이 나온다.
  while (i < b.length) {
    if (rem < 6) {
      const byte = b[i++];
      reg = (reg << 8) | (compatible ? byte : ((byte << 24) >> 24)); // 비호환: int8_t 부호 확장(C `(int8_t)bin[i]`)
      rem += 8;
    }
    out += DIGITS[(reg >>> (rem - 6)) & 0x3f];
    rem -= 6;
  }
  if (rem) {
    const mask = (1 << rem) - 1;
    out += DIGITS[compatible ? (((reg & mask) << (6 - rem)) & 0x3f) : (reg & mask & 0x3f)];
  }
  return out;
}

/** Console 비밀번호 → MD5 16진 문자열(소문자 32자). Director 가 키로 쓰는 값이다. */
export function passwordMd5Hex(password) {
  return crypto.createHash('md5').update(Buffer.from(String(password ?? ''), 'utf8')).digest('hex');
}

/**
 * CRAM-MD5 응답 — HMAC-MD5(key = 비밀번호 MD5 16진 문자열, data = 챌린지 문자열) 를 Bareos 식 base64 로.
 * @returns {{ plain: string, compatible: string }} 두 변형(검증할 때는 둘 다 받아들인다 — Director 와 같은 규칙)
 */
export function cramResponse(challenge, md5hex) {
  const digest = crypto.createHmac('md5', Buffer.from(String(md5hex), 'ascii')).update(Buffer.from(String(challenge), 'utf8')).digest();
  return { plain: bareosBase64(digest, false), compatible: bareosBase64(digest, true) };
}
