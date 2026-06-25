import crypto from 'node:crypto';

/**
 * 공유 토큰/시크릿 비교를 상수시간(timing-safe)으로 수행한다. 일반 `===`는 첫 불일치
 * 바이트에서 조기 반환해 응답시간 차이로 토큰을 한 바이트씩 복구당할 수 있다.
 * 길이를 먼저 HMAC으로 정규화해 길이 자체도 누설하지 않는다.
 */
export function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  // 길이가 달라도 timingSafeEqual은 동일 길이 버퍼를 요구하므로, 양쪽을 키 HMAC으로
  // 고정 길이(32B) 다이제스트화한 뒤 비교한다(내용·길이 모두 상수시간).
  const key = crypto.randomBytes(32);
  const ha = crypto.createHmac('sha256', key).update(ab).digest();
  const hb = crypto.createHmac('sha256', key).update(bb).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** 토큰이 설정돼 있고(비어있지 않고) 제시값과 상수시간 일치하면 true. */
export function tokenMatches(provided, expected) {
  if (!expected) return false;
  return timingSafeEqualStr(provided, expected);
}
