// ipamBulkText.js — IP 관리상태 '수동 등록 / 일괄 관리' 입력 판정(웹, 순수 · v2.744 감사 WEB-02).
// ⚠ 서버 `server/src/ipam/overrides.js splitBatchIps` 와 **같은 규칙의 사본**이다(번들 경계 — 웹은 서버 소스를 import 할 수 없다).
//   `audit2744g.test.js` 가 두 구현을 같은 입력으로 대조한다 — 한쪽만 고치면 테스트가 깨진다.
//   예전 화면은 입력을 공백·쉼표로 나누기만 하고 보냈고, 서버는 무효 토큰(10.250.1.300 · 10.250.1)을 조용히 버린 채 나머지만 적용했다 —
//   화면은 '성공' 으로 창을 닫았다. 이제 화면은 저장 전에 같은 판정으로 무효 값을 보이고 저장을 막으며, 서버도 400 + invalid 로 거부한다.

const OCTET = /^\d+$/;
// server/src/util/ipv4.js ipToNum 과 같은 규칙(점 4개 · 각 칸 10진 숫자 ≤255 · 선행 0 은 10진으로 받는다 · 앞뒤 공백 다듬기).
function ipToNum(s) {
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
function numToIp(n) {
  const v = Number(n) >>> 0;
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
}
/** 정규형 IPv4 문자열(서버 canonIp 와 같다). IPv4 가 아니면 null. */
export function canonIp(s) {
  const n = ipToNum(String(s ?? '').trim());
  return n == null ? null : numToIp(n);
}

/**
 * 입력을 토큰·정규형 IP·무효 원문으로 나눈다(서버 splitBatchIps 와 같다).
 * @returns {{tokens:string[], ips:string[], invalid:string[]}} tokens = 다듬은 원문 전부(중복 포함) · ips = 정규형·중복 제거 ·
 *   invalid = 무효 원문·중복 제거(입력 순서)
 */
export function splitBulkIps(input) {
  const tokens = (Array.isArray(input) ? input : String(input ?? '').split(/[\s,]+/))
    .map((s) => (s == null ? '' : String(s).trim())).filter(Boolean);
  const seen = new Set(); const ips = []; const bad = new Set();
  for (const t of tokens) {
    const k = canonIp(t);
    if (!k) { bad.add(t); continue; }
    if (!seen.has(k)) { seen.add(k); ips.push(k); }
  }
  return { tokens, ips, invalid: [...bad] };
}

const SHOW_MAX = 50;
const short = (t) => { const v = String(t); return v.length > 64 ? `${v.slice(0, 63)}…` : v; };

/**
 * 무효 값 안내 한 줄(저장 전 판정·서버 400 응답 공용). 없으면 null.
 * @param {string[]} invalid 무효 원문(서버 응답이면 상한으로 잘린 목록)
 * @param {number} [count] 전체 개수(서버 invalidCount — 목록이 잘렸으면 목록보다 크다)
 * @param {{server?:boolean}} [opt] server = 서버가 거부한 응답(아무것도 저장되지 않았다)
 */
export function bulkInvalidText(invalid, count, opt = {}) {
  const list = Array.isArray(invalid) ? invalid.map(short) : [];
  const total = Number.isFinite(count) && count > list.length ? count : list.length;
  if (!total) return null;
  const shown = list.slice(0, SHOW_MAX);
  const more = total > shown.length ? ` 외 ${total - shown.length}개` : '';
  const head = opt?.server
    ? `서버가 IPv4 주소가 아닌 값 ${total}개 때문에 일괄 적용을 거부했습니다 — 아무 IP 도 저장되지 않았습니다`
    : `IPv4 주소가 아닌 값 ${total}개 — 고치거나 지운 뒤 저장하세요(나머지 IP 만 저장하지는 않습니다)`;
  return `${head}: ${shown.join(', ')}${more}`;
}

/**
 * 저장 실패 응답에서 화면에 보일 무효 값 목록을 꺼낸다(postJson 은 400 을 던지므로 HttpError.body 에 본문이 있다).
 * @returns {{invalid:string[], invalidCount:number}|null}
 */
export function invalidOfResponse(r) {
  const b = r && typeof r === 'object' ? r : null;
  if (!b || !Array.isArray(b.invalid) || !b.invalid.length) return null;
  const n = Number(b.invalidCount);
  return { invalid: b.invalid.map(String), invalidCount: Number.isFinite(n) && n > 0 ? n : b.invalid.length };
}
