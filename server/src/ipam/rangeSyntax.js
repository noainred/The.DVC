/**
 * IPMS 대역 문법 — 한 줄 판정(순수, v2.637).
 *
 * 무시 대역·공인/사설 분류·vCenter 스캔 대역이 같은 문법(CIDR · 범위 · 단일 IP)을 쓰는데, 판정이 세 곳에 따로 있었고
 * 저장 경로는 **아무것도 검사하지 않았다**. 그래서:
 *   ① `10.0.0.0/` (슬래시 뒤를 비움)는 `Number('') === 0` 으로 마스크 0(IPv4 전체)이 되어 무시 대역이면 IPv4 전체가 대장에서 사라지고,
 *      공인 대역이면 사설 주소(10.0.0.1)까지 '공인' 으로 분류됐다(v2.637 재현).
 *   ② `abc`·`10.0.0.0/33` 같은 줄은 오류 없이 저장되고 적용 단계에서 조용히 버려졌다 — 화면은 '저장했습니다' 라고 말했다.
 * 판정은 이 모듈 하나가 한다. 웹 `views/tools/ipmsRangeText.js` 는 같은 규칙의 사본이고 테스트가 두 구현을 대조한다
 * (번들 경계 — 웹은 서버 소스를 import 할 수 없다).
 *
 * 규칙
 *   · CIDR: 마스크는 1~2자리 숫자이고 8~32(스캔 대역 `rangeSize` 와 같은 하한). 빈 마스크·/0~/7 은 오류다.
 *     기준 주소가 네트워크 경계가 아니면(10.0.0.5/24) 오류가 아니라 경고 — 경계로 내려 읽는다(예전 동작 그대로).
 *   · 범위: `a-b`(끝 전체 IP) 또는 `a.b.c.d-e`(끝이 마지막 옥텟). 끝이 시작보다 작으면 무시·분류 목록은 바꿔 읽고(경고),
 *     스캔 대역(`reversed:'error'`)은 오류다.
 *   · 단일 IP.
 */
import { ipToNum, numToIp } from '../util/ipv4.js';

export const MIN_MASK = 8;
const MASK_RE = /^\d{1,2}$/;
const OCTET_RE = /^\d{1,3}$/;

/**
 * 한 줄 판정.
 * @returns {{ ok: true, lo: number, hi: number, size: number, kind: 'cidr'|'range'|'ip', warn: string|null }
 *          | { ok: false, reason: string }}
 */
export function checkRangeSpec(spec, opt = {}) {
  const s = String(spec ?? '').trim();
  if (!s) return { ok: false, reason: '빈 줄' };
  if (s.includes('/')) {
    const parts = s.split('/');
    if (parts.length !== 2) return { ok: false, reason: '‘/’ 가 두 번 이상 있습니다' };
    const [b, m] = parts.map((x) => x.trim());
    const base = ipToNum(b);
    if (base == null) return { ok: false, reason: `‘${b || '(비어 있음)'}’ 는 IPv4 주소가 아닙니다` };
    if (!m) return { ok: false, reason: '‘/’ 뒤 마스크가 비어 있습니다 — 비워 두면 전체 주소(/0)로 읽힐 수 있어 받지 않습니다' };
    if (!MASK_RE.test(m)) return { ok: false, reason: `마스크 ‘${m}’ 는 숫자가 아닙니다` };
    const mask = Number(m);
    if (mask > 32) return { ok: false, reason: `마스크 /${mask} 는 32 를 넘습니다` };
    if (mask < MIN_MASK) return { ok: false, reason: `마스크 /${mask} 는 너무 넓습니다(/${MIN_MASK} 이상만 받습니다)` };
    const size = 2 ** (32 - mask);
    const lo = Math.floor(base / size) * size;
    const warn = lo !== base ? `네트워크 경계가 아닙니다 — ${numToIp(lo)}/${mask} 로 읽습니다` : null;
    return { ok: true, lo, hi: lo + size - 1, size, kind: 'cidr', warn };
  }
  if (s.includes('-')) {
    const parts = s.split('-');
    if (parts.length !== 2) return { ok: false, reason: '‘-’ 가 두 번 이상 있습니다' };
    const [a, bRaw] = parts.map((x) => x.trim());
    const lo = ipToNum(a);
    if (lo == null) return { ok: false, reason: `시작 ‘${a || '(비어 있음)'}’ 는 IPv4 주소가 아닙니다` };
    let hi = ipToNum(bRaw);
    if (hi == null && OCTET_RE.test(bRaw) && Number(bRaw) <= 255) hi = Math.floor(lo / 256) * 256 + Number(bRaw); // a.b.c.d-e
    if (hi == null) return { ok: false, reason: `끝 ‘${bRaw || '(비어 있음)'}’ 는 IPv4 주소(또는 마지막 옥텟)가 아닙니다` };
    if (hi < lo) {
      // 무시·분류 목록은 예전부터 뒤집힌 범위를 바꿔 읽었다(저장된 옛 값이 조용히 빠지지 않게 유지) — 경고로 밝힌다.
      // 스캔 대역은 `rangeSize` 가 거부하므로 오류다(opt.reversed === 'error').
      if (opt.reversed === 'error') return { ok: false, reason: `끝 ${numToIp(hi)} 이 시작 ${numToIp(lo)} 보다 작습니다` };
      return { ok: true, lo: hi, hi: lo, size: lo - hi + 1, kind: 'range', warn: `시작과 끝이 뒤바뀌었습니다 — ${numToIp(hi)}-${numToIp(lo)} 로 읽습니다` };
    }
    return { ok: true, lo, hi, size: hi - lo + 1, kind: 'range', warn: null };
  }
  const n = ipToNum(s);
  if (n == null) return { ok: false, reason: `‘${s.length > 40 ? `${s.slice(0, 40)}…` : s}’ 는 CIDR·범위·IP 형식이 아닙니다` };
  return { ok: true, lo: n, hi: n, size: 1, kind: 'ip', warn: null };
}

/** 적용용 파서 — 판정을 통과한 줄만 {lo,hi}. 저장된 옛 값(검증 전 저장분)도 같은 규칙이다. */
export function parseRangeSpec(spec) {
  const r = checkRangeSpec(spec);
  return r.ok ? { lo: r.lo, hi: r.hi } : null;
}

/**
 * 목록 판정. 빈 줄은 오류가 아니다(무시한다). 줄 번호는 1부터, **빈 줄을 포함한 원래 줄** 기준이다(화면이 그 줄을 가리키게).
 * @param {string[]|string} list
 * @param {{ scanCap?: number, reversed?: 'swap'|'error' }} [opt] scanCap 이 있으면 한 줄이 그보다 크면 경고(스캔은 앞 N개만 돈다).
 */
export function checkRangeList(list, opt = {}) {
  const lines = Array.isArray(list) ? list.map((x) => String(x ?? '')) : String(list ?? '').split(/\r?\n/);
  const valid = []; const invalid = []; const warnings = [];
  const seen = new Map();
  let total = 0;
  lines.forEach((raw, i) => {
    const v = raw.trim();
    if (!v) return;
    const r = checkRangeSpec(v, opt);
    if (!r.ok) { invalid.push({ line: i + 1, value: v.slice(0, 80), reason: r.reason }); return; }
    const key = `${r.lo}-${r.hi}`;
    if (seen.has(key)) warnings.push({ line: i + 1, value: v.slice(0, 80), reason: `${seen.get(key)}행과 같은 대역입니다` });
    else seen.set(key, i + 1);
    if (r.warn) warnings.push({ line: i + 1, value: v.slice(0, 80), reason: r.warn });
    if (opt.scanCap && r.size > opt.scanCap) warnings.push({ line: i + 1, value: v.slice(0, 80), reason: `${r.size.toLocaleString()}개 — 스캔은 앞 ${opt.scanCap.toLocaleString()}개만 돕니다(/24 단위로 나누세요)` });
    total += r.size;
    valid.push(v);
  });
  return { valid, invalid, warnings, ipCount: total };
}
