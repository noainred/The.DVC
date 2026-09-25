/**
 * Expand a free-form IP list into individual IPv4 addresses. Supports, one item
 * per line (commas also allowed within a line) with '#' comments:
 *   - single:  10.0.0.5
 *   - range :  10.0.0.1 - 10.0.0.20   (also short form 10.0.0.1-20)
 *   - CIDR  :  10.0.0.0/24            (network & broadcast excluded for <=/30)
 * A safety cap limits the total to avoid accidental huge expansions.
 */

const MAX = 4096;

import { ipToNum, strictIpv4Num } from '../util/ipv4.js';

const ipToInt = ipToNum; // v2.586 — util/ipv4.js 하나

function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export function expandIpList(text) {
  const out = [];
  const seen = new Set();
  const errors = [];
  const push = (ip) => { if (!seen.has(ip)) { seen.add(ip); out.push(ip); } };

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    for (const token of line.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (out.length >= MAX) break;

      if (token.includes('/')) {
        const [base, bitsStr] = token.split('/');
        const baseInt = ipToInt(base);
        const bits = Number(bitsStr);
        if (baseInt == null || !/^\d+$/.test(bitsStr) || bits < 0 || bits > 32) { errors.push(`잘못된 CIDR: ${token}`); continue; }
        const size = 2 ** (32 - bits);
        const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
        const network = (baseInt & mask) >>> 0;
        const hostCount = bits >= 31 ? size : size - 2;
        if (hostCount > MAX) { errors.push(`CIDR 호스트 수가 너무 많음(>${MAX}): ${token}`); continue; }
        const start = bits >= 31 ? 0 : 1;
        const end = bits >= 31 ? size : size - 1;
        for (let i = start; i < end; i++) { if (out.length >= MAX) break; push(intToIp((network + i) >>> 0)); }

      } else if (token.includes('-')) {
        const [aRaw, bRaw] = token.split('-').map((s) => s.trim());
        const aInt = ipToInt(aRaw);
        let bInt = null;
        if (bRaw && bRaw.includes('.')) bInt = ipToInt(bRaw);
        else if (bRaw && /^\d+$/.test(bRaw) && aInt != null && Number(bRaw) <= 255) {
          bInt = ((aInt & 0xffffff00) | Number(bRaw)) >>> 0; // short form: last octet
        }
        if (aInt == null || bInt == null) { errors.push(`잘못된 범위: ${token}`); continue; }
        if (bInt < aInt) { errors.push(`범위 끝이 시작보다 작습니다: ${token}`); continue; }
        if (bInt - aInt + 1 > MAX) { errors.push(`범위가 너무 큽니다(>${MAX}): ${token}`); continue; }
        for (let n = aInt; n <= bInt; n++) { if (out.length >= MAX) break; push(intToIp(n >>> 0)); }

      } else {
        if (ipToInt(token) == null) { errors.push(`잘못된 IP: ${token}`); continue; }
        // v2.611(감사 SEC2611-02): 단건은 원문을 그대로 접속처로 쓰므로 **정규형만** 받는다. '010.0.0.5' 는 이 파서가 10진
        //   (10.0.0.5)으로 읽지만 URL·inet_aton 은 8진(8.0.0.5)으로 접속한다 — 같은 표기가 범위·CIDR(10진 정규화)과 다른 호스트가
        //   되어 Dell/iLO 계정이 엉뚱한 주소로 간다. 8진인지 10진인지 추측하지 않고 거부한다(v2.589 '접속 대상은 비정규 거부' ·
        //   svcmon/genspec.js 와 같은 판단). 범위·CIDR 은 정규형을 만들어 내보내므로 저장된 대역 호환을 위해 그대로 둔다.
        if (strictIpv4Num(token) === false) { errors.push(`비정규 IP 표기(선행 0 등 — 정규형으로 적으세요): ${token}`); continue; }
        push(token);
      }
    }
  }

  return { ips: out, errors, truncated: out.length >= MAX };
}
