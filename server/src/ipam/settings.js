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
  const out = [];
  const add = (field, list, vcenterId) => {
    for (const x of checkRangeList(list || []).invalid) out.push({ field, ...(vcenterId != null ? { vcenterId } : {}), ...x });
  };
  add('global', settings.global);
  add('publicRanges', settings.publicRanges);
  add('privateRanges', settings.privateRanges);
  for (const [k, v] of Object.entries(settings.vcenters || {})) add('vcenters', v, k);
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
