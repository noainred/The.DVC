/**
 * IPMS settings — IP ranges to hide from the IP ledger. Supports a global
 * ignore list and per-vCenter ignore lists. Entries may be CIDR (10.0.0.0/8),
 * a range (10.0.0.1-10.0.0.50), or a single IP. Stored in CONFIG_DIR/ipam-settings.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { ipToNum } from '../util/ipv4.js'; // v2.586 — ledger.js 를 import 하던 순환(settings ↔ ledger) 제거
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { parseRangeSpec, checkRangeList } from './rangeSyntax.js';

const FILE = path.join(config.configDir, 'ipam-settings.json');

let cache = null;       // raw settings
let matcherCache = null; // compiled matcher

let classifierCache = null;
let rev = 0; // 설정 변경 리비전(대장 캐시 무효화 키)
export function settingsRev() { return rev; }

function load() {
  if (cache) return cache;
  cache = { global: [], vcenters: {}, publicRanges: [], privateRanges: [] };
  try { if (fs.existsSync(FILE)) { const s = JSON.parse(fs.readFileSync(FILE, 'utf8')); cache = { global: s.global || [], vcenters: s.vcenters || {}, publicRanges: s.publicRanges || [], privateRanges: s.privateRanges || [] }; } } catch (e) { preserveCorrupt(FILE, e.message); /* defaults */ }
  return cache;
}

export function loadSettings() { return load(); }

/**
 * v2.637: 저장된 값 중 적용되지 않는 줄(검증 전에 저장된 옛 값) — 화면이 '저장돼 있지만 무시되는 줄' 을 밝힌다.
 * @returns {{ field: string, vcenterId?: string, line: number, value: string, reason: string }[]}
 */
export function savedInvalidEntries(settings = load()) {
  return invalidEntries(settings, { globals: true, vcKeys: null });
}

/**
 * v2.639(감사 S5): 설정 본문의 형식 오류 줄 — 저장된 값(`savedInvalidEntries`)과 PUT 본문 검사(routes/admin/centralIpam.js)가
 * 같은 루프를 두 벌 갖고 있었다. 판정은 `rangeSyntax.checkRangeList` 하나이고 여기서는 필드·vCenter 축만 붙인다.
 * @param {object} body           { global, publicRanges, privateRanges, vcenters:{ [id]: list } } — 목록은 배열·문자열 둘 다
 * @param {{globals?:boolean, vcKeys?:Set<string>|null}} [opt]
 *   globals: false 면 전역 3목록은 검사하지 않는다(범위 계정 저장 — 전역 변경은 어차피 무시된다).
 *   vcKeys: 검사할 vCenter id 집합(null·미지정이면 전부).
 * @returns {{ field: string, vcenterId?: string, line: number, value: string, reason: string }[]}
 */
export function invalidEntries(body = {}, { globals = true, vcKeys = null } = {}) {
  const out = [];
  const add = (field, list, vcenterId) => {
    for (const x of checkRangeList(list || []).invalid) out.push({ field, ...(vcenterId != null ? { vcenterId } : {}), ...x });
  };
  if (globals) { add('global', body.global); add('publicRanges', body.publicRanges); add('privateRanges', body.privateRanges); }
  const vcs = body.vcenters && typeof body.vcenters === 'object' && !Array.isArray(body.vcenters) ? body.vcenters : {};
  for (const [k, v] of Object.entries(vcs)) if (!vcKeys || vcKeys.has(k)) add('vcenters', v, k);
  return out;
}

export function saveSettings(body = {}) {
  const next = {
    global: cleanList(body.global),
    vcenters: Object.fromEntries(Object.entries(body.vcenters || {}).map(([k, v]) => [k, cleanList(v)]).filter(([, v]) => v.length)),
    publicRanges: cleanList(body.publicRanges),
    privateRanges: cleanList(body.privateRanges),
  };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2)); // 크래시/디스크풀 중 부분기록으로 설정 유실 방지
  cache = next; matcherCache = null; classifierCache = null; rev++;
  return next;
}

// RFC1918 private space (default when no explicit rule matches).
const RFC1918 = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'].map(parseRange);
const inAny = (n, ranges) => ranges.some((r) => n >= r.lo && n <= r.hi);

/** Returns ip → 'public' | 'private'. Explicit rules win; else RFC1918 = private. */
export function getClassifier() {
  if (classifierCache) return classifierCache;
  const s = load();
  const pub = (s.publicRanges || []).map(parseRange).filter(Boolean);
  const priv = (s.privateRanges || []).map(parseRange).filter(Boolean);
  // v2.611(감사 PERF2611-01): 숫자판(`.num`) — 원장 재구성이 IP 를 행당 한 번만 파싱해 넘긴다. 문자열판은 파싱 후 숫자판을
  //   부르므로 두 판의 결과는 항상 같다(ipToNum 은 순수 함수).
  const byNum = (n) => {
    if (inAny(n, priv)) return 'private';
    if (inAny(n, pub)) return 'public';
    return inAny(n, RFC1918) ? 'private' : 'public';
  };
  classifierCache = (ip) => {
    const n = ipToNum(ip);
    if (n == null) return 'private';
    return byNum(n);
  };
  classifierCache.num = (n) => (n == null ? 'private' : byNum(n));
  return classifierCache;
}

const cleanList = (v) => (Array.isArray(v) ? v : String(v || '').split(/\r?\n/)).map((s) => String(s).trim()).filter(Boolean);

// v2.637: 판정은 rangeSyntax.js 하나다 — 예전 사본은 `10.0.0.0/`(빈 마스크)를 Number('')===0 → /0 으로 읽어
//   무시 대역이면 IPv4 전체를 대장에서 숨기고, 공인 대역이면 사설 주소까지 '공인' 으로 분류했다.
function parseRange(s) { return parseRangeSpec(s); }

/** Returns (ip, vcenterId) → true if the IP should be hidden. */
export function getIgnoreMatcher() {
  if (matcherCache) return matcherCache;
  const s = load();
  const global = (s.global || []).map(parseRange).filter(Boolean);
  const vc = {};
  for (const [k, arr] of Object.entries(s.vcenters || {})) vc[k] = (arr || []).map(parseRange).filter(Boolean);
  const inAny = (n, ranges) => ranges.some((r) => n >= r.lo && n <= r.hi);
  // v2.611(감사 PERF2611-01): 숫자판(`.num`) — classifier 와 같은 이유. 문자열판은 파싱 후 숫자판을 부른다.
  const byNum = (n, vcenterId) => {
    if (inAny(n, global)) return true;
    const v = vc[vcenterId];
    return v ? inAny(n, v) : false;
  };
  matcherCache = (ip, vcenterId) => {
    const n = ipToNum(ip);
    if (n == null) return false;
    return byNum(n, vcenterId);
  };
  matcherCache.num = (n, vcenterId) => (n == null ? false : byNum(n, vcenterId));
  matcherCache.empty = global.length === 0 && Object.keys(vc).length === 0;
  return matcherCache;
}

/**
 * v2.692: 무시 대역을 구간({lo,hi})으로 — '/24 가져오기' 가 무시 대역을 후보에서 빼는 데 쓴다(ipam/vcRangeSuggest.js annotateSubnets).
 * 판정은 대장 숨김(getIgnoreMatcher)과 같은 목록·같은 파서다.
 */
export function ignoreRanges() {
  const s = load();
  const vcenters = {};
  for (const [k, arr] of Object.entries(s.vcenters || {})) vcenters[k] = (arr || []).map(parseRange).filter(Boolean);
  return { global: (s.global || []).map(parseRange).filter(Boolean), vcenters };
}
