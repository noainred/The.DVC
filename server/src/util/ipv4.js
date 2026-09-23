/**
 * util/ipv4.js — IPv4 점표기 ↔ uint32 의 **단일 소스**(v2.586).
 *
 * ⚠ 왜: 같은 함수가 6벌(`ipam/ledger.js`·`ipam/scan.js`·`ipam/rangePolicies.js`·`provision/spec.js`·
 *   `search/deepSearch.js ipToInt`·`idrac/iprange.js ipToInt`) 있었고 **서로 다르게** 동작했다.
 *   가장 느슨한 `ipam/scan.js` 판본(=`isIpv4`, "키 오염·잘못된 입력 차단용 공용 검증기")은
 *   `Number('') === 0` 때문에 **'10..1.1'·'10.1.1.' 을 유효 IP 로 받았고**(빈 옥텟 → 0), `'10.1.0x1.1'`
 *   (16진)·`'1e0'`(지수) 도 통과시켰다. 그 값은 IPAM 수동 지정 키·스캔 대상으로 저장된다.
 *   · 선행 0(`'010'`)은 **10진수로 받는다**(예전 판본 전부의 동작 — 저장된 스캔 범위·override 키가 깨지지 않게).
 *     원문 토큰을 그대로 접속처로 쓰는 곳은 8진수 오해석 위험이 있으므로 **정규형(`numToIp`)으로 바꿔 쓰거나
 *     거부**해야 한다 — `svcmon/genspec.js nonCanonicalIp` 가 그 예다.
 *   · 앞뒤 공백은 다듬는다(붙여넣기).
 */
const OCTET = /^\d+$/;

/** '10.0.0.1' → 167772161. 유효하지 않으면 null. */
export function ipToNum(s) {
  if (typeof s !== 'string' && typeof s !== 'number') return null;
  const parts = String(s).trim().split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!OCTET.test(p)) return null;
    const x = Number(p);
    if (x > 255) return null;
    n = n * 256 + x;
  }
  return n >>> 0;
}

/** 167772161 → '10.0.0.1'. */
export function numToIp(n) {
  const v = Number(n) >>> 0;
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
}

/** 유효한 IPv4 점표기인가. */
export const isIpv4 = (s) => ipToNum(s) != null;

/**
 * 접속처 판정용 IPv4 — **정규형일 때만** 숫자를 준다(v2.589, 감사 ARCH-A2).
 * ⚠ 허용 목록 대조에 느슨한 `ipToNum` 을 쓰면 `'010.0.0.5'` 가 10.0.0.5 로 허용되는데 실제 접속의
 *   `dns.lookup`(glibc inet_aton)은 그것을 **8진수 8.0.0.5** 로 해석한다 — 허용 대역 밖으로 나간다.
 * 반환: 정규형이면 숫자, 숫자·점만으로 된 비정규형(선행 0·짧은 표기·빈 옥텟)이면 `false`(거부해야 함),
 * IP 모양이 아니면(호스트명) `null`.
 */
export function strictIpv4Num(s) {
  const h = String(s ?? '').trim();
  if (!/^[0-9.]+$/.test(h)) return null;
  const n = ipToNum(h);
  if (n == null || numToIp(n) !== h) return false;
  return n;
}

/** CIDR·단일 IPv4 목록 항목(관리자 입력 — 느슨히 읽는다)과 정규형 대상 숫자의 일치. 항목이 IP 가 아니면 null. */
export function cidrMatch(n, entry) {
  const [base, bits] = String(entry ?? '').trim().split('/');
  const bn = ipToNum(base);
  if (bn == null) return null;
  const k = bits == null ? 32 : (/^\d+$/.test(bits) ? Number(bits) : NaN);
  if (!(k >= 0 && k <= 32)) return null;
  const mask = k === 0 ? 0 : (0xffffffff << (32 - k)) >>> 0;
  return ((n & mask) >>> 0) === ((bn & mask) >>> 0);
}

/**
 * 정규형 IPv4 문자열(v2.595 — v2.594 에 ipam/overrides.js·annotations.js 두 곳에 있던 것을 코어로 올렸다).
 * 파서는 선행 0('010.39.0.1')을 10진으로 받지만(v2.586 호환) 원장·소유 맵은 **문자열**로 대조한다 — 저장과 판정이
 * 같은 키를 쓰려면 둘 다 이 함수를 거쳐야 한다(v2.595 R2595-01: 저장만 정규화하고 범위 판정은 원문으로 해서
 * 범위 계정이 선행 0 표기로 범위 밖 IP 에 쓸 수 있었다). IPv4 가 아니면 null.
 */
export function canonIp(s) {
  const n = ipToNum(String(s ?? '').trim());
  return n == null ? null : numToIp(n);
}
