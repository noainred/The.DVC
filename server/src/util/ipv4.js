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
